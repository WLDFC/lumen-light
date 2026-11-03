/**
 * 漫画分镜模板路由测试（routes/mangaTemplates.js，ADR 078）。
 * 临时 dataDir（os.tmpdir mkdtemp）真读写：清单扫描（坏文件跳过）、
 * 保存（同名覆盖）、删除、载荷校验与 id 防逸出。
 */

const request = require('supertest');
const express = require('express');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const createMangaTemplatesRouter = require('../../routes/mangaTemplates');

const GOOD_CELL = { x: 0.04, y: 0.04, w: 0.28, h: 0.28 };

async function makeApp() {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-tpl-test-'));
    const app = express();
    app.use(express.json());
    app.use('/api/manga-templates', createMangaTemplatesRouter({ dataDir }));
    return { app, dataDir };
}

describe('漫画分镜模板路由（/api/manga-templates）', () => {
    let app, dataDir;

    beforeEach(async () => {
        ({ app, dataDir } = await makeApp());
    });

    afterEach(async () => {
        await fs.rm(dataDir, { recursive: true, force: true });
    });

    test('GET 空目录返回两组空清单，永不 500', async () => {
        const r = await request(app).get('/api/manga-templates');
        expect(r.status).toBe(200);
        expect(r.body.status).toBe('ok');
        expect(r.body.presets).toEqual([]);
        expect(r.body.user).toEqual([]);
    });

    test('POST 保存到 user/，GET 可读回；预设文件进 presets/', async () => {
        const r = await request(app).post('/api/manga-templates')
            .send({ name: '九格节奏', cells: [GOOD_CELL, { ...GOOD_CELL, label: 'character' }] });
        expect(r.status).toBe(200);
        expect(r.body.status).toBe('ok');
        expect(r.body.overwritten).toBe(false);

        // 预设目录手工放一个文件（放文件即生效语义）
        const presetsDir = path.join(dataDir, 'manga-templates', 'presets');
        await fs.mkdir(presetsDir, { recursive: true });
        await fs.writeFile(path.join(presetsDir, '单格留白.json'),
            JSON.stringify({ name: '单格留白', cells: [{ x: 0.05, y: 0.05, w: 0.9, h: 0.9 }] }));

        const list = await request(app).get('/api/manga-templates');
        expect(list.body.presets).toHaveLength(1);
        expect(list.body.presets[0].name).toBe('单格留白');
        expect(list.body.user).toHaveLength(1);
        expect(list.body.user[0].name).toBe('九格节奏');
        expect(list.body.user[0].cells[1].label).toBe('character');
    });

    test('同名保存覆盖（overwritten=true，文件不翻倍）', async () => {
        await request(app).post('/api/manga-templates')
            .send({ name: '三段叙事', cells: [GOOD_CELL] });
        const r = await request(app).post('/api/manga-templates')
            .send({ name: '三段叙事', cells: [{ x: 0.1, y: 0.1, w: 0.8, h: 0.35 }] });
        expect(r.body.overwritten).toBe(true);
        const list = await request(app).get('/api/manga-templates');
        expect(list.body.user).toHaveLength(1);
        expect(list.body.user[0].cells[0].x).toBe(0.1);
    });

    test('载荷校验：坏 cells/空名/超长名 400', async () => {
        expect((await request(app).post('/api/manga-templates')
            .send({ name: 'x', cells: [] })).status).toBe(400);
        expect((await request(app).post('/api/manga-templates')
            .send({ name: 'x', cells: [{ x: -0.1, y: 0, w: 0.5, h: 0.5 }] })).status).toBe(400);
        expect((await request(app).post('/api/manga-templates')
            .send({ name: 'x', cells: [{ x: 0.5, y: 0.5, w: 0.9, h: 0.9 }] })).status).toBe(400);   // 越界
        expect((await request(app).post('/api/manga-templates')
            .send({ name: 'x', cells: [{ ...GOOD_CELL, label: 'bogus' }] })).status).toBe(400);
        expect((await request(app).post('/api/manga-templates')
            .send({ name: '', cells: [GOOD_CELL] })).status).toBe(400);
        expect((await request(app).post('/api/manga-templates')
            .send({ name: 'a'.repeat(41), cells: [GOOD_CELL] })).status).toBe(400);
    });

    test('DELETE 删除用户模板；不存在 404；路径逸出 id 400', async () => {
        await request(app).post('/api/manga-templates')
            .send({ name: '九格节奏', cells: [GOOD_CELL] });
        const id = (await request(app).get('/api/manga-templates')).body.user[0].id;
        expect((await request(app).delete(`/api/manga-templates/user/${encodeURIComponent(id)}`)).status).toBe(200);
        expect((await request(app).delete(`/api/manga-templates/user/${encodeURIComponent(id)}`)).status).toBe(404);
        expect((await request(app).delete('/api/manga-templates/user/..%2F..%2Fmanga-draft')).status).toBe(400);
    });

    test('根级 presetsDir 参数：预设从独立目录读（ADR 078 后记迁移），user 仍落 dataDir', async () => {
        const presetsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-tpl-presets-'));
        const presetsDir = path.join(presetsRoot, 'presets');
        await fs.mkdir(presetsDir, { recursive: true });
        await fs.writeFile(path.join(presetsDir, '三段叙事.json'),
            JSON.stringify({ name: '三段叙事', cells: [GOOD_CELL] }));
        const app2 = express();
        app2.use(express.json());
        app2.use('/api/manga-templates',
            createMangaTemplatesRouter({ dataDir, presetsDir }));
        const list = await request(app2).get('/api/manga-templates');
        expect(list.body.presets).toHaveLength(1);
        expect(list.body.presets[0].name).toBe('三段叙事');
        // user/ 仍按 dataDir 走
        await request(app2).post('/api/manga-templates')
            .send({ name: '我的', cells: [GOOD_CELL] });
        const saved = JSON.parse(await fs.readFile(
            path.join(dataDir, 'manga-templates', 'user', '我的.json'), 'utf-8'));
        expect(saved.name).toBe('我的');
        await fs.rm(presetsRoot, { recursive: true, force: true });
    });

    test('清单扫描跳过坏文件（坏 JSON/缺 name/cells 非法）不拖垮其余条目', async () => {
        const userDir = path.join(dataDir, 'manga-templates', 'user');
        await fs.mkdir(userDir, { recursive: true });
        await fs.writeFile(path.join(userDir, 'a-好的.json'),
            JSON.stringify({ name: '好的', cells: [GOOD_CELL] }));
        await fs.writeFile(path.join(userDir, 'b-坏json.json'), '{oops');
        await fs.writeFile(path.join(userDir, 'c-没名字.json'),
            JSON.stringify({ cells: [GOOD_CELL] }));
        await fs.writeFile(path.join(userDir, 'd-格子越界.json'),
            JSON.stringify({ name: '越界', cells: [{ x: 0, y: 0, w: 1.5, h: 0.5 }] }));
        const list = await request(app).get('/api/manga-templates');
        expect(list.body.user).toHaveLength(1);
        expect(list.body.user[0].name).toBe('好的');
    });
});
