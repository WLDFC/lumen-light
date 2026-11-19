/**
 * generate 测试（2026-11-09 自 mangaEditor.test.js 按模块拆分）
 * 覆盖：MangaEditor._refreshGenModelDropdown 生图模型下拉（仅 API 模式）；MangaEditor._runGenerate comfy 委托面板提交（编译可选回落）；MangaEditor._consumeGenCapture 生成回流一次性捕获；MangaEditor 生成图回流分发与旧背景字段剥离（背景功能已退役，2026-11-08）；MangaEditor 生成图监听时序（构造器即挂）；MangaEditor 生成图 src 归一（_normalizeGenSrc）
 */

const { context, MangaEditor, CoordinateLayout, makeInstance } = require('./helpers');

describe('MangaEditor._refreshGenModelDropdown 生图模型下拉（仅 API 模式）', () => {
    // LumenLight 桩：本方法只消费 collectConfiguredModels/classifyModel 两个
    // 纯函数（真实实现属 js/config.js，不在本套件加载范围）；用 __ 前缀
    // 约定字段注入清单与分类结果
    context.LumenLight = {
        collectConfiguredModels: (api) => ({
            models: (api && api.__models) || [],
            providerCount: (api && api.__providerCount) || 1
        }),
        classifyModel: (m) => (m && m.__class) || 'chat',
        // 'provider||id' → { provider, id }（真实实现属 js/config.js；API 直连
        // 路径的生成用例消费）
        parseModelKey: (k) => {
            const i = String(k).indexOf('||');
            return i < 0 ? { provider: '', id: k } :
                { provider: String(k).slice(0, i), id: String(k).slice(i + 2) };
        }
    };

    const SETTINGS = (models, providerCount) => ({
        settings: { api: { __models: models, __providerCount: providerCount } }
    });
    const API_MODELS = [
        { key: 'A||img1', id: 'img1', displayName: '生图一号', provider: 'A', __class: 'image' },
        { key: 'A||chat1', id: 'chat1', displayName: '对话一号', provider: 'A', __class: 'chat' }
    ];

    /** fetch 桩：按 URL 路由（Error 实例 = 拒绝，模拟接口炸） */
    function stubFetch(routes) {
        context.fetch = (url) => {
            const body = routes[url];
            if (body instanceof Error) return Promise.reject(body);
            return Promise.resolve({ ok: true, json: async () => body });
        };
    }

    function makeInst() {
        const inst = Object.create(MangaEditor.prototype);
        inst._setCalls = [];
        inst.genModelDropdown = {
            setOptions: (items, selected) => inst._setCalls.push({ items, selected })
        };
        return inst;
    }

    beforeEach(() => { context.localStorage._s = {}; });

    test('Comfy 模式：清单预取缓存待命但不消费（下拉空，占位锁定由 _syncGenModeUi 管）', async () => {
        const fetched = [];
        context.fetch = (url) => {
            fetched.push(url);
            return Promise.resolve({ ok: true, json: async () => SETTINGS(API_MODELS, 2) });
        };
        const inst = makeInst();                    // 默认 comfy 模式
        await inst._refreshGenModelDropdown();
        expect(fetched).toEqual(['/api/settings']); // 只拉 API 清单（Comfy 清单接口不再用）
        expect(inst._setCalls).toHaveLength(0);     // comfy 模式不消费清单
        expect(inst._apiModelOptions).toHaveLength(1);   // 缓存待命（切 API 即用）
    });

    test('API 模式：只列生图模型（value 用 m.key 多厂商带后缀），对话模型过滤', async () => {
        const fetched = [];
        context.fetch = (url) => {
            fetched.push(url);
            return Promise.resolve({ ok: true, json: async () => SETTINGS(API_MODELS, 2) });
        };
        context.localStorage.setItem('lumenLight.mangaGenMode', 'api');
        const inst = makeInst();
        await inst._refreshGenModelDropdown();
        expect(fetched).toEqual(['/api/settings']);
        const { items } = inst._setCalls[0];
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ value: 'A||img1', label: '生图一号 · A' });
    });

    test('API 记忆：选择持久化，失效（模型被删）清除回落第一项', async () => {
        stubFetch({ '/api/settings': SETTINGS(API_MODELS, 1) });
        context.localStorage.setItem('lumenLight.mangaGenMode', 'api');
        context.localStorage.setItem('lumenLight.mangaGenModel.api', 'A||img1');
        const inst = makeInst();
        await inst._refreshGenModelDropdown();
        expect(inst._setCalls[0].selected).toBe('A||img1');

        context.localStorage.setItem('lumenLight.mangaGenModel.api', 'Z||gone');
        const goneInst = makeInst();
        await goneInst._refreshGenModelDropdown();
        expect(goneInst._setCalls[0].selected).toBe('');
        expect(context.localStorage.getItem('lumenLight.mangaGenModel.api')).toBeNull();
    });

    test('旧单键迁移：无 comfy: 前缀归 api 键；comfy: 前缀已退役不消费（旧键留存）', async () => {
        // 桩清单须含旧键引用的模型，否则会被「失效回落」路径清除（非迁移语义）
        stubFetch({ '/api/settings': SETTINGS([
            ...API_MODELS,
            { key: 'A||legacy', id: 'legacy', displayName: '旧模型', provider: 'A', __class: 'image' }
        ], 1) });
        context.localStorage.setItem('lumenLight.mangaGenMode', 'api');
        context.localStorage.setItem('lumenLight.mangaGenModel', 'A||legacy');
        const inst = makeInst();
        await inst._refreshGenModelDropdown();
        expect(inst._setCalls[0].selected).toBe('A||legacy');
        expect(context.localStorage.getItem('lumenLight.mangaGenModel')).toBeNull();
        expect(context.localStorage.getItem('lumenLight.mangaGenModel.api')).toBe('A||legacy');

        // comfy: 前缀旧值：Comfy 模型选择随面板委托退役——不迁移不消费，
        // api 模式回落第一项（'' 语义），旧键原样留存
        context.localStorage.removeItem('lumenLight.mangaGenModel.api');   // 清掉上一段迁移产物
        context.localStorage.setItem('lumenLight.mangaGenModel', 'comfy:gone.safetensors');
        const inst2 = makeInst();
        await inst2._refreshGenModelDropdown();
        expect(inst2._setCalls[0].selected).toBe('');
        expect(context.localStorage.getItem('lumenLight.mangaGenModel')).toBe('comfy:gone.safetensors');
    });

    test('接口炸：不抛错，空清单 + 传空回落', async () => {
        context.localStorage.setItem('lumenLight.mangaGenMode', 'api');
        stubFetch({ '/api/settings': new Error('boom') });
        const inst = makeInst();
        await expect(inst._refreshGenModelDropdown()).resolves.toBeUndefined();
        expect(inst._setCalls[0].items).toHaveLength(0);
        expect(inst._setCalls[0].selected).toBe('');
    });

    test('_genModelChoice/_saveGenModelChoice：api 键读写与 _genMode 默认值', () => {
        const inst = makeInst();
        expect(inst._genMode()).toBe('comfy');      // 无存储默认 comfy
        context.localStorage.setItem('lumenLight.mangaGenMode', 'api');
        expect(inst._genMode()).toBe('api');

        inst._saveGenModelChoice('api', 'A||m1');
        expect(inst._genModelChoice('api')).toBe('A||m1');
        inst._saveGenModelChoice('api', '');
        expect(inst._genModelChoice('api')).toBe('');
    });
});

