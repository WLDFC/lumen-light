/**
 * ==========================================================================
 * LumenLight pi 智能体控制器（LlmPiAgent）
 * ==========================================================================
 * 作用：LLM 窗口选中「pi 编码智能体」时的对话控制器——事件状态机与会话
 *   控制（渲染层与纯函数已拆出，见下方「文件分工」）：
 *   - send()：消息经后端 /api/pi/prompt 喂给 pi RPC 子进程
 *     （后端自动完成模型切换与"存档 → 会话"绑定）；
 *   - pi 的流式事件由后端经 WebSocket 广播（piEvent 页面事件），
 *     本类消费后把一轮回复渲染成「分阶段、可折叠」的块序列：
 *       · 思考块（thinking）：流式累积，结束/进入下一阶段自动折叠，头部计时长；
 *       · 工具块（tool）：默认折叠，头部显示中文标题/参数预览/运行状态与耗时；
 *       · 文本块（text）：最终回答，始终展开。
 *     工具结果（role=tool）只填入对应工具块的折叠区，绝不铺进主气泡
 *     （否则 bash 打印的 base64 等大段二进制会糊满界面）；
 *   - 流式中点击发送 = 中止推理；流空闲看门狗兜底收尾（长静默轮询
 *     /api/pi/state 区分"在忙/流丢失/后端不可达"）。
 *
 * 文件分工（本类只保留事件消费与块序列状态机）：
 *   - js/components/LlmPiAgentRender.js  块的 DOM 装配/指示器/说明块/Markdown
 *                                        渲染（原型混入，须后于本文件加载）；
 *   - js/utils/PiAgentBlocks.js          纯函数层（工具名映射/输出摘要/时长/
 *                                        转义与行内渲染/去重决策，Jest 可单测）。
 *
 * pi 的底层模型在 设置 → 通用 → 「pi 使用的模型」中选择
 * （localStorage: piModelKey），权限分级同处设置（同步到后端生效）。
 * ==========================================================================
 */

/** pi 完成提示音：Web Audio 合成上行双音（E6→A6，正弦 + 指数衰减包络），
 *  与常见 IDE 的任务完成音同风格——零音频文件依赖。AudioContext 惰性
 *  创建：发送消息本身就是用户手势，首次播放即可满足浏览器自动播放
 *  策略（此前从未交互过的页面才会被拦，对话场景不存在） */
let _chimeCtx = null;
function _playDoneChime() {
    try {
        if (!_chimeCtx) {
            _chimeCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (_chimeCtx.state === 'suspended') _chimeCtx.resume();
        const t0 = _chimeCtx.currentTime;
        // [频率, 起始偏移]：第二音略延迟形成"叮-叮"上行的完成感
        [[1318.5, 0], [1760, 0.09]].forEach(([freq, at]) => {
            const osc = _chimeCtx.createOscillator();
            const gain = _chimeCtx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0, t0 + at);
            gain.gain.linearRampToValueAtTime(0.16, t0 + at + 0.012);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.36);
            osc.connect(gain).connect(_chimeCtx.destination);
            osc.start(t0 + at);
            osc.stop(t0 + at + 0.4);
        });
    } catch { /* 音频不可用（极旧浏览器等）：静默跳过，不影响主流程 */ }
}

