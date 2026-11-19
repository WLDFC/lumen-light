/**
 * tools 测试（2026-11-09 自 mangaEditor.test.js 按模块拆分）
 * 覆盖：MangaEditor 工具栏与画笔（MangaTools）；MangaEditor 色板与 setColor 分派（MangaTools，ADR 068）
 */

const { context, MangaEditor, CoordinateLayout, makeInstance } = require('./helpers');

describe('MangaEditor 工具栏与画笔（MangaTools）', () => {
    /** 页构造器（多页 describe 里的 mkPage 不在本块作用域，本地同款） */
    const mkBrushPage = (w = 1024, h = 1024) => ({
        width: w, height: h,
        bbox_coord_space: 'abs', bbox_format: 'xyxy',
        summary: { caption: '', canvas: 'single' },
        items: []
    });

    /** 画笔纯逻辑用实例：_view 恒等映射（草稿坐标=舞台坐标），存档/缩略图打桩 */
    function makeBrushInst() {
        const inst = makeInstance([]);
        inst.activeTool = 'select';
        inst._stroke = null;
        inst._brushColor = '#ff5a5a';
        inst._brushWidth = 4;
        inst._view = { scale: 1, ox: 0, oy: 0 };
        inst._activeLayerId = null;
        inst._selLayerId = null;
        inst._layerImgCache = new Map();
        inst._nextLayerId = 1;
        inst.stageCv = { style: {}, setPointerCapture() {} };
        inst._scheduleSave = () => {};
        inst._scheduleThumbRefresh = () => {};
        return inst;
    }

    test('画笔生命周期：笔迹写进活动图层（无层自动建）并入历史', () => {
        const inst = makeBrushInst();
        inst._brushStart(10, 10);
        const layers = inst.draft.drawLayers;
        expect(Array.isArray(layers)).toBe(true);
        expect(layers.length).toBe(1);                    // 无层自动建「图层 1」
        expect(inst._stroke.layerId).toBe(layers[0].id);
        inst._brushMove(10.5, 10.5);        // <1 草稿像素：不动笔
        expect(inst._stroke.points.length).toBe(2);
        inst._brushMove(30, 25);
        inst._brushMove(50, 20);
        expect(inst._stroke.points.length).toBe(6);
        const before = inst._undoStack.length;
        inst._brushEnd();
        expect(inst._stroke).toBe(null);
        expect(layers[0].strokes.length).toBe(1);
        expect(layers[0].strokes[0]).toMatchObject({ color: '#ff5a5a', width: 4 });
        expect(inst._undoStack.length).toBe(before + 1);   // 一笔一计入账
    });

    test('单点也保留（点击=点迹）；空收笔/作废安全', () => {
        const inst = makeBrushInst();
        inst._brushStart(5, 5);
        inst._brushEnd();                    // 没有运笔：单点也落
        expect(inst.draft.drawLayers[0].strokes.length).toBe(1);
        expect(inst.draft.drawLayers[0].strokes[0].points).toEqual([5, 5]);
        inst._stroke = null;
        expect(() => inst._brushEnd()).not.toThrow();
        expect(() => inst._cancelStroke()).not.toThrow();
    });

    test('橡皮：起笔带 erase 标记，收笔条目落 erase、入账标签「橡皮」', () => {
        const inst = makeBrushInst();
        inst.activeTool = 'eraser';
        inst._brushStart(10, 10);
        expect(inst._stroke.erase).toBe(true);
        inst._brushMove(60, 40);
        inst._brushEnd();
        const entry = inst.draft.drawLayers[0].strokes[0];
        expect(entry.erase).toBe(true);       // 渲染走层内 destination-out 的依据
        expect(inst._undoStack.length).toBe(1);
        expect(inst._undoStack[0].label).toBe('橡皮');
    });

    test('橡皮在图片层：烘焙进 src（条目退役、撤销栈回滚旧 src）', async () => {
        const inst = makeBrushInst();
        inst.draft.drawLayers = [
            { id: 7, name: '图片 1', visible: true, image: { src: '/api/assets/orig', bbox: [0, 0, 832, 1216] } }
        ];
        inst._selLayerId = 7;
        inst.activeTool = 'eraser';
        // canvas/document 桩：烘焙重绘与 toDataURL（vm 无 DOM）；
        // fetch 桩：/api/assets 返回新引用（本套件不在持久化套件的桩作用域内）
        const ctx2d = {
            globalCompositeOperation: 'source-over', lineJoin: '', lineCap: '',
            lineWidth: 1, strokeStyle: '', fillStyle: '',
            drawImage() {}, clearRect() {}, setTransform() {}, beginPath() {}, arc() {},
            stroke() {}, fill() {}, moveTo() {}, lineTo() {}, setLineDash() {},
            fillRect() {}, strokeRect() {}, rect() {}, clip() {}, save() {}, restore() {}
        };
        context.document = {
            createElement: (tag) => tag === 'canvas'
                ? { width: 0, height: 0, getContext: () => ctx2d, toDataURL: () => 'data:image/png;base64,BAKE' }
                : {}
        };
        context.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', url: '/api/assets/baked' }) });
        try {
            inst._brushStart(10, 10);
            inst._brushMove(300, 200);
            inst._brushEnd();
            expect(inst.draft.drawLayers[0].strokes.length).toBe(1);   // 烘焙前条目驱动擦除
            await new Promise((r) => setTimeout(r, 0));                // 烘焙链+fetch 落定
            expect(inst.draft.drawLayers[0].image.src).toBe('/api/assets/baked');
            expect(inst.draft.drawLayers[0].strokes.length).toBe(0);   // 条目退役：擦除已由 src 承接
            expect(inst._undoStack.at(-1).label).toBe('橡皮');
        } finally {
            delete context.document;
            delete context.fetch;
        }
    });

    test('选中图片层落笔：笔迹进图片层（PS 语义），不再自动新建层', () => {
        const inst = makeBrushInst();
        inst.draft.drawLayers = [
            { id: 7, name: '图片 1', visible: true, image: { src: 'x', bbox: [0, 0, 832, 1216] } }
        ];
        inst._selLayerId = 7;
        inst._activeLayerId = null;
        inst._brushStart(10, 10);
        expect(inst._stroke.layerId).toBe(7);                     // 落在选中图片层
        expect(Array.isArray(inst.draft.drawLayers[0].strokes)).toBe(true);  // 首笔扩出笔迹数组
        inst._brushMove(70, 50);
        inst._brushEnd();
        expect(inst.draft.drawLayers).toHaveLength(1);            // 不自动新建
        expect(inst.draft.drawLayers[0].strokes.length).toBe(1);
        expect(inst.draft.drawLayers[0].strokes[0].points.length).toBe(4);
        // 取消选中且无纯笔迹层：回落自动建层路径照旧（新层是纯笔迹层）
        inst._selLayerId = null;
        inst._brushStart(5, 5);
        expect(inst._stroke.layerId).not.toBe(7);                 // 新建纯笔迹层接笔
        expect(inst.draft.drawLayers).toHaveLength(2);
        inst._brushMove(20, 20);
        inst._brushEnd();
        expect(inst.draft.drawLayers[1].strokes.length).toBe(1);
    });

    test('_draftForCompile 剥离 strokes 与 drawLayers（原稿不动）', () => {
        const inst = makeBrushInst();
        inst.draft.drawLayers = [{ id: 1, name: '图层 1', visible: true, strokes: [] }];
        inst.draft.strokes = [{ color: '#fff', width: 4, points: [1, 2] }];
        const out = inst._draftForCompile();
        expect('strokes' in out).toBe(false);
        expect('drawLayers' in out).toBe(false);
        expect(inst.draft.drawLayers.length).toBe(1);
    });

    test('_normalizeDocument：旧平铺 strokes 迁移为单个笔迹图层；drawLayers 直收', () => {
        const inst = makeBrushInst();
        const legacy = {
            pages: [Object.assign(mkBrushPage(832, 1216), {
                strokes: [{ color: '#fff', width: 4, points: [1, 2, 3, 4] }]
            })],
            active: 0
        };
        const doc = inst._normalizeDocument(legacy);
        expect(doc.pages[0].drawLayers.length).toBe(1);
        expect(doc.pages[0].drawLayers[0].strokes.length).toBe(1);
        expect(doc.pages[0].strokes).toBeUndefined();

        const layers = [{ id: 5, name: '图片 5', visible: true, image: { src: '/api/assets/a', bbox: [0, 0, 10, 10] } }];
        const doc2 = inst._normalizeDocument(
            { pages: [Object.assign(mkBrushPage(), { drawLayers: layers })], active: 0 });
        expect(doc2.pages[0].drawLayers).toEqual(layers);
    });

    test('_setTool 切换与守卫：未知工具忽略；切换收掉进行中笔迹', () => {
        const inst = makeBrushInst();
        inst._setTool('brush');
        expect(inst.activeTool).toBe('brush');
        inst._setTool('bogus');
        expect(inst.activeTool).toBe('brush');
        inst._brushStart(1, 1);
        inst._setTool('select');
        expect(inst._stroke).toBe(null);     // 切工具收掉进行中笔迹
        expect(inst.activeTool).toBe('select');
    });

    // ---- 抠图（动作型：选中图片层就地写回，自灯箱迁移） ----

    /** 抠图用例环境：选中图片层 + rembg/资产/模型桩 */
    function makeCutoutInst() {
        const inst = makeBrushInst();
        inst.draft.drawLayers = [
            { id: 1, name: '图片 1', visible: true, image: { src: '/api/assets/in.png', bbox: [0, 0, 100, 100] } },
            { id: 2, name: '图层 2', visible: true, strokes: [] }
        ];
        inst._selLayerId = 1;
        inst._uploadToAssets = async (dataUrl, name) => {
            inst._uploads = inst._uploads || [];
            inst._uploads.push({ dataUrl, name });
            return '/api/assets/cutout.png';
        };
        return inst;
    }
    const REMBG_OK = { status: 'ok', image: 'data:image/png;base64,out', cost: 2345, provider: 'dml' };

    beforeEach(() => {
        context.window.SettingsManager = { getActiveRembgModel: () => 'rmbg-1.4' };
        context.window.ImageExport = { toDataUrl: async (img, src) => (
            src.startsWith('data:') ? src : 'data:image/png;base64,conv') };
    });

    afterEach(() => {
        delete context.window.SettingsManager;
        delete context.window.ImageExport;
    });

    test('未选中图片层：拦截提示，不发请求', async () => {
        const inst = makeCutoutInst();
        inst._selLayerId = null;
        const fetched = [];
        context.fetch = async (url) => { fetched.push(url); };
        await inst._cutoutSelectedLayer();
        expect(fetched).toHaveLength(0);
        expect(inst.statusCalls.at(-1).isError).toBe(true);
        expect(inst.statusCalls.at(-1).text).toContain('请先选中图片图层');
    });

    test('抠图 happy path：URL 转 dataURL 提交 → 结果入资产库写回该层并入历史', async () => {
        const inst = makeCutoutInst();
        const bodies = [];
        context.fetch = async (url, opts) => {
            bodies.push({ url, body: JSON.parse(opts.body) });
            return { ok: true, json: async () => REMBG_OK };
        };
        const undoBefore = inst._undoStack.length;
        await inst._cutoutSelectedLayer();
        expect(bodies).toHaveLength(1);
        expect(bodies[0].url).toBe('/api/rembg');
        expect(bodies[0].body).toMatchObject({
            imageData: 'data:image/png;base64,conv',   // 资产 URL 经 ImageExport 转 dataURL
            model: 'rmbg-1.4'
        });
        expect(inst._uploads[0].dataUrl).toBe(REMBG_OK.image);
        expect(inst.draft.drawLayers[0].image.src).toBe('/api/assets/cutout.png');   // 就地写回
        expect(inst.draft.drawLayers[0].image.bbox).toEqual([0, 0, 100, 100]);       // bbox 不动
        expect(inst._undoStack.length).toBe(undoBefore + 1);                         // 入历史可撤销
        expect(inst.statusCalls.at(-1).text).toContain('抠图完成');
        expect(inst.statusCalls.at(-1).text).toContain('dml');
        expect(inst._removingBg).toBe(false);        // finally 复位
        clearTimeout(inst._cutoutMsgTimer);          // 状态自动清除定时器不挂着
    });

    test('接口报错：状态栏报错，层不动，不误入历史', async () => {
        const inst = makeCutoutInst();
        context.fetch = async () => ({ ok: true, json: async () => ({ status: 'error', message: '模型未下载' }) });
        const undoBefore = inst._undoStack.length;
        await inst._cutoutSelectedLayer();
        expect(inst.draft.drawLayers[0].image.src).toBe('/api/assets/in.png');
        expect(inst._undoStack.length).toBe(undoBefore);
        expect(inst.statusCalls.at(-1).isError).toBe(true);
        expect(inst.statusCalls.at(-1).text).toContain('抠图失败');
        expect(inst.statusCalls.at(-1).text).toContain('模型未下载');
        expect(inst._removingBg).toBe(false);
    });
});

