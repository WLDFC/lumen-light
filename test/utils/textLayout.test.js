/**
 * TextLayout 共享纯函数层测试（js/utils/TextLayout.js，ADR 067）。
 * 被测文件是浏览器端经典脚本（依赖全局 window），用 vm 在同一上下文执行
 * （coordinateLayout.test.js 同款做法）。拆段用例是 ADR 066 修复的回归锚
 * ——竖排西文段曾被 [^[...]] 双重嵌套正则静默丢弃。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {} };
vm.createContext(context);
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/utils/TextLayout.js'), 'utf-8'),
    context, { filename: 'TextLayout.js' });
const TextLayout = context.window.TextLayout;

/** 确定性测量桩：宽=字符数×10、fontBoundingBox 20/5（断言数字全部基于此） */
function makeStubCtx() {
    return {
        font: '',
        measureText: (s) => ({
            width: String(s).length * 10,
            fontBoundingBoxAscent: 20, fontBoundingBoxDescent: 5
        })
    };
}

describe('TextLayout.splitRuns（ADR 066 修复回归锚）', () => {
    test('混排：西文段与 CJK 段正确分拆', () => {
        expect(TextLayout.splitRuns('AB字')).toEqual([
            { text: 'AB', cjk: false },
            { text: '字', cjk: true }
        ]);
        expect(TextLayout.splitRuns('你好AB世界')).toEqual([
            { text: '你好', cjk: true },
            { text: 'AB', cjk: false },
            { text: '世界', cjk: true }
        ]);
    });

    test('纯西文/纯 CJK/空串边界', () => {
        expect(TextLayout.splitRuns('ABC')).toEqual([{ text: 'ABC', cjk: false }]);
        expect(TextLayout.splitRuns('你好')).toEqual([{ text: '你好', cjk: true }]);
        expect(TextLayout.splitRuns('')).toEqual([]);
    });

    test('全角标点归 CJK（FF01-FF60/3000-303F）；U+2014 破折号不在区间随西文段合并', () => {
        expect(TextLayout.splitRuns('Hi！')).toEqual([
            { text: 'Hi', cjk: false },
            { text: '！', cjk: true }
        ]);
        expect(TextLayout.splitRuns('，。')).toEqual([{ text: '，。', cjk: true }]);
        // 相邻同为非 CJK 不拆段（拆分只发生在 CJK/西文边界）
        expect(TextLayout.splitRuns('A——B')).toEqual([{ text: 'A——B', cjk: false }]);
    });
});

describe('TextLayout.measureTextLayout（注入 stub mctx）', () => {
    test('横排：宽=最长行、高=行数×行距、pad=30% 字号', () => {
        const l = TextLayout.measureTextLayout(
            { content: 'AB\nCD', font: 'TestFont', size: 40, vertical: false }, makeStubCtx());
        expect(l.pad).toBe(12);
        expect(l.w).toBe(40);                 // max(最长行 20, 字号 40)
        expect(l.h).toBeCloseTo(112);         // 2 行 × 40 × 1.4
        expect(l.font).toBe('40px "TestFont", sans-serif');
        expect(l.vertical).toBe(false);
    });

    test('竖排：宽=列数×列距、高=CJK 逐字 CHAR_ADV+西文段测宽', () => {
        const l = TextLayout.measureTextLayout(
            { content: 'AB字', font: 'TestFont', size: 40, vertical: true }, makeStubCtx());
        expect(l.w).toBeCloseTo(56);          // 1 列 × 40 × 1.4
        expect(l.h).toBeCloseTo(66);          // 西文 20 + CJK 1 字 40×1.15
        expect(l.vertical).toBe(true);
    });

    test('缺省字号 48 / 字号下限 4 / 内容缺省空串', () => {
        const l = TextLayout.measureTextLayout({ content: 'A' }, makeStubCtx());
        expect(l.size).toBe(48);
        expect(l.font).toBe('48px "Microsoft YaHei", sans-serif');
        const tiny = TextLayout.measureTextLayout({ content: 'A', size: 1 }, makeStubCtx());
        expect(tiny.size).toBe(4);
    });
});

describe('TextLayout.drawTextContent（内部测量画布走 document 桩）', () => {
    beforeEach(() => {
        // drawTextContent 取半行距要读 fontBoundingBox——内部测量画布经
        // document.createElement 创建，vm 无 DOM 须给桩（漫画测试同款）
        context.document = {
            createElement: (tag) => tag === 'canvas'
                ? { width: 0, height: 0, getContext: () => makeStubCtx() }
                : {}
        };
    });
    afterEach(() => { delete context.document; });

    function makeRecordingG() {
        const calls = { fill: [], font: null, color: null };
        calls.g = {
            set font(v) { calls.font = v; },
            get font() { return calls.font; },
            set fillStyle(v) { calls.color = v; },
            get fillStyle() { return calls.color; },
            textAlign: '', textBaseline: '',
            measureText: (s) => ({
                width: String(s).length * 10,
                fontBoundingBoxAscent: 20, fontBoundingBoxDescent: 5
            }),
            fillText: (...a) => calls.fill.push(a),
            save() {}, restore() {}, translate() {}, rotate() {}
        };
        return calls;
    }

    test('横排：逐行 fillText、颜色透传', () => {
        const rec = makeRecordingG();
        const layout = TextLayout.measureTextLayout(
            { content: 'AB\nCD', font: 'TestFont', size: 40, vertical: false }, makeStubCtx());
        TextLayout.drawTextContent(rec.g,
            { content: 'AB\nCD', color: '#ff5a5a' }, layout);
        expect(rec.fill).toHaveLength(2);     // 两行各一笔
        expect(rec.color).toBe('#ff5a5a');
        expect(rec.g.textAlign).toBe('left');
    });

    test('竖排：CJK 逐字、西文段旋转一笔', () => {
        const rec = makeRecordingG();
        const layout = TextLayout.measureTextLayout(
            { content: 'AB字', font: 'TestFont', size: 40, vertical: true }, makeStubCtx());
        TextLayout.drawTextContent(rec.g, { content: 'AB字', color: '#fff' }, layout);
        expect(rec.fill).toHaveLength(2);     // 西文段 1 笔 + CJK 1 字 1 笔
        expect(rec.g.textAlign).toBe('center');
    });

    test('空内容不落笔', () => {
        const rec = makeRecordingG();
        const layout = TextLayout.measureTextLayout(
            { content: '', font: 'TestFont', size: 40, vertical: false }, makeStubCtx());
        TextLayout.drawTextContent(rec.g, { content: '' }, layout);
        expect(rec.fill).toHaveLength(0);
    });
});

describe('TextLayout.loadSystemFonts（后端 /api/system-fonts，ADR 067）', () => {
    afterEach(() => { delete context.fetch; });

    test('ok 且非空 → 原样返回清单', async () => {
        const fonts = [{ label: 'Arial', family: 'Arial' }];
        context.fetch = async () => ({ json: async () => ({ status: 'ok', fonts }) });
        await expect(TextLayout.loadSystemFonts()).resolves.toBe(fonts);
    });

    test('status error / 空清单 / fetch 抛错 → null（调用方回落精选清单）', async () => {
        context.fetch = async () => ({ json: async () => ({ status: 'error' }) });
        await expect(TextLayout.loadSystemFonts()).resolves.toBe(null);
        context.fetch = async () => ({ json: async () => ({ status: 'ok', fonts: [] }) });
        await expect(TextLayout.loadSystemFonts()).resolves.toBe(null);
        context.fetch = async () => { throw new Error('后端未起'); };
        await expect(TextLayout.loadSystemFonts()).resolves.toBe(null);
    });
});
