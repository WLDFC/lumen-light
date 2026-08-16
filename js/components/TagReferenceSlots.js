/**
 * ============================================================
 * LumenLight 提示词收藏参考图槽位组件（TagReferenceSlots）
 * ============================================================
 * 作用：在详情弹窗（TagDetailDialog）模型标签下方渲染最多 5 个
 *       参考图槽位，样式沿用 ComfyUI 提示词栏的图片槽位
 *       （虚线框 + ＋ 占位，见 css/prompt-panel.css 的 thumbnail-slot）。
 *
 * 交互约定：
 *   1. 点击空槽位   -> 弹出选图面板：列出画布上的所有图片供点选，
 *                      面板底部同时提供"从本地选择"按钮（隐藏 file input）
 *   2. 选完立即上传 -> POST /api/tags/:id/references，成功后用响应的
 *                      tag 就地重绘槽位（不依赖二次 GET）
 *   3. 已上传槽位   -> 点击图片打开灯箱看大图；点击右上角 × 删除该
 *                      参考图（DELETE /api/tags/:id/references/:index）
 *   4. 达到 5 张上限 -> 空槽位不再显示，等待删除腾出位置
 *
 * 数据模型：tag.referenceImages 为字符串数组（"/tag/references/xxx.webp"），
 *           旧收藏无此字段时按空数组处理。
 *
 * 画布图片来源：window.canvas.images.images（ImageManager 维护的数组），
 *               每项含 img.src / name / isPlaceholder，占位图不参与选择。
 *
 * 配套文件：
 *   js/components/TagDetailDialog.js  # 宿主弹窗，在模型标签下方挂载本组件
 *   css/tag-detail-dialog.css         # 槽位与选图面板样式（tag-ref- 前缀）
 *   routes/tags.js                    # 参考图增删接口
 * ============================================================
 */
class TagReferenceSlots {
    /**
     * @param {Object} callbacks - 回调集合
     * @param {Function} callbacks.onChanged - 参考图列表变化后触发，
     *   参数为服务端返回的最新 tag 记录（宿主据此同步内存对象）
     */
    constructor({ onChanged } = {}) {
        this.onChanged = onChanged || (() => {});
        this.tag = null;        // 当前收藏记录
        this.isUploading = false; // 上传请求进行中标记（防重复提交）
        this.picker = null;     // 选图面板根元素（懒创建，同一时间最多一个）
        this.fileInput = null;  // 隐藏的本地文件选择 input（懒创建）

        this.container = document.createElement('div');
        this.container.className = 'tag-ref-slots';
        this.container.setAttribute('role', 'group');
        this.container.setAttribute('aria-label', '参考图槽位，最多 5 张');
    }

    /** 挂载点元素（由宿主插入到模型标签下方） */
    getElement() {
        return this.container;
    }

    /**
     * 载入收藏记录并重绘槽位
     * @param {Object} tag - 收藏记录（referenceImages 可能为空/缺失）
     */
    setTag(tag) {
        this.tag = tag;
        this.closePicker(); // 切换收藏时收起上一个选图面板
        this.render();
    }

    /** 当前参考图 URL 列表（缺失字段按空数组处理） */
    getImages() {
        return (this.tag && this.tag.referenceImages) || [];
    }

    /** 重绘全部槽位：已有图片的实线槽 + 剩余空槽（＋ 占位） */
    render() {
        const images = this.getImages();
        this.container.replaceChildren();

        for (let i = 0; i < images.length; i++) {
            this.container.appendChild(this.createFilledSlot(images[i], i));
        }
        // 未满 5 张时补一个空槽位用于添加
        if (images.length < 5) {
            this.container.appendChild(this.createEmptySlot());
        }
    }

