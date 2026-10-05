/**
 * ==========================================================================
 * LumenLight LLM 聊天窗口组件
 * 作用：右侧面板切换到 “LLM 对话框” 模式时显示的聊天界面，
 *       支持与大语言模型多轮对话、附带图片上传（多模态）、模型选择、图像生成。
 *       模型列表来自设置界面（API 分类）中配置的模型，
 *       聊天请求通过后端 /api/llm/chat 代理转发到 API 提供商。
 *       生成的图片可点击放大查看，也可拖拽到画布上以原生分辨率添加。
 * ==========================================================================
 */

// 下拉选项的纯白线条图标（Feather 风格路径，由 LumenDropdown 统一包 svg 壳，
// stroke=currentColor 渲染为白色，与提示词节点技能栏图标同风格）
const LLM_DD_ICONS = {
    box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'
};

class LlmChat {
    /**
     * 构造函数
     */
    constructor() {
        // ===== DOM 元素引用 =====
        this.messagesEl = document.getElementById('llmMessages');
        this.emptyTipEl = document.getElementById('llmChatEmpty');
        this.inputEl = document.getElementById('llmInput');
        this.sendBtn = document.getElementById('llmSendBtn');
        // 生图停止按钮：默认暗置，有在飞生图任务时点亮（见 _updateStopBtn）
        this.stopBtn = document.getElementById('llmStopBtn');
        this.modelSelect = document.getElementById('llmModelSelect');
        this.qualitySelect = document.getElementById('llmQualitySelect');
        this.uploadBtn = document.getElementById('llmUploadBtn');
        this.clearBtn = document.getElementById('llmClearBtn');
        this.fileInput = document.getElementById('llmFileInput');
        // 面板头部 pi 调用统计灰字（上下文 token · 缓存命中率）
        this.piUsageEl = document.getElementById('piUsageStatus');

        // 快速回底按钮（消息区悬浮）：滚离底部时浮现，点击平滑滚回最新消息
        this.scrollBtn = document.getElementById('llmScrollBottom');
        // 自动跟随：为 true 时流式输出持续贴底；用户上滑阅读历史即暂停，点回底按钮恢复
        this.autoFollow = true;
        if (this.scrollBtn) {
            this.scrollBtn.addEventListener('click', () => this._smoothScrollToBottom());
            this.messagesEl.addEventListener('scroll', () => this._onMessagesScroll(), { passive: true });
        }

        // 图片灯箱组件（已从本类拆分出去）
        this.lightbox = new LlmLightbox();
        // 待发送图片附件组件（已从本类拆分出去）
        this.attachments = new LlmAttachments('llmAttachments');
        // 视频生成控制器（独立模块，不干扰聊天/生图链路）
        this.videoGen = new LlmVideoGen(this);
        // pi 编码智能体控制器（画布代理，流式渲染经 piEvent 页面事件）
        this.piAgent = new LlmPiAgent(this);
        // 网页桥接控制器（豆包等站点网页直连，流式渲染经 webbridgeEvent 页面事件）
        this.webBridge = new LlmWebBridge(this);
        // 比例 + 分辨率档位双段选择面板（已从本类拆分出去）
        this.sizePicker = new LlmSizePicker('llmSizeSelect');
        // 模型 / 质量自定义下拉（图标按钮模式：纯图标触发器，点击弹出
        // 菜单选择，当前选中在菜单里以青色对勾标记，展开时按钮变强调蓝；
        // 交互与技能栏下拉一致。尺寸比例双段选择器维持原实现）
        this.modelDropdown = new LumenDropdown(this.modelSelect, {
            iconButton: true,
            triggerIcon: LLM_DD_ICONS.box,
            onChange: () => this._onModelChanged()
        });
        this.qualityDropdown = new LumenDropdown(this.qualitySelect, {
            iconButton: true,
            triggerIcon: LLM_DD_ICONS.star
        });
        this.qualityDropdown.setOptions([
            { value: '', label: '自动', icon: LLM_DD_ICONS.zap },
            { value: 'low', label: '低质量', icon: LLM_DD_ICONS.star },
            { value: 'medium', label: '中质量', icon: LLM_DD_ICONS.star },
            { value: 'high', label: '高质量', icon: LLM_DD_ICONS.star }
        ], '');

        // ===== 状态 =====
        // 对话历史（发送给后端的上下文）
        this.history = [];
        // 是否正在等待模型回复
        this.isSending = false;
        // 在飞生图任务的 AbortController 集合（停止按钮的作用域：
        // 生图不走 isSending 串行锁，任务彼此独立可并发，点停止全部中止）
        this._imageGenTasks = new Set();
        // 当前厂商的模型配置列表（含 type 标记），用于区分聊天/绘图模型
        this.modelsConfig = [];

        // ===== 聊天记录持久化（F5 后恢复） =====
        // 存取编排拆至 LlmHistoryController（同名方法，下方留同名薄代理，
        // 调用点零改动）；_genParams / _piUsage 是生成图块与 pi 统计的
        // 功能状态，仍归本类，控制器读写时经 chat 引用访问
        this._historyCtl = new LlmHistoryController(this);
        this._genParams = new Map();   // 生成图片块 id → 原始请求参数（重新生成/恢复重绑用）
        this._piUsage = null;          // 最近一次 pi 调用统计 {usage, modelId}（随快照持久化）

        this.init();
    }

