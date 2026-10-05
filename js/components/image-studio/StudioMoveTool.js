/**
 * ==========================================================================
 * ImageStudio 子模块：移动工具（自 ImageStudio.js 拆出）
 * 作用：图层的选中 / 拖动移动 / 拖角等比缩放，与选中框覆盖层绘制。
 *       交互语义与画布同构（CanvasInteraction.applyResize）：快照矩形防
 *       浮点漂移、对角锚点固定、倍率取宽高较大者保证跟手、控制点屏幕
 *       恒定大小。
 *       磁吸吸附（PS 对齐画幅同款）：拖动/缩放时图层边与中心对齐画幅
 *       边与中心（每轴 3 候选、独立取阈值内最近者），阈值按屏幕像素
 *       （ImageStudio.SNAP_PX / zoom）不随缩放变化；吸附生效的轴在覆盖
 *       层画贯穿画幅的粉色参考线，松手由宿主 _onPaintUp 清除。
 * 契约：构造时传入宿主 ImageStudio 实例并读写其字段与方法（studio.xxx）；
 *       主类保留同名薄代理（_onMoveDown/_onMoveHover/_drawSelOverlay）。
 * ==========================================================================
 */

class StudioMoveTool {
    /** @param {Object} studio - 宿主 ImageStudio 实例 */
    constructor(studio) {
        this.studio = studio;
    }

    /** 图层变换后的文档坐标矩形（尺寸 = 图层自身画布 × 缩放，
     *  置入图层是内容紧致的，选框/命中/缩放都以可见内容为准） */
    _layerRect(layer) {
        return {
            x: layer.tx, y: layer.ty,
            w: layer.paintCv.width * layer.tscale,
            h: layer.paintCv.height * layer.tscale
        };
    }

    /** 移动工具按下：控制点命中 → 拖角缩放；图层命中 → 选中并拖动。
     *  输入来自舞台（覆盖层/绘制面都放行了指针），指针捕获在舞台上，
     *  拖出窗口也能继续跟踪 */
    _onMoveDown(e) {
        const studio = this.studio;
        if (!studio._readyDone) return;
        e.preventDefault();
        studio.stageEl.setPointerCapture(e.pointerId);
        const pos = studio._toImagePos(e);
        const active = studio._activeLayer();
        if (active && !active.isBackground) {
            const handle = this._hitLayerHandle(active, pos);
            if (handle) {
                studio.moveDrag = {
                    mode: 'resize', handle, layer: active,
                    startRect: this._layerRect(active), startMouse: pos
                };
                return;
            }
        }
        const hit = this._hitLayerAt(pos);
        if (hit) {
            if (hit.id !== studio.activeLayerId) studio._setActive(hit.id);
            studio.moveDrag = {
                mode: 'move', layer: hit,
                startTx: hit.tx, startTy: hit.ty, startMouse: pos
            };
            studio.paintSurface.style.cursor = 'move';
        }
    }

    /** 移动工具悬停/拖动：拖拽中实时应用变换，否则按命中更新光标 */
    _onMoveHover(e) {
        const studio = this.studio;
        const pos = studio._toImagePos(e);
        const d = studio.moveDrag;
        if (d) {
            const layer = d.layer;
            if (d.mode === 'move') {
                const w = layer.paintCv.width * layer.tscale;
                const h = layer.paintCv.height * layer.tscale;
                const rawX = d.startTx + (pos.x - d.startMouse.x);
                const rawY = d.startTy + (pos.y - d.startMouse.y);
                const snap = this._snapMove(rawX, rawY, w, h);
                layer.tx = rawX + snap.x;
                layer.ty = rawY + snap.y;
                studio._snapGuides = { v: snap.guideV, h: snap.guideH };
            } else {
                const s = d.startRect;
                // 固定对角锚点，倍率取宽高较大者（跟手，画布同款）
                const anchorX = (d.handle === 'nw' || d.handle === 'sw') ? s.x + s.w : s.x;
                const anchorY = (d.handle === 'nw' || d.handle === 'ne') ? s.y + s.h : s.y;
                const rawW = Math.abs(pos.x - anchorX);
                const rawH = Math.abs(pos.y - anchorY);
                const ratio = Math.max(rawW / s.w, rawH / s.h);
                // 最小尺寸钳制：避免缩到不可见后无法再抓到控制点
                const minSize = (window.LumenLight?.config?.minImageSize) || 24;
                const finalRatio = Math.max(ratio, minSize / Math.min(s.w, s.h));
                // 磁吸：移动中的边/中心吸附画幅边/中心（等比缩放两轴共享
                // 一个倍率，两轴同时命中时只听距离更近的一轴）
                const snap = this._snapResize(d, s, finalRatio, anchorX, anchorY);
                const newW = s.w * snap.ratio;
                const newH = s.h * snap.ratio;
                layer.tscale = newW / layer.paintCv.width;
                layer.tx = (d.handle === 'nw' || d.handle === 'sw') ? anchorX - newW : anchorX;
                layer.ty = (d.handle === 'nw' || d.handle === 'ne') ? anchorY - newH : anchorY;
                studio._snapGuides = { v: snap.guideV, h: snap.guideH };
            }
            studio._positionLayerCanvases(layer);
            studio._drawSelOverlay();
            // 变换影响拍平与遮罩并集（两者都按变换合成）
            studio.dirty[layer.isImage ? 'base' : 'strokes'] = true;
            studio.dirty.mask = true;
            return;
        }
        // 悬停光标：控制点 → 缩放光标，图层体 → 移动光标
        let cursor = 'default';
        const active = studio._activeLayer();
        if (active && !active.isBackground) {
            const handle = this._hitLayerHandle(active, pos);
            if (handle) {
                cursor = (handle === 'nw' || handle === 'se') ? 'nwse-resize' : 'nesw-resize';
            } else if (this._hitLayerAt(pos)) {
                cursor = 'move';
            }
        }
        studio.paintSurface.style.cursor = cursor;
    }

