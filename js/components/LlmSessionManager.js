/**
 * ==========================================================================
 * LlmSessionManager — LLM 窗口多会话管理（2026-11-20）
 * ==========================================================================
 * 作用：LLM/agent 模式支持同时存在多个对话（ChatGPT/ZCode 式）：
 *   - 头部「会话」按钮（插在系统提示词按钮左侧）→ 平铺下拉菜单：
 *     ＋新建会话 / 会话清单（当前高亮、悬停露出改名与删除）
 *   - 会话切换 = 换聊天快照键（LlmHistoryController._swapHistorySnapshot
 *     现成机制整体互换）+ agent 模式顺带切 pi 会话（switch_session RPC）
 *   - 会话标题自动取首条用户消息截断，可手动改名（改名优先）
 *
 * 键规则（与 LlmHistoryController._historyKey 对齐）：
 *   - 首个会话 id 固定 'legacy'，其快照键仍是历史单键 '_global'
 *     （存量聊天记录零迁移无缝收编）；其余会话键 `_session-<id>`
 *   - 网页桥接模式仍按站点分键，会话按钮在桥接模式隐藏（桥接的对话
 *     本体在站点网页里，本地面板只是回流镜像，多会话无意义）
 *
 * 存储分层：
 *   - 注册表（元数据，小）：localStorage lumen.llmSessions.v1
 *     [{id, title, customTitle, createdAt, updatedAt}]，updatedAt 降序
 *   - 快照本体（大）：IndexedDB（ChatHistoryStore，键随会话）
 *   - 当前指针：localStorage lumen.llmSession.current
 *   - pi 侧绑定：session-map.json v2（<存档>::<会话id> → 会话文件，
 *     见 piAgentManager；旧版单存档映射自动迁移为 ::legacy）
 * ==========================================================================
 */

class LlmSessionManager {
    /**
     * @param {LlmChat} chat - 宿主聊天组件（读 messagesEl/promptMode 显隐等）
     */
    constructor(chat) {
        this.chat = chat;
        this.sessions = LlmSessionManager.normalizeRegistry(
            localStorage.getItem(LlmSessionManager.REGISTRY_KEY));
        // 当前指针校验：指向的会话不存在时回落最新一个
        const stored = localStorage.getItem(LlmSessionManager.CURRENT_KEY);
        this.currentId = this.sessions.some((s) => s.id === stored)
            ? stored
            : (this.sessions[0] && this.sessions[0].id) || null;
        this._saveRegistry();

        this.menuEl = null;          // 下拉面板 DOM（懒建，复用）
        this._menuClose = null;      // 外点/Esc/滚动关闭解绑器
        this.buildButton();
        this.updateVisibility();
        document.getElementById('promptMode')?.addEventListener('change', () => this.updateVisibility());
    }

    // ==================== 静态纯函数（vm 可测） ====================

    static REGISTRY_KEY = 'lumen.llmSessions.v1';
    static CURRENT_KEY = 'lumen.llmSession.current';
    static MAX_SESSIONS = 20;
    /** 首个会话固定 id：快照键保持历史单键 '_global'，存量记录无缝收编 */
    static LEGACY_ID = 'legacy';
    static TITLE_MAX = 20;

    /**
     * 注册表归一：解析失败/结构损坏/空清单 → 种子初始会话（legacy）；
     * 条目字段防御式补齐、id 去重、按 updatedAt 降序（最近活跃在前）
     * @param {string|null} raw - localStorage 原始 JSON
     * @returns {Array<{id:string,title:string,customTitle:boolean,createdAt:number,updatedAt:number}>}
     */
    static normalizeRegistry(raw) {
        const now = Date.now();
        const seed = () => [{
            id: LlmSessionManager.LEGACY_ID,
            title: '',
            customTitle: false,
            createdAt: now,
            updatedAt: now
        }];
        let list = null;
        try {
            const parsed = JSON.parse(String(raw || ''));
            if (Array.isArray(parsed)) list = parsed;
        } catch { /* 损坏走种子 */ }
        if (!list || !list.length) return seed();
        const seen = new Set();
        const out = [];
        for (const item of list) {
            const id = item && typeof item.id === 'string' && item.id.trim();
            if (!id || seen.has(id)) continue;
            seen.add(id);
            out.push({
                id,
                title: typeof item.title === 'string' ? item.title : '',
                customTitle: item.customTitle === true,
                createdAt: Number(item.createdAt) || now,
                updatedAt: Number(item.updatedAt) || Number(item.createdAt) || now
            });
        }
        return out.length
            ? out.sort((a, b) => b.updatedAt - a.updatedAt)
            : seed();
    }

