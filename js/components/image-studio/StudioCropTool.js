/**
 * ==========================================================================
 * ImageStudio 子模块：裁剪 / 扩图（自 ImageStudio.js 拆出，移植自
 * ImageOutpaint）
 * 作用：画幅框四边锚点拖拽调整画幅（钳制公式与 ImageOutpaint 同套）、
 *       裁剪覆盖层渲染（三分网格/边框/锚点/尺寸标签）、顶栏尺寸信息。
 * 契约：构造时传入宿主 ImageStudio 实例并读写其字段与方法（studio.xxx）；
 *       主类保留同名薄代理（_onCropDown/_onCropMove/_updateMsg/
 *       _drawCropOverlay）。
 * ==========================================================================
 */

class StudioCropTool {
    /** @param {Object} studio - 宿主 ImageStudio 实例 */
    constructor(studio) {
        this.studio = studio;
    }

    _onCropDown(e) {
        const studio = this.studio;
        if (e.button !== 0 || !studio.image) return;
        const rect = studio.cropCanvas.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        const edge = this._hitAnchor(sx, sy);
        if (!edge) return;
        e.preventDefault();
        studio.dragEdge = edge;
        try { studio.cropCanvas.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
        this._dragEdgeTo(sx, sy);
    }

    _onCropMove(e) {
        const studio = this.studio;
        const rect = studio.cropCanvas.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        if (studio.dragEdge) {
            this._dragEdgeTo(sx, sy);
            return;
        }
        // 悬停反馈：锚点上方换尺寸调整光标
        const edge = this._hitAnchor(sx, sy);
        studio.cropCanvas.style.cursor =
            edge === 'left' || edge === 'right' ? 'ew-resize' :
            edge === 'top' || edge === 'bottom' ? 'ns-resize' : 'default';
    }

    /** 四边中点锚点（画幅框边缘 = 承载区边缘；坐标含出血偏移） */
    _anchorPoints() {
        const studio = this.studio;
        const b = ImageStudio.CROP_BLEED;
        const w = studio.cropCanvas.clientWidth - b * 2;
        const h = studio.cropCanvas.clientHeight - b * 2;
        return [
            { edge: 'left',   x: b,     y: b + h / 2 },
            { edge: 'right',  x: b + w, y: b + h / 2 },
            { edge: 'top',    x: b + w / 2, y: b },
            { edge: 'bottom', x: b + w / 2, y: b + h }
        ];
    }

    _hitAnchor(screenX, screenY) {
        for (const a of this._anchorPoints()) {
            const dx = screenX - a.x, dy = screenY - a.y;
            if (dx * dx + dy * dy <= ImageStudio.HIT_R * ImageStudio.HIT_R) return a.edge;
        }
        return null;
    }

    /**
     * 按拖拽边更新画幅（钳制：边长 ∈ [64,8192]，框与原图可见交集
     * 每轴 ≥64px 防把图完全裁没），并补偿平移保持原图在屏幕上不动。
     * 覆盖层坐标减去出血边距换算回画幅框内坐标，再除以缩放得文档坐标。
     */
    _dragEdgeTo(sx, sy) {
        const studio = this.studio;
        const b = ImageStudio.CROP_BLEED;
        const docX = studio.frame.fx + (sx - b) / studio.zoom;
        const docY = studio.frame.fy + (sy - b) / studio.zoom;
        const prevCx = studio.frame.fx + studio.frame.fw / 2;
        const prevCy = studio.frame.fy + studio.frame.fh / 2;
        this._applyEdge(studio.dragEdge,
            studio.dragEdge === 'left' || studio.dragEdge === 'right' ? docX : docY);
        // 画幅框中心偏移量补偿进平移：视图锚点不变，原图纹丝不动
        studio.panX += ((studio.frame.fx + studio.frame.fw / 2) - prevCx) * studio.zoom;
        studio.panY += ((studio.frame.fy + studio.frame.fh / 2) - prevCy) * studio.zoom;
        studio.dirty.frame = true;
        const f = studio.frame;
        studio.dragLabel = (studio.dragEdge === 'left' || studio.dragEdge === 'right')
            ? `W：${Math.round(f.fw)} 像素`
            : `H：${Math.round(f.fh)} 像素`;
        studio._applyTransform();
        studio._updateMsg();
    }

    /** 边约束计算（与 ImageOutpaint._applyEdge 同一套钳制公式） */
    _applyEdge(edge, pos) {
        const studio = this.studio;
        const f = studio.frame;
        const MIN = ImageStudio.MIN_DIM;
        const MAX = ImageStudio.MAX_DIM;
        const V = ImageStudio.MIN_VISIBLE;
        if (edge === 'left' || edge === 'right') {
            const right = f.fx + f.fw;
            if (edge === 'left') {
                f.fx = Math.max(
                    Math.max(right - MAX, V - right),
                    Math.min(pos, Math.min(right - MIN, studio.iw - V))
                );
                f.fw = right - f.fx;
            } else {
                f.fw = Math.max(MIN, Math.min(MAX, pos - f.fx));
            }
        } else {
            const bottom = f.fy + f.fh;
            if (edge === 'top') {
                f.fy = Math.max(
                    Math.max(bottom - MAX, V - bottom),
                    Math.min(pos, Math.min(bottom - MIN, studio.ih - V))
                );
                f.fh = bottom - f.fy;
            } else {
                f.fh = Math.max(MIN, Math.min(MAX, pos - f.fy));
            }
        }
    }

    _updateMsg() {
        const studio = this.studio;
        if (studio.tool !== 'crop') {
            studio.msgEl.textContent = '';
            return;
        }
        const f = studio.frame;
        studio.msgEl.textContent =
            `原图 ${studio.iw}×${studio.ih} ｜ 画幅 ${Math.round(f.fw)}×${Math.round(f.fh)}`;
    }

    /** 裁剪覆盖层渲染：三分网格 / 画幅边框 / 四边锚点 / 拖拽尺寸标签 */
    _drawCropOverlay() {
        const studio = this.studio;
        const ctx = studio.cropCanvas.getContext('2d');
        const dpr = studio._dpr || 1;
        const b = ImageStudio.CROP_BLEED;
        const w = studio.cropCanvas.clientWidth - b * 2;   // 画幅框尺寸
        const h = studio.cropCanvas.clientHeight - b * 2;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, studio.cropCanvas.clientWidth, studio.cropCanvas.clientHeight);
        if (studio.tool !== 'crop') return;

        // 三分网格（灰色细线）
        ctx.strokeStyle = 'rgba(128, 128, 128, 0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 1; i <= 2; i++) {
            ctx.moveTo(b + (w * i) / 3, b); ctx.lineTo(b + (w * i) / 3, b + h);
            ctx.moveTo(b, b + (h * i) / 3); ctx.lineTo(b + w, b + (h * i) / 3);
        }
        ctx.stroke();

