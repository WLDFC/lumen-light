/**
 * ==========================================================================
 * ImageStudio 子模块：DOM 构建与事件绑定（自 ImageStudio.js 拆出）
 * 作用：一次性构建编辑器全部 DOM（顶栏/工具栏/舞台/右侧面板/弹窗），
 *       绑定全部事件（绘制面/裁剪层/舞台/键盘/弹窗/面板拖宽）。
 * 契约：构造时传入宿主 ImageStudio 实例并读写其字段与方法（studio.xxx）；
 *       主类保留同名薄代理，内部/外部调用点零改动。
 * 对应：css/image-studio.css、css/image-editor.css（基础灯箱样式复用）
 * ==========================================================================
 */

class StudioDomBuilder {
    /** @param {Object} studio - 宿主 ImageStudio 实例 */
    constructor(studio) {
        this.studio = studio;
        this._buildDom();
    }

    _buildDom() {
        const studio = this.studio;
        // 根元素复用 .image-editor 基础灯箱样式，附加 .image-studio 布局
        studio.overlayEl = document.createElement('div');
        studio.overlayEl.className = 'image-editor image-studio';

        // ---- 顶栏：字体/字号/横竖排（PS 工具选项栏位置）/ 状态 / 保存 / 关闭 ----
        // （旧「图像编辑」标题已按用户要求移除，顶栏更紧凑）
        const topbar = document.createElement('div');
        topbar.className = 'image-editor-topbar';

        // ---- 顶栏最左端「文件」菜单（PS 菜单栏位置）：置入图片→新图层 ----
        const fileWrap = document.createElement('div');
        fileWrap.className = 'is-file-wrap';
        const fileBtn = document.createElement('button');
        fileBtn.type = 'button';
        fileBtn.className = 'is-file-btn';
        fileBtn.title = '文件：置入图片（本地 / 画布）';
        fileBtn.textContent = '文件';
        studio.fileMenuEl = document.createElement('div');
        studio.fileMenuEl.className = 'is-file-menu';
        studio.fileMenuEl.hidden = true;
        const fileLocalItem = document.createElement('button');
        fileLocalItem.type = 'button';
        fileLocalItem.className = 'is-file-item';
        fileLocalItem.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>置入本地图片…`;
        const fileCanvasItem = document.createElement('button');
        fileCanvasItem.type = 'button';
        fileCanvasItem.className = 'is-file-item';
        fileCanvasItem.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>从画布选择图片…`;
        studio.fileMenuEl.append(fileLocalItem, fileCanvasItem);
        fileWrap.append(fileBtn, studio.fileMenuEl);
        fileBtn.addEventListener('click', () => {
            studio.fileMenuEl.hidden = !studio.fileMenuEl.hidden;
        });
        fileLocalItem.addEventListener('click', () => studio._openLocalFileDialog());
        fileCanvasItem.addEventListener('click', () => studio._openPicker());

        const sizeRow = document.createElement('div');
        sizeRow.className = 'ie-group is-size-row';
        const sizeLabel = document.createElement('span');
        sizeLabel.className = 'ie-size-label';
        sizeLabel.textContent = '粗细';
        studio.sizeSlider = document.createElement('input');
        studio.sizeSlider.type = 'range';
        studio.sizeSlider.min = ImageStudio.MIN_SIZE;
        studio.sizeSlider.max = ImageStudio.MAX_SIZE;
        studio.sizeSlider.addEventListener('input', () => {
            studio.sizes[studio._maskMode ? 'mask' : 'strokes'] = Number(studio.sizeSlider.value);
            studio.sizeValueEl.textContent = studio.sizeSlider.value;   // 数值标签随拖动实时刷新
            studio._updateCursor();
        });
        studio.sizeValueEl = document.createElement('span');
        studio.sizeValueEl.className = 'ie-size-value';
        sizeRow.append(sizeLabel, studio.sizeSlider, studio.sizeValueEl);
        studio.sizeRowEl = sizeRow;

        // ---- 顶栏文字选项（文字工具激活时替换粗细行，PS 工具选项栏同位）：
        //      字体下拉 / 字号 / 横排竖排切换 ----
        const textRow = document.createElement('div');
        textRow.className = 'ie-group is-text-row';
        textRow.style.display = 'none';
        studio.textRowEl = textRow;
        studio.fontBtn = document.createElement('button');
        studio.fontBtn.type = 'button';
        studio.fontBtn.className = 'is-file-btn is-font-btn';
        studio.fontBtn.title = '字体（可选择「加载系统全部字体」枚举本机安装的字体）';
        studio.fontBtn.innerHTML = `<span></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
        studio.fontMenuEl = document.createElement('div');
        studio.fontMenuEl.className = 'is-file-menu is-font-menu';
        studio.fontMenuEl.hidden = true;
        studio.fontBtn.addEventListener('click', () => {
            studio.fontMenuEl.hidden = !studio.fontMenuEl.hidden;
        });
        const fontWrap = document.createElement('div');
        fontWrap.className = 'is-file-wrap';
        fontWrap.append(studio.fontBtn, studio.fontMenuEl);
        this._buildFontMenu(StudioTextTool.FONTS);
        const textSizeLabel = document.createElement('span');
        textSizeLabel.className = 'ie-size-label';
        textSizeLabel.textContent = '字号';
        studio.textSizeInput = document.createElement('input');
        studio.textSizeInput.type = 'number';
        studio.textSizeInput.className = 'is-text-size';
        studio.textSizeInput.min = 8;
        studio.textSizeInput.max = 512;
        studio.textSizeInput.value = studio.textOpts.size;
        studio.textSizeInput.title = '字号（像素，随图片分辨率缩放）';
        studio.textSizeInput.addEventListener('change', () => {
            const v = Math.min(512, Math.max(8, Number(studio.textSizeInput.value) || 48));
            studio.textOpts.size = v;
            studio.textSizeInput.value = v;
            studio._text.applyOpts();
        });
        const dirGroup = document.createElement('div');
        dirGroup.className = 'ie-group is-dir-group';
        studio.dirHBtn = document.createElement('button');
        studio.dirHBtn.type = 'button';
        studio.dirHBtn.className = 'is-dir-btn active';
        studio.dirHBtn.textContent = '横排';
        studio.dirHBtn.title = '横排文字（自左向右）';
        studio.dirVBtn = document.createElement('button');
        studio.dirVBtn.type = 'button';
        studio.dirVBtn.className = 'is-dir-btn';
        studio.dirVBtn.textContent = '竖排';
        studio.dirVBtn.title = '竖排文字（自上而下，列自右向左；西文段旋转 90°）';
        studio.dirHBtn.addEventListener('click', () => this._setTextDirection(false));
        studio.dirVBtn.addEventListener('click', () => this._setTextDirection(true));
        dirGroup.append(studio.dirHBtn, studio.dirVBtn);
        textRow.append(fontWrap, textSizeLabel, studio.textSizeInput, dirGroup);
        // 模糊强度行（模糊笔刷激活时替换粗细显示，与文字选项同机制）
        const fxRow = document.createElement('div');
        fxRow.className = 'ie-size-row';
        fxRow.style.display = 'none';
        const fxLabel = document.createElement('span');
        fxLabel.className = 'ie-size-label';
        fxLabel.textContent = '强度';
        studio.fxStrengthSlider = document.createElement('input');
        studio.fxStrengthSlider.type = 'range';
        studio.fxStrengthSlider.min = 4;
        studio.fxStrengthSlider.max = 40;
        studio.fxStrengthSlider.value = studio.fxStrength;
        studio.fxStrengthSlider.title = '模糊强度：σ = 强度/10，值越大单次涂抹越糊';
        studio.fxStrengthSlider.addEventListener('input', () => {
            studio.fxStrength = Number(studio.fxStrengthSlider.value);
            studio.fxStrengthValueEl.textContent = studio.fxStrengthSlider.value;
        });
        studio.fxStrengthValueEl = document.createElement('span');
        studio.fxStrengthValueEl.className = 'ie-size-value';
        studio.fxStrengthValueEl.textContent = studio.fxStrength;
        fxRow.append(fxLabel, studio.fxStrengthSlider, studio.fxStrengthValueEl);
        // 形状属性行（形状工具激活时替换粗细显示，与文字选项同机制）：
        // 类型四选一 / 填充色 / 描边色 / 描边宽（0 = 无边框，或点「无」去边框）/ 圆角
        const shapeRow = document.createElement('div');
        shapeRow.className = 'ie-group is-shape-row';
        shapeRow.style.display = 'none';
        studio.shapeRowEl = shapeRow;
        studio.shapeTypeBtns = {};
        const shapeTypes = [
            ['rect', '矩形', '<rect x="4" y="6" width="16" height="12" rx="1"></rect>'],
            ['round', '圆角矩形', '<rect x="4" y="6" width="16" height="12" rx="4"></rect>'],
            ['ellipse', '椭圆', '<ellipse cx="12" cy="12" rx="9" ry="7"></ellipse>'],
            ['bubble', '气泡框', '<ellipse cx="12" cy="11" rx="9" ry="7"></ellipse><path d="M9 17 L7 22 L13 17.5"></path>']
        ];
        for (const [type, label, icon] of shapeTypes) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'is-shape-type-btn' + (studio.shapeOpts.type === type ? ' active' : '');
            btn.title = label;
            btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>`;
            btn.addEventListener('click', () => {
                studio.shapeOpts.type = type;
                this._syncShapeTypeBtns();
                studio._shape.applyOpts();
            });
            studio.shapeTypeBtns[type] = btn;
            shapeRow.append(btn);
        }
        const fillLabel = document.createElement('span');
        fillLabel.className = 'ie-size-label';
        fillLabel.textContent = '填充';
        studio.shapeFillInput = document.createElement('input');
        studio.shapeFillInput.type = 'color';
        studio.shapeFillInput.className = 'is-color-input';
        studio.shapeFillInput.value = studio.shapeOpts.fill === 'none' ? '#ffffff' : studio.shapeOpts.fill;
        studio.shapeFillInput.title = '填充颜色';
        studio.shapeFillInput.addEventListener('input', () => {
            studio.shapeOpts.fill = studio.shapeFillInput.value;
            this._syncShapeNoFillBtn();
            studio._shape.applyOpts();
        });
        // 去填充（PS 红斜杠同款）：透明底；再点恢复上次填充色
        studio.shapeNoFillBtn = document.createElement('button');
        studio.shapeNoFillBtn.type = 'button';
        studio.shapeNoFillBtn.className = 'is-none-swatch';
        studio.shapeNoFillBtn.title = '去填充（透明底；再点恢复上次填充色）';
        studio.shapeNoFillBtn.addEventListener('click', () => {
            if (studio.shapeOpts.fill !== 'none') {
                studio._lastFill = studio.shapeOpts.fill;
                studio.shapeOpts.fill = 'none';
            } else {
                studio.shapeOpts.fill = studio._lastFill || '#ffffff';
            }
            studio.shapeFillInput.value = studio.shapeOpts.fill === 'none'
                ? (studio._lastFill || '#ffffff') : studio.shapeOpts.fill;
            this._syncShapeNoFillBtn();
            studio._shape.applyOpts();
        });
        const strokeLabel = document.createElement('span');
        strokeLabel.className = 'ie-size-label';
        strokeLabel.textContent = '边框';
        studio.shapeStrokeInput = document.createElement('input');
        studio.shapeStrokeInput.type = 'color';
        studio.shapeStrokeInput.className = 'is-color-input';
        studio.shapeStrokeInput.value = studio.shapeOpts.strokeColor;
        studio.shapeStrokeInput.title = '边框颜色';
        studio.shapeStrokeInput.addEventListener('input', () => {
            studio.shapeOpts.strokeColor = studio.shapeStrokeInput.value;
            studio._shape.applyOpts();
        });
        const strokeWLabel = document.createElement('span');
        strokeWLabel.className = 'ie-size-label';
        strokeWLabel.textContent = '边宽';
        studio.shapeStrokeSlider = document.createElement('input');
        studio.shapeStrokeSlider.type = 'range';
        studio.shapeStrokeSlider.min = 0;
        studio.shapeStrokeSlider.max = 60;
        studio.shapeStrokeSlider.value = studio.shapeOpts.strokeWidth;
        studio.shapeStrokeSlider.title = '边框宽度（0 = 无边框）';
        studio.shapeStrokeSlider.addEventListener('input', () => {
            studio.shapeOpts.strokeWidth = Number(studio.shapeStrokeSlider.value);
            if (studio.shapeOpts.strokeWidth > 0) studio._lastStrokeWidth = studio.shapeOpts.strokeWidth;
            studio.shapeStrokeValueEl.textContent = studio.shapeStrokeSlider.value;
            this._syncShapeNoStrokeBtn();
            studio._shape.applyOpts();
        });
        studio.shapeStrokeValueEl = document.createElement('span');
        studio.shapeStrokeValueEl.className = 'ie-size-value';
        studio.shapeStrokeValueEl.textContent = studio.shapeOpts.strokeWidth;
        // 去边框（PS 红斜杠同款）：宽度归零；再点恢复上次边宽（与滑杆双向同步）
        studio.shapeNoStrokeBtn = document.createElement('button');
        studio.shapeNoStrokeBtn.type = 'button';
        studio.shapeNoStrokeBtn.className = 'is-none-swatch';
        studio.shapeNoStrokeBtn.title = '去边框（无边框纯底色；再点恢复上次边宽）';
        studio.shapeNoStrokeBtn.addEventListener('click', () => {
            if (studio.shapeOpts.strokeWidth > 0) {
                studio._lastStrokeWidth = studio.shapeOpts.strokeWidth;
                studio.shapeOpts.strokeWidth = 0;
            } else {
                studio.shapeOpts.strokeWidth = studio._lastStrokeWidth || 6;
            }
            studio.shapeStrokeSlider.value = studio.shapeOpts.strokeWidth;
            studio.shapeStrokeValueEl.textContent = studio.shapeOpts.strokeWidth;
            this._syncShapeNoStrokeBtn();
            studio._shape.applyOpts();
        });
        const radiusLabel = document.createElement('span');
        radiusLabel.className = 'ie-size-label';
        radiusLabel.textContent = '圆角';
        studio.shapeRadiusSlider = document.createElement('input');
        studio.shapeRadiusSlider.type = 'range';
        studio.shapeRadiusSlider.min = 0;
        studio.shapeRadiusSlider.max = 120;
        studio.shapeRadiusSlider.value = studio.shapeOpts.radius;
        studio.shapeRadiusSlider.title = '圆角半径（仅矩形类形状生效）';
        studio.shapeRadiusSlider.addEventListener('input', () => {
            studio.shapeOpts.radius = Number(studio.shapeRadiusSlider.value);
            studio.shapeRadiusValueEl.textContent = studio.shapeRadiusSlider.value;
            studio._shape.applyOpts();
        });
        studio.shapeRadiusValueEl = document.createElement('span');
        studio.shapeRadiusValueEl.className = 'ie-size-value';
        studio.shapeRadiusValueEl.textContent = studio.shapeOpts.radius;
        shapeRow.append(fillLabel, studio.shapeFillInput, studio.shapeNoFillBtn,
            strokeLabel, studio.shapeStrokeInput, studio.shapeNoStrokeBtn,
            strokeWLabel, studio.shapeStrokeSlider, studio.shapeStrokeValueEl,
            radiusLabel, studio.shapeRadiusSlider, studio.shapeRadiusValueEl);
        studio.msgEl = document.createElement('span');
        studio.msgEl.className = 'ie-msg';
        const saveBtn = document.createElement('button');
        saveBtn.className = 'ie-save-btn';
        saveBtn.textContent = '保存';
        saveBtn.title = '保存：图层拍平写回图片（画幅变更导出新图），保存后不退出；退出请点右侧 ×';
        saveBtn.addEventListener('click', () => studio.save());
        const closeBtn = document.createElement('button');
        closeBtn.className = 'ie-close-btn';
        closeBtn.title = '关闭';
        closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
        closeBtn.addEventListener('click', () => studio.requestClose());
        topbar.append(fileWrap, sizeRow, textRow, fxRow, shapeRow, studio.msgEl, saveBtn, closeBtn);
        studio.fxRowEl = fxRow;
        studio._syncShapeOptsDom = () => this._syncShapeRow();

