/**
 * lumen-canvas.ts 扩展冒烟测试（工具启停联动部分）
 * 直接以 Node 原生 type-stripping 加载 .ts 扩展（与 pi 运行时同机制），
 * mock ExtensionAPI 捕获注册的工具与事件处理器，mock 全局 fetch：
 *   - session_start：上报工具注册表（POST /api/pi/extension-tools），
 *     不含内置工具与 mcp__* 工具；
 *   - 禁用清单应用：getAllTools - disabledTools 经 setActiveTools 生效；
 *   - before_agent_start：重新应用（面板勾选改动下一轮消息生效）。
 *
 * 扩展 import "typebox"（pi 运行时注入的依赖，项目内不可解析），
 * 测试加载前替换成最小 stub（与 lumenSkills.smoke.mjs 同一手法）。
 * node 直跑不入 jest：node test/utils/lumenCanvas.smoke.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const src = fs.readFileSync('pi-extensions/lumen-canvas.ts', 'utf8');
const js = stripTypeScriptTypes(
    src.replace(/from "typebox"/g, 'from "./typebox-stub.mjs"'),
    { mode: 'strip' }
);
const stub = `export const Type = new Proxy({}, { get: () => (..._a) => ({ __type: true }) });`;
const stubUrl = 'data:text/javascript;base64,' + Buffer.from(stub).toString('base64');
const jsPatched = js.replace('from "./typebox-stub.mjs"', `from "${stubUrl}"`);
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(jsPatched, 'utf8').toString('base64');
const { default: factory } = await import(dataUrl);

// ---- mock pi：捕获注册/事件/工具集操作 ----
const CANVAS_TOOLS = ['canvas_get_state', 'canvas_drop_image', 'canvas_clear_media'];
const ALL_TOOLS = [
    ...CANVAS_TOOLS,
    'comfy_mcp_system_stats', 'comfy_mcp_run_workflow',
    'web_search', 'skill_list',
    'read', 'bash', 'powershell', 'edit', 'write',   // 内置：不参与上报（powershell=Windows shell 工具）
    'mcp__foo__bar'                            // MCP 动态工具：不参与上报
];
const handlers = {};
let activeTools = [...ALL_TOOLS];
const setActiveCalls = [];
const posts = [];

global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.endsWith('/api/pi/permission')) {
        return { json: async () => ({ status: 'ok', level: 'full' }) };
    }
    if (u.endsWith('/api/pi/disabled-tools')) {
        return { json: async () => ({ status: 'ok', disabledTools: ['canvas_clear_media', 'comfy_mcp_run_workflow'] }) };
    }
    if (u.endsWith('/api/pi/extension-tools') && options.method === 'POST') {
        posts.push(JSON.parse(options.body));
        return { json: async () => ({ status: 'ok' }) };
    }
    if (u.endsWith('/api/pi/provider-config')) {
        return { json: async () => ({ status: 'error' }) };
    }
    if (u.endsWith('/api/canvas-bridge/command')) {
        return { json: async () => ({ status: 'ok', data: {} }) };
    }
    throw new Error('unexpected fetch: ' + u);
};

const piMock = {
    registerTool: () => {},
    registerProvider: () => {},
    on: (event, handler) => { handlers[event] = handler; },
    getAllTools: () => ALL_TOOLS.map((name) => ({ name, description: 'd ' + name })),
    setActiveTools: (names) => { activeTools = names; setActiveCalls.push([...names]); }
};

await factory(piMock);
assert.ok(handlers.session_start && handlers.before_agent_start, 'session_start / before_agent_start 处理器未注册');

// ---- 启动即应用一次禁用清单 ----
await new Promise((r) => setTimeout(r, 20));
assert.ok(setActiveCalls.length >= 1, '启动时未应用禁用清单');
const applied = setActiveCalls[0];
assert.equal(applied.length, ALL_TOOLS.length - 2, '禁用后工具数不符');
assert.ok(!applied.includes('canvas_clear_media'), '禁用的画布工具仍在激活集');
assert.ok(!applied.includes('comfy_mcp_run_workflow'), '禁用的 comfy 工具仍在激活集');
assert.ok(applied.includes('read') && applied.includes('bash'), '内置工具不应被误移除');

// ---- session_start：上报注册表（不含内置与 mcp__ 工具） ----
await handlers.session_start({}, async () => {});
await new Promise((r) => setTimeout(r, 20));
assert.equal(posts.length, 1, '工具注册表应上报一次');
const reported = posts[0];
assert.equal(reported.extension, 'pi');
assert.equal(reported.tools.length, ALL_TOOLS.length - 6, '上报清单不应含内置与 mcp__ 工具');
assert.ok(!reported.tools.some((t) => ['read', 'bash', 'powershell', 'edit', 'write', 'mcp__foo__bar'].includes(t.name)));
assert.ok(reported.tools.every((t) => t.name && typeof t.description === 'string'));

// ---- before_agent_start：重新应用（面板勾选改动下一轮生效） ----
const before = setActiveCalls.length;
await handlers.before_agent_start({}, async () => {});
await new Promise((r) => setTimeout(r, 20));
assert.ok(setActiveCalls.length > before, '回合开始未重新应用禁用清单');
assert.ok(setActiveCalls.at(-1).every((n) => !['canvas_clear_media', 'comfy_mcp_run_workflow'].includes(n)));

console.log('lumenCanvas.smoke: 工具上报（过滤内置/mcp）/ 禁用清单应用 / 回合开始重应用 — 全部通过');
