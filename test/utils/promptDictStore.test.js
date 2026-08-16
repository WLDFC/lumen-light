/**
 * ==========================================================================
 * PromptDictStore 单元测试
 * 覆盖共享词典单例的搜索排序与索引构建：
 *   - 四级优先匹配（cn 前缀 > cn 包含 > en 前缀 > en 包含）
 *   - 同级保持词典原序、大小写不敏感、脏数据行过滤
 * 被测文件是浏览器端经典脚本（依赖全局 window），用 vm 模块在
 * 同一上下文中执行（与 nodeTypes.test.js 同一套做法）。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {} };
vm.createContext(context);

const source = fs.readFileSync(
    path.join(__dirname, '../../js/utils/PromptDictStore.js'), 'utf-8');
vm.runInContext(source, context, { filename: 'PromptDictStore.js' });

const Store = context.window.PromptDictStore;

/** 构造测试索引（绕开 fetch/IndexedDB，直接走 _apply） */
function apply(items) {
    Store._apply(items);
}

beforeEach(() => {
    Store._listeners = [];
    Store._promise = null;
});

describe('PromptDictStore 索引构建', () => {
    test('_apply 过滤 cn/en 非字符串的脏数据行', () => {
        apply([
            { cn: '1个女孩', en: '1girl' },
            null,
            { cn: 123, en: 'bad' },
            { cn: '高分辨率' },
            { cn: '单人', en: 'solo' }
        ]);
        expect(Store._index).toHaveLength(2);
        expect(Store.status).toBe('ready');
    });

    test('_apply 后状态为 ready 并通知订阅者', () => {
        const seen = [];
        Store.subscribe((s) => seen.push(s));
        apply([{ cn: '单人', en: 'solo' }]);
        expect(Store.status).toBe('ready');
        expect(seen).toEqual(['ready']);
    });

    test('subscribe 返回取消订阅函数', () => {
        const seen = [];
        const unsub = Store.subscribe((s) => seen.push(s));
        unsub();
        apply([{ cn: '单人', en: 'solo' }]);
        expect(seen).toEqual([]);
    });
});

describe('PromptDictStore 搜索排序', () => {
    beforeEach(() => {
        apply([
            { cn: '高分辨率', en: 'highres' },        // en 包含（query=girl 不含）→ 不命中
            { cn: '女孩', en: 'girl' },               // cn 前缀
            { cn: '坏女孩', en: 'badgirl' },          // cn 包含
            { cn: '女孩风', en: 'girl_style' },       // cn 前缀
            { cn: '金发女孩', en: 'golden_girl' },    // en 包含
            { cn: '女孩心', en: 'girlheart' }         // en 前缀
        ]);
    });

    test('cn 前缀优先于 cn 包含，同级保持词典原序', () => {
        const hits = Store.search('女孩');
        // 前缀档：女孩/女孩风/女孩心；包含档：坏女孩/金发女孩（中文含"女孩"）
        expect(hits.map(i => i.en)).toEqual(
            ['girl', 'girl_style', 'girlheart', 'badgirl', 'golden_girl']);
    });

    test('cn 包含优先于 en 前缀', () => {
        // query=男不命中任何 cn，en 侧按前缀/包含分档
        const hits = Store.search('girl');
        expect(hits.map(i => i.en)).toEqual(['girl', 'girl_style', 'girlheart', 'badgirl', 'golden_girl']);
    });

    test('大小写不敏感（索引为预构建小写）', () => {
        const hits = Store.search('GIRL');
        expect(hits.length).toBe(5);
        expect(hits[0].en).toBe('girl');
    });

    test('空查询返回空数组', () => {
        expect(Store.search('')).toEqual([]);
    });

    test('无命中返回空数组', () => {
        expect(Store.search('不存在的词条xyz')).toEqual([]);
    });
});
