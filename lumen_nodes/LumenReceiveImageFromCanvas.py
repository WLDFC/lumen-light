import requests
import numpy as np
from PIL import Image
import io
import base64
import torch

class LumenReceiveImageFromCanvas:
    """从 LumenLight 画板接收图片（用于 Edit 工作流）"""
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "slot": (["1", "2", "3"], {"default": "1"}),
                "wait_for_image": ("BOOLEAN", {"default": True}),
                "force_reload": ("BOOLEAN", {"default": True, "label": "强制重新加载"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "label": "随机种子（强制刷新）"}),
            }
        }
    
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "receive"
    CATEGORY = "LumenLight"

    def receive(self, slot, wait_for_image, force_reload=True, seed=0):
        """从画板获取指定槽位的图片"""
        print(f"\n📥 Lumen: Requesting image from slot {slot}...")
        print(f"  🔄 Force reload: {force_reload}, Seed: {seed}")

        try:
            # 从后端获取图片
            url = f"http://localhost:8080/api/canvas-image/{slot}"
            print(f"  🌐 GET {url}")

            response = requests.get(
                url,
                timeout=30 if wait_for_image else 5
            )

            print(f"  📡 Response: {response.status_code}")

            if response.status_code == 200:
                data = response.json()
                print(f"  📦 Data keys: {data.keys()}")

                if data.get("status") == "ok" and data.get("image"):
                    img_base64 = data["image"]
                    timestamp = data.get("timestamp", 0)
                    print(f"  📏 Base64 length: {len(img_base64)}, Timestamp: {timestamp}")

                    # Base64 -> PIL
                    img_bytes = base64.b64decode(img_base64)
                    print(f"  📦 Decoded bytes: {len(img_bytes)}")

                    pil_img = Image.open(io.BytesIO(img_bytes))
                    print(f"  🖼️ Image mode: {pil_img.mode}, size: {pil_img.size}")

                    # 处理透明通道
                    if pil_img.mode == 'RGBA':
                        # 分离 alpha 通道
                        r, g, b, a = pil_img.split()
                        # 创建白色背景
                        background = Image.new('RGB', pil_img.size, (255, 255, 255))
                        background.paste(pil_img, mask=a)
                        # 生成 mask
                        mask = np.array(a).astype(np.float32) / 255.0
                        mask = torch.from_numpy(mask).unsqueeze(0)
                        pil_img = background
                        print(f"  ✅ RGBA processed, mask created")
                    elif pil_img.mode != 'RGB':
                        pil_img = pil_img.convert('RGB')
                        mask = torch.ones((1, pil_img.size[1], pil_img.size[0]))
                        print(f"  ✅ Converted to RGB")
                    else:
                        mask = torch.ones((1, pil_img.size[1], pil_img.size[0]))

                    # PIL -> Tensor
                    img_array = np.array(pil_img).astype(np.float32) / 255.0
                    img_tensor = torch.from_numpy(img_array).unsqueeze(0)

                    print(f"  ✅ Image received: shape={img_tensor.shape}, dtype={img_tensor.dtype}")
                    return (img_tensor, mask)
                else:
                    print(f"  ⚠️ No image in slot {slot}, status: {data.get('status')}")
            else:
                print(f"  ❌ Failed to get image: {response.status_code}")
                print(f"  📄 Response: {response.text[:200]}")

        except Exception as e:
            print(f"  ❌ Error: {e}")
            import traceback
            traceback.print_exc()

        # 返回空白图
        print(f"  ⚠️ Returning empty image")
        empty_img = torch.zeros(1, 512, 512, 3)
        empty_mask = torch.zeros(1, 512, 512)
        return (empty_img, empty_mask)

NODE_CLASS_MAPPINGS = {
    "LumenReceiveImageFromCanvas": LumenReceiveImageFromCanvas
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "LumenReceiveImageFromCanvas": "💡 From Canvas (Edit Image)"
}
