/**
 * shell 测试（2026-11-09 自 mangaEditor.test.js 按模块拆分）
 * 覆盖：MangaEditor 并排窗口（右缘留白与 ESC 守卫）；MangaEditor 保存/关闭确认（保存点快照，写回画布已退役 ADR 071）
 */

const { context, MangaEditor, CoordinateLayout, makeInstance } = require('./helpers');

describe('MangaEditor 并排窗口（右缘留白与 ESC 守卫）', () => {
    test('_clampGap：下限 0（默认全屏分叉）、上限保编辑器最小宽 900、非数字回落默认', () => {
        const inst = Object.create(MangaEditor.prototype);
        expect(inst._clampGap(540, 1920)).toBe(540);          // 常规值原样（取整）
        expect(inst._clampGap(80, 1920)).toBe(80);            // 无 360 下限（坐标编辑器才有）
        expect(inst._clampGap(0, 1920)).toBe(0);              // 全屏
        expect(inst._clampGap(-50, 1920)).toBe(0);            // 负值钳到全屏
        expect(inst._clampGap(5000, 1920)).toBe(1020);        // innerWidth-900
        expect(inst._clampGap('x', 1920)).toBe(0);            // 非数字 → 默认全屏
        expect(inst._clampGap(NaN, 1920)).toBe(0);
        // 窄屏上限塌到 0：不产生负宽
        expect(inst._clampGap(800, 1100)).toBe(200);
        expect(inst._clampGap(500, 800)).toBe(0);             // innerWidth<900 → 恒全屏
    });

    test('_shouldCloseOnEscape：弹窗内/无焦点目标关窗，外部面板不关', () => {
        const inst = Object.create(MangaEditor.prototype);
        const inside = { tag: 'editor-input' };
        inst.dialog = { contains: (t) => t === inside };
        expect(inst._shouldCloseOnEscape(inside)).toBe(true);          // 弹窗内
        expect(inst._shouldCloseOnEscape(null)).toBe(true);            // 无目标
        expect(inst._shouldCloseOnEscape(undefined)).toBe(true);
        expect(inst._shouldCloseOnEscape({ tag: 'llm-input' })).toBe(false);   // 面板输入框
        inst.dialog = null;
        expect(inst._shouldCloseOnEscape({ tag: 'llm-input' })).toBe(true);    // 无弹窗兜底关
    });

    // 布局开关/默认留白语义已收敛 LumenLayoutPanel 预制件（关-态=offGap
    // '0px' 全屏、getGap 恢复拖拽记忆），断言迁 test/components/
    // lumenLayoutPanel.test.js——此处保留 _clampGap 与 ESC 守卫
});

