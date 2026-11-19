/**
 * 形状几何共享纯函数层测试（ADR 069）：vm 装载 js/utils/ShapeLayout.js，
 * Path2D 用录制桩、绘图上下文用普通对象桩（属性直读+fill/stroke 探针）
 * ——数值断言全部可离线复算（bubbleGeom 的三角函数值按定义手工核算）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {} };
// Path2D 录制桩：drawShapeContent 内部 new Path2D()，方法调用记录进 calls
context.Path2D = class {
    constructor() { this.calls = []; }
    moveTo(...a) { this.calls.push(['moveTo', ...a]); }
    lineTo(...a) { this.calls.push(['lineTo', ...a]); }
    arcTo(...a) { this.calls.push(['arcTo', ...a]); }
    rect(...a) { this.calls.push(['rect', ...a]); }
    ellipse(...a) { this.calls.push(['ellipse', ...a]); }
    quadraticCurveTo(...a) { this.calls.push(['quadraticCurveTo', ...a]); }
    closePath(...a) { this.calls.push(['closePath', ...a]); }
};
vm.createContext(context);
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/utils/ShapeLayout.js'), 'utf-8'),
    context, { filename: 'ShapeLayout.js' });
const ShapeLayout = context.window.ShapeLayout;

/** 绘图上下文桩：属性直读、fill/stroke 调用记进 _ops 供断言 */
function makeG() {
    const ops = [];
    return {
        _ops: ops,
        fill() { ops.push('fill'); },
        stroke() { ops.push('stroke'); }
    };
}

describe('ShapeLayout 类型与映射表（ADR 069）', () => {
    test('TAIL_DEG/TYPE_NAME 全量在册', () => {
        expect(ShapeLayout.TAIL_DEG).toEqual({ rb: 45, lb: 135, lt: 225, rt: 315 });
        expect(ShapeLayout.TYPE_NAME).toEqual({
            rect: '矩形', round: '圆角矩形', ellipse: '椭圆', bubble: '气泡框', poly: '多边形'
        });
    });
    test('MIRROR_TAIL 对合（翻转两次还原）；旋转换位成环', () => {
        for (const k of Object.keys(ShapeLayout.MIRROR_TAIL)) {
            expect(ShapeLayout.MIRROR_TAIL[ShapeLayout.MIRROR_TAIL[k]]).toBe(k);
        }
        // 90° 顺时针四步成环：rb→lb→lt→rt→rb；180° 两步成环
        let cur = 'rb';
        for (let i = 0; i < 4; i++) cur = ShapeLayout.ROT_TAIL_CW[cur];
        expect(cur).toBe('rb');
        expect(ShapeLayout.ROT_TAIL_180[ShapeLayout.ROT_TAIL_180.rb]).toBe('rb');
    });
});

describe('ShapeLayout.bubbleGeom（气泡尾巴几何）', () => {
    test('lb 尾巴：中心角/根点/尖端按椭圆定义可复算，尖端出界', () => {
        const g = ShapeLayout.bubbleGeom(100, 100, 'lb');
        expect(g.L).toBeCloseTo(33, 10);                       // 尾长 0.33×短边
        // aM=135°，椭圆点 M=(50+50cos135°, 50+50sin135°)
        expect(g.aM).toBeCloseTo((135 * Math.PI) / 180, 12);
        expect(g.M).toBeUndefined;                             // M 不在返回值里（返回 A/B/T/cOut）
        expect(g.A[0]).toBeCloseTo(50 + 50 * Math.cos((141 * Math.PI) / 180), 6);
        expect(g.A[1]).toBeCloseTo(50 + 50 * Math.sin((141 * Math.PI) / 180), 6);
        expect(g.B[0]).toBeCloseTo(50 + 50 * Math.cos((129 * Math.PI) / 180), 6);
        // 尖端 T 沿法线（回摆 8° → 127°）伸出 L：出包围盒（左/下）
        const tx = 50 + 50 * Math.cos((135 * Math.PI) / 180) + 33 * Math.cos((127 * Math.PI) / 180);
        const ty = 50 + 50 * Math.sin((135 * Math.PI) / 180) + 33 * Math.sin((127 * Math.PI) / 180);
        expect(g.T[0]).toBeCloseTo(tx, 6);
        expect(g.T[1]).toBeCloseTo(ty, 6);
        expect(g.T[0]).toBeLessThan(0);
        expect(g.T[1]).toBeGreaterThan(100);
    });
    test('未知尾巴方位回落 lb（135°）', () => {
        expect(ShapeLayout.bubbleGeom(100, 100, 'xx').aM)
            .toBe(ShapeLayout.bubbleGeom(100, 100, 'lb').aM);
    });
});

