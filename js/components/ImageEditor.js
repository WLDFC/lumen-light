/**
 * ==========================================================================
 * LumenLight 画布图片编辑器（画笔灯箱）
 * ==========================================================================
 * 作用：图片工具栏「编辑 → 画笔」进入的全屏编辑灯箱，在图片上用画笔涂画：
 *   - 双层画布：底层为原图（等比缩放适配屏幕），上层为"笔画层"（与原图
 *     同分辨率）——笔迹与原图分离，橡皮以 destination-out 擦除笔迹露出原图；
 *   - 顶栏：画笔 / 橡皮 / 还原（清空全部笔迹）/ 粗细滑块（原图像素）/
 *     8 色色块 / 保存（合成写回原图并关闭）/ 关闭（有未保存笔迹时确认丢弃）；
 *   - 光标：跟随圆圈实时预览笔刷直径（原图像素 × 屏幕缩放比）；
 *   - 保存：原图 + 笔画层合成导出 PNG dataURL，一次性 onload 后触发画布
 *     重绘——实时保存按内容哈希自动同步，存档系统零感知。
 * 坐标系：屏幕坐标 ÷ 缩放比 = 原图坐标；缩放比 = 显示尺寸 ÷ 原始尺寸。
 * 对应组件：js/components/ImageToolbar.js（入口）、css/image-editor.css
 * ==========================================================================
 */

class ImageEditor {
    /** 预设色块（用户指定：红/黑/白/粉红/蓝/橙/浅蓝/绿） */
    static COLORS = [
        { name: '红', value: '#ef4444' },
        { name: '黑', value: '#000000' },
        { name: '白', value: '#ffffff' },
        { name: '粉红', value: '#f472b6' },
        { name: '蓝', value: '#3b82f6' },
        { name: '橙', value: '#f97316' },
        { name: '浅蓝', value: '#7dd3fc' },
        { name: '绿', value: '#22c55e' }
    ];
    static MIN_SIZE = 2;          // 笔刷粗细下限（原图像素）
    static MAX_SIZE = 80;         // 笔刷粗细上限

    /**
     * @param {Object} canvas - 画布实例（保存写回后触发重绘用）
     */
    constructor(canvas) {
        this.canvas = canvas;
        this.image = null;        // 当前编辑的画布图片对象（{img, ...}）
        this.tool = 'brush';      // 'brush' | 'eraser'
        this.color = ImageEditor.COLORS[0].value;
        this.size = 14;           // 笔刷粗细（原图像素）
        this.drawing = false;     // 指针按下绘制中
        this.last = null;         // 上一指针位置（原图坐标）
        this.dirty = false;       // 笔画层是否有未保存笔迹
        this.zoom = 1;            // 缩放比：原图像素 → 屏幕像素（100% = 1:1）
        this.panX = 0;            // 视图平移偏移（px，相对舞台中心；中键拖拽改变）
        this.panY = 0;
        this.panning = false;     // 中键拖拽平移中

        this._buildDom();
    }

    // ==================== DOM 构建（一次性） ====================

