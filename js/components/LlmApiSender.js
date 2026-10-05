/**
 * ==========================================================================
 * LumenLight LLM 发送链路控制器（LlmApiSender）
 * ==========================================================================
 * 作用：承载 LlmChat 拆分出的发送链路（第二刀），包括：
 *   1. send() 发送路由：按选中模型分流到 pi agent / 网页桥接 / 视频生成 /
 *      图像生成四条路径（含流式中"发送即停止"、isSending 串行锁判定）；
 *   2. 图像生成全流程：分辨率计算与降级、风格模板拼接、参考图（I2I）、
 *      /api/llm/generate-image 请求、结果落图块；
 *   3. 生图停止内核：每任务一个 GenStopControl（与生图节点 X 同款，
 *      无头模式），_imageGenTasks 集合与面板 ■停止按钮状态归本类；
 *   4. 生成图片块构造与"重新生成"（_genParams 原始请求参数存 chat，
 *      LlmHistoryController 恢复重绑共用）。
 *
 * 与宿主的分工：本类只管"发出去与收回来"，消息区 DOM（appendMessage/
 * appendMessage 的气泡）、模型分类判断（isImageModel 等）、输入区状态
 * （attachments/sizePicker/qualityDropdown/modelDropdown）仍归 LlmChat，
 * 经 chat 引用访问。LlmChat 上留同名薄代理，外部调用点零改动。
 * ==========================================================================
 */

class LlmApiSender {
    /**
     * 构造函数
     * @param {LlmChat} chat - 宿主聊天组件（DOM 渲染与输入区状态经它访问）
     */
    constructor(chat) {
        this.chat = chat;
        // 在飞生图任务的停止控件集合（■停止按钮的作用域：生图不走
        // isSending 串行锁，任务彼此独立可并发，点停止全部中止）
        this._imageGenTasks = new Set();
    }

    // ==================== 发送路由 ====================

    /**
     * 发送当前输入内容到模型
     * 根据选中的模型自动判断是聊天对话还是图像生成。
     */
    async send() {
        const chat = this.chat;
        // pi 流式中：发送按钮即"停止"
        if (chat.piAgent?.isStreaming()) {
            chat.piAgent.abort();
            return;
        }
        // 网页桥接捕获回复中：发送按钮即"停止"（中止捕获并尽力停掉网页侧生成）
        if (chat.webBridge?.isStreaming()) {
            chat.webBridge.abort();
            return;
        }
        // 聊天/视频仍走 isSending 串行锁；生图任务彼此独立（API 并发），
        // 选中绘图模型时不拦，允许不等上一张完成就发下一张
        if (chat.isSending && !chat.isImageModel(chat.modelDropdown?.value)) return;

        const text = chat.inputEl.value.trim();
        if (!text && !chat.attachments.hasAttachments()) return;
        // 文档仍在解析中时拦住，避免未解析完的附件被静默漏发
        if (chat.attachments.isParsing()) {
            alert('文件正在解析中，请稍候再发送');
            return;
        }

        const model = chat.modelDropdown?.value;
        if (!model) {
            alert('请先选择模型（模型在设置 → API 中配置）');
            return;
        }

        if (chat.isWebBridgeModel(model)) {
            // 网页桥接路径：消息由后端专用浏览器驱动进站点网页，
            // 流式回复与产物经 webbridgeEvent / WS 回流，不走 /api/llm
            await chat.webBridge.send(text, chat.attachments.getAll());
        } else if (chat.isVideoModel(model)) {
            await chat.videoGen.generate(text, model, chat.attachments.getAll());
        } else if (chat.isImageModel(model)) {
            await this.sendImageGeneration(text, model);
        } else {
            // 对话模型（Agent 分类）→ pi agent 路径。面板不再有纯聊天直连：
            // agent 自带完整对话能力（分类下拉改造时的决策），chat/auto
            // 模型统一以该模型运行 pi
            await chat.piAgent.send(this.buildAgentText(text), chat.attachments.getAll());
        }
    }

    /**
     * 为 pi 智能体拼接提示词：将已解析的文档文本附在用户正文之后
     * （生图/视频模型不读文档，故仅智能体路径做此拼接）
     * @param {string} text - 用户输入文本
     * @returns {string} 拼接文档后的文本
     */
    buildAgentText(text) {
        const files = this.chat.attachments.getFiles();
        if (!files.length) return text;
        const block = files
            .map((f) => `【附件 ${f.name}${f.truncated ? '（内容过长已截断）' : ''}】\n${f.text}`)
            .join('\n\n');
        return text ? `${text}\n\n${block}` : block;
    }

    // ==================== 图像生成 ====================

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
        const chat = this.chat;
        // 重新生成时复用原始请求的参考图；正常发送从输入区状态读取
        const isRegen = opts.ratio !== undefined;
        const images = isRegen ? [...opts.images] : chat.attachments.getAll();

        // 仅正常发送时清空输入区；重新生成不动输入框与待发送图片
        if (!isRegen) {
            chat.inputEl.value = '';
            chat.attachments.clear();
        }