        // ---- 主体：左工具栏 / 舞台 / 右面板 ----
        const body = document.createElement('div');
        body.className = 'is-body';

        // 左侧竖排工具栏：移动 / 画笔 / 橡皮 / 遮罩模式开关 / 分隔线 / 还原 / 裁剪
        const toolbar = document.createElement('div');
        toolbar.className = 'is-toolbar';
        // 移动工具（PS 的 V 工具同位）：点击选中图层、拖动移动、拖角等比缩放
        studio.moveBtn = document.createElement('button');
        studio.moveBtn.className = 'ie-tool-btn';
        studio.moveBtn.title = '移动 / 缩放图层：点击选中，拖动移动，拖角等比缩放';
        studio.moveBtn.dataset.tool = 'move';
        studio.moveBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 9 2 12 5 15"></polyline><polyline points="9 5 12 2 15 5"></polyline><polyline points="15 19 12 22 9 19"></polyline><polyline points="19 9 22 12 19 15"></polyline><line x1="2" y1="12" x2="22" y2="12"></line><line x1="12" y1="2" x2="12" y2="22"></line></svg>`;
        studio.moveBtn.addEventListener('click', () => studio.setTool('move'));
        studio.brushBtn = this._makeToolBtn('画笔', 'M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z', 'brush');
        studio.eraserBtn = this._makeToolBtn('橡皮', 'm7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21M22 21H7m-2-10 9 9', 'eraser');
        // 模糊笔刷：像素效果工具（涂抹柔化），图标 = 水滴
        studio.fxBtn = document.createElement('button');
        studio.fxBtn.className = 'ie-tool-btn';
        studio.fxBtn.dataset.tool = 'fx';
        studio.fxBtn.title = '模糊笔刷：涂抹柔化局部（顶栏「强度」调轻重）';
        studio.fxBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"></path></svg>`;
        studio.fxBtn.addEventListener('click', () => studio.setTool('fx'));
        // 文字工具：点击画布新建文字层就地输入，点击已有文字层再次编辑
        //（图标 = Lucide type，与魔杖/画笔系均不混淆）
        studio.textBtn = document.createElement('button');
        studio.textBtn.className = 'ie-tool-btn';
        studio.textBtn.title = '文字工具：点击画布添加文字（顶部选字体/字号/横竖排），点击已有文字再次编辑';
        studio.textBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>`;
        studio.textBtn.addEventListener('click', () => studio.setTool('text'));
        studio.shapeBtn = document.createElement('button');
        studio.shapeBtn.className = 'ie-tool-btn';
        studio.shapeBtn.title = '形状工具：拖拽画矩形/椭圆/气泡框（顶栏选形状/填充/边框；Shift 约束正方；点击已有形状改属性）';
        studio.shapeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"></rect></svg>`;
        studio.shapeBtn.addEventListener('click', () => studio.setTool('shape'));
        // 遮罩模式开关：按下后画笔/橡皮涂出遮罩（落到激活
        // 图层的遮罩画布），弹起即普通画笔；激活态红色呼应遮罩视觉
        studio.maskBtn = document.createElement('button');
        studio.maskBtn.className = 'ie-tool-btn is-mask-btn';
        studio.maskBtn.title = '遮罩模式：按下后涂画即遮罩（局部重绘区域），弹起恢复普通画笔';
        studio.maskBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><rect x="8" y="8" width="8" height="8" fill="currentColor" stroke="none"></rect></svg>`;
        studio.maskBtn.addEventListener('click', () => studio.setMaskMode(!studio._maskMode));
        // 移除工具（AI 抹除）：自带遮罩涂抹的模式工具——激活后直接涂抹，
        // 松手自动提交后端 LaMa 模型本地推理抹除并智能填充。
        // 图标用创可贴（Lucide bandage）——PS 移除工具同款隐喻，
        // 与魔杖系图标（易误读为魔棒/选区）区分
        studio.removeBtn = document.createElement('button');
        studio.removeBtn.className = 'ie-tool-btn';
        studio.removeBtn.title = '移除工具：涂抹要移除的区域，松手自动 AI 抹除并智能填充（本地模型，再点一次退出）';
        studio.removeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 10.01h.01"></path><path d="M10 14.01h.01"></path><path d="M14 10.01h.01"></path><path d="M14 14.01h.01"></path><path d="M18 6v11.5"></path><path d="M6 6v12"></path><rect x="2" y="6" width="20" height="12" rx="2"></rect></svg>`;
        studio.removeBtn.addEventListener('click', () => studio.setRemoveMode());
        studio.cropBtn = this._makeToolBtn('裁剪 / 扩图（拖四边锚点调整画幅）', 'M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2', 'crop');
        const revertBtn = document.createElement('button');
        revertBtn.className = 'ie-tool-btn';
        revertBtn.title = '还原（清空全部遮罩 / 重置画幅 / 还原图层像素）';
        revertBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>`;
        revertBtn.addEventListener('click', () => studio.revert());
        const sep = document.createElement('div');
        sep.className = 'is-toolbar-sep';
        toolbar.append(studio.moveBtn, studio.brushBtn, studio.eraserBtn, studio.fxBtn,
            studio.textBtn, studio.shapeBtn, studio.maskBtn, studio.removeBtn, sep, revertBtn, studio.cropBtn);

        // 舞台 + 画布承载区：图层画布（动态）/ 绘制面 / 选中框 / 裁剪覆盖层
        const stage = document.createElement('div');
        stage.className = 'image-editor-stage';
        studio.stageEl = stage;
        studio.wrapEl = document.createElement('div');
        studio.wrapEl.className = 'ie-canvas-wrap';
        studio.paintSurface = document.createElement('div');
        studio.paintSurface.className = 'is-paint-surface';
        // 选中框覆盖层：铺满整个舞台（屏幕坐标绘制）——图层移出文档后
        // 选框依然完整可见；纯视觉 pointer-events:none，输入走舞台/绘制面
        studio.selCanvas = document.createElement('canvas');
        studio.selCanvas.className = 'is-selcanvas';
        studio.cropCanvas = document.createElement('canvas');
        studio.cropCanvas.className = 'is-crop';
        stage.appendChild(studio.wrapEl);
        stage.appendChild(studio.selCanvas);

        // ---- 右侧面板（可拖拽调宽）：色板 + 图层面板 ----
        const side = document.createElement('div');
        side.className = 'is-side';
        studio.sideEl = side;
        side.style.width = (localStorage.getItem('studioSideWidth')
            || ImageStudio.SIDE_DEFAULT) + 'px';
        // 面板左缘拖拽手柄（ew-resize）
        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'is-resize-handle';
        resizeHandle.addEventListener('pointerdown', (e) => this._onSideResizeDown(e));
        side.appendChild(resizeHandle);

        // ---- 色板：PS 式内嵌取色器（StudioColorPicker）+ 最近使用/预设网格。
        //      wrapper（paletteEl）承载蒙版禁用态，内部 = 取色器 + 色块网格 ----
        const paletteLabel = document.createElement('div');
        paletteLabel.className = 'is-panel-label';
        paletteLabel.textContent = '色板';
        studio.paletteEl = document.createElement('div');
        studio.paletteEl.className = 'is-palette';
        studio.swatchEls = [];

        // 取色器挂载点
        const pickerHost = document.createElement('div');
        studio._colorPicker.mount(pickerHost);

        // 色块网格（最近使用行首 + 预设 8 色）
        const paletteGrid = document.createElement('div');
        paletteGrid.className = 'is-palette-grid';
        const makeSwatch = (color, title) => {
            const sw = document.createElement('button');
            sw.className = 'ie-swatch';
            sw.title = title;
            if (color) sw.style.background = color;
            return sw;
        };
        const presetSws = ImageStudio.COLORS.map((c) => {
            const sw = makeSwatch(c.value, c.name);
            sw.dataset.color = c.value;
            sw.addEventListener('click', () => {
                studio.setColor(c.value, sw);
                this._pushRecentColor(c.value);
            });
            return sw;
        });
        this._buildPaletteSwatches = () => {
            paletteGrid.innerHTML = '';
            studio.swatchEls = [];
            for (const color of studio.recentColors) {
                const sw = makeSwatch(color, `最近使用 ${color}`);
                sw.dataset.color = color;
                // 已在列，无需再入列——点击最近色块不让网格重排
                sw.addEventListener('click', () => studio.setColor(color, sw));
                paletteGrid.appendChild(sw);
                studio.swatchEls.push(sw);
            }
            for (const sw of presetSws) {
                paletteGrid.appendChild(sw);
                studio.swatchEls.push(sw);
            }
            // 重建后按当前色恢复高亮
            studio.swatchEls.forEach((sw) =>
                sw.classList.toggle('active', sw.dataset.color === studio.color));
        };
        this._buildPaletteSwatches();
        studio.paletteEl.append(pickerHost, paletteGrid);

        // 图层面板：透明度（激活图层）+ 图层列表（拖放排序 + 右键菜单）
        const layersLabel = document.createElement('div');
        layersLabel.className = 'is-panel-label';
        layersLabel.textContent = '图层';
        const opacityRow = document.createElement('div');
        opacityRow.className = 'is-opacity-row';
        const opacityLabel = document.createElement('span');
        opacityLabel.className = 'ie-size-label';
        opacityLabel.textContent = '透明度';
        studio.opacitySlider = document.createElement('input');
        studio.opacitySlider.type = 'range';
        studio.opacitySlider.min = 0;
        studio.opacitySlider.max = 100;
        studio.opacitySlider.addEventListener('input', () => {
            const layer = studio._activeLayer();
            if (!layer) return;
            layer.opacity = Number(studio.opacitySlider.value) / 100;
            // 透明度参与拍平合成与图层栈序列化
            studio.dirty.layers = true;
            studio.opacityValueEl.textContent = studio.opacitySlider.value;
            studio._applyLayerStyles(layer);
        });
        studio.opacityValueEl = document.createElement('span');
        studio.opacityValueEl.className = 'ie-size-value';
        opacityRow.append(opacityLabel, studio.opacitySlider, studio.opacityValueEl);
        // 透明度历史：change（松手/确认）记一条，input 拖动中不刷历史
        studio.opacitySlider.addEventListener('change', () =>
            studio._pushHistory('调整透明度'));
        studio.layerListEl = document.createElement('div');
        studio.layerListEl.className = 'is-layer-list';
        studio.layerListEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            studio._showLayerMenu(e.clientX, e.clientY);
        });

        // 色板与图层面板之间的分隔线（视觉分区）
        const sideSep = document.createElement('div');
        sideSep.className = 'is-side-sep';
        side.append(paletteLabel, studio.paletteEl, sideSep,
            layersLabel, opacityRow, studio.layerListEl);

        // ---- 右侧工具栏（PS 面板栏同位，宽度同左栏）：历史记录入口 ----
        const rail = document.createElement('div');
        rail.className = 'is-rail';
        studio.historyBtn = document.createElement('button');
        studio.historyBtn.className = 'ie-tool-btn';
        studio.historyBtn.title = '历史记录：查看/回退到任意一步（Ctrl+Z 后退、Ctrl+Shift+Z 前进）';
        studio.historyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path><polyline points="12 7 12 12 15 15"></polyline></svg>`;
        studio.historyBtn.addEventListener('click', () => studio._history.togglePanel());
        rail.append(studio.historyBtn);
        studio._history.buildPanel(rail);
        studio._history.renderList = () => studio._history.renderListDefault();

