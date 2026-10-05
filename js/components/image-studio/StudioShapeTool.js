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
 *       三角尾巴连成单一路径（填充描边不断线），尾巴方位四选一。
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
     * 画布外伸量：形状包围盒四周 = 描边半宽 + 1px 防裁切；气泡框再按
     * 尾巴方向加上尾巴外伸（尾巴尖伸出包围盒最远 min(w,h)×0.35，画布
     * 不扩到那里尾巴就被裁掉——曾因此渲染出"没闭合的圆"）
     * @returns {{left:number, top:number, right:number, bottom:number}}
     */
    static _extFor(s, w, h) {
        const m = Math.ceil((Math.max(0, Number(s.strokeWidth) || 0)) / 2) + 1;
        let l = m; let t = m; let r = m; let b = m;
        if (s.type === 'bubble') {
            const rad = ((StudioShapeTool.TAIL_DEG[s.tail] ?? 135) * Math.PI) / 180;
            const L = Math.min(w, h) * 0.35;
            const ox = Math.cos(rad) * L;
            const oy = Math.sin(rad) * L;
            l += Math.ceil(Math.max(0, -ox));
            t += Math.ceil(Math.max(0, -oy));
            r += Math.ceil(Math.max(0, ox));
            b += Math.ceil(Math.max(0, oy));
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
        const ext = StudioShapeTool._extFor(s, w, h);
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
        g.lineJoin = 'round';
        g.lineCap = 'round';
        const p = new Path2D();
        this._buildPath(p, ext.left, ext.top, w, h, s);
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
     * 气泡框路径：椭圆长弧（300°）+ 三角尾巴连成单一路径——填充与描边
     * 一次完成，尾巴与椭圆交界处不断线。尾巴指向角 t 由 TAIL_DEG 给出，
     * 根部张开 ±30°，尖端沿该方向伸出短边 35% 的长度
     */
    _bubblePath(p, x, y, w, h, tail) {
        const cx = x + w / 2;
        const cy = y + h / 2;
        const rx = w / 2;
        const ry = h / 2;
        const t = ((StudioShapeTool.TAIL_DEG[tail] ?? 135) * Math.PI) / 180;
        const half = Math.PI / 6;                       // 根部半张角 30°
        const sweep = Math.PI * 2 - half * 2;           // 长弧 300°
        const steps = 48;
        const px = (a) => cx + rx * Math.cos(a);
        const py = (a) => cy + ry * Math.sin(a);
        const a1 = t + half;
        p.moveTo(px(a1), py(a1));
        for (let i = 1; i <= steps; i++) {
            const a = a1 + (sweep * i) / steps;
            p.lineTo(px(a), py(a));
        }
        const tailLen = Math.min(w, h) * 0.35;
        p.lineTo(cx + (rx + tailLen) * Math.cos(t), cy + (ry + tailLen) * Math.sin(t));
        p.closePath();
    }
}

// 暴露到全局作用域（经典 script，ImageStudio.js 之后实例化时消费）
window.StudioShapeTool = StudioShapeTool;