class LlmPiAgent {
    constructor(chat) {
        this.chat = chat;
        this._streaming = false;
        this._wrap = null;        // 本轮 assistant 消息容器（块序列的父节点）
        this._blocks = [];        // 本轮已渲染的块 [{type, el, body, content, meta}]
        this._textBuf = '';       // 已累计的回答文本
        this._watchTimer = null;     // 流空闲看门狗定时器
        this._lastEventAt = 0;       // 最近一次 pi 事件时间（空闲判定基准）
        this._skipNextAgentEnd = false; // 排队场景：忽略上一任务的 agent_end
        this._watchPollFails = 0;    // 看门狗状态轮询连续失败次数
        this._runningEl = null;      // 执行中指示器元素（最新消息框下方）
        this._runningTextEl = null;  // 执行中指示器文本（可按场景改写）
        this._lastPrompt = null;     // 最近一次发送 {text, images}，失败"重新继续"用
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

    // ==================== 纯函数委托（实现在 PiAgentBlocks） ====================

    /** 工具名 → 中文标题/图标（映射表在 PiAgentBlocks.toolMeta） */
    _toolMeta(name) {
        return PiAgentBlocks.toolMeta(name);
    }

    /** 工具参数的头部单行内联展示 */
    _argsInline(args) {
        return PiAgentBlocks.argsInline(args);
    }

    /** 去掉文本块尾部的流式光标占位符 */
    _stripCursor(s) {
        return PiAgentBlocks.stripCursor(s);
    }

    // ==================== 块序列状态机 ====================

    /** 新建工具块（带图标 + 内联参数），默认折叠，并预填调用参数分段 */
    _addToolBlock(name, args) {
        this._dropEmptyCursor();   // 真实块开始：清掉开头的光标占位块
        this._finalizeText();      // 进入工具阶段：上一个文本块清光标定稿
        const meta = this._toolMeta(name);
        const b = this._addCollapsibleBlock('tool', meta.title, {
            icon: meta.icon,
            args: this._argsInline(args)
        });
        b.name = name || '工具';    // 记录原始工具名供次级匹配（标题已是中文）
        // 默认折叠：头部已带中文标题/参数预览/运行状态，需要细节再点开
        this._setToolArgs(b, args);
        return b;
    }

    /** 收尾当前文本块：清掉流式光标，保证内容干净（阶段切换/消息收尾时调用） */
    _finalizeText() {
        const last = this._blocks[this._blocks.length - 1];
        if (last && last.type === 'text') {
            last.content.textContent = this._stripCursor(last.content.textContent);
        }
    }

    /** 取"当前"思考块（最后一个且为 thinking），没有则新建（默认折叠） */
    _ensureThinkingBlock() {
        const last = this._blocks[this._blocks.length - 1];
        if (last && last.type === 'thinking') return last;
        this._dropEmptyCursor();
        this._finalizeText();   // 进入思考阶段：上一个文本块清光标定稿
        // 思考块只要存在就会渲染出来（看得见这一行），但内容默认折叠；
        // 头部由秒级 tick 实时刷新"持续了 X 秒"
        const b = this._addCollapsibleBlock('thinking', '思考', { icon: PiAgentBlocks.THINK_ICON });
        b.thinkingActive = true;
        b.meta.textContent = '思考中…';
        return b;
    }

    /** 思考块去重：pi 个别场景下会把同一段思考流式输出两次（调试日志
     *  证实：message_end 前出现两个内容完全相同的思考块，呈"思考→回复→
     *  思考"布局）。以先出现的为准，移除其后内容完全相同的重复块。
     *  在 message_end / agent_end 收尾时调用（消息边界，内容已定稿） */
    _dedupeThinking() {
        const { kept, removed } = PiAgentBlocks.dedupeBlocks(
            this._blocks, 'thinking', (b) => b.content.textContent);
        removed.forEach((b) => b.el.remove());
        this._blocks = kept;
    }

    /** 文本块去重：pi 流式层偶发把同一段文本分两段输出（与思考块复读
     *  同构，见 _dedupeThinking——序列形如"回复→思考→回复"，第二段
     *  因中间插了思考块走 _ensureTextBlock 新建，界面出现两段相同
     *  文本）。以先出现的为准，按定稿源文本归一化比较，移除其后
     *  重复块。在 message_end / agent_end 收尾时调用 */
    _dedupeText() {
        const { kept, removed } = PiAgentBlocks.dedupeBlocks(
            this._blocks, 'text',
            (b) => this._stripCursor(typeof b.srcText === 'string'
                ? b.srcText : b.content.textContent).trim());
        removed.forEach((b) => b.el.remove());
        this._blocks = kept;
    }

    /** 移除"仅有光标、尚无实质内容"的占位文本块（真实块开始时调用） */
    _dropEmptyCursor() {
        const last = this._blocks[this._blocks.length - 1];
        if (last && last.type === 'text' && this._textBuf === '' &&
            last.content.textContent.trim() === '▍') {
            last.el.remove();
            this._blocks.pop();
        }
    }

    /** 取"当前"文本块（最后一个且为 text）；没有则新建（含模型复读去重） */
    _ensureTextBlock() {
        const last = this._blocks[this._blocks.length - 1];
        if (last && last.type === 'text') return last;
        // 去重兜底：若即将新建的文本与"上一个文本块"完全相同（模型对每个
        // 对象都复读一次总结），复用旧块不新建，避免界面出现 N 段相同总结
        if (this._textBuf) {
            for (let i = this._blocks.length - 1; i >= 0; i--) {
                if (this._blocks[i].type === 'text') {
                    if (this._blocks[i].content.textContent === this._textBuf) return this._blocks[i];
                    break;
                }
            }
        }
        return this._addTextBlock();
    }

    /** 按 toolCall id 查找工具块（不限收尾状态），没有则返回 null */
    _findToolBlock(callId) {
        if (!callId) return null;
        return this._blocks.find((b) => b.type === 'tool' && b.callId === callId) || null;
    }

    /** 取最后一个"运行中/未收尾"的工具块，没有则返回 null */
    _lastToolBlock() {
        for (let i = this._blocks.length - 1; i >= 0; i--) {
            if (this._blocks[i].type === 'tool' && !this._blocks[i].done) return this._blocks[i];
        }
        return null;
    }

    // ==================== 发送与事件 ====================

    /** 发送用户消息到 pi（流式结果经 piEvent 异步渲染） */
    async send(text, images) {
        const chat = this.chat;
        const model = this.getUnderlyingModel();
        if (!model) {
            chat.appendMessage('assistant', '请先在面板模型下拉的「Agent」分类中选择一个对话模型（即 pi 底层模型）');
            return;
        }

        chat.inputEl.value = '';
        chat.attachments.clear();
        chat.appendMessage('user', text || '（图片）', images);

        // 建一个空的 assistant 消息容器作为块序列父节点
        // （气泡创建收敛到 LlmChat.createAssistantBubble 公共接口）
        const { wrap } = chat.createAssistantBubble();
        wrap.classList.add('thinking', 'pi-turn');
        this._wrap = wrap;
        this._blocks = [];
        this._textBuf = '';

        this._streaming = true;
        this._skipNextAgentEnd = false;
        this._watchPollFails = 0;
        this._lastPrompt = { text, images: images || [] };   // 失败"重新继续"用
        this._lastEventAt = Date.now();
        if (!this._watchTimer) {
            this._watchTimer = setInterval(() => this._watchdog(), 10000);
        }
        // 块计时器：思考块"持续了 X 秒"与运行中工具块的耗时每秒刷新
        if (!this._tickTimer) {
            this._tickTimer = setInterval(() => this._tickBlocks(), 1000);
        }
        // 先放一个带光标的空文本块，表示"已开始、等待输出"
        this._ensureTextBlock().content.textContent = '▍';
        if (chat.sendBtn) chat.sendBtn.textContent = '■ 停止';
        this._showRunning('执行中…');
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
            // 指定技能注记（永驻兜底）：用户在「指定技能」下拉选了技能时随
            // 消息注入"先 skill_load 再执行"；「自动」= 空串不注入。只进 pi
            // 消息，用户气泡仍显示原文（chat.getMandatedSkillNote，见 LlmChat）
            const mandatedNote = chat.getMandatedSkillNote ? chat.getMandatedSkillNote() : '';
            const resp = await fetch('/api/pi/prompt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: (text || '') + mandatedNote,
                    images: imagesPayload,
                    // chat 场景系统提示词随消息上送：pi RPC 的 prompt 命令无
                    // system 参数，后端在会话首条消息时拼入消息头部（见 piAgentManager）
                    systemPrompt: window.llmSystemPrompt?.getActiveContent('chat') || '',
                    archive: window.saveManager?.currentSave || null,
                    provider: model.provider,
                    modelId: model.modelId
                })
            });
            const result = await resp.json().catch(() => null);
            if (!resp.ok || !result || result.status !== 'ok') {
                throw new Error((result && result.message) || `pi 调用失败（HTTP ${resp.status}）`);
            }
            // 已接受；流式内容经 piEvent 更新块，agent_end 收尾。
            // 若 pi 仍在执行上一任务（queued），先显示排队提示；
            // 上一任务的 agent_end 会先到达，必须跳过，否则本条消息的
            // 流会被提前收尾——之后本任务的所有事件因 _streaming 已置假
            // 被静默丢弃，界面永久定格（无停止提示）
            if (result.queued) {
                this._skipNextAgentEnd = true;
                const qb = this._ensureTextBlock();
                qb.srcText = null;   // 占位文本：源文本未定，清掉防旧值参与去重
                qb.content.textContent = '⏳ pi 正在执行上一任务，本条已加入队列…';
                this._setRunningText('⏳ 上一任务仍在执行，本条排队中…');
            }
        } catch (err) {
            this._failNote('❌ ' + err.message);
        }
    }

    /** 中止当前推理（用户点停止按钮）：界面立即收尾（乐观停止），
     *  后台把「清队列 + 掐 bash + 中止」发给后端。
     *  为什么不等后端应答：pi 的 abort 应答要等会话空闲才回来，工具挂住时
     *  可能永不回来——等它就是"点了停止没反应"的观感来源。收尾后到达的
     *  事件因 _streaming=false 被忽略；指令若因 pi 僵死未送达，
     *  pi_unresponsive 上报与状态灯仍会给出重启入口 */
    abort() {
        if (!this._streaming) return;
        // 先写说明再 _finish（_finish 置空 _wrap，顺序反了说明会丢）
        this._noteBlock('⛔ 已停止：清队列与中止指令已发出，后台生成任务一并取消', false);
        this._finish();
        fetch('/api/pi/abort', { method: 'POST', signal: AbortSignal.timeout(15000) })
            .then((r) => r.json().catch(() => null))
            .then((j) => {
                if (j && j.status === 'ok' && j.data && j.data.abortSent === false) {
                    // pi 进程未运行：本地收尾已生效，补一条明示
                    this._standaloneNote('⚠️ 停止指令未能送达（pi 进程未运行）');
                }
            })
            .catch(() => { /* 后端不可达：保持乐观收尾，状态灯会反映后端状态 */ });
    }

    /** pi 事件消费：按阶段写入思考/工具/文本块 */
    _onEvent(event) {
        if (!this._streaming || !this._wrap || !event || !event.type) return;
        this._lastEventAt = Date.now();
        this._watchPollFails = 0;

        if (event.type === 'message_update') {
            const ev = event.assistantMessageEvent || {};
            if (ev.type === 'text_delta') {
                this._textBuf += ev.delta || '';
                const b = this._ensureTextBlock();
                b.srcText = null;   // 裸排累积中：源文本未定，清掉防上段残留
                b.content.textContent = this._textBuf + ' ▍';
                this.chat.followBottom();
            } else if (ev.type === 'text_end' && ev.content !== undefined) {
                this._textBuf = ev.content;
                this._renderMarkdownInto(this._ensureTextBlock(), ev.content);
                this._textBuf = '';   // 消息边界：重置缓冲，下条消息重新累积
            } else if (ev.type === 'thinking_delta') {
                const b = this._ensureThinkingBlock();
                b.thinkingActive = true;   // thinking→text→thinking 回归时重新计时
                b.el.classList.add('open');   // 流式期间临时展开便于观察，结束再折回
                b.content.textContent += ev.delta || '';
                this.chat.followBottom();
            } else if (ev.type === 'thinking_end' && ev.content !== undefined) {
                const b = this._ensureThinkingBlock();
                b.content.textContent = ev.content;
                this._endThinking(b);   // 冻结时长并恢复默认折叠
            }
        } else if (event.type === 'tool_execution_start') {
            this._dropEmptyCursor();
            const args = event.args ?? event.input ?? event.arguments;
            // 优先复用已存在的块（message_end 的 toolCall 可能先建过同名块），
            // 避免 start 事件无条件新建导致同名双块、其中一个拿不到结果
            let b = this._findToolBlock(event.toolCallId ?? event.id);
            if (!b) {
                const last = this._lastToolBlock();
                if (last && !last.started && last.name === (event.toolName || last.name)) b = last;
            }
            if (!b) b = this._addToolBlock(event.toolName, args);
            else this._setToolArgs(b, args);
            b.started = true;
            if (!b.callId) b.callId = event.toolCallId ?? event.id ?? null;
            b.meta.textContent = '运行中…';
            b.el.classList.add('running');
        } else if (event.type === 'tool_execution_end') {
            const b = this._findToolBlock(event.toolCallId ?? event.id) ?? this._lastToolBlock();
            if (b) {
                const hasResult = event.result !== undefined || event.output !== undefined;
                if (hasResult) {
                    this._setToolResult(b, event.result ?? event.output);
                    this._markToolDone(b, event.success === false);
                }
                // 没带 result 时不收尾：等随后的 toolResult 消息填结果，
                // 否则 message_end 的 toolCall 会误判"无未收尾块"而新建重复块
            }
        } else if (event.type === 'message_end' && event.message) {
            const role = event.message.role;
            const parts = Array.isArray(event.message.content) ? event.message.content : [];
            if (role === 'tool') {
                // 工具结果：只填进对应工具块的"执行结果"折叠分段，绝不铺进主气泡
                // （bash 打印的 base64 等大段二进制就藏在这里）
                const text = parts.map((p) => (p.type === 'text'
                    ? (typeof p.text === 'string' ? p.text : JSON.stringify(p.text, null, 2))
                    : '')).filter(Boolean).join('\n');
                const b = this._findToolBlock(event.message.toolCallId ?? event.toolCallId) ?? this._lastToolBlock();
                if (b) {
                    this._setToolResult(b, text);
                    this._markToolDone(b, false);
                }
            } else if (role === 'assistant') {
                // 刷新面板头部统计灰字（实际模型 · 上下文 token · 缓存命中率）
                if (event.message.usage) this.chat.updatePiUsage(event.message.usage, event.message.modelId);
                // pi 模型调用失败（stopReason=error）：把真实错误摆出来，
                // 否则界面只剩兜底的"（无输出）"，看不出是模型/密钥/注册问题
                if (event.message.stopReason === 'error' || event.message.errorMessage) {
                    this._noteBlock(`❌ pi 模型调用失败（${event.message.provider || '?'}/${event.message.model || '?'}）：${event.message.errorMessage || '未知错误'}`, true);
                }
                // 助手消息收尾：补齐思考/文本/工具块（增量事件丢失时的兜底）
                parts.forEach((p) => {
                    if (p.type === 'thinking' && p.thinking) {
                        // 去重：流式阶段（thinking_delta/end）已建过思考块，而
                        // message_end 到达时中间插入了文本/工具块，末尾不再是
                        // 思考块——直接 _ensureThinkingBlock 会新建重复块（同
                        // 文本部件当年的复读 bug）。先按内容查已有思考块
                        let b = this._blocks.find((blk) => blk.type === 'thinking' &&
                            blk.content.textContent === p.thinking);
                        if (!b) {
                            b = this._ensureThinkingBlock();
                            if (!b.content.textContent) b.content.textContent = p.thinking;
                        }
                        this._endThinking(b); // 收尾：冻结时长并保持默认折叠
                    } else if (p.type === 'text' && p.text) {
                        // 以 pi 的 assistant 消息为权威单位：完整文本覆盖当前文本块；
                        // 若与已有文本块相同（流式复读），丢弃本轮新建的重复块。
                        // 比较优先用渲染时记下的 srcText——textContent 已丢
                        // markdown 符号，拿它比原始文本永远不等（去重失效根因）
                        const clean = this._stripCursor(p.text);
                        const sameText = (b) => {
                            if (typeof b.srcText === 'string') {
                                return this._stripCursor(b.srcText) === clean;
                            }
                            return this._stripCursor(b.content.textContent) === clean;
                        };
                        const dup = this._blocks.find((b) => b.type === 'text' && sameText(b));
                        if (dup) {
                            const cur = this._blocks[this._blocks.length - 1];
                            if (cur && cur.type === 'text' && cur !== dup) {
                                cur.el.remove();
                                this._blocks.pop();
                            }
                            if (dup.srcText !== clean) {
                                // dup 是裸排态（流式中被截）或内容有偏差：统一渲染定稿
                                this._renderMarkdownInto(dup, clean);
                            }
                        } else {
                            this._textBuf = clean;
                            this._renderMarkdownInto(this._ensureTextBlock(), clean);
                        }
                        this._textBuf = '';   // 消息边界：重置缓冲，下条消息重新累积
                    } else if (p.type === 'toolCall') {
                        // 按调用 id 精确匹配已有块（含 start 事件建的），避免重复新建；
                        // 匹配不到才退化为"最近未收尾块"或新建。
                        // 注意：这里不能标记收尾——真正的执行结果在随后的
                        // toolResult 消息里，提前收尾会导致结果无处可填而丢失
                        let b = this._findToolBlock(p.id);
                        if (!b) {
                            // 次级匹配：最近一个"未被 message_end 认领过"且同名的
                            // 未收尾块（即 start 事件建立、id 不同源的场景）；
                            // 都不满足才新建，避免同消息多 toolCall 被错误合并
                            const last = this._lastToolBlock();
                            if (last && !last.claimed && last.name === (p.name || last.name)) b = last;
                        }
                        if (!b) b = this._addToolBlock(p.name, p.arguments ?? p.args);
                        else this._setToolArgs(b, p.arguments ?? p.args);
                        if (b && !b.callId) b.callId = p.id ?? null;
                        b.claimed = true;
                    }
                });
                // 收尾去重：清掉流式阶段可能重复输出的同内容思考/文本块
                this._dedupeThinking();
                this._dedupeText();
            }
        } else if (event.type === 'agent_end') {
            if (this._skipNextAgentEnd) {
                // 排队场景：这是上一任务的收尾，本条消息的流才开始。
                // 重置块序列并恢复光标，继续等待本任务的事件
                this._skipNextAgentEnd = false;
                this._wrap.querySelectorAll('.pi-block').forEach((el) => el.remove());
                this._blocks = [];
                this._textBuf = '';
                this._ensureTextBlock().content.textContent = '▍';
                return;
            }
            // 兜底收尾：仍未标记收尾的工具块（无 toolResult 的场景）统一标已完成
            this._blocks.forEach((b) => {
                if (b.type === 'tool' && !b.done) this._markToolDone(b, false);
            });
            // 兜底去重：message_end 丢失时流式重复思考/文本块也能在此清理
            this._dedupeThinking();
            this._dedupeText();
            // 没有实质回答时清掉空光标块；若整轮无任何块则给占位提示
            if (this._textBuf === '') {
                this._dropEmptyCursor();
                if (this._blocks.length === 0) {
                    this._ensureTextBlock().content.textContent = '（无输出）';
                }
            } else {
                // 兜底渲染：text_end 丢失（流被中止等）时缓冲里还留着
                // 未定稿文本——此处一次性渲染，杜绝符号裸漏
                const last = this._blocks[this._blocks.length - 1];
                if (last && last.type === 'text') {
                    this._renderMarkdownInto(last, this._stripCursor(this._textBuf));
                }
                this._textBuf = '';
            }
            // 完成提示音：仅正常收尾路径响——排队分支已提前 return，
            // 用户点停止（abort）不产生 agent_end 事件，均不会误响
            _playDoneChime();
            this._finish();
            this.chat.followBottom();
        } else if (event.type === 'pi_process_exit') {
            // pi 子进程退出（后端广播）：流式中止并明示原因 + 重新继续按钮
            if (this._streaming) {
                this._failNote('⚠️ pi 进程已退出（code ' + (event.code ?? '?') + '），本轮被中断；重新发送将自动拉起并接续会话');
            }
        } else if (event.type === 'pi_unresponsive') {
            // 后端疑似卡死上报（程序不自动杀 pi，人工决策）：弹双按钮说明，
            // 不收尾回合——pi 可能只是慢
            this._unresponsiveNote(event);
        }
    }

    /**
     * 流空闲看门狗：pi 静默挂死（无事件、无退出广播）时界面会永远
     * thinking。空闲超过阈值后轮询 /api/pi/state 区分三种情况：
     *   - pi 仍在流式（长工具等待）→ 刷新基准继续等；
     *   - pi 不在流式 → 事件流丢失，主动收尾并明示；
     *   - 后端不可达（连续两次）→ 收尾并报错。
     * 轮询自带 5s 中止信号，不会长期占用连接
     */
    _watchdog() {
        if (!this._streaming) return;
        if (Date.now() - this._lastEventAt < LlmPiAgent.IDLE_MS) return;

        fetch('/api/pi/state', { signal: AbortSignal.timeout(5000) })
            .then((r) => r.json())
            .then((result) => {
                if (!this._streaming) return;
                const st = (result && result.data) || {};
                if (st.running && st.isStreaming) {
                    // 确实在忙（如桥接工具 30s 等待）：继续等，顺延基准
                    this._lastEventAt = Date.now();
                    return;
                }
                this._finishWithNote(st.running === false
                    ? '⚠️ pi 进程未运行（已崩溃或被重启），本轮对话已结束；重新发送将自动拉起并接续会话'
                    : '⚠️ pi 无新事件且不在流式，已自动结束');
            })
            .catch(() => {
                if (!this._streaming) return;
                this._watchPollFails++;
                // 只提示不收尾：轮询失败可能只是后端瞬间忙，收尾会误杀
                // 实际还在跑的回合（视觉层干扰源）
                this._setRunningText(`⚠️ 状态查询异常（${this._watchPollFails} 次），仍在等待 pi…`);
            });
    }

    /** 收尾并追加说明文字（看门狗/异常路径共用） */
    _finishWithNote(note) {
        this._failNote(note);   // 先说明后收尾，避免说明丢失（见 _failNote 注释）
    }

    /** 收尾：解除流式状态、恢复发送按钮、折叠思考块 */
    _finish() {
        this._streaming = false;
        if (this._watchTimer) {
            clearInterval(this._watchTimer);
            this._watchTimer = null;
        }
        if (this._tickTimer) {
            clearInterval(this._tickTimer);
            this._tickTimer = null;
        }
        this._runningEl?.remove();
        this._runningEl = null;
        this._runningTextEl = null;
        this._wrap?.classList.remove('thinking');
        if (this.chat.sendBtn) this.chat.sendBtn.textContent = '发送';
        this._wrap = null;
        this._blocks = [];
    }
}

// 流空闲阈值：超过此时长无事件才轮询状态（正常工具间隔远小于此）
LlmPiAgent.IDLE_MS = 45000;

// 暴露到全局作用域
window.LlmPiAgent = LlmPiAgent;