describe('MangaEditor._runGenerate comfy 委托面板提交（编译可选回落）', () => {
    /** 生成链路桩：真实 _compile（CoordinateLayout 同上下文）+ 面板委托桩 */
    function makeGenInst(items, outText) {
        const inst = makeInstance(items);
        inst.aiOutTa = { value: outText || '' };
        inst.jsonNote = { textContent: '' };
        inst.copyBtn = { disabled: false };
        inst.genModelDropdown = { value: '' };
        inst._setGenRunning = (v) => { inst.genRunning = v; };
        return inst;
    }
    /** 面板桩：记录框写入、触发词补写与 runner.run 调用。
     *  框 1 预置质量词+触发词块（用户拍板：编辑器注入只进框 2，框 1 不动） */
    function stubPanel(workflowId) {
        const calls = { runs: 0, triggerSyncs: 0 };
        context.window.promptPanel = {
            workflowManager: { getCurrentWorkflowId: () => workflowId },
            triggerManager: { syncFromStack: () => { calls.triggerSyncs++; } },
            comfyRunner: { run: async () => { calls.runs++; } }
        };
        context.window.promptInputManager = {
            posPrompt: { value: 'masterpiece, <lora:xx:1>' },
            posPrompt2: { value: '旧框2' }
        };
        return calls;
    }

    beforeEach(() => {
        // 前序用例组可能残留模式存储——本组逐例复位
        context.localStorage._s = {};
        delete context.window.promptPanel;
        delete context.window.promptInputManager;
    });

    afterEach(() => {
        // 用例组不向后续 describe 泄漏全局（ImageExport/面板引用）
        delete context.window.promptPanel;
        delete context.window.promptInputManager;
        delete context.window.ImageExport;
    });

    const VALID_DRAFT = () => {
        const inst = makeGenInst(
            [{ label: 'object', caption: '一杯奶茶', bbox: [0, 0, 100, 100] }], '');
        inst.draft.summary.caption = '整体画面';       // 空 caption 本身会编译失败
        return inst;
    };

    test('编译成功 → 委托：产物写入正面框 2（框 1 质量词不动）→ run()，不进运行态', async () => {
        const calls = stubPanel('wf1');
        const inst = VALID_DRAFT();
        await inst._runGenerate();
        expect(calls.runs).toBe(1);
        expect(calls.triggerSyncs).toBe(0);           // 框 1 未动：无需触发词补写
        const pim = context.window.promptInputManager;
        expect(pim.posPrompt2.value).toContain('"summary"');   // MOSS JSON 产物进框 2
        expect(pim.posPrompt.value).toBe('masterpiece, <lora:xx:1>');   // 质量词原样保留
        expect(inst._genCaptureArmed).toBe(true);   // 一次性捕获武装等回流
        expect(inst.genRunning).toBeFalsy();        // 不进运行态（面板接管反馈）
    });

    test('编译失败 + 右栏有文本：右栏文本当提示词委托（不拦截）', async () => {
        stubPanel('wf1');
        const inst = makeGenInst([], '一只猫在窗台');   // items 空 + caption 空 → 编译必败
        await inst._runGenerate();
        const pim = context.window.promptInputManager;
        expect(pim.posPrompt2.value).toBe('一只猫在窗台');
        expect(pim.posPrompt.value).toBe('masterpiece, <lora:xx:1>');
        expect(inst.statusCalls.some((c) => c.text.includes('改用右栏文本'))).toBe(true);
        expect(inst._genCaptureArmed).toBe(true);
    });

    test('面板无框 2（异常形态）：回落写框 1', async () => {
        stubPanel('wf1');
        context.window.promptInputManager.posPrompt2 = null;
        const inst = VALID_DRAFT();
        await inst._runGenerate();
        expect(context.window.promptInputManager.posPrompt.value).toContain('"summary"');
    });

    test('面板未选工作流：拦截，不写框不委托', async () => {
        const calls = stubPanel(null);
        const inst = VALID_DRAFT();
        await inst._runGenerate();
        expect(calls.runs).toBe(0);
        expect(calls.triggerSyncs).toBe(0);
        const pim = context.window.promptInputManager;
        expect(pim.posPrompt.value).toBe('masterpiece, <lora:xx:1>');   // 框未被覆写
        expect(pim.posPrompt2.value).toBe('旧框2');
        expect(inst.statusCalls.at(-1).text).toContain('右侧 Comfy 面板选择工作流');
        expect(inst._genCaptureArmed).toBeFalsy();
    });

    test('面板未初始化：拦截报错', async () => {
        const fetched = [];
        context.fetch = async (url) => { fetched.push(url); };
        const inst = makeGenInst([], '随便写点');
        await inst._runGenerate();
        expect(fetched).toHaveLength(0);
        expect(inst.statusCalls.at(-1).text).toContain('提示词面板未初始化');
    });

    test('编译失败 + 右栏为空：拦截报错，不进运行态', async () => {
        const calls = stubPanel('wf1');
        const inst = makeGenInst([], '');
        await inst._runGenerate();
        expect(calls.runs).toBe(0);
        expect(inst.genRunning).toBeFalsy();
        expect(inst.statusCalls.at(-1).text).toContain('无可用提示词');
    });

    test('API 模式：仍直连 /api/llm/generate-image（运行态自理，结果落图层）', async () => {
        context.localStorage.setItem('lumenLight.mangaGenMode', 'api');
        stubPanel('wf1');                           // 面板在场但不应被碰
        const bodies = [];
        context.fetch = async (url, opts) => {
            bodies.push({ url, body: JSON.parse(opts.body) });
            return { ok: true, json: async () => ({ status: 'ok', imageUrl: '/api/assets/x.png' }) };
        };
        const inst = VALID_DRAFT();
        inst.genModelDropdown = { value: 'A||img1' };
        inst.pages = [inst.draft];                  // 落图层路径要按页安放
        inst.activePage = 0;
        inst._nextLayerId = 1;
        inst._uploadToAssets = async () => '/api/assets/manga-gen-1.png';
        context.window.ImageExport = { toDataUrl: async () => 'data:image/png;base64,x' };
        await inst._runGenerate();
        expect(bodies).toHaveLength(1);
        expect(bodies[0].url).toBe('/api/llm/generate-image');
        expect(bodies[0].body.prompt).toContain('"summary"');
        expect(context.window.promptInputManager.posPrompt.value).toBe('masterpiece, <lora:xx:1>');   // 面板未被写入
        expect(inst.draft.drawLayers).toHaveLength(1);   // 结果落图片图层
        expect(inst.draft.drawLayers[0].image.src).toBe('/api/assets/x.png');   // 稳定引用直接落层不转存
        expect(inst._selLayerId).toBe(inst.draft.drawLayers[0].id);   // 自动选中可抠图
        expect(inst.genRunning).toBe(false);        // 直连完成自动收尾
    });
});

