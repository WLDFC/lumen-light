/**
 * ==========================================================================
 * LlmHistoryController — 聊天记录持久化编排（从 LlmChat 拆出）
 * ==========================================================================
 * 职责：消息区 DOM 快照的存取编排——按"存档+模式"键存 IndexedDB（底层
 *       存储在 ChatHistoryStore），F5 后恢复回填并重绑交互；快照经
 *       MutationObserver 捕获（childList/subtree/characterData 全量），
 *       防抖 800ms 合并 pi 流式期间的高频文本更新。
 * 键规则：LLM/agent 模式跨存档统一一份（'_global'）；网页桥接模式按站点
 *        分键（web-站点），切模型时由 _swapHistorySnapshot 整体互换，互不串。
 *
 * 协作约定（与 LlmPiAgent / LlmWebBridge 同款模式）：
 *   - 构造函数持有 chat 引用，方法名与拆分前完全一致；
 *     LlmChat 上保留同名薄代理方法，外部调用点零改动。
 *   - 归属本控制器的内部状态：_historyStore / _historySaveTimer /
 *     _historyRestored / _historyObserver / _currentKey。
 *   - 仍归属 LlmChat 的共享状态经 this.chat 访问：消息区 DOM（messagesEl /
 *     emptyTipEl，恢复时会重新引用 emptyTipEl）、生成参数表 _genParams、
 *     pi 统计 _piUsage，以及气泡重绑要用到的各功能组件与方法。
 * ==========================================================================
 */

class LlmHistoryController {
    /**
     * @param {LlmChat} chat - 宿主聊天组件（只存引用，构造期不读取其状态）
     */
    constructor(chat) {
        this.chat = chat;
        this._historyStore = new ChatHistoryStore();
        this._historySaveTimer = null; // 快照防抖定时器
        this._historyRestored = false; // 恢复完成前不落盘（避免恢复中的 DOM 覆盖快照）
        this._historyObserver = null;  // 消息区变更监听（恢复完成后挂载）
        this._currentKey = null;       // 当前已恢复/已落盘的持久化键
    }

    /**
     * 当前持久化键：跨存档统一一份（2026-10-05 用户决策：聊天记录不随
     * 画布存档分家——按存档分键时，就地切换存档后观察者仍会把当前画面
     * 写进新存档的键，串档覆写会静默销毁原存档记录；统一键后此问题不存在）。
     * 网页桥接模式仍按桥接站点细分（模式维度，与存档无关）
     */
    _historyKey() {
        if (this.chat.isWebMode()) {
            return `web-${this.chat.webBridge?.getActiveSite() || 'doubao'}`;
        }
        return '_global';
    }

    /**
     * 模式切换（网页桥接 ↔ LLM/agent，或桥接站点变更）时的历史互换：
     * 旧键快照落盘 → 清空消息区 → 读新键快照回填重绑。
     * 恢复期间置 _historyRestored=false 挂起持久化，避免互换过程的
     * DOM 变更被 MutationObserver 写回旧键
     */
    async _swapHistorySnapshot() {
        if (!this._historyRestored || !this._historyObserver) return;
        const newKey = this._historyKey();
        if (newKey === this._currentKey) return;
        this._historyRestored = false;
        try {
            this._saveHistorySnapshot(this._currentKey);
            Array.from(this.chat.messagesEl.children).forEach((el) => {
                if (el !== this.chat.emptyTipEl) el.remove();
            });
            this.chat._genParams = new Map();
            this._currentKey = newKey;
            const saved = await this._historyStore.get(newKey);
            if (saved && saved.html) {
                this.chat.messagesEl.innerHTML = saved.html;
                // innerHTML 重建后原空状态提示节点已被替换，重新引用
                this.chat.emptyTipEl = document.getElementById('llmChatEmpty');
                this.chat._genParams = new Map(Object.entries(saved.gen || {}));
                if (saved.usage) this.chat.updatePiUsage(saved.usage.usage, saved.usage.modelId);
                this._rebindRestoredMessages();
                this.chat.scrollToBottom();
            }
            if (this.chat.emptyTipEl) {
                this.chat.emptyTipEl.style.display =
                    this.chat.messagesEl.querySelector('.llm-msg, .llm-gen-block') ? 'none' : '';
            }
        } catch (err) {
            console.warn('切换模式恢复聊天记录失败:', err);
        } finally {
            this._historyRestored = true;
        }
    }

