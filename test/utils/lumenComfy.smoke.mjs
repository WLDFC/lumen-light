/**
 * lumen-comfy.ts 扩展的冒烟测试
 * 直接以 Node 原生 type-stripping 加载 .ts 扩展（与 pi 运行时同机制），
 * mock ExtensionAPI 捕获注册的工具并直调 execute；mock 全局 fetch 拦截
 * 对后端 /api/comfy-tools 的调用。
 *
 * 扩展 import "typebox"（pi 运行时注入的依赖，项目内不可解析），
 * 测试加载前替换成最小 stub（与 lumenSkills.smoke.mjs 同一手法）。
 * node 直跑不入 jest：node test/utils/lumenComfy.smoke.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const src = fs.readFileSync('pi-extensions/lumen-comfy.ts', 'utf8');
const js = stripTypeScriptTypes(
    src.replace(/from "typebox"/g, 'from "./typebox-stub.mjs"'),
    { mode: 'strip' }
);
const stub = `export const Type = new Proxy({}, { get: () => (..._a) => ({ __type: true }) });`;
const stubUrl = 'data:text/javascript;base64,' + Buffer.from(stub).toString('base64');
const jsPatched = js.replace('from "./typebox-stub.mjs"', `from "${stubUrl}"`);
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(jsPatched, 'utf8').toString('base64');
const { default: factory } = await import(dataUrl);

// ---- mock pi：捕获工具注册与 tool_call 处理器 ----
const tools = {};
let toolCallHandler = null;
factory({
    registerTool: (t) => { tools[t.name] = t; },
    on: (event, handler) => { if (event === 'tool_call') toolCallHandler = handler; },
    registerProvider: () => {}
});

// ---- 18 个工具全部注册，且命名带 comfy_mcp_ 前缀（与上游 comfy-mcp 对照） ----
const EXPECTED = [
    'comfy_mcp_system_stats', 'comfy_mcp_free_memory', 'comfy_mcp_job',
    'comfy_mcp_fetch_outputs', 'comfy_mcp_run_workflow', 'comfy_mcp_list_workflow_slots',
    'comfy_mcp_set_workflow_slot', 'comfy_mcp_search_templates', 'comfy_mcp_fetch_template',
    'comfy_mcp_run_template', 'comfy_mcp_nodes', 'comfy_mcp_search_models',
    'comfy_mcp_download_model', 'comfy_mcp_download', 'comfy_mcp_upload_file',
    'comfy_mcp_install_node', 'comfy_mcp_workflow_deps', 'comfy_mcp_get_logs'
];
for (const name of EXPECTED) {
    assert.ok(tools[name], `工具 ${name} 未注册`);
}
assert.equal(Object.keys(tools).length, EXPECTED.length, '注册的工具数量与预期不符');

// ---- 结果契约：{ content: [{ type: "text", text }] } ----
const txt = (r) => {
    assert.ok(r && Array.isArray(r.content) && r.content[0]?.type === 'text',
        '工具返回必须含 content[0].text 包装');
    return r.content[0].text;
};

// ---- mock fetch：后端 permission 与 comfy-tools 端点 ----
let permissionLevel = 'full';
const toolCalls = [];
global.fetch = async (url, options) => {
    const u = String(url);
    if (u.endsWith('/api/pi/permission')) {
        return { ok: true, json: async () => ({ status: 'ok', level: permissionLevel }) };
    }
    if (u.includes('/api/comfy-tools')) {
        toolCalls.push({ url: u, options });
        return {
            ok: true,
            json: async () => ({ status: 'ok', data: { echoPath: u.split('/api/comfy-tools')[1], body: options?.body ? JSON.parse(options.body) : null } })
        };
    }
    throw new Error('unexpected fetch: ' + u);
};

// ---- system_stats：GET 端点 + 契约包装 ----
{
    const r = await tools.comfy_mcp_system_stats.execute('t1', {});
    const s = txt(r);
    assert.ok(s.includes('/system-stats'), 'system_stats 应调用对应端点');
}

// ---- job：POST 透传参数 ----
{
    const r = await tools.comfy_mcp_job.execute('t2', { action: 'cancel', prompt_id: 'p-1' });
    const s = txt(r);
    assert.ok(s.includes('/job'), 'job 应调用对应端点');
    assert.ok(s.includes('"prompt_id": "p-1"'), 'job 应透传 prompt_id');
}

// ---- run_workflow：长超时端点路径正确 ----
{
    const r = await tools.comfy_mcp_run_workflow.execute('t3', { workflow_path: 'D:/wf.json' });
    const s = txt(r);
    assert.ok(s.includes('/run-workflow'), 'run_workflow 应调用对应端点');
    assert.ok(s.includes('wf.json'), 'run_workflow 应透传路径');
}

// ---- get_logs：tail 进查询串 ----
{
    const r = await tools.comfy_mcp_get_logs.execute('t4', { tail: 5 });
    assert.ok(txt(r).includes('tail=5'), 'get_logs 应把 tail 放进查询串');
}

// ---- 后端报错时抛出（message 透传） ----
global.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/api/pi/permission')) {
        return { ok: true, json: async () => ({ status: 'ok', level: 'full' }) };
    }
    return { ok: false, status: 500, json: async () => ({ status: 'error', message: 'ComfyUI 未在线' }) };
};
await assert.rejects(
    () => tools.comfy_mcp_system_stats.execute('t5', {}),
    /ComfyUI 未在线/,
    '后端错误信息应透传为工具异常'
);

// ---- 权限分级拦截 ----
// 恢复正常 mock
global.fetch = async (url, options) => {
    const u = String(url);
    if (u.endsWith('/api/pi/permission')) {
        return { ok: true, json: async () => ({ status: 'ok', level: permissionLevel }) };
    }
    return { ok: true, json: async () => ({ status: 'ok', data: {} }) };
};

// 只读分级：查询类放行、变更类阻止
permissionLevel = 'readonly';
assert.equal(await toolCallHandler({ toolName: 'comfy_mcp_system_stats' }), undefined, '只读分级应放行查询工具');
{
    const verdict = await toolCallHandler({ toolName: 'comfy_mcp_free_memory' });
    assert.ok(verdict?.block, '只读分级应阻止 free_memory');
}

// 标准分级：install_node 阻止（运行第三方代码需完整分级）
permissionLevel = 'standard';
assert.equal(await toolCallHandler({ toolName: 'comfy_mcp_run_workflow' }), undefined, '标准分级应放行 run_workflow');
{
    const verdict = await toolCallHandler({ toolName: 'comfy_mcp_install_node' });
    assert.ok(verdict?.block, '标准分级应阻止 install_node');
}

// 完整分级：全部放行
permissionLevel = 'full';
assert.equal(await toolCallHandler({ toolName: 'comfy_mcp_install_node' }), undefined, '完整分级应放行 install_node');

// 非本扩展工具不干预
permissionLevel = 'readonly';
assert.equal(await toolCallHandler({ toolName: 'canvas_get_state' }), undefined, '非 comfy_mcp 工具不应被本扩展的处理器拦截');

console.log('lumenComfy.smoke: 18 工具注册 / 契约包装 / 端点路由 / 错误透传 / 三级权限拦截 — 全部通过');
