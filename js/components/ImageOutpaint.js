/**
 * ==========================================================================
 * LumenLight 画布图片扩图灯箱（ImageOutpaint）
 * ==========================================================================
 * 作用：图片工具栏「编辑 → 扩图」进入的全屏灯箱，通过拉伸画幅框调整
 *       图像的最终尺寸（可向外扩展、也可向内裁剪）：
 *   - 文档模型：画幅框（frame）定义最终输出范围，原图固定在文档坐标
 *     (0,0,iw,ih)；框四边中点各一个锚点（沿用画布选中锚点视觉：
 *     白色圆点 + #6cebff 描边），拖拽只动被抓的那条边；
 *   - 视觉：画幅内白色填充（保存时新区域即为白底）、三分网格辅助线、
 *     边框与画布选中框同色（#6cebff 1.7px）、拖拽时在活动边外侧浮出
 *     「W/H：xxxx 像素」尺寸标签（同 image-size-label 观感）；
 *   - 约束：框最小 64px、单边最大 8192px，且框与原图的可见交集每轴
 *     至少 64px（不允许把图完全裁没）；
 *   - 视图：自动适应——每次框变化后整体重新 fit（框变大视图缩小），
 *     无需手动缩放平移；
 *   - 保存：按画幅原始分辨率导出 PNG（白底 + 原图按偏移绘制，笔迹层
 *     不烘焙——与放大/抠图同口径），作为新图落到原图右侧，原图不动。
 * 对应组件：js/components/ImageToolbar.js（编辑菜单入口）、
 *           js/app.js（outpaintComplete 事件落图）、css/image-editor.css（复用）
 * ==========================================================================
 */

class ImageOutpaint {
    /** 画幅最小边（原图像素） */
    static MIN_DIM = 64;
    /** 画幅最大边（原图像素） */
    static MAX_DIM = 8192;
    /** 框与原图可见交集的最小边（防把图完全裁没） */
    static MIN_VISIBLE = 64;
    /** 锚点半径（屏幕像素，白圆 + 青描边，与画布选中锚点同款） */
    static ANCHOR_R = 4.5;
    /** 锚点命中半径（屏幕像素，略宽于视觉半径便于抓取） */
    static HIT_R = 12;
    /** 自动适应时画幅与舞台边缘的留白（屏幕像素） */
    static FIT_MARGIN = 60;

    /**
     * @param {Object} canvas - 画布实例（未直接使用，与 ImageEditor 同构保留）
     */
    constructor(canvas) {
        this.canvas = canvas;
        this.image = null;        // 当前扩图的画布图片对象
        this.iw = 0;              // 原图宽（文档像素）
        this.ih = 0;
        this.frame = { fx: 0, fy: 0, fw: 0, fh: 0 };  // 画幅框（文档坐标）
        this.zoom = 1;            // 文档像素 → 屏幕像素
        this.vcx = 0;             // 视图中心（文档坐标）——视图变换的唯一锚点，
        this.vcy = 0;             // 拖拽锚点/扩展画幅时不随之改变，图片因此固定不动
        this.panning = false;     // 中键拖拽平移中（移植画笔灯箱）
        this._panLast = null;
        this.dragEdge = null;     // 正在拖拽的边：'left' | 'right' | 'top' | 'bottom'
        this.dragLabel = '';      // 拖拽期间浮出的尺寸标签文本
        this.dirty = false;       // 画幅是否偏离初始（未保存关闭时确认）

        this._buildDom();
    }

    // ==================== DOM 构建（一次性，复用画笔灯箱类名） ====================

