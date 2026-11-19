/**
 * layers 测试（2026-11-09 自 mangaEditor.test.js 按模块拆分）
 * 覆盖：MangaEditor 图层：遮挡选层与顺序操作（ADR 017 决策十）；MangaEditor 图层系统（MangaLayers）；MangaLayers._ensureDefaultLayerSelection 默认选中（ADR 074 补遗：灯箱同语义）；MangaLayers 文件菜单（ADR 075 自灯箱 StudioImport 迁移）
 */

const { context, MangaEditor, CoordinateLayout, makeInstance } = require('./helpers');

describe('MangaEditor 图层：遮挡选层与顺序操作（ADR 017 决策十）', () => {
    // 视口 1:1（scale=1, 偏移 0），bbox 即舞台像素坐标
    function makeLayerInst() {
        const inst = Object.create(MangaEditor.prototype);
        inst.draft = {
            width: 1024, height: 1024,
            bbox_coord_space: 'abs', bbox_format: 'xyxy',
            summary: { caption: '', canvas: 'single' },
            items: [
                { label: 'object', caption: '底层小框', bbox: [100, 100, 300, 300] },
                { label: 'object', caption: '中层框', bbox: [150, 150, 400, 400] },
                { label: 'object', caption: '顶层大框', bbox: [200, 200, 900, 900] }
            ]
        };
        inst._view = { scale: 1, ox: 0, oy: 0 };
        inst.selected = -1;
        inst._clickBurst = null;
        inst._hiddenCids = new Set();   // 眼睛隐藏态（_stackAt 命中过滤用）
        inst._undoStack = [];   // 图层操作会入账历史
        inst._redoStack = [];
        inst.statusCalls = [];
        inst._status = (text, isError) => inst.statusCalls.push({ text, isError });
        inst.renderCalls = 0;
        inst._renderItems = () => { inst.renderCalls++; };
        inst._renderStage = () => { inst.renderCalls++; };
        inst._scheduleSave = () => {};
        inst.compiled = null;
        inst.copyBtn = { disabled: false };
        inst.aiOutTa = { value: '' };
        inst.jsonNote = { textContent: '' };
        inst._outMode = '';
        return inst;
    }

    test('_stackAt：重叠点按层顶→底返回（索引降序），框外为空', () => {
        const inst = makeLayerInst();
        expect(inst._stackAt(250, 250)).toEqual([2, 1, 0]);   // 三层全压着
        expect(inst._stackAt(120, 120)).toEqual([0]);          // 只有底层框
        expect(inst._stackAt(950, 950)).toEqual([]);           // 画幅内但无框
    });

    test('_cycleCandidate：从选中者逐层下探，到底回顶', () => {
        const inst = makeLayerInst();
        inst.selected = 2;   // 顶层大框
        expect(inst._cycleCandidate(inst._stackAt(250, 250))).toBe(1);
        inst.selected = 1;
        expect(inst._cycleCandidate(inst._stackAt(250, 250))).toBe(0);
        inst.selected = 0;   // 已到底 → 回顶
        expect(inst._cycleCandidate(inst._stackAt(250, 250))).toBe(2);
        inst.selected = -1;  // 无选中 → 顶层
        expect(inst._cycleCandidate(inst._stackAt(250, 250))).toBe(2);
    });

    test('_isClickBurst：600ms 内 6px 内且选中者在层栈里才成立', () => {
        const inst = makeLayerInst();
        inst.selected = 1;
        const now = Date.now();
        inst._clickBurst = { t: now - 100, px: 250, py: 250 };
        expect(inst._isClickBurst(252, 251, inst._stackAt(252, 251))).toBe(true);   // 连点成立
        inst._clickBurst = { t: now - 1000, px: 250, py: 250 };
        expect(inst._isClickBurst(252, 251, inst._stackAt(252, 251))).toBe(false);  // 超时
        inst._clickBurst = { t: now - 100, px: 300, py: 300 };
        expect(inst._isClickBurst(252, 251, inst._stackAt(252, 251))).toBe(false);  // 移位超 6px
        inst._clickBurst = { t: now - 100, px: 250, py: 250 };
        inst.selected = -1;   // 选中已取消 → 链断
        expect(inst._isClickBurst(252, 251, inst._stackAt(252, 251))).toBe(false);
    });

    test('_layerOp：up/down 相邻交换、front/back 移端，选择跟随', () => {
        const inst = makeLayerInst();
        inst.selected = 2; inst._layerOp('down');   // 顶层大框下移一层
        expect(inst.draft.items.map((x) => x.caption)).toEqual(['底层小框', '顶层大框', '中层框']);
        expect(inst.selected).toBe(1);
        inst._layerOp('down');                       // 再下移到底
        expect(inst.draft.items.map((x) => x.caption)).toEqual(['顶层大框', '底层小框', '中层框']);
        inst._layerOp('down');                       // 已在底：状态提示、不变
        expect(inst.draft.items[0].caption).toBe('顶层大框');
        expect(inst.statusCalls.at(-1).text).toContain('最底层');
        inst._layerOp('front');                      // 置顶
        expect(inst.selected).toBe(2);
        expect(inst.draft.items[2].caption).toBe('顶层大框');
        inst._layerOp('up'); inst._layerOp('back');  // 回底
        expect(inst.draft.items[0].caption).toBe('顶层大框');
        expect(inst.selected).toBe(0);
    });

    test('_layerOp：无选中报提示不动；边界操作触发渲染与保存失效', () => {
        const inst = makeLayerInst();
        inst.selected = -1;
        inst._layerOp('up');
        expect(inst.statusCalls.at(-1).text).toContain('先选中');
        expect(inst.renderCalls).toBe(0);
        inst.selected = 1;
        const callsBefore = inst.renderCalls;
        inst._layerOp('up');
        expect(inst.renderCalls).toBeGreaterThan(callsBefore);
        expect(inst._clickBurst).toBeNull();
    });

    test('move 拖动超过 2px：挂 moved 并解除连点链（拖动非点击）', () => {
        const inst = makeLayerInst();
        inst.stageCv = { getBoundingClientRect: () => ({ left: 0, top: 0 }), style: {} };
        inst._otherEdges = () => ({ xs: [], ys: [] });   // 磁吸目标：空（免画幅依赖）
        inst._syncBboxInputs = () => {};                 // bbox 数值框同步：DOM 桩
        inst.draft.width = 10000; inst.draft.height = 10000;   // 钳制不裁剪拖动
        inst.selected = 2;
        inst._clickBurst = { t: Date.now(), px: 250, py: 250 };
        inst._drag = { mode: 'move', orig: inst.draft.items[2].bbox.slice(), start: { x: 250, y: 250 }, moved: false };
        inst._onPointerMove({ clientX: 260, clientY: 250 });   // +10px 真实拖动
        expect(inst._drag.moved).toBe(true);
        expect(inst._clickBurst).toBeNull();
        // 微动（≤2px）不算拖动：连点链保留
        inst._clickBurst = { t: Date.now(), px: 250, py: 250 };
        inst._drag = { mode: 'move', orig: inst.draft.items[2].bbox.slice(), start: { x: 250, y: 250 }, moved: false };
        inst._onPointerMove({ clientX: 251, clientY: 250 });
        expect(inst._drag.moved).toBe(false);
        expect(inst._clickBurst).not.toBeNull();
    });
});

