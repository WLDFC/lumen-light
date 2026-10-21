/**
 * ==========================================================================
 * routes/comfyPrompts.js 集成测试（Comfy 提示词预设，正面/负面两库）
 *   - GET 空：文件不存在 → {status:'ok', positive:[], negative:[]}（永不 500）
 *   - POST 合法 → 落盘对应库，GET 回读一致；kind 非法/缺名/缺内容 → 400
 *   - PUT /:id 更新名称与内容（两库按 id 查找）；未知 id → 404
 *   - DELETE /:id 删除；再删 → 404
 *   - 文件损坏（半截 JSON）→ GET 回落空库
 * 通过 supertest 直连 Express 应用，使用临时目录避免污染 data/。
 * ==========================================================================
 */

const express = require('express');
const request = require('supertest');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const createComfyPromptsRouter = require('../../routes/comfyPrompts');

function makeApp(dataDir) {
    const app = express();
    app.use(express.json());
    app.use('/api/comfy-prompts', createComfyPromptsRouter({ dataDir }));
    return app;
}

describe('routes/comfyPrompts 提示词预设两库', () => {
    let tmpDir, dataDir, app;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-comfy-prompts-test-'));
        dataDir = tmpDir;
        app = makeApp(dataDir);
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('GET 空库：文件不存在时返回两空数组且 status ok', async () => {
        const res = await request(app).get('/api/comfy-prompts');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.positive).toEqual([]);
        expect(res.body.negative).toEqual([]);
    });

    test('POST 分别落正面/负面两库，GET 回读一致', async () => {
        const pos = await request(app).post('/api/comfy-prompts')
            .send({ name: 'anima 质量流', kind: 'positive', content: 'masterpiece, best quality' });
        expect(pos.status).toBe(200);
        expect(pos.body.entry.id).toBeTruthy();

        const neg = await request(app).post('/api/comfy-prompts')
            .send({ name: '通用负面', kind: 'negative', content: 'low quality, blurry' });
        expect(neg.status).toBe(200);

        const list = await request(app).get('/api/comfy-prompts');
        expect(list.body.positive).toHaveLength(1);
        expect(list.body.positive[0]).toMatchObject({ name: 'anima 质量流', content: 'masterpiece, best quality' });
        expect(list.body.negative).toHaveLength(1);
        expect(list.body.negative[0]).toMatchObject({ name: '通用负面' });
    });

    test('POST 校验：kind 非法 / 缺名 / 缺内容 → 400', async () => {
        expect((await request(app).post('/api/comfy-prompts')
            .send({ name: 'x', kind: 'both', content: 'y' })).status).toBe(400);
        expect((await request(app).post('/api/comfy-prompts')
            .send({ name: '  ', kind: 'positive', content: 'y' })).status).toBe(400);
        expect((await request(app).post('/api/comfy-prompts')
            .send({ name: 'x', kind: 'positive', content: '' })).status).toBe(400);
    });

    test('PUT /:id 更新名称与内容（跨库按 id 查找），未知 id → 404', async () => {
        const created = await request(app).post('/api/comfy-prompts')
            .send({ name: '旧名', kind: 'negative', content: '旧内容' });
        const id = created.body.entry.id;

        const updated = await request(app).put(`/api/comfy-prompts/${id}`)
            .send({ name: '新名', content: '新内容' });
        expect(updated.status).toBe(200);
        expect(updated.body.entry).toMatchObject({ name: '新名', content: '新内容' });

        const list = await request(app).get('/api/comfy-prompts');
        expect(list.body.negative[0].name).toBe('新名');

        expect((await request(app).put('/api/comfy-prompts/no-such-id')
            .send({ name: 'x' })).status).toBe(404);
        expect((await request(app).put(`/api/comfy-prompts/${id}`)
            .send({ name: ' ' })).status).toBe(400);
    });

    test('DELETE /:id 删除后回读为空，再删 → 404', async () => {
        const created = await request(app).post('/api/comfy-prompts')
            .send({ name: '待删', kind: 'positive', content: '内容' });
        const id = created.body.entry.id;

        expect((await request(app).delete(`/api/comfy-prompts/${id}`)).status).toBe(200);
        const list = await request(app).get('/api/comfy-prompts');
        expect(list.body.positive).toEqual([]);
        expect((await request(app).delete(`/api/comfy-prompts/${id}`)).status).toBe(404);
    });

    test('文件损坏（半截 JSON）→ GET 回落空库，不 500', async () => {
        await fs.writeFile(path.join(dataDir, 'comfy-prompts.json'), '{"positive": [', 'utf-8');
        const res = await request(app).get('/api/comfy-prompts');
        expect(res.status).toBe(200);
        expect(res.body.positive).toEqual([]);
        expect(res.body.negative).toEqual([]);
    });
});
