/**
 * ==========================================================================
 * 画板视频槽位管理路由（引用式槽位）
 * 作用：管理供 ComfyUI LumenReceiveVideoFromCanvas 节点读取的画板视频槽位，
 *       支持 1-3 号槽位，与 routes/canvasImages.js 的图片槽按位对称：
 *   1. 保存视频引用到指定槽位（POST /api/canvas-video/:slot）
 *   2. 获取指定槽位的视频元数据（GET /api/canvas-video/:slot）
 *   3. 流式回传槽位视频文件字节（GET /api/canvas-video/:slot/file）
 *
 * 与图片槽的设计差异（为什么存引用而不是 base64）：
 *   图片几十 KB~几 MB，base64 JSON 无压力；视频动辄几十上百 MB，
 *   base64 会额外膨胀 33% 且挤爆内存。画布视频本来就以文件形式落在
 *   后端 data/videos/ 目录，槽位只存引用（videoUrl + filename），
 *   Comfy 节点取视频时由本路由经 sendFile 直接流式回传磁盘文件。
 *
 * 引用校验：写入时校验目标文件存在于 data/videos/（basename 防路径
 * 穿越）；读取文件时实时校验存在性——data/videos/ 的文件会被保存归档
 * GC 清理，槽位引用可能失效，失效时返回 404 与明确 message（节点侧
 * 报"槽位视频已被清理"而不是糊一个空视频）。
 * ==========================================================================
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;

// 允许的视频扩展名（与 lumen_nodes/LumenReceiveVideoFromCanvas.py、
// LumenSendVideoToCanvas.py 的白名单保持一致）
const ALLOWED_EXTS = new Set(['.mp4', '.webm', '.mov', '.gif', '.mkv', '.avi']);

// 槽位上限（与图片槽 routes/canvasImages.js 保持一致）
const MAX_SLOTS = 3;

/**
 * 创建画板视频槽位管理路由
 * @param {Object} options - 依赖项
 * @param {Object} options.canvasVideos - 视频槽位数据对象（槽位号 → 引用或 null）
 * @param {Object} options.canvasVideosTimestamp - 视频槽位时间戳对象
 * @param {string} options.videosDir - 视频工作区目录（data/videos/ 绝对路径）
 * @returns {express.Router} Express 路由实例
 */
