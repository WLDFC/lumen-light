/**
 * ============================================================
 * LumenLight 图片选中工具栏组件
 * ============================================================
 * 当用户选中画布中的图片时，该组件会在图片周围显示一个浮动工具栏，
 * 包含以下功能按钮：
 *   - 添加到内容：LLM 模式下加入聊天待发送图片区，Comfy 模式下加入内容缩略图列表
 *   - 高清放大：调用 UpscaleManager 对图片进行高清放大处理
 *   - 下载：将当前选中的图片保存到本地
 *
 * 同时，工具栏还会显示：
 *   - 图片名称标签：悬浮在图片上方，展示图片名称
 *   - 图片尺寸标签：悬浮在图片下方，展示原始宽度 × 高度
 *
 * 该组件通过监听 window 上的自定义事件与画板进行通信，
 * 并能在窗口缩放、画布视口变化、图片拖动等场景下自动更新位置。
 * ============================================================
 */

/**
 * 图片选中工具栏类
 * 负责创建浮动工具栏 DOM、绑定事件、更新位置以及处理用户交互。
 */
class ImageToolbar {
    /**
     * 构造方法：初始化工具栏状态并调用初始化逻辑
     * @param {Object} canvas - 画布实例，用于获取选中图片、视口等信息
     */
    constructor(canvas) {
        // 画布实例引用
        this.canvas = canvas;
        // 工具栏根 DOM 元素
        this.toolbar = null;
        // 图片名称标签 DOM 元素
        this.nameLabel = null;
        // 图片尺寸标签 DOM 元素
        this.sizeLabel = null;
        // 当前选中的图片对象数组
        this.selectedImages = [];
        // 工具栏是否可见
        this.isVisible = false;
        // 节流更新位置使用的 requestAnimationFrame 定时器
        this.updateThrottleTimer = null;
        // 抠图任务进行中标记，防止重复提交
        this.isRemovingBg = false;

        // 执行初始化
        this.init();
    }

    /**
     * 初始化方法：依次创建工具栏、名称标签、尺寸标签并绑定事件
     */
    init() {
        this.createToolbar();
        this.createNameLabel();
        this.createSizeLabel();
        this.bindEvents();
    }

