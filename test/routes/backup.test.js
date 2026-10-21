/**
 * ==========================================================================
 * routes/backup.js 集成测试（备份导出/导入）
 *   - 纯函数：sanitizeEntryName 防 zip-slip / stripSecrets 三处密钥脱敏 /
 *     mergeApiProviders 按厂商合并 / mergeTagEntries·mergeModelTags 并集
 *   - 导出：zip 结构（manifest 首条目/存档/设置/聊天/提示词）、脱敏开关、
 *     manifest 内容与勾选项一致
 *   - 导入：同名存档改名不覆盖、新增存档落位、API 设置按厂商合并且
 *     未涉及厂商保留、收藏/模型标签/提示词库并集合并（现有优先）、
 *     聊天记录随响应返回不落盘、坏包（非 zip/缺 manifest）400
 * 通过 supertest 直连 Express 应用，临时目录避免污染真实数据。
 * ==========================================================================
 */

const express = require('express');
const request = require('supertest');
const fs = require('fs').promises;
const fsp = fs;
const os = require('os');
const path = require('path');
const archiver = require('archiver');
const yauzl = require('yauzl');

const createBackupRouter = require('../../routes/backup');

const {
    sanitizeEntryName,
    stripSecrets,
    mergeApiProviders,
    mergeTagEntries,
    mergeModelTags
} = createBackupRouter;

// ==================== 测试辅助 ====================

function makeApp({ savesDir, dataDir, tagsDir }) {
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api/backup', createBackupRouter({ savesDir, dataDir, tagsDir }));
    return app;
}

