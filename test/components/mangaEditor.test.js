/**
 * ==========================================================================
 * MangaEditor 合并/解析单元测试
 * 覆盖 AI 写提示词的输出解析与回填（实测模型输出缺陷驱动）：
 *   - 行协议（当前请求的格式）：SUMMARY:/ITEM n:/ITEM n TEXT: 逐行解析、
 *     中文冒号/markdown 前缀/大小写容忍、值内冒号不断句、无关行忽略、
 *     空回复返回 null 交回 JSON 路径
 *   - JSON 兜底解析：代码围栏剥离、首尾大括号截取、尾逗号/字符串内
 *     裸换行两轮修复、真坏 JSON 抛可重试错误
 *   - _mergeAiReply：行协议与 JSON 共用；常规结构回填、items 嵌进
 *     summary 的变形归一（mimo 实测）、元素数量不足按序部分填并如实
 *     计数（不整体作废）、几何保持用户手画不动、状态如实汇报
 *   - 草稿持久化（ADR 018）：防抖合并 PUT、keepalive 兜底补发、
 *     失败报错保留脏标记、恢复回填/竞态闸/无存档静默
 *   - _aiSystemPrompt 技能指引注入（ADR 017 决策八）：不选技能=纯
 *     基础指令、选中=正文进框架语（流程性指令忽略）、超长截断、
 *     失效选择回落
 *   - 并排窗口：留白钳制（漫画分叉——下限 0 全屏/上限保三栏最小宽 900）、
 *     ESC 焦点守卫（弹窗内关、面板输入框不关）
 *   - 撤销/重做（ADR 017 决策十一）：快照入账去重、undo/redo 序列与
 *     状态往返、上限 50 裁剪、文本输入防抖合并一步、撤销后自动保存
 *     同步回滚、快捷键焦点守卫（并排时面板内放行）、新建/恢复清栈
 * 被测文件是浏览器端经典脚本（依赖全局 window），用 vm 模块加载；
 * 构造函数依赖 DOM，测试用 Object.create + 桩方法绕开（只测纯逻辑方法）。
 * 拆分后（ADR 026）组件按职责域拆为 manga-editor/ 混入模块——
 * vm 同载主类与十一个混入文件（混入 Object.assign 回原型，加载顺序同页面），
 * 原型方法与实例字段契约不变，测试工厂零改动。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = {
    console,
    window: {},
    // localStorage 桩：模型优先级链测试用（组件方法运行时读取）
    localStorage: {
        _s: {},
        getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
        setItem(k, v) { this._s[k] = String(v); },
        removeItem(k) { delete this._s[k]; }
    }
};
// 真实定时器常驻注入（组件防抖逻辑依赖；套件级桩覆盖后恢复到这里）
context.setTimeout = setTimeout;
context.clearTimeout = clearTimeout;
context.AbortController = AbortController;   // API 直连生成路径 new AbortController
// Image 桩：src 赋值即异步 onload（生成落图层路径要读结果图尺寸）；
// complete=true 供橡皮烘焙路径的就绪校验（真实 Image 加载完成后同为 true）
context.Image = class {
    constructor() { this.naturalWidth = 100; this.naturalHeight = 100; this.complete = true; }
    set src(v) { this._src = v; queueMicrotask(() => this.onload && this.onload()); }
    get src() { return this._src; }
};
vm.createContext(context);
// ImageData 最小 polyfill：MangaAdjustTool._processPipeline 在 vm 内构造
// 处理结果（Node 无浏览器 ImageData，测试断言从 Node 侧读 .data）
context.ImageData = class {
    constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
// rAF 最小桩：MangaAdjustTool 的预览节流/收尾清理引用（测试不走真帧调度）
context.requestAnimationFrame = () => 0;
context.cancelAnimationFrame = () => {};
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/components/MangaEditor.js'), 'utf-8'),
    context, { filename: 'MangaEditor.js' });
// 调色工具独立类（ADR 074）：主类构造器实例化消费，随主类加载
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/components/manga-editor/MangaAdjustTool.js'), 'utf-8'),
    context, { filename: 'MangaAdjustTool.js' });
// 移除工具独立类（ADR 076）：主类构造器实例化消费，随主类加载
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/components/manga-editor/MangaRemoveTool.js'), 'utf-8'),
    context, { filename: 'MangaRemoveTool.js' });
// 画布节点类型谓词（ADR 075 文件菜单过滤画布真实图片用）
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/utils/NodeTypes.js'), 'utf-8'),
    context, { filename: 'NodeTypes.js' });
// 文字层共享纯函数层（ADR 067）：MangaText 委托消费，先于混入装载
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/utils/TextLayout.js'), 'utf-8'),
    context, { filename: 'TextLayout.js' });
// 形状几何共享纯函数层（ADR 069）：MangaShape 委托消费，先于混入装载
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/utils/ShapeLayout.js'), 'utf-8'),
    context, { filename: 'ShapeLayout.js' });
// 色板取色器共享预制件（ADR 068）：MangaTools setColor/pushRecentColor 消费
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/components/LumenColorPicker.js'), 'utf-8'),
    context, { filename: 'LumenColorPicker.js' });
// 子模块混入文件同载（须后于主类——Object.assign 进 MangaEditor.prototype）
for (const f of ['MangaDom.js', 'MangaPanel.js', 'MangaStage.js', 'MangaGestures.js',
    'MangaTools.js', 'MangaLayers.js', 'MangaPageRender.js', 'MangaLayerPanel.js',
    'MangaHistory.js', 'MangaDraftStore.js', 'MangaAi.js',
    'MangaBackground.js', 'MangaTemplates.js', 'MangaPages.js', 'MangaGenerate.js', 'MangaText.js',
    'MangaShape.js', 'MangaProjects.js']) {
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '../../js/components/manga-editor/', f), 'utf-8'),
        context, { filename: f });
}
// CoordinateLayout 一并加载进同一上下文（景别剥离后的编译断言用；
// 组件运行时消费它，测试环境同样供给）
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/utils/CoordinateLayout.js'), 'utf-8'),
    context, { filename: 'CoordinateLayout.js' });
const MangaEditor = context.window.MangaEditor;
const CoordinateLayout = context.window.CoordinateLayout;

/** 造一个绕开 DOM 的实例：只接纯逻辑方法，渲染/状态方法打桩 */
function makeInstance(items) {
    const inst = Object.create(MangaEditor.prototype);
    inst.draft = {
        width: 1024, height: 1024,
        bbox_coord_space: 'abs', bbox_format: 'xyxy',
        summary: { caption: '', canvas: 'single' },
        items: items.map((it) => ({ ...it }))
    };
    inst._undoStack = [];   // 景别/合并路径会入账历史
    inst._redoStack = [];
    inst.statusCalls = [];
    inst._status = (text, isError) => inst.statusCalls.push({ text, isError });
    inst._invalidateCompiled = () => {};
    inst._renderAll = () => {};
    inst._renderStage = () => {};
    return inst;
}

describe('MangaEditor._parseAiLines 行协议解析', () => {
    const inst = makeInstance([]);

    test('标准行协议：SUMMARY + 逐元素 + TEXT 行', () => {
        const r = inst._parseAiLines('SUMMARY: A poster.\nITEM 1: Title.\nITEM 1 TEXT: 诗。\nITEM 2: Cup.');
        expect(r).toEqual({
            summary: { caption: 'A poster.' },
            items: [{ caption: 'Title.', text: '诗。' }, { caption: 'Cup.' }]
        });
    });

    test('容忍中文冒号 / markdown 前缀 / 大小写 / 无空格序号', () => {
        const r = inst._parseAiLines('**SUMMARY：** 描述\n- item1：物体\n* Item 2 text ： 文字');
        expect(r.summary.caption).toBe('描述');
        expect(r.items[0].caption).toBe('物体');
        expect(r.items[1].text).toBe('文字');
    });

    test('值内含冒号不断句（首个冒号后全取）', () => {
        const r = inst._parseAiLines('ITEM 1: 时间：下午三点，光线柔和');
        expect(r.items[0].caption).toBe('时间：下午三点，光线柔和');
    });

    test('中文字段名容忍（模型本地化输出）：整体描述/元素 N/元素 N 文字', () => {
        const r = inst._parseAiLines('整体描述：拼贴海报。\n元素 1：少女半身。\n元素1文字：慢下来\n条目 2：干花');
        expect(r.summary.caption).toBe('拼贴海报。');
        expect(r.items[0]).toEqual({ caption: '少女半身。', text: '慢下来' });
        expect(r.items[1].caption).toBe('干花');
    });

    test('末路兜底：无字段行时纯编号行（1. / 1、/ 1)）按序当元素描述', () => {
        const r = inst._parseAiLines('好的，文案如下：\n1. 第一个的描述\n2、第二个的描述\n3) 第三个的描述');
        expect(r.summary.caption).toBe('');
        expect(r.items.map((i) => i.caption)).toEqual(['第一个的描述', '第二个的描述', '第三个的描述']);
        // 编号跳跃不塌：5 号行保留 2-4 号为空占位
        const r2 = inst._parseAiLines('1. a\n5. b');
        expect(r2.items.length).toBe(5);
        expect(r2.items[4].caption).toBe('b');
    });

    test('无关行忽略；纯寒暄/空回复返回 null 交回 JSON 路径', () => {
        expect(inst._parseAiLines('好的，请稍等')).toBeNull();
        expect(inst._parseAiLines('')).toBeNull();
        const r = inst._parseAiLines('前言行\nITEM 1: x\n尾注行');
        expect(r.items[0].caption).toBe('x');
        expect(r.items.length).toBe(1);
    });

    test('_parseAiResult：行协议优先，纯 JSON 回复回退 JSON 路径', () => {
        expect(inst._parseAiResult('SUMMARY: S\nITEM 1: C').summary.caption).toBe('S');
        expect(inst._parseAiResult('{"summary":{"caption":"J"},"items":[]}').summary.caption).toBe('J');
    });
});