    /**
     * 创建工具栏 DOM 结构
     * 工具栏从左到右包含三个区域：添加到内容、高清放大 / 抠图、下载
     */
    createToolbar() {
        // 创建工具栏根节点，初始状态为隐藏
        this.toolbar = document.createElement('div');
        this.toolbar.className = 'image-toolbar';
        this.toolbar.style.display = 'none';

        // 工具栏内容容器，用于布局三个功能区域
        const content = document.createElement('div');
        content.className = 'image-toolbar-content';

        // ==================== 左侧功能区：添加到内容 ====================
        const leftSection = document.createElement('div');
        leftSection.className = 'toolbar-section left';

        // 创建"添加到内容"按钮
        const addToContentBtn = document.createElement('button');
        addToContentBtn.className = 'toolbar-btn add-to-content-btn';
        addToContentBtn.title = '添加到内容';
        // 按钮图标：方框内带十字加号，配合文字"添加到内容"
        addToContentBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="12" y1="8" x2="12" y2="16"></line>
                <line x1="8" y1="12" x2="16" y2="12"></line>
            </svg>
            <span class="btn-text">添加到内容</span>
        `;
        // 点击时阻止事件冒泡，避免触发画布取消选中
        addToContentBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.addToContent();
        });

        leftSection.appendChild(addToContentBtn);

        // ==================== 中间功能区：高清放大 ====================
        const centerSection = document.createElement('div');
        centerSection.className = 'toolbar-section center';

        // 初始化高清放大管理器，用于显示放大倍数菜单
        this.upscaleManager = new UpscaleManager();

        // 创建"高清放大"按钮
        const upscaleBtn = document.createElement('button');
        upscaleBtn.className = 'toolbar-btn upscale-btn';
        upscaleBtn.title = '高清放大';
        // 按钮图标：方框内带网格线，配合文字"高清放大"
        upscaleBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <path d="M9 3v18"></path>
                <path d="M15 3v18"></path>
                <path d="M3 9h18"></path>
                <path d="M3 15h18"></path>
            </svg>
            <span class="btn-text">高清放大</span>
        `;
        // 点击时阻止事件冒泡并弹出高清放大选项菜单
        upscaleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showUpscaleMenu(upscaleBtn);
        });

        centerSection.appendChild(upscaleBtn);

        // 创建“去除背景”按钮
        const rembgBtn = document.createElement('button');
        rembgBtn.className = 'toolbar-btn rembg-btn';
        rembgBtn.title = '去除背景';
        // 按钮图标：图片与橡皮擦，表示擦除图片背景
        rembgBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="4" width="12" height="16" rx="2"></rect>
                <circle cx="7.5" cy="9" r="1.5"></circle>
                <path d="m5 17 3.5-3.5 2.5 2.5 2-2"></path>
                <path d="m15 14 3.5-3.5 3 3-5.5 5.5H13v-3z"></path>
                <path d="m17 12 2 2"></path>
            </svg>
            <span class="btn-text">去除背景</span>
        `;
        // 点击时阻止事件冒泡并执行抠图
        rembgBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.removeBackground();
        });

        centerSection.appendChild(rembgBtn);

        // ==================== 右侧功能区：下载 ====================
        const rightSection = document.createElement('div');
        rightSection.className = 'toolbar-section right';

        // 创建"下载"按钮（仅图标，无文字）
        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'toolbar-btn download-btn';
        downloadBtn.title = '下载图片';
        // 按钮图标：向下箭头指向底板，表示下载
        downloadBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
        `;
        // 点击时阻止事件冒泡并执行下载
        downloadBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.downloadImage();
        });

        rightSection.appendChild(downloadBtn);

        const saveTagBtn = document.createElement('button');
        saveTagBtn.className = 'toolbar-btn save-tag-btn';
        saveTagBtn.title = '保存提示词';
        saveTagBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 3h12a2 2 0 0 1 2 2v16l-8-4-8 4V5a2 2 0 0 1 2-2z"></path>
                <line x1="12" y1="7" x2="12" y2="13"></line>
                <line x1="9" y1="10" x2="15" y2="10"></line>
            </svg>
            <span class="btn-text">保存提示词</span>
        `;
        saveTagBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.savePromptTag();
        });
        centerSection.appendChild(saveTagBtn);

        // 将三个功能区组装到内容容器中
        content.appendChild(leftSection);
        content.appendChild(centerSection);
        content.appendChild(rightSection);
        this.toolbar.appendChild(content);

        // 将工具栏追加到 body，使其能够绝对定位悬浮在画布之上
        document.body.appendChild(this.toolbar);

    }

    /**
     * 创建图片名称标签 DOM
     * 名称标签悬浮在图片上方，用于显示当前选中图片的名称
     */
    createNameLabel() {
        this.nameLabel = document.createElement('div');
        this.nameLabel.className = 'image-name-label';
        this.nameLabel.style.display = 'none';
        document.body.appendChild(this.nameLabel);
    }

    /**
     * 创建图片尺寸标签 DOM
     * 尺寸标签悬浮在图片下方，用于显示当前选中图片的原始宽高
     */
    createSizeLabel() {
        this.sizeLabel = document.createElement('div');
        this.sizeLabel.className = 'image-size-label';
        this.sizeLabel.style.display = 'none';
        document.body.appendChild(this.sizeLabel);
    }

    /**
     * 绑定各类事件监听器
     * 包括画布图片选中、外部点击、窗口缩放、视口变化、图片拖动开始/结束等
     */
    bindEvents() {
        // 监听画布图片选中事件：detail.image 为最后选中的图片对象，为空则隐藏工具栏
        window.addEventListener('canvasImageSelected', (e) => {
            const image = e.detail.image;
            // 生成反馈占位图不显示工具栏
            if (image && NodeTypes.isPlaceholder(image.source)) {
                this.hide();
                return;
            }
            // 提示词/文本节点不是图片，选中节点不显示图片工具栏；
            // 但若同时多选了图片（节点+图片混合），仍按图片集合显示
            const selectedImages = this.canvas.images.getSelected()
                .filter(img => img.source !== NodeTypes.SOURCE.PROMPT_NODE &&
                               img.source !== NodeTypes.SOURCE.TEXT_NODE);
            if (selectedImages.length > 0) {
                this.show(selectedImages);
            } else {
                this.hide();
            }
        });

        // 监听全局鼠标按下事件：点击工具栏和标签之外的区域时隐藏工具栏
        document.addEventListener('mousedown', (e) => {
            if (this.isVisible && !this.toolbar.contains(e.target) &&
                !this.nameLabel.contains(e.target) && !this.sizeLabel.contains(e.target)) {
                const isCanvasClick = e.target.tagName === 'CANVAS';
                const hasSelectedImages = this.canvas.images.selectedIds.size > 0;

                // 若点击的是画布且仍有选中图片，则保持显示；否则隐藏
                if (!isCanvasClick || !hasSelectedImages) {
                    this.hide();
                }
            }
        });

        // 监听窗口大小变化事件：窗口缩放时重新计算工具栏位置（防抖处理）
        let resizeTimer = null;
        window.addEventListener('resize', () => {
            if (this.isVisible && this.selectedImages.length > 0) {
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(() => this.updatePosition(), 100);
            }
        });

        // 监听画布视口变化事件：缩放或平移时使用节流函数更新位置
        window.addEventListener('canvasViewportChanged', () => {
            if (this.isVisible && this.selectedImages.length > 0) {
                this.throttledUpdatePosition();
            }
        });

        // 监听图片拖动开始事件：拖动过程中隐藏工具栏和标签，避免视觉干扰
        window.addEventListener('canvasImageDragStart', () => {
            if (this.isVisible) {
                this.hideElements();
            }
        });

        // 监听图片拖动结束事件：拖动结束后重新显示工具栏和标签
        window.addEventListener('canvasImageDragEnd', () => {
            if (this.selectedImages.length > 0) {
                this.showElements();
            }
        });

        // 监听缩放开始事件：隐藏按钮组和名称标签，仅保留尺寸标签作为实时反馈
        window.addEventListener('canvasImageResizeStart', () => {
            if (this.isVisible) {
                this.toolbar.style.display = 'none';
                this.nameLabel.style.display = 'none';
            }
        });

        // 监听缩放过程事件：实时刷新尺寸标签文本与位置
        window.addEventListener('canvasImageResizing', () => {
            if (this.isVisible && this.selectedImages.length > 0) {
                this.updateImageInfo(this.selectedImages[this.selectedImages.length - 1], this.selectedImages.length);
                this.updatePosition();
            }
        });

        // 监听缩放结束事件：按新尺寸恢复完整显示
        window.addEventListener('canvasImageResizeEnd', () => {
            if (this.selectedImages.length > 0) {
                this.showElements();
            }
        });
    }

    /**
     * 节流更新位置方法
     * 使用 requestAnimationFrame 减少高频事件（如视口变化）导致的重复重排
     */
    throttledUpdatePosition() {
        if (this.updateThrottleTimer) {
            cancelAnimationFrame(this.updateThrottleTimer);
        }
        this.updateThrottleTimer = requestAnimationFrame(() => {
            this.updatePosition();
        });
    }

    /**
     * 显示工具栏方法
     * 设置当前选中图片数组，更新信息，计算位置后显示工具栏和标签
     * @param {Array} images - 当前选中的图片对象数组
     */
    show(images) {
        this.selectedImages = images;
        this.isVisible = true;

        // 更新图片名称和尺寸信息（显示最后一张选中的图片信息）
        const lastImage = images[images.length - 1];
        this.updateImageInfo(lastImage, images.length);

        // 先显示所有元素，再更新位置
        // （顺序不能反：display:none 时 offsetWidth/offsetHeight 为 0，
        //   居中和间距计算会退回兜底值，导致工具栏相对图片偏移、不居中）
        this.toolbar.style.display = 'block';
        this.nameLabel.style.display = 'block';
        // 多张选中时隐藏尺寸标签
        this.sizeLabel.style.display = images.length > 1 ? 'none' : 'block';

        this.updatePosition();
    }

    /**
     * 隐藏工具栏元素方法
     * 拖动过程中使用，仅隐藏 DOM 元素但保留 selectedImage 和 isVisible 状态
     */
    hideElements() {
        this.toolbar.style.display = 'none';
        this.nameLabel.style.display = 'none';
        this.sizeLabel.style.display = 'none';
    }

    /**
     * 显示工具栏元素方法
     * 拖动结束时使用，先更新位置再显示 DOM 元素
     */
    showElements() {
        // 先显示所有元素，再更新位置（display:none 时尺寸测量为 0，定位会偏移）
        this.toolbar.style.display = 'block';
        this.nameLabel.style.display = 'block';
        this.sizeLabel.style.display = 'block';
        this.updatePosition();
    }

    /**
     * 隐藏工具栏方法
     * 完全隐藏工具栏和标签，清空选中状态并取消节流定时器
     */
    hide() {
        this.isVisible = false;
        this.toolbar.style.display = 'none';
        this.nameLabel.style.display = 'none';
        this.sizeLabel.style.display = 'none';
        this.selectedImages = [];

        // 清理 requestAnimationFrame 定时器，避免内存泄漏
        if (this.updateThrottleTimer) {
            cancelAnimationFrame(this.updateThrottleTimer);
            this.updateThrottleTimer = null;
        }

    }

    /**
     * 更新图片信息方法
     * 根据图片对象设置名称标签和尺寸标签的文本内容
     * @param {Object} image - 当前最后选中的图片对象
     * @param {number} selectedCount - 选中图片数量
     */
    updateImageInfo(image, selectedCount = 1) {
        if (!image || !image.img) return;

        // 更新图片名称：多张选中时显示数量，单张时显示图片名
        if (selectedCount > 1) {
            this.nameLabel.textContent = `已选中 ${selectedCount} 张图片`;
        } else {
            let imageName = image.name || `图片 ${image.id.substring(0, 6)}`;
            this.nameLabel.textContent = imageName;
        }

        // 更新图片尺寸：显示画布上的当前显示尺寸，拖角缩放后同步变化。
        // 不用 naturalWidth/naturalHeight，否则缩放后标签与实际视觉大小不一致。
        const width = Math.round(image.width);
        const height = Math.round(image.height);
        this.sizeLabel.textContent = `${width} × ${height}`;
    }

    /**
     * 更新工具栏和标签位置方法
     * 根据所有选中图片的包围盒计算工具栏和标签位置
     */
    updatePosition() {
        if (!this.selectedImages.length || !this.canvas.viewport) return;

        const viewport = this.canvas.viewport;
        const canvasRect = this.canvas.canvas.getBoundingClientRect();

        // 计算所有选中图片的包围盒
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const img of this.selectedImages) {
            const x = img.x;
            const y = img.y;
            const right = x + img.width;
            const bottom = y + img.height;

            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (right > maxX) maxX = right;
            if (bottom > maxY) maxY = bottom;
        }

        // 将包围盒从画布坐标转换为屏幕坐标
        const topLeft = viewport.canvasToScreen(minX, minY);
        const bottomRight = viewport.canvasToScreen(maxX, maxY);

        const screenX = canvasRect.left + topLeft.x;
        const screenY = canvasRect.top + topLeft.y;
        const displayWidth = bottomRight.x - topLeft.x;
        const displayHeight = bottomRight.y - topLeft.y;

        // 工具栏尺寸和间距定义
        const toolbarHeight = this.toolbar.offsetHeight || 40;
        const toolbarSpacing = 30;  // 工具栏与图片之间的固定间距
        const nameLabelOffset = 25; // 名称标签与图片顶部的固定间距
        const sizeLabelSpacing = Math.max(2, displayHeight * 0.03);

        // 工具栏位置：优先放在图片上方，与图片保持固定间距；
        // 图片贴近屏幕顶部、上方放不下时，整体翻转到图片下方（排在尺寸标签后），
        // 保证工具栏永远完整可见且间距恒定，不遮挡图片
        const toolbarTopAbove = screenY - toolbarHeight - toolbarSpacing;
        if (toolbarTopAbove >= 10) {
            this.toolbar.style.top = `${toolbarTopAbove}px`;
        } else {
            this.toolbar.style.top = `${screenY + displayHeight + sizeLabelSpacing + 24}px`;
        }
        const toolbarWidth = this.toolbar.offsetWidth || 240;
        this.toolbar.style.left = `${screenX + (displayWidth - toolbarWidth) / 2}px`;

        // 名称标签位置：位于包围盒顶部上方
        const nameLabelTop = screenY - nameLabelOffset;
        this.nameLabel.style.top = `${nameLabelTop}px`;
        this.nameLabel.style.left = `${screenX + displayWidth / 2}px`;
        this.nameLabel.style.transform = 'translateX(-50%)';

        // 尺寸标签位置：位于包围盒底部下方
        const sizeLabelTop = screenY + displayHeight + sizeLabelSpacing;
        this.sizeLabel.style.top = `${sizeLabelTop}px`;
        this.sizeLabel.style.left = `${screenX + displayWidth / 2}px`;
        this.sizeLabel.style.transform = 'translateX(-50%)';
    }

    /**
     * 保存提示词入口：打开 SaveTagDialog 弹窗
     * 用户填写名字（默认"无题"）、选择模型标签后点"保存"，
     * 由回调执行真正的请求（saveTagToServer）。
     */
    savePromptTag() {
        if (this.selectedImages.length !== 1) return;
        const image = this.selectedImages[0];
        if (!image.prompt) {
            const mode = document.getElementById('promptMode')?.value;
            if (mode === 'llm') {
                alert('该图片未绑定 LLM 生成提示词，请从 LLM 生成图片后拖入画布');
            } else {
                alert('该图片未绑定 Comfy 生成提示词，请重新生成后再保存');
            }
            return;
        }

        // 记录本次待保存的图片：弹窗只创建一次，
        // 确认时读取的是最新选中的图片，而非闭包里第一次的引用
        this.pendingTagImage = image;

        if (!this.saveTagDialog) {
            this.saveTagDialog = new SaveTagDialog({
                onConfirm: ({ name, model }) =>
                    this.saveTagToServer(this.pendingTagImage, name, model)
            });
            // 挂到全局：RecipeManager 的左侧栏增删标签后会调用 refreshModels 同步选项
            window.saveTagDialog = this.saveTagDialog;
        }
        this.saveTagDialog.open();
    }

    /**
     * 调用后端接口保存图片及提示词（携带用户填写的名字与模型标签）
     * @param {Object} image - 选中的图片对象
     * @param {string} name - 用户填写的名字（默认"无题"）
     * @param {string} model - 用户选择的模型标签（可为空字符串）
     * @returns {Promise<void>} 失败时 reject，SaveTagDialog 据此保持弹窗打开
     */
    async saveTagToServer(image, name, model) {
        const response = await fetch('/api/tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: image.prompt,
                negativePrompt: image.negativePrompt || '',
                imageUrl: image.img.src,
                source: image.source || 'unknown',
                name,
                model
            })
        });
        const responseText = await response.text();
        let result;
        try {
            result = JSON.parse(responseText);
        } catch {
            throw new Error(`保存接口返回了非 JSON 内容（HTTP ${response.status}），请重启当前项目服务后重试`);
        }
        if (!response.ok) throw new Error(result.message || '保存失败');
        window.dispatchEvent(new CustomEvent('promptTagSaved', { detail: result }));
        window.socket?.showNotification(result.duplicated ? '该图片已保存，已更新名字和模型' : '图片和提示词已保存');
    }

    /**
     * 下载选中的图片方法
     * 多张选中时依次下载所有图片。
     * 对于远程 URL，通过后端代理下载，避免浏览器跨域限制导致格式/文件名异常；
     * 对于本地或内嵌图片，直接下载保持原格式；
     * 兜底方案使用 canvas 转 blob 下载。
     */
    downloadImage() {
        if (!this.selectedImages.length) {
            console.warn('⚠️ 没有可下载的图片');
            return;
        }

        for (const imgObj of this.selectedImages) {
            const img = imgObj.img;
            const filename = imgObj.name || `lumen-image-${imgObj.id.substring(0, 6)}-${Date.now()}.png`;
            const src = img?.src;

            try {
                // 远程 URL：通过后端代理下载，避免 CORS 导致文件名/格式异常
                if (src && (src.startsWith('http://') || src.startsWith('https://'))) {
                    const encodedUrl = encodeURIComponent(src);
                    const encodedFilename = encodeURIComponent(filename);
                    const proxyUrl = `/api/llm/download-image?url=${encodedUrl}&filename=${encodedFilename}`;

                    const a = document.createElement('a');
                    a.href = proxyUrl;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);

                    continue;
                }

                // data URL 或 blob URL：直接下载，保持原格式
                if (src && (src.startsWith('data:') || src.startsWith('blob:'))) {
                    const a = document.createElement('a');
                    a.href = src;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);

                    continue;
                }

                // 兜底：canvas 转 blob 下载（可能受 CORS 限制，仅用于无 src 的特殊场景）
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth || img.width;
                canvas.height = img.naturalHeight || img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);

                canvas.toBlob((blob) => {
                    if (!blob) {
                        console.error('❌ 无法创建图片blob');
                        return;
                    }

                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);

                }, 'image/png');

            } catch (error) {
                console.error('❌ 下载图片失败:', error);
            }
        }
    }

    /**
     * 添加到内容方法
     * 根据右侧面板当前模式分发目标：
     *   - LLM 模式：图片加入聊天窗口的待发送图片区（随消息发给模型）
     *   - Comfy 模式：图片加入内容缩略图列表（原有行为）
     * 两种模式的事件数据格式保持一致
     */
    addToContent() {
        if (!this.selectedImages.length) {
            console.warn('⚠️ 没有可添加的图片');
            return;
        }

        const modeSelect = document.getElementById('promptMode');
        const eventName = (modeSelect && modeSelect.value === 'llm')
            ? 'addImageToLlmAttachments'
            : 'addImageToThumbnails';

        for (const img of this.selectedImages) {

            window.dispatchEvent(new CustomEvent(eventName, {
                detail: {
                    image: {
                        id: img.id,
                        src: img.img.src,
                        width: img.width,
                        height: img.height
                    }
                }
            }));
        }
    }

    /**
     * 显示高清放大菜单方法
     * 将当前选中的所有图片数据交给 UpscaleManager 创建并显示放大选项菜单
     * @param {HTMLElement} button - 触发菜单的"高清放大"按钮元素
     */
    showUpscaleMenu(button) {
        if (!this.selectedImages.length) {
            console.warn('⚠️ 没有可放大的图片');
            return;
        }

        // 组装所有选中图片的数据数组
        const imagesData = this.selectedImages.map(img => ({
            id: img.id,
            src: img.img.src,
            name: img.name || `image-${img.id.substring(0, 6)}.png`,
            x: img.x,
            y: img.y,
            width: img.width,
            height: img.height
        }));

        // 创建并显示菜单（菜单会直接添加到 body）
        this.upscaleManager.createUpscaleMenu(button, imagesData);
    }

    /**
     * 抠图去背景
     * 依次把选中的图片发给后端 /api/rembg，成功后触发 rembgComplete 事件，
     * 由 app.js 统一把结果作为新图片添加到画板（与高清放大同一套流程）。
     */
    async removeBackground() {
        if (!this.selectedImages.length) {
            console.warn('没有可抠图的图片');
            return;
        }

        // 同一时刻只允许一个抠图任务，避免重复占用模型会话
        if (this.isRemovingBg) {
            alert('正在抠图中，请稍候...');
            return;
        }
        this.isRemovingBg = true;

        // 复制一份选中列表：抠图过程中用户可能改变选区
        const targets = this.selectedImages.slice();
        this.showToast(`抠图中 (${targets.length} 张)...`, 'processing');

        let successCount = 0;
        let failCount = 0;
        let lastError = '';

        // 抠图模型在设置中选定，此处统一读取一次供本批次所有图片使用
        const model = window.SettingsManager.getActiveRembgModel();

        try {
            for (const imgObj of targets) {
                try {
                    const imageData = await this.toBase64(imgObj.img.src);

                    const response = await fetch('/api/rembg', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ imageData, model })
                    });
                    const data = await response.json();

                    if (data.status !== 'ok' || !data.image) {
                        throw new Error(data.message || '抠图失败');
                    }

                    window.dispatchEvent(new CustomEvent('rembgComplete', {
                        detail: { originalImage: imgObj, image: data.image }
                    }));
                    successCount++;
                } catch (itemError) {
                    console.error('抠图失败:', itemError);
                    // TypeError 表示请求根本没发出去（服务未启动/断连），
                    // 浏览器给的 "Failed to fetch" 无法定位问题，这里替换成可读提示
                    lastError = itemError instanceof TypeError
                        ? '无法连接后端服务，请确认服务器已启动'
                        : itemError.message;
                    failCount++;
                }
            }

            if (failCount === 0) {
                this.showToast(`抠图完成！共 ${successCount} 张`, 'success');
            } else if (successCount === 0) {
                this.showToast('抠图失败: ' + lastError, 'error');
            } else {
                this.showToast(`抠图完成：成功 ${successCount} 张，失败 ${failCount} 张`, 'success');
            }
        } finally {
            this.isRemovingBg = false;
        }
    }

    /**
     * 将图片地址转换为 base64 数据（已是 base64 则原样返回）
     * @param {string} src - 图片地址，可能是 data: / blob: / http(s) / 相对路径
     * @returns {Promise<string>} base64 数据 URL
     */
    async toBase64(src) {
        if (src.startsWith('data:image')) return src;

        // 远程图片（如 LLM 生成后拖入画布的图）直接 fetch 会被 CORS 拦截，
        // 报错信息只有 "Failed to fetch"。改走后端代理，与下载功能保持一致。
        const url = /^https?:\/\//.test(src)
            ? `/api/llm/download-image?url=${encodeURIComponent(src)}`
            : src;

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('无法读取图片: ' + response.status);
        }
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    /**
     * 显示操作提示（复用高清放大的 toast 样式）
     * @param {string} message - 提示内容
     * @param {string} type - 提示类型：'processing' / 'success' / 'error'
     */
    showToast(message, type) {
        // 移除已有提示，避免多个 toast 重叠
        const oldToast = document.querySelector('.upscale-toast');
        if (oldToast) oldToast.remove();

        const toast = document.createElement('div');
        toast.className = `upscale-toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        // 处理中的提示保留到任务结束时被下一个 toast 替换，其余 3 秒后自动消失
        if (type !== 'processing') {
            setTimeout(() => toast.remove(), 3000);
        }
    }
}

// 将 ImageToolbar 类挂载到全局 window 对象，便于其他模块使用
window.ImageToolbar = ImageToolbar;