    _buildDom() {
        // 遮罩层（灯箱式全屏）
        this.overlayEl = document.createElement('div');
        this.overlayEl.className = 'image-editor';

        // ---- 顶栏 ----
        const topbar = document.createElement('div');
        topbar.className = 'image-editor-topbar';

        // 工具组：画笔 / 橡皮
        const tools = document.createElement('div');
        tools.className = 'ie-group';
        this.brushBtn = this._makeToolBtn('画笔', 'M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z', 'brush');
        this.eraserBtn = this._makeToolBtn('橡皮', 'm7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21M22 21H7m-2-10 9 9', 'eraser');
        tools.append(this.brushBtn, this.eraserBtn);

        // 还原：清空全部笔迹
        const revertBtn = document.createElement('button');
        revertBtn.className = 'ie-tool-btn';
        revertBtn.title = '还原（清空全部笔迹）';
        revertBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>`;
        revertBtn.addEventListener('click', () => this.revert());
        tools.appendChild(revertBtn);

        // 色块组
        const colors = document.createElement('div');
        colors.className = 'ie-group ie-colors';
        this.swatchEls = ImageEditor.COLORS.map((c, i) => {
            const sw = document.createElement('button');
            sw.className = 'ie-swatch' + (i === 0 ? ' active' : '');
            sw.style.background = c.value;
            sw.title = c.name;
            sw.addEventListener('click', () => this.setColor(c.value, sw));
            colors.appendChild(sw);
            return sw;
        });

        // 粗细滑块（原图像素）
        const sizeBox = document.createElement('div');
        sizeBox.className = 'ie-group ie-size';
        const sizeLabel = document.createElement('span');
        sizeLabel.className = 'ie-size-label';
        sizeLabel.textContent = '粗细';
        this.sizeSlider = document.createElement('input');
        this.sizeSlider.type = 'range';
        this.sizeSlider.min = ImageEditor.MIN_SIZE;
        this.sizeSlider.max = ImageEditor.MAX_SIZE;
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

        // 透明度滑块：控制笔迹画布层的透明度（原图保持不动，
        // 调淡画布可与原图对照笔迹位置；保存始终按笔迹全强度合成）
        const opacityBox = document.createElement('div');
        opacityBox.className = 'ie-group ie-size';
        const opacityLabel = document.createElement('span');
        opacityLabel.className = 'ie-size-label';
        opacityLabel.textContent = '透明度';
        this.opacitySlider = document.createElement('input');
        this.opacitySlider.type = 'range';
        this.opacitySlider.min = 0;
        this.opacitySlider.max = 100;
        this.opacitySlider.value = 100;
        this.opacityValueEl = document.createElement('span');
        this.opacityValueEl.className = 'ie-size-value';
        this.opacityValueEl.textContent = '100';
        this.opacitySlider.addEventListener('input', () => {
            const v = Number(this.opacitySlider.value);
            this.opacityValueEl.textContent = v;
            this.strokesCanvas.style.opacity = v / 100;
        });
        opacityBox.append(opacityLabel, this.opacitySlider, this.opacityValueEl);

        // 右侧：状态提示 / 保存 / 关闭
        this.msgEl = document.createElement('span');
        this.msgEl.className = 'ie-msg';
        const saveBtn = document.createElement('button');
        saveBtn.className = 'ie-save-btn';
        saveBtn.textContent = '保存';
        saveBtn.title = '合成笔迹并写回画布原图';
        saveBtn.addEventListener('click', () => this.save());
        const closeBtn = document.createElement('button');
        closeBtn.className = 'ie-close-btn';
        closeBtn.title = '关闭';
        closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
        closeBtn.addEventListener('click', () => this.requestClose());

        topbar.append(tools, colors, sizeBox, opacityBox, this.msgEl, saveBtn, closeBtn);

        // ---- 画布区：双层画布（滚轮缩放 + 空格/中键拖拽平移） ----
        const stage = document.createElement('div');
        stage.className = 'image-editor-stage';
        this.stageEl = stage;
        this.wrapEl = document.createElement('div');
        this.wrapEl.className = 'ie-canvas-wrap';
        this.baseCanvas = document.createElement('canvas');
        this.baseCanvas.className = 'ie-base';
        this.strokesCanvas = document.createElement('canvas');
        this.strokesCanvas.className = 'ie-strokes';
        this.wrapEl.append(this.baseCanvas, this.strokesCanvas);
        stage.appendChild(this.wrapEl);

        // ---- 左下角缩放指示（与主画布左下角同款：适应屏幕 + 百分比） ----
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

        // ---- 笔刷光标（跟随圆圈）与丢弃确认框 ----
        this.cursorEl = document.createElement('div');
        this.cursorEl.className = 'ie-cursor';
        this.confirmEl = document.createElement('div');
        this.confirmEl.className = 'ie-confirm';
        this.confirmEl.hidden = true;
        this.confirmEl.innerHTML = `
            <div class="ie-confirm-text">有未保存的笔迹，确定丢弃吗？</div>
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
        // 笔画层指针事件（pointer events 统一鼠标/触屏/手写笔）
        this.strokesCanvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
        this.strokesCanvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
        this.strokesCanvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
        this.strokesCanvas.addEventListener('pointercancel', (e) => this._onPointerUp(e));
        this.strokesCanvas.addEventListener('pointerleave', () => this._hideCursor());
        this.strokesCanvas.addEventListener('pointerenter', () => this._updateCursor());
        this.strokesCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

        // 悬停位置 → 光标圆圈跟随
        this.strokesCanvas.addEventListener('pointermove', (e) => {
            this.cursorEl.style.left = e.clientX + 'px';
            this.cursorEl.style.top = e.clientY + 'px';
        });

        // 滚轮缩放（固定图像中心原地缩放）；中键拖拽平移视图
        this.stageEl.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
        // 中键按下会触发浏览器"自动滚动"，必须拦掉
        this.stageEl.addEventListener('mousedown', (e) => {
            if (e.button === 1) e.preventDefault();
        });
        this.stageEl.addEventListener('pointerdown', (e) => this._onStagePointerDown(e));
        this.stageEl.addEventListener('pointermove', (e) => this._onStagePointerMove(e));
        this.stageEl.addEventListener('pointerup', (e) => this._onStagePointerUp(e));
        this.stageEl.addEventListener('pointercancel', (e) => this._onStagePointerUp(e));

        // 窗口尺寸变化：保持当前缩放与平移，重算居中锚点（笔画层原生分辨率，内容不丢）
        window.addEventListener('resize', () => { if (this.isOpen()) this._applyTransform(); });

        // ESC 关闭（有未保存笔迹时走确认）
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
        // 笔画层同分辨率，打开时清空；透明度滑块回填为图片对象上
        // 持久化的图层透明度（无记录时默认不透明），笔迹画布同步
        this.strokesCanvas.width = natW;
        this.strokesCanvas.height = natH;
        const opacity = imageObj.editStrokesOpacity ?? 1;
        const opacityPct = Math.round(opacity * 100);
        this.opacitySlider.value = opacityPct;
        this.opacityValueEl.textContent = opacityPct;
        this.strokesCanvas.style.opacity = opacity;

        // 已有笔迹层（此前编辑保存的）画回笔画层——可继续涂画/擦除/还原。
        // 位图可能尚未加载（恢复自资产 URL / 后台标签页节流），用就绪门闩
        // 保证：加载完成前禁止落笔、保存前等待加载——否则会在空画布上
        // 擦除并保存出全透明图层，覆盖掉已恢复的笔迹数据
        this._strokesReadyDone = false;
        this._strokesReady = new Promise((resolve) => { this._strokesReadyResolve = resolve; });
        const existing = imageObj.editStrokesImg;
        if (existing && existing.complete && existing.naturalWidth) {
            this.strokesCtx.drawImage(existing, 0, 0);
            this._strokesReadyDone = true;
            this._strokesReadyResolve();
        } else if (imageObj.editStrokes) {
            const loader = new Image();
            loader.onload = () => {
                if (this.image === imageObj) {
                    imageObj.editStrokesImg = loader;
                    this.strokesCtx.drawImage(loader, 0, 0);
                }
                this._strokesReadyDone = true;
                this._strokesReadyResolve();
            };
            loader.onerror = () => {
                this._strokesReadyDone = true;
                this._strokesReadyResolve();
            };
            loader.src = imageObj.editStrokes;
        } else {
            this._strokesReadyDone = true;
            this._strokesReadyResolve();
        }

        // 先显示再适配：舞台尺寸要在可见状态下测量（隐藏时 clientWidth 为 0）
        this.overlayEl.style.display = 'flex';
        this.fitView();
    }

