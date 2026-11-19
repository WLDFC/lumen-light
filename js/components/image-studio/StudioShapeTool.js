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
 *       同名薄代理（_onShapeDown/_bakeShapeScale）。几何算法（类型表/
 *       气泡尾巴/外伸/路径/绘制原语）2026-11-06 收敛共享层
 *       js/utils/ShapeLayout.js（ADR 069，漫画编辑器 MangaShape 同消费方，
 *       勿复制），本文件的静态表与纯几何方法均为一行委托（别名保留——
 *       ImageStudio.js 的翻转/旋转分支仍按 StudioShapeTool.XXX 消费）。
 * ==========================================================================
 */

class StudioShapeTool {
    /** 气泡尾巴方位 → 尾巴指向角（度，y 向下坐标系：45=右下 135=左下
     *  225=左上 315=右上）——委托 ShapeLayout（同一对象引用） */
    static TAIL_DEG = ShapeLayout.TAIL_DEG;

    /** 形状类型 → 图层名（创建提交时命名） */
    static TYPE_NAME = ShapeLayout.TYPE_NAME;

    /** 左右翻转用的尾巴方位映射（气泡是唯一左右不对称的形状——
     *  尾巴换到镜像侧，其余形状左右对称，重渲染结果不变） */
    static MIRROR_TAIL = ShapeLayout.MIRROR_TAIL;
    // 旋转换位表：90° 顺时针（右→下→左→上，角落 rb→lb→lt→rt 循环）
    // 与 180°（对角互换）。供 rotateActiveLayer 旋转气泡尾巴方位用
    static ROT_TAIL_CW = ShapeLayout.ROT_TAIL_CW;
    static ROT_TAIL_180 = ShapeLayout.ROT_TAIL_180;

