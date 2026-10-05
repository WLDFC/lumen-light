/**
 * ==========================================================================
 * LumenLight pi 技能库管理器
 * ==========================================================================
 * 作用：LLM 面板头部的技能库入口，包含两部分：
 *   1. 面板头部的入口按钮（双四角星图标，与系统提示词按钮同款 32px 正圆）
 *   2. 居中弹窗：查阅 data/pi/skills/ 技能库（pi agent 的 skill_list/
 *      skill_load 数据源），勾选控制启停——取消勾选 = agent 在 skill_list
 *      里看不到、skill_load 拒绝加载；勾选恢复可见可加载。状态存
 *      data/pi/settings.json 的 disabledSkills，扩展每次调用现读，即时生效。
 * 数据接口：routes/piSkills.js（GET /api/pi-skills、PUT /api/pi-skills/:id/enabled、
 *   POST /api/pi-skills/upload 上传单 .md / Agent Skills 文件夹）。
 * 点击行可展开技能正文（只读查阅）；无效技能文件（frontmatter 不合法）
 * 以灰条显示不隐藏——否则用户放了格式错的文件会以为功能坏了。
 * ==========================================================================
 */

/**
 * File → base64（不分块会触发 String.fromCharCode 参数上限，按 32KB 分块）
 * @param {File} file
 * @returns {Promise<string>}
 */
function fileToBase64(file) {
    return file.arrayBuffer().then((buf) => {
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(bin);
    });
}

class LlmSkillManager {
    constructor() {
        this.skills = [];          // [{id, name, description, enabled, body}]
        this.invalid = [];         // 无效技能文件 [{file}]
        this.isOpen = false;
        this.expandedId = null;    // 当前展开正文的技能 id

        this.buildButton();
    }

    // ==================== 入口按钮 ====================

