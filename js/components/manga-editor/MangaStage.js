/**
 * ==========================================================================
 * MangaEditor 子模块：舞台视口与渲染（ADR 073 手势状态机拆出至
 * MangaGestures.js）
 * ==========================================================================
 * 作用：中央舞台的「看」——视口（自适应铺满 pad28 × 用户缩放 _zoom/平移
 *       _panX/_panY，_computeStageView 单点合成与钳制，滚轮缩放围绕光标
 *       ±10%，双击复位）、渲染（_renderStage：画幅底/三分线/磁吸参考线/
 *       元素框 _drawBox/编号徽标/类型·景别标签/尺寸标签/八向锚点，选中
 *       框置顶重绘保证遮挡下可抓）、画笔圆圈光标覆盖层（自灯箱迁移，
 *       不污染舞台渲染帧）、坐标换算 _localPoint/_toDraft（手势消费方
 *       在 MangaGestures）。图层栈渲染 _drawPageLayers 在 MangaPageRender，
 *       指针手势在 MangaGestures。
 * 契约：原型混入（partial-class，ADR 026）——方法 Object.assign 进
 *       MangaEditor.prototype，this 即编辑器实例；须后于主类加载。
 * 对应：css/manga-editor.css；磁吸纯函数在 js/utils/CoordinateLayout.js。
 * ==========================================================================
 */