    /** 自栈顶向下找第一个命中文档坐标的可见图层（跳过锁定的背景层
     *  与尚无像素的空图层——空图层不该挡住对下面内容的点选） */
    _hitLayerAt(pos) {
        const studio = this.studio;
        for (let i = studio.layers.length - 1; i >= 1; i--) {
            const layer = studio.layers[i];
            if (!layer.visible || layer.empty) continue;
            const r = this._layerRect(layer);
            if (pos.x >= r.x && pos.x <= r.x + r.w &&
                pos.y >= r.y && pos.y <= r.y + r.h) return layer;
        }
        return null;
    }

    /** 激活图层四角控制点命中（命中半径按缩放比补偿，屏幕恒定） */
    _hitLayerHandle(layer, pos) {
        const studio = this.studio;
        const r = this._layerRect(layer);
        const hit = ImageStudio.HIT_R / studio.zoom;
        const corners = [
            ['nw', r.x, r.y], ['ne', r.x + r.w, r.y],
            ['sw', r.x, r.y + r.h], ['se', r.x + r.w, r.y + r.h]
        ];
        for (const [name, cx, cy] of corners) {
            if (Math.abs(pos.x - cx) <= hit && Math.abs(pos.y - cy) <= hit) return name;
        }
        return null;
    }

    // ==================== 磁吸吸附（PS 对齐画幅同款） ====================

    /** 拖动磁吸：矩形 (x,y,w,h) 相对画幅框求两轴独立吸附。
     *  候选 = 图层左/中/右 ↔ 画幅左/中/右（上下轴同理，共 6 候选），
     *  每轴取阈值内最近者；阈值 = SNAP_PX 屏幕像素换算成文档单位。
     *  返回 { x, y 原点修正量, guideV/guideH 吸附线文档坐标 } */
    _snapMove(x, y, w, h) {
        const studio = this.studio;
        const f = studio.frame;
        const thr = ImageStudio.SNAP_PX / studio.zoom;
        const ax = this._snapAxis1D(
            [x, x + w / 2, x + w],
            [f.fx, f.fx + f.fw / 2, f.fx + f.fw], thr);
        const ay = this._snapAxis1D(
            [y, y + h / 2, y + h],
            [f.fy, f.fy + f.fh / 2, f.fy + f.fh], thr);
        return { x: ax.delta, y: ay.delta, guideV: ax.guide, guideH: ay.guide };
    }

    /** 单轴磁吸：图层候选点（边/中心）对齐画幅候选线，阈值内取最近。
     *  返回 { delta 应用到图层原点的修正量, guide 吸附线文档坐标 } */
    _snapAxis1D(layerPoints, targets, thr) {
        let best = null;
        for (const a of layerPoints) {
            for (const b of targets) {
                const d = b - a;
                if (Math.abs(d) > thr) continue;
                if (!best || Math.abs(d) < Math.abs(best.delta)) {
                    best = { delta: d, guide: b };
                }
            }
        }
        return best || { delta: 0, guide: null };
    }

