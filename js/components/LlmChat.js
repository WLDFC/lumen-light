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
        this.modelSelect = document.getElementById('llmModelSelect');
        this.qualitySelect = document.getElementById('llmQualitySelect');
        this.uploadBtn = document.getElementById('llmUploadBtn');
        this.clearBtn = document.getElementById('llmClearBtn');
        this.fileInput = document.getElementById('llmFileInput');

        // 图片灯箱组件（已从本类拆分出去）
        this.lightbox = new LlmLightbox();
        // 待发送图片附件组件（已从本类拆分出去）
        this.attachments = new LlmAttachments('llmAttachments');
        // 视频生成控制器（独立模块，不干扰聊天/生图链路）
        this.videoGen = new LlmVideoGen(this);
        // pi 编码智能体控制器（画布代理，流式渲染经 piEvent 页面事件）
        this.piAgent = new LlmPiAgent(this);
        // 比例 + 分辨率档位双段选择面板（已从本类拆分出去）
        this.sizePicker = new LlmSizePicker('llmSizeSelect');
        // 模型 / 质量自定义下拉（图标按钮模式：纯图标触发器，点击弹出
        // 菜单选择，当前选中在菜单里以青色对勾标记，展开时按钮变强调蓝；
        // 交互与技能栏下拉一致。尺寸比例双段选择器维持原实现）
        this.modelDropdown = new LumenDropdown(this.modelSelect, {
            iconButton: true,
            triggerIcon: LLM_DD_ICONS.box,
            onChange: () => this.updateToolbarForModel()
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
        // 当前厂商的模型配置列表（含 type 标记），用于区分聊天/绘图模型
        this.modelsConfig = [];

        this.init();
    }

    /**
     * 初始化：绑定事件、加载模型列表
     */
    init() {
        if (!this.messagesEl) return;

        // 发送按钮
        this.sendBtn?.addEventListener('click', () => this.send());

        // 输入框：Enter 发送，Shift+Enter 换行
        this.inputEl?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.send();
            }
        });

        // 图片上传（视频文件路由到 LlmVideoGen，以视频消息形式导入）
        this.uploadBtn?.addEventListener('click', () => this.fileInput?.click());
        this.fileInput?.addEventListener('change', (e) => {
            Array.from(e.target.files || []).forEach((file) => {
                if (CanvasVideoManager.isVideoFile(file)) {
                    this.videoGen.importLocalVideo(file);
                } else {
                    this.attachments.addFromFile(file);
                }
            });
            e.target.value = '';
        });

        // 清空对话
        this.clearBtn?.addEventListener('click', () => this.clearChat());

        // 模型切换的 toolbar 刷新由 modelDropdown 的 onChange 回调触发
        // （原生 select 的 change 监听已由 LumenDropdown 取代）

        // 设置保存后刷新模型列表（设置界面会派发该事件）
        window.addEventListener('settingsSaved', () => this.loadModels());

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

        // 2. 自动识别：按模型名称关键词判断。
        //    image 可覆盖 gpt-image-*、gemini-*-flash-image、nano-banana 等中转站常见绘图模型命名。
        //    用复合键中解析出的纯模型 ID 判断，避免厂商名碰巧含关键词造成误判
        const keywords = ['seedream', 'dall-e', 'dalle', 'midjourney', 'sdxl', 'flux', 'image'];
        const lower = LumenLight.parseModelKey(modelId).id.toLowerCase();
        return keywords.some((k) => lower.includes(k));
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
        const isVideo = this.isVideoModel(modelId);
        const isImage = !isVideo && this.isImageModel(modelId);
        const qualityOptions = isImage ? this.getQualityOptions(modelId) : null;

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
                this.modelDropdown.setOptions(
                    [{ value: '', label: '未配置模型（请到设置中添加）' }], '');
                return;
            }

            // pi 编码智能体（画布代理）：置顶入口；底层模型在 设置→通用 选择
            models.unshift({
                key: 'pi||pi-agent',
                provider: 'pi',
                id: 'pi-agent',
                displayName: 'pi 编码智能体',
                type: 'agent'
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
     * 消息区滚动到底部
     */
    scrollToBottom() {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
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
        if (this.isSending) return;

        const text = this.inputEl.value.trim();
        if (!text && !this.attachments.hasImages()) return;

        const model = this.modelDropdown?.value;
        if (!model) {
            alert('请先选择模型（模型在设置 → API 中配置）');
            return;
        }

        if (this.isAgentModel(model)) {
            await this.piAgent.send(text, this.attachments.getAll());
        } else if (this.isVideoModel(model)) {
            await this.videoGen.generate(text, model, this.attachments.getAll());
        } else if (this.isImageModel(model)) {
            await this.sendImageGeneration(text, model);
        } else {
            await this.sendChat(text, model);
        }
    }

    /**
     * 发送聊天请求
     * @param {string} text - 用户输入文本
     * @param {string} model - 选中的模型 ID
     */
    async sendChat(text, model) {
        // 记录本次发送的内容，清空输入区
        const images = this.attachments.getAll();
        this.inputEl.value = '';
        this.attachments.clear();

        // 渲染用户消息并加入历史（纯图片时气泡显示占位符，但重新编辑要拿到原始文本）
        this.appendMessage('user', text || '（图片）', images, { rawPrompt: text });
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
                body: JSON.stringify({ model: selection.id, provider: selection.provider, messages, images })
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
            this.scrollToBottom();
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

        // 锁定发送状态
        this.isSending = true;
        if (this.sendBtn) {
            this.sendBtn.disabled = true;
            this.sendBtn.textContent = '生成中…';
        }

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
                body: JSON.stringify(requestBody)
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
            thinkingEl.textContent = '❌ 连接失败：' + error.message;
            thinkingEl.parentElement.classList.add('error');
            console.error('图像生成请求失败:', error);
        } finally {
            this.isSending = false;
            if (this.sendBtn) {
                this.sendBtn.disabled = false;
                // 根据当前模型恢复按钮文案（聊天=发送，绘图=生成图片）
                this.updateToolbarForModel();
            }
            this.scrollToBottom();
        }
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
        if (this.isSending) return;

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
     * 清空对话历史与界面
     */
    clearChat() {
        this.history = [];
        // 终止所有进行中的视频生成轮询
        this.videoGen?.cancelAll();
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
