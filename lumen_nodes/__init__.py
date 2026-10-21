# ===========================================================================
# LumenLight ComfyUI 自定义节点包入口
# ===========================================================================
# 本包实现 LumenLight 画板与 ComfyUI 之间的双向桥接节点，共四个，
# 按方向分两组：
#
#   【ComfyUI → 画板】生成结果回传：
#     - LumenSendImageRealtime        💡 To Canvas (Image)    图片回传
#       （生成图实时经 WebSocket 推送到画板）
#     - LumenSendVideoToCanvas        💡 To Canvas (Video)    视频回传
#       （原生 VIDEO / VHS Filenames 二进制直传，落 data/videos/）
#
#   【画板 → ComfyUI】素材送入工作流：
#     - LumenReceiveImageFromCanvas   💡 From Canvas (Edit Image)  图片槽位
#       （1-9 号槽位取图，mask 语义与 LoadImage 同约定：透明=重绘区，
#        供 Edit / 局部重绘 / 多图编辑工作流）
#     - LumenReceiveVideoFromCanvas   💡 From Canvas (Video Ref)   视频槽位
#       （1-3 号槽位取视频引用，输出 VIDEO 容器 + 帧序列 IMAGE + 音频 AUDIO
#        + 帧数/帧率 + VHS 引用/元信息，供视频参考 / V2V 工作流）
#
# 加载策略：每个节点独立 try/except——单个节点依赖缺失（如 requests
# 未装、ComfyUI 版本过旧无 VIDEO 类型）只跳过该节点并打印原因，
# 不影响其余节点加载。
#
# ComfyUI 通过扫描 custom_nodes 目录加载本包，约定导出两个字典：
#   NODE_CLASS_MAPPINGS        节点类注册表（内部类名 → 节点类）
#   NODE_DISPLAY_NAME_MAPPINGS 节点显示名（内部类名 → 界面显示名）
# ===========================================================================

import sys
import os

# 添加当前目录到路径（保证节点文件内的相对导入 / 直接执行场景都能找到同目录模块）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# ComfyUI 约定的节点注册表（模块加载时逐个节点填充）
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

try:
    # 导入图片发送节点（ComfyUI -> 画板）
    from .LumenSendImageRealtime import LumenSendImageRealtime
    NODE_CLASS_MAPPINGS["LumenSendImageRealtime"] = LumenSendImageRealtime
    NODE_DISPLAY_NAME_MAPPINGS["LumenSendImageRealtime"] = "💡 To Canvas (Image)"
    print("✅ Lumen: Output node loaded")
except Exception as e:
    print(f"⚠️ Lumen Output node skip: {e}")

try:
    # 导入视频发送节点（ComfyUI -> 画板）
    from .LumenSendVideoToCanvas import LumenSendVideoToCanvas
    NODE_CLASS_MAPPINGS["LumenSendVideoToCanvas"] = LumenSendVideoToCanvas
    NODE_DISPLAY_NAME_MAPPINGS["LumenSendVideoToCanvas"] = "💡 To Canvas (Video)"
    print("✅ Lumen: Video output node loaded")
except Exception as e:
    print(f"⚠️ Lumen Video output node skip: {e}")

try:
    # 导入从画板获取图片节点（用于 Edit）
    from .LumenReceiveImageFromCanvas import LumenReceiveImageFromCanvas
    NODE_CLASS_MAPPINGS["LumenReceiveImageFromCanvas"] = LumenReceiveImageFromCanvas
    NODE_DISPLAY_NAME_MAPPINGS["LumenReceiveImageFromCanvas"] = "💡 From Canvas (Edit Image)"
    print("✅ Lumen: Edit image node loaded")
except Exception as e:
    print(f"⚠️ Lumen Edit image node skip: {e}")

try:
    # 导入从画板获取视频节点（用于视频参考 / V2V 工作流）
    from .LumenReceiveVideoFromCanvas import LumenReceiveVideoFromCanvas
    NODE_CLASS_MAPPINGS["LumenReceiveVideoFromCanvas"] = LumenReceiveVideoFromCanvas
    NODE_DISPLAY_NAME_MAPPINGS["LumenReceiveVideoFromCanvas"] = "💡 From Canvas (Video Ref)"
    print("✅ Lumen: Video reference node loaded")
except Exception as e:
    print(f"⚠️ Lumen Video reference node skip: {e}")

# 仅向 ComfyUI 暴露两个注册表字典，隐藏内部导入的中间符号
__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS']
