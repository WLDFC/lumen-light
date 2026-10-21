/**
 * ==========================================================================
 * LumenLight pi 智能体控制器（LlmPiAgent）
 * ==========================================================================
 * 作用：LLM 窗口选中「pi 编码智能体」时的对话控制器：
 *   - send()：消息经后端 /api/pi/prompt 喂给 pi RPC 子进程
 *     （后端自动完成模型切换与"存档 → 会话"绑定）；
 *   - pi 的流式事件由后端经 WebSocket 广播（piEvent 页面事件），
 *     本类消费后把一轮回复渲染成「分阶段、可折叠」的块序列：
 *       · 思考块（thinking）：流式累积，结束/进入下一阶段自动折叠，头部计时长；
 *       · 工具块（tool）：默认折叠，头部显示中文标题/参数预览/运行状态与耗时
 *         （常见工具映射中文名——bash→终端、read→查阅、edit/write→写入，
 *         canvas_·/web_·/comfy_mcp_· 等扩展工具族各有专名，未知工具保留原名）；
 *       · 文本块（text）：最终回答，始终展开。
 *     工具结果（role=tool）只填入对应工具块的折叠区，绝不铺进主气泡
 *     （否则 bash 打印的 base64 等大段二进制会糊满界面）；
 *   - 流式中点击发送 = 中止推理。
 *
 * pi 的底层模型在 设置 → 通用 → 「pi 使用的模型」中选择
 * （localStorage: piModelKey），权限分级同处设置（同步到后端生效）。
 * ==========================================================================
 */

/** 工具结果展示上限（字符）：超出截断，避免超长输出撑爆气泡 */
const PI_TOOL_OUTPUT_LIMIT = 2000;
/** 判定"base64/二进制"输出的连续 base64 字符阈值 */
const PI_BASE64_RUN = 300;

