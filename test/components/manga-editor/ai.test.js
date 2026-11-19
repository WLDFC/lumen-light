/**
 * ai 测试（2026-11-09 自 mangaEditor.test.js 按模块拆分）
 * 覆盖：MangaEditor._parseAiLines 行协议解析；MangaEditor._parseAiReply JSON 兜底；MangaEditor._resolveAiModel 优先级链；MangaEditor._mergeAiReply；MangaEditor._aiSystemPrompt 技能指引注入（ADR 017 决策八）
 */

const { context, MangaEditor, CoordinateLayout, makeInstance } = require('./helpers');

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
