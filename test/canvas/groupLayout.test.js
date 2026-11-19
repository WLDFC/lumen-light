/**
 * ==========================================================================
 * GroupLayout 单元测试
 * 覆盖阅读顺序排序（行容差）、水平/垂直/宫格三种布局的坐标与尺寸、
 * 归一化输出（0,0 起点）、只移动不缩放约定；时间键回退链与组内按
 * 时间排序（timeKeyOf/sortTimeOrder，2026-11-16 编组时间排序功能）。
 * 被测文件是浏览器端经典脚本（依赖全局词法作用域），与 groupManager
 * 测试同款做法：用 vm 模块按浏览器加载顺序执行源码。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {} };
vm.createContext(context);

[
    '../../js/canvas/GroupLayout.js'
].forEach((file) => {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf-8');
    vm.runInContext(source, context, { filename: file });
});

const GroupLayout = context.window.GroupLayout;

/** 构造成员对象（只需几何字段） */
function member(id, x, y, width, height) {
    return { id, x, y, width, height };
}

describe('sortReadingOrder（阅读顺序）', () => {
    test('按 y 分行、行内按 x 排序', () => {
        // 打乱的 2 行 2 列
        const a = member('a', 1000, 0, 100, 100);
        const b = member('b', 0, 0, 100, 100);
        const c = member('c', 1000, 500, 100, 100);
        const d = member('d', 0, 500, 100, 100);
        const ordered = GroupLayout.sortReadingOrder([a, b, c, d]);
        expect(ordered.map(o => o.id)).toEqual(['b', 'a', 'd', 'c']);
    });

    test('y 相差小于较小者高度一半视为同行（容差吸收抖动）', () => {
        // b 比 a 低 30（< 100/2），应视作同行、按 x 排
        const a = member('a', 500, 0, 100, 100);
        const b = member('b', 0, 30, 100, 100);
        const ordered = GroupLayout.sortReadingOrder([a, b]);
        expect(ordered.map(o => o.id)).toEqual(['b', 'a']);
    });

    test('不修改入参数组', () => {
        const a = member('a', 500, 0, 100, 100);
        const b = member('b', 0, 0, 100, 100);
        const input = [a, b];
        GroupLayout.sortReadingOrder(input);
        expect(input[0].id).toBe('a');
    });
});

describe('horizontal（水平布局）', () => {
    test('从左到右累加，整行相对最高成员垂直居中', () => {
        const a = member('a', 0, 0, 200, 100);
        const b = member('b', 0, 0, 100, 300);
        const { placements, width, height } = GroupLayout.arrange('horizontal', [a, b]);
        expect(height).toBe(300);
        // a 居中：(300-100)/2 = 100；b 与行顶齐平
        expect(placements[0]).toMatchObject({ obj: a, x: 0, y: 100 });
        expect(placements[1]).toMatchObject({ obj: b, x: 200 + GroupLayout.GAP, y: 0 });
        expect(width).toBe(200 + GroupLayout.GAP + 100);
    });

    test('输出归一化到 (0,0) 起点（与输入坐标无关）', () => {
        const a = member('a', 5000, 9000, 200, 100);
        const { placements } = GroupLayout.arrange('horizontal', [a]);
        expect(placements[0].x).toBe(0);
        expect(placements[0].y).toBe(0);
    });
});

describe('vertical（垂直布局）', () => {
    test('从上到下累加，整列相对最宽成员水平居中', () => {
        const a = member('a', 0, 0, 400, 100);
        const b = member('b', 0, 0, 200, 200);
        const { placements, width, height } = GroupLayout.arrange('vertical', [a, b]);
        expect(width).toBe(400);
        // b 居中：(400-200)/2 = 100；a 与列左缘齐平
        expect(placements[0]).toMatchObject({ obj: a, x: 0, y: 0 });
        expect(placements[1]).toMatchObject({ obj: b, x: 100, y: 100 + GroupLayout.GAP });
        expect(height).toBe(100 + GroupLayout.GAP + 200);
    });
});

