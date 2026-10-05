/**
 * ==========================================================================
 * routes/piSkills.js 集成测试
 * 覆盖：技能列表解析（合法/非法/readme 文件）、启停往返（disabledSkills
 * 增删与幂等）、settings.json 其他区块保留（permissionLevel）、非法 id 拦截。
 * 通过 supertest 直连 Express 应用，使用临时目录避免污染 data/。
 * ==========================================================================
 */

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');

const createPiSkillsRouter = require('../../routes/piSkills');

/** 合法技能文件模板（与 lumen-skills.ts 的解析契约一致） */
const SKILL_MD = (id, name, desc) =>
    `---\nid: ${id}\nname: ${name}\ndescription: ${desc}\n---\n第一步：做 X。\n第二步：做 Y。`;

function makeApp(dataDir) {
    const app = express();
    app.use(express.json());
    app.use('/api/pi-skills', createPiSkillsRouter({ dataDir }));
    return app;
}

const readSettings = (dataDir) =>
    JSON.parse(fs.readFileSync(path.join(dataDir, 'pi', 'settings.json'), 'utf-8'));

describe('routes/piSkills', () => {
    let dataDir;
    beforeEach(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-skills-test-'));
        fs.mkdirSync(path.join(dataDir, 'pi', 'skills'), { recursive: true });
    });
    afterEach(() => {
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    test('空目录返回空清单', async () => {
        const res = await request(makeApp(dataDir)).get('/api/pi-skills');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.skills).toEqual([]);
        expect(res.body.invalid).toEqual([]);
    });

    test('列出合法技能（默认启用、含正文），非法文件进 invalid，readme 跳过', async () => {
        fs.writeFileSync(path.join(dataDir, 'pi', 'skills', 'demo-skill.md'),
            SKILL_MD('demo-skill', '演示技能', '用于测试'));
        fs.writeFileSync(path.join(dataDir, 'pi', 'skills', 'broken.md'), '没有 frontmatter 的文件');
        // id 与文件名不一致的文件（扩展会静默忽略，路由归入 invalid）
        fs.writeFileSync(path.join(dataDir, 'pi', 'skills', 'wrong-name.md'),
            SKILL_MD('other-id', '坏命名', 'x'));
        fs.writeFileSync(path.join(dataDir, 'pi', 'skills', 'readme.md'), '# 目录说明');

        const res = await request(makeApp(dataDir)).get('/api/pi-skills');
        expect(res.body.skills).toHaveLength(1);
        expect(res.body.skills[0]).toMatchObject({
            id: 'demo-skill', name: '演示技能', description: '用于测试', enabled: true
        });
        expect(res.body.skills[0].body).toContain('第二步：做 Y。');
        expect(res.body.invalid.map((v) => v.file).sort()).toEqual(['broken.md', 'wrong-name.md']);
    });

    test('启停往返：禁用写 disabledSkills，重新启用移出清单', async () => {
        fs.writeFileSync(path.join(dataDir, 'pi', 'skills', 'demo-skill.md'),
            SKILL_MD('demo-skill', '演示技能', 'x'));
        const app = makeApp(dataDir);

        let res = await request(app).put('/api/pi-skills/demo-skill/enabled').send({ enabled: false });
        expect(res.body.status).toBe('ok');
        expect(res.body.enabled).toBe(false);
        expect(readSettings(dataDir).disabledSkills).toEqual(['demo-skill']);

        res = await request(app).get('/api/pi-skills');
        expect(res.body.skills[0].enabled).toBe(false);

        res = await request(app).put('/api/pi-skills/demo-skill/enabled').send({ enabled: true });
        expect(res.body.disabledSkills).toEqual([]);
        res = await request(app).get('/api/pi-skills');
        expect(res.body.skills[0].enabled).toBe(true);
    });

    test('重复禁用幂等，不产生重复项', async () => {
        const app = makeApp(dataDir);
        await request(app).put('/api/pi-skills/a-skill/enabled').send({ enabled: false });
        await request(app).put('/api/pi-skills/a-skill/enabled').send({ enabled: false });
        expect(readSettings(dataDir).disabledSkills).toEqual(['a-skill']);
    });

    test('保留 settings.json 其他区块（permissionLevel）', async () => {
        fs.writeFileSync(path.join(dataDir, 'pi', 'settings.json'),
            JSON.stringify({ permissionLevel: 'full' }, null, 2));
        const app = makeApp(dataDir);
        await request(app).put('/api/pi-skills/demo/enabled').send({ enabled: false });
        const settings = readSettings(dataDir);
        expect(settings.permissionLevel).toBe('full');
        expect(settings.disabledSkills).toEqual(['demo']);
    });

    test('非法 id（含特殊字符）返回 400，不写状态', async () => {
        const app = makeApp(dataDir);
        const res = await request(app)
            .put(`/api/pi-skills/${encodeURIComponent('bad!id')}/enabled`)
            .send({ enabled: false });
        expect(res.status).toBe(400);
        expect(fs.existsSync(path.join(dataDir, 'pi', 'settings.json'))).toBe(false);
    });

    // ==================== 文件夹形态与上传 ====================

    const b64 = (s) => Buffer.from(s).toString('base64');

    test('GET 识别文件夹形态技能，无效文件夹进 invalid（带原因）', async () => {
        const dir = path.join(dataDir, 'pi', 'skills', 'my-skill');
        fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'),
            '---\nname: 我的文件夹技能\ndescription: 用于测试\n---\n正文内容');
        fs.writeFileSync(path.join(dir, 'scripts', 'run.py'), 'print(1)');
        fs.mkdirSync(path.join(dataDir, 'pi', 'skills', 'empty-dir'), { recursive: true });
        const badDir = path.join(dataDir, 'pi', 'skills', 'bad-folder');
        fs.mkdirSync(badDir, { recursive: true });
        fs.writeFileSync(path.join(badDir, 'SKILL.md'),
            '---\nid: other\nname: x\ndescription: y\n---\n正文');

        const res = await request(makeApp(dataDir)).get('/api/pi-skills');
        expect(res.body.skills).toHaveLength(1);
        expect(res.body.skills[0]).toMatchObject({
            id: 'my-skill', name: '我的文件夹技能', form: 'folder', enabled: true
        });
        expect(res.body.skills[0].body).toContain('正文内容');
        const reasons = Object.fromEntries(res.body.invalid.map((v) => [v.file, v.reason]));
        expect(reasons['empty-dir/']).toContain('SKILL.md');
        expect(reasons['bad-folder/']).toContain('不一致');
    });

    test('上传文件夹：辅助文件原样落盘；重复上传 409，allowOverwrite 覆盖', async () => {
        const app = makeApp(dataDir);
        const files = [
            { path: 'my-skill/SKILL.md', content: b64('---\nname: 文件夹技能\ndescription: d\n---\n正文'), encoding: 'base64' },
            { path: 'my-skill/scripts/run.py', content: b64('print(1)'), encoding: 'base64' }
        ];
        let res = await request(app).post('/api/pi-skills/upload').send({ files });
        expect(res.body.status).toBe('ok');
        expect(res.body).toMatchObject({ id: 'my-skill', form: 'folder', fileCount: 2 });
        expect(fs.existsSync(path.join(dataDir, 'pi', 'skills', 'my-skill', 'scripts', 'run.py'))).toBe(true);

        res = await request(app).post('/api/pi-skills/upload').send({ files });
        expect(res.status).toBe(409);
        expect(res.body.exists).toBe(true);

        res = await request(app).post('/api/pi-skills/upload').send({ files, allowOverwrite: true });
        expect(res.body.status).toBe('ok');

        const list = await request(app).get('/api/pi-skills');
        expect(list.body.skills[0].id).toBe('my-skill');
    });

    test('上传文件夹：缺 SKILL.md / id 不一致 / 混合上传 / 路径穿越 均拒绝', async () => {
        const app = makeApp(dataDir);
        let res = await request(app).post('/api/pi-skills/upload').send({
            files: [{ path: 'no-entry/readme.txt', content: b64('x'), encoding: 'base64' }]
        });
        expect(res.body.message).toContain('SKILL.md');

        res = await request(app).post('/api/pi-skills/upload').send({
            files: [{ path: 'my-skill/SKILL.md', content: b64('---\nid: other\nname: n\ndescription: d\n---\n正文'), encoding: 'base64' }]
        });
        expect(res.body.message).toContain('不一致');

        res = await request(app).post('/api/pi-skills/upload').send({
            files: [
                { path: 'my-skill/SKILL.md', content: b64('---\nname: n\ndescription: d\n---\n正文'), encoding: 'base64' },
                { path: 'loose.md', content: b64('---\nid: loose\nname: n\ndescription: d\n---\n正文'), encoding: 'base64' }
            ]
        });
        expect(res.body.message).toContain('混合');

        res = await request(app).post('/api/pi-skills/upload').send({
            files: [{ path: 'my-skill/../evil.md', content: b64('x'), encoding: 'base64' }]
        });
        expect(res.status).toBe(400);
        expect(fs.existsSync(path.join(dataDir, 'evil.md'))).toBe(false);
    });

    test('上传单 .md：以 frontmatter id 命名落盘；缺字段/非 md 拒绝', async () => {
        const app = makeApp(dataDir);
        let res = await request(app).post('/api/pi-skills/upload').send({
            files: [{ path: 'wrong-name.md', content: b64('---\nid: right-id\nname: 名\ndescription: 描述\n---\n正文'), encoding: 'base64' }]
        });
        expect(res.body).toMatchObject({ status: 'ok', ids: ['right-id'], form: 'file' });
        expect(fs.existsSync(path.join(dataDir, 'pi', 'skills', 'right-id.md'))).toBe(true);
        expect(fs.existsSync(path.join(dataDir, 'pi', 'skills', 'wrong-name.md'))).toBe(false);

        res = await request(app).post('/api/pi-skills/upload').send({
            files: [{ path: 'no-desc.md', content: b64('---\nid: no-desc\nname: 名\n---\n正文'), encoding: 'base64' }]
        });
        expect(res.status).toBe(400);

        res = await request(app).post('/api/pi-skills/upload').send({
            files: [{ path: 'script.py', content: b64('print(1)'), encoding: 'base64' }]
        });
        expect(res.body.message).toContain('.md');
    });

    test('上传单 .md 与同 id 文件夹冲突：409 后覆盖会移除文件夹', async () => {
        const app = makeApp(dataDir);
        // 先上传文件夹形态
        await request(app).post('/api/pi-skills/upload').send({
            files: [{ path: 'demo/SKILL.md', content: b64('---\nname: n\ndescription: d\n---\n正文'), encoding: 'base64' }]
        });
        // 再上传同 id 的单文件
        const files = [{ path: 'demo.md', content: b64('---\nid: demo\nname: n2\ndescription: d2\n---\n正文2'), encoding: 'base64' }];
        let res = await request(app).post('/api/pi-skills/upload').send({ files });
        expect(res.status).toBe(409);
        res = await request(app).post('/api/pi-skills/upload').send({ files, allowOverwrite: true });
        expect(res.body.status).toBe('ok');
        expect(fs.existsSync(path.join(dataDir, 'pi', 'skills', 'demo.md'))).toBe(true);
        expect(fs.existsSync(path.join(dataDir, 'pi', 'skills', 'demo'))).toBe(false);
    });
});
