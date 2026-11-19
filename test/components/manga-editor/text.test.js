/**
 * text 测试（2026-11-09 自 mangaEditor.test.js 按模块拆分）
 * 覆盖：MangaEditor 文字工具与文字图层（MangaText，自灯箱复刻 ADR 066）
 */

const { context, MangaEditor, CoordinateLayout, makeInstance } = require('./helpers');

describe('MangaEditor 文字工具与文字图层（MangaText，自灯箱复刻 ADR 066）', () => {
    /** 文字测量桩：确定性布局（宽=字符数×10、fontBoundingBox 20/5），
     *  横竖排/半行距/CHAR_ADV 的断言全部基于这套数字 */
    function makeTextDoc() {
        const ctx2d = () => ({
            font: '', fillStyle: '', textAlign: '', textBaseline: '',
            globalAlpha: 1, globalCompositeOperation: 'source-over',
            measureText: (s) => ({
                width: String(s).length * 10,
                fontBoundingBoxAscent: 20, fontBoundingBoxDescent: 5
            }),
            fillText() {}, save() {}, restore() {}, translate() {}, scale() {},
            rotate() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
            moveTo() {}, lineTo() {}, setLineDash() {}, strokeRect() {},
            clearRect() {}, drawImage() {}, rect() {}, clip() {}, setTransform() {}
        });
        return {
            body: { appendChild() {} },
            addEventListener() {},
            createElement(tag) {
                if (tag === 'canvas') return { width: 0, height: 0, getContext: () => ctx2d() };
                if (tag === 'textarea') {
                    return {
                        value: '', spellcheck: false, className: '', style: {},
                        addEventListener() {}, focus() {}, select() {},
                        parentNode: null, remove() { this.parentNode = null; }
                    };
                }
                return {};
            }
        };
    }

    /** 文字工具用例实例：文字状态字段 + 舞台/持久化桩（含 stageCv
     *  parentElement 供就地编辑框挂载） */
    function makeTextInst() {
        const inst = makeInstance([]);
        inst.activeTool = 'text';
        inst._textOpts = { font: 'TestFont', size: 40, vertical: false };
        inst._textColor = '#ff5a5a';
        inst._textEdit = null;
        inst._view = { scale: 1, ox: 0, oy: 0 };
        inst._activeLayerId = null;
        inst._selLayerId = null;
        inst._layerImgCache = new Map();
        inst._nextLayerId = 1;
        inst._guides = [];
        inst._stroke = null;
        inst.stageCv = {
            style: {},
            setPointerCapture() {},
            getBoundingClientRect: () => ({ left: 0, top: 0 }),
            parentElement: { appendChild(el) { el.parentNode = this; } }
        };
        inst._scheduleSave = () => {};
        inst._scheduleThumbRefresh = () => {};
        return inst;
    }

    const pageBase = (w = 200, h = 200) => ({
        width: w, height: h,
        bbox_coord_space: 'abs', bbox_format: 'xyxy',
        summary: { caption: '', canvas: 'single' },
        items: []
    });

    beforeEach(() => { context.document = makeTextDoc(); });
    afterEach(() => { delete context.document; });

    test('_measureTextLayout：横排=最长行×行数×行距；竖排=CJK 逐字 CHAR_ADV+西文段测宽', () => {
        const inst = makeTextInst();
        const h = inst._measureTextLayout(
            { content: 'AB\nCD', font: 'TestFont', size: 40, vertical: false });
        expect(h.pad).toBe(12);              // ceil(40×0.3)：渲染周边距
        expect(h.w).toBe(40);                // max(最长行 20, 字号 40)
        expect(h.h).toBeCloseTo(112);        // 2 行 × 40 × 1.4（LINE_H）
        const v = inst._measureTextLayout(
            { content: 'AB字', font: 'TestFont', size: 40, vertical: true });
        expect(v.w).toBeCloseTo(56);         // 1 列 × 40 × 1.4
        expect(v.h).toBeCloseTo(66);         // 西文段 20 + CJK 1 字 40×1.15=46
    });

    test('addTextLayer：记录形态（选项默认值/scale=1/插层栈顶）', () => {
        const inst = makeTextInst();
        const layer = inst.addTextLayer(10, 20);
        expect(inst.draft.drawLayers).toHaveLength(1);
        expect(layer).toMatchObject({
            name: `文字 ${layer.id}`, visible: true,
            text: {
                content: '', font: 'TestFont', size: 40, vertical: false,
                color: '#ff5a5a', x: 10, y: 20, scale: 1
            }
        });
    });

    test('文字工具路由：空白新建就地编辑 → 输入即写草稿 → 提交入账「新建文字」并随内容更名', () => {
        const inst = makeTextInst();
        inst._textStart(30, 30);
        expect(inst._textEdit).not.toBe(null);
        expect(inst._textEdit.isNew).toBe(true);
        expect(inst._selLayerId).toBe(inst._textEdit.layer.id);   // 舞台选中（锚点/不透明度目标）
        inst._textEdit.ta.value = '你好\n世界';
        inst._onTextEditorInput();
        expect(inst.draft.drawLayers[0].text.content).toBe('你好\n世界');
        const undoBefore = inst._undoStack.length;
        inst._commitTextEdit();
        expect(inst._textEdit).toBe(null);
        expect(inst.draft.drawLayers[0].name).toBe('你好');       // 首行前 12 字（PS 同款）
        expect(inst._undoStack.length).toBe(undoBefore + 1);
        expect(inst._undoStack.at(-1).label).toBe('新建文字');
    });

    test('点击已有文字层重编辑（全选替换语义）：提交入账「编辑文字」', () => {
        const inst = makeTextInst();
        const layer = inst.addTextLayer(10, 10);
        layer.text.content = '原图层名';
        layer.name = '原图层名';
        inst._textStart(15, 15);   // 包围盒 [10,10,74,90] 内
        expect(inst._textEdit).not.toBe(null);
        expect(inst._textEdit.isNew).toBe(false);
        expect(inst._textEdit.ta.value).toBe('原图层名');
        inst._textEdit.ta.value = '改后的文字';
        inst._onTextEditorInput();
        inst._commitTextEdit();
        expect(inst._undoStack.at(-1).label).toBe('编辑文字');
        expect(inst.draft.drawLayers[0].text.content).toBe('改后的文字');
    });

    test('空内容提交=新建层静默摘除（零历史）/重编辑恢复原文字；Esc 取消同语义', () => {
        const inst = makeTextInst();
        inst._textStart(30, 30);
        const undoBefore = inst._undoStack.length;
        inst._commitTextEdit();                       // 新建层空提交
        expect(inst.draft.drawLayers).toHaveLength(0);
        expect(inst._textEdit).toBe(null);
        expect(inst._undoStack.length).toBe(undoBefore);
        const layer = inst.addTextLayer(0, 0);
        layer.text.content = '保留';
        inst._textStart(5, 5);                        // 重编辑
        inst._textEdit.ta.value = '';
        inst._onTextEditorInput();
        inst._commitTextEdit();
        expect(layer.text.content).toBe('保留');      // 不留隐形空层
        inst._textStart(5, 5);
        inst._textEdit.ta.value = '改动';
        inst._onTextEditorInput();
        inst._cancelTextEdit();                       // Esc
        expect(layer.text.content).toBe('保留');
        expect(inst._textEdit).toBe(null);
    });

    test('_drawPageLayers 文字分支：属性绘进舞台；编辑中的层跳过（textarea 呈现）', () => {
        const inst = makeTextInst();
        const fillCalls = [];
        const ctx = {
            globalAlpha: 1,
            fillText: (...a) => fillCalls.push(a),
            save() {}, restore() {}, translate() {}, scale() {}, rotate() {},
            beginPath() {}, rect() {}, clip() {}, setLineDash() {}, strokeRect() {},
            arc() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {},
            measureText: (s) => ({
                width: String(s).length * 10,
                fontBoundingBoxAscent: 20, fontBoundingBoxDescent: 5
            }),
            setTransform() {}
        };
        inst.draft.drawLayers = [{
            id: 1, name: '文字 1', visible: true,
            text: { content: 'AB', font: 'TestFont', size: 40, vertical: false, color: '#fff', x: 5, y: 5, scale: 1 }
        }];
        inst._drawPageLayers(ctx, (x) => x, (y) => y, 1, inst.draft);
        expect(fillCalls.length).toBeGreaterThanOrEqual(1);
        fillCalls.length = 0;
        inst._textEdit = { layer: inst.draft.drawLayers[0] };
        inst._drawPageLayers(ctx, (x) => x, (y) => y, 1, inst.draft);
        expect(fillCalls).toHaveLength(0);   // 编辑中舞台跳过
    });

    test('_layerBounds：随 text.scale 等比、pad 计入；空文字不参与命中', () => {
        const inst = makeTextInst();
        const layer = inst.addTextLayer(0, 0);
        layer.text.content = '字';           // 1 字：w=max(10,40)=40 → bw=40+24=64；h=56 → bh=80
        expect(inst._layerBounds(layer)).toEqual([0, 0, 64, 80]);
        layer.text.scale = 2;
        expect(inst._layerBounds(layer)).toEqual([0, 0, 128, 160]);
        layer.text.content = '';
        expect(inst._hitImageLayer(5, 5)).toBe(null);
        expect(inst._hitTextLayerAt(5, 5)).toBe(null);
    });

    test('select 工具手势：拖动平移 text.x/y 并入账「移动文字」；锚点缩放等比写 text.scale、对侧边锚定；打断回滚三件套', () => {
        const inst = makeTextInst();
        inst.activeTool = 'select';
        const layer = inst.addTextLayer(10, 10);
        layer.text.content = '字';
        inst._selLayerId = layer.id;
        const bounds = inst._layerBounds(layer);
        expect(bounds).toEqual([10, 10, 74, 90]);
        inst._drag = {
            mode: 'layer-move', layerId: layer.id, moved: false,
            orig: bounds.slice(), origGeom: { x: 10, y: 10, scale: 1 },
            start: { x: 10, y: 10 }, histSnap: inst._histSnapshot()
        };
        inst._onPointerMove({ clientX: 200, clientY: 60 });
        expect(layer.text.x).toBe(200);      // 包围盒左上角=text.x/y
        expect(layer.text.y).toBe(60);
        inst._onPointerUp({ clientX: 200, clientY: 60 });
        expect(inst._undoStack.at(-1).label).toBe('移动文字');
        inst._drag = {
            mode: 'layer-resize', layerId: layer.id, anchor: 'se',
            orig: inst._layerBounds(layer).slice(),
            origGeom: { x: layer.text.x, y: layer.text.y, scale: 1 },
            histSnap: inst._histSnapshot()
        };
        inst._onPointerMove({ clientX: layer.text.x + 128, clientY: layer.text.y + 160 });
        expect(layer.text.scale).toBeCloseTo(2);   // rx=128/64=2、ry=160/80=2（等比锁纵横）
        expect(layer.text.x).toBe(200);            // se 角：左上角锚定不动
        inst._cancelDrag();
        expect(layer.text.scale).toBe(1);          // 指针打断回滚 x/y/scale 三件套
        expect(layer.text.x).toBe(200);
        expect(layer.text.y).toBe(60);
    });

    test('文字层拖动可出画幅（灯箱同款，ADR 070）：右缘拖出不回弹', () => {
        const inst = makeTextInst();
        inst.activeTool = 'select';
        const layer = inst.addTextLayer(900, 100);
        layer.text.content = '字';
        inst._selLayerId = layer.id;
        const bounds = inst._layerBounds(layer);
        inst._drag = {
            mode: 'layer-move', layerId: layer.id, moved: false,
            orig: bounds.slice(), origGeom: { x: 900, y: 100, scale: 1 },
            start: { x: 900, y: 100 }, histSnap: inst._histSnapshot()
        };
        inst._onPointerMove({ clientX: 1100, clientY: 100 });   // +200px：拖出右缘
        expect(layer.text.x).toBe(1100);
        expect(inst._layerBounds(layer)[2]).toBeGreaterThan(1024);   // 出界成功
    });

    test('_setTool：text 进白名单（I 形光标）；离开文字工具先提交在途编辑', () => {
        const inst = makeTextInst();
        inst.activeTool = 'select';          // 从 select 切过去（同值早退不发光标）
        inst._setTool('text');
        expect(inst.activeTool).toBe('text');
        expect(inst.stageCv.style.cursor).toBe('text');
        inst._textStart(30, 30);
        inst._textEdit.ta.value = '未提交';
        inst._onTextEditorInput();
        inst._setTool('brush');
        expect(inst._textEdit).toBe(null);
        expect(inst.draft.drawLayers[0].text.content).toBe('未提交');
        expect(inst._undoStack.at(-1).label).toBe('新建文字');
        inst._setTool('bogus');
        expect(inst.activeTool).toBe('brush');
    });

    test('_normalizeDocument 直收文字层（text 字段透传不剥离）', () => {
        const inst = makeTextInst();
        const textLayer = {
            id: 9, name: '文字 9', visible: true,
            text: { content: '台词', font: 'KaiTi', size: 30, vertical: true, color: '#fff', x: 3, y: 4, scale: 1.5 }
        };
        const doc = inst._normalizeDocument(
            { pages: [Object.assign(pageBase(), { drawLayers: [textLayer] })], active: 0 });
        expect(doc.pages[0].drawLayers[0].text).toEqual(textLayer.text);
    });

    test('形态通用化收口：文字层纳入不透明度目标/复制接管（副本插上方并选中）', () => {
        const inst = makeTextInst();
        const layer = inst.addTextLayer(0, 0);
        layer.text.content = '字';
        inst._selLayerId = layer.id;
        expect(inst._currentEditableLayer()).toBe(layer);
        inst._duplicateLayer(layer.id);
        expect(inst.draft.drawLayers).toHaveLength(2);
        expect(inst.draft.drawLayers[1].text.content).toBe('字');
        expect(inst.draft.drawLayers[1].name).toBe('文字 1 副本');
        expect(inst._selLayerId).toBe(inst.draft.drawLayers[1].id);   // 复制接管=选中
    });
});
