/**
 * ==========================================================================
 * 画板图片槽位管理路由
 * 作用：管理供 ComfyUI Edit 节点读取的画板图片槽位，支持 1-3 号槽位：
 *   1. 保存图片到指定槽位
 *   2. 获取指定槽位的图片
 *   3. 清除指定槽位的图片
 * ==========================================================================
 */

const express = require('express');

/**
 * 创建画板图片槽位管理路由
 * @param {Object} options - 依赖项
 * @param {Object} options.canvasImages - 画板图片槽位数据对象
 * @param {Object} options.canvasImagesTimestamp - 画板图片槽位时间戳对象
 * @returns {express.Router} Express 路由实例
 */
function createCanvasImagesRouter(options) {
    const { canvasImages, canvasImagesTimestamp } = options;
    const router = express.Router();

    /**
     * POST /api/canvas-image/:slot
     * 保存画板图片到指定槽位（1-3）
     */
    router.post('/:slot', async (req, res) => {
        const slot = parseInt(req.params.slot);
        console.log(`📥 POST /api/canvas-image/${slot}`);

        if (slot < 1 || slot > 3) {
            return res.status(400).json({
                status: 'error',
                message: '槽位必须是 1-3'
            });
        }

        const { image } = req.body;
        if (image === undefined) {
            console.log(`  ❌ 缺少图片数据`);
            return res.status(400).json({
                status: 'error',
                message: '缺少图片数据'
            });
        }

        // 显式传 null = 清空槽位（如本次运行无遮罩时清掉上次残留的遮罩槽）
        if (image === null) {
            canvasImages[slot] = null;
            canvasImagesTimestamp[slot] = 0;
            console.log(`  🧹 槽位 ${slot} 已清空`);
            return res.json({
                status: 'ok',
                message: `槽位 ${slot} 已清空`,
                timestamp: 0
            });
        }

        // 检查是否替换了旧图片
        const hadOldImage = canvasImages[slot] !== null;
        if (hadOldImage) {
            console.log(`  🔄 替换槽位 ${slot} 的旧图片`);
        }

        canvasImages[slot] = image;
        canvasImagesTimestamp[slot] = Date.now();
        console.log(`  ✅ 图片已保存到槽位 ${slot}，长度: ${image.length}，时间戳: ${canvasImagesTimestamp[slot]}`);

        res.json({
            status: 'ok',
            message: `图片已保存到槽位 ${slot}`,
            replaced: hadOldImage,
            timestamp: canvasImagesTimestamp[slot]
        });
    });

    /**
     * GET /api/canvas-image/:slot
     * 获取指定槽位的画板图片（供 ComfyUI 自定义节点使用）
     */
    router.get('/:slot', async (req, res) => {
        const slot = parseInt(req.params.slot);
        const requestId = Date.now();
        console.log(`\n📤 [${requestId}] GET /api/canvas-image/${slot}`);
        console.log(`  当前槽位${slot}图片长度: ${canvasImages[slot]?.length || 'null'}, 时间戳: ${canvasImagesTimestamp[slot]}`);

        if (slot < 1 || slot > 3) {
            return res.status(400).json({
                status: 'error',
                message: '槽位必须是 1-3'
            });
        }

        const image = canvasImages[slot];
        if (!image) {
            console.log(`  ⚠️ 槽位 ${slot} 没有图片`);
            return res.status(404).json({
                status: 'error',
                message: `槽位 ${slot} 没有图片`
            });
        }

        console.log(`  ✅ [${requestId}] 返回槽位 ${slot} 图片，长度: ${image.length}，时间戳: ${canvasImagesTimestamp[slot]}`);
        res.json({
            status: 'ok',
            image: image,
            timestamp: canvasImagesTimestamp[slot]
        });
    });

    return router;
}

module.exports = createCanvasImagesRouter;