describe('MangaEditor._consumeGenCapture 生成回流一次性捕获', () => {
    function makeGenInst() {
        const inst = Object.create(MangaEditor.prototype);
        inst.pages = [
            { width: 832, height: 1216, items: [] },
            { width: 832, height: 1216, items: [] }
        ];
        inst.activePage = 1;
        inst.draft = inst.pages[1];
        inst.genRunning = true;
        inst._nextLayerId = 1;
        inst._undoStack = [];
        inst._redoStack = [];
        inst._textHistPending = null;
        inst._histTimer = null;
        inst._scheduleSave = () => {};
        inst._renderRail = () => {};
        inst._status = () => {};
        inst._uploadToAssets = async () => '/api/assets/manga-gen-1.png';
        context.window.ImageExport = { toDataUrl: async () => 'data:image/png;base64,x' };
        return inst;
    }

    test('武装时消费一次：图落提交时刻的页图层并解除武装收尾', async () => {
        const inst = makeGenInst();
        inst._genCaptureArmed = true;
        inst._genCapturePage = 1;
        inst._genTaskRef = { end: (o) => { inst._taskEnd = o; } };

        expect(inst._consumeGenCapture('data:image/png;base64,abc')).toBe(true);
        await new Promise((r) => setTimeout(r, 0));   // _adoptGenerateResult 异步入库
        const layers = inst.pages[1].drawLayers;
        expect(layers).toHaveLength(1);
        expect(layers[0].image.src).toBe('/api/assets/manga-gen-1.png');
        expect(layers[0].image.bbox).toHaveLength(4); // contain 适配画幅
        expect(inst._selLayerId).toBe(layers[0].id);  // 自动选中：可立即拖动/抠图
        expect(inst._taskEnd).toBe('done');           // 任务中心随捕获结算
        expect(inst._genCaptureArmed).toBe(false);    // 一次性：解除武装
        expect(inst.genRunning).toBe(false);
    });

    test('未武装/重复消费返回 false；异页落点直写该页层栈（活动页不串图）', async () => {
        const inst = makeGenInst();
        expect(inst._consumeGenCapture('data:image/png;base64,abc')).toBe(false);

        inst._genCaptureArmed = true;
        inst._genCapturePage = 0;                     // 提交时在第 1 页，现已切到第 2 页
        expect(inst._consumeGenCapture('data:image/png;base64,abc')).toBe(true);
        await new Promise((r) => setTimeout(r, 0));
        expect(inst.pages[0].drawLayers).toHaveLength(1);
        expect(inst.pages[0].drawLayers[0].image.src).toBe('/api/assets/manga-gen-1.png');
        expect(inst.pages[1].drawLayers || []).toHaveLength(0);   // 活动页不串图
    });
});

