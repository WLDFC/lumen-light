/**
 * lumen-skills.ts 扩展的冒烟测试
 * 直接以 Node 原生 type-stripping 加载 .ts 扩展（与 pi 运行时同机制），
 * mock ExtensionAPI 捕获 registerTool 注册的工具并直调 execute。
 *
 * 扩展 import "typebox"（pi 运行时注入的依赖，项目内不可解析），
 * 测试加载前把它替换成最小 stub——本扩展只在 registerTool 的
 * parameters 声明处用到 Type，execute 不依赖其语义。
 *
 * 技能目录经 LUMEN_SKILLS_DIR 重定向到临时目录（与真实 data/pi/skills 隔离）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const src = fs.readFileSync('pi-extensions/lumen-skills.ts', 'utf8');
const js = stripTypeScriptTypes(
    src.replace(/from "typebox"/g, 'from "./typebox-stub.mjs"'),
    { mode: 'strip' }
);
// data: URL 无法相对导入，stub 内联成 base64 模块再绝对导入
const stub = `export const Type = new Proxy({}, { get: () => (..._a) => ({ __type: true }) });`;
const stubUrl = 'data:text/javascript;base64,' + Buffer.from(stub).toString('base64');
const jsPatched = js.replace('from "./typebox-stub.mjs"', `from "${stubUrl}"`);
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(jsPatched, 'utf8').toString('base64');
const { default: factory } = await import(dataUrl);

// ---- mock pi：捕获注册的工具 ----
const tools = {};
factory({ registerTool: (t) => { tools[t.name] = t; } });
assert.ok(tools.skill_list && tools.skill_load, 'skill_list / skill_load 未注册');

// ---- 准备临时技能库 ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-skills-test-'));
process.env.LUMEN_SKILLS_DIR = dir;
const write = (name, content) => fs.writeFileSync(path.join(dir, name), content);
const SKILL = `---\nid: demo-skill\nname: 演示技能\ndescription: 用于冒烟测试的技能\n---\n第一步：做 X。\n第二步：做 Y。`;
write('demo-skill.md', SKILL);
// 非法文件：id 与文件名不一致 / 缺 description / 非 frontmatter
write('bad-name.md', '---\nid: other-id\nname: 坏命名\ndescription: x\n---\n正文');
write('no-desc.md', '---\nid: no-desc\nname: 缺描述\n---\n正文');
write('plain.md', '没有 frontmatter 的普通文件');

const NL = String.fromCharCode(10);

/** 工具 execute 返回的正确契约与 lumen-canvas/lumen-mcp 一致：
 *  { content: [{ type: "text", text }] }——pi 按 content 字段解析，
 *  缺该包装会被解析为空输出（历史上 skill_list 因此对 pi 不可见） */
const txt = (r) => {
    assert.ok(r && Array.isArray(r.content) && r.content[0]?.type === 'text',
        '工具返回必须含 content[0].text 包装');
    return r.content[0].text;
};

// ---- skill_list：只列合法技能，非法文件静默忽略 ----
{
    const r = await tools.skill_list.execute('t1', {});
    const s = txt(r);
    assert.ok(s.includes('demo-skill'), 'skill_list 应列出合法技能');
    assert.ok(s.includes('用于冒烟测试的技能'), 'skill_list 应含描述');
    assert.ok(!s.includes('bad-name') && !s.includes('no-desc') && !s.includes('plain'),
        '非法技能文件应被忽略');
    assert.ok(s.includes('skill_load'), 'skill_list 应引导用 skill_load 加载');
}

// ---- skill_load：返回名称 + 完整正文 ----
{
    const r = await tools.skill_load.execute('t2', { id: 'demo-skill' });
    const s = txt(r);
    assert.ok(s.includes('【技能：演示技能】'), 'skill_load 应含技能名');
    assert.ok(s.includes('第二步：做 Y。'), 'skill_load 应含完整正文');
}

// ---- 异常路径 ----
await assert.rejects(() => tools.skill_load.execute('t3', { id: 'missing' }), /不存在/, '不存在的技能应报错');
await assert.rejects(() => tools.skill_load.execute('t4', { id: '../escape' }), /非法/, '路径穿越 id 应报错');

