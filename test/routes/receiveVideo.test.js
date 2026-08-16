/**
 * ==========================================================================
 * routes/comfy.js POST /api/receive-video 集成测试
 * 覆盖 ComfyUI 视频节点（LumenSendVideoToCanvas）的上传链路：
 *   - 二进制直传保存到 data/videos/ 并广播 new-video WebSocket 消息
 *   - 扩展名白名单、空请求体拦截
 * 通过 mock WebSocket 客户端（clients Map）捕获广播消息。
 * 视频写入真实的 data/videos/ 目录，用例结束按响应中的文件名清理。
 * ==========================================================================
 */

const express = require('express');
const request = require('supertest');
const fs = require('fs').promises;
const path = require('path');

const createComfyRouter = require('../../routes/comfy');

const VIDEOS_DIR = path.join(__dirname, '..', '..', 'data', 'videos');

function makeApp(clients, latestPrompts) {
    const app = express();
    app.use(express.json({ limit: '100mb' }));
    app.use('/api', createComfyRouter({
        clients,
        latestPrompts,
        latestWorkflow: { workflow: null, timestamp: 0 },
        canvasImages: { 1: null, 2: null, 3: null },
        canvasImagesTimestamp: { 1: 0, 2: 0, 3: 0 },
        comfyApiUrl: 'http://127.0.0.1:8188'
    }));
    return app;
}

// 捕获 WebSocket 广播的假客户端（ws.readyState=1 即 OPEN）
function makeFakeCanvasClient(sent) {
    return {
        role: 'canvas',
        ws: {
            readyState: 1,
            send: (data) => sent.push(JSON.parse(data))
        }
    };
}

describe('POST /api/receive-video', () => {
    let clients;
    let sent;
    let app;
    // 本轮用例写入的视频文件名（从响应解析，用例结束清理）
    let createdFiles = [];

    beforeEach(() => {
        sent = [];
        createdFiles = [];
        clients = new Map();
        clients.set('c1', makeFakeCanvasClient(sent));
        app = makeApp(clients, { positive: 'a cat', negative: 'lowres' });
    });

    afterEach(async () => {
        await Promise.all(createdFiles.map(name =>
            fs.rm(path.join(VIDEOS_DIR, name), { force: true })));
    });

    test('二进制直传保存视频并广播 new-video 消息', async () => {
        const bytes = Buffer.from('fake mp4 data for receive-video test');

        const res = await request(app)
            .post('/api/receive-video?filename=clip.mp4&target=node-1')
            .set('Content-Type', 'application/octet-stream')
            .send(bytes);

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.videoUrl).toMatch(/^data\/videos\/video_\d+_clip\.mp4$/);
        expect(res.body.clientsNotified).toBe(1);
        createdFiles.push(path.basename(res.body.videoUrl));

        // 文件确实落盘且字节一致
        const saved = await fs.readFile(path.join(VIDEOS_DIR, path.basename(res.body.videoUrl)));
        expect(saved.equals(bytes)).toBe(true);

        // WebSocket 广播内容
        expect(sent).toHaveLength(1);
        const msg = sent[0];
        expect(msg.type).toBe('new-video');
        expect(msg.videoUrl).toBe(res.body.videoUrl);
        expect(msg.target).toBe('node-1');
        expect(msg.prompt).toEqual({ positive: 'a cat', negative: 'lowres' });
    });

    test('扩展名白名单拦截', async () => {
        const res = await request(app)
            .post('/api/receive-video?filename=evil.exe')
            .set('Content-Type', 'application/octet-stream')
            .send(Buffer.from('x'));

        expect(res.status).toBe(400);
        expect(res.body.message).toContain('不支持的视频格式');
        expect(sent).toHaveLength(0);
    });

    test('空请求体被拦截', async () => {
        const res = await request(app)
            .post('/api/receive-video?filename=a.mp4')
            .set('Content-Type', 'application/octet-stream')
            .send();

        expect(res.status).toBe(400);
        expect(sent).toHaveLength(0);
    });

    test('webm 格式可用，文件名非法字符被清洗', async () => {
        const res = await request(app)
            .post('/api/receive-video?filename=my clip: v1.webm')
            .set('Content-Type', 'application/octet-stream')
            .send(Buffer.from('webm-bytes'));

        expect(res.status).toBe(200);
        expect(res.body.videoUrl).toMatch(/video_\d+_my_clip__v1\.webm$/);
        createdFiles.push(path.basename(res.body.videoUrl));
    });
});
