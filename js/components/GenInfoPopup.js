/**
 * ==========================================================================
 * LumenLight 生成参数弹窗（GenInfoPopup）——「生成同款」按钮的展示层
 * ==========================================================================
 * 选中带生成记录（imageObj.genInfo，见 utils/GenRecord.js）的图片后，
 * 图片工具栏「生成同款」按钮唤出：锚定图片下方弹出（下方空间不足自动
 * 翻到图片上方，左右钳制在视口内），展示模式徽章/来源/时间、正/负面
 * 提示词（负面默认折叠，可复制）、LoRA 清单与动作行——左侧参数
 * （api=行内下拉，comfy/rh=工作流/主模型/步数只读参数块）+ 右侧
 * 仅回填 / 复制 / 白色圆形执行键（行为见 GenReplay）。
 * 视口缩放平移跟随重定位；外点/Esc/图片拖动或缩放时关闭。
 * ==========================================================================
 */

class GenInfoPopup {
    /**
     * @param {Object} canvas - 画布实例（视口坐标换算用）
     */
    constructor(canvas) {
        this.canvas = canvas;
        this.root = null;          // 弹窗根元素（懒创建，挂 body）
        this.image = null;         // 当前展示的画布图片对象
        this._genInfo = null;      // 当前展示的生成参数记录
        this._raf = null;          // 视口跟随重定位的 rAF 句柄
        this._saveTimer = null;    // 编辑后触发重绘（自动保存）的防抖句柄
        this._dropdowns = [];      // 行内参数下拉实例（api/comfy 模式，重开时重建）
        this._workflowOptions = []; // comfy 工作流下拉当前清单（onPick 查 label 用）
        this._listenersBound = false;  // 全局监听只绑一次（单例组件）
    }

    /**
     * 打开弹窗（重复调用 = 换图重渲染并重新定位）
     * @param {Object} image - 带生成记录的画布图片对象
     */
    open(image) {
        if (!image || !image.genInfo) return;
        this.image = image;
        this._genInfo = image.genInfo;
        // 上一轮的行内下拉实例随 innerHTML 重建而失效：先摘干净（菜单/监听）
        this._dropdowns.forEach((dd) => { try { dd.destroy(); } catch (e) { /* 忽略 */ } });
        this._dropdowns = [];
        if (!this.root) {
            this.root = document.createElement('div');
            this.root.className = 'gen-info-popup';
            document.body.appendChild(this.root);
        }
        this.root.innerHTML = this._render(image.genInfo);
        this.root.style.display = 'block';
        this._bindActions();
        this._position();
        if (!this._listenersBound) {
            this._bindGlobalListeners();
            this._listenersBound = true;
        }
    }