// ---- 面板禁用联动：data/pi/settings.json 的 disabledSkills（每次调用现读） ----
{
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-skills-disabled-'));
    const skills2 = path.join(root2, 'skills');
    fs.mkdirSync(skills2, { recursive: true });
    process.env.LUMEN_SKILLS_DIR = skills2;
    fs.writeFileSync(path.join(skills2, 'demo-skill.md'), SKILL);
    const settingsFile = path.join(root2, 'settings.json');
    const setDisabled = (list) =>
        fs.writeFileSync(settingsFile, JSON.stringify({ permissionLevel: 'standard', disabledSkills: list }));

    setDisabled(['demo-skill']);
    {
        const s = txt(await tools.skill_list.execute('t6', {}));
        assert.ok(!s.includes('demo-skill'), '禁用后 skill_list 不应列出该技能');
        assert.ok(s.includes('已在面板禁用'), 'skill_list 应提示存在被禁用的技能');
    }
    await assert.rejects(() => tools.skill_load.execute('t7', { id: 'demo-skill' }), /面板禁用/,
        '禁用后 skill_load 应拒绝并说明');
    // 空库 + 全部禁用：提示里应体现禁用数而非普通空库文案
    {
        const s = txt(await tools.skill_list.execute('t8', {}));
        assert.ok(s.includes('技能库为空') && s.includes('1 个技能已在面板禁用'),
            '全部禁用时返回带禁用数的空库提示');
    }

    setDisabled([]);   // 重新勾选启用：立即可见可加载
    {
        const s = txt(await tools.skill_list.execute('t9', {}));
        assert.ok(s.includes('demo-skill'), '重新启用后 skill_list 应恢复列出');
        const r = txt(await tools.skill_load.execute('t10', { id: 'demo-skill' }));
        assert.ok(r.includes('第二步：做 Y。'), '重新启用后 skill_load 应恢复加载');
    }

    // settings.json 缺失/损坏：视为全部启用，不抛错
    fs.unlinkSync(settingsFile);
    {
        const s = txt(await tools.skill_list.execute('t11', {}));
        assert.ok(s.includes('demo-skill'), '状态文件缺失时所有技能应恢复可见');
    }
    fs.rmSync(root2, { recursive: true, force: true });
    process.env.LUMEN_SKILLS_DIR = dir;
}

// ---- 文件夹形态（Anthropic Agent Skills 标准）----
{
    const root3 = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-skills-folder-'));
    const skills3 = path.join(root3, 'skills');
    const skillDir = path.join(skills3, 'folder-skill');
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'),
        '---\nname: 文件夹技能\ndescription: 用于冒烟测试\n---\n文件夹正文。');
    fs.writeFileSync(path.join(skillDir, 'scripts', 'run.py'), 'print(1)');
    // frontmatter id 与文件夹名不一致 → 忽略
    const badDir = path.join(skills3, 'bad-folder');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'SKILL.md'),
        '---\nid: other\nname: n\ndescription: d\n---\n正文');
    process.env.LUMEN_SKILLS_DIR = skills3;

    {
        const s = txt(await tools.skill_list.execute('t12', {}));
        assert.ok(s.includes('folder-skill') && s.includes('文件夹技能'),
            'skill_list 应列出文件夹形态技能');
        assert.ok(!s.includes('bad-folder'), 'id 与文件夹名不一致的文件夹应被忽略');
    }
    {
        const s = txt(await tools.skill_load.execute('t13', { id: 'folder-skill' }));
        assert.ok(s.includes('文件夹正文。'), 'skill_load 应返回 SKILL.md 正文');
        assert.ok(s.includes('scripts'), 'skill_load 应提示辅助文件路径（渐进式披露）');
    }
    // 文件夹形态同样受面板禁用控制
    fs.writeFileSync(path.join(root3, 'settings.json'),
        JSON.stringify({ disabledSkills: ['folder-skill'] }));
    await assert.rejects(() => tools.skill_load.execute('t14', { id: 'folder-skill' }), /面板禁用/,
        '文件夹形态技能禁用后 skill_load 应拒绝');

    fs.rmSync(root3, { recursive: true, force: true });
    process.env.LUMEN_SKILLS_DIR = dir;
}

{
    // 空目录：skill_list 返回空库提示而非抛错
    process.env.LUMEN_SKILLS_DIR = path.join(dir, 'not-exist');
    const r = await tools.skill_list.execute('t5', {});
    assert.ok(txt(r).includes('技能库为空'), '目录缺失应返回空库提示');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('lumen-skills 冒烟测试：全部断言通过（含面板禁用联动 + 文件夹形态）');