describe('MangaEditor 生成图回流分发与旧背景字段剥离（背景功能已退役，2026-11-08）', () => {
    function makeBgInst() {
        const inst = makeInstance([]);
        inst._scheduleSave = () => {};
        return inst;
    }

    test('_draftForCompile 剥离旧档残留 background 字段（原稿不动）', () => {
        const inst = makeBgInst();
        inst.draft.background = '/api/assets/file/abc.png';
        const out = inst._draftForCompile();
        expect(out.background).toBeUndefined();
        expect(inst.draft.background).toBe('/api/assets/file/abc.png');
    });

    test('_onGeneratedImage：无捕获武装时不做任何事', () => {
        const inst = makeBgInst();
        expect(() => inst._onGeneratedImage({ detail: { src: '/api/assets/file/a.png' } })).not.toThrow();
    });

    test('_onGeneratedImage：armed 捕获优先消费（生成按钮回流落图层路径）', () => {
        const inst = makeBgInst();
        const consumed = [];
        inst._consumeGenCapture = (src) => { consumed.push(src); return true; };
        inst._onGeneratedImage({ detail: { src: '/api/assets/file/a.png' } });
        expect(consumed).toEqual(['/api/assets/file/a.png']);
    });
});

describe('MangaEditor 生成图监听时序（构造器即挂）', () => {
    test('_attachGeneratedImageListener：幂等只挂一次', () => {
        const added = [];
        const orig = context.window.addEventListener;
        context.window.addEventListener = (t) => added.push(t);
        try {
            const inst = makeInstance([]);
            inst._attachGeneratedImageListener();
            inst._attachGeneratedImageListener();
            expect(added.filter((t) => t === 'lumenGeneratedImage')).toHaveLength(1);
        } finally {
            context.window.addEventListener = orig;
        }
    });
});

