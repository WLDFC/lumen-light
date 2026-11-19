/**
 * dom 测试（2026-11-09 自 mangaEditor.test.js 按模块拆分）
 * 覆盖：MangaEditor Delete 键删除对象决策（元素/图层，MangaDom._keyDeleteTarget）；MangaEditor 右栏分区收纳（MangaDom._buildOutRail）；漫画编辑器中键拖动平移（ADR 077）
 */

const { context, MangaEditor, CoordinateLayout, makeInstance } = require('./helpers');

describe('MangaEditor Delete 键删除对象决策（元素/图层，MangaDom._keyDeleteTarget）', () => {
    function makeKeyInst() {
        const inst = Object.create(MangaEditor.prototype);
        inst.draft = {
            width: 1024, height: 1024,
            bbox_coord_space: 'abs', bbox_format: 'xyxy',
            summary: { caption: '', canvas: 'single' },
            items: [{ label: 'object', caption: '', bbox: [100, 100, 300, 300] }],
            drawLayers: [
                { id: 1, name: '图层 1', visible: true, strokes: [] },
                { id: 2, name: '图片 2', visible: true, image: { src: 'x', bbox: [0, 0, 100, 100] } }
            ]
        };
        inst.selected = -1;
        inst._selLayerId = null;
        inst._activeLayerId = null;
        return inst;
    }

    test('无任何选中/激活 → null（键不响应）', () => {
        expect(makeKeyInst()._keyDeleteTarget()).toBeNull();
    });

    test('元素选中优先（与图层选中异常并存时只删元素，防双删）', () => {
        const inst = makeKeyInst();
        inst.selected = 0;
        inst._selLayerId = 2;
        expect(inst._keyDeleteTarget()).toEqual({ kind: 'element', index: 0 });
    });

    test('图片层选中 → 删图片层', () => {
        const inst = makeKeyInst();
        inst._selLayerId = 2;
        expect(inst._keyDeleteTarget()).toEqual({ kind: 'layer', id: 2 });
    });

    test('图片层选中失效（跨页残留/已删 id）→ 回落活动笔迹层', () => {
        const inst = makeKeyInst();
        inst._selLayerId = 99;
        inst._activeLayerId = 1;
        expect(inst._keyDeleteTarget()).toEqual({ kind: 'layer', id: 1 });
    });

    test('仅活动笔迹层 → 删笔迹层；层栈清空后 → null', () => {
        const inst = makeKeyInst();
        inst._activeLayerId = 1;
        expect(inst._keyDeleteTarget()).toEqual({ kind: 'layer', id: 1 });
        inst.draft.drawLayers = [];
        expect(inst._keyDeleteTarget()).toBeNull();
    });
});

describe('MangaEditor 右栏分区收纳（MangaDom._buildOutRail）', () => {
    /** 极简元素桩：按钮记 is-active 与 click 处理器，分区记 hidden */
    function makeEl(sec, isBtn) {
        const e = {
            dataset: sec ? { outSec: sec } : {},
            hidden: false,
            active: false,
            classList: {
                contains: (c) => isBtn && c === 'manga-out-toggle',
                toggle: (c, v) => { e.active = !!v; }
            },
            hasAttribute: () => false,
            setAttribute() {},
            clicks: [],
            addEventListener(_t, fn) { e.clicks.push(fn); }
        };
        return e;
    }

    function makeOutInst(state) {
        const inst = makeInstance([]);
        inst._outSections = state;
        inst._body = makeEl(null, false);
        inst._secSize = makeEl('size', false);
        inst._secOut = makeEl('output', false);
        inst._btnSize = makeEl('size', true);
        inst._btnOut = makeEl('output', true);
        const side = {
            _collapsed: null,
            classList: { toggle: (_c, v) => { side._collapsed = !!v; } },
            querySelector: (sel) => sel === '.manga-out-body' ? inst._body : null,
            querySelectorAll: (sel) => sel === '[data-out-sec]'
                ? [inst._secSize, inst._secOut, inst._btnSize, inst._btnOut] : []
        };
        const rail = {
            querySelectorAll: (sel) => sel === '.manga-out-toggle'
                ? [inst._btnSize, inst._btnOut] : []
        };
        inst.dialog = {
            querySelector: (sel) => sel === '.manga-out-side' ? side
                : sel === '.manga-out-rail' ? rail : null
        };
        return inst;
    }

    test('独立开关：点图标翻转分区显隐并持久化 localStorage', () => {
        const inst = makeOutInst({ size: true, output: true });
        inst._buildOutRail();
        expect(inst._body.hidden).toBe(false);       // 默认全开
        expect(inst._secSize.hidden).toBe(false);
        inst._btnSize.clicks[0]();                   // 收起「画幅+模式」
        expect(inst._outSections.size).toBe(false);
        expect(inst._secSize.hidden).toBe(true);
        expect(inst._btnSize.active).toBe(false);    // 图标熄灭
        expect(JSON.parse(context.localStorage.getItem('lumenLight.mangaOutSections')))
            .toEqual({ size: false, output: true });
        inst._btnSize.clicks[0]();                   // 再点展开
        expect(inst._outSections.size).toBe(true);
        expect(inst._secSize.hidden).toBe(false);
    });

    test('全收起：分区主体隐藏 + is-collapsed 放开右栏宽度；展开任一栏恢复', () => {
        const inst = makeOutInst({ size: true, output: true });
        inst._buildOutRail();
        inst._btnSize.clicks[0]();
        inst._btnOut.clicks[0]();
        expect(inst._body.hidden).toBe(true);
        const side = inst.dialog.querySelector('.manga-out-side');
        expect(side._collapsed).toBe(true);
        inst._btnOut.clicks[0]();
        expect(inst._body.hidden).toBe(false);
        expect(side._collapsed).toBe(false);
    });

    test('恢复呈现：构造恢复的收起态由 _applyOutSections 正确落到分区', () => {
        const inst = makeOutInst({ size: false, output: true });
        inst._applyOutSections();
        expect(inst._secSize.hidden).toBe(true);
        expect(inst._secOut.hidden).toBe(false);
        expect(inst._btnSize.active).toBe(false);
        expect(inst._btnOut.active).toBe(true);
        expect(inst._body.hidden).toBe(false);       // 还有 output 开着
    });
});

