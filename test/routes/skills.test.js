/**
 * ==========================================================================
 * routes/skills.js GET 接口测试：文件夹形态（Anthropic Agent Skills 标准）
 * 识别——<文件夹>/SKILL.md，id 取文件夹名，frontmatter 写了 id 必须与
 * 文件夹名一致；同 id 时平铺件优先。临时目录隔离 data/skills/。
 * ==========================================================================
 */

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');

const createSkillsRouter = require('../../routes/skills');

function makeApp(skillsDir) {
    const app = express();
    app.use(express.json());
    app.use('/api/skills', createSkillsRouter({ skillsDir }));
    return app;
}

describe('routes/skills 文件夹形态', () => {
    let skillsDir;
    beforeEach(() => {
        skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-skills-test-'));
    });
    afterEach(() => {
        fs.rmSync(skillsDir, { recursive: true, force: true });
    });

    test('识别 <文件夹>/SKILL.md（id=文件夹名），与平铺件并存', async () => {
        const dir = path.join(skillsDir, 'folder-skill');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'),
            '---\nname: 文件夹技能\ndescription: d\ninputText: true\n---\n正文指令');
        fs.writeFileSync(path.join(skillsDir, 'flat-skill.md'),
            '---\nid: flat-skill\nname: 平铺技能\ndescription: d\n---\n正文');

        const res = await request(makeApp(skillsDir)).get('/api/skills');
        expect(res.body.status).toBe('ok');
        const ids = res.body.skills.map((s) => s.id);
        expect(ids).toContain('folder-skill');
        expect(ids).toContain('flat-skill');
        const folder = res.body.skills.find((s) => s.id === 'folder-skill');
        expect(folder).toMatchObject({ name: '文件夹技能', instruction: '正文指令', inputText: true });
    });

    test('frontmatter id 与文件夹名不一致的文件夹跳过', async () => {
        const dir = path.join(skillsDir, 'my-dir');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'),
            '---\nid: other\nname: n\ndescription: d\n---\n正文');
        const res = await request(makeApp(skillsDir)).get('/api/skills');
        expect(res.body.skills).toEqual([]);
    });

    test('缺 SKILL.md 的文件夹跳过，同 id 平铺件优先于文件夹', async () => {
        fs.mkdirSync(path.join(skillsDir, 'empty-dir'), { recursive: true });
        fs.mkdirSync(path.join(skillsDir, 'dup'), { recursive: true });
        fs.writeFileSync(path.join(skillsDir, 'dup', 'SKILL.md'),
            '---\nname: 文件夹版\ndescription: d\n---\n文件夹正文');
        fs.writeFileSync(path.join(skillsDir, 'dup.md'),
            '---\nid: dup\nname: 平铺版\ndescription: d\n---\n平铺正文');

        const res = await request(makeApp(skillsDir)).get('/api/skills');
        expect(res.body.skills).toHaveLength(1);
        expect(res.body.skills[0]).toMatchObject({ id: 'dup', name: '平铺版' });
    });
});