describe('MangaEditor 生成图 src 归一（_normalizeGenSrc）', () => {
    const inst = makeInstance([]);

    test('裸 base64（WS new-image 契约）补 data: 前缀', () => {
        const out = inst._normalizeGenSrc('iVBORw0KGgoAAAABJRU5ErkJggg==');
        expect(out).toBe('data:image/png;base64,iVBORw0KGgoAAAABJRU5ErkJggg==');
    });

    test('data URL / 资产引用 / 同源路径 / http(s) 地址原样放行', () => {
        expect(inst._normalizeGenSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
        expect(inst._normalizeGenSrc('/api/assets/file/x.png')).toBe('/api/assets/file/x.png');
        expect(inst._normalizeGenSrc('/api/comfy/view?filename=a')).toBe('/api/comfy/view?filename=a');
        expect(inst._normalizeGenSrc('http://127.0.0.1:8188/view?filename=a')).toBe('http://127.0.0.1:8188/view?filename=a');
    });

    test('空值/非字符串返回空串（上游忽略）', () => {
        expect(inst._normalizeGenSrc('')).toBe('');
        expect(inst._normalizeGenSrc(null)).toBe('');
        expect(inst._normalizeGenSrc(42)).toBe('');
    });
});

// ==================== 逐格生成（2026-11-12）：元素框 → Comfy 批量 ====================

describe('MangaEditor._boxGenSize 框→生成尺寸（≈1MP 等比钳 64 倍数）', () => {
    const inst = makeInstance([]);

    test('正方形 512² → 1024²（面积正中 1MP）', () => {
        expect(inst._boxGenSize(512, 512)).toEqual({ width: 1024, height: 1024 });
    });

    test('横条 200×100：等比放大 ≈1MP、双维 64 倍数、比例近似保持', () => {
        const s = inst._boxGenSize(200, 100);
        expect(s.width % 64).toBe(0);
        expect(s.height % 64).toBe(0);
        expect(s.width / s.height).toBeGreaterThan(1.8);   // 64 取整容差内保 2:1
        expect(s.width / s.height).toBeLessThan(2.2);
        expect(s.width * s.height).toBeGreaterThan(0.9 * 1024 * 1024);
        expect(s.width * s.height).toBeLessThan(1.1 * 1024 * 1024);
    });

    test('超 1MP 大框 2048×1024：等比缩小（不是只放大）', () => {
        const s = inst._boxGenSize(2048, 1024);
        expect(s.width).toBeLessThan(2048);
        expect(s.height).toBeLessThan(1024);
        expect(s.width * s.height).toBeGreaterThan(0.9 * 1024 * 1024);
        expect(s.width * s.height).toBeLessThan(1.1 * 1024 * 1024);
    });

    test('极扁框：短边钳 64 下限（防极端比例出 0/个位数尺寸）', () => {
        const s = inst._boxGenSize(4000, 8);
        expect(s.height).toBe(64);
        expect(s.width % 64).toBe(0);
        expect(s.width).toBeGreaterThan(64);
    });
});

describe('MangaEditor._runPerElementGenerate 逐格批量：收集/拦截/串行/回流对位', () => {
    const tick = () => new Promise((r) => setTimeout(r, 0));

    /** 绕开 DOM 的批处理实例：items 带 cid（眼睛隐藏按 cid 过滤） */
    function makeBatchInst(items) {
        const inst = Object.create(MangaEditor.prototype);
        inst.pages = [
            { width: 1024, height: 1024, summary: { caption: '', canvas: 'single' },
                items: items.map((it) => ({ ...it })) },
            { width: 1024, height: 1024, summary: { caption: '', canvas: 'single' }, items: [] }
        ];
        inst.activePage = 0;
        inst.draft = inst.pages[0];
        inst.selected = -1;
        inst._multiSelected = new Set();   // Shift 多选集合（逐格范围）
        inst._hiddenCids = new Set();
        inst._nextLayerId = 1;
        inst._undoStack = [];
        inst._redoStack = [];
        inst.statusCalls = [];
        inst._status = (text, isError) => inst.statusCalls.push({ text, isError });
        inst._scheduleSave = () => { };
        inst._scheduleThumbRefresh = () => { };
        inst._renderStage = () => { };
        inst._renderLayerPanel = () => { };
        inst.genRunning = false;
        return inst;
    }

    /** 面板桩：run 记录 runOpts 并按序发布 pid（真实 runner 提交后写
     *  _activePromptIds 的语义）；taskRegistry 记录登记与结算 */
    function stubBatchPanel(runImpl) {
        const calls = { runOpts: [], updates: [], endStatus: null, endNote: null, registered: null };
        const runner = {
            _activePromptIds: [],
            run: runImpl || (async (opts) => {
                calls.runOpts.push(opts);
                runner._activePromptIds = ['pid-' + calls.runOpts.length];
            })
        };
        context.window.promptPanel = {
            workflowManager: { getCurrentWorkflowId: () => 'wf1' },
            comfyParams: { detected: { sizeTargets: [{ nodeId: 5, width: 512, height: 512 }] } },
            comfyRunner: runner
        };
        context.window.promptInputManager = {
            posPrompt: { value: '质量词' },
            posPrompt2: { value: '' }
        };
        context.window.taskRegistry = {
            register: (o) => {
                calls.registered = o;
                return {
                    update: (u) => calls.updates.push(u),
                    end: (s, n) => { calls.endStatus = s; calls.endNote = n; },
                    isRunning: () => true
                };
            }
        };
        calls.runner = runner;
        return calls;
    }

    beforeEach(() => { context.localStorage._s = {}; });
    // 失败用例也可能留下看门狗 interval——逐例清扫防泄漏（挂住 jest worker）
    let activeInst = null;
    afterEach(() => {
        if (activeInst) activeInst._clearBatchWatchdog();
        activeInst = null;
        context.window.__mangaGenSuppress = false;
        delete context.window.promptPanel;
        delete context.window.promptInputManager;
        delete context.window.taskRegistry;
        delete context.window.ImageExport;
    });

    test('两格串行：逐格写框 2 + latentSize 覆写 + count 1，全部回流后按 done 结算', async () => {
        const calls = stubBatchPanel();
        const inst = makeBatchInst([
            { cid: 'c1', label: 'object', caption: '一杯奶茶', bbox: [0, 0, 512, 256] },
            { cid: 'c2', label: 'character', caption: '女孩', title: '主角', shot: '前景',
                bbox: [100, 100, 400, 900] }
        ]);
        context.window.ImageExport = { toDataUrl: async () => 'data:image/png;base64,x' };
        activeInst = inst;
        await inst._runPerElementGenerate();
        await tick();   // 首格提交完成（run 桩同步发布 pid）
        expect(calls.registered).toMatchObject({ kind: 'comfy', total: 2 });
        expect(calls.runOpts).toHaveLength(1);
        expect(calls.runOpts[0].count).toBe(1);
        expect(calls.runOpts[0].latentSize).toEqual(inst._boxGenSize(512, 256));
        expect(context.window.promptInputManager.posPrompt2.value).toBe('一杯奶茶');
        expect(context.window.promptInputManager.posPrompt.value).toBe('质量词');   // 框 1 不动
        expect(inst._batchInflight).not.toBeNull();

        // 首格回流 → 续投第二格（景别织入）
        inst._onGeneratedImage({ detail: { src: '/api/assets/g1.png', promptIds: ['pid-1'] } });
        await tick();
        expect(calls.runOpts).toHaveLength(2);
        expect(context.window.promptInputManager.posPrompt2.value).toBe('前景，女孩');

        // 次格回流 → 完成：bbox 精确落框（提交时快照）
        inst._onGeneratedImage({ detail: { src: '/api/assets/g2.png', promptIds: ['pid-2'] } });
        await tick();
        expect(calls.endStatus).toBe('done');
        expect(inst._batchActive).toBe(false);
        expect(inst._batchByPromptId.size).toBe(0);
        const layers = inst.draft.drawLayers;
        expect(layers).toHaveLength(2);
        expect(layers[0].image.bbox).toEqual([0, 0, 512, 256]);
        expect(layers[0].name).toBe('生成·一杯奶茶');
        expect(layers[1].image.bbox).toEqual([100, 100, 400, 900]);   // 精确填满框
        expect(layers[1].name).toBe('生成·主角');
        expect(inst._selLayerId).toBe(layers[1].id);   // 入历史/自动选中同置入路径
        expect(inst._undoStack.length).toBeGreaterThan(0);
    });

    test('收集过滤：文字类型/空描述/眼睛隐藏跳过；bbox 快照与框现值解耦', async () => {
        const calls = stubBatchPanel();
        const inst = makeBatchInst([
            { cid: 'c1', label: 'text', caption: '台词不生成', bbox: [0, 0, 100, 100] },
            { cid: 'c2', label: 'object', caption: '', bbox: [0, 0, 100, 100] },
            { cid: 'c3', label: 'object', caption: '隐藏框', bbox: [0, 0, 100, 100] },
            { cid: 'c4', label: 'object', caption: '有效框', bbox: [10, 20, 330, 240] }
        ]);
        inst._hiddenCids.add('c3');
        context.window.ImageExport = { toDataUrl: async () => 'data:image/png;base64,x' };
        activeInst = inst;
        await inst._runPerElementGenerate();
        await tick();
        expect(calls.runOpts).toHaveLength(1);          // 只有 c4 入队
        expect(calls.registered.total).toBe(1);
        expect(calls.runOpts[0].latentSize).toEqual(inst._boxGenSize(320, 220));
        // 提交后改框现值：回流按快照落，不追现值
        inst.draft.items[3].bbox = [500, 500, 900, 900];
        inst._onGeneratedImage({ detail: { src: '/api/assets/g1.png', promptIds: ['pid-1'] } });
        await tick();
        expect(inst.draft.drawLayers[0].image.bbox).toEqual([10, 20, 330, 240]);
    });

    test('拦截：无面板 / 无工作流 / API 模式 / 全跳过 / 整页生成中', async () => {
        // 无面板
        let inst = makeBatchInst([{ cid: 'c1', label: 'object', caption: 'a', bbox: [0, 0, 10, 10] }]);
        await inst._runPerElementGenerate();
        expect(inst.statusCalls.at(-1).text).toContain('提示词面板未初始化');

        // 无工作流
        stubBatchPanel();
        context.window.promptPanel.workflowManager.getCurrentWorkflowId = () => null;
        await inst._runPerElementGenerate();
        expect(inst.statusCalls.at(-1).text).toContain('选择工作流');

        // API 模式
        context.window.promptPanel.workflowManager.getCurrentWorkflowId = () => 'wf1';   // 恢复工作流（上例置空）
        context.localStorage.setItem('lumenLight.mangaGenMode', 'api');
        await inst._runPerElementGenerate();
        expect(inst.statusCalls.at(-1).text).toContain('仅支持 Comfy');
        context.localStorage.removeItem('lumenLight.mangaGenMode');

        // 全跳过（text+空描述+隐藏）
        stubBatchPanel();
        inst = makeBatchInst([
            { cid: 'c1', label: 'text', caption: '台词', bbox: [0, 0, 10, 10] },
            { cid: 'c2', label: 'object', caption: '', bbox: [0, 0, 10, 10] }
        ]);
        await inst._runPerElementGenerate();
        expect(inst.statusCalls.at(-1).text).toContain('没有可生成的元素框');

        // 整页生成进行中
        stubBatchPanel();
        inst = makeBatchInst([{ cid: 'c1', label: 'object', caption: 'a', bbox: [0, 0, 10, 10] }]);
        inst.genRunning = true;
        await inst._runPerElementGenerate();
        expect(inst.statusCalls.at(-1).text).toContain('整页生成进行中');
    });

    test('无 sizeTargets：明示按工作流现值尺寸生成后继续（不拦批次）', async () => {
        const calls = stubBatchPanel();
        context.window.promptPanel.comfyParams.detected = { sizeTargets: [] };
        const inst = makeBatchInst([{ cid: 'c1', label: 'object', caption: 'a', bbox: [0, 0, 512, 512] }]);
        context.window.ImageExport = { toDataUrl: async () => 'data:image/png;base64,x' };
        await inst._runPerElementGenerate();
        await tick();
        expect(calls.runOpts).toHaveLength(1);   // 继续提交
        expect(inst.statusCalls.some((c) => c.text.includes('未探测到尺寸节点'))).toBe(true);
    });

    test('提交失败（run 无 promptId）：该格计败续投，下一格正常完成', async () => {
        let n = 0;
        const calls = stubBatchPanel(async (opts) => {
            n++;
            calls.runOpts.push(opts);
            calls.runner._activePromptIds = n === 1 ? [] : ['pid-2'];   // 首格提交未发生
        });
        const inst = makeBatchInst([
            { cid: 'c1', label: 'object', caption: '首个', bbox: [0, 0, 512, 512] },
            { cid: 'c2', label: 'object', caption: '次个', bbox: [0, 0, 512, 512] }
        ]);
        context.window.ImageExport = { toDataUrl: async () => 'data:image/png;base64,x' };
        activeInst = inst;
        await inst._runPerElementGenerate();
        await tick();
        expect(inst.statusCalls.some((c) => c.text.includes('提交失败'))).toBe(true);
        expect(calls.runOpts).toHaveLength(2);   // 两格各调一次 run（首格无 pid 计败）
        inst._onGeneratedImage({ detail: { src: '/api/assets/g2.png', promptIds: ['pid-2'] } });
        await tick();
        expect(calls.endStatus).toBe('done');
        expect(inst._batchFailed).toBe(1);
        expect(inst.draft.drawLayers).toHaveLength(1);   // 只有次格落层
    });

    test('超时格的迟来出图：按 promptId 对位落自己的框，不冒领 inflight', async () => {
        const calls = stubBatchPanel();
        const inst = makeBatchInst([
            { cid: 'c1', label: 'object', caption: '超时格', bbox: [0, 0, 100, 100] },
            { cid: 'c2', label: 'object', caption: '正常格', bbox: [200, 200, 400, 400] }
        ]);
        context.window.ImageExport = { toDataUrl: async () => 'data:image/png;base64,x' };
        activeInst = inst;
        await inst._runPerElementGenerate();
        await tick();
        // 首格看门狗计败（10 分钟无进度路径的直接驱动）→ 续投次格
        inst._batchItemFail(inst._batchInflight, '测试超时');
        await tick();
        expect(inst._batchInflight.promptId).toBe('pid-2');
        // 迟到的首格出图（pid-1）：落它自己的框，次格 inflight 不受影响
        inst._onGeneratedImage({ detail: { src: '/api/assets/g1.png', promptIds: ['pid-1'] } });
        await tick();
        expect(inst._batchInflight.promptId).toBe('pid-2');   // 未被打断
        expect(inst.draft.drawLayers).toHaveLength(1);
        expect(inst.draft.drawLayers[0].image.bbox).toEqual([0, 0, 100, 100]);
        // 次格正常回流 → 结算 done（1 成功 1 失败）
        inst._onGeneratedImage({ detail: { src: '/api/assets/g2.png', promptIds: ['pid-2'] } });
        await tick();
        expect(calls.endStatus).toBe('done');
        expect(inst.draft.drawLayers).toHaveLength(2);
    });

    test('停止：清队列按 stopped 结算，回流不再消费（不落层）', async () => {
        const calls = stubBatchPanel();
        const inst = makeBatchInst([
            { cid: 'c1', label: 'object', caption: '首个', bbox: [0, 0, 100, 100] },
            { cid: 'c2', label: 'object', caption: '次个', bbox: [200, 200, 400, 400] }
        ]);
        await inst._runPerElementGenerate();
        await tick();
        inst._stopPerElementGenerate();
        expect(inst._batchActive).toBe(false);
        expect(inst._batchQueue).toHaveLength(0);
        expect(calls.endStatus).toBe('stopped');
        expect(context.window.__mangaGenSuppress).toBe(false);   // 落画布抑制解除
        // 已提交首格的回流：批分支已关、单次捕获未武装 → 不落层不报错
        expect(() => inst._onGeneratedImage({
            detail: { src: '/api/assets/g1.png', promptIds: ['pid-1'] }
        })).not.toThrow();
        expect(inst.draft.drawLayers || []).toHaveLength(0);
    });

    test('批中途面板消失：中止剩余排队并按 failed 结算', async () => {
        const calls = stubBatchPanel();
        const inst = makeBatchInst([{ cid: 'c1', label: 'object', caption: 'a', bbox: [0, 0, 100, 100] }]);
        // 手工武装批状态后撤走面板（模拟批中途面板被销毁的异常形态）
        inst._batchActive = true;
        inst._batchQueue = [{ prompt: 'a', bbox: [0, 0, 100, 100], pageIdx: 0,
            genSize: { width: 1024, height: 1024 }, name: 'a' }];
        inst._batchTotal = 2;
        inst._batchDone = 1;
        inst._batchFailed = 0;
        inst._batchInflight = null;
        inst._batchByPromptId = new Map();
        inst._batchTaskRef = { update: () => { }, end: (s, n) => { calls.endStatus = s; calls.endNote = n; }, isRunning: () => true };
        delete context.window.promptInputManager;
        await inst._submitNextBatchItem();
        expect(calls.endStatus).toBe('failed');
        expect(inst._batchActive).toBe(false);
        expect(inst.statusCalls.some((c) => c.text.includes('提示词面板不可用'))).toBe(true);
    });

    test('范围：主选中单格=只跑该格（未选=全页回归不变）', async () => {
        const calls = stubBatchPanel();
        const inst = makeBatchInst([
            { cid: 'c1', label: 'object', caption: '一号', bbox: [0, 0, 100, 100] },
            { cid: 'c2', label: 'object', caption: '二号', bbox: [100, 100, 300, 300] },
            { cid: 'c3', label: 'object', caption: '三号', bbox: [300, 300, 500, 500] }
        ]);
        inst.selected = 1;   // 点选了二号
        context.window.ImageExport = { toDataUrl: async () => 'data:image/png;base64,x' };
        activeInst = inst;
        await inst._runPerElementGenerate();
        await tick();
        expect(calls.registered.total).toBe(1);
        expect(calls.registered.label).toContain('单格');
        expect(calls.runOpts).toHaveLength(1);
    });

    test('范围：Shift 多选集合=只跑选中格（草稿序，失效 cid 滤掉）', async () => {
        const calls = stubBatchPanel();
        const inst = makeBatchInst([
            { cid: 'c1', label: 'object', caption: '一号', bbox: [0, 0, 100, 100] },
            { cid: 'c2', label: 'object', caption: '二号', bbox: [100, 100, 300, 300] },
            { cid: 'c3', label: 'object', caption: '三号', bbox: [300, 300, 500, 500] }
        ]);
        inst._multiSelected = new Set(['c3', 'stale-cid', 'c1']);   // 无序集合 + 已删框的残留 cid
        context.window.ImageExport = { toDataUrl: async () => 'data:image/png;base64,x' };
        activeInst = inst;
        await inst._runPerElementGenerate();
        await tick();
        expect(calls.registered.total).toBe(2);              // stale 滤掉
        expect(calls.registered.label).toContain('选中');
        expect(calls.runOpts).toHaveLength(1);               // 串行：此刻只提交了首格
        // 草稿序提交（集合迭代序无关）：一号先于三号
        expect(context.window.promptInputManager.posPrompt2.value).toBe('一号');
        inst._onGeneratedImage({ detail: { src: '/api/assets/g1.png', promptIds: ['pid-1'] } });
        await tick();
        expect(calls.runOpts).toHaveLength(2);
        expect(context.window.promptInputManager.posPrompt2.value).toBe('三号');
    });

    test('范围：显式选中却全部不可用 → 拦截且不静默扩成全页', async () => {
        const calls = stubBatchPanel();
        const inst = makeBatchInst([
            { cid: 'c1', label: 'text', caption: '台词框', bbox: [0, 0, 100, 100] },
            { cid: 'c2', label: 'object', caption: '', bbox: [100, 100, 300, 300] }
        ]);
        inst._multiSelected = new Set(['c1', 'c2']);
        await inst._runPerElementGenerate();
        expect(calls.registered).toBeNull();
        expect(inst.statusCalls.at(-1).text).toContain('选中的框没有可生成');
    });

    test('_toggleMultiSelect：入集跟随主选中、出集清主选中、越界 no-op', () => {
        const inst = makeBatchInst([
            { cid: 'c1', label: 'object', caption: '一号', bbox: [0, 0, 100, 100] },
            { cid: 'c2', label: 'object', caption: '二号', bbox: [100, 100, 300, 300] }
        ]);
        inst.itemsEl = { querySelectorAll: () => [] };   // _select 刷卡片类用
        inst._toggleMultiSelect(0);   // 入集
        expect(inst._multiSelected.has('c1')).toBe(true);
        expect(inst.selected).toBe(0);   // 主选中跟随
        inst._toggleMultiSelect(1);   // 再入
        expect(inst.selected).toBe(1);
        inst._toggleMultiSelect(1);   // 出集（恰是主选中）→ 主选中清
        expect(inst.selected).toBe(-1);
        expect(inst._multiSelected.has('c2')).toBe(false);
        expect(inst._multiSelected.has('c1')).toBe(true);   // 其余成员不受影响
        expect(() => inst._toggleMultiSelect(99)).not.toThrow();   // 越界 no-op
    });

    test('_selectSingle：普通点击清多选集合（单选语义不变）', () => {
        const inst = makeBatchInst([
            { cid: 'c1', label: 'object', caption: '一号', bbox: [0, 0, 100, 100] },
            { cid: 'c2', label: 'object', caption: '二号', bbox: [100, 100, 300, 300] }
        ]);
        inst.itemsEl = { querySelectorAll: () => [] };
        inst._multiSelected = new Set(['c1', 'c2']);
        inst.selected = 0;
        inst._selectSingle(1);
        expect(inst._multiSelected.size).toBe(0);
        expect(inst.selected).toBe(1);
    });
});

// ==================== 多页文档（二期）：页面栏/切页/页面操作/迁移 ====================