        body.append(toolbar, stage, rail, side);

        // ---- 图层右键菜单 ----
        studio.layerMenuEl = document.createElement('div');
        studio.layerMenuEl.className = 'is-ctxmenu';
        studio.layerMenuEl.hidden = true;
        const addItem = document.createElement('div');
        addItem.className = 'is-ctxmenu-item';
        addItem.textContent = '新建图层';
        addItem.addEventListener('click', () => {
            studio.layerMenuEl.hidden = true;
            studio.addLayer();
        });
        studio.deleteItemEl = document.createElement('div');
        studio.deleteItemEl.className = 'is-ctxmenu-item';
        studio.deleteItemEl.textContent = '删除图层';
        studio.deleteItemEl.addEventListener('click', () => {
            studio.layerMenuEl.hidden = true;
            studio.deleteActiveLayer();
        });
        const dupItem = document.createElement('div');
        dupItem.className = 'is-ctxmenu-item';
        dupItem.textContent = '复制图层';
        dupItem.title = '克隆当前图层（内容/遮罩/变换/透明度），副本为普通图层插到原层上方';
        dupItem.addEventListener('click', () => {
            studio.layerMenuEl.hidden = true;
            studio.duplicateActiveLayer();
        });
        studio.layerMenuEl.append(addItem, dupItem, studio.deleteItemEl);
        document.addEventListener('pointerdown', (e) => {
            if (!studio.layerMenuEl.hidden && !studio.layerMenuEl.contains(e.target)) {
                studio.layerMenuEl.hidden = true;
            }
            if (!studio.fileMenuEl.hidden && !fileWrap.contains(e.target)) {
                studio.fileMenuEl.hidden = true;
            }
        });

