/**
 * ============================================================
 * LumenLight 提示词收藏详情弹窗组件（TagDetailDialog）
 * ============================================================
 * 作用：在提示词收藏页面点击卡片图片后弹出本详情弹窗，
 *       用户可以在查看大图的同时手动编辑该收藏的元数据。
 *
 * 布局（左右分栏）：
 *   左栏 —— 图片大图：自适应缩放（最大占左栏 90%），点击可调
 *           用现有 LlmLightbox 查看原生分辨率原图
 *   右栏 —— 编辑面板（从上到下）：
 *     1. 图片名字输入框（单行文本）
 *     2. 模型标签组（单选胶囊，与 SaveTagDialog 同一套交互，
 *        点击已选中的标签可取消选择）
 *     3. 参考图槽位（TagReferenceSlots，最多 5 张，选完立即上传，
 *        点击图片看大图，× 删除）
 *     4. Copy 按钮 + 提示词多行编辑框（可手动编辑提示词）
 *     5. 保存按钮：点击后调用 PUT /api/tags/:id 一次性提交
 *        名字、模型、提示词三个字段
 *
 * 交互约定：
 *   - Esc 键关闭（保存请求进行中不允许关闭）
 *   - 点击遮罩空白处关闭
 *   - 关闭后通过 onSaved 回调通知 RecipeManager 刷新卡片列表，
 *     使瀑布流上的名字 / 模型角标与编辑结果保持一致
 *
 * 配套文件：
 *   js/components/RecipeManager.js     # 调用方：卡片图片点击时 open()
 *   js/components/SaveTagDialog.js     # 模型标签清单保持一致（共用 MODELS）
 *   js/components/TagReferenceSlots.js # 参考图槽位子组件
 *   routes/tags.js                     # 后端 PUT /:id 与参考图增删接口
 *   css/tag-detail-dialog.css          # 样式（tag-detail- / tag-ref- 前缀）
 * ============================================================
 */
class TagDetailDialog {
    /**
     * 构造方法：创建弹窗 DOM 并绑定事件
     * @param {Object} callbacks - 回调集合
     * @param {Function} callbacks.onSaved - 保存成功后触发，
     *   参数为更新后的 tag 记录，调用方据此刷新列表
     * @param {Function} [callbacks.onTagUpdated] - 参考图即时增删后触发，
     *   参数为服务端返回的最新 tag 记录，调用方据此就地同步缓存列表
     *   （不触发整页刷新，避免打断当前操作）
     */
    constructor({ onSaved, onTagUpdated }) {
        this.onSaved = onSaved;         // 保存成功回调
        this.onTagUpdated = onTagUpdated; // 参考图变化回调（即时同步缓存）
        this.tag = null;            // 当前展示的收藏记录
        this.dialog = null;         // 弹窗根元素
        this.imageEl = null;        // 左栏大图
        this.nameInput = null;      // 名字输入框
        this.promptInput = null;    // 提示词编辑框
        this.modelChips = [];       // 模型标签按钮数组
        this.selectedModel = '';    // 当前选中的模型（空字符串表示未选）
        this.saveBtn = null;        // 保存按钮（请求期间禁用）
        this.isSubmitting = false;  // 保存请求进行中标记

        // 模型清单与保存弹窗保持一致
        this.models = SaveTagDialog.MODELS;

        this.createDialog();
        this.bindEvents();
    }

    /** 创建弹窗 DOM 结构（默认隐藏） */
    createDialog() {
        this.dialog = document.createElement('div');
        this.dialog.className = 'tag-detail-dialog';
        this.dialog.setAttribute('role', 'dialog');
        this.dialog.setAttribute('aria-modal', 'true');
        this.dialog.setAttribute('aria-hidden', 'true');
        this.dialog.innerHTML = `
            <section class="tag-detail-panel">
                <button class="tag-detail-close-btn" type="button" title="关闭" aria-label="关闭详情窗口">×</button>
                <div class="tag-detail-left">
                    <img class="tag-detail-image" src="" alt="收藏图片">
                </div>
                <div class="tag-detail-right">
                    <label class="tag-detail-label" for="tagDetailNameInput">名字</label>
                    <input id="tagDetailNameInput" class="tag-detail-name-input" type="text" maxlength="40" placeholder="无题">
                    <span class="tag-detail-label">模型</span>
                    <div class="tag-detail-model-chips" role="radiogroup" aria-label="生成模型"></div>
                    <span class="tag-detail-label">参考图（最多 5 张）</span>
                    <div class="tag-ref-slots-host"></div>
                    <div class="tag-detail-prompt-header">
                        <span class="tag-detail-label">提示词</span>
                        <button class="tag-detail-copy-btn" type="button" title="复制正面提示词">Copy</button>
                    </div>
                    <textarea class="tag-detail-prompt-input" placeholder="输入图片的生成提示词"></textarea>
                    <button class="tag-detail-save-btn" type="button">保存</button>
                </div>
            </section>
        `;

        // 生成模型标签按钮（单选，交互与保存弹窗一致）
        const chipContainer = this.dialog.querySelector('.tag-detail-model-chips');
        for (const model of this.models) {
            const chip = document.createElement('button');
            chip.className = 'tag-detail-model-chip';
            chip.type = 'button';
            chip.textContent = model;
            chip.setAttribute('role', 'radio');
            chip.setAttribute('aria-checked', 'false');
            chip.addEventListener('click', () => this.toggleModel(chip, model));
            chipContainer.appendChild(chip);
            this.modelChips.push(chip);
        }

        this.imageEl = this.dialog.querySelector('.tag-detail-image');
        this.nameInput = this.dialog.querySelector('.tag-detail-name-input');
        this.promptInput = this.dialog.querySelector('.tag-detail-prompt-input');
        this.saveBtn = this.dialog.querySelector('.tag-detail-save-btn');

        // 参考图槽位：挂在模型标签下方，增删即时写后端并同步内存中的 tag；
        // 同时通过 onTagUpdated 通知 RecipeManager 就地合并缓存列表，
        // 保证关闭再重开弹窗时传入的是含最新参考图的记录
        this.refSlots = new TagReferenceSlots({
            onChanged: updatedTag => {
                this.tag = updatedTag;
                this.onTagUpdated?.(updatedTag);
            }
        });
        this.dialog.querySelector('.tag-ref-slots-host').appendChild(this.refSlots.getElement());

        document.body.appendChild(this.dialog);
    }

