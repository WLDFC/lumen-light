/**
 * ==========================================================================
 * LumenLight 系统提示词管理器
 * ==========================================================================
 * 作用：LLM 对话框的系统提示词功能，包含三部分：
 *   1. 面板头部的入口按钮（位于收起按钮旁）
 *   2. 弹窗管理界面：按场景（聊天模型 chat / 绘画模型 image）分栏，
 *      支持提示词库的新建、编辑、删除、下拉切换启用项
 *   3. 对外提供 getActiveContent(scene)，供 LlmChat 发送时取用：
 *        - chat  ：聊天模型，内容注入 chat/completions 的 system 角色
 *        - image ：生图模型，内容拼接在图片提示词前部（生图 API 无 system 角色）
 * 打开弹窗时自动定位到当前选中模型对应的场景（跟随 LlmChat 的模型类型）。
 * 数据接口：routes/prompts.js（GET/POST/PUT/DELETE /api/system-prompts），
 * 数据文件：data/prompts.json。
 * ==========================================================================
 */

class LlmSystemPrompt {
    constructor() {
        this.prompts = [];                       // 提示词库 [{id, name, scene, content, ...}]
        this.active = { chat: null, image: null }; // 各场景的启用项 id
        this.isOpen = false;                     // 弹窗开关状态
        this.currentScene = 'chat';              // 弹窗当前编辑的场景
        this.selectedId = null;                  // 弹窗中正在编辑的条目 id（null = 新建草稿）

        this.buildButton();
        this.loadLibrary();
    }

    // ==================== 入口按钮 ====================

    /**
     * 在面板头部（收起按钮旁）插入系统提示词按钮
     */
    buildButton() {
        const header = document.querySelector('.prompt-panel-header');
        const closeBtn = document.getElementById('closePrompt');
        if (!header || !closeBtn) return;

        this.btn = document.createElement('button');
        this.btn.className = 'llm-system-prompt-btn';
        this.btn.type = 'button';
        this.btn.title = '系统提示词';
        // 图标：对话气泡 + 文字行（"预设指令"语义），项目统一的无外框白色线稿
        this.btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="13" y2="13"/></svg>';
        this.btn.addEventListener('click', () => this.togglePopup());
        header.insertBefore(this.btn, closeBtn);

        // 仅 LLM 对话框模式显示按钮（Comfy 模式无系统提示词概念），
        // 初始状态与切换模式时各刷新一次
        this.updateVisibility();
        document.getElementById('promptMode')?.addEventListener('change', () => this.updateVisibility());
    }

    /**
     * 按面板当前模式刷新按钮显隐：LLM 对话框模式显示，Comfy 模式隐藏
     */
    updateVisibility() {
        if (!this.btn) return;
        const mode = document.getElementById('promptMode')?.value;
        this.btn.style.display = mode === 'llm' ? '' : 'none';
    }

    // ==================== 数据读写 ====================

    /**
     * 从后端拉取提示词库与启用状态
     */
    async loadLibrary() {
        try {
            const response = await fetch('/api/system-prompts');
            const result = await response.json();
            if (result.status === 'ok') {
                this.prompts = result.prompts || [];
                this.active = result.active || { chat: null, image: null };
                if (this.isOpen) this.renderPopup();
            }
        } catch (error) {
            console.error('系统提示词库加载失败:', error);
        }
    }

    /**
     * 获取指定场景当前启用的系统提示词内容
     * @param {'chat'|'image'} scene - 场景
     * @returns {string} 提示词内容（未启用时为空串）
     */
    getActiveContent(scene) {
        const id = this.active?.[scene];
        if (!id) return '';
        const entry = this.prompts.find((p) => p.id === id);
        return entry ? entry.content : '';
    }

    /**
     * 根据当前选中的模型类型推断场景（打开弹窗时自动定位用）
     * @returns {'chat'|'image'}
     */
    sceneFromModel() {
        const chat = window.llmChat;
        const model = chat?.modelSelect?.value;
        if (model && typeof chat.isImageModel === 'function') {
            return chat.isImageModel(model) ? 'image' : 'chat';
        }
        return 'chat';
    }