describe('MangaEditor._parseAiReply JSON 兜底', () => {
    const inst = makeInstance([]);

    test('纯 JSON / 代码围栏 / 前后缀解释文本 均可解析', () => {
        expect(inst._parseAiReply('{"a":1}')).toEqual({ a: 1 });
        expect(inst._parseAiReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
        expect(inst._parseAiReply('好的，结果如下：\n{"a":1}\n希望有帮助！')).toEqual({ a: 1 });
    });

    test('尾逗号自动修复', () => {
        expect(inst._parseAiReply('{"summary":{"caption":"x",},"items":[,]}'))
            .toEqual({ summary: { caption: 'x' }, items: [] });
    });

    test('字符串内裸换行自动修复为 \\n 转义', () => {
        const parsed = inst._parseAiReply('{"summary":{"caption":"第一行\n第二行"}}');
        expect(parsed.summary.caption).toBe('第一行\n第二行');
    });

    test('真坏 JSON 抛带可重试提示的错误；无格式回复带开头片段便于诊断', () => {
        expect(() => inst._parseAiReply('{"summary":{"caption" "缺冒号"}}'))
            .toThrow(/无法解析.*可重试/);
        expect(() => inst._parseAiReply('完全没有大括号的回复'))
            .toThrow(/无法识别回复格式.*完全没有大括号/);
    });
});

describe('MangaEditor._resolveAiModel 优先级链', () => {
    const MODELS = [
        { key: 'A||m1', provider: 'A', id: 'm1', displayName: 'M1' },
        { key: 'B||m2', provider: 'B', id: 'm2', displayName: 'M2' }
    ];
    beforeEach(() => { context.localStorage._s = {}; });

    function makeInst() {
        const inst = Object.create(MangaEditor.prototype);
        inst._aiModels = MODELS;
        inst._loadChatModels = async () => MODELS;
        return inst;
    }

    test('显式选择（mangaModel）最优先，压过 piModelKey', async () => {
        context.localStorage.setItem('lumenLight.mangaModel', 'B||m2');
        context.localStorage.setItem('piModelKey', 'A||m1');
        expect(await makeInst()._resolveAiModel()).toBe('B||m2');
    });

    test('无显式选择时跟随 piModelKey（Agent 模型）', async () => {
        context.localStorage.setItem('piModelKey', 'A||m1');
        expect(await makeInst()._resolveAiModel()).toBe('A||m1');
    });

    test('piModelKey 失效回落技能栏模型', async () => {
        context.localStorage.setItem('piModelKey', 'X||gone');
        context.localStorage.setItem('lumenLight.skillModel', 'B||m2');
        expect(await makeInst()._resolveAiModel()).toBe('B||m2');
    });

    test('全失效回落第一序聊天模型', async () => {
        context.localStorage.setItem('piModelKey', 'X||gone');
        context.localStorage.setItem('lumenLight.skillModel', 'Y||gone');
        expect(await makeInst()._resolveAiModel()).toBe('A||m1');
    });

    test('显式选择失效（模型被删）也回落跟随链', async () => {
        context.localStorage.setItem('lumenLight.mangaModel', 'Z||deleted');
        context.localStorage.setItem('piModelKey', 'A||m1');
        expect(await makeInst()._resolveAiModel()).toBe('A||m1');
    });
});

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

describe('MangaEditor 景别辅助（item.shot）', () => {
    test('选景别把词前缀进 caption；换景别换前缀；清除摘前缀并删字段', () => {
        const inst = makeInstance([{ label: 'object', caption: '', bbox: [0, 0, 100, 100] }]);
        inst._onShotChange(0, '前景', null);
        expect(inst.draft.items[0]).toMatchObject({ shot: '前景', caption: '前景，' });
        inst._onShotChange(0, '后景', null);
        expect(inst.draft.items[0]).toMatchObject({ shot: '后景', caption: '后景，' });
        inst._onShotChange(0, '', null);
        expect(inst.draft.items[0].caption).toBe('');
        expect('shot' in inst.draft.items[0]).toBe(false);
    });

    test('已有文案不重复加词；用户文案里已含该词则完全不动', () => {
        const inst = makeInstance([{ label: 'object', caption: '一杯奶茶', bbox: [0, 0, 100, 100] }]);
        inst._onShotChange(0, '前景', null);
        expect(inst.draft.items[0].caption).toBe('前景，一杯奶茶');
        inst._onShotChange(0, '前景', null);   // 重复选同值不叠加
        expect(inst.draft.items[0].caption).toBe('前景，一杯奶茶');
        const inst2 = makeInstance([{ label: 'object', caption: '中景的吧台与咖啡师', bbox: [0, 0, 100, 100] }]);
        inst2._onShotChange(0, '中景', null);
        expect(inst2.draft.items[0].caption).toBe('中景的吧台与咖啡师');
    });

    test('_draftForCompile：剥离 shot 后可编译（编辑器元数据不进 MOSS 产物）', () => {
        const inst = makeInstance([]);
        inst.draft.summary.caption = '海报。';
        inst.draft.items = [{ label: 'object', caption: '前景，奶茶', shot: '前景', bbox: [0, 0, 512, 512] }];
        const clean = inst._draftForCompile();
        expect('shot' in clean.items[0]).toBe(false);
        const r = CoordinateLayout.compileDraft(clean);
        expect(r.ok).toBe(true);
        expect(r.prompt).toContain('前景，奶茶');
        expect(r.prompt).not.toContain('"shot"');
        // 原始草稿（带 shot）直接编译应被拒——证明剥离是必要的
        expect(CoordinateLayout.compileDraft(inst.draft).ok).toBe(false);
    });
});

describe('MangaEditor._mergeAiReply', () => {
    const baseItems = [
        { label: 'text', caption: '', text: '', bbox: [100, 100, 400, 200] },
        { label: 'object', caption: '', bbox: [0, 512, 1024, 1024] }
    ];

    test('常规结构：summary 与逐元素 caption/text 回填，几何不动', () => {
        const inst = makeInstance(baseItems);
        inst._mergeAiReply(JSON.stringify({
            summary: { caption: 'A poster.' },
            items: [
                { caption: 'Dark-green title.', text: '把日常，过成诗。' },
                { caption: 'An ivory cup.' }
            ]
        }));
        expect(inst.draft.summary.caption).toBe('A poster.');
        expect(inst.draft.items[0].caption).toBe('Dark-green title.');
        expect(inst.draft.items[0].text).toBe('把日常，过成诗。');
        expect(inst.draft.items[1].caption).toBe('An ivory cup.');
        // 几何保持用户手画
        expect(inst.draft.items[0].bbox).toEqual([100, 100, 400, 200]);
        expect(inst.draft.items[1].bbox).toEqual([0, 512, 1024, 1024]);
        // 非 text 元素不引入 text 字段
        expect('text' in inst.draft.items[1]).toBe(false);
        expect(inst.statusCalls.at(-1)).toEqual({ text: 'AI 已填写文案', isError: false });
    });

    test('items 嵌进 summary 的变形结构归一（mimo 实测缺陷）', () => {
        const inst = makeInstance(baseItems);
        inst._mergeAiReply(JSON.stringify({
            summary: {
                caption: 'A warm poster.',
                items: [
                    { caption: 'Nested title.', text: '诗。' },
                    { caption: 'Nested cup.' }
                ]
            }
        }));
        expect(inst.draft.summary.caption).toBe('A warm poster.');
        expect(inst.draft.items[0].caption).toBe('Nested title.');
        expect(inst.draft.items[1].caption).toBe('Nested cup.');
    });

    test('元素数量少于布局：按序填前 N 个并如实计数（不整体作废）', () => {
        const inst = makeInstance(baseItems);
        inst.draft.items[0].caption = '已有文案';
        inst._mergeAiReply(JSON.stringify({
            summary: { caption: 'x' },
            items: [{ caption: 'only one' }]
        }));
        expect(inst.draft.items[0].caption).toBe('only one');
        expect(inst.draft.items[1].caption).toBe('');
        expect(inst.statusCalls.at(-1).text).toContain('元素文案 1/2');
    });

    test('行协议回复直接合并：缺行少填、如实计数', () => {
        const inst = makeInstance(baseItems);
        inst._mergeAiReply('SUMMARY: 海报。\nITEM 2: 只有第二个元素的文案');
        expect(inst.draft.summary.caption).toBe('海报。');
        expect(inst.draft.items[0].caption).toBe('');
        expect(inst.draft.items[1].caption).toBe('只有第二个元素的文案');
        expect(inst.statusCalls.at(-1).text).toContain('元素文案 1/2');
    });

    test('缺 items 时如实汇报（不谎报全部完成）', () => {
        const inst = makeInstance(baseItems);
        inst._mergeAiReply(JSON.stringify({ summary: { caption: 'Only summary.' } }));
        expect(inst.draft.summary.caption).toBe('Only summary.');
        expect(inst.statusCalls.at(-1).text).toContain('元素文案 0/2');
    });

    test('部分元素缺 caption 时计数如实', () => {
        const inst = makeInstance(baseItems);
        inst._mergeAiReply(JSON.stringify({
            summary: { caption: 'x' },
            items: [{ caption: '' }, { caption: 'filled' }]
        }));
        expect(inst.statusCalls.at(-1).text).toContain('元素文案 1/2');
    });
});

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
        expect(inst.draft.backgroundSrcId).toBe('img-src-7');   // 来源 id 随背景透传（删图联动）
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

describe('MangaEditor._aiSystemPrompt 技能指引注入（ADR 017 决策八）', () => {
    const SKILL_ID = 'moss-image-prompt-enhancer';
    const SKILL_BODY = 'Write readable JSON. Use boxes for coherent visible units.\nRun python3 scripts/compile_prompt.py draft.json';

    function makeInst() {
        const inst = Object.create(MangaEditor.prototype);
        inst._skillBodies = new Map([[SKILL_ID, SKILL_BODY]]);
        return inst;
    }

    beforeEach(() => { context.localStorage._s = {}; });

    test('不选技能：纯基础指令（行协议在、无指引标记）', () => {
        const p = makeInst()._aiSystemPrompt();
        expect(p).toContain('SUMMARY:');
        expect(p).toContain('ITEM 1:');
        expect(p).not.toContain('指引开始');
    });

    test('选中技能：正文注入，框架语声明流程性指令忽略', () => {
        context.localStorage.setItem('lumenLight.mangaSkill', SKILL_ID);
        const p = makeInst()._aiSystemPrompt();
        expect(p).toContain('--- 指引开始 ---');
        expect(p).toContain('coherent visible units');
        expect(p).toContain('一律忽略');
        // 基础指令仍在（行协议不会被指引顶掉）
        expect(p.indexOf('SUMMARY:')).toBeLessThan(p.indexOf('指引开始'));
    });

    test('选中的技能已不在缓存（被删/禁用）：回落基础指令', () => {
        context.localStorage.setItem('lumenLight.mangaSkill', 'gone-skill');
        const p = makeInst()._aiSystemPrompt();
        expect(p).not.toContain('指引开始');
    });

    test('技能正文超长截断到上限并注明', () => {
        const long = 'x'.repeat(20001);
        const inst = makeInst();
        inst._skillBodies.set('long-skill', long);
        context.localStorage.setItem('lumenLight.mangaSkill', 'long-skill');
        const p = inst._aiSystemPrompt();
        expect(p).toContain('已截断');
        // 截断到恰好 20000 字符：连续段存在、原长段不存在
        expect(p).toContain('x'.repeat(20000));
        expect(p).not.toContain('x'.repeat(20001));
    });
});

describe('MangaEditor._compile/_invalidateCompiled 输出框（右栏共用）', () => {
    function makeOutInst() {
        const inst = Object.create(MangaEditor.prototype);
        inst.draft = {
            width: 1024, height: 1024,
            bbox_coord_space: 'abs', bbox_format: 'xyxy',
            summary: { caption: 'A poster.', canvas: 'single' },
            items: [{ label: 'object', caption: 'A cup.', bbox: [64, 64, 512, 512] }]
        };
        inst.compiled = null;
        inst.copyBtn = { disabled: false };
        inst.aiOutTa = { value: '' };
        inst.jsonNote = { textContent: '' };
        inst._outMode = '';
        inst.statusCalls = [];
        inst._status = (text, isError) => inst.statusCalls.push({ text, isError });
        inst._saveTimer = null;
        inst._saveDirty = false;
        inst._draftTouched = true;   // 编译不改草稿，不触发保存断言
        inst._scheduleSave = () => {};
        return inst;
    }

    test('编译成功：产物写入右栏输出框 + 尺寸提醒', () => {
        const inst = makeOutInst();
        inst._compile();
        expect(inst.compiled.ok).toBe(true);
        expect(inst.aiOutTa.value).toContain('"summary"');
        expect(inst.aiOutTa.value).toContain('abs_centralized');
        expect(inst.jsonNote.textContent).toContain('1024×1024');
        expect(inst._outMode).toBe('compile');
        expect(inst.copyBtn.disabled).toBe(false);
    });

    test('编译失败：右栏旧编译产物清空、按钮禁用、状态报错', () => {
        const inst = makeOutInst();
        inst.aiOutTa.value = '旧产物';
        inst._outMode = 'compile';
        inst.draft.items = [];   // 空 items 编译必失败
        inst._compile();
        expect(inst.compiled.ok).toBe(false);
        expect(inst.aiOutTa.value).toBe('');
        expect(inst.jsonNote.textContent).toBe('');
        expect(inst.copyBtn.disabled).toBe(true);
        expect(inst.statusCalls.at(-1).text).toContain('编译失败');
    });

    test('草稿变更：正在显示的编译产物清空；AI 文案留档不误清', () => {
        const inst = makeOutInst();
        inst._compile();
        expect(inst.aiOutTa.value).not.toBe('');
        inst._invalidateCompiled();
        expect(inst.aiOutTa.value).toBe('');          // 编译产物过期即清
        expect(inst.jsonNote.textContent).toBe('');
        // AI 留档场景：编辑草稿不清 AI 输出
        inst.aiOutTa.value = 'SUMMARY: AI 输出留档';
        inst._outMode = 'ai';
        inst._invalidateCompiled();
        expect(inst.aiOutTa.value).toBe('SUMMARY: AI 输出留档');
    });

    test('右栏为 AI 输出态时按右栏编译（文案取 AI、几何取草稿、不回写左侧）', () => {
        const inst = makeOutInst();
        inst.aiOutTa.value = 'SUMMARY: AI 整体描述。\nITEM 1: AI 元素文案。';
        inst._outMode = 'ai';
        inst._compile();
        expect(inst.compiled.ok).toBe(true);
        expect(inst.aiOutTa.value).toContain('AI 整体描述');
        expect(inst.aiOutTa.value).toContain('AI 元素文案');
        // 左侧草稿未被回写
        expect(inst.draft.summary.caption).toBe('A poster.');
        expect(inst.draft.items[0].caption).toBe('A cup.');
        expect(inst._outMode).toBe('compile');
    });

    test('手动编辑草稿消费 AI 输出标记：之后编译按草稿（右栏内容保留供参考）', () => {
        const inst = makeOutInst();
        inst.aiOutTa.value = 'SUMMARY: AI 整体描述。\nITEM 1: AI 元素文案。';
        inst._outMode = 'ai';
        inst._invalidateCompiled();
        expect(inst._outMode).toBe('');                       // 标记被消费
        expect(inst.aiOutTa.value).toContain('AI 整体描述');  // 内容不清，仅供参考
        inst._compile();
        expect(inst.compiled.ok).toBe(true);
        expect(inst.aiOutTa.value).toContain('A cup.');       // 按草稿编译
        expect(inst.aiOutTa.value).not.toContain('AI 元素文案');
    });
});

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

    test('_defaultGap：恒 0（默认全屏开窗，与坐标编辑器按面板对齐的策略分叉）', () => {
        const inst = Object.create(MangaEditor.prototype);
        expect(inst._defaultGap()).toBe(0);
    });
});

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

