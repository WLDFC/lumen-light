# ===========================================================================
# LumenReceiveVideoFromCanvas —— 从 LumenLight 画板接收视频（第四个 Lumen 节点）
# ===========================================================================
# 用途：视频参考 / V2V（视频生视频）工作流。很多视频模型支持拿一段视频做
# 参考（运镜 / 风格 / 主体延续，如 MiniMax H3 的视频延续），本节点把画布上
# 选定的视频取回并拆解成工作流可直接消费的各种形态。
#
# 与 LumenReceiveImageFromCanvas 的设计差异（为什么不是照抄 base64 槽位）：
#   图片几十 KB~几 MB，base64 JSON 槽位无压力；视频动辄几十上百 MB，
#   base64 会额外膨胀 33% 且挤爆内存。因此画布视频本来就以文件形式落在
#   LumenLight 后端的 data/videos/ 目录，视频槽位只存"引用"
#   （文件名 + 时间戳），本节点取视频时分两步：
#     1) GET /api/canvas-video/:slot      → 槽位元数据（文件名 + 时间戳）
#     2) GET /api/canvas-video/:slot/file → 后端 sendFile 流式回传字节
#   拿到字节后写入 ComfyUI temp 目录成为本地文件，再包装输出。
#
# 输出形态（对齐 VHS Load Reference Video 的多输出习惯，按需接线，
# 只接其一即可，其余悬空无副作用）：
#   video        —— ComfyUI 原生 VIDEO 容器（不解码，惰性），
#                   接原生 GetVideoComponents 或视频模型的 V2V 输入口
#   frames       —— 视频帧序列（类型为 IMAGE batch [B,H,W,C]，类型系统
#                   约束：H3 ref_video / VAE Encode 等输入口只收 IMAGE）
#   audio        —— 音频 AUDIO（无声视频返回 0 长度静音）
#   frame_count  —— 帧数 INT
#   vhs_filenames —— VHS 文件引用（装了 VHS 的用户接 VHS 工具链）
#   video_info   —— 视频元信息 dict（VHS_VIDEOINFO 风格：fps/帧数/时长/宽高）
#
# 帧率：不设输出端口，作为节点控件（fps，默认 24）自定义——H3 等模型
# 期望参考视频 24fps，时长换算以控件值为准，经 video_info 传递；
# 源视频实际帧率仅打印参考。
#
# 帧序列解码：经原生 VIDEO 容器的 get_components() 迭代器完成
# （与原生 GetVideoComponents 节点同一条解码路径，零额外依赖），
# 拆出帧张量 / 音频。
#
# 依赖：requests + torch（ComfyUI 环境自带，不引入 imageio/opencv）。
# ===========================================================================

import os
import tempfile
import requests
import torch

# folder_paths 是 ComfyUI 的内置模块，用于定位其 temp 目录；
# 脱离 ComfyUI 环境单独测试时导入失败不致命，回退系统临时目录
try:
    import folder_paths
except ImportError:
    folder_paths = None

# ---------------------------------------------------------------------------
# VIDEO 容器包装类导入：优先新位置（comfy_api.input_impl），逐级回退。
# 全部失败时置 None——receive 时给出明确报错而不是静默产出空视频
# ---------------------------------------------------------------------------
_VideoFromFile = None          # VideoFromFile 类：把本地视频文件包装成原生 VIDEO 对象
_video_import_error = None     # 记录最后一次导入失败原因，供运行时报错展示
for _mod_name in ("comfy_api.input_impl", "comfy_api.input_impl.video_types"):
    try:
        _module = __import__(_mod_name, fromlist=("VideoFromFile",))
        _VideoFromFile = getattr(_module, "VideoFromFile")
        break                  # 任一位置导入成功即停，用最优先的可用版本
    except Exception as _e:
        _video_import_error = _e


