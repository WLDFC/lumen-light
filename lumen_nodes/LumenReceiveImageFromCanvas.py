# ===========================================================================
# LumenReceiveImageFromCanvas —— 从 LumenLight 画板取图送入工作流（画板 → ComfyUI）
# ===========================================================================
# 用途：Edit / 局部重绘 / 多图编辑工作流。画板端把选定的图片（base64）
# 写入 1-9 号槽位（随工作流提交自动写入），本节点按槽位编号取图。
#
# 遮罩（mask）语义与 ComfyUI LoadImage 同约定：透明像素 = 1 = 重绘区。
# 搭配 LumenLight 遮罩灯箱：涂抹过遮罩的图片以 RGBA 提交（遮罩区域
# 透明），本节点的 mask 输出可直接接 VAE Encode for Inpainting /
# SetLatentNoiseMask。
# mask 来源两级：优先读专用遮罩槽 /api/canvas-mask/:slot（黑白图，
# 白=重绘区，由前端遮罩灯箱随提交写入），槽位为空时回退 alpha 派生。
#
# 依赖：requests + numpy + PIL + torch（ComfyUI 环境自带）。
# ===========================================================================

import requests
import numpy as np
from PIL import Image
import io
import base64
import torch

class LumenReceiveImageFromCanvas:
    """从 LumenLight 画板接收图片（用于 Edit / 局部重绘工作流）

    mask 输出与 ComfyUI LoadImage 同约定：透明像素 = 1 = 重绘区。
    搭配 LumenLight 遮罩灯箱：涂抹过遮罩的图片以 RGBA 提交（遮罩区域
    透明），本节点的 mask 输出可直接接 VAE Encode for Inpainting /
    SetLatentNoiseMask；无 alpha 通道的图片 mask 全 0（保留全图）。
    """

    # LumenLight 后端图片槽位接口（与后端同机部署，端口硬编码
    # 与其余三个 Lumen 节点保持一致）：GET /api/canvas-image/{slot}
    # 取图、/api/canvas-mask/{slot} 取遮罩槽（见 receive/_fetch_mask_from_slot）

    # 槽位上限（与后端 canvasImages 槽位校验、面板槽位扫描钳制对齐；
    # 多图编辑模型可能引用多张画布图，扩容只改这一个数字——
    # 三处同源：本节点 slot 枚举、routes/canvasImages.js 校验、
    # PromptPanel.collectContentSlots 扫描钳制）
    MAX_SLOTS = 9

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 槽位编号：画板提交工作流时把选定图片写入对应槽位，
                # 模板里靠编号取用（面板槽位按 Receive 节点出现顺序
                # 1..N 对位写入，N 个取图节点请把 slot 依次设为 1..N）
                "slot": ([str(i) for i in range(1, cls.MAX_SLOTS + 1)], {"default": "1"}),
                # 等待模式：True=槽位暂空时最长等 30s（提交即跑的常规场景，
                # 容忍画板端图片上传在途）；False=只等 5s 快速失败
                "wait_for_image": ("BOOLEAN", {"default": True}),
                # 强制重新加载：True=不读本地缓存每次都重新拉取槽位
                "force_reload": ("BOOLEAN", {"default": True, "label": "强制重新加载"}),
                # 随机种子：ComfyUI 不重跑输入值未变的节点，改 seed 即
                # 强制本节点重新执行（手动刷新用，不参与逻辑）
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "label": "随机种子（强制刷新）"}),
            }
        }

    # 双输出：image 供重绘/编辑主链路；mask 供 inpainting 链路
    # （接 VAE Encode for Inpainting / SetLatentNoiseMask）
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "receive"
    CATEGORY = "LumenLight"

    def _fetch_mask_from_slot(self, slot):
        """从专用遮罩槽读取黑白遮罩图（白=重绘区=1）。

        尽力而为：遮罩槽为空/超时返回 None，调用方回退 alpha 派生。
        不用长等待——没涂遮罩的运行不该被这里拖住
        """
        try:
            url = f"http://localhost:8080/api/canvas-mask/{slot}"
            response = requests.get(url, timeout=3)
            if response.status_code != 200:
                return None
            data = response.json()
            if data.get("status") != "ok" or not data.get("image"):
                return None
            pil = Image.open(io.BytesIO(base64.b64decode(data["image"]))).convert("RGB")
            arr = np.array(pil).astype(np.float32) / 255.0
            # 黑白图取红通道：白(255)=1=重绘区
            mask = torch.from_numpy(arr[:, :, 0]).unsqueeze(0)
            print(f"  🎭 Mask loaded from mask slot {slot}")
            return mask
        except Exception as e:
            print(f"  ℹ️ Mask slot {slot} unavailable ({e}), falling back to alpha")
            return None

    def receive(self, slot, wait_for_image, force_reload=True, seed=0):
        """ComfyUI 执行入口：从画板获取指定槽位的图片
        （mask 优先读专用遮罩槽，回退 alpha 派生）。

        参数:
            slot:           槽位编号（"1".."9"，与画板端面板槽位按序对位）
            wait_for_image: 等待策略（30s / 5s）
            force_reload:   是否强制重新拉取
            seed:           随机种子（仅用于强制刷新节点执行，不参与逻辑）
        返回:
            (image, mask) —— 取不到时返回 512×512 空白图 + 全 0 遮罩
            （图片场景保留空兜底以兼容旧工作流；视频节点无兜底是刻意差异）
        """
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

                    # 处理透明通道（mask 语义与 ComfyUI LoadImage 一致：
                    # 透明 = 1 = 重绘区）。遮罩优先取专用遮罩槽（黑白图，
                    # 由前端遮罩灯箱随提交写入），槽位为空时回退 alpha 派生
                    slot_mask = self._fetch_mask_from_slot(slot)
                    if pil_img.mode == 'RGBA':
                        # 分离 alpha 通道
                        r, g, b, a = pil_img.split()
                        # 图像 = 原始 RGB 像素原样保留（与 ComfyUI LoadImage 的
                        # convert("RGB") 同语义：透明区只丢 alpha 不动颜色）。
                        # 禁止合成白底——白洞会被模糊遮罩/低降噪的采样渗进
                        # 重绘结果（表现为遮罩区输出白色糊状物）
                        pil_img = Image.merge('RGB', (r, g, b))
                        if slot_mask is not None:
                            mask = slot_mask
                        else:
                            # alpha 派生回退：透明区=1=重绘区
                            mask = 1.0 - (np.array(a).astype(np.float32) / 255.0)
                            mask = torch.from_numpy(mask).unsqueeze(0)
                        print(f"  ✅ RGBA processed, mask ready (transparent=repaint)")
                    elif pil_img.mode != 'RGB':
                        pil_img = pil_img.convert('RGB')
                        # 无 alpha 通道 = 无遮罩信息：遮罩槽优先，全 0 兜底
                        mask = slot_mask if slot_mask is not None \
                            else torch.zeros((1, pil_img.size[1], pil_img.size[0]))
                        print(f"  ✅ Converted to RGB, mask ready")
                    else:
                        mask = slot_mask if slot_mask is not None \
                            else torch.zeros((1, pil_img.size[1], pil_img.size[0]))

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
