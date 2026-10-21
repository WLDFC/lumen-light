/**
 * ==========================================================================
 * LumenLight 音频工作区管理路由
 * 作用：管理 data/audio/ 音频工作区（画布音频文件的临时落点）：
 *   - POST /api/audios          : 上传本地音频文件（拖拽/粘贴到画布时持久化）。
 *     请求体：原始二进制流（Content-Type: application/octet-stream），
 *     查询参数 filename（原始文件名，仅取扩展名），扩展名白名单校验。
 *   - DELETE /api/audios/:filename : 画布删除音频对象时立即删除对应文件。
 *     仅允许删除 data/audio/ 目录内的文件（basename 防路径穿越）。
 * 与 routes/videos.js 同一约定：存档内副本（save/<名>/audios/）不归本接口管，
 * 保存时的引用 GC 由 routes/saves.js 负责。
 * ==========================================================================
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;

/** 音频扩展名白名单（MIME 缺失时按扩展名兜底判断的同一清单） */
const AUDIO_EXTS = /\.(mp3|wav|ogg|m4a|flac|aac|opus|weba)$/i;

function createAudiosRouter({ audiosDir }) {
    const router = express.Router();

    const rawParser = express.raw({ type: 'application/octet-stream', limit: '200mb' });

    router.post('/', rawParser, async (req, res) => {
        try {
            if (!req.body || req.body.length === 0) {
                return res.status(400).json({ status: 'error', message: '未接收到音频数据' });
            }

            // 只取原始文件名的扩展名做白名单校验（文件名本身不落盘，
            // 统一重命名为 audio_<时间戳><扩展名> 防重名与穿越）
            const originalName = String(req.query.filename || 'audio.mp3');
            const ext = path.extname(originalName).toLowerCase();
            if (!AUDIO_EXTS.test(ext)) {
                return res.status(400).json({
                    status: 'error',
                    message: `不支持的音频格式: ${ext || '(无扩展名)'}`
                });
            }

            const safeName = `audio_${Date.now()}${ext}`;
            await fs.mkdir(audiosDir, { recursive: true });
            const destPath = path.join(audiosDir, safeName);
            await fs.writeFile(destPath, req.body);

            const relativePath = path.relative(
                path.join(__dirname, '..'), destPath).replace(/\\/g, '/');
            console.log(`🎵 音频上传完成: ${relativePath} (${(req.body.length / 1024 / 1024).toFixed(1)}MB)`);
            res.json({ status: 'ok', audioPath: relativePath });
        } catch (error) {
            console.error('音频上传失败:', error);
            res.status(500).json({ status: 'error', message: error.message || '音频上传失败' });
        }
    });

    router.delete('/:filename', async (req, res) => {
        try {
            // basename 归一化：只允许删 data/audio/ 直接子文件，拒绝路径穿越
            const filename = path.basename(String(req.params.filename || ''));
            if (!filename || filename === '.' || filename === '..') {
                return res.status(400).json({ status: 'error', message: '非法文件名' });
            }

            const filePath = path.join(audiosDir, filename);
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
            console.log(`🗑️ 已删除音频工作区文件: ${filename}`);
            res.json({ status: 'ok' });
        } catch (error) {
            console.error('删除音频文件失败:', error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    return router;
}

module.exports = createAudiosRouter;
