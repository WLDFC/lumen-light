/**
 * draftstore 测试（2026-11-09 自 mangaEditor.test.js 按模块拆分）
 * 覆盖：MangaEditor 草稿持久化（ADR 018）
 */

const { context, MangaEditor, CoordinateLayout, makeInstance } = require('./helpers');

describe('MangaEditor 草稿持久化（ADR 018）', () => {
    // 定时器/fetch 桩：防抖逻辑确定性推进（手动 flush 定时器队列），
    // 真实 setTimeout 只用于等微任务落定
    const realSetTimeout = global.setTimeout;
    let timers, timerSeq, fetchCalls, nextFetchResult;

    beforeEach(() => {
        timers = new Map(); timerSeq = 0; fetchCalls = [];
        nextFetchResult = { ok: true, status: 200, json: async () => ({ status: 'ok', draft: null }) };
        // vm context 与 Jest 共享全局：桩只在本套件生效，afterEach 必须还原，
        // 否则后面的套件（历史防抖用真实 setTimeout）拿到的是手动队列桩
        this._origSetTimeout = context.setTimeout;
        this._origClearTimeout = context.clearTimeout;
        this._origAbort = context.AbortController;
        this._origFetch = context.fetch;
        context.setTimeout = (fn) => { const id = ++timerSeq; timers.set(id, fn); return id; };
        context.clearTimeout = (id) => { timers.delete(id); };
        context.AbortController = AbortController;
        context.fetch = (url, opts) => {
            fetchCalls.push({ url, opts });
            return Promise.resolve(nextFetchResult);
        };
    });

    afterEach(() => {
        context.setTimeout = this._origSetTimeout;
        context.clearTimeout = this._origClearTimeout;
        context.AbortController = this._origAbort;
        context.fetch = this._origFetch;
    });

    const flushTimers = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach((fn) => fn()); };
    const SAVED_DRAFT = {
        width: 832, height: 1216,
        summary: { caption: '海报', canvas: 'collage' },
        items: [{ label: 'text', caption: '标题', text: '流光', bbox: [0, 0, 400, 200], shot: '前景' }],
        background: '/api/assets/bg-ref-1',
        backgroundSrcId: 'img-src-7'
    };

    /** 持久化用实例：保留真 _invalidateCompiled，只桩 DOM 触点与渲染 */
    function makePersistInstance() {
        const inst = Object.create(MangaEditor.prototype);
        inst.draft = CoordinateLayout.createDraft();
        inst.pages = [inst.draft];   // 二期多页：PUT 载荷 = 整文档
        inst.activePage = 0;
        inst.compiled = null;
        inst.copyBtn = { disabled: false };
        inst.aiOutTa = { value: '' };
        inst.jsonNote = { textContent: '' };
        inst._outMode = '';
        inst._saveTimer = null;
        inst._saveDirty = false;
        inst._draftTouched = false;
        inst._saveAbort = null;
        inst.statusCalls = [];
        inst._status = (text, isError) => inst.statusCalls.push({ text, isError });
        inst.renderAllCalls = 0;
        inst._renderAll = () => { inst.renderAllCalls++; };
        inst.layerPanelCalls = 0;
        inst._renderLayerPanel = () => { inst.layerPanelCalls++; };
        return inst;
    }

    // ADR 072：自动保存退役——草稿变更只标脏不落盘，显式保存是唯一持久化写
    test('草稿变更只标脏不落盘（自动保存退役）', () => {
        const inst = makePersistInstance();
        inst.draft.summary.caption = '连改三次';
        inst._invalidateCompiled();
        inst._invalidateCompiled();
        inst._invalidateCompiled();
        expect(inst._saveDirty).toBe(true);
        expect(fetchCalls).toHaveLength(0);       // 无防抖 PUT——保存只走显式 save()
        expect(inst._draftTouched).toBe(true);
    });

    test('save：有改动落盘成功推进保存点；失败报错且保存点不动', async () => {
        const inst = makePersistInstance();
        inst._exportSnap = inst._docSnapshot();
        inst.draft.summary.caption = '改动';
        inst._scheduleSave();
        await inst.save();
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0].url).toBe('/api/manga-draft');
        expect(fetchCalls[0].opts.method).toBe('PUT');
        const body = JSON.parse(fetchCalls[0].opts.body).draft;
        expect(body.pages).toHaveLength(1);
        expect(body.pages[0]).toEqual(inst.draft);
        expect(body.active).toBe(0);
        expect(inst._saveDirty).toBe(false);
        expect(inst.statusCalls.some((c) => /已保存/.test(c.text))).toBe(true);

        // 失败：脏标记保留、保存点不推进（关窗确认仍视作脏）、报错无「已保存」
        const bad = makePersistInstance();
        bad._exportSnap = bad._docSnapshot();
        bad.draft.summary.caption = '改动';
        bad._scheduleSave();
        nextFetchResult = { ok: false, status: 500, json: async () => ({ status: 'error', message: 'boom' }) };
        expect(await bad.save()).toBe(false);
        expect(bad._saveDirty).toBe(true);
        expect(bad._exportSnap).not.toBe(bad._docSnapshot());
        expect(bad.statusCalls.some((c) => c.isError && /保存失败/.test(c.text))).toBe(true);
    });

    test('_loadSavedDraft：远端草稿经归一回填（shot 保留）', async () => {
        nextFetchResult = { ok: true, status: 200, json: async () => ({ status: 'ok', draft: SAVED_DRAFT }) };
        const inst = makePersistInstance();
        await inst._loadSavedDraft();
        await new Promise((r) => realSetTimeout(r, 0));
        expect(inst.draft.width).toBe(832);
        expect(inst.draft.summary.canvas).toBe('collage');
        expect(inst.draft.items[0].shot).toBe('前景');
        expect(inst.draft.background).toBe('/api/assets/bg-ref-1');
        expect(inst.draft.backgroundSrcId).toBe('img-src-7');   // 旧档残留字段原样透传（功能已退役，仅剥离于编译前）
        expect(inst.renderAllCalls).toBe(1);
        expect(inst.layerPanelCalls).toBe(1);     // 层栈随恢复重渲染（F5 后面板空态 bug，2026-11-04）
        expect(inst.statusCalls.some((c) => /已恢复/.test(c.text))).toBe(true);
    });

    test('_loadSavedDraft：GET 返回前用户已动手则丢弃远端（竞态闸）', async () => {
        nextFetchResult = { ok: true, status: 200, json: async () => ({ status: 'ok', draft: SAVED_DRAFT }) };
        const inst = makePersistInstance();
        inst._draftTouched = true;
        await inst._loadSavedDraft();
        expect(inst.draft.width).toBe(1024);      // 保持默认草稿
        expect(inst.renderAllCalls).toBe(0);
        expect(inst.layerPanelCalls).toBe(0);
    });

    test('_loadSavedDraft：draft 为 null（无存档/损坏）静默保持默认', async () => {
        const inst = makePersistInstance();
        await inst._loadSavedDraft();
        expect(inst.renderAllCalls).toBe(0);
        expect(inst.layerPanelCalls).toBe(0);
        expect(inst.draft).toEqual(CoordinateLayout.createDraft());
    });

    // ADR 071 补遗三：存在项目但无 lastId 记录时自动收编最近项目——
    // 编辑器恒在项目内工作，生图转存/资源归集才有归属（否则生图落资产池，
    // 项目夹拿不到图——2026-11-07 真机分叉事故）
    test('_loadSavedDraft：无 lastId 自动收编最近项目（空项目按默认单页开进）', async () => {
        const applied = [];
        const inst = makePersistInstance();
        inst._applyLoadedDocument = (doc, project) => applied.push({ doc, project });
        const proj = { id: 'm-20261107-zz9z', name: '默认漫画' };
        const origFetch = context.fetch;
        context.fetch = (url) => {
            fetchCalls.push({ url });
            if (url === '/api/manga-projects') {
                return Promise.resolve({ ok: true, json: async () => ({ status: 'ok', projects: [proj] }) });
            }
            return Promise.resolve({ ok: true, json: async () => ({ status: 'ok', project: proj, draft: null }) });
        };
        try {
            await inst._loadSavedDraft();
        } finally {
            context.fetch = origFetch;
        }
        expect(fetchCalls[0].url).toBe('/api/manga-projects');   // 先拉列表
        expect(applied).toHaveLength(1);
        expect(applied[0].project).toBe(proj);                   // 收编最近项目
        expect(applied[0].doc.pages).toHaveLength(1);            // 空项目 → 默认单页
        expect(context.localStorage.getItem('lumenLight.mangaLastProject')).toBe('m-20261107-zz9z');
        expect(inst.statusCalls.some((c) => /已打开项目「默认漫画」/.test(c.text))).toBe(true);
        context.localStorage.removeItem('lumenLight.mangaLastProject');   // 不泄漏给后续用例
    });

    test('_loadSavedDraft：lastId 命中时不收编其他项目', async () => {
        const applied = [];
        const inst = makePersistInstance();
        inst._applyLoadedDocument = (doc, project) => applied.push({ doc, project });
        context.localStorage.setItem('lumenLight.mangaLastProject', 'm-20261107-aaaa');
        const newer = { id: 'm-20261107-zz9z', name: '最近项目' };
        const mine = { id: 'm-20261107-aaaa', name: '我的项目' };
        const origFetch = context.fetch;
        context.fetch = (url) => {
            fetchCalls.push({ url });
            if (url === '/api/manga-projects') {
                return Promise.resolve({ ok: true, json: async () => ({ status: 'ok', projects: [newer, mine] }) });
            }
            return Promise.resolve({ ok: true, json: async () => ({ status: 'ok', project: mine, draft: null }) });
        };
        try {
            await inst._loadSavedDraft();
        } finally {
            context.fetch = origFetch;
        }
        expect(applied[0].project).toBe(mine);   // 记录优先于最近使用
        expect(context.localStorage.getItem('lumenLight.mangaLastProject')).toBe('m-20261107-aaaa');
        context.localStorage.removeItem('lumenLight.mangaLastProject');
    });
});
