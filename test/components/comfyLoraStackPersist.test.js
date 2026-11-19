/**
 * ==========================================================================
 * Comfy 面板 LoRA 叠加区持久化测试（2026-11-08 用户需求：F5 后保留）
 * 覆盖 _loadLoraStack 的脏数据防御（坏 JSON/非数组/坏条目/id 补生成/
 * 强度归位/enabled 缺省）与 _persistLoraStack 写入round-trip。
 * 被测文件是浏览器端经典脚本，vm 加载；叠加区方法自 ADR 083 起位于
 * comfy-param-rows/ComfyLoraStack.js 原型混入，同 context 先主文件后
 * 混入依次装入；实例用 Object.create 绕开 constructor 的 DOM 依赖，
 * 只接持久化两方法需要的触点。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { window: {} };
vm.createContext(context);
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/components/ComfyParamRows.js'), 'utf-8'),
    context, { filename: 'ComfyParamRows.js' });
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/components/comfy-param-rows/ComfyLoraStack.js'), 'utf-8'),
    context, { filename: 'ComfyLoraStack.js' });
const ComfyParamRows = context.window.ComfyParamRows;

/** 持久化可测实例：不跑 constructor，只落 loraStack 开关与 localStorage 桩 */
function makeInst(store) {
    const inst = Object.create(ComfyParamRows.prototype);
    inst.loraStack = true;
    context.localStorage = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); }
    };
    return inst;
}

const KEY = 'comfyLoraStack';

describe('LoRA 叠加区持久化：_loadLoraStack 恢复防御', () => {
    afterEach(() => { delete context.localStorage; });

    test('坏 JSON / 非数组 / null 返回空栈不抛错', () => {
        const inst = makeInst({});
        expect(inst._loadLoraStack()).toEqual([]);          // 无记录
        context.localStorage.setItem(KEY, '{broken json');
        expect(inst._loadLoraStack()).toEqual([]);
        context.localStorage.setItem(KEY, JSON.stringify({ file: 'a' }));
        expect(inst._loadLoraStack()).toEqual([]);
    });

    test('合法条目恢复：强度归位、enabled 缺省视为启用、id 缺失补生成', () => {
        const inst = makeInst({});
        context.window.LumenLight = { generateId: () => 'gen-1' };
        context.localStorage = {
            getItem: () => JSON.stringify([
                { id: 'a', file: 'moss/x.safetensors', strengthModel: 0.8, strengthClip: 1.2, enabled: false },
                { file: 'moss/y.safetensors', strengthModel: '9', strengthClip: 'abc' },
                null,
                { file: 42 },
                { id: 'c', file: '', strengthModel: 1, strengthClip: 1 }
            ]),
            setItem: () => {}
        };
        const out = inst._loadLoraStack();
        expect(out).toHaveLength(3);
        expect(out[0]).toEqual({ id: 'a', file: 'moss/x.safetensors', strengthModel: 0.8, strengthClip: 1.2, enabled: false });
        // id 缺失补生成；强度钳位（9 → 5 上限、abc → 回落 1）
        expect(out[1].id).toBe('gen-1');
        expect(out[1].strengthModel).toBe(5);
        expect(out[1].strengthClip).toBe(1);
        expect(out[1].enabled).toBe(true);
        // file 非字符串丢弃（null/数字两条）；file 为空串的空槽保留
        expect(out[2].id).toBe('c');
        expect(out[2].file).toBe('');
    });

    test('条数 200 封顶', () => {
        const raw = Array.from({ length: 300 }, (_, i) => ({ file: `f/${i}.safetensors` }));
        const inst = makeInst({});
        context.window.LumenLight = { generateId: () => 'x' };
        context.localStorage = { getItem: () => JSON.stringify(raw), setItem: () => {} };
        expect(inst._loadLoraStack()).toHaveLength(200);
    });
});

describe('LoRA 叠加区持久化：_persistLoraStack 写入', () => {
    afterEach(() => {
        delete context.localStorage;
        delete context.window.LumenLight;
    });

    test('round-trip：只落五个契约字段，enabled=false 原样保留', () => {
        const store = {};
        const inst = makeInst(store);
        inst.loras = [
            { id: 'a', file: 'moss/x.safetensors', strengthModel: 0.7, strengthClip: 1, enabled: true, junk: '不落盘' },
            { id: 'b', file: '', strengthModel: 1, strengthClip: 1, enabled: false }
        ];
        inst._persistLoraStack();
        const written = JSON.parse(store[KEY]);
        expect(written).toEqual([
            { id: 'a', file: 'moss/x.safetensors', strengthModel: 0.7, strengthClip: 1, enabled: true },
            { id: 'b', file: '', strengthModel: 1, strengthClip: 1, enabled: false }
        ]);
        // 恢复口径一致：读回来的条目与写入等价
        const restored = inst._loadLoraStack();
        expect(restored[0].file).toBe('moss/x.safetensors');
        expect(restored[1].enabled).toBe(false);
    });

    test('非 loraStack 模式（画布节点实例）不写盘', () => {
        const store = {};
        const inst = makeInst(store);
        inst.loraStack = false;
        inst.loras = [{ id: 'a', file: 'x' }];
        inst._persistLoraStack();
        expect(store[KEY]).toBeUndefined();
    });
});
