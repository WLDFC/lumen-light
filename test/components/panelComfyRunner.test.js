/**
 * PanelComfyRunner 测试（2026-11-12 逐格生成配套）
 * 覆盖：_buildOverrides 覆盖表组装（面板参数行编译 + latentSize 一次性
 * 覆写合并——漫画逐格生成每格尺寸不同，不动面板行状态）；run(runOpts)
 * count 强制与 latentSize 随提交体下发（面板按钮常规路径不传 runOpts
 * 时行为不变：count 走面板批量值、overrides 即编译表原样）
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: { addEventListener: () => { } } };
context.setTimeout = setTimeout;
context.clearTimeout = clearTimeout;
vm.createContext(context);
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/components/PanelComfyRunner.js'), 'utf-8'),
    context, { filename: 'PanelComfyRunner.js' });
const PanelComfyRunner = context.window.PanelComfyRunner;

/** 造 runner + 环境桩；返回 { runner, calls }（calls.fetchBodies 按 run 收集） */
function makeRunner(over = {}) {
    const calls = { fetchBodies: [], statuses: [] };
    context.window.taskRegistry = over.taskRegistry === undefined ? {
        register: () => ({
            update: () => { }, end: () => { }, isRunning: () => true
        })
    } : over.taskRegistry;
    context.fetch = async (url, opts) => {
        calls.fetchBodies.push(JSON.parse(opts.body));
        return { ok: true, json: async () => ({ status: 'ok', promptId: 'pid-' + calls.fetchBodies.length }) };
    };
    const runner = new PanelComfyRunner({
        getPrompts: () => ({ positive: '测试正向', negative: '测试负面' }),
        getWorkflowId: () => 'wf1',
        getOverrides: () => over.overrides || { 7: { steps: 20 } },
        getLatentSizeTargets: () => over.sizeTargets !== undefined
            ? over.sizeTargets
            : [{ nodeId: 5, width: 512, height: 512 }],
        getBatchCount: () => over.batchCount !== undefined ? over.batchCount : 1,
        updateWorkflowStatus: (m, e) => calls.statuses.push({ m, e }),
        uploadThumbnails: async () => { }
    });
    runner.button = { textContent: '发送', disabled: false, style: {} };
    return { runner, calls };
}

describe('PanelComfyRunner._buildOverrides 覆盖表组装', () => {
    test('latentSize 覆写叠加在编译表之上：patch 全部探测到的尺寸节点', () => {
        const { runner } = makeRunner();
        const out = runner._buildOverrides({ latentSize: { width: 768, height: 768 } });
        expect(out[7]).toEqual({ steps: 20 });            // 面板行编译原样
        expect(out[5]).toEqual({ width: 768, height: 768 });   // 尺寸覆写
    });

    test('同节点既有编译条目：合并不覆盖（尺寸键新增、其余键保留）', () => {
        const { runner } = makeRunner({ overrides: { 5: { cfg: 4.5 } } });
        const out = runner._buildOverrides({ latentSize: { width: 640, height: 896 } });
        expect(out[5]).toEqual({ cfg: 4.5, width: 640, height: 896 });
    });

    test('未传 latentSize：编译表原样（面板按钮常规路径）', () => {
        const { runner } = makeRunner();
        expect(runner._buildOverrides(null)).toEqual({ 7: { steps: 20 } });
        expect(runner._buildOverrides({})).toEqual({ 7: { steps: 20 } });
    });

    test('未探测到尺寸节点：latentSize 忽略（按模板现值出图）', () => {
        const { runner } = makeRunner({ sizeTargets: [] });
        const out = runner._buildOverrides({ latentSize: { width: 768, height: 768 } });
        expect(out).toEqual({ 7: { steps: 20 } });
    });
});

describe('PanelComfyRunner.run(runOpts) count 强制与 latentSize 下发', () => {
    test('run({latentSize, count:1})：提交体带覆写后的 overrides，仅 1 个任务', async () => {
        const { runner, calls } = makeRunner({ batchCount: 4 });
        await runner.run({ latentSize: { width: 768, height: 768 }, count: 1 });
        expect(calls.fetchBodies).toHaveLength(1);        // count 强制压过面板批量值
        expect(calls.fetchBodies[0].overrides[5]).toEqual({ width: 768, height: 768 });
        expect(calls.fetchBodies[0].positive).toBe('测试正向');
    });

    test('不传 runOpts：count 走面板批量值，overrides 即编译表原样', async () => {
        const { runner, calls } = makeRunner({ batchCount: 3 });
        await runner.run();
        expect(calls.fetchBodies).toHaveLength(3);
        expect(calls.fetchBodies[0].overrides).toEqual({ 7: { steps: 20 } });
    });

    test('提交失败：不抛错（自吞反馈），状态栏报错', async () => {
        const { runner, calls } = makeRunner();
        const saved = context.fetch;
        context.fetch = async () => ({ ok: false, json: async () => ({ status: 'error', message: '炸了' }) });
        try {
            await expect(runner.run({ count: 1 })).resolves.toBeUndefined();
            expect(calls.statuses.some((s) => s.e && s.m.includes('炸了'))).toBe(true);
        } finally {
            context.fetch = saved;
        }
    });
});