        // ---- 左下角缩放指示：仅保留百分比胶囊（点击恢复 100%） ----
        const zoomCtrl = document.createElement('div');
        zoomCtrl.className = 'ie-zoomctrl';
        studio.zoomPill = document.createElement('button');
        studio.zoomPill.className = 'ie-zoom-pill';
        studio.zoomPill.title = '点击恢复 100%';
        studio.zoomPill.textContent = '100%';
        studio.zoomPill.addEventListener('click', () => studio.setZoom(1));
        zoomCtrl.append(studio.zoomPill);

        // ---- 笔刷光标与丢弃确认框（复用画笔灯箱样式） ----
        studio.cursorEl = document.createElement('div');
        studio.cursorEl.className = 'ie-cursor';
        studio.confirmEl = document.createElement('div');
        studio.confirmEl.className = 'ie-confirm';
        studio.confirmEl.hidden = true;
        studio.confirmEl.innerHTML = `
            <div class="ie-confirm-text">有未保存的修改，确定丢弃吗？</div>
            <div class="ie-confirm-btns">
                <button type="button" class="ie-confirm-cancel">继续编辑</button>
                <button type="button" class="ie-confirm-discard">丢弃更改</button>
            </div>`;
        studio.confirmEl.querySelector('.ie-confirm-cancel')
            .addEventListener('click', () => { studio.confirmEl.hidden = true; });
        studio.confirmEl.querySelector('.ie-confirm-discard')
            .addEventListener('click', () => { studio.confirmEl.hidden = true; studio.close(); });