    /** 关闭弹窗（保留 DOM，仅隐藏——下次 open 重渲染；待落盘的编辑防抖立即结算） */
    close() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
            this.canvas?.draw();   // 有未结算的编辑：立刻给实时保存发脏标记
        }
        if (this.root) this.root.style.display = 'none';
        this.image = null;
        this._genInfo = null;
    }

    /** 是否打开中 */
    get isOpen() {
        return !!(this.root && this.root.style.display === 'block');
    }

    /**
     * 渲染弹窗内容（innerHTML 模板一次成型）
     * @param {Object} info - 生成参数记录
     * @returns {string}
     */
    _render(info) {
        const esc = LumenLight.escapeHtml;
        const mode = GenRecord.modeLabel(info.mode);
        const source = info.sourceNodeTitle || '未知来源';

        const head = `
            <div class="gi-head">
                <span class="gi-badge gi-badge-${esc(info.mode)}">${esc(mode)}</span>
                <span class="gi-source" title="生成来源">${esc(source)}</span>
                <span class="gi-time">${esc(GenRecord.formatTime(info.time))}</span>
            </div>`;

        const sec = (title, copyKey, body) => {
            const head = (title || copyKey)
                ? `<div class="gi-sec-head">${title ? `<span class="gi-sec-title">${esc(title)}</span>` : ''}${copyKey ? `<button type="button" class="gi-copy" data-copy="${copyKey}">复制</button>` : ''}</div>`
                : '';
            return `<div class="gi-sec">${head}${body}</div>`;
        };

        // 正面提示词不设小标题、复制钮移到动作行（仅回填右侧）；
        // 负面提示词保留标题与复制钮以作区分
        const promptSec = info.positive !== undefined && info.positive !== null
            ? sec('', null,
                `<textarea class="gi-prompt" data-prompt="positive" spellcheck="false">${esc(info.positive)}</textarea>`)
            : '';
        // 负面提示词独立成折叠区（.gi-neg）：默认收起只留标题条，
        // 点标题条展开——负面词通常长且非焦点，避免撑高弹窗（展开/
        // 收起绑定见 _bindActions；标题条不放复制钮——动作行已有复制，
        // 负面词需要时展开全选复制即可）
        const negSec = info.negative
            ? `<div class="gi-sec gi-neg gi-neg-collapsed">
                <div class="gi-sec-head">
                    <button type="button" class="gi-neg-toggle" title="展开/收起负面提示词">
                        <svg class="gi-neg-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                        <span class="gi-sec-title">负面提示词</span>
                    </button>
                </div>
                <textarea class="gi-prompt" data-prompt="negative" spellcheck="false">${esc(info.negative)}</textarea>
            </div>`
            : '';

        // 动作行左侧参数位：api=行内下拉占位（模型/比例/尺寸档）；comfy=
        // 工作流下拉 + 主模型下拉 + 步数输入（均可编辑，回放按编辑后值
        // 执行，绑定见 _bindComfyEditors）；rh=只读参数块（回放不消费
        // 记录编辑——参数随来源节点保留）
        let paramSlots = '';
        if (info.mode === 'api') {
            paramSlots = `
                <button type="button" class="gi-dd gi-dd-model" aria-haspopup="listbox" title="生图模型"></button>
                <button type="button" class="gi-dd gi-dd-ratio" aria-haspopup="listbox" title="画面比例"></button>
                <button type="button" class="gi-dd gi-dd-tier" aria-haspopup="listbox" title="分辨率档位"></button>`;
        } else if (info.mode === 'comfy') {
            paramSlots = `
                <button type="button" class="gi-dd gi-dd-workflow" aria-haspopup="listbox" title="工作流"></button>
                <button type="button" class="gi-dd gi-dd-checkpoint" aria-haspopup="listbox" title="主模型"></button>
                <input type="number" class="gi-num gi-num-steps" min="1" step="1" title="步数" value="${esc(info.params?.steps ?? '')}">`;
        } else {
            paramSlots = GenRecord.describeRows(info).slice(0, 3)
                .map((r) => `<span class="gi-param" title="${esc(r.label)}：${esc(r.value)}">${esc(r.value)}</span>`)
                .join('');
        }

        const loraRows = (info.loras && info.loras.length)
            ? info.loras.map((l) => {
                const text = GenRecord.loraText(l);
                return `<div class="gi-lora-row" title="${esc(text)}">${esc(text)}</div>`;
            }).join('')
            : '';
        const loraSec = loraRows
            ? `<div class="gi-sec"><div class="gi-sec-head"><span class="gi-sec-title">LoRA（${info.loras.length}）</span></div>${loraRows}</div>`
            : '';

        // 动作区：三种模式同一行布局——左侧参数（api=行内下拉，comfy=
        // 可编辑下拉/输入，rh=只读参数块），右侧仅回填 + 复制 + 圆形执行键
        // （提示词节点同款白圆箭头推到行尾）
        const foot = `
            <div class="gi-actions-row">
                ${paramSlots}
                <button type="button" class="gi-btn" data-action="fill">仅回填</button>
                <button type="button" class="gi-copy" data-copy="positive" title="复制正面提示词">复制</button>
                <button type="button" class="gi-run" data-action="regen" title="生成同款（按当前参数重新生成）">
                    <svg class="run-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                </button>
            </div>`;

        return `
            ${head}
            ${promptSec}
            ${negSec}
            ${loraSec}
            ${foot}`;
    }

    /** 绑定弹窗内交互（提示词编辑 / 参数下拉 / 复制 / 生成同款 / 仅回填） */
    _bindActions() {
        // 提示词编辑：输入即时写回图片的生成参数记录（this._genInfo 即
        // imageObj.genInfo，同引用就地改）——生成同款/仅回填/复制据此执行
        this.root.querySelectorAll('textarea.gi-prompt').forEach((ta) => {
            ta.addEventListener('input', () => {
                if (!this._genInfo) return;
                this._genInfo[ta.dataset.prompt] = ta.value;
                this._touchDirty();
            });
        });

        // api 模式行内参数下拉（模型/比例/尺寸档）：改动同样即时写回记录
        if (this._genInfo?.mode === 'api') this._bindApiDropdowns();
        // comfy 模式行内编辑器（工作流/主模型下拉 + 步数输入）
        if (this._genInfo?.mode === 'comfy') this._bindComfyEditors();

        // 负面提示词折叠区：点标题条收起/展开；高度变化后重定位
        // （锚点关系不变，只是换算基准的弹窗高度变了）
        this.root.querySelector('.gi-neg-toggle')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const neg = e.currentTarget.closest('.gi-neg');
            neg.classList.toggle('gi-neg-collapsed');
            this._position();
        });

        this.root.querySelectorAll('.gi-copy').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const key = btn.dataset.copy;
                const text = key === 'positive'
                    ? (this._genInfo?.positive || '')
                    : (this._genInfo?.negative || '');
                GenInfoPopup._copyText(text, btn);
            });
        });

        const regen = this.root.querySelector('[data-action="regen"]');
        const fill = this.root.querySelector('[data-action="fill"]');
        if (regen) {
            regen.addEventListener('click', async (e) => {
                e.stopPropagation();
                const info = this._genInfo;
                this.close();
                await GenReplay.apply(info, { run: true });
            });
        }
        if (fill) {
            fill.addEventListener('click', async (e) => {
                e.stopPropagation();
                const info = this._genInfo;
                this.close();
                await GenReplay.apply(info, { run: false });
            });
        }
    }

    /**
     * api 模式行内参数下拉（LumenDropdown 预制件，聊天工具栏/提示词节点
     * 同款交互）：模型=配置清单里的生图模型（异步拉取），比例/尺寸档=
     * LlmResolution 静态清单。改动即时写回 _genInfo（回放按编辑后值执行）
     */
    _bindApiDropdowns() {
        const info = this._genInfo;

        // 比例 / 分辨率档位：静态清单（与聊天窗口尺寸选择同数据源）
        this._mkDropdown(this.root.querySelector('.gi-dd-ratio'), '比例',
            LlmResolution.getSizeOptions()
                .map((r) => ({ value: r, label: r === 'auto' ? '自动' : r })),
            info.ratio || 'auto',
            (v) => { this._genInfo.ratio = v; });
        this._mkDropdown(this.root.querySelector('.gi-dd-tier'), '尺寸',
            LlmResolution.getResolutionTiers()
                .map((t) => ({ value: t.label, label: t.label })),
            info.tier || '2K',
            (v) => { this._genInfo.tier = v; });

        // 模型：先给占位清单（至少含记录值，保证当前选择可见），异步拉到
        // 配置清单后刷新——弹窗可能已换图/关闭，回填前核对实例仍存活
        const modelDd = this._mkDropdown(this.root.querySelector('.gi-dd-model'), '模型',
            this._fallbackModelOptions(info), info.model,
            (v) => { this._genInfo.model = v; });
        if (modelDd) {
            this._loadImageModelOptions().then((options) => {
                if (!this.isOpen || !this._dropdowns.includes(modelDd)) return;
                modelDd.setOptions(options, this._genInfo?.model);
            });
        }
    }

    /**
     * comfy 模式行内编辑器：工作流下拉（/api/workflows 清单）+ 主模型
     * 下拉（/api/comfy-node/models 的 checkpoints 清单）+ 步数数字输入。
     * 改动即时写回 _genInfo——GenReplay._applyComfy 回填/执行按编辑后值
     * （工作流按 workflowId 重选、主模型写入面板加载器、步数进 params）。
     * 下拉清单异步拉取：先给占位清单（至少含记录值，保证当前选择可见），
     * 拉到后刷新——弹窗可能已换图/关闭，回填前核对实例仍存活
     */
    _bindComfyEditors() {
        const info = this._genInfo;
        this._workflowOptions = this._fallbackWorkflowOptions(info);

        const wfDd = this._mkDropdown(this.root.querySelector('.gi-dd-workflow'), '工作流',
            this._workflowOptions, info.workflowId || '',
            (v) => {
                const opt = this._workflowOptions.find((o) => o.value === v);
                this._genInfo.workflowId = v;
                this._genInfo.workflowName = opt ? opt.label : v;
            });
        this._loadWorkflowOptions().then((options) => {
            if (!this.isOpen || !this._dropdowns.includes(wfDd)) return;
            wfDd.setOptions(options, this._genInfo?.workflowId);
        });

        const ckptDd = this._mkDropdown(this.root.querySelector('.gi-dd-checkpoint'), '主模型',
            this._fallbackCheckpointOptions(info), info.model || '',
            (v) => { this._genInfo.model = v; });
        this._loadCheckpointOptions().then((options) => {
            if (!this.isOpen || !this._dropdowns.includes(ckptDd)) return;
            ckptDd.setOptions(options, this._genInfo?.model);
        });

        // 步数：自由数字输入（清空 = 回工作流模板值语义，params.steps=null）
        const stepsInput = this.root.querySelector('.gi-num-steps');
        if (stepsInput) {
            stepsInput.addEventListener('input', () => {
                if (!this._genInfo) return;
                const v = parseInt(stepsInput.value, 10);
                this._genInfo.params = this._genInfo.params || {};
                this._genInfo.params.steps = Number.isFinite(v) ? v : null;
                this._touchDirty();
            });
        }
    }

    /** 行内下拉工厂：创建 LumenDropdown 并登记（open 重渲染时统一销毁） */
    _mkDropdown(el, placeholder, options, selected, onPick) {
        if (!el) return null;
        const dd = new LumenDropdown(el, {
            placeholder,
            onChange: (v) => {
                if (this._genInfo) onPick(v);
                this._touchDirty();
            }
        });
        dd.setOptions(options, selected);
        this._dropdowns.push(dd);
        return dd;
    }

    /** 拉取工作流清单（口径与面板工作流下拉一致）；记录值不在清单时补进去 */
    async _loadWorkflowOptions() {
        try {
            const response = await fetch('/api/workflows');
            const result = await response.json();
            const options = (result.workflows || []).map((wf) => ({
                value: wf.id,
                label: wf.name || wf.id
            }));
            const cur = this._genInfo?.workflowId;
            if (cur && !options.some((o) => o.value === cur)) {
                options.unshift({
                    value: cur,
                    label: `${this._genInfo?.workflowName || cur}（记录）`
                });
            }
            if (options.length) {
                this._workflowOptions = options;
                return options;
            }
        } catch (err) {
            console.warn('拉取工作流清单失败（弹窗内工作流下拉回落占位清单）:', err);
        }
        this._workflowOptions = this._fallbackWorkflowOptions(this._genInfo);
        return this._workflowOptions;
    }

    /** 拉取 ComfyUI checkpoints 清单（口径与面板主模型下拉一致） */
    async _loadCheckpointOptions() {
        try {
            const response = await fetch('/api/comfy-node/models');
            const data = await response.json();
            const options = (data.checkpoints || []).map((c) => ({ value: c, label: c }));
            const cur = this._genInfo?.model;
            if (cur && !options.some((o) => o.value === cur)) {
                options.unshift({ value: cur, label: `${cur}（记录）` });
            }
            if (options.length) return options;
        } catch (err) {
            console.warn('拉取 Comfy 模型清单失败（弹窗内主模型下拉回落占位清单）:', err);
        }
        return this._fallbackCheckpointOptions(this._genInfo);
    }

    /** 占位工作流清单：只含记录值（接口失败/无配置时的兜底） */
    _fallbackWorkflowOptions(info) {
        const id = info?.workflowId;
        return id ? [{ value: id, label: info?.workflowName || id }] : [];
    }

    /** 占位主模型清单：只含记录值 */
    _fallbackCheckpointOptions(info) {
        const cur = info?.model;
        return cur ? [{ value: cur, label: cur }] : [];
    }

    /** 拉取配置清单里的生图模型（口径与聊天窗口 loadModels 一致） */
    async _loadImageModelOptions() {
        try {
            const response = await fetch('/api/settings');
            const result = await response.json();
            const api = result.settings?.api || {};
            const { models, providerCount } = LumenLight.collectConfiguredModels(api);
            // 只保留生图模型（分类口径与画布 API 生图节点/LLM 窗口三分类
            // 统一，见 LumenLight.classifyModel）
            const imageModels = models.filter((m) => LumenLight.classifyModel(m) === 'image');
            const options = imageModels.map((m) => ({
                value: m.key,
                label: providerCount > 1
                    ? `${m.displayName || m.id} · ${m.provider}`
                    : (m.displayName || m.id)
            }));
            // 记录的模型不在当前清单（已删除/清单未刷新）时补进去：
            // 当前值必须始终可见可选，否则触发器只显示占位符
            const cur = this._genInfo?.model;
            if (cur && !options.some((o) => o.value === cur)) {
                options.unshift({
                    value: cur,
                    label: `${LumenLight.parseModelKey(cur).id}（记录）`
                });
            }
            if (options.length) return options;
        } catch (err) {
            console.warn('拉取生图模型清单失败（弹窗内模型下拉回落占位清单）:', err);
        }
        return this._fallbackModelOptions(this._genInfo);
    }

    /** 占位模型清单：只含记录值（接口失败/无配置时的兜底） */
    _fallbackModelOptions(info) {
        const cur = info?.model;
        return cur
            ? [{ value: cur, label: LumenLight.parseModelKey(cur).id }]
            : [];
    }

    /** 编辑脏标记（防抖）：触发一次重绘让实时保存捕获变更（改稿随画布落盘） */
    _touchDirty() {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this.canvas?.draw();
        }, 600);
    }

    /**
     * 定位：图片包围盒屏幕坐标下方居中；下方放不下翻到上方，
     * 左右钳制在视口内（与工具栏同一套坐标换算）
     */
    _position() {
        if (!this.root || !this.image || !this.canvas?.viewport) return;
        const rect = this.canvas.canvas.getBoundingClientRect();
        const tl = this.canvas.viewport.canvasToScreen(this.image.x, this.image.y);
        const br = this.canvas.viewport.canvasToScreen(
            this.image.x + this.image.width,
            this.image.y + this.image.height
        );
        const left = rect.left + tl.x;
        const top = rect.top + tl.y;
        const w = br.x - tl.x;
        const h = br.y - tl.y;
        const pw = this.root.offsetWidth;
        const ph = this.root.offsetHeight;
        const gap = 30;   // 让过图片下方的尺寸标签（与工具栏间距同口径）

        let x = left + (w - pw) / 2;
        let y = top + h + gap;
        if (y + ph > window.innerHeight - 8) {
            // 下方放不下：翻到图片上方；上方也放不下则贴视口底部
            const above = top - ph - gap;
            y = above >= 8 ? above : Math.max(8, window.innerHeight - ph - 8);
        }
        x = Math.max(8, Math.min(x, window.innerWidth - pw - 8));
        this.root.style.left = `${Math.round(x)}px`;
        this.root.style.top = `${Math.round(y)}px`;
    }

    /** 全局监听（单例只绑一次）：外点/Esc/视口变化/图片拖动缩放 */
    _bindGlobalListeners() {
        // 外点关闭：点在弹窗内不关（复制/动作按钮）；行内参数下拉的菜单
        // 挂 body（.lumen-dropdown-menu），点菜单选项同样不算外点——否则
        // mousedown 先把弹窗关掉，选项的 click 永远等不到；工具栏点击由
        // ImageToolbar 侧排除（点「生成同款」按钮=关了再开，表现即开合）
        document.addEventListener('mousedown', (e) => {
            if (!this.isOpen) return;
            if (this.root.contains(e.target)) return;
            if (e.target.closest?.('.lumen-dropdown-menu')) return;
            this.close();
        });
        // 视口缩放平移跟随（rAF 节流，与工具栏同口径）
        window.addEventListener('canvasViewportChanged', () => {
            if (!this.isOpen) return;
            if (this._raf) cancelAnimationFrame(this._raf);
            this._raf = requestAnimationFrame(() => this._position());
        });
        window.addEventListener('resize', () => {
            if (this.isOpen) this._position();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !this.isOpen) return;
            // 焦点在提示词编辑框里：第一下 Esc 只是退出编辑（失焦），
            // 再按才关弹窗——避免改稿时误关
            if (e.target?.classList?.contains('gi-prompt')) {
                e.target.blur();
                return;
            }
            this.close();
        });
        // 图片拖动/缩放开始时随工具栏一起收起
        window.addEventListener('canvasImageDragStart', () => {
            if (this.isOpen) this.close();
        });
        window.addEventListener('canvasImageResizeStart', () => {
            if (this.isOpen) this.close();
        });
    }

    /**
     * 复制文本到剪贴板（Clipboard API 优先，失败回落 execCommand）
     * @param {string} text
     * @param {HTMLElement} [btn] - 触发按钮（成功后短暂显示「已复制」）
     */
    static async _copyText(text, btn) {
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
        } catch (err) {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
            ta.remove();
        }
        if (btn) {
            btn.textContent = '已复制';
            setTimeout(() => { btn.textContent = '复制'; }, 1200);
        }
    }
}

// 导出为全局变量，供其他模块使用
window.GenInfoPopup = GenInfoPopup;