    /** 变更防抖保存（恢复完成前忽略，避免恢复中的 DOM 覆盖快照） */
    _scheduleHistorySave() {
        if (!this._historyRestored) return;
        if (this._historySaveTimer) clearTimeout(this._historySaveTimer);
        this._historySaveTimer = setTimeout(() => {
            this._historySaveTimer = null;
            this._saveHistorySnapshot();
        }, 800);
    }

    /** 序列化消息区写入 IndexedDB（瞬态元素——pi 执行指示器、网页桥接
     *  任务进度行——不入快照） */
    _saveHistorySnapshot(key = this._historyKey()) {
        const clone = this.chat.messagesEl.cloneNode(true);
        clone.querySelectorAll('.pi-running, .webbridge-task').forEach((el) => el.remove());
        this._historyStore.put(key, clone.innerHTML,
            Object.fromEntries(this.chat._genParams), this.chat._piUsage || null);
    }

    /** 卸载前把防抖窗口内的最后一次变更尽力落盘 */
    _flushHistory() {
        if (!this._historyRestored) return;
        if (this._historySaveTimer) {
            clearTimeout(this._historySaveTimer);
            this._historySaveTimer = null;
        }
        this._saveHistorySnapshot();
    }

    /**
     * 启动恢复：等实时保存恢复完成（存档键就绪，见 RealtimeSaveManager.restore）
     * 后读快照回填消息区并重绑交互；恢复完成后才开始持久化。
     * 实时保存 5s 内未完成时按当前键兜底恢复（极端情况：后端未运行）
     */
    async _restoreHistory() {
        try {
            if (!window.__realtimeSaveRestored) {
                await new Promise((resolve) => {
                    const onRestored = () => { cleanup(); resolve(); };
                    const timer = setTimeout(() => { cleanup(); resolve(); }, 5000);
                    const cleanup = () => {
                        clearTimeout(timer);
                        window.removeEventListener('realtimeSaveRestored', onRestored);
                    };
                    window.addEventListener('realtimeSaveRestored', onRestored, { once: true });
                });
            }
            const key = this._historyKey();
            this._currentKey = key;
            const saved = await this._historyStore.get(key);
            if (saved && saved.html) {
                this.chat.messagesEl.innerHTML = saved.html;
                // innerHTML 重建后原空状态提示节点已被替换，重新引用
                this.chat.emptyTipEl = document.getElementById('llmChatEmpty');
                if (this.chat.emptyTipEl) {
                    this.chat.emptyTipEl.style.display =
                        this.chat.messagesEl.querySelector('.llm-msg, .llm-gen-block') ? 'none' : '';
                }
                this.chat._genParams = new Map(Object.entries(saved.gen || {}));
                // 恢复面板头部的 pi 调用统计灰字（随快照按存档持久化，见 updatePiUsage）
                if (saved.usage) this.chat.updatePiUsage(saved.usage.usage, saved.usage.modelId);
                this._rebindRestoredMessages();
                this.chat.scrollToBottom();
            }
        } catch (err) {
            console.warn('恢复聊天记录失败:', err);
        } finally {
            this._historyRestored = true;
            this._startHistoryObserver();
        }
    }