/** 用 archiver 把 {name: content} 打成 zip 文件（content 为 string/Buffer） */
function buildZip(entries) {
    const zipPath = path.join(os.tmpdir(), `lumen-backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
    return new Promise((resolve, reject) => {
        const output = require('fs').createWriteStream(zipPath);
        const archive = archiver('zip');
        output.on('close', () => resolve(zipPath));
        archive.on('error', reject);
        archive.pipe(output);
        for (const [name, content] of Object.entries(entries)) {
            archive.append(content, { name });
        }
        archive.finalize();
    });
}

/** 用 yauzl 把 zip 读成 {names: [按序], files: {name: Buffer}} */
function readZip(zipPath) {
    return new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
            if (err) return reject(err);
            const names = [];
            const files = {};
            zipfile.readEntry();
            zipfile.on('entry', (entry) => {
                names.push(entry.fileName);
                zipfile.openReadStream(entry, (err2, rs) => {
                    if (err2) return reject(err2);
                    const chunks = [];
                    rs.on('data', (c) => chunks.push(c));
                    rs.on('end', () => {
                        files[entry.fileName] = Buffer.concat(chunks);
                        zipfile.readEntry();
                    });
                });
            });
            zipfile.on('end', () => resolve({ names, files }));
            zipfile.on('error', reject);
        });
    });
}

const CHAT_RECORDS = [
    { key: '_global', html: '<div class="msg">你好</div>', gen: {}, savedAt: 1700000000000 },
    { key: 'web-doubao', html: '<div class="msg">桥接</div>', gen: {}, savedAt: 1700000000001 }
];

describe('routes/backup 纯函数', () => {
    test('sanitizeEntryName：拒绝上跳/绝对路径/盘符/反斜杠', () => {
        expect(sanitizeEntryName('../evil.txt')).toBeNull();
        expect(sanitizeEntryName('a/../../b.txt')).toBeNull();
        expect(sanitizeEntryName('./a.txt')).toBeNull();
        expect(sanitizeEntryName('/abs/a.txt')).toBeNull();
        expect(sanitizeEntryName('C:/abs/a.txt')).toBeNull();
        expect(sanitizeEntryName('a\\b.txt')).toBeNull();
        expect(sanitizeEntryName('')).toBeNull();
        expect(sanitizeEntryName('saves/我的存档/project.json')).toBe('saves/我的存档/project.json');
        expect(sanitizeEntryName('a//b.txt')).toBe('a/b.txt');
    });

    test('stripSecrets：三处密钥置空，其余字段保留，入参不被修改', () => {
        const settings = {
            api: { providers: { Deepseek: { endpoint: 'e', apiKey: 'sk-1', models: ['m'] } } },
            runninghub: { apiKey: 'rh-1', endpoint: 'x' },
            civitai: { apiKey: 'cv-1', proxy: '' },
            comfy: { root: 'D:/x' }
        };
        const out = stripSecrets(settings);
        expect(out.api.providers.Deepseek.apiKey).toBe('');
        expect(out.runninghub.apiKey).toBe('');
        expect(out.civitai.apiKey).toBe('');
        expect(out.comfy.root).toBe('D:/x');
        expect(out.api.providers.Deepseek.endpoint).toBe('e');
        // 入参不动
        expect(settings.api.providers.Deepseek.apiKey).toBe('sk-1');
        expect(settings.runninghub.apiKey).toBe('rh-1');
    });

    test('mergeApiProviders：同名覆盖、新名追加、现有保留', () => {
        const current = {
            Deepseek: { endpoint: 'old', apiKey: 'old', models: ['a'] },
            Extra: { endpoint: 'keep', apiKey: 'k', models: [] }
        };
        const backup = {
            Deepseek: { endpoint: 'new', apiKey: 'new', models: ['b'] },
            Added: { endpoint: 'add', apiKey: 'x', models: [] }
        };
        const r = mergeApiProviders({ providers: current }, { providers: backup });
        expect(r.providers.Deepseek).toEqual(backup.Deepseek);
        expect(r.providers.Extra).toEqual(current.Extra);
        expect(r.providers.Added).toEqual(backup.Added);
        expect(r.updated).toBe(1);
        expect(r.added).toBe(1);
    });

    test('mergeTagEntries：按 id 并集、现有优先、无 id 跳过；mergeModelTags 按 name', () => {
        const r = mergeTagEntries(
            [{ id: 't1', prompt: 'current' }],
            [{ id: 't1', prompt: 'backup' }, { id: 't2', prompt: 'new' }, { prompt: 'no-id' }]
        );
        expect(r.list).toEqual([{ id: 't1', prompt: 'current' }, { id: 't2', prompt: 'new' }]);
        expect(r.added).toBe(1);

        const m = mergeModelTags([{ name: 'M1' }], [{ name: 'M1' }, { name: 'M2' }]);
        expect(m.list.map(x => x.name)).toEqual(['M1', 'M2']);
        expect(m.added).toBe(1);
    });
});

describe('routes/backup 备份导出', () => {
    let root, savesDir, dataDir, tagsDir, app;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-backup-export-'));
        savesDir = path.join(root, 'save');
        dataDir = path.join(root, 'data');
        tagsDir = path.join(root, 'tag');
        await fs.mkdir(path.join(savesDir, '我的存档'), { recursive: true });
        await fs.writeFile(path.join(savesDir, '我的存档', 'project.json'), '{"name":"我的存档"}');
        await fs.writeFile(path.join(savesDir, '我的存档', 'img.png'), Buffer.from([0x89, 0x50]));
        await fs.mkdir(dataDir, { recursive: true });
        await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({
            api: { providers: { Deepseek: { endpoint: 'e', apiKey: 'sk-1', models: [] } } },
            runninghub: { apiKey: 'rh-1' }
        }));
        await fs.writeFile(path.join(dataDir, 'prompts.json'), JSON.stringify({ prompts: [{ id: 'p1' }], active: {} }));
        await fs.writeFile(path.join(dataDir, 'comfy-prompts.json'), JSON.stringify({ positive: [], negative: [] }));
        await fs.mkdir(path.join(tagsDir, 'images'), { recursive: true });
        await fs.writeFile(path.join(tagsDir, 'tags.json'), JSON.stringify([{ id: 't1' }]));
        await fs.writeFile(path.join(tagsDir, 'images', 'a.png'), Buffer.from([1, 2, 3]));
        app = makeApp({ savesDir, dataDir, tagsDir });
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    /** supertest 默认不认识 application/zip：挂 binary parser 拿到 Buffer */
    function binaryParser(res, callback) {
        res.setEncoding('binary');
        res.data = '';
        res.on('data', (chunk) => { res.data += chunk; });
        res.on('end', () => callback(null, Buffer.from(res.data, 'binary')));
    }

    async function exportBackup(includeKeys) {
        const res = await request(app).post('/api/backup/export')
            .parse(binaryParser)
            .send({
                saves: true, settings: true, settingsIncludeKeys: includeKeys,
                chat: true, chatData: CHAT_RECORDS, prompts: true
            });
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('application/zip');
        const zipPath = path.join(root, 'out.zip');
        await fs.writeFile(zipPath, res.body);
        return readZip(zipPath);
    }

    test('全项导出：manifest 首条目、结构完整、默认脱敏', async () => {
        const { names, files } = await exportBackup(false);

        expect(names[0]).toBe('backup-manifest.json');
        expect(names).toEqual(expect.arrayContaining([
            'saves/我的存档/project.json',
            'saves/我的存档/img.png',
            'settings.json',
            'chat-history.json',
            'prompts/system-prompts.json',
            'prompts/comfy-prompts.json',
            'tags/tags.json',
            'tags/images/a.png'
        ]));

        const manifest = JSON.parse(files['backup-manifest.json'].toString('utf-8'));
        expect(manifest.formatVersion).toBe(1);
        expect(manifest.items.saves).toEqual(['我的存档']);
        expect(manifest.items.chat).toEqual({ count: 2 });
        expect(manifest.items.settings).toBe(true);
        expect(manifest.items.prompts).toBe(true);

        // 默认不含 Key：三处密钥全部置空
        const settings = JSON.parse(files['settings.json'].toString('utf-8'));
        expect(settings.api.providers.Deepseek.apiKey).toBe('');
        expect(settings.runninghub.apiKey).toBe('');

        const chat = JSON.parse(files['chat-history.json'].toString('utf-8'));
        expect(chat).toEqual(CHAT_RECORDS);
    });

    test('settingsIncludeKeys=true 时密钥原样导出', async () => {
        const { files } = await exportBackup(true);
        const settings = JSON.parse(files['settings.json'].toString('utf-8'));
        expect(settings.api.providers.Deepseek.apiKey).toBe('sk-1');
        expect(settings.runninghub.apiKey).toBe('rh-1');
    });

    test('一项都没选 → 400；chat 勾选但缺 chatData → 400', async () => {
        const res1 = await request(app).post('/api/backup/export').send({});
        expect(res1.status).toBe(400);
        const res2 = await request(app).post('/api/backup/export').send({ chat: true });
        expect(res2.status).toBe(400);
    });
});

describe('routes/backup 备份导入', () => {
    let root, savesDir, dataDir, tagsDir, app;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-backup-import-'));
        savesDir = path.join(root, 'save');
        dataDir = path.join(root, 'data');
        tagsDir = path.join(root, 'tag');
        await fs.mkdir(dataDir, { recursive: true });

        // 现状：一个同名存档、两个厂商（Deepseek 待覆盖 / Extra 须保留）、收藏 t1
        await fs.mkdir(path.join(savesDir, '我的存档'), { recursive: true });
        await fs.writeFile(path.join(savesDir, '我的存档', 'project.json'), '{"name":"我的存档","v":1}');
        await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({
            api: {
                currentProvider: 'Deepseek',
                providers: {
                    Deepseek: { endpoint: 'old', apiKey: 'old', models: ['a'] },
                    Extra: { endpoint: 'keep', apiKey: 'keep', models: [] }
                }
            },
            runninghub: { apiKey: 'rh-current' }
        }));
        await fs.mkdir(path.join(tagsDir, 'images'), { recursive: true });
        await fs.writeFile(path.join(tagsDir, 'tags.json'), JSON.stringify([{ id: 't1', prompt: 'current' }]));
        await fs.writeFile(path.join(tagsDir, 'models.json'), JSON.stringify([{ name: 'M1', parentId: null }]));
        await fs.writeFile(path.join(dataDir, 'prompts.json'), JSON.stringify({
            prompts: [{ id: 'p1', name: '现有' }],
            active: { chat: 'p1', image: null }
        }));
        app = makeApp({ savesDir, dataDir, tagsDir });
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    /** 构造一份标准备份包 */
    async function buildStandardBackup() {
        return buildZip({
            'backup-manifest.json': JSON.stringify({ formatVersion: 1, items: {} }),
            'saves/我的存档/project.json': '{"name":"我的存档","v":2}',
            'saves/新存档/project.json': '{"name":"新存档"}',
            'settings.json': JSON.stringify({
                api: {
                    providers: {
                        Deepseek: { endpoint: 'new', apiKey: 'new', models: ['b'] },
                        Added: { endpoint: 'add', apiKey: 'add', models: [] }
                    }
                },
                runninghub: { apiKey: 'rh-backup' }
            }),
            'chat-history.json': JSON.stringify(CHAT_RECORDS),
            'tags/tags.json': JSON.stringify([{ id: 't1', prompt: 'backup' }, { id: 't2', prompt: 'new' }]),
            'tags/models.json': JSON.stringify([{ name: 'M1' }, { name: 'M2', parentId: 'M1' }]),
            'tags/images/new.png': Buffer.from([9, 9]),
            'prompts/system-prompts.json': JSON.stringify({ prompts: [{ id: 'p2', name: '导入' }], active: {} }),
            'prompts/comfy-prompts.json': JSON.stringify({ positive: [{ id: 'c1' }], negative: [] })
        });
    }

    test('全项导入：同名存档改名不覆盖、合并策略生效、聊天记录随响应返回', async () => {
        const zipPath = await buildStandardBackup();
        const zipBuf = await fs.readFile(zipPath);

        const res = await request(app)
            .post('/api/backup/import?saves=1&settings=1&chat=1&prompts=1')
            .set('Content-Type', 'application/zip')
            .send(zipBuf);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');

        const s = res.body.summary;
        // 同名存档被改名导入，原存档内容未被动过；新存档直接落位
        expect(s.savesRenamed).toBe(1);
        expect(s.savesImported).toHaveLength(2);
        expect(s.savesImported.some(n => n.startsWith('我的存档-导入'))).toBe(true);
        expect(s.savesImported).toContain('新存档');
        expect(await fs.readFile(path.join(savesDir, '我的存档', 'project.json'), 'utf-8')).toBe('{"name":"我的存档","v":1}');
        expect(await fs.readFile(path.join(savesDir, '新存档', 'project.json'), 'utf-8')).toBe('{"name":"新存档"}');

        // API 设置：同名厂商以备份包为准、新增追加、未涉及厂商保留、其余节不动
        expect(s.settingsUpdated).toBe(1);
        expect(s.settingsAdded).toBe(1);
        const settings = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf-8'));
        expect(settings.api.providers.Deepseek).toEqual({ endpoint: 'new', apiKey: 'new', models: ['b'] });
        expect(settings.api.providers.Extra).toEqual({ endpoint: 'keep', apiKey: 'keep', models: [] });
        expect(settings.api.providers.Added.apiKey).toBe('add');
        expect(settings.api.currentProvider).toBe('Deepseek');
        expect(settings.runninghub.apiKey).toBe('rh-current');

        // 收藏/模型标签：并集合并、现有优先
        expect(s.tagsAdded).toBe(1);
        expect(s.modelsAdded).toBe(1);
        const tags = JSON.parse(await fs.readFile(path.join(tagsDir, 'tags.json'), 'utf-8'));
        expect(tags).toEqual([{ id: 't1', prompt: 'current' }, { id: 't2', prompt: 'new' }]);
        const models = JSON.parse(await fs.readFile(path.join(tagsDir, 'models.json'), 'utf-8'));
        expect(models.map(m => m.name)).toEqual(['M1', 'M2']);
        expect(await fs.readFile(path.join(tagsDir, 'images', 'new.png'))).toEqual(Buffer.from([9, 9]));

        // 系统提示词合并：active 保留现有
        const sysPrompts = JSON.parse(await fs.readFile(path.join(dataDir, 'prompts.json'), 'utf-8'));
        expect(sysPrompts.prompts.map(p => p.id)).toEqual(['p1', 'p2']);
        expect(sysPrompts.active).toEqual({ chat: 'p1', image: null });

        // 聊天记录：随响应返回（前端写回 IndexedDB），服务端不落盘
        expect(s.chatRecords).toBe(2);
        expect(res.body.chat).toEqual(CHAT_RECORDS);
        expect(await fs.readdir(dataDir)).not.toContain('chat-history.json');
    });

    test('只勾部分项：未勾选项完全不动', async () => {
        const zipPath = await buildStandardBackup();
        const zipBuf = await fs.readFile(zipPath);
        const res = await request(app)
            .post('/api/backup/import?settings=1')
            .set('Content-Type', 'application/zip')
            .send(zipBuf);
        expect(res.status).toBe(200);
        expect(res.body.summary.savesImported).toHaveLength(0);
        expect(res.body.chat).toBeNull();
        // 存档目录没有被新增（除原有的）
        const saves = (await fs.readdir(savesDir)).filter(n => !n.endsWith('.tmp'));
        expect(saves).toEqual(['我的存档']);
    });

    test('非 zip 内容 → 400', async () => {
        const res = await request(app)
            .post('/api/backup/import?saves=1')
            .set('Content-Type', 'application/zip')
            .send(Buffer.from('this is not a zip file'));
        expect(res.status).toBe(400);
        expect(res.body.status).toBe('error');
    });

    test('缺 manifest（不是流光备份包）→ 400', async () => {
        const zipPath = await buildZip({ 'random.txt': 'hello' });
        const zipBuf = await fs.readFile(zipPath);
        const res = await request(app)
            .post('/api/backup/import?saves=1')
            .set('Content-Type', 'application/zip')
            .send(zipBuf);
        expect(res.status).toBe(400);
        expect(res.body.message).toContain('backup-manifest');
    });

    test('formatVersion 不符 → 400', async () => {
        const zipPath = await buildZip({
            'backup-manifest.json': JSON.stringify({ formatVersion: 999, items: {} })
        });
        const zipBuf = await fs.readFile(zipPath);
        const res = await request(app)
            .post('/api/backup/import?saves=1')
            .set('Content-Type', 'application/zip')
            .send(zipBuf);
        expect(res.status).toBe(400);
    });

    test('一个勾选项都没传 → 400', async () => {
        const res = await request(app)
            .post('/api/backup/import')
            .set('Content-Type', 'application/zip')
            .send(Buffer.from('x'));
        expect(res.status).toBe(400);
    });
});
