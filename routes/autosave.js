/**
 * ==========================================================================
 * 实时保存路由（本地磁盘自动保存）
 * 作用：为前端 RealtimeSaveManager 提供画布变更的持久化支持，
 *       数据写入 data/autosave/ 目录（与 save/ 正式存档分离，
 *       不会出现在「打开画布」的存档列表里）。所有数据都落在本机磁盘。
 *
 * 设计要点：
 *   1. 内容寻址资产：图片按内容 SHA-256 哈希命名存入 assets/，
 *      重复上传同一张图（幂等）直接命中已有文件，跳过写入——
 *      这是"实时保存只传增量"的地基；
 *   2. 元数据轻量：project.json 只记录图片引用（URL）、节点、连线、
 *      视口等结构信息，变更时整体覆盖写入，体积通常只有几 KB；
 *   3. 原子写入：project.json 先写 .tmp 再 rename，避免写一半崩溃
 *      留下损坏的恢复数据；
 *   4. 孤儿回收：每次元数据写入后，删除 assets/ 中不再被引用的图片，
 *      防止删除画布图片后资产无限累积。
 *
 * 路由：
 *   - POST   /asset : 上传一张图片资产（{ hash, src }，src 为 data URL）
 *   - POST   /meta  : 写入恢复元数据（{ data, currentSave }，整体覆盖）
 *   - GET    /      : 读取恢复元数据（含 savedAt / currentSave / data）
 *   - DELETE /      : 清空恢复槽位（用户拒绝恢复或不再需要时调用）
 * ==========================================================================
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');

// 哈希字段合法性校验：64 位十六进制（SHA-256），同时杜绝路径穿越
const HASH_PATTERN = /^[a-f0-9]{64}$/;

// data URL 前缀 → 资产文件扩展名（白名单，防止任意扩展名写入）
const MIME_EXTENSIONS = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif'
};

// 元数据文件名（data/autosave/project.json）
const META_FILENAME = 'project.json';

/**
 * 创建实时保存路由
 * @param {Object} options - 依赖项
 * @param {string} options.dir - 恢复数据目录（data/autosave），assets/ 为其子目录
 * @returns {express.Router} Express 路由实例
 */
