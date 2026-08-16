/**
 * ==========================================================================
 * LumenLight pi 智能体路由
 * 作用：LLM 窗口与 pi RPC 进程之间的 HTTP 入口：
 *   - POST /api/pi/prompt    ：发用户消息（自动切模型/会话，流式内容走 WS 广播）
 *   - POST /api/pi/abort     ：中止当前推理
 *   - GET  /api/pi/state     ：pi 运行状态
 *   - GET  /api/pi/permission    ：读取权限分级（pi 扩展的工具拦截用）
 *   - POST /api/pi/permission    ：设置权限分级（设置→通用）
 *   - GET  /api/pi/provider-config ：LLM 面板模型 → pi provider 注册配置
 * ==========================================================================
 */

const express = require('express');

function createPiAgentRouter({ manager }) {
    const router = express.Router();

    router.post('/prompt', async (req, res) => {
        try {
            const { message, images, archive, provider, modelId } = req.body || {};
            if (!message || !message.trim()) {
                return res.status(400).json({ status: 'error', message: '消息为空' });
            }
            const result = await manager.prompt({
                message: message.trim(),
                images: Array.isArray(images) ? images : [],
                archive: archive || null,
                provider: provider || null,
                modelId: modelId || null
            });
            res.json({ status: 'ok', ...result });
        } catch (err) {
            console.error('[pi] prompt 失败:', err.message);
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    router.post('/abort', async (req, res) => {
        try {
            await manager.abort();
            res.json({ status: 'ok' });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    router.get('/state', async (req, res) => {
        try {
            res.json({ status: 'ok', data: await manager.getState() });
        } catch (err) {
            res.json({ status: 'ok', data: { running: false } });
        }
    });

    router.get('/permission', (req, res) => {
        res.json({ status: 'ok', level: manager.getPermissionLevel() });
    });

    router.post('/permission', (req, res) => {
        const { level } = req.body || {};
        manager.setPermissionLevel(level);
        res.json({ status: 'ok', level: manager.getPermissionLevel() });
    });

    router.get('/provider-config', (req, res) => {
        res.json({ status: 'ok', data: manager.getProviderConfig() });
    });

    return router;
}

module.exports = createPiAgentRouter;
