/**
 * ==========================================================================
 * routes/lora.js POST /move 接口测试：
 *   - 移动 lora 文件到子文件夹（sidecar 预览候选 + sidecar JSON 一并搬走）
 *   - 旧版中央 lora-meta.json 首触点自动迁出为 sidecar（迁移源语义，
 *     迁完改名 .migrated.bak）
 *   - 目标已有同名文件跳过不覆盖；已在目标文件夹跳过
 *   - 移回根目录（target: ''）sidecar 跟回
 *   - 路径越界 / 目标目录名不合法 / 缺 paths 拒绝
 * 临时目录隔离（comfy root 与旧版 meta 文件均注入临时路径）。
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

describe('routes/lora POST /move（sidecar JSON 跟文件走）', () => {
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
        // 旧版中央 meta：/move 等触点会先把它迁出成 sidecar JSON
        metaFile = path.join(base, 'lora-meta.json');
        await fsp.writeFile(metaFile, JSON.stringify({
            pinned: ['a.safetensors'],
            triggers: { 'a.safetensors': 'trigger-a' },
            notes: { 'a.safetensors': 'note-a' },
            civitai: { 'a.safetensors': { pageUrl: 'https://x/y', description: '<p>long html</p>' } }
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

    test('移到子文件夹：文件 + sidecar 预览 + sidecar JSON 全部跟着走；旧 meta 迁出留档', async () => {
        const res = await request(app).post('/api/lora/move').send({ paths: ['a.safetensors'], target: 'sub' });
        expect(res.status).toBe(200);
        expect(res.body.moved).toBe(1);

        await fsp.access(path.join(lorasDir, 'sub', 'a.safetensors'));
        await fsp.access(path.join(lorasDir, 'sub', 'a.preview.png'));
        await fsp.access(path.join(lorasDir, 'sub', 'a.png'));
        const movedMeta = JSON.parse(await fsp.readFile(path.join(lorasDir, 'sub', 'a_lumen.json'), 'utf-8'));
        expect(movedMeta.triggers).toBe('trigger-a');
        expect(movedMeta.note).toBe('note-a');
        expect(movedMeta.pinned).toBe(true);
        expect(movedMeta.civitai.pageUrl).toBe('https://x/y');
        expect(movedMeta.civitai.description).toBe('<p>long html</p>');

        // 旧版中央 meta 已迁出并改名留档
        await expect(fsp.access(metaFile)).rejects.toThrow();
        const bak = JSON.parse(await fsp.readFile(metaFile + '.migrated.bak', 'utf-8'));
        expect(bak.triggers['a.safetensors']).toBe('trigger-a');
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

    test('移回根目录（target 空串）：sidecar JSON 跟回根目录', async () => {
        await request(app).post('/api/lora/move').send({ paths: ['a.safetensors'], target: 'sub' });
        const res = await request(app).post('/api/lora/move').send({ paths: ['sub/a.safetensors'], target: '' });
        expect(res.body.moved).toBe(1);
        await fsp.access(path.join(lorasDir, 'a.safetensors'));
        const movedMeta = JSON.parse(await fsp.readFile(path.join(lorasDir, 'a_lumen.json'), 'utf-8'));
        expect(movedMeta.triggers).toBe('trigger-a');
        await expect(fsp.access(path.join(lorasDir, 'sub', 'a_lumen.json'))).rejects.toThrow();
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
