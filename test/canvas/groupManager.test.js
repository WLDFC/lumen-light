/**
 * ==========================================================================
 * GroupManager 单元测试
 * 覆盖组数据管理（增删/选中）、成员包含判定、标题栏/边缘手柄命中、
 * 手柄几何与光标决策。
 * 被测文件是浏览器端经典脚本（依赖全局词法作用域），与 canvasHitTester
 * 测试同款做法：用 vm 模块按浏览器加载顺序执行源码。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = {
    console,
    window: { dispatchEvent() {} },   // 派发 canvasGroupSelected 的桩
    // Node 无 CustomEvent，提供最小构造桩（type/detail 即 GroupManager 用到的全部）
    CustomEvent: class {
        constructor(type, opts) {
            this.type = type;
            this.detail = opts && opts.detail;
        }
    }
};
vm.createContext(context);

[
    '../../js/config.js',
    '../../js/utils/NodeTypes.js',
    '../../js/canvas/GroupManager.js'
].forEach((file) => {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf-8');
    vm.runInContext(source, context, { filename: file });
});

const GroupManager = context.window.GroupManager;
const NodeTypes = context.window.NodeTypes;

/** 构造测试用画布对象（只含 GroupManager 所需字段） */
function makeCanvas(images = []) {
    return {
        viewport: { scale: 1 },
        images: { images }
    };
}

describe('add / delete / 选中管理', () => {
    test('add 生成组对象并钳制最小尺寸', () => {
        const manager = new GroupManager(makeCanvas());
        const g = manager.add(10, 20, 50, 40);
        expect(g.type).toBe('group');
        expect(g.title).toBe(GroupManager.DEFAULT_TITLE);
        expect(g.width).toBe(GroupManager.MIN_WIDTH);   // 50 < 最小宽，被钳制
        expect(g.height).toBe(GroupManager.MIN_HEIGHT);
        expect(g.selected).toBe(false);
    });

    test('select / toggleSelect / clearSelection 状态互斥且同步 selected 标记', () => {
        const manager = new GroupManager(makeCanvas());
        const a = manager.add(0, 0, 300, 200);
        const b = manager.add(400, 0, 300, 200);

        manager.select(a.id);
        expect(manager.getSelected()).toEqual([a]);
        expect(a.selected).toBe(true);

        manager.toggleSelect(b.id);
        expect(manager.selectedIds.size).toBe(2);

        manager.toggleSelect(b.id);   // 再次切换 = 取消
        expect(manager.selectedIds.has(b.id)).toBe(false);

        manager.clearSelection();
        expect(manager.getSelected()).toHaveLength(0);
        expect(a.selected).toBe(false);
    });

    test('delete 移除组并清选中；组壳删除不影响成员数据', () => {
        const manager = new GroupManager(makeCanvas());
        const g = manager.add(0, 0, 300, 200);
        manager.select(g.id);
        expect(manager.delete(g.id)).toBe(true);
        expect(manager.groups).toHaveLength(0);
        expect(manager.selectedIds.size).toBe(0);
        expect(manager.delete(g.id)).toBe(false);
    });
});

describe('contains / getMembers（几何包含判定）', () => {
    test('完全包含才判定为成员，出界与占位图排除', () => {
        const group = { x: 0, y: 0, width: 500, height: 400 };
        const inside = { id: 'a', x: 10, y: 10, width: 100, height: 80, source: 'save' };
        const overflow = { id: 'b', x: 450, y: 10, width: 100, height: 80, source: 'save' };  // 右缘出界
        const placeholder = { id: 'c', x: 20, y: 20, width: 50, height: 50, source: 'generation-placeholder' };

        const canvas = makeCanvas([inside, overflow, placeholder]);
        const manager = new GroupManager(canvas);
        const members = manager.getMembers(group);

        expect(members).toEqual([inside]);
        expect(GroupManager.contains(group, inside)).toBe(true);
        expect(GroupManager.contains(group, overflow)).toBe(false);
    });

    test('CONTAIN_EPS 容差吸收浮点误差', () => {
        const group = { x: 0, y: 0, width: 500, height: 400 };
        const obj = { x: 0.3, y: 0, width: 499.4, height: 399.8, source: 'save' };
        expect(GroupManager.contains(group, obj)).toBe(true);
    });
});