        // ---- 画布选图弹窗（+ 下拉 → 从画布选择图片）：中央长方形多选网格 ----
        studio._pickerSelected = new Set();   // 本次弹窗内勾选的画布图片 id
        studio.pickerEl = document.createElement('div');
        studio.pickerEl.className = 'is-picker-mask';
        studio.pickerEl.hidden = true;
        studio.pickerEl.innerHTML = `
            <div class="is-picker">
                <div class="is-picker-head">
                    <span class="is-picker-title">选择画布图片</span>
                    <button type="button" class="is-picker-close" title="关闭">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                </div>
                <div class="is-picker-body"><div class="is-picker-grid"></div></div>
                <div class="is-picker-foot">
                    <span class="is-picker-count"></span>
                    <button type="button" class="is-picker-cancel">取消</button>
                    <button type="button" class="is-picker-ok">确定</button>
                </div>
            </div>`;
        // 点遮罩空白 = 取消；关闭/取消同义
        studio.pickerEl.addEventListener('pointerdown', (e) => {
            if (e.target === studio.pickerEl) studio._closePicker();
        });
        studio.pickerEl.querySelector('.is-picker-close')
            .addEventListener('click', () => studio._closePicker());
        studio.pickerEl.querySelector('.is-picker-cancel')
            .addEventListener('click', () => studio._closePicker());
        studio.pickerEl.querySelector('.is-picker-ok')
            .addEventListener('click', async () => {
                const picked = (studio.canvas?.images?.images || [])
                    .filter((o) => studio._pickerSelected.has(o.id));
                studio._closePicker();
                let seq = 1;
                for (const o of picked) {
                    try {
                        await studio.importImageAsLayer(o.img.src, `画布图片 ${seq++}`);
                    } catch (err) {
                        console.error('❌ 导入画布图片失败:', err);
                    }
                }
            });