    /** 新会话 id：时间戳 + 随机尾（同毫秒创建多个也不撞） */
    static makeId() {
        return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    }

    /**
     * 自动标题：折叠空白后截断 TITLE_MAX 字，截断补省略号；空文本返回 ''
     * @param {string} text - 首条用户消息文本
     */
    static autoTitle(text) {
        const s = String(text || '').replace(/\s+/g, ' ').trim();
        if (!s) return '';
        return s.length > LlmSessionManager.TITLE_MAX
            ? s.slice(0, LlmSessionManager.TITLE_MAX) + '…'
            : s;
    }

    /**
     * 相对时间标签（ZCode 会话清单同款）：刚刚 / N分 / N小时 / N天 /
     * N个月 / N年——按 updatedAt（最近活跃）算，未来时间（本机时钟偏差）
     * 归入刚刚；非法值返回空串
     * @param {number} ts - 毫秒时间戳
     */
    static relativeTime(ts) {
        const t = Number(ts);
        if (!Number.isFinite(t) || t <= 0) return '';
        const diff = Date.now() - t;
        if (diff < 60_000) return '刚刚';
        const minutes = Math.floor(diff / 60_000);
        if (minutes < 60) return `${minutes}分`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}小时`;
        const days = Math.floor(hours / 24);
        if (days < 30) return `${days}天`;
        const months = Math.floor(days / 30);
        if (months < 12) return `${months}个月`;
        return `${Math.floor(days / 365)}年`;
    }

    /**
     * 会话 id → 聊天快照键（LlmHistoryController._historyKey 消费）：
     * legacy 保持历史单键 '_global'（存量记录零迁移），其余 `_session-<id>`
     */
    static keyFor(id) {
        return id === LlmSessionManager.LEGACY_ID ? '_global' : `_session-${id}`;
    }

    // ==================== 注册表操作 ====================

    /** 当前会话对象（可能为 null：注册表被外部清空的极端情况） */
    get current() {
        return this.sessions.find((s) => s.id === this.currentId) || null;
    }

    _saveRegistry() {
        localStorage.setItem(LlmSessionManager.REGISTRY_KEY, JSON.stringify(this.sessions));
    }

    _setCurrent(id) {
        this.currentId = id;
        localStorage.setItem(LlmSessionManager.CURRENT_KEY, id);
    }

    /**
     * 按快照键推进会话活跃时间（真实聊天才前进——切过去看看不算，
     * 2026-11-20 用户反馈）：由 LlmHistoryController 在「消息区真实变更
     * 引发的落盘」时调用；键是 web-*（桥接）或找不到会话时静默跳过。
     * 排序随 updatedAt 降序重排（清单=最近聊过的在前）
     */
    touchByKey(key) {
        const sid = key === '_global' ? LlmSessionManager.LEGACY_ID
            : (typeof key === 'string' && key.startsWith('_session-'))
                ? key.slice('_session-'.length) : null;
        if (!sid) return;
        const s = this.sessions.find((x) => x.id === sid);
        if (!s) return;
        s.updatedAt = Date.now();
        this.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
        this._saveRegistry();
    }

    // ==================== 会话操作（菜单回调入口） ====================

    /**
     * 切换会话：更新指针 → 快照整体互换（旧键落盘/新键回填重绑，
     * LlmHistoryController 现成机制）→ agent 模式顺带切 pi 会话。
     * 有流式任务在跑时拒绝（切走后流式块会写到错误会话的快照里）
     */
    async switchTo(id) {
        if (!id || id === this.currentId || !this.sessions.some((s) => s.id === id)) return;
        if (this.chat.isSending || this.chat.piAgent?.isStreaming?.() || this.chat.webBridge?.isStreaming?.()) {
            window.socket?.showNotification?.('正在回复中，等本轮结束再切换会话', 3000);
            return;
        }
        this._setCurrent(id);
        await this.chat._swapHistorySnapshot();
        this._notifyPiSwitch(id);
        this.updateVisibility();
    }

    /** agent 模式把 pi 切到当前会话（尽力而为：失败不阻塞界面切换，
     *  下一条消息的 prompt 会带 sessionId 让后端对齐） */
    _notifyPiSwitch(sessionId) {
        if (this.chat.isWebMode()) return;
        fetch('/api/pi/switch-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                archive: window.saveManager?.currentSave || null,
                sessionId
            })
        }).catch(() => { /* pi 未运行：下次 prompt 对齐 */ });
    }

    /**
     * 新建会话：软上限 MAX_SESSIONS，超限提示先删（快照是整段 DOM
     * 序列化，IndexedDB 虽无压力但清单过长下拉难用）→ 切入新会话
     */
    async createSession() {
        if (this.sessions.length >= LlmSessionManager.MAX_SESSIONS) {
            window.socket?.showNotification?.(
                `会话已达上限（${LlmSessionManager.MAX_SESSIONS} 个），请先删除不用的会话`, 4000);
            return;
        }
        if (this.chat.isSending || this.chat.piAgent?.isStreaming?.() || this.chat.webBridge?.isStreaming?.()) {
            window.socket?.showNotification?.('正在回复中，等本轮结束再新建会话', 3000);
            return;
        }
        const now = Date.now();
        const session = {
            id: LlmSessionManager.makeId(),
            title: '',
            customTitle: false,
            createdAt: now,
            updatedAt: now
        };
        this.sessions.unshift(session);
        this._saveRegistry();
        this._setCurrent(session.id);
        await this.chat._swapHistorySnapshot();   // 旧会话落盘，新会话空区
        this._notifyPiSwitch(session.id);
        this.updateVisibility();
    }

    /** 改名（空串回退自动标题语义：customTitle=false 且清空标题） */
    renameSession(id, title) {
        const s = this.sessions.find((x) => x.id === id);
        if (!s) return;
        const trimmed = String(title || '').replace(/\s+/g, ' ').trim();
        s.customTitle = !!trimmed;
        s.title = trimmed;
        this._saveRegistry();
    }

    /** 清空对话联动：当前会话被推倒，自动标题作废（陈旧标题配空对话易误导） */
    resetCurrentTitle() {
        const s = this.current;
        if (!s || s.customTitle) return;
        s.title = '';
        this._saveRegistry();
    }

    /**
     * 删除会话：出注册表 + 删快照 + pi 侧删对应会话文件（跨存档的
     * <存档>::<id> 绑定一并清）；删的是当前会话时切回清单首个（无则
     * 种子新会话）。由调用方先 confirm
     */
    async deleteSession(id) {
        if (this.chat.isSending || this.chat.piAgent?.isStreaming?.() || this.chat.webBridge?.isStreaming?.()) {
            window.socket?.showNotification?.('正在回复中，等本轮结束再删除会话', 3000);
            return;
        }
        const key = LlmSessionManager.keyFor(id);
        const isCurrent = id === this.currentId;
        this.sessions = this.sessions.filter((s) => s.id !== id);
        if (isCurrent) {
            // 删的是当前会话：先切走再删快照。顺序是硬约束——切换的
            // _swapHistorySnapshot 会先把当前 DOM 落盘到旧键，若先删快照
            // 这一步会把刚删的写回去（孤儿快照复活）
            let next = this.sessions[0];
            if (!next) {
                // 清单删空：种子一个新会话顶上
                const now = Date.now();
                next = {
                    id: LlmSessionManager.makeId(), title: '', customTitle: false,
                    createdAt: now, updatedAt: now
                };
                this.sessions = [next];
            }
            this._setCurrent(next.id);
            await this.chat._swapHistorySnapshot();
            this._notifyPiSwitch(next.id);
            this.chat._historyCtl._deleteHistorySnapshot(key);
        } else {
            // 非当前会话：直接删快照（当前 DOM 属于当前会话，互不沾染）
            this.chat._historyCtl._deleteHistorySnapshot(key);
        }
        this._saveRegistry();
        fetch('/api/pi/delete-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: id })
        }).catch(() => { /* 后端不可达：下次启动映射仍在，删除幂等可重试 */ });
    }

    // ==================== 自动标题 ====================

    /**
     * 快照保存时顺带补题：未自定义且无标题 → 取首条用户消息截断。
     * key 对位守卫：切换/新建会话是「先改指针、后换 DOM」——swap 把旧
     * 快照落盘那一刻指针已指向新会话而 DOM 还是旧对话内容，不按键对位
     * 会把旧对话首条消息错题到新会话头上（2026-11-20 实测踩中：新会话
     * 被题成旧对话标题「晚上好」）；键不属于当前会话的落盘直接跳过
     */
    maybeAutoTitle(key) {
        const s = this.current;
        if (!s || s.customTitle || s.title) return;
        if (key != null && key !== LlmSessionManager.keyFor(s.id)) return;
        const el = this.chat.messagesEl?.querySelector('.llm-msg.user .llm-msg-text');
        const title = LlmSessionManager.autoTitle(el?.textContent || '');
        if (title) {
            s.title = title;
            this._saveRegistry();
        }
    }

    // ==================== UI：头部按钮 + 平铺下拉菜单 ====================

    /** 头部会话按钮：插在清空按钮前——本类先于 LlmSystemPrompt 构建，
     *  系统提示词按钮随后插到清空按钮前，最终顺序
     *  「会话 - 系统提示词 - 清空对话 - 收起」（app.js 实例化顺序保证） */
    buildButton() {
        const header = document.querySelector('.prompt-panel-header');
        const anchor = document.getElementById('llmClearBtn') ||
            document.getElementById('closePrompt');
        if (!header || !anchor) return;
        this.btn = document.createElement('button');
        this.btn.className = 'llm-header-icon-btn llm-session-btn';
        this.btn.type = 'button';
        this.btn.title = '会话：新建 / 切换对话（多会话并存，互不干扰）';
        this.btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="12" y1="5" x2="12" y2="11"/></svg>';
        this.btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.isOpen ? this.closeMenu() : this.openMenu();
        });
        anchor.parentElement.insertBefore(this.btn, anchor);
    }

    get isOpen() {
        return !!(this.menuEl && this.menuEl.classList.contains('is-open'));
    }

    /** 平铺下拉菜单：＋新建会话 + 会话清单（当前高亮/悬停改名删除/内联改名） */
    openMenu() {
        if (!this.btn) return;
        if (!this.menuEl) {
            this.menuEl = document.createElement('div');
            this.menuEl.className = 'llm-session-menu';
            document.body.appendChild(this.menuEl);
        }
        this.menuEl.replaceChildren();   // 全量重建，防旧闭包残留可点
        // ---- 新建会话（第一项）----
        const newBtn = document.createElement('button');
        newBtn.type = 'button';
        newBtn.className = 'llm-session-new';
        newBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>新建会话</span>';
        newBtn.addEventListener('click', () => {
            this.closeMenu();
            this.createSession();
        });
        this.menuEl.appendChild(newBtn);
        // ---- 会话清单 ----
        for (const s of this.sessions) {
            this.menuEl.appendChild(this._buildSessionItem(s));
        }
        this.menuEl.classList.add('is-open');
        // 定位在按钮正下方，右对齐按钮（面板贴右缘时向左展开不出视口）。
        // is-open 已令 display:block 可测量；只动 visibility，**不能写内联
        // display**——否则 closeMenu 移除类后内联块级仍压着 display:none，
        // 菜单永远关不掉（2026-11-20 实测踩中）
        const rect = this.btn.getBoundingClientRect();
        this.menuEl.style.visibility = 'hidden';
        const mw = this.menuEl.offsetWidth, mh = this.menuEl.offsetHeight;
        let x = rect.right - mw;
        x = Math.max(8, Math.min(x, window.innerWidth - mw - 8));
        let y = rect.bottom + 6;
        if (y + mh > window.innerHeight - 8) y = Math.max(8, rect.top - mh - 6);
        this.menuEl.style.left = `${x}px`;
        this.menuEl.style.top = `${y}px`;
        this.menuEl.style.visibility = '';
        // 关闭器（外点捕获/按钮再点/Esc/滚动缩放）
        const close = () => this.closeMenu();
        this._menuClose = () => {
            document.removeEventListener('click', this._outside, true);
            document.removeEventListener('keydown', this._keyClose);
            window.removeEventListener('scroll', this._scrollClose, true);
            window.removeEventListener('resize', this._scrollClose);
            this._outside = this._keyClose = this._scrollClose = null;
            this._menuClose = null;
        };
        this._outside = (e) => {
            if (!this.menuEl.contains(e.target) && e.target !== this.btn &&
                !this.btn.contains(e.target)) this.closeMenu();
        };
        this._keyClose = (e) => { if (e.key === 'Escape') this.closeMenu(); };
        this._scrollClose = close;
        document.addEventListener('click', this._outside, true);
        document.addEventListener('keydown', this._keyClose);
        window.addEventListener('scroll', this._scrollClose, true);
        window.addEventListener('resize', this._scrollClose);
    }

    closeMenu() {
        if (!this.isOpen) return;
        this.menuEl.classList.remove('is-open');
        if (this._menuClose) this._menuClose();
    }

    /** 单个会话行：标题（自动标题带「自动」角标）+ 悬停操作（改名/删除） */
    _buildSessionItem(s) {
        const item = document.createElement('div');
        item.className = 'llm-session-item' + (s.id === this.currentId ? ' active' : '');
        const titleEl = document.createElement('span');
        titleEl.className = 'llm-session-title';
        titleEl.textContent = s.title || '新对话';
        titleEl.title = s.customTitle
            ? `${s.title}（用户命名）`
            : `${s.title || '新对话'}（自动命名，悬停改名后不再自动）`;
        item.appendChild(titleEl);
        // 相对时间（右对齐，悬停让位给操作钮；title 带完整时间）
        const timeEl = document.createElement('span');
        timeEl.className = 'llm-session-time';
        timeEl.textContent = LlmSessionManager.relativeTime(s.updatedAt);
        const full = new Date(s.updatedAt);
        timeEl.title = `最近活跃：${full.toLocaleDateString()} ${full.toLocaleTimeString()}`;
        item.appendChild(timeEl);
        // 悬停操作钮（改名/删除），CSS 控制仅 hover 或激活时可见
        const ops = document.createElement('span');
        ops.className = 'llm-session-ops';
        const renameBtn = document.createElement('button');
        renameBtn.type = 'button';
        renameBtn.className = 'llm-session-op';
        renameBtn.title = '重命名';
        renameBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
        renameBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._beginInlineRename(item, titleEl, s);
        });
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'llm-session-op danger';
        delBtn.title = '删除会话（聊天记录与 agent 上下文一并删除，不可恢复）';
        delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
        delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm(`删除会话「${s.title || '新对话'}」？\n聊天记录与对应 agent 上下文将一并删除，不可恢复。`)) return;
            this.closeMenu();
            await this.deleteSession(s.id);
        });
        ops.appendChild(renameBtn);
        ops.appendChild(delBtn);
        item.appendChild(ops);
        // 点击行体（非操作钮）= 切换
        item.addEventListener('click', (e) => {
            if (e.target.closest('.llm-session-op') || item.querySelector('input')) return;
            this.closeMenu();
            this.switchTo(s.id);
        });
        return item;
    }

    /** 内联改名：标题 span 换 input，Enter/失焦提交、Esc 还原 */
    _beginInlineRename(item, titleEl, s) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'llm-session-rename';
        input.value = s.title || '';
        input.maxLength = 40;
        input.placeholder = '会话名称（留空恢复自动命名）';
        titleEl.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const commit = () => {
            if (done) return;
            done = true;
            this.renameSession(s.id, input.value);
            this._refreshItemTitle(item, s);
        };
        const cancel = () => {
            if (done) return;
            done = true;
            this._refreshItemTitle(item, s);
        };
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') cancel();
        });
        input.addEventListener('blur', commit);
    }

    /** 改名提交/取消后把 input 换回标题 span */
    _refreshItemTitle(item, s) {
        const input = item.querySelector('.llm-session-rename');
        if (!input) return;
        const titleEl = document.createElement('span');
        titleEl.className = 'llm-session-title';
        titleEl.textContent = s.title || '新对话';
        input.replaceWith(titleEl);
    }

    // ==================== 显隐 ====================

    /** 仅 LLM 模式且非网页桥接显示（Comfy 无对话概念；桥接会话在站点侧） */
    updateVisibility() {
        if (!this.btn) return;
        const mode = document.getElementById('promptMode')?.value;
        const show = mode === 'llm' && !this.chat.isWebMode();
        this.btn.style.display = show ? '' : 'none';
        if (!show) this.closeMenu();
    }
}

// 将类暴露到全局作用域（LlmChat 构造函数中实例化）
window.LlmSessionManager = LlmSessionManager;