describe('MangaEditor 图层系统（MangaLayers）', () => {
    function makeLayerInst(items) {
        const inst = makeInstance(items);
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

    test('新建笔迹层：落在活动层之上并设为活动；删除清活动引用并入历史', () => {
        const inst = makeLayerInst([]);
        const a = inst._addStrokeLayer(false);
        const b = inst._addStrokeLayer(false);
        expect(inst.draft.drawLayers.map((l) => l.id)).toEqual([a.id, b.id]);
        expect(inst._activeLayerId).toBe(b.id);
        const before = inst._undoStack.length;
        inst._deleteLayer(b.id);
        expect(inst._activeLayerId).toBe(null);
        expect(inst._selLayerId).toBe(null);
        expect(inst.draft.drawLayers.length).toBe(1);
        expect(inst._undoStack.length).toBe(before + 1);
    });

    test('拖拽排序落位（_reorderLayerTo）：above/below 语义正确入账；同位不动；显隐翻转进历史', () => {
        const inst = makeLayerInst([]);
        inst._addStrokeLayer(false);
        inst._addStrokeLayer(false);
        const [a, b] = inst.draft.drawLayers;           // 数组底→顶
        const before = inst._undoStack.length;
        inst._reorderLayerTo(a, b, false);              // a 拖到 b 视觉上方 → 交换
        expect(inst.draft.drawLayers[0].id).toBe(b.id);
        expect(inst.draft.drawLayers[1].id).toBe(a.id);
        expect(inst._undoStack.length).toBe(before + 1);
        inst._reorderLayerTo(a, b, true);               // a 拖回 b 视觉下方 → 移回
        expect(inst.draft.drawLayers[0].id).toBe(a.id);
        const after = inst._undoStack.length;
        inst._reorderLayerTo(a, b, true);               // 已在 b 下方：同位不动不入账
        expect(inst._undoStack.length).toBe(after);
        inst._reorderLayerTo(a, a, false);              // 自身为目标：忽略
        expect(inst._undoStack.length).toBe(after);
        inst._toggleLayerVisible(b.id);
        expect(inst.draft.drawLayers.find((l) => l.id === b.id).visible).toBe(false);
        expect(inst._undoStack.length).toBe(after + 1);
    });

    test('复制图层：笔迹层连笔迹深克隆插本层上方并接管活动；图片层副本共享引用', () => {
        const inst = makeLayerInst([]);
        const a = inst._addStrokeLayer(false);
        a.strokes.push({ color: '#ff5a5a', width: 4, points: [1, 2, 30, 40] });
        const before = inst._undoStack.length;
        inst._duplicateLayer(a.id);
        const layers = inst.draft.drawLayers;
        expect(layers).toHaveLength(2);
        expect(layers[0].id).toBe(a.id);                // 副本插原图层上方（数组 idx+1）
        expect(layers[1].name).toBe('图层 1 副本');
        expect(layers[1].id).not.toBe(a.id);
        expect(layers[1].strokes).toEqual(a.strokes);   // 内容深克隆
        expect(layers[1].strokes).not.toBe(a.strokes);  // 非同一引用
        expect(inst._activeLayerId).toBe(layers[1].id); // 笔迹层副本接管活动
        expect(inst._undoStack.length).toBe(before + 1);

        // 图片层：副本同 src（缓存共享）、选中态切到副本、bbox 原样
        inst.draft.drawLayers.push({
            id: 9, name: '图片 9', visible: true,
            image: { src: '/api/assets/x', bbox: [0, 0, 50, 60] }
        });
        inst._selLayerId = null;
        inst._duplicateLayer(9);
        const copy = inst.draft.drawLayers[inst.draft.drawLayers.length - 1];
        // 无 fromSrc 的旧层数据在 _ensureDrawLayers 补盖基线（写回画布的
        // src 偏离判定依赖），副本随之携带
        expect(copy.image).toEqual({ src: '/api/assets/x', fromSrc: '/api/assets/x', bbox: [0, 0, 50, 60] });
        expect(copy.name).toBe('图片 9 副本');
        expect(inst._selLayerId).toBe(copy.id);
        expect(inst.draft.drawLayers[2].id).toBe(9);    // 原层未动
    });

    test('_layerOpacity 归一：缺省 1、越界钳边界；_setLayerOpacity 变值并收口', () => {
        const inst = makeLayerInst([]);
        inst._renderStage = () => {};
        expect(inst._layerOpacity({})).toBe(1);
        expect(inst._layerOpacity({ opacity: 0.5 })).toBe(0.5);
        expect(inst._layerOpacity({ opacity: 5 })).toBe(1);
        expect(inst._layerOpacity({ opacity: 0.001 })).toBe(0.05);
        const layer = { id: 1, strokes: [] };
        inst.draft.drawLayers = [layer];
        let saved = 0;
        inst._scheduleSave = () => { saved++; };
        inst._setLayerOpacity(1, 0.3);
        expect(layer.opacity).toBe(0.3);
        expect(saved).toBe(1);
        inst._setLayerOpacity(1, 99);                   // 越界钳到 1
        expect(layer.opacity).toBe(1);
        expect(saved).toBe(2);                          // 两次合法调用各收口一次
        inst._setLayerOpacity(999, 0.5);                // 未知层：不动不收口
        expect(saved).toBe(2);
    });

    test('_drawPageLayers：逐层不透明度按层生效（save/restore 成对不泄漏）', () => {
        const inst = makeLayerInst([]);
        const img = { complete: true, naturalWidth: 10, naturalHeight: 10 };
        inst._layerImgCache.set('/api/assets/x', { img });
        inst.draft.drawLayers = [
            { id: 1, visible: true, opacity: 0.4, image: { src: '/api/assets/x', bbox: [0, 0, 50, 50] } },
            { id: 2, visible: true, strokes: [{ color: '#fff', width: 2, points: [1, 1, 9, 9] }] }
        ];
        const log = [];
        const ctx = {
            _ga: 1,
            set globalAlpha(v) { this._ga = v; log.push(['alpha', v]); },
            get globalAlpha() { return this._ga; },
            save() { log.push('save'); },
            restore() { log.push('restore'); },
            beginPath() {}, rect() {}, clip() {}, drawImage() {}, stroke() {},
            moveTo() {}, lineTo() {}, arc() {}, fill() {},
            set strokeStyle(v) {}, set fillStyle(v) {}, set lineWidth(v) {},
            set lineJoin(v) {}, set lineCap(v) {}
        };
        inst._drawPageLayers(ctx, (v) => v, (v) => v, 1, inst.draft);
        const alphas = log.filter((e) => Array.isArray(e) && e[0] === 'alpha').map((e) => e[1]);
        expect(alphas).toEqual([0.4, 1]);               // 图片层 0.4 → 笔迹层缺省 1
        expect(log.filter((e) => e === 'save').length).toBe(5);      // 外层 1 + 每层各 1 + 逐内容页裁剪各 1（图片层笔迹段/笔迹层，ADR 070）
        expect(log.filter((e) => e === 'restore').length).toBe(5);
    });

    test('_activeStrokeLayer：活动层隐藏/为图片层时回落最顶可见笔迹层', () => {
        const inst = makeLayerInst([]);
        const a = inst._addStrokeLayer(true);
        const b = inst._addStrokeLayer(true);
        a.visible = false;
        inst._activeLayerId = a.id;
        expect(inst._activeStrokeLayer().id).toBe(b.id);
        inst.draft.drawLayers.push({
            id: 9, name: '图片 9', visible: true,
            image: { src: '/api/assets/x', bbox: [0, 0, 5, 5] }
        });
        inst._activeLayerId = 9;                        // 图片层不可画
        expect(inst._activeStrokeLayer().id).toBe(b.id);
    });

    test('_hitImageLayer：自顶向下首个可见命中；隐藏层跳过', () => {
        const inst = makeLayerInst([]);
        inst.draft.drawLayers = [
            { id: 1, name: '图片 1', visible: true, image: { src: '/api/assets/a', bbox: [0, 0, 100, 100] } },
            { id: 2, name: '图片 2', visible: false, image: { src: '/api/assets/b', bbox: [0, 0, 50, 50] } },
            { id: 3, name: '图片 3', visible: true, image: { src: '/api/assets/c', bbox: [40, 40, 60, 60] } }
        ];
        expect(inst._hitImageLayer(50, 50)).toBe(3);    // 顶层优先
        expect(inst._hitImageLayer(10, 10)).toBe(1);    // 顶层不覆盖落到 1
        expect(inst._hitImageLayer(200, 200)).toBe(null);
    });

    test('图片层磁吸：边对齐画幅目标（只吸画幅，不吸元素框）', () => {
        const inst = makeLayerInst([]);
        inst.draft.width = 832;
        inst.draft.height = 1216;
        const r = inst._snapLayerMove([2, 100, 102, 200]);   // 左边距画幅 2px
        expect(r.box[0]).toBe(0);
        expect(r.guides.some((g) => g.axis === 'x' && g.pos === 0)).toBe(true);
    });

    test('图片层落位：center 拖放落点=光标中心（钳画幅内），缺省画幅居中', () => {
        const inst = makeLayerInst([]);
        const page = { width: 1024, height: 1024 };
        // 2048×1024 contain 适配 → 1024×512；落点 (512,512)：bbox 中心对齐落点
        const rec = inst._makeImageLayerRecord(page, '/u', 2048, 1024, 9, '测试', { x: 512, y: 512 });
        expect(rec.image.bbox).toEqual([0, 256, 1024, 768]);
        // 落点越界钳到画幅缘（中心=页缘，bbox 半出页也抓得回）
        const edge = inst._makeImageLayerRecord(page, '/u', 2048, 1024, 10, '测试', { x: -50, y: 2000 });
        expect(edge.image.bbox).toEqual([-512, 768, 512, 1280]);
        // 缺省：contain 适配画幅居中（文件菜单置入原行为不变）
        const plain = inst._makeImageLayerRecord(page, '/u', 2048, 1024, 11, '测试');
        expect(plain.image.bbox).toEqual([0, 256, 1024, 768]);
    });

    test('图片层拖动可出画幅（灯箱同款，ADR 070）：右缘拖出不回弹', () => {
        const inst = makeLayerInst([]);
        inst.draft.drawLayers = [
            { id: 1, name: '图片 1', visible: true, image: { src: '/api/assets/a', bbox: [824, 100, 1024, 300] } }
        ];
        inst._selLayerId = 1;
        inst._localPoint = (e) => ({ px: e.clientX, py: e.clientY });
        inst._drag = {
            mode: 'layer-move', layerId: 1, moved: false,
            orig: [824, 100, 1024, 300], origGeom: null,
            start: { x: 0, y: 0 }, histSnap: inst._histSnapshot()
        };
        inst._onPointerMove({ clientX: 200, clientY: 0 });   // +200px：拖出右缘
        expect(inst.draft.drawLayers[0].image.bbox[2]).toBe(1224);   // 出界成功
        expect(inst.draft.drawLayers[0].image.bbox[0]).toBe(1024);   // 左缘吸到画幅右缘
    });

    test('图片层锚点缩放等比（2026-11-11 用户拍板）：四角锁纵横、对角锚定、入账「缩放图片」', () => {
        const inst = makeLayerInst([]);
        inst.draft.drawLayers = [
            { id: 1, name: '图片 1', visible: true, image: { src: '/api/assets/a', bbox: [100, 100, 300, 200] } }
        ];
        inst._selLayerId = 1;
        inst._localPoint = (e) => ({ px: e.clientX, py: e.clientY });
        inst._drag = {
            mode: 'layer-resize', layerId: 1, anchor: 'se', moved: false,
            orig: [100, 100, 300, 200], histSnap: inst._histSnapshot()
        };
        inst._onPointerMove({ clientX: 500, clientY: 500 });   // rx=2、ry=4 → 主轴 4 带动
        expect(inst.draft.drawLayers[0].image.bbox).toEqual([100, 100, 900, 500]);   // 200×100→800×400 不变形
        inst._onPointerUp({ clientX: 500, clientY: 500 });
        expect(inst._undoStack.at(-1).label).toBe('缩放图片');   // moved 挂上才入账
    });

    test('图片层锚点缩放：nw 对侧角锚定（右下缘固定）+ 最小边 24px 下限', () => {
        const inst = makeLayerInst([]);
        inst.draft.drawLayers = [
            { id: 1, name: '图片 1', visible: true, image: { src: '/api/assets/a', bbox: [100, 100, 300, 200] } }
        ];
        inst._selLayerId = 1;
        inst._localPoint = (e) => ({ px: e.clientX, py: e.clientY });
        inst._drag = {
            mode: 'layer-resize', layerId: 1, anchor: 'nw', moved: false,
            orig: [100, 100, 300, 200], histSnap: inst._histSnapshot()
        };
        inst._onPointerMove({ clientX: 50, clientY: 60 });   // rx=1.25、ry=1.4 → 1.4
        expect(inst.draft.drawLayers[0].image.bbox).toEqual([20, 60, 300, 200]);   // 右下角不动
        inst._onPointerMove({ clientX: 299, clientY: 199 }); // rx≈0、ry≈0 → 钳最小边 24
        expect(inst.draft.drawLayers[0].image.bbox).toEqual([252, 176, 300, 200]);   // 48×24
    });

    test('图片层单边锚点等比：e 边左缘固定、纵横比不变', () => {
        const inst = makeLayerInst([]);
        inst.draft.drawLayers = [
            { id: 1, name: '图片 1', visible: true, image: { src: '/api/assets/a', bbox: [100, 100, 300, 200] } }
        ];
        inst._selLayerId = 1;
        inst._localPoint = (e) => ({ px: e.clientX, py: e.clientY });
        inst._drag = {
            mode: 'layer-resize', layerId: 1, anchor: 'e', moved: false,
            orig: [100, 100, 300, 200], histSnap: inst._histSnapshot()
        };
        inst._onPointerMove({ clientX: 600, clientY: 300 });   // rx=2.5 → 整框乘 2.5
        expect(inst.draft.drawLayers[0].image.bbox).toEqual([100, 100, 600, 350]);   // 2:1 保持
    });

    test('图片层等比缩放磁吸：移动边接近画幅中线按倍率吸附并出参考线', () => {
        const inst = makeLayerInst([]);
        inst.draft.drawLayers = [
            { id: 1, name: '图片 1', visible: true, image: { src: '/api/assets/a', bbox: [100, 100, 300, 200] } }
        ];
        inst._selLayerId = 1;
        inst._localPoint = (e) => ({ px: e.clientX, py: e.clientY });
        inst._drag = {
            mode: 'layer-resize', layerId: 1, anchor: 'se', moved: false,
            orig: [100, 100, 300, 200], histSnap: inst._histSnapshot()
        };
        inst._onPointerMove({ clientX: 510, clientY: 200 });   // raw 410 距画幅中线 512 目标 412 差 2px
        expect(inst.draft.drawLayers[0].image.bbox).toEqual([100, 100, 512, 306]);   // 倍率吸到 412/200=2.06
        expect(inst._guides).toEqual([{ axis: 'x', pos: 512 }]);
    });

    test('图片层等比缩放打断回滚 _cancelDrag：bbox 回到拖拽前', () => {
        const inst = makeLayerInst([]);
        inst.draft.drawLayers = [
            { id: 1, name: '图片 1', visible: true, image: { src: '/api/assets/a', bbox: [100, 100, 300, 200] } }
        ];
        inst._selLayerId = 1;
        inst._localPoint = (e) => ({ px: e.clientX, py: e.clientY });
        inst._drag = {
            mode: 'layer-resize', layerId: 1, anchor: 'se', moved: false,
            orig: [100, 100, 300, 200], histSnap: inst._histSnapshot()
        };
        inst._onPointerMove({ clientX: 500, clientY: 500 });
        inst._cancelDrag();
        expect(inst.draft.drawLayers[0].image.bbox).toEqual([100, 100, 300, 200]);
        expect(inst._drag).toBe(null);
    });

    test('形状层拖动可出画幅（2026-11-07 用户拍板补遗，与图片/文字层一致；创建仍限页内）', () => {
        const inst = makeLayerInst([]);
        inst.draft.drawLayers = [
            { id: 1, name: '形状 1', visible: true, x: 900, y: 900,
              shape: { type: 'rect', w: 100, h: 80, fill: '#ffffff', strokeColor: '#000000', strokeWidth: 6, radius: 24, tail: 'lb' } }
        ];
        inst._selLayerId = 1;
        inst._drag = {
            mode: 'layer-move', layerId: 1, moved: true,
            orig: inst._layerBounds(inst.draft.drawLayers[0]).slice(),
            origGeom: { x: 900, y: 900, w: 100, h: 80 },
            start: { x: 0, y: 0 }, histSnap: inst._histSnapshot()
        };
        inst._localPoint = () => ({ px: 300, py: 300 });   // +300px：拖出右下缘
        inst._onPointerMove({ clientX: 0, clientY: 0 });
        expect(inst.draft.drawLayers[0].x).toBe(1200);   // 出界成功不回弹
        expect(inst.draft.drawLayers[0].y).toBe(1200);
        expect(inst._layerBounds(inst.draft.drawLayers[0])[2]).toBeGreaterThan(1024);
    });

    test('图层磁吸阈值 8 屏幕像素（灯箱 SNAP_PX 同款，ADR 070）', () => {
        const inst = makeLayerInst([]);
        inst.draft.width = 1024;
        inst.draft.height = 1024;
        const r = inst._snapLayerMove([7, 300, 107, 400]);   // 左缘距画幅 7px（旧阈值 6 吸不到）
        expect(r.box[0]).toBe(0);
        expect(r.guides.some((g) => g.axis === 'x' && g.pos === 0)).toBe(true);
    });

    test('_ensureDrawLayers：旧平铺 strokes 会话内懒迁移为垫底层', () => {
        const inst = makeLayerInst([]);
        inst.draft.strokes = [{ color: '#fff', width: 4, points: [1, 2] }];
        const layers = inst._ensureDrawLayers();
        expect(layers.length).toBe(1);
        expect(layers[0].strokes.length).toBe(1);
        expect(inst.draft.strokes).toBeUndefined();
    });
});

describe('MangaLayers._ensureDefaultLayerSelection 默认选中（ADR 074 补遗：灯箱同语义）', () => {
    function makeSelInst(layers) {
        const inst = Object.create(MangaEditor.prototype);
        inst.draft = {
            width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy',
            summary: { caption: '', canvas: 'single' }, items: [], drawLayers: layers
        };
        inst.selected = -1;
        inst._selLayerId = null;
        inst._nextLayerId = 10;
        inst._syncLayerPanelUi = () => { inst.panelSynced = true; };
        return inst;
    }

    test('无选中自动选最顶可见图片层；已有有效选中不动；隐藏图片层跳过', () => {
        const a = { id: 1, image: { src: '/api/assets/a.png', bbox: [0, 0, 10, 10] }, visible: false };
        const b = { id: 2, image: { src: '/api/assets/b.png', bbox: [0, 0, 10, 10] } };
        const inst = makeSelInst([a, b]);
        inst._ensureDefaultLayerSelection();
        expect(inst._selLayerId).toBe(2);            // 栈顶可见图片层（b 在数组末位）
        expect(inst.selected).toBe(-1);              // 元素选中让位
        expect(inst.panelSynced).toBe(true);

        const inst2 = makeSelInst([a, b]);
        inst2._selLayerId = 1;                        // 已有选中（哪怕隐藏）不动
        inst2._ensureDefaultLayerSelection();
        expect(inst2._selLayerId).toBe(1);

        const inst3 = makeSelInst([{ id: 3, strokes: [] }]);   // 无图片层：保持无选中
        inst3._ensureDefaultLayerSelection();
        expect(inst3._selLayerId).toBe(null);
    });

    test('_applyLoadedDocument 载入即默认选中（调色/抠图开箱即用）', () => {
        const inst = Object.create(MangaEditor.prototype);
        const layer = { id: 5, image: { src: '/api/assets/x.png', bbox: [0, 0, 10, 10] } };
        inst.pages = [{
            width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy',
            summary: { caption: '', canvas: 'single' }, items: [], drawLayers: [layer]
        }];
        inst.activePage = 0;
        inst._renderAll = () => {}; inst._renderLayerPanel = () => {}; inst._renderRail = () => {};
        inst._resetHistory = () => {}; inst._updateProjectBtnLabel = () => {};
        inst._applyLoadedDocument({ pages: inst.pages, active: 0 }, null);
        expect(inst._selLayerId).toBe(5);
    });
});

describe('MangaLayers 文件菜单（ADR 075 自灯箱 StudioImport 迁移）', () => {
    function withFakeDoc(fn) {
        const orig = context.document;
        context.document = {
            createElement() {
                return {
                    children: [], style: {}, className: '', type: '', title: '',
                    textContent: '', draggable: false, innerHTML: '', hidden: false,
                    classList: { add() {}, remove() {}, toggle() {} },
                    addEventListener() {}, append(...cs) { this.children.push(...cs); },
                    appendChild(c) { this.children.push(c); }
                };
            },
            addEventListener() {}, removeEventListener() {}, body: { appendChild() {} }
        };
        try {
            return fn();
        } finally {
            if (orig === undefined) delete context.document;
            else context.document = orig;
        }
    }

    function makeFileInst(items) {
        const inst = Object.create(MangaEditor.prototype);
        inst.draft = {
            width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy',
            summary: { caption: '', canvas: 'single' }, items, drawLayers: []
        };
        inst.selected = -1;
        inst._nextLayerId = 1;
        inst._undoStack = []; inst._redoStack = [];
        inst._textHistPending = null; inst._histTimer = null;
        inst.statusCalls = [];
        inst._status = (t, e) => inst.statusCalls.push({ text: t, isError: e });
        inst._scheduleSave = () => {}; inst._scheduleThumbRefresh = () => {};
        inst._renderStage = () => {}; inst._renderLayerPanel = () => {};
        const grid = {
            innerHTML: '', children: [],
            appendChild(c) { grid.children.push(c); }, append(...cs) { grid.children.push(...cs); },
            querySelector: () => null
        };
        const countEl = { textContent: '' };
        const okEl = { disabled: false };
        inst.pickerEl = {
            hidden: true,
            querySelector(sel) {
                if (sel === '.manga-picker-grid') return grid;
                if (sel === '.manga-picker-count') return countEl;
                if (sel === '.manga-picker-ok') return okEl;
                return null;
            }
        };
        inst._pickerGrid = grid;
        return inst;
    }
    const mkCanvasImg = (id, name) => ({
        id, name, source: 'image', img: { src: `/api/assets/canvas-${id}.png` }
    });

    test('_openFileCanvasPicker：官方谓词过滤（面板节点/视频排除）+ 空态', () => {
        const inst = makeFileInst([]);
        context.window.canvas = {
            images: { images: [
                mkCanvasImg('a', '甲'),
                { id: 'p', source: 'prompt-node', img: null },                     // 面板节点：无 img 天然排除
                { id: 'v', source: 'video', img: { src: '/api/assets/v.png' } },   // 视频封面排除
                mkCanvasImg('b', '乙')
            ] }
        };
        withFakeDoc(() => inst._openFileCanvasPicker());
        expect(inst.pickerEl.hidden).toBe(false);
        expect(inst._pickerGrid.children).toHaveLength(2);                         // 只剩两张真实图片
        expect(inst._filePickerSelected.size).toBe(0);
        expect(inst.pickerEl.querySelector('.manga-picker-count').textContent).toBe('已选 0 张');
        expect(inst.pickerEl.querySelector('.manga-picker-ok').disabled).toBe(true);

        const empty = makeFileInst([]);
        context.window.canvas = { images: { images: [] } };
        withFakeDoc(() => empty._openFileCanvasPicker());
        expect(empty._pickerGrid.children).toHaveLength(1);                        // 空态占位
        expect(empty._pickerGrid.children[0].className).toBe('manga-picker-empty');
        context.window.canvas = undefined;
    });

    test('_onFileCanvasPickerOk：勾选图片逐张落层（按画布列表序 + 「画布图片 N」编号）', async () => {
        const inst = makeFileInst([]);
        const added = [];
        inst._addImageLayer = (url, w, h, label) => added.push({ url, w, h, label });
        context.window.canvas = { images: { images: [mkCanvasImg('a', '甲'), mkCanvasImg('b', '乙')] } };
        inst._filePickerSelected = new Set(['b', 'a']);                            // 勾选顺序无关：按画布列表序导入（灯箱同口径）
        await inst._onFileCanvasPickerOk();
        expect(added.map((x) => x.url)).toEqual(['/api/assets/canvas-a.png', '/api/assets/canvas-b.png']);
        expect(added.map((x) => x.label)).toEqual(['画布图片 1', '画布图片 2']);
        expect(added.every((x) => x.w === 100 && x.h === 100)).toBe(true);         // 既有 Image 桩默认尺寸
        expect(inst.pickerEl.hidden).toBe(true);                                   // 导入完收窗
        expect(inst._filePickerSelected.size).toBe(0);
    });

    test('_closeFileCanvasPicker：收窗并清勾选', () => {
        const inst = makeFileInst([]);
        inst._filePickerSelected = new Set(['a']);
        inst._closeFileCanvasPicker();
        expect(inst.pickerEl.hidden).toBe(true);
        expect(inst._filePickerSelected.size).toBe(0);
    });
});

// ==========================================================================
// 剪贴蒙版（2026-11-11，PS Clipping Mask 同语义）：clipped 标记 + 基底规则
// ==========================================================================

describe('MangaEditor 图层剪贴蒙版（PS 同语义）', () => {
    function makeClipInst(layers) {
        const inst = makeInstance([]);
        inst.draft.drawLayers = layers.map((l) => ({ visible: true, ...l }));
        inst._view = { scale: 1, ox: 0, oy: 0 };
        inst._selLayerId = null;
        inst._activeLayerId = null;
        inst._layerImgCache = new Map();
        inst._nextLayerId = 100;
        inst._scheduleSave = () => {};
        inst._scheduleThumbRefresh = () => {};
        inst._renderStage = () => {};
        return inst;
    }
    const imgLayer = (id) => ({ id, name: `图片 ${id}`, image: { src: '/api/assets/x', bbox: [0, 0, 50, 60] } });

    test('_toggleClipToBelow：标记/释放切换，入账「创建/释放剪贴蒙版」；释放不留 false 字段', () => {
        const inst = makeClipInst([imgLayer(1), imgLayer(2)]);
        const before = inst._undoStack.length;
        inst._toggleClipToBelow(2);
        expect(inst.draft.drawLayers[1].clipped).toBe(true);
        expect(inst._undoStack.length).toBe(before + 1);
        inst._toggleClipToBelow(2);
        expect('clipped' in inst.draft.drawLayers[1]).toBe(false);   // 释放即删字段（草稿干净）
        expect(inst._undoStack.length).toBe(before + 2);
    });

    test('最底层无基底可剪：拒绝并入状态提示，不入账', () => {
        const inst = makeClipInst([imgLayer(1), imgLayer(2)]);
        const before = inst._undoStack.length;
        inst._toggleClipToBelow(1);
        expect(inst.draft.drawLayers[0].clipped).toBeUndefined();
        expect(inst._undoStack.length).toBe(before);
        expect(inst.statusCalls.at(-1).text).toContain('下方没有可作基底的图层');
    });

    test('_clipBaseFor：跨过其他剪贴层取最近未剪贴层（PS 链式语义）', () => {
        const inst = makeClipInst([imgLayer(1), imgLayer(2), imgLayer(3), imgLayer(4)]);
        const [a, b, c, top] = inst.draft.drawLayers;
        top.clipped = true;
        expect(inst._clipBaseFor(top)).toBe(c);
        c.clipped = true;                          // c 也剪贴 → top 的基底下探到 b
        expect(inst._clipBaseFor(top)).toBe(b);
        expect(inst._clipBaseFor(c)).toBe(b);      // c 与 top 挂同一基底
        b.clipped = true;                          // b 也剪贴 → 基底下探到 a
        expect(inst._clipBaseFor(top)).toBe(a);
        a.clipped = true;                          // a 也剪贴（防御：手动标记无守卫路径）→ 无基底
        expect(inst._clipBaseFor(top)).toBeNull();
    });

    // ---- 组渲染（2026-11-11 轮廓独立）：基底→置入链→形状基底描边补笔 ----

    const recCtx = () => ({
        save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
        setLineDash() {}, strokeRect() {}, arc() {}, fill() {}, stroke() {},
        moveTo() {}, lineTo() {}, translate() {}, scale() {}, rotate() {},
        setTransform() {}, drawImage() {}
    });

    test('_drawPageLayers 组渲染：形状基底填充先行、置入链居中、描边补笔殿后', () => {
        const inst = makeClipInst([
            { id: 1, name: '框', shape: { type: 'rect', w: 100, h: 80, fill: '#fff', strokeColor: '#000', strokeWidth: 4, radius: 0 } },
            imgLayer(2),
            imgLayer(3)
        ]);
        inst.draft.drawLayers[1].clipped = true;
        inst.draft.drawLayers[2].clipped = true;
        const events = [];
        inst._drawShapeLayer = (ctx, layer, X, Y, scale, paint) => events.push(['shape', layer.id, paint ?? 'full']);
        inst._renderClippedLayer = (ctx, layer) => events.push(['clip', layer.id]);
        inst._drawPageLayers(recCtx(), (x) => x, (y) => y, 1, inst.draft);
        expect(events).toEqual([
            ['shape', 1, 'fill'],    // 填充随层位先画（链下）
            ['clip', 2],
            ['clip', 3],
            ['shape', 1, 'stroke']   // 描边链顶补笔——框线恒在最上
        ]);
    });

    test('无链形状层不拆笔：整层一次全画（paint 缺省）', () => {
        const inst = makeClipInst([
            { id: 1, name: '框', shape: { type: 'rect', w: 100, h: 80, fill: '#fff', strokeColor: '#000', strokeWidth: 4, radius: 0 } }
        ]);
        const events = [];
        inst._drawShapeLayer = (ctx, layer, X, Y, scale, paint) => events.push(['shape', layer.id, paint ?? 'full']);
        inst._renderClippedLayer = (ctx, layer) => events.push(['clip', layer.id]);
        inst._drawPageLayers(recCtx(), (x) => x, (y) => y, 1, inst.draft);
        expect(events).toEqual([['shape', 1, 'full']]);
    });

    test('图片基底+置入链照常组渲染；链被非剪贴层截断后各挂各基底', () => {
        const inst = makeClipInst([imgLayer(1), imgLayer(2), imgLayer(3), imgLayer(4)]);
        inst.draft.drawLayers[1].clipped = true;
        inst.draft.drawLayers[3].clipped = true;   // 基底是 3 而非 1（链不跨非剪贴层）
        const events = [];
        inst._drawShapeLayer = (ctx, layer, X, Y, scale, paint) => events.push(['shape', layer.id, paint ?? 'full']);
        inst._renderClippedLayer = (ctx, layer) => events.push(['clip', layer.id]);
        inst._drawPageLayers(recCtx(), (x) => x, (y) => y, 1, inst.draft);
        expect(events).toEqual([['clip', 2], ['clip', 4]]);   // 图片基底不拆笔，无 shape 事件
    });

    test('基底隐藏→整链不显示（PS 同语义），补笔也不画', () => {
        const inst = makeClipInst([
            { id: 1, name: '框', visible: false, shape: { type: 'rect', w: 100, h: 80, fill: '#fff', strokeColor: '#000', strokeWidth: 4, radius: 0 } },
            imgLayer(2)
        ]);
        inst.draft.drawLayers[1].clipped = true;
        const events = [];
        inst._drawShapeLayer = (ctx, layer, X, Y, scale, paint) => events.push(['shape', layer.id, paint ?? 'full']);
        inst._renderClippedLayer = (ctx, layer) => events.push(['clip', layer.id]);
        inst._drawPageLayers(recCtx(), (x) => x, (y) => y, 1, inst.draft);
        expect(events).toEqual([]);
    });

    test('ShapeLayout.drawShapeContent 拆笔：fill/stroke 模式各只画一半，缺省全画', () => {
        const inst = makeClipInst([]);
        const mkG = () => ({ fills: [], strokes: [], fill(p) { this.fills.push(p); }, stroke(p) { this.strokes.push(p); } });
        const s = { type: 'rect', w: 10, h: 8, fill: '#fff', strokeColor: '#000', strokeWidth: 3, radius: 0 };
        let g = mkG();
        inst._drawShapeContent(g, s, 0, 0, s.w, s.h);
        expect(g.fills).toHaveLength(1);
        expect(g.strokes).toHaveLength(1);
        g = mkG();
        inst._drawShapeContent(g, s, 0, 0, s.w, s.h, 'fill');
        expect(g.fills).toHaveLength(1);
        expect(g.strokes).toHaveLength(0);
        g = mkG();
        inst._drawShapeContent(g, s, 0, 0, s.w, s.h, 'stroke');
        expect(g.fills).toHaveLength(0);
        expect(g.strokes).toHaveLength(1);
    });
});

// ==========================================================================
// 移除工具（MangaRemoveTool，ADR 076）：遮罩涂抹 + 松手自动 LaMa 抹除
// ==========================================================================