    _buildDom() {
        // 遮罩层：复用 .image-editor 全套灯箱样式（遮罩/顶栏/舞台/确认框），
        // 附加 .image-outpaint 作语义标识与本功能的少量覆盖样式
        this.overlayEl = document.createElement('div');
        this.overlayEl.className = 'image-editor image-outpaint';

        // ---- 顶栏 ----
        const topbar = document.createElement('div');
        topbar.className = 'image-editor-topbar';

        const title = document.createElement('span');
        title.className = 'ie-size-label';
        title.textContent = '扩图';
        title.style.fontSize = '13px';

        // 还原：画幅重置为原图尺寸
        const revertBtn = document.createElement('button');
        revertBtn.className = 'ie-tool-btn';
        revertBtn.title = '还原（画幅重置为原图尺寸）';
        revertBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>`;
        revertBtn.addEventListener('click', () => this.resetFrame());

        // 右侧：尺寸提示 / 保存 / 关闭
        this.msgEl = document.createElement('span');
        this.msgEl.className = 'ie-msg';
        const saveBtn = document.createElement('button');
        saveBtn.className = 'ie-save-btn';
        saveBtn.textContent = '保存';
        saveBtn.title = '按当前画幅导出新图（白色填充扩展区），落到原图右侧';
        saveBtn.addEventListener('click', () => this.save());
        const closeBtn = document.createElement('button');
        closeBtn.className = 'ie-close-btn';
        closeBtn.title = '关闭';
        closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
        closeBtn.addEventListener('click', () => this.requestClose());

        topbar.append(title, revertBtn, this.msgEl, saveBtn, closeBtn);

        // ---- 画布区：单画布渲染（文档/网格/边框/锚点/标签） ----
        const stage = document.createElement('div');
        stage.className = 'image-editor-stage';
        this.stageEl = stage;
        this.canvasEl = document.createElement('canvas');
        this.canvasEl.className = 'io-canvas';
        this.ctx = this.canvasEl.getContext('2d');
        stage.appendChild(this.canvasEl);

        // ---- 左下角缩放指示（移植画笔灯箱同款：适应屏幕 + 百分比） ----
        const zoomCtrl = document.createElement('div');
        zoomCtrl.className = 'ie-zoomctrl';
        const fitBtn = document.createElement('button');
        fitBtn.className = 'ie-fit-btn';
        fitBtn.title = '缩放至适应画幅';
        fitBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path></svg>
            <span>适应屏幕</span>`;
        fitBtn.addEventListener('click', () => this.fitView());
        this.zoomPill = document.createElement('button');
        this.zoomPill.className = 'ie-zoom-pill';
        this.zoomPill.title = '点击恢复 100%';
        this.zoomPill.textContent = '100%';
        this.zoomPill.addEventListener('click', () => this.setZoom(1));
        zoomCtrl.append(fitBtn, this.zoomPill);

        // ---- 丢弃确认框（复用画笔灯箱样式） ----
        this.confirmEl = document.createElement('div');
        this.confirmEl.className = 'ie-confirm';
        this.confirmEl.hidden = true;
        this.confirmEl.innerHTML = `
            <div class="ie-confirm-text">有未保存的扩图设置，确定丢弃吗？</div>
            <div class="ie-confirm-btns">
                <button type="button" class="ie-confirm-cancel">继续调整</button>
                <button type="button" class="ie-confirm-discard">丢弃更改</button>
            </div>`;
        this.confirmEl.querySelector('.ie-confirm-cancel')
            .addEventListener('click', () => { this.confirmEl.hidden = true; });
        this.confirmEl.querySelector('.ie-confirm-discard')
            .addEventListener('click', () => { this.confirmEl.hidden = true; this.close(); });

        this.overlayEl.append(topbar, stage, zoomCtrl, this.confirmEl);
        this.overlayEl.style.display = 'none';
        document.body.appendChild(this.overlayEl);

        this._bindEvents();
    }