    /**
     * 创建空槽位：虚线框 + ＋ 占位，点击弹出选图面板
     * @returns {HTMLElement}
     */
    createEmptySlot() {
        const slot = document.createElement('div');
        slot.className = 'tag-ref-slot';
        slot.title = '添加参考图（画布图片或本地文件）';

        const placeholder = document.createElement('span');
        placeholder.className = 'tag-ref-placeholder';
        placeholder.textContent = '＋';
        slot.appendChild(placeholder);

        slot.addEventListener('click', () => this.openPicker());
        return slot;
    }

    /**
     * 创建已上传槽位：图片缩略图 + 右上角删除 ×
     * 点击图片打开灯箱看大图；点击 × 删除该参考图
     * @param {string} url - 参考图 URL
     * @param {number} index - 在 referenceImages 中的下标
     * @returns {HTMLElement}
     */
    createFilledSlot(url, index) {
        const slot = document.createElement('div');
        slot.className = 'tag-ref-slot has-image';
        slot.title = '点击查看大图';

        const img = document.createElement('img');
        img.className = 'tag-ref-img';
        img.src = url;
        img.alt = `参考图 ${index + 1}`;
        img.loading = 'lazy';
        slot.appendChild(img);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'tag-ref-remove';
        removeBtn.type = 'button';
        removeBtn.textContent = '×';
        removeBtn.title = '移除参考图';
        removeBtn.setAttribute('aria-label', `移除参考图 ${index + 1}`);
        removeBtn.addEventListener('click', async event => {
            event.stopPropagation(); // 阻止触发图片点击看大图
            await this.removeReference(index);
        });
        slot.appendChild(removeBtn);

        // 点击已上传图片：复用现有灯箱查看大图
        slot.addEventListener('click', () => {
            if (window.llmChat?.lightbox) window.llmChat.lightbox.open(url);
        });
        return slot;
    }

    /** 打开选图面板：面板跟随槽位下方弹出，重复点击切换显隐 */
    openPicker() {
        if (this.picker?.isConnected) { this.closePicker(); return; }

        this.picker = this.createPicker();
        // 面板插入槽位容器之后（覆盖在编辑面板上层，不挤压布局）
        this.container.appendChild(this.picker);
        this.renderPickerImages();

        // 点击面板外部时收起（面板内部已阻止冒泡，不会误关）
        // 先在下一个宏任务再绑定，避免本次点击自身触发关闭
        this.outsideClickHandler = () => this.closePicker();
        setTimeout(() => {
            document.addEventListener('click', this.outsideClickHandler, { once: true });
        }, 0);
    }

    /** 收起选图面板 */
    closePicker() {
        if (this.outsideClickHandler) {
            document.removeEventListener('click', this.outsideClickHandler);
            this.outsideClickHandler = null;
        }
        this.picker?.remove();
        this.picker = null;
    }

    /**
     * 创建选图面板：上半部分是画布图片网格，底部是"从本地选择"按钮
     * @returns {HTMLElement}
     */
    createPicker() {
        const picker = document.createElement('div');
        picker.className = 'tag-ref-picker';

        // 点击面板内部不冒泡关闭（选项点击靠自身处理）
        picker.addEventListener('click', event => event.stopPropagation());

        const grid = document.createElement('div');
        grid.className = 'tag-ref-picker-grid';
        picker.appendChild(grid);

        const footer = document.createElement('div');
        footer.className = 'tag-ref-picker-footer';

        const localBtn = document.createElement('button');
        localBtn.type = 'button';
        localBtn.className = 'tag-ref-picker-local-btn';
        localBtn.textContent = '从本地选择…';
        localBtn.addEventListener('click', () => this.getFileInput().click());
        footer.appendChild(localBtn);

        const emptyHint = document.createElement('span');
        emptyHint.className = 'tag-ref-picker-empty';
        emptyHint.textContent = '画布上没有图片';
        picker.appendChild(emptyHint);

        picker.append(footer);
        return picker;
    }

