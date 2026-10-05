/**
 * ==========================================================================
 * LumenLight MCP 服务器管理路由
 * ==========================================================================
 * 作用：画布作为 MCP 宿主的后端接口——管理用户登记的 MCP 服务器
 *       （设置 → MCP），并把工具暴露给 pi 桥接扩展（lumen-mcp）：
 *   GET  /api/mcp/overview     配置 + 连接状态 + 工具清单（设置界面数据源）
 *   POST /api/mcp/servers      保存服务器列表（settings.json mcp.servers）
 *                              并差量应用（新增/启用连接、移除/停用断开）
 *   POST /api/mcp/connect      { id } 手动连接单个服务器
 *   POST /api/mcp/disconnect   { id } 断开单个服务器
 *   POST /api/mcp/call         { serverId, tool, args } 工具调用代理
 *                              （pi 桥接扩展 execute 的落点）
 *   GET  /api/mcp/tools        工具扁平清单（pi 桥接扩展注册用）
 * ==========================================================================
 */

const express = require('express');

/**
 * 创建 MCP 管理路由
 * @param {Object} options - 依赖项
 * @param {Object} options.mcpManager - MCPManager 实例（utils/mcpManager.js）
 * @returns {express.Router}
 */
function createMcpRouter({ mcpManager }) {
    const router = express.Router();

    /** 总览：配置 + 状态 + 工具清单 */
    router.get('/overview', async (req, res) => {
        try {
            res.json({ status: 'ok', servers: await mcpManager.getOverview() });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    /** 保存服务器列表并差量应用（comfyRoot 有变动时自动认领） */
    router.post('/servers', async (req, res) => {
        try {
            const result = await mcpManager.saveServers((req.body || {}).servers);
            res.json({ status: 'ok', servers: result.servers, claims: result.claims });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    /** 手动连接单个服务器 */
    router.post('/connect', async (req, res) => {
        try {
            const id = String((req.body || {}).id || '');
            const ok = await mcpManager.connectById(id);
            const entry = mcpManager.servers.get(id);
            res.json({
                status: 'ok',
                connected: ok,
                error: ok ? '' : (entry ? entry.error : '未找到该服务器')
            });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    /** 手动断开单个服务器 */
    router.post('/disconnect', async (req, res) => {
        try {
            const id = String((req.body || {}).id || '');
            await mcpManager.disconnect(id);
            res.json({ status: 'ok' });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    /**
     * 打开系统原生文件夹选择窗口（PowerShell 调系统 IFileDialog，
     * 资源管理器同款现代对话框），返回用户选择的绝对路径。
     * 浏览器拿不到本地绝对路径，由后端代为弹窗；
     * 仅 Windows 可用。请求会阻塞到用户选择/取消为止
     */
    router.post('/pick-folder', async (req, res) => {
        try {
            const result = await mcpManager.pickFolder();
            res.json({ status: 'ok', ...result });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    /** comfy-mcp 专用：认领 ComfyUI 根目录（等价 comfy set-default） */
    router.post('/comfy-set-default', async (req, res) => {
        try {
            const body = req.body || {};
            const result = await mcpManager.comfySetDefault(
                String(body.serverId || ''),
                String(body.rootPath || '')
            );
            res.json({ status: 'ok', ...result });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    /** 工具调用代理（pi 桥接扩展的 execute 落点） */
    router.post('/call', async (req, res) => {
        try {
            const body = req.body || {};
            const result = await mcpManager.callTool(
                String(body.serverId || ''),
                String(body.tool || ''),
                body.args
            );
            res.json({ status: 'ok', ...result });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    /** 工具扁平清单（pi 桥接扩展注册用）+ 资源/提示词能力服务器清单 */
    router.get('/tools', async (req, res) => {
        try {
            const tools = await mcpManager.getAllTools();
            const caps = await mcpManager.getCapabilityServers();
            res.json({ status: 'ok', tools, ...caps });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    /** 聚合资源清单（按服务器分组，过权限门禁） */
    router.get('/resources', async (req, res) => {
        try {
            res.json({ status: 'ok', servers: await mcpManager.listAllResources() });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    /** 实时列出某服务器的资源清单 */
    router.post('/resources/list', async (req, res) => {
        try {
            const result = await mcpManager.listServerResources(String((req.body || {}).serverId || ''));
            res.json({ status: 'ok', ...result });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    /** 读取资源内容（text 拼接 + 原始 contents） */
    router.post('/resources/read', async (req, res) => {
        try {
            const body = req.body || {};
            const result = await mcpManager.readResource(String(body.serverId || ''), String(body.uri || ''));
            res.json({ status: 'ok', ...result });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    /** 聚合提示词模板清单（按服务器分组，过权限门禁） */
    router.get('/prompts', async (req, res) => {
        try {
            res.json({ status: 'ok', servers: await mcpManager.listAllPrompts() });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    /** 获取（渲染）提示词模板 */
    router.post('/prompt/get', async (req, res) => {
        try {
            const body = req.body || {};
            const result = await mcpManager.getPrompt(
                String(body.serverId || ''),
                String(body.name || ''),
                body.args
            );
            res.json({ status: 'ok', ...result });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    /** 重列某服务器的工具/资源/提示词清单（缓存刷新） */
    router.post('/refresh', async (req, res) => {
        try {
            const result = await mcpManager.refresh(String((req.body || {}).serverId || ''));
            res.json({ status: 'ok', ...result });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    return router;
}

module.exports = createMcpRouter;