/** 思考块图标（cpu 线稿，与工具图标同风格） */
const PI_THINK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>';

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

    // ==================== 分块渲染 ====================

    /**
     * 新建一个可折叠块（思考/工具共用结构：头部按钮 + 折叠正文）
     * @param {'thinking'|'tool'} type - 块类型
     * @param {string} title - 头部标题
     * @returns {Object} 块对象 {type, el, body, content, meta}
     */
    _addCollapsibleBlock(type, title, opts = {}) {
        const el = document.createElement('div');
        el.className = `pi-block pi-block-${type}`;

        const header = document.createElement('button');
        header.type = 'button';
        header.className = 'pi-block-header';
        const icon = document.createElement('span');
        icon.className = 'pi-block-icon';
        icon.innerHTML = opts.icon || '';
        const caret = document.createElement('span');
        caret.className = 'pi-caret';
        caret.textContent = '▸';
        const titleEl = document.createElement('span');
        titleEl.className = 'pi-block-title';
        titleEl.textContent = title;
        const argsEl = document.createElement('span');
        argsEl.className = 'pi-block-args';
        if (opts.args) argsEl.textContent = opts.args;
        const meta = document.createElement('span');
        meta.className = 'pi-block-meta';
        header.append(icon, caret, titleEl, argsEl, meta);

        const body = document.createElement('div');
        body.className = 'pi-block-body';

        el.append(header, body);
        // 所有块都可点击头部折叠/展开；思考块与工具块均默认折叠
        header.addEventListener('click', () => el.classList.toggle('open'));

        this._wrap.appendChild(el);
        const block = { type, el, body, meta, titleEl, argsEl, startedAt: Date.now() };
        // 思考块正文直接一个 pre；工具块正文按"调用参数/执行结果"分段懒加载
        if (type === 'thinking') block.content = this._addSectionContent(body);
        this._blocks.push(block);
        this.chat.followBottom();
        return block;
    }

    /** 在 body 内建一个无标签正文 pre（思考块用） */
    _addSectionContent(parent) {
        const pre = document.createElement('div');
        pre.className = 'pi-block-content';
        parent.appendChild(pre);
        return pre;
    }

    /** 在工具块 body 内建一个带标签的分段（调用参数/执行结果），返回其 pre */
    _addSection(block, label) {
        const wrap = document.createElement('div');
        wrap.className = 'pi-section';
        const lab = document.createElement('div');
        lab.className = 'pi-section-label';
        lab.textContent = label;
        const pre = this._addSectionContent(wrap);
        wrap.append(lab, pre);
        block.body.appendChild(wrap);
        return pre;
    }

    /**
     * 按工具名给出展示元数据（中文标题 + 图标），对齐 zcode 的块观感：
     * 常见内置工具与三个扩展工具族显示中文标题，未知工具与用户自挂
     * MCP 工具（mcp__ 前缀）保留原名，避免看不出是哪个服务器
     * @param {string} name - 工具名
     * @returns {{title: string, icon: string}} 头部标题与 svg 标记
     */
    _toolMeta(name) {
        const svg = (paths) => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
        const ICON = {
            terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
            read: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
            canvas: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
            search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
            edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
            star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
            globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
            film: '<rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/>',
            gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
            save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
            check: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
            wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'
        };
        const pick = (title, key) => ({ title, icon: svg(ICON[key]) });
        const n = String(name || '').toLowerCase();
        // ---- 画布工具族（lumen-canvas 扩展 14 个，按实际名单给专名）----
        if (/^canvas_get_state$/.test(n)) return pick('获取画布状态', 'canvas');
        if (/^canvas_get_image/.test(n)) return pick('取画布图片', 'canvas');
        if (/^canvas_get_prompts/.test(n)) return pick('获取提示词链', 'canvas');
        if (/^canvas_drop_image$/.test(n)) return pick('落图到画布', 'canvas');
        if (/^canvas_drop_video$/.test(n)) return pick('落视频到画布', 'film');
        if (/^canvas_run_comfy/.test(n)) return pick('执行 Comfy 工作流', 'gear');
        if (/^canvas_run_llm_image/.test(n)) return pick('AI 生图', 'star');
        if (/^canvas_run_video/.test(n)) return pick('AI 生视频', 'film');
        if (/^canvas_poll_task/.test(n)) return pick('查询生成任务', 'check');
        if (/^canvas_build/.test(n)) return pick('搭建节点工作流', 'gear');
        if (/^canvas_list_workflows/.test(n)) return pick('列出工作流', 'gear');
        if (/^canvas_search_assets/.test(n)) return pick('检索资产', 'search');
        if (/^canvas_clear_media/.test(n)) return pick('清空画布', 'canvas');
        if (/^canvas_delete_media/.test(n)) return pick('删除画布媒体', 'canvas');
        if (/^canvas_/.test(n)) return pick('画布工具', 'canvas');
        // ---- 联网工具族（lumen-web 扩展）----
        if (/^web_search/.test(n)) return pick('联网搜索', 'globe');
        if (/^web_image_search/.test(n)) return pick('网络搜图', 'globe');
        if (/^web_fetch/.test(n)) return pick('读取网页', 'globe');
        if (/^web_/.test(n)) return pick('联网工具', 'globe');
        // ---- Comfy 原生工具族（lumen-comfy 扩展 18 个 comfy_mcp_*，
        //      按实际名单给中文，未收录的显示 "Comfy · 后缀" 保住区分度）----
        if (/^comfy_mcp_/.test(n)) {
            const t = {
                comfy_mcp_system_stats: 'Comfy 状态',
                comfy_mcp_job: '查询 Comfy 任务',
                comfy_mcp_fetch_outputs: '取 Comfy 输出',
                comfy_mcp_run_workflow: '执行 Comfy 工作流',
                comfy_mcp_run_template: '运行 Comfy 模板',
                comfy_mcp_list_workflow_slots: '查看工作流槽位',
                comfy_mcp_set_workflow_slot: '写入工作流槽位',
                comfy_mcp_search_models: '检索模型',
                comfy_mcp_search_templates: '检索模板',
                comfy_mcp_fetch_template: '拉取模板',
                comfy_mcp_download_model: '下载模型',
                comfy_mcp_install_node: '安装节点',
                comfy_mcp_nodes: '查看节点清单',
                comfy_mcp_workflow_deps: '依赖分析',
                comfy_mcp_get_logs: 'Comfy 日志',
                comfy_mcp_free_memory: '释放显存',
                comfy_mcp_upload_file: '上传文件',
                comfy_mcp_download: '下载'
            }[n];
            return t ? pick(t, 'gear') : pick('Comfy · ' + n.replace(/^comfy_mcp_/, ''), 'gear');
        }
        // ---- 技能库（lumen-skills 扩展）----
        if (/^skill_list/.test(n)) return pick('查看技能列表', 'read');
        if (/^skill_load/.test(n)) return pick('加载技能', 'read');
        // ---- pi 内置工具 ----
        if (/^bash$|shell|terminal/.test(n)) return pick('终端', 'terminal');
        if (/^read$|^open/.test(n)) return pick('查阅', 'read');
        if (/^edit$|^write$|^apply_patch|^create/.test(n)) return pick('写入', 'edit');
        if (/grep|glob|find|search|query|list|^ls$/.test(n)) return pick('搜索', 'search');
        // ---- 用户自挂 MCP 工具：保留全名（含服务器名）不翻译 ----
        if (/^mcp__/.test(n)) return { title: name || 'MCP 工具', icon: svg(ICON.wrench) };
        return { title: name || '工具', icon: svg(ICON.wrench) };
    }

    /** 工具参数的头部单行内联展示（紧凑 JSON；空参数返回空串不显示） */
    _argsInline(args) {
        if (args === undefined || args === null || args === '') return '';
        if (typeof args === 'object' && Object.keys(args).length === 0) return '';
        return typeof args === 'string' ? args : JSON.stringify(args);
    }

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

    /** 填充工具块的"调用参数"分段（懒建；空参数不渲染，避免无意义的 {}） */
    _setToolArgs(b, args) {
        const isEmpty = args === undefined || args === null || args === '' ||
            (typeof args === 'object' && Object.keys(args).length === 0);
        if (isEmpty) return;
        if (!b.argsPre) b.argsPre = this._addSection(b, '调用参数');
        b.argsPre.textContent = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
        if (!b.argsEl.textContent) b.argsEl.textContent = this._argsInline(args);
    }

    /** 填充工具块的"执行结果"分段（懒建，自动摘要/折叠 base64） */
    _setToolResult(b, text) {
        if (!b.resultPre) b.resultPre = this._addSection(b, '执行结果');
        b.resultPre.textContent = this._summarizeToolOutput(text);
    }

    /** 标记工具块收尾状态（已完成/失败，附耗时） */
    _markToolDone(b, failed) {
        b.done = true;
        b.el.classList.remove('running');
        b.el.classList.add(failed ? 'failed' : 'done');
        const dur = this._fmtDuration(Date.now() - (b.startedAt || Date.now()));
        b.meta.textContent = (failed ? '失败 · ' : '已完成 · ') + dur;
    }

    /** 结束思考计时：冻结头部时长并折叠（重复调用无害） */
    _endThinking(b) {
        if (!b || b.thinkingActive === false) return;
        b.thinkingActive = false;
        b.meta.textContent = '持续了 ' + this._fmtDuration(Date.now() - (b.startedAt || Date.now()));
        b.el.classList.remove('open');
    }

    /** 毫秒 → 人话时长（60 秒内 "N 秒"，以上 "M 分 S 秒"） */
    _fmtDuration(ms) {
        const s = Math.max(0, Math.round(ms / 1000));
        if (s < 60) return s + ' 秒';
        return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
    }

    /** 秒级 tick：刷新进行中块的头部计时（思考块与运行中工具块） */
    _tickBlocks() {
        if (!this._streaming || !this._wrap) return;
        const now = Date.now();
        for (const b of this._blocks) {
            if (b.type === 'thinking' && b.thinkingActive) {
                b.meta.textContent = '持续了 ' + this._fmtDuration(now - b.startedAt);
            } else if (b.type === 'tool' && b.started && !b.done) {
                b.meta.textContent = '运行中 · ' + this._fmtDuration(now - b.startedAt);
            }
        }
    }

    /** 新建一个始终展开的文本块（最终回答） */
    _addTextBlock() {
        const el = document.createElement('div');
        el.className = 'pi-block pi-block-text';
        const content = document.createElement('div');
        content.className = 'pi-block-content';
        el.appendChild(content);
        this._wrap.appendChild(el);
        const block = { type: 'text', el, content };
        this._blocks.push(block);
        this.chat.followBottom();
        return block;
    }

    /** 去掉文本块尾部的流式光标占位符 */
    _stripCursor(s) {
        return String(s || '').replace(/\s*▍$/, '');
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
        const b = this._addCollapsibleBlock('thinking', '思考', { icon: PI_THINK_ICON });
        b.thinkingActive = true;
        b.meta.textContent = '思考中…';
        return b;
    }

    /** 思考块去重：pi 个别场景下会把同一段思考流式输出两次（调试日志
     *  证实：message_end 前出现两个内容完全相同的思考块，呈"思考→回复→
     *  思考"布局）。以先出现的为准，移除其后内容完全相同的重复块。
     *  在 message_end / agent_end 收尾时调用（消息边界，内容已定稿） */
    _dedupeThinking() {
        const seen = new Set();
        const keep = [];
        for (const b of this._blocks) {
            if (b.type === 'thinking') {
                const c = b.content.textContent;
                if (c && seen.has(c)) { b.el.remove(); continue; }
                if (c) seen.add(c);
            }
            keep.push(b);
        }
        this._blocks = keep;
    }

    /** 文本块去重：pi 流式层偶发把同一段文本分两段输出（与思考块复读
     *  同构，见 _dedupeThinking——序列形如"回复→思考→回复"，第二段
     *  因中间插了思考块走 _ensureTextBlock 新建，界面出现两段相同
     *  文本）。以先出现的为准，按定稿源文本归一化比较，移除其后
     *  重复块。在 message_end / agent_end 收尾时调用 */
    _dedupeText() {
        const norm = (s) => this._stripCursor(String(s == null ? '' : s)).trim();
        const seen = new Set();
        const keep = [];
        for (const b of this._blocks) {
            if (b.type === 'text') {
                const key = norm(typeof b.srcText === 'string'
                    ? b.srcText : b.content.textContent);
                if (key && seen.has(key)) { b.el.remove(); continue; }
                if (key) seen.add(key);
            }
            keep.push(b);
        }
        this._blocks = keep;
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

    /**
     * 工具结果摘要化：base64/二进制折叠、超长截断，避免大段乱码进界面
     * @param {*} text - 工具原始输出（字符串或对象，对象序列化为 JSON）
     * @returns {string} 适合折叠展示的摘要
     */
    _summarizeToolOutput(text) {
        let s;
        if (typeof text === 'string') s = text;
        else if (text == null) s = '';
        else {
            // 工具返回对象时直接 String() 会得到 "[object Object]"，必须序列化
            try { s = JSON.stringify(text, null, 2); } catch { s = String(text); }
        }
        if (!s.trim()) return '（无输出）';
        if (new RegExp(`[A-Za-z0-9+/]{${PI_BASE64_RUN},}`).test(s)) {
            return `（含 base64/二进制输出，共 ${s.length} 字符，已折叠不展示）`;
        }
        if (s.length > PI_TOOL_OUTPUT_LIMIT) {
            return s.slice(0, PI_TOOL_OUTPUT_LIMIT) + `\n…（已截断，共 ${s.length} 字符）`;
        }
        return s;
    }

    /** 追加一条说明文本块（错误/进程退出/看门狗收尾共用） */
    _noteBlock(text, isError) {
        const block = this._addTextBlock();
        block.content.textContent = text;
        if (isError && this._wrap) this._wrap.classList.add('error');
        return block;
    }

    // ==================== 迷你 Markdown 渲染 ====================
    // pi 底层模型按 Markdown 语法写回答（**粗体** / `代码` / 列表 / 标题），
    // 纯文本裸排会让符号漏出来。这里做零依赖的轻量渲染（对齐 Trae 等
    // 客户端的段落观感）：只覆盖模型回答里实际出现的语法，未覆盖语法
    // 按普通文本降级。安全性：先整体 HTML 转义再按标记切分，标记以外
    // 的内容永不产生 HTML——模型输出不可信，注入面收在转义这一道闸。

    /** HTML 转义（渲染的第一道闸：所有原文先过这里） */
    _mdEscape(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** 行内渲染：粗体 / 行内代码（先保护代码段再处理粗体，代码内的
     *  星号不参与粗体解析——`**这样**` 应显示为字面量） */
    _mdInline(s) {
        const codes = [];
        // 行内代码先摘出来（内容原样保留，不再吃粗体解析）
        let out = s.replace(/`([^`]+)`/g, (_, code) => {
            codes.push(`<code class="pi-md-code">${code}</code>`);
            return `\u0000${codes.length - 1}\u0000`;
        });
        out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        // 占位符还原（顺序倒放不需要——占位符本身不含 ** ）
        return out.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
    }

    /**
     * 把 pi 的 Markdown 回答渲染成 DOM（覆盖：代码块 / 标题 / 有序·无序
     * 列表含两档嵌套 / 分隔线 / 粗体 / 行内代码；表格等未支持语法整行
     * 按普通文本降级）。返回 DocumentFragment，调用方替换文本块内容。
     * @param {string} src - pi 的原始回答文本
     * @returns {DocumentFragment}
     */
    _renderMarkdown(src) {
        const frag = document.createDocumentFragment();
        const esc = (t) => this._mdEscape(t);
        const inline = (t) => this._mdInline(esc(t));
        const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n');
        let i = 0;
        const mk = (tag, cls, html) => {
            const el = document.createElement(tag);
            if (cls) el.className = cls;
            el.innerHTML = html;
            frag.appendChild(el);
            return el;
        };
        const isUl = (t) => /^\s*[-*]\s+/.test(t);
        const isOl = (t) => /^\s*\d+[.、)]\s+/.test(t);
        const isListItem = (t) => isUl(t) || isOl(t);
        // 表格行：以 | 开头或包含 | 的行（由下一行的 |---| 分隔行确认）
        const isPipeRow = (t) => /^\s*\|.*\|\s*$/.test(t);
        const isTableSep = (t) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(t);
        const splitPipeRow = (t) => t.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        // 表格单元格里也可能有粗体/行内代码——逐格走 inline
        const buildTable = (rows) => {
            const table = document.createElement('table');
            table.className = 'pi-md-table';
            // 首行为表头，第二行是 |---| 分隔（调用方已校验）
            const thead = document.createElement('thead');
            const trh = document.createElement('tr');
            for (const cell of rows[0]) {
                const th = document.createElement('th');
                th.innerHTML = inline(cell);
                trh.appendChild(th);
            }
            thead.appendChild(trh);
            table.appendChild(thead);
            const tbody = document.createElement('tbody');
            for (let r = 2; r < rows.length; r++) {
                const tr = document.createElement('tr');
                // 列数不齐时按表头列数补空格/截断（模型输出常见轻度错位）
                for (let c = 0; c < rows[0].length; c++) {
                    const td = document.createElement('td');
                    td.innerHTML = inline(rows[r][c] ?? '');
                    tr.appendChild(td);
                }
                tbody.appendChild(tr);
            }
            table.appendChild(tbody);
            return table;
        };

        while (i < lines.length) {
            const line = lines[i];
            // ---- 代码块（``` 围栏）：内容原样转义，不出 inline 解析 ----
            if (/^\s*```/.test(line)) {
                const buf = [];
                i++;
                while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
                i++;   // 跳过收尾围栏（缺失也安全：循环条件兜底）
                mk('pre', 'pi-md-pre', `<code>${esc(buf.join('\n'))}</code>`);
                continue;
            }
            // ---- 表格：首行 |…| + 次行 |---|---| 分隔（GFM 管道表）----
            // 连续管道行聚合成一张表；列数不齐按表头补齐/截断
            if (isPipeRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
                const rows = [splitPipeRow(line)];
                i += 2;   // 跳过表头与分隔行
                while (i < lines.length && isPipeRow(lines[i])) {
                    rows.push(splitPipeRow(lines[i++]));
                }
                frag.appendChild(buildTable(rows));
                continue;
            }
            // ---- 分隔线 ----
            if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { mk('hr', 'pi-md-hr'); i++; continue; }
            // ---- 标题（#### 最多吃到四级，粗体更大）----
            const h = line.match(/^(#{1,4})\s+(.*)$/);
            if (h) { mk('div', `pi-md-h pi-md-h${h[1].length}`, inline(h[2])); i++; continue; }
            // ---- 列表（连续列表行聚合成一个 ul/ol，支持两档嵌套）----
            if (isListItem(line)) {
                const ordered = isOl(line);
                const list = document.createElement(ordered ? 'ol' : 'ul');
                list.className = 'pi-md-list';
                while (i < lines.length && isListItem(lines[i])) {
                    const cur = lines[i];
                    const indent = cur.match(/^\s*/)[0].length;
                    const item = cur.replace(/^\s*(?:[-*]|\d+[.、)])\s+/, '');
                    if (indent >= 2 && list.lastElementChild) {
                        // 嵌套档：挂到上一条目的子列表（没有则现建）
                        let sub = list.lastElementChild.querySelector('ul,ol');
                        if (!sub) {
                            sub = document.createElement(isUl(cur) ? 'ul' : 'ol');
                            sub.className = 'pi-md-list';
                            list.lastElementChild.appendChild(sub);
                        }
                        const li = document.createElement('li');
                        li.innerHTML = inline(item);
                        sub.appendChild(li);
                    } else {
                        const li = document.createElement('li');
                        li.innerHTML = inline(item);
                        list.appendChild(li);
                    }
                    i++;
                }
                frag.appendChild(list);
                continue;
            }
            // ---- 空行：段落分隔 ----
            if (!line.trim()) { i++; continue; }
            // ---- 普通段落：连续非空非结构行聚合为一段 ----
            const buf = [];
            while (i < lines.length && lines[i].trim() && !isListItem(lines[i]) &&
                   !/^\s*```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) &&
                   !/^\s*(-{3,}|\*{3,})\s*$/.test(lines[i])) {
                buf.push(lines[i++]);
            }
            mk('p', 'pi-md-p', buf.map(inline).join('<br>'));
        }
        return frag;
    }

    /** 把文本块内容替换为 Markdown 渲染结果（定稿时调用；流式中不动）。
     *  同时在块上记录源文本 srcText——收尾去重按它精确比较：渲染后的
     *  textContent 已丢失 markdown 符号（**、- 等），拿它比对原始文本
     *  永远不等，是文本复读漏去重的根因 */
    _renderMarkdownInto(block, text) {
        block.srcText = text;
        block.content.innerHTML = '';
        block.content.appendChild(this._renderMarkdown(text));
    }

    /** 执行中指示器：挂在最新消息框下方，圆弧 spinner 匀速旋转。
     *  长沉默（长工具/长模型调用/磁盘扫描）期间给用户"还活着"的判断依据，
     *  避免误判为死掉而人工干预（停止/重启/重发）——那才是回合的真正杀手 */
    _showRunning(text) {
        this._runningEl?.remove();
        const el = document.createElement('div');
        el.className = 'pi-running';
        const spin = document.createElement('span');
        spin.className = 'pi-running-spinner';
        // 圆弧 + 圆头线帽的转圈图标（stroke 颜色经 currentColor 交给 CSS）
        spin.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
            '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" ' +
            'stroke-width="2.5" stroke-linecap="round" stroke-dasharray="40 16.55"/></svg>';
        const t = document.createElement('span');
        t.textContent = text;
        el.append(spin, t);
        this.chat.messagesEl.appendChild(el);
        this._runningEl = el;
        this._runningTextEl = t;
        this.chat.followBottom();
    }

    /** 改写执行中指示器文本（排队/轮询异常等场景） */
    _setRunningText(text) {
        if (this._runningTextEl) this._runningTextEl.textContent = text;
    }

    /** 失败收尾：先把说明与"重新继续"按钮写进当前回合，再收尾。
     *  顺序不能反：_finish 会把 _wrap 置空，之后 _noteBlock 找不到父节点
     *  抛异常、说明丢失（历史上失败说明全因此丢成"静默收泡"） */
    _failNote(note) {
        if (!this._wrap) { this._finish(); return; }
        const b = this._noteBlock(note, true);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pi-retry-btn';
        btn.textContent = '↻ 重新继续';
        btn.title = '重发上一条消息，让 pi 从当前会话进度继续';
        btn.addEventListener('click', () => {
            btn.disabled = true;
            const p = this._lastPrompt;
            if (p) this.send(p.text, p.images);
        });
        b.el.appendChild(btn);
        this._finish();
        this.chat.followBottom();
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

    /** 疑似卡死说明块：[重启 pi 进程]/[继续等待] 双按钮，人工决定是否干预。
     *  选重启后后续的 pi_process_exit 会自然收尾本轮并附"重新继续" */
    _unresponsiveNote(event) {
        const label = event.source === 'probe' ? '健康探测' : 'RPC 命令';
        const text = `⚠️ pi 连续 ${event.count || '多'} 次${label}无应答，疑似卡死（程序不会自动重启 pi）`;
        const block = this._wrap ? this._noteBlock(text, true) : this._standaloneNote(text);
        const bar = document.createElement('div');
        bar.className = 'pi-retry-bar';
        const btnRestart = document.createElement('button');
        btnRestart.type = 'button';
        btnRestart.className = 'pi-retry-btn';
        btnRestart.textContent = '↻ 重启 pi 进程';
        const btnWait = document.createElement('button');
        btnWait.type = 'button';
        btnWait.className = 'pi-retry-btn';
        btnWait.textContent = '… 继续等待';
        btnRestart.addEventListener('click', async () => {
            btnRestart.disabled = true;
            btnWait.disabled = true;
            btnRestart.textContent = '重启中…';
            try {
                await fetch('/api/pi/restart', { method: 'POST' });
            } catch { /* 后端不可达：保留按钮状态，用户可自行重试 */ }
        });
        btnWait.addEventListener('click', () => {
            bar.remove();
            block.content.textContent = text + '（已选择继续等待，持续无应答将再次提醒）';
        });
        bar.append(btnRestart, btnWait);
        block.el.appendChild(bar);
        this.chat.followBottom();
    }

    /** 回合外说明块（流式外收到上报时没有 _wrap，直接挂消息区） */
    _standaloneNote(text) {
        const el = document.createElement('div');
        el.className = 'pi-block pi-block-text';
        const content = document.createElement('div');
        content.className = 'pi-block-content';
        content.textContent = text;
        el.appendChild(content);
        this.chat.messagesEl.appendChild(el);
        return { el, content };
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
