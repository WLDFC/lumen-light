/**
 * ==========================================================================
 * js/utils/OcclusionLayout.js 纯函数测试（遮挡检测与让位）
 *   - coverageRatio：全覆盖/半覆盖/遮挡源重叠并集不重复计数/不相交为 0
 *   - findOccluded：层序决定谁遮谁/面板节点恒最上/不可移动项只做遮挡源/
 *     阈值边界
 *   - findFreeSpot：原位空闲原样返回/右移就近找位/尊重间隙/向下回退/
 *     已挪对象计入占位/画布满返回 null
 *   - isSpawnConflicting：大图盖小图/新图被盖/部分重叠不冲突
 * ==========================================================================
 */

// OcclusionLayout 是浏览器端经典脚本（IIFE 挂 window），与 collectSlotLayout
// 测试同款：vm 执行源码后从 window 桩上取函数
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {} };
vm.createContext(context);
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/utils/OcclusionLayout.js'), 'utf8'),
    context
);
const {
    coverageRatio,
    findOccluded,
    findFreeSpot,
    isSpawnConflicting,
    COVERAGE_THRESHOLD
} = context.window.OcclusionLayout;

const R = (x, y, w, h) => ({ x, y, width: w, height: h });

describe('OcclusionLayout.coverageRatio 并集覆盖率', () => {
    test('全覆盖 = 1，半覆盖 = 0.5，无遮挡源 = 0，不相交 = 0', () => {
        const t = R(0, 0, 100, 100);
        expect(coverageRatio(t, [R(0, 0, 100, 100)])).toBe(1);
        expect(coverageRatio(t, [R(0, 0, 100, 50)])).toBe(0.5);
        expect(coverageRatio(t, [])).toBe(0);
        expect(coverageRatio(t, [R(500, 500, 10, 10)])).toBe(0);
    });

    test('两个遮挡源彼此重叠：并集面积不重复计数', () => {
        const t = R(0, 0, 100, 100);
        // 各遮左半/右半，且在 [40,60] 区间互相重叠 20
        const r1 = R(0, 0, 60, 100);   // 覆盖 [0,60]
        const r2 = R(40, 0, 60, 100);  // 覆盖 [40,100]
        // 并集 = 100%（不求和的 120%）
        expect(coverageRatio(t, [r1, r2])).toBe(1);
        // 改成各遮 45% 且重叠 10：并集 = 80%
        const a = R(0, 0, 45, 100);
        const b = R(35, 0, 45, 100);   // 覆盖 [35,80]
        expect(coverageRatio(t, [a, b])).toBeCloseTo(0.8, 10);
    });

    test('遮挡源超出目标边界：只计目标内部分', () => {
        const t = R(0, 0, 100, 100);
        expect(coverageRatio(t, [R(-50, -50, 200, 200)])).toBe(1);
    });
});

describe('OcclusionLayout.findOccluded 层序与阈值', () => {
    const E = (obj, x, y, w, h, layer, opts = {}) => ({
        obj, x, y, width: w, height: h, layer,
        isTopLayer: !!opts.top, movable: opts.movable !== false
    });

    test('数组序在后的对象遮挡在前的对象，反向不遮', () => {
        const a = { id: 'a' }, b = { id: 'b' };
        // b 完全压住 a：a 被遮挡；b 在上层不被 a 遮
        const entries = [
            E(a, 0, 0, 100, 100, 0),
            E(b, 0, 0, 100, 100, 1)
        ];
        const hit = findOccluded(entries);
        expect(hit).toHaveLength(1);
        expect(hit[0].obj).toBe(a);
        expect(hit[0].ratio).toBe(1);
    });

    test('部分重叠（50%）不达 90% 阈值不标记', () => {
        const a = { id: 'a' }, b = { id: 'b' };
        const entries = [
            E(a, 0, 0, 100, 100, 0),
            E(b, 50, 0, 100, 100, 1)
        ];
        expect(findOccluded(entries)).toHaveLength(0);
    });

    test('面板节点（isTopLayer）无论数组序都遮一切，且自身不进结果', () => {
        const a = { id: 'a' }, node = { id: 'node' };
        // 面板节点数组序在 a 之前，仍应遮住 a
        const entries = [
            E(node, 0, 0, 100, 100, 0, { top: true, movable: false }),
            E(a, 0, 0, 100, 100, 1)
        ];
        const hit = findOccluded(entries);
        expect(hit).toHaveLength(1);
        expect(hit[0].obj).toBe(a);
    });

    test('movable=false 的占位图：只做遮挡源不被移动', () => {
        const ph = { id: 'ph' }, a = { id: 'a' };
        const entries = [
            E(a, 0, 0, 100, 100, 0),
            E(ph, 0, 0, 100, 100, 1, { movable: false })
        ];
        const hit = findOccluded(entries);
        expect(hit.map(h => h.obj)).toEqual([a]);
    });

    test('默认阈值常量为 0.9（用户拍板）', () => {
        expect(COVERAGE_THRESHOLD).toBe(0.9);
    });
});

