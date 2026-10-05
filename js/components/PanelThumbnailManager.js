/**
 * ==========================================================================
 * LumenLight 面板缩略图管理器（PanelThumbnailManager）
 * ==========================================================================
 * 作用：右侧 Comfy 提示词面板的图片缩略图管理。从 PromptPanel 拆出，职责单一：
 *         - 槽位点击选择本地图片 / 移除按钮清空
 *         - 接收画布工具栏的 addImageToThumbnails 事件
 *         - 运行前把槽位图片按槽位序 POST 到 /api/canvas-image/{slot}
 *           （供 Edit 类工作流的 LumenReceiveImageFromCanvas 拉取）
 *
 * 槽位数量动态化（不再固定 3 张）：槽位数 = 所选工作流 JSON 里
 * LumenReceiveImageFromCanvas 取图节点的个数（由 PromptPanel 在工作流
 * 切换时经 setSlotCount 传入，0-3，0 = 整个缩略图区隐藏——文生图工作流
 * 不需要输入图）。后端槽位上限仍为 3（与 routes/canvasImages.js 的
 * MAX_SLOTS 一致），超出部分本来也不会被工作流消费。
 *
 * 状态：thumbnails 数组（长度 = 当前槽位数，null 为空）。
 * 槽位 DOM 由本类动态渲染（index.html 只保留空容器），渲染时回填
 * 已有图片数据；容器上用事件委托处理点击与文件选择。
 * ==========================================================================
 */

class PanelThumbnailManager {
    constructor() {
        // 后端槽位上限（与 routes/canvasImages.js 的 MAX_SLOTS 保持一致）
        this.maxSlots = 3;
        // 当前槽位数据（长度 = 槽位数，null 为空槽）。
        // 初始 0 槽：未选工作流时缩略图区隐藏，选中后由 setSlotCount 展开
        this.thumbnails = [];
        this.container = document.getElementById('imageThumbnails');
        this.wrap = document.getElementById('thumbnailWrap');
    }

    /**
     * 初始化：容器事件委托（点击槽位选图 / 移除按钮清空 / 文件选择）
     * 以及画布工具栏的「添加到缩略图」事件
     */
    init() {
        if (this.container) {
            this.container.addEventListener('click', (e) => this._onContainerClick(e));
            this.container.addEventListener('change', (e) => this._onFileChange(e));
        }

        // 监听添加到缩略图事件（来自画布图片工具栏）
        window.addEventListener('addImageToThumbnails', (e) => {
            const imageData = e.detail.image;
            if (!imageData) return;
            this.addImage(imageData);
        });

        this.render();
    }

    /**
     * 设置槽位数量并重渲染（工作流切换时由 PromptPanel 调用）。
     * 数量 = 所选工作流里取图节点的个数；缩小时裁掉多余槽位的数据
     * @param {number} n - 槽位数量（0 = 隐藏整个缩略图区）
     */
    setSlotCount(n) {
        const count = Math.max(0, Math.min(this.maxSlots, parseInt(n, 10) || 0));
        // 缩小时裁掉被裁掉槽位的图片数据
        while (this.thumbnails.length > count) this.thumbnails.pop();
        while (this.thumbnails.length < count) this.thumbnails.push(null);
        this.render();
    }

    /** 当前槽位数 */
    get slotCount() {
        return this.thumbnails.length;
    }

    /**
     * 渲染全部槽位 + 容器/外层显隐（0 槽 = 隐藏）。
     * 已有图片数据的槽位在渲染时回填显示状态
     */
    render() {
        if (!this.container) return;
        if (this.wrap) this.wrap.style.display = this.slotCount === 0 ? 'none' : '';

        this.container.innerHTML = '';
        for (let index = 0; index < this.slotCount; index++) {
            this.container.appendChild(this._buildSlot(index));
            const imgData = this.thumbnails[index];
            if (imgData) this._paintThumbnail(index, imgData);
        }
    }

