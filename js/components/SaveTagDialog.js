/**
 * ============================================================
 * LumenLight 保存提示词弹窗组件（SaveTagDialog）
 * ============================================================
 * 作用：用户在画布图片工具栏点击"保存提示词"后弹出本对话框，
 *       让用户在保存前为收藏补充两项元数据：
 *   1. 图片名字 —— 单行文本输入框，默认值"无题"，允许为空
 *   2. 模型标签 —— 单选标签组，选项来自后端 /api/tags/models
 *                 （与提示词页左侧栏共用同一份清单，删/建标签后自动同步），
 *                 选中项绿色高亮，允许不选（后端 model 存空字符串）
 *
 * 交互流程：
 *   点击"保存提示词" -> open() 打开弹窗（自动聚焦输入框并全选文本，
 *     同时拉取最新模型标签清单）
 *   -> 用户填写名字、选择模型标签
 *   -> 点击"保存" -> 触发 onConfirm 回调（由 ImageToolbar 提供，
 *      负责调用 POST /api/tags 并携带 name / model 字段）
 *
 * 对话框约定（与 RecipeManager 弹窗一致）：
 *   - role="dialog" + aria-modal，Esc 键关闭
 *   - 点击遮罩空白处关闭
 *   - 保存请求期间禁用按钮，防止重复提交
 *
 * 配套文件：
 *   css/save-tag-dialog.css          # 弹窗样式
 *   js/components/ImageToolbar.js    # 调用方：savePromptTag()
 *   js/components/RecipeManager.js   # 左侧栏增删标签后调用 refreshModels() 同步
 *   routes/tags.js                   # 后端接收 name / model 字段
 * ============================================================
 */
class SaveTagDialog {
    /** 后端不可用时的兜底标签（正常流程下 open() 会立即用接口数据覆盖） */
    static MODELS = ['anima', 'gpt image', 'flux2 klein', 'krea2'];

    /**
     * 构造方法：创建弹窗 DOM 并绑定事件
     * @param {Object} callbacks - 回调集合
     * @param {Function} callbacks.onConfirm - 点击保存按钮时触发，
     *   参数为 { name: string, model: string }
     *   返回 Promise：resolve 后弹窗自动关闭，reject 则保持打开
     */
    constructor({ onConfirm }) {
        this.onConfirm = onConfirm; // 确认回调（异步，由调用方实现）
        this.dialog = null;         // 弹窗根元素
        this.nameInput = null;      // 名字输入框
        this.modelChips = [];       // 模型标签按钮数组
        this.models = [...SaveTagDialog.MODELS]; // 当前标签清单（可被后端数据刷新）
        this.selectedModel = '';    // 当前选中的模型（空字符串表示未选）
        this.confirmBtn = null;     // 保存按钮（请求期间禁用）
        this.isSubmitting = false;  // 保存请求进行中标记

        this.createDialog();
        this.bindEvents();
    }

    /** 创建弹窗 DOM 结构（默认隐藏） */
    createDialog() {
        this.dialog = document.createElement('div');
        this.dialog.className = 'save-tag-dialog';
        this.dialog.setAttribute('role', 'dialog');
        this.dialog.setAttribute('aria-modal', 'true');
        this.dialog.setAttribute('aria-labelledby', 'saveTagDialogTitle');
        this.dialog.setAttribute('aria-hidden', 'true');
        this.dialog.innerHTML = `
            <section class="save-tag-dialog-panel">
                <header class="save-tag-dialog-header">
                    <h2 id="saveTagDialogTitle">保存提示词</h2>
                </header>
                <div class="save-tag-dialog-body">
                    <label class="save-tag-dialog-label" for="saveTagNameInput">名字</label>
                    <input id="saveTagNameInput" class="save-tag-name-input" type="text" maxlength="40" placeholder="无题">
                    <span class="save-tag-dialog-label">模型</span>
                    <div class="save-tag-model-chips" role="radiogroup" aria-label="生成模型"></div>
                </div>
                <footer class="save-tag-dialog-footer">
                    <button class="save-tag-cancel-btn" type="button">取消</button>
                    <button class="save-tag-confirm-btn" type="button">保存</button>
                </footer>
            </section>
        `;

        // 生成模型标签按钮（单选 radiogroup 语义，用 button 模拟）
        this.renderModelChips();

        this.nameInput = this.dialog.querySelector('.save-tag-name-input');
        this.confirmBtn = this.dialog.querySelector('.save-tag-confirm-btn');
        document.body.appendChild(this.dialog);
    }