        // 画幅边框（与画布选中框同款青色）
        ctx.strokeStyle = '#6cebff';
        ctx.lineWidth = 1.7;
        ctx.strokeRect(b + 0.85, b + 0.85, w - 1.7, h - 1.7);

        // 四边中点锚点（白圆 + 青描边，屏幕尺寸恒定）
        for (const a of this._anchorPoints()) {
            ctx.beginPath();
            ctx.arc(a.x, a.y, ImageStudio.ANCHOR_R, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.strokeStyle = '#6cebff';
            ctx.lineWidth = 1.7;
            ctx.stroke();
        }

        // 拖拽中的尺寸标签（黑底白字圆角，浮在活动边外侧）
        if (studio.dragLabel && studio.dragEdge) {
            const vertical = studio.dragEdge === 'left' || studio.dragEdge === 'right';
            ctx.font = '12px system-ui, sans-serif';
            const textW = ctx.measureText(studio.dragLabel).width;
            const padX = 8, padY = 5;
            const boxW = textW + padX * 2, boxH = 12 + padY * 2;
            const bx = vertical ? b + w + 16 : b + w / 2 - boxW / 2;
            const by = vertical ? b + h / 2 - boxH / 2 : b + h + 16;
            ctx.fillStyle = 'rgba(20, 21, 26, 0.9)';
            ctx.beginPath();
            ctx.roundRect(bx, by, boxW, boxH, 5);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.textBaseline = 'middle';
            ctx.fillText(studio.dragLabel, bx + padX, by + boxH / 2 + 1);
        }
    }
}

// 暴露到全局作用域（经典 script，ImageStudio.js 之后实例化时消费）
window.StudioCropTool = StudioCropTool;
