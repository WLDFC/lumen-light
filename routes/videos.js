/**
 * ==========================================================================
 * LumenLight 视频工作区管理路由
 * 作用：管理 data/videos/ 视频工作区（实时保存的临时视频落点）：
 *   - DELETE /api/videos/:filename : 画布删除视频对象时立即删除对应文件。
 *     仅允许删除 data/videos/ 目录内的文件（basename 防路径穿越），
 *     存档内副本（save/<名>/videos/）不归本接口管。
 * 保存时的批量清理（引用 GC）在 routes/saves.js 的 commitSave 内完成。
 * ==========================================================================
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;

function createVideosRouter({ videosDir }) {
    const router = express.Router();

    router.delete('/:filename', async (req, res) => {
        try {
            // basename 归一化：只允许删 data/videos/ 直接子文件，拒绝路径穿越
            const filename = path.basename(String(req.params.filename || ''));
            if (!filename || filename === '.' || filename === '..') {
                return res.status(400).json({ status: 'error', message: '非法文件名' });
            }

            const filePath = path.join(videosDir, filename);
            try {
                const stat = await fs.stat(filePath);
                if (!stat.isFile()) {
                    return res.status(400).json({ status: 'error', message: '目标不是文件' });
                }
            } catch {
                // 文件已不存在：视为删除成功（幂等）
                return res.json({ status: 'ok', message: '文件不存在，视为已删除' });
            }

            await fs.rm(filePath);
            console.log(`🗑️ 已删除视频工作区文件: ${filename}`);
            res.json({ status: 'ok' });
        } catch (error) {
            console.error('删除视频文件失败:', error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    return router;
}

module.exports = createVideosRouter;
