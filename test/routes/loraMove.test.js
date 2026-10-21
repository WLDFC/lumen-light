/**
 * ==========================================================================
 * routes/lora.js POST /move 接口测试：
 *   - 移动 lora 文件到子文件夹（sidecar 预览候选一并搬走）
 *   - lora-meta 记录换 key（置顶/触发词/备注/Civitai 跟着文件走）
 *   - 目标已有同名文件跳过不覆盖；已在目标文件夹跳过
 *   - 移回根目录（target: ''）后 meta key 去掉目录前缀
 *   - 路径越界 / 目标目录名不合法 / 缺 paths 拒绝
 * 临时目录隔离（comfy root 与 meta 文件均注入临时路径）。
 * ==========================================================================
 */

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const createLoraRouter = require('../../routes/lora');

function makeApp(root, metaFile) {
    const app = express();
    app.use(express.json());
    app.use('/api/lora', createLoraRouter({ getComfyRoot: () => root, metaFile }));
    return app;
}

describe('routes/lora POST /move', () => {
    let base;
    let root;
    let lorasDir;
    let metaFile;
    let app;

    beforeEach(async () => {
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'lora-move-test-'));
        root = path.join(base, 'comfy');
        lorasDir = path.join(root, 'models', 'loras');
        await fsp.mkdir(path.join(lorasDir, 'sub'), { recursive: true });
        metaFile = path.join(base, 'lora-meta.json');
        await fsp.writeFile(metaFile, JSON.stringify({
            pinned: ['a.safetensors'],
            triggers: { 'a.safetensors': 'trigger-a' },
            notes: { 'a.safetensors': 'note-a' },
            civitai: { 'a.safetensors': { pageUrl: 'https://x/y' } }
        }), 'utf-8');
        await fsp.writeFile(path.join(lorasDir, 'a.safetensors'), 'AAA');
        await fsp.writeFile(path.join(lorasDir, 'a.preview.png'), 'PNG');
        await fsp.writeFile(path.join(lorasDir, 'a.png'), 'PNG2');
        await fsp.writeFile(path.join(lorasDir, 'sub', 'b.safetensors'), 'BBB');
        app = makeApp(root, metaFile);
    });

    afterEach(() => {
        fs.rmSync(base, { recursive: true, force: true });
    });

    test('移到子文件夹：文件 + sidecar + meta 记录全部换 key', async () => {
        const res = await request(app).post('/api/lora/move').send({ paths: ['a.safetensors'], target: 'sub' });
        expect(res.status).toBe(200);
        expect(res.body.moved).toBe(1);

        await fsp.access(path.join(lorasDir, 'sub', 'a.safetensors'));
        await fsp.access(path.join(lorasDir, 'sub', 'a.preview.png'));
        await fsp.access(path.join(lorasDir, 'sub', 'a.png'));

        const meta = JSON.parse(await fsp.readFile(metaFile, 'utf-8'));
        expect(meta.pinned).toContain('sub/a.safetensors');
        expect(meta.pinned).not.toContain('a.safetensors');
        expect(meta.triggers['sub/a.safetensors']).toBe('trigger-a');
        expect(meta.notes['sub/a.safetensors']).toBe('note-a');
        expect(meta.civitai['sub/a.safetensors'].pageUrl).toBe('https://x/y');
    });

    test('目标已有同名文件跳过不覆盖；已在目标文件夹跳过', async () => {
        await fsp.writeFile(path.join(lorasDir, 'c.safetensors'), 'CCC');
        await fsp.writeFile(path.join(lorasDir, 'sub', 'c.safetensors'), 'EXISTING');
        const r1 = await request(app).post('/api/lora/move').send({ paths: ['c.safetensors'], target: 'sub' });
        expect(r1.body.moved).toBe(0);
        expect(r1.body.skipped[0].reason).toBe('目标已有同名文件');
        await expect(fsp.readFile(path.join(lorasDir, 'sub', 'c.safetensors'), 'utf-8')).resolves.toBe('EXISTING');

        const r2 = await request(app).post('/api/lora/move').send({ paths: ['sub/b.safetensors'], target: 'sub' });
        expect(r2.body.skipped[0].reason).toBe('已在目标文件夹');
    });

    test('移回根目录（target 空串）：meta key 去掉目录前缀', async () => {
        await request(app).post('/api/lora/move').send({ paths: ['a.safetensors'], target: 'sub' });
        const res = await request(app).post('/api/lora/move').send({ paths: ['sub/a.safetensors'], target: '' });
        expect(res.body.moved).toBe(1);
        await fsp.access(path.join(lorasDir, 'a.safetensors'));
        const meta = JSON.parse(await fsp.readFile(metaFile, 'utf-8'));
        expect(meta.pinned).toContain('a.safetensors');
        expect(meta.triggers['a.safetensors']).toBe('trigger-a');
    });

    test('路径越界 / 目标目录名不合法 / 缺 paths 拒绝', async () => {
        const badTarget = await request(app).post('/api/lora/move').send({ paths: ['a.safetensors'], target: '../escape' });
        expect(badTarget.status).toBe(400);

        const badSrc = await request(app).post('/api/lora/move').send({ paths: ['../../etc/passwd'], target: 'sub' });
        expect(badSrc.status).toBe(200);
        expect(badSrc.body.failed).toHaveLength(1);
        expect(badSrc.body.failed[0].reason).toBe('路径越界');

        const missing = await request(app).post('/api/lora/move').send({});
        expect(missing.status).toBe(400);
    });
});