    constructor(studio) {
        this.studio = studio;
        this.drag = null;   // 拖拽创建态 { layer, startX, startY }
        studio._pen = null; // 钢笔会话态 { pts, cursor }（挂宿主，预览/键盘消费）
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

    /** 顶栏属性改动 → 选中形状层重渲染（未选中则只影响默认值）。
     *  多边形（钢笔）不吃类型切换——类型钮只改默认值，不把 poly 转成
     *  矩形/椭圆（否则拖圆角滑杆都会把多边形变矩形） */
    applyOpts() {
        const studio = this.studio;
        const layer = this._targetLayer();
        const o = studio.shapeOpts;
        if (!layer) return;
        const typePatch = layer.shape.type === 'poly' ? {} : { type: o.type };
        Object.assign(layer.shape, {
            ...typePatch, fill: o.fill, strokeColor: o.strokeColor,
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

    // ==================== 钢笔工具（2026-11-11 自漫画编辑器移植） ====================

    /** 钢笔按下（主类 _onPaintDown pen 分支转发）：无会话则首点开话
     *  （钳到文档边界）；近起点（屏幕 8px/zoom 换算文档距离）且 ≥3 点 →
     *  闭合提交，否则追加顶点。预览经 _drawSelOverlay（StudioMoveTool） */
    _penDown(e) {
        const studio = this.studio;
        if (!studio._readyDone) return;
        e.preventDefault();
        const pos = studio._toImagePos(e);
        const clamp = (p) => [
            Math.max(0, Math.min(studio.iw, p.x)),
            Math.max(0, Math.min(studio.ih, p.y))
        ];
        if (!studio._pen) {
            studio._pen = { pts: [clamp(pos)], cursor: null };
            studio._drawSelOverlay();
            return;
        }
        const pen = studio._pen;
        const dist = Math.hypot(pos.x - pen.pts[0][0], pos.y - pen.pts[0][1]) * studio.zoom;
        if (dist <= 8 && pen.pts.length >= 3) {
            this._penClose();
            return;
        }
        pen.pts.push(clamp(pos));
        studio._drawSelOverlay();
    }

    /** 钢笔移动：橡皮筋预览终点实时更新 */
    _penMove(e) {
        const studio = this.studio;
        if (!studio._pen) return;
        const pos = studio._toImagePos(e);
        studio._pen.cursor = [
            Math.max(0, Math.min(studio.iw, pos.x)),
            Math.max(0, Math.min(studio.ih, pos.y))
        ];
        studio._drawSelOverlay();
    }

    /**
     * 闭合提交（近起点 / Enter）：polyNormalize 归一化点集建形状层
     * （属性取顶栏默认值：填充/边框色/边宽/圆角——圆角做顶点圆弧过渡，
     * polyPath arcTo），命名「多边形」+「绘制多边形」入账 + 自动选中；
     * <3 点提示取消零痕迹
     */
    _penClose() {
        const studio = this.studio;
        const pen = studio._pen;
        studio._pen = null;
        if (!pen || pen.pts.length < 3) {
            if (pen) studio._flashMsg('多边形至少需要 3 个顶点，已取消');
            studio._drawSelOverlay();
            return;
        }
        const norm = ShapeLayout.polyNormalize(pen.pts);
        if (!norm) { studio._drawSelOverlay(); return; }
        const layer = studio.addShapeLayer({ x: norm.x, y: norm.y });
        layer.shape = {
            type: 'poly',
            w: norm.w,
            h: norm.h,
            points: norm.points,
            fill: studio.shapeOpts.fill,
            strokeColor: studio.shapeOpts.strokeColor,
            strokeWidth: studio.shapeOpts.strokeWidth,
            radius: studio.shapeOpts.radius,
            tail: 'lb'
        };
        layer.name = ShapeLayout.TYPE_NAME.poly;
        this._render(layer);   // 外伸画布 + tx 重定位同拖拽创建口径
        studio._positionLayerCanvases(layer);
        studio.dirty.layers = true;
        studio._refreshThumb(layer);
        studio._pushHistory('绘制多边形');
        studio._renderLayerList();
        studio._drawSelOverlay();
    }

    /** 取消会话（Esc/切工具/关编辑器）；无会话返回 false 供调用方判别 */
    _penCancel() {
        const studio = this.studio;
        if (!studio._pen) return false;
        studio._pen = null;
        studio._drawSelOverlay();
        return true;
    }

    // ==================== 形状渲染 ====================

    /**
     * 气泡尾巴几何——算法在共享层 ShapeLayout.bubbleGeom（ADR 069），
     * 本体为一行委托（签名与返回形态不变）
     * @returns {{A:number[], B:number[], T:number[], cOut:number[],
     *            aA:number, aB:number, aM:number, half:number, L:number}}
     */
    static _bubbleGeom(w, h, tail) {
        return ShapeLayout.bubbleGeom(w, h, tail);
    }

    /**
     * 画布外伸量——算法在共享层 ShapeLayout.extFor（ADR 069），一行委托
     * @returns {{left:number, top:number, right:number, bottom:number}}
     */
    static _extFor(s, w, h) {
        return ShapeLayout.extFor(s, w, h);
    }

    /**
     * 把形状按属性渲染进图层画布。画布 = 形状包围盒 + 四向外伸（见
     * _extFor），layer.tx/ty 语义 = 画布左上角的文档坐标；外伸变化时
     * （尾巴换向/描边宽改/缩放烘焙）以包围盒为锚重定位——气泡本体
     * 在文档中纹丝不动，画布只向外伸方向扩。填充 'none' = 透明
     * （只要边框）；描边宽 0 = 无边框 */
    _render(layer) {
        const studio = this.studio;   // 尾部 _refreshClips 消费（漏声明=ReferenceError，渲染中断画布停 1px）
        const s = layer.shape;
        const w = Math.max(2, Math.round(s.w));
        const h = Math.max(2, Math.round(s.h));
        // 左右翻转：气泡尾巴方位水平镜像后再渲染（这类形状的左右不对称
        // 完全来自尾巴，换向后重算外伸，本体锚点由下方重定位保持不变；
        // 绘制面不再叠加 CSS 镜像，避免外伸不对称导致内容偏移/裁切）。
        // 多边形（钢笔）：镜像层内点集（x → w − x），与气泡同属内容烘焙
        const eff = layer.flipX
            ? {
                ...s,
                tail: StudioShapeTool.MIRROR_TAIL[s.tail] || s.tail,
                points: s.type === 'poly' && Array.isArray(s.points)
                    ? s.points.map(([px, py]) => [s.w - px, py]) : s.points
            }
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
        // 线型策略 + 建路径 + 填充/描边在共享层统一原语（ADR 069）
        ShapeLayout.drawShapeContent(g, eff, ext.left, ext.top, w, h);
        // 形状内容变化影响剪贴合成（本层作基底或被剪贴均受影响）
        studio._refreshClips();
    }

    /** 按类型构建形状路径——算法在共享层 ShapeLayout.buildPath（ADR 069），一行委托 */
    _buildPath(p, x, y, w, h, s) {
        return ShapeLayout.buildPath(p, x, y, w, h, s);
    }

    /**
     * 气泡框路径——算法在共享层 ShapeLayout.bubblePath（ADR 069），一行委托
     */
    _bubblePath(p, x, y, w, h, tail) {
        return ShapeLayout.bubblePath(p, x, y, w, h, tail);
    }
}

// 暴露到全局作用域（经典 script，ImageStudio.js 之后实例化时消费）
window.StudioShapeTool = StudioShapeTool;