function createAutosaveRouter({ dir }) {
    const router = express.Router();
    const assetsDir = path.join(dir, 'assets');

    /**
     * 确保目录存在，不存在则递归创建
     * @param {string} target - 目标目录
     */
    async function ensureDir(target) {
        await fs.mkdir(target, { recursive: true });
    }

    /**
     * 原子写入 JSON 文件：先写 .tmp 再 rename，
     * 避免写入中途崩溃留下截断/损坏的恢复数据
     * @param {string} filePath - 目标文件路径
     * @param {Object} payload - 可 JSON 序列化的对象
     */
    async function writeJsonAtomic(filePath, payload) {
        const tmpPath = `${filePath}.tmp`;
        await fs.writeFile(tmpPath, JSON.stringify(payload), 'utf8');
        await fs.rename(tmpPath, filePath);
    }

    /**
     * 从元数据中收集仍被引用的资产文件名集合
     * （元数据 images[].src 形如 /data/autosave/assets/<hash>.png）
     * @param {Object} data - project.json 的 data 字段
     * @returns {Set<string>} 引用的资产文件名
     */
    function collectReferencedAssets(data) {
        const referenced = new Set();
        for (const img of (data && Array.isArray(data.images) ? data.images : [])) {
            const src = typeof img?.src === 'string' ? img.src : '';
            const marker = '/assets/';
            const idx = src.lastIndexOf(marker);
            if (idx === -1) continue;
            const filename = src.slice(idx + marker.length);
            // 只认纯文件名（不含再往下的路径），防止误把别的路径当资产
            if (filename && !filename.includes('/')) referenced.add(filename);
        }
        return referenced;
    }

    // ==================== 资产上传（内容寻址，幂等） ====================

    /**
     * POST /asset —— 上传一张图片资产
     * 请求体：{ hash: 64位十六进制, src: 'data:image/png;base64,...' }
     * 同哈希文件已存在时直接返回已有 URL（内容寻址天然幂等，
     * 前端每轮变更只对"新出现的图"发起上传请求即可）
     */
    router.post('/asset', async (req, res) => {
        try {
            const { hash, src } = req.body || {};
            if (!HASH_PATTERN.test(hash || '')) {
                return res.json({ status: 'error', message: '非法的资产哈希' });
            }
            if (typeof src !== 'string' || !src.startsWith('data:image/')) {
                return res.json({ status: 'error', message: '仅支持 data URL 图片' });
            }

            // 解析 data URL：取 mime 与纯 base64 部分
            const match = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(src);
            if (!match) {
                return res.json({ status: 'error', message: 'data URL 格式无法解析' });
            }
            const ext = MIME_EXTENSIONS[match[1]];
            if (!ext) {
                return res.json({ status: 'error', message: `不支持的图片格式：${match[1]}` });
            }

            await ensureDir(assetsDir);
            const filename = `${hash}${ext}`;
            const destPath = path.join(assetsDir, filename);

            // 内容寻址：同名文件即同内容，命中则跳过写入（幂等去重）
            let existed = false;
            try {
                await fs.access(destPath);
                existed = true;
            } catch {
                await fs.writeFile(destPath, Buffer.from(match[2], 'base64'));
            }

            return res.json({
                status: 'ok',
                filename,
                existed,
                url: `/data/autosave/assets/${encodeURIComponent(filename)}`
            });
        } catch (err) {
            console.error('[实时保存] 资产上传失败:', err);
            return res.json({ status: 'error', message: err.message || '资产上传失败' });
        }
    });

    // ==================== 元数据写入 / 读取 / 清空 ====================

    /**
     * POST /meta —— 写入恢复元数据（整体覆盖）
     * 请求体：{ data: <与存档 project.json 的 data 字段同结构>, currentSave: string|null }
     * 写入成功后回收 assets/ 中不再被引用的孤儿资产
     */
    router.post('/meta', async (req, res) => {
        try {
            const { data, currentSave } = req.body || {};
            if (!data || typeof data !== 'object') {
                return res.json({ status: 'error', message: '缺少元数据 data 字段' });
            }

            await ensureDir(assetsDir);
            await writeJsonAtomic(path.join(dir, META_FILENAME), {
                version: 1,
                savedAt: Date.now(),
                currentSave: currentSave || null,
                data
            });

            // 孤儿回收：删除 assets/ 中不再被引用的文件
            // （画布图片被删除后，下一轮元数据写入即不再引用它）
            const referenced = collectReferencedAssets(data);
            let pruned = 0;
            try {
                for (const file of await fs.readdir(assetsDir)) {
                    if (referenced.has(file)) continue;
                    await fs.rm(path.join(assetsDir, file), { force: true });
                    pruned++;
                }
            } catch {
                // 资产目录不存在等异常不影响元数据写入结果
            }

            return res.json({ status: 'ok', pruned });
        } catch (err) {
            console.error('[实时保存] 元数据写入失败:', err);
            return res.json({ status: 'error', message: err.message || '元数据写入失败' });
        }
    });

    /**
     * GET / —— 读取恢复元数据
     * 不存在时返回 exists: false（前端据此判断是否弹出恢复询问）
     */
    router.get('/', async (req, res) => {
        try {
            const raw = await fs.readFile(path.join(dir, META_FILENAME), 'utf8');
            const meta = JSON.parse(raw);
            return res.json({
                status: 'ok',
                exists: true,
                savedAt: meta.savedAt || 0,
                currentSave: meta.currentSave || null,
                data: meta.data || null
            });
        } catch {
            // 文件不存在或解析失败都视为"无恢复数据"
            return res.json({ status: 'ok', exists: false });
        }
    });

    /**
     * DELETE / —— 清空恢复槽位
     * 用户在恢复询问中选择"不恢复"时调用，避免下次启动重复询问
     */
    router.delete('/', async (req, res) => {
        try {
            await fs.rm(dir, { recursive: true, force: true });
            return res.json({ status: 'ok' });
        } catch (err) {
            console.error('[实时保存] 清空恢复槽位失败:', err);
            return res.json({ status: 'error', message: err.message || '清空失败' });
        }
    });

    return router;
}

module.exports = createAutosaveRouter;