describe('OcclusionLayout.findFreeSpot 找空位', () => {
    test('原位无重叠：原样返回原位', () => {
        const rect = R(0, 0, 100, 100);
        const spot = findFreeSpot(rect, [R(500, 500, 50, 50)]);
        expect(spot).toEqual({ x: 0, y: 0 });
    });

    test('右侧被堵时向下找位；新位与全部占位无重叠', () => {
        const rect = R(0, 0, 100, 100);
        // 右侧摆满（限制 steps=5 让右移射程内全被占），下方留空 → 应向下找位
        const occupied = [];
        for (let i = 0; i < 8; i++) {
            occupied.push(R(64 + i * 50, 0, 100, 100));
        }
        const spot = findFreeSpot(rect, occupied, { steps: 5 });
        expect(spot).not.toBeNull();
        expect(spot.y).toBeGreaterThan(0);
        // 新位不与任何占位相交
        const cand = { x: spot.x, y: spot.y, width: 100, height: 100 };
        for (const o of occupied) {
            expect(cand.x + 100 <= o.x || o.x + o.width <= cand.x ||
                   cand.y + 100 <= o.y || o.y + o.height <= cand.y).toBe(true);
        }
    });

    test('最近空位优先：右移跳过与原位重叠的候选', () => {
        const rect = R(0, 0, 100, 100);
        // 仅原位被占：步长 64，x=64 与原位相交，x=128（与原位右缘间隙 28 ≥ 16）自由
        const spot = findFreeSpot(rect, [R(0, 0, 100, 100)]);
        expect(spot).toEqual({ x: 128, y: 0 });
    });

    test('画布塞满返回 null（调用方保持原位）', () => {
        const rect = R(0, 0, 100, 100);
        const occupied = [];
        for (let j = -2; j <= 32; j++) {
            for (let i = -2; i <= 32; i++) {
                occupied.push(R(i * 64, j * 64, 100, 100));
            }
        }
        expect(findFreeSpot(rect, occupied, { steps: 30 })).toBeNull();
    });
});

describe('OcclusionLayout.isSpawnConflicting 生成落点冲突', () => {
    test('新图完全盖住小图 → 冲突；小图只被盖 25% → 不冲突', () => {
        const spawn = R(0, 0, 1000, 1000);
        // 小图完全落在落点内（覆盖 100%）
        expect(isSpawnConflicting(spawn, [R(100, 100, 50, 50)])).toBe(true);
        // 小图与落点只有 50×50 相交（自身被盖 25%）
        expect(isSpawnConflicting(spawn, [R(950, 950, 100, 100)])).toBe(false);
    });

    test('新图被既有大图盖住 ≥90% → 冲突', () => {
        const spawn = R(0, 0, 100, 100);
        expect(isSpawnConflicting(spawn, [R(-40, -40, 200, 200)])).toBe(true);
    });

    test('不相交 → 不冲突', () => {
        expect(isSpawnConflicting(R(0, 0, 100, 100), [R(500, 500, 100, 100)])).toBe(false);
    });
});
