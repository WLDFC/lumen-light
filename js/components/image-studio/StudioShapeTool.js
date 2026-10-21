/**
 * ==========================================================================
 * ImageStudio 子模块：形状工具（矩形/圆角矩形/椭圆/气泡框）
 * 作用：形状层 = 属性驱动的普通图层（文字工具同构）——形状按属性（类型/
 *       宽高/填充/描边色/描边宽/圆角/尾巴方位）渲染进图层自己的 paintCv，
 *       移动/缩放/透明度/删除/保存拍平全部复用现有图层管线。可再编辑性
 *       靠形状属性随 studioLayers 序列化（StudioSave 落盘、open 恢复时
 *       按属性重渲染），形状工具下点击形状层即选中并同步顶栏属性。
 * 不做矢量路径：矩形/椭圆是解析图形，参数即"路径"——图层被移动工具
 *       缩放后按属性重渲染（ImageStudio._bakeShapeScale 在缩放提交时
 *       把 tscale 烘焙回形状宽高），永远锐利，无需矢量引擎。
 * 交互：拖拽创建（Shift 约束正方/正圆）；点击已有形状层 = 选中并同步
 *       顶栏属性；干点（位移过小）= 取消刚建的层。气泡框 = 椭圆长弧 +
 *       细长尖角尾巴（窄根 12°、尾长 0.33×短边、沿椭圆法线伸出、直边
 *       内侧 + 微凸外边、miter 锐角）连成单一路径（填充描边不断线），
 *       尾巴方位四选一。尾巴几何数值来自参考图逐像素实测，见 _bubbleGeom。
 * 契约：构造时传入宿主 ImageStudio 实例并读写其字段与方法；主类保留
 *       同名薄代理（_onShapeDown/_bakeShapeScale）。
 * ==========================================================================
 */

class StudioShapeTool {
    /** 气泡尾巴方位 → 尾巴指向角（度，y 向下坐标系：45=右下 135=左下
     *  225=左上 315=右上） */
    static TAIL_DEG = { rb: 45, lb: 135, lt: 225, rt: 315 };

    /** 形状类型 → 图层名（创建提交时命名） */
    static TYPE_NAME = { rect: '矩形', round: '圆角矩形', ellipse: '椭圆', bubble: '气泡框' };

    /** 左右翻转用的尾巴方位映射（气泡是唯一左右不对称的形状——
     *  尾巴换到镜像侧，其余形状左右对称，重渲染结果不变） */
    static MIRROR_TAIL = { rb: 'lb', lb: 'rb', rt: 'lt', lt: 'rt' };
    // 旋转换位表：90° 顺时针（右→下→左→上，角落 rb→lb→lt→rt 循环）
    // 与 180°（对角互换）。供 rotateActiveLayer 旋转气泡尾巴方位用
    static ROT_TAIL_CW = { rb: 'lb', lb: 'lt', lt: 'rt', rt: 'rb' };
    static ROT_TAIL_180 = { rb: 'lt', lt: 'rb', lb: 'rt', rt: 'lb' };

    constructor(studio) {
        this.studio = studio;
        this.drag = null;   // 拖拽创建态 { layer, startX, startY }
    }

    // ==================== 输入路由（主类 _onPaintDown 转发） ====================

    /** 形状工具按下：命中形状层 → 选中并同步顶栏属性（再编辑）；
     *  空白处 → 开始拖拽创建（即时建层，拖动中实时改属性重渲染） */
    _onShapeDown(e) {
        const studio = this.studio;
        if (!studio._readyDone) return;
        e.preventDefault();
        const pos = studio._toImagePos(e);
        const hit = this._hitShapeLayerAt(pos);
        if (hit) {
            studio._setActive(hit.id);
            this._syncOptsFromLayer(hit);
            studio._drawSelOverlay();
            return;
        }
        const layer = studio.addShapeLayer(pos);
        studio.paintSurface.setPointerCapture(e.pointerId);
        this.drag = { layer, startX: pos.x, startY: pos.y };
        studio._drawSelOverlay();
    }

