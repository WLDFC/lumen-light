import requests
import numpy as np
from PIL import Image
import io
import base64
import torch

class LumenSendImageRealtime:
    """发送图片到 LumenLight 画板（HTTP版）"""
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "auto_send": ("BOOLEAN", {"default": True}),
            },
            # 可选透传字段：画板 Comfy 生图节点提交工作流时注入自己的节点 id，
            # 后端随 WebSocket 消息原样回传，前端据此把生成图精确落到
            # 发起生成的那个节点的占位图上（并发多个节点时互不串图）。
            # 不注入时为空串，后端走默认落图逻辑，与提示词面板流程兼容。
            "optional": {
                "lumen_target": ("STRING", {"default": ""}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "send"
    OUTPUT_NODE = True
    CATEGORY = "LumenLight"

    def send(self, images, auto_send, lumen_target=""):
        if auto_send:
            print(f"📤 Lumen: Sending {len(images)} image(s) to canvas...")

            # 转换为 base64 并发送
            for i, img_tensor in enumerate(images):
                # Tensor -> PIL
                img_array = (img_tensor.cpu().numpy() * 255).astype(np.uint8)
                pil_img = Image.fromarray(img_array)

                print(f"  🖼️ Image {i+1}: tensor shape {img_tensor.shape}, PIL size {pil_img.size}")

                # PIL -> Base64
                buffered = io.BytesIO()
                pil_img.save(buffered, format="PNG")
                img_base64 = base64.b64encode(buffered.getvalue()).decode()

                # 发送到后端
                try:
                    response = requests.post(
                        "http://localhost:8080/api/receive-image",
                        json={
                            "image": img_base64,
                            "index": i,
                            "total": len(images),
                            "target": lumen_target or None
                        },
                        timeout=10
                    )
                    if response.status_code == 200:
                        print(f"  ✅ Image {i+1} sent successfully")
                    else:
                        print(f"  ❌ Failed: {response.status_code}")
                except Exception as e:
                    print(f"  ❌ Error: {e}")

        return (images,)

NODE_CLASS_MAPPINGS = {
    "LumenSendImageRealtime": LumenSendImageRealtime
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "LumenSendImageRealtime": "💡 To Canvas (Image)"
}