    /**
     * 切换模型标签选中态（单选；点击已选中的标签取消选择）
     * @param {HTMLElement} chip - 被点击的标签按钮
     * @param {string} model - 该标签对应的模型名
     */
    toggleModel(chip, model) {
        if (this.selectedModel === model) {
            this.selectedModel = '';
            chip.classList.remove('is-selected');
            chip.setAttribute('aria-checked', 'false');
            return;
        }
        this.selectedModel = model;
        for (const c of this.modelChips) {
            c.classList.remove('is-selected');
            c.setAttribute('aria-checked', 'false');
        }
        chip.classList.add('is-selected');
        chip.setAttribute('aria-checked', 'true');
    }

    /** 绑定弹窗事件：关闭、保存、Esc、点遮罩关闭、复制提示词 */
    bindEvents() {
        this.dialog.querySelector('.tag-detail-close-btn')
            .addEventListener('click', () => this.close());

        // 点击遮罩空白处关闭（面板内的点击不冒泡到这里关闭）
        this.dialog.addEventListener('click', (e) => {
            if (e.target === this.dialog && !this.isSubmitting) this.close();
        });

        // Esc 键关闭（保存请求进行中不允许关闭）
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen() && !this.isSubmitting) this.close();
        });

        // 点击左栏大图：调用现有灯箱查看原生分辨率
        this.imageEl.addEventListener('click', () => {
            if (this.tag?.imageUrl) window.llmChat?.lightbox.open(this.tag.imageUrl);
        });

        // Copy 按钮：复制提示词编辑框的当前内容，成功后变绿 1.2 秒
        const copyBtn = this.dialog.querySelector('.tag-detail-copy-btn');
        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(this.promptInput.value);
                copyBtn.textContent = 'Copied';
                copyBtn.classList.add('is-copied');
                window.setTimeout(() => {
                    copyBtn.textContent = 'Copy';
                    copyBtn.classList.remove('is-copied');
                }, 1200);
            } catch (error) {
                console.error('复制提示词失败:', error);
            }
        });

        // Ctrl+Enter 快捷提交（在输入框内操作时不必移动鼠标）
        this.promptInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this.save();
            }
        });

        this.saveBtn.addEventListener('click', () => this.save());
    }

    /**
     * 打开详情弹窗：填充当前收藏记录的数据
     * @param {Object} tag - 收藏记录（含 id、name、model、prompt、imageUrl）
     */
    open(tag) {
        if (!tag || this.isSubmitting) return;
        this.tag = tag;

        this.imageEl.src = tag.imageUrl;
        this.nameInput.value = tag.name || '';
        this.promptInput.value = tag.prompt || '';

        // 回显模型标签：无 model 字段的旧记录全部保持未选
        this.selectedModel = tag.model || '';
        for (const chip of this.modelChips) {
            const isSelected = chip.textContent === this.selectedModel;
            chip.classList.toggle('is-selected', isSelected);
            chip.setAttribute('aria-checked', String(isSelected));
        }

        // 载入参考图槽位（旧收藏无 referenceImages 字段按空处理）
        this.refSlots.setTag(tag);

        this.dialog.classList.add('is-open');
        this.dialog.setAttribute('aria-hidden', 'false');
    }

    /** 关闭弹窗 */
    close() {
        this.refSlots?.closePicker();  // 收起可能开着的选图面板
        this.dialog.classList.remove('is-open');
        this.dialog.setAttribute('aria-hidden', 'true');
    }

    /** 弹窗是否处于打开状态 */
    isOpen() {
        return this.dialog.classList.contains('is-open');
    }

    /**
     * 保存编辑：收集三个字段 -> PUT /api/tags/:id -> 通知调用方刷新
     * 请求期间禁用保存按钮，失败时保持弹窗打开
     */
    async save() {
        if (!this.tag || this.isSubmitting) return;
        this.isSubmitting = true;
        this.saveBtn.disabled = true;

        try {
            const response = await fetch(`/api/tags/${encodeURIComponent(this.tag.id)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: this.nameInput.value.trim() || '无题',
                    model: this.selectedModel,
                    prompt: this.promptInput.value
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

            // 把服务端返回的最新记录回填，供调用方刷新卡片列表
            this.tag = result.tag;
            this.onSaved?.(this.tag);
            this.close();
        } catch (error) {
            alert(error.message);
        } finally {
            this.isSubmitting = false;
            this.saveBtn.disabled = false;
        }
    }
}

// 将 TagDetailDialog 类挂载到全局 window 对象，便于 RecipeManager 使用
window.TagDetailDialog = TagDetailDialog;