    /** 拖拽中：更新形状宽高与图层位置并重渲染（解析图形渲染零成本，
     *  所见即所得）；Shift 约束正方/正圆 */
    dragMove(e) {
        if (!this.drag) return;
        const studio = this.studio;
        const pos = studio._toImagePos(e);
        const d = this.drag;
        let w = Math.abs(pos.x - d.startX);
        let h = Math.abs(pos.y - d.startY);
        if (e.shiftKey) {
            const m = Math.max(w, h);
            w = m; h = m;
        }
        const s = d.layer.shape;
        s.w = Math.max(2, w);
        s.h = Math.max(2, h);
        // tx/ty = 画布左上角文档坐标 = 拖拽包围盒左上角 − 该方向外伸；
        // 先预置 _shapeExt 再渲染，_render 的重定位（增量 = 0）不引入漂移
        const ext = StudioShapeTool._extFor(s, s.w, s.h);
        d.layer.tx = Math.min(pos.x, d.startX) - ext.left;
        d.layer.ty = Math.min(pos.y, d.startY) - ext.top;
        d.layer._shapeExt = ext;
        this._render(d.layer);
        studio._positionLayerCanvases(d.layer);
        studio._drawSelOverlay();
    }

    /** 拖拽提交：位移过小（干点）→ 静默删掉刚建的层（不推历史，图层
     *  从未入过历史）；正常提交 → 命名/置脏/历史/缩略图/面板同步 */
    dragUp() {
        const studio = this.studio;
        const d = this.drag;
        if (!d) return;
        this.drag = null;
        const layer = d.layer;
        if (layer.shape.w < 6 || layer.shape.h < 6) {
            // 干点取消：直接移除（不经 deleteActiveLayer——它推「删除图层」
            // 历史，而这层从未提交过，推历史只会刷出无效条目）
            const idx = studio.layers.indexOf(layer);
            if (idx > -1) studio.layers.splice(idx, 1);
            layer.paintCv.remove();
            layer.maskCv.remove();
            studio.activeLayerId = studio.layers[Math.min(idx, studio.layers.length - 1)].id;
            studio._drawSelOverlay();
            return;
        }
        layer.name = StudioShapeTool.TYPE_NAME[layer.shape.type] || '形状';
        this._render(layer);
        studio._positionLayerCanvases(layer);
        studio.dirty.layers = true;
        studio._refreshThumb(layer);
        studio._pushHistory('绘制形状');
        studio._renderLayerList();
        studio._syncPanels();
        studio._drawSelOverlay();
    }

    /** 自栈顶向下找第一个命中的可见形状层（形状层恒在图片层之上） */
    _hitShapeLayerAt(pos) {
        const studio = this.studio;
        for (let i = studio.layers.length - 1; i >= 2; i--) {
            const layer = studio.layers[i];
            if (!layer.isShape || !layer.visible || layer.empty) continue;
            const w = layer.paintCv.width * layer.tscale;
            const h = layer.paintCv.height * layer.tscale;
            if (pos.x >= layer.tx && pos.x <= layer.tx + w &&
                pos.y >= layer.ty && pos.y <= layer.ty + h) return layer;
        }
        return null;
    }

    // ==================== 顶栏选项实时应用 ====================

    /** 选项作用目标：当前选中的形状层（未选中时改动只更新 shapeOpts
     *  作为下次绘制的默认值，与文字工具同语义） */
    _targetLayer() {
        const active = this.studio._activeLayer();
        return active && active.isShape ? active : null;
    }

    /** 顶栏属性改动 → 选中形状层重渲染（未选中则只影响默认值） */
    applyOpts() {
        const studio = this.studio;
        const layer = this._targetLayer();
        const o = studio.shapeOpts;
        if (!layer) return;
        Object.assign(layer.shape, {
            type: o.type, fill: o.fill, strokeColor: o.strokeColor,
            strokeWidth: o.strokeWidth, radius: o.radius, tail: o.tail
        });
        this._render(layer);
        studio._positionLayerCanvases(layer);
        studio.dirty.layers = true;
        studio._refreshThumb(layer);
        studio._drawSelOverlay();
    }

    /** 选中已有形状层时反向同步：图层属性 → shapeOpts → 顶栏 DOM */
    _syncOptsFromLayer(layer) {
        const studio = this.studio;
        Object.assign(studio.shapeOpts, layer.shape);
        studio._syncShapeOptsDom?.();
    }

    // ==================== 形状渲染 ====================

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
    static _bubbleGeom(w, h, tail) {
        const cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2;
        const aM = ((StudioShapeTool.TAIL_DEG[tail] ?? 135) * Math.PI) / 180;
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
    }

