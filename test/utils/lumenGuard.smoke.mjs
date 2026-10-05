/**
 * lumen-guard.ts 扩展的冒烟测试
 * 直接以 Node 原生 type-stripping 加载 .ts 扩展（与 pi 运行时同机制），
 * mock ExtensionAPI 触发 tool_call 处理器，断言各场景的拦截/放行。
 * 运行目录必须是项目根（扩展用 process.cwd() 定位项目边界）。
 *
 * 分级/规则表/日志用例通过 LUMEN_GUARD_DATA_DIR 把数据目录重定向到
 * 系统临时目录（真实 data/pi/settings.json 的分级由用户设置决定，
 * 不能作为断言依据）；守卫每次工具调用现读配置，改文件即生效。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

// 项目 package.json 无 "type": "module"，.ts 直接 import 会被当 CJS 解析。
// 与 pi 的加载行为无关（pi 自带扩展加载器），此处先剥离类型再经 data: URL
// 以 ESM 加载，保证测试环境与扩展源码解耦。
const src = fs.readFileSync('pi-extensions/lumen-guard.ts', 'utf8');
const js = stripTypeScriptTypes(src, { mode: 'strip' });
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64');
const { default: guardFactory } = await import(dataUrl);

let handler = null;
const mockPi = { on: (ev, fn) => { if (ev === 'tool_call') handler = fn; } };
guardFactory(mockPi);
assert.ok(handler, 'tool_call 处理器未注册');

// 测试专用数据目录：分级（settings.json）、规则表（guard.json）、日志
// （agent.log）全部落在这里，与真实 data/pi 完全隔离
const dataTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-guard-test-'));
process.env.LUMEN_GUARD_DATA_DIR = dataTmp;
const setLevel = (level) =>
    fs.writeFileSync(path.join(dataTmp, 'settings.json'), JSON.stringify({ permissionLevel: level }));
const setGuard = (cfg) =>
    fs.writeFileSync(path.join(dataTmp, 'guard.json'), JSON.stringify(cfg));

const run = (toolName, input) => handler({ toolName, input });
const deny = (r) => r && r.block === true;

// ==================== standard 级（默认白名单语义，与历史行为一致） ====================
setLevel('standard');
fs.rmSync(path.join(dataTmp, 'guard.json'), { force: true });   // 验证缺省自动生成

// edit/write：路径级判断
assert.ok(deny(await run('edit', { path: 'js/app.js' })), 'edit 相对路径项目内应拦截');
assert.ok(deny(await run('edit', { path: 'H:\\lumen-light\\lumen-light\\server.js' })), 'edit 绝对路径项目内应拦截');
assert.ok(deny(await run('write', { path: 'data/settings.json' })), 'write 项目内数据文件应拦截');
assert.ok(deny(await run('edit', { path: '' })), 'edit 无路径 fail-safe 应拦截');
assert.ok(!deny(await run('write', { path: 'data/pi/workspace/t.txt' })), 'write 白名单区应放行');
assert.ok(!deny(await run('write', { path: 'data/pi/skills/my-skill.md' })), 'write pi 技能库应放行');
assert.ok(!deny(await run('write', { path: 'data/skills/my-skill.md' })), 'write 技能白名单区应放行');
assert.ok(deny(await run('write', { path: 'data/skills_backup/x.md' })), 'write 相似前缀目录应拦截');
assert.ok(deny(await run('write', { path: 'data/prompts.json' })), 'write 技能目录外的 data 文件应拦截');
assert.ok(!deny(await run('edit', { path: 'C:\\Users\\WLDFC\\AppData\\Local\\Temp\\x.js' })), 'edit 系统临时目录应放行');
assert.ok(!deny(await run('edit', { path: 'D:/outside/notes.md' })), 'edit 项目外应放行');

// guard.json 缺省自动生成（自述文档），内容含默认白名单
assert.ok(fs.existsSync(path.join(dataTmp, 'guard.json')), 'guard.json 缺失应自动生成');
assert.ok(fs.readFileSync(path.join(dataTmp, 'guard.json'), 'utf-8').includes('data/skills'),
    '自动生成的 guard.json 应含默认白名单');

// bash：启发式
assert.ok(deny(await run('bash', { command: 'echo hi > out.txt' })), '重定向到项目根应拦截');
assert.ok(deny(await run('bash', { command: 'echo hi >> server.js' })), '追加写源码应拦截');
assert.ok(deny(await run('bash', { command: 'rm -rf node_modules' })), 'rm 项目内应拦截');
assert.ok(deny(await run('bash', { command: 'sed -i "s/a/b/" server.js' })), 'sed -i 应拦截');
assert.ok(deny(await run('bash', { command: 'Remove-Item server.js' })), 'PowerShell 删除应拦截');
assert.ok(deny(await run('bash', { command: 'echo x | tee log.txt' })), 'tee 项目根应拦截');
assert.ok(deny(await run('bash', { command: 'mv a.js b.js' })), 'mv 项目内应拦截');
assert.ok(!deny(await run('bash', { command: 'echo hi > data/pi/workspace/out.txt' })), '重定向到白名单区应放行');
assert.ok(!deny(await run('bash', { command: 'cp tools/x.md data/skills/x.md' })), '复制技能文件到白名单区应放行');
assert.ok(!deny(await run('bash', { command: 'echo x > $env:TEMP\\a.txt' })), '写 TEMP 应放行');
assert.ok(!deny(await run('bash', { command: 'node --check server.js' })), '语法检查应放行');
assert.ok(!deny(await run('bash', { command: 'npm test' })), 'npm test 应放行');
assert.ok(!deny(await run('bash', { command: 'git status' })), 'git status 应放行');
assert.ok(!deny(await run('bash', { command: 'node tools/agent-upscale.js' })), '运行项目工具脚本应放行');
assert.ok(!deny(await run('bash', { command: 'echo done 2>&1' })), '纯 fd 重定向应放行');

// 拦截日志：standard 级已产生多次拦截，agent.log 应有 [guard] 行
const logText = fs.existsSync(path.join(dataTmp, 'agent.log'))
    ? fs.readFileSync(path.join(dataTmp, 'agent.log'), 'utf-8') : '';
assert.ok(logText.includes('[guard] deny edit'), '拦截应写入 agent.log（[guard] deny）');

// ==================== 声明式规则表：自定义白名单 ====================
setLevel('standard');
setGuard({ whitelistDirs: ['temp_custom'] });   // writePatterns 省略 → 回退默认特征词
assert.ok(!deny(await run('write', { path: 'temp_custom/x.txt' })), '自定义白名单目录应放行');
assert.ok(deny(await run('write', { path: 'data/pi/workspace/t.txt' })), '自定义规则后默认白名单应失效');
assert.ok(deny(await run('bash', { command: 'echo hi > out.txt' })), '省略 writePatterns 应回退默认特征词');
assert.ok(!deny(await run('bash', { command: 'echo hi > temp_custom/out.txt' })), 'bash 重定向到自定义白名单应放行');
setGuard({ whitelistDirs: ['data/pi/workspace', 'data/skills', 'data/pi/skills'] });   // 恢复默认语义

// ==================== readonly 级：项目内一律禁写（含白名单区） ====================
setLevel('readonly');
assert.ok(deny(await run('write', { path: 'data/pi/workspace/t.txt' })), '只读级白名单区也应拦截');
assert.ok(deny(await run('write', { path: 'data/skills/s.md' })), '只读级技能目录应拦截');
assert.ok(deny(await run('edit', { path: 'js/app.js' })), '只读级源码应拦截');
assert.ok(!deny(await run('write', { path: 'D:/outside/notes.md' })), '只读级项目外应放行');
assert.ok(deny(await run('bash', { command: 'echo hi > data/pi/workspace/out.txt' })), '只读级 bash 写白名单区应拦截');
assert.ok(!deny(await run('bash', { command: 'echo done 2>&1' })), '只读级纯 fd 重定向应放行');

// ==================== full 级：白名单 + 画布内容区，源码/配置任何分级禁写 ====================
setLevel('full');
assert.ok(deny(await run('write', { path: 'js/app.js' })), '完整级源码仍应拦截');
assert.ok(deny(await run('write', { path: 'server.js' })), '完整级根级文件仍应拦截');
assert.ok(deny(await run('write', { path: 'data/settings.json' })), '完整级应用配置仍应拦截');
assert.ok(deny(await run('write', { path: 'data/pi/guard.json' })), '完整级守卫自身配置仍应拦截');
assert.ok(!deny(await run('write', { path: 'data/pi/workspace/t.txt' })), '完整级白名单区应放行');
assert.ok(!deny(await run('write', { path: 'save/x.png' })), '完整级内容区 save 应放行');
assert.ok(!deny(await run('write', { path: 'tag/meta.json' })), '完整级内容区 tag 应放行');
assert.ok(!deny(await run('write', { path: 'temp_upscale/x.png' })), '完整级内容区 temp_upscale 应放行');
assert.ok(!deny(await run('write', { path: 'data/videos/v.mp4' })), '完整级内容区 data/videos 应放行');
assert.ok(deny(await run('bash', { command: 'echo hi > out.txt' })), '完整级 bash 写项目根仍应拦截');
assert.ok(deny(await run('bash', { command: 'rm -rf node_modules' })), '完整级 rm 源码目录仍应拦截');
assert.ok(!deny(await run('bash', { command: 'echo hi > save/out.txt' })), '完整级 bash 写内容区应放行');
assert.ok(!deny(await run('bash', { command: 'echo hi > temp_upscale/a.txt' })), '完整级 bash 写临时放大区应放行');

// ==================== 配置清洗：白名单指向受保护目录会被丢弃 ====================
setLevel('standard');
setGuard({ whitelistDirs: ['js', 'data/pi/workspace', 'data/skills'] });
assert.ok(deny(await run('write', { path: 'js/x.js' })), '白名单指向源码目录应被清洗（仍拦截）');
assert.ok(!deny(await run('write', { path: 'data/pi/workspace/t.txt' })), '合法白名单条目不受清洗影响');
setGuard({ whitelistDirs: ['data/pi/workspace', 'data/skills', 'data/pi/skills'] });   // 恢复默认语义

// ==================== settings.json 缺失/非法 → fail-safe 按 standard ====================
fs.rmSync(path.join(dataTmp, 'settings.json'), { force: true });
assert.ok(deny(await run('write', { path: 'js/app.js' })), '分级文件缺失应按 standard 拦截源码');
assert.ok(!deny(await run('write', { path: 'data/pi/workspace/t.txt' })), '分级文件缺失应按 standard 放行白名单');
fs.writeFileSync(path.join(dataTmp, 'settings.json'), '{broken');
assert.ok(deny(await run('write', { path: 'js/app.js' })), '分级文件损坏应按 standard 拦截源码');

// ==================== 只读/桥接工具不受影响 ====================
assert.ok(!deny(await run('read', { path: 'server.js' })), 'read 应放行');
assert.ok(!deny(await run('grep', { pattern: 'x' })), 'grep 应放行');
assert.ok(!deny(await run('canvas_get_state', {})), '画布桥接工具应放行');

fs.rmSync(dataTmp, { recursive: true, force: true });
console.log('lumen-guard 冒烟测试：全部 61 项断言通过');
