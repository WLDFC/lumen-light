/**
 * ==========================================================================
 * routes/tags.js POST /reveal（打开所在文件夹）测试：
 *   - 合法 id → 200 且调用 explorer /select 选中图片文件（win32 分支）
 *   - 缺 id 400 / 未知 id 404 / 磁盘文件不存在 404
 *   - imageHash 缺失时从 imageUrl 末段兜底推导文件名
 * child_process 整体 mock（绝不真开资源管理器）；临时目录隔离 tag/，
 * 内存 express 应用 + supertest 直打路由。
 * ==========================================================================
 */

jest.mock('child_process', () => ({
    exec: jest.fn(),
    execFile: jest.fn()
}));

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const createTagsRouter = require('../../routes/tags');

function makeApp(tagsDir) {
    const app = express();
    app.use(express.json());
    app.use('/api/tags', createTagsRouter({ tagsDir }));
    return app;
}

describe('routes/tags POST /reveal 打开所在文件夹', () => {
    let tagsDir;
    beforeEach(() => {
        jest.clearAllMocks();
        tagsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tags-reveal-test-'));
        fs.mkdirSync(path.join(tagsDir, 'images'), { recursive: true });
    });
    afterEach(() => {
        fs.rmSync(tagsDir, { recursive: true, force: true });
    });

    /** 预置一条收藏 + 磁盘图片文件，返回 tagsDir */
    function seed({ withFile = true, withHash = true } = {}) {
        const hash = 'aaa111';
        const tag = {
            id: 't1',
            ...(withHash ? { imageHash: hash } : {}),
            name: 'x', model: '', prompt: 'p',
            imageUrl: `/tag/images/${hash}.webp`,
            thumbnailUrl: `/tag/thumbnails/${hash}.webp`,
            createdAt: 1700000000000
        };
        fs.writeFileSync(path.join(tagsDir, 'tags.json'), JSON.stringify([tag]), 'utf8');
        if (withFile) fs.writeFileSync(path.join(tagsDir, 'images', `${hash}.webp`), 'x');
        return tag;
    }

    test('合法 id：200 且 explorer /select 选中图片文件', async () => {
        seed();
        const res = await request(makeApp(tagsDir)).post('/api/tags/reveal').send({ id: 't1' });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(exec).toHaveBeenCalledTimes(1);
        const cmd = exec.mock.calls[0][0];
        expect(cmd).toContain('explorer /select,');
        expect(cmd).toContain(path.join(tagsDir, 'images', 'aaa111.webp'));
    });

    test('缺 id 400；未知 id 404', async () => {
        seed();
        const app = makeApp(tagsDir);
        expect((await request(app).post('/api/tags/reveal').send({})).status).toBe(400);
        expect((await request(app).post('/api/tags/reveal').send({ id: 'nope' })).status).toBe(404);
        expect(exec).not.toHaveBeenCalled();
    });

    test('tags.json 有记录但磁盘文件不存在：404 不触发打开', async () => {
        seed({ withFile: false });
        const res = await request(makeApp(tagsDir)).post('/api/tags/reveal').send({ id: 't1' });
        expect(res.status).toBe(404);
        expect(exec).not.toHaveBeenCalled();
    });

    test('imageHash 缺失的旧条目从 imageUrl 末段兜底推导', async () => {
        seed({ withHash: false });
        const res = await request(makeApp(tagsDir)).post('/api/tags/reveal').send({ id: 't1' });
        expect(res.status).toBe(200);
        expect(exec.mock.calls[0][0]).toContain('aaa111.webp');
    });
});
