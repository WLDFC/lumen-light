/**
 * ==========================================================================
 * LumenLight 面板内容槽位管理器（PanelThumbnailManager）
 * ==========================================================================
 * 作用：右侧 Comfy 提示词面板的内容槽位（图片/视频混合）管理。
 *       从 PromptPanel 拆出，职责单一：
 *         - 槽位点击选择本地图片 / 移除按钮清空
 *         - 接收画布工具栏的「添加到内容」事件（图片/视频分流）
 *         - 运行前把槽位内容按槽位序写入后端：
 *             图片槽 → POST /api/canvas-image/{slot}（base64，
 *                      供 LumenReceiveImageFromCanvas 拉取）
 *             视频槽 → POST /api/canvas-video/{slot}（引用式，
 *                      供 LumenReceiveVideoFromCanvas 拉取）
 *
 * 槽位类型化：槽位清单来自所选工作流 JSON 的内容节点
 * （LumenReceiveImageFromCanvas → image 槽 / LumenReceiveVideoFromCanvas →
 * video 槽 / 免节点工作流的原生 LoadImage → 带 loadImageId 的直注槽），
 * 由 PromptPanel.collectContentSlots 经 setSlots 传入
 * （空清单 = 整个缩略图区隐藏——文生图工作流不需要输入内容）。
 * 数量上限在扫描侧收口：Receive 图片槽 9、视频槽 3（跟随各自 Python
 * 节点）；LoadImage 直注槽不经过后端槽位、按工作流节点数自动扩展。
 *
 * 类型守卫：图片只进图片槽、视频只进视频槽——类型是工作流决定的
 * （节点侧拿到错类内容必然出错），添加时前置校验并给出提示。
 *
 * 状态：thumbnails 数组（长度 = 当前槽位数，null 为空；图片条目
 * {kind:'image', id, src, width, height}，视频条目
 * {kind:'video', videoUrl, cover, name}——视频存引用不搬字节）。
 * 槽位 DOM 由本类动态渲染（index.html 只保留空容器），渲染时回填
 * 已有内容；容器上用事件委托处理点击与文件选择。
 * ==========================================================================
 */

class PanelThumbnailManager {
    constructor() {
        // 当前槽位数据（长度 = 槽数，null 为空槽）。
        // 初始 0 槽：未选工作流时缩略图区隐藏，选中后由 setSlots 展开
        this.thumbnails = [];
        // 当前槽位定义（{kind: 'image'|'video', loadImageId?: 节点id}，
        // 与 thumbnails 按位对齐；loadImageId = 免节点直注槽的目标节点）
        this.slotDefs = [];
        // 槽位类型清单（'image' | 'video' 派生数组，旧语义保留）
        this.slotKinds = [];
        this.container = document.getElementById('imageThumbnails');
        this.wrap = document.getElementById('thumbnailWrap');
    }

    /**
     * 初始化：容器事件委托（点击槽位选图 / 移除按钮清空 / 文件选择）
     * 以及画布工具栏的「添加到内容」事件（图片与视频两个事件源）
     */
    init() {
        if (this.container) {
            this.container.addEventListener('click', (e) => this._onContainerClick(e));
            this.container.addEventListener('change', (e) => this._onFileChange(e));
        }

        // 监听添加到内容事件（来自画布图片工具栏，Comfy 模式）
        window.addEventListener('addImageToThumbnails', (e) => {
            const imageData = e.detail.image;
            if (!imageData) return;
            this.addImage(imageData);
        });

        // 监听视频添加到内容事件（来自画布视频工具栏，Comfy 模式）
        window.addEventListener('addVideoToContent', (e) => {
            const videoData = e.detail.video;
            if (!videoData) return;
            this.addVideo(videoData);
        });

        this.render();
    }

    /**
     * 设置槽位清单并重渲染（工作流切换时由 PromptPanel 调用）。
     * 条目形态：{kind: 'image'|'video', loadImageId?: 节点id}（兼容旧
     * 纯类型字符串）。LoadImage 直注槽带 loadImageId——渲染节点角标，
     * 运行时按「节点 id → 槽位内容」组 imageMapping 直注。
     * 类型不变的槽位保留已有内容；类型变化（image↔video）或被裁掉的
     * 槽位清空数据——避免运行时写出类型不匹配的脏内容
     * @param {Array<{kind: string, loadImageId?: string}|string>} defs - 槽位定义清单（空 = 隐藏整个缩略图区）
     */
    setSlots(defs) {
        const list = (Array.isArray(defs) ? defs : [])
            .map((d) => typeof d === 'string'
                ? { kind: d, loadImageId: null }
                : { kind: (d && d.kind) || 'image', loadImageId: (d && d.loadImageId) ? String(d.loadImageId) : null });
        const oldKinds = this.slotKinds;
        // 类型变化的槽位清空数据（逐位对齐比较）
        for (let i = 0; i < this.thumbnails.length; i++) {
            if (list[i] && oldKinds[i] && list[i].kind !== oldKinds[i]) {
                this.thumbnails[i] = null;
            }
        }
        this.slotDefs = list;
        this.slotKinds = list.map((d) => d.kind);
        // 对齐长度：缩小裁掉多余槽位的数据，扩大补空槽
        while (this.thumbnails.length > list.length) this.thumbnails.pop();
        while (this.thumbnails.length < list.length) this.thumbnails.push(null);
        this.render();
    }

