/**
 * ==========================================================================
 * routes/canvasVideo.js 视频槽位路由测试
 * 覆盖引用式视频槽位的三条端点：
 *   - POST   /api/canvas-video/:slot   保存引用（存在性校验/白名单/清槽/穿越拦截）
 *   - GET    /api/canvas-video/:slot   元数据（空槽 404/文件被 GC 后自动清槽）
 *   - GET    /api/canvas-video/:slot/file  字节回传（sendFile 流式）
 * videosDir 指向临时目录，不触碰真实 data/videos。
 * ==========================================================================
 */

const express = require('express');
const request = require('supertest');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const createCanvasVideoRouter = require('../../routes/canvasVideo');

function buildApp(videosDir) {
    const canvasVideos = { 1: null, 2: null, 3: null };
    const canvasVideosTimestamp = { 1: 0, 2: 0, 3: 0 };
    const app = express();
    app.use(express.json());
    app.use('/api/canvas-video', createCanvasVideoRouter({
        canvasVideos,
        canvasVideosTimestamp,
        videosDir
    }));
    return app;
}

describe('视频槽位路由（canvasVideo）', () => {
    let tmpDir;
    let videosDir;
    let app;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-canvas-video-test-'));
        videosDir = path.join(tmpDir, 'data', 'videos');
        await fs.mkdir(videosDir, { recursive: true });
        app = buildApp(videosDir);
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    describe('POST /api/canvas-video/:slot', () => {
        test('保存合法引用并返回时间戳（带/不带前缀均可）', async () => {
            await fs.writeFile(path.join(videosDir, 'a.mp4'), 'video-a');

            for (const url of ['data/videos/a.mp4', '/data/videos/a.mp4']) {
                const res = await request(app).post('/api/canvas-video/1').send({ videoUrl: url });
                expect(res.status).toBe(200);
                expect(res.body.status).toBe('ok');
                expect(res.body.filename).toBe('a.mp4');
                expect(res.body.timestamp).toBeGreaterThan(0);
            }
        });

        test('文件不存在时拒绝写入（404 + 明确 message）', async () => {
            const res = await request(app).post('/api/canvas-video/1')
                .send({ videoUrl: 'data/videos/missing.mp4' });
            expect(res.status).toBe(404);
            expect(res.body.status).toBe('error');
        });

        test('路径穿越被拦截（../ 被 basename 归一化，逃不出 videos 目录）', async () => {
            const secret = path.join(tmpDir, 'secret.mp4');
            await fs.writeFile(secret, 'secret');

            // ../secret.mp4 被 basename 归一化为 secret.mp4（不在 videos/）→ 按不存在处理
            const res = await request(app).post('/api/canvas-video/1')
                .send({ videoUrl: '../secret.mp4' });
            expect(res.status).toBe(404);

            // 槽位保持空，引用不到白名单目录外的文件
            const meta = await request(app).get('/api/canvas-video/1');
            expect(meta.status).toBe(404);
        });

        test('扩展名白名单外拒绝（.txt）', async () => {
            await fs.writeFile(path.join(videosDir, 'note.txt'), 'text');
            const res = await request(app).post('/api/canvas-video/1')
                .send({ videoUrl: 'data/videos/note.txt' });
            expect(res.status).toBe(400);
        });

        test('显式 null 清空槽位（时间戳归零）', async () => {
            await fs.writeFile(path.join(videosDir, 'a.mp4'), 'video-a');
            await request(app).post('/api/canvas-video/1').send({ videoUrl: 'data/videos/a.mp4' });

            const res = await request(app).post('/api/canvas-video/1').send({ videoUrl: null });
            expect(res.status).toBe(200);
            expect(res.body.timestamp).toBe(0);

            const meta = await request(app).get('/api/canvas-video/1');
            expect(meta.status).toBe(404);
        });

        test('缺 videoUrl 字段与非法槽位均 400', async () => {
            expect((await request(app).post('/api/canvas-video/1').send({})).status).toBe(400);
            expect((await request(app).post('/api/canvas-video/4').send({ videoUrl: null })).status).toBe(400);
            expect((await request(app).post('/api/canvas-video/0').send({ videoUrl: null })).status).toBe(400);
        });
    });

    describe('GET /api/canvas-video/:slot', () => {
        test('返回元数据（filename/videoUrl/timestamp）', async () => {
            await fs.writeFile(path.join(videosDir, 'a.mp4'), 'video-a');
            await request(app).post('/api/canvas-video/2').send({ videoUrl: 'data/videos/a.mp4' });

            const res = await request(app).get('/api/canvas-video/2');
            expect(res.status).toBe(200);
            expect(res.body.status).toBe('ok');
            expect(res.body.filename).toBe('a.mp4');
            expect(res.body.videoUrl).toBe('data/videos/a.mp4');
            expect(res.body.timestamp).toBeGreaterThan(0);
        });

        test('空槽位 404', async () => {
            const res = await request(app).get('/api/canvas-video/3');
            expect(res.status).toBe(404);
        });

        test('引用的视频被 GC 清理后：404 且槽位自动清空', async () => {
            await fs.writeFile(path.join(videosDir, 'gone.mp4'), 'video-gone');
            await request(app).post('/api/canvas-video/1').send({ videoUrl: 'data/videos/gone.mp4' });
            await fs.rm(path.join(videosDir, 'gone.mp4'));

            const res = await request(app).get('/api/canvas-video/1');
            expect(res.status).toBe(404);
            expect(res.body.message).toContain('已被清理');

            // 重新写入同文件再删已无意义——槽位应已自动清空，直接验证空槽语义
            const meta = await request(app).get('/api/canvas-video/1');
            expect(meta.status).toBe(404);
        });
    });

    describe('GET /api/canvas-video/:slot/file', () => {
        test('回传完整字节与 mp4 Content-Type', async () => {
            const payload = Buffer.from('fake-mp4-bytes-0123456789');
            await fs.writeFile(path.join(videosDir, 'a.mp4'), payload);
            await request(app).post('/api/canvas-video/1').send({ videoUrl: 'data/videos/a.mp4' });

            const res = await request(app).get('/api/canvas-video/1/file');
            expect(res.status).toBe(200);
            expect(res.body).toEqual(payload);
            expect(res.headers['content-type']).toContain('video/mp4');
        });

        test('空槽位与文件被清理均 404', async () => {
            expect((await request(app).get('/api/canvas-video/1/file')).status).toBe(404);

            await fs.writeFile(path.join(videosDir, 'gone.mp4'), 'x');
            await request(app).post('/api/canvas-video/1').send({ videoUrl: 'data/videos/gone.mp4' });
            await fs.rm(path.join(videosDir, 'gone.mp4'));
            expect((await request(app).get('/api/canvas-video/1/file')).status).toBe(404);
        });
    });
});