    /** 适应屏幕：缩放比取窗口可用空间与原图的适配比（不超过 100%），
     *  并复位视图平移（画布回舞台中心） */
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

    /** 设置缩放比：固定图像中心原地缩放（视图平移偏移保持不变） */
    setZoom(zoom) {
        this.zoom = Math.min(16, Math.max(0.05, zoom));   // 5% ~ 1600%
        this._applyTransform();
    }

    _onWheel(e) {
        if (!this.image) return;
        e.preventDefault();
        // 滚轮/触控板捏合（ctrl+wheel）统一按缩放处理
        const factor = Math.pow(1.0015, -e.deltaY);
        this.setZoom(this.zoom * factor);
    }

    // ==================== 视图平移（中键拖拽） ====================

    _onStagePointerDown(e) {
        if (!this.image || e.button !== 1) return;   // 仅中键平移
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

    /**
     * 应用变换：按当前缩放比同步两层画布的 CSS 尺寸，并按视图平移偏移
     * 定位（缩放围绕图像中心伸缩，平移整体挪动视图）。
     * 画布元素同时显式设定 100% 宽高，压制全局 canvas 规则
     * （100vw/100vh）导致的比例变形。平移带可见性夹取：
     * 画布至少 80px 留在舞台内，防止拖丢
     */
    _applyTransform() {
        if (!this.stageEl) return;
        const w = Math.round(this.baseCanvas.width * this.zoom);
        const h = Math.round(this.baseCanvas.height * this.zoom);
        const stageW = this.stageEl.clientWidth;
        const stageH = this.stageEl.clientHeight;
        const marginX = Math.min(80, w);
        const marginY = Math.min(80, h);
        // wrap 中心 = 舞台中心 + 平移偏移；夹取平移保证画布至少相交 80px
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

    /** 关闭（不询问；丢弃确认由 requestClose 负责） */
    close() {
        this.overlayEl.style.display = 'none';
        this.image = null;
        this.dirty = false;
        this.drawing = false;
        this._hideCursor();
    }

    /** 关闭请求：有未保存笔迹时先弹丢弃确认 */
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

    setColor(value, swatchEl) {
        this.color = value;
        this.swatchEls.forEach((sw) => sw.classList.toggle('active', sw === swatchEl));
        // 选色即回到画笔（选橡皮时点色块没有意义）
        if (this.tool !== 'brush') this.setTool('brush');
    }

    revert() {
        this.strokesCtx.clearRect(0, 0, this.strokesCanvas.width, this.strokesCanvas.height);
        this.dirty = false;
    }

    // ==================== 绘制 ====================

    _onPointerDown(e) {
        if (e.button !== 0 || !this.image) return;
        if (!this._strokesReadyDone) return;   // 既有笔迹层加载完成前禁止落笔
        e.preventDefault();
        this.strokesCanvas.setPointerCapture(e.pointerId);
        this.drawing = true;
        const pos = this._toImagePos(e);
        this.last = pos;
        this._strokeSegment(pos, pos);   // 单击也落一个圆点
        this.dirty = true;
    }

    _onPointerMove(e) {
        if (!this.drawing) return;
        // 合并高事件速率下的插值点，长笔画更顺滑
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of events) {
            const pos = this._toImagePos(ev);
            this._strokeSegment(this.last, pos);
            this.last = pos;
        }
    }

    _onPointerUp(e) {
        this.drawing = false;
        this.last = null;
    }

    /** 屏幕坐标 → 原图坐标（除以当前缩放比；画布矩形已含平移偏移） */
    _toImagePos(e) {
        const rect = this.strokesCanvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) / this.zoom,
            y: (e.clientY - rect.top) / this.zoom
        };
    }

    /** 在笔画层画一段笔迹：画笔叠加当前色，橡皮 destination-out 擦除 */
    _strokeSegment(from, to) {
        const ctx = this.strokesCtx;
        ctx.globalCompositeOperation = this.tool === 'eraser' ? 'destination-out' : 'source-over';
        ctx.strokeStyle = this.color;
        ctx.fillStyle = this.color;
        ctx.lineWidth = this.size;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
        // 起笔/单击的圆点（stroke 对零长度线段不绘制）
        if (from.x === to.x && from.y === to.y) {
            ctx.beginPath();
            ctx.arc(to.x, to.y, this.size / 2, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
    }

    get strokesCtx() {
        return this.strokesCanvas.getContext('2d');
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
     * 保存：笔迹层单独导出为透明 PNG，以图层形式挂在图片对象上
     * （image.editStrokes / editStrokesImg）——非破坏性：原图 src 不动，
     * 画布渲染器把笔迹层叠画在原图上；重新进入编辑器可继续涂画/擦除/
     * 还原。写回后走 draw()（CanvasChangeWatcher hook）触发自动保存
     */
    async save() {
        if (!this.image) return;
        try {
            await this._strokesReady;   // 既有笔迹层未加载完时等待，防覆盖
            const imgObj = this.image;
            const dataURL = this.strokesCanvas.toDataURL('image/png');

            // 图层透明度随图层一起持久化（渲染器与合成出口都会使用）
            imgObj.editStrokes = dataURL;
            imgObj.editStrokesOpacity = Number(this.opacitySlider.value) / 100;
            const layer = new Image();
            layer.onload = () => {
                imgObj.editStrokesImg = layer;
                this.canvas?.draw();   // 走 watcher hook：重绘 + 自动保存调度
            };
            layer.src = dataURL;

            this.msgEl.textContent = '';
            this.close();
        } catch (err) {
            this.msgEl.textContent = '保存失败：笔迹层导出异常';
            this.msgEl.classList.add('error');
            setTimeout(() => {
                this.msgEl.textContent = '';
                this.msgEl.classList.remove('error');
            }, 3000);
        }
    }
}

// 暴露到全局作用域
window.ImageEditor = ImageEditor;