describe('hitGroupTitle（标题栏命中）', () => {
    function makeHitCanvas(groups, scale = 1) {
        return { viewport: { scale }, groups: { groups } };
    }

    test('命中标题栏区域（组顶部 ns 比例高度内）', () => {
        const g = { id: 'g1', x: 100, y: 100, width: 400, height: 300 };
        const th = GroupManager.getTitleMetrics(g).height;   // 48 × 300/512 ≈ 28 → 兜底 32
        const canvas = makeHitCanvas([g]);
        expect(th).toBe(32);
        expect(GroupManager.hitGroupTitle(canvas, 150, 110)).toBe(g);
        expect(GroupManager.hitGroupTitle(canvas, 100, 100 + th)).toBe(g);
    });

    test('组体内部与组外不命中', () => {
        const g = { id: 'g1', x: 100, y: 100, width: 400, height: 300 };
        const canvas = makeHitCanvas([g]);
        expect(GroupManager.hitGroupTitle(canvas, 300, 200)).toBeNull();   // 组体中部
        expect(GroupManager.hitGroupTitle(canvas, 300, 99)).toBeNull();    // 组上方
    });

    test('标题高度随组尺寸 ns 缩放（与节点标题栏同款）', () => {
        // 节点量级组（2048×1800）：ns = 1800/512 = 3.52 → 高 ≈ 169
        const big = { id: 'g1', x: 0, y: 0, width: 2048, height: 1800 };
        expect(GroupManager.getTitleMetrics(big).height).toBeCloseTo(48 * 1800 / 512);
        // 标题高度只取决于组本身，与视口缩放无关（世界坐标体系）
        const canvas = makeHitCanvas([big], 0.15);
        const th = GroupManager.getTitleMetrics(big).height;
        expect(GroupManager.hitGroupTitle(canvas, 1000, th * 0.9)).toBe(big);
        expect(GroupManager.hitGroupTitle(canvas, 1000, th + 10)).toBeNull();
    });

    test('重叠组从最上层（数组末尾）往下命中', () => {
        const bottom = { id: 'g1', x: 0, y: 0, width: 400, height: 300 };
        const top = { id: 'g2', x: 0, y: 0, width: 400, height: 300 };
        const canvas = makeHitCanvas([bottom, top]);
        expect(GroupManager.hitGroupTitle(canvas, 50, 10).id).toBe('g2');
    });
});

describe('getEdgeHandleRects / hitGroupEdgeHandle（边缘手柄）', () => {
    test('四边手柄以边中点为中心，尺寸按视口缩放反补偿', () => {
        const g = { x: 100, y: 100, width: 400, height: 300 };
        const rects = GroupManager.getEdgeHandleRects(g, 1);
        expect(rects.map(r => r.name)).toEqual(['n', 's', 'w', 'e']);

        const n = rects[0], s = rects[1], w = rects[2], e = rects[3];
        // 上/下手柄水平居中于组
        expect(n.x + n.w / 2).toBeCloseTo(g.x + g.width / 2);
        expect(s.y + s.h / 2).toBeCloseTo(g.y + g.height);
        // 左/右手柄垂直居中于组
        expect(w.y + w.h / 2).toBeCloseTo(g.y + g.height / 2);
        expect(e.x + e.w / 2).toBeCloseTo(g.x + g.width);

        // 缩放 2 倍视口：手柄世界尺寸减半（屏幕恒定）
        const half = GroupManager.getEdgeHandleRects(g, 2);
        expect(half[0].w).toBeCloseTo(n.w / 2);
    });

    test('仅单选组时可命中手柄，命中区含容差', () => {
        const g = { id: 'g1', x: 100, y: 100, width: 400, height: 300, selected: true };
        const canvas = {
            viewport: { scale: 1 },
            groups: {
                groups: [g],
                selectedIds: new Set(['g1']),
                getSelected: () => [g]
            }
        };

        // 上边中点手柄（含容差范围内）
        const cx = g.x + g.width / 2;
        const hit = GroupManager.hitGroupEdgeHandle(canvas, cx, g.y + 2);
        expect(hit).toEqual({ group: g, handle: 'n' });

        // 多选状态不提供缩放
        canvas.groups.selectedIds = new Set(['g1', 'other']);
        expect(GroupManager.hitGroupEdgeHandle(canvas, cx, g.y)).toBeNull();
    });
});

describe('getGroupResizeCursor', () => {
    test('上下为 ns-resize，左右为 ew-resize', () => {
        expect(GroupManager.getGroupResizeCursor('n')).toBe('ns-resize');
        expect(GroupManager.getGroupResizeCursor('s')).toBe('ns-resize');
        expect(GroupManager.getGroupResizeCursor('w')).toBe('ew-resize');
        expect(GroupManager.getGroupResizeCursor('e')).toBe('ew-resize');
    });
});

describe('NodeTypes 兼容性', () => {
    test('组不是图片也不是面板节点，通用谓词全部排除', () => {
        const g = { source: 'group', img: null };
        expect(NodeTypes.isRealCanvasImage(g)).toBe(false);
        expect(NodeTypes.isPanelNode(g.source)).toBe(false);
        expect(NodeTypes.isPlaceholder(g.source)).toBe(false);
    });
});
