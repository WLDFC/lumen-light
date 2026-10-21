# ===========================================================================
# LumenSendImageRealtime —— 生成图片实时回传 LumenLight 画板（ComfyUI → 画板）
# ===========================================================================
# 用途：工作流末尾（SaveImage 之前）接上本节点，每次生成即把图片经
# LumenLight 后端推送到画板，用户在画布上即时看到结果。
#
# 传输方式：与视频节点（LumenSendVideoToCanvas）不同，图片体积小，
# 走 base64 JSON 直发后端 /api/receive-image，由后端经 WebSocket 以
# new-image 消息推给画板客户端——与画布回传消息格式同构。
#
# 依赖：requests + numpy + PIL + torch（ComfyUI 环境自带）。
# ===========================================================================

import requests
import numpy as np
from PIL import Image
import io
import base64
import torch

class LumenSendImageRealtime:
    """发送图片到 LumenLight 画板（HTTP 版，base64 JSON）

    支持批量：上游 IMAGE 输出是 [N, H, W, C] 张量时逐张发送，
    每张带 index/total，后端可按序推送。
    """

    # LumenLight 后端图片接收接口（与后端同机部署，端口硬编码
    # 与其余三个 Lumen 节点保持一致）
    BACKEND_URL = "http://localhost:8080/api/receive-image"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 上游生成的图片批次（ComfyUI 标准 IMAGE 类型：[N,H,W,C]，0~1 浮点）
                "images": ("IMAGE",),
                # 发送开关：False 时节点退化为直通（仅返回输入不发送），
                # 想临时停用回传又不想改连线时用
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

    # 直通输出：原样返回输入图片，方便继续接下游节点（如 SaveImage）
    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "send"
    # OUTPUT_NODE：声明为输出型节点——没有下游连线也会被执行
    # （ComfyUI 只执行有下游消费者或声明为输出节点的节点）
    OUTPUT_NODE = True
    CATEGORY = "LumenLight"

    def send(self, images, auto_send, lumen_target=""):
        """把输入图片批次逐张编码后发送到画板。

        参数:
            images:      [N, H, W, C] 浮点张量（0~1）
            auto_send:   False 时跳过发送（直通模式）
            lumen_target: 画板发起节点的 id（透传，用于占位图归属）
        返回:
            (images,) 原样透传
        说明:
            单张发送失败只打印错误不中断——回传是旁路功能，
            不应让整个工作流执行失败
        """
        if auto_send:
            print(f"📤 Lumen: Sending {len(images)} image(s) to canvas...")

            # 转换为 base64 并发送
            for i, img_tensor in enumerate(images):
                # Tensor -> PIL：反归一化到 0~255 整型再交给 PIL
                img_array = (img_tensor.cpu().numpy() * 255).astype(np.uint8)
                pil_img = Image.fromarray(img_array)

                print(f"  🖼️ Image {i+1}: tensor shape {img_tensor.shape}, PIL size {pil_img.size}")

                # PIL -> Base64：统一 PNG 编码（无损，画板端直接可读）
                buffered = io.BytesIO()
                pil_img.save(buffered, format="PNG")
                img_base64 = base64.b64encode(buffered.getvalue()).decode()

                # 发送到后端：index/total 让后端/前端知道批次进度
                try:
                    response = requests.post(
                        self.BACKEND_URL,
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
