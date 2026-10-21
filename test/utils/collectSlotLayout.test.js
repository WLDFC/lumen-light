/**
 * ==========================================================================
 * CollectSlotLayout 单元测试
 * 覆盖间距语义（intersects 的 gap 半径判定）、区内空槽扫描（阅读序/
 * 换行/放不下返回 null）、编组位置级联（锚点避让步进）。
 * 被测文件是浏览器端经典脚本（依赖全局词法作用域），与 groupLayout
 * 测试同款做法：用 vm 模块按浏览器加载顺序执行源码。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {} };
vm.createContext(context);

[
    '../../js/utils/CollectSlotLayout.js'
].forEach((file) => {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf-8');
    vm.runInContext(source, context, { filename: file });
});

const CollectSlotLayout = context.window.CollectSlotLayout;

describe('intersects（间距语义）', () => {
    test('零间距：矩形相交判定', () => {
        const a = { x: 0, y: 0, width: 100, height: 100 };
        expect(CollectSlotLayout.intersects(a, { x: 50, y: 50, width: 100, height: 100 })).toBe(true);
        expect(CollectSlotLayout.intersects(a, { x: 100, y: 0, width: 100, height: 100 })).toBe(false);
    });

    test('带 gap：间距小于 gap 视为重叠、等于及以上不重叠', () => {
        const a = { x: 0, y: 0, width: 100, height: 100 };
        // 间距 10 < gap 24 → 重叠
        expect(CollectSlotLayout.intersects(a, { x: 110, y: 0, width: 100, height: 100 }, 24)).toBe(true);
        // 间距 24 → 恰好不重叠
        expect(CollectSlotLayout.intersects(a, { x: 124, y: 0, width: 100, height: 100 }, 24)).toBe(false);
    });
});

describe('findSlot（区内空槽扫描）', () => {
    const GAP = 24;

    test('空区：落区左上角', () => {
        const slot = CollectSlotLayout.findSlot(
            { x: 0, y: 0, width: 1000, height: 1000 }, [], { width: 200, height: 150 }, GAP
        );
        expect(slot).toEqual({ x: 0, y: 0 });
    });

    test('已有矩形：贴其右缘外推一个间隙', () => {
        const slot = CollectSlotLayout.findSlot(
            { x: 0, y: 0, width: 1000, height: 1000 },
            [{ x: 0, y: 0, width: 200, height: 150 }],
            { width: 200, height: 150 }, GAP
        );
        expect(slot).toEqual({ x: 224, y: 0 });
    });

    test('一行放不下：换行到已占矩形下缘（阅读序先 y 后 x）', () => {
        // 区宽 640：第三列 448+200=648 放不下 → 换行 y=174
        const slot = CollectSlotLayout.findSlot(
            { x: 0, y: 0, width: 640, height: 400 },
            [
                { x: 0, y: 0, width: 200, height: 150 },
                { x: 224, y: 0, width: 200, height: 150 }
            ],
            { width: 200, height: 150 }, GAP
        );
        expect(slot).toEqual({ x: 0, y: 174 });
    });

    test('来图比区大：返回 null（不缩放裁定交给调用方级联）', () => {
        const slot = CollectSlotLayout.findSlot(
            { x: 0, y: 0, width: 1000, height: 1000 }, [], { width: 1500, height: 150 }, GAP
        );
        expect(slot).toBeNull();
    });

    test('区内已满：返回 null', () => {
        const slot = CollectSlotLayout.findSlot(
            { x: 0, y: 0, width: 300, height: 300 },
            [{ x: 0, y: 0, width: 300, height: 300 }],
            { width: 200, height: 150 }, GAP
        );
        expect(slot).toBeNull();
    });

    test('已占矩形部分在区外：右缘外推候选仍可用且槽位不越区', () => {
        // 占位矩形从区左外侧伸入，右缘 100+24=124 是候选
        const slot = CollectSlotLayout.findSlot(
            { x: 0, y: 0, width: 500, height: 500 },
            [{ x: -200, y: 0, width: 300, height: 150 }],
            { width: 200, height: 150 }, GAP
        );
        expect(slot).toEqual({ x: 124, y: 0 });
    });
});

describe('cascade（编组位置级联）', () => {
    const GAP = 24;

    test('锚点空闲：直接落锚点', () => {
        const pos = CollectSlotLayout.cascade(
            { x: 500, y: 300 }, [], { width: 200, height: 150 }, GAP
        );
        expect(pos).toEqual({ x: 500, y: 300 });
    });

    test('锚点被占：向右步进到第一个空位', () => {
        const pos = CollectSlotLayout.cascade(
            { x: 0, y: 0 },
            [{ x: 0, y: 0, width: 200, height: 150 }],
            { width: 200, height: 150 }, GAP
        );
        expect(pos).toEqual({ x: 224, y: 0 });
    });

    test('级联路径上的长矩形：逐格绕行', () => {
        // 占位矩形 0..500 挡住锚点与前两步，第三步 672 落定
        const pos = CollectSlotLayout.cascade(
            { x: 0, y: 0 },
            [{ x: 0, y: 0, width: 500, height: 150 }],
            { width: 200, height: 150 }, GAP
        );
        expect(pos).toEqual({ x: 672, y: 0 });
    });
});