describe('grid（宫格布局）', () => {
    test('列数 = ⌈√n⌉：4 张 2 列，格内双向居中', () => {
        // 2×2，b/c 尺寸不同：列宽取最大、行高取最大，成员在格内居中
        const a = member('a', 0, 0, 100, 100);   // 行0 列0
        const b = member('b', 0, 0, 200, 60);    // 行0 列1
        const c = member('c', 0, 0, 80, 300);    // 行1 列0
        const d = member('d', 0, 0, 120, 120);   // 行1 列1
        const { placements, width, height } = GroupLayout.arrange('grid', [a, b, c, d]);
        const gap = GroupLayout.GAP;

        // 列宽：[max(100,80), max(200,120)] = [100, 200]；行高：[max(100,60), max(300,120)] = [100, 300]
        expect(placements[0]).toMatchObject({ obj: a, x: 0, y: 0 });                    // 格 100×100 恰好填满
        expect(placements[1]).toMatchObject({ obj: b, x: 100 + gap, y: (100 - 60) / 2 });
        expect(placements[2]).toMatchObject({ obj: c, x: (100 - 80) / 2, y: 100 + gap });
        expect(placements[3]).toMatchObject({ obj: d, x: 100 + gap + (200 - 120) / 2, y: 100 + gap + (300 - 120) / 2 });
        expect(width).toBe(100 + gap + 200);
        expect(height).toBe(100 + gap + 300);
    });

    test('5 张 → 3 列（⌈√5⌉），末行不满也能排', () => {
        const members = [0, 1, 2, 3, 4].map(i => member(`m${i}`, 0, 0, 100, 100));
        const { placements, width } = GroupLayout.arrange('grid', members);
        expect(placements).toHaveLength(5);
        // 3 列：前 3 张第一行，后 2 张第二行
        expect(placements[3].y).toBeGreaterThan(placements[0].y);
        expect(width).toBe(100 * 3 + GroupLayout.GAP * 2);
    });

    test('只移动不缩放：成员宽高不被修改', () => {
        const a = member('a', 0, 0, 100, 300);
        const b = member('b', 0, 0, 400, 80);
        GroupLayout.arrange('grid', [a, b]);
        expect(a).toMatchObject({ width: 100, height: 300 });
        expect(b).toMatchObject({ width: 400, height: 80 });
    });

    test('所有坐标非负（格内居中不会推出包围盒）', () => {
        const members = [
            member('a', 0, 0, 50, 200),
            member('b', 0, 0, 300, 40),
            member('c', 0, 0, 120, 90)
        ];
        const { placements } = GroupLayout.arrange('grid', members);
        for (const p of placements) {
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeGreaterThanOrEqual(0);
        }
    });
});

describe('waterfall（瀑布流布局）', () => {
    test('最矮列优先：高成员独占一列后，短成员回流矮列（瀑布流语义）', () => {
        // 3 张 2 列（⌈√3⌉=2）：a→列0；b(高300)→列1；c 回到更矮的列0
        const a = member('a', 0, 0, 100, 100);
        const b = member('b', 0, 0, 100, 300);
        const c = member('c', 0, 0, 100, 100);
        const { placements, width, height } = GroupLayout.arrange('waterfall', [a, b, c]);
        const gap = GroupLayout.GAP;

        expect(placements[0]).toMatchObject({ obj: a, x: 0, y: 0 });
        expect(placements[1]).toMatchObject({ obj: b, x: 100 + gap, y: 0 });
        expect(placements[2]).toMatchObject({ obj: c, x: 0, y: 100 + gap });
        expect(width).toBe(100 * 2 + gap);
        // 列1 总高 300+gap 为最深列，去掉尾部 gap
        expect(height).toBe(300);
    });

    test('列宽 = 成员最大宽，窄成员列内水平居中', () => {
        const a = member('a', 0, 0, 400, 100);
        const b = member('b', 0, 0, 200, 100);
        const { placements, width } = GroupLayout.arrange('waterfall', [a, b]);
        expect(width).toBe(400 * 2 + GroupLayout.GAP);
        // b 落列1（空列更矮），在 400 宽列内居中：(400-200)/2 = 100
        expect(placements[1].x).toBe(400 + GroupLayout.GAP + 100);
    });

    test('4 张等尺寸 → 2 列各 2 张（⌈√4⌉），等高并列取最左', () => {
        const members = ['a', 'b', 'c', 'd'].map(id => member(id, 0, 0, 100, 100));
        const { placements } = GroupLayout.arrange('waterfall', members);
        expect(placements.map(p => p.obj.id)).toEqual(['a', 'b', 'c', 'd']);
        expect(placements[2]).toMatchObject({ x: 0, y: 100 + GroupLayout.GAP });
        expect(placements[3]).toMatchObject({ x: 100 + GroupLayout.GAP, y: 100 + GroupLayout.GAP });
    });

    test('只移动不缩放：成员宽高不被修改', () => {
        const a = member('a', 0, 0, 100, 300);
        const b = member('b', 0, 0, 400, 80);
        GroupLayout.arrange('waterfall', [a, b]);
        expect(a).toMatchObject({ width: 100, height: 300 });
        expect(b).toMatchObject({ width: 400, height: 80 });
    });
});

