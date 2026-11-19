/**
 * ==========================================================================
 * routes/lora.js per-LoRA sidecar JSON 存储层测试（2026-11-12 中央
 * lora-meta.json 退役）：
 *   - 旧版中央 meta 首触点幂等迁出为 lora 旁 <同名>.json（孤儿记录丢弃）
 *   - GET /pins 聚合：pinned/triggers/notes 还原成表、civitai 剥离
 *     description 大字段
 *   - POST /pins / /trigger / /note 写 sidecar（空串删除该条）
 *   - GET /civitai/info：全量记录（含 description）按需取；未获取过 empty
 *   - POST /delete 清源文件 + 预览 + sidecar JSON
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

describe('routes/lora per-LoRA sidecar JSON 存储层', () => {
    let base;
    let root;
    let lorasDir;
    let metaFile;
    let app;

    beforeEach(async () => {
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'lora-sidecar-test-'));
        root = path.join(base, 'comfy');
        lorasDir = path.join(root, 'models', 'loras');
        await fsp.mkdir(lorasDir, { recursive: true });
        metaFile = path.join(base, 'lora-meta.json');
        await fsp.writeFile(metaFile, JSON.stringify({
            pinned: ['a.safetensors'],
            triggers: { 'a.safetensors': 'trigger-a', 'gone.safetensors': 'orphan' },
            notes: { 'a.safetensors': 'note-a' },
            civitai: {
                'a.safetensors': { modelName: 'Model A', baseModel: 'SDXL', pageUrl: 'https://x/a', description: '<p>desc</p>' },
                'gone.safetensors': { pageUrl: 'https://x/gone' }
            }
        }), 'utf-8');
        await fsp.writeFile(path.join(lorasDir, 'a.safetensors'), 'AAA');
        await fsp.writeFile(path.join(lorasDir, 'b.safetensors'), 'BBB');
        app = makeApp(root, metaFile);
    });

    afterEach(() => {
        fs.rmSync(base, { recursive: true, force: true });
    });

    test('GET /pins 首触点迁移：旧记录并入 sidecar（孤儿丢弃）+ 聚合剥离 description', async () => {
        const r = await request(app).get('/api/lora/pins');
        expect(r.status).toBe(200);
        expect(r.body.status).toBe('ok');
        expect(r.body.pinned).toEqual(['a.safetensors']);
        expect(r.body.triggers['a.safetensors']).toBe('trigger-a');
        expect(r.body.triggers['gone.safetensors']).toBeUndefined();   // lora 已不在：孤儿丢弃
        expect(r.body.notes['a.safetensors']).toBe('note-a');
        expect(r.body.civitai['a.safetensors'].modelName).toBe('Model A');
        expect(r.body.civitai['a.safetensors'].description).toBeUndefined();   // 大字段不进列表载荷

        // sidecar JSON 落在 lora 旁（<同名>_lumen.json）；中央 meta 改名留档
        const sidecar = JSON.parse(await fsp.readFile(path.join(lorasDir, 'a_lumen.json'), 'utf-8'));
        expect(sidecar).toMatchObject({
            pinned: true, triggers: 'trigger-a', note: 'note-a',
            civitai: { baseModel: 'SDXL', description: '<p>desc</p>' }
        });
        await expect(fsp.access(path.join(lorasDir, 'gone_lumen.json'))).rejects.toThrow();
        await expect(fsp.access(metaFile)).rejects.toThrow();
        await expect(fsp.access(metaFile + '.migrated.bak')).resolves.toBeUndefined();

        // 幂等：第二次 /pins 不重复迁移（.migrated.bak 不再被动）
        await request(app).get('/api/lora/pins');
        await expect(fsp.access(metaFile + '.migrated.bak')).resolves.toBeUndefined();
    });

    test('POST /pins / /trigger / /note 写 sidecar；空串清除该条', async () => {
        await request(app).get('/api/lora/pins');   // 触发迁移
        await request(app).post('/api/lora/pins').send({ path: 'b.safetensors', pinned: true });
        await request(app).post('/api/lora/trigger').send({ path: 'b.safetensors', text: 'trigger-b' });
        await request(app).post('/api/lora/note').send({ path: 'b.safetensors', text: 'note-b' });

        const sidecar = JSON.parse(await fsp.readFile(path.join(lorasDir, 'b_lumen.json'), 'utf-8'));
        expect(sidecar.pinned).toBe(true);
        expect(sidecar.triggers).toBe('trigger-b');
        expect(sidecar.note).toBe('note-b');

        await request(app).post('/api/lora/note').send({ path: 'b.safetensors', text: '' });
        const after = JSON.parse(await fsp.readFile(path.join(lorasDir, 'b_lumen.json'), 'utf-8'));
        expect(after.note).toBeUndefined();
        expect(after.triggers).toBe('trigger-b');   // 清 note 不伤触发词

        const pins = await request(app).get('/api/lora/pins');
        expect(pins.body.pinned.sort()).toEqual(['a.safetensors', 'b.safetensors']);
    });

    test('GET /civitai/info：全量记录含 description；未获取过返回 empty', async () => {
        await request(app).get('/api/lora/pins');   // 触发迁移
        const info = await request(app).get('/api/lora/civitai/info?path=a.safetensors');
        expect(info.body.status).toBe('ok');
        expect(info.body.info.description).toBe('<p>desc</p>');
        expect(info.body.info.modelName).toBe('Model A');

        const empty = await request(app).get('/api/lora/civitai/info?path=b.safetensors');
        expect(empty.body.status).toBe('empty');
    });

    test('POST /delete 清源文件 + 预览候选 + sidecar JSON', async () => {
        await request(app).get('/api/lora/pins');   // 触发迁移（a_lumen.json 生成）
        await fsp.writeFile(path.join(lorasDir, 'a.preview.png'), 'PNG');
        const r = await request(app).post('/api/lora/delete').send({ path: 'a.safetensors' });
        expect(r.status).toBe(200);
        await expect(fsp.access(path.join(lorasDir, 'a.safetensors'))).rejects.toThrow();
        await expect(fsp.access(path.join(lorasDir, 'a.preview.png'))).rejects.toThrow();
        await expect(fsp.access(path.join(lorasDir, 'a_lumen.json'))).rejects.toThrow();

        const pins = await request(app).get('/api/lora/pins');
        expect(pins.body.pinned).toEqual([]);   // 删除后聚合里不再出现
    });

    test('旧命名收编：<同名>.json 认本应用 schema 改名 _lumen；别家格式不误抢', async () => {
        // 旧命名（试运行期产物，本应用 schema）→ 收编为 a_lumen.json；
        // 收编先于迁移，故触发词以 sidecar 现值为准（迁移只填空字段）
        await fsp.writeFile(path.join(lorasDir, 'a.json'), JSON.stringify({
            triggers: 'legacy-t', civitai: { sha256: 'X' }
        }), 'utf-8');
        // 别家管理器格式（trainedWords 等，无本应用字段）→ 原样不动
        await fsp.writeFile(path.join(lorasDir, 'b.json'), JSON.stringify({
            trainedWords: ['word'], versionName: 'v1'
        }), 'utf-8');

        const r = await request(app).get('/api/lora/pins');
        expect(r.status).toBe(200);

        const ours = JSON.parse(await fsp.readFile(path.join(lorasDir, 'a_lumen.json'), 'utf-8'));
        expect(ours.triggers).toBe('legacy-t');            // sidecar 现值优先
        expect(ours.note).toBe('note-a');                  // 空字段由中央 meta 补
        expect(ours.civitai.sha256).toBe('X');             // civitai 已存在不覆盖
        await expect(fsp.access(path.join(lorasDir, 'a.json'))).rejects.toThrow();   // 旧名已收编

        const foreign = JSON.parse(await fsp.readFile(path.join(lorasDir, 'b.json'), 'utf-8'));
        expect(foreign.trainedWords).toEqual(['word']);    // 别家文件原样保留
        await expect(fsp.access(path.join(lorasDir, 'b_lumen.json'))).rejects.toThrow();
    });

    test('root 未配置：GET /pins 空结构降级不报错', async () => {
        const noRoot = express();
        noRoot.use(express.json());
        noRoot.use('/api/lora', createLoraRouter({ getComfyRoot: () => null, metaFile }));
        const r = await request(noRoot).get('/api/lora/pins');
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ status: 'ok', pinned: [], triggers: {}, notes: {}, civitai: {} });
    });
});
