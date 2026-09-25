/**
 * ==========================================================================
 * routes/canvasBridge.js 桥接路由测试
 * 核心回归：POST /response 必须应答浏览器请求本身。历史上该路由只回复
 * pi 侧挂起的 /command（waiter.res），漏掉了浏览器自己的 res——每条桥接
 * 命令泄漏一条浏览器同源连接，约 6 条后连接池耗尽、整页 HTTP 互锁卡死。
 * 用假 WS 客户端驱动完整 命令→应答 回路，不触碰真实浏览器。
 * ==========================================================================
 */

const express = require('express');
const request = require('supertest');
const WebSocket = require('ws');

const createCanvasBridgeRouter = require('../../routes/canvasBridge');

/** 假画布 WS 客户端：记录收到的命令，readyState 恒为 OPEN */
function fakeCanvasClient() {
    return {
        role: 'canvas',
        name: 'test-canvas',
        lastSeen: Date.now(),
        ws: {
            readyState: WebSocket.OPEN,
            sent: [],
            send(payload) { this.sent.push(JSON.parse(payload)); },
            once() { /* 测试内不模拟断线 */ }
        }
    };
}

/** 轮询等待条件成立（命令经真实 HTTP 回路下发，tick 数不固定） */
async function waitFor(cond, ms = 2000) {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('waitFor 超时');
        await new Promise((r) => setTimeout(r, 5));
    }
}

describe('画布桥接路由', () => {
    let app;
    let client;

    beforeEach(() => {
        client = fakeCanvasClient();
        const clients = new Map([['c1', client]]);
        app = express();
        app.use(express.json());
        app.use('/api/canvas-bridge', createCanvasBridgeRouter({ clients }));
    });

    it('命令经 WS 下发，应答同时回复 /command 与 /response 两个请求', async () => {
        // /command 挂起等待浏览器应答，先发出不应答
        // （包一层 async 立即触发 supertest 请求：裸 Test 对象是懒触发的）
        const cmdPromise = (async () => request(app)
            .post('/api/canvas-bridge/command')
            .send({ command: 'get_state', params: {} }))();

        // 等命令到达假客户端
        await waitFor(() => client.ws.sent.length === 1);
        const { id, command } = client.ws.sent[0];
        expect(command).toBe('get_state');

        // 浏览器回传应答：/response 请求本身必须立即收到响应（回归点）
        const respRes = await request(app)
            .post('/api/canvas-bridge/response')
            .send({ id, ok: true, data: { viewport: { scale: 1 } } });
        expect(respRes.status).toBe(200);
        expect(respRes.body).toEqual({ status: 'ok' });

        // pi 侧 /command 随之拿到浏览器执行结果
        const cmdRes = await cmdPromise;
        expect(cmdRes.status).toBe(200);
        expect(cmdRes.body).toMatchObject({ status: 'ok', data: { viewport: { scale: 1 } } });
    });

    it('执行失败的应答以 error 回复 /command，/response 自身仍正常结束', async () => {
        const cmdPromise = (async () => request(app)
            .post('/api/canvas-bridge/command')
            .send({ command: 'delete_media', params: { name: 'x.png' } }))();
        await waitFor(() => client.ws.sent.length === 1);
        const { id } = client.ws.sent[0];

        const respRes = await request(app)
            .post('/api/canvas-bridge/response')
            .send({ id, ok: false, error: '对象不存在' });
        expect(respRes.status).toBe(200);
        expect(respRes.body).toEqual({ status: 'ok' });

        const cmdRes = await cmdPromise;
        expect(cmdRes.body).toMatchObject({ status: 'error', message: '对象不存在' });
    });

    it('无匹配挂起请求的迟到应答也正常结束（不挂起）', async () => {
        const respRes = await request(app)
            .post('/api/canvas-bridge/response')
            .send({ id: 'bridge_none', ok: true });
        expect(respRes.status).toBe(200);
        expect(respRes.body.status).toBe('ok');
    });

    it('无画布客户端时写命令立即 503，不挂起', async () => {
        const emptyApp = express();
        emptyApp.use(express.json());
        emptyApp.use('/api/canvas-bridge', createCanvasBridgeRouter({ clients: new Map() }));
        const res = await request(emptyApp)
            .post('/api/canvas-bridge/command')
            .send({ command: 'delete_media', params: {} });
        expect(res.status).toBe(503);
    });
});