    /**
     * 构建单个槽位 DOM（结构与旧版静态 HTML 一致，样式零改动）
     * @param {number} index - 槽位索引（0 起）
     * @returns {HTMLElement}
     */
    _buildSlot(index) {
        const slot = document.createElement('div');
        slot.className = 'thumbnail-slot';
        slot.dataset.index = String(index);
        slot.innerHTML = `
            <span class="thumbnail-placeholder">+</span>
            <img class="thumbnail-img" style="display: none;" />
            <button class="thumbnail-remove" style="display: none;">×</button>
            <input type="file" class="thumbnail-file-input" accept="image/*" style="display: none;" />`;
        return slot;
    }

    /**
     * 容器点击委托：移除按钮 → 清空；槽位其他区域 → 打开文件选择
     */
    _onContainerClick(e) {
        const slotEl = e.target.closest('.thumbnail-slot');
        if (!slotEl) return;
        const index = parseInt(slotEl.dataset.index, 10);

        if (e.target.closest('.thumbnail-remove')) {
            e.stopPropagation();
            this.clearThumbnail(index);
            return;
        }
        const fileInput = slotEl.querySelector('.thumbnail-file-input');
        if (e.target === fileInput) return;
        fileInput?.click();
    }

    /**
     * 文件选择 change 事件委托：读取图片填充到所在槽位
     */
    _onFileChange(e) {
        if (!e.target.classList.contains('thumbnail-file-input')) return;
        const slotEl = e.target.closest('.thumbnail-slot');
        const file = e.target.files[0];
        if (file && file.type.startsWith('image/') && slotEl) {
            this.loadImageFromFile(file, parseInt(slotEl.dataset.index, 10));
        }
        // 清空 input 值，允许重复选择同一张图片
        e.target.value = '';
    }

    /**
     * 添加一张图片：优先放入第一个空槽；全部占满时替换第一个槽位
     * （画布工具栏「添加到缩略图」事件走这里）。当前工作流不需要
     * 参考图（0 槽）时给出提示
     * @param {Object} imageData - { id, src, width, height }
     */
    addImage(imageData) {
        if (this.slotCount === 0) {
            window.socket?.showNotification?.('当前工作流不需要参考图');
            return;
        }
        const empty = this.thumbnails.findIndex((t) => !t);
        if (empty >= 0) {
            this.addImageToThumbnail(empty, imageData);
        } else {
            // 所有槽位都满了，替换第一个
            this.addImageToThumbnail(0, imageData);
        }
    }