    /**
     * 画布外伸量：形状包围盒四周 = 描边余量 + 1px 防裁切；气泡框按尾巴
     * 实际顶点（根 A/B、尖端 T、外边控制点）超出包围盒的量外伸。
     * 气泡的尖角用 miter 连接，外刺最长约 2.2×描边宽，余量按此放大
     * （余量不足尾巴尖会被裁掉——曾因此渲染出"缺尖的尾巴"）
     * @returns {{left:number, top:number, right:number, bottom:number}}
     */
    static _extFor(s, w, h) {
        const sw = Math.max(0, Number(s.strokeWidth) || 0);
        const isBubble = s.type === 'bubble';
        const m = (isBubble ? Math.ceil(sw * 2.3) : Math.ceil(sw / 2)) + 1;
        let l = m; let t = m; let r = m; let b = m;
        if (isBubble) {
            const g = StudioShapeTool._bubbleGeom(w, h, s.tail);
            const xs = [g.A[0], g.B[0], g.T[0], g.cOut[0]];
            const ys = [g.A[1], g.B[1], g.T[1], g.cOut[1]];
            l += Math.ceil(Math.max(0, -Math.min(...xs)));
            t += Math.ceil(Math.max(0, -Math.min(...ys)));
            r += Math.ceil(Math.max(0, Math.max(...xs) - w));
            b += Math.ceil(Math.max(0, Math.max(...ys) - h));
        }
        return { left: l, top: t, right: r, bottom: b };
    }

    /**
     * 把形状按属性渲染进图层画布。画布 = 形状包围盒 + 四向外伸（见
     * _extFor），layer.tx/ty 语义 = 画布左上角的文档坐标；外伸变化时
     * （尾巴换向/描边宽改/缩放烘焙）以包围盒为锚重定位——气泡本体
     * 在文档中纹丝不动，画布只向外伸方向扩。填充 'none' = 透明
     * （只要边框）；描边宽 0 = 无边框 */
    _render(layer) {
        const s = layer.shape;
        const w = Math.max(2, Math.round(s.w));
        const h = Math.max(2, Math.round(s.h));
        // 左右翻转：气泡尾巴方位水平镜像后再渲染（这类形状的左右不对称
        // 完全来自尾巴，换向后重算外伸，本体锚点由下方重定位保持不变；
        // 绘制面不再叠加 CSS 镜像，避免外伸不对称导致内容偏移/裁切）
        const eff = layer.flipX
            ? { ...s, tail: StudioShapeTool.MIRROR_TAIL[s.tail] || s.tail }
            : s;
        const ext = StudioShapeTool._extFor(eff, w, h);
        const prev = layer._shapeExt || { left: 0, top: 0 };
        layer.tx = (layer.tx || 0) + prev.left - ext.left;
        layer.ty = (layer.ty || 0) + prev.top - ext.top;
        layer._shapeExt = ext;
        const cv = layer.paintCv;
        cv.width = w + ext.left + ext.right;
        cv.height = h + ext.top + ext.bottom;
        const g = cv.getContext('2d');
        g.clearRect(0, 0, cv.width, cv.height);
        layer.empty = false;
        // 气泡的尾巴尖与根部缺口都需要锐利折角：用 miter 连接（round 会把
        // 尖角磨圆成小圆头）；miterLimit 放大到 6 让 26° 左右的尖角不被切平
        g.lineJoin = s.type === 'bubble' ? 'miter' : 'round';
        g.miterLimit = 6;
        g.lineCap = 'round';
        const p = new Path2D();
        this._buildPath(p, ext.left, ext.top, w, h, eff);
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

    /** 按类型构建形状路径（坐标 = 包围盒左上角 x,y 与宽高 w,h） */
    _buildPath(p, x, y, w, h, s) {
        if (s.type === 'ellipse') {
            p.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
            return;
        }
        if (s.type === 'bubble') {
            this._bubblePath(p, x, y, w, h, s.tail);
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
    }

    /**
     * 气泡框路径：椭圆长弧（挖掉尾部窄口）+ 尖角尾巴，单一路径闭合——
     * 填充与描边一次完成，交界不断线。尾巴几何见 _bubbleGeom：
     *   弧：根A（aM+6°）沿 a 增方向绕一圈到根B（aM−6°）
     *   内边：根B → 尖端 直线（根部形成锐利缺口）
     *   外边：尖端 → 根A 二次曲线（微外鼓）
     */
    _bubblePath(p, x, y, w, h, tail) {
        const g = StudioShapeTool._bubbleGeom(w, h, tail);
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
    }
}

// 暴露到全局作用域（经典 script，ImageStudio.js 之后实例化时消费）
window.StudioShapeTool = StudioShapeTool;