    /**
     * 渲染选图面板中的画布图片网格
     * 画布无图片时显示提示文案；点击缩略图立即上传
     */
    renderPickerImages() {
        if (!this.picker?.isConnected) return;
        const grid = this.picker.querySelector('.tag-ref-picker-grid');
        const emptyHint = this.picker.querySelector('.tag-ref-picker-empty');
        // 过滤掉占位图（生成过程中的反馈动画图不作为参考图来源）
        const canvasImages = (window.canvas?.images?.images || [])
            .filter(item => !item.isPlaceholder);

        grid.replaceChildren();
        emptyHint.style.display = canvasImages.length ? 'none' : 'block';

        for (const item of canvasImages) {
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.className = 'tag-ref-picker-cell';
            cell.title = item.name || '画布图片';
            cell.setAttribute('aria-label', `选择画布图片 ${item.name || ''}`);

            const thumb = document.createElement('img');
            thumb.src = item.img.src;
            thumb.alt = '';
            thumb.loading = 'lazy';
            cell.appendChild(thumb);

            cell.addEventListener('click', () => {
                this.closePicker();
                this.uploadReference(item.img.src);
            });
            grid.appendChild(cell);
        }
    }

    /** 懒创建隐藏的本地文件选择 input（挂在槽位容器下） */
    getFileInput() {
        if (!this.fileInput?.isConnected) {
            this.fileInput = document.createElement('input');
            this.fileInput.type = 'file';
            this.fileInput.accept = 'image/*';
            this.fileInput.className = 'tag-ref-file-input';
            // 选择后立即上传；完成后清空 value 以便再次选择同一文件
            this.fileInput.addEventListener('change', () => {
                const file = this.fileInput.files[0];
                if (file) this.uploadFile(file);
                this.fileInput.value = '';
            });
            this.container.appendChild(this.fileInput);
        }
        return this.fileInput;
    }

    /**
     * 上传本地文件：先读为 Base64 Data URL 再走统一上传通道
     * @param {File} file
     */
    uploadFile(file) {
        const reader = new FileReader();
        reader.onload = event => this.uploadReference(event.target.result);
        reader.onerror = () => alert('读取本地图片失败');
        reader.readAsDataURL(file);
    }

    /**
     * 上传参考图：POST /api/tags/:id/references
     * 成功后用响应的 tag 更新本地记录并重绘，通知宿主同步
     * @param {string} imageUrl - 图片地址（data URL / 本站路径 / 外链）
     */
    async uploadReference(imageUrl) {
        if (!this.tag || this.isUploading) return;
        if (this.getImages().length >= 5) { alert('参考图最多 5 张'); return; }

        this.isUploading = true;
        try {
            const response = await fetch(`/api/tags/${encodeURIComponent(this.tag.id)}/references`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imageUrl })
            });
            const responseText = await response.text();
            let result;
            try {
                result = JSON.parse(responseText);
            } catch {
                throw new Error(`接口返回了非 JSON 内容（HTTP ${response.status}）`);
            }
            if (!response.ok) throw new Error(result.message || '上传失败');

            this.tag = result.tag;
            this.render();
            this.onChanged(result.tag);
        } catch (error) {
            alert(error.message);
        } finally {
            this.isUploading = false;
        }
    }

    /**
     * 删除指定下标的参考图：DELETE /api/tags/:id/references/:index
     * @param {number} index
     */
    async removeReference(index) {
        if (!this.tag || this.isUploading) return;
        this.isUploading = true;
        try {
            const response = await fetch(
                `/api/tags/${encodeURIComponent(this.tag.id)}/references/${index}`,
                { method: 'DELETE' }
            );
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.message || '删除失败');

            this.tag = result.tag;
            this.render();
            this.onChanged(result.tag);
        } catch (error) {
            alert(error.message);
        } finally {
            this.isUploading = false;
        }
    }
}

// 将 TagReferenceSlots 类挂载到全局，供 TagDetailDialog 使用
window.TagReferenceSlots = TagReferenceSlots;
