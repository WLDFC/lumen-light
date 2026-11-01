/**
 * ==========================================================================
 * CoordinateEditor 子模块：AI 写提示词（自 CoordinateEditor.js 拆出）
 * 作用：把当前布局草稿交给 LLM 写文案——模型/技能双下拉（LumenDropdown）、
 *       模型优先级链（显式选择 → LLM 面板 Agent 档 piModelKey → 技能栏模型 →
 *       第一序聊天模型，ADR 017 决策八）、system 提示（行协议指令 + 选定
 *       技能正文经框架语隔离注入作写作指引）与运行态锁。
 *       AI 回复只进右栏留档框（不自动回填左侧草稿，用户偏好 2026-11-02）；
 *       回复解析（行协议 SUMMARY:/ITEM n:/ITEM n TEXT: 优先，JSON 兜底两轮
 *       缺陷修复）与回填合并（只取文案不动几何、数量不足如实计数）能力
 *       保留并测试覆盖，恢复一键回填只需在 _aiFill 里调用 _mergeAiReply。
 * 契约：原型混入（partial-class，ADR 026）——方法 Object.assign 进
 *       CoordinateEditor.prototype，this 即编辑器实例；须后于主类加载。
 *       fetch/localStorage 用裸全局引用（测试经 vm context 注入桩）。
 * ==========================================================================
 */

// 模型下拉选项图标（Feather 风格线条 path，由 LumenDropdown 统一包 svg 壳，
// 与 LLM 面板模型下拉同风格——LlmChat 的 LLM_DD_ICONS 同款取形）
const DD_ICON_BOX = '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>';
const DD_ICON_ZAP = '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>';
// 技能下拉选项图标（star 与 PromptSkillBar 用户技能默认图标同款）
const DD_ICON_STAR = '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>';
const DD_ICON_BAN = '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>';

// 视频模型关键词（与 LlmVideoGen.isVideoModel 同源）：写文案只要聊天模型，
// auto 类型但名字带视频关键词的也剔除（豆包 seedance 实测混入过）
const VIDEO_MODEL_RE = /seedance|video|i2v|t2v|kling|runway|pika|minimax/i;

