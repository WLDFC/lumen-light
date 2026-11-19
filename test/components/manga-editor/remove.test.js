/**
 * remove 测试（2026-11-09 自 mangaEditor.test.js 按模块拆分）
 * 覆盖：移除工具（MangaRemoveTool，ADR 076）
 */

const { context, MangaEditor, CoordinateLayout, makeInstance } = require('./helpers');

describe('移除工具（MangaRemoveTool，ADR 076）', () => {
    const MangaRemoveTool = context.window.MangaRemoveTool;

    /** 本 describe 专用 document 桩：canvas ctx 记录绘制指令（遮罩映射
     *  断言用），用完即删防泄漏（跨 describe 夹具不互通——就地自足） */
    function withRemoveDoc(fn) {
        context.document = {
            createElement(tag) {
                if (tag === 'canvas') {
                    const ctx = {
                        ops: [],
                        lineWidth: 1, lineJoin: '', lineCap: '', strokeStyle: '', fillStyle: '',
                        drawImage() { this.ops.push(['drawImage']); },
                        clearRect() { this.ops.push(['clearRect']); },
                        beginPath() { this.ops.push(['beginPath']); },
                        arc(x, y, r) { this.ops.push(['arc', x, y, r]); },
                        fill() { this.ops.push(['fill']); },
                        moveTo(x, y) { this.ops.push(['moveTo', x, y]); },
                        lineTo(x, y) { this.ops.push(['lineTo', x, y]); },
                        stroke() { this.ops.push(['stroke']); },
                        toDataURL: () => 'data:image/png;base64,AAA'
                    };
                    return { width: 0, height: 0, getContext: () => ctx, toDataURL: () => 'data:image/png;base64,AAA' };
                }
                return { style: {}, classList: { add() {}, remove() {} }, removed: false, remove() { this.removed = true; }, appendChild() {} };
            },
            addEventListener() {}, removeEventListener() {}
        };
        try {
            return fn();
        } finally {
            delete context.document;
        }
    }

    function makeRemoveHost(layers) {
        return {
            visible: true,
            _selLayerId: null,
            _layerById: (id) => layers.find((l) => l.id === id) || null,
            _ensureLayerImage: () => ({ complete: true, naturalWidth: 2, naturalHeight: 2 }),
            _view: { scale: 1 },
            _toDraft: (px, py) => ({ x: px, y: py }),   // 恒等映射：屏幕坐标=草稿坐标
            statusCalls: [],
            _status(text, isError) { this.statusCalls.push({ text, isError }); },
            _renderStageCalls: 0,
            _renderStage() { this._renderStageCalls++; },
            _scheduleThumbRefreshCalls: 0,
            _scheduleThumbRefresh() { this._scheduleThumbRefreshCalls++; },
            _renderLayerPanelCalls: 0,
            _renderLayerPanel() { this._renderLayerPanelCalls++; },
            _commitHistoryLabels: [],
            _commitHistory(snap, label) { this._commitHistoryLabels.push(label); },
            _histSnapshot: () => 'snap-1',
            _draftTouched: false,
            _scheduleSaveCalls: 0,
            _scheduleSave() { this._scheduleSaveCalls++; },
            _uploadToAssets: async () => '/api/assets/removed.png',
            _removeMask: null,
            _hideCursorRingCalls: 0,
            _hideCursorRing() { this._hideCursorRingCalls++; },
            dialog: { appendChild() {} }
        };
    }

    const flush = async () => {
        // 垫最小 document 桩：前面调色用例 open() 遗留的 setTimeout(0) 点外
        // 监听会在 flush 让出事件循环时触发，而 withXxxDoc 的桩已按契约
        // 删除——不垫会以「document is not defined」炸到当前用例头上
        context.document = { createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }), addEventListener() {}, removeEventListener() {} };
        try {
            await new Promise((r) => setImmediate(r));
            await new Promise((r) => setImmediate(r));
        } finally {
            delete context.document;
        }
    };

    test('open 守卫：未选中/非图片层/图未就绪不开会话并提示', () => {
        const host = makeRemoveHost([{ id: 7, image: { src: '/a.png', bbox: [0, 0, 4, 4] } }]);
        const tool = new MangaRemoveTool(host);
        withRemoveDoc(() => tool.open());                 // 未选中
        expect(tool._open).toBe(false);
        expect(host._removeMask).toBe(null);
        expect(host.statusCalls.some((c) => c.isError && /选中一个图片层/.test(c.text))).toBe(true);
        const textOnly = makeRemoveHost([{ id: 8, text: { content: 'x' } }]);
        textOnly._selLayerId = 8;
        new MangaRemoveTool(textOnly).open();             // 文字层不可抹
        expect(textOnly.statusCalls.some((c) => c.isError && /选中一个图片层/.test(c.text))).toBe(true);
        const notReady = makeRemoveHost([{ id: 9, image: { src: '/b.png', bbox: [0, 0, 4, 4] } }]);
        notReady._selLayerId = 9;
        notReady._ensureLayerImage = () => ({ complete: false, naturalWidth: 0, naturalHeight: 0 });
        new MangaRemoveTool(notReady).open();             // 图未加载完
        expect(notReady.statusCalls.some((c) => c.isError && /尚未加载完成/.test(c.text))).toBe(true);
    });

    test('open/close：会话建遮罩画布挂预览钩子，close 摘钩子丢弃未提交遮罩', () => {
        const host = makeRemoveHost([{ id: 7, image: { src: '/a.png', bbox: [0, 0, 4, 4] } }]);
        host._selLayerId = 7;
        const tool = new MangaRemoveTool(host);
        withRemoveDoc(() => tool.open());
        expect(tool._open).toBe(true);
        expect(host._removeMask).not.toBe(null);
        expect(host._removeMask.layerId).toBe(7);
        expect(tool.maskCv.width).toBe(2);                // 遮罩画布 = 图片自然分辨率
        expect(tool.maskCv.height).toBe(2);
        withRemoveDoc(() => tool.close());
        expect(tool._open).toBe(false);
        expect(host._removeMask).toBe(null);
        expect(tool.maskCv).toBe(null);
    });

    test('遮罩映射：草稿坐标按 bbox 等比换算进图片局部（k = natW/(x2-x1)）', () => {
        const host = makeRemoveHost([{ id: 7, image: { src: '/a.png', bbox: [0, 0, 4, 4] } }]);
        host._selLayerId = 7;
        const tool = new MangaRemoveTool(host);
        withRemoveDoc(() => {
            tool.open();
            tool._strokeStart(0, 0);                      // 草稿 (0,0) → 图片局部 (0,0)
            tool._strokeMove(2, 2);                       // 草稿 (2,2) → 图片局部 (1,1)
        });
        const g = tool.maskCv.getContext('2d');
        expect(g.ops.some((o) => o[0] === 'stroke')).toBe(true);
        expect(g.ops).toContainEqual(['moveTo', 0, 0]);
        expect(g.ops).toContainEqual(['lineTo', 1, 1]);   // 2 × (2/4) = 1
        expect(g.lineWidth).toBe(30);                     // 遮罩笔宽 30 × SIZE_SCALE 2 × k 0.5
        const arc = g.ops.find((o) => o[0] === 'arc');    // 起笔点迹：局部 (0,0) 半径 30×2×0.5/2
        expect(arc).toEqual(['arc', 0, 0, 15]);
    });

    test('收笔自动提交：底片+遮罩 → /api/lama/remove → 换 src 入账 + 遮罩消费', async () => {
        const host = makeRemoveHost([{ id: 7, image: { src: '/api/assets/a.png', fromSrc: '/api/assets/a.png', bbox: [0, 0, 4, 4] } }]);
        host._selLayerId = 7;
        const layer = host._layerById(7);
        const tool = new MangaRemoveTool(host);
        const calls = [];
        const origFetch = context.fetch;
        context.fetch = async (url, opts) => {
            calls.push({ url, body: JSON.parse(opts.body) });
            return { json: async () => ({ status: 'ok', image: 'data:image/png;base64,BBB', cost: 1200, provider: 'cpu' }) };
        };
        try {
            withRemoveDoc(() => {
                tool.open();
                tool._strokeStart(0, 0);
                tool._strokeMove(2, 2);
                tool._strokeEnd();
            });
            await flush();
        } finally {
            context.fetch = origFetch;
        }
        expect(calls.length).toBe(1);
        expect(calls[0].url).toBe('/api/lama/remove');
        expect(calls[0].body.imageData).toMatch(/^data:image\/png;base64,/);
        expect(calls[0].body.maskData).toMatch(/^data:image\/png;base64,/);
        expect(layer.image.src).toBe('/api/assets/removed.png');    // 换新引用
        expect(layer.image.fromSrc).toBe('/api/assets/a.png');      // fromSrc 不动
        expect(host._commitHistoryLabels).toEqual(['AI移除']);
        expect(host._draftTouched).toBe(true);
        expect(host._scheduleSaveCalls).toBe(1);                    // ADR 072 只标脏
        expect(host._renderLayerPanelCalls).toBeGreaterThanOrEqual(1);
        expect(host.statusCalls.some((c) => /移除完成/.test(c.text))).toBe(true);
        expect(tool._removing).toBe(false);
        // 遮罩消费：成功后清空画布（后续新笔从净画布起）
        expect(tool.maskCv.getContext('2d').ops.some((o) => o[0] === 'clearRect')).toBe(true);
        // 忙碌遮罩：推理期间挂载、结束移除（灯箱 _setBusy 同语义）
        expect(tool.busyShield).not.toBe(null);
        expect(tool.busyShield.removed).toBe(true);
    });

    test('提交失败：遮罩保留可重试 + src 不变 + 错误提示', async () => {
        const host = makeRemoveHost([{ id: 9, image: { src: '/api/assets/b.png', bbox: [0, 0, 4, 4] } }]);
        host._selLayerId = 9;
        const layer = host._layerById(9);
        const tool = new MangaRemoveTool(host);
        const origFetch = context.fetch;
        context.fetch = async () => ({ json: async () => ({ status: 'error', message: '模型不可用' }) });
        try {
            withRemoveDoc(() => {
                tool.open();
                tool._strokeStart(0, 0);
                tool._strokeEnd();
            });
            await flush();
        } finally {
            context.fetch = origFetch;
        }
        expect(layer.image.src).toBe('/api/assets/b.png');
        expect(host._commitHistoryLabels).toEqual([]);
        expect(host.statusCalls.some((c) => c.isError && /移除失败/.test(c.text))).toBe(true);
        // 遮罩未消费：ctx 无 clearRect（保留供继续涂改重试，灯箱同口径）
        expect(tool.maskCv.getContext('2d').ops.some((o) => o[0] === 'clearRect')).toBe(false);
        expect(tool._removing).toBe(false);
    });

    test('推理中防重入：新涂抹忽略并提示', () => {
        const host = makeRemoveHost([{ id: 7, image: { src: '/api/assets/a.png', bbox: [0, 0, 4, 4] } }]);
        host._selLayerId = 7;
        const tool = new MangaRemoveTool(host);
        tool._open = true;
        tool.layer = host._layerById(7);
        tool._removing = true;
        withRemoveDoc(() => tool._strokeStart(0, 0));
        expect(tool._stroke).toBe(null);
        expect(host.statusCalls.some((c) => /移除中/.test(c.text))).toBe(true);
    });

    test('会话失效自愈：会话已关/目标层失联时起笔自动重开对齐当前选中层', () => {
        const host = makeRemoveHost([{ id: 7, image: { src: '/a.png', bbox: [0, 0, 4, 4] } }]);
        host._selLayerId = 7;
        const tool = new MangaRemoveTool(host);
        // 场景一：关窗（hide→close）后 activeTool 仍停在 remove——旧版涂抹
        // 纯静默（无红罩无请求），用户实测踩中
        withRemoveDoc(() => tool._strokeStart(1, 1));
        expect(tool._open).toBe(true);                        // 自愈重开
        expect(host._removeMask).not.toBe(null);
        expect(tool._stroke).not.toBe(null);                  // 涂抹正常建立
        // 场景二：目标层随旧会话失联（切页/换文档）——对齐当前选中层重开
        const staleLayer = { id: 999, image: { src: '/old.png', bbox: [0, 0, 4, 4] } };
        tool.layer = staleLayer;
        withRemoveDoc(() => tool._strokeStart(1, 1));
        expect(tool.layer).toBe(host._layerById(7));          // 重新对齐
        expect(tool.layer.id).toBe(7);
        // 场景三：无选中图片层 → 自愈失败给明确提示（不再静默）
        const empty = makeRemoveHost([{ id: 8, image: { src: '/c.png', bbox: [0, 0, 4, 4] } }]);
        empty._selLayerId = null;
        const tool2 = new MangaRemoveTool(empty);
        withRemoveDoc(() => tool2._strokeStart(1, 1));
        expect(tool2._open).toBe(false);
        expect(empty.statusCalls.some((c) => c.isError && /选中一个图片层/.test(c.text))).toBe(true);
    });

    test('提交后目标层已不存在：明示未落地而非静默钉死「移除中」', async () => {
        const host = makeRemoveHost([{ id: 7, image: { src: '/api/assets/a.png', bbox: [0, 0, 4, 4] } }]);
        host._selLayerId = 7;
        const layer = host._layerById(7);
        const tool = new MangaRemoveTool(host);
        const origFetch = context.fetch;
        context.fetch = async () => ({ json: async () => ({ status: 'ok', image: 'data:image/png;base64,BBB', cost: 100, provider: 'cpu' }) });
        try {
            withRemoveDoc(() => {
                tool.open();
                tool._strokeStart(0, 0);
                tool._strokeEnd();
            });
            host._layerById = () => null;                     // 推理往返中层被删
            await flush();
        } finally {
            context.fetch = origFetch;
        }
        expect(layer.image.src).toBe('/api/assets/a.png');    // 未落地
        expect(host.statusCalls.some((c) => c.isError && /未落地/.test(c.text))).toBe(true);
        expect(tool._removing).toBe(false);
    });

    test('粗细滑杆接入：remove 显示选项条且滑块值跟随会话遮罩宽（灯箱遮罩独立笔宽同语义）', () => {
        const inst = makeInstance([]);
        inst._remove = new MangaRemoveTool(inst);
        inst._remove.width = 18;
        inst.activeTool = 'remove';
        inst._brushBarEl = { hidden: true };
        inst._brushSliderEl = { value: '4' };
        inst._brushWidthValEl = { textContent: '4' };
        inst._syncBrushBar();
        expect(inst._brushBarEl.hidden).toBe(false);          // remove 也显示选项条
        expect(inst._brushSliderEl.value).toBe('18');         // 滑块回填遮罩宽
        expect(inst._brushWidthValEl.textContent).toBe('18');
        inst.activeTool = 'brush';                            // 切回画笔：回填画笔宽
        inst._brushWidth = 7;
        inst._syncBrushBar();
        expect(inst._brushSliderEl.value).toBe('7');
        expect(inst._brushWidthValEl.textContent).toBe('7');
    });
});
// ==========================================================================
// 中键拖动平移（MangaGestures，ADR 077，灯箱 ImageStudio 同款迁移）
// ==========================================================================
