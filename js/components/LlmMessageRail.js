/**
 * ==========================================================================
 * LumenLight LLM 消息刻度导航（LlmMessageRail）
 * ==========================================================================
 * 作用：LLM 对话窗口左侧的悬浮定位索引——每条用户消息一个刻度，
 *       长会话快速转跳历史提问：
 *   - 悬停刻度：tooltip 预览该条消息文字；
 *   - 点击刻度：平滑跳转到那轮提问；
 *   - 滚动同步：当前视口所在轮次的刻度加亮加宽（会话走到哪一眼可见）；
 *   - 自动跟随：MutationObserver 监听消息区直接子节点，发消息/清屏/
 *     F5 恢复记录均自动重建刻度，无需 LlmChat 各处手动通知。
 *
 * 显示条件：用户消息 ≥ 2 条（更少的会话没有导航价值）。
 * 定位：贴消息区左缘的悬浮细条，覆盖在消息区 18px 内边距上，
 *       不压缩气泡宽度（AI 消息起点 18px，刻度条只占 x≈4-16px）。
 * 坐标系：统一用 getBoundingClientRect 相对消息区计算（不依赖
 *         offsetParent——消息区滚动会干扰 offsetTop 的语义）。
 * 对应组件：js/components/LlmChat.js（消息区本体）
 * ==========================================================================
 */

class LlmMessageRail {
    /** 用户消息不足此数不显示导航 */
    static MIN_MESSAGES = 2;
    /** 刻度基准间距/厚度（消息很多时自动压缩间距，见 _layout） */
    static GAP = 8;
    static TICK_H = 3;
    /** 跳转后目标消息距视口顶部的落点（px） */
    static JUMP_INSET = 8;

    /**
     * @param {LlmChat} chat - LLM 聊天组件实例（取其消息区挂载）
     */
    constructor(chat) {
        this.chat = chat;
        this.messagesEl = chat.messagesEl;
        this.wrap = this.messagesEl.parentElement;   // .llm-chat-messages-wrap（定位基准）
        if (!this.wrap) return;

        // 悬浮刻度条 + 预览 tooltip（都挂在 wrap 上，绝对定位）
        this.railEl = document.createElement('div');
        this.railEl.className = 'llm-msg-rail';
        this.tipEl = document.createElement('div');
        this.tipEl.className = 'llm-msg-rail-tip';
        this.wrap.append(this.railEl, this.tipEl);

        this.userMsgs = [];       // 与刻度一一对应的用户消息元素
        this.activeIdx = -1;

        // 消息区直接子节点变化（发消息/清屏/恢复记录）→ 合并重建刻度
        this._mo = new MutationObserver(() => this._scheduleRebuild());
        this._mo.observe(this.messagesEl, { childList: true });

        // 滚动同步高亮（独立监听，与 LlmChat 的跟随/回底逻辑互不干扰）。
        // scrollend 兜底：节流环境下平滑滚动的末帧事件可能被吞，
        // 滚动完全停止时 scrollend 必触发一次，保证激活态最终一致
        this.messagesEl.addEventListener('scroll', () => this._syncActive(), { passive: true });
        this.messagesEl.addEventListener('scrollend', () => this._syncActive(), { passive: true });
        // 模式切回 LLM 时消息区尺寸才真实存在，重测量一次
        window.addEventListener('llmModeEnter', () => this._scheduleRebuild());

        this._rebuild();
    }

    /**
     * DOM 抖动合并：一次发送会触发多次 mutation，100ms 窗口内只重建一次。
     * 不用 requestAnimationFrame——后台/节流标签页里 rAF 可能长期不触发，
     * 刻度会停滞在旧状态；setTimeout 不依赖渲染帧，任何环境保证最终一致
     */
    _scheduleRebuild() {
        if (this._rebuildPending) return;
        this._rebuildPending = true;
        setTimeout(() => {
            this._rebuildPending = false;
            this._rebuild();
        }, 100);
    }

    /** 扫描用户消息并全量重建刻度（消息量级下成本可忽略） */
    _rebuild() {
        this.userMsgs = [...this.messagesEl.querySelectorAll('.llm-msg.user')];
        const n = this.userMsgs.length;
        const show = n >= LlmMessageRail.MIN_MESSAGES;
        this.railEl.classList.toggle('show', show);
        this.tipEl.classList.remove('show');
        if (!show) {
            this.railEl.replaceChildren();
            this.activeIdx = -1;
            return;
        }
        const frag = document.createDocumentFragment();
        this.userMsgs.forEach((msg, i) => {
            const tick = document.createElement('div');
            tick.className = 'llm-msg-rail-tick';
            tick.addEventListener('click', () => this._jumpTo(i));
            tick.addEventListener('mouseenter', () => this._showTip(i));
            tick.addEventListener('mouseleave', () => this.tipEl.classList.remove('show'));
            frag.appendChild(tick);
        });
        this.railEl.replaceChildren(frag);
        this._layout();
        this._syncActive();
    }

    /** 消息很多时压缩刻度间距，整列高度不超过消息区高度的 70% */
    _layout() {
        const n = this.userMsgs.length;
        if (n < 2) return;
        const maxH = this.messagesEl.clientHeight * 0.7;
        if (maxH <= 0) return;   // 消息区不可见（模式未切入）：保持基准间距
        const need = (n - 1) * LlmMessageRail.GAP + n * LlmMessageRail.TICK_H;
        const gap = need > maxH
            ? Math.max(3, Math.floor((maxH - n * LlmMessageRail.TICK_H) / (n - 1)))
            : LlmMessageRail.GAP;
        this.railEl.style.gap = gap + 'px';
    }

    /** 滚动同步：视口上部 35% 处所在的轮次即当前位置（消息按序排列，可提前退出） */
    _syncActive() {
        if (this.userMsgs.length < LlmMessageRail.MIN_MESSAGES) return;
        const probe = this.messagesEl.getBoundingClientRect().top
            + this.messagesEl.clientHeight * 0.35;
        let idx = 0;
        for (let i = 0; i < this.userMsgs.length; i++) {
            if (this.userMsgs[i].getBoundingClientRect().top <= probe) idx = i;
            else break;
        }
        if (idx === this.activeIdx) return;
        this.activeIdx = idx;
        [...this.railEl.children].forEach((t, i) => t.classList.toggle('active', i === idx));
    }

    /** 跳转到第 i 条用户消息：平滑滚动、对齐到视口上部落点 */
    _jumpTo(i) {
        const msg = this.userMsgs[i];
        if (!msg) return;
        const rel = msg.getBoundingClientRect().top - this.messagesEl.getBoundingClientRect().top;
        this.messagesEl.scrollTo({
            top: Math.max(0, this.messagesEl.scrollTop + rel - LlmMessageRail.JUMP_INSET),
            behavior: 'smooth'
        });
    }

    /** 悬停预览：tooltip 显示该条消息文字（超长截断） */
    _showTip(i) {
        const msg = this.userMsgs[i];
        const textEl = msg.querySelector('.llm-msg-text');
        const text = (textEl ? textEl.textContent : '').trim() || '（图片）';
        this.tipEl.textContent = text.length > 120 ? text.slice(0, 120) + '…' : text;
        // 垂直对齐刻度中心（tip 用 translateY(-50%) 居中于该点）
        const tick = this.railEl.children[i];
        const wrapBox = this.wrap.getBoundingClientRect();
        const tickBox = tick.getBoundingClientRect();
        this.tipEl.style.top = (tickBox.top - wrapBox.top + tickBox.height / 2) + 'px';
        this.tipEl.classList.add('show');
    }
}
