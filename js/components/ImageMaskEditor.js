/**
 * ==========================================================================
 * LumenLight 画布图片遮罩编辑器（遮罩灯箱）
 * ==========================================================================
 * 作用：图片工具栏「编辑 → 遮罩」进入的全屏灯箱，在图片上涂抹局部重绘
 *       遮罩。与画笔灯箱（ImageEditor）的本质区别：遮罩是元数据不是装饰
 *       图层——它标记"重绘哪些区域"，绝不写回原图：
 *   - 双层画布：底层原图（等比缩放适配屏幕），上层为遮罩层（与原图同
 *     分辨率）——遮罩笔迹以全强度红色存储，显示层固定半透明（惯例的
 *     "半透明红"观感，又能看清涂了哪里）；
 *   - 工具：画笔（涂遮罩）/ 橡皮（擦除）/ 还原（清空全部）/ 粗细滑块。
 *     无色块与透明度滑块——遮罩只有一种语义，半透明遮罩会产生灰阶，
 *     让重绘边界模糊，所以显示透明度固定、数据永远全强度；
 *   - 图层挂原图：遮罩层以 data URL 挂在图片对象上（image.mask /
 *     maskImg），非破坏性、重开可继续编辑、随实时保存进存档；
 *   - 自动传递：Comfy 生图节点提交时（ImagePipeline，bakeMask 开启），
 *     带遮罩的槽位图导出为 RGBA PNG——遮罩区域 alpha=0（透明=重绘区，
 *     Comfy 标准约定），由 From Canvas 节点的 mask 输出交给 inpaint
 *     工作流。原图与画笔笔迹不受任何影响。
 * 坐标系：屏幕坐标 ÷ 缩放比 = 原图坐标（与画笔灯箱一致）。
 * 对应组件：js/components/ImageToolbar.js（入口）、css/image-editor.css
 * ==========================================================================
 */

class ImageMaskEditor {
    /** 遮罩笔迹颜色（全强度存储；显示层经 CSS 固定半透明） */
    static MASK_COLOR = '#ff0000';
    static MIN_SIZE = 2;          // 笔刷粗细下限（原图像素）
    static MAX_SIZE = 120;        // 上限比画笔宽：涂抹区域通常成片
    /** 遮罩判定阈值：alpha 高于此值的像素视为重绘区 */
    static ALPHA_THRESHOLD = 127;

    /**
     * @param {Object} canvas - 画布实例（保存写回后触发重绘用）
     */
    constructor(canvas) {
        this.canvas = canvas;
        this.image = null;        // 当前编辑的画布图片对象（{img, ...}）
        this.tool = 'brush';      // 'brush' | 'eraser'
        this.size = 40;           // 笔刷粗细（原图像素）
        this.drawing = false;
        this.last = null;
        this.dirty = false;       // 遮罩层是否有未保存修改
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.panning = false;

        this._buildDom();
    }

    // ==================== DOM 构建（一次性） ====================