    /** 当前槽位数 */
    get slotCount() {
        return this.thumbnails.length;
    }

    /** 指定槽位的类型（'image' | 'video'） */
    slotKind(index) {
        return this.slotKinds[index] || 'image';
    }

    /** 指定槽位的目标 LoadImage 节点 id（免节点直注槽；普通槽为 null） */
    slotLoadImageId(index) {
        return (this.slotDefs[index] && this.slotDefs[index].loadImageId) || null;
    }

    /**
     * 渲染全部槽位 + 容器/外层显隐（0 槽 = 隐藏）。
     * 已有内容的槽位在渲染时回填显示状态
     */
    render() {
        if (!this.container) return;
        if (this.wrap) this.wrap.style.display = this.slotCount === 0 ? 'none' : '';

        this.container.innerHTML = '';
        for (let index = 0; index < this.slotCount; index++) {
            const slot = this._buildSlot(index);
            this.container.appendChild(slot);
            const data = this.thumbnails[index];
            if (data) this._paintThumbnail(index, data);
        }
    }

    /**
     * 构建单个槽位 DOM（结构与旧版静态 HTML 一致，样式零改动；
     * 视频槽额外带一个常驻小播放角标，靠 CSS 按槽位类型显隐）
     * @param {number} index - 槽位索引（0 起）
     * @returns {HTMLElement}
     */
    _buildSlot(index) {
        const loadImageId = this.slotLoadImageId(index);
        const slot = document.createElement('div');
        slot.className = 'thumbnail-slot';
        slot.dataset.index = String(index);
        slot.dataset.kind = this.slotKind(index);
        if (loadImageId) slot.dataset.loadImageId = loadImageId;
        slot.innerHTML = `
            <span class="thumbnail-placeholder">+</span>
            <img class="thumbnail-img" style="display: none;" />
            <span class="thumbnail-video-badge" title="视频槽位">▶</span>
            ${loadImageId ? `<span class="thumbnail-node-badge" title="免节点直注：对应工作流 LoadImage 节点">#${loadImageId}</span>` : ''}
            <button class="thumbnail-remove" style="display: none;">×</button>
            <input type="file" class="thumbnail-file-input" accept="image/*" style="display: none;" />`;
        return slot;
    }

    /**
     * 容器点击委托：移除按钮 → 清空；图片槽其他区域 → 打开文件选择；
     * 视频槽不支持本地文件选择（视频只能来自画布——文件须先落到
     * data/videos/ 才有引用可写），点击无动作
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
        // 视频槽不弹文件选择
        if (this.slotKind(index) === 'video') return;
        const fileInput = slotEl.querySelector('.thumbnail-file-input');
        if (e.target === fileInput) return;
        fileInput?.click();
    }

    /**
     * 文件选择 change 事件委托：读取图片填充到所在槽位（仅图片槽）
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
     * 添加一张图片：优先放入第一个空图片槽；图片槽全占满时替换第一个
     * 图片槽位（画布工具栏「添加到内容」事件走这里）。当前工作流没有
     * 图片槽（0 槽或全是视频槽）时给出提示
     * @param {Object} imageData - { id, src, width, height }
     */
    addImage(imageData) {
        const imageSlots = this._slotsOfKind('image');
        if (imageSlots.length === 0) {
            window.socket?.showNotification?.('当前工作流没有图片槽位（无法接收图片）');
            return;
        }
        const empty = imageSlots.find((i) => !this.thumbnails[i]);
        const target = empty !== undefined ? empty : imageSlots[0];
        this.addImageToThumbnail(target, imageData);
    }

    /**
     * 添加一个视频引用：优先放入第一个空视频槽；视频槽全占满时替换
     * 第一个视频槽位（画布视频工具栏「添加到内容」事件走这里）。
     * 当前工作流没有视频槽时给出提示
     * @param {Object} videoData - { videoUrl, cover, name, width?, height? }
     */
    addVideo(videoData) {
        const videoSlots = this._slotsOfKind('video');
        if (videoSlots.length === 0) {
            window.socket?.showNotification?.('当前工作流没有视频槽位（无法接收视频）');
            return;
        }
        if (!videoData.videoUrl) {
            console.warn('⚠️ 视频数据缺少 videoUrl 引用，无法添加');
            return;
        }
        const empty = videoSlots.find((i) => !this.thumbnails[i]);
        const target = empty !== undefined ? empty : videoSlots[0];
        this.addVideoToThumbnail(target, videoData);
    }

    /** 按类型过滤槽位索引（保持槽位顺序） */
    _slotsOfKind(kind) {
        const result = [];
        for (let i = 0; i < this.slotCount; i++) {
            if (this.slotKind(i) === kind) result.push(i);
        }
        return result;
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
                    kind: 'image',
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
     * 添加图片到指定缩略图槽位（支持替换已有内容）
     * @param {number} index - 槽位索引（0 起）
     * @param {object} imageData - 图片数据对象
     */
    addImageToThumbnail(index, imageData) {
        if (index < 0 || index >= this.slotCount) return;

        // 如果已有内容，只清除前端显示，不清除后端（让POST覆盖）
        if (this.thumbnails[index]) {
            this.clearThumbnail(index);
            // 注意：不发送DELETE到后端，让后续的POST直接覆盖
        }

        this.setThumbnail(index, {
            kind: 'image',
            id: imageData.id,
            src: imageData.src,
            width: imageData.width,
            height: imageData.height
        });
    }

    /**
     * 添加视频引用到指定槽位（支持替换已有内容）。
     * 视频条目存引用（videoUrl 指向 data/videos/ 文件）+ 封面快照，
     * 不搬运视频字节——后端槽位与 Comfy 节点都按引用取文件
     * @param {number} index - 槽位索引（0 起）
     * @param {object} videoData - { videoUrl, cover, name, width?, height? }
     */
    addVideoToThumbnail(index, videoData) {
        if (index < 0 || index >= this.slotCount) return;

        if (this.thumbnails[index]) {
            this.clearThumbnail(index);
        }

        this.setThumbnail(index, {
            kind: 'video',
            videoUrl: videoData.videoUrl,
            cover: videoData.cover || '',
            name: videoData.name || '',
            width: videoData.width,
            height: videoData.height
        });
    }

    /**
     * 设置指定槽位的内容数据并更新 UI
     * @param {number} index - 槽位索引（0 起）
     * @param {object} data - 内容数据对象（图片或视频条目）
     */
    setThumbnail(index, data) {
        if (index < 0 || index >= this.slotCount) return;

        // 保存内容数据到状态
        this.thumbnails[index] = data;
        this._paintThumbnail(index, data);
    }

    /**
     * 把槽位数据回填到槽位 UI：
     * 图片槽隐藏占位符显示图片；视频槽显示封面 + 播放角标
     */
    _paintThumbnail(index, data) {
        const slot = this.container.querySelector(`.thumbnail-slot[data-index="${index}"]`);
        if (!slot) return;

        const placeholder = slot.querySelector('.thumbnail-placeholder');
        const img = slot.querySelector('.thumbnail-img');
        const removeBtn = slot.querySelector('.thumbnail-remove');

        placeholder.style.display = 'none';
        // 图片取 src/dataUrl；视频取封面快照
        img.src = data.src || data.dataUrl || data.cover || '';
        img.style.display = 'block';
        removeBtn.style.display = 'flex';
        slot.classList.add('has-image');
        // 视频槽加类型标记（CSS 据此显示播放角标）
        slot.classList.toggle('is-video', data.kind === 'video');
    }

    /**
     * 清除指定槽位的内容
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
        slot.classList.remove('is-video');
    }

    /**
     * 发送所有槽位内容到后端（用于 ComfyUI Edit / 重绘 / 视频参考工作流）。
     * 按槽位类型分流：
     *   图片槽：base64 POST /api/canvas-image/{slot}；同时把遮罩槽位
     *           （/api/canvas-mask/{slot}）按位写/清——遮罩槽是独立的
     *           黑白遮罩图（白=重绘区），From Canvas 节点的 mask 输出读取
     *   视频槽：引用 POST /api/canvas-video/{slot}（只传 videoUrl，
     *           后端校验文件存在于 data/videos/ 并刷新时间戳），
     *           视频槽没有遮罩语义，跳过遮罩槽写入
     *
     * 遮罩实时性：按缩略图记录的画布图片 id 回查实时对象取遮罩图层，
     * 画布对象已删除或无遮罩时清空遮罩槽并回退到添加时的快照 src——
     * 缩略图只是快照，遮罩永远是画布对象的实时图层
     */
    async sendThumbnailsToBackend() {
        for (let i = 0; i < this.slotCount; i++) {
            const data = this.thumbnails[i];
            const slot = i + 1; // 槽位从 1 开始

            // 视频槽：引用式写入
            if (data && data.kind === 'video' && data.videoUrl) {
                try {
                    const response = await fetch(`http://localhost:8080/api/canvas-video/${slot}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ videoUrl: data.videoUrl })
                    });
                    const result = await response.json().catch(() => null);
                    if (!response.ok) {
                        console.error(`❌ 视频槽位 ${slot} 写入失败:`, result);
                        window.socket?.showNotification?.(
                            `视频槽位 ${slot} 写入失败：${result?.message || response.status}`);
                    }
                } catch (e) {
                    console.error(`❌ 视频槽位 ${slot} 处理出错:`, e);
                }
                continue;
            }

            // 图片槽：原有 base64 + 遮罩逻辑
            if (data && data.src) {
                try {
                    // 按 id 回查画布实时对象（遮罩在对象上，不在快照里）
                    const canvasObj = window.canvas?.images?.images?.find(
                        (im) => im.id === data.id
                    );

                    // 图片：添加时的快照（原图+笔迹合成，无 alpha 洞）
                    const base64Image = await this.imageToBase64(data.src);

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
