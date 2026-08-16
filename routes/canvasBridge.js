/**
 * ==========================================================================
 * LumenLight 画布桥接路由（Canvas Bridge）
 * ==========================================================================
 * 作用：把画布能力以"工具命令"形式暴露给外部 agent（pi 编码智能体、
 *       未来的 MCP server 等）。协议无关的核心层：
 *
 *   agent 工具调用 → POST /api/canvas-bridge/command
 *     → WebSocket 推给浏览器（type: bridge-command）
 *     → 浏览器执行真实画布操作（LumenSocket 执行器）
 *     → POST /api/canvas-bridge/response 回传结果（带相同 id）
 *     → agent 拿到工具结果继续推理
 *
 * 设计要点：
 *   - 应答走 HTTP 而非 WebSocket 回流：不侵入 server.js 的现有消息
 *     分发，浏览器侧也只需普通 fetch，两侧解耦；
 *   - 请求带唯一 id + 超时（20s）+ pending 映射，命令/应答可靠关联；
 *   - 本路由不解释命令语义——命令清单由浏览器执行器定义（见
 *     js/api/LumenSocket.js 的 _execBridgeCommand），桥接层只做
 *     转发与关联，未来新增画布能力无需改这里。
 * ==========================================================================
 */

const express = require('express');
const WebSocket = require('ws');

/** 桥接命令超时（浏览器执行存档等操作可能较慢，放宽到 30s） */
const BRIDGE_TIMEOUT_MS = 30 * 1000;

function createCanvasBridgeRouter({ clients }) {
    const router = express.Router();

    /** id -> { res, timer }，等待浏览器回传应答的挂起请求 */
    const pending = new Map();
    let bridgeSeq = 0;

    /** 需要路由到单一客户端的写命令（广播会重复执行） */
    const MUTATING_COMMANDS = new Set(['drop_image', 'delete_media', 'clear_media']);
    /** 心跳新鲜度阈值：超过视为页面失去响应 */
    const FRESH_MS = 10 * 1000;

    /**
     * 在线画布客户端列表（按 lastSeen 新→旧排序）
     */
    function listCanvasClients() {
        return [...clients.values()]
            .filter((c) => c.role === 'canvas' && c.ws.readyState === WebSocket.OPEN)
            .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    }

    /**
     * POST /api/canvas-bridge/command
     * 转发一条画布命令给浏览器执行。
     * 请求体：{ command: string, params?: object }
     * 应答：{ status:'ok', id, data }（浏览器执行结果）或错误
     */
    router.post('/command', (req, res) => {
        const { command, params } = req.body || {};
        if (!command || typeof command !== 'string') {
            return res.status(400).json({ status: 'error', message: '缺少 command' });
        }

        const canvasClients = listCanvasClients();
        if (canvasClients.length === 0) {
            return res.status(503).json({
                status: 'error',
                message: '画布未连接（请打开 LumenLight 页面）'
            });
        }

        // 路由策略：
        //   读命令 → 广播给全部画布客户端，首个应答生效（多标签容错）；
        //   写命令 → 只发给最近活跃的客户端（避免重复执行），且要求
        //   心跳新鲜（>10s 无心跳 = 页面失去响应，明确报错而非干等）
        const isMutating = MUTATING_COMMANDS.has(command);
        let targets;
        if (isMutating) {
            const best = canvasClients[0];
            const age = Date.now() - (best.lastSeen || 0);
            if (age > FRESH_MS) {
                return res.status(503).json({
                    status: 'error',
                    message: `画布页面失去响应（${Math.round(age / 1000)} 秒无心跳），请刷新画布页面后重试`
                });
            }
            targets = [best];
        } else {
            targets = canvasClients;
        }

        const id = `bridge_${Date.now()}_${++bridgeSeq}`;
        const timer = setTimeout(() => {
            if (pending.delete(id)) {
                res.status(504).json({ status: 'error', message: '画布执行超时' });
            }
        }, BRIDGE_TIMEOUT_MS);
        pending.set(id, { res, timer });

        for (const client of targets) {
            client.ws.send(JSON.stringify({
                type: 'bridge-command',
                id,
                command,
                params: params || {}
            }));
        }
        console.log(`[桥接] ${command} (id=${id}) → ${targets.length} 个客户端` +
            `，心跳年龄 ${Math.round((Date.now() - (targets[0].lastSeen || 0)) / 1000)}s`);
    });

    /**
     * POST /api/canvas-bridge/response
     * 浏览器执行完成后回传结果（与 command 的 id 配对）
     * 请求体：{ id, ok, data?, error? }
     */
    router.post('/response', (req, res) => {
        const { id, ok, data, error } = req.body || {};
        const waiter = typeof id === 'string' ? pending.get(id) : null;
        if (!waiter) {
            // 超时后晚到的应答：静默丢弃即可
            return res.json({ status: 'ok', message: '无匹配的挂起请求' });
        }
        clearTimeout(waiter.timer);
        pending.delete(id);
        console.log(`[桥接] 应答 ${id}: ${ok ? 'ok' : 'error ' + (error || '')}`);
        if (ok) {
            waiter.res.json({ status: 'ok', id, data: data === undefined ? null : data });
        } else {
            waiter.res.json({ status: 'error', id, message: error || '画布执行失败' });
        }
    });

    /**
     * GET /api/canvas-bridge/debug
     * 诊断：当前画布客户端连接与心跳状态
     */
    router.get('/debug', (req, res) => {
        const now = Date.now();
        const list = [...clients.values()].map((c) => ({
            role: c.role,
            name: c.name,
            readyState: c.ws.readyState,
            lastSeenAgeSec: c.lastSeen ? Math.round((now - c.lastSeen) / 1000) : null,
            bridgeReceived: c.bridgeReceived || 0
        }));
        res.json({ status: 'ok', clients: list, pendingCount: pending.size });
    });

    // 挂起请求的定期清理（客户端断线导致永远等不到应答时兜底）
    setInterval(() => {
        const now = Date.now();
        for (const [id, waiter] of pending) {
            // timer 到点后自会触发 504，这里只做极端情况兜底统计
            if (now - parseInt(id.split('_')[1], 10) > BRIDGE_TIMEOUT_MS * 2) {
                clearTimeout(waiter.timer);
                pending.delete(id);
                try {
                    waiter.res.status(504).json({ status: 'error', message: '画布执行超时' });
                } catch { /* 应答已发送 */ }
            }
        }
    }, 60 * 1000);

    return router;
}

module.exports = createCanvasBridgeRouter;
