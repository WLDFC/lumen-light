/**
 * ==========================================================================
 * LumenLight 用户资产接口（routes/assets.js）
 * ==========================================================================
 * 作用：承载「添加到资产」功能的存储端——把画布选中的图片保存到
 *       data/assets/，并供资产库内置标签「我的资产」列出与读取。
 *
 * 设计：
 *   - 内容寻址：按图片内容 SHA-256 哈希命名（<hash>.<ext>），同一张图
 *     反复保存天然幂等去重（与 data/autosave/assets、tag/images 的
 *     内容哈希惯例一致）；
 *   - 展示名与保存时间存 index.json sidecar——哈希文件名对人不可读，
 *     资产卡片标签显示保存时的原始文件名；同内容重复保存保留首次展示名；
 *   - 只存图片不存视频（入口是图片工具栏；视频走 data/videos/ 链路）；
 *   - 不提供删除接口：资产库里删除「我的资产」标签只是前端解除视图
 *     绑定（localStorage 标记），磁盘文件不丢，再次保存即恢复显示。
 *
 * 路由：
 *   POST /          保存一张图片 { src: 'data:image/...;base64,...', name? }
 *   GET /           列出全部资产 { exists, items: [{filename,name,size,savedAt,url}] }
 *   GET /file/:name 按文件名读取图片字节（扩展名白名单 + 路径穿越防护）
 * ==========================================================================
 */

const express = require('express');
const fs = require('fs').promises;
const crypto = require('crypto');
const path = require('path');

/** data URL mime → 文件扩展名 */
const MIME_EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp'
};

/** 允许写入/列出的图片扩展名（列表按扩展名过滤，防杂文件混入） */
const IMAGE_EXT_PATTERN = /\.(png|jpe?g|gif|webp|bmp)$/i;

const INDEX_FILENAME = 'index.json';

/**
 * 创建用户资产路由
 * @param {Object} options
 * @param {string} options.assetsDir - 资产目录（data/assets，首次保存自动创建）
 */
module.exports = function createAssetsRouter({ assetsDir }) {
    const router = express.Router();

    async function ensureDir() {
        await fs.mkdir(assetsDir, { recursive: true });
    }

    /** 读取展示名 sidecar；缺失/损坏按空表处理 */
    async function readIndex() {
        try {
            const raw = await fs.readFile(path.join(assetsDir, INDEX_FILENAME), 'utf8');
            const data = JSON.parse(raw);
            return data && typeof data === 'object' ? data : {};
        } catch {
            return {};
        }
    }

    /** 整体覆盖写入展示名 sidecar */
    async function writeIndex(index) {
        await ensureDir();
        await fs.writeFile(
            path.join(assetsDir, INDEX_FILENAME),
            JSON.stringify(index, null, 2),
            'utf8'
        );
    }

    /**
     * POST / —— 保存一张图片（内容寻址，幂等）
     * 请求体：{ src: 'data:image/png;base64,...', name?: '展示文件名' }
     * 返回：{ status:'ok', filename, name, existed, url }
     */
    router.post('/', async (req, res) => {
        try {
            const { src, name } = req.body || {};
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
            const buffer = Buffer.from(match[2], 'base64');
            if (buffer.length === 0) {
                return res.json({ status: 'error', message: '图片内容为空' });
            }

            // 内容哈希命名：同内容只存一份（幂等去重）
            const hash = crypto.createHash('sha256').update(buffer).digest('hex');
            const filename = `${hash}.${ext}`;
            const destPath = path.join(assetsDir, filename);
            let existed = false;
            await ensureDir();
            try {
                await fs.access(destPath);
                existed = true;
            } catch {
                await fs.writeFile(destPath, buffer);
            }

            // 展示名 sidecar：已存在时保留首次的展示名
            const displayName = (typeof name === 'string' && name.trim())
                ? name.trim()
                : `asset-${hash.slice(0, 8)}.${ext}`;
            const index = await readIndex();
            if (!index[filename]) {
                index[filename] = { name: displayName, savedAt: Date.now() };
                await writeIndex(index);
            }

            return res.json({
                status: 'ok',
                filename,
                name: index[filename].name,
                existed,
                url: `/api/assets/file/${encodeURIComponent(filename)}`
            });
        } catch (err) {
            console.error('[资产] 保存失败:', err);
            return res.json({ status: 'error', message: err.message || '保存失败' });
        }
    });

    /**
     * GET / —— 列出全部资产。
     * exists 标记目录是否已建立（前端据此决定是否显示内置标签「我的资产」），
     * 按保存时间倒序
     */
    router.get('/', async (req, res) => {
        try {
            let entries;
            try {
                entries = await fs.readdir(assetsDir);
            } catch {
                return res.json({ status: 'ok', exists: false, items: [] });
            }
            const index = await readIndex();
            const items = [];
            for (const filename of entries) {
                if (filename === INDEX_FILENAME || !IMAGE_EXT_PATTERN.test(filename)) continue;
                try {
                    const st = await fs.stat(path.join(assetsDir, filename));
                    const meta = index[filename] || {};
                    items.push({
                        filename,
                        name: meta.name || filename,
                        size: st.size,
                        savedAt: meta.savedAt || Math.floor(st.mtimeMs),
                        url: `/api/assets/file/${encodeURIComponent(filename)}`
                    });
                } catch { /* 单个文件 stat 失败跳过，不影响其余 */ }
            }
            items.sort((a, b) => b.savedAt - a.savedAt);
            return res.json({ status: 'ok', exists: true, items });
        } catch (err) {
            console.error('[资产] 列表失败:', err);
            return res.json({ status: 'error', message: err.message || '列表失败' });
        }
    });

    /**
     * GET /file/:name —— 读取图片字节。
     * 文件名取 basename + 扩展名白名单 + 解析后仍须落在 assetsDir 内，
     * 三重防护防路径穿越
     */
    router.get('/file/:name', async (req, res) => {
        try {
            const name = path.basename(req.params.name || '');
            if (!IMAGE_EXT_PATTERN.test(name)) {
                return res.status(400).json({ status: 'error', message: '非法的文件名' });
            }
            const filePath = path.join(assetsDir, name);
            if (!path.resolve(filePath).startsWith(path.resolve(assetsDir) + path.sep)) {
                return res.status(400).json({ status: 'error', message: '非法的文件路径' });
            }
            await fs.access(filePath);
            return res.sendFile(filePath);
        } catch {
            return res.status(404).json({ status: 'error', message: '文件不存在' });
        }
    });

    return router;
};