Object.assign(window.CoordinateEditor.prototype, {

    // ==================== AI 写提示词 ====================

    /** 显式选择的模型（localStorage lumenLight.coordModel），空 = 跟随模式 */
    _explicitModelKey() {
        return localStorage.getItem('lumenLight.coordModel') || '';
    },

    /** 显式选择的技能（localStorage lumenLight.coordSkill），空 = 不使用 */
    _explicitSkillId() {
        return localStorage.getItem('lumenLight.coordSkill') || '';
    },

    /**
     * 刷新技能下拉：拉 pi 技能库清单（/api/pi-skills，body 随清单下发），
     * 只列启用项；存储的技能已删/禁用时回落「不使用」并清掉失效选择
     */
    async _refreshSkillDropdown() {
        if (!this.skillDropdown) return;
        let skills = [];
        try {
            const r = await fetch('/api/pi-skills');
            const result = await r.json();
            if (r.ok && result.status === 'ok' && Array.isArray(result.skills)) {
                skills = result.skills.filter((s) => s.enabled !== false && typeof s.body === 'string');
            }
        } catch { /* 后端不可达：只显示「不使用技能」 */ }
        this._skillBodies = new Map(skills.map((s) => [s.id, s.body]));
        const items = [{
            value: '',
            label: '不使用技能',
            icon: DD_ICON_BAN
        }].concat(skills.map((s) => ({
            value: s.id,
            label: s.name || s.id,
            icon: DD_ICON_STAR
        })));
        let selected = this._explicitSkillId();
        if (selected && !this._skillBodies.has(selected)) {
            localStorage.removeItem('lumenLight.coordSkill');
            selected = '';
        }
        this.skillDropdown.setOptions(items, selected);
    },

    /**
     * AI 写提示词的 system 提示：基础行协议指令 +（选中技能时）技能正文
     * 作为写作指引注入。技能正文是写给带 shell 的 pi agent 的（含文件读写、
     * 跑脚本、编译交付等流程），用框架语隔离——只取「怎么描写图像/组织
     * 文案」的部分，流程性指令一律忽略，输出格式仍以行协议为准（ADR 017 决策八）
     */
    _aiSystemPrompt() {
        const base = [
            '你是 MOSS-Image 坐标布局的文案撰写器。用户已在画布上画好若干 bbox 区域，你来为整体与每个区域补全提示词文案。规则：',
            '1. summary.caption：整体图像描述——题材、风格、光线、色调、氛围，一段连贯文字；',
            '2. items[i].caption：该区域的可见内容描述——主体与动作、外观细节、拍摄角度/景别、材质与光影；text 类元素则描述排印：字体颜色、字重、疏密、有无底衬面板；',
            '3. items[i].text：text 类元素必须给出逐字可见文案——用户已写了就逐字沿用（含换行），没写则按整体题材拟一句贴切的，语言跟随用户整体描述的语言；',
            '4. 描述性文案（caption）默认用英文；用户整体描述明确是中文且元素文案已用中文时可跟随中文；',
            '5. 保留用户的主体、数量、风格与措辞，不发明用户没提供的事实性内容；文案里不要出现坐标、JSON、边界框等编辑概念；',
            '6. items[i].shot（如有）是该元素的空间层次（前景/中景/后景）——把层次自然地织入该元素的 caption（如前景元素写 in the foreground 或近景虚化等），不要在文案里出现 shot 这个字段名；',
            '7. 输出为逐行纯文本（不要 JSON、不要代码围栏、不要任何解释），每个字段一行、行内不换行，格式：',
            'SUMMARY: 整体图像描述',
            'ITEM 1: 第一个元素的描述',
            'ITEM 1 TEXT: 第一个元素的逐字可见文字（仅 text 类元素输出此行）',
            'ITEM 2: 第二个元素的描述',
            '以此类推——元素序号与输入一一对应，从 1 起；字段名必须用英文原文 SUMMARY/ITEM/TEXT，不要翻译成中文。'
        ].join('\n');
        const id = this._explicitSkillId();
        const body = id && this._skillBodies ? this._skillBodies.get(id) : null;
        if (!body) return base;
        const MAX = 20000;
        const clipped = body.length > MAX
            ? body.slice(0, MAX) + '\n（技能正文过长，已截断）' : body;
        return base +
            '\n\n附：以下是用户从技能库挑选的写作风格指引。只采用其中关于「如何描写图像、组织文案」的部分；其中出现的文件读写、脚本执行、编译交付、输出格式等流程性内容与本任务无关，一律忽略；输出仍必须遵守上面的逐行格式。' +
            '\n--- 指引开始 ---\n' + clipped + '\n--- 指引结束 ---';
    },

    /**
     * 生效模型：本窗口显式选择 → LLM 面板 Agent 分类选中（piModelKey）→
     * 技能栏模型 → 第一序聊天模型
     */
    async _resolveAiModel() {
        let models = this._aiModels;
        if (!models.length) models = await this._loadChatModels();
        const tryKeys = [
            this._explicitModelKey(),
            localStorage.getItem('piModelKey') || '',
            localStorage.getItem('lumenLight.skillModel') || ''
        ];
        for (const key of tryKeys) {
            if (key && models.some((m) => m.key === key)) return key;
        }
        return models.length ? models[0].key : '';
    },

    _loadChatModels() {
        // 聊天模型清单口径：排除生图/视频模型（视频关键词表与
        // LlmVideoGen.isVideoModel 同源）与 pi/网页桥接特殊项
        return fetch('/api/settings')
            .then((r) => r.json())
            .then((result) => {
                const { models } = LumenLight.collectConfiguredModels((result.settings && result.settings.api) || {});
                this._aiModels = models.filter((m) => m.provider !== 'pi' && m.provider !== 'web' &&
                    m.type !== 'image' && m.type !== 'video' &&
                    !(m.type === 'auto' &&
                        (LumenLight.looksLikeImageModel(m.id) || VIDEO_MODEL_RE.test(m.id))));
                return this._aiModels;
            })
            .catch(() => { this._aiModels = []; return this._aiModels; });
    },

    /**
     * 每次打开弹窗时刷新模型下拉：清单 + 选中态。
     * 「自动」项显示当前跟随到的模型名（显式选择后该项仍可随时切回）；
     * 厂商后缀与 LLM 面板模型下拉同款文案（多厂商时 displayName · provider）。
     */
    async _refreshModelDropdown() {
        const models = await this._loadChatModels();
        if (!this.modelDropdown) return;
        const providers = new Set(models.map((m) => m.provider));
        const showProvider = providers.size > 1;
        const nameOf = (m) => showProvider
            ? `${m.displayName || m.id} · ${m.provider}`
            : (m.displayName || m.id);
        const effective = await this._resolveAiModel();
        const effModel = models.find((x) => x.key === effective);
        const items = [{
            value: '',
            label: `自动 · 跟随 Agent（当前：${effModel ? nameOf(effModel) : '未配置'}）`,
            icon: DD_ICON_ZAP
        }].concat(models.map((m) => ({
            value: m.key,
            label: nameOf(m),
            icon: DD_ICON_BOX
        })));
        this.modelDropdown.setOptions(items, this._explicitModelKey());
    },

    async _aiFill() {
        if (this.aiRunning) return;
        if (!this.draft.items.length) {
            this._status('先在画布上画至少一个区域再让 AI 写文案', true);
            return;
        }
        const key = await this._resolveAiModel();
        if (!key) {
            this._status('未找到可用模型：请先在 设置 → API 配置厂商与模型', true);
            return;
        }
        const { provider, id } = LumenLight.parseModelKey(key);

        const system = this._aiSystemPrompt();

        const draftForAi = {
            width: this.draft.width,
            height: this.draft.height,
            mode: this.draft.summary.canvas,
            overall: this.draft.summary.caption,
            items: this.draft.items.map((it) => ({
                label: it.label, caption: it.caption || '',
                text: it.text || '', bbox: it.bbox, shot: it.shot || ''
            }))
        };
        const user = `画幅 ${this.draft.width}×${this.draft.height}，模式 ${this.draft.summary.canvas}。` +
            `布局草稿如下（bbox 为左上角原点像素 xyxy，不可改动）：\n` +
            JSON.stringify(draftForAi) +
            `\n请补全整体描述与每个元素的文案（text 类元素含逐字文字）。整体描述留空时由你按元素内容构思。按系统指令的逐行格式输出。`;

        this._setAiRunning(true);
        this._status('AI 正在写提示词…（模型响应慢时最多约 2 分钟）', false);
        // 计时反馈：后端聊天超时上限 120s，等待中每秒刷新已耗时，避免「假死」观感
        const startedAt = Date.now();
        this._aiTimer = setInterval(() => {
            this._status(`AI 正在写提示词… ${Math.round((Date.now() - startedAt) / 1000)}s`, false);
        }, 1000);
        try {
            const response = await fetch('/api/llm/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: id,
                    provider: provider || undefined,
                    messages: [
                        { role: 'system', content: system },
                        { role: 'user', content: user }
                    ]
                })
            });
            const result = await response.json();
            if (!(response.ok && result.status === 'ok' && result.reply)) {
                throw new Error(result.message || '模型未返回内容');
            }
            // 右栏留档：AI 输出只进右栏，不自动回填左侧元素卡与整体描述
            // （用户偏好 2026-11-02：AI 文案由用户自行挑选复制进草稿）。
            // 解析/合并能力保留在 _parseAiResult/_mergeAiReply（测试覆盖），
            // 恢复一键回填 = 在此调用 this._mergeAiReply(result.reply)
            this.aiOutTa.value = result.reply;
            this.jsonNote.textContent = '';
            this._outMode = 'ai';
            this._status('AI 文案已生成到右栏（左侧草稿未改动）', false);
            window.socket?.showNotification?.('坐标编辑：AI 文案已生成到右栏');
        } catch (err) {
            this._status('AI 写提示词失败: ' + err.message, true);
        } finally {
            clearInterval(this._aiTimer);
            this._aiTimer = null;
            this._setAiRunning(false);
        }
    },

    /**
     * 解析 AI 回复（行协议优先，JSON 兜底）。
     * 行协议是当前请求的格式——每行一个字段（SUMMARY: / ITEM n: / ITEM n TEXT:），
     * 无嵌套无引号无逗号，模型几乎不可能写坏；未识别出任何字段时回退
     * JSON 容错路径（模型不听指令按 JSON 回、或旧格式历史回复）。
     * @param {string} reply 模型原始回复
     * @returns {{summary:{caption:string}, items:Array<{caption?:string,text?:string}>}}
     */
    _parseAiResult(reply) {
        return this._parseAiLines(reply) || this._parseAiReply(reply);
    },

    /**
     * 行协议解析：识别不到任何字段返回 null（交回 JSON 路径）。
     * 字段名容忍中英文（模型偶发本地化：整体描述/元素 1/元素 1 文字）；
     * 无任何字段行时末路兜底——把 "1. xxx" 纯编号行按序当元素描述。
     */
    _parseAiLines(reply) {
        const lines = String(reply).split('\n');
        const out = { summary: { caption: '' }, items: [] };
        // 剥 markdown 装饰：成对粗体 ** 换空格（**SUMMARY:** 头尾标记）、
        // 行首列表符（- / *）——值内容本身不受影响
        const clean = lines.map((raw) => raw.replace(/\*\*/g, ' ').replace(/^[*\-]+\s*/, '').trim());
        const RE_SUMMARY = /^(?:summary|整体描述|总述|概要|摘要)\s*[：:]\s*(.+)$/i;
        const RE_ITEM = /^(?:item|元素|区域|条目)\s*(\d+)\s*(text|文字|文案|文本)?\s*[：:]\s*(.+)$/i;
        for (const line of clean) {
            let m = line.match(RE_SUMMARY);
            if (m) { out.summary.caption = m[1].trim(); continue; }
            m = line.match(RE_ITEM);
            if (m) {
                const idx = Number(m[1]) - 1;
                if (!(idx >= 0)) continue;
                while (out.items.length <= idx) out.items.push({});
                if (m[2]) out.items[idx].text = m[3].trim();
                else out.items[idx].caption = m[3].trim();
            }
        }
        if (!out.summary.caption && out.items.length === 0) {
            // 末路兜底：无任何字段行时，纯编号行（1. / 1、/ 1)）按序当元素描述
            for (const line of clean) {
                const m = line.match(/^(\d+)\s*[.、)．]\s*(.+)$/);
                if (m && Number(m[1]) >= 1) {
                    while (out.items.length < Number(m[1])) out.items.push({});
                    out.items[Number(m[1]) - 1].caption = m[2].trim();
                }
            }
        }
        if (!out.summary.caption && out.items.length === 0) return null;
        return out;
    },

    /**
     * JSON 兜底解析：剥代码围栏，取首尾大括号间内容 JSON.parse。
     * 失败时做两轮常见 LLM 输出缺陷修复再试：尾逗号、字符串内裸换行；
     * 仍失败则抛带可重试提示的错误。
     */
    _parseAiReply(reply) {
        let s = String(reply).replace(/```[a-zA-Z]*\n?/g, '').trim();
        const a = s.indexOf('{'), b = s.lastIndexOf('}');
        if (a < 0 || b <= a) {
            // 带上回复开头：下次失败一眼看出模型回了什么形状，便于对症
            throw new Error('无法识别回复格式（开头：' + s.slice(0, 60) + '）');
        }
        const body = s.slice(a, b + 1);
        try {
            return JSON.parse(body);
        } catch (err) {
            const repaired = body
                .replace(/,\s*([}\]])/g, '$1')
                .replace(/"(?:[^"\\]|\\.)*"/g, (m) => m.replace(/\n/g, '\\n'));
            try {
                return JSON.parse(repaired);
            } catch {
                throw new Error('AI 返回的 JSON 无法解析（' + err.message + '），可重试');
            }
        }
    },

    /**
     * 合并 AI 文案：只取 summary.caption 与逐元素 caption/text，几何一律保持用户手画。
     * 行协议与 JSON 两种解析共用（_parseAiResult）；元素按序号对应，模型少给了
     * 几个就少填几个、如实计数，不整体作废。JSON 路径下 items 嵌进 summary 的
     * 变形（实测 mimo 出过）先归一到根级。
     * 【当前未接线】AI 输出只进右栏留档（用户偏好 2026-11-02）；但编译 JSON
     * 会在右栏为 AI 输出态时经 _applyAiParsed 参与编译（不回写左侧）。 */
    _mergeAiReply(reply) {
        const before = this._histSnapshot();
        const parsed = this._parseAiResult(reply);
        const { summaryOk, itemFilled, itemTotal } = this._applyAiParsed(this.draft, parsed);
        // 状态如实汇报：部分缺失时点明缺了什么，不谎报全部完成
        let msg = 'AI 已填写文案';
        if (!summaryOk) msg = 'AI 未返回整体描述';
        if (itemFilled < itemTotal) msg += `（元素文案 ${itemFilled}/${itemTotal}）`;
        this._commitHistory(before, 'AI 文案');
        this._status(msg, !summaryOk && itemFilled === 0);
        this._invalidateCompiled();
        this._renderAll();
    },

    /**
     * 把解析好的 AI 文案应用到任意草稿对象（不碰 UI/历史）：
     * summary.caption + 逐元素 caption/text，几何与字段守卫同 _mergeAiReply。
     * @param {Object} draftObj - 目标草稿（this.draft 或编译用克隆）
     * @param {{summary?:{caption?:string}, items?:Array<{caption?:string,text?:string}>}} parsed
     * @returns {{summaryOk: boolean, itemFilled: number, itemTotal: number}} 计数供状态栏
     */
    _applyAiParsed(draftObj, parsed) {
        // items 嵌进 summary 的变形（实测 mimo 出过）先归一到根级
        if (!Array.isArray(parsed?.items) && parsed?.summary && Array.isArray(parsed.summary.items)) {
            parsed = { summary: { caption: parsed.summary.caption }, items: parsed.summary.items };
        }
        const summaryOk = typeof parsed?.summary?.caption === 'string' && parsed.summary.caption.trim() !== '';
        if (summaryOk) draftObj.summary.caption = parsed.summary.caption;

        const itemTotal = draftObj.items.length;
        let itemFilled = 0;
        if (Array.isArray(parsed.items)) {
            draftObj.items.forEach((item, i) => {
                const ai = parsed.items[i] || {};
                if (typeof ai.caption === 'string' && ai.caption.trim()) { item.caption = ai.caption; itemFilled++; }
                if (item.label === 'text' && typeof ai.text === 'string' && ai.text.trim()) {
                    item.text = ai.text;
                }
            });
        }
        return { summaryOk, itemFilled, itemTotal };
    },

    _setAiRunning(running) {
        this.aiRunning = running;
        this.aiBtn.classList.toggle('running', running);
        this.aiBtn.disabled = running;
        this.modelSelectBtn.disabled = running;   // 运行中锁模型切换
        this.skillSelectBtn.disabled = running;   // 与模型同锁（指引在发送时已定格）
    },
});
