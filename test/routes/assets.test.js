/**
 * ==========================================================================
 * routes/assets.js 用户资产接口测试
 * 内容寻址保存（幂等去重）、index.json 展示名 sidecar、列表 exists 标记、
 * 文件读取的扩展名白名单与路径穿越防护。临时目录隔离 data/assets/。
 * ==========================================================================
 */

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');

const createAssetsRouter = require('../../routes/assets');

// 1×1 PNG 的 data URL（后端不校验图片结构，仅需合法 base64 + image/* 前缀）
const PNG_1PX =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function makeApp(assetsDir) {
    const app = express();
    app.use(express.json({ limit: '20mb' }));
    app.use('/api/assets', createAssetsRouter({ assetsDir }));
    return app;
}

describe('routes/assets 用户资产', () => {
    let assetsDir;
    beforeEach(() => {
        // assetsDir 本身不预先创建（生产环境 data/assets/ 初始不存在，
        // 首次保存时由后端自建，exists 标记依赖这一点）
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-assets-test-'));
        assetsDir = path.join(root, 'assets');
    });
    afterEach(() => {
        fs.rmSync(path.dirname(assetsDir), { recursive: true, force: true });
    });

    test('POST 保存图片：内容哈希命名 + 展示名 sidecar + url 可取回字节', async () => {
        const app = makeApp(assetsDir);
        const res = await request(app).post('/api/assets')
            .send({ src: PNG_1PX, name: '我的图.png' });
        expect(res.body.status).toBe('ok');
        expect(res.body.existed).toBe(false);
        expect(res.body.filename).toMatch(/^[0-9a-f]{64}\.png$/);
        expect(res.body.name).toBe('我的图.png');
        expect(res.body.url).toBe(`/api/assets/file/${encodeURIComponent(res.body.filename)}`);

        // 文件确实落盘
        expect(fs.readdirSync(assetsDir)).toContain(res.body.filename);

        // 列表含展示名与 exists 标记
        const list = await request(app).get('/api/assets');
        expect(list.body.exists).toBe(true);
        expect(list.body.items).toHaveLength(1);
        expect(list.body.items[0]).toMatchObject({ name: '我的图.png' });
        expect(list.body.items[0].url).toBe(res.body.url);

        // 按列表 url 取回字节，Content-Type 按扩展名推断
        const file = await request(app).get(res.body.url);
        expect(file.status).toBe(200);
        expect(file.headers['content-type']).toContain('image/png');
        expect(file.body.length).toBeGreaterThan(0);
    });

    test('POST 同内容重复保存幂等：单文件 + existed:true + 保留首次展示名', async () => {
        const app = makeApp(assetsDir);
        await request(app).post('/api/assets').send({ src: PNG_1PX, name: 'a.png' });
        const res = await request(app).post('/api/assets').send({ src: PNG_1PX, name: 'b.png' });
        expect(res.body.existed).toBe(true);
        expect(res.body.name).toBe('a.png');
        const files = fs.readdirSync(assetsDir).filter((f) => f !== 'index.json');
        expect(files).toHaveLength(1);
    });

    test('POST 非图片 data URL / 空 base64 拒绝', async () => {
        const app = makeApp(assetsDir);
        const badMime = await request(app).post('/api/assets')
            .send({ src: 'data:text/plain;base64,aGk=' });
        expect(badMime.body.status).toBe('error');
        const empty = await request(app).post('/api/assets')
            .send({ src: 'data:image/png;base64,' });
        expect(empty.body.status).toBe('error');
    });

    test('GET 列表：目录不存在时 exists:false；index.json 与非图片文件不进列表', async () => {
        const app = makeApp(assetsDir);
        const empty = await request(app).get('/api/assets');
        expect(empty.body).toMatchObject({ status: 'ok', exists: false, items: [] });

        await request(app).post('/api/assets').send({ src: PNG_1PX, name: 'a.png' });
        fs.writeFileSync(path.join(assetsDir, 'notes.txt'), 'x');
        const list = await request(app).get('/api/assets');
        expect(list.body.exists).toBe(true);
        expect(list.body.items).toHaveLength(1);
    });

    test('GET /file/:name 路径穿越与非图片扩展名拦截', async () => {
        const app = makeApp(assetsDir);
        const traversal = await request(app).get('/api/assets/file/..%2F..%2Fsettings.json');
        expect(traversal.status).toBe(400);
        const badExt = await request(app).get('/api/assets/file/whatever.txt');
        expect(badExt.status).toBe(400);
        const missing = await request(app).get('/api/assets/file/deadbeef.png');
        expect(missing.status).toBe(404);
    });
});
