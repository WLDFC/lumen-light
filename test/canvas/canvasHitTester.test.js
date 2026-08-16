/**
 * ==========================================================================
 * CanvasHitTester 单元测试
 * 覆盖缩放控制点命中、端口圆点命中、光标决策等纯几何判定。
 * 被测文件是浏览器端经典脚本（顶层 const/class 依赖全局词法作用域，
 * require() 会把它们变成模块私有），这里用 vm 模块在同一个上下文中
 * 按浏览器加载顺序执行源码，模拟 script 标签的加载行为。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {} };
vm.createContext(context);

[
    '../../js/config.js',
    '../../js/utils/NodeTypes.js',
    '../../js/canvas/CanvasRenderer.js',
    '../../js/canvas/CanvasConnections.js',
    '../../js/canvas/CanvasHitTester.js'
].forEach((file) => {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf-8');
    vm.runInContext(source, context, { filename: file });
});

const CanvasHitTester = context.window.CanvasHitTester;
const CanvasConnections = context.window.CanvasConnections;

/** 构造测试用画布对象（只含命中检测所需的字段） */
function makeCanvas(images, selected, scale = 1) {
    const selectedSet = new Set(selected.map((o) => o.id));
    return {
        canvas: { style: {} },
        viewport: { scale },
        images: {
            images,
            selectedIds: selectedSet,
            getSelected() {
                return images.filter((i) => selectedSet.has(i.id));
            }
        },
        isPanning: false,
        isResizing: false,
        resizeHandle: 'se'
    };
}

describe('getResizeCursor', () => {
    test('nw/se 为主对角线，ne/sw 为副对角线', () => {
        expect(CanvasHitTester.getResizeCursor('nw')).toBe('nwse-resize');
        expect(CanvasHitTester.getResizeCursor('se')).toBe('nwse-resize');
        expect(CanvasHitTester.getResizeCursor('ne')).toBe('nesw-resize');
        expect(CanvasHitTester.getResizeCursor('sw')).toBe('nesw-resize');
    });
});

describe('hitResizeHandle', () => {
    const img = { id: 'a', source: 'image', x: 1000, y: 1000, width: 2000, height: 2000 };

    test('单选时命中左上控制点（nw）', () => {
        const canvas = makeCanvas([img], [img], 1);
        expect(CanvasHitTester.hitResizeHandle(canvas, 1000, 1000)).toEqual({ img, handle: 'nw' });
    });

    test('命中右下控制点（se）', () => {
        const canvas = makeCanvas([img], [img], 1);
        expect(CanvasHitTester.hitResizeHandle(canvas, 3000, 3000)).toEqual({ img, handle: 'se' });
    });

    test('图片中心不命中任何控制点', () => {
        const canvas = makeCanvas([img], [img], 1);
        expect(CanvasHitTester.hitResizeHandle(canvas, 2000, 2000)).toBeNull();
    });

    test('多选时禁用缩放命中', () => {
        const img2 = { ...img, id: 'b', x: 5000, y: 5000 };
        const canvas = makeCanvas([img, img2], [img, img2], 1);
        expect(CanvasHitTester.hitResizeHandle(canvas, 1000, 1000)).toBeNull();
    });

    test('未选中时返回 null', () => {
        const canvas = makeCanvas([img], [], 1);
        expect(CanvasHitTester.hitResizeHandle(canvas, 1000, 1000)).toBeNull();
    });

    test('生成占位图不可缩放', () => {
        const ph = { ...img, source: 'generation-placeholder' };
        const canvas = makeCanvas([ph], [ph], 1);
        expect(CanvasHitTester.hitResizeHandle(canvas, 1000, 1000)).toBeNull();
    });

    test('图片屏幕尺寸过小时禁用命中（避免控制点盖满整图无法拖动）', () => {
        // scale 0.001 时屏幕尺寸 2000×0.001 = 2px，小于控制点直径的 3 倍
        const canvas = makeCanvas([img], [img], 0.001);
        expect(CanvasHitTester.hitResizeHandle(canvas, 1000, 1000)).toBeNull();
    });
});

describe('hitConnectionDot', () => {
    const img = { id: 'a', source: 'image', x: 1000, y: 1000, width: 2000, height: 2000 };

    test('命中左侧输入端口（in）', () => {
        const pt = CanvasConnections.getPortPoint(img, 'in', 1);
        const canvas = makeCanvas([img], [], 1);
        expect(CanvasHitTester.hitConnectionDot(canvas, pt.x, pt.y)).toEqual({ img, side: 'in' });
    });

    test('命中右侧输出端口（out）', () => {
        const pt = CanvasConnections.getPortPoint(img, 'out', 1);
        const canvas = makeCanvas([img], [], 1);
        expect(CanvasHitTester.hitConnectionDot(canvas, pt.x, pt.y)).toEqual({ img, side: 'out' });
    });

    test('远离端口时不命中', () => {
        const canvas = makeCanvas([img], [], 1);
        expect(CanvasHitTester.hitConnectionDot(canvas, 2000, 2000)).toBeNull();
    });

    test('提示词节点与占位图不参与端口命中', () => {
        const node = { id: 'n', source: 'prompt-node', x: 1000, y: 1000, width: 2000, height: 2000 };
        const ph = { id: 'p', source: 'generation-placeholder', x: 6000, y: 1000, width: 2000, height: 2000 };
        const canvas = makeCanvas([node, ph], [], 1);
        // 即使坐标落在节点左缘中点（普通图片的输入端口位置）也返回 null，
        // 节点端口由 DOM 圆点自带的事件转发处理，canvas 层不参与
        expect(CanvasHitTester.hitConnectionDot(canvas, 990, 2000)).toBeNull();
        expect(CanvasHitTester.hitConnectionDot(canvas, 8010, 2000)).toBeNull();
    });

    test('多张图片重叠时优先命中上层（数组靠后）图片的端口', () => {
        const lower = { id: 'lower', source: 'image', x: 1000, y: 1000, width: 2000, height: 2000 };
        const upper = { id: 'upper', source: 'image', x: 1000, y: 1000, width: 2000, height: 2000 };
        const canvas = makeCanvas([lower, upper], [], 1);
        const pt = CanvasConnections.getPortPoint(upper, 'in', 1);
        expect(CanvasHitTester.hitConnectionDot(canvas, pt.x, pt.y).img.id).toBe('upper');
    });
});
