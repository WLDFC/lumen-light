/**
 * ==========================================================================
 * StudioAdjustTool 单元测试（调色工具）
 * 覆盖三块：
 *   1. 配置表一致性（DEFS/GROUPS/TABS 互恰——扩展调色项时漏改一处即红）；
 *   2. 像素管线逐段验证（恒等、亮度、对比度、色温、饱和度、锐化、颗粒）；
 *   3. 噪声瓦片性质（值域、确定性——预览不"沸腾"的根基）。
 * 被测文件是浏览器端经典脚本，用 vm 模块在同一上下文执行源码模拟
 * script 标签加载（同 imageProxyCache.test.js 先例）；ImageData 在
 * Node 环境不存在，注入行为等价的最小 mock（数据壳三字段，像素
 * 处理只用这三者）。画布上下文相关的 DOM 交互不在无头环境测试范围。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {} };
context.ImageData = class {
    constructor(data, width, height) {
        this.data = data;
        this.width = width;
        this.height = height;
    }
};
vm.createContext(context);

const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'js', 'components', 'image-studio', 'StudioAdjustTool.js'),
    'utf-8');
vm.runInContext(source, context, { filename: 'StudioAdjustTool.js' });

const StudioAdjustTool = context.window.StudioAdjustTool;

/** 纯管线实例（不触 DOM：_processPipeline/_buildNoiseTile 不依赖宿主） */
const tool = new StudioAdjustTool({});

/** 构造 1×1（或 w×h）纯色 ImageData */
function pixels(r, g, b, a = 255, w = 1, h = 1) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
    return new context.ImageData(data, w, h);
}

/** 全零参数（恒等基线） */
const ZERO = { brightness: 0, contrast: 0, saturation: 0, temperature: 0, sharpen: 0, grain: 0 };

describe('StudioAdjustTool 配置表一致性', () => {
    test('open 是可调用的方法，未被实例状态属性遮蔽（曾因 this.open 布尔遮蔽 open() 导致点击按钮 TypeError 无响应）', () => {
        const t = new StudioAdjustTool({});
        expect(typeof t.open).toBe('function');   // 方法必须可调用
        expect(t._open).toBe(false);              // 会话状态走 _open
        expect(typeof t.close).toBe('function');
        expect(typeof t.save).toBe('function');
    });

    test('GROUPS 清单的并集与 DEFS 键完全互恰（无漏挂/无幽灵项）', () => {
        const grouped = Object.values(StudioAdjustTool.GROUPS).flat();
        expect(grouped.sort()).toEqual(Object.keys(StudioAdjustTool.DEFS).sort());
    });

    test('每个 tab 的 GROUPS 键都存在于 TABS（不会出现死 tab）', () => {
        const tabIds = StudioAdjustTool.TABS.map(t => t.id);
        for (const id of Object.keys(StudioAdjustTool.GROUPS)) {
            expect(tabIds).toContain(id);
        }
    });

    test('每项定义范围合法且默认值在范围内', () => {
        for (const [key, def] of Object.entries(StudioAdjustTool.DEFS)) {
            expect(def.min).toBeLessThan(def.max);
            expect(def.def).toBeGreaterThanOrEqual(def.min);
            expect(def.def).toBeLessThanOrEqual(def.max);
            expect(typeof def.label).toBe('string');
            expect(def.label.length).toBeGreaterThan(0);
        }
    });
});