    /** 挂消息区变更监听（此后一切增删改都会触发防抖落盘） */
    _startHistoryObserver() {
        if (this._historyObserver) return;
        this._historyObserver = new MutationObserver(() => this._scheduleHistorySave());
        this._historyObserver.observe(this.chat.messagesEl, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    /**
     * 为恢复的 DOM 重绑交互（监听器随 innerHTML 重建丢失）：
     *   - 图片：灯箱 + 拖拽到画布（生成图带原始提示词，落画布可溯源）
     *   - 图片删除按钮 / 用户消息"重新编辑" / 生成图"重新生成"
     *   - 视频块"添加到画布"与"下载视频"（路径/提示词在 data 属性）
     *   - pi 块折叠头；pi 的"重新继续"是绑定失败现场的一次性入口，
     *     刷新后上下文已断，直接移除避免留下无响应的死按钮
     */
    _rebindRestoredMessages() {
        const chat = this.chat;
        const genParamsOf = (blockEl) => {
            const id = blockEl?.dataset.genId;
            return (id && chat._genParams.get(id)) || null;
        };

        // 图片：灯箱 + 拖拽
        chat.messagesEl.querySelectorAll('.llm-msg-image').forEach((img) => {
            const genParams = genParamsOf(img.closest('.llm-gen-block'));
            img.addEventListener('click', () => chat.lightbox.open(img.src));
            LlmImageDrag.attach(img, genParams ? { prompt: genParams.prompt || '' } : {});
        });

        // 图片删除按钮（悬停 ×）
        chat.messagesEl.querySelectorAll('.llm-msg-image-remove').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                btn.closest('.llm-msg-image-wrap')?.remove();
                this._scheduleHistorySave();
            });
        });

        // 用户消息"重新编辑"：原始提示词在 data 属性，图片取自气泡本身
        chat.messagesEl.querySelectorAll('.llm-msg-actions[data-raw-prompt]').forEach((actions) => {
            actions.querySelectorAll('.llm-msg-action-btn').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const bubble = actions.closest('.llm-msg');
                    const images = Array.from(bubble?.querySelectorAll('.llm-msg-image') || [])
                        .map((img) => img.src);
                    chat.reeditMessage(actions.dataset.rawPrompt, images);
                });
            });
        });

        chat.messagesEl.querySelectorAll('.llm-gen-block').forEach((block) => {
            if (block.classList.contains('llm-video-block')) {
                // 视频块：添加到画布 / 下载视频（路径与提示词在 data 属性）
                const dragBtn = block.querySelector('.llm-video-to-canvas-btn');
                const fallbackPath = dragBtn?.dataset.videoPath || '';
                block.querySelectorAll('.llm-video-to-canvas-btn').forEach((btn) => {
                    btn.addEventListener('click', () =>
                        chat.videoGen._addVideoToCanvas(btn.dataset.videoPath, btn.dataset.prompt || ''));
                });
                block.querySelectorAll('.llm-gen-btn').forEach((btn) => {
                    btn.addEventListener('click', () => {
                        const path = btn.dataset.videoPath || fallbackPath;
                        if (!path) return;
                        const a = document.createElement('a');
                        a.href = '/' + path;
                        a.download = String(path).split('/').pop();
                        a.click();
                    });
                });
                return;
            }
            // 生成图片块：重新生成（原始请求参数按块 id 从快照取回）
            const params = genParamsOf(block);
            block.querySelectorAll('.llm-gen-btn').forEach((btn) => {
                if (!params) {
                    btn.disabled = true;
                    btn.title = '原始生成参数缺失，无法重新生成';
                    return;
                }
                btn.addEventListener('click', () => chat.regenerate(params));
            });
        });

        // pi 块折叠头 + 移除失效的"重新继续"按钮
        chat.messagesEl.querySelectorAll('.pi-block-header').forEach((header) => {
            header.addEventListener('click', () => header.closest('.pi-block')?.classList.toggle('open'));
        });
        chat.messagesEl.querySelectorAll('.pi-retry-btn').forEach((btn) => btn.remove());

        // 网页桥接推荐追问胶囊：追问文本在 data 属性，点击续问
        chat.messagesEl.querySelectorAll('.webbridge-suggestion[data-suggestion]').forEach((chip) => {
            chip.addEventListener('click', () => {
                if (chat.webBridge?.isStreaming()) return;
                chat.webBridge?.send(chip.dataset.suggestion, []);
            });
        });
    }

    /**
     * 删除当前键的快照（清空对话时调用，键规则与 _saveHistorySnapshot 一致）
     * @param {string} [key] - 缺省按当前持久化键
     */
    _deleteHistorySnapshot(key = this._historyKey()) {
        this._historyStore.delete(key);
    }
}

// 将控制器类暴露到全局作用域（LlmChat 构造函数中实例化）
window.LlmHistoryController = LlmHistoryController;
