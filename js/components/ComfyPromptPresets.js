/**
 * ==========================================================================
 * LumenLight Comfy 提示词预设管理器（ComfyPromptPresets）
 * ==========================================================================
 * 作用：Comfy 面板的「提示词」入口按钮 + 预设管理弹窗，参考
 *       LlmSystemPrompt（系统提示词窗口）同款骨架：遮罩居中弹窗 +
 *       正面/负面两页签 + 下拉选条目 + 名称/内容编辑 + 保存/另存/删除。
 *   1. 入口按钮：独立成钮，位于负面提示词标题条右侧（index.html
 *      cpp-topbar 内，与 LORA 叠加栏的「触发词」按钮同款位置形态
 *      ——ADR 035 同款：标题条 flex:1 近乎通栏、按钮栏外右侧 stretch
 *      等高）；点击打开弹窗，默认正面页签
 *   2. 一键注入：覆盖语义——把选中预设内容整体写入目标输入框
 *      （不派发合成 input，避开提示词自动补全建议条，与 LoRA 触发词
 *      托管块写面板框同款约定）；目标区若处于折叠态自动展开（复用
 *      折叠钮 click，折叠记忆照常落 localStorage）；注入后弹窗不关，
 *      便于正面+负面连注
 *   3. 预设分正面/负面两库，不做模型绑定字段——「不同模型不同提示词」
 *      由用户在标题里自行区分（如「anima-质量流」）；弹窗工具行展示
 *      当前工作流主模型作参照
 * 数据接口：routes/comfyPrompts.js（GET/POST/PUT/DELETE /api/comfy-prompts），
 * 数据文件：data/comfy-prompts.json。
 * ==========================================================================
 */

class ComfyPromptPresets {
    /** 三个注入目标的元数据（注入通知的文案标签用） */
    static ENTRY_POINTS = [
        { kind: 'positive', target: 'posPrompt',  label: '正面提示词 1' },
        { kind: 'positive', target: 'posPrompt2', label: '正面提示词 2' },
        { kind: 'negative', target: 'negPrompt',  label: '负面提示词' }
    ];

    /**
     * 构造函数：绑定入口按钮并拉取预设库
     */
    constructor() {
        this.presets = { positive: [], negative: [] };
        this.isOpen = false;
        this.currentKind = 'positive';   // 弹窗当前页签（positive | negative）
        this.selectedId = null;          // 弹窗中正在编辑的条目 id（null = 新建草稿）
        this.injectTarget = null;        // 入口预定向的注入目标（textarea id，独立按钮无预定向）

        this.bindEntryButton();
        this.loadLibrary();
    }

    // ==================== 入口按钮 ====================