describe('漫画编辑器中键拖动平移（ADR 077）', () => {
    function makePanInst() {
        const inst = Object.create(MangaEditor.prototype);
        inst.draft = { width: 1024, height: 1024, items: [] };
        inst.stageCv = {
            classList: {
                _s: new Set(),
                add(c) { this._s.add(c); },
                remove(c) { this._s.delete(c); },
                contains(c) { return this._s.has(c); }
            },
            setPointerCapture() {},
            getBoundingClientRect: () => ({ left: 0, top: 0 }),
            style: {}
        };
        inst._view = { scale: 1, ox: 0, oy: 0 };
        inst._panX = 0;
        inst._panY = 0;
        inst._renderStageCalls = 0;
        inst._renderStage = () => { inst._renderStageCalls++; };
        inst._syncBrushCursorCalls = 0;
        inst._syncBrushCursor = () => { inst._syncBrushCursorCalls++; };
        return inst;
    }

    const midDown = (x, y) => ({ button: 1, pointerId: 5, clientX: x, clientY: y, preventDefault() { this.prevented = true; } });
    const move = (x, y) => ({ clientX: x, clientY: y });

    test('中键按下：建平移态 + 加 grabbing 类 + 拦默认行为', () => {
        const inst = makePanInst();
        const e = midDown(100, 80);
        inst._onPointerDown(e);
        expect(inst._panning).toEqual({ x: 100, y: 80 });
        expect(inst.stageCv.classList.contains('panning')).toBe(true);
        expect(e.prevented).toBe(true);
    });

    test('拖动累加视口偏移且起点随步更新；松手清理并恢复光标', () => {
        const inst = makePanInst();
        inst._onPointerDown(midDown(100, 80));
        inst._onPointerMove(move(130, 90));
        expect(inst._panX).toBe(30);
        expect(inst._panY).toBe(10);
        expect(inst._renderStageCalls).toBe(1);
        expect(inst._panning).toEqual({ x: 130, y: 90 });   // 起点随步更新（增量模型）
        inst._onPointerMove(move(125, 96));
        expect(inst._panX).toBe(25);
        expect(inst._panY).toBe(16);
        inst._onPointerUp(move(125, 96));
        expect(inst._panning).toBeNull();
        expect(inst.stageCv.classList.contains('panning')).toBe(false);
        expect(inst._syncBrushCursorCalls).toBe(1);
        expect(inst._panX).toBe(25);                        // 偏移保留（不回弹）
    });

    test('左键手势进行中中键被忽略；_cancelDrag 清理平移态', () => {
        const inst = makePanInst();
        inst._stroke = { layerId: 1, points: [1, 1] };
        const e = midDown(100, 80);
        inst._onPointerDown(e);
        expect(inst._panning).toBeUndefined();              // 未建立
        expect(e.prevented).toBeUndefined();
        expect(inst.stageCv.classList.contains('panning')).toBe(false);
        inst._stroke = null;
        inst._onPointerDown(midDown(10, 10));
        inst._cancelDrag();
        expect(inst._panning).toBeNull();
        expect(inst.stageCv.classList.contains('panning')).toBe(false);
        expect(inst._syncBrushCursorCalls).toBe(1);
    });
});
