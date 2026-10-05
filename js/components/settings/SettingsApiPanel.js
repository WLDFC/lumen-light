/**
 * ==========================================================================
 * LumenLight 设置 - API 面板
 * 作用：渲染「API」分类，负责提供商切换、端点地址、API Key、模型列表的
 *       增删改，以及从提供商拉取可用模型、把设置保存到后端。
 *       提供商分两类：内置三家（Deepseek / OpenAI兼容 / 豆包）与
 *       用户自由添加的「OpenAI 兼容」自定义厂商（自命名、可添加任意个、
 *       可删除，协议与内置 OpenAI兼容 完全一致）。
 * 数据约定：设置本体存放在 SettingsManager.settings 中（按厂商分组），
 *           自定义厂商就是 providers Map 里的自由键名，后端无白名单，
 *           本面板只负责「表单 <-> settings」之间的收集与回填。
 * 由 SettingsManager 在构造时实例化并按分类调用 render()。
 * ==========================================================================
 */

class SettingsApiPanel {
    /** 内置提供商（固定三家，不可删除）；其余 providers 键均为自定义厂商 */
    static BUILTIN_PROVIDERS = [
        { key: 'Deepseek', label: 'Deepseek' },
        { key: 'OpenAI', label: 'OpenAI兼容' },
        { key: 'Doubao', label: '豆包 / 火山方舟' }
    ];
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

        // 厂商下拉：内置三家 + 自定义厂商（providers 里的自由键名）
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
                           placeholder="https://api.example.com/v1" value="${LumenLight.escapeHtml(config.endpoint || '')}">
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
                            <span>显示名称</span>
                            <span>类型</span>
                        </div>
                        <div class="settings-models-body" id="settingsModelsBody">
                            ${models.map((model, index) => this.renderModelRow(model, index)).join('')}
                        </div>
                    </div>
                    <div class="settings-models-hint">${modelHint}</div>
                </div>

                <!-- RunningHub 云端工作流：API Key 与工作流登记（登记卡模式） -->
                <div class="settings-models-section">
                    <div class="settings-models-header">
                        <span class="settings-models-title">RunningHub（云端工作流）</span>
                        <div class="settings-models-actions">
                            <button class="settings-models-btn primary" id="settingsRhAddWorkflowBtn" type="button">
                                + 登记工作流
                            </button>
                        </div>
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
                        工作流 ID 填纯数字（平台工作流页 URL 末段），点「从平台拉取」可自动解析参数映射
                        （与云端运行版本一致，推荐）。type 支持 string（文本框）/ list（下拉，配 options
                        数组）/ image（自动取节点连线图片）；role 填 prompt 或 negative 时，画布连线
                        提示词在参数留空时自动填入。例：
                        [{"nodeId":"45","fieldName":"prompt","label":"提示词","type":"string","role":"prompt"}]
                    </div>
                    <div id="settingsRhWorkflowsBody" class="settings-rh-workflows">
                        ${rhWorkflows.map((wf) => this.renderRhWorkflowCard(wf)).join('')}
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

        // 绑定删除模型事件（事件委托）
        const modelsBody = document.getElementById('settingsModelsBody');
        modelsBody?.addEventListener('click', (e) => {
            const deleteBtn = e.target.closest('.settings-model-delete');
            if (deleteBtn) {
                const index = parseInt(deleteBtn.dataset.index, 10);
                this.removeModel(index);
            }
        });

