/**
 * lumen-guard.ts 扩展的冒烟测试
 * 直接以 Node 原生 type-stripping 加载 .ts 扩展（与 pi 运行时同机制），
 * mock ExtensionAPI 触发 tool_call 处理器，断言各场景的拦截/放行。
 * 运行目录必须是项目根（扩展用 process.cwd() 定位项目边界）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

const run = (toolName, input) => handler({ toolName, input });
const deny = (r) => r && r.block === true;

// edit/write：路径级判断
assert.ok(deny(await run('edit', { path: 'js/app.js' })), 'edit 相对路径项目内应拦截');
assert.ok(deny(await run('edit', { path: 'H:\\lumen-light\\lumen-light\\server.js' })), 'edit 绝对路径项目内应拦截');
assert.ok(deny(await run('write', { path: 'data/settings.json' })), 'write 项目内数据文件应拦截');
assert.ok(deny(await run('edit', { path: '' })), 'edit 无路径 fail-safe 应拦截');
assert.ok(!deny(await run('write', { path: 'data/pi/workspace/t.txt' })), 'write 白名单区应放行');
assert.ok(!deny(await run('edit', { path: 'C:\\Users\\WLDFC\\AppData\\Local\\Temp\\x.js' })), 'edit 系统临时目录应放行');
assert.ok(!deny(await run('edit', { path: 'D:/outside/notes.md' })), 'edit 项目外应放行');

// bash：启发式
assert.ok(deny(await run('bash', { command: 'echo hi > out.txt' })), '重定向到项目根应拦截');
assert.ok(deny(await run('bash', { command: 'echo hi >> server.js' })), '追加写源码应拦截');
assert.ok(deny(await run('bash', { command: 'rm -rf node_modules' })), 'rm 项目内应拦截');
assert.ok(deny(await run('bash', { command: 'sed -i "s/a/b/" server.js' })), 'sed -i 应拦截');
assert.ok(deny(await run('bash', { command: 'Remove-Item server.js' })), 'PowerShell 删除应拦截');
assert.ok(deny(await run('bash', { command: 'echo x | tee log.txt' })), 'tee 项目根应拦截');
assert.ok(deny(await run('bash', { command: 'mv a.js b.js' })), 'mv 项目内应拦截');
assert.ok(!deny(await run('bash', { command: 'echo hi > data/pi/workspace/out.txt' })), '重定向到白名单区应放行');
assert.ok(!deny(await run('bash', { command: 'echo x > $env:TEMP\\a.txt' })), '写 TEMP 应放行');
assert.ok(!deny(await run('bash', { command: 'node --check server.js' })), '语法检查应放行');
assert.ok(!deny(await run('bash', { command: 'npm test' })), 'npm test 应放行');
assert.ok(!deny(await run('bash', { command: 'git status' })), 'git status 应放行');
assert.ok(!deny(await run('bash', { command: 'node tools/agent-upscale.js' })), '运行项目工具脚本应放行');
assert.ok(!deny(await run('bash', { command: 'echo done 2>&1' })), '纯 fd 重定向应放行');

// 只读/桥接工具不受影响
assert.ok(!deny(await run('read', { path: 'server.js' })), 'read 应放行');
assert.ok(!deny(await run('grep', { pattern: 'x' })), 'grep 应放行');
assert.ok(!deny(await run('canvas_get_state', {})), '画布桥接工具应放行');

console.log('lumen-guard 冒烟测试：全部 22 项断言通过');