function createCanvasVideoRouter(options) {
    const { canvasVideos, canvasVideosTimestamp, videosDir } = options;
    const router = express.Router();

    /**
     * 把前端传来的 videoUrl（如 "data/videos/xxx.mp4" 或 "/data/videos/xxx.mp4"）
     * 解析为 data/videos/ 内的合法文件名。返回 {filename, ext} 或 null。
     * basename 归一化防路径穿越——只允许 videosDir 直接子文件
     */
    function parseVideoUrl(videoUrl) {
        if (typeof videoUrl !== 'string' || !videoUrl.trim()) return null;
        // 剥掉开头的 /、data/videos/ 前缀（兼容两种写法），再取 basename
        const filename = path.basename(videoUrl.trim().replace(/^\/?(?:data\/videos\/)?/, ''));
        if (!filename || filename === '.' || filename === '..') return null;
        const ext = path.extname(filename).toLowerCase();
        if (!ALLOWED_EXTS.has(ext)) return null;
        return { filename, ext };
    }

    /**
     * 校验视频文件存在于 data/videos/。存在返回绝对路径，不存在返回 null
     */
    async function resolveVideoFile(filename) {
        const filePath = path.join(videosDir, filename);
        try {
            const stat = await fs.stat(filePath);
            return stat.isFile() ? filePath : null;
        } catch {
            return null;
        }
    }

    /**
     * POST /api/canvas-video/:slot
     * 保存视频引用到指定槽位（1-3）。body: { videoUrl } 或 { videoUrl: null } 清槽。
     * 写入时校验文件存在于 data/videos/，避免绑定后立刻 404 的脏引用
     */
    router.post('/:slot', async (req, res) => {
        const slot = parseInt(req.params.slot);
        console.log(`📥 POST /api/canvas-video/${slot}`);

        if (slot < 1 || slot > MAX_SLOTS) {
            return res.status(400).json({
                status: 'error',
                message: `槽位必须是 1-${MAX_SLOTS}`
            });
        }

        const { videoUrl } = req.body;
        if (videoUrl === undefined) {
            return res.status(400).json({
                status: 'error',
                message: '缺少 videoUrl 数据'
            });
        }

        // 显式传 null = 清空槽位（与图片槽语义一致）
        if (videoUrl === null) {
            canvasVideos[slot] = null;
            canvasVideosTimestamp[slot] = 0;
            console.log(`  🧹 视频槽位 ${slot} 已清空`);
            return res.json({
                status: 'ok',
                message: `视频槽位 ${slot} 已清空`,
                timestamp: 0
            });
        }

        // 解析 + 白名单 + 存在性校验，任一失败拒绝写入
        const parsed = parseVideoUrl(videoUrl);
        if (!parsed) {
            return res.status(400).json({
                status: 'error',
                message: '非法的视频引用（路径穿越或格式不在白名单）'
            });
        }
        const filePath = await resolveVideoFile(parsed.filename);
        if (!filePath) {
            return res.status(404).json({
                status: 'error',
                message: `视频文件不存在或已被清理: ${parsed.filename}`
            });
        }

        const hadOld = canvasVideos[slot] !== null;
        canvasVideos[slot] = {
            videoUrl: `data/videos/${parsed.filename}`,
            filename: parsed.filename
        };
        canvasVideosTimestamp[slot] = Date.now();
        console.log(`  ✅ 视频引用已保存到槽位 ${slot}: ${parsed.filename}，时间戳: ${canvasVideosTimestamp[slot]}`);

        res.json({
            status: 'ok',
            message: `视频引用已保存到槽位 ${slot}`,
            replaced: hadOld,
            filename: parsed.filename,
            timestamp: canvasVideosTimestamp[slot]
        });
    });

    /**
     * GET /api/canvas-video/:slot
     * 获取指定槽位的视频元数据（轻量 JSON，不传视频本体，
     * 供 ComfyUI LumenReceiveVideoFromCanvas 节点第一步调用）
     */
    router.get('/:slot', async (req, res) => {
        const slot = parseInt(req.params.slot);
        console.log(`\n📤 GET /api/canvas-video/${slot}`);
        console.log(`  当前槽位${slot}引用: ${canvasVideos[slot]?.filename || 'null'}, 时间戳: ${canvasVideosTimestamp[slot]}`);

        if (slot < 1 || slot > MAX_SLOTS) {
            return res.status(400).json({
                status: 'error',
                message: `槽位必须是 1-${MAX_SLOTS}`
            });
        }

        const ref = canvasVideos[slot];
        if (!ref) {
            return res.status(404).json({
                status: 'error',
                message: `槽位 ${slot} 没有视频`
            });
        }

        // 返回元数据前实时校验文件存在性（data/videos/ 会被保存归档 GC
        // 清理，引用可能已失效）——失效按"没有视频"处理，并顺手清空槽位
        const filePath = await resolveVideoFile(ref.filename);
        if (!filePath) {
            canvasVideos[slot] = null;
            canvasVideosTimestamp[slot] = 0;
            console.log(`  ⚠️ 槽位 ${slot} 引用的视频已被清理，槽位已自动清空`);
            return res.status(404).json({
                status: 'error',
                message: `槽位 ${slot} 的视频文件已被清理: ${ref.filename}（请重新绑定）`
            });
        }

        console.log(`  ✅ 返回槽位 ${slot} 元数据: ${ref.filename}, 时间戳: ${canvasVideosTimestamp[slot]}`);
        res.json({
            status: 'ok',
            filename: ref.filename,
            videoUrl: ref.videoUrl,
            timestamp: canvasVideosTimestamp[slot]
        });
    });

    /**
     * GET /api/canvas-video/:slot/file
     * 流式回传槽位视频文件字节（供节点第二步下载落盘）。
     * 不设 Range——节点侧整文件下载后由 VideoFromFile 包装
     */
    router.get('/:slot/file', async (req, res) => {
        const slot = parseInt(req.params.slot);
        console.log(`📤 GET /api/canvas-video/${slot}/file`);

        if (slot < 1 || slot > MAX_SLOTS) {
            return res.status(400).json({
                status: 'error',
                message: `槽位必须是 1-${MAX_SLOTS}`
            });
        }

        const ref = canvasVideos[slot];
        if (!ref) {
            return res.status(404).json({
                status: 'error',
                message: `槽位 ${slot} 没有视频`
            });
        }

        const filePath = await resolveVideoFile(ref.filename);
        if (!filePath) {
            return res.status(404).json({
                status: 'error',
                message: `槽位 ${slot} 的视频文件已被清理: ${ref.filename}（请重新绑定）`
            });
        }

        // sendFile 流式回传（不整读进内存），按扩展名给 Content-Type
        res.sendFile(filePath, (err) => {
            if (err) {
                // 客户端中止（如节点侧超时）会走到这里，仅记日志
                console.error(`  ❌ 回传槽位 ${slot} 视频失败: ${err.message}`);
            }
        });
    });

    return router;
}

module.exports = createCanvasVideoRouter;
