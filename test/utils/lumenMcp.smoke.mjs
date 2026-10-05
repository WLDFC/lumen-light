/**
 * lumen-mcp.ts 扩展的冒烟测试（与 lumenGuard.smoke.mjs 同机制）：
 * Node 原生 type-stripping 加载 .ts 扩展，mock pi API 与后端 fetch，
 * 断言工具/资源/提示词元工具的注册、调用代理与去重行为。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

// 扩展源码：剥离 TS 类型；typebox 导入替换为透传桩（数据 URL 环境无法解析包名）
let src = fs.readFileSync('pi-extensions/lumen-mcp.ts', 'utf8');
src = src.replace('import { Type } from "typebox";', 'const Type = { Unsafe: (s) => s };');
src = src.replace('setInterval(() => { void syncTools(); }, 60_000);',
    'globalThis.__lumenMcpPoll = syncTools;');   // 轮询改为手动触发（测试不挂定时器）

const js = stripTypeScriptTypes(src, { mode: 'strip' });
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64');

// ---- mock：pi API 与后端 HTTP ----
const registeredTools = [];
const mockPi = {
    registerTool(tool) { registeredTools.push(tool); }
};

let callPayload = null;
let readPayload = null;
let promptPayload = null;
globalThis.fetch = async (url, options) => {
    const u = String(url);
    if (u.endsWith('/api/mcp/tools')) {
        return {
            json: async () => ({
                status: 'ok',
                tools: [{
                    serverId: 't1',
                    serverName: 'echo 服务器',
                    name: 'echo',
                    description: '回显文本',
                    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
                }],
                resourceServers: [{ serverId: 't1', serverName: 'echo 服务器' }],
                promptServers: [{
                    serverId: 't1',
                    serverName: 'echo 服务器',
                    prompts: [{ name: 'greet', description: '打招呼模板' }]
                }]
            })
        };
    }
    if (u.endsWith('/api/mcp/call')) {
        callPayload = JSON.parse(options.body);
        return { json: async () => ({ status: 'ok', ok: true, text: 'echo:你好', isError: false }) };
    }
    if (u.endsWith('/api/mcp/resources/list')) {
        return { json: async () => ({ status: 'ok', ok: true, resources: [{ uri: 'test://info', name: 'info' }] }) };
    }
    if (u.endsWith('/api/mcp/resources/read')) {
        readPayload = JSON.parse(options.body);
        return { json: async () => ({ status: 'ok', ok: true, text: 'hello-resource' }) };
    }
    if (u.endsWith('/api/mcp/prompt/get')) {
        promptPayload = JSON.parse(options.body);
        return { json: async () => ({ status: 'ok', ok: true, text: 'user: 你好呀' }) };
    }
    throw new Error('意外请求: ' + u);
};

// ---- 加载扩展 ----
const { default: extFactory } = await import(dataUrl);
extFactory(mockPi);

// 首轮 syncTools 是异步的：让出微任务队列后断言
await new Promise((r) => setImmediate(r));

// 工具 + 资源两件套 + 提示词 = 4 个
assert.equal(registeredTools.length, 4, '应注册 4 个工具');
const byName = Object.fromEntries(registeredTools.map((t) => [t.name, t]));
assert.ok(byName['mcp__echo__echo'], 'echo 工具已注册');
assert.ok(byName['mcp__echo__list_resources'], 'list_resources 元工具已注册');
assert.ok(byName['mcp__echo__read_resource'], 'read_resource 元工具已注册');
assert.ok(byName['mcp__echo__get_prompt'], 'get_prompt 元工具已注册');
assert.match(byName['mcp__echo__get_prompt'].description, /greet/);

// ---- echo 工具调用代理 ----
const echoResult = await byName['mcp__echo__echo'].execute(
    'call-1', { text: '你好' }, new AbortController().signal, () => {}, {});
assert.equal(callPayload.serverId, 't1');
assert.deepEqual(callPayload.args, { text: '你好' });
assert.equal(echoResult.content[0].text, 'echo:你好');

// ---- 资源元工具 ----
const listResult = await byName['mcp__echo__list_resources'].execute(
    'call-2', {}, new AbortController().signal, () => {}, {});
assert.match(listResult.content[0].text, /test:\/\/info/);
const readResult = await byName['mcp__echo__read_resource'].execute(
    'call-3', { uri: 'test://info' }, new AbortController().signal, () => {}, {});
assert.equal(readPayload.uri, 'test://info');
assert.equal(readResult.content[0].text, 'hello-resource');

// ---- 提示词元工具 ----
const promptResult = await byName['mcp__echo__get_prompt'].execute(
    'call-4', { name: 'greet', args: {} }, new AbortController().signal, () => {}, {});
assert.equal(promptPayload.name, 'greet');
assert.equal(promptResult.content[0].text, 'user: 你好呀');

// ---- 轮询不重复注册 ----
await globalThis.__lumenMcpPoll();
assert.equal(registeredTools.length, 4, '同一工具不应重复注册');

console.log('lumen-mcp 冒烟测试通过：4 个工具注册、三类代理调用与去重均符合预期');