    /**
     * 在面板头部（系统提示词按钮旁）插入技能库按钮
     */
    buildButton() {
        const header = document.querySelector('.prompt-panel-header');
        const closeBtn = document.getElementById('closePrompt');
        if (!header || !closeBtn) return;

        this.btn = document.createElement('button');
        this.btn.className = 'llm-system-prompt-btn';   // 复用头部 32px 正圆线稿按钮样式
        this.btn.type = 'button';
        this.btn.title = '技能库';
        // 图标：双四角星（sparkles，AI 技能语义）。四角星线稿在 18px 下太细，
        // 用实心填充（fill=currentColor），与项目头部纯白图标风格保持统一
        this.btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M10 2 L12 8 L18 10 L12 12 L10 18 L8 12 L2 10 L8 8 Z"/><path d="M18 12 L19.5 15.5 L23 17 L19.5 18.5 L18 22 L16.5 18.5 L13 17 L16.5 15.5 Z"/></svg>';
        this.btn.addEventListener('click', () => this.togglePopup());
        // 插到清空对话按钮前：系统提示词先插、本按钮后插，
        // 形成「系统提示词 - 技能库 - 清空对话 - 收起」头部图标组
        const anchor = document.getElementById('llmClearBtn') || closeBtn;
        anchor.parentElement.insertBefore(this.btn, anchor);

        // 仅 LLM 对话框模式显示按钮（与系统提示词按钮同款显隐逻辑）
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
     * 从后端拉取技能清单与启用状态
     */
    async loadSkills() {
        try {
            const response = await fetch('/api/pi-skills');
            const result = await response.json();
            if (result.status === 'ok') {
                this.skills = result.skills || [];
                this.invalid = result.invalid || [];
            }
        } catch (error) {
            console.error('技能库加载失败:', error);
        }
    }

    /**
     * 勾选/取消勾选（即时生效，无保存按钮）
     * @param {string} id - 技能 id
     * @param {boolean} enabled - true = agent 可见可加载
     */
    async setEnabled(id, enabled) {
        try {
            const response = await fetch(`/api/pi-skills/${encodeURIComponent(id)}/enabled`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled })
            });
            const result = await response.json();
            if (result.status !== 'ok') {
                window.socket?.showNotification?.('技能启停失败: ' + (result.message || '未知错误'));
                await this.loadSkills();   // 回读真实状态，避免勾选框与磁盘漂移
                this.renderPopup();
                return;
            }
            const skill = this.skills.find((s) => s.id === id);
            if (skill) skill.enabled = result.enabled;
            this.renderPopup();
        } catch (error) {
            window.socket?.showNotification?.('技能启停失败: ' + error.message);
            await this.loadSkills();
            this.renderPopup();
        }
    }

    // ==================== 上传 ====================

    /** 上传限制（与后端 piSkills.js 约定一致） */
    static LIMITS = { file: 1024 * 1024, total: 20 * 1024 * 1024, count: 200 };

    /**
     * 读取用户选择的文件并上传（单 .md 多选 / 文件夹webkitdirectory 均走此路）。
     * 内容统一 base64 提交（文本/二进制一致处理）；超限直接提示不发请求
     * @param {FileList} fileList
     */
    async uploadFiles(fileList) {
        const files = Array.from(fileList || []);
        const notify = (text, duration) => window.socket?.showNotification?.(text, duration);
        if (!files.length) return;
        if (files.length > LlmSkillManager.LIMITS.count) {
            notify(`一次最多上传 ${LlmSkillManager.LIMITS.count} 个文件`);
            return;
        }
        let total = 0;
        const payload = [];
        for (const f of files) {
            if (f.size > LlmSkillManager.LIMITS.file) {
                notify(`文件超过 1MB 上限: ${f.name}`);
                return;
            }
            total += f.size;
            if (total > LlmSkillManager.LIMITS.total) {
                notify('总大小超过 20MB 上限');
                return;
            }
            // 相对路径：文件夹选择时 webkitRelativePath 形如 <folder>/SKILL.md，
            // 单文件选择时只有文件名——后端据此区分两种形态
            const path = f.webkitRelativePath || f.name;
            payload.push({ path, content: await fileToBase64(f), encoding: 'base64' });
        }
        await this.sendUpload(payload);
    }

    /**
     * 提交上传；同 id 已存在（409）时确认覆盖后带 allowOverwrite 重发
     */
    async sendUpload(payload) {
        const notify = (text, duration) => window.socket?.showNotification?.(text, duration);
        const post = (allowOverwrite) => fetch('/api/pi-skills/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: payload, allowOverwrite })
        });
        try {
            let response = await post(false);
            let result = await response.json();
            if (response.status === 409 && result.exists) {
                if (!confirm(`技能「${result.id}」已存在，覆盖？`)) return;
                response = await post(true);
                result = await response.json();
            }
            if (result.status !== 'ok') {
                notify('上传失败: ' + (result.message || '未知错误'), 8000);
                return;
            }
            notify('技能已上传并即时生效');
            await this.loadSkills();
            this.renderPopup();
        } catch (error) {
            notify('上传失败: ' + error.message, 8000);
        }
    }

    // ==================== 弹窗渲染 ====================

    togglePopup() {
        this.isOpen ? this.closePopup() : this.openPopup();
    }

    openPopup() {
        if (!this._popupEl) this.buildPopupDom();
        this.isOpen = true;
        this._overlay.style.display = 'flex';
        // 每次打开都重取：pi 自己可能沉淀过新技能（目录在写门禁白名单内）
        this.loadSkills().then(() => this.renderPopup());
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
        overlay.className = 'llm-sk-overlay';
        overlay.innerHTML = `
            <div class="llm-sk-dialog">
                <div class="llm-sk-header">
                    <span class="llm-sk-title">技能库</span>
                    <span class="llm-sk-count"></span>
                    <button type="button" class="llm-sk-upload" data-kind="md" title="上传单个 .md 技能文件（可多选）">上传 .md</button>
                    <button type="button" class="llm-sk-upload" data-kind="folder" title="上传 Agent Skills 文件夹（含 SKILL.md，辅助文件一并存储）">上传文件夹</button>
                    <button type="button" class="llm-sk-close" title="关闭"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                </div>
                <div class="llm-sk-hint">勾选 = agent 可见可加载（skill_list 列出、skill_load 放行）；取消勾选 = agent 完全感知不到。改动即时生效，无需重启。支持单 .md 文件（frontmatter 必填 id/name/description）与 Agent Skills 文件夹（&lt;id&gt;/SKILL.md，id=文件夹名）。</div>
                <div class="llm-sk-list"></div>
                <div class="llm-sk-footer">
                    <span class="llm-sk-footer-hint">点击行可展开技能全文（只读查阅）</span>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        this._overlay = overlay;
        this._listEl = overlay.querySelector('.llm-sk-list');

        // 关闭：按钮 / 点击遮罩空白 / ESC
        overlay.querySelector('.llm-sk-close').addEventListener('click', () => this.closePopup());
        overlay.addEventListener('mousedown', (e) => {
            if (e.target === overlay) this.closePopup();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) this.closePopup();
        });

        // 上传：浏览器里选单文件与选文件夹互斥（webkitdirectory），两个按钮
        // 各挂一个隐藏 input；文件内容前端读成 base64 统一提交
        this._fileInput = document.createElement('input');
        this._fileInput.type = 'file';
        this._fileInput.accept = '.md';
        this._fileInput.multiple = true;
        this._fileInput.hidden = true;
        this._dirInput = document.createElement('input');
        this._dirInput.type = 'file';
        this._dirInput.setAttribute('webkitdirectory', '');
        this._dirInput.hidden = true;
        overlay.appendChild(this._fileInput);
        overlay.appendChild(this._dirInput);
        overlay.querySelector('[data-kind="md"]').addEventListener('click', () => this._fileInput.click());
        overlay.querySelector('[data-kind="folder"]').addEventListener('click', () => this._dirInput.click());
        this._fileInput.addEventListener('change', () => {
            this.uploadFiles(this._fileInput.files).finally(() => { this._fileInput.value = ''; });
        });
        this._dirInput.addEventListener('change', () => {
            this.uploadFiles(this._dirInput.files).finally(() => { this._dirInput.value = ''; });
        });
    }

    /**
     * 按当前状态刷新弹窗（技能行 + 无效文件灰条 + 计数）
     */
    renderPopup() {
        if (!this._overlay) return;
        const list = this._listEl;
        const enabledCount = this.skills.filter((s) => s.enabled).length;

        this._overlay.querySelector('.llm-sk-count').textContent =
            this.skills.length
                ? `共 ${this.skills.length} 个 · 启用 ${enabledCount} 个`
                : '';

        if (!this.skills.length && !this.invalid.length) {
            list.innerHTML = '<div class="llm-sk-empty">技能库为空（data/pi/skills/ 下没有技能文件）</div>';
            return;
        }

        const esc = (t) => LumenLight.escapeHtml(String(t ?? ''));
        list.innerHTML = this.skills.map((s) => `
            <div class="llm-sk-item${s.enabled ? '' : ' disabled'}${this.expandedId === s.id ? ' expanded' : ''}" data-id="${esc(s.id)}">
                <div class="llm-sk-row">
                    <input type="checkbox" class="llm-sk-check" ${s.enabled ? 'checked' : ''} title="勾选启用，取消勾选禁用">
                    <div class="llm-sk-main">
                        <div class="llm-sk-line">
                            <span class="llm-sk-name">${esc(s.name)}</span>
                            <span class="llm-sk-id">${esc(s.id)}</span>
                        </div>
                        <div class="llm-sk-desc">${esc(s.description)}</div>
                        ${s.id === 'comfy-quality-prompts' ? '<div class="llm-sk-warn">AGENTS.md 硬规则技能：禁用后 agent 提交 anima 工作流不再注入质量词，agent 会按技能被禁用跳过该步骤</div>' : ''}
                    </div>
                </div>
                <pre class="llm-sk-body">${esc(s.body)}</pre>
            </div>
        `).join('') + this.invalid.map((v) => `
            <div class="llm-sk-item invalid" title="${esc(v.reason || 'frontmatter 缺 id/name/description，或文件名与 id 不一致')}">
                <div class="llm-sk-row">
                    <div class="llm-sk-main">
                        <div class="llm-sk-line"><span class="llm-sk-name">无效技能文件</span><span class="llm-sk-id">${esc(v.file)}</span></div>
                        <div class="llm-sk-desc">${esc(v.reason || '格式不合法，agent 无法识别——请修正 frontmatter 或文件名（id.md）')}</div>
                    </div>
                </div>
            </div>
        `).join('');

        // 勾选：切换启停（阻止冒泡，避免触发行的展开）
        list.querySelectorAll('.llm-sk-check').forEach((check) => {
            check.addEventListener('change', (e) => {
                const id = e.target.closest('.llm-sk-item').dataset.id;
                this.setEnabled(id, e.target.checked);
            });
            check.addEventListener('click', (e) => e.stopPropagation());
        });
        // 点击行：展开/收起正文
        list.querySelectorAll('.llm-sk-item:not(.invalid)').forEach((item) => {
            item.addEventListener('click', () => {
                const id = item.dataset.id;
                this.expandedId = this.expandedId === id ? null : id;
                this.renderPopup();
            });
        });
    }
}

// 将类暴露到全局作用域
window.LlmSkillManager = LlmSkillManager;