describe('ShapeLayout.extFor（画布外伸）', () => {
    test('矩形：四周 = ceil(描边/2)+1，与尾巴无关', () => {
        expect(ShapeLayout.extFor({ type: 'rect', strokeWidth: 6 }, 100, 60))
            .toEqual({ left: 4, top: 4, right: 4, bottom: 4 });
        expect(ShapeLayout.extFor({ type: 'rect', strokeWidth: 0 }, 100, 60))
            .toEqual({ left: 1, top: 1, right: 1, bottom: 1 });
    });
    test('气泡：基础余量放大到 2.3×描边，尾巴出界侧再加量', () => {
        const e = ShapeLayout.extFor({ type: 'bubble', strokeWidth: 6, tail: 'lb' }, 100, 100);
        expect(e.top).toBe(15);      // ceil(6×2.3)+1，上/右无尾巴出界
        expect(e.right).toBe(15);
        expect(e.left).toBeGreaterThan(15);    // T.x<0（lb 尖端出左界）
        expect(e.bottom).toBeGreaterThan(15);  // T.y>100（出下界）
    });
});

describe('ShapeLayout.buildPath（按类型构建路径）', () => {
    test('rect：radius 缺省=单条 rect 指令（radius>0 也走圆角分支，圆角归属性在调用方默认值）', () => {
        const p = new context.Path2D();
        ShapeLayout.buildPath(p, 0, 0, 100, 60, { type: 'rect' });
        expect(p.calls).toEqual([['rect', 0, 0, 100, 60]]);
    });
    test('round：arcTo 四角 + closePath，r 钳到宽高一半', () => {
        const p = new context.Path2D();
        ShapeLayout.buildPath(p, 0, 0, 100, 60, { type: 'round', radius: 24 });
        expect(p.calls[0]).toEqual(['moveTo', 24, 0]);
        expect(p.calls.filter((c) => c[0] === 'arcTo')).toHaveLength(4);
        expect(p.calls[p.calls.length - 1][0]).toBe('closePath');
    });
    test('round 半径钳制精确值：min(radius, w/2, h/2)', () => {
        const p = new context.Path2D();
        ShapeLayout.buildPath(p, 0, 0, 100, 60, { type: 'round', radius: 999 });
        expect(p.calls[0]).toEqual(['moveTo', 30, 0]);
    });
    test('ellipse：解析椭圆', () => {
        const p = new context.Path2D();
        ShapeLayout.buildPath(p, 10, 20, 100, 60, { type: 'ellipse' });
        expect(p.calls).toEqual([['ellipse', 60, 50, 50, 30, 0, 0, Math.PI * 2]]);
    });
    test('bubble：长弧 64 段折线 + 尖端直线 + 外边二次曲线，单一路径闭合', () => {
        const p = new context.Path2D();
        ShapeLayout.buildPath(p, 0, 0, 100, 100, { type: 'bubble', tail: 'lb' });
        expect(p.calls[0][0]).toBe('moveTo');
        expect(p.calls.filter((c) => c[0] === 'lineTo')).toHaveLength(65);   // 64 弧段+1 尖端
        expect(p.calls.filter((c) => c[0] === 'quadraticCurveTo')).toHaveLength(1);
        expect(p.calls[p.calls.length - 1][0]).toBe('closePath');
    });
    test('poly：radius 0 走直线折线（与旧渲染一致）；radius>0 委托 polyPath 圆角', () => {
        const straight = new context.Path2D();
        ShapeLayout.buildPath(straight, 0, 0, 100, 100, {
            type: 'poly', points: [[0, 0], [100, 0], [100, 100]]
        });
        expect(straight.calls).toEqual([
            ['moveTo', 0, 0], ['lineTo', 100, 0], ['lineTo', 100, 100], ['closePath']
        ]);
        const rounded = new context.Path2D();
        ShapeLayout.buildPath(rounded, 0, 0, 100, 100, {
            type: 'poly', points: [[0, 0], [100, 0], [100, 100]], radius: 10
        });
        expect(rounded.calls.filter((c) => c[0] === 'arcTo')).toHaveLength(3);
    });
});