describe('MangaEditor 画布删图联动清背景（MangaBackground，2026-11-04 拍板）', () => {
    function makeBgInst(pages, activePage) {
        const inst = Object.create(MangaEditor.prototype);
        inst.pages = pages;
        inst.activePage = activePage || 0;
        inst.draft = pages[inst.activePage];
        inst.visible = false;
        inst._draftTouched = false;
        inst.saveCalls = 0;
        inst._scheduleSave = () => { inst.saveCalls++; };
        inst.stageCalls = 0;
        inst._renderStage = () => { inst.stageCalls++; };
        inst.statusCalls = [];
        inst._status = (t) => inst.statusCalls.push(t);
        inst._bgImg = { fake: 1 };
        inst._bgLoadedUrl = 'x';
        inst.thumbsDrawn = [];
        inst._drawPageThumb = (cv, page) => inst.thumbsDrawn.push(page);
        // 页面栏桩：children 按页占位，querySelector 返回真值 canvas 让
        // 缩略图重画分支走到 _drawPageThumb
        inst.railListEl = { children: pages.map(() => ({ querySelector: () => ({}) })) };
        return inst;
    }
    const pageWithBg = (srcId) => ({ background: '/api/assets/abc', backgroundSrcId: srcId });

    test('_setBackground：带 srcId 记来源，不带清来源，清空连引用一起清', () => {
        const inst = makeBgInst([pageWithBg('img-old')]);
        inst._setBackground('/api/assets/new', 'img-9');
        expect(inst.draft.backgroundSrcId).toBe('img-9');
        inst._setBackground('/api/assets/another');   // 本地上传：无源不挂
        expect(inst.draft.backgroundSrcId).toBeUndefined();
        inst._setBackground('');
        expect(inst.draft.background).toBeUndefined();
        expect(inst.draft.backgroundSrcId).toBeUndefined();
        expect(inst._bgImg).toBeNull();
    });

    test('源图被删：活动页与跨页引用都清，无源快照与孤儿 URL 不动', () => {
        const pages = [pageWithBg('img-1'), pageWithBg('img-2'), { background: '/api/assets/manual' }];
        const inst = makeBgInst(pages, 0);
        inst._onCanvasImageDeleted({ detail: { objs: [{ id: 'img-1' }, { id: 'img-2' }] } });
        expect(pages[0].background).toBeUndefined();
        expect(pages[0].backgroundSrcId).toBeUndefined();
        expect(pages[1].background).toBeUndefined();
        expect(pages[1].backgroundSrcId).toBeUndefined();
        expect(pages[2].background).toBe('/api/assets/manual');   // 本地上传快照不联动
        expect(inst.saveCalls).toBe(1);
        expect(inst.thumbsDrawn).toEqual([pages[0], pages[1]]);
        expect(inst._bgImg).toBeNull();
        expect(inst.statusCalls.some((t) => /背景已清除/.test(t))).toBe(true);
    });

    test('删的是无关图：草稿与界面都不动', () => {
        const pages = [pageWithBg('img-1')];
        const inst = makeBgInst(pages, 0);
        inst._onCanvasImageDeleted({ detail: { objs: [{ id: 'other' }, { id: undefined }] } });
        expect(pages[0].background).toBe('/api/assets/abc');
        expect(pages[0].backgroundSrcId).toBe('img-1');
        expect(inst.saveCalls).toBe(0);
        expect(inst.statusCalls).toHaveLength(0);
    });

    test('非活动页被清：不弹状态栏，舞台不重绘', () => {
        const pages = [{ background: '/api/assets/manual' }, pageWithBg('img-2')];
        const inst = makeBgInst(pages, 0);
        inst._onCanvasImageDeleted({ detail: { objs: [{ id: 'img-2' }] } });
        expect(pages[1].background).toBeUndefined();
        expect(inst.stageCalls).toBe(0);
        expect(inst.statusCalls).toHaveLength(0);
        expect(inst._bgImg).not.toBeNull();
    });

    test('空事件/无 pages 防御', () => {
        const pages = [pageWithBg('img-1')];
        const inst = makeBgInst(pages, 0);
        inst._onCanvasImageDeleted(null);
        inst._onCanvasImageDeleted({ detail: { objs: [] } });
        expect(inst.saveCalls).toBe(0);
        expect(pages[0].background).toBe('/api/assets/abc');
    });
});