        // RunningHub 登记区：新增/删除工作流卡片（卡片编辑即时改 DOM，保存时统一收集）
        document.getElementById('settingsRhAddWorkflowBtn')?.addEventListener('click', () => {
            const body = document.getElementById('settingsRhWorkflowsBody');
            if (!body) return;
            body.insertAdjacentHTML('beforeend', this.renderRhWorkflowCard({}));
        });
        document.getElementById('settingsRhWorkflowsBody')?.addEventListener('click', (e) => {
            const del = e.target.closest('.rh-wf-delete');
            if (del) del.closest('.settings-rh-workflow')?.remove();
            // 从平台拉取工作流 JSON：取卡片内工作流 ID → 后端代理调平台
            // getJsonApiFormat（apiKey 只在服务端）→ 解析回填
            const fetchBtn = e.target.closest('.rh-wf-fetch');
            if (fetchBtn) this.fetchRhWorkflow(fetchBtn);
            // 导入本地 JSON：中转到卡片内隐藏的文件选择框
            const imp = e.target.closest('.rh-wf-import');
            if (imp) imp.closest('.settings-rh-workflow')?.querySelector('.rh-wf-file')?.click();
        });
        // 导入文件选择完成：解析工作流 JSON → 参数映射回填到卡片文本域
        document.getElementById('settingsRhWorkflowsBody')?.addEventListener('change', (e) => {
            const fileInput = e.target.closest('.rh-wf-file');
            if (!fileInput || !fileInput.files || !fileInput.files[0]) return;
            const card = fileInput.closest('.settings-rh-workflow');
            const file = fileInput.files[0];
            fileInput.value = '';   // 允许下次重选同一文件

            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const workflow = JSON.parse(reader.result);
                    const result = RhWorkflowImporter.import(workflow);
                    if (result.error) {
                        alert('导入失败：' + result.error);
                        return;
                    }
                    // 本地文件与平台运行版可能不一致（空字段/版本漂移），
                    // 导入成功即提示以云端为准
                    this._applyRhParams(card, result.params,
                        '本地文件仅作备用，以平台实际运行版本为准，建议优先「从平台拉取」校准');
                } catch (err) {
                    alert('导入失败：文件不是合法 JSON（' + err.message + '）');
                }
            };
            reader.onerror = () => alert('导入失败：文件读取失败');
            reader.readAsText(file);
        });
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

        return `
            <div class="settings-models-row" data-index="${index}">
                <select class="settings-input settings-model-id" data-index="${index}">
                    ${currentOption}
                    ${idOptions}
                </select>
                <input type="text" class="settings-input settings-model-name" data-index="${index}"
                       placeholder="显示名称" value="${LumenLight.escapeHtml(model.displayName || '')}">
                <select class="settings-input settings-model-type" data-index="${index}"
                        title="自动：按模型名称识别；聊天：强制走对话接口；绘图：强制走图像生成接口；视频：强制走视频生成接口">
                    <option value="auto" ${type === 'auto' ? 'selected' : ''}>自动</option>
                    <option value="chat" ${type === 'chat' ? 'selected' : ''}>聊天</option>
                    <option value="image" ${type === 'image' ? 'selected' : ''}>绘图</option>
                    <option value="video" ${type === 'video' ? 'selected' : ''}>视频</option>
                </select>
                <button class="settings-model-delete" type="button" data-index="${index}" title="删除模型">🗑️</button>
            </div>
        `;
    }

    /**
     * 收集当前表单中的模型列表
     * @returns {Array} 模型对象数组
     */
    collectModelsFromForm() {
        const body = document.getElementById('settingsModelsBody');
        const models = [];

        if (body) {
            const rows = body.querySelectorAll('.settings-models-row');
            rows.forEach((row) => {
                const idSelect = row.querySelector('.settings-model-id');
                const nameInput = row.querySelector('.settings-model-name');
                const typeSelect = row.querySelector('.settings-model-type');
                const id = idSelect ? idSelect.value.trim() : '';
                const displayName = nameInput ? nameInput.value.trim() : '';
                // 模型类型标记：auto/chat/image/video，用于前端区分聊天、绘图与视频接口
                const type = typeSelect ? typeSelect.value : 'auto';

                if (id || displayName) {
                    models.push({ id, displayName, type });
                }
            });
        }

        return models;
    }

    /**
     * 收集当前表单中的完整 API 设置
     * 按厂商分组保存，避免不同厂商的端点、Key、模型互相串。
     * 当前厂商以 settings.api.currentProvider 为准，
     * 调用方（如 onProviderChange）需要自行维护 currentProvider 的切换。
     * @returns {Object} API 设置对象 { currentProvider, providers }
     */
    collectApiFromForm() {
        const provider = (this.settings.api && this.settings.api.currentProvider) || 'Deepseek';
        const endpoint = document.getElementById('settingsApiEndpoint')?.value.trim() || '';
        const apiKey = document.getElementById('settingsApiKey')?.value.trim() || '';
        const models = this.collectModelsFromForm();

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
        const api = this.collectApiFromForm();
        const provider = api.currentProvider || 'Deepseek';
        const providerConfig = api.providers[provider] || { endpoint: '', apiKey: '', models: [] };
        providerConfig.models.push({ id: '', displayName: '', type: 'auto' });
        api.providers[provider] = providerConfig;
        this.settings.api = api;
        this.render();
    }

    /**
     * 删除指定索引的模型
     * @param {number} index - 模型索引
     */
    removeModel(index) {
        const api = this.collectApiFromForm();
        const provider = api.currentProvider || 'Deepseek';
        const providerConfig = api.providers[provider] || { endpoint: '', apiKey: '', models: [] };
        providerConfig.models.splice(index, 1);
        api.providers[provider] = providerConfig;
        this.settings.api = api;
        this.render();
    }

    // ==================== RunningHub 云端工作流登记 ====================

    /**
     * 渲染单张工作流登记卡：名称 + 工作流 ID + 参数映射 JSON
     * @param {Object} wf - 登记卡 { id, name, rhWorkflowId, params }
     * @returns {string} HTML 字符串
     */
    renderRhWorkflowCard(wf) {
        // 参数定义序列化为缩进 JSON 供编辑；已有 id 存进 data 属性（保存时沿用，
        // 画布节点的 workflowId 存档引用它，重新生成会断链）
        const paramsText = Array.isArray(wf.params) && wf.params.length
            ? JSON.stringify(wf.params, null, 1)
            : '';
        const wid = LumenLight.escapeHtml(wf.id || '');
        return `
            <div class="settings-rh-workflow" data-wf-id="${wid}">
                <div class="settings-rh-workflow-main">
                    <input type="text" class="settings-input rh-wf-name" placeholder="名称（画布下拉里显示）"
                           value="${LumenLight.escapeHtml(wf.name || '')}">
                    <input type="text" class="settings-input rh-wf-id" placeholder="工作流 ID（纯数字）"
                           value="${LumenLight.escapeHtml(wf.rhWorkflowId || '')}">
                    <button class="settings-model-delete rh-wf-delete" type="button" title="删除该工作流登记">🗑️</button>
                </div>
                <div class="settings-rh-workflow-actions">
                    <button class="settings-models-btn primary rh-wf-fetch" type="button"
                            title="用左边的工作流 ID 直接从平台拉取 JSON 并解析参数（无需手动导出文件）">从平台拉取</button>
                    <button class="settings-models-btn rh-wf-import" type="button"
                            title="选择本地工作流 JSON 文件解析参数（平台拉取失败时的备用方式）">导入本地 JSON</button>
                    <input type="file" class="rh-wf-file" accept=".json,application/json" style="display:none">
                </div>
                <textarea class="settings-input settings-rh-params rh-wf-params" rows="3"
                          placeholder='参数映射 JSON 数组。推荐点上方「从平台拉取」自动解析；也可手工填写，例：[{"nodeId":"45","fieldName":"prompt","label":"提示词","type":"string","role":"prompt"}]'>${LumenLight.escapeHtml(paramsText)}</textarea>
            </div>
        `;
    }

    /**
     * 从平台拉取工作流 JSON 并解析参数（登记卡「从平台拉取」按钮）。
     * 取本卡工作流 ID → POST /api/runninghub/fetch-workflow（后端代理，
     * apiKey 不进浏览器）→ RhWorkflowImporter 解析 → 回填参数映射
     * @param {HTMLElement} btn - 触发的按钮（用于加载态）
     */
    async fetchRhWorkflow(btn) {
        const card = btn.closest('.settings-rh-workflow');
        const id = card?.querySelector('.rh-wf-id')?.value.trim() || '';
        if (!/^\d+$/.test(id)) {
            alert('请先在卡片上填写纯数字的工作流 ID');
            return;
        }

        const original = btn.textContent;
        btn.textContent = '拉取中...';
        btn.disabled = true;
        try {
            const response = await fetch('/api/runninghub/fetch-workflow', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workflowId: id })
            });
            const result = await response.json();
            if (result.status !== 'ok') {
                throw new Error(result.message || '拉取失败');
            }
            const parsed = RhWorkflowImporter.import(result.workflow);
            if (parsed.error) {
                alert('平台返回的工作流解析失败：' + parsed.error);
                return;
            }
            this._applyRhParams(card, parsed.params);
        } catch (error) {
            console.error('从平台拉取工作流失败:', error);
            alert('从平台拉取失败：' + error.message);
        } finally {
            btn.textContent = original;
            btn.disabled = false;
        }
    }

    /**
     * 把解析出的参数映射回填到登记卡文本域（已有映射先确认，不静默覆盖）
     * @param {HTMLElement} card - 登记卡元素
     * @param {Object[]} params - 解析出的参数数组
     * @param {string} [sourceNote] - 来源附注（本地导入时提示以云端拉取为准）
     */
    _applyRhParams(card, params, sourceNote) {
        const textarea = card?.querySelector('.rh-wf-params');
        if (!textarea) return;
        if (textarea.value.trim() &&
            !confirm(`已解析出 ${params.length} 个参数，覆盖现有参数映射？`)) {
            return;
        }
        textarea.value = JSON.stringify(params, null, 1);
        this.flashStatus(`已解析出 ${params.length} 个参数，点击「保存设置」后生效${sourceNote ? '；' + sourceNote : ''}`);
    }

    /**
     * 收集 RunningHub 表单（Key / 地址 / 工作流登记卡）
     * 参数映射 JSON 解析失败时返回 null 并闪现提示（由调用方中止保存）
     * @returns {Object|null} { apiKey, endpoint, workflows } 或 null（校验失败）
     */
    collectRunningHubFromForm() {
        const apiKey = document.getElementById('settingsRhApiKey')?.value.trim() || '';
        const endpoint = document.getElementById('settingsRhEndpoint')?.value.trim() || '';
        const workflows = [];

        const body = document.getElementById('settingsRhWorkflowsBody');
        if (body) {
            for (const card of body.querySelectorAll('.settings-rh-workflow')) {
                const name = card.querySelector('.rh-wf-name')?.value.trim() || '';
                const rhWorkflowId = card.querySelector('.rh-wf-id')?.value.trim() || '';
                if (!name && !rhWorkflowId) continue;   // 整卡空白：跳过不入库

                // 参数映射：必须解析为 JSON 数组；解析失败中止保存并指出哪张卡
                let params = [];
                const raw = card.querySelector('.rh-wf-params')?.value.trim() || '';
                if (raw) {
                    try {
                        params = JSON.parse(raw);
                        if (!Array.isArray(params)) throw new Error('not array');
                    } catch {
                        this.flashStatus(`工作流「${name || rhWorkflowId}」的参数映射不是合法 JSON 数组，请修正后再保存`);
                        return null;
                    }
                }

                workflows.push({
                    // 已有 id 沿用（画布存档引用），新卡生成稳定唯一 id
                    id: card.dataset.wfId || `wf_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
                    name,
                    rhWorkflowId,
                    params
                });
            }
        }

        return { apiKey, endpoint, workflows };
    }

    /**
     * 保存设置到后端
     * 表单里能改的只有 API 配置，因此这里先收集 API 表单再整体提交
     */
    async save() {
        // 统一从表单收集所有 API 设置，确保端点、Key 和模型都能正确保存
        this.settings.api = this.collectApiFromForm();

        // RunningHub 区块：参数 JSON 校验失败时不落盘，等用户修正
        const runninghub = this.collectRunningHubFromForm();
        if (!runninghub) return;
        this.settings.runninghub = runninghub;

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