describe('StudioAdjustTool._processPipeline 像素处理', () => {
    test('全零参数 = 恒等（输出逐字节等于输入，输入不被修改）', () => {
        const src = pixels(10, 128, 250, 200, 3, 2);
        const srcCopy = new Uint8ClampedArray(src.data);
        const out = tool._processPipeline(src, { ...ZERO });
        expect(Array.from(out.data)).toEqual(Array.from(srcCopy));
        expect(Array.from(src.data)).toEqual(Array.from(srcCopy));   // 输入未动
    });

    test('亮度 +100：v=100 → 228（偏移 +128），且 255 处钳制不溢出', () => {
        const out = tool._processPipeline(pixels(100, 100, 100), { ...ZERO, brightness: 100 });
        expect([out.data[0], out.data[1], out.data[2]]).toEqual([228, 228, 228]);
        const maxed = tool._processPipeline(pixels(255, 255, 255), { ...ZERO, brightness: 100 });
        expect([maxed.data[0], maxed.data[1], maxed.data[2]]).toEqual([255, 255, 255]);
    });

    test('对比度 +100（cf=2）：100 → 72、200 → 272 钳到 255；-100 全部压到中灰', () => {
        const out = tool._processPipeline(pixels(100, 100, 100), { ...ZERO, contrast: 100 });
        expect(out.data[0]).toBe(72);
        const up = tool._processPipeline(pixels(200, 200, 200), { ...ZERO, contrast: 100 });
        expect(up.data[0]).toBe(255);
        const flat = tool._processPipeline(pixels(30, 30, 30), { ...ZERO, contrast: -100 });
        expect([flat.data[0], flat.data[1], flat.data[2]]).toEqual([128, 128, 128]);
    });

    test('色温 +100：R +50 钳制、B −50、G 不动；负值方向相反', () => {
        const warm = tool._processPipeline(pixels(220, 128, 60), { ...ZERO, temperature: 100 });
        expect([warm.data[0], warm.data[1], warm.data[2]]).toEqual([255, 128, 10]);
        const cool = tool._processPipeline(pixels(60, 128, 220), { ...ZERO, temperature: -100 });
        expect([cool.data[0], cool.data[1], cool.data[2]]).toEqual([10, 128, 255]);
    });

    test('饱和度 −100 → 灰度化（RGB = Rec.601 亮度）；0 饱和度跳过矩阵运算', () => {
        const gray = tool._processPipeline(pixels(100, 200, 50), { ...ZERO, saturation: -100 });
        const luma = Math.round(0.299 * 100 + 0.587 * 200 + 0.114 * 50);
        expect([gray.data[0], gray.data[1], gray.data[2]]).toEqual([luma, luma, luma]);
        // 灰像素在任何饱和度下不变（r=g=b 时矩阵不动点）
        const satOnGray = tool._processPipeline(pixels(90, 90, 90), { ...ZERO, saturation: 80 });
        expect([satOnGray.data[0], satOnGray.data[1], satOnGray.data[2]]).toEqual([90, 90, 90]);
    });

    test('饱和度 +100：色彩离灰度轴更远（扩老大/压小低）', () => {
        const src = pixels(200, 100, 100);
        const out = tool._processPipeline(src, { ...ZERO, saturation: 100 });
        expect(out.data[0]).toBeGreaterThan(200);   // 高于均值的通道更远
        expect(out.data[1]).toBeLessThan(100);      // 低于均值的通道更近
    });

    test('锐化：平坦区域不变；竖直亮暗边缘增强对比（亮侧更亮、暗侧更暗）', () => {
        // 4×1 平坦图（无边缘可锐）→ 不变
        const flat = tool._processPipeline(pixels(120, 120, 120, 255, 4, 4), { ...ZERO, sharpen: 100 });
        expect(Array.from(flat.data)).toEqual(Array.from(pixels(120, 120, 120, 255, 4, 4).data));
        // 5×3 左暗右亮边缘：边缘列在锐化后对比拉大
        const edge = pixels(50, 50, 50, 255, 5, 3);
        for (let y = 0; y < 3; y++) {
            for (let x = 3; x < 5; x++) {
                const i = (y * 5 + x) * 4;
                edge.data[i] = 200; edge.data[i + 1] = 200; edge.data[i + 2] = 200;
            }
        }
        const sharp = tool._processPipeline(edge, { ...ZERO, sharpen: 100 });
        const brightIdx = (1 * 5 + 3) * 4;   // 边缘亮侧（x=3，邻域含暗列）
        const darkIdx = (1 * 5 + 2) * 4;     // 边缘暗侧（x=2，邻域含亮列）
        expect(sharp.data[brightIdx]).toBeGreaterThan(200);
        expect(sharp.data[darkIdx]).toBeLessThan(50);
    });

    test('锐化：抗锯齿渐变坡有效（半径 2 盒模糊的核心场景——曾用半径 1 十字核时坡上恒为 0，用户实测「没效果」）', () => {
        // 8×3 单行内容：…100,100,130,160,160… 3px 宽渐变坡（模拟真实
        // 图像抗锯齿边缘）；锐化后坡两侧的对比必须显著拉大
        const ramp = pixels(100, 100, 100, 255, 8, 3);
        for (let y = 0; y < 3; y++) {
            const i1 = (y * 8 + 3) * 4;   // 坡中间 130
            const i2 = (y * 8 + 4) * 4;   // 坡顶 160
            ramp.data[i1] = 130; ramp.data[i1 + 1] = 130; ramp.data[i1 + 2] = 130;
            ramp.data[i2] = 160; ramp.data[i2 + 1] = 160; ramp.data[i2 + 2] = 160;
        }
        const sharp = tool._processPipeline(ramp, { ...ZERO, sharpen: 100 });
        const row = 1 * 8 * 4;
        const darkSide = sharp.data[row + 2 * 4];      // 坡下侧（100 区邻接坡）
        const brightSide = sharp.data[row + 4 * 4];    // 坡上侧（160 邻接坡）
        expect(brightSide - darkSide).toBeGreaterThan(160 - 100 + 20);   // 对比明显拉大
        // 旧十字核在此场景的增量 ≈ 0（回归红线：增量低于阈值即修复失效）
    });

    test('颗粒：参数相同输出逐字节一致（固定种子，预览不沸腾）；幅度受上限约束', () => {
        const src = pixels(128, 128, 128, 255, 40, 40);
        const a = tool._processPipeline(src, { ...ZERO, grain: 80 });
        tool._noise = null;                          // 重建瓦片也必须一致
        const b = tool._processPipeline(src, { ...ZERO, grain: 80 });
        expect(Array.from(a.data)).toEqual(Array.from(b.data));
        // 逐像素偏移 ≤ 0.5 × 0.9 ≈ ±45（钳制边界内），且确有像素被改动
        let changed = 0;
        for (let i = 0; i < a.data.length; i += 4) {
            const delta = Math.abs(a.data[i] - 128);
            expect(delta).toBeLessThanOrEqual(46);
            if (delta > 0) changed++;
        }
        expect(changed).toBeGreaterThan(0);
    });

    test('多段叠加：亮度与色温同时生效（LUT 合并语义 = 各自单独作用的叠加）', () => {
        const out = tool._processPipeline(pixels(100, 100, 100),
            { ...ZERO, brightness: 50, temperature: 40 });
        // 亮度 +50 → 164；色温 +40 → R+20 / B−20 / G 不变
        expect([out.data[0], out.data[1], out.data[2]]).toEqual([184, 164, 144]);
    });
});

describe('StudioAdjustTool._buildNoiseTile 噪声瓦片', () => {
    test('值域 [-0.5, 0.5)、长度 128×128，且构建过程确定性可复现', () => {
        tool._noise = null;
        const tile = tool._buildNoiseTile();
        expect(tile.length).toBe(128 * 128);
        for (const v of tile) {
            expect(v).toBeGreaterThanOrEqual(-0.5);
            expect(v).toBeLessThan(0.5);
        }
        tool._noise = null;
        const tile2 = tool._buildNoiseTile();
        expect(Array.from(tile)).toEqual(Array.from(tile2));
    });
});
