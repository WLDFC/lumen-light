/**
 * ==========================================================================
 * GenNodePlaceholder 混入单元测试
 * 覆盖出图节点占位图生命周期共享编排：几何计算（res 兜底/级联偏移）、
 * 移除委托、替换载荷（source/命名前缀/base64 拼 data URL/url 透传/
 * genInfo 绑定）、无占位图兜底落图。被测文件是浏览器端经典脚本，
 * 用 vm 上下文执行（同 CanvasDelivery 测试模式）。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- 桩：全局占位图管理器（记录调用）与 Image/LumenLight ----
function makeStubs() {
    const calls = { create: [], remove: [], removeAll: [], replace: [] };
    const placeholderManager = {
        create: (owner, opts) => { calls.create.push({ owner, opts }); return { handle: calls.create.length }; },
        remove: (t) => { calls.remove.push(t); },
        removeAll: (owner) => { calls.removeAll.push(owner); },
        replace: (handle, imageUrl, payload) => {
            calls.replace.push({ handle, imageUrl, payload });
            return Promise.resolve({ replaced: true, imageUrl, ...payload });
        }
    };
    // Image 桩：构造后赋 src 时同步触发 onload（宽高 640×320）
    class Image {
        set src(v) { this._src = v; this.width = 640; this.height = 320; if (this.onload) this.onload(); }
        get src() { return this._src; }
    }
    const LumenLight = { generateId: () => `id-${Math.random().toString(36).slice(2, 8)}` };
    return { calls, placeholderManager, Image, LumenLight };
}

const stubs = makeStubs();
const context = {
    console,
    window: { placeholderManager: stubs.placeholderManager },
    Image: stubs.Image,
    LumenLight: stubs.LumenLight
};
vm.createContext(context);

vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/canvas/nodes/GenNodePlaceholder.js'), 'utf-8'),
    context, { filename: 'GenNodePlaceholder.js' }
);

const GenNodePlaceholder = context.window.GenNodePlaceholder;

// ---- 假节点工厂：mixin 方法挂在原型链上，constructor 指向配置对象 ----
function makeNode(config, extra = {}) {
    const C = {
        PLACEHOLDER_GAP: 300, PLACEHOLDER_CASCADE: 160,
        PLACEHOLDER_SOURCE: 'comfy', PLACEHOLDER_NAME_PREFIX: 'comfy_gen',
        PLACEHOLDER_INPUT: 'base64', ...config
    };
    const canvas = { images: { images: [] }, draw: jest.fn() };
    const node = Object.create(GenNodePlaceholder);
    Object.assign(node, {
        x: 100, y: 50, width: 200, height: 400,
        _activeGenInfo: null, canvas, constructor: C
    }, extra);
    return node;
}

describe('GenNodePlaceholder.createPlaceholder', () => {
    test('按 res 尺寸与节点右缘间距落位（index 0）', () => {
        const node = makeNode();
        const handle = node.createPlaceholder({ width: 512, height: 512 });
        const call = stubs.calls.create.at(-1);
        expect(handle).toEqual({ handle: stubs.calls.create.length });
        expect(call.owner).toBe(node);
        expect(call.opts).toEqual({ x: 600, y: -6, width: 512, height: 512 }); // 100+200+300, 50+200-256
    });

    test('index 级联偏移沿对角线累加', () => {
        const node = makeNode();
        node.createPlaceholder({ width: 512, height: 512 }, 2);
        const call = stubs.calls.create.at(-1);
        expect(call.opts.x).toBe(600 + 2 * 160); // + cascade
        expect(call.opts.y).toBe(-6 + 2 * 160);
    });

    test('res 为 null 时回退 1024 方图', () => {
        const node = makeNode();
        node.createPlaceholder(null);
        const call = stubs.calls.create.at(-1);
        expect(call.opts.width).toBe(1024);
        expect(call.opts.height).toBe(1024);
    });
});

describe('GenNodePlaceholder.removePlaceholder', () => {
    test('带句柄时精确移除，缺省时清空本节点全部', () => {
        const node = makeNode();
        const target = { handle: 1 };
        node.removePlaceholder(target);
        expect(stubs.calls.remove.at(-1)).toBe(target);
        node.removePlaceholder();
        expect(stubs.calls.removeAll.at(-1)).toBe(node);
    });
});

describe('GenNodePlaceholder.replacePlaceholder', () => {
    test('base64 输入拼 data URL 前缀，载荷带 source/命名前缀/提示词', async () => {
        const node = makeNode({ PLACEHOLDER_SOURCE: 'comfy', PLACEHOLDER_NAME_PREFIX: 'comfy_gen', PLACEHOLDER_INPUT: 'base64' });
        const out = await node.replacePlaceholder({ h: 1 }, 'ABCbase64', '一只猫', '低质');
        const call = stubs.calls.replace.at(-1);
        expect(call.imageUrl).toBe('data:image/png;base64,ABCbase64');
        expect(call.payload.source).toBe('comfy');
        expect(call.payload.name).toMatch(/^comfy_gen_\d+\.png$/);
        expect(call.payload.prompt).toBe('一只猫');
        expect(call.payload.negativePrompt).toBe('低质');
        expect(call.payload.genInfo).toBeNull();
        expect(out.replaced).toBe(true);
    });

    test('url 输入原样透传（API 生图节点）', async () => {
        const node = makeNode({ PLACEHOLDER_SOURCE: 'image-gen', PLACEHOLDER_NAME_PREFIX: 'image_gen', PLACEHOLDER_INPUT: 'url' });
        await node.replacePlaceholder({ h: 2 }, 'https://example.com/a.png', 'p');
        const call = stubs.calls.replace.at(-1);
        expect(call.imageUrl).toBe('https://example.com/a.png');
        expect(call.payload.negativePrompt).toBe(''); // 未传时兜底空串
    });

    test('活跃 GenRecord 绑定进载荷（生成同款溯源）', async () => {
        const genInfo = { model: 'x' };
        const node = makeNode({}, { _activeGenInfo: genInfo });
        await node.replacePlaceholder({ h: 3 }, 'RAW', 'p');
        expect(stubs.calls.replace.at(-1).payload.genInfo).toBe(genInfo);
    });
});

describe('GenNodePlaceholder._appendImageRightOfNode', () => {
    test('兜底落图：对象字段齐备、几何垂直居中于节点右侧', () => {
        const node = makeNode();
        node._appendImageRightOfNode('RAWb64', '一只猫');
        expect(node.canvas.images.images).toHaveLength(1);
        const obj = node.canvas.images.images[0];
        expect(obj.name).toMatch(/^comfy_gen_\d+\.png$/);
        expect(obj.source).toBe('comfy');
        expect(obj.x).toBe(600);            // 100+200+300
        expect(obj.y).toBe(50 + 200 - 160); // 节点垂直中心 - 图高/2
        expect(obj.width).toBe(640);
        expect(obj.height).toBe(320);
        expect(obj.prompt).toBe('一只猫');
        expect(obj.negativePrompt).toBe('');
        expect(obj.selected).toBe(false);
        expect(obj.genInfo).toBeUndefined();
        expect(typeof obj.created).toBe('number');
        expect(node.canvas.draw).toHaveBeenCalled();
        expect(obj.img.src).toBe('data:image/png;base64,RAWb64');
    });

    test('url 输入兜底落图时 src 原样使用', () => {
        const node = makeNode({ PLACEHOLDER_INPUT: 'url', PLACEHOLDER_SOURCE: 'image-gen', PLACEHOLDER_NAME_PREFIX: 'image_gen' });
        node._appendImageRightOfNode('https://example.com/a.png', 'p');
        expect(node.canvas.images.images[0].img.src).toBe('https://example.com/a.png');
        expect(node.canvas.images.images[0].source).toBe('image-gen');
    });

    test('活跃 GenRecord 随兜底落图绑定', () => {
        const genInfo = { model: 'y' };
        const node = makeNode({}, { _activeGenInfo: genInfo });
        node._appendImageRightOfNode('R', 'p');
        expect(node.canvas.images.images[0].genInfo).toBe(genInfo);
    });
});