    /**
     * 绑定独立「提示词」按钮（静态位于负面提示词标题条右侧，
     * index.html cpp-topbar 内）。标题条整条可点切换折叠——按钮
     * click 必须 stopPropagation，防止开弹窗的同时标题区跟着收放
     */
    bindEntryButton() {
        const btn = document.getElementById('comfyPresetBtn');
        if (!btn) return;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.openPopup('positive', null);
        });
    }

    // ==================== 数据读写 ====================

    /**
     * 从后端拉取预设库（正面/负面两库）
     */
    async loadLibrary() {
        try {
            const response = await fetch('/api/comfy-prompts');
            const result = await response.json();
            if (result.status === 'ok') {
                this.presets = {
                    positive: result.positive || [],
                    negative: result.negative || []
                };
                if (this.isOpen) this.renderPopup();
            }
        } catch (error) {
            console.error('Comfy 提示词预设库加载失败:', error);
        }
    }

    // ==================== 弹窗 ====================

    openPopup(kind, injectTarget) {
        if (!this._overlayEl) this.buildPopupDom();
        this.currentKind = kind || 'positive';
        this.injectTarget = injectTarget || null;
        // 选中该页签第一条（无启用项概念，库里第一条即最近可用语境）
        const list = this.presets[this.currentKind];
        this.selectedId = list.length > 0 ? list[0].id : null;
        this.isOpen = true;
        this._overlayEl.style.display = 'flex';
        this.renderPopup();
    }

    closePopup() {
        this.isOpen = false;
        if (this._overlayEl) this._overlayEl.style.display = 'none';
    }

    /**
     * 构建弹窗 DOM（懒创建，只建一次）
     */
    buildPopupDom() {
        const overlay = document.createElement('div');
        overlay.className = 'cpp-overlay';
        overlay.innerHTML = `
            <div class="cpp-dialog">
                <div class="cpp-header">
                    <span class="cpp-title">提示词预设</span>
                    <div class="cpp-tabs">
                        <button type="button" data-kind="positive" class="cpp-tab">正面提示词</button>
                        <button type="button" data-kind="negative" class="cpp-tab">负面提示词</button>
                    </div>
                    <button type="button" class="cpp-close" title="关闭"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                </div>
                <div class="cpp-toolbar">
                    <select class="cpp-list" title="选择要编辑/注入的预设"></select>
                    <button type="button" class="cpp-new" title="新建一份空白预设">新建</button>
                </div>
                <div class="cpp-model-hint"></div>
                <input class="cpp-name" type="text" placeholder="预设名称（如：anima 质量流 / 通用负面）">
                <textarea class="cpp-content" placeholder="输入提示词内容…&#10;正面预设可注入正面提示词 1 或 2，负面预设注入负面提示词"></textarea>
                <div class="cpp-footer">
                    <span class="cpp-hint">注入 = 覆盖目标输入框全部内容</span>
                    <div class="cpp-inject-group">
                        <button type="button" class="cpp-inject" data-target="posPrompt">注入正面1</button>
                        <button type="button" class="cpp-inject" data-target="posPrompt2">注入正面2</button>
                        <button type="button" class="cpp-inject" data-target="negPrompt">注入负面</button>
                    </div>
                    <button type="button" class="cpp-delete">删除</button>
                    <button type="button" class="cpp-update">保存修改</button>
                    <button type="button" class="cpp-saveas">另存为新条目</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        this._overlayEl = overlay;

        // 页签切换（正面/负面两库）
        overlay.querySelectorAll('.cpp-tab').forEach((tab) => {
            tab.addEventListener('click', () => {
                this.currentKind = tab.dataset.kind;
                const list = this.presets[this.currentKind];
                this.selectedId = list.length > 0 ? list[0].id : null;
                this.renderPopup();
            });
        });
        // 关闭：按钮 / 点遮罩空白
        overlay.querySelector('.cpp-close').addEventListener('click', () => this.closePopup());
        overlay.addEventListener('mousedown', (e) => {
            if (e.target === overlay) this.closePopup();
        });
        // 列表切换：加载所选条目到编辑区
        overlay.querySelector('.cpp-list').addEventListener('change', (e) => {
            this.selectedId = e.target.value || null;
            this.renderPopup();
        });
        // 新建草稿
        overlay.querySelector('.cpp-new').addEventListener('click', () => {
            this.selectedId = null;
            this.renderPopup();
        });
        // 注入（覆盖目标输入框）
        overlay.querySelectorAll('.cpp-inject').forEach((btn) => {
            btn.addEventListener('click', () => this.injectSelected(btn.dataset.target));
        });
        // 保存 / 删除
        overlay.querySelector('.cpp-saveas').addEventListener('click', () => this.saveAsNew());
        overlay.querySelector('.cpp-update').addEventListener('click', () => this.saveUpdate());
        overlay.querySelector('.cpp-delete').addEventListener('click', () => this.deleteSelected());
    }

    /**
     * 按当前状态刷新弹窗（页签高亮、下拉列表、编辑区、注入钮可见性）
     */
    renderPopup() {
        const overlay = this._overlayEl;
        if (!overlay) return;

        overlay.querySelectorAll('.cpp-tab').forEach((tab) => {
            tab.classList.toggle('active', tab.dataset.kind === this.currentKind);
        });

        // 下拉列表：仅当前页签的条目（库为空时显示占位并禁用）
        const list = overlay.querySelector('.cpp-list');
        const entries = this.presets[this.currentKind];
        if (entries.length === 0) {
            list.innerHTML = '<option value="" disabled selected>暂无保存的预设</option>';
            list.disabled = true;
        } else {
            list.disabled = false;
            list.innerHTML = entries.map((p) =>
                `<option value="${LumenLight.escapeHtml(p.id)}">${LumenLight.escapeHtml(p.name)}</option>`
            ).join('');
            list.value = this.selectedId || '';
        }

        // 编辑区：选中条目的内容，或新建草稿的空白
        const entry = entries.find((p) => p.id === this.selectedId) || null;
        overlay.querySelector('.cpp-name').value = entry ? entry.name : '';
        overlay.querySelector('.cpp-content').value = entry ? entry.content : '';
        overlay.querySelector('.cpp-update').disabled = !entry;
        overlay.querySelector('.cpp-delete').disabled = !entry;

        // 注入钮可见性随页签（正面页签→正面1/2，负面页签→负面），
        // 入口预定向的目标钮高亮 is-default
        const injectInPositive = this.currentKind === 'positive';
        overlay.querySelectorAll('.cpp-inject').forEach((btn) => {
            const isPositiveTarget = btn.dataset.target !== 'negPrompt';
            btn.style.display = isPositiveTarget === injectInPositive ? '' : 'none';
            btn.classList.toggle('is-default', !!entry && btn.dataset.target === this.injectTarget);
        });

        // 主模型参照（当前工作流第一个 checkpoint 下拉的值，无则隐藏）
        const hint = overlay.querySelector('.cpp-model-hint');
        const modelSelect = document.querySelector('#comfyContent select.comfy-model-select');
        const modelValue = modelSelect && modelSelect.value ? modelSelect.value : '';
        if (modelValue) {
            hint.textContent = `当前主模型：${modelValue}`;
            hint.style.display = '';
        } else {
            hint.style.display = 'none';
        }
    }

    /**
     * 读取弹窗编辑区内容
     */
    readEditor() {
        return {
            name: this._overlayEl.querySelector('.cpp-name').value.trim(),
            content: this._overlayEl.querySelector('.cpp-content').value
        };
    }

    /**
     * 一键注入：选中预设内容覆盖写入目标输入框。
     * 刻意不派发合成 input——会触发提示词自动补全弹出建议条（ADR 031
     * 同款约定）；目标区折叠时自动展开（走折叠钮 click，折叠记忆照常
     * 落 localStorage）。注入后弹窗保持打开，便于正面+负面连注
     * @param {string} target - 目标输入框 id（posPrompt | posPrompt2 | negPrompt）
     */
    injectSelected(target) {
        const entries = this.presets[this.currentKind];
        const entry = entries.find((p) => p.id === this.selectedId);
        if (!entry) {
            window.socket?.showNotification?.('先选择或保存一份预设再注入');
            return;
        }
        const box = document.getElementById(target);
        if (!box) return;
        box.value = entry.content;

        // 目标区折叠态自动展开（posPrompt1Wrap / posPrompt2Wrap / negPromptWrap）
        const wrap = document.getElementById(`${target}Wrap`);
        const toggle = document.getElementById(`${target}Toggle`);
        if (wrap && wrap.classList.contains('collapsed') && toggle) {
            toggle.click();
        }

        const ep = ComfyPromptPresets.ENTRY_POINTS.find((p) => p.target === target);
        window.socket?.showNotification?.(`已注入「${entry.name}」到${ep ? ep.label : '输入框'}`);
    }

    /**
     * 另存为新条目
     */
    async saveAsNew() {
        const { name, content } = this.readEditor();
        try {
            const response = await fetch('/api/comfy-prompts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, kind: this.currentKind, content })
            });
            const result = await response.json();
            if (result.status !== 'ok') {
                window.socket?.showNotification?.('保存失败: ' + (result.message || '未知错误'));
                return;
            }
            await this.loadLibrary();
            this.selectedId = result.entry.id;
            this.renderPopup();
            window.socket?.showNotification?.('提示词预设已保存');
        } catch (error) {
            window.socket?.showNotification?.('保存失败: ' + error.message);
        }
    }

    /**
     * 保存修改到当前选中的条目
     */
    async saveUpdate() {
        if (!this.selectedId) return;
        const { name, content } = this.readEditor();
        try {
            const response = await fetch(`/api/comfy-prompts/${this.selectedId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, content })
            });
            const result = await response.json();
            if (result.status !== 'ok') {
                window.socket?.showNotification?.('保存失败: ' + (result.message || '未知错误'));
                return;
            }
            await this.loadLibrary();
            this.renderPopup();
            window.socket?.showNotification?.('提示词预设已更新');
        } catch (error) {
            window.socket?.showNotification?.('保存失败: ' + error.message);
        }
    }

    /**
     * 删除当前选中的条目
     */
    async deleteSelected() {
        if (!this.selectedId) return;
        if (!confirm('确定删除这份提示词预设吗？')) return;
        try {
            const response = await fetch(`/api/comfy-prompts/${this.selectedId}`, { method: 'DELETE' });
            const result = await response.json();
            if (result.status !== 'ok') {
                window.socket?.showNotification?.('删除失败: ' + (result.message || '未知错误'));
                return;
            }
            await this.loadLibrary();
            const list = this.presets[this.currentKind];
            this.selectedId = list.length > 0 ? list[0].id : null;
            this.renderPopup();
            window.socket?.showNotification?.('已删除');
        } catch (error) {
            window.socket?.showNotification?.('删除失败: ' + error.message);
        }
    }
}

// 将 ComfyPromptPresets 类暴露到全局作用域
window.ComfyPromptPresets = ComfyPromptPresets;
