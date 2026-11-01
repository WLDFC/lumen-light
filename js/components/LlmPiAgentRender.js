/**
 * ==========================================================================
 * LlmPiAgent 子模块：块渲染与指示器（自 LlmPiAgent.js 拆出）
 * ==========================================================================
 * 作用：pi 回复的 DOM 装配层——可折叠块（思考/工具共用结构）、工具块的
 *       「调用参数/执行结果」分段、文本块、说明块（失败/卡死/进程退出，
 *       附「重新继续」「重启 pi」按钮）、执行中指示器（圆弧 spinner）、
 *       迷你 Markdown 的 DOM 渲染（代码块/标题/列表/表格/分隔线）。
 *       纯决策（时长人话化/摘要化/工具名映射/转义与行内渲染/去重）在
 *       js/utils/PiAgentBlocks.js；事件状态机在主类 LlmPiAgent。
 * 契约：原型混入（partial-class，ADR 026 同款）——本文件末尾 Object.assign
 *       进 LlmPiAgent.prototype，this 即控制器实例；须后于主类文件加载。
 *       安全性：Markdown 渲染先整体转义再按标记切分（mdEscape 是唯一
 *       注入闸），标记以外的内容永不产生 HTML。
 * ==========================================================================
 */

const LlmPiAgentRender = {

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
    },

    /** 在 body 内建一个无标签正文 pre（思考块用） */
    _addSectionContent(parent) {
        const pre = document.createElement('div');
        pre.className = 'pi-block-content';
        parent.appendChild(pre);
        return pre;
    },

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
    },

    /** 填充工具块的"调用参数"分段（懒建；空参数不渲染，避免无意义的 {}） */
    _setToolArgs(b, args) {
        const isEmpty = args === undefined || args === null || args === '' ||
            (typeof args === 'object' && Object.keys(args).length === 0);
        if (isEmpty) return;
        if (!b.argsPre) b.argsPre = this._addSection(b, '调用参数');
        b.argsPre.textContent = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
        if (!b.argsEl.textContent) b.argsEl.textContent = PiAgentBlocks.argsInline(args);
    },

    /** 填充工具块的"执行结果"分段（懒建，自动摘要/折叠 base64） */
    _setToolResult(b, text) {
        if (!b.resultPre) b.resultPre = this._addSection(b, '执行结果');
        b.resultPre.textContent = PiAgentBlocks.summarizeToolOutput(text);
    },

    /** 标记工具块收尾状态（已完成/失败，附耗时） */
    _markToolDone(b, failed) {
        b.done = true;
        b.el.classList.remove('running');
        b.el.classList.add(failed ? 'failed' : 'done');
        const dur = PiAgentBlocks.fmtDuration(Date.now() - (b.startedAt || Date.now()));
        b.meta.textContent = (failed ? '失败 · ' : '已完成 · ') + dur;
    },

    /** 结束思考计时：冻结头部时长并折叠（重复调用无害） */
    _endThinking(b) {
        if (!b || b.thinkingActive === false) return;
        b.thinkingActive = false;
        b.meta.textContent = '持续了 ' + PiAgentBlocks.fmtDuration(Date.now() - (b.startedAt || Date.now()));
        b.el.classList.remove('open');
    },

    /** 秒级 tick：刷新进行中块的头部计时（思考块与运行中工具块） */
    _tickBlocks() {
        if (!this._streaming || !this._wrap) return;
        const now = Date.now();
        for (const b of this._blocks) {
            if (b.type === 'thinking' && b.thinkingActive) {
                b.meta.textContent = '持续了 ' + PiAgentBlocks.fmtDuration(now - b.startedAt);
            } else if (b.type === 'tool' && b.started && !b.done) {
                b.meta.textContent = '运行中 · ' + PiAgentBlocks.fmtDuration(now - b.startedAt);
            }
        }
    },

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
    },

    /** 追加一条说明文本块（错误/进程退出/看门狗收尾共用） */
    _noteBlock(text, isError) {
        const block = this._addTextBlock();
        block.content.textContent = text;
        if (isError && this._wrap) this._wrap.classList.add('error');
        return block;
    },

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
    },

    /** 改写执行中指示器文本（排队/轮询异常等场景） */
    _setRunningText(text) {
        if (this._runningTextEl) this._runningTextEl.textContent = text;
    },

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
    },

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
    },

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
    },

    // ==================== 迷你 Markdown 渲染 ====================
    // pi 底层模型按 Markdown 语法写回答（**粗体** / `代码` / 列表 / 标题），
    // 纯文本裸排会让符号漏出来。这里做零依赖的轻量渲染（对齐 Trae 等
    // 客户端的段落观感）：只覆盖模型回答里实际出现的语法，未覆盖语法
    // 按普通文本降级。转义与行内渲染的纯函数在 PiAgentBlocks。

    /**
     * 把 pi 的 Markdown 回答渲染成 DOM（覆盖：代码块 / 标题 / 有序·无序
     * 列表含两档嵌套 / 分隔线 / 粗体 / 行内代码 / GFM 管道表；表格等
     * 未支持语法整行按普通文本降级）。返回 DocumentFragment，调用方
     * 替换文本块内容。
     * @param {string} src - pi 的原始回答文本
     * @returns {DocumentFragment}
     */
    _renderMarkdown(src) {
        const frag = document.createDocumentFragment();
        const esc = (t) => PiAgentBlocks.mdEscape(t);
        const inline = (t) => PiAgentBlocks.mdInline(esc(t));
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
    },

    /** 把文本块内容替换为 Markdown 渲染结果（定稿时调用；流式中不动）。
     *  同时在块上记录源文本 srcText——收尾去重按它精确比较：渲染后的
     *  textContent 已丢失 markdown 符号（**、- 等），拿它比对原始文本
     *  永远不等，是文本复读漏去重的根因 */
    _renderMarkdownInto(block, text) {
        block.srcText = text;
        block.content.innerHTML = '';
        block.content.appendChild(this._renderMarkdown(text));
    }
};

// 混入主类原型（须后于 LlmPiAgent.js 加载）
Object.assign(LlmPiAgent.prototype, LlmPiAgentRender);