describe('MangaEditor 撤销/重做（快照式，ADR 017 决策十一）', () => {
    const realSetTimeout = global.setTimeout;

    function makeHistInst() {
        const inst = Object.create(MangaEditor.prototype);
        inst.draft = {
            width: 1024, height: 1024,
            bbox_coord_space: 'abs', bbox_format: 'xyxy',
            summary: { caption: '', canvas: 'single' },
            items: [{ label: 'object', caption: 'A cup.', bbox: [64, 64, 512, 512] }]
        };
        inst.selected = -1;
        inst._clickBurst = null;
        inst._undoStack = [];
        inst._redoStack = [];
        inst._textHistPending = null;
        inst._histTimer = null;
        inst.statusCalls = [];
        inst._status = (text, isError) => inst.statusCalls.push({ text, isError });
        inst.renderCalls = 0;
        inst._renderAll = () => { inst.renderCalls++; };
        inst._renderItems = () => { inst.renderCalls++; };
        inst._renderStage = () => {};
        inst._scheduleSave = () => {};
        inst.compiled = null;
        inst.copyBtn = { disabled: false };
        inst.aiOutTa = { value: '' };
        inst.jsonNote = { textContent: '' };
        inst._outMode = '';
        return inst;
    }

    test('commit→undo→redo 序列：草稿状态与选择往返', () => {
        const inst = makeHistInst();
        const before = inst._histSnapshot();
        inst.draft.items[0].caption = 'A teapot.';
        inst._commitHistory(before, '输入文案');
        expect(inst._undoStack).toHaveLength(1);
        expect(inst._redoStack).toHaveLength(0);

        inst._undoHist();
        expect(inst.draft.items[0].caption).toBe('A cup.');
        expect(inst._undoStack).toHaveLength(0);
        expect(inst._redoStack).toHaveLength(1);
        expect(inst.statusCalls.at(-1).text).toContain('已撤销：输入文案');

        inst._redoHist();
        expect(inst.draft.items[0].caption).toBe('A teapot.');
        expect(inst._undoStack).toHaveLength(1);
        expect(inst.statusCalls.at(-1).text).toContain('已重做：输入文案');
    });

    test('空栈 undo/redo 提示不动；删了又改回原样不入账', () => {
        const inst = makeHistInst();
        inst._undoHist();
        expect(inst.statusCalls.at(-1).text).toContain('没有可撤销');
        expect(inst.renderCalls).toBe(0);
        const before = inst._histSnapshot();
        inst.draft.items[0].caption = 'x';
        inst.draft.items[0].caption = 'A cup.';
        inst._commitHistory(before, '输入文案');
        expect(inst._undoStack).toHaveLength(0);   // 与当前相同：跳过
    });

    test('commit 截断重做分支；超过 50 步裁剪最旧', () => {
        const inst = makeHistInst();
        const before = inst._histSnapshot();
        inst.draft.items[0].caption = 'v1';
        inst._commitHistory(before, 'a');
        inst._undoHist();
        expect(inst._redoStack).toHaveLength(1);
        const before2 = inst._histSnapshot();
        inst.draft.items[0].caption = 'v2';
        inst._commitHistory(before2, 'b');
        expect(inst._redoStack).toHaveLength(0);   // 新操作截断重做

        for (let i = 0; i < 60; i++) {
            const b = inst._histSnapshot();
            inst.draft.items[0].caption = `step-${i}`;
            inst._commitHistory(b, `s${i}`);
        }
        expect(inst._undoStack).toHaveLength(50);
        expect(inst._undoStack[0].label).toBe('s10');   // 最旧 10 步被裁
    });

    test('undo 后自动保存同步回滚（_invalidateCompiled 触发）', () => {
        const inst = makeHistInst();
        let invalidateCount = 0;
        inst._invalidateCompiled = () => { invalidateCount++; };
        const before = inst._histSnapshot();
        inst.draft.items[0].caption = 'changed';
        inst._commitHistory(before, '输入文案');
        inst._undoHist();
        expect(invalidateCount).toBe(1);   // 撤销即标脏 → 防抖自动保存回滚落盘
    });

    test('文本输入合并：input 首字符挂 pending、防抖到期一步入账', async () => {
        const inst = makeHistInst();
        inst._beginTextInputHist();
        expect(inst._textHistPending).not.toBeNull();
        expect(inst._undoStack).toHaveLength(0);   // 窗口内未入账
        inst.draft.summary.caption = 'poster';     // 连续输入复用同一 pending
        inst._beginTextInputHist();
        expect(inst._undoStack).toHaveLength(0);
        await new Promise((r) => realSetTimeout(r, 1100));
        expect(inst._undoStack).toHaveLength(1);   // 一步入账
        expect(inst._undoStack[0].label).toBe('输入文案');
        expect(inst._textHistPending).toBeNull();
    });

    test('blur 立即结算挂起的文本合并', () => {
        const inst = makeHistInst();
        inst._beginTextInputHist();
        inst.draft.summary.caption = 'poster';
        inst._flushTextInputHist();
        expect(inst._undoStack).toHaveLength(1);
        expect(inst._textHistPending).toBeNull();
    });

    test('undo 前先结算文本挂起（LIFO：撤销的是栈顶文本而非更早的移动）', () => {
        const inst = makeHistInst();
        const before = inst._histSnapshot();
        inst.draft.items[0].caption = 'moved box';
        inst._commitHistory(before, '移动');
        inst._beginTextInputHist();
        inst.draft.summary.caption = 'poster';
        inst._undoHist();
        // 挂起的文本先入账成为栈顶，本次 undo 撤销的就是它
        expect(inst.draft.summary.caption).toBe('');
        expect(inst.draft.items[0].caption).toBe('moved box');   // 移动结果保留
        expect(inst.statusCalls.at(-1).text).toContain('已撤销：输入文案');
        // 再撤销一次 → 回到移动前
        inst._undoHist();
        expect(inst.draft.items[0].caption).toBe('A cup.');
        expect(inst.statusCalls.at(-1).text).toContain('已撤销：移动');
    });

    test('_histKeyOwns：焦点在弹窗/body 归编辑器，外部放行', () => {
        const inst = makeHistInst();
        inst.dialog = { contains: (t) => t === 'editor-el' };
        expect(inst._histKeyOwns('editor-el')).toBe(true);
        expect(inst._histKeyOwns(null)).toBe(true);
        expect(inst._histKeyOwns('llm-input')).toBe(false);   // 并排面板内放行
        inst.dialog = null;
        expect(inst._histKeyOwns('llm-input')).toBe(true);    // 无弹窗兜底接管
    });

    test('_resetHistory 清空栈与挂起（新建/恢复草稿的新基线）', () => {
        const inst = makeHistInst();
        inst._undoStack.push({ label: 'x', snap: {} });
        inst._beginTextInputHist();
        inst._resetHistory();
        expect(inst._undoStack).toHaveLength(0);
        expect(inst._redoStack).toHaveLength(0);
        expect(inst._textHistPending).toBeNull();
    });
});