    /**
     * 从本地文件读取图片并填充到指定缩略图槽位
     * @param {File} file - 图片文件对象
     * @param {number} index - 目标槽位索引（0 起）
     */
    loadImageFromFile(file, index) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const dataUrl = e.target.result;
            const img = new Image();
            img.onload = () => {
                this.setThumbnail(index, {
                    id: LumenLight.generateId(),
                    src: dataUrl,
                    width: img.width,
                    height: img.height
                });
            };
            img.src = dataUrl;
        };
        reader.readAsDataURL(file);
    }

    /**
     * 添加图片到指定缩略图槽位（支持替换已有图片）
     * @param {number} index - 槽位索引（0 起）
     * @param {object} imageData - 图片数据对象
     */
    addImageToThumbnail(index, imageData) {
        if (index < 0 || index >= this.slotCount) return;

        // 如果已有图片，只清除前端显示，不清除后端（让POST覆盖）
        if (this.thumbnails[index]) {
            this.clearThumbnail(index);
            // 注意：不发送DELETE到后端，让后续的POST直接覆盖
        }

        this.setThumbnail(index, {
            id: imageData.id,
            src: imageData.src,
            width: imageData.width,
            height: imageData.height
        });
    }

    /**
     * 设置指定槽位的图片数据并更新 UI
     * @param {number} index - 槽位索引（0 起）
     * @param {object} imgData - 图片数据对象
     */
    setThumbnail(index, imgData) {
        if (index < 0 || index >= this.slotCount) return;

        // 保存图片数据到状态
        this.thumbnails[index] = imgData;
        this._paintThumbnail(index, imgData);
    }

    /** 把槽位数据回填到槽位 UI（占位符隐藏 / 图片与移除按钮显示） */
    _paintThumbnail(index, imgData) {
        const slot = this.container.querySelector(`.thumbnail-slot[data-index="${index}"]`);
        if (!slot) return;

        const placeholder = slot.querySelector('.thumbnail-placeholder');
        const img = slot.querySelector('.thumbnail-img');
        const removeBtn = slot.querySelector('.thumbnail-remove');

        placeholder.style.display = 'none';
        img.src = imgData.src || imgData.dataUrl;
        img.style.display = 'block';
        removeBtn.style.display = 'flex';
        slot.classList.add('has-image');
    }

    /**
     * 清除指定槽位的缩略图
     * @param {number} index - 槽位索引（0 起）
     */
    clearThumbnail(index) {
        if (index < 0 || index >= this.slotCount) return;

        const slot = this.container.querySelector(`.thumbnail-slot[data-index="${index}"]`);
        if (!slot) return;

        const placeholder = slot.querySelector('.thumbnail-placeholder');
        const img = slot.querySelector('.thumbnail-img');
        const removeBtn = slot.querySelector('.thumbnail-remove');

        // 先清除数据
        this.thumbnails[index] = null;

        // 更新 UI - 先隐藏再清除 src，避免闪烁
        img.style.display = 'none';
        img.src = '';
        placeholder.style.display = 'block';
        removeBtn.style.display = 'none';
        slot.classList.remove('has-image');
    }

    /**
     * 发送所有缩略图到后端（用于 ComfyUI Edit / 局部重绘工作流）
     * 将图片转为 base64 后按槽位 POST 到 /api/canvas-image/{slot}；
     * 同时把遮罩槽位（/api/canvas-mask/{slot}）按位写/清——遮罩槽是
     * 独立的黑白遮罩图（白=重绘区），From Canvas 节点的 mask 输出读取
     *
     * 遮罩实时性：按缩略图记录的画布图片 id 回查实时对象取遮罩图层，
     * 画布对象已删除或无遮罩时清空遮罩槽并回退到添加时的快照 src——
     * 缩略图只是快照，遮罩永远是画布对象的实时图层
     */
    async sendThumbnailsToBackend() {
        for (let i = 0; i < this.slotCount; i++) {
            const imgData = this.thumbnails[i];
            const slot = i + 1; // 槽位从 1 开始

            if (imgData && imgData.src) {
                try {
                    // 按 id 回查画布实时对象（遮罩在对象上，不在快照里）
                    const canvasObj = window.canvas?.images?.images?.find(
                        (im) => im.id === imgData.id
                    );

                    // 图片：添加时的快照（原图+笔迹合成，无 alpha 洞）
                    const base64Image = await this.imageToBase64(imgData.src);

                    // 遮罩：实时对象有遮罩图层时导出黑白 PNG，否则清空遮罩槽
                    let maskPayload = null;
                    if (canvasObj && canvasObj.mask) {
                        const payload = await ImagePipeline.slotPayload(canvasObj);
                        if (payload.mask) maskPayload = payload.mask.split(',')[1];
                    }
                    await fetch(`http://localhost:8080/api/canvas-mask/${slot}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ image: maskPayload })
                    });

                    // 发送图片到后端
                    const response = await fetch(`http://localhost:8080/api/canvas-image/${slot}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ image: base64Image })
                    });

                    const result = await response.json();

                    if (!response.ok) {
                        console.error(`❌ 槽位 ${slot} 发送失败:`, result);
                    }
                } catch (e) {
                    console.error(`❌ 槽位 ${slot} 处理出错:`, e);
                }
            }
        }
    }

    /**
     * 将图片 URL 转换为 Base64 字符串
     * 如果已经是 base64 格式则直接返回数据部分
     * @param {string} src - 图片 URL 或 base64 字符串
     * @returns {Promise<string>} base64 编码的图片数据（不含 data URI 头部）
     */
    async imageToBase64(src) {
        // 如果已经是 base64 格式，直接返回
        if (src.startsWith('data:image')) {
            return src.split(',')[1];
        }

        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                resolve(canvas.toDataURL('image/png').split(',')[1]);
            };
            img.onerror = (e) => {
                console.error('图片加载失败:', src.substring(0, 50), e);
                reject(e);
            };
            img.src = src;
        });
    }
}

// 将 PanelThumbnailManager 类暴露到全局作用域
window.PanelThumbnailManager = PanelThumbnailManager;
