/**
 * ==========================================================================
 * 尺寸行「预设」下拉测试（2026-11-16 用户需求：Comfy 面板尺寸右侧快速
 * 加载预设尺寸，迁移漫画编辑器画幅预设交互）
 * 覆盖：
 *  - ComfyParamRows：sizePresets 选项开/关的渲染差异（面板开、画布节点
 *    默认关）、选中预设写状态/回填输入框/复位占位；
 *  - RunningHubParamRows：尺寸合并行附预设下拉，选中即写入宽高两键；
 *    只登记 width 单参时回退单行、无预设钮。
 * 被测文件是浏览器端经典脚本，vm 加载；CoordinateLayout 装真件（验证与
 * 漫画/坐标编辑器共享清单同源），ComfyParamScanner 桩掉（render 只消费
 * scan 结果字段）；容器用手写桩收集 innerHTML 与按选择器返回控件桩。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '../..');
const context = { window: {} };
context.LumenLight = { escapeHtml: (s) => String(s) };
context.localStorage = { getItem: () => null, setItem: () => { } };
vm.createContext(context);
vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'js/utils/CoordinateLayout.js'), 'utf-8'),
    context, { filename: 'CoordinateLayout.js' });
vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'js/components/ComfyParamRows.js'), 'utf-8'),
    context, { filename: 'ComfyParamRows.js' });
vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'js/components/comfy-param-rows/ComfyLoraStack.js'), 'utf-8'),
    context, { filename: 'ComfyLoraStack.js' });
vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'js/components/RunningHubParamRows.js'), 'utf-8'),
    context, { filename: 'RunningHubParamRows.js' });
const ComfyParamRows = context.window.ComfyParamRows;
const RunningHubParamRows = context.window.RunningHubParamRows;
const CL = context.window.CoordinateLayout;
const PRESETS = CL.COMFY_PRESET_SIZES;   // Comfy 链路八档（共享五档 + 追加三档）

/** 可挂事件桩：addEventListener 收进 handlers，测试直接调 handlers.change() */
function stubControl() {
    return { value: '', handlers: {}, addEventListener(t, fn) { this.handlers[t] = fn; } };
}

/** 带输入桩的控件（dataset 供 data-key 读取） */
function stubInput(key) {
    return Object.assign(stubControl(), { dataset: key ? { key } : {} });
}

/**
 * ComfyParamRows 容器桩：收集 innerHTML；querySelector 按映射表返回
 * 指定控件桩（缺省 null）；querySelectorAll 恒空数组（无 lora 行/步数行）
 */
function makeComfyContainer(queryMap = {}) {
    return {
        innerHTML: '',
        querySelector: (sel) => (sel in queryMap ? queryMap[sel] : null),
        querySelectorAll: () => []
    };
}

/** 造 ComfyParamRows 实例并跑一轮 render（sizeTargets 一档，其余空） */
function makeComfyRows({ sizePresets } = {}) {
    const width = stubInput();
    const height = stubInput();
    const preset = stubControl();
    const container = makeComfyContainer({
        '.comfy-width-input': width,
        '.comfy-height-input': height,
        '.comfy-size-preset': preset
    });
    const inst = new ComfyParamRows(container, sizePresets ? { sizePresets: true } : {});
    context.ComfyParamScanner = {
        scan: () => ({
            loaders: [], stepsTargets: [], cfgTargets: [], samplerTargets: [],
            denoiseTargets: [], batchTargets: [],
            sizeTargets: [{ nodeId: '5', width: 512, height: 512 }]
        })
    };
    inst.setWorkflow('{}');
    return { inst, width, height, preset };
}

/** RunningHub 容器桩：'.rh-param-input' 与 '.comfy-size-row .rh-param-input' 返回行内输入桩 */
function makeRhContainer() {
    const width = stubInput('9:width');
    const height = stubInput('9:height');
    const preset = stubControl();
    const pair = [width, height];
    return {
        width, height, preset,
        container: {
            innerHTML: '',
            querySelector: (sel) => (sel === '.comfy-size-preset' ? preset : null),
            querySelectorAll: (sel) => (sel.includes('rh-param-input') ? pair : [])
        }
    };
}