    /** 缩放磁吸：把移动中的边/中心吸附到画幅边/中心。等比缩放两轴
     *  共享一个倍率，故把每个候选换算成倍率（边对齐 newLen=|t-anchor|、
     *  中心对齐 newLen=2|t-anchor|），与原始倍率取长度差最近者——两轴
     *  同时命中时只听更近的一轴。返回 { ratio, guideV, guideH } */
    _snapResize(d, s, ratio, anchorX, anchorY) {
        const studio = this.studio;
        const f = studio.frame;
        const thr = ImageStudio.SNAP_PX / studio.zoom;
        const minSize = (window.LumenLight?.config?.minImageSize) || 24;
        const west = d.handle === 'nw' || d.handle === 'sw';   // 锚点在右，左边移动
        const north = d.handle === 'nw' || d.handle === 'ne';  // 锚点在下，上边移动
        let best = null;
        const consider = (baseLen, anchor, isV) => {
            for (const t of (isV
                ? [f.fy, f.fy + f.fh / 2, f.fy + f.fh]
                : [f.fx, f.fx + f.fw / 2, f.fx + f.fw])) {
                const edge = isV
                    ? (north ? anchor - t : t - anchor)
                    : (west ? anchor - t : t - anchor);
                for (const newLen of [edge, edge * 2]) {   // 边贴边 / 中心对齐
                    if (newLen <= 0) continue;
                    const r = newLen / baseLen;
                    if (Math.min(s.w, s.h) * r < minSize) continue;
                    const delta = Math.abs(newLen - baseLen * ratio);
                    if (delta > thr) continue;
                    if (!best || delta < best.delta) {
                        best = { ratio: r, delta,
                            guideV: isV ? null : t, guideH: isV ? t : null };
                    }
                }
            }
        };
        consider(s.w, anchorX, false);
        consider(s.h, anchorY, true);
        return best || { ratio, guideV: null, guideH: null };
    }

    /** 绘制选中框覆盖层：激活图层边框 + 四角白色圆点控制点（移动工具下）。
     *  覆盖层铺满整个舞台、按舞台屏幕坐标绘制——图层移出文档后选框依然
     *  完整可见；线宽与控制点直接用屏幕像素，无需按缩放比补偿 */
    _drawSelOverlay() {
        const studio = this.studio;
        if (!studio.selCanvas || !studio.stageEl) return;
        if (studio._wrapLeft === undefined || studio._wrapTop === undefined) return;
        const g = studio.selCanvas.getContext('2d');
        const dpr = studio._selDpr || 1;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, studio.selCanvas.width, studio.selCanvas.height);
        if ((studio.tool !== 'move' && studio.tool !== 'text') || !studio.image) return;
        const layer = studio._activeLayer();
        if (!layer || layer.isBackground || layer.empty) return;
        // 文档坐标 → 舞台屏幕坐标（与图层画布定位同源：包裹层偏移 +
        // (文档值 - 画幅偏移) × 缩放比；小数不取整，与图层定位保持
        // 亚像素一致，避免选框相对图层抖动）
        const doc = this._layerRect(layer);
        const sx = (x) => studio._wrapLeft + (x - studio.frame.fx) * studio.zoom;
        const sy = (y) => studio._wrapTop + (y - studio.frame.fy) * studio.zoom;
        // 磁吸参考线：吸附生效的轴画贯穿画幅的粉线（拖拽中随移动实时
        // 重绘，松手由宿主 _onPaintUp 清除并重绘本覆盖层）
        const guides = studio._snapGuides;
        if (guides && (guides.v != null || guides.h != null)) {
            g.strokeStyle = ImageStudio.SNAP_GUIDE_COLOR;
            g.lineWidth = 1;
            g.beginPath();
            if (guides.v != null) {
                const gx = sx(guides.v);
                g.moveTo(gx, sy(studio.frame.fy));
                g.lineTo(gx, sy(studio.frame.fy + studio.frame.fh));
            }
            if (guides.h != null) {
                const gy = sy(guides.h);
                g.moveTo(sx(studio.frame.fx), gy);
                g.lineTo(sx(studio.frame.fx + studio.frame.fw), gy);
            }
            g.stroke();
        }
        const x1 = sx(doc.x), y1 = sy(doc.y);
        const x2 = sx(doc.x + doc.w), y2 = sy(doc.y + doc.h);
        g.strokeStyle = '#6cebff';
        g.lineWidth = 1.5;
        g.strokeRect(x1, y1, x2 - x1, y2 - y1);
        const rad = ImageStudio.ANCHOR_R;
        for (const [cx, cy] of [[x1, y1], [x2, y1], [x1, y2], [x2, y2]]) {
            g.beginPath();
            g.arc(cx, cy, rad, 0, Math.PI * 2);
            g.fillStyle = '#ffffff';
            g.fill();
            g.strokeStyle = 'rgba(15, 23, 32, 0.9)';
            g.lineWidth = 1.5;
            g.stroke();
        }
    }
}

// 暴露到全局作用域（经典 script，ImageStudio.js 之后实例化时消费）
window.StudioMoveTool = StudioMoveTool;