    _bindEvents() {
        this.canvasEl.addEventListener('pointerdown', (e) => this._onPointerDown(e));
        this.canvasEl.addEventListener('pointermove', (e) => this._onPointerMove(e));
        this.canvasEl.addEventListener('pointerup', (e) => this._onPointerUp(e));
        this.canvasEl.addEventListener('pointercancel', (e) => this._onPointerUp(e));
        this.canvasEl.addEventListener('contextmenu', (e) => e.preventDefault());

        // 滚轮缩放（移植画笔灯箱）+ 中键拖拽平移
        this.stageEl.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
        // 中键按下会触发浏览器"自动滚动"，必须拦掉
        this.stageEl.addEventListener('mousedown', (e) => {
            if (e.button === 1) e.preventDefault();
        });
        this.stageEl.addEventListener('pointerdown', (e) => this._onStagePointerDown(e));
        this.stageEl.addEventListener('pointermove', (e) => this._onStagePointerMove(e));
        this.stageEl.addEventListener('pointerup', (e) => this._onStagePointerUp(e));
        this.stageEl.addEventListener('pointercancel', (e) => this._onStagePointerUp(e));

        window.addEventListener('resize', () => {
            if (this.isOpen()) { this._resizeCanvas(); this._clampPan(); this._draw(); }
        });

        // ESC 关闭（画幅偏离初始时走确认；与画笔灯箱互不干扰——各自 isOpen 守卫）
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen()) this.requestClose();
        });
    }

    // ==================== 打开 / 关闭 ====================

    isOpen() {
        return this.overlayEl.style.display !== 'none';
    }

    /**
     * 打开扩图灯箱
     * @param {Object} imageObj - 画布图片对象（ImageToolbar.selectedImages[0]）
     */
    open(imageObj) {
        if (!imageObj?.img) return;
        this.image = imageObj;
        this.iw = imageObj.img.naturalWidth;
        this.ih = imageObj.img.naturalHeight;
        this.frame = { fx: 0, fy: 0, fw: this.iw, fh: this.ih };
        this.dragEdge = null;
        this.dragLabel = '';
        this.dirty = false;
        this.confirmEl.hidden = true;
        this._updateMsg();

        this.overlayEl.style.display = 'flex';
        // 舞台尺寸在可见后才能测量，下一帧再初始化画布与视图
        requestAnimationFrame(() => {
            this._resizeCanvas();
            this.fitView();
            this._draw();
        });
    }

    close() {
        this.overlayEl.style.display = 'none';
        this.image = null;
        this.dragEdge = null;
    }

    /** 关闭请求：画幅偏离初始（未保存）时先确认 */
    requestClose() {
        if (this.dirty) {
            this.confirmEl.hidden = false;
            return;
        }
        this.close();
    }

    /** 还原：画幅重置为原图尺寸并重新适应视图 */
    resetFrame() {
        this.frame = { fx: 0, fy: 0, fw: this.iw, fh: this.ih };
        this.dirty = false;
        this.dragLabel = '';
        this._updateMsg();
        this.fitView();
        this._draw();
    }

    /**
     * 适应屏幕：整个画幅完整可见并居中（打开时与「适应屏幕」按钮用）。
     * 拖拽锚点时不调用——视图固定，图片在屏幕上纹丝不动
     */
    fitView() {
        const m = ImageOutpaint.FIT_MARGIN;
        const z = Math.min(
            (this.viewW - m * 2) / this.frame.fw,
            (this.viewH - m * 2) / this.frame.fh
        );
        this.zoom = Math.max(0.01, Math.min(8, z));
        this.vcx = this.frame.fx + this.frame.fw / 2;
        this.vcy = this.frame.fy + this.frame.fh / 2;
        this._updateZoomPill();
        this._draw();
    }

    /** 设置缩放比：锚定舞台中心（该点文档坐标不变），范围 5% ~ 1600% */
    setZoom(zoom) {
        this.zoom = Math.min(16, Math.max(0.05, zoom));
        this._clampPan();
        this._updateZoomPill();
        this._draw();
    }

    /** 滚轮/触控板捏合缩放（与画笔灯箱同系数） */
    _onWheel(e) {
        if (!this.image) return;
        e.preventDefault();
        const factor = Math.pow(1.0015, -e.deltaY);
        this.setZoom(this.zoom * factor);
    }

    // ==================== 视图平移（中键拖拽，移植画笔灯箱） ====================

    _onStagePointerDown(e) {
        if (!this.image || e.button !== 1) return;   // 仅中键平移
        e.preventDefault();
        this.panning = true;
        this._panLast = { x: e.clientX, y: e.clientY };
        try { this.stageEl.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
        this.overlayEl.classList.add('panning');
    }

    _onStagePointerMove(e) {
        if (!this.panning) return;
        // 平移量换算到文档坐标（除以缩放），视图中心反向移动
        this.vcx -= (e.clientX - this._panLast.x) / this.zoom;
        this.vcy -= (e.clientY - this._panLast.y) / this.zoom;
        this._panLast = { x: e.clientX, y: e.clientY };
        this._clampPan();
        this._draw();
    }

    _onStagePointerUp() {
        if (!this.panning) return;
        this.panning = false;
        this.overlayEl.classList.remove('panning');
    }

    /**
     * 平移可见性夹取：画幅至少 80px 留在舞台内，防止拖丢
     *（与画笔灯箱 _applyTransform 的夹取同一思路）
     */
    _clampPan() {
        const f = this.frame;
        const half = { w: (f.fw * this.zoom) / 2, h: (f.fh * this.zoom) / 2 };
        const marginX = Math.min(80, half.w);
        const marginY = Math.min(80, half.h);
        const cx = f.fx + f.fw / 2, cy = f.fy + f.fh / 2;
        const rangeX = this.viewW / 2 + half.w - marginX;
        const rangeY = this.viewH / 2 + half.h - marginY;
        this.vcx = cx + Math.max(-rangeX, Math.min(rangeX, this.vcx - cx));
        this.vcy = cy + Math.max(-rangeY, Math.min(rangeY, this.vcy - cy));
    }

    _updateZoomPill() {
        if (this.zoomPill) this.zoomPill.textContent = `${Math.round(this.zoom * 100)}%`;
    }

    // ==================== 视图与坐标 ====================

    _resizeCanvas() {
        const dpr = window.devicePixelRatio || 1;
        const rect = this.stageEl.getBoundingClientRect();
        this.viewW = Math.max(1, rect.width);
        this.viewH = Math.max(1, rect.height);
        this.canvasEl.width = Math.round(this.viewW * dpr);
        this.canvasEl.height = Math.round(this.viewH * dpr);
        this.canvasEl.style.width = this.viewW + 'px';
        this.canvasEl.style.height = this.viewH + 'px';
        this.dpr = dpr;
    }

    /** 文档坐标 → 舞台坐标（以视图中心 vcx/vcy 为基准） */
    _toScreen(docX, docY) {
        return {
            x: this.viewW / 2 + (docX - this.vcx) * this.zoom,
            y: this.viewH / 2 + (docY - this.vcy) * this.zoom
        };
    }

    /** 舞台坐标 → 文档坐标 */
    _toDoc(screenX, screenY) {
        return {
            x: (screenX - this.viewW / 2) / this.zoom + this.vcx,
            y: (screenY - this.viewH / 2) / this.zoom + this.vcy
        };
    }

    // ==================== 画幅约束 ====================

    /**
     * 按拖拽边更新画幅（含全部钳制）：
     *   - 边长 ∈ [64, 8192]；
     *   - 框与原图的可见交集每轴 ≥ 64px（不允许把图完全裁没）。
     * @param {'left'|'right'|'top'|'bottom'} edge - 被拖拽的边
     * @param {number} pos - 鼠标的文档坐标（该边目标位置）
     */
    _applyEdge(edge, pos) {
        const f = this.frame;
        const MIN = ImageOutpaint.MIN_DIM;
        const MAX = ImageOutpaint.MAX_DIM;
        const V = ImageOutpaint.MIN_VISIBLE;
        if (edge === 'left' || edge === 'right') {
            const right = f.fx + f.fw;
            if (edge === 'left') {
                // 左边：右缘不动。钳制：最小/最大边长 + 原图左右各留 ≥V 可见
                f.fx = Math.max(
                    Math.max(right - MAX, V - right),
                    Math.min(pos, Math.min(right - MIN, this.iw - V))
                );
                f.fw = right - f.fx;
            } else {
                // 右边：左缘不动（fx ≤ iw-V 是不变量，保证左留 ≥V）
                f.fw = Math.max(MIN, Math.min(MAX, pos - f.fx));
            }
        } else {
            const bottom = f.fy + f.fh;
            if (edge === 'top') {
                f.fy = Math.max(
                    Math.max(bottom - MAX, V - bottom),
                    Math.min(pos, Math.min(bottom - MIN, this.ih - V))
                );
                f.fh = bottom - f.fy;
            } else {
                f.fh = Math.max(MIN, Math.min(MAX, pos - f.fy));
            }
        }
    }

    // ==================== 指针交互 ====================

    /** 四边中点锚点的屏幕坐标与命中框 */
    _anchorPoints() {
        const f = this.frame;
        return [
            { edge: 'left',   x: f.fx,            y: f.fy + f.fh / 2 },
            { edge: 'right',  x: f.fx + f.fw,     y: f.fy + f.fh / 2 },
            { edge: 'top',    x: f.fx + f.fw / 2, y: f.fy },
            { edge: 'bottom', x: f.fx + f.fw / 2, y: f.fy + f.fh }
        ].map(a => ({ ...a, s: this._toScreen(a.x, a.y) }));
    }

    _hitAnchor(screenX, screenY) {
        for (const a of this._anchorPoints()) {
            const dx = screenX - a.s.x, dy = screenY - a.s.y;
            if (dx * dx + dy * dy <= ImageOutpaint.HIT_R * ImageOutpaint.HIT_R) return a.edge;
        }
        return null;
    }

    _onPointerDown(e) {
        if (e.button !== 0) return;
        const rect = this.canvasEl.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        const edge = this._hitAnchor(sx, sy);
        if (!edge) return;
        e.preventDefault();
        this.dragEdge = edge;
        // 指针捕获保证拖出画布仍收得到 move；合成事件/无活动指针时可能抛错，忽略即可
        try { this.canvasEl.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
        this._dragTo(sx, sy);
    }

    _onPointerMove(e) {
        const rect = this.canvasEl.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        if (this.dragEdge) {
            this._dragTo(sx, sy);
            return;
        }
        // 悬停反馈：锚点上方换尺寸调整光标
        const edge = this._hitAnchor(sx, sy);
        this.canvasEl.style.cursor =
            edge === 'left' || edge === 'right' ? 'ew-resize' :
            edge === 'top' || edge === 'bottom' ? 'ns-resize' : 'default';
    }

    _onPointerUp() {
        this.dragEdge = null;
    }

    /** 拖拽中：把被拖边移到鼠标位置（钳制后）重绘。
     *  视图固定不动——图片在屏幕上保持原位，扩展区向鼠标方向生长 */
    _dragTo(sx, sy) {
        const doc = this._toDoc(sx, sy);
        this._applyEdge(this.dragEdge, this.dragEdge === 'left' || this.dragEdge === 'right' ? doc.x : doc.y);
        this.dirty = true;
        const f = this.frame;
        this.dragLabel = (this.dragEdge === 'left' || this.dragEdge === 'right')
            ? `W：${Math.round(f.fw)} 像素`
            : `H：${Math.round(f.fh)} 像素`;
        this._updateMsg();
        this._draw();
    }

    _updateMsg() {
        const f = this.frame;
        this.msgEl.textContent =
            `原图 ${this.iw}×${this.ih} ｜ 当前 ${Math.round(f.fw)}×${Math.round(f.fh)}`;
    }

    // ==================== 渲染 ====================

    _draw() {
        const ctx = this.ctx;
        const dpr = this.dpr || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, this.viewW, this.viewH);
        if (!this.image) return;

        const f = this.frame;
        const tl = this._toScreen(f.fx, f.fy);
        const sw = f.fw * this.zoom, sh = f.fh * this.zoom;

        // 画幅内容（白色底 + 原图），裁剪到框内——内收裁剪时框外部分不可见
        ctx.save();
        ctx.beginPath();
        ctx.rect(tl.x, tl.y, sw, sh);
        ctx.clip();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(tl.x, tl.y, sw, sh);
        const origin = this._toScreen(0, 0);
        ctx.drawImage(this.image.img, origin.x, origin.y, this.iw * this.zoom, this.ih * this.zoom);

        // 三分网格（灰色细线，白底与图上都可辨）
        ctx.strokeStyle = 'rgba(128, 128, 128, 0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 1; i <= 2; i++) {
            const gx = tl.x + (sw * i) / 3;
            const gy = tl.y + (sh * i) / 3;
            ctx.moveTo(gx, tl.y); ctx.lineTo(gx, tl.y + sh);
            ctx.moveTo(tl.x, gy); ctx.lineTo(tl.x + sw, gy);
        }
        ctx.stroke();
        ctx.restore();

        // 画幅边框（与画布选中框同款青色）
        ctx.strokeStyle = '#6cebff';
        ctx.lineWidth = 1.7;
        ctx.strokeRect(tl.x, tl.y, sw, sh);

        // 四边中点锚点（白圆 + 青描边，屏幕尺寸恒定）
        for (const a of this._anchorPoints()) {
            ctx.beginPath();
            ctx.arc(a.s.x, a.s.y, ImageOutpaint.ANCHOR_R, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.strokeStyle = '#6cebff';
            ctx.lineWidth = 1.7;
            ctx.stroke();
        }

        // 拖拽中的尺寸标签（黑底白字圆角，浮在活动边外侧——同尺寸标签观感）
        if (this.dragLabel && this.dragEdge) {
            const vertical = this.dragEdge === 'left' || this.dragEdge === 'right';
            ctx.font = '12px system-ui, sans-serif';
            const textW = ctx.measureText(this.dragLabel).width;
            const padX = 8, padY = 5;
            const boxW = textW + padX * 2, boxH = 12 + padY * 2;
            const bx = vertical
                ? tl.x + sw + 16
                : tl.x + sw / 2 - boxW / 2;
            const by = vertical
                ? tl.y + sh / 2 - boxH / 2
                : tl.y + sh + 16;
            ctx.fillStyle = 'rgba(20, 21, 26, 0.9)';
            ctx.beginPath();
            ctx.roundRect(bx, by, boxW, boxH, 5);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.textBaseline = 'middle';
            ctx.fillText(this.dragLabel, bx + padX, by + boxH / 2 + 1);
        }
    }

    // ==================== 保存 ====================

    /** 按画幅原始分辨率导出（白底 + 原图偏移绘制），作为新图事件交画布落地 */
    save() {
        if (!this.image) return;
        const f = this.frame;
        const out = document.createElement('canvas');
        out.width = Math.round(f.fw);
        out.height = Math.round(f.fh);
        const g = out.getContext('2d');
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, out.width, out.height);
        g.drawImage(this.image.img, -f.fx, -f.fy);
        window.dispatchEvent(new CustomEvent('outpaintComplete', {
            detail: { originalImage: this.image, imageDataUrl: out.toDataURL('image/png') }
        }));
        this.close();
    }
}

// 暴露到全局作用域
window.ImageOutpaint = ImageOutpaint;
