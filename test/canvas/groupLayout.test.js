/**
 * ==========================================================================
 * GroupLayout 单元测试
 * 覆盖阅读顺序排序（行容差）、水平/垂直/宫格三种布局的坐标与尺寸、
 * 归一化输出（0,0 起点）、只移动不缩放约定。
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
