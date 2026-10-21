/**
 * ==========================================================================
 * CoordinateEditor 合并/解析单元测试
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
 *   - 并排窗口：留白钳制（下限 360/上限保三栏最小宽 900）、ESC 焦点
 *     守卫（弹窗内关、面板输入框不关）
 *   - 撤销/重做（ADR 017 决策十一）：快照入账去重、undo/redo 序列与
 *     状态往返、上限 50 裁剪、文本输入防抖合并一步、撤销后自动保存
 *     同步回滚、快捷键焦点守卫（并排时面板内放行）、新建/恢复清栈
 * 被测文件是浏览器端经典脚本（依赖全局 window），用 vm 模块加载；
 * 构造函数依赖 DOM，测试用 Object.create + 桩方法绕开（只测纯逻辑方法）。
 * 拆分后（ADR 026）组件按职责域拆为 coordinate-editor/ 混入模块——
 * vm 同载主类与六个混入文件（混入 Object.assign 回原型，加载顺序同页面），
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
vm.createContext(context);
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/components/CoordinateEditor.js'), 'utf-8'),
    context, { filename: 'CoordinateEditor.js' });
// 子模块混入文件同载（须后于主类——Object.assign 进 CoordinateEditor.prototype）
for (const f of ['CoordDom.js', 'CoordPanel.js', 'CoordStage.js',
    'CoordHistory.js', 'CoordDraftStore.js', 'CoordAi.js']) {
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '../../js/components/coordinate-editor/', f), 'utf-8'),
        context, { filename: f });
}
// CoordinateLayout 一并加载进同一上下文（景别剥离后的编译断言用；
// 组件运行时消费它，测试环境同样供给）
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/utils/CoordinateLayout.js'), 'utf-8'),
    context, { filename: 'CoordinateLayout.js' });
const CoordinateEditor = context.window.CoordinateEditor;
const CoordinateLayout = context.window.CoordinateLayout;

/** 造一个绕开 DOM 的实例：只接纯逻辑方法，渲染/状态方法打桩 */
function makeInstance(items) {
    const inst = Object.create(CoordinateEditor.prototype);
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

describe('CoordinateEditor._parseAiLines 行协议解析', () => {
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

describe('CoordinateEditor._parseAiReply JSON 兜底', () => {
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

describe('CoordinateEditor._resolveAiModel 优先级链', () => {
    const MODELS = [
        { key: 'A||m1', provider: 'A', id: 'm1', displayName: 'M1' },
        { key: 'B||m2', provider: 'B', id: 'm2', displayName: 'M2' }
    ];
    beforeEach(() => { context.localStorage._s = {}; });

    function makeInst() {
        const inst = Object.create(CoordinateEditor.prototype);
        inst._aiModels = MODELS;
        inst._loadChatModels = async () => MODELS;
        return inst;
    }

    test('显式选择（coordModel）最优先，压过 piModelKey', async () => {
        context.localStorage.setItem('lumenLight.coordModel', 'B||m2');
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
        context.localStorage.setItem('lumenLight.coordModel', 'Z||deleted');
        context.localStorage.setItem('piModelKey', 'A||m1');
        expect(await makeInst()._resolveAiModel()).toBe('A||m1');
    });
});

describe('CoordinateEditor 景别辅助（item.shot）', () => {
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

describe('CoordinateEditor._mergeAiReply', () => {
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

describe('CoordinateEditor 草稿持久化（ADR 018）', () => {
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
        items: [{ label: 'text', caption: '标题', text: '流光', bbox: [0, 0, 400, 200], shot: '前景' }]
    };

    /** 持久化用实例：保留真 _invalidateCompiled，只桩 DOM 触点与渲染 */
    function makePersistInstance() {
        const inst = Object.create(CoordinateEditor.prototype);
        inst.draft = CoordinateLayout.createDraft();
        inst.compiled = null;
        inst.copyBtn = { disabled: false };
        inst.panelBtn = { disabled: false };
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
        return inst;
    }

    test('草稿变更防抖合并为一次 PUT，成功后脏标记清除', async () => {
        const inst = makePersistInstance();
        inst.draft.summary.caption = '连改三次';
        inst._invalidateCompiled();
        inst._invalidateCompiled();
        inst._invalidateCompiled();
        expect(fetchCalls).toHaveLength(0);       // 防抖窗口内不发
        flushTimers();
        await new Promise((r) => realSetTimeout(r, 0));
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0].url).toBe('/api/coordinate-draft');
        expect(fetchCalls[0].opts.method).toBe('PUT');
        expect(JSON.parse(fetchCalls[0].opts.body).draft).toEqual(inst.draft);
        expect(inst._saveDirty).toBe(false);
        expect(inst._draftTouched).toBe(true);
    });

    test('_flushSave：脏时 keepalive 补发并清脏，不脏时不发', () => {
        const inst = makePersistInstance();
        inst._scheduleSave();
        inst._flushSave();
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0].opts.keepalive).toBe(true);
        expect(inst._saveDirty).toBe(false);
        inst._flushSave();
        expect(fetchCalls).toHaveLength(1);       // 已不脏，不再发
    });

    test('保存失败：状态栏报错、脏标记保留', async () => {
        nextFetchResult = { ok: false, status: 500, json: async () => ({ status: 'error', message: 'boom' }) };
        const inst = makePersistInstance();
        inst._invalidateCompiled();
        flushTimers();
        await new Promise((r) => realSetTimeout(r, 0));
        expect(inst._saveDirty).toBe(true);
        expect(inst.statusCalls.some((c) => c.isError && /自动保存失败/.test(c.text))).toBe(true);
    });

    test('_loadSavedDraft：远端草稿经归一回填（shot 保留）', async () => {
        nextFetchResult = { ok: true, status: 200, json: async () => ({ status: 'ok', draft: SAVED_DRAFT }) };
        const inst = makePersistInstance();
        await inst._loadSavedDraft();
        await new Promise((r) => realSetTimeout(r, 0));
        expect(inst.draft.width).toBe(832);
        expect(inst.draft.summary.canvas).toBe('collage');
        expect(inst.draft.items[0].shot).toBe('前景');
        expect(inst.renderAllCalls).toBe(1);
        expect(inst.statusCalls.some((c) => /已恢复/.test(c.text))).toBe(true);
    });

    test('_loadSavedDraft：GET 返回前用户已动手则丢弃远端（竞态闸）', async () => {
        nextFetchResult = { ok: true, status: 200, json: async () => ({ status: 'ok', draft: SAVED_DRAFT }) };
        const inst = makePersistInstance();
        inst._draftTouched = true;
        await inst._loadSavedDraft();
        expect(inst.draft.width).toBe(1024);      // 保持默认草稿
        expect(inst.renderAllCalls).toBe(0);
    });

    test('_loadSavedDraft：draft 为 null（无存档/损坏）静默保持默认', async () => {
        const inst = makePersistInstance();
        await inst._loadSavedDraft();
        expect(inst.renderAllCalls).toBe(0);
        expect(inst.draft).toEqual(CoordinateLayout.createDraft());
    });
});

describe('CoordinateEditor._aiSystemPrompt 技能指引注入（ADR 017 决策八）', () => {
    const SKILL_ID = 'moss-image-prompt-enhancer';
    const SKILL_BODY = 'Write readable JSON. Use boxes for coherent visible units.\nRun python3 scripts/compile_prompt.py draft.json';

    function makeInst() {
        const inst = Object.create(CoordinateEditor.prototype);
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
        context.localStorage.setItem('lumenLight.coordSkill', SKILL_ID);
        const p = makeInst()._aiSystemPrompt();
        expect(p).toContain('--- 指引开始 ---');
        expect(p).toContain('coherent visible units');
        expect(p).toContain('一律忽略');
        // 基础指令仍在（行协议不会被指引顶掉）
        expect(p.indexOf('SUMMARY:')).toBeLessThan(p.indexOf('指引开始'));
    });

    test('选中的技能已不在缓存（被删/禁用）：回落基础指令', () => {
        context.localStorage.setItem('lumenLight.coordSkill', 'gone-skill');
        const p = makeInst()._aiSystemPrompt();
        expect(p).not.toContain('指引开始');
    });

    test('技能正文超长截断到上限并注明', () => {
        const long = 'x'.repeat(20001);
        const inst = makeInst();
        inst._skillBodies.set('long-skill', long);
        context.localStorage.setItem('lumenLight.coordSkill', 'long-skill');
        const p = inst._aiSystemPrompt();
        expect(p).toContain('已截断');
        // 截断到恰好 20000 字符：连续段存在、原长段不存在
        expect(p).toContain('x'.repeat(20000));
        expect(p).not.toContain('x'.repeat(20001));
    });
});

describe('CoordinateEditor._compile/_invalidateCompiled 输出框（右栏共用）', () => {
    function makeOutInst() {
        const inst = Object.create(CoordinateEditor.prototype);
        inst.draft = {
            width: 1024, height: 1024,
            bbox_coord_space: 'abs', bbox_format: 'xyxy',
            summary: { caption: 'A poster.', canvas: 'single' },
            items: [{ label: 'object', caption: 'A cup.', bbox: [64, 64, 512, 512] }]
        };
        inst.compiled = null;
        inst.copyBtn = { disabled: false };
        inst.panelBtn = { disabled: false };
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
});

describe('CoordinateEditor 并排窗口（右缘留白与 ESC 守卫）', () => {
    test('_clampGap：下限 360、上限保编辑器最小宽 900、非数字回落默认', () => {
        const inst = Object.create(CoordinateEditor.prototype);
        expect(inst._clampGap(540, 1920)).toBe(540);          // 常规值原样（取整）
        expect(inst._clampGap(80, 1920)).toBe(360);           // 至少放下面板
        expect(inst._clampGap(5000, 1920)).toBe(1020);        // innerWidth-900
        expect(inst._clampGap('x', 1920)).toBe(540);          // 非数字 → 默认
        expect(inst._clampGap(NaN, 1920)).toBe(540);
        // 窄屏上限塌到下限：不产生负宽
        expect(inst._clampGap(800, 1100)).toBe(360);
    });

    test('_shouldCloseOnEscape：弹窗内/无焦点目标关窗，外部面板不关', () => {
        const inst = Object.create(CoordinateEditor.prototype);
        const inside = { tag: 'editor-input' };
        inst.dialog = { contains: (t) => t === inside };
        expect(inst._shouldCloseOnEscape(inside)).toBe(true);          // 弹窗内
        expect(inst._shouldCloseOnEscape(null)).toBe(true);            // 无目标
        expect(inst._shouldCloseOnEscape(undefined)).toBe(true);
        expect(inst._shouldCloseOnEscape({ tag: 'llm-input' })).toBe(false);   // 面板输入框
        inst.dialog = null;
        expect(inst._shouldCloseOnEscape({ tag: 'llm-input' })).toBe(true);    // 无弹窗兜底关
    });

    describe('_defaultGap 按面板实测宽度对齐', () => {
        afterEach(() => { delete context.document; delete context.window.innerWidth; });

        const panelRect = (left, width) => ({
            getElementById: (id) => id === 'promptPanel'
                ? { getBoundingClientRect: () => ({ left, width }) }
                : null
        });

        test('面板默认宽（左缘=innerWidth-545）→ 留白 552', () => {
            const inst = Object.create(CoordinateEditor.prototype);
            context.window = { innerWidth: 1920 };
            context.document = panelRect(1920 - 545, 540);
            expect(inst._defaultGap()).toBe(552);
        });

        test('面板拖宽到 700 → 留白跟随到 712', () => {
            const inst = Object.create(CoordinateEditor.prototype);
            context.window = { innerWidth: 1920 };
            context.document = panelRect(1920 - 705, 700);
            expect(inst._defaultGap()).toBe(712);
        });

        test('面板隐藏（平移出视口）/取不到 → 回落 552', () => {
            const inst = Object.create(CoordinateEditor.prototype);
            context.window = { innerWidth: 1920 };
            context.document = panelRect(2500, 540);          // translateX 藏到右侧外
            expect(inst._defaultGap()).toBe(552);
            context.document = { getElementById: () => null };
            expect(inst._defaultGap()).toBe(552);
        });
    });
});

describe('CoordinateEditor 图层：遮挡选层与顺序操作（ADR 017 决策十）', () => {
    // 视口 1:1（scale=1, 偏移 0），bbox 即舞台像素坐标
    function makeLayerInst() {
        const inst = Object.create(CoordinateEditor.prototype);
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
        inst.panelBtn = { disabled: false };
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

describe('CoordinateEditor 撤销/重做（快照式，ADR 017 决策十一）', () => {
    const realSetTimeout = global.setTimeout;

    function makeHistInst() {
        const inst = Object.create(CoordinateEditor.prototype);
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
        inst.panelBtn = { disabled: false };
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
