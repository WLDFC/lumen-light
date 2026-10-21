/**
 * ==========================================================================
 * LumenLight Comfy 提示词预设路由
 * 作用：提供 Comfy 面板「提示词」按钮（ComfyPromptPresets）的预设库
 *       增删改查 HTTP API，持久化到 data/comfy-prompts.json。预设按
 *       用途分两库：
 *         - positive：正面提示词预设（注入面板正面框 1 / 2）
 *         - negative：负面提示词预设（注入面板负面框）
 *       不做模型绑定字段——「不同模型不同提示词」的适配语义由用户在
 *       预设标题里自行区分（如「anima-质量流」），与 LLM 系统提示词库
 *       （data/prompts.json，routes/prompts.js）域分离互不干扰。
 * 数据落盘结构（首次保存时自动创建）：
 *   {
 *     "positive": [ { "id", "name", "content", "createdAt", "updatedAt" } ],
 *     "negative": [ ... ]
 *   }
 * 接口一览：
 *   GET    /      读取两库全部预设
 *   POST   /      新建预设 { name, kind, content }（kind: positive|negative）
 *   PUT    /:id   更新预设的名称 / 内容（两库按 id 查找）
 *   DELETE /:id   删除预设（两库按 id 查找）
 * 挂载方式：server.js 中以 DATA_DIR 创建并挂载到 /api/comfy-prompts。
 * ==========================================================================
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const KINDS = ['positive', 'negative'];

/**
 * 创建 Comfy 提示词预设路由
 * @param {Object} options - 依赖项
 * @param {string} options.dataDir - 数据文件存放目录（data/）
 * @returns {express.Router} Express 路由实例
 */
function createComfyPromptsRouter({ dataDir }) {
    const router = express.Router();
    const storePath = path.join(dataDir, 'comfy-prompts.json');

    /**
     * 读取预设库文件（不存在或损坏时返回空库，永不 500）
     * @returns {Promise<{positive: Array, negative: Array}>}
     */
    async function readStore() {
        try {
            const content = await fs.readFile(storePath, 'utf-8');
            const store = JSON.parse(content);
            return {
                positive: Array.isArray(store.positive) ? store.positive : [],
                negative: Array.isArray(store.negative) ? store.negative : []
            };
        } catch {
            return { positive: [], negative: [] };
        }
    }

    /**
     * 写入预设库文件
     */
    async function writeStore(store) {
        await fs.mkdir(dataDir, { recursive: true });
        await fs.writeFile(storePath, JSON.stringify(store, null, 4), 'utf-8');
    }

    // 读取全部
    router.get('/', async (req, res) => {
        try {
            const store = await readStore();
            res.json({ status: 'ok', ...store });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    // 新建
    router.post('/', async (req, res) => {
        try {
            const { name, kind, content } = req.body || {};
            if (!name || !String(name).trim()) {
                return res.status(400).json({ status: 'error', message: '预设名称不能为空' });
            }
            if (!KINDS.includes(kind)) {
                return res.status(400).json({ status: 'error', message: 'kind 必须是 positive 或 negative' });
            }
            if (!content || !String(content).trim()) {
                return res.status(400).json({ status: 'error', message: '预设内容不能为空' });
            }

            const store = await readStore();
            const now = Date.now();
            const entry = {
                id: crypto.randomUUID(),
                name: String(name).trim(),
                content: String(content),
                createdAt: now,
                updatedAt: now
            };
            store[kind].push(entry);
            await writeStore(store);
            res.json({ status: 'ok', entry });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    // 更新名称 / 内容（两库按 id 查找，条目不跨库移动）
    router.put('/:id', async (req, res) => {
        try {
            const { name, content } = req.body || {};
            const store = await readStore();
            let entry = store.positive.find((p) => p.id === req.params.id);
            if (!entry) entry = store.negative.find((p) => p.id === req.params.id);
            if (!entry) {
                return res.status(404).json({ status: 'error', message: '预设不存在' });
            }
            if (name !== undefined) {
                if (!String(name).trim()) {
                    return res.status(400).json({ status: 'error', message: '预设名称不能为空' });
                }
                entry.name = String(name).trim();
            }
            if (content !== undefined) {
                if (!String(content).trim()) {
                    return res.status(400).json({ status: 'error', message: '预设内容不能为空' });
                }
                entry.content = String(content);
            }
            entry.updatedAt = Date.now();
            await writeStore(store);
            res.json({ status: 'ok', entry });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    // 删除（两库按 id 查找）
    router.delete('/:id', async (req, res) => {
        try {
            const store = await readStore();
            let removed = null;
            for (const kind of KINDS) {
                const idx = store[kind].findIndex((p) => p.id === req.params.id);
                if (idx > -1) {
                    [removed] = store[kind].splice(idx, 1);
                    break;
                }
            }
            if (!removed) {
                return res.status(404).json({ status: 'error', message: '预设不存在' });
            }
            await writeStore(store);
            res.json({ status: 'ok' });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    return router;
}

module.exports = createComfyPromptsRouter;