describe('ShapeLayout.polyPath（多边形顶点圆角过渡，2026-11-11）', () => {
    const SQUARE = { type: 'poly', points: [[0, 0], [100, 0], [100, 100], [0, 100]] };
    // 浮点容差归一：tan(π/4) 双精度 ≠1 会让切点带 1e-15 尾差，按 6 位取整
    const fx = (calls) => calls.map((c) => c.map((v) => typeof v === 'number' ? Number(v.toFixed(6)) : v));

    test('正方形 r=10：每角切点距角 r，arcTo 真圆弧', () => {
        const p = new context.Path2D();
        ShapeLayout.polyPath(p, 0, 0, { ...SQUARE, radius: 10 });
        // 直角 t=r/tan(45°)=10；起点=角0入切点（末边 x=0 上），closePath 补末边
        expect(fx(p.calls)).toEqual([
            ['moveTo', 0, 10],
            ['arcTo', 0, 0, 10, 0, 10],
            ['arcTo', 100, 0, 100, 10, 10],
            ['arcTo', 100, 100, 90, 100, 10],
            ['arcTo', 0, 100, 0, 90, 10],
            ['closePath']
        ]);
    });

    test('锐角钳制：等边三角形 r=60 → 切线长钳半边 50，有效半径回代', () => {
        const p = new context.Path2D();
        ShapeLayout.polyPath(p, 0, 0, {
            type: 'poly', points: [[0, 0], [100, 0], [50, 50 * Math.sqrt(3)]], radius: 60
        });
        const arcs = p.calls.filter((c) => c[0] === 'arcTo');
        expect(p.calls.filter((c) => c[0] === 'moveTo')).toHaveLength(1);
        // 60° 角 t=60/tan(30°)≈103.9 > 50 → 钳 50；rEff=50·tan(30°)≈28.87
        expect(arcs[0][5]).toBeCloseTo(50 * Math.tan(Math.PI / 6), 1);
        // 角 0 (0,0) 的出切点在朝 (100,0) 边上距角 50
        expect(arcs[0][1]).toBeCloseTo(0, 6);
        expect(arcs[0][2]).toBeCloseTo(0, 6);
        expect(arcs[0][3]).toBeCloseTo(50, 6);
        expect(arcs[0][4]).toBeCloseTo(0, 6);
    });

    test('退化角：共线角直连不圆角，其余角照常 arcTo', () => {
        const p = new context.Path2D();
        ShapeLayout.polyPath(p, 0, 0, {
            type: 'poly',
            points: [[0, 0], [50, 0], [100, 0], [100, 100]],   // (50,0) 处三点共线
            radius: 8
        });
        expect(p.calls.map((c) => c[0])).toEqual(
            ['moveTo', 'arcTo', 'lineTo', 'arcTo', 'arcTo', 'closePath']);
    });

    test('偏移包围盒原点：切点坐标带 x,y 平移', () => {
        const p = new context.Path2D();
        ShapeLayout.polyPath(p, 10, 20, { ...SQUARE, radius: 10 });
        expect(fx(p.calls)[0]).toEqual(['moveTo', 10, 30]);            // (0,10)+(10,20)
        expect(fx(p.calls)[1]).toEqual(['arcTo', 10, 20, 20, 20, 10]); // 角 (0,0) 平移
    });
});

describe('ShapeLayout.drawShapeContent（统一绘制原语）', () => {
    test('rect：round 线型 + 填充描边，线宽/颜色落上下文', () => {
        const g = makeG();
        ShapeLayout.drawShapeContent(g, {
            type: 'rect', fill: '#ffffff', strokeColor: '#000000', strokeWidth: 6
        }, 0, 0, 100, 60);
        expect(g.lineJoin).toBe('round');
        expect(g.miterLimit).toBe(6);
        expect(g.fillStyle).toBe('#ffffff');
        expect(g.strokeStyle).toBe('#000000');
        expect(g.lineWidth).toBe(6);
        expect(g._ops).toContain('fill');
        expect(g._ops).toContain('stroke');
    });
    test('bubble：miter 线型保尖角', () => {
        const g = makeG();
        ShapeLayout.drawShapeContent(g, {
            type: 'bubble', tail: 'lb', fill: '#fff', strokeColor: '#000', strokeWidth: 4
        }, 0, 0, 100, 100);
        expect(g.lineJoin).toBe('miter');
    });
    test("fill 'none'=透明只要边框；strokeWidth 0=无边框", () => {
        const g = makeG();
        ShapeLayout.drawShapeContent(g, {
            type: 'rect', fill: 'none', strokeColor: '#000', strokeWidth: 4
        }, 0, 0, 50, 50);
        expect(g._ops).not.toContain('fill');
        expect(g._ops).toContain('stroke');
        expect(g.fillStyle).toBeUndefined();
        const g2 = makeG();
        ShapeLayout.drawShapeContent(g2, {
            type: 'rect', fill: '#fff', strokeColor: '#000', strokeWidth: 0
        }, 0, 0, 50, 50);
        expect(g2._ops).toContain('fill');
        expect(g2._ops).not.toContain('stroke');
        expect(g2.lineWidth).toBeUndefined();
    });
});