describe('ComfyParamRows 尺寸行预设下拉（sizePresets 选项）', () => {
    test('默认关闭：画布节点渲染不含预设下拉（行为不变）', () => {
        const { inst } = makeComfyRows({});
        expect(inst.sizePresets).toBe(false);
        expect(inst.container.innerHTML).toContain('comfy-width-input');
        expect(inst.container.innerHTML).not.toContain('comfy-size-preset');
    });

    test('开启后渲染「预设」占位 + 八档选项（共享五档 + Comfy 追加三档）', () => {
        const { inst } = makeComfyRows({ sizePresets: true });
        const html = inst.container.innerHTML;
        expect(html).toContain('<select class="comfy-size-preset" title="常用尺寸预设">');
        expect(html).toContain('<option value="">预设</option>');
        expect(PRESETS).toHaveLength(8);
        for (const p of PRESETS) expect(html).toContain(p.label);
        // 追加档在共享五档之后（前五档下标稳定，既有快捷选择不漂移）
        expect(PRESETS.slice(0, 5).map((p) => p.label))
            .toEqual(CL.PRESET_SIZES.map((p) => p.label));
        expect(PRESETS[7]).toEqual({ label: '1920 × 1080（16:9）', width: 1920, height: 1080 });
    });

    test('共享五档清单不受追加污染（漫画/坐标编辑器口径不变）', () => {
        expect(CL.PRESET_SIZES).toHaveLength(5);
        expect(CL.PRESET_SIZES.every((p) => p.width % 16 === 0 && p.height % 16 === 0)).toBe(true);
    });

    test('选中共享档：状态与输入框回填宽高，占位复位', () => {
        const { inst, width, height, preset } = makeComfyRows({ sizePresets: true });
        preset.value = '1';   // 832 × 1216（竖图）
        preset.handlers.change();
        expect(inst.state.sizeW).toBe(832);
        expect(inst.state.sizeH).toBe(1216);
        expect(width.value).toBe(832);
        expect(height.value).toBe(1216);
        expect(preset.value).toBe('');          // 复位回「预设」占位
    });

    test('选中追加档 1920×1080：Comfy 侧不做 16 倍数取整', () => {
        const { inst, width, height, preset } = makeComfyRows({ sizePresets: true });
        preset.value = '7';   // 1920 × 1080（16:9）
        preset.handlers.change();
        expect(inst.state.sizeW).toBe(1920);
        expect(inst.state.sizeH).toBe(1080);    // 不被 clampDim 取整到 1088
        expect(width.value).toBe(1920);
        expect(height.value).toBe(1080);
    });

    test('占位项（value 空）不写入状态', () => {
        const { inst, width, height, preset } = makeComfyRows({ sizePresets: true });
        preset.value = '';
        preset.handlers.change();
        expect(inst.state.sizeW).toBeNull();
        expect(inst.state.sizeH).toBeNull();
        expect(width.value).toBe('');           // 未动模板默认渲染值
    });
});

describe('RunningHubParamRows 尺寸合并行预设下拉', () => {
    const WF = {
        id: 'rh1', name: '测试卡',
        params: [
            { nodeId: '9', fieldName: 'width', label: 'Width', type: 'string' },
            { nodeId: '9', fieldName: 'height', label: 'Height', type: 'string' }
        ]
    };

    test('尺寸合并行渲染预设下拉与八档选项', () => {
        const { container } = makeRhContainer();
        const inst = new RunningHubParamRows(container);
        inst.setWorkflow(WF);
        expect(container.innerHTML).toContain('<select class="comfy-size-preset" title="常用尺寸预设">');
        expect(container.innerHTML).toContain('<option value="">预设</option>');
        expect(container.innerHTML).toContain(PRESETS[0].label);
    });

    test('选中预设：宽高两输入与 values 快照同步写入，占位复位', () => {
        const { container, width, height, preset } = makeRhContainer();
        const inst = new RunningHubParamRows(container);
        inst.setWorkflow(WF);
        preset.value = '2';   // 1216 × 832（横图）
        preset.handlers.change();
        expect(width.value).toBe('1216');
        expect(height.value).toBe('832');
        expect(inst.values['9:width']).toBe('1216');
        expect(inst.values['9:height']).toBe('832');
        expect(preset.value).toBe('');
        expect(inst.getValues()['9:width']).toBe('1216');   // 提交口径随预设走
    });

    test('选中追加档 1920×1080：宽高两键按字符串写入', () => {
        const { container, width, height, preset } = makeRhContainer();
        const inst = new RunningHubParamRows(container);
        inst.setWorkflow(WF);
        preset.value = '7';
        preset.handlers.change();
        expect(width.value).toBe('1920');
        expect(height.value).toBe('1080');
        expect(inst.values['9:width']).toBe('1920');
        expect(inst.values['9:height']).toBe('1080');
    });

    test('只登记 width 单参：回退普通单行，无预设下拉', () => {
        const { container } = makeRhContainer();
        const inst = new RunningHubParamRows(container);
        inst.setWorkflow({ id: 'rh2', name: '单参卡', params: [WF.params[0]] });
        expect(container.innerHTML).not.toContain('comfy-size-row');
        expect(container.innerHTML).not.toContain('comfy-size-preset');
    });
});