    // ==================== 弹窗 ====================

    togglePopup() {
        this.isOpen ? this.closePopup() : this.openPopup();
    }

    openPopup() {
        if (!this._popupEl) this.buildPopupDom();
        // 打开时自动定位到当前模型类型对应的场景，并选中该场景的启用项
        this.currentScene = this.sceneFromModel();
        this.selectedId = this.active[this.currentScene] || null;
        this.isOpen = true;
        this._overlay.style.display = 'flex';
        this.renderPopup();
    }

    closePopup() {
        this.isOpen = false;
        if (this._overlay) this._overlay.style.display = 'none';
    }

    /**
     * 构建弹窗 DOM（懒创建，只建一次）
     */
    buildPopupDom() {
        const overlay = document.createElement('div');
        overlay.className = 'llm-sp-overlay';
        overlay.innerHTML = `
            <div class="llm-sp-dialog">
                <div class="llm-sp-header">
                    <span class="llm-sp-title">系统提示词</span>
                    <div class="llm-sp-tabs">
                        <button type="button" data-scene="chat" class="llm-sp-tab">聊天模型</button>
                        <button type="button" data-scene="image" class="llm-sp-tab">绘画模型</button>
                    </div>
                    <button type="button" class="llm-sp-close" title="关闭"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                </div>
                <div class="llm-sp-toolbar">
                    <select class="llm-sp-list" title="选择要编辑的系统提示词"></select>
                    <label class="llm-sp-enable" title="勾选后，该提示词随每次请求发送给模型">
                        <input type="checkbox" class="llm-sp-enable-check"> 启用
                    </label>
                    <button type="button" class="llm-sp-new" title="新建一份空白提示词">新建</button>
                </div>
                <input class="llm-sp-name" type="text" placeholder="提示词名称（如：绘画顾问 / 默认风格）">
                <textarea class="llm-sp-content" placeholder="输入系统提示词内容…&#10;聊天模型：作为 system 角色随每轮请求发送&#10;绘画模型：拼接在图片提示词前部"></textarea>
                <div class="llm-sp-footer">
                    <span class="llm-sp-hint">勾选「启用」后，随每次请求发送给模型</span>
                    <button type="button" class="llm-sp-delete">删除</button>
                    <button type="button" class="llm-sp-update">保存修改</button>
                    <button type="button" class="llm-sp-saveas">另存为新条目</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        this._overlay = overlay;

        // 场景切换
        overlay.querySelectorAll('.llm-sp-tab').forEach((tab) => {
            tab.addEventListener('click', () => {
                this.currentScene = tab.dataset.scene;
                this.selectedId = this.active[this.currentScene] || null;
                this.renderPopup();
            });
        });
        // 关闭
        overlay.querySelector('.llm-sp-close').addEventListener('click', () => this.closePopup());
        overlay.addEventListener('mousedown', (e) => {
            if (e.target === overlay) this.closePopup();
        });
        // 列表切换：加载所选条目到编辑区（是否启用由「启用」勾选单独控制）
        overlay.querySelector('.llm-sp-list').addEventListener('change', (e) => {
            this.selectedId = e.target.value || null;
            this.renderPopup();
        });
        // 启用勾选：切换当前选中条目的启用状态
        overlay.querySelector('.llm-sp-enable-check').addEventListener('change', async (e) => {
            if (!this.selectedId) {
                e.target.checked = false;
                return;
            }
            await this.setActive(this.currentScene, e.target.checked ? this.selectedId : null);
        });
        // 新建草稿
        overlay.querySelector('.llm-sp-new').addEventListener('click', () => {
            this.selectedId = null;
            this.renderPopup();
        });
        // 保存 / 删除
        overlay.querySelector('.llm-sp-saveas').addEventListener('click', () => this.saveAsNew());
        overlay.querySelector('.llm-sp-update').addEventListener('click', () => this.saveUpdate());
        overlay.querySelector('.llm-sp-delete').addEventListener('click', () => this.deleteSelected());
    }

    /**
     * 按当前状态刷新弹窗（场景页签、下拉列表、编辑区）
     */
    renderPopup() {
        const overlay = this._overlay;
        if (!overlay) return;

        // 场景页签高亮
        overlay.querySelectorAll('.llm-sp-tab').forEach((tab) => {
            tab.classList.toggle('active', tab.dataset.scene === this.currentScene);
        });

        // 下拉列表：仅当前场景的条目（库为空时显示占位并禁用）
        const list = overlay.querySelector('.llm-sp-list');
        const scenePrompts = this.prompts.filter((p) => p.scene === this.currentScene);
        if (scenePrompts.length === 0) {
            list.innerHTML = '<option value="" disabled selected>暂无保存的提示词</option>';
            list.disabled = true;
        } else {
            list.disabled = false;
            list.innerHTML = scenePrompts.map((p) =>
                `<option value="${LumenLight.escapeHtml(p.id)}">${LumenLight.escapeHtml(p.name)}</option>`
            ).join('');
            list.value = this.selectedId || '';
        }

        // 编辑区：选中条目的内容，或新建草稿的空白
        const entry = this.prompts.find((p) => p.id === this.selectedId);
        overlay.querySelector('.llm-sp-name').value = entry ? entry.name : '';
        overlay.querySelector('.llm-sp-content').value = entry ? entry.content : '';

        // 没有选中条目时，启用勾选/更新/删除不可用；勾选状态反映该条目是否为启用项
        const enableCheck = overlay.querySelector('.llm-sp-enable-check');
        enableCheck.disabled = !entry;
        enableCheck.checked = !!entry && this.active[this.currentScene] === entry.id;
        overlay.querySelector('.llm-sp-update').disabled = !entry;
        overlay.querySelector('.llm-sp-delete').disabled = !entry;
    }

    /**
     * 读取弹窗编辑区内容
     */
    readEditor() {
        return {
            name: this._overlay.querySelector('.llm-sp-name').value.trim(),
            content: this._overlay.querySelector('.llm-sp-content').value
        };
    }

    /**
     * 另存为新条目（新建即启用）
     */
    async saveAsNew() {
        const { name, content } = this.readEditor();
        try {
            const response = await fetch('/api/system-prompts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, scene: this.currentScene, content })
            });
            const result = await response.json();
            if (result.status !== 'ok') {
                window.socket?.showNotification?.('保存失败: ' + (result.message || '未知错误'));
                return;
            }
            await this.loadLibrary();
            this.selectedId = result.prompt.id;
            this.renderPopup();
            window.socket?.showNotification?.('系统提示词已保存并启用');
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
            const response = await fetch(`/api/system-prompts/${this.selectedId}`, {
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
            window.socket?.showNotification?.('系统提示词已更新');
        } catch (error) {
            window.socket?.showNotification?.('保存失败: ' + error.message);
        }
    }

    /**
     * 删除当前选中的条目
     */
    async deleteSelected() {
        if (!this.selectedId) return;
        if (!confirm('确定删除这份系统提示词吗？')) return;
        try {
            const response = await fetch(`/api/system-prompts/${this.selectedId}`, { method: 'DELETE' });
            const result = await response.json();
            if (result.status !== 'ok') {
                window.socket?.showNotification?.('删除失败: ' + (result.message || '未知错误'));
                return;
            }
            await this.loadLibrary();
            this.selectedId = this.active[this.currentScene] || null;
            this.renderPopup();
            window.socket?.showNotification?.('已删除');
        } catch (error) {
            window.socket?.showNotification?.('删除失败: ' + error.message);
        }
    }

    /**
     * 设置某场景的启用项（下拉框选择即启用）
     * @param {'chat'|'image'} scene - 场景
     * @param {string|null} id - 提示词 id，null 表示不启用
     */
    async setActive(scene, id) {
        try {
            const response = await fetch('/api/system-prompts/active', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scene, id })
            });
            const result = await response.json();
            if (result.status === 'ok') {
                this.active = result.active;
            }
            this.renderPopup();
        } catch (error) {
            console.error('设置启用状态失败:', error);
        }
    }
}

// 将类暴露到全局作用域
window.LlmSystemPrompt = LlmSystemPrompt;
