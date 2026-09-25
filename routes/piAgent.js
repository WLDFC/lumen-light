/**
 * ==========================================================================
 * LumenLight pi 智能体路由
 * 作用：LLM 窗口与 pi RPC 进程之间的 HTTP 入口：
 *   - POST /api/pi/prompt    ：发用户消息（自动切模型/会话，流式内容走 WS 广播）
 *   - POST /api/pi/abort     ：中止当前推理
 *   - POST /api/pi/reset-session ：重置当前存档的 pi 会话（清空对话联动）
 *   - POST /api/pi/restart     ：重启 pi 进程（状态灯黄/红点击、疑似卡死按钮用；
 *                                kill 后自动拉起新进程接续会话）
 *   - GET  /api/pi/state     ：pi 运行状态
 *   - GET  /api/pi/permission    ：读取权限分级（pi 扩展的工具拦截用）
 *   - POST /api/pi/permission    ：设置权限分级（设置→通用）
 *   - GET  /api/pi/provider-config ：LLM 面板模型 → pi provider 注册配置
 *   - GET  /api/pi/attachments ：当前消息附图（扩展 refImages 按 attachment:N 引用取图）
 * ==========================================================================
 */

const express = require('express');

function createPiAgentRouter({ manager }) {
    const router = express.Router();

    router.post('/prompt', async (req, res) => {
        try {
            const { message, images, archive, provider, modelId, systemPrompt } = req.body || {};
            if (!message || !message.trim()) {
                return res.status(400).json({ status: 'error', message: '消息为空' });
            }
            const result = await manager.prompt({
                message: message.trim(),
                images: Array.isArray(images) ? images : [],
                archive: archive || null,
                provider: provider || null,
                modelId: modelId || null,
                systemPrompt: typeof systemPrompt === 'string' ? systemPrompt : ''
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

    router.post('/reset-session', async (req, res) => {
        try {
            const { archive } = req.body || {};
            await manager.resetSession(archive || null);
            res.json({ status: 'ok' });
        } catch (err) {
            console.error('[pi] reset-session 失败:', err.message);
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    // 重启 pi 进程：状态灯黄/红点击与疑似卡死按钮共用（async：kill 后等旧进程
    // 退出再拉起新进程接续会话，避免新旧 pi 并存持有同一会话文件）
    router.post('/restart', async (req, res) => {
        try {
            await manager.restart();
            res.json({ status: 'ok' });
        } catch (err) {
            console.error('[pi] restart 失败:', err.message);
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

    // 当前消息附图：扩展 canvas_run_llm_image 按 attachment:N 引用取用户刚发的图，
    // 避免模型拿画布图片名猜附图、猜错编辑了无关的图
    router.get('/attachments', (req, res) => {
        res.json({ status: 'ok', attachments: manager.getAttachments() });
    });

    return router;
}

module.exports = createPiAgentRouter;
