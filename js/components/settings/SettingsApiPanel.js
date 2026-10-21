/**
 * ==========================================================================
 * LumenLight 设置 - API 面板
 * 作用：渲染「API」分类，负责提供商切换、端点地址、API Key、模型列表的
 *       增删改，以及从提供商拉取可用模型、把设置保存到后端。
 *       提供商分两类：内置五家（Deepseek / OpenAI兼容 / 豆包 / 阿里云百炼 /
 *       魔搭ModelScope）与
 *       用户自由添加的「OpenAI 兼容」自定义厂商（自命名、可添加任意个、
 *       可删除，协议与内置 OpenAI兼容 完全一致）。
 * 数据约定：设置本体存放在 SettingsManager.settings 中（按厂商分组），
 *           自定义厂商就是 providers Map 里的自由键名，后端无白名单，
 *           本面板只负责「表单 <-> settings」之间的收集与回填。
 * 由 SettingsManager 在构造时实例化并按分类调用 render()。
 * ==========================================================================
 */

class SettingsApiPanel {
    /** 内置提供商（固定五家，不可删除）；其余 providers 键均为自定义厂商 */
    static BUILTIN_PROVIDERS = [
        { key: 'Deepseek', label: 'Deepseek' },
        { key: 'OpenAI', label: 'OpenAI兼容' },
        { key: 'Doubao', label: '豆包 / 火山方舟' },
        { key: 'DashScope', label: '阿里云百炼' },
        { key: 'ModelScope', label: '魔搭ModelScope' }
    ];

    /** 内置提供商的官方 OpenAI 兼容端点：配置为空时作为预填值展示，
     *  用户粘贴 Key 即可直接「保存设置」启用（自定义厂商无预填） */
    static DEFAULT_ENDPOINTS = {
        Deepseek: 'https://api.deepseek.com/v1',
        OpenAI: 'https://api.openai.com/v1',
        Doubao: 'https://ark.cn-beijing.volces.com/api/v3',
        DashScope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        ModelScope: 'https://api-inference.modelscope.cn/v1'
    };

    /** agent（pi）上下文窗口的取值钳制与留空默认值。
     *  默认 307200（300K）与 piAgentManager.getProviderConfig 的透传默认一致
     *  （2026-10-28 由 128K 上调，用户拍板） */
    static CTX_TOKEN_MIN = 1024;
    static CTX_TOKEN_MAX = 10485760;
    static CTX_DEFAULT_TOKENS = 307200;
    static CTX_DEFAULT_LABEL = '300K';

    /** 单次回复输出上限的取值钳制与留空默认值（默认 8192，同上） */
    static MAXTOK_TOKEN_MIN = 256;
    static MAXTOK_TOKEN_MAX = 1048576;
    static MAXTOK_DEFAULT_TOKENS = 8192;
    static MAXTOK_DEFAULT_LABEL = '8K';

    /**
     * 解析 token 数输入：纯数字按 tokens，数字后缀 k/K 按 ×1024
     * （128K → 131072），结果钳制到 [min, max]；空串/非法返回 null
     * @param {string} raw - 输入框原始值
     * @param {number} min - 最小值
     * @param {number} max - 最大值
     * @returns {number|null}
     */
    static parseTokenField(raw, min, max) {
        const text = (raw || '').trim();
        if (!text) return null;
        const m = /^(\d+)([kK])?$/.exec(text);
        if (!m) return null;
        let value = parseInt(m[1], 10) * (m[2] ? 1024 : 1);
        if (value < min) value = min;
        if (value > max) value = max;
        return value;
    }

    /**
     * token 数的表单展示值：1024 的整数倍显示为 K 形式（131072 → 128K，
     * 与 parseTokenField 的 K 写法互逆），其余原样；非法/缺失返回空串
     * @param {number|string} value - settings 里存的 token 数
     * @returns {string}
     */
    static formatTokenField(value) {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return '';
        return n % 1024 === 0 ? `${n / 1024}K` : String(n);
    }

    /** 模型行操作按钮的 SVG 线框图标：stroke 走 currentColor，
     *  颜色/悬停/结果态全部由 CSS 控制（与设置面板深色主题同源） */
    static ICONS = {
        // 插头：测试链接
        test: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 1.5v3M10.5 1.5v3M4 4.5h8v2.5a4 4 0 0 1-8 0z"/><path d="M8 11v3.5"/></svg>',
        // 铅笔：编辑
        edit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.1 2.3a1.9 1.9 0 0 1 2.6 2.6L5.5 13.1l-3.4.8.8-3.4z"/><path d="M10 3.4l2.6 2.6"/></svg>',
        // 垃圾桶：删除
        trash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.2h11"/><path d="M6.3 4V2.9c0-.5.4-.9.9-.9h1.6c.5 0 .9.4.9.9V4"/><path d="M4.1 4.2l.6 8.9c0 .5.4.9.9.9h4.8c.5 0 .9-.4.9-.9l.6-8.9"/><path d="M6.6 7v4.3M9.4 7v4.3"/></svg>'
    };
    /**
     * @param {SettingsManager} manager - 设置管理器实例（提供 contentEl、settings 等）
     */
    constructor(manager) {
        this.manager = manager;

        // 从 API 提供商获取到的原始模型 ID 列表，供模型行的下拉框使用
        this.fetchedModels = [];
    }

