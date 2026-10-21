# ===========================================================================
# LumenSendVideoToCanvas —— 生成视频回传 LumenLight 画板（ComfyUI → 画板）
# ===========================================================================
# 用途：视频工作流末尾接上本节点，把生成的视频文件二进制直传到
# LumenLight 后端（保存到 data/videos/），后端经 WebSocket 以
# new-video 消息推给画板客户端落画布。
#
# 与图片节点（LumenSendImageRealtime）的传输差异：图片体积小走
# base64 JSON；视频动辄几十上百 MB，走原始字节流直传
# （Content-Type: application/octet-stream），避免 base64 膨胀 33%。
#
# 兼容两种视频上游（按优先级取用）：
#   1. ComfyUI 原生"创建视频"链路 —— VIDEO 对象（VideoContainer）；
#   2. VHS VideoCombine 链路 —— Filenames 文件路径引用。
# 两个输入都悬空时不发送，仅打印提示（auto_send=True 时）。
#
# 依赖：requests（folder_paths 可选，用于相对路径解析）。
# ===========================================================================

import os
import tempfile
import requests

# folder_paths 是 ComfyUI 内置模块，用于把 VHS 输出的相对路径
# 解析到其 output / input / temp 目录；脱离 ComfyUI 测试时导入失败
# 不致命（届时只认绝对路径）
try:
    import folder_paths
except ImportError:
    folder_paths = None


