/**
 * ==========================================================================
 * LumenLight 网页桥接控制器（LlmWebBridge）
 * ==========================================================================
 * 作用：LLM 窗口模型下拉选中「网页桥接」时的对话控制器（与 LlmPiAgent
 *       平级）：用户消息经后端 /api/webbridge/message 驱动进目标站点网页
 *       （豆包等），回复由后端轮询捕获并经 WebSocket 广播（webbridgeEvent
 *       页面事件），本类消费后渲染：
 *         - stream_text：流式文本覆盖当前气泡（全量快照，非增量拼接）；
 *         - message_end：文本定稿 + 回复里的图片以消息图形式展示
 *           （灯箱/拖拽落画布复用既有 .llm-msg-image 链路）；
 *         - error：错误说明块。
 *       图片/视频产物同时由后端按 new-image / new-video 回流落画布，
 *       面板展示与画布落图互不依赖。
 *
 * 连接策略：惰性启动——发送时后端未拉起浏览器会自动拉起（首次需在弹出的
 * 浏览器里登录站点一次，会话持久化在 data/webbridge/profile/）。
 * 当前站点 id 来自 /api/webbridge/overview，聊天记录按「存档+站点」分键
 * （见 LlmChat._historyKey），与 LLM 模式互不串。
 * ==========================================================================
 */

class LlmWebBridge {
    constructor(chat) {
        this.chat = chat;
        this._streaming = false;
        this._wrap = null;       // 本轮 assistant 气泡容器
        this._textEl = null;     // 流式文本元素
        this._taskEl = null;     // 任务进度行（生图/生视频进行中，单例原地更新）
        this._status = null;     // 最近一次 overview 快照
        this._activeSite = 'doubao';
        window.addEventListener('webbridgeEvent', (e) => this._onEvent(e.detail));
        // 设置保存后刷新站点信息（网页桥接面板可能改了 activeSite）
        window.addEventListener('settingsSaved', () => this.refreshStatus());
        this.refreshStatus();
    }

    isStreaming() { return this._streaming; }

    /** 当前桥接站点 id（聊天记录分键用；overview 未就绪时按默认站点） */
    getActiveSite() { return this._activeSite || 'doubao'; }

    /** 拉取后端状态快照（运行状态/站点清单/当前站点），失败静默降级 */
    async refreshStatus() {
        try {
            const resp = await fetch('/api/webbridge/overview');
            const data = await resp.json();
            if (data.status === 'ok') {
                this._status = data;
                const prevSite = this._activeSite;
                this._activeSite = data.activeSite || this._activeSite;
                // 站点变更通知（LlmChat 处于网页桥接模式时按新站点换聊天记录）
                if (prevSite !== this._activeSite) {
                    window.dispatchEvent(new CustomEvent('webbridgeSiteChanged', {
                        detail: { site: this._activeSite }
                    }));
                }
            }
        } catch { /* 后端不可达：保留旧值 */ }
        return this._status;
    }

    // ==================== 发送与事件 ====================