class LumenReceiveVideoFromCanvas:
    """从 LumenLight 画板接收视频（供视频参考 / V2V 工作流使用）

    槽位协议与 LumenReceiveImageFromCanvas 对应：视频体积大，槽位只存
    "引用"（文件名 + 时间戳，指向后端 data/videos/ 已落盘文件），本节点
    按两步取回：先 GET 元数据，再 GET 字节流落盘为本地文件。

    取回缓存：按 (slot, timestamp) 记忆 temp 文件路径，槽位时间戳没变
    就不重复下载；force_reload=True 时忽略缓存强制重取。
    """

    # LumenLight 后端视频槽位路由基地址（与 LumenLight 后端同机部署，
    # 端口 8080 与图片节点 LumenReceiveImageFromCanvas 的硬编码保持一致）
    BACKEND_BASE = "http://localhost:8080/api/canvas-video"
    # 允许的视频扩展名（与 LumenLight 后端 LumenSendVideoToCanvas 保持一致）
    ALLOWED_EXTS = {".mp4", ".webm", ".mov", ".gif", ".mkv", ".avi"}

    # 模块级取回缓存：key = f"{slot}:{timestamp}"，value = 本地 temp 文件路径。
    # 时间戳是槽位内容的"版本号"——用户在画布上改绑视频会刷新时间戳，
    # 缓存自动失效触发重新下载；时间戳没变则直接复用已下载的文件，
    # 避免每次跑工作流都传输几十上百 MB
    _received_video_cache = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 槽位编号：与图片槽位 1-3 对称；画布侧把选定的视频
                # 绑定到某个槽位，工作流模板里靠编号取用
                "slot": (["1", "2", "3"], {"default": "1"}),
                # 帧率：自定义控件（不走端口连线）。H3 等视频模型期望参考
                # 视频 24fps，但源视频实际帧率模型侧并不感知——时长/帧数
                # 换算以这里的值为准，写入 video_info（duration = 帧数/fps）。
                # 用 INT：帧率语义上就是整数（23.976 这类小数帧率对参考视频
                # 无意义，还省得 FLOAT 控件显示 1.00 这种小数尾巴）
                "fps": ("INT", {"default": 24, "min": 1, "max": 240, "step": 1, "label": "帧率（自定义）"}),
                # 等待模式：True=后端响应慢时最长等 30s（提交即跑的常规场景）；
                # False=只等 5s 快速失败（不想被空槽位拖住时用）
                "wait_for_video": ("BOOLEAN", {"default": True}),
                # 强制重新加载：True=忽略缓存每次都重新下载；
                # False=同槽位同时间戳时复用上次下载的本地文件
                "force_reload": ("BOOLEAN", {"default": True, "label": "强制重新加载"}),
                # 随机种子：与图片节点同约定——ComfyUI 不重跑输入值未变的节点，
                # 改 seed 即强制本节点重新执行（配合 force_reload 实现手动刷新）
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "label": "随机种子（强制刷新）"}),
            }
        }

    # 六路输出，按需接线（只接其一即可，其余悬空无副作用）：
    #   video         —— 原生 VIDEO 容器（惰性，不解码）
    #   frames        —— 视频帧序列，类型为 IMAGE batch（这是类型系统约束：
    #                    MiniMax H3 的 ref_video 口与 VAE Encode 等图像类
    #                    输入口都只收 IMAGE，改成别的类型就接不上了）。
    #                    显示名用 frames 避免与"参考图片"口混淆——它装的是
    #                    视频逐帧解出的帧序列，不是单张图片
    #   audio         —— 音频 AUDIO（无声视频为 0 长度静音）
    #   frame_count   —— 帧数 INT
    #   vhs_filenames —— VHS 文件引用
    #   video_info    —— 视频元信息 dict（fps=控件自定义值/帧数/时长/宽高）
    # 帧率不再是输出端口——作为上方控件自定义，经 video_info 传递
    RETURN_TYPES = ("VIDEO", "IMAGE", "AUDIO", "INT", "VHS_FILENAMES", "VHS_VIDEOINFO")
    RETURN_NAMES = ("video", "frames (视频帧序列)", "audio", "frame_count", "vhs_filenames", "video_info")
    FUNCTION = "receive"
    CATEGORY = "LumenLight"

    # ------------------------------------------------------------------
    # 取回链路
    # ------------------------------------------------------------------
    def _fetch_metadata(self, slot, timeout):
        """第一步：GET 槽位元数据（轻量 JSON，不传视频本体）。

        参数:
            slot:    槽位编号字符串（"1"/"2"/"3"）
            timeout: 请求超时秒数（wait_for_video 决定 30s / 5s）
        返回:
            (文件名, 时间戳) 二元组
        异常:
            RuntimeError —— 后端不可达 / 槽位为空(404) / 元数据异常 / 格式不支持。
            视频没有有意义的"空视频"兜底，统一抛错让问题显式暴露，
            ComfyUI 会把错误信息直接显示到节点上
        """
        url = f"{self.BACKEND_BASE}/{slot}"
        try:
            response = requests.get(url, timeout=timeout)
        except Exception as e:
            # 连接层失败（后端未启动 / 端口不对等），单独给出可排查的提示
            raise RuntimeError(f"连接 LumenLight 后端失败（{url}）：{e}")

        if response.status_code == 404:
            # 槽位为空是用户侧最常见的漏操作（忘绑视频），提示直接给操作指引
            raise RuntimeError(f"画板槽位 {slot} 没有视频（先在画布上绑定视频到该槽位）")
        if response.status_code != 200:
            raise RuntimeError(f"获取槽位 {slot} 元数据失败：HTTP {response.status_code} {response.text[:200]}")

        data = response.json()
        if data.get("status") != "ok" or not data.get("filename"):
            raise RuntimeError(f"槽位 {slot} 元数据异常：{data}")

        # 格式白名单前置校验：后端只收白名单格式，这里再拦一道，
        # 避免把下游节点解不了的容器（如奇怪的封装）送进工作流
        filename = data["filename"]
        ext = os.path.splitext(filename)[1].lower()
        if ext not in self.ALLOWED_EXTS:
            raise RuntimeError(f"槽位 {slot} 的视频格式 {ext} 不受支持（支持: {sorted(self.ALLOWED_EXTS)}）")
        return filename, data.get("timestamp", 0)

    def _temp_dir(self):
        """视频落盘目录：优先 ComfyUI temp 目录，回退系统临时目录。

        用 ComfyUI temp 的好处：文件纳入 ComfyUI 自身的临时目录清理机制，
        不会无限堆积；folder_paths 不可用（脱离 ComfyUI 测试）时回退。
        """
        if folder_paths is not None:
            try:
                return folder_paths.get_temp_directory()
            except Exception:
                pass
        return tempfile.gettempdir()

    def _download_to_temp(self, slot, filename):
        """第二步：GET 视频字节流写盘（整文件下载，不设 Range 断点）。

        参数:
            slot:     槽位编号字符串
            filename: 元数据里的原始文件名（仅取扩展名决定本地后缀）
        返回:
            本地文件绝对路径
        异常:
            RuntimeError —— 下载失败（HTTP 非 200）；写盘失败原样抛出
            并清理半成品文件
        """
        url = f"{self.BACKEND_BASE}/{slot}/file"
        # 视频体积大，超时放宽到 5 分钟（与 LumenSendVideoToCanvas 上传超时对齐）
        response = requests.get(url, timeout=300)
        if response.status_code != 200:
            # 典型场景：槽位引用的视频已被存档 GC 清理（404），
            # 后端 message 会随响应体带回来
            raise RuntimeError(f"下载槽位 {slot} 视频失败：HTTP {response.status_code} {response.text[:200]}")

        # mkstemp 生成唯一文件名防并发互踩（多个工作流同时取同一槽位
        # 也不会写同一个文件）；保留原始扩展名，下游按扩展名识别容器格式。
        # 缓存 key 的槽位/时间戳语义由调用方 _get_video_file 维护，这里不管
        fd, tmp_path = tempfile.mkstemp(
            suffix=os.path.splitext(filename)[1].lower(),
            prefix="lumen_canvas_video_",
            dir=self._temp_dir(),
        )
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(response.content)
        except Exception:
            # 写盘失败清理半成品，避免 temp 目录留垃圾文件
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            raise
        print(f"  🎬 Video downloaded: {filename} ({len(response.content) / 1024 / 1024:.1f} MB) → {tmp_path}")
        return tmp_path

    def _get_video_file(self, slot, wait_for_video, force_reload):
        """取回视频本地文件（元数据 → 缓存判定 → 下载，完整链路编排）。

        参数:
            slot:          槽位编号字符串
            wait_for_video: 是否长等待（透传给元数据请求的超时）
            force_reload:   True=跳过缓存强制重新下载
        返回:
            (本地文件路径, 槽位时间戳) 二元组
        异常:
            RuntimeError —— 槽位为空 / 不可达 / 格式不支持 / 下载失败
        """
        filename, timestamp = self._fetch_metadata(
            slot,
            timeout=30 if wait_for_video else 5,
        )
        cache_key = f"{slot}:{timestamp}"
        cached = self._received_video_cache.get(cache_key)
        # 缓存命中三条件：有条目 + 未强制刷新 + 文件还在磁盘上
        # （temp 目录可能被 ComfyUI/系统清掉，isfile 校验兜底）
        if cached and not force_reload and os.path.isfile(cached):
            print(f"  ♻️ Slot {slot} cache hit (timestamp={timestamp})")
            return cached, timestamp

        tmp_path = self._download_to_temp(slot, filename)
        # 清掉同槽位旧时间戳的缓存条目（改绑视频后旧文件引用已失效），
        # 避免字典无限增长
        for stale_key in [k for k in self._received_video_cache if k.startswith(f"{slot}:") and k != cache_key]:
            self._received_video_cache.pop(stale_key, None)
        self._received_video_cache[cache_key] = tmp_path
        return tmp_path, timestamp

    # ------------------------------------------------------------------
    # 帧序列 / 音频 / 帧率解码
    # ------------------------------------------------------------------
    def _decode_components(self, video_obj):
        """把原生 VIDEO 容器拆解为 (帧序列, 音频, 帧率)。

        走原生 get_components()——与 ComfyUI 自带的 GetVideoComponents
        节点完全同一条解码路径，零额外依赖。

        兼容两种 API 形态（随 ComfyUI 版本演进）：
          新版：get_components() 返回单个 VideoComponents 对象
                （dataclass：images [B,H,W,C] 张量 + frame_rate Fraction + audio）
          旧版：返回可迭代对象（逐块产出组件）——按迭代器防御处理

        参数:
            video_obj: VideoFromFile 包装的 VIDEO 对象
        返回:
            (images, audio, fps)
            images: torch.Tensor [B,H,W,C] 浮点 0~1（帧序列 batch）
            audio:  AUDIO dict {waveform:[B,C,T], sample_rate}（无声为 0 长度）
            fps:    float（元数据缺失时 0.0）
        异常:
            RuntimeError —— 容器不支持解码 / 一帧都解不出来
        """
        if not hasattr(video_obj, "get_components"):
            raise RuntimeError(
                "当前 ComfyUI 的 VIDEO 容器不支持 get_components() 解码，"
                "无法输出 frames/audio——请升级 ComfyUI，"
                "或改用 video 输出口接原生 GetVideoComponents 节点"
            )

        def _extract(comp):
            """从单个 VideoComponents 对象提取 (images, audio, fps)。
            images 统一为浮点张量；frame_rate/fps 两种字段名都认"""
            images = getattr(comp, "images", None)
            if images is None:
                return None, getattr(comp, "audio", None), 0.0
            # 张量直接用；其他形态（numpy 等）转浮点张量
            if not isinstance(images, torch.Tensor):
                import numpy as _np
                images = torch.from_numpy(_np.asarray(images).astype("float32") / 255.0)
            elif images.dtype != torch.float32:
                images = images.to(torch.float32)
            # 帧率字段：新版 frame_rate（Fraction），旧版 fps
            rate = getattr(comp, "frame_rate", None) or getattr(comp, "fps", None)
            fps = float(rate) if rate else 0.0
            return images, getattr(comp, "audio", None), fps

        # 先按"单个 VideoComponents 对象"处理（新版 API）；
        # TypeError（对象不可迭代发生在 for 时才是旧版迭代器形态，
        # 解码内部错误要原样抛出）则回退逐块迭代收集
        components = video_obj.get_components()
        if isinstance(components, torch.Tensor):
            # 极端防御：直接返回了张量
            comp_images, comp_audio, comp_fps = components, None, 0.0
        else:
            try:
                iter(components)
                is_iterable = True
            except TypeError:
                is_iterable = False

            if is_iterable:
                # 旧版迭代器形态：逐块提取，最后一块有音频/帧率即采纳
                comp_images, comp_audio, comp_fps = None, None, 0.0
                for comp in components:
                    im, au, fr = _extract(comp)
                    if im is not None:
                        comp_images = im if comp_images is None else torch.cat([comp_images, im], dim=0)
                    if au is not None:
                        comp_audio = au
                    if fr:
                        comp_fps = fr
            else:
                comp_images, comp_audio, comp_fps = _extract(components)

        if comp_images is None or not isinstance(comp_images, torch.Tensor) or comp_images.ndim < 3 \
                or comp_images.shape[0] == 0:
            raise RuntimeError("视频解码结果为 0 帧（容器损坏或编码不受支持）")
        images = comp_images
        audio = comp_audio
        fps = comp_fps

        # 无声视频给 0 长度静音（AUDIO 约定 {waveform:[B,C,T], sample_rate}），
        # 下游音频节点可正常消费而不报错
        if audio is None:
            audio = {"waveform": torch.zeros((1, 2, 0)), "sample_rate": 44100}

        print(f"  🧩 Decoded: {images.shape[0]} frames, fps={fps}, "
              f"audio={'yes' if audio['waveform'].shape[-1] > 0 else 'silent'}")
        return images, audio, fps

    # ------------------------------------------------------------------
    # 节点主函数
    # ------------------------------------------------------------------
    def receive(self, slot, fps, wait_for_video, force_reload=True, seed=0):
        """ComfyUI 执行入口：取回视频并输出全部形态。

        参数:
            slot:           槽位编号（"1"/"2"/"3"）
            fps:            自定义帧率（控件值，用于 video_info 与时长换算）
            wait_for_video: 空槽位/慢后端的等待策略（30s / 5s）
            force_reload:   是否忽略缓存强制重新下载
            seed:           随机种子（仅用于强制刷新节点执行，不参与逻辑）
        返回:
            (video, frames, audio, frame_count, vhs_filenames, video_info)
        异常:
            RuntimeError —— VIDEO 类型不可用 / 槽位链路任一环节失败 / 解码失败
        """
        print(f"\n📥 Lumen: Requesting video from slot {slot}...")
        print(f"  🔄 Force reload: {force_reload}, Seed: {seed}, Custom fps: {fps}")

        # 前置校验：VIDEO 包装类导入失败的极端环境（ComfyUI 过旧），
        # 明确报错并给出替代接线建议，而不是抛出难懂的 AttributeError
        if _VideoFromFile is None:
            raise RuntimeError(
                "当前 ComfyUI 版本不含原生 VIDEO 类型（comfy_api.input_impl 导入失败："
                f"{_video_import_error}）。请升级 ComfyUI 后使用本节点"
            )

        video_path, timestamp = self._get_video_file(slot, wait_for_video, force_reload)

        # 主输出：ComfyUI 原生 VIDEO 对象（惰性容器——不预解码帧，
        # 下游 GetVideoComponents / 视频模型节点自行按需读取）
        video_obj = _VideoFromFile(video_path)

        # 帧序列 / 音频：走原生解码路径拆解（供图像类输入口与音频节点
        # 直接消费——MiniMax H3 等模型的参考视频接这里）
        images, audio, source_fps = self._decode_components(video_obj)
        frame_count = int(images.shape[0])
        height, width = int(images.shape[1]), int(images.shape[2])
        # 帧率以控件自定义值为准（时长/帧数换算语义一致），源视频实际
        # 帧率仅打印参考——H3 等模型期望 24fps，与源不符时由用户在控件上调整
        fps = float(int(fps)) if fps and int(fps) > 0 else float(source_fps or 24)
        fps = round(fps)  # INT 控件语义：帧率取整
        duration = frame_count / fps
        print(f"  ℹ️ Source fps: {source_fps}, using custom fps: {fps}")

        # VHS 风格文件引用 dict（防御性同时带 filename/fullpath，
        # 兼容 VHS 各版本对 VHS_FILENAMES 的解析习惯；type=temp 表示
        # 文件在 ComfyUI temp 目录，VHS 端可直接读取）
        vhs_ref = {
            "filename": os.path.basename(video_path),
            "fullpath": video_path,
            "subfolder": "",
            "type": "temp",
        }

        # 视频元信息 dict（VHS_VIDEOINFO 风格，键名与 VHS Load Video 对齐）
        video_info = {
            "source": video_path,
            "fps": fps,
            "frame_count": frame_count,
            "duration": duration,
            "width": width,
            "height": height,
        }

        print(f"  ✅ Video ready: slot={slot}, timestamp={timestamp}, "
              f"{frame_count} frames @ {fps}fps, {width}x{height}")
        return (video_obj, images, audio, frame_count, vhs_ref, video_info)


NODE_CLASS_MAPPINGS = {
    "LumenReceiveVideoFromCanvas": LumenReceiveVideoFromCanvas
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "LumenReceiveVideoFromCanvas": "💡 From Canvas (Video Ref)"
}