describe('timeKeyOf（时间键回退链）', () => {
    test('created 优先于 genInfo.time', () => {
        const o = member('a', 0, 0, 100, 100);
        o.created = 2000;
        o.genInfo = { time: 1000 };
        expect(GroupLayout.timeKeyOf(o)).toBe(2000);
    });

    test('无 created 时回退 genInfo.time', () => {
        const o = member('a', 0, 0, 100, 100);
        o.genInfo = { time: 1000 };
        expect(GroupLayout.timeKeyOf(o)).toBe(1000);
    });

    test('再回退 name/videoUrl 内嵌 13 位毫秒戳', () => {
        const o1 = member('a', 0, 0, 100, 100);
        o1.name = 'upscaled_1699999999999.png';
        const o2 = member('b', 0, 0, 100, 100);
        o2.videoUrl = '/data/videos/video_1700000000000.mp4';
        expect(GroupLayout.timeKeyOf(o1)).toBe(1699999999999);
        expect(GroupLayout.timeKeyOf(o2)).toBe(1700000000000);
    });

    test('无任何时间线索返回 Infinity', () => {
        expect(GroupLayout.timeKeyOf(member('a', 0, 0, 100, 100))).toBe(Infinity);
    });

    test('失真值不采纳：非有限数/非正数视同缺失', () => {
        const o = member('a', 0, 0, 100, 100);
        o.created = -5;
        expect(GroupLayout.timeKeyOf(o)).toBe(Infinity);
        o.created = NaN;
        o.genInfo = { time: 'abc' };
        expect(GroupLayout.timeKeyOf(o)).toBe(Infinity);
    });
});

describe('sortTimeOrder（组内按时间排序）', () => {
    test('时间升序（旧→新），无时间成员尾置并保持阅读序', () => {
        // 阅读序基座：old(左上) newest(右上) none1(左下) none2(右下)
        const old = member('old', 0, 0, 100, 100);
        old.created = 1000;
        const newest = member('newest', 500, 0, 100, 100);
        newest.genInfo = { time: 9000 };
        const none1 = member('none1', 0, 500, 100, 100);
        const none2 = member('none2', 500, 500, 100, 100);
        const ordered = GroupLayout.sortTimeOrder([newest, old, none2, none1]);
        expect(ordered.map(o => o.id)).toEqual(['old', 'newest', 'none1', 'none2']);
    });

    test('desc 方向（新→旧）：最新在阅读序首位，无时间成员仍尾置', () => {
        const old = member('old', 0, 0, 100, 100);
        old.created = 1000;
        const newest = member('newest', 500, 0, 100, 100);
        newest.genInfo = { time: 9000 };
        const none = member('none', 0, 500, 100, 100);
        const ordered = GroupLayout.sortTimeOrder([old, newest, none], 'desc');
        expect(ordered.map(o => o.id)).toEqual(['newest', 'old', 'none']);
    });

    test('同毫秒并列不洗牌（保持阅读序基座）', () => {
        const a = member('a', 0, 0, 100, 100);
        a.created = 5000;
        const b = member('b', 500, 0, 100, 100);
        b.created = 5000;   // 批量同帧
        const ordered = GroupLayout.sortTimeOrder([b, a]);
        expect(ordered.map(o => o.id)).toEqual(['a', 'b']);
    });

    test('不修改入参数组', () => {
        const a = member('a', 0, 0, 100, 100);
        a.created = 2000;
        const b = member('b', 500, 0, 100, 100);
        b.created = 1000;
        const input = [a, b];
        GroupLayout.sortTimeOrder(input);
        expect(input.map(o => o.id)).toEqual(['a', 'b']);
    });

    test('arrange 第三参：时间序直接喂宫格（跳过阅读序）', () => {
        // 位置上 b 在前（阅读序 b,a），时间上 a 旧 b 新
        const b = member('b', 0, 0, 100, 100);
        b.created = 9000;
        const a = member('a', 500, 0, 100, 100);
        a.created = 1000;
        const { placements } = GroupLayout.arrange(
            'grid', [b, a], GroupLayout.sortTimeOrder([b, a]));
        // 宫格逐行按传入序：a（旧）占左上，b（新）占右上
        expect(placements.map(p => p.obj.id)).toEqual(['a', 'b']);
        expect(placements[0]).toMatchObject({ x: 0, y: 0 });
        expect(placements[1]).toMatchObject({ x: 100 + GroupLayout.GAP, y: 0 });
    });
});