    /**
     * settings 的快捷访问器，避免每处都写 this.manager.settings
     * @returns {Object} 设置对象
     */
    get settings() {
        return this.manager.settings;
    }

    /**
     * 获取当前选中厂商的配置
     * @returns {Object} { endpoint, apiKey, models }
     */
    getCurrentProviderConfig() {
        const api = this.settings.api || {};
        const provider = api.currentProvider || 'Deepseek';
        const providers = api.providers || {};
        return providers[provider] || { endpoint: '', apiKey: '', models: [] };
    }

    /**
     * 渲染 API 设置内容
     */
    render() {
        const contentEl = this.manager.contentEl;
        if (!contentEl) return;

        const api = this.settings.api || {};
        const currentProvider = api.currentProvider || 'Deepseek';
        const config = this.getCurrentProviderConfig();
        const models = Array.isArray(config.models) ? config.models : [];

        // 技能模型绑定（api.bindings.skill）已删除：技能模型选择迁移到
        // 提示词节点技能栏（PromptSkillBar 模型下拉，2026-10）

        // RunningHub 云端工作流配置（apiKey/endpoint + 工作流登记卡列表）
        const rh = this.settings.runninghub || {};
        const rhWorkflows = Array.isArray(rh.workflows) ? rh.workflows : [];

        // 根据当前提供商显示对应的模型提示
        const modelHint = this.getProviderModelHint(currentProvider);

        // 厂商下拉：内置五家 + 自定义厂商（providers 里的自由键名）
        const providerOptions = [
            ...SettingsApiPanel.BUILTIN_PROVIDERS.map((p) =>
                `<option value="${p.key}" ${currentProvider === p.key ? 'selected' : ''}>${p.label}</option>`
            ),
            ...this.getCustomProviderKeys().map((key) =>
                `<option value="${LumenLight.escapeHtml(key)}" ${currentProvider === key ? 'selected' : ''}>${LumenLight.escapeHtml(key)}</option>`
            )
        ].join('');
        const isCustom = this.isCustomProvider(currentProvider);

        contentEl.innerHTML = `
            <div class="settings-form">
                <div class="settings-form-item">
                    <label for="settingsApiProvider">API 提供商</label>
                    <div class="settings-provider-row">
                        <select id="settingsApiProvider" class="settings-input">${providerOptions}</select>
                        <button type="button" class="settings-models-btn" id="settingsAddProviderBtn">+ 添加兼容厂商</button>
                        ${isCustom ? '<button type="button" class="settings-models-btn danger" id="settingsDeleteProviderBtn">删除该厂商</button>' : ''}
                    </div>
                </div>
                <div class="settings-form-item" id="settingsNewProviderRow" style="display: none;">
                    <label for="settingsNewProviderName">新厂商名称（OpenAI 兼容协议）</label>
                    <div class="settings-provider-row">
                        <input type="text" id="settingsNewProviderName" class="settings-input"
                               placeholder="例如：中转站A / 本地 LM Studio" maxlength="30">
                        <button type="button" class="settings-models-btn primary" id="settingsNewProviderConfirm">添加</button>
                        <button type="button" class="settings-models-btn" id="settingsNewProviderCancel">取消</button>
                    </div>
                </div>
                <div class="settings-form-item">
                    <label for="settingsApiEndpoint">端点地址</label>
                    <input type="text" id="settingsApiEndpoint" class="settings-input"
                           placeholder="https://api.example.com/v1"
                           value="${LumenLight.escapeHtml(config.endpoint || SettingsApiPanel.DEFAULT_ENDPOINTS[currentProvider] || '')}">
                </div>
                <div class="settings-form-item">
                    <label for="settingsApiKey">API Key</label>
                    <input type="password" id="settingsApiKey" class="settings-input"
                           placeholder="sk-..." value="${LumenLight.escapeHtml(config.apiKey || '')}">
                </div>

                <!-- 模型配置 -->
                <div class="settings-models-section">
                    <div class="settings-models-header">
                        <span class="settings-models-title">模型配置</span>
                        <div class="settings-models-actions">
                            <button class="settings-models-btn" id="settingsFetchModelsBtn" type="button">
                                 获取模型列表
                            </button>
                            <button class="settings-models-btn primary" id="settingsAddModelBtn" type="button">
                                + 添加模型
                            </button>
                        </div>
                    </div>
                    <div class="settings-models-table">
                        <div class="settings-models-row head">
                            <span>模型 ID</span>
                            <span>类型</span>
                            <span>操作</span>
                        </div>
                        <div class="settings-models-body" id="settingsModelsBody">
                            ${models.map((model, index) => this.renderModelRow(model, index)).join('')}
                        </div>
                    </div>
                    <div class="settings-models-hint">${modelHint}<br>
                        🔌 测试链接：检查端点可达性与该模型是否在清单中（部分中转 /models 不全，不在清单只作提醒）；
                        ✏️ 编辑：显示名称（留空显示模型 ID）与 agent 上下文/输出上限（${SettingsApiPanel.CTX_DEFAULT_LABEL} / ${SettingsApiPanel.MAXTOK_DEFAULT_LABEL}
                        或 ${SettingsApiPanel.CTX_DEFAULT_TOKENS} / ${SettingsApiPanel.MAXTOK_DEFAULT_TOKENS} 写法，留空用默认，仅影响 agent 压缩时机与输出预算，不改变模型真实上限）；
                        开关关闭后该模型在所有模型下拉与 agent 中隐藏。
                    </div>
                </div>

                <!-- RunningHub 云端配置：仅 Key 与端点（工作流/应用的 ID 输入
                     与参数拉取在画布节点上完成，登记卡模式已退役但旧数据仍兼容） -->
                <div class="settings-models-section">
                    <div class="settings-models-header">
                        <span class="settings-models-title">RunningHub（云端工作流/应用）</span>
                    </div>
                    <div class="settings-form-item">
                        <label for="settingsRhApiKey">API Key</label>
                        <input type="password" id="settingsRhApiKey" class="settings-input"
                               placeholder="RunningHub 个人中心 → API 令牌"
                               value="${LumenLight.escapeHtml(rh.apiKey || '')}">
                    </div>
                    <div class="settings-form-item">
                        <label for="settingsRhEndpoint">API 地址（高级，留空用官方默认）</label>
                        <input type="text" id="settingsRhEndpoint" class="settings-input"
                               placeholder="https://www.runninghub.cn"
                               value="${LumenLight.escapeHtml(rh.endpoint || '')}">
                    </div>
                    <div class="settings-models-hint">
                        工作流/应用不用在这里登记：画布上新建 RunningHub 节点，把平台页 URL 末段的
                        纯数字 ID 填进节点后点「拉取」，参数模板自动解析成参数行并随存档保存。
                        此前登记过的 ${rhWorkflows.length} 张工作流卡仍对旧存档节点生效（在节点「最近」下拉的「已登记」分组）。
                    </div>
                </div>

                <div class="settings-form-actions">
                    <button class="settings-save-btn" id="settingsSaveBtn">保存设置</button>
                </div>
                <div class="settings-save-status" id="settingsSaveStatus"></div>
            </div>
        `;

        // 绑定保存事件
        document.getElementById('settingsSaveBtn').addEventListener('click', () => this.save());

        // 绑定提供商切换事件：自动填充默认端点
        const providerSelect = document.getElementById('settingsApiProvider');
        providerSelect?.addEventListener('change', () => this.onProviderChange());

        // 绑定自定义厂商：添加（展开输入行）/ 取消 / 确认 / 删除（两段式确认）
        document.getElementById('settingsAddProviderBtn')?.addEventListener('click', () => {
            document.getElementById('settingsNewProviderRow').style.display = '';
            document.getElementById('settingsNewProviderName').focus();
        });
        document.getElementById('settingsNewProviderCancel')?.addEventListener('click', () => {
            document.getElementById('settingsNewProviderRow').style.display = 'none';
        });
        document.getElementById('settingsNewProviderConfirm')?.addEventListener('click', () => this.confirmAddProvider());
        document.getElementById('settingsNewProviderName')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.confirmAddProvider();
        });
        document.getElementById('settingsDeleteProviderBtn')?.addEventListener('click', (e) => this.confirmDeleteProvider(e.currentTarget));

        // 绑定模型配置事件
        const fetchBtn = document.getElementById('settingsFetchModelsBtn');
        const addBtn = document.getElementById('settingsAddModelBtn');

        fetchBtn?.addEventListener('click', () => this.fetchModels());
        addBtn?.addEventListener('click', () => this.addModel());

        // 模型行操作事件（事件委托）：测试链接 / 编辑弹窗 / 删除
        const modelsBody = document.getElementById('settingsModelsBody');
        modelsBody?.addEventListener('click', (e) => {
            const testBtn = e.target.closest('.settings-model-test');
            if (testBtn) {
                this.testModelConnection(parseInt(testBtn.dataset.index, 10), testBtn);
                return;
            }
            const editBtn = e.target.closest('.settings-model-edit');
            if (editBtn) {
                this.openModelEditModal(parseInt(editBtn.dataset.index, 10));
                return;
            }
            const deleteBtn = e.target.closest('.settings-model-delete');
            if (deleteBtn) {
                this.removeModel(parseInt(deleteBtn.dataset.index, 10));
            }
        });

        // RunningHub 区只剩 Key/端点两个输入（ID 与拉取在画布节点上），
        // 无额外事件绑定
    }

    /**
     * 离开该分类时的清理钩子
     * API 面板没有定时器或订阅，留空以统一面板接口
     */
    onLeave() {
        // 无需清理
    }

    /**
     * 获取不同提供商对应的模型填写提示
     * @param {string} provider - 提供商名称
     * @returns {string} 提示文字
     */
    getProviderModelHint(provider) {
        switch (provider) {
            case 'Doubao':
                return '豆包请填写火山方舟的推理接入点 ID（通常以 ep- 开头），而不是模型名称';
            case 'Deepseek':
                return 'Deepseek 直接填写模型名称，例如 deepseek-chat';
            case 'OpenAI':
                return 'OpenAI兼容接口直接填写模型名称，例如 gpt-4o';
            case 'DashScope':
                return '百炼走 OpenAI 兼容模式（compatible-mode），模型名称如 qwen-plus、qwen3-max、qwen3-vl-plus（带视觉）；Key 在百炼控制台「API-KEY」页创建';
            case 'ModelScope':
                return '魔搭免费推理 API，模型 ID 需带组织前缀，如 Qwen/Qwen3-235B-A22B-Instruct-2507、deepseek-ai/DeepSeek-V3.2（点「获取模型列表」可拉全量）；Token 在魔搭「访问令牌」页创建，按天有免费额度';
            default:
                if (this.isCustomProvider(provider)) {
                    return '自定义厂商走 OpenAI 兼容协议，直接填写模型名称；请确保与其他厂商的模型 ID 不重复，否则同名模型只会路由到先配置的厂商';
                }
                return '配置可用的模型及其显示名称';
        }
    }

    // ==================== 自定义厂商（OpenAI 兼容） ====================

    /**
     * 列出所有自定义厂商的键名（providers 中不在内置名单里的键）
     * @returns {string[]}
     */
    getCustomProviderKeys() {
        const builtinKeys = SettingsApiPanel.BUILTIN_PROVIDERS.map((p) => p.key);
        return Object.keys((this.settings.api && this.settings.api.providers) || {})
            .filter((name) => !builtinKeys.includes(name));
    }

    /**
     * 判断是否为自定义厂商
     * @param {string} name - 厂商名
     * @returns {boolean}
     */
    isCustomProvider(name) {
        return !!name && !SettingsApiPanel.BUILTIN_PROVIDERS.some((p) => p.key === name);
    }

    /**
     * 确认添加自定义厂商：校验名称 → 建立空配置 → 切换到该厂商开始填写。
     * 仅改内存中的 settings，与其他表单编辑一致，点「保存设置」后落盘。
     */
    confirmAddProvider() {
        const input = document.getElementById('settingsNewProviderName');
        const name = (input?.value || '').trim();

        if (!name) {
            alert('请输入厂商名称');
            return;
        }
        const providers = (this.settings.api && this.settings.api.providers) || {};
        if (providers[name]) {
            alert(`厂商「${name}」已存在`);
            return;
        }

        // 建立空配置并切换过去（switchProvider 会先把当前表单内容存回原厂商）
        providers[name] = { endpoint: '', apiKey: '', models: [] };
        if (!this.settings.api) this.settings.api = {};
        this.settings.api.providers = providers;
        this.switchProvider(name);
    }

    /**
     * 删除当前选中的自定义厂商（两段式确认：第一次点击变为「确认删除？」）。
     * 同时清理指向该厂商的技能绑定，并把当前厂商回退到 Deepseek。
     * 仅改内存中的 settings，点「保存设置」后落盘。
     * @param {HTMLElement} btn - 删除按钮（用于两段式确认的状态标记）
     */
    confirmDeleteProvider(btn) {
        // 第一次点击：进入待确认态，再次点击才真正删除
        if (btn.dataset.confirming !== 'true') {
            btn.dataset.confirming = 'true';
            btn.textContent = '确认删除？';
            btn.classList.add('danger-confirm');
            return;
        }

        const name = (this.settings.api && this.settings.api.currentProvider) || '';
        const api = this.settings.api;
        delete api.providers[name];

        api.currentProvider = 'Deepseek';
        this.fetchedModels = [];
        this.render();
        this.flashStatus(`已移除厂商「${name}」，点击「保存设置」后生效`);
    }

    /**
     * 在面板底部状态区闪现一条提示（2.5 秒后自动清除）
     * @param {string} text - 提示文字
     */
    flashStatus(text) {
        const statusEl = document.getElementById('settingsSaveStatus');
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.className = 'settings-save-status';
        setTimeout(() => {
            if (statusEl.textContent === text) statusEl.textContent = '';
        }, 2500);
    }

    /**
     * 提供商切换处理
     * 切换前先把当前表单内容保存到上一个厂商配置中，
     * 然后切换 currentProvider 并加载新厂商的端点、Key、模型。
     */
    onProviderChange() {
        const newProvider = document.getElementById('settingsApiProvider')?.value || 'Deepseek';
        this.switchProvider(newProvider);
    }

    /**
     * 切换当前厂商（下拉切换与添加自定义厂商共用）：
     * 先把当前表单内容保存到上一个厂商配置中，再切换并重渲染表单。
     * @param {string} newProvider - 目标厂商名
     */
    switchProvider(newProvider) {
        const previousProvider = (this.settings.api && this.settings.api.currentProvider) || 'Deepseek';
        if (newProvider === previousProvider) {
            this.render();
            return;
        }

        // 1. 先把当前表单中的端点、Key、模型保存到上一个厂商配置中
        const endpoint = document.getElementById('settingsApiEndpoint')?.value.trim() || '';
        const apiKey = document.getElementById('settingsApiKey')?.value.trim() || '';
        const models = this.collectModelsFromForm();

        if (!this.settings.api.providers) {
            this.settings.api.providers = {};
        }
        this.settings.api.providers[previousProvider] = { endpoint, apiKey, models };

        // 2. 切换当前厂商
        this.settings.api.currentProvider = newProvider;

        // 3. 清空已获取的模型列表缓存（不同厂商模型列表不同）
        this.fetchedModels = [];

        // 4. 重新渲染表单，显示新厂商的配置
        this.render();
    }

    /**
     * 渲染单个模型行
     * @param {Object} model - 模型对象
     * @param {number} index - 模型索引
     * @returns {string} HTML 字符串
     */
    renderModelRow(model, index) {
        const idOptions = this.fetchedModels.length > 0
            ? this.fetchedModels.map((id) => `<option value="${LumenLight.escapeHtml(id)}" ${id === model.id ? 'selected' : ''}>${LumenLight.escapeHtml(id)}</option>`).join('')
            : '';

        const currentOption = model.id
            ? `<option value="${LumenLight.escapeHtml(model.id)}" selected>${LumenLight.escapeHtml(model.id)}</option>`
            : '<option value="" selected>请选择模型</option>';

        // 模型类型：auto=按名称自动识别（默认）、chat=聊天、image=绘图（图像生成）
        const type = ['auto', 'chat', 'image', 'video'].includes(model.type) ? model.type : 'auto';

        // 开关缺省=启用：只有显式 enabled === false 才是停用（与项目启停惯例一致，
        // 同 ADR 004 的 === false 判定口径）
        const enabled = model.enabled !== false;

        return `
            <div class="settings-models-row" data-index="${index}">
                <select class="settings-input settings-model-id" data-index="${index}">
                    ${currentOption}
                    ${idOptions}
                </select>
                <select class="settings-input settings-model-type" data-index="${index}"
                        title="自动：按模型名称识别；聊天：强制走对话接口；绘图：强制走图像生成接口；视频：强制走视频生成接口">
                    <option value="auto" ${type === 'auto' ? 'selected' : ''}>自动</option>
                    <option value="chat" ${type === 'chat' ? 'selected' : ''}>聊天</option>
                    <option value="image" ${type === 'image' ? 'selected' : ''}>绘图</option>
                    <option value="video" ${type === 'video' ? 'selected' : ''}>视频</option>
                </select>
                <div class="settings-model-actions">
                    <button type="button" class="settings-model-act settings-model-test" data-index="${index}"
                            title="测试链接：检查端点可达性与该模型是否在清单中">${SettingsApiPanel.ICONS.test}</button>
                    <button type="button" class="settings-model-act settings-model-edit" data-index="${index}"
                            title="编辑：显示名称 / 上下文 / 输出上限">${SettingsApiPanel.ICONS.edit}</button>
                    <button type="button" class="settings-model-act settings-model-delete" data-index="${index}"
                            title="删除模型">${SettingsApiPanel.ICONS.trash}</button>
                    <label class="settings-switch settings-model-switch"
                           title="启用/停用：关闭后该模型在所有模型下拉与 agent 中隐藏">
                        <input type="checkbox" class="settings-model-enabled" data-index="${index}" ${enabled ? 'checked' : ''}>
                        <span class="settings-switch-slider"></span>
                    </label>
                </div>
            </div>
        `;
    }

    /**
     * 收集当前表单中的模型列表（与行严格对位）。
     * 返回数组下标 == 行下标 == settings 存储下标（render 按存储数组
     * 1:1 渲染行）：未选 ID 的空行以 null 占位而不是丢弃——否则压缩
     * 会让「编辑/删除」按钮携带的行下标在空行位于目标行之前时错位。
     * 占位 null 由写回侧（collectApiFromForm / 增删改方法）过滤，
     * 落盘行为与旧版「丢弃空行」一致
     * @returns {Array<(Object|null)>} 模型对象或 null 占位
     */
    collectModelsFromForm() {
        const body = document.getElementById('settingsModelsBody');
        const models = [];

        if (body) {
            // 显示名称/上下文/输出上限已移入编辑弹窗（写入 settings，
            // 不在行 DOM 里），收集时必须按位回填——否则任意一次收集
            // （保存/切厂商/加删行）都会把这些字段静默抹掉
            const storedModels = Array.isArray(this.getCurrentProviderConfig().models)
                ? this.getCurrentProviderConfig().models : [];
            const rows = body.querySelectorAll('.settings-models-row');
            rows.forEach((row, i) => {
                const idSelect = row.querySelector('.settings-model-id');
                const typeSelect = row.querySelector('.settings-model-type');
                const enabledInput = row.querySelector('.settings-model-enabled');
                const id = idSelect ? idSelect.value.trim() : '';
                // 模型类型标记：auto/chat/image/video，用于前端区分聊天、绘图与视频接口
                const type = typeSelect ? typeSelect.value : 'auto';

                // 空行（未选 ID）占位保对位，写回侧过滤
                if (!id) {
                    models.push(null);
                    return;
                }
                const prev = storedModels[i] || {};
                const entry = { id, displayName: prev.displayName || '', type };
                if (prev.contextWindow) entry.contextWindow = prev.contextWindow;
                if (prev.maxTokens) entry.maxTokens = prev.maxTokens;
                // 开关缺省=启用：只在停用时写字段（=== false 判定口径）
                if (enabledInput && enabledInput.checked === false) entry.enabled = false;
                models.push(entry);
            });
        }

        return models;
    }

    /**
     * 收集当前表单中的完整 API 设置
     * 按厂商分组保存，避免不同厂商的端点、Key、模型互相串。
     * 当前厂商以 settings.api.currentProvider 为准，
     * 调用方（如 onProviderChange）需要自行维护 currentProvider 的切换。
     * @param {boolean} [keepEmptyRows] - 保留空行占位（对位编辑用）：
     *        仅 addModel/removeModel/applyModelEdit 需要「行下标可直取」
     *        的对位数组并在变更后自行过滤；持久化路径（保存/切厂商）
     *        默认过滤 null，落盘行为与旧版「丢弃空行」一致
     * @returns {Object} API 设置对象 { currentProvider, providers }
     */
    collectApiFromForm(keepEmptyRows = false) {
        const provider = (this.settings.api && this.settings.api.currentProvider) || 'Deepseek';
        const endpoint = document.getElementById('settingsApiEndpoint')?.value.trim() || '';
        const apiKey = document.getElementById('settingsApiKey')?.value.trim() || '';
        const aligned = this.collectModelsFromForm();
        const models = keepEmptyRows ? aligned : aligned.filter(Boolean);

        // 保留其他厂商的已有配置，只更新当前厂商。
        // bindings 不再写入 skill（技能模型已迁移到提示词节点技能栏，
        // 2026-10）——顺手清掉存量配置里的残留键
        const existingBindings = (this.settings.api && this.settings.api.bindings) || {};
        const bindings = { ...existingBindings };
        delete bindings.skill;
        const existingProviders = (this.settings.api && this.settings.api.providers) || {};
        return {
            currentProvider: provider,
            providers: {
                ...existingProviders,
                [provider]: { endpoint, apiKey, models }
            },
            bindings
        };
    }

    /**
     * 从 API 提供商获取模型列表
     */
    async fetchModels() {
        // 先保存当前表单中的所有 API 设置，避免重新渲染后丢失用户输入
        this.settings.api = this.collectApiFromForm();

        const config = this.getCurrentProviderConfig();
        const { endpoint, apiKey } = config;

        if (!endpoint || !apiKey) {
            alert('请先填写端点地址和 API Key');
            return;
        }

        const fetchBtn = document.getElementById('settingsFetchModelsBtn');
        const originalText = fetchBtn.textContent;
        fetchBtn.textContent = '获取中...';
        fetchBtn.disabled = true;

        try {
            const response = await fetch('/api/settings/models', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint, apiKey })
            });

            const result = await response.json();

            if (result.status === 'ok') {
                this.fetchedModels = result.models || [];
                this.render();
            } else {
                throw new Error(result.message || '获取失败');
            }
        } catch (error) {
            console.error('获取模型列表失败:', error);
            // TypeError: Failed to fetch 表示连不上本地后端，而非上游 API 的问题
            const message = error instanceof TypeError
                ? '无法连接到本地后端服务，请确认 server.js 已启动（8080 端口）'
                : error.message;
            alert('获取模型列表失败：' + message);
        } finally {
            if (fetchBtn) {
                fetchBtn.textContent = originalText;
                fetchBtn.disabled = false;
            }
        }
    }

    /**
     * 添加一个空模型行
     */
    addModel() {
        // keepEmptyRows：先拿对位数组再追加，避免先前空行被丢弃压缩
        // 导致与渲染行错位
        const api = this.collectApiFromForm(true);
        const provider = api.currentProvider || 'Deepseek';
        const providerConfig = api.providers[provider] || { endpoint: '', apiKey: '', models: [] };
        providerConfig.models.push({ id: '', displayName: '', type: 'auto' });
        providerConfig.models = providerConfig.models.filter(Boolean);
        api.providers[provider] = providerConfig;
        this.settings.api = api;
        this.render();
    }

    /**
     * 删除指定索引的模型
     * @param {number} index - 模型索引（= 渲染行下标，与对位数组直配）
     */
    removeModel(index) {
        const api = this.collectApiFromForm(true);
        const provider = api.currentProvider || 'Deepseek';
        const providerConfig = api.providers[provider] || { endpoint: '', apiKey: '', models: [] };
        providerConfig.models.splice(index, 1);
        providerConfig.models = providerConfig.models.filter(Boolean);
        api.providers[provider] = providerConfig;
        this.settings.api = api;
        this.render();
    }

    // ==================== 模型编辑弹窗 ====================
    // 显示名称/上下文/输出上限收进弹窗（行内只留 ID/类型/操作组）。
    // 弹窗字段初值取自 settings 的存储值（这些字段不在行 DOM 中），
    // 确认后经「收集→按位合并→重渲染」的既有管线落回，与添加/删除
    // 模型同一条数据路径；取消/Esc/点遮罩一律不改动

    /**
     * 打开模型编辑弹窗
     * @param {number} index - 模型行下标（与 settings 存储数组对位）
     */
    openModelEditModal(index) {
        this.closeModelEditModal();   // 防重复叠加
        const storedModels = Array.isArray(this.getCurrentProviderConfig().models)
            ? this.getCurrentProviderConfig().models : [];
        const model = storedModels[index] || {};
        const row = document.querySelector(`#settingsModelsBody .settings-models-row[data-index="${index}"]`);
        const id = row?.querySelector('.settings-model-id')?.value.trim() || model.id || '';

        const overlay = document.createElement('div');
        overlay.id = 'modelEditOverlay';
        overlay.innerHTML = `
            <div class="model-edit-dialog" role="dialog" aria-modal="true">
                <div class="model-edit-title">编辑模型</div>
                <div class="model-edit-subtitle">${LumenLight.escapeHtml(id || '（未选择模型 ID）')}</div>
                <div class="model-edit-field">
                    <label for="modelEditName">显示名称</label>
                    <input type="text" id="modelEditName" class="settings-input" maxlength="60"
                           placeholder="留空显示模型 ID"
                           value="${LumenLight.escapeHtml(model.displayName || '')}">
                </div>
                <div class="model-edit-field">
                    <label for="modelEditCtx">上下文窗口（tokens）</label>
                    <input type="text" inputmode="numeric" id="modelEditCtx" class="settings-input"
                           placeholder="默认 ${SettingsApiPanel.CTX_DEFAULT_LABEL}"
                           value="${LumenLight.escapeHtml(SettingsApiPanel.formatTokenField(model.contextWindow))}">
                    <div class="model-edit-hint">agent（pi）自动压缩的触发依据，不改变模型真实上限；支持 ${SettingsApiPanel.CTX_DEFAULT_LABEL} 或 ${SettingsApiPanel.CTX_DEFAULT_TOKENS} 写法</div>
                </div>
                <div class="model-edit-field">
                    <label for="modelEditMaxtok">输出上限（tokens）</label>
                    <input type="text" inputmode="numeric" id="modelEditMaxtok" class="settings-input"
                           placeholder="默认 ${SettingsApiPanel.MAXTOK_DEFAULT_LABEL}"
                           value="${LumenLight.escapeHtml(SettingsApiPanel.formatTokenField(model.maxTokens))}">
                    <div class="model-edit-hint">单次回复输出预算，推理类模型可调大；绘图/视频模型不走 agent，这两项不生效</div>
                </div>
                <div class="model-edit-footer">
                    <button type="button" class="settings-models-btn" id="modelEditCancel">取消</button>
                    <button type="button" class="settings-models-btn primary" id="modelEditConfirm">确定</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.addEventListener('mousedown', (e) => {
            if (e.target === overlay) this.closeModelEditModal();
        });
        overlay.querySelector('#modelEditCancel').addEventListener('click', () => this.closeModelEditModal());
        overlay.querySelector('#modelEditConfirm').addEventListener('click', () => this.applyModelEdit(index));
        overlay.querySelectorAll('input').forEach((inp) => {
            inp.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); this.applyModelEdit(index); }
            });
        });
        // Esc 关闭挂在 document 上（弹窗内焦点才收得到键盘），关闭时移除
        this._modelEditKeyHandler = (e) => {
            if (e.key === 'Escape') this.closeModelEditModal();
        };
        document.addEventListener('keydown', this._modelEditKeyHandler);
        overlay.querySelector('#modelEditName').focus();
    }

    /** 关闭模型编辑弹窗（幂等）：移除遮罩与 document 级 Esc 监听 */
    closeModelEditModal() {
        if (this._modelEditKeyHandler) {
            document.removeEventListener('keydown', this._modelEditKeyHandler);
            this._modelEditKeyHandler = null;
        }
        document.getElementById('modelEditOverlay')?.remove();
    }

    /**
     * 应用模型编辑：校验 → 合入对应下标的存储条目 → 重渲染。
     * 走 collectApiFromForm 既有管线（行 DOM 只贡献 id/类型/开关，
     * 弹窗字段在此覆盖），保存落盘仍由「保存设置」统一负责
     * @param {number} index - 模型行下标
     */
    applyModelEdit(index) {
        const name = document.getElementById('modelEditName')?.value.trim() || '';
        const ctxRaw = document.getElementById('modelEditCtx')?.value ?? '';
        const maxtokRaw = document.getElementById('modelEditMaxtok')?.value ?? '';
        const contextWindow = SettingsApiPanel.parseTokenField(
            ctxRaw, SettingsApiPanel.CTX_TOKEN_MIN, SettingsApiPanel.CTX_TOKEN_MAX);
        const maxTokens = SettingsApiPanel.parseTokenField(
            maxtokRaw, SettingsApiPanel.MAXTOK_TOKEN_MIN, SettingsApiPanel.MAXTOK_TOKEN_MAX);
        if ((ctxRaw.trim() && contextWindow === null) ||
            (maxtokRaw.trim() && maxTokens === null)) {
            alert(`上下文/输出上限格式不正确，示例：${SettingsApiPanel.CTX_DEFAULT_LABEL} 或 ${SettingsApiPanel.CTX_DEFAULT_TOKENS}`);
            return;
        }

        // 对位收集（keepEmptyRows）：弹窗字段按行下标覆盖，再过滤空位
        // 落回 settings——与添加/删除模型同一条数据路径
        const api = this.collectApiFromForm(true);
        const provider = api.currentProvider || 'Deepseek';
        const entry = ((api.providers[provider] || {}).models || [])[index];
        if (entry) {
            entry.displayName = name;
            // 清空 = 删除字段走后端默认（300K/8192，与 piAgentManager 透传默认一致）
            if (contextWindow !== null) entry.contextWindow = contextWindow; else delete entry.contextWindow;
            if (maxTokens !== null) entry.maxTokens = maxTokens; else delete entry.maxTokens;
        }
        if (api.providers[provider]) {
            api.providers[provider].models = (api.providers[provider].models || []).filter(Boolean);
        }
        this.settings.api = api;
        this.closeModelEditModal();
        this.render();
        this.flashStatus('模型编辑已应用，点击「保存设置」后落盘');
    }

    // ==================== 测试链接 ====================
    // 轻量检查：POST /api/settings/models（复用「获取模型列表」接口），
    // 报告端点可达性 + 该模型 ID 是否在清单。清单不含只作黄色提醒
    // （很多中转 /models 返回不全但模型实际可用），不做真实对话调用

    /**
     * 测试某行模型的连接。只读表单（端点/Key 直接读输入框），
     * 不经 collectApiFromForm 落 settings，避免测试动作触发重渲染
     * 打断其他行的未落盘编辑
     * @param {number} index - 模型行下标
     * @param {HTMLElement} btn - 触发测试的按钮（结果态写在其 class 上）
     */
    async testModelConnection(index, btn) {
        const endpoint = document.getElementById('settingsApiEndpoint')?.value.trim() || '';
        const apiKey = document.getElementById('settingsApiKey')?.value.trim() || '';
        if (!endpoint || !apiKey) {
            this.flashStatus('测试链接前请先填写端点地址和 API Key');
            return;
        }
        const row = btn.closest('.settings-models-row');
        const id = row?.querySelector('.settings-model-id')?.value.trim() || '';
        if (!id) {
            this.flashStatus('请先选择模型 ID 再测试链接');
            return;
        }

        btn.classList.remove('is-ok', 'is-warn', 'is-bad');
        btn.classList.add('is-testing');
        try {
            const response = await fetch('/api/settings/models', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint, apiKey })
            });
            const result = await response.json();
            if (result.status !== 'ok') throw new Error(result.message || '获取失败');
            const list = Array.isArray(result.models) ? result.models : [];
            if (list.includes(id)) {
                btn.classList.add('is-ok');
                this.flashStatus(`「${id}」测试通过：端点可达，模型在清单中（共 ${list.length} 个）`);
            } else {
                btn.classList.add('is-warn');
                this.flashStatus(`端点可达，但模型清单（${list.length} 个）不含「${id}」——部分中转 /models 不全，实际可能仍可用`);
            }
        } catch (error) {
            btn.classList.add('is-bad');
            this.flashStatus('测试失败：' + error.message);
        } finally {
            btn.classList.remove('is-testing');
            // 结果色停留 4s 后恢复；期间行可能被重渲染替换，isConnected 容错
            setTimeout(() => {
                if (btn.isConnected) btn.classList.remove('is-ok', 'is-warn', 'is-bad');
            }, 4000);
        }
    }

    // ==================== RunningHub 云端配置 ====================
    // 登记卡模式已退役：工作流/应用的 ID 输入与参数拉取在画布 RunningHub
    // 节点上完成（节点直连）。历史登记卡数据（settings.json 的
    // runninghub.workflows）只读保留——旧存档节点仍按卡提交，编辑器覆盖
    // 依旧经后端写卡，本面板不再提供编辑 UI

    /**
     * 收集 RunningHub 表单：仅 Key 与端点两个输入。
     * 登记卡数组（workflows）原样带回内存设置，不做任何增删改——
     * 否则每次保存设置都会把历史登记卡静默抹掉
     * @returns {Object} { apiKey, endpoint, workflows }
     */
    collectRunningHubFromForm() {
        const apiKey = document.getElementById('settingsRhApiKey')?.value.trim() || '';
        const endpoint = document.getElementById('settingsRhEndpoint')?.value.trim() || '';
        const workflows = (this.settings.runninghub &&
            Array.isArray(this.settings.runninghub.workflows))
            ? this.settings.runninghub.workflows : [];
        return { apiKey, endpoint, workflows };
    }

    /**
     * 保存设置到后端
     * 表单里能改的只有 API 配置，因此这里先收集 API 表单再整体提交
     */
    async save() {
        // 统一从表单收集所有 API 设置，确保端点、Key 和模型都能正确保存
        this.settings.api = this.collectApiFromForm();

        // RunningHub 区块：collect 恒成功（仅 Key/端点，旧卡原样保留）
        this.settings.runninghub = this.collectRunningHubFromForm();

        try {
            const statusEl = document.getElementById('settingsSaveStatus');
            statusEl.textContent = '正在保存...';
            statusEl.className = 'settings-save-status';

            const response = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.settings)
            });

            const result = await response.json();

            if (result.status === 'ok') {
                this.manager.settings = result.settings;
                statusEl.textContent = '保存成功，正在验证...';
                statusEl.classList.add('success');

                // 保存成功后立即重新加载，确保前端内存中的设置与文件一致
                await this.manager.loadSettings(false);
                this.render();

                statusEl.textContent = '保存成功';
                // 通知其他组件（如 LLM 聊天窗口）刷新模型列表
                window.dispatchEvent(new CustomEvent('settingsSaved'));
                setTimeout(() => { statusEl.textContent = ''; }, 2000);
            } else {
                throw new Error(result.message || '保存失败');
            }
        } catch (error) {
            console.error('保存设置失败:', error);
            const statusEl = document.getElementById('settingsSaveStatus');
            statusEl.textContent = '保存失败：' + error.message;
            statusEl.classList.add('error');
        }
    }
}

// 将 SettingsApiPanel 暴露到全局作用域
window.SettingsApiPanel = SettingsApiPanel;
