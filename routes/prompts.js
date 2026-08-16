/**
 * ==========================================================================
 * LumenLight 系统提示词路由
 * 作用：提供 LLM 对话框"系统提示词"库的增删改查 HTTP API，
 *       持久化到 data/prompts.json。提示词按场景分两类：
 *         - chat  ：聊天模型，注入 chat/completions 的 system 角色
 *         - image ：生图模型，拼接在图片提示词前部（生图 API 无 system 角色）
 * 数据落盘结构（首次保存时自动创建）：
 *   {
 *     "prompts": [ { "id", "name", "scene", "content", "createdAt", "updatedAt" } ],
 *     "active":  { "chat": "id|null", "image": "id|null" }
 *   }
 * 接口一览：
 *   GET    /         读取全部提示词与启用状态
 *   POST   /         新建提示词 { name, scene, content }（新建即设为该场景启用项）
 *   PUT    /:id      更新提示词的名称 / 内容
 *   DELETE /:id      删除提示词（若为启用项则同时清除启用状态）
 *   PUT    /active   设置某场景的启用项 { scene, id }（id 传 null 表示不启用）
 * 挂载方式：server.js 中以 DATA_DIR 创建并挂载到 /api/system-prompts。
 * ==========================================================================
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const SCENES = ['chat', 'image'];

/**
 * 创建系统提示词路由
 * @param {Object} options - 依赖项
 * @param {string} options.dataDir - 数据文件存放目录（data/）
 * @returns {express.Router} Express 路由实例
 */
function createPromptsRouter({ dataDir }) {
    const router = express.Router();
    const promptsPath = path.join(dataDir, 'prompts.json');

    /**
     * 读取提示词库文件（不存在或损坏时返回空库）
     * @returns {Promise<{prompts: Array, active: Object}>}
     */
    async function readStore() {
        try {
            const content = await fs.readFile(promptsPath, 'utf-8');
            const store = JSON.parse(content);
            return {
                prompts: Array.isArray(store.prompts) ? store.prompts : [],
                active: store.active && typeof store.active === 'object'
                    ? store.active
                    : { chat: null, image: null }
            };
        } catch {
            return { prompts: [], active: { chat: null, image: null } };
        }
    }

    /**
     * 写入提示词库文件
     */
    async function writeStore(store) {
        await fs.mkdir(dataDir, { recursive: true });
        await fs.writeFile(promptsPath, JSON.stringify(store, null, 4), 'utf-8');
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

    // 新建（新建即设为该场景的启用项）
    router.post('/', async (req, res) => {
        try {
            const { name, scene, content } = req.body || {};
            if (!name || !String(name).trim()) {
                return res.status(400).json({ status: 'error', message: '提示词名称不能为空' });
            }
            if (!SCENES.includes(scene)) {
                return res.status(400).json({ status: 'error', message: '场景必须是 chat 或 image' });
            }
            if (!content || !String(content).trim()) {
                return res.status(400).json({ status: 'error', message: '提示词内容不能为空' });
            }

            const store = await readStore();
            const now = Date.now();
            const prompt = {
                id: uuidv4(),
                name: String(name).trim(),
                scene,
                content: String(content),
                createdAt: now,
                updatedAt: now
            };
            store.prompts.push(prompt);
            store.active[scene] = prompt.id;
            await writeStore(store);
            res.json({ status: 'ok', prompt, active: store.active });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    // 设置某场景的启用项
    // 注意：必须注册在 PUT /:id 之前，否则 "active" 会被当作 id 匹配
    router.put('/active', async (req, res) => {
        try {
            const { scene, id } = req.body || {};
            if (!SCENES.includes(scene)) {
                return res.status(400).json({ status: 'error', message: '场景必须是 chat 或 image' });
            }
            const store = await readStore();
            if (id !== null && id !== undefined) {
                if (!store.prompts.some((p) => p.id === id)) {
                    return res.status(404).json({ status: 'error', message: '提示词不存在' });
                }
                store.active[scene] = id;
            } else {
                store.active[scene] = null;
            }
            await writeStore(store);
            res.json({ status: 'ok', active: store.active });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    // 更新名称 / 内容
    router.put('/:id', async (req, res) => {
        try {
            const { name, content } = req.body || {};
            const store = await readStore();
            const prompt = store.prompts.find((p) => p.id === req.params.id);
            if (!prompt) {
                return res.status(404).json({ status: 'error', message: '提示词不存在' });
            }
            if (name !== undefined) {
                if (!String(name).trim()) {
                    return res.status(400).json({ status: 'error', message: '提示词名称不能为空' });
                }
                prompt.name = String(name).trim();
            }
            if (content !== undefined) {
                if (!String(content).trim()) {
                    return res.status(400).json({ status: 'error', message: '提示词内容不能为空' });
                }
                prompt.content = String(content);
            }
            prompt.updatedAt = Date.now();
            await writeStore(store);
            res.json({ status: 'ok', prompt });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    // 删除（若为启用项则同时清除启用状态）
    router.delete('/:id', async (req, res) => {
        try {
            const store = await readStore();
            const idx = store.prompts.findIndex((p) => p.id === req.params.id);
            if (idx === -1) {
                return res.status(404).json({ status: 'error', message: '提示词不存在' });
            }
            const [removed] = store.prompts.splice(idx, 1);
            for (const scene of SCENES) {
                if (store.active[scene] === removed.id) store.active[scene] = null;
            }
            await writeStore(store);
            res.json({ status: 'ok', active: store.active });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    return router;
}

module.exports = createPromptsRouter;