describe('MangaEditor 保存/关闭确认（保存点快照，写回画布已退役 ADR 071）', () => {
    /** 保存/关闭用实例：接主类纯逻辑方法，DOM/IO 全打桩 */
    function makeSaveInstance() {
        const inst = makeInstance([]);
        inst.pages = [inst.draft];
        inst.activePage = 0;
        inst.visible = false;
        inst.hideCalls = 0;
        inst.hide = function () { inst.hideCalls++; inst.visible = false; };
        inst._exportSnap = inst._docSnapshot();   // 等价 _buildDom 建的基线
        return inst;
    }

    test('_docSnapshot 含 pages+active：改内容/切页都变脏（ADR 072）', () => {
        const inst = makeSaveInstance();
        expect(inst._isPageDirty()).toBe(false);
        inst.draft.items.push({ label: 'object', caption: '', bbox: [0, 0, 10, 10] });
        expect(inst._isPageDirty()).toBe(true);
        // 切页也是未保存改动——重进回到上次保存时的页
        inst.pages.push({
            width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy',
            summary: { caption: '', canvas: 'single' }, items: []
        });
        inst._exportSnap = inst._docSnapshot();
        inst.activePage = 1;
        expect(inst._isPageDirty()).toBe(true);
    });

    test('requestClose：干净直接关，脏弹确认浮层不关窗', () => {
        const inst = makeSaveInstance();
        inst.visible = true;
        inst._confirmEl = { hidden: true };
        inst.requestClose();
        expect(inst.hideCalls).toBe(1);
        inst.visible = true;
        inst.draft.summary.caption = '改动';
        inst.requestClose();
        expect(inst.hideCalls).toBe(1);             // 未直接关
        expect(inst._confirmEl.hidden).toBe(false); // 浮层弹出
    });

    test('save：无新改动不重复落盘；有改动落盘并按项目归属汇报', async () => {
        const inst = makeSaveInstance();
        inst._saveNowCalls = 0;
        inst._saveNow = async function () { inst._saveNowCalls++; return true; };
        await inst.save();
        expect(inst.statusCalls[inst.statusCalls.length - 1].text).toContain('无新改动');
        expect(inst._saveNowCalls).toBe(0);        // 干净态不重复落盘
        inst.draft.items.push({ label: 'object', caption: '', bbox: [0, 0, 10, 10] });
        inst._saveDirty = true;
        await inst.save();
        expect(inst._saveNowCalls).toBe(1);        // 有改动才落盘
        expect(inst.statusCalls[inst.statusCalls.length - 1].text).toContain('默认草稿');
        // 保存点已推进：紧接再保存不重复汇报改动
        await inst.save();
        expect(inst.statusCalls[inst.statusCalls.length - 1].text).toContain('无新改动');

        const proj = makeSaveInstance();
        proj.currentProjectId = 'm-20261107-abcd';
        proj._saveNow = async function () { return true; };
        proj.draft.summary.caption = '改动';
        await proj.save();
        expect(proj.statusCalls[proj.statusCalls.length - 1].text).toContain('已保存到当前项目');
    });

    test('_confirmSaveAndClose：save 成功关窗收浮层', async () => {
        const inst = makeSaveInstance();
        inst.visible = true;
        inst._confirmEl = { hidden: false };
        inst._saveNow = async function () { return true; };
        inst.draft.summary.caption = '改动';
        await inst._confirmSaveAndClose();
        expect(inst._confirmEl.hidden).toBe(true);   // 浮层先收
        expect(inst.hideCalls).toBe(1);
    });

    test('_confirmCloseOnly：不落盘直接关，浮层随关收起并从服务端重载已保存态', () => {
        const inst = makeSaveInstance();
        inst.visible = true;
        inst._confirmEl = { hidden: false };
        let reloads = 0;
        inst._reloadSavedDocument = () => { reloads++; };
        inst._confirmCloseOnly();
        expect(inst.hideCalls).toBe(1);
        expect(inst._confirmEl.hidden).toBe(true);
        expect(reloads).toBe(1);   // 只丢内存不重载的话，同会话重开仍是改过的文档
    });

    test('_reloadSavedDocument：项目归属走 _openProjectById force，无项目走旧全局草稿', async () => {
        const proj = makeSaveInstance();
        proj.currentProjectId = 'm-20261107-abcd';
        proj.currentProjectName = 'A';
        const forceCalls = [];
        proj._openProjectById = async (id, name, opts) => forceCalls.push({ id, name, opts });
        await proj._reloadSavedDocument();
        expect(forceCalls).toEqual([{ id: 'm-20261107-abcd', name: 'A', opts: { force: true } }]);

        const legacy = makeSaveInstance();
        const applied = [];
        legacy._applyLoadedDocument = (doc, project) => applied.push({ doc, project });
        const origFetch = context.fetch;
        context.fetch = () => Promise.resolve({ ok: true, json: async () => ({ status: 'ok', draft: { pages: [{ width: 832, height: 1216, items: [] }], active: 0 } }) });
        try {
            await legacy._reloadSavedDocument();
        } finally {
            context.fetch = origFetch;
        }
        expect(applied).toHaveLength(1);
        expect(applied[0].doc.pages).toHaveLength(1);
        expect(applied[0].project).toBe(null);
    });

    // ADR 072：切项目遇未保存改动先确认（保存并打开 / 放弃修改）——
    // 未保存改动不自动落盘，也不在切换时静默持久化或静默丢弃
    test('_openProjectById：脏先弹确认；保存分支落盘成功才切，放弃分支直接切', async () => {
        const inst = makeSaveInstance();
        inst.draft.summary.caption = '未保存改动';
        const captured = [];
        inst._showSaveConfirm = (opts) => captured.push(opts);
        const applied = [];
        inst._applyLoadedDocument = (doc, project) => applied.push(project);
        const origFetch = context.fetch;
        context.fetch = (url) => {
            if (String(url).startsWith('/api/manga-projects/')) {
                return Promise.resolve({ ok: true, json: async () => ({ status: 'ok', project: { id: 'm-20261107-new1', name: '新项目' }, draft: null }) });
            }
            return origFetch(url);
        };

        try {
            await inst._openProjectById('m-20261107-new1', '新项目');
        expect(captured).toHaveLength(1);            // 脏：弹确认不直接切
        expect(captured[0].saveLabel).toBe('保存并打开');
        expect(captured[0].closeLabel).toBe('放弃修改');

        // 保存分支：save 失败不切
        inst.save = async () => false;
        await captured[0].onSave();
        expect(applied).toHaveLength(0);
        // 保存分支：成功才切（force 重入走真实 fetch+apply 流程）
        inst.save = async () => true;
        await captured[0].onSave();
        expect(applied).toHaveLength(1);
        // 放弃分支：不落盘直接切
        await captured[0].onClose();
        expect(applied).toHaveLength(2);
        } finally {
            context.fetch = origFetch;
        }
    });

    test('_openProjectById：干净态直接切不弹确认', async () => {
        const inst = makeSaveInstance();
        inst._showSaveConfirm = () => { throw new Error('不应弹确认'); };
        const origFetch = context.fetch;
        context.fetch = (url) => {
            if (String(url).startsWith('/api/manga-projects/')) {
                return Promise.resolve({ ok: true, json: async () => ({ status: 'ok', project: { id: 'm-20261107-new2', name: 'B' }, draft: null }) });
            }
            return origFetch(url);
        };
        try {
            await inst._openProjectById('m-20261107-new2', 'B');
        } finally {
            context.fetch = origFetch;
        }
        expect(inst.currentProjectId).toBe('m-20261107-new2');
        expect(inst._saveDirty).toBe(false);         // _applyLoadedDocument 载入即干净态
    });

    test('_addStrokeLayer：图片层选中态让位（新建图层后画笔落新层）', () => {
        const inst = makeSaveInstance();
        inst._layerImgCache = new Map();
        inst._nextLayerId = 1;
        inst._renderLayerPanel = () => {};
        inst._scheduleSave = () => {};
        const imgLayer = { id: 9, name: '图片 9', visible: true, image: { src: '/api/assets/x.png', fromSrc: '/api/assets/x.png', bbox: [0, 0, 10, 10] } };
        inst.draft.drawLayers = [imgLayer];
        inst._selLayerId = 9;   // 生成落图自动选中图片层
        const sl = inst._addStrokeLayer(true);
        expect(inst._selLayerId).toBe(null);   // 让位——_brushStart 不再优先图片层
        expect(inst._activeLayerId).toBe(sl.id);
    });
});
