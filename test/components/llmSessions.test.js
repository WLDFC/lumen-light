/**
 * LlmSessionManager 多会话管理测试（2026-11-20）
 * 覆盖：注册表归一（损坏兜底种子/字段防御/id 去重/活跃降序）、
 * 会话 id 生成、自动标题截断、快照键规则（legacy 保持 '_global'）。
 * 后端 piAgentManager 的会话映射 v1→v2 迁移与配对键另册（piSessionMap.test.js）。
 * 构造期 DOM/localStorage 交互属浏览器侧，vm 只测静态纯函数。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {}, localStorage: {
    getItem: () => null, setItem: () => { }, removeItem: () => { }
} };
vm.createContext(context);
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/components/LlmSessionManager.js'), 'utf-8'),
    context, { filename: 'LlmSessionManager.js' });
const LlmSessionManager = context.window.LlmSessionManager;

describe('LlmSessionManager.normalizeRegistry 注册表归一', () => {
    test('损坏 JSON / 空清单 → 种子初始 legacy 会话', () => {
        for (const bad of [null, undefined, '', 'not json', '{"a":1}', '[]', '[{}]']) {
            const list = LlmSessionManager.normalizeRegistry(bad);
            expect(list).toHaveLength(1);
            expect(list[0].id).toBe('legacy');
            expect(list[0].title).toBe('');
            expect(list[0].customTitle).toBe(false);
        }
    });

    test('合法条目保留并按 updatedAt 降序（最近活跃在前）', () => {
        const list = LlmSessionManager.normalizeRegistry(JSON.stringify([
            { id: 'a', title: '旧', updatedAt: 100, createdAt: 90 },
            { id: 'b', title: '新', updatedAt: 300, createdAt: 200 },
            { id: 'c', title: '中', updatedAt: 200, createdAt: 150 }
        ]));
        expect(list.map((s) => s.id)).toEqual(['b', 'c', 'a']);
        expect(list[0].customTitle).toBe(false);
    });

    test('无 id / 重复 id 条目剔除；缺失字段防御式补齐', () => {
        const list = LlmSessionManager.normalizeRegistry(JSON.stringify([
            { id: 'a', title: 'A', customTitle: true },
            { title: '无 id' },
            { id: 'a', title: '重复' },
            { id: 'b' }
        ]));
        expect(list).toHaveLength(2);
        expect(list[0]).toMatchObject({ id: 'a', title: 'A', customTitle: true });
        expect(list[1].title).toBe('');
        expect(list[1].customTitle).toBe(false);
        expect(list[1].createdAt).toBeGreaterThan(0);   // 缺失时间补 now
    });
});

describe('LlmSessionManager.makeId 会话 id 生成', () => {
    test('s 前缀 + 批量不撞车', () => {
        const ids = Array.from({ length: 50 }, () => LlmSessionManager.makeId());
        expect(ids.every((id) => /^s[a-z0-9]+$/.test(id))).toBe(true);
        expect(new Set(ids).size).toBe(50);
    });
});

describe('LlmSessionManager.autoTitle 自动标题', () => {
    test('截断 20 字补省略号；不超长原样', () => {
        expect(LlmSessionManager.autoTitle('短标题')).toBe('短标题');
        const long = '这是一条非常长的用户消息用来测试自动标题的截断行为是否正确';
        const t = LlmSessionManager.autoTitle(long);
        expect(t).toHaveLength(21);   // 20 字 + …
        expect(t.endsWith('…')).toBe(true);
        expect(t.startsWith(long.slice(0, 20))).toBe(true);
    });

    test('空白折叠；空文本返回空串（不产生标题）', () => {
        expect(LlmSessionManager.autoTitle('  帮我\n画一张   图  ')).toBe('帮我 画一张 图');
        expect(LlmSessionManager.autoTitle('   ')).toBe('');
        expect(LlmSessionManager.autoTitle(null)).toBe('');
    });
});

describe('LlmSessionManager.keyFor 快照键规则', () => {
    test('legacy 会话保持历史单键 _global（存量记录零迁移收编）', () => {
        expect(LlmSessionManager.keyFor('legacy')).toBe('_global');
    });

    test('其余会话按 id 细分键', () => {
        expect(LlmSessionManager.keyFor('sabc123')).toBe('_session-sabc123');
    });
});

describe('LlmSessionManager.relativeTime 相对时间标签', () => {
    const NOW = Date.now();
    let dateSpy;
    beforeAll(() => { dateSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW); });
    afterAll(() => { dateSpy.mockRestore(); });

    test('阶梯：刚刚 / N分 / N小时 / N天 / N个月 / N年', () => {
        expect(LlmSessionManager.relativeTime(NOW)).toBe('刚刚');
        expect(LlmSessionManager.relativeTime(NOW - 59_000)).toBe('刚刚');
        expect(LlmSessionManager.relativeTime(NOW - 60_000)).toBe('1分');
        expect(LlmSessionManager.relativeTime(NOW - 59 * 60_000)).toBe('59分');
        expect(LlmSessionManager.relativeTime(NOW - 60 * 60_000)).toBe('1小时');
        expect(LlmSessionManager.relativeTime(NOW - 23 * 3600_000)).toBe('23小时');
        expect(LlmSessionManager.relativeTime(NOW - 24 * 3600_000)).toBe('1天');
        expect(LlmSessionManager.relativeTime(NOW - 29 * 86400_000)).toBe('29天');
        expect(LlmSessionManager.relativeTime(NOW - 30 * 86400_000)).toBe('1个月');
        expect(LlmSessionManager.relativeTime(NOW - 330 * 86400_000)).toBe('11个月');
        expect(LlmSessionManager.relativeTime(NOW - 365 * 86400_000)).toBe('1年');
        expect(LlmSessionManager.relativeTime(NOW - 800 * 86400_000)).toBe('2年');
    });

    test('未来时间（时钟偏差）归刚刚；非法值返回空串', () => {
        expect(LlmSessionManager.relativeTime(NOW + 3600_000)).toBe('刚刚');
        expect(LlmSessionManager.relativeTime(0)).toBe('');
        expect(LlmSessionManager.relativeTime(-1)).toBe('');
        expect(LlmSessionManager.relativeTime('abc')).toBe('');
        expect(LlmSessionManager.relativeTime(undefined)).toBe('');
    });
});
