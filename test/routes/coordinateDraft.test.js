/**
 * ==========================================================================
 * routes/coordinateDraft.js 集成测试（坐标编辑器草稿持久化，ADR 018）
 *   - GET 空：文件不存在 → {status:'ok', draft:null}（永不 500）
 *   - PUT 合法草稿 → 落盘 dataDir/coordinate-draft.json，GET 回读一致
 *     （item.shot 编辑器侧元数据原样透传）
 *   - PUT 形状不合法（缺 draft/宽高非数字/summary 非对象/items 非数组）→ 400
 *   - 文件损坏（半截 JSON）→ GET 回落 draft:null
 * 通过 supertest 直连 Express 应用，使用临时目录避免污染 data/。
 * ==========================================================================
 */

const express = require('express');
const request = require('supertest');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const createCoordinateDraftRouter = require('../../routes/coordinateDraft');

// 编辑器真实草稿形态：含 item.shot 景别元数据（编译前由前端剥离，路由透传）
const DRAFT = {
    width: 1024,
    height: 1024,
    bbox_coord_space: 'abs',
    bbox_format: 'xyxy',
    summary: { caption: '拼贴海报', canvas: 'collage' },
    items: [
        { label: 'character', caption: '前景女孩', bbox: [64, 64, 512, 768], shot: '前景' },
        { label: 'text', caption: '主标题', text: '流光', bbox: [512, 512, 960, 960] }
    ]
};

function makeApp(dataDir) {
    const app = express();
    app.use(express.json());
    app.use('/api/coordinate-draft', createCoordinateDraftRouter({ dataDir }));
    return app;
}

describe('routes/coordinateDraft 草稿持久化', () => {
    let tmpDir, dataDir, app;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-coord-draft-test-'));
        dataDir = tmpDir;
        app = makeApp(dataDir);
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('GET 文件不存在 → draft:null', async () => {
        const res = await request(app).get('/api/coordinate-draft');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'ok', draft: null });
    });

    test('PUT 合法草稿 → 落盘并回读一致（shot 透传）', async () => {
        const put = await request(app).put('/api/coordinate-draft').send({ draft: DRAFT });
        expect(put.status).toBe(200);
        expect(put.body.status).toBe('ok');
        expect(typeof put.body.savedAt).toBe('number');

        const fileRaw = JSON.parse(await fs.readFile(path.join(dataDir, 'coordinate-draft.json'), 'utf-8'));
        expect(fileRaw.draft).toEqual(DRAFT);

        const get = await request(app).get('/api/coordinate-draft');
        expect(get.status).toBe(200);
        expect(get.body.status).toBe('ok');
        expect(get.body.draft).toEqual(DRAFT);
    });

    test('PUT 后再 PUT 覆盖为新草稿', async () => {
        await request(app).put('/api/coordinate-draft').send({ draft: DRAFT });
        const fresh = {
            width: 832, height: 1216,
            bbox_coord_space: 'abs', bbox_format: 'xyxy',
            summary: { caption: '', canvas: 'single' },
            items: []
        };
        const put = await request(app).put('/api/coordinate-draft').send({ draft: fresh });
        expect(put.status).toBe(200);
        const get = await request(app).get('/api/coordinate-draft');
        expect(get.body.draft).toEqual(fresh);
    });

    test.each([
        ['缺 draft', {}],
        ['draft 非对象', { draft: [1, 2] }],
        ['width 非数字', { draft: { ...DRAFT, width: '1024' } }],
        ['height 缺失', { draft: { ...DRAFT, height: undefined } }],
        ['summary 非对象', { draft: { ...DRAFT, summary: 'x' } }],
        ['items 非数组', { draft: { ...DRAFT, items: 'x' } }],
        ['body 为空', undefined]
    ])('PUT %s → 400', async (_name, body) => {
        const put = body === undefined
            ? await request(app).put('/api/coordinate-draft')
            : await request(app).put('/api/coordinate-draft').send(body);
        expect(put.status).toBe(400);
        expect(put.body.status).toBe('error');
        // 拒绝后不落盘
        const get = await request(app).get('/api/coordinate-draft');
        expect(get.body.draft).toBeNull();
    });

    test('文件损坏（半截 JSON）→ GET 回落 draft:null', async () => {
        await fs.mkdir(dataDir, { recursive: true });
        await fs.writeFile(path.join(dataDir, 'coordinate-draft.json'), '{"draft": {"widt', 'utf-8');
        const get = await request(app).get('/api/coordinate-draft');
        expect(get.status).toBe(200);
        expect(get.body).toEqual({ status: 'ok', draft: null });
    });

    test('文件存在但 draft 形状不对 → GET 回落 draft:null', async () => {
        await fs.mkdir(dataDir, { recursive: true });
        await fs.writeFile(path.join(dataDir, 'coordinate-draft.json'),
            JSON.stringify({ draft: { width: 1 } }), 'utf-8');
        const get = await request(app).get('/api/coordinate-draft');
        expect(get.body).toEqual({ status: 'ok', draft: null });
    });
});