class LumenSendVideoToCanvas:
    """发送视频文件到 LumenLight 画板（HTTP 版，二进制直传）

    与 LumenSendImageRealtime（图片回传）对应：图片走 base64 JSON，
    视频体积大，走原始字节流直传，由 LumenLight 后端保存到 data/videos/
    后经 WebSocket 推送给画板客户端。

    支持两种视频来源（按优先级）：
      1. video 输入口——ComfyUI 原生"创建视频"(CreateVideo) 的 VIDEO 对象；
      2. vhs_filenames 输入口——VHS VideoCombine 的 Filenames（文件路径）。
    """

    # LumenLight 后端视频接收接口（二进制 POST，与后端同机部署）
    BACKEND_URL = "http://localhost:8080/api/receive-video"
    # 允许上传的视频扩展名（与 LumenLight 后端保持一致，白名单前置校验）
    ALLOWED_EXTS = {".mp4", ".webm", ".mov", ".gif", ".mkv", ".avi"}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 发送开关：False 时节点退化为直通（不读上游不发送）
                "auto_send": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                # ComfyUI 原生"创建视频"(CreateVideo)/SaveVideo 的输出类型——
                # 值是内存中的视频对象（VideoContainer），节点内部先落成
                # 临时文件再上传
                "video": ("VIDEO", {}),
                # VHS VideoCombine 的 Filenames 输出类型——值为文件路径
                "vhs_filenames": ("VHS_FILENAMES", {}),
                # 可选透传字段：画板 Comfy 生图节点提交工作流时注入自己的节点 id，
                # 后端随 WebSocket 消息原样回传。视频对象落画布暂不走节点占位图，
                # 该字段仅作日志与预留
                "lumen_target": ("STRING", {"default": ""}),
            }
        }

    # 返回上游解析出的文件路径列表（换行分隔），供调试查看；
    # 发送失败的位置留空串
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("paths",)
    FUNCTION = "send_video"
    # OUTPUT_NODE：声明为输出型节点——没有下游连线也会被执行
    OUTPUT_NODE = True
    CATEGORY = "LumenLight"

    def _resolve_path(self, raw):
        """把用户输入的路径解析为可读文件：绝对路径直用，
        相对路径依次在 ComfyUI 的 output / input / temp 目录查找

        参数:
            raw: 原始路径字符串（容忍首尾引号与空白）
        返回:
            存在的文件绝对路径；解析不到返回 None
        """
        raw = raw.strip().strip('"').strip("'")
        if not raw:
            return None
        if os.path.isabs(raw):
            return raw if os.path.isfile(raw) else None
        if folder_paths is not None:
            # VHS 等上游输出的相对路径基准随版本不同，
            # 三个目录依次尝试命中即用
            for getter in ("get_output_directory", "get_input_directory", "get_temp_directory"):
                try:
                    candidate = os.path.join(getattr(folder_paths, getter)(), raw)
                    if os.path.isfile(candidate):
                        return candidate
                except Exception:
                    pass
        if os.path.isfile(raw):
            return raw
        return None

    def _video_object_to_file(self, value):
        """把 ComfyUI 原生 VIDEO 对象（VideoContainer）落成本地文件。

        返回 (文件路径, 是否临时文件)，失败返回 (None, False)。
        优先取内部已有的数据源文件（零拷贝），否则经 save_to 写临时 mp4
        """
        # 1. VideoFromFile/VideoFromBytes 的内部数据源可能就是本地文件
        #    ——直接引用原路径，上传后不删（is_temp=False）
        try:
            src = value.get_stream_source()
            if isinstance(src, str) and os.path.isfile(src):
                return src, False
        except Exception:
            pass
        # 2. 落成临时文件（CreateVideo 输出为 mp4 封装）——
        #    临时文件上传完在 finally 里删除
        try:
            fd, tmp = tempfile.mkstemp(suffix=".mp4", prefix="lumen_video_")
            os.close(fd)
            value.save_to(tmp)
            if os.path.isfile(tmp) and os.path.getsize(tmp) > 0:
                return tmp, True
        except Exception as e:
            print(f"  ⚠️ VIDEO 对象落盘失败: {e}")
        return None, False

    def _extract_paths(self, value):
        """从上游节点输出中防御性提取文件路径列表。
        VHS_FILENAMES 的实际结构随 VHS 版本不同：可能是 dict
        （含 filenames/fullpath 等键）、list/tuple、或纯字符串

        参数:
            value: 上游输出的原始值（任意结构）
        返回:
            路径字符串列表（可能为空）
        """
        paths = []
        if value is None:
            return paths
        if isinstance(value, str):
            if value.strip():
                paths.append(value)
        elif isinstance(value, dict):
            # 已知键按序探测，命中第一个即递归取值
            for key in ("filenames", "fullpath", "filename", "paths", "file"):
                if value.get(key):
                    paths.extend(self._extract_paths(value[key]))
                    break
        elif isinstance(value, (list, tuple)):
            # 列表/元组逐项递归展开
            for item in value:
                paths.extend(self._extract_paths(item))
        return paths

    def send_video(self, auto_send, video=None, vhs_filenames=None, lumen_target=""):
        """把每个视频文件二进制 POST 到 LumenLight 后端

        参数:
            auto_send:     False 时跳过发送（直通模式）
            video:         原生 VIDEO 对象（可单个或列表）
            vhs_filenames: VHS 文件路径引用（结构不限，见 _extract_paths）
            lumen_target:  画板发起节点 id（透传，预留）
        返回:
            (paths,) 换行分隔的已发送文件路径列表
        说明:
            单个视频发送失败只打印错误不中断——回传是旁路功能，
            不应让整个工作流执行失败
        """
        # 上游来源优先级：原生 VIDEO 对象 > VHS Filenames。
        # jobs 每项为 (文件路径, 是否上传后删除的临时文件)
        jobs = []
        if video is not None:
            video_values = video if isinstance(video, (list, tuple)) else [video]
            for value in video_values:
                resolved, is_temp = self._video_object_to_file(value)
                if resolved:
                    jobs.append((resolved, is_temp))
                else:
                    print("  ❌ 无法读取上游 VIDEO 对象（save_to 失败）")
        if not jobs:
            jobs.extend((p, False) for p in self._extract_paths(vhs_filenames))
        # 路径来源统一做存在性解析（VHS 输出可能是相对路径）；
        # 临时文件已是绝对路径，跳过解析
        jobs = [(self._resolve_path(p) if not is_temp else p, is_temp) for p, is_temp in jobs]
        jobs = [(p, t) for p, t in jobs if p]

        if auto_send and not jobs:
            print("⚠️ Lumen: 未连接上游视频，未发送任何视频")
        if auto_send:
            print(f"📤 Lumen: Sending {len(jobs)} video(s) to canvas...")

        results = []
        for i, (resolved, is_temp) in enumerate(jobs):
            try:
                # 白名单前置校验：后端不收的格式提前拦下并说明
                ext = os.path.splitext(resolved)[1].lower()
                if ext not in self.ALLOWED_EXTS:
                    print(f"  ❌ Video {i + 1}: 不支持的格式 {ext}（支持: {sorted(self.ALLOWED_EXTS)}）")
                    results.append("")
                    continue

                # 整文件读入后以字节流直传（不 base64，避免体积膨胀）
                with open(resolved, "rb") as f:
                    payload = f.read()
                print(f"  🎬 Video {i + 1}: {resolved} ({len(payload) / 1024 / 1024:.1f} MB)")

                response = requests.post(
                    self.BACKEND_URL,
                    data=payload,
                    params={
                        "filename": os.path.basename(resolved),
                        "target": lumen_target or ""
                    },
                    headers={"Content-Type": "application/octet-stream"},
                    # 视频体积大，上传超时放宽到 5 分钟
                    timeout=300
                )
                if response.status_code == 200:
                    data = response.json()
                    print(f"  ✅ Video {i + 1} sent: {data.get('videoUrl', '')}")
                    results.append(resolved)
                else:
                    print(f"  ❌ Failed: {response.status_code} {response.text[:200]}")
                    results.append("")
            except Exception as e:
                print(f"  ❌ Error: {e}")
                results.append("")
            finally:
                # VIDEO 对象落出的临时文件上传后清理（无论成败）；
                # 引用的原始文件（is_temp=False）绝不动
                if is_temp:
                    try:
                        os.remove(resolved)
                    except OSError:
                        pass

        return ("\n".join(results),)


NODE_CLASS_MAPPINGS = {
    "LumenSendVideoToCanvas": LumenSendVideoToCanvas
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LumenSendVideoToCanvas": "💡 To Canvas (Video)"
}
