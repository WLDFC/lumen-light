/**
 * ==========================================================================
 * LumenLight 漫画编辑器草稿路由
 * 作用：漫画编辑器（顶栏「漫画编辑」弹窗）的草稿自动持久化，
 *       F5 / 关闭页面 / 换会话后重开编辑器可恢复（见 ADR 018）。
 *       草稿为全局单份（不绑定画布存档——编辑器是独立工具，
 *       产物经「复制/写入面板」流向画布），存 this.draft 原样 JSON，
 *       含编辑器侧 item.shot 景别元数据（编译前由前端剥离）。
 * 数据落盘（首次保存时自动创建，原子写 tmp+rename——恢复型数据）：
 *   data/manga-draft.json = { "draft": {…MOSS 草稿…}, "savedAt": 1761… }
 * 接口一览：
 *   GET  /    读取草稿（文件不存在/损坏时 draft 为 null，永不 500）
 *   PUT  /    保存草稿 { draft }（形状校验不过 400）
 * 说明：不设 DELETE——编辑器「新建草稿」= PUT 一份全新默认草稿，语义等价。
 * 挂载方式：server.js 中以 DATA_DIR 创建并挂载到 /api/manga-draft。
 * ==========================================================================
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');

/** 单页草稿的最小形状校验（宽松：完整归一在前端 CoordinateLayout.normalizeDraft） */
function isValidPageShape(draft) {
    return !!draft
        && typeof draft === 'object'
        && !Array.isArray(draft)
        && typeof draft.width === 'number'
        && Number.isFinite(draft.width)
        && typeof draft.height === 'number'
        && Number.isFinite(draft.height)
        && !!draft.summary
        && typeof draft.summary === 'object'
        && Array.isArray(draft.items);
}

/**
 * PUT 载荷校验，两种形态都收（宽松：完整归一在前端 _normalizeDocument）：
 *   - 多页文档：{ pages: [单页草稿...]（1..500）, active: 界内整数 }
 *   - 旧版单页草稿（一期数据）
 */
function isValidDraftShape(draft) {
    if (isValidPageShape(draft)) return true;
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return false;
    if (!Array.isArray(draft.pages) || draft.pages.length < 1 || draft.pages.length > 500) return false;
    if (!Number.isInteger(draft.active) || draft.active < 0 || draft.active >= draft.pages.length) return false;
    return draft.pages.every(isValidPageShape);
}

/**
 * 创建漫画编辑器草稿路由
 * @param {Object} options - 依赖项
 * @param {string} options.dataDir - 数据文件存放目录（data/）
 * @returns {express.Router} Express 路由实例
 */
function createMangaDraftRouter({ dataDir }) {
    const router = express.Router();
    const draftPath = path.join(dataDir, 'manga-draft.json');

    /** 读取草稿文件（不存在或损坏时返回 null，GET 永不 500） */
    async function readDraft() {
        try {
            const store = JSON.parse(await fs.readFile(draftPath, 'utf-8'));
            return isValidDraftShape(store.draft) ? store.draft : null;
        } catch {
            return null;
        }
    }

    /** 原子写（先 .tmp 再 rename，防写一半进程死亡毁掉恢复型数据） */
    async function writeStore(store) {
        const tmp = draftPath + '.tmp';
        await fs.mkdir(dataDir, { recursive: true });
        await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf-8');
        await fs.rename(tmp, draftPath);
    }

    // 读取草稿
    router.get('/', async (req, res) => {
        try {
            const draft = await readDraft();
            res.json({ status: 'ok', draft });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    // 保存草稿
    router.put('/', async (req, res) => {
        try {
            const { draft } = req.body || {};
            if (!isValidDraftShape(draft)) {
                return res.status(400).json({
                    status: 'error',
                    message: '草稿格式不合法（多页文档需 pages 数组 + active 下标，或旧版单页草稿：width/height 数字、summary 对象、items 数组）'
                });
            }
            const savedAt = Date.now();
            await writeStore({ draft, savedAt });
            res.json({ status: 'ok', savedAt });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    return router;
}

module.exports = createMangaDraftRouter;