        studio.overlayEl.append(topbar, body, zoomCtrl, studio.cursorEl, studio.confirmEl,
            studio.layerMenuEl, studio.pickerEl);
        studio.overlayEl.style.display = 'none';
        document.body.appendChild(studio.overlayEl);

        this._bindEvents();
    }

    /** 左侧工具按钮（画笔/橡皮/裁剪），点击切换并高亮 */
    /** 左侧工具按钮（画笔/橡皮/裁剪），点击切换并高亮 */
    _makeToolBtn(title, iconPath, tool) {
        const btn = document.createElement('button');
        btn.className = 'ie-tool-btn';
        btn.title = title;
        btn.dataset.tool = tool;
        btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${iconPath}"></path></svg>`;
        btn.addEventListener('click', () => this.studio.setTool(tool));
        return btn;
    }

    // ==================== 顶栏文字选项 ====================

    /** 重建字体下拉清单（每项按自身字体预览，PS 同款）；清单传入精选
     *  FONTS 或 queryLocalFonts 枚举的系统全量。清单尾部挂「加载系统
     *  全部字体」入口（仅支持的浏览器显示） */
    _buildFontMenu(fonts) {
        const studio = this.studio;
        // 触发器文案 = 当前字体（初始与选项变更后都经此刷新）
        const cur = fonts.find((f) => f.family === studio.textOpts.font);
        studio.fontBtn.querySelector('span').textContent = cur ? cur.label : studio.textOpts.font;
        studio.fontMenuEl.innerHTML = '';
        for (const f of fonts) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'is-file-item is-font-item'
                + (f.family === studio.textOpts.font ? ' active' : '');
            item.textContent = f.label;
            item.style.fontFamily = `"${f.family}", sans-serif`;
            item.addEventListener('click', () => {
                studio.textOpts.font = f.family;
                studio.fontBtn.querySelector('span').textContent = f.label;
                studio.fontMenuEl.hidden = true;
                studio._text.applyOpts();
                this._buildFontMenu(fonts);   // 刷新 active 高亮
            });
            studio.fontMenuEl.appendChild(item);
        }
        if (window.queryLocalFonts && fonts === StudioTextTool.FONTS) {
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'is-file-item is-font-more';
            more.textContent = '加载系统全部字体…';
            more.addEventListener('click', async () => {
                more.textContent = '加载中…';
                const list = await StudioTextTool.loadSystemFonts();
                if (list && list.length) {
                    this._buildFontMenu(list);
                } else {
                    more.textContent = '无法枚举系统字体';
                    setTimeout(() => { more.textContent = '加载系统全部字体…'; }, 2000);
                }
            });
            studio.fontMenuEl.appendChild(more);
        }
    }

    /** 横排/竖排切换：更新选项高亮与文字属性（编辑中实时重排） */
    _setTextDirection(vertical) {
        const studio = this.studio;
        studio.textOpts.vertical = vertical;
        studio.dirHBtn.classList.toggle('active', !vertical);
        studio.dirVBtn.classList.toggle('active', vertical);
        studio._text.applyOpts();
    }

    // ==================== 形状工具顶栏 ====================

    /** 形状类型按钮组激活态同步 */
    _syncShapeTypeBtns() {
        const studio = this.studio;
        for (const [type, btn] of Object.entries(studio.shapeTypeBtns)) {
            btn.classList.toggle('active', studio.shapeOpts.type === type);
        }
    }

    /** 顶栏形状属性 ← studio.shapeOpts（选中已有形状层反向同步用；
     *  无填充时填充色输入仍显示最近实色，便于切回） */
    _syncShapeRow() {
        const studio = this.studio;
        const o = studio.shapeOpts;
        this._syncShapeTypeBtns();
        this._syncShapeNoFillBtn();
        studio.shapeFillInput.value = o.fill === 'none'
            ? (studio._lastFill || '#ffffff') : o.fill;
        studio.shapeStrokeInput.value = o.strokeColor;
        studio.shapeStrokeSlider.value = o.strokeWidth;
        studio.shapeStrokeValueEl.textContent = o.strokeWidth;
        this._syncShapeNoStrokeBtn();
        studio.shapeRadiusSlider.value = o.radius;
        studio.shapeRadiusValueEl.textContent = o.radius;
    }

    /** 去边框按钮激活态：边宽为 0 即激活 */
    _syncShapeNoStrokeBtn() {
        this.studio.shapeNoStrokeBtn.classList.toggle(
            'active', this.studio.shapeOpts.strokeWidth === 0);
    }

    /** 去填充按钮激活态：填充为 none 即激活 */
    _syncShapeNoFillBtn() {
        this.studio.shapeNoFillBtn.classList.toggle(
            'active', this.studio.shapeOpts.fill === 'none');
    }

    /** 最近使用色：只收录「新颜色」——已在列的或是预设 8 色的一律跳过
     *  （预设块本来就固定可见，入列冗余且会导致来回点色块时网格洗牌，
     *  用户实测反馈的 bug）。仅在真正的新色入列时重建网格 */
    _pushRecentColor(value) {
        const studio = this.studio;
        const v = String(value).toLowerCase();
        if (studio.recentColors.includes(v)) return;
        if (ImageStudio.COLORS.some((c) => c.value === v)) return;
        studio.recentColors = [v, ...studio.recentColors]
            .slice(0, ImageStudio.RECENT_MAX);
        this._buildPaletteSwatches();
    }

    _bindEvents() {
        const studio = this.studio;
        // 统一绘制面：全部绘制输入经它路由到激活图层
        studio.paintSurface.addEventListener('pointerdown', (e) => studio._onPaintDown(e));
        studio.paintSurface.addEventListener('pointermove', (e) => studio._onPaintMove(e));
        studio.paintSurface.addEventListener('pointerup', (e) => studio._onPaintUp(e));
        studio.paintSurface.addEventListener('pointercancel', (e) => studio._onPaintUp(e));
        studio.paintSurface.addEventListener('contextmenu', (e) => e.preventDefault());

        // 自定义笔刷光标在整个舞台内可见（文档 + 周边空白）；移出舞台
        // （左工具栏 / 右侧面板 / 顶栏）才隐藏并恢复系统鼠标——顶栏/面板
        // 上要点击控件，用系统光标。笔刷类工具的舞台内系统鼠标隐藏由
        // setTool 给 stageEl 置 cursor:none 完成
        studio.stageEl.addEventListener('pointerleave', () => {
            studio._cursorInStage = false;
            studio._hideCursor();
        });
        studio.stageEl.addEventListener('pointermove', (e) => {
            // move 兜底复活：滑杆拖动等 pointer capture 场景会吞掉
            // pointerenter，只信 enter 会让光标圈一去不回。圈是否点亮由
            // _updateCursor 按「笔刷类工具 + 指针在舞台内」判定
            studio._cursorInStage = true;
            if (!studio._brushCursorTool) return;
            if (studio.cursorEl.style.display === 'none') studio._updateCursor();
            studio.cursorEl.style.left = e.clientX + 'px';
            studio.cursorEl.style.top = e.clientY + 'px';
        });

        // 裁剪覆盖层：锚点拖拽（仅裁剪工具下显示）
        studio.cropCanvas.addEventListener('pointerdown', (e) => studio._onCropDown(e));
        studio.cropCanvas.addEventListener('pointermove', (e) => studio._onCropMove(e));
        studio.cropCanvas.addEventListener('pointerup', () => {
            if (studio.dragEdge) studio._pushHistory('调整画幅');
            studio.dragEdge = null;
        });
        studio.cropCanvas.addEventListener('pointercancel', () => { studio.dragEdge = null; });
        studio.cropCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

        // 滚轮缩放 + 中键拖拽平移（与画笔灯箱同款）
        studio.stageEl.addEventListener('wheel', (e) => studio._onWheel(e), { passive: false });
        studio.stageEl.addEventListener('mousedown', (e) => {
            if (e.button === 1) e.preventDefault();   // 拦掉浏览器中键自动滚动
        });
        studio.stageEl.addEventListener('pointerdown', (e) => studio._onStagePointerDown(e));
        studio.stageEl.addEventListener('pointermove', (e) => studio._onStagePointerMove(e));
        studio.stageEl.addEventListener('pointerup', (e) => studio._onStagePointerUp(e));
        studio.stageEl.addEventListener('pointercancel', (e) => studio._onStagePointerUp(e));

        // 移动工具的全域输入：绘制面只盖文档矩形，图层移出文档后点击
        // 落不到它——移动工具下绘制面放行指针（.moving 类），由舞台
        // 接手按下/拖动/抬起，选择与变换在整片舞台范围内可用
        studio.stageEl.addEventListener('pointerdown', (e) => {
            if (studio.tool !== 'move') return;
            studio._onPaintDown(e);
        });
        studio.stageEl.addEventListener('pointermove', (e) => {
            if (studio.tool !== 'move') return;
            studio._onMoveHover(e);
        });
        studio.stageEl.addEventListener('pointerup', () => {
            if (studio.tool !== 'move') return;
            studio._onPaintUp();
        });
        studio.stageEl.addEventListener('pointercancel', () => {
            if (studio.tool !== 'move') return;
            studio._onPaintUp();
        });

        window.addEventListener('resize', () => { if (studio.isOpen()) studio._applyTransform(); });

        // 字体菜单点外关闭（点击触发按钮或菜单内部不关）
        document.addEventListener('click', (e) => {
            if (studio.fontMenuEl && !studio.fontMenuEl.hidden &&
                !studio.fontBtn.contains(e.target) && !studio.fontMenuEl.contains(e.target)) {
                studio.fontMenuEl.hidden = true;
            }
        });

        document.addEventListener('keydown', (e) => {
            if (!studio.isOpen()) return;
            // 模型推理忙碌期：键盘操作全部冻结（Esc 关闭/Delete 删层
            // 都会改动图层栈，与推理结果写回冲突）
            if (studio._removing) { e.preventDefault(); return; }
            // 输入控件聚焦（粗细/透明度滑杆等）时按键交给原生行为，快捷键失效
            if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) return;
            // 历史步进：Ctrl+Z 后退 / Ctrl+Shift+Z 或 Ctrl+Y 前进
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                studio._history.step(e.shiftKey ? 1 : -1);
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
                e.preventDefault();
                studio._history.step(1);
                return;
            }
            if (e.key === 'Escape') {
                if (!studio.pickerEl.hidden) { studio._closePicker(); return; }  // 弹窗开着先关弹窗
                studio.fileMenuEl.hidden = true;
                studio.fontMenuEl.hidden = true;
                studio._history.closePanel();
                studio.requestClose();
                return;
            }
            // Delete 键删除激活图层（键盘入口，等同右键菜单「删除图层」）：
            // 背景层/图片层不可删，deleteActiveLayer 内部守卫直接跳过；
            // 画布选图弹窗或文件菜单开着时不响应，避免误删
            if (e.key === 'Delete') {
                if (!studio.pickerEl.hidden || !studio.fileMenuEl.hidden) return;
                e.preventDefault();
                studio.deleteActiveLayer();
            }
        });
    }

    // ==================== 右侧面板拖拽调宽 ====================

    _onSideResizeDown(e) {
        const studio = this.studio;
        e.preventDefault();
        studio._sideResizing = true;
        try { e.target.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
        const move = (ev) => {
            if (!studio._sideResizing) return;
            const rect = studio.sideEl.getBoundingClientRect();
            const w = Math.min(ImageStudio.SIDE_MAX,
                Math.max(ImageStudio.SIDE_MIN, rect.right - ev.clientX));
            studio.sideEl.style.width = w + 'px';
            studio._applyTransform();
        };
        const up = () => {
            studio._sideResizing = false;
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            localStorage.setItem('studioSideWidth',
                String(parseInt(studio.sideEl.style.width, 10)));
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }
}

// 暴露到全局作用域（经典 script，ImageStudio.js 之后实例化时消费）
window.StudioDomBuilder = StudioDomBuilder;