    /** 按当前 models 清单重建标签按钮组；清单为空时显示占位提示 */
    renderModelChips() {
        const chipContainer = this.dialog.querySelector('.save-tag-model-chips');
        chipContainer.replaceChildren();
        this.modelChips = [];

        if (!this.models.length) {
            const hint = document.createElement('span');
            hint.className = 'save-tag-models-empty';
            hint.textContent = '暂无模型标签，可在提示词页左侧栏新建';
            chipContainer.appendChild(hint);
            return;
        }

        for (const model of this.models) {
            const chip = document.createElement('button');
            chip.className = 'save-tag-model-chip';
            chip.type = 'button';
            chip.textContent = model;
            chip.setAttribute('role', 'radio');
            chip.setAttribute('aria-checked', 'false');
            chip.addEventListener('click', () => this.toggleModel(chip, model));
            chipContainer.appendChild(chip);
            this.modelChips.push(chip);
        }
    }

    /**
     * 用新清单刷新模型标签选项（供 RecipeManager 左侧栏增删标签后调用）
     * 若当前选中的模型已不在新清单中，则取消选择
     * @param {string[]} modelNames - 模型名数组
     */
    refreshModels(modelNames) {
        this.models = Array.isArray(modelNames) ? modelNames : [];
        if (this.selectedModel && !this.models.includes(this.selectedModel)) {
            this.selectedModel = '';
        }
        this.renderModelChips();
    }

    /**
     * 切换模型标签选中态（单选：选中新的同时取消旧的；再次点击已选中的则取消）
     * @param {HTMLElement} chip - 被点击的标签按钮
     * @param {string} model - 该标签对应的模型名
     */
    toggleModel(chip, model) {
        if (this.selectedModel === model) {
            // 点击已选中的标签：取消选择
            this.selectedModel = '';
            chip.classList.remove('is-selected');
            chip.setAttribute('aria-checked', 'false');
            return;
        }
        // 单选：清除其他标签的选中态
        this.selectedModel = model;
        for (const c of this.modelChips) {
            c.classList.remove('is-selected');
            c.setAttribute('aria-checked', 'false');
        }
        chip.classList.add('is-selected');
        chip.setAttribute('aria-checked', 'true');
    }

    /** 绑定弹窗事件：取消、保存、Esc 关闭、点遮罩关闭、输入框回车提交 */
    bindEvents() {
        this.dialog.querySelector('.save-tag-cancel-btn')
            .addEventListener('click', () => this.close());

        this.confirmBtn.addEventListener('click', () => this.submit());

        // Esc 键关闭（保存请求进行中不允许关闭，避免状态错乱）
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen() && !this.isSubmitting) this.close();
        });

        // 点击遮罩空白处关闭
        this.dialog.addEventListener('click', (e) => {
            if (e.target === this.dialog && !this.isSubmitting) this.close();
        });

        // 名字输入框内按回车直接提交
        this.nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.submit();
            }
        });
    }

    /**
     * 打开弹窗：重置表单（默认名"无题"、清空模型选择）并聚焦输入框
     * @param {string} [defaultName='无题'] - 输入框初始内容
     */
    open(defaultName = '无题') {
        // 上一轮提交未完成时不允许重复打开
        if (this.isSubmitting) return;

        this.nameInput.value = defaultName || '无题';
        this.selectedModel = '';
        for (const chip of this.modelChips) {
            chip.classList.remove('is-selected');
            chip.setAttribute('aria-checked', 'false');
        }

        this.dialog.classList.add('is-open');
        this.dialog.setAttribute('aria-hidden', 'false');
        // 聚焦并全选默认名，用户直接输入即可覆盖"无题"
        this.nameInput.focus();
        this.nameInput.select();
        // 异步拉取最新标签清单（左侧栏可能增删过），失败保留当前清单
        this.syncModels();
    }

    /** 从后端拉取模型标签清单并刷新按钮组（静默失败） */
    async syncModels() {
        try {
            const response = await fetch('/api/tags/models');
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || '读取失败');
            this.refreshModels(result.models.map(m => m.name));
        } catch (error) {
            console.error('读取模型标签失败:', error);
        }
    }

    /** 关闭弹窗并清空提交状态 */
    close() {
        this.dialog.classList.remove('is-open');
        this.dialog.setAttribute('aria-hidden', 'true');
    }

    /** 弹窗是否处于打开状态 */
    isOpen() {
        return this.dialog.classList.contains('is-open');
    }

    /** 点击保存按钮：收集表单 -> 调用 onConfirm -> 成功后关闭 */
    async submit() {
        if (this.isSubmitting) return;
        this.isSubmitting = true;
        this.confirmBtn.disabled = true;

        try {
            const name = this.nameInput.value.trim() || '无题';
            // 调用方（ImageToolbar）返回的 Promise 抛错则保持弹窗打开
            await this.onConfirm({ name, model: this.selectedModel });
            this.close();
        } catch (error) {
            // 保存失败：弹窗保持打开，错误提示由调用方 alert
            console.error('保存提示词失败:', error);
        } finally {
            this.isSubmitting = false;
            this.confirmBtn.disabled = false;
        }
    }
}

// 将 SaveTagDialog 类挂载到全局 window 对象，便于 ImageToolbar 使用
window.SaveTagDialog = SaveTagDialog;
