/**
 * ==========================================================================
 * LumenLight pi 智能体路由
 * 作用：LLM 窗口与 pi RPC 进程之间的 HTTP 入口：
 *   - POST /api/pi/prompt    ：发用户消息（自动切模型/会话，流式内容走 WS 广播）
 *   - POST /api/pi/abort     ：中止当前推理（清队列+掐 bash+中止，明细返回）
 *   - GET  /api/pi/stop-signal ：停止信号时间戳（扩展后台任务取消检查用）
 *   - POST /api/pi/reset-session ：重置当前存档的 pi 会话（清空对话联动）
 *   - POST /api/pi/restart     ：重启 pi 进程（状态灯黄/红点击、疑似卡死按钮用；
 *                                kill 后自动拉起新进程接续会话）
 *   - GET  /api/pi/state     ：pi 运行状态
 *   - GET  /api/pi/permission    ：读取权限分级 + 禁用工具清单（扩展工具拦截用）
 *   - POST /api/pi/permission    ：设置权限分级（设置→通用）
 *   - GET/POST /api/pi/disabled-tools ：禁用工具清单（面板「工具与技能」勾选；
 *                                扩展经 setActiveTools 移除，下一轮消息生效）
 *   - GET/POST /api/pi/extension-tools ：扩展工具清单注册表（上报/展示）
 *   - GET  /api/pi/provider-config ：LLM 面板模型 → pi provider 注册配置
 *   - GET  /api/pi/attachments ：当前消息附图（扩展 refImages 按 attachment:N 引用取图）
 * ==========================================================================
 */

const express = require('express');
const path = require('path');

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
            // 返回各步明细（clearQueue/abortBash/abortSent）：pi 僵死时前两步
            // 超时失败、abort 仍已写入——前端据此决定提示口径
            const detail = await manager.abort();
            res.json({ status: 'ok', data: detail });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    // 停止信号查询：lumen-canvas 扩展的后台生图/视频任务用它感知
    // "用户已点停止"并自我取消（轮询 at 是否晚于自己提交时刻）
    router.get('/stop-signal', (req, res) => {
        res.json({ status: 'ok', at: manager.lastAbortAt });
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
        // disabledTools 顺带下发：扩展的 tool_call 钩子一次请求同时拿到
        // 权限分级与禁用清单，两道门禁共用这一次往返
        res.json({ status: 'ok', level: manager.getPermissionLevel(), disabledTools: manager.getDisabledTools() });
    });

    router.post('/permission', (req, res) => {
        const { level } = req.body || {};
        manager.setPermissionLevel(level);
        res.json({ status: 'ok', level: manager.getPermissionLevel() });
    });

    // ==================== 工具启停（面板「工具与技能」） ====================

    // 禁用工具清单：面板勾选读写；扩展在 pi 启动与每回合开始
    // （before_agent_start）读取并经 setActiveTools 移除，下一轮消息生效
    router.get('/disabled-tools', (req, res) => {
        res.json({ status: 'ok', disabledTools: manager.getDisabledTools() });
    });

    router.post('/disabled-tools', (req, res) => {
        const { disabledTools } = req.body || {};
        res.json({ status: 'ok', disabledTools: manager.setDisabledTools(disabledTools) });
    });

    // 扩展工具清单注册表：lumen-canvas 在会话启动时把 pi 当前配置的全部
    // 扩展工具（名/描述）上报至此，落盘 data/pi/tools-registry.json——
    // pi 未运行时面板也有清单可显示（上一次上报的快照，扩展更新后
    // 下次上报自动刷新）
    const toolsRegistryFile = path.join(manager.dataDir, 'pi', 'tools-registry.json');

    router.post('/extension-tools', (req, res) => {
        try {
            const { extension, tools } = req.body || {};
            if (!extension || typeof extension !== 'string') {
                return res.status(400).json({ status: 'error', message: '缺少 extension 标识' });
            }
            const list = (Array.isArray(tools) ? tools : [])
                .map((t) => ({
                    name: String(t?.name || ''),
                    label: String(t?.label || ''),
                    description: String(t?.description || '').slice(0, 300)
                }))
                .filter((t) => t.name);
            const registry = manager._readJson(toolsRegistryFile, {});
            registry[extension] = { reportedAt: Date.now(), tools: list };
            manager._writeJson(toolsRegistryFile, registry);
            res.json({ status: 'ok', count: list.length });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    router.get('/extension-tools', (req, res) => {
        res.json({ status: 'ok', registry: manager._readJson(toolsRegistryFile, {}) });
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
