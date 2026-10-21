/**
 * ==========================================================================
 * routes/canvasImages.js 图片/遮罩槽位路由测试
 * 覆盖槽位扩容契约（多图编辑：上限 9 与 LumenReceiveImageFromCanvas
 * .MAX_SLOTS 对齐）与基础读写：
 *   - POST /api/canvas-image/:slot   保存（1-9 合法/越界 400/null 清槽）
 *   - GET  /api/canvas-image/:slot   读取（有图/空槽 404/越界 400）
 *   - 遮罩槽复用同一工厂（server.js 挂 /api/canvas-mask），校验随之同步
 * ==========================================================================
 */

const express = require('express');
const request = require('supertest');

const createCanvasImagesRouter = require('../../routes/canvasImages');

function buildApp() {
    const canvasImages = { 1: null, 2: null, 3: null };
    const canvasImagesTimestamp = { 1: 0, 2: 0, 3: 0 };
    const canvasMasks = { 1: null, 2: null, 3: null };
    const canvasMasksTimestamp = { 1: 0, 2: 0, 3: 0 };
    const app = express();
    app.use(express.json());
    app.use('/api/canvas-image', createCanvasImagesRouter({
        canvasImages, canvasImagesTimestamp
    }));
    app.use('/api/canvas-mask', createCanvasImagesRouter({
        canvasImages: canvasMasks, canvasImagesTimestamp: canvasMasksTimestamp
    }));
    return app;
}

describe('图片/遮罩槽位路由（canvasImages）', () => {
    let app;

    beforeEach(() => {
        app = buildApp();
    });

    describe('槽位范围（扩容契约）', () => {
        test('1-9 号槽位全部可写可读（扩容后的合法范围）', async () => {
            for (let slot = 1; slot <= 9; slot++) {
                const post = await request(app).post(`/api/canvas-image/${slot}`)
                    .send({ image: `base64-img-${slot}` });
                expect(post.status).toBe(200);
                expect(post.body.status).toBe('ok');

                const get = await request(app).get(`/api/canvas-image/${slot}`);
                expect(get.status).toBe(200);
                expect(get.body.image).toBe(`base64-img-${slot}`);
                expect(get.body.timestamp).toBeGreaterThan(0);
            }
        });

        test('0 与 10 号槽位越界拒绝（400，POST/GET 同口径）', async () => {
            for (const slot of [0, 10]) {
                const post = await request(app).post(`/api/canvas-image/${slot}`)
                    .send({ image: 'x' });
                expect(post.status).toBe(400);
                expect(post.body.message).toBe('槽位必须是 1-9');

                const get = await request(app).get(`/api/canvas-image/${slot}`);
                expect(get.status).toBe(400);
            }
        });

        test('遮罩槽走同一工厂，1-9 合法/越界拒绝同步生效', async () => {
            const ok = await request(app).post('/api/canvas-mask/9')
                .send({ image: 'base64-mask-9' });
            expect(ok.status).toBe(200);

            const over = await request(app).post('/api/canvas-mask/10')
                .send({ image: 'x' });
            expect(over.status).toBe(400);
        });
    });

    describe('POST /api/canvas-image/:slot', () => {
        test('显式 null 清空槽位并返回时间戳 0', async () => {
            await request(app).post('/api/canvas-image/2').send({ image: 'x' });
            const res = await request(app).post('/api/canvas-image/2').send({ image: null });
            expect(res.status).toBe(200);
            expect(res.body.message).toBe('槽位 2 已清空');
            expect(res.body.timestamp).toBe(0);
        });

        test('缺少 image 字段拒绝（400）', async () => {
            const res = await request(app).post('/api/canvas-image/1').send({});
            expect(res.status).toBe(400);
            expect(res.body.message).toBe('缺少图片数据');
        });

        test('替换已有图片时 replaced: true', async () => {
            await request(app).post('/api/canvas-image/1').send({ image: 'a' });
            const res = await request(app).post('/api/canvas-image/1').send({ image: 'b' });
            expect(res.status).toBe(200);
            expect(res.body.replaced).toBe(true);
        });
    });

    describe('GET /api/canvas-image/:slot', () => {
        test('空槽位返回 404', async () => {
            const res = await request(app).get('/api/canvas-image/5');
            expect(res.status).toBe(404);
            expect(res.body.message).toBe('槽位 5 没有图片');
        });
    });
});
