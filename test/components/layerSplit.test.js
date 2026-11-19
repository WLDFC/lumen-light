/**
 * LayerSplit 图层拆分测试（2026-11-13）
 * 覆盖：识别输出解析（extractJson 剥围栏/normalizeBox 归一与钳制/
 * parseDetectResult 白名单与兜底）；识别 prompt（像素坐标强制注入）；
 * 几何纯函数（uniteBoxes 并集/computeBlendRect 局部合成矩形）；
 * 逐层精抠纯函数（planPreciseCrop/opaqueBboxFiltered/alignPreciseSlice/
 * resolvePrecisePrompt，2026-11-19）。
 * 壳与手势属浏览器 DOM，vm 不覆盖（冒烟走真机）。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {}, localStorage: {
    getItem: () => null, setItem: () => { }, removeItem: () => { }
} };
vm.createContext(context);
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/components/LayerSplit.js'), 'utf-8'),
    context, { filename: 'LayerSplit.js' });
const LayerSplit = context.window.LayerSplit;

describe('LayerSplit.extractJson 模型输出 JSON 提取', () => {
    test('裸 JSON / markdown 围栏 / 前后噪声三种形态都能取出对象', () => {
        expect(LayerSplit.extractJson('{"assets":[]}')).toEqual({ assets: [] });
        expect(LayerSplit.extractJson('```json\n{"assets":[]}\n```')).toEqual({ assets: [] });
        expect(LayerSplit.extractJson('好的，结果如下：{"assets":[]} 以上。')).toEqual({ assets: [] });
    });

    test('无大括号/JSON 损坏：抛可读错误', () => {
        expect(() => LayerSplit.extractJson('没有任何 JSON')).toThrow('模型没有返回 JSON 对象');
        expect(() => LayerSplit.extractJson('{"assets": [broken}')).toThrow('JSON 解析失败');
        expect(() => LayerSplit.extractJson('{"assets": [broken')).toThrow('模型没有返回 JSON 对象');
    });
});

describe('LayerSplit.normalizeBox bbox 归一', () => {
    test('对象与数组两种入参等价；负宽高自动交换', () => {
        expect(LayerSplit.normalizeBox({ x: 10, y: 20, width: 30, height: 40 }, 100, 100))
            .toEqual([10, 20, 30, 40]);
        expect(LayerSplit.normalizeBox([10, 20, 30, 40], 100, 100)).toEqual([10, 20, 30, 40]);
        expect(LayerSplit.normalizeBox({ x: 40, y: 60, width: -30, height: -40 }, 100, 100))
            .toEqual([10, 20, 30, 40]);
    });

    test('越界钳进画幅；小尺寸丢弃；非法值返回 null', () => {
        expect(LayerSplit.normalizeBox({ x: -5, y: -5, width: 200, height: 200 }, 100, 100))
            .toEqual([0, 0, 100, 100]);
        expect(LayerSplit.normalizeBox({ x: 0, y: 0, width: 4, height: 4 }, 100, 100)).toBeNull();
        expect(LayerSplit.normalizeBox({ x: 'a', y: 0, width: 30, height: 30 }, 100, 100)).toBeNull();
        expect(LayerSplit.normalizeBox(null, 100, 100)).toBeNull();
        // 自定义最小尺寸（手画框放宽到 4px）
        expect(LayerSplit.normalizeBox({ x: 0, y: 0, width: 5, height: 5 }, 100, 100, 4))
            .toEqual([0, 0, 5, 5]);
    });
});

describe('LayerSplit.parseDetectResult 识别结果解析', () => {
    const OK = JSON.stringify({
        assets: [
            { name: 'ornate_wood_frame', kind: 'decoration', bbox: { x: 0, y: 0, width: 200, height: 100 }, confidence: 0.9 },
            { name: 'bad kind 混入中文', kind: 'window', bbox: { x: 0, y: 0, width: 50, height: 50 } },   // 白名单外
            { name: 'tiny', kind: 'icon', bbox: { x: 0, y: 0, width: 3, height: 3 } },                    // 太小
            { kind: 'button', bbox: { x: 20, y: 20, width: 60, height: 30 } }                             // 无名兜底
        ]
    });

    test('白名单外 kind 归一 other（不丢弃）/最小尺寸过滤 + 名称兜底 + confidence 钳制', () => {
        const boxes = LayerSplit.parseDetectResult(OK, 400, 300);
        expect(boxes).toHaveLength(3);   // tiny 被滤掉；window 归 other 保留
        expect(boxes[0]).toMatchObject({
            name: 'ornate_wood_frame', kind: 'decoration',
            bbox: [0, 0, 200, 100], keep: true, confidence: 0.9
        });
        expect(boxes[1].kind).toBe('other');      // 自定义词表不被静默吞
        expect(boxes[2].name).toBe('asset_04');   // 缺名按原始下标兜底
        expect(boxes[2].confidence).toBeNull();
    });

    test('名称清洗：非词字符统一转下划线再剥首尾，超长截断', () => {
        const boxes = LayerSplit.parseDetectResult(JSON.stringify({
            assets: [{ name: 'ornate frame 红!!', kind: 'icon', bbox: [0, 0, 50, 50], confidence: 5 }]
        }), 400, 300);
        expect(boxes[0].name).toBe('ornate_frame');   // 首尾下划线剥净
        expect(boxes[0].confidence).toBe(1);   // 越界钳到 1
    });

    test('assets 缺失/非数组：空数组不抛错', () => {
        expect(LayerSplit.parseDetectResult('{"foo":1}', 400, 300)).toEqual([]);
    });
});

describe('LayerSplit.buildDetectPrompt 像素坐标强制注入', () => {
    test('原图尺寸与禁止归一化指令都注入 prompt', () => {
        const p = LayerSplit.buildDetectPrompt(1920, 1080);
        expect(p).toContain('1920 x 1080 pixels');
        expect(p).toContain('Do not normalize');
        expect(p).toContain('icon, button, avatar');   // 词表
    });
});

describe('LayerSplit.resolveDetectPrompt 自定义识别提示词', () => {
    test('空自定义 → 内置模板注入尺寸', () => {
        const p = LayerSplit.resolveDetectPrompt('', 800, 600);
        expect(p).toContain('800 x 600 pixels');
        expect(p).toBe(LayerSplit.buildDetectPrompt(800, 600));
    });

    test('自定义模板：{{width}}/{{height}} 占位符替换；未写占位符原样发送', () => {
        const p = LayerSplit.resolveDetectPrompt(
            '找出 {{width}}x{{height}} 图里的宝石按钮，返回 JSON。', 640, 420);
        expect(p).toBe('找出 640x420 图里的宝石按钮，返回 JSON。');
        expect(LayerSplit.resolveDetectPrompt('直接找图标', 640, 420))
            .toBe('直接找图标');
        expect(LayerSplit.resolveDetectPrompt('   ', 640, 420))
            .toBe(LayerSplit.buildDetectPrompt(640, 420));   // 纯空白=未自定义
    });
});

describe('LayerSplit.resolveInpaintPrompt 自定义补齐提示词', () => {
    test('空自定义 → 内置补齐模板（挖洞还原/保持原像素/风格衔接四规则）', () => {
        const p = LayerSplit.resolveInpaintPrompt('', 640, 420);
        expect(p).toBe(LayerSplit.INPAINT_PROMPT_TEMPLATE);
        expect(p).toContain('Fill in the missing transparent region');
        expect(p).toContain('Keep all existing visible pixels unchanged');
    });

    test('自定义模板：占位符替换与原样透传', () => {
        expect(LayerSplit.resolveInpaintPrompt(
            '补全 {{width}}x{{height}} 图中被挖空的区域，保持厚涂质感。', 640, 420))
            .toBe('补全 640x420 图中被挖空的区域，保持厚涂质感。');
        expect(LayerSplit.resolveInpaintPrompt('用中文描述补全', 640, 420))
            .toBe('用中文描述补全');
        expect(LayerSplit.resolveInpaintPrompt(null, 640, 420))
            .toBe(LayerSplit.INPAINT_PROMPT_TEMPLATE);
    });
});

describe('LayerSplit.resolveExtractPrompt 自定义提取提示词（AI 拆图）', () => {
    test('空自定义 → 内置整图提取模板并注入缩放后尺寸', () => {
        const p = LayerSplit.resolveExtractPrompt('', 2048, 1152);
        expect(p).toContain('保持原坐标位置不改变');
        expect(p).toContain('透明');
        expect(p).toContain('2048');
        expect(p).toContain('1152');
        expect(p).not.toContain('{{width}}');
        expect(p).not.toContain('{{height}}');
    });

    test('自定义模板：占位符替换与原样透传', () => {
        expect(LayerSplit.resolveExtractPrompt(
            '提取前景 {{width}}x{{height}}，透明背景。', 100, 50))
            .toBe('提取前景 100x50，透明背景。');
        expect(LayerSplit.resolveExtractPrompt('整图抠前景', 640, 420))
            .toBe('整图抠前景');
        expect(LayerSplit.resolveExtractPrompt('   ', 640, 420))
            .toBe(LayerSplit.resolveExtractPrompt('', 640, 420));
    });

    test('EXTRACT_TARGET_EDGE 为 2K 档（发送前缩放基准）', () => {
        expect(LayerSplit.EXTRACT_TARGET_EDGE).toBe(2048);
    });
});

describe('LayerSplit 几何：并集与局部合成矩形', () => {
    test('uniteBoxes：多框并集 / 空返回 null', () => {
        expect(LayerSplit.uniteBoxes([[10, 10, 20, 20], [50, 50, 10, 10]]))
            .toEqual([10, 10, 50, 50]);
        expect(LayerSplit.uniteBoxes([[10, 10, 20, 20], [15, 15, 10, 10]]))
            .toEqual([10, 10, 20, 20]);
        expect(LayerSplit.uniteBoxes([])).toBeNull();
        expect(LayerSplit.uniteBoxes(null)).toBeNull();
    });

    test('computeBlendRect：外扩并钳进画幅', () => {
        expect(LayerSplit.computeBlendRect([10, 10, 30, 30], 100, 100, 0))
            .toEqual({ x: 10, y: 10, w: 30, h: 30 });
        expect(LayerSplit.computeBlendRect([0, 0, 30, 30], 100, 100, 4))
            .toEqual({ x: 0, y: 0, w: 34, h: 34 });
        expect(LayerSplit.computeBlendRect([90, 90, 20, 20], 100, 100, 4))
            .toEqual({ x: 86, y: 86, w: 14, h: 14 });   // 右下钳边界
        expect(LayerSplit.computeBlendRect(null, 100, 100, 4)).toBeNull();
    });
});

// ==================== image-to-slice 机制迁移（2026-11-14） ====================

describe('LayerSplit.expandHole 挖洞外扩', () => {
    test('外扩 min(宽高)*0.1 钳 4~16px，四边一致', () => {
        // 30×30 洞 → pad=max(4,3)=4 → 38×38
        expect(LayerSplit.expandHole([10, 10, 30, 30], 500, 500)).toEqual([6, 6, 38, 38]);
        // 200×200 洞 → pad=16（20 上限被钳） → 232×232
        expect(LayerSplit.expandHole([100, 100, 200, 200], 1000, 1000)).toEqual([84, 84, 232, 232]);
        // 10×10 洞 → pad=4 → 18×18
        expect(LayerSplit.expandHole([50, 50, 10, 10], 500, 500)).toEqual([46, 46, 18, 18]);
    });

    test('贴边洞外扩钳进画幅不出界', () => {
        expect(LayerSplit.expandHole([0, 0, 40, 40], 100, 100)).toEqual([0, 0, 44, 44]);
        expect(LayerSplit.expandHole([96, 96, 4, 4], 100, 100)).toEqual([92, 92, 8, 8]);
        // 画幅角落的退化洞：外扩后钳在画幅内
        expect(LayerSplit.expandHole([100, 100, 0, 0], 100, 100)).toEqual([96, 96, 4, 4]);
    });
});

describe('LayerSplit.sampleEdgeBackground 边缘背景色采样', () => {
    test('纯色边缘：均值即该色', () => {
        const w = 30, h = 30;
        const pixels = new Array(w * h * 4);
        for (let i = 0; i < w * h; i++) {
            pixels[i * 4] = 200; pixels[i * 4 + 1] = 180; pixels[i * 4 + 2] = 160; pixels[i * 4 + 3] = 255;
        }
        const bg = LayerSplit.sampleEdgeBackground(pixels, w, h);
        expect(bg.r).toBeCloseTo(200, 5);
        expect(bg.g).toBeCloseTo(180, 5);
        expect(bg.b).toBeCloseTo(160, 5);
    });

    test('边缘混入少量非背景像素：掐头去尾后不被带偏', () => {
        const w = 40, h = 40;
        const pixels = new Array(w * h * 4).fill(0);
        for (let i = 0; i < w * h; i++) {
            pixels[i * 4] = 240; pixels[i * 4 + 1] = 240; pixels[i * 4 + 2] = 240; pixels[i * 4 + 3] = 255;
        }
        // 边缘撒少量黑噪点（<20% 极值尾，掐掉）
        for (const [x, y] of [[0, 0], [10, 0], [20, 39], [39, 15]]) {
            const i = (y * w + x) * 4;
            pixels[i] = 10; pixels[i + 1] = 10; pixels[i + 2] = 10;
        }
        const bg = LayerSplit.sampleEdgeBackground(pixels, w, h);
        expect(bg.r).toBeGreaterThan(200);   // 仍接近 240
        expect(bg.r).toBeLessThanOrEqual(240);
    });
});

describe('LayerSplit.colorKeyTransparent 双阈值色键去底', () => {
    const makePixels = () => {
        // [白背景, 软过渡, 主体红, 白背景] 4 像素
        return [
            250, 250, 250, 255,
            250, 250, 250, 255,
            200, 30, 30, 255,
            250, 250, 250, 255
        ];
    };
    test('背景色距 ≤hard 全透', () => {
        const px = makePixels();
        const keyed = LayerSplit.colorKeyTransparent(px, 4, 1, { r: 250, g: 250, b: 250 });
        expect(keyed).toBe(3);
        expect(px[3]).toBe(0);
        expect(px[15]).toBe(0);
    });

    test('hard~soft 之间 alpha 线性渐变；≥soft 不动', () => {
        const px = [
            250, 250, 250, 255,   // 距离 0 → 全透
            250, 220, 220, 255,   // 距离 = sqrt(30²+30²) ≈ 42.4 → 渐变区
            200, 30, 30, 255,     // 距离很大 → 不动
            250, 250, 250, 255
        ];
        LayerSplit.colorKeyTransparent(px, 4, 1, { r: 250, g: 250, b: 250 }, { hard: 10, soft: 90 });
        expect(px[3]).toBe(0);
        const expectedRatio = (Math.sqrt(2 * 900) - 10) / 80;
        expect(px[7]).toBe(Math.round(255 * expectedRatio));
        expect(px[11]).toBe(255);
    });

    test('单遍语义：渐变带乘现有 alpha，重复跑软边继续变淡（与参考实现一致）', () => {
        const px = [250, 220, 220, 255];
        LayerSplit.colorKeyTransparent(px, 1, 1, { r: 250, g: 250, b: 250 }, { hard: 10, soft: 90 });
        const once = Math.round(255 * (Math.sqrt(2 * 900) - 10) / 80);
        expect(px[3]).toBe(once);
        LayerSplit.colorKeyTransparent(px, 1, 1, { r: 250, g: 250, b: 250 }, { hard: 10, soft: 90 });
        expect(px[3]).toBe(Math.round(once * (Math.sqrt(2 * 900) - 10) / 80));
    });

    test('花色背景（无像素接近边缘色）keyed=0', () => {
        const px = [10, 10, 10, 255, 220, 10, 10, 255, 10, 220, 10, 255, 10, 10, 220, 255];
        expect(LayerSplit.colorKeyTransparent(px, 4, 1, { r: 250, g: 250, b: 250 })).toBe(0);
        expect(px[3]).toBe(255);   // alpha 原封不动
    });
});

describe('LayerSplit.buildJsonRepairPrompt 修复提示词', () => {
    test('附原文且声明不许增删改条目', () => {
        const p = LayerSplit.buildJsonRepairPrompt('{"assets":[broken');
        expect(p).toContain('不新增');
        expect(p).toContain('{"assets":[broken');
    });
});

describe('INPAINT_PROMPT_TEMPLATE 色彩保护条款（image-to-slice 迁）', () => {
    test('含白平衡/曝光对齐与禁全局调色条款', () => {
        expect(LayerSplit.INPAINT_PROMPT_TEMPLATE)
            .toContain('white balance, color temperature, tint, exposure, gamma, contrast and saturation');
        expect(LayerSplit.INPAINT_PROMPT_TEMPLATE).toContain('no global relighting, HDR');
        expect(LayerSplit.INPAINT_PROMPT_TEMPLATE).toContain('Avoid seams, halos');
    });
});

describe('LayerSplit.planCutoutResize AI 抠图三档选档（image-to-slice 同款）', () => {
    test('宽高比分档：>1.2 横图 1536x1024，<0.85 竖图 1024x1536，其余 1024x1024', () => {
        expect(LayerSplit.planCutoutResize(140, 92).size).toBe('1536x1024');
        expect(LayerSplit.planCutoutResize(200, 300).size).toBe('1024x1536');
        expect(LayerSplit.planCutoutResize(500, 520).size).toBe('1024x1024');
        // 阈值边界：1.2 与 0.85 归近方形档
        expect(LayerSplit.planCutoutResize(120, 100).size).toBe('1024x1024');
        expect(LayerSplit.planCutoutResize(85, 100).size).toBe('1024x1024');
    });

    test('contain 等比缩放居中：长边贴满、短边居中', () => {
        // 140×92 → 横图档，scale=min(1536/140≈10.97, 1024/92≈11.13)=10.97
        // → 内容 1536×1009（宽先贴满），垂直居中留 15px
        const p1 = LayerSplit.planCutoutResize(140, 92);
        expect(p1.contentW).toBe(1536);
        expect(p1.contentH).toBe(1009);
        expect(p1.y).toBe(7);
        // 300×100 → 横图档，scale=min(1536/300=5.12, 1024/100=10.24)=5.12 → 内容 1536×512，垂直居中
        const p2 = LayerSplit.planCutoutResize(300, 100);
        expect(p2.contentW).toBe(1536);
        expect(p2.contentH).toBe(512);
        expect(p2.x).toBe(0);
        expect(p2.y).toBe(256);
        // 竖图：1024×1536 档，400×1200 → scale=min(2.56, 1.28)=1.28 → 512×1536 水平居中
        const p3 = LayerSplit.planCutoutResize(400, 1200);
        expect(p3.contentW).toBe(512);
        expect(p3.contentH).toBe(1536);
        expect(p3.x).toBe(256);
        expect(p3.y).toBe(0);
    });

    test('极端长条：短边缩放不足 1px 时钳到 1px', () => {
        const p = LayerSplit.planCutoutResize(10000, 1);
        expect(p.contentW).toBe(1536);
        expect(p.contentH).toBe(1);   // round(1×0.1536)=0 → 钳 1
    });
});

// ==================== 逐层精抠纯函数（2026-11-19 方案一） ====================

describe('LayerSplit.planPreciseCrop 精抠裁片规划', () => {
    test('框四周外扩长边 25%，inner 换算成裁片坐标', () => {
        // margin = max(80,60)*0.25 = 20
        const p = LayerSplit.planPreciseCrop([100, 100, 80, 60], 800, 600);
        expect(p.crop).toEqual([80, 80, 120, 100]);
        expect(p.inner).toEqual([20, 20, 80, 60]);
        expect(p.margin).toBe(20);
    });

    test('边距下限 12px（小图标兜底）', () => {
        // margin = max(12, 8*0.25=2) = 12
        const p = LayerSplit.planPreciseCrop([10, 10, 8, 8], 100, 100);
        expect(p.crop).toEqual([0, 0, 30, 30]);   // 贴左上钳边界
        expect(p.inner).toEqual([10, 10, 8, 8]);
    });

    test('边距上限 192px（大面板不无限扩）', () => {
        // margin = min(192, 1000*0.25=250) = 192
        const p = LayerSplit.planPreciseCrop([300, 300, 1000, 900], 2000, 2000);
        expect(p.margin).toBe(192);
        expect(p.crop).toEqual([108, 108, 1384, 1284]);
        expect(p.inner).toEqual([192, 192, 1000, 900]);
    });

    test('贴边框：crop 钳进画幅不出界（box 在原点 → inner 贴 crop 原点）', () => {
        const p = LayerSplit.planPreciseCrop([0, 0, 40, 40], 100, 100);
        expect(p.crop).toEqual([0, 0, 52, 52]);
        expect(p.inner).toEqual([0, 0, 40, 40]);
    });
});

describe('LayerSplit.opaqueBboxFiltered alpha 连通域去噪', () => {
    /** 构造 w×h 全透明像素底 + 若干不透明块 [x, y, w, h] */
    const makePixels = (w, h, blocks) => {
        const px = new Array(w * h * 4).fill(0);
        for (const [bx, by, bw, bh] of blocks) {
            for (let y = by; y < by + bh; y++) {
                for (let x = bx; x < bx + bw; x++) {
                    const i = (y * w + x) * 4;
                    px[i] = 200; px[i + 1] = 30; px[i + 2] = 30; px[i + 3] = 255;
                }
            }
        }
        return px;
    };

    test('最大连通域保留、1px 噪点按 minPx 滤掉，bbox=去噪后并集', () => {
        // 20×10：主体 4×4（16px）+ 远角 1px 噪点 → 阈值 max(4, 16*0.01)=4 → 噪点滤掉
        const px = makePixels(20, 10, [[2, 2, 4, 4], [19, 9, 1, 1]]);
        const r = LayerSplit.opaqueBboxFiltered(px, 20, 10);
        expect(r.bbox).toEqual([2, 2, 4, 4]);
        expect(r.kept).toBe(1);
        expect(r.total).toBe(2);
    });

    test('多个大连通域全部保留：bbox 取并集（元素分离部件不丢）', () => {
        const px = makePixels(20, 10, [[0, 0, 4, 4], [10, 5, 4, 4]]);
        const r = LayerSplit.opaqueBboxFiltered(px, 20, 10);
        expect(r.bbox).toEqual([0, 0, 14, 9]);
        expect(r.kept).toBe(2);
    });

    test('8 连通：对角相邻算同一连通域（2×2 团对角相接，高于 minPx 下限）', () => {
        const px = makePixels(6, 6, [[0, 0, 2, 2], [2, 2, 2, 2]]);
        const r = LayerSplit.opaqueBboxFiltered(px, 6, 6);
        expect(r.total).toBe(1);
        expect(r.bbox).toEqual([0, 0, 4, 4]);
    });

    test('alpha 阈值：半透明（≤8）不算前景；全透明返回 null', () => {
        const px = new Array(4 * 4 * 4).fill(0);   // RGBA 全长（短数组 undefined alpha 会被当前景）
        px[3] = 8;   // 第一像素 alpha=8 → 不算
        expect(LayerSplit.opaqueBboxFiltered(px, 4, 4)).toBeNull();
        const px2 = new Array(4 * 4 * 4).fill(0);
        for (const i of [0, 1, 4, 5]) px2[i * 4 + 3] = 9;   // 2×2 团（4px 恰好过 minPx 下限；单像素会被当噪点滤掉=设计行为）
        expect(LayerSplit.opaqueBboxFiltered(px2, 4, 4)).toEqual({ bbox: [0, 0, 2, 2], kept: 1, total: 1 });
    });
});

