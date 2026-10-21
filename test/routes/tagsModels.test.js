/**
 * ==========================================================================
 * routes/tags.js 模型标签层级（parentId）接口测试：
 *   - POST /models 携带 parentId 建子标签（响应与清单都带 parentId，
 *     根级标签不写该字段）
 *   - 层级上限 3 级：3 级父标签下再建返回 400
 *   - 父标签不存在 404；名字全表唯一（大小写不敏感、跨层级也算重名）
 *   - DELETE /models/:id 不级联删除：子标签上移一级挂到被删标签的
 *     原父级下，父级为根则升为顶层
 * 临时目录隔离 tag/，内存 express 应用 + supertest 直打路由。
 * ==========================================================================
 */

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');

const createTagsRouter = require('../../routes/tags');

function makeApp(tagsDir) {
    const app = express();
    app.use(express.json());
    app.use('/api/tags', createTagsRouter({ tagsDir }));
    return app;
}

describe('routes/tags 模型标签层级', () => {
    let tagsDir;
    beforeEach(() => {
        tagsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tags-models-test-'));
    });
    afterEach(() => {
        fs.rmSync(tagsDir, { recursive: true, force: true });
    });

    test('POST /models 携带 parentId 建子标签，根级不写 parentId 字段', async () => {
        const app = makeApp(tagsDir);
        const root = (await request(app).post('/api/tags/models').send({ name: 'ModelA' })).body.model;
        expect(root.parentId).toBeUndefined();

        const child = (await request(app).post('/api/tags/models').send({ name: '角色', parentId: root.id })).body.model;
        expect(child.parentId).toBe(root.id);

        const list = (await request(app).get('/api/tags/models')).body.models;
        expect(list.find(m => m.id === root.id).parentId).toBeUndefined();
        expect(list.find(m => m.id === child.id).parentId).toBe(root.id);
    });

    test('最多 3 级：3 级父标签下再建子标签返回 400', async () => {
        const app = makeApp(tagsDir);
        const l1 = (await request(app).post('/api/tags/models').send({ name: 'L1' })).body.model;
        const l2 = (await request(app).post('/api/tags/models').send({ name: 'L2', parentId: l1.id })).body.model;
        const l3 = (await request(app).post('/api/tags/models').send({ name: 'L3', parentId: l2.id })).body.model;

        const denied = await request(app).post('/api/tags/models').send({ name: 'L4', parentId: l3.id });
        expect(denied.status).toBe(400);

        // 2 级父标签仍可建第 3 级
        const ok = (await request(app).post('/api/tags/models').send({ name: 'L3b', parentId: l2.id })).body.model;
        expect(ok.parentId).toBe(l2.id);
    });

    test('父标签不存在返回 404；名字全表唯一（大小写不敏感、跨层级重名 409）', async () => {
        const app = makeApp(tagsDir);
        const root = (await request(app).post('/api/tags/models').send({ name: 'ModelA' })).body.model;

        const missing = await request(app).post('/api/tags/models').send({ name: '角色', parentId: 'no-such-id' });
        expect(missing.status).toBe(404);

        // 子标签与顶层标签重名同样拒绝（大小写不敏感）
        const dup = await request(app).post('/api/tags/models').send({ name: 'modela', parentId: root.id });
        expect(dup.status).toBe(409);
    });

    test('DELETE /models/:id 不级联：子标签上移一级，根级子标签升为顶层', async () => {
        const app = makeApp(tagsDir);
        const l1 = (await request(app).post('/api/tags/models').send({ name: 'L1' })).body.model;
        const l2 = (await request(app).post('/api/tags/models').send({ name: 'L2', parentId: l1.id })).body.model;
        const l3 = (await request(app).post('/api/tags/models').send({ name: 'L3', parentId: l2.id })).body.model;

        // 删中间层：孙标签挂到祖父
        await request(app).delete(`/api/tags/models/${l2.id}`);
        let list = (await request(app).get('/api/tags/models')).body.models;
        expect(list.some(m => m.id === l2.id)).toBe(false);
        expect(list.find(m => m.id === l3.id).parentId).toBe(l1.id);

        // 删顶层：剩余子标签升为顶层（去掉 parentId）
        await request(app).delete(`/api/tags/models/${l1.id}`);
        list = (await request(app).get('/api/tags/models')).body.models;
        expect(list.find(m => m.id === l3.id).parentId).toBeUndefined();
    });
});
