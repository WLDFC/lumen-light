/**
 * adjust 测试（2026-11-09 自 mangaEditor.test.js 按模块拆分）
 * 覆盖：MangaAdjustTool 调色工具（ADR 074 自灯箱 StudioAdjustTool 迁移）
 */

const { context, MangaEditor, CoordinateLayout, makeInstance } = require('./helpers');

describe('MangaAdjustTool 调色工具（ADR 074 自灯箱 StudioAdjustTool 迁移）', () => {
    const MangaAdjustTool = context.window.MangaAdjustTool;

    /** vm 内 document.createElement 桩（canvas 支持像素管线；用完即删防泄漏）。
     *  同时临时压掉 setTimeout：open() 里挂「点弹窗外关闭」监听走 0ms 定时器，
     *  若真定时器在桩删除后触发会引用已不存在的 document（泄漏句柄 +
     *  worker 无法优雅退出警告的根源）——测试不消费该监听，压掉即稳 */
    function withFakeDocument(fn) {
        const ImageDataCtor = context.ImageData;
        const prevSetTimeout = context.setTimeout;
        context.setTimeout = () => 0;
        context.document = {
            createElement(tag) {
                if (tag === 'canvas') {
                    return {
                        width: 0, height: 0,
                        getContext() {
                            return {
                                drawImage() {}, clearRect() {}, putImageData() {},
                                getImageData(x, y, w, h) {
                                    return new ImageDataCtor(new Uint8ClampedArray(w * h * 4), w, h);
                                },
                                set imageSmoothingEnabled(v) {}, set imageSmoothingQuality(v) {}
                            };
                        },
                        toDataURL: () => 'data:image/png;base64,AAA'
                    };
                }
                return {
                    children: [], style: {}, dataset: {},
                    className: '', type: '', title: '', textContent: '', value: '', min: 0, max: 0, step: 0,
                    classList: { add() {}, remove() {}, toggle() {} },
                    addEventListener() {}, append(...cs) { this.children.push(...cs); },
                    closest: () => null, remove() {}, querySelectorAll: () => []
                };
            },
            addEventListener() {}, removeEventListener() {}
        };
        try {
            return fn();
        } finally {
            delete context.document;
            context.setTimeout = prevSetTimeout;
        }
    }

    function makeHost(layers) {
        return {
            visible: true,
            _selLayerId: null,
            _layerById: (id) => layers.find((l) => l.id === id) || null,
            _ensureLayerImage: () => ({ complete: true, naturalWidth: 2, naturalHeight: 2 }),
            activeTool: 'brush',
            _setToolCalls: [],
            _setTool(id) { this._setToolCalls.push(id); this.activeTool = id; },
            adjustBtn: {
                classList: { add() {}, remove() {} },
                getBoundingClientRect: () => ({ right: 50, top: 100, width: 15, height: 15 })
            },
            dialog: {
                appendChild() {},
                getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 })
            },
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
            _uploadToAssets: async () => '/api/assets/adjusted.png',
            _adjustPreview: null
        };
    }

    test('open 守卫：未选中图片层不开会话并提示', () => {
        const host = makeHost([{ id: 7, image: { src: '/api/assets/a.png', bbox: [0, 0, 2, 2] } }]);
        const tool = new MangaAdjustTool(host);
        tool.open();                                        // 未选中
        expect(tool._open).toBe(false);
        expect(host._adjustPreview).toBe(null);
        expect(host.statusCalls.some((c) => c.isError && /选中一个图片层/.test(c.text))).toBe(true);
        const textOnly = makeHost([{ id: 8, text: { content: 'x' } }]);
        textOnly._selLayerId = 8;
        const tool2 = new MangaAdjustTool(textOnly);
        tool2.open();                                       // 文字层不可调
        expect(tool2._open).toBe(false);
        expect(textOnly.statusCalls.some((c) => c.isError && /选中一个图片层/.test(c.text))).toBe(true);
    });

    test('open：选中图片层开会话（快照+预览钩子+强制选择工具），close 丢弃还原', () => {
        const host = makeHost([{ id: 7, image: { src: '/api/assets/a.png', bbox: [0, 0, 2, 2] } }]);
        host._selLayerId = 7;
        const tool = new MangaAdjustTool(host);
        withFakeDocument(() => tool.open());
        expect(tool._open).toBe(true);
        expect(host._adjustPreview).not.toBe(null);
        expect(host._adjustPreview.layerId).toBe(7);
        expect(host._adjustPreview.cv.complete).toBe(true);      // 预览画布补 Image 同款判据
        expect(host._adjustPreview.cv.naturalWidth).toBe(2);
        expect(host._setToolCalls).toContain('select');          // 防涂画干扰
        tool.close();                                       // 丢弃
        expect(tool._open).toBe(false);
        expect(host._adjustPreview).toBe(null);
        expect(host._setToolCalls[host._setToolCalls.length - 1]).toBe('brush');   // 恢复原工具
    });

    test('_processPipeline：亮度钳位/饱和度灰度化/色温反向/颗粒稳定/零参恒等', () => {
        const tool = new MangaAdjustTool({});
        const px = (r, g, b) => new context.ImageData(new Uint8ClampedArray([r, g, b, 255, r, g, b, 255]), 2, 1);

        // 亮度 +100：黑 → 中灰（128）
        let out = tool._processPipeline(px(0, 0, 0), { brightness: 100, contrast: 0, saturation: 0, temperature: 0, sharpen: 0, grain: 0 });
        expect([out.data[0], out.data[1], out.data[2]]).toEqual([128, 128, 128]);

        // 饱和度 -100：红 → Rec.601 灰度（R=G=B≈76）
        out = tool._processPipeline(px(255, 0, 0), { brightness: 0, contrast: 0, saturation: -100, temperature: 0, sharpen: 0, grain: 0 });
        expect(out.data[0]).toBe(out.data[1]);
        expect(out.data[1]).toBe(out.data[2]);
        expect(out.data[0]).toBe(76);

        // 色温 +100：暖 = R 增 B 减（绿不动）
        out = tool._processPipeline(px(128, 128, 128), { brightness: 0, contrast: 0, saturation: 0, temperature: 100, sharpen: 0, grain: 0 });
        expect(out.data[0]).toBe(178);
        expect(out.data[2]).toBe(78);
        expect(out.data[1]).toBe(128);

        // 颗粒：两次同参调用输出逐字节一致（固定种子瓦片，预览不沸腾）
        const p = { brightness: 0, contrast: 0, saturation: 0, temperature: 0, sharpen: 0, grain: 80 };
        const a = tool._processPipeline(px(200, 100, 50), p);
        const b = tool._processPipeline(px(200, 100, 50), p);
        expect(Array.from(a.data)).toEqual(Array.from(b.data));

        // 全零参：恒等（对比度系数 1、无饱和/锐化/颗粒）
        out = tool._processPipeline(px(10, 20, 30), { brightness: 0, contrast: 0, saturation: 0, temperature: 0, sharpen: 0, grain: 0 });
        expect([out.data[0], out.data[1], out.data[2]]).toEqual([10, 20, 30]);
    });

    test('save：全分辨率烘焙 → 入资产库换 src → 历史入账 + 脏标记；失败保留会话', async () => {
        const host = makeHost([{ id: 7, image: { src: '/api/assets/a.png', fromSrc: '/api/assets/a.png', bbox: [0, 0, 2, 2] } }]);
        host._selLayerId = 7;
        const layer = host._layerById(7);
        const tool = new MangaAdjustTool(host);
        withFakeDocument(() => tool.open());
        tool.params.brightness = 30;
        await withFakeDocument(() => tool.save());
        expect(layer.image.src).toBe('/api/assets/adjusted.png');   // 换新引用
        expect(layer.image.fromSrc).toBe('/api/assets/a.png');      // fromSrc 不动
        expect(host._commitHistoryLabels).toEqual(['调色']);
        expect(host._draftTouched).toBe(true);
        expect(host._scheduleSaveCalls).toBe(1);                    // ADR 072 只标脏
        expect(host._adjustPreview).toBe(null);
        expect(host._renderLayerPanelCalls).toBeGreaterThanOrEqual(1);
        expect(host.statusCalls.some((c) => /调色已应用/.test(c.text))).toBe(true);

        // 失败：会话保留（预览钩子还在舞台上），可重试或关闭丢弃
        const host2 = makeHost([{ id: 9, image: { src: '/api/assets/b.png', bbox: [0, 0, 2, 2] } }]);
        host2._selLayerId = 9;
        const tool2 = new MangaAdjustTool(host2);
        withFakeDocument(() => tool2.open());
        host2._uploadToAssets = async () => { throw new Error('boom'); };
        await withFakeDocument(() => tool2.save());
        expect(tool2._open).toBe(true);                             // 会话未拆
        expect(host2._adjustPreview).not.toBe(null);                // 预览仍在
        expect(host2._layerById(9).image.src).toBe('/api/assets/b.png');
        expect(host2.statusCalls.some((c) => c.isError && /调色保存失败/.test(c.text))).toBe(true);
        tool2.close();
        expect(host2._adjustPreview).toBe(null);
    });
});