    /**
     * 初始化：绑定事件、加载模型列表
     */
    init() {
        if (!this.messagesEl) return;

        // 发送按钮
        this.sendBtn?.addEventListener('click', () => this.send());

        // 生图停止按钮
        this.stopBtn?.addEventListener('click', () => this.abortImageGenerations());
        // 初始显隐同步（默认模型非绘图时隐藏）
        this._updateStopBtn();

        // 输入框：Enter 发送，Shift+Enter 换行
        this.inputEl?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.send();
            }
        });

        // 上传分流：视频→视频生成；图片→图片附件；其余文档→解析成文本附件
        this.uploadBtn?.addEventListener('click', () => this.fileInput?.click());
        this.fileInput?.addEventListener('change', (e) => {
            Array.from(e.target.files || []).forEach((file) => {
                if (CanvasVideoManager.isVideoFile(file)) {
                    this.videoGen.importLocalVideo(file);
                } else if (file.type.startsWith('image/')) {
                    this.attachments.addFromFile(file);
                } else {
                    this.attachments.addDocFromFile(file);
                }
            });
            e.target.value = '';
        });

        // 清空对话
        this.clearBtn?.addEventListener('click', () => this.clearChat());
        // 清空按钮移至面板头部后仅 LLM 模式显示（Comfy 模式无对话概念，
        // 与系统提示词按钮同一显隐模式）
        this.updateClearBtnVisibility();
        document.getElementById('promptMode')?.addEventListener('change', () => this.updateClearBtnVisibility());

        // 模型切换的 toolbar 刷新由 modelDropdown 的 onChange 回调触发
        // （原生 select 的 change 监听已由 LumenDropdown 取代）

        // 设置保存后刷新模型列表（设置界面会派发该事件）
        window.addEventListener('settingsSaved', () => this.loadModels());

        // 设置里切换了桥接站点：处于网页桥接模式时按新站点换聊天记录
        window.addEventListener('webbridgeSiteChanged', () => {
            if (this.isWebMode()) this._swapHistorySnapshot();
        });

        // 切换到 LLM 模式时刷新模型列表（PromptPanel 会派发该事件）
        window.addEventListener('llmModeEnter', () => this.loadModels());

        // 画布工具栏"添加到内容"按钮在 LLM 模式下派发的事件
        window.addEventListener('addImageToLlmAttachments', (e) => {
            const imageData = e.detail?.image;
            if (imageData?.src) {
                this.attachments.addImageUrl(imageData.src);
            }
        });

        // 初始加载一次模型列表
        this.loadModels();

        // 恢复上次会话的聊天记录（等实时保存确定存档键后按存档恢复）
        this._restoreHistory();
        // 卸载前把防抖窗口内的最后一次变更尽力落盘
        window.addEventListener('beforeunload', () => this._flushHistory());
    }

    /**
     * 为消息图片包一层容器并挂载悬停显示的删除按钮
     * 删除仅移除界面元素释放内存，不影响对话历史（历史只存文字）
     * @param {HTMLImageElement} imgEl - 图片元素（已设置好 src、点击、拖拽事件）
     * @returns {HTMLDivElement} 包含图片和删除按钮的容器
     */
    wrapRemovableImage(imgEl) {
        const wrap = document.createElement('div');
        wrap.className = 'llm-msg-image-wrap';

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'llm-msg-image-remove';
        removeBtn.title = '删除图片';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            wrap.remove();
        });

        wrap.appendChild(imgEl);
        wrap.appendChild(removeBtn);
        return wrap;
    }

    /**
     * 判断给定模型 ID 是否为图像生成模型
     * 优先使用设置中的手动类型标记（chat=聊天、image=绘图），
     * 标记为 auto 或未标记时按模型名称关键词自动识别
     * @param {string} modelId - 模型 ID
     * @returns {boolean}
     */
    isImageModel(modelId) {
        if (!modelId) return false;

        // 1. 手动标记优先：设置界面可为每个模型指定类型，覆盖自动识别。
        //    modelId 可能是"厂商||模型ID"复合键（下拉框 value），两种形态都匹配
        const marked = (this.modelsConfig || [])
            .find((m) => m && (m.key === modelId || m.id === modelId));
        if (marked) {
            if (marked.type === 'image') return true;
            if (marked.type === 'chat') return false;
        }

        // 2. 自动识别：关键词口径统一在 LumenLight.looksLikeImageModel。
        //    用复合键中解析出的纯模型 ID 判断，避免厂商名碰巧含关键词造成误判
        return LumenLight.looksLikeImageModel(LumenLight.parseModelKey(modelId).id);
    }

    /**
     * 判断给定模型是否支持 quality 质量参数，并返回该模型对应的质量档位选项
     * 档位判断逻辑已迁移到 js/utils/llmQuality.js，此处仅作委托转发
     * @param {string} modelId - 模型 ID
     * @returns {Array<{value: string, label: string}>|null} 支持时返回选项列表，不支持返回 null
     */
    getQualityOptions(modelId) {
        return LlmQuality.getOptions(modelId);
    }

    // ==================== 尺寸与分辨率逻辑 ====================
    // 比例列表、档位定义、按模型计算像素、约束降级等纯计算逻辑
    // 已迁移到 js/utils/llmResolution.js，通过 LlmResolution 静态方法调用；
    // 比例/档位双段下拉面板的 UI 已迁移到 js/components/LlmSizePicker.js

    /**
     * 判断给定模型 ID 是否为视频生成模型
     * 委托给 LlmVideoGen 模块处理（type='video' 标记 + 名称关键词自动识别）
     * @param {string} modelId - 模型 ID
     * @returns {boolean}
     */
    /**
     * 是否为 pi 智能体入口（厂商名 'pi'）
     */
    isAgentModel(modelId) {
        try {
            return LumenLight.parseModelKey(modelId).provider === 'pi';
        } catch {
            return false;
        }
    }

    /**
     * 是否为网页桥接入口（厂商名 'web'）
     */
    isWebBridgeModel(modelId) {
        try {
            return LumenLight.parseModelKey(modelId).provider === 'web';
        } catch {
            return false;
        }
    }

    isVideoModel(modelId) {
        return this.videoGen ? this.videoGen.isVideoModel(modelId) : false;
    }
    
    /**
     * 根据当前选中的模型刷新工具栏：
     *   - 视频模型：隐藏尺寸/质量，发送按钮文案改为"生成视频"
     *   - 绘图模型：显示尺寸、按需显示质量、发送按钮文案改为"生成图片"
     *   - 聊天模型：隐藏尺寸与质量、发送按钮文案改为"发送"
     */
    updateToolbarForModel() {
        if (!this.modelDropdown) return;
        const modelId = this.modelDropdown.value;
        // 停止生图按钮的显隐跟随模型类型（仅绘图模型显示）
        this._updateStopBtn();
        const isVideo = this.isVideoModel(modelId);
        const isImage = !isVideo && this.isImageModel(modelId);
        const qualityOptions = isImage ? this.getQualityOptions(modelId) : null;

        // 网页桥接：无尺寸/质量概念，消息驱动进站点网页（回复里带什么
        // 尺寸由网页自己决定）
        if (this.isWebBridgeModel(modelId)) {
            this.sizePicker.setVisible(false);
            this.qualityDropdown?.setVisible(false);
            if (this.sendBtn) this.sendBtn.textContent = '发送';
            return;
        }

        this.sizePicker.setVisible(isImage);
        // 同步档位可用性：低于模型最小总像素的档位会被禁用，
        // 已选中的低档会可见地切到最低可用档
        if (isImage) this.sizePicker.setModel(modelId);

        if (this.qualityDropdown) {
            if (qualityOptions) {
                // 仅选项变化时才重绘，避免切模型时丢失当前选择（setOptions 内有指纹守卫）
                // 质量选项带白线条图标：自动=闪电，档位=星形
                this.qualityDropdown.setOptions(
                    qualityOptions.map((opt) => ({
                        ...opt,
                        icon: opt.value === '' ? LLM_DD_ICONS.zap : LLM_DD_ICONS.star
                    })),
                    this.qualityDropdown.value
                );
                this.qualityDropdown.setVisible(true);
            } else {
                this.qualityDropdown.setVisible(false);
            }
        }
        if (this.sendBtn) {
            this.sendBtn.textContent = isVideo ? '生成视频' : (isImage ? '生成图片' : '发送');
        }
    }

    // ==================== 模型列表 ====================

    /**
     * 从设置中加载模型列表并填充下拉框。
     * 聚合所有已配置厂商的模型（多厂商并存）：后端按模型 ID 自动路由
     * 到对应厂商，这里只负责把可选模型列全。配置了多个厂商时，
     * 选项文案带厂商名便于区分。
     */
    async loadModels() {
        try {
            const response = await fetch('/api/settings');
            const result = await response.json();
            const api = result.settings?.api || {};
            const { models, providerCount } = LumenLight.collectConfiguredModels(api);

            // 缓存模型配置（含 type 标记），供 isImageModel 区分聊天/绘图模型
            this.modelsConfig = models;

            const previousValue = this.modelDropdown?.value;
            const showProvider = providerCount > 1;

            if (models.length === 0) {
                // 未配置任何 API 模型：网页桥接不依赖 API 配置，仍保底可用
                this.modelDropdown.setOptions(
                    [{ value: 'web||webbridge', label: '网页桥接', icon: LLM_DD_ICONS.box }],
                    'web||webbridge');
                this.modelsConfig = [];
                this.updateToolbarForModel();
                return;
            }

            // pi 编码智能体（画布代理）：置顶入口；底层模型在 设置→通用 选择
            models.unshift({
                key: 'pi||pi-agent',
                provider: 'pi',
                id: 'pi-agent',
                displayName: 'agent模式',
                type: 'agent'
            });

            // 网页桥接（豆包等站点网页直连）：消息经后端专用浏览器驱动进
            // 网页，回复与产物自动回流画布；桥接站点在 设置 → 网页桥接 选择
            models.push({
                key: 'web||webbridge',
                provider: 'web',
                id: 'webbridge',
                displayName: '网页桥接',
                type: 'web'
            });

            // 尽量保持之前的选择；无有效选择时取第一项（与原生 select 行为一致）。
            // 下拉框 value 为"厂商||模型ID"复合键，不同厂商的同名模型可共存
            const current = previousValue && models.some((m) => m.key === previousValue)
                ? previousValue
                : models[0].key;
            this.modelDropdown.setOptions(models.map((model) => {
                const label = showProvider
                    ? `${model.displayName || model.id} · ${model.provider}`
                    : (model.displayName || model.id);
                return { value: model.key, label, icon: LLM_DD_ICONS.box };
            }), current);

            // 根据当前模型刷新工具栏（尺寸/质量显隐、发送按钮文案）
            this.updateToolbarForModel();
        } catch (error) {
            console.error('加载模型列表失败:', error);
        }
    }

    // ==================== 消息渲染 ====================

    /**
     * 添加一条消息气泡
     * @param {string} role - 'user' 或 'assistant'
     * @param {string} text - 消息文本
     * @param {string[]} images - 消息附带的图片 data URL
     * @param {Object} [opts] - 额外选项
     * @param {string} [opts.rawPrompt] - 用户消息的原始提示词（气泡文本可能是"（图片）"占位符，
     *                                    重新编辑时必须回填原始内容）
     * @param {{name: string, truncated?: boolean}[]} [opts.files] - 用户消息附带的文档（气泡内显示文件名块）
     * @returns {HTMLElement} 消息文本元素（便于后续更新内容）
     */
    appendMessage(role, text, images = [], opts = {}) {
        // 有消息后隐藏空状态提示
        if (this.emptyTipEl) this.emptyTipEl.style.display = 'none';

        const bubbleWrap = document.createElement('div');
        bubbleWrap.className = `llm-msg ${role}`;

        // 附带图片（用户上传图片或模型生成的图片）
        if (images.length > 0) {
            const container = document.createElement('div');
            container.className = 'llm-msg-images';
            images.forEach((src) => {
                const imgEl = document.createElement('img');
                imgEl.className = 'llm-msg-image';
                imgEl.src = src;
                imgEl.alt = '图片';
                imgEl.addEventListener('click', () => this.lightbox.open(src));
                LlmImageDrag.attach(imgEl);
                container.appendChild(this.wrapRemovableImage(imgEl));
            });
            bubbleWrap.appendChild(container);
        }

        // 附带文档（用户上传的 txt/pdf/docx 等，气泡里显示文件名块）
        const msgFiles = Array.isArray(opts.files) ? opts.files : [];
        if (msgFiles.length > 0) {
            const fileContainer = document.createElement('div');
            fileContainer.className = 'llm-msg-files';
            msgFiles.forEach((f) => {
                const chip = document.createElement('div');
                chip.className = 'llm-msg-file';
                chip.title = `${f.name}${f.truncated ? '（内容过长已截断）' : ''}`;
                const extEl = document.createElement('span');
                extEl.className = 'llm-msg-file-ext';
                extEl.textContent = (String(f.name).split('.').pop() || 'file').toUpperCase().slice(0, 5);
                const nameEl = document.createElement('span');
                nameEl.className = 'llm-msg-file-name';
                nameEl.textContent = f.name;
                chip.appendChild(extEl);
                chip.appendChild(nameEl);
                fileContainer.appendChild(chip);
            });
            bubbleWrap.appendChild(fileContainer);
        }

        const textEl = document.createElement('div');
        textEl.className = 'llm-msg-text';
        textEl.textContent = text;
        bubbleWrap.appendChild(textEl);

        // 用户消息气泡下方追加"重新编辑"操作栏
        if (role === 'user') {
            bubbleWrap.appendChild(this.buildUserActions(opts.rawPrompt ?? text, images));
        }

        this.messagesEl.appendChild(bubbleWrap);
        this.scrollToBottom();
        return textEl;
    }

    /**
     * 构建用户消息气泡下方的操作栏（当前仅"重新编辑"一个纯图标按钮）
     * @param {string} prompt - 该条消息的原始提示词
     * @param {string[]} images - 该条消息附带的图片 data URL
     * @returns {HTMLElement} 操作栏元素
     */
    buildUserActions(prompt, images) {
        const actions = document.createElement('div');
        actions.className = 'llm-msg-actions';

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'llm-msg-action-btn';
        // 悬停时由 CSS 伪元素渲染气泡提示（不用原生 title，避免样式不可控）
        editBtn.dataset.tip = '重新编辑';
        editBtn.setAttribute('aria-label', '重新编辑');
        editBtn.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 20h9"></path>
                <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
            </svg>
        `;
        editBtn.addEventListener('click', () => this.reeditMessage(prompt, images));
        // 原始提示词存 data 属性：F5 恢复后重绑"重新编辑"时从 DOM 取回
        actions.dataset.rawPrompt = prompt ?? '';

        actions.appendChild(editBtn);
        return actions;
    }

    /**
     * 重新编辑：把该条用户消息的提示词与图片回填到输入区（全部覆盖现有内容）
     * @param {string} prompt - 原始提示词
     * @param {string[]} images - 原始图片 data URL 列表
     */
    reeditMessage(prompt, images = []) {
        if (this.inputEl) {
            this.inputEl.value = prompt || '';
            this.inputEl.focus();
            // 光标移到末尾，方便直接续写
            const end = this.inputEl.value.length;
            this.inputEl.setSelectionRange(end, end);
        }

        // 图片区先清空再回填；消息里的图片本身是 data URL，走同步快路径
        this.attachments.clear();
        images.forEach((src) => this.attachments.addImageUrl(src));
    }

    /**
     * 消息区无条件滚动到底部并恢复自动跟随：
     * 用于发送消息、F5 恢复记录等"应当贴底"的场景
     */
    scrollToBottom() {
        this.autoFollow = true;
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        this._updateScrollBtn();
    }

    /**
     * 仅在自动跟随状态下贴底（流式输出逐块滚动走这里）：
     * 用户上滑阅读历史即暂停跟随，不被新输出拽回；点回底按钮恢复
     */
    followBottom() {
        if (this.autoFollow) this.scrollToBottom();
    }

    /** 回底按钮点击：平滑滚动到最新消息（滚动到位后自然恢复自动跟随） */
    _smoothScrollToBottom() {
        this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: 'smooth' });
    }

    /**
     * 消息区滚动监听：按离底距离驱动自动跟随开关与回底按钮显隐
     * （距底 ≤120px 视为贴底；离底超过 120px 浮现按钮）
     */
    _onMessagesScroll() {
        const dist = this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight;
        this.autoFollow = dist <= 120;
        this._updateScrollBtn();
    }

    /** 按离底距离显隐回底按钮 */
    _updateScrollBtn() {
        if (!this.scrollBtn) return;
        const dist = this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight;
        this.scrollBtn.classList.toggle('visible', dist > 120);
    }

    /**
     * 创建空的 assistant 消息容器作为流式块序列的父节点（供各模式控制器
     * 使用：pi 智能体的分阶段块、网页桥接的流式文本都以它为容器）。
     * 追加后移除默认文本节点，可选带一个流式文本元素
     * @param {boolean} [withTextEl=false] - 是否预置 .llm-msg-text 文本元素
     * @returns {{wrap: HTMLElement, textEl: HTMLElement|null}}
     */
    createAssistantBubble(withTextEl = false) {
        const seedEl = this.appendMessage('assistant', '');
        const wrap = seedEl.parentElement;
        seedEl.remove();
        let textEl = null;
        if (withTextEl) {
            textEl = document.createElement('div');
            textEl.className = 'llm-msg-text';
            wrap.appendChild(textEl);
        }
        return { wrap, textEl };
    }

    // ==================== 发送消息 ====================

    /**
     * 发送当前输入内容到模型
     * 根据选中的模型自动判断是聊天对话还是图像生成。
     */
    async send() {
        // pi 流式中：发送按钮即"停止"
        if (this.piAgent?.isStreaming()) {
            this.piAgent.abort();
            return;
        }
        // 网页桥接捕获回复中：发送按钮即"停止"（中止捕获并尽力停掉网页侧生成）
        if (this.webBridge?.isStreaming()) {
            this.webBridge.abort();
            return;
        }
        // 聊天/视频仍走 isSending 串行锁；生图任务彼此独立（API 并发），
        // 选中绘图模型时不拦，允许不等上一张完成就发下一张
        if (this.isSending && !this.isImageModel(this.modelDropdown?.value)) return;

        const text = this.inputEl.value.trim();
        if (!text && !this.attachments.hasAttachments()) return;
        // 文档仍在解析中时拦住，避免未解析完的附件被静默漏发
        if (this.attachments.isParsing()) {
            alert('文件正在解析中，请稍候再发送');
            return;
        }

        const model = this.modelDropdown?.value;
        if (!model) {
            alert('请先选择模型（模型在设置 → API 中配置）');
            return;
        }

        if (this.isAgentModel(model)) {
            // pi 编码智能体路径：文档文本直接拼进提示词（不走 /chat 后端拼接）
            await this.piAgent.send(this.buildAgentText(text), this.attachments.getAll());
        } else if (this.isWebBridgeModel(model)) {
            // 网页桥接路径：消息由后端专用浏览器驱动进站点网页，
            // 流式回复与产物经 webbridgeEvent / WS 回流，不走 /api/llm
            await this.webBridge.send(text, this.attachments.getAll());
        } else if (this.isVideoModel(model)) {
            await this.videoGen.generate(text, model, this.attachments.getAll());
        } else if (this.isImageModel(model)) {
            await this.sendImageGeneration(text, model);
        } else {
            await this.sendChat(text, model);
        }
    }

    /**
     * 为 pi 智能体拼接提示词：将已解析的文档文本附在用户正文之后
     * （生图/视频模型不读文档，故仅智能体路径做此拼接）
     * @param {string} text - 用户输入文本
     * @returns {string} 拼接文档后的文本
     */
    buildAgentText(text) {
        const files = this.attachments.getFiles();
        if (!files.length) return text;
        const block = files
            .map((f) => `【附件 ${f.name}${f.truncated ? '（内容过长已截断）' : ''}】\n${f.text}`)
            .join('\n\n');
        return text ? `${text}\n\n${block}` : block;
    }

    /**
     * 发送聊天请求
     * @param {string} text - 用户输入文本
     * @param {string} model - 选中的模型 ID
     */
    async sendChat(text, model) {
        // 记录本次发送的内容，清空输入区
        const images = this.attachments.getAll();
        const files = this.attachments.getFiles();
        this.inputEl.value = '';
        this.attachments.clear();

        // 渲染用户消息并加入历史（纯附件时气泡显示占位符，但重新编辑要拿到原始文本）
        this.appendMessage('user', text || (images.length ? '（图片）' : '（文件）'), images, { rawPrompt: text, files });
        this.history.push({ role: 'user', content: text });

        // 渲染“思考中”占位气泡
        const thinkingEl = this.appendMessage('assistant', '正在思考…');
        thinkingEl.parentElement.classList.add('thinking');

        // 锁定发送状态
        this.isSending = true;
        if (this.sendBtn) {
            this.sendBtn.disabled = true;
            this.sendBtn.textContent = '回复中…';
        }

        try {
            // 聊天模型：注入启用的系统提示词（system 角色，每轮请求都携带）
            const systemPrompt = window.llmSystemPrompt?.getActiveContent('chat');
            const messages = systemPrompt
                ? [{ role: 'system', content: systemPrompt }, ...this.history]
                : this.history;

            // 下拉 value 为"厂商||模型ID"复合键：拆开后显式指定厂商，
            // 后端直接路由（同名模型在多个中转站共存时可区分）
            const selection = LumenLight.parseModelKey(model);
            const response = await fetch('/api/llm/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: selection.id, provider: selection.provider, messages, images, files })
            });

            const result = await response.json();

            thinkingEl.parentElement.classList.remove('thinking');

            if (response.ok && result.status === 'ok') {
                thinkingEl.textContent = result.reply || '（模型未返回内容）';
                this.history.push({ role: 'assistant', content: result.reply || '' });
            } else {
                // 失败时显示错误，不把错误内容加入历史
                thinkingEl.textContent = '❌ ' + (result.message || '请求失败');
                thinkingEl.parentElement.classList.add('error');
            }
        } catch (error) {
            thinkingEl.parentElement.classList.remove('thinking');
            thinkingEl.textContent = '❌ 连接失败：' + error.message;
            thinkingEl.parentElement.classList.add('error');
            console.error('聊天请求失败:', error);
        } finally {
            this.isSending = false;
            if (this.sendBtn) {
                this.sendBtn.disabled = false;
                // 根据当前模型恢复按钮文案（聊天=发送，绘图=生成图片）
                this.updateToolbarForModel();
            }
            this.followBottom();   // 仅在跟随态贴底：用户上滑阅读时不拽回
        }
    }

    /**
     * 发送图像生成请求
     * 待发送图片会作为参考图一并发送（图生图 I2I，豆包 Seedream 等支持）
     * @param {string} prompt - 图像生成提示词
     * @param {string} model - 选中的图像生成模型 ID
     * @param {Object} [opts] - 由"重新生成"传入的原始请求参数（正常发送不传）
     * @param {string[]} [opts.images] - 原始参考图列表（图生图时复用）
     * @param {string} [opts.ratio] - 原始比例选择
     * @param {string} [opts.tier] - 原始分辨率档位
     * @param {string} [opts.quality] - 原始质量选择
     */
    async sendImageGeneration(prompt, model, opts = {}) {
        // 重新生成时复用原始请求的参考图；正常发送从输入区状态读取
        const isRegen = opts.ratio !== undefined;
        const images = isRegen ? [...opts.images] : this.attachments.getAll();

        // 仅正常发送时清空输入区；重新生成不动输入框与待发送图片
        if (!isRegen) {
            this.inputEl.value = '';
            this.attachments.clear();
        }

        // 渲染用户提示词消息（附带参考图缩略图）
        this.appendMessage('user', prompt || '（图片）', images, { rawPrompt: prompt });

        // 读取当前比例与档位（重新生成时优先沿用原请求）
        const ratio = isRegen ? opts.ratio : this.sizePicker.getRatio();
        const tier = isRegen ? (opts.tier || '2K') : this.sizePicker.getTier();
        const quality = opts.quality || this.qualityDropdown?.value || '';
        const isI2I = images.length > 0;
        const sizeText = ratio === 'auto' ? '自动比例' : `${ratio} / ${tier}`;
        const thinkingEl = this.appendMessage('assistant', isI2I ? `正在生成 ${sizeText} 图片（图生图）…` : `正在生成 ${sizeText} 图片…`);
        thinkingEl.parentElement.classList.add('thinking');

        // 生图不走 isSending 串行锁（聊天/视频专用）：API 支持并发，
        // 连续发送互不阻塞；每个任务持独立 AbortController 供停止按钮中止，
        // 前端 abort 后后端监听断连同步掐断对上游厂商的请求（不再继续计费）
        const abortController = new AbortController();
        this._imageGenTasks.add(abortController);
        this._updateStopBtn();

        try {
            // 根据模型、比例、档位计算实际像素，模型不支持时自动降级
            let effectiveSize = null;
            if (ratio === 'auto' && isI2I) {
                const dim = await this.getImageSize(images[0]);
                if (dim) {
                    const adaptive = LlmResolution.computeAdaptiveSize(dim.width, dim.height, tier);
                    const constrained = LlmResolution.applyModelResolutionConstraints(
                        model,
                        adaptive.width,
                        adaptive.height,
                        LlmResolution.simplifyRatio(dim.width, dim.height)
                    );
                    effectiveSize = `${constrained.width}x${constrained.height}`;
                }
            } else if (ratio !== 'auto') {
                const res = LlmResolution.getResolutionForModel(model, ratio, tier);
                effectiveSize = res ? `${res.width}x${res.height}` : null;
            }

            // 生图模型没有 system 角色：启用的风格模板拼接在提示词前部
            // （重新生成时传入的是原始提示词，模板按当前启用状态重新拼入）
            const stylePrompt = window.llmSystemPrompt?.getActiveContent('image');
            const finalPrompt = stylePrompt ? `${stylePrompt}\n\n${prompt}` : prompt;

            // 下拉 value 为"厂商||模型ID"复合键：拆开后显式指定厂商，
            // 后端直接路由（同名模型在多个中转站共存时可区分）
            const selection = LumenLight.parseModelKey(model);
            const requestBody = { model: selection.id, provider: selection.provider, prompt: finalPrompt, images };
            if (effectiveSize && effectiveSize !== 'auto') {
                requestBody.size = effectiveSize;
            }
            // quality 为空字符串表示"自动"，请求时不传，由模型默认决定
            if (quality) {
                requestBody.quality = quality;
            }

            const response = await fetch('/api/llm/generate-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
                signal: abortController.signal
            });

            const result = await response.json();

            thinkingEl.parentElement.classList.remove('thinking');

            if (response.ok && result.status === 'ok' && result.imageUrl) {
                const img = document.createElement('img');
                img.className = 'llm-msg-image';
                img.src = result.imageUrl;
                img.alt = '生成的图片';
                img.onclick = () => this.lightbox.open(result.imageUrl);
                LlmImageDrag.attach(img, { prompt });
                // 用"图片 + 操作栏"块整体替换占位气泡，不残留空文本气泡
                const block = this.buildGeneratedImageBlock(img, { prompt, images, ratio, tier, quality });
                thinkingEl.parentElement.replaceWith(block);

                // 不加入历史，因为图像生成不支持多轮对话
            } else {
                thinkingEl.textContent = '❌ ' + (result.message || '图片生成失败');
                thinkingEl.parentElement.classList.add('error');
            }
        } catch (error) {
            thinkingEl.parentElement.classList.remove('thinking');
            if (error?.name === 'AbortError') {
                // 用户点停止按钮主动中止：中性提示，不算错误
                thinkingEl.textContent = '⛔ 已停止生成';
            } else {
                thinkingEl.textContent = '❌ 连接失败：' + error.message;
                thinkingEl.parentElement.classList.add('error');
                console.error('图像生成请求失败:', error);
            }
        } finally {
            this._imageGenTasks.delete(abortController);
            this._updateStopBtn();
            this.followBottom();   // 仅在跟随态贴底：用户上滑阅读时不拽回
        }
    }

    /**
     * 中止面板全部在飞生图任务（停止按钮回调）
     * 逐个 abort 会触发各任务自己的 catch：气泡改为"已停止生成"并落盘快照；
     * 后端经断连监听同步中止对上游厂商的请求
     */
    abortImageGenerations() {
        if (this._imageGenTasks.size === 0) return;
        const count = this._imageGenTasks.size;
        for (const ac of [...this._imageGenTasks]) ac.abort();
        window.socket?.showNotification?.(`已停止 ${count} 张生图`);
    }

    /**
     * 按在飞生图任务数与当前模型刷新停止按钮：
     *   - 显隐：仅绘图模型显示（agent/聊天/视频/网页桥接无生图可停）；
     *     有在飞任务时即使切走了模型也保持可见，避免任务失管无法取消
     *   - 两态：无任务暗红灭置禁用，有任务亮红可点
     */
    _updateStopBtn() {
        if (!this.stopBtn) return;
        const modelId = this.modelDropdown?.value;
        const isImage = !this.isVideoModel(modelId) && this.isImageModel(modelId);
        const active = this._imageGenTasks.size > 0;
        this.stopBtn.style.display = (isImage || active) ? '' : 'none';
        this.stopBtn.classList.toggle('active', active);
        this.stopBtn.disabled = !active;
    }

    /**
     * 构造生成图片的完整展示块：图片（含悬停删除）+ 底部操作栏
     * @param {HTMLImageElement} imgEl - 已绑定灯箱/拖拽事件的图片元素
     * @param {Object} requestParams - 原始请求参数 { prompt, images, ratio, tier, quality }，供重新生成复用
     * @returns {HTMLDivElement} 展示块容器
     */
    buildGeneratedImageBlock(imgEl, requestParams) {
        const block = document.createElement('div');
        block.className = 'llm-gen-block';
        // 块 id → 原始请求参数：重新生成与 F5 恢复后的重绑都按它索引
        // （参考图为 data URL，随快照一起进 IndexedDB）
        block.dataset.genId = LumenLight.generateId();
        this._genParams.set(block.dataset.genId, requestParams);

        // 图片容器（悬停显示删除按钮，复用现有逻辑）
        block.appendChild(this.wrapRemovableImage(imgEl));

        // 底部操作栏：白色线条风格按钮，后续新按钮追加在此栏即可
        const actions = document.createElement('div');
        actions.className = 'llm-gen-actions';

        const regenBtn = document.createElement('button');
        regenBtn.type = 'button';
        regenBtn.className = 'llm-gen-btn';
        regenBtn.title = '使用同一套提示词与参考图，按当前选中模型重新生成';
        regenBtn.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
                <polyline points="21 3 21 9 15 9"></polyline>
            </svg>
            <span>重新生成</span>
        `;
        regenBtn.addEventListener('click', () => this.regenerate(requestParams));

        actions.appendChild(regenBtn);
        block.appendChild(actions);
        return block;
    }

    /**
     * 重新生成：复用原始请求的提示词、参考图、比例、档位与质量，
     * 按当前选中的绘图模型再次生成（新图作为新消息追加在底部）
     * @param {Object} params - 原始请求参数 { prompt, images, ratio, tier, quality }
     */
    async regenerate({ prompt, images, ratio, tier, quality }) {
        // 与正常发送一致：生图任务不查 isSending 串行锁，允许在飞时再次发起

        const model = this.modelDropdown?.value;
        if (!model) {
            alert('请先在聊天窗口选择模型');
            return;
        }
        if (!this.isImageModel(model)) {
            alert('当前选中的模型不是绘图模型，请切换后再重新生成');
            return;
        }

        await this.sendImageGeneration(prompt, model, { images: images || [], ratio, tier, quality });
    }

    /**
     * 获取图片的原始像素尺寸
     * @param {string} src - 图片的 data URL 或网址
     * @returns {Promise<{width: number, height: number}|null>} 失败时返回 null
     */
    getImageSize(src) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () => resolve(null);
            img.src = src;
        });
    }

    /**
     * 按面板当前模式刷新清空按钮显隐：LLM 对话框模式显示，Comfy 模式隐藏
     */
    updateClearBtnVisibility() {
        const mode = document.getElementById('promptMode')?.value;
        if (this.clearBtn) this.clearBtn.style.display = mode === 'llm' ? '' : 'none';
        // 统计灰字与清空按钮同规则：仅 LLM 模式且已有数据时显示
        if (this.piUsageEl) {
            this.piUsageEl.style.display = (mode === 'llm' && this.piUsageEl.textContent) ? '' : 'none';
        }
    }

    /**
     * 刷新面板头部的 pi 调用统计灰字（数据来自 pi message_end 的 message.usage）。
     * 不猜上下文窗口分母：上下文只显示绝对 token，另附缓存命中率。
     * @param {Object} usage - {input, output, cacheRead, cacheWrite, totalTokens}
     * @param {string} [modelId] - 本次调用实际使用的模型 ID（消息上的字段，
     *   是 API 调用铁证；模型"自我认知"可能被历史陈旧信息误导，不可信）
     */
    updatePiUsage(usage, modelId) {
        if (!this.piUsageEl || !usage) return;
        // 记住最近一次统计：随聊天快照按存档持久化，F5 后恢复显示
        this._piUsage = { usage, modelId: modelId || null };
        const ctx = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
        const parts = [];
        if (modelId) parts.push(String(modelId));
        parts.push(`ctx ${LlmChat.formatTokens(ctx)}`);
        if (ctx > 0) parts.push(`CH ${(((usage.cacheRead || 0) / ctx) * 100).toFixed(1)}%`);
        this.piUsageEl.textContent = parts.join(' · ');
        this.piUsageEl.title = `本轮调用统计：上下文 ${ctx} token（输入 ${usage.input || 0} + 缓存读 ${usage.cacheRead || 0} + 缓存写 ${usage.cacheWrite || 0}），输出 ${usage.output || 0} token`;
        this.updateClearBtnVisibility();   // 顺带按当前模式刷新显隐
    }

    /** token 数 → 紧凑显示（1.2M / 34.5k / 875） */
    static formatTokens(n) {
        if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
        if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
        return String(n);
    }

    // ==================== 聊天记录持久化（编排已拆至 LlmHistoryController） ====================
    // 消息区 DOM 快照存 IndexedDB（跨存档统一键，网页桥接按站点分键），
    // F5 后整体回填并重绑交互。
    // 本类只保留同名薄代理（内部/外部调用点零改动）；isWebMode 与
    // _onModelChanged 属模型切换逻辑，仍归本类。

    /** 当前持久化键（代理到持久化控制器；网页桥接模式按站点细分） */
    _historyKey() {
        return this._historyCtl._historyKey();
    }

    /**
     * 当前选中的是否为网页桥接入口（厂商名 'web'；公共接口，控制器复用）
     */
    isWebMode() {
        try {
            return LumenLight.parseModelKey(this.modelDropdown?.value || '').provider === 'web';
        } catch {
            return false;
        }
    }

    /** 统一处理模型切换：工具栏刷新 + 网页桥接模式的聊天记录互换 */
    _onModelChanged() {
        this.updateToolbarForModel();
        this._swapHistorySnapshot();
    }

    // ---- 以下 6 个为 LlmHistoryController 同名方法的薄代理 ----
    // （存取编排与恢复重绑的实现见 js/components/LlmHistoryController.js）

    /** 模式切换（网页桥接 ↔ LLM/agent 或站点变更）时的历史互换 */
    _swapHistorySnapshot() {
        return this._historyCtl._swapHistorySnapshot();
    }

    /** 变更防抖保存（800ms 合并高频更新；恢复完成前忽略） */
    _scheduleHistorySave() {
        return this._historyCtl._scheduleHistorySave();
    }

    /** 序列化消息区写入 IndexedDB（key 缺省按当前持久化键） */
    _saveHistorySnapshot(key) {
        return this._historyCtl._saveHistorySnapshot(key);
    }

    /** 卸载前把防抖窗口内的最后一次变更尽力落盘 */
    _flushHistory() {
        return this._historyCtl._flushHistory();
    }

    /** 启动恢复：等实时保存就绪后读快照回填消息区并重绑交互 */
    _restoreHistory() {
        return this._historyCtl._restoreHistory();
    }

    /** 挂消息区变更监听（此后一切增删改都会触发防抖落盘） */
    _startHistoryObserver() {
        return this._historyCtl._startHistoryObserver();
    }

    /**
     * 清空对话历史与界面
     */
    clearChat() {
        this.history = [];
        // 终止所有进行中的视频生成轮询
        this.videoGen?.cancelAll();
        // 同步重置 pi 会话：pi 的对话按存档持久化在会话文件里，只清界面
        // 会让旧上下文在下一句原样背进去（上下文持续膨胀，历史里的
        // 过期信息甚至会误导模型自我认知）；后端重置时清空 sessions/
        // 全部会话文件（所有存档的 agent 上下文一并推倒重来）
        fetch('/api/pi/reset-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ archive: window.saveManager?.currentSave || null })
        }).catch(() => { /* pi 未运行或重置失败：不阻塞界面清空 */ });
        if (this.piUsageEl) {
            this.piUsageEl.textContent = '';
            this._piUsage = null;   // 随快照持久化的统计一并清除
        }
        // 持久化快照与生成参数一并清除（防抖随后写入的空快照与之一致）
        this._genParams.clear();
        this._historyCtl._deleteHistorySnapshot();
        // 移除消息区内除空状态提示外的所有节点。
        // 这里刻意不按 class 白名单（如 .llm-msg）删除：生成图片块 .llm-gen-block 是
        // 用 replaceWith 整体替换占位气泡产生的，并不带 .llm-msg，白名单会漏掉它。
        // 改为"保留白名单"后，将来新增任何消息块类型都无需再改这里。
        Array.from(this.messagesEl.children).forEach((el) => {
            if (el !== this.emptyTipEl) el.remove();
        });
        if (this.emptyTipEl) this.emptyTipEl.style.display = '';
    }
}

// 将 LlmChat 类暴露到全局作用域
window.LlmChat = LlmChat;
