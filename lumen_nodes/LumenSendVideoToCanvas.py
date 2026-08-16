import os
import tempfile
import requests

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

    BACKEND_URL = "http://localhost:8080/api/receive-video"
    # 允许上传的视频扩展名（与 LumenLight 后端保持一致）
    ALLOWED_EXTS = {".mp4", ".webm", ".mov", ".gif", ".mkv", ".avi"}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
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

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("paths",)
    FUNCTION = "send_video"
    OUTPUT_NODE = True
    CATEGORY = "LumenLight"

    def _resolve_path(self, raw):
        """把用户输入的路径解析为可读文件：绝对路径直用，
        相对路径依次在 ComfyUI 的 output / input / temp 目录查找"""
        raw = raw.strip().strip('"').strip("'")
        if not raw:
            return None
        if os.path.isabs(raw):
            return raw if os.path.isfile(raw) else None
        if folder_paths is not None:
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
        优先取内部已有的数据源文件（零拷贝），否则经 save_to 写临时 mp4"""
        # 1. VideoFromFile/VideoFromBytes 的内部数据源可能就是本地文件
        try:
            src = value.get_stream_source()
            if isinstance(src, str) and os.path.isfile(src):
                return src, False
        except Exception:
            pass
        # 2. 落成临时文件（CreateVideo 输出为 mp4 封装）
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
        （含 filenames/fullpath 等键）、list/tuple、或纯字符串"""
        paths = []
        if value is None:
            return paths
        if isinstance(value, str):
            if value.strip():
                paths.append(value)
        elif isinstance(value, dict):
            for key in ("filenames", "fullpath", "filename", "paths", "file"):
                if value.get(key):
                    paths.extend(self._extract_paths(value[key]))
                    break
        elif isinstance(value, (list, tuple)):
            for item in value:
                paths.extend(self._extract_paths(item))
        return paths

    def send_video(self, auto_send, video=None, vhs_filenames=None, lumen_target=""):
        """把每个视频文件二进制 POST 到 LumenLight 后端"""
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
        # 路径来源统一做存在性解析（VHS 输出可能是相对路径）
        jobs = [(self._resolve_path(p) if not is_temp else p, is_temp) for p, is_temp in jobs]
        jobs = [(p, t) for p, t in jobs if p]

        if auto_send and not jobs:
            print("⚠️ Lumen: 未连接上游视频，未发送任何视频")
        if auto_send:
            print(f"📤 Lumen: Sending {len(jobs)} video(s) to canvas...")

        results = []
        for i, (resolved, is_temp) in enumerate(jobs):
            try:
                ext = os.path.splitext(resolved)[1].lower()
                if ext not in self.ALLOWED_EXTS:
                    print(f"  ❌ Video {i + 1}: 不支持的格式 {ext}（支持: {sorted(self.ALLOWED_EXTS)}）")
                    results.append("")
                    continue

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
                # VIDEO 对象落出的临时文件上传后清理
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