describe('LayerSplit.alignPreciseSlice 精抠两态对齐', () => {
    test('抖动态（bbox 在基准框±2 内）：中心对齐基准框', () => {
        // 输出 bbox [22,22,80,60] 恰好贴着 expanded 右下界（102/82 ≤ 102/82）
        expect(LayerSplit.alignPreciseSlice([22, 22, 80, 60], [20, 20, 80, 60]))
            .toEqual([20, 20, 80, 60]);
    });

    test('补全态（bbox 明显超出基准框）：保持原位不平移', () => {
        // 模型补全被遮挡部分使 bbox 扩大——中心平移会错位可见部分
        expect(LayerSplit.alignPreciseSlice([10, 10, 100, 100], [20, 20, 80, 60]))
            .toEqual([10, 10, 100, 100]);
    });

    test('自定义 tolerance：放宽判定后进入抖动态修正', () => {
        // tol=4：[17,22,80,60] 落进 [16,16,88,68] → 中心对齐 (60,50)
        expect(LayerSplit.alignPreciseSlice([17, 22, 80, 60], [20, 20, 80, 60], 4))
            .toEqual([20, 20, 80, 60]);
    });
});

describe('LayerSplit.resolvePrecisePrompt 精抠提示词', () => {
    test('空自定义 → 内置模板并替换 {{name}}/{{kind}}', () => {
        const p = LayerSplit.resolvePrecisePrompt('', 'gem_button_red', 'button');
        expect(p).toContain('gem_button_red');
        expect(p).toContain('button');
        expect(p).not.toContain('{{name}}');
        expect(p).not.toContain('{{kind}}');
        expect(p).toBe(LayerSplit.resolvePrecisePrompt('   ', 'gem_button_red', 'button'));   // 纯空白=未自定义
    });

    test('自定义模板：占位符替换；缺名/缺类型走兜底值', () => {
        expect(LayerSplit.resolvePrecisePrompt('只提取 {{name}}（{{kind}}）', 'gem', 'icon'))
            .toBe('只提取 gem（icon）');
        expect(LayerSplit.resolvePrecisePrompt('只提取 {{name}}', null, null))
            .toBe('只提取 target element');
        expect(LayerSplit.resolvePrecisePrompt('无占位符原样发送', 'gem', 'icon'))
            .toBe('无占位符原样发送');
    });
});