Object.assign(window.MangaEditor.prototype, {

    // ==================== 舞台视口（自适应铺满 × 滚轮缩放） ====================

    /**
     * 舞台视口计算：自适应铺满（pad 28 边距）× 用户缩放 _zoom，再叠加
     * 平移偏移并钳制。钳制规则分两态：铺满态（zoom=1）平移归零恒居中
     * ——「铺满」的可预期位置，也是切页/双击复位的落点；放大态平移
     * 钳在走廊（pad, total-pad）内——内容装得下时允许走廊内任意摆放
     * （光标锚定跨过铺满边界的头几格需要），超出走廊后边缘钉在走廊上
     * （看图器同款）。就地修正 _panX/_panY（钳制是状态收口的一部分），
     * _renderStage 与滚轮缩放共用保证两处视口一致
     */
    _computeStageView(cssW, cssH) {
        const d = this.draft, pad = 28;
        const fit = Math.min((cssW - pad * 2) / d.width, (cssH - pad * 2) / d.height);
        const zoom = Number.isFinite(this._zoom) && this._zoom > 0 ? this._zoom : 1;
        const scale = fit * zoom;
        const w = d.width * scale, h = d.height * scale;
        if (zoom === 1) {
            this._panX = 0;
            this._panY = 0;
        } else {
            const clampPan = (pan, size, total) => {
                const base = (total - size) / 2;
                const lo = Math.min(pad, total - pad - size) - base;
                const hi = Math.max(pad, total - pad - size) - base;
                return Math.max(lo, Math.min(hi, Number.isFinite(pan) ? pan : 0));
            };
            this._panX = clampPan(this._panX, w, cssW);
            this._panY = clampPan(this._panY, h, cssH);
        }
        return { scale, ox: (cssW - w) / 2 + this._panX, oy: (cssH - h) / 2 + this._panY };
    },

    /**
     * 以舞台点 (px,py) 为锚缩放：该点的草稿坐标在缩放后仍停在原屏幕
     * 位置（主画布 Viewport.zoom 围绕光标同款）。倍率钳 [1, 8]——下限
     * 即自适应铺满（画幅是固定构图，更小只多留白）；顶到走廊边后钳制
     * 会吃掉部分锚定偏移，属预期。
     * @returns {boolean} 视口是否变化（调用方据此重绘）
     */
    _zoomAt(px, py, factor) {
        if (!this._view || !this.draft) return false;
        const wrap = this.stageCv.parentElement;
        if (!wrap || !wrap.clientWidth || !wrap.clientHeight) return false;
        const z = Math.max(1, Math.min(8, (this._zoom || 1) * factor));
        if (z === this._zoom) return false;
        const before = this._toDraft(px, py);
        this._zoom = z;
        const geom = this._computeStageView(wrap.clientWidth, wrap.clientHeight);
        this._panX += px - before.x * geom.scale - geom.ox;
        this._panY += py - before.y * geom.scale - geom.oy;
        return true;
    },

    /**
     * 滚轮缩放画布：每格 ±10%（0.9/1.1，主画布 Viewport.zoom 同款步进）。
     * ctrl+滚轮（触控板捏合）不特判按同款处理——主画布同策略；
     * preventDefault 防止滚进弹窗其他滚动区
     */
    _onStageWheel(e) {
        if (!this.visible) return;
        e.preventDefault();
        const { px, py } = this._localPoint(e);
        // 缩放锚定在指针处：视口变了指针没动，圈必须仍套在指针下
        this._cursorPos = { x: px, y: py };
        this._cursorInStage = true;
        if (this._zoomAt(px, py, e.deltaY > 0 ? 0.9 : 1.1)) this._renderStage();
    },

    // ==================== 舞台渲染 ====================

    _renderStage() {
        if (!this.dialog || !this.visible) return;
        this._ensureItemIds();
        const cv = this.stageCv;
        const wrap = cv.parentElement;
        const cssW = wrap.clientWidth, cssH = wrap.clientHeight;
        if (!cssW || !cssH) return;
        const dpr = window.devicePixelRatio || 1;
        const bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
        if (cv.width !== bw || cv.height !== bh) {
            cv.width = bw; cv.height = bh;
            cv.style.width = cssW + 'px';
            cv.style.height = cssH + 'px';
        }
        const ctx = cv.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        const d = this.draft;
        this._view = this._computeStageView(cssW, cssH);
        const { scale, ox, oy } = this._view;
        const X = (v) => ox + v * scale, Y = (v) => oy + v * scale;

        // 背景参考图（MangaBackground 混入）：铺满画幅半透明，画在元素框下方
        this._drawBackground(ctx, X, Y, scale);

        // 画幅底与边框
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.fillRect(X(0), Y(0), d.width * scale, d.height * scale);
        ctx.strokeStyle = 'rgba(200,205,215,0.30)';
        ctx.lineWidth = 1;
        ctx.strokeRect(X(0) + 0.5, Y(0) + 0.5, d.width * scale - 1, d.height * scale - 1);

        // 三分参考线（与裁剪工具同款灰细线）
        ctx.strokeStyle = 'rgba(128,128,128,0.30)';
        ctx.beginPath();
        for (let i = 1; i <= 2; i++) {
            ctx.moveTo(X(d.width * i / 3), Y(0)); ctx.lineTo(X(d.width * i / 3), Y(d.height));
            ctx.moveTo(X(0), Y(d.height * i / 3)); ctx.lineTo(X(d.width), Y(d.height * i / 3));
        }
        ctx.stroke();

        // 图层栈（笔迹层/图片层，MangaLayers 混入）：画幅底之上、元素框之下
        this._drawPageLayers(ctx, X, Y, scale, d);

        // 移除工具遮罩预览（MangaRemoveTool，ADR 076）：该层会话中把遮罩
        // 画布（图片分辨率红涂）按 bbox 半透明罩回——挂在 _renderStage 而
        // 非 _drawPageLayers：舞台专属路径，缩略图/「导出本页」零泄漏。
        // 会话关闭时钩子已摘（close 清 _removeMask）
        if (this._removeMask && this._removeMask.cv) {
            const layer = this._layerById(this._removeMask.layerId);
            if (layer && layer.image) {
                const [mx1, my1, mx2, my2] = layer.image.bbox;
                ctx.save();
                ctx.globalAlpha = 0.45;
                ctx.drawImage(this._removeMask.cv, X(mx1), Y(my1), (mx2 - mx1) * scale, (my2 - my1) * scale);
                ctx.restore();
            }
        }

        // 磁吸参考线（拖拽中，灯箱 StudioMoveTool 同款：#ff4fd8 实线 1px，
        // 贯穿舞台全域——图层移出画布后参考线仍全程可见，ADR 070）
        if (this._guides.length) {
            ctx.strokeStyle = '#ff4fd8';
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (const g of this._guides) {
                if (g.axis === 'x') {
                    ctx.moveTo(X(g.pos), 0); ctx.lineTo(X(g.pos), cssH);
                } else {
                    ctx.moveTo(0, Y(g.pos)); ctx.lineTo(cssW, Y(g.pos));
                }
            }
            ctx.stroke();
        }

        // 元素框（按列表顺序绘制，数组末位画在最上层；眼睛隐藏的框跳过）
        d.items.forEach((item, i) => {
            if (this._hiddenCids.has(item.cid)) return;
            this._drawBox(ctx, item, i, X, Y, scale, i === this.selected);
        });

        // 选中框置顶重绘（跳过填充防半透明叠深）：被上层框盖住时，
        // 选中描边/徽标/锚点仍可见可抓——遮挡编辑的前提
        if (this.selected >= 0 && this.selected < d.items.length &&
            !this._hiddenCids.has(d.items[this.selected].cid)) {
            this._drawBox(ctx, d.items[this.selected], this.selected, X, Y, scale, true, true);
        }

        // 选中图片层覆盖（虚线框 + 八向锚点，MangaLayers 混入）
        this._drawLayerSelection(ctx, X, Y, scale);

        // 绘制中的新框（虚线预览，用下一个颜色）
        if (this._drag && this._drag.mode === 'draw' && this._drag.box) {
            const [x1, y1, x2, y2] = this._drag.box;
            ctx.strokeStyle = this._colorFor(this._nextCid);
            ctx.lineWidth = 1.7;
            ctx.setLineDash([6, 4]);
            ctx.strokeRect(X(Math.min(x1, x2)), Y(Math.min(y1, y2)),
                Math.abs(x2 - x1) * scale, Math.abs(y2 - y1) * scale);
            ctx.setLineDash([]);
            this._drawDimLabel(ctx, X(Math.min(x1, x2)), Y(Math.max(y1, y2)),
                Math.abs(x2 - x1), Math.abs(y2 - y1));
        }

        // 画笔圆圈光标：覆盖层随舞台重算同步尺寸，圈径保持与笔迹 1:1
        this._ensureCursorCv(wrap, cssW, cssH, dpr);
        this._redrawCursorRing();
    },

    // ==================== 画笔圆圈光标（自灯箱 ImageStudio 迁移） ====================

    /**
     * 光标覆盖层画布：悬在 stageCv 之上同尺寸（pointer-events:none），
     * 圈画在这层——不污染舞台渲染帧（灯箱 selCanvas 同机制）。尺寸随
     * _renderStage 的舞台重算同步（dpr 同源）
     */
    _ensureCursorCv(wrap, cssW, cssH, dpr) {
        if (!this._cursorCv) {
            const cv = document.createElement('canvas');
            cv.className = 'manga-cursor-cv';
            wrap.appendChild(cv);
            this._cursorCv = cv;
        }
        const bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
        if (this._cursorCv.width !== bw || this._cursorCv.height !== bh) {
            this._cursorCv.width = bw;
            this._cursorCv.height = bh;
        }
        this._cursorCv.style.width = cssW + 'px';
        this._cursorCv.style.height = cssH + 'px';
    },

    /** 圈可见性谓词：画笔/橡皮工具 + 指针在舞台内（顶栏/面板上不画）——
     *  灯箱 _brushCursorTool 同语义 */
    _ringVisible() {
        return (this.activeTool === 'brush' || this.activeTool === 'eraser' || this.activeTool === 'remove') &&
            this._cursorInStage === true &&
            !!this._cursorPos && !!this._view;
    },

    /** 光标圈直径 = 笔宽 × 舞台缩放（与笔迹屏幕渲染宽度 1:1，所见即所得）；
     *  移除工具取会话遮罩笔宽 × SIZE_SCALE（灯箱同款视觉倍率，ADR 076） */
    _cursorRingD() {
        const w = this.activeTool === 'remove' && this._remove
            ? this._remove.width * window.MangaRemoveTool.SIZE_SCALE : this._brushWidth;
        return Math.max(4, Math.round(w * this._view.scale));
    },

    /** 光标圈局部重绘：只清上一处圈包围盒再画新圈（灯箱脏区同款——
     *  悬停移动不掉帧）。pointermove / 粗细变化 / 舞台重绘统一走这里 */
    _redrawCursorRing() {
        const cv = this._cursorCv;
        if (!cv) return;
        const g = cv.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (this._ringBBox) {
            const b = this._ringBBox;
            g.clearRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6);
            this._ringBBox = null;
        }
        if (!this._ringVisible()) return;
        const { x, y } = this._cursorPos;
        const d = this._cursorRingD();
        this._drawCursorRing(g, x, y, d);
        this._ringBBox = { x: x - d / 2, y: y - d / 2, w: d, h: d };
    },

    /** 圈样式（黑白互补任意底色可辨）：黑外弧 + 白弧 + 中心定位点——
     *  无填充（2026-11-05 用户拍板，与灯箱同步） */
    _drawCursorRing(g, x, y, d) {
        const r = d / 2 - 1.5;
        g.setLineDash([]);
        g.lineWidth = 1.2;
        g.beginPath();
        g.arc(x, y, r + 1.1, 0, Math.PI * 2);
        g.strokeStyle = 'rgba(0, 0, 0, 0.9)';
        g.stroke();
        if (this.activeTool === 'eraser') g.setLineDash([4, 3]);   // 橡皮虚线圈区分（灯箱同款）
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.strokeStyle = 'rgba(255, 255, 255, 0.92)';
        g.stroke();
        g.setLineDash([]);
        // 中心定位点：低缩放/小圈径时的位置参照
        g.beginPath();
        g.arc(x, y, 1.5, 0, Math.PI * 2);
        g.fillStyle = 'rgba(255, 255, 255, 0.9)';
        g.fill();
    },

    /** 指针离台隐藏圈（pointerleave 收口；下次 move 由跟随逻辑复活） */
    _hideCursorRing() {
        this._cursorPos = null;
        this._redrawCursorRing();
    },

    _drawBox(ctx, item, i, X, Y, scale, isSelected, overlayOnly) {
        const [x1, y1, x2, y2] = item.bbox;
        const id = Number.isInteger(item.cid) ? item.cid : i;   // 旧数据未回填时退回下标
        const color = this._colorFor(id);
        const px = X(x1), py = Y(y1), pw = (x2 - x1) * scale, ph = (y2 - y1) * scale;

        if (!overlayOnly) {           // 置顶重绘只补描边与控件，不再刷填充
            ctx.fillStyle = this._hexA(color, 0.13);
            ctx.fillRect(px, py, pw, ph);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = isSelected ? 2 : 1.7;
        ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);

        // 编号徽标（左上角圆点）
        ctx.beginPath();
        ctx.arc(px, py, 9, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.fillStyle = '#14151a';
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(id + 1), px, py + 0.5);

        // 类型小标签（框够宽才画，避免糊成一团）：标题 · 类型 · 景别 三段都在
        // ——标题只是识别名，类型（物体/角色/文字）始终保留
        if (pw > 64) {
            ctx.fillStyle = 'rgba(255,255,255,0.78)';
            ctx.font = '11px system-ui, sans-serif';
            ctx.textAlign = 'left';
            const parts = [];
            const t = (item.title || '').trim();
            if (t) parts.push(t);
            parts.push(this._labelText[item.label] || item.label);
            if (item.shot) parts.push(item.shot);
            ctx.fillText(parts.join('·'), px + 14, py + 0.5);
        }

        // 拖动中的尺寸标签
        if (this._drag && (this._drag.mode !== 'draw') && isSelected) {
            this._drawDimLabel(ctx, px, py + ph, x2 - x1, y2 - y1);
        }

        // 选中框：八向锚点（白圆 + 彩描边，屏幕尺寸恒定）
        if (isSelected) {
            for (const a of this._anchors(item.bbox, X, Y)) {
                ctx.beginPath();
                ctx.arc(a.x, a.y, 4.5, 0, Math.PI * 2);
                ctx.fillStyle = '#ffffff';
                ctx.fill();
                ctx.strokeStyle = color;
                ctx.lineWidth = 1.6;
                ctx.stroke();
            }
        }
        ctx.textAlign = 'left';
    },

    /** 拖拽尺寸标签（黑底白字圆角，贴框左下角） */
    _drawDimLabel(ctx, x, y, w, h) {
        const text = `${Math.round(w)} × ${Math.round(h)}`;
        ctx.font = '12px system-ui, sans-serif';
        const tw = ctx.measureText(text).width;
        const bw = tw + 16, bh = 22;
        let bx = x, by = y + 6;
        if (bx + bw > this.stageCv.clientWidth - 4) bx = this.stageCv.clientWidth - bw - 4;
        if (by + bh > this.stageCv.clientHeight - 4) by = y - bh - 6;
        ctx.fillStyle = 'rgba(20,21,26,0.92)';
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 5);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, bx + 8, by + bh / 2 + 1);
    },

    /** 八向锚点屏幕坐标（四角 + 四边中点） */
    _anchors(box, X, Y) {
        const [x1, y1, x2, y2] = box;
        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
        return [
            { id: 'nw', x: X(x1), y: Y(y1) }, { id: 'n', x: X(cx), y: Y(y1) },
            { id: 'ne', x: X(x2), y: Y(y1) }, { id: 'e', x: X(x2), y: Y(cy) },
            { id: 'se', x: X(x2), y: Y(y2) }, { id: 's', x: X(cx), y: Y(y2) },
            { id: 'sw', x: X(x1), y: Y(y2) }, { id: 'w', x: X(x1), y: Y(cy) }
        ];
    },

    _hexA(hex, a) {
        const n = parseInt(hex.slice(1), 16);
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    },

    // ==================== 舞台指针交互 ====================

    /** 事件 → 舞台本地像素坐标 */
    _localPoint(e) {
        const rect = this.stageCv.getBoundingClientRect();
        return { px: e.clientX - rect.left, py: e.clientY - rect.top };
    },

    /** 舞台像素 → 草图像素 */
    _toDraft(px, py) {
        const v = this._view;
        return { x: (px - v.ox) / v.scale, y: (py - v.oy) / v.scale };
    },

});