describe('MangaEditor 背景参考图与生成图透显（MangaBackground）', () => {
    function makeBgInst() {
        const inst = makeInstance([]);
        inst._scheduleSave = () => {};
        inst._loadBackgroundImg = () => {};
        return inst;
    }

    test('_draftForCompile 剥离 background 编辑器侧字段（原稿不动）', () => {
        const inst = makeBgInst();
        inst.draft.background = '/api/assets/file/abc.png';
        const out = inst._draftForCompile();
        expect(out.background).toBeUndefined();
        expect(inst.draft.background).toBe('/api/assets/file/abc.png');
    });

    test('_setBackground：URL 写草稿并触发保存；空串清除字段与内存图', () => {
        const inst = makeBgInst();
        const saves = [];
        inst._scheduleSave = () => saves.push(1);
        inst._setBackground('/api/assets/file/x.png');
        expect(inst.draft.background).toBe('/api/assets/file/x.png');
        expect(saves).toHaveLength(1);
        inst._setBackground('');
        expect(inst.draft.background).toBeUndefined();
        expect(inst._bgImg).toBeNull();
    });

    test('_onGeneratedImage：透显开关已退役，无捕获武装时不改背景', () => {
        const inst = makeBgInst();
        inst._onGeneratedImage({ detail: { src: '/api/assets/file/a.png' } });
        expect(inst.draft.background).toBeUndefined();
    });

    test('_onGeneratedImage：armed 捕获优先消费（生成按钮回流落图层路径）', () => {
        const inst = makeBgInst();
        const consumed = [];
        inst._consumeGenCapture = (src) => { consumed.push(src); return true; };
        inst._onGeneratedImage({ detail: { src: '/api/assets/file/a.png' } });
        expect(consumed).toEqual(['/api/assets/file/a.png']);
        expect(inst.draft.background).toBeUndefined();   // 也不再走背景采纳
    });

    test('_drawBackground：纸白垫底 + 全不透明绘制（不透明度滑块已退役，2026-11-05）', () => {
        const inst = makeBgInst();
        inst._bgImg = {};                          // 非 null 即画
        inst.draft.background = '/api/assets/x.png';
        const log = [];
        const ctx = {
            fillStyle: '',
            save() { log.push('save'); },
            restore() { log.push('restore'); },
            fillRect() { log.push(['fillRect', this.fillStyle]); },
            drawImage() { log.push(['drawImage']); }
        };
        inst._drawBackground(ctx, (v) => v, (v) => v, 1);
        // 就两笔：白垫底 + 原图——无 save/globalAlpha/restore
        expect(log).toEqual([['fillRect', '#ffffff'], ['drawImage']]);
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

// ==================== 多页文档（二期）：页面栏/切页/页面操作/迁移 ====================

describe('MangaEditor 多页文档：页面操作/切页/迁移/跨 kind 撤销', () => {
    const mkPage = (w = 1024, h = 1024, caption = '') => ({
        width: w, height: h,
        bbox_coord_space: 'abs', bbox_format: 'xyxy',
        summary: { caption, canvas: 'single' },
        items: []
    });

    /** 双页文档实例：渲染/存档链路全部打桩，只留页面操作与历史真身 */
    function makeDocInst() {
        const inst = Object.create(MangaEditor.prototype);
        inst.pages = [mkPage(), mkPage()];
        inst.activePage = 0;
        inst.draft = inst.pages[0];
        inst._undoStack = [];
        inst._redoStack = [];
        inst._textHistPending = null;
        inst._histTimer = null;
        inst._status = () => {};
        inst._renderAll = () => {};
        inst._renderRail = () => {};
        inst._scheduleSave = () => {};
        inst._invalidateCompiled = () => {};
        inst._syncPageBackgroundUi = () => {};
        return inst;
    }

    test('_switchPage：draft 换引用指向目标页；越界/同页不动', () => {
        const inst = makeDocInst();
        inst.pages[1].summary.caption = '第二页';
        expect(inst._switchPage(1)).toBe(true);
        expect(inst.draft).toBe(inst.pages[1]);
        expect(inst.activePage).toBe(1);
        expect(inst._switchPage(5)).toBe(false);
        expect(inst._switchPage(-1)).toBe(false);
        expect(inst._switchPage(1)).toBe(false);   // 同页
    });

    test('_syncPageBackgroundUi：切到无背景页清空旧背景并立即重绘（舞台不滞留上一页图像）', () => {
        const inst = makeDocInst();
        delete inst._syncPageBackgroundUi;         // 走真身（本次修复的回归断言）
        inst._loadBackgroundImg = () => {};
        inst.visible = true;
        inst._bgImg = {};                          // 上一页残留的背景图
        inst._bgLoadedUrl = '/api/assets/page1.png';
        let rendered = 0;
        inst._renderStage = () => { rendered++; };

        expect(inst._switchPage(1)).toBe(true);
        expect(inst._bgImg).toBeNull();            // 旧页背景清除
        expect(inst._bgLoadedUrl).toBe('');
        expect(rendered).toBe(1);                  // 清除后立即重绘（修复点）
    });

    test('_addPage：空白页继承当前页画幅、插在活动页之后并切换', () => {
        const inst = makeDocInst();
        inst.pages[0].width = 832;
        inst.pages[0].height = 1216;
        inst._addPage();
        expect(inst.pages.length).toBe(3);
        expect(inst.activePage).toBe(1);
        expect(inst.draft).toBe(inst.pages[1]);
        expect(inst.draft.width).toBe(832);
        expect(inst.draft.height).toBe(1216);
        expect(inst.draft.items.length).toBe(0);
        inst._undoHist();                          // 文档级回滚
        expect(inst.pages.length).toBe(2);
        expect(inst.activePage).toBe(0);
        inst._redoHist();
        expect(inst.pages.length).toBe(3);
        expect(inst.activePage).toBe(1);
    });

    test('_copyPage：深拷贝插到其后；副本与原件互不影响', () => {
        const inst = makeDocInst();
        inst.pages[0].summary.caption = '原页';
        inst._copyPage(0);
        expect(inst.pages.length).toBe(3);
        expect(inst.activePage).toBe(1);
        expect(inst.draft.summary.caption).toBe('原页');
        inst.draft.summary.caption = '副本改';
        expect(inst.pages[0].summary.caption).toBe('原页');
    });

    test('_deletePage：最后一页拒绝；删活动页之前的页下标收拢；撤销整表恢复', () => {
        const inst = makeDocInst();
        inst.pages = [mkPage()];
        inst.activePage = 0;
        inst.draft = inst.pages[0];
        const errs = [];
        inst._status = (t, isErr) => { if (isErr) errs.push(t); };
        inst._deletePage(0);
        expect(inst.pages.length).toBe(1);         // 拒绝删除最后一页
        expect(errs.length).toBe(1);

        inst.pages = [mkPage(), mkPage(), mkPage()];
        inst.activePage = 2;
        inst.draft = inst.pages[2];
        inst._deletePage(0);
        expect(inst.pages.length).toBe(2);
        expect(inst.activePage).toBe(1);
        expect(inst.draft).toBe(inst.pages[1]);
        inst._undoHist();
        expect(inst.pages.length).toBe(3);
        expect(inst.activePage).toBe(2);           // 文档快照含 active，一并归位
    });

    test('_movePage：活动页跟随自身换位，内容不变', () => {
        const inst = makeDocInst();
        inst.pages[0].summary.caption = 'A';
        inst.pages[1].summary.caption = 'B';
        inst._movePage(0, 1);                      // A 下移
        expect(inst.pages[0].summary.caption).toBe('B');
        expect(inst.pages[1].summary.caption).toBe('A');
        expect(inst.activePage).toBe(1);           // 活动页（原 A）跟到下标 1
        inst._undoHist();
        expect(inst.pages[0].summary.caption).toBe('A');
        expect(inst.activePage).toBe(0);
    });

    test('混合撤销：页级内容编辑与文档级删页交替回滚各自归位', () => {
        const inst = makeDocInst();
        inst.pages[1].width = 832;
        inst._switchPage(1);
        // 页级编辑：第 2 页画一个框（快照 → 变更 → 入账）
        const before = inst._histSnapshot();
        expect(before.kind).toBe('page');
        expect(before.pageIdx).toBe(1);
        inst.draft.items.push({ cid: 0, label: 'object', caption: '', bbox: [0, 0, 100, 100] });
        inst._commitHistory(before, '画框');
        // 文档级：删除第 1 页
        inst._deletePage(0);
        expect(inst.pages.length).toBe(1);
        // 撤销删页 → 回到 2 页，active 归位第 2 页
        inst._undoHist();
        expect(inst.pages.length).toBe(2);
        expect(inst.activePage).toBe(1);
        expect(inst.pages[1].width).toBe(832);
        // 再撤销画框 → 页级回滚落在第 2 页，items 清空
        inst._undoHist();
        expect(inst.draft.items.length).toBe(0);
        expect(inst.pages[1].items.length).toBe(0);
    });

    test('_confirmDeletePage：最后一页直接拦下不弹确认；多页时走确认后删除', async () => {
        const inst = makeDocInst();
        inst.pages = [mkPage()];
        inst.activePage = 0;
        inst.draft = inst.pages[0];
        const errs = [];
        inst._status = (t, isErr) => { if (isErr) errs.push(t); };
        await inst._confirmDeletePage(0);
        expect(errs.length).toBe(1);               // 最后一页：状态栏报错，不弹框
        expect(inst.pages.length).toBe(1);

        inst.pages = [mkPage(), mkPage()];
        inst.activePage = 0;
        inst.draft = inst.pages[0];
        inst.pageConfirmDialog = { confirm: async () => false };   // 用户点取消
        await inst._confirmDeletePage(1);
        expect(inst.pages.length).toBe(2);         // 取消：不删
        inst.pageConfirmDialog = { confirm: async () => true };    // 用户确认
        await inst._confirmDeletePage(1);
        expect(inst.pages.length).toBe(1);         // 确认：删除
    });

    test('_normalizeDocument：旧单页草稿自动迁移；越界 active 钳制；垃圾返回 null', () => {
        const inst = makeDocInst();
        const legacy = mkPage(832, 1216);
        const doc = inst._normalizeDocument(legacy);
        expect(doc.pages.length).toBe(1);
        expect(doc.pages[0].width).toBe(832);
        expect(doc.active).toBe(0);

        const doc2 = inst._normalizeDocument({ pages: [mkPage(), mkPage()], active: 9 });
        expect(doc2.pages.length).toBe(2);
        expect(doc2.active).toBe(1);

        // 垃圾对象：normalizeDraft 宽松归一补默认值成空白页（与坐标编辑器
        // 恢复行为一致）；null 连对象都不是 → 整文档救不回返回 null
        const doc3 = inst._normalizeDocument({ foo: 1 });
        expect(doc3.pages.length).toBe(1);
        expect(doc3.pages[0].width).toBe(1024);
        expect(inst._normalizeDocument(null)).toBe(null);
    });
});

describe('MangaEditor 舞台滚轮缩放（MangaStage）', () => {
    /** 舞台视口纯几何用实例：只接 _computeStageView/_zoomAt 依赖的最小字段 */
    function makeStageInst(stageW, stageH, draftW, draftH) {
        const inst = Object.create(MangaEditor.prototype);
        inst.draft = { width: draftW, height: draftH, items: [] };
        inst.visible = true;
        inst._view = null;
        inst._zoom = 1;
        inst._panX = 0;
        inst._panY = 0;
        inst.stageCv = { parentElement: { clientWidth: stageW, clientHeight: stageH } };
        return inst;
    }

    test('zoom=1 即自适应铺满：受限轴贴 pad 走廊、另一轴居中（一期行为不变）', () => {
        const inst = makeStageInst(1000, 800, 832, 1216);
        const v = inst._computeStageView(1000, 800);
        // 高是受限轴：fit = min((1000-56)/832, (800-56)/1216)
        expect(v.scale).toBeCloseTo((800 - 56) / 1216, 10);
        expect(v.oy).toBeCloseTo(28, 6);                       // 受限轴贴走廊
        expect(v.ox).toBeCloseTo((1000 - 832 * v.scale) / 2, 6); // 宽裕轴居中
    });

    test('放大后围绕光标锚定：光标下的草稿点缩放前后屏幕位置不变', () => {
        const inst = makeStageInst(1000, 800, 832, 1216);
        inst._view = inst._computeStageView(1000, 800);
        const px = 300, py = 400;
        const before = inst._toDraft(px, py);
        expect(inst._zoomAt(px, py, 1.1)).toBe(true);
        inst._view = inst._computeStageView(1000, 800);
        const after = inst._toDraft(px, py);
        expect(after.x).toBeCloseTo(before.x, 6);
        expect(after.y).toBeCloseTo(before.y, 6);
    });

    test('倍率钳制 [1, 8]：铺满即最小，连滚不超上限', () => {
        const inst = makeStageInst(1000, 800, 832, 1216);
        inst._view = inst._computeStageView(1000, 800);
        expect(inst._zoomAt(100, 100, 0.5)).toBe(false);   // 已在 1：缩不动
        expect(inst._zoom).toBe(1);
        for (let i = 0; i < 40; i++) inst._zoomAt(100, 100, 1.1);
        expect(inst._zoom).toBe(8);
        expect(inst._zoomAt(100, 100, 1.1)).toBe(false);   // 顶格不再变化
    });

    test('放大后平移钳制：画幅四边不脱出 pad 走廊', () => {
        const inst = makeStageInst(1000, 800, 832, 1216);
        inst._view = inst._computeStageView(1000, 800);
        // 以左上角为锚放大：内容被拉向右下，钳制后左/上边贴走廊上界
        inst._zoomAt(1, 1, 4);
        const v = inst._computeStageView(1000, 800);
        expect(v.ox).toBeLessThanOrEqual(28 + 1e-6);
        expect(v.oy).toBeLessThanOrEqual(28 + 1e-6);
        expect(v.ox + 832 * v.scale).toBeGreaterThanOrEqual(1000 - 28 - 1e-6);
        expect(v.oy + 1216 * v.scale).toBeGreaterThanOrEqual(800 - 28 - 1e-6);
    });

    test('缩回 1 强制居中铺满：残留平移被归零', () => {
        const inst = makeStageInst(1000, 800, 832, 1216);
        inst._view = inst._computeStageView(1000, 800);
        inst._zoomAt(1, 1, 4);
        inst._zoom = 1;
        inst._panX = 50;
        inst._panY = -30;   // 模拟残留平移
        const v = inst._computeStageView(1000, 800);
        expect(inst._panX).toBe(0);
        expect(inst._panY).toBe(0);
        expect(v.oy).toBeCloseTo(28, 6);
        expect(v.ox).toBeCloseTo((1000 - 832 * v.scale) / 2, 6);
    });
});

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

    test('_awaitLayerImages：图层图片全部就绪时立即放行', async () => {
        const inst = makeSaveInstance();
        inst._layerImgCache = new Map();
        inst._nextLayerId = 1;
        inst.draft.drawLayers = [
            { id: 1, name: '图层 1', visible: true, image: { src: '/api/assets/a.png', bbox: [0, 0, 10, 10] } },
            { id: 2, name: '图层 2', visible: false, image: { src: '/api/assets/b.png', bbox: [0, 0, 10, 10] } }   // 不可见不等待
        ];
        await expect(inst._awaitLayerImages()).resolves.toEqual([]);
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

describe('MangaEditor 形状工具与形状图层（MangaShape，自灯箱迁移 ADR 069）', () => {
    /** 形状工具用例实例：形状状态字段 + 舞台/持久化/历史桩（手势测试
     *  经 _localPoint/_toDraft 桩喂坐标——draft 坐标即屏幕坐标） */
    function makeShapeInst() {
        const inst = makeInstance([]);
        inst.activeTool = 'shape';
        inst._shapeOpts = {
            type: 'rect', fill: '#ffffff', strokeColor: '#000000',
            strokeWidth: 6, radius: 24, tail: 'lb'
        };
        inst._fillColor = '#ffffff';
        inst._strokeColor = '#000000';
        inst._lastShapeFill = null;
        inst._lastShapeStrokeWidth = null;
        inst._view = { scale: 1, ox: 0, oy: 0 };
        inst._activeLayerId = null;
        inst._selLayerId = null;
        inst._layerImgCache = new Map();
        inst._nextLayerId = 1;
        inst._guides = [];
        inst._stroke = null;
        inst._drag = null;
        inst.stageCv = {
            style: {},
            setPointerCapture() {},
            getBoundingClientRect: () => ({ left: 0, top: 0 })
        };
        inst._scheduleSave = () => {};
        inst._scheduleThumbRefresh = () => {};
        inst._renderLayerPanel = () => {};
        inst._redrawCursorRing = () => {};
        inst._histCalls = [];
        inst._histSnapshot = () => ({ mark: inst._histCalls.length });
        inst._commitHistory = (snap, label) => inst._histCalls.push(label);
        inst._localPoint = () => ({ px: 0, py: 0 });
        inst._toDraft = (px, py) => ({ x: px, y: py });
        return inst;
    }

    test('addShapeLayer：第四形态 schema/命名/插层栈顶', () => {
        const inst = makeShapeInst();
        const layer = inst.addShapeLayer(12, 34);
        expect(inst.draft.drawLayers).toHaveLength(1);
        expect(inst.draft.drawLayers[0]).toBe(layer);
        expect(layer.id).toBe(1);
        expect(layer.name).toBe('形状 1');
        expect(layer.visible).toBe(true);
        expect(layer.x).toBe(12);
        expect(layer.y).toBe(34);
        expect(layer.shape).toEqual({
            type: 'rect', w: 2, h: 2, fill: '#ffffff', strokeColor: '#000000',
            strokeWidth: 6, radius: 24, tail: 'lb'
        });
    });

    test('_shapeLayerBounds 含渲染外伸；_layerBounds 泛化出口认识形状层', () => {
        const inst = makeShapeInst();
        const layer = inst.addShapeLayer(10, 10);
        layer.shape.w = 50;
        layer.shape.h = 40;
        // sw=6 矩形外伸 = ceil(6/2)+1 = 4
        expect(inst._shapeLayerBounds(layer)).toEqual([6, 6, 64, 54]);
        expect(inst._layerBounds(layer)).toEqual([6, 6, 64, 54]);
    });

    test('_shapeStart：空白建临时层进 shape-create；命中选中并反向同步选项', () => {
        const inst = makeShapeInst();
        inst._shapeStart(5, 5);
        expect(inst._drag.mode).toBe('shape-create');
        expect(inst._selLayerId).toBe(inst.draft.drawLayers[0].id);
        expect(inst.draft.drawLayers).toHaveLength(1);
        // 命中已有层：不进拖拽，_shapeOpts 被图层属性反向同步（防选项条
        // 默认值覆盖选中层既有属性，灯箱同款）
        const layer = inst.draft.drawLayers[0];
        inst._drag = null;
        layer.shape.w = 80;
        layer.shape.h = 60;
        layer.shape.fill = '#abcdef';
        layer.shape.strokeWidth = 9;
        inst._shapeStart(20, 20);
        expect(inst._drag).toBeNull();
        expect(inst._selLayerId).toBe(layer.id);
        expect(inst._shapeOpts.fill).toBe('#abcdef');
        expect(inst._shapeOpts.strokeWidth).toBe(9);
        expect(inst._lastShapeFill).toBe('#abcdef');
    });

    test('_shapeCreateMove：宽高/左上角实时更新，Shift 约束正方，反向拖换向', () => {
        const inst = makeShapeInst();
        inst._shapeStart(10, 10);
        inst._shapeCreateMove({ x: 50, y: 40 }, {});
        expect(inst._drag.layer.shape.w).toBe(40);
        expect(inst._drag.layer.shape.h).toBe(30);
        expect(inst._drag.layer.x).toBe(10);
        expect(inst._drag.layer.y).toBe(10);
        inst._shapeCreateMove({ x: 50, y: 40 }, { shiftKey: true });
        expect(inst._drag.layer.shape.w).toBe(40);
        expect(inst._drag.layer.shape.h).toBe(40);
        inst._shapeCreateMove({ x: 2, y: 4 }, {});   // 向左上拖过起点
        expect(inst._drag.layer.x).toBe(2);
        expect(inst._drag.layer.y).toBe(4);
        expect(inst._drag.layer.shape.w).toBe(8);
        expect(inst._drag.layer.shape.h).toBe(6);
    });

    test('_shapeStart 画幅外不新建（舞台黑边区按下直接忽略，ADR 069 真机修复二）', () => {
        const inst = makeShapeInst();
        inst._shapeStart(-50, 100);   // 左侧黑边
        inst._shapeStart(100, 1100);  // 底部黑边
        inst._shapeStart(1100, 1100); // 右下角外
        expect(inst.draft.drawLayers || []).toHaveLength(0);
        expect(inst._drag).toBeNull();
        inst._shapeStart(100, 100);   // 画幅内正常建
        expect(inst._drag && inst._drag.mode).toBe('shape-create');
    });

    test('_shapeCreateMove 全程钳画幅内：拖出黑边贴边停住', () => {
        const inst = makeShapeInst();
        inst._shapeStart(900, 900);
        inst._shapeCreateMove({ x: 1500, y: 1200 }, {});   // 拖进右侧/底部黑边
        expect(inst._drag.layer.x).toBe(900);
        expect(inst._drag.layer.y).toBe(900);
        expect(inst._drag.layer.shape.w).toBe(124);   // 1024-900：贴边不越界
        expect(inst._drag.layer.shape.h).toBe(124);
    });

    test('_shapeCreateMove Shift 大轴越界再钳：正方不越过底/右边', () => {
        const inst = makeShapeInst();
        inst._shapeStart(900, 950);
        inst._shapeCreateMove({ x: 1000, y: 960 }, { shiftKey: true });   // x 跨 100
        expect(inst._drag.layer.shape.w).toBe(100);   // Shift 取大轴
        expect(inst._drag.layer.shape.h).toBe(74);    // 底边越界再钳（1024-950）
        expect(inst._drag.layer.y + inst._drag.layer.shape.h).toBeLessThanOrEqual(1024);
    });

    test('_shapeCreateUp：按类型命名+「绘制形状」入账；干点静默摘除零历史', () => {
        const inst = makeShapeInst();
        inst._shapeOpts.type = 'bubble';
        inst._shapeStart(10, 10);
        inst._shapeCreateMove({ x: 110, y: 80 }, {});
        const layer = inst._drag.layer;
        inst._shapeCreateUp(inst._drag);
        expect(layer.name).toBe('气泡框');
        expect(inst._histCalls).toEqual(['绘制形状']);
        expect(inst.draft.drawLayers).toHaveLength(1);
        expect(inst._drag).toBeNull();
        // 干点（<6px）：临时层摘除、无新历史
        inst._shapeStart(10, 10);
        inst._shapeCreateMove({ x: 12, y: 12 }, {});
        inst._shapeCreateUp(inst._drag);
        expect(inst.draft.drawLayers).toHaveLength(1);
        expect(inst._histCalls).toEqual(['绘制形状']);
        expect(inst._drag).toBeNull();
    });

    test('select 手势 layer-move：平移写 x/y（包围盒钳制，外伸基准不漂移）', () => {
        const inst = makeShapeInst();
        const layer = inst.addShapeLayer(10, 10);
        layer.shape.w = 50;
        layer.shape.h = 40;
        inst._selLayerId = layer.id;
        inst.activeTool = 'select';
        inst._drag = {
            mode: 'layer-move', layerId: layer.id, moved: true,
            orig: inst._layerBounds(layer).slice(),
            origGeom: { x: 10, y: 10, w: 50, h: 40 },
            start: { x: 0, y: 0 }, histSnap: inst._histSnapshot()
        };
        inst._localPoint = () => ({ px: 30, py: 20 });
        inst._onPointerMove({ clientX: 0, clientY: 0 });
        expect(layer.x).toBe(40);
        expect(layer.y).toBe(30);
        expect(layer.shape.w).toBe(50);   // 拖动不改尺寸
    });

    test('select 已选层优先于元素分支：全画幅元素 bbox 不再吃掉层拖动（ADR 069 真机修复）', () => {
        const inst = makeShapeInst();
        inst.draft.items.push({ cid: 0, label: 'character', caption: '', bbox: [0, 0, 1024, 1024] });
        inst.selected = -1;
        inst._hiddenCids = new Set();
        const layer = inst.addShapeLayer(100, 100);
        layer.shape.w = 200;
        layer.shape.h = 100;
        inst._selectImageLayer(layer.id);
        inst.activeTool = 'select';
        inst._localPoint = () => ({ px: 150, py: 130 });   // 形状内部
        context.document = { activeElement: null };   // 焦点交还路径读 activeElement
        try {
            inst._onPointerDown({ pointerId: 1, button: 0, preventDefault() {} });
        } finally {
            delete context.document;   // 同橡皮测试：局部桩用完即撤
        }
        expect(inst._drag && inst._drag.mode).toBe('layer-move');
        expect(inst._drag.layerId).toBe(layer.id);
    });

    test('select 手势 layer-resize：八向非等比直改 x/y/w/h，边宽不随缩放', () => {
        const inst = makeShapeInst();
        const layer = inst.addShapeLayer(10, 10);
        layer.shape.w = 50;
        layer.shape.h = 40;
        inst._selLayerId = layer.id;
        inst.activeTool = 'select';
        inst._drag = {
            mode: 'layer-resize', layerId: layer.id, anchor: 'se', moved: true,
            orig: inst._layerBounds(layer).slice(),
            origGeom: { x: 10, y: 10, w: 50, h: 40 },
            histSnap: inst._histSnapshot()
        };
        inst._localPoint = () => ({ px: 90, py: 80 });
        inst._onPointerMove({ clientX: 0, clientY: 0 });
        expect(layer.x).toBe(10);   // 拖 se：左上角锚定
        expect(layer.y).toBe(10);
        expect(layer.shape.w).toBe(80);
        expect(layer.shape.h).toBe(70);
        expect(layer.shape.strokeWidth).toBe(6);   // 边宽保持设定值（用户拍板）
        // 拖 nw：右下角锚定，x/y 跟随
        inst._drag.origGeom = { x: layer.x, y: layer.y, w: layer.shape.w, h: layer.shape.h };
        inst._drag.anchor = 'nw';
        inst._localPoint = () => ({ px: 0, py: 0 });
        inst._onPointerMove({ clientX: 0, clientY: 0 });
        expect(layer.x).toBe(0);
        expect(layer.y).toBe(0);
        expect(layer.shape.w).toBe(90);
        expect(layer.shape.h).toBe(80);
    });

    test('_cancelDrag：shape-create 摘临时层；resize 回滚 x/y/w/h 四件套', () => {
        const inst = makeShapeInst();
        inst._shapeStart(10, 10);
        inst._shapeCreateMove({ x: 60, y: 50 }, {});
        inst._cancelDrag();
        expect(inst.draft.drawLayers).toHaveLength(0);
        expect(inst._drag).toBeNull();
        // resize 中断：几何回到拖拽前
        const layer = inst.addShapeLayer(10, 10);
        layer.shape.w = 50;
        layer.shape.h = 40;
        inst._selLayerId = layer.id;
        inst._drag = {
            mode: 'layer-resize', layerId: layer.id, anchor: 'se',
            orig: inst._layerBounds(layer).slice(),
            origGeom: { x: 10, y: 10, w: 50, h: 40 },
            histSnap: inst._histSnapshot()
        };
        inst._localPoint = () => ({ px: 90, py: 80 });
        inst._onPointerMove({ clientX: 0, clientY: 0 });
        expect(layer.shape.w).toBe(80);
        inst._cancelDrag();
        expect(layer.x).toBe(10);
        expect(layer.y).toBe(10);
        expect(layer.shape.w).toBe(50);
        expect(layer.shape.h).toBe(40);
    });

    test('_applyShapeOpts：未选中只落默认；选中实时生效', () => {
        const inst = makeShapeInst();
        inst._shapeOpts.type = 'ellipse';
        inst._applyShapeOpts();
        expect(inst.draft.drawLayers || []).toHaveLength(0);   // 无选中层不碰层栈
        const layer = inst.addShapeLayer(0, 0);
        inst._selLayerId = layer.id;
        inst._applyShapeOpts();
        expect(layer.shape.type).toBe('ellipse');
    });

    test('setColor 按工具分发到形状填充色（色板契约扩一档，ADR 068/069）', () => {
        const inst = makeShapeInst();
        inst.setColor('#112233');
        expect(inst._fillColor).toBe('#112233');
        expect(inst._shapeOpts.fill).toBe('#112233');
        // 选中层实时生效
        const layer = inst.addShapeLayer(0, 0);
        inst._selLayerId = layer.id;
        inst.setColor('#445566');
        expect(layer.shape.fill).toBe('#445566');
    });

    test('红斜杠开关：去填充↔恢复上次值；去边框↔恢复上次边宽', () => {
        const inst = makeShapeInst();
        const layer = inst.addShapeLayer(0, 0);
        inst._selLayerId = layer.id;
        layer.shape.fill = '#abcdef';
        layer.shape.strokeWidth = 3;
        inst._syncShapeOptsFromLayer(layer);   // 真实选择流程：选项条反向同步
        inst._toggleShapeFillNone();
        expect(layer.shape.fill).toBe('none');
        expect(inst._lastShapeFill).toBe('#abcdef');
        inst._toggleShapeFillNone();
        expect(layer.shape.fill).toBe('#abcdef');
        inst._toggleShapeStrokeNone();
        expect(layer.shape.strokeWidth).toBe(0);
        inst._toggleShapeStrokeNone();
        expect(layer.shape.strokeWidth).toBe(3);
    });
});

describe('MangaEditor 漫画项目管理（MangaProjects，ADR 071 交付独立）', () => {

    function makeProjInst() {
        const inst = makeInstance([]);
        inst.pages = [inst.draft];
        inst.activePage = 0;
        inst.visible = false;
        inst.hideCalls = 0;
        inst.hide = function () { inst.hideCalls++; inst.visible = false; };
        inst._exportSnap = inst._docSnapshot();
        inst._layerImgCache = new Map();
        inst._nextLayerId = 1;
        inst._renderLayerPanel = () => {};
        inst._renderRail = () => {};
        inst._resetHistory = () => {};
        inst._loadBackgroundImg = () => {};
        inst.projectBtn = { textContent: '项目', title: '' };
        return inst;
    }

    test('_applyLoadedDocument：项目态落位（id/名称/localStorage 记忆/面板重渲染/按钮标签）', () => {
        const inst = makeProjInst();
        const page = { width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy', summary: { caption: '', canvas: 'single' }, items: [] };
        inst._applyLoadedDocument({ pages: [page, page], active: 1 }, { id: 'm-20261107-abcd', name: '测试本' });
        expect(inst.currentProjectId).toBe('m-20261107-abcd');
        expect(inst.currentProjectName).toBe('测试本');
        expect(inst.pages).toHaveLength(2);
        expect(inst.activePage).toBe(1);
        expect(inst.draft).toBe(inst.pages[1]);
        expect(inst._selLayerId).toBe(null);
        expect(context.localStorage.getItem('lumenLight.mangaLastProject')).toBe('m-20261107-abcd');
        expect(inst.projectBtn.textContent).toContain('●');
        expect(inst.projectBtn.title).toContain('测试本');
    });

    test('_applyLoadedDocument：null 项目=默认草稿态，不写 localStorage，按钮无 ●', () => {
        const inst = makeProjInst();
        context.localStorage.setItem('lumenLight.mangaLastProject', 'm-20261107-old');
        const page = { width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy', summary: { caption: '', canvas: 'single' }, items: [] };
        inst._applyLoadedDocument({ pages: [page], active: 0 }, null);
        expect(inst.currentProjectId).toBe(null);
        expect(inst.currentProjectName).toBe(null);
        expect(inst.projectBtn.textContent).toBe('项目');
        expect(inst.projectBtn.title).toContain('默认草稿');
    });

    test('_transferGenImage：无项目原样返回；有项目转存成功换项目路径；失败回落原 src', async () => {
        const inst = makeProjInst();
        inst.currentProjectId = null;
        await expect(inst._transferGenImage('data:image/png;base64,AAA')).resolves.toBe('data:image/png;base64,AAA');

        inst.currentProjectId = 'm-20261107-abcd';
        context.fetch = async (url, opts) => ({
            ok: true,
            json: async () => ({ status: 'ok', path: '/api/manga-projects/m-20261107-abcd/images/1.png' }),
            url, opts
        });
        try {
            await expect(inst._transferGenImage('data:image/png;base64,AAA'))
                .resolves.toBe('/api/manga-projects/m-20261107-abcd/images/1.png');
        } finally {
            delete context.fetch;
        }

        context.fetch = async () => { throw new Error('网络炸了'); };
        try {
            await expect(inst._transferGenImage('data:image/png;base64,AAA'))
                .resolves.toBe('data:image/png;base64,AAA');   // 失败回落原 src
            expect(inst.statusCalls[inst.statusCalls.length - 1].isError).toBe(true);
        } finally {
            delete context.fetch;
        }
    });
});

describe('MangaAdjustTool 调色工具（ADR 074 自灯箱 StudioAdjustTool 迁移）', () => {
    const MangaAdjustTool = context.window.MangaAdjustTool;

    /** vm 内 document.createElement 桩（canvas 支持像素管线；用完即删防泄漏） */
    function withFakeDocument(fn) {
        const ImageDataCtor = context.ImageData;
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
        inst._resetHistory = () => {}; inst._updateProjectBtnLabel = () => {}; inst._loadBackgroundImg = () => {};
        inst._applyLoadedDocument({ pages: inst.pages, active: 0 }, null);
        expect(inst._selLayerId).toBe(5);
    });
});

describe('MangaPanel 分区级眼睛（全部元素框一键隐藏/显示，2026-11-07 用户拍板）', () => {
    function makeItemsEyeInst(items) {
        const inst = Object.create(MangaEditor.prototype);
        inst.draft = {
            width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy',
            summary: { caption: '', canvas: 'single' }, items, drawLayers: []
        };
        inst.selected = -1;
        inst._hiddenCids = new Set();
        inst.itemsEl = { innerHTML: '' };
        inst.itemCountEl = { textContent: '' };
        inst.itemsEyeEl = { innerHTML: '', title: '', isOff: null, classList: { toggle(c, v) { inst.itemsEyeEl.isOff = v; } } };
        inst._renderStageCalls = 0;
        inst._renderStage = () => { inst._renderStageCalls++; };
        inst.renderItemsCalls = 0;
        inst._renderItems = () => { inst.renderItemsCalls++; inst._syncItemsEyeUi(); };
        return inst;
    }
    const mkItem = (cid) => ({ cid, label: 'object', caption: '', bbox: [0, 0, 10, 10] });

    test('_toggleAllItemsHidden：混合态全隐 → 再点全显（视图态不进编译）', () => {
        const inst = makeItemsEyeInst([mkItem(0), mkItem(1), mkItem(2)]);
        inst._hiddenCids.add(1);   // 混合态：单卡已隐一个
        inst._toggleAllItemsHidden();
        expect([...inst._hiddenCids].sort()).toEqual([0, 1, 2]);   // 全隐
        expect(inst.renderItemsCalls).toBe(1);
        expect(inst._renderStageCalls).toBe(1);
        inst._toggleAllItemsHidden();
        expect(inst._hiddenCids.size).toBe(0);                     // 全显
    });

    test('_syncItemsEyeUi：聚合态切图标（划线眼=全隐）与提示文案', () => {
        const inst = makeItemsEyeInst([mkItem(0), mkItem(1)]);
        inst._syncItemsEyeUi();
        expect(inst.itemsEyeEl.innerHTML).toContain('M1 12s4-8');          // 普通眼
        expect(inst.itemsEyeEl.title).toContain('隐藏全部');
        expect(inst.itemsEyeEl.isOff).toBe(false);

        inst._hiddenCids.add(0);
        inst._syncItemsEyeUi();                                            // 混合态仍算可见
        expect(inst.itemsEyeEl.innerHTML).toContain('M1 12s4-8');

        inst._hiddenCids.add(1);                                           // 全隐
        inst._syncItemsEyeUi();
        expect(inst.itemsEyeEl.innerHTML).toContain('x2="23" y2="23"');    // 划线眼
        expect(inst.itemsEyeEl.title).toContain('显示全部');
        expect(inst.itemsEyeEl.isOff).toBe(true);

        const empty = makeItemsEyeInst([]);                                // 空页不算全隐
        empty._syncItemsEyeUi();
        expect(empty.itemsEyeEl.innerHTML).toContain('M1 12s4-8');
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
// 移除工具（MangaRemoveTool，ADR 076）：遮罩涂抹 + 松手自动 LaMa 抹除
// ==========================================================================

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

describe('MangaEditor 分镜模板换算（MangaTemplates 混入，ADR 078）', () => {
    function makeTplInstance() {
        const inst = makeInstance([]);
        inst.draft.width = 1000;
        inst.draft.height = 500;
        inst._nextCid = 100;
        return inst;
    }

    test('_tplCellsToItems：归一化格子按画幅换算回绝对 xyxy，cid 就地分配', () => {
        const inst = makeTplInstance();
        const items = inst._tplCellsToItems([
            { x: 0.1, y: 0.2, w: 0.3, h: 0.4, label: 'character', shot: '中景' },
            { x: 0, y: 0, w: 0.5, h: 1 }
        ]);
        expect(items).toHaveLength(2);
        expect(items[0].bbox).toEqual([100, 100, 400, 300]);
        expect(items[0].label).toBe('character');
        expect(items[0].shot).toBe('中景');
        expect(items[0].caption).toBe('');
        expect(items[1].cid).toBe(items[0].cid + 1);   // cid 就地递增
        expect(items[1].label).toBe('object');         // 缺省 object
        expect(items[0]).not.toHaveProperty('title');   // 模板不带框标题
    });

    test('_tplCellsToItems：无效格子跳过不拖垮，越界坐标被 normalizeBox 钳进画幅', () => {
        const inst = makeTplInstance();
        const items = inst._tplCellsToItems([
            null,
            { x: 0.1, y: 0.1, w: 0, h: 0.5 },        // 宽为 0 无效
            { x: 0.9, y: 0.9, w: 0.5, h: 0.5 },      // 越界 → 钳到画幅内
            { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }
        ]);
        expect(items).toHaveLength(2);
        const [x1, y1, x2, y2] = items[0].bbox;
        expect(x2).toBeLessThanOrEqual(1000);
        expect(y2).toBeLessThanOrEqual(500);
        expect(items[1].bbox).toEqual([200, 100, 300, 150]);
    });

    test('_tplItemsToCells：bbox 除以画幅归一化，只带走几何 + label/shot', () => {
        const inst = makeTplInstance();
        const cells = inst._tplItemsToCells([
            { label: 'character', shot: '前景', caption: '主角登场', title: '格 1',
              bbox: [50, 100, 550, 300] },
            { caption: '无 label', bbox: [0, 0, 1000, 500] },
            { bbox: 'bad' },
            { bbox: [100, 100, 100, 200] }   // 零面积无效
        ]);
        expect(cells).toHaveLength(2);
        expect(cells[0]).toEqual({
            x: 0.05, y: 0.2, w: 0.5, h: 0.4, label: 'character', shot: '前景'
        });
        expect(cells[0]).not.toHaveProperty('caption');
        expect(cells[0]).not.toHaveProperty('title');
        expect(cells[1]).toEqual({ x: 0, y: 0, w: 1, h: 1 });   // 缺 label 不写字段
    });

    test('_tplItemsToCells：越出画幅的框钳回 0~1（拖出界的元素框照存）', () => {
        const inst = makeTplInstance();
        const cells = inst._tplItemsToCells([
            { bbox: [-50, -50, 1200, 600] }
        ]);
        expect(cells).toHaveLength(1);
        expect(cells[0].x).toBe(0);
        expect(cells[0].y).toBe(0);
        expect(cells[0].w).toBe(1);   // 1200/1000 钳回 1
        expect(cells[0].h).toBe(1);
    });

    test('往返一致性：格子 → 元素框 → 格子，几何回到原值（画幅内）', () => {
        const inst = makeTplInstance();
        const origin = { x: 0.12, y: 0.24, w: 0.3, h: 0.4, label: 'object' };
        const items = inst._tplCellsToItems([origin]);
        const cells = inst._tplItemsToCells(items);
        expect(cells[0].x).toBeCloseTo(origin.x, 6);
        expect(cells[0].y).toBeCloseTo(origin.y, 6);
        expect(cells[0].w).toBeCloseTo(origin.w, 6);
        expect(cells[0].h).toBeCloseTo(origin.h, 6);
        expect(cells[0].label).toBe('object');
    });
});
