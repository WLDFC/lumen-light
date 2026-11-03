/**
 * ==========================================================================
 * 形状几何共享纯函数层（ADR 069，TextLayout.js 同款约定——两编辑器共用勿复制）：
 * 形状 = 属性驱动的解析图形（rect/round/ellipse/bubble），本层承载类型表、
 * 气泡尾巴几何、路径构建、画布外伸计算与统一绘制原语。零 DOM 依赖
 * （Path2D 由运行环境全局提供，vm 测试注入桩），Jest 可单测。
 * 消费方：StudioShapeTool（灯箱，paintCv 位图管线 + 属性烘焙）与
 * MangaShape（漫画编辑器，舞台/页缩略图/面板缩略图矢量现画）。
 * 属性 schema（layer.shape）：type('rect'|'round'|'ellipse'|'bubble') /
 *   w / h / fill(CSS 色 | 'none'=透明) / strokeColor / strokeWidth(0=无边框) /
 *   radius(仅矩形类) / tail('rb'|'lb'|'lt'|'rt'，仅气泡)。
 * ==========================================================================
 */

const ShapeLayout = {
    /** 气泡尾巴方位 → 尾巴指向角（度，y 向下坐标系：45=右下 135=左下
     *  225=左上 315=右上） */
    TAIL_DEG: { rb: 45, lb: 135, lt: 225, rt: 315 },

    /** 形状类型 → 图层名（创建提交时命名） */
    TYPE_NAME: { rect: '矩形', round: '圆角矩形', ellipse: '椭圆', bubble: '气泡框' },

    /** 左右翻转用的尾巴方位映射（气泡是唯一左右不对称的形状——
     *  尾巴换到镜像侧，其余形状左右对称，重渲染结果不变） */
    MIRROR_TAIL: { rb: 'lb', lb: 'rb', rt: 'lt', lt: 'rt' },
    // 旋转换位表：90° 顺时针（右→下→左→上，角落 rb→lb→lt→rt 循环）
    // 与 180°（对角互换）。供灯箱 rotateActiveLayer 旋转气泡尾巴方位用
    ROT_TAIL_CW: { rb: 'lb', lb: 'lt', lt: 'rt', rt: 'rb' },
    ROT_TAIL_180: { rb: 'lt', lt: 'rb', lb: 'rt', rt: 'lb' },

    /**
     * 气泡尾巴几何（包围盒坐标，0..w / 0..h）。数值来自参考图逐像素实测
     * （气泡 305×143，根部夹角约 12°、尾长约 0.33×短边、尖端沿椭圆法线
     * 略回摆 8°）：
     *   aM  尾巴中心角（椭圆参数角，TAIL_DEG 直接复用）
     *   aA  外侧根点（aM+half）  aB  内侧根点（aM−half）
     *   T   尖端：从 aM 处椭圆点沿「该点外法线（回摆 8°）」伸出 L
     *   cOut 外边控制点（尖端→根A 微外鼓）
     * @returns {{A:number[], B:number[], T:number[], cOut:number[],
     *            aA:number, aB:number, aM:number, half:number, L:number}}
     */
    bubbleGeom(w, h, tail) {
        const cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2;
        const aM = ((ShapeLayout.TAIL_DEG[tail] ?? 135) * Math.PI) / 180;
        const half = (6 * Math.PI) / 180;          // 根部半张角 6°（实测窄口）
        const L = Math.min(w, h) * 0.33;           // 尾长 0.33×短边（实测）
        const lean = (-8 * Math.PI) / 180;         // 相对法线回摆 8°（实测）
        const pt = (a) => [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
        const aA = aM + half;
        const aB = aM - half;
        const A = pt(aA);
        const B = pt(aB);
        // 椭圆在 aM 处的外法线：(cos a / rx, sin a / ry) 归一化，再回摆 lean
        const nx0 = Math.cos(aM) / rx;
        const ny0 = Math.sin(aM) / ry;
        const nl = Math.hypot(nx0, ny0) || 1;
        const ux = nx0 / nl;
        const uy = ny0 / nl;
        const nx = ux * Math.cos(lean) - uy * Math.sin(lean);
        const ny = ux * Math.sin(lean) + uy * Math.cos(lean);
        const M = pt(aM);
        const T = [M[0] + nx * L, M[1] + ny * L];
        // 外边（尖端→根A）控制点：中点再沿法线外推 10% 尾长，轻微外鼓
        const cOut = [
            (T[0] + A[0]) / 2 + nx * L * 0.1,
            (T[1] + A[1]) / 2 + ny * L * 0.1
        ];
        return { A, B, T, cOut, aA, aB, aM, half, L };
    },

    /**
     * 画布外伸量：形状包围盒四周 = 描边余量 + 1px 防裁切；气泡框按尾巴
     * 实际顶点（根 A/B、尖端 T、外边控制点）超出包围盒的量外伸。
     * 气泡的尖角用 miter 连接，外刺最长约 2.2×描边宽，余量按此放大
     * （余量不足尾巴尖会被裁掉——曾因此渲染出"缺尖的尾巴"）
     * @returns {{left:number, top:number, right:number, bottom:number}}
     */
    extFor(s, w, h) {
        const sw = Math.max(0, Number(s.strokeWidth) || 0);
        const isBubble = s.type === 'bubble';
        const m = (isBubble ? Math.ceil(sw * 2.3) : Math.ceil(sw / 2)) + 1;
        let l = m; let t = m; let r = m; let b = m;
        if (isBubble) {
            const g = ShapeLayout.bubbleGeom(w, h, s.tail);
            const xs = [g.A[0], g.B[0], g.T[0], g.cOut[0]];
            const ys = [g.A[1], g.B[1], g.T[1], g.cOut[1]];
            l += Math.ceil(Math.max(0, -Math.min(...xs)));
            t += Math.ceil(Math.max(0, -Math.min(...ys)));
            r += Math.ceil(Math.max(0, Math.max(...xs) - w));
            b += Math.ceil(Math.max(0, Math.max(...ys) - h));
        }
        return { left: l, top: t, right: r, bottom: b };
    },

    /** 按类型构建形状路径（坐标 = 包围盒左上角 x,y 与宽高 w,h；
     *  p 由调用方提供（浏览器 Path2D / 测试录制桩） */
    buildPath(p, x, y, w, h, s) {
        if (s.type === 'ellipse') {
            p.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
            return;
        }
        if (s.type === 'bubble') {
            ShapeLayout.bubblePath(p, x, y, w, h, s.tail);
            return;
        }
        const r = Math.min(s.radius || 0, w / 2, h / 2);
        if (r > 0) {
            // 圆角矩形（arcTo 四角；r 已钳制到宽高一半以内）
            p.moveTo(x + r, y);
            p.arcTo(x + w, y, x + w, y + h, r);
            p.arcTo(x + w, y + h, x, y + h, r);
            p.arcTo(x, y + h, x, y, r);
            p.arcTo(x, y, x + w, y, r);
            p.closePath();
        } else {
            p.rect(x, y, w, h);
        }
    },

    /**
     * 气泡框路径：椭圆长弧（挖掉尾部窄口）+ 尖角尾巴，单一路径闭合——
     * 填充与描边一次完成，交界不断线。尾巴几何见 bubbleGeom：
     *   弧：根A（aM+6°）沿 a 增方向绕一圈到根B（aM−6°）
     *   内边：根B → 尖端 直线（根部形成锐利缺口）
     *   外边：尖端 → 根A 二次曲线（微外鼓）
     */
    bubblePath(p, x, y, w, h, tail) {
        const g = ShapeLayout.bubbleGeom(w, h, tail);
        const cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2;
        const sweep = Math.PI * 2 - g.half * 2;    // 长弧（窄口由尾巴补上）
        const steps = 64;
        const px = (a) => x + cx + rx * Math.cos(a);
        const py = (a) => y + cy + ry * Math.sin(a);
        p.moveTo(px(g.aA), py(g.aA));
        for (let i = 1; i <= steps; i++) {
            const a = g.aA + (sweep * i) / steps;
            p.lineTo(px(a), py(a));
        }
        // 弧终点即根B：内边直线到尖端
        p.lineTo(x + g.T[0], y + g.T[1]);
        // 外边由尖端回到根A（控制点微外鼓）
        p.quadraticCurveTo(x + g.cOut[0], y + g.cOut[1], x + g.A[0], y + g.A[1]);
        p.closePath();
    },

    /**
     * 统一绘制原语：线型策略 + 建路径 + 填充/描边。气泡的尾巴尖与根部
     * 缺口需要锐利折角：miter 连接（round 会把尖角磨圆），miterLimit 6
     * 让 26° 左右的尖角不被切平；其余类型 round。填充 'none'=透明（只要
     * 边框）；描边宽 0=无边框。不清理画布、不做变换——清底与
     * translate/scale 由调用方负责（三处复用：舞台/页缩略图/面板缩略图）。
     */
    drawShapeContent(g, s, x, y, w, h) {
        g.lineJoin = s.type === 'bubble' ? 'miter' : 'round';
        g.miterLimit = 6;
        g.lineCap = 'round';
        const p = new Path2D();
        ShapeLayout.buildPath(p, x, y, w, h, s);
        const sw = Math.max(0, Number(s.strokeWidth) || 0);
        if (s.fill !== 'none' && s.fill) {
            g.fillStyle = s.fill;
            g.fill(p);
        }
        if (sw > 0) {
            g.strokeStyle = s.strokeColor;
            g.lineWidth = sw;
            g.stroke(p);
        }
    }
};

// 暴露到全局作用域（经典 script；须先于两编辑器主类与混入加载，见 index.html）
window.ShapeLayout = ShapeLayout;
