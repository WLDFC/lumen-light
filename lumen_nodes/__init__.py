import sys
import os

# 添加当前目录到路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

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

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS']