    _buildDom() {
        this.overlayEl = document.createElement('div');
        this.overlayEl.className = 'image-editor';

        // ---- 顶栏 ----
        const topbar = document.createElement('div');
        topbar.className = 'image-editor-topbar';

        const title = document.createElement('span');
        title.className = 'ie-size-label';
        title.textContent = '遮罩 · 局部重绘';
        title.style.fontSize = '13px';

        // 工具组：画笔 / 橡皮 / 还原
        const tools = document.createElement('div');
        tools.className = 'ie-group';
        this.brushBtn = this._makeToolBtn('画笔（涂遮罩）', 'M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z', 'brush');
        this.eraserBtn = this._makeToolBtn('橡皮（擦除遮罩）', 'm7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21M22 21H7m-2-10 9 9', 'eraser');
        const revertBtn = document.createElement('button');
        revertBtn.className = 'ie-tool-btn';
        revertBtn.title = '还原（清空全部遮罩）';
        revertBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>`;
        revertBtn.addEventListener('click', () => this.revert());
        tools.append(this.brushBtn, this.eraserBtn, revertBtn);

        // 粗细滑块（原图像素）
        const sizeBox = document.createElement('div');
        sizeBox.className = 'ie-group ie-size';
        const sizeLabel = document.createElement('span');
        sizeLabel.className = 'ie-size-label';
        sizeLabel.textContent = '粗细';
        this.sizeSlider = document.createElement('input');
        this.sizeSlider.type = 'range';
        this.sizeSlider.min = ImageMaskEditor.MIN_SIZE;
        this.sizeSlider.max = ImageMaskEditor.MAX_SIZE;
        this.sizeSlider.value = this.size;
        this.sizeValueEl = document.createElement('span');
        this.sizeValueEl.className = 'ie-size-value';
        this.sizeValueEl.textContent = this.size;
        this.sizeSlider.addEventListener('input', () => {
            this.size = Number(this.sizeSlider.value);
            this.sizeValueEl.textContent = this.size;
            this._updateCursor();
        });
        sizeBox.append(sizeLabel, this.sizeSlider, this.sizeValueEl);

        // 右侧：状态提示 / 保存 / 关闭
        this.msgEl = document.createElement('span');
        this.msgEl.className = 'ie-msg';
        const saveBtn = document.createElement('button');
        saveBtn.className = 'ie-save-btn';
        saveBtn.textContent = '保存';
        saveBtn.title = '遮罩挂到图片上：提交 Comfy 局部重绘时自动随图传递';
        saveBtn.addEventListener('click', () => this.save());
        const closeBtn = document.createElement('button');
        closeBtn.className = 'ie-close-btn';
        closeBtn.title = '关闭';
        closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
        closeBtn.addEventListener('click', () => this.requestClose());

        topbar.append(title, tools, sizeBox, this.msgEl, saveBtn, closeBtn);

        // ---- 画布区：双层画布（滚轮缩放 + 中键拖拽平移，与画笔灯箱一致） ----
        const stage = document.createElement('div');
        stage.className = 'image-editor-stage';
        this.stageEl = stage;
        this.wrapEl = document.createElement('div');
        this.wrapEl.className = 'ie-canvas-wrap';
        this.baseCanvas = document.createElement('canvas');
        this.baseCanvas.className = 'ie-base';
        this.maskCanvas = document.createElement('canvas');
        this.maskCanvas.className = 'ie-strokes ie-mask-strokes';
        this.wrapEl.append(this.baseCanvas, this.maskCanvas);
        stage.appendChild(this.wrapEl);

        // ---- 左下角缩放指示 ----
        const zoomCtrl = document.createElement('div');
        zoomCtrl.className = 'ie-zoomctrl';
        const fitBtn = document.createElement('button');
        fitBtn.className = 'ie-fit-btn';
        fitBtn.title = '缩放至适应屏幕';
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

        // ---- 笔刷光标与丢弃确认框 ----
        this.cursorEl = document.createElement('div');
        this.cursorEl.className = 'ie-cursor';
        this.confirmEl = document.createElement('div');
        this.confirmEl.className = 'ie-confirm';
        this.confirmEl.hidden = true;
        this.confirmEl.innerHTML = `
            <div class="ie-confirm-text">有未保存的遮罩，确定丢弃吗？</div>
            <div class="ie-confirm-btns">
                <button type="button" class="ie-confirm-cancel">继续编辑</button>
                <button type="button" class="ie-confirm-discard">丢弃更改</button>
            </div>`;
        this.confirmEl.querySelector('.ie-confirm-cancel')
            .addEventListener('click', () => { this.confirmEl.hidden = true; });
        this.confirmEl.querySelector('.ie-confirm-discard')
            .addEventListener('click', () => { this.confirmEl.hidden = true; this.close(); });

        this.overlayEl.append(topbar, stage, zoomCtrl, this.cursorEl, this.confirmEl);
        this.overlayEl.style.display = 'none';
        document.body.appendChild(this.overlayEl);

        this._bindEvents();
    }

    /** 顶部工具按钮（画笔/橡皮），点击切换并高亮 */
    _makeToolBtn(title, iconPath, tool) {
        const btn = document.createElement('button');
        btn.className = 'ie-tool-btn' + (tool === this.tool ? ' active' : '');
        btn.title = title;
        btn.dataset.tool = tool;
        btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${iconPath}"></path></svg>`;
        btn.addEventListener('click', () => this.setTool(tool));
        return btn;
    }

