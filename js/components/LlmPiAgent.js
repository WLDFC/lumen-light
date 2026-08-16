/**
 * ==========================================================================
 * LumenLight pi 智能体控制器（LlmPiAgent）
 * ==========================================================================
 * 作用：LLM 窗口选中「pi 编码智能体」时的对话控制器：
 *   - send()：消息经后端 /api/pi/prompt 喂给 pi RPC 子进程
 *     （后端自动完成模型切换与"存档 → 会话"绑定）；
 *   - pi 的流式事件由后端经 WebSocket 广播（piEvent 页面事件），
 *     本类消费后渲染流式气泡（文本增量 / 工具调用标记）；
 *   - 流式中点击发送 = 中止推理。
 *
 * pi 的底层模型在 设置 → 通用 → 「pi 使用的模型」中选择
 * （localStorage: piModelKey），权限分级同处设置（同步到后端生效）。
 * ==========================================================================
 */

class LlmPiAgent {
    constructor(chat) {
        this.chat = chat;
        this._streaming = false;
        this._bubbleEl = null;   // 流式气泡的文本元素
        this._text = '';         // 已累计的输出文本
        window.addEventListener('piEvent', (e) => this._onEvent(e.detail));
    }

    isStreaming() { return this._streaming; }

    /** 通用设置里选择的 pi 底层模型（'厂商||模型ID' 复合键） */
    getUnderlyingModel() {
        const key = localStorage.getItem('piModelKey');
        if (!key) return null;
        try {
            const parsed = LumenLight.parseModelKey(key);
            return parsed.provider && parsed.id
                ? { provider: parsed.provider, modelId: parsed.id }
                : null;
        } catch {
            return null;
        }
    }

    /** 发送用户消息到 pi（流式结果经 piEvent 异步渲染） */
    async send(text, images) {
        const chat = this.chat;
        const model = this.getUnderlyingModel();
        if (!model) {
            chat.appendMessage('assistant', '请先在 设置 → 通用 → 「pi 使用的模型」中选择模型');
            return;
        }

        chat.inputEl.value = '';
        chat.attachments.clear();
        chat.appendMessage('user', text || '（图片）', images);

        this._streaming = true;
        this._text = '';
        const bubble = chat.appendMessage('assistant', '▍');
        bubble.parentElement.classList.add('thinking');
        this._bubbleEl = bubble;
        if (chat.sendBtn) chat.sendBtn.textContent = '■ 停止';
        chat.scrollToBottom();

        // 附件（dataURL 字符串）→ pi 图片格式
        const imagesPayload = (images || [])
            .filter((src) => typeof src === 'string' && src.startsWith('data:'))
            .map((src) => {
                const [head, data] = src.split(',');
                const mimeType = (head.match(/data:([^;]+)/) || [])[1] || 'image/png';
                return { type: 'image', data, mimeType };
            });

        try {
            const resp = await fetch('/api/pi/prompt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: text,
                    images: imagesPayload,
                    archive: window.saveManager?.currentSave || null,
                    provider: model.provider,
                    modelId: model.modelId
                })
            });
            const result = await resp.json().catch(() => null);
            if (!resp.ok || !result || result.status !== 'ok') {
                throw new Error((result && result.message) || `pi 调用失败（HTTP ${resp.status}）`);
            }
            // 已接受；流式内容经 piEvent 更新气泡，agent_end 收尾。
            // 若 pi 仍在执行上一任务（queued），气泡先显示排队提示
            if (result.queued) {
                this._bubbleEl.textContent = '⏳ pi 正在执行上一任务，本条已加入队列…';
            }
        } catch (err) {
            // 注意：先取气泡引用再 _finish()（_finish 会置空 _bubbleEl），
            // 否则错误文字写不上、气泡定格在光标状态且真实原因被吞掉
            const el = this._bubbleEl;
            this._finish();
            if (el) {
                el.textContent = '❌ ' + err.message;
                el.parentElement.classList.add('error');
            }
            chat.scrollToBottom();
        }
    }

    /** 中止当前推理 */
    abort() {
        if (!this._streaming) return;
        fetch('/api/pi/abort', { method: 'POST' }).catch(() => {});
    }

    /** pi 事件消费：渲染流式文本 / 工具调用标记 / 收尾 */
    _onEvent(event) {
        if (!this._streaming || !this._bubbleEl || !event || !event.type) return;

        if (event.type === 'message_update') {
            const ev = event.assistantMessageEvent || {};
            if (ev.type === 'text_delta') {
                this._text += ev.delta || '';
                this._bubbleEl.textContent = this._text + ' ▍';
                this.chat.scrollToBottom();
            } else if (ev.type === 'text_end' && ev.content !== undefined) {
                this._text = ev.content;
                this._bubbleEl.textContent = this._text;
            }
        } else if (event.type === 'tool_execution_start') {
            this._text += `\n🔧 ${event.toolName || '工具'}…`;
            this._bubbleEl.textContent = this._text + ' ▍';
            this.chat.scrollToBottom();
        } else if (event.type === 'message_end' && event.message) {
            const finalText = (event.message.content || [])
                .filter((p) => p.type === 'text')
                .map((p) => p.text)
                .join('\n');
            if (finalText) {
                this._text = finalText;
                this._bubbleEl.textContent = this._text;
            }
        } else if (event.type === 'agent_end') {
            if (this._text) this._bubbleEl.textContent = this._text;
            this._finish();
            this.chat.scrollToBottom();
        } else if (event.type === 'pi_process_exit') {
            // pi 子进程退出（后端广播）：流式中止并明示原因
            if (this._streaming) {
                const el = this._bubbleEl;
                this._finish();
                if (el) {
                    el.textContent = (this._text ? this._text + '\n' : '') +
                        '⚠️ pi 进程已退出（code ' + (event.code ?? '?') + '），下次发送将自动重启';
                    el.parentElement.classList.remove('thinking');
                    el.parentElement.classList.add('error');
                }
                this.chat.scrollToBottom();
            }
        }
    }

    /** 收尾：解除流式状态、恢复发送按钮 */
    _finish() {
        this._streaming = false;
        this._bubbleEl?.parentElement.classList.remove('thinking');
        if (this.chat.sendBtn) this.chat.sendBtn.textContent = '发送';
        this._bubbleEl = null;
    }
}

// 暴露到全局作用域
window.LlmPiAgent = LlmPiAgent;
