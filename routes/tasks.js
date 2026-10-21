/**
 * ==========================================================================
 * LumenLight pi 后台任务上报路由（routes/tasks.js）
 * ==========================================================================
 * 作用：接收 pi 扩展（lumen-canvas.ts）后台任务的上报并广播到画布
 *       WebSocket 客户端，让前端任务中心能展示 agent 驱动的任务
 *       （canvas_generate_image / canvas_generate_video / canvas_image_process
 *       的任务句柄住在 pi 子进程内存里，前端无法直接枚举——本路由是中继）。
 *   - POST /api/tasks：登记/更新（按 id upsert），广播 task-event 事件；
 *   - GET  /api/tasks：当前已知任务快照（前端 F5 后补水运行中任务用）。
 * 只做中继与内存快照，不做持久化：pi 重启后其任务即失联（扩展侧同语义，
 * poll 报未知 id），本表随之过期属预期。
 * ==========================================================================
 */

const express = require('express');

function createTasksRouter({ clients }) {
    const router = express.Router();
    const tasks = new Map();       // id -> 最近一次上报的任务快照
    const MAX_TASKS = 60;

    // 广播到画布客户端（与 piAgentManager._broadcast 同一过滤口径：
    // 只发画布角色、readyState 就绪、单条失败不中断其余）
    function broadcast(payload) {
        for (const client of clients.values()) {
            if (client.role === 'canvas' && client.ws.readyState === 1) {
                try { client.ws.send(JSON.stringify(payload)); } catch { /* 忽略单个失败 */ }
            }
        }
    }

    router.post('/', (req, res) => {
        const t = req.body;
        if (!t || typeof t.id !== 'string' || !t.id ||
            typeof t.kind !== 'string' || !t.kind ||
            typeof t.status !== 'string') {
            return res.status(400).json({ status: 'error', message: '缺少 id/kind/status' });
        }
        const snapshot = {
            id: t.id,
            kind: t.kind,
            label: typeof t.label === 'string' ? t.label : '',
            status: ['running', 'done', 'failed', 'stopped'].includes(t.status) ? t.status : 'running',
            note: typeof t.note === 'string' ? t.note : '',
            startedAt: Number.isFinite(t.startedAt) ? t.startedAt : Date.now(),
            endedAt: Number.isFinite(t.endedAt) ? t.endedAt : null
        };
        tasks.set(snapshot.id, snapshot);
        while (tasks.size > MAX_TASKS) {
            tasks.delete(tasks.keys().next().value);
        }
        broadcast({ type: 'task-event', task: snapshot });
        res.json({ status: 'ok' });
    });

    router.get('/', (req, res) => {
        res.json({ status: 'ok', tasks: [...tasks.values()] });
    });

    return router;
}

module.exports = createTasksRouter;