        // 渲染用户提示词消息（附带参考图缩略图）
        chat.appendMessage('user', prompt || '（图片）', images, { rawPrompt: prompt });

        // 读取当前比例与档位（重新生成时优先沿用原请求）
        const ratio = isRegen ? opts.ratio : chat.sizePicker.getRatio();
        const tier = isRegen ? (opts.tier || '2K') : chat.sizePicker.getTier();
        const quality = opts.quality || chat.qualityDropdown?.value || '';
        const isI2I = images.length > 0;
        const sizeText = ratio === 'auto' ? '自动比例' : `${ratio} / ${tier}`;
        const thinkingEl = chat.appendMessage('assistant', isI2I ? `正在生成 ${sizeText} 图片（图生图）…` : `正在生成 ${sizeText} 图片…`);
        thinkingEl.parentElement.classList.add('thinking');

        // 生图不走 isSending 串行锁（聊天/视频专用）：API 支持并发，
        // 连续发送互不阻塞；每个任务持独立 GenStopControl（与生图节点
        // X 按钮同一内核，此处无头模式不出按钮），前端 abort 后后端监听
        // 断连同步掐断对上游厂商的请求（不再继续计费）
        const control = new GenStopControl();
        this._imageGenTasks.add(control);
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
                // begin() 此刻才创建内部 AbortController 并返回 signal——
                // 与画布节点用法对齐；漏掉 begin 的话 signal 为 null，
                // fetch 不可中止，停止按钮只会空转（此前的实际 bug）
                signal: control.begin()
            });

            const result = await response.json();

            thinkingEl.parentElement.classList.remove('thinking');

            if (response.ok && result.status === 'ok' && result.imageUrl) {
                const img = document.createElement('img');
                img.className = 'llm-msg-image';
                img.src = result.imageUrl;
                img.alt = '生成的图片';
                img.onclick = () => chat.lightbox.open(result.imageUrl);
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
            if (GenStopControl.isAbortError(error)) {
                // 用户点停止按钮主动中止：中性提示，不算错误
                thinkingEl.textContent = '⛔ 已停止生成';
            } else {
                thinkingEl.textContent = '❌ 连接失败：' + error.message;
                thinkingEl.parentElement.classList.add('error');
                console.error('图像生成请求失败:', error);
            }
        } finally {
            control.end();
            this._imageGenTasks.delete(control);
            this._updateStopBtn();
            chat.followBottom();   // 仅在跟随态贴底：用户上滑阅读时不拽回
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
        for (const control of [...this._imageGenTasks]) control.abort();
        window.socket?.showNotification?.(`已停止 ${count} 张生图`);
    }

    /**
     * 按在飞生图任务数与当前模型刷新停止按钮：
     *   - 显隐：仅绘图模型显示（agent/聊天/视频/网页桥接无生图可停）；
     *     有在飞任务时即使切走了模型也保持可见，避免任务失管无法取消
     *   - 两态：无任务暗红灭置禁用，有任务亮红可点
     */
    _updateStopBtn() {
        const chat = this.chat;
        if (!chat.stopBtn) return;
        const modelId = chat.modelDropdown?.value;
        const isImage = !chat.isVideoModel(modelId) && chat.isImageModel(modelId);
        const active = this._imageGenTasks.size > 0;
        chat.stopBtn.style.display = (isImage || active) ? '' : 'none';
        chat.stopBtn.classList.toggle('active', active);
        chat.stopBtn.disabled = !active;
    }

    // ==================== 生成图片块与重新生成 ====================

    /**
     * 构造生成图片的完整展示块：图片（含悬停删除）+ 底部操作栏
     * @param {HTMLImageElement} imgEl - 已绑定灯箱/拖拽事件的图片元素
     * @param {Object} requestParams - 原始请求参数 { prompt, images, ratio, tier, quality }，供重新生成复用
     * @returns {HTMLDivElement} 展示块容器
     */
    buildGeneratedImageBlock(imgEl, requestParams) {
        const chat = this.chat;
        const block = document.createElement('div');
        block.className = 'llm-gen-block';
        // 块 id → 原始请求参数：重新生成与 F5 恢复后的重绑都按它索引
        // （参考图为 data URL，随快照一起进 IndexedDB）
        block.dataset.genId = LumenLight.generateId();
        chat._genParams.set(block.dataset.genId, requestParams);

        // 图片容器（悬停显示删除按钮，复用现有逻辑）
        block.appendChild(chat.wrapRemovableImage(imgEl));

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
        const chat = this.chat;
        // 与正常发送一致：生图任务不查 isSending 串行锁，允许在飞时再次发起

        const model = chat.modelDropdown?.value;
        if (!model) {
            alert('请先在聊天窗口选择模型');
            return;
        }
        if (!chat.isImageModel(model)) {
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
}

// 将 LlmApiSender 类暴露到全局作用域
window.LlmApiSender = LlmApiSender;