    _bindEvents() {
        // 遮罩层指针事件（与画笔灯箱同款：pointer events 统一输入）
        this.maskCanvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
        this.maskCanvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
        this.maskCanvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
        this.maskCanvas.addEventListener('pointercancel', (e) => this._onPointerUp(e));
        this.maskCanvas.addEventListener('pointerleave', () => this._hideCursor());
        this.maskCanvas.addEventListener('pointerenter', () => this._updateCursor());
        this.maskCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

        this.maskCanvas.addEventListener('pointermove', (e) => {
            this.cursorEl.style.left = e.clientX + 'px';
            this.cursorEl.style.top = e.clientY + 'px';
        });

        this.stageEl.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
        this.stageEl.addEventListener('mousedown', (e) => {
            if (e.button === 1) e.preventDefault();
        });
        this.stageEl.addEventListener('pointerdown', (e) => this._onStagePointerDown(e));
        this.stageEl.addEventListener('pointermove', (e) => this._onStagePointerMove(e));
        this.stageEl.addEventListener('pointerup', (e) => this._onStagePointerUp(e));
        this.stageEl.addEventListener('pointercancel', (e) => this._onStagePointerUp(e));

        window.addEventListener('resize', () => { if (this.isOpen()) this._applyTransform(); });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen()) this.requestClose();
        });
    }

    // ==================== 打开 / 关闭 ====================

    /**
     * 打开编辑器
     * @param {Object} imageObj - 画布图片对象（ImageToolbar.selectedImages[0]）
     */
    open(imageObj) {
        if (!imageObj?.img) return;
        this.image = imageObj;
        this.tool = 'brush';
        this.drawing = false;
        this.dirty = false;
        this.confirmEl.hidden = true;
        this.msgEl.textContent = '';
        this.brushBtn.classList.add('active');
        this.eraserBtn.classList.remove('active');

        // 原图层按图片原生分辨率铺底
        const natW = imageObj.img.naturalWidth;
        const natH = imageObj.img.naturalHeight;
        this.baseCanvas.width = natW;
        this.baseCanvas.height = natH;
        this.baseCanvas.getContext('2d').drawImage(imageObj.img, 0, 0);
        // 遮罩层同分辨率，打开时清空（显示透明度走 CSS 固定值，不提供滑块）
        this.maskCanvas.width = natW;
        this.maskCanvas.height = natH;

        // 已有遮罩层画回——可继续涂画/擦除/还原。就绪门闩与画笔灯箱同款：
        // 位图未加载完前禁止落笔/保存，防止在空画布上保存出空遮罩
        this._maskReadyDone = false;
        this._maskReady = new Promise((resolve) => { this._maskReadyResolve = resolve; });
        const existing = imageObj.maskImg;
        if (existing && existing.complete && existing.naturalWidth) {
            this.maskCtx.drawImage(existing, 0, 0);
            this._maskReadyDone = true;
            this._maskReadyResolve();
        } else if (imageObj.mask) {
            const loader = new Image();
            loader.onload = () => {
                if (this.image === imageObj) {
                    imageObj.maskImg = loader;
                    this.maskCtx.drawImage(loader, 0, 0);
                }
                this._maskReadyDone = true;
                this._maskReadyResolve();
            };
            loader.onerror = () => {
                this._maskReadyDone = true;
                this._maskReadyResolve();
            };
            loader.src = imageObj.mask;
        } else {
            this._maskReadyDone = true;
            this._maskReadyResolve();
        }

        this.overlayEl.style.display = 'flex';
        this.fitView();
    }

    /** 适应屏幕：与画笔灯箱同款 */
    fitView() {
        if (!this.image || !this.baseCanvas.width) return;
        const natW = this.baseCanvas.width;
        const natH = this.baseCanvas.height;
        const availW = this.stageEl.clientWidth - 48;
        const availH = this.stageEl.clientHeight - 48;
        this.zoom = Math.min(availW / natW, availH / natH, 1);
        this.panX = 0;
        this.panY = 0;
        this._applyTransform();
    }

    /** 设置缩放比：固定图像中心原地缩放 */
    setZoom(zoom) {
        this.zoom = Math.min(16, Math.max(0.05, zoom));
        this._applyTransform();
    }

    _onWheel(e) {
        if (!this.image) return;
        e.preventDefault();
        const factor = Math.pow(1.0015, -e.deltaY);
        this.setZoom(this.zoom * factor);
    }

    // ==================== 视图平移（中键拖拽） ====================

    _onStagePointerDown(e) {
        if (!this.image || e.button !== 1) return;
        e.preventDefault();
        this.panning = true;
        this._panLast = { x: e.clientX, y: e.clientY };
        this.stageEl.setPointerCapture(e.pointerId);
        this.overlayEl.classList.add('panning');
    }

    _onStagePointerMove(e) {
        if (!this.panning) return;
        this.panX += e.clientX - this._panLast.x;
        this.panY += e.clientY - this._panLast.y;
        this._panLast = { x: e.clientX, y: e.clientY };
        this._applyTransform();
    }

    _onStagePointerUp() {
        if (!this.panning) return;
        this.panning = false;
        this.overlayEl.classList.remove('panning');
    }

    /** 应用变换（与画笔灯箱同款几何：夹取平移防拖丢） */
    _applyTransform() {
        if (!this.stageEl) return;
        const w = Math.round(this.baseCanvas.width * this.zoom);
        const h = Math.round(this.baseCanvas.height * this.zoom);
        const stageW = this.stageEl.clientWidth;
        const stageH = this.stageEl.clientHeight;
        const marginX = Math.min(80, w);
        const marginY = Math.min(80, h);
        const maxPanX = stageW / 2 - marginX + w / 2;
        const minPanX = -stageW / 2 + marginX - w / 2;
        this.panX = Math.min(maxPanX, Math.max(minPanX, this.panX));
        const maxPanY = stageH / 2 - marginY + h / 2;
        const minPanY = -stageH / 2 + marginY - h / 2;
        this.panY = Math.min(maxPanY, Math.max(minPanY, this.panY));

        this.wrapEl.style.width = w + 'px';
        this.wrapEl.style.height = h + 'px';
        this.wrapEl.style.left = Math.round(stageW / 2 + this.panX - w / 2) + 'px';
        this.wrapEl.style.top = Math.round(stageH / 2 + this.panY - h / 2) + 'px';
        if (this.zoomPill) this.zoomPill.textContent = Math.round(this.zoom * 100) + '%';
        this._updateCursor();
    }

    isOpen() {
        return this.overlayEl.style.display !== 'none';
    }

    close() {
        this.overlayEl.style.display = 'none';
        this.image = null;
        this.dirty = false;
        this.drawing = false;
        this._hideCursor();
    }

    /** 关闭请求：有未保存遮罩时先弹丢弃确认 */
    requestClose() {
        if (this.dirty) {
            this.confirmEl.hidden = false;
            return;
        }
        this.close();
    }

    // ==================== 工具状态 ====================

    setTool(tool) {
        this.tool = tool;
        this.brushBtn.classList.toggle('active', tool === 'brush');
        this.eraserBtn.classList.toggle('active', tool === 'eraser');
        this._updateCursor();
    }

    revert() {
        this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
        this.dirty = false;
    }

    // ==================== 绘制 ====================

    _onPointerDown(e) {
        if (e.button !== 0 || !this.image) return;
        if (!this._maskReadyDone) return;   // 既有遮罩层加载完成前禁止落笔
        e.preventDefault();
        this.maskCanvas.setPointerCapture(e.pointerId);
        this.drawing = true;
        const pos = this._toImagePos(e);
        this.last = pos;
        this._strokeSegment(pos, pos);
        this.dirty = true;
    }

    _onPointerMove(e) {
        if (!this.drawing) return;
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of events) {
            const pos = this._toImagePos(ev);
            this._strokeSegment(this.last, pos);
            this.last = pos;
        }
    }

    _onPointerUp() {
        this.drawing = false;
        this.last = null;
    }

    /** 屏幕坐标 → 原图坐标（与画笔灯箱一致） */
    _toImagePos(e) {
        const rect = this.maskCanvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) / this.zoom,
            y: (e.clientY - rect.top) / this.zoom
        };
    }

    /** 在遮罩层画一段笔迹：画笔叠加遮罩色，橡皮 destination-out 擦除 */
    _strokeSegment(from, to) {
        const ctx = this.maskCtx;
        ctx.globalCompositeOperation = this.tool === 'eraser' ? 'destination-out' : 'source-over';
        ctx.strokeStyle = ImageMaskEditor.MASK_COLOR;
        ctx.fillStyle = ImageMaskEditor.MASK_COLOR;
        ctx.lineWidth = this.size;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
        if (from.x === to.x && from.y === to.y) {
            ctx.beginPath();
            ctx.arc(to.x, to.y, this.size / 2, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
    }

    get maskCtx() {
        return this.maskCanvas.getContext('2d');
    }

    // ==================== 光标 ====================

    /** 光标圆圈直径 = 笔刷粗细 × 屏幕缩放比；橡皮用虚线圈区分 */
    _updateCursor() {
        const d = Math.max(4, this.size * this.zoom);
        this.cursorEl.style.width = d + 'px';
        this.cursorEl.style.height = d + 'px';
        this.cursorEl.style.border = this.tool === 'eraser'
            ? '1px dashed rgba(255,255,255,0.9)'
            : '1px solid rgba(255,255,255,0.9)';
        this.cursorEl.style.display = 'block';
    }

    _hideCursor() {
        this.cursorEl.style.display = 'none';
    }

    // ==================== 保存 ====================

    /**
     * 保存：遮罩层单独导出为 data URL 挂到图片对象上（image.mask / maskImg）
     * ——非破坏性：原图与画笔笔迹都不动，画布渲染不受影响；重新进入可继续
     * 编辑。Comfy 生图节点提交时由 ImagePipeline 把遮罩烘进槽位图 alpha
     * 通道（透明=重绘区）自动传递。写回后走 draw()（watcher hook）触发
     * 实时保存
     */
    save() {
        if (!this.image) return;
        // 既有遮罩层未加载完时等待，防覆盖（与画笔灯箱同款防呆）
        this._maskReady.then(() => {
            if (!this.image) return;
            const imgObj = this.image;
            const dataURL = this.maskCanvas.toDataURL('image/png');
            imgObj.mask = dataURL;
            const layer = new Image();
            layer.onload = () => {
                imgObj.maskImg = layer;
                this.canvas?.draw();   // 走 watcher hook：重绘 + 自动保存调度
            };
            layer.src = dataURL;

            this.close();
        });
    }
}

// 暴露到全局作用域
window.ImageMaskEditor = ImageMaskEditor;