    /**
     * 发送用户消息到目标站点网页（流式结果经 webbridgeEvent 异步渲染）
     * @param {string} text - 用户输入
     * @param {string[]} images - 附件图片 data URL 列表
     */
    async send(text, images) {
        const chat = this.chat;
        chat.inputEl.value = '';
        chat.attachments.clear();
        chat.appendMessage('user', text || (images && images.length ? '（图片）' : ''), images);

        // 流式容器（气泡创建收敛到 LlmChat.createAssistantBubble 公共接口）
        const { wrap, textEl } = chat.createAssistantBubble(true);
        wrap.classList.add('thinking');
        textEl.textContent = '已发送到网页，等待回复… ▍';
        this._wrap = wrap;
        this._textEl = textEl;

        this._streaming = true;
        if (chat.sendBtn) chat.sendBtn.textContent = '■ 停止';
        chat.scrollToBottom();

        try {
            const resp = await fetch('/api/webbridge/message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, images: images || [] })
            });
            const result = await resp.json().catch(() => null);
            if (!resp.ok || !result || result.status !== 'ok') {
                throw new Error((result && result.message) || `网页桥接调用失败（HTTP ${resp.status}）`);
            }
            // 已接受；stream_text / message_end 事件更新气泡
        } catch (err) {
            this._note(err.message, true);
            this._finish();
        }
    }

    /** 中止当前回合捕获（尽力点击站点停止按钮） */
    abort() {
        if (!this._streaming) return;
        fetch('/api/webbridge/abort', { method: 'POST' }).catch(() => {});
    }

    /** 桥接事件消费 */
    _onEvent(event) {
        if (!event || !event.type) return;
        const handled = ['stream_text', 'task_progress', 'message_end', 'error'];
        if (!handled.includes(event.type)) return;   // status 等仅存状态，不入界面

        // 回合外接收（异步产物看护捕捉到的投递，如豆包视频"稍后另发一条"）：
        // 仅当前处于网页桥接模式时开一个被动气泡渲染，避免消息落错模式的
        // 快照里；回合外 error 无所属回合，忽略。
        // 注意判定用 !_wrap 而非 !_streaming：被动气泡期间 _streaming 保持
        // false，若按后者判定，message_end 会再开一个气泡而不是落进原气泡
        if (!this._wrap) {
            if (event.type === 'error') return;
            if (this.chat.isWebMode && !this.chat.isWebMode()) return;
            this._beginPassiveTurn();
        }

        if (event.type === 'stream_text') {
            this._textEl.textContent = event.text + ' ▍';
            this.chat.followBottom();
        } else if (event.type === 'task_progress') {
            // 生图/生视频等长任务：进度行单例原地更新（带旋转指示器）
            if (!this._taskEl && this._wrap) {
                this._taskEl = document.createElement('div');
                this._taskEl.className = 'webbridge-task';
                this._wrap.appendChild(this._taskEl);
            }
            if (this._taskEl) {
                this._taskEl.textContent = event.text || '生成中…';
                this.chat.followBottom();
            }
        } else if (event.type === 'message_end') {
            if (event.site) this._activeSite = event.site;
            this._textEl.textContent = event.text || '（未捕获到回复文本）';
            if (event.aborted) {
                this._note('⚠️ 已中止捕获（网页侧可能仍在生成）');
            }
            // 回复图片：与聊天消息图同结构（灯箱/拖拽落画布由既有链路接管；
            // F5 恢复后由 LlmChat._rebindRestoredMessages 重绑）
            (event.images || []).forEach((dataUrl) => {
                const img = document.createElement('img');
                img.className = 'llm-msg-image';
                img.src = dataUrl;
                img.alt = '网页回复图片';
                img.onclick = () => this.chat.lightbox.open(dataUrl);
                LlmImageDrag.attach(img, { prompt: event.text || '' });
                this._wrap.appendChild(img);
            });
            (event.videos || []).forEach((videoPath) => {
                // 面板内嵌可播放视频（原生 controls，无监听器故 F5 恢复后
                // 随 DOM 快照直接可用，无需重绑）；视频同时已自动落画布
                const video = document.createElement('video');
                video.className = 'webbridge-msg-video';
                video.src = '/' + String(videoPath).replace(/^\//, '');
                video.controls = true;
                video.playsInline = true;
                video.preload = 'metadata';
                this._wrap.appendChild(video);
                this._note(`🎬 视频已生成并落画布：${videoPath}`);
            });
            // 转存失败明示（不再静默丢图）：用户据此反馈校准适配器
            (event.assetErrors || []).forEach((msg) => {
                this._note('⚠️ ' + msg, true);
            });
            // 推荐追问胶囊：点击直接作为新消息驱动进站点网页（结构与聊天
            // 消息同存 DOM 快照，F5 后由 LlmChat._rebindRestoredMessages 重绑）
            if (Array.isArray(event.suggestions) && event.suggestions.length) {
                const row = document.createElement('div');
                row.className = 'webbridge-suggestion-row';
                event.suggestions.forEach((sug) => {
                    const chip = document.createElement('button');
                    chip.type = 'button';
                    chip.className = 'llm-gen-btn webbridge-suggestion';
                    chip.dataset.suggestion = sug;
                    chip.textContent = sug;
                    chip.title = '点击发送到网页继续对话';
                    chip.addEventListener('click', () => {
                        if (this._streaming) return;
                        this.send(sug, []);
                    });
                    row.appendChild(chip);
                });
                this._wrap.appendChild(row);
            }
            this._finish();
            this.chat.followBottom();
        } else if (event.type === 'error') {
            this._note('❌ ' + (event.message || '网页桥接错误'), true);
            this._finish();
        }
        // status 事件仅反映浏览器状态，回合内无需渲染（发送失败自有 error）
    }

    /**
     * 被动气泡：回合外接收异步投递时临时开启的渲染容器
     * （结构同流式回合，但 _streaming 保持 false；message_end 收尾）
     */
    _beginPassiveTurn() {
        const { wrap, textEl } = this.chat.createAssistantBubble(true);
        textEl.textContent = '⏳ 网页侧有新内容送达…';
        this._wrap = wrap;
        this._textEl = textEl;
        this._taskEl = null;
        this.chat.scrollToBottom();
    }

    /** 追加一条说明块（错误/中止/视频提示共用） */
    _note(text, isError) {
        if (!this._wrap) return;
        const el = document.createElement('div');
        el.className = 'llm-msg-text';
        el.textContent = text;
        if (isError) this._wrap.classList.add('error');
        this._wrap.appendChild(el);
    }

    /** 收尾：解除流式状态、移除进度行、恢复按钮文案 */
    _finish() {
        this._streaming = false;
        this._wrap?.classList.remove('thinking');
        this._taskEl?.remove();
        this._taskEl = null;
        if (this.chat.sendBtn) this.chat.updateToolbarForModel();
        this._wrap = null;
        this._textEl = null;
    }
}

// 暴露到全局作用域
window.LlmWebBridge = LlmWebBridge;