describe('MangaEditor 色板与 setColor 分派（MangaTools，ADR 068）', () => {
    /** 色板用例实例：画笔桩 + 文字/色板状态字段（localStorage 用共享桩；
     *  vm 无 DOM，取色器不建、网格桩置空——setColor/pushRecentColor 的
     *  纯数据路径零 DOM 依赖） */
    function makePaletteInst() {
        const inst = makeInstance([]);
        inst.activeTool = 'brush';
        inst._stroke = null;
        inst._brushColor = '#ff5a5a';
        inst._brushWidth = 4;
        inst._view = { scale: 1, ox: 0, oy: 0 };
        inst._activeLayerId = null;
        inst._selLayerId = null;
        inst._layerImgCache = new Map();
        inst._nextLayerId = 1;
        inst.stageCv = { style: {}, setPointerCapture() {} };
        inst._scheduleSave = () => {};
        inst._scheduleThumbRefresh = () => {};
        inst.recentColors = [];
        inst._colorPicker = null;
        inst._textOpts = { font: 'TestFont', size: 40, vertical: false };
        inst._textColor = '#ff5a5a';
        inst._textEdit = null;
        inst._paletteGridEl = null;
        return inst;
    }

    test('color getter 与 setColor 分派：画笔工具落笔色、文字工具落文字色', () => {
        const inst = makePaletteInst();
        inst.activeTool = 'brush';
        expect(inst.color).toBe('#ff5a5a');
        inst.setColor('#123456');
        expect(inst._brushColor).toBe('#123456');
        expect(inst._textColor).toBe('#ff5a5a');                       // 文字色不被带偏
        expect(context.localStorage.getItem('lumenLight.mangaBrushColor')).toBe('#123456');
        inst.activeTool = 'text';
        expect(inst.color).toBe('#ff5a5a');
        inst.setColor('#abcdef');
        expect(inst._textColor).toBe('#abcdef');
        expect(inst._brushColor).toBe('#123456');
        expect(context.localStorage.getItem('lumenLight.mangaTextColor')).toBe('#abcdef');
    });

    test('文字工具下选色写目标层（选中文字层优先）并即时同步编辑框', () => {
        const inst = makePaletteInst();
        inst.draft.drawLayers = [{
            id: 3, name: '文字 3', visible: true,
            text: { content: '字', font: 'TestFont', size: 40, vertical: false, color: '#ff5a5a', x: 0, y: 0, scale: 1 }
        }];
        inst._selLayerId = 3;
        inst.activeTool = 'text';
        inst.setColor('#7ce38b');
        expect(inst.draft.drawLayers[0].text.color).toBe('#7ce38b');   // 目标层实时生效
    });

    test('pushRecentColor：新色入列、重复与预设跳过（防洗牌）、上限裁剪', () => {
        const inst = makePaletteInst();
        inst.pushRecentColor('#111111');
        inst.pushRecentColor('#222222');
        inst.pushRecentColor('#111111');                               // 重复不入列
        expect(inst.recentColors).toEqual(['#222222', '#111111']);
        inst.pushRecentColor('#ef4444');                               // 预设色跳过
        expect(inst.recentColors).toEqual(['#222222', '#111111']);
        inst.pushRecentColor('#333333');
        inst.pushRecentColor('#444444');
        inst.pushRecentColor('#555555');                               // 第 5 个 → 裁到 4
        expect(inst.recentColors).toEqual(
            ['#555555', '#444444', '#333333', '#222222']);
    });

    test('_normalizeHexColor：六位 hex 原样保留（大小写不拘），其余回落默认', () => {
        const N = MangaEditor._normalizeHexColor;
        expect(N('#AbCdEf', 'fb')).toBe('#AbCdEf');
        expect(N('#123456', 'fb')).toBe('#123456');
        expect(N('#fff', 'fb')).toBe('fb');        // 三位缩写不收
        expect(N('123456', 'fb')).toBe('fb');      // 缺 # 不收
        expect(N('#12345', 'fb')).toBe('fb');
        expect(N('garbage', 'fb')).toBe('fb');
        expect(N(null, 'fb')).toBe('fb');
        expect(N(undefined, 'fb')).toBe('fb');
    });
});
