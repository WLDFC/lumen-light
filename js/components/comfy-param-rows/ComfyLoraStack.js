/**
 * ==========================================================================
 * LumenLight Comfy 参数行 — LoRA 叠加区混入（ComfyLoraStack）
 * ==========================================================================
 * 从 ComfyParamRows.js 拆出的 LoRA 域（ADR 083）：叠加区 UI 渲染与事件绑定、
 * 用户条目生命周期与 localStorage 持久化、生效条目导出、LoRA 封面选择器
 * 挂载（.lfs-host，画布节点行与面板叠加区共用）。
 *
 * 契约（同 manga-editor 混入模式，ADR 026）：
 *   - 本文件方法 Object.assign 回 ComfyParamRows.prototype，this 即实例，
 *     调用点与测试契约（Object.create(prototype) + 实例打桩）零改动；
 *   - 加载顺序：必须在 ComfyParamRows.js 之后、任何实例化（ComfyGenNode.js /
 *     PromptPanel.js）之前（index.html 中紧随主文件插入）；
 *   - 状态仍归属实例（this.loras / this.state.loraStrengths /
 *     this.deletedLoraIds / this.loraStackCollapsed），本文件只带行为不带
 *     状态；构造器经 _initLoraStackState() 无条件初始化这些字段（画布节点
 *     实例同样走一遍，与拆分前行为一致）；
 *   - 内嵌条目（工作流模板 lora）的状态写 state.models / state.loraEnabled /
 *     state.loraStrengths 与 deletedLoraIds（主类持有，随 overrides 注入），
 *     本文件负责它们在叠加区的 UI 呈现（文件/强度/启停/删除）；
 *   - 强度清洗复用主类 static ComfyParamRows._clampStrength（运行时经全局
 *     类引用，主文件先加载故可用）。
 * ==========================================================================
 */

Object.assign(window.ComfyParamRows.prototype, {

    /**
     * LoRA 叠加域实例状态初始化（构造器无条件调用，画布节点实例同样走一遍，
     * 与拆分前行为一致）。独立于 this.state：叠加堆栈不随工作流切换重置
     * （resetOnWorkflowChange 不影响它），也不进入画布节点的存档字段——
     * 它是面板侧的用户附加选择，跨工作流保留，且跨 F5/重启持久化
     * （localStorage comfyLoraStack，2026-11-08 用户需求：刷新后加载的
     * LoRA 不丢；恢复后清单到位经 healEntries 补归一）。
     * 条目结构与画布 LoraNode 一致：{id, file, strengthModel, strengthClip}，
     * file 为空 = 此条不生效（提交时过滤）
     */
    _initLoraStackState() {
        this.loras = this._loadLoraStack();

        // 工作流模板内嵌 lora 的删除记录（loraStack 模式）：条目随工作流
        // 探测生成，删除 = 提交时 bypass 剔除节点（bypassLoras 参数，后端
        // applyBypass 直通重连）。仅内存记录——重新加载工作流（切换/刷新
        // 后恢复选中）即自动恢复内嵌 lora，无持久化
        this.workflowId = null;
        this.deletedLoraIds = new Set();

        // 叠加区折叠状态（与提示词框同机制，记忆在 localStorage，默认折叠）
        this.loraStackCollapsed = localStorage.getItem('comfyLoraStackCollapsed') !== 'false';
    },

    /**
     * 初始化 LoRA 封面选择器挂载点（.lfs-host）：
     * - 内嵌条目（data-node-id）：组件先建空壳，随后 _bindDynamicRows →
     *   _fillModelSelect 经 el._lfs.setFiles 灌清单与选中值
     * - 用户自加条目（data-entry-id）：此处直接喂清单与当前值
     */
    _initLoraFileSelects() {
        const hosts = this.container.querySelectorAll('.lfs-host');
        if (hosts.length === 0) return;
        const files = (this.modelLists && this.modelLists.loras) || [];
        hosts.forEach((el) => {
            if (el.dataset.nodeId) {
                new LoraFileSelect(el, {
                    files,
                    value: this.state.models[el.dataset.nodeId] || '',
                    allowEmpty: false
                });
            } else if (el.dataset.entryId) {
                const entry = this.loras.find((en) => en.id === el.dataset.entryId);
                new LoraFileSelect(el, {
                    files,
                    value: entry ? entry.file : '',
                    allowEmpty: true,
                    emptyLabel: '-- 选择 LoRA 文件 --'
                });
            }
        });
    },

    /**
     * 清单就绪后自动补归一（ADR 028 决策四）：离线期间投递的条目按原
     * 路径入栈，清单到位后回扫唯一文件名匹配的条目就地更正，避免
     * 「先投递后开 ComfyUI」的时机差残留成永远的不在清单
     * （setModelLists 调用，本方法不做 loraStack 门控——与拆分前一致）
     */
    _healLoraStackEntries() {
        const healed = window.LoraSendPopup?.healEntries?.(this.loras, this.modelLists.loras);
        if (healed > 0) {
            console.info(`[LoRA叠加区] ${healed} 只历史条目已按 ComfyUI 清单自动更正路径`);
            window.socket?.showNotification?.(`${healed} 只历史 LoRA 已自动更正为 ComfyUI 清单路径`, 4000);
        }
    },

    /**
     * 叠加区当前生效条数：内嵌条目（未删除且未取消勾选）+ 用户条目
     * （选了文件且未取消勾选）。标题栏徽标用
     * @returns {number}
     */
    _loraStackActiveCount() {
        let n = 0;
        if (this.detected) {
            for (const loader of this.detected.loaders) {
                if (loader.kind === 'lora' && !this.deletedLoraIds.has(loader.nodeId) &&
                    this.state.loraEnabled[loader.nodeId] !== false) {
                    n++;
                }
            }
        }
        n += this.loras.filter((e) => e.file && e.enabled !== false).length;
        return n;
    },

    /**
     * 渲染 LoRA 叠加区 HTML：折叠标题栏（含生效条数徽标）+ 条目列表 + 添加按钮。
     * 条目两类：
     *   - 内嵌条目（is-embedded，带「模板」标签）：来自工作流模板扫描出的
     *     lora 加载节点——文件下拉/启用勾选复用动态行绑定（data-node-id，
     *     写 state.models / state.loraEnabled 经 overrides 注入），强度输入
     *     写 state.loraStrengths；X = 删除（提交时 bypass 剔除节点，可恢复）；
     *   - 用户条目：点「+ 添加 LoRA」追加的独立叠加项，经 getLoras() 随
     *     提交交给后端 injectLoraChain 追加在模板 lora 之后。
     * 样式复用面板参数行规格
     * @returns {string} HTML 片段
     */
    _renderLoraStack() {
        const s = this.state;

        // 内嵌条目（已删除的不渲染）
        const embeddedLoaders = this.detected
            ? this.detected.loaders.filter((l) => l.kind === 'lora' && !this.deletedLoraIds.has(l.nodeId))
            : [];
        const embeddedHtml = embeddedLoaders.map((loader) => {
            const nodeId = LumenLight.escapeHtml(loader.nodeId);
            const off = s.loraEnabled[loader.nodeId] === false;
            const st = s.loraStrengths[loader.nodeId] || {};
            const hasM = loader.strengthFields.includes('strength_model');
            const hasC = loader.strengthFields.includes('strength_clip');
            const mVal = st.strengthModel !== undefined ? st.strengthModel : loader.strengths.strength_model;
            const cVal = st.strengthClip !== undefined ? st.strengthClip : loader.strengths.strength_clip;
            // 强度区：两个都有 → 并排行；只有其一时单行；无字面强度 → 不渲染
            // （强度是连线输入的模板 lora 只能换文件/删除，强度走工作流原值）
            let strengthHtml = '';
            if (hasM && hasC) {
                strengthHtml = `
                    <div class="comfy-param-pair">
                        <div class="comfy-param-row">
                            <div class="comfy-param-label">模型强度</div>
                            <input type="number" class="comfy-num-input comfy-lorastack-strength-model"
                                   min="-5" max="5" step="0.05" value="${mVal}"
                                   title="模型强度（strength_model）">
                        </div>
                        <div class="comfy-param-row">
                            <div class="comfy-param-label">CLIP强度</div>
                            <input type="number" class="comfy-num-input comfy-lorastack-strength-clip"
                                   min="-5" max="5" step="0.05" value="${cVal}"
                                   title="CLIP 强度（strength_clip）">
                        </div>
                    </div>`;
            } else if (hasM || hasC) {
                strengthHtml = `
                    <div class="comfy-param-row">
                        <div class="comfy-param-label">${hasM ? '模型强度' : 'CLIP强度'}</div>
                        <input type="number" class="comfy-num-input ${hasM ? 'comfy-lorastack-strength-model' : 'comfy-lorastack-strength-clip'}"
                               min="-5" max="5" step="0.05" value="${hasM ? mVal : cVal}"
                               title="${hasM ? '模型强度（strength_model）' : 'CLIP 强度（strength_clip）'}">
                    </div>`;
            }
            // 无字面强度字段时无法软关闭，不出启用勾选（删除仍可用）
            const checkboxHtml = loader.strengthFields.length > 0
                ? `<input type="checkbox" class="comfy-lora-enable-input comfy-lorastack-enable"
                          data-node-id="${nodeId}"
                          title="勾选后此条 LoRA 生效；取消勾选则注入强度 0 关闭（不影响已填的强度值）"${off ? '' : ' checked'}>`
                : '';
            return `
                <div class="comfy-lorastack-entry is-embedded${off ? ' is-off' : ''}" data-node-id="${nodeId}">
                    <div class="comfy-param-row">
                        <div class="comfy-param-label">lora<span class="comfy-lorastack-tag">模板</span></div>
                        <div class="comfy-lorastack-head">
                            <div class="llm-model-select comfy-model-select comfy-lorastack-file lfs-host" data-node-id="${nodeId}" title="模板内嵌 LoRA 文件（工作流自带，可更换，点开看封面）"></div>
                            ${checkboxHtml}
                            <button type="button" class="comfy-lorastack-remove" title="删除此模板 LoRA（提交时从工作流剔除；重新加载工作流后恢复）">✕</button>
                        </div>
                    </div>
                    ${strengthHtml}
                </div>
            `;
        }).join('');

        const userEntriesHtml = this.loras.map((entry) => `
            <div class="comfy-lorastack-entry${entry.enabled === false ? ' is-off' : ''}" data-entry-id="${LumenLight.escapeHtml(entry.id)}">
                <div class="comfy-param-row">
                    <div class="comfy-param-label">lora</div>
                        <div class="comfy-lorastack-head">
                            <div class="llm-model-select comfy-model-select comfy-lorastack-file lfs-host" data-entry-id="${LumenLight.escapeHtml(entry.id)}" title="LoRA 文件（选空则此条不生效，点开看封面）"></div>
                            <input type="checkbox" class="comfy-lorastack-enable"
                                   title="勾选后此条 LoRA 生效；取消勾选则提交时跳过（不影响已填的强度值）"${entry.enabled === false ? '' : ' checked'}>
                            <button type="button" class="comfy-lorastack-remove" title="删除此 LoRA">✕</button>
                        </div>
                </div>
                <div class="comfy-param-pair">
                    <div class="comfy-param-row">
                        <div class="comfy-param-label">模型强度</div>
                        <input type="number" class="comfy-num-input comfy-lorastack-strength-model"
                               min="-5" max="5" step="0.05" value="${entry.strengthModel}"
                               title="模型强度（strength_model）">
                    </div>
                    <div class="comfy-param-row">
                        <div class="comfy-param-label">CLIP强度</div>
                        <input type="number" class="comfy-num-input comfy-lorastack-strength-clip"
                               min="-5" max="5" step="0.05" value="${entry.strengthClip}"
                               title="CLIP 强度（strength_clip）">
                    </div>
                </div>
            </div>
        `).join('');

        // 空态：无内嵌条目且无用户条目
        const emptyHtml = (embeddedLoaders.length === 0 && this.loras.length === 0)
            ? `<div class="comfy-lorastack-empty">暂无 LoRA，点下方按钮添加；叠加的 LoRA 会作用于当前工作流的生成结果</div>`
            : '';

        return `
            <div class="comfy-lorastack collapsible${this.loraStackCollapsed ? ' collapsed' : ''}">
                <div class="comfy-lorastack-topbar">
                    <div class="collapsible-header comfy-lorastack-header" title="点击展开/收起 LoRA 叠加列表">
                        <span class="comfy-param-label">LoRA 叠加${this._loraStackActiveCount() > 0 ? `（${this._loraStackActiveCount()}）` : ''}</span>
                        <button type="button" class="collapse-toggle" aria-label="展开/收起 LoRA 叠加">▶</button>
                    </div>
                    <button type="button" class="comfy-lorastack-triggers"
                            title="管理 LoRA 触发词（按 Civitai 触发词开关与权重，自动写入正面提示词框末尾）"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83z"/><line x1="7" y1="7" x2="7.01" y2="7.01"/></svg>触发词</button>
                </div>
                <div class="collapsible-body comfy-lorastack-body">
                    ${embeddedHtml}
                    ${userEntriesHtml}
                    ${emptyHtml}
                    <button type="button" class="comfy-lorastack-add" title="添加一条 LoRA">+ 添加 LoRA</button>
                </div>
            </div>
        `;
    },

    /**
     * 绑定叠加区事件（每次 render 重建 DOM 后调用，绑定在新建的区块元素上，
     * 不挂在 container 上避免重渲染累积监听器）：
     *   - 标题栏点击：折叠/展开（▶/▼ 箭头 + localStorage 记忆，同提示词框）
     *   - change 委托：文件选择（选空 = 不生效，同步徽标计数）/ 强度修改
     *   - click 委托：删除条目 / 添加条目（重建列表）
     */
    _bindLoraStack() {
        if (!this.loraStack) return;
        const section = this.container.querySelector('.comfy-lorastack');
        if (!section) return;

        // 折叠切换：与提示词框一致——整条标题栏可点，箭头随状态翻转
        const header = section.querySelector('.comfy-lorastack-header');
        header.addEventListener('click', () => {
            this.loraStackCollapsed = !section.classList.contains('collapsed');
            section.classList.toggle('collapsed', this.loraStackCollapsed);
            const toggle = header.querySelector('.collapse-toggle');
            toggle.textContent = this.loraStackCollapsed ? '▶' : '▼';
            localStorage.setItem('comfyLoraStackCollapsed', String(this.loraStackCollapsed));
        });
        // 渲染后同步一次箭头方向（默认折叠态）
        header.querySelector('.collapse-toggle').textContent =
            this.loraStackCollapsed ? '▶' : '▼';

        // 「触发词」按钮：唤出触发词管理器弹窗（监听方为 LoraTriggerManager）。
        // 按钮在 topbar 上、折叠标题栏之外（独立按钮不叠在 lora 栏里），
        // 不会触发标题栏的折叠点击，无需再挡冒泡
        const triggersBtn = section.querySelector('.comfy-lorastack-triggers');
        if (triggersBtn) {
            triggersBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                document.dispatchEvent(new CustomEvent('lumen-lora-triggers-open'));
            });
        }

        // 条目修改（事件委托，直接改状态不重建 DOM，保持输入焦点）。
        // 内嵌条目（data-node-id）与用户条目（data-entry-id）分流：
        // 内嵌条目的文件/勾选由动态行绑定处理，这里只接强度输入
        section.addEventListener('change', (e) => {
            const entryEl = e.target.closest('.comfy-lorastack-entry');
            if (!entryEl) return;

            if (entryEl.dataset.nodeId) {
                // 内嵌条目：强度改值写 state.loraStrengths（overrides 注入）
                const nodeId = entryEl.dataset.nodeId;
                const loader = this.detected?.loaders.find((l) => l.nodeId === nodeId);
                if (e.target.classList.contains('comfy-lorastack-strength-model')) {
                    const st = this.state.loraStrengths[nodeId] = this.state.loraStrengths[nodeId] || {};
                    st.strengthModel = ComfyParamRows._clampStrength(
                        e.target.value, st.strengthModel ?? loader?.strengths?.strength_model ?? 1);
                    e.target.value = st.strengthModel;
                } else if (e.target.classList.contains('comfy-lorastack-strength-clip')) {
                    const st = this.state.loraStrengths[nodeId] = this.state.loraStrengths[nodeId] || {};
                    st.strengthClip = ComfyParamRows._clampStrength(
                        e.target.value, st.strengthClip ?? loader?.strengths?.strength_clip ?? 1);
                    e.target.value = st.strengthClip;
                }
                return;
            }

            const entry = this.loras.find((en) => en.id === entryEl.dataset.entryId);
            if (!entry) return;

            if (e.target.classList.contains('comfy-lorastack-file')) {
                entry.file = e.target.value;
                this._updateLoraStackCount();
                this._emitLoraStackChanged();
                this._persistLoraStack();
            } else if (e.target.classList.contains('comfy-lorastack-enable')) {
                // 启用勾选：就地改状态与置灰态，不重建 DOM（保持焦点/滚动）
                entry.enabled = e.target.checked;
                entryEl.classList.toggle('is-off', !entry.enabled);
                this._updateLoraStackCount();
                this._emitLoraStackChanged();
                this._persistLoraStack();
            } else if (e.target.classList.contains('comfy-lorastack-strength-model')) {
                entry.strengthModel = ComfyParamRows._clampStrength(e.target.value, entry.strengthModel);
                e.target.value = entry.strengthModel;
                this._persistLoraStack();
            } else if (e.target.classList.contains('comfy-lorastack-strength-clip')) {
                entry.strengthClip = ComfyParamRows._clampStrength(e.target.value, entry.strengthClip);
                e.target.value = entry.strengthClip;
                this._persistLoraStack();
            }
        });

        // 删除 / 添加 / 恢复（重建列表，与画布 LoraNode.renderEntries 同策略）
        section.addEventListener('click', (e) => {
            const removeBtn = e.target.closest('.comfy-lorastack-remove');
            if (removeBtn) {
                const entryEl = removeBtn.closest('.comfy-lorastack-entry');
                if (entryEl && entryEl.dataset.nodeId) {
                    // 内嵌条目删除：记录节点 id（提交时后端 bypass 剔除），
                    // 重建列表；重新加载工作流后自动恢复
                    this._deleteEmbeddedLora(entryEl.dataset.nodeId);
                    this.render();
                    return;
                }
                this.loras = this.loras.filter((en) => en.id !== entryEl.dataset.entryId);
                this._persistLoraStack();
                this.render();
                return;
            }
            if (e.target.closest('.comfy-lorastack-add')) {
                this.loras.push({
                    id: LumenLight.generateId(),
                    file: '',
                    strengthModel: 1,
                    strengthClip: 1,
                    enabled: true
                });
                this._persistLoraStack();
                // 添加时自动展开，方便立即选择文件
                this._setLoraStackCollapsed(section, false);
                this.render();
            }
        });
    },

    /**
     * 切换叠加区折叠状态并同步箭头与 localStorage（渲染期间的就地切换，
     * 不经过 render）
     */
    _setLoraStackCollapsed(section, collapsed) {
        this.loraStackCollapsed = collapsed;
        section.classList.toggle('collapsed', collapsed);
        const toggle = section.querySelector('.collapse-toggle');
        if (toggle) toggle.textContent = collapsed ? '▶' : '▼';
        localStorage.setItem('comfyLoraStackCollapsed', String(collapsed));
    },

    /**
     * 就地更新标题栏的生效条数徽标（文件选择/勾选变更时调用，不重建 DOM）
     */
    _updateLoraStackCount() {
        const label = this.container.querySelector('.comfy-lorastack-header .comfy-param-label');
        if (!label) return;
        const n = this._loraStackActiveCount();
        label.textContent = `LoRA 叠加${n > 0 ? `（${n}）` : ''}`;
    },

    /**
     * 导出生效中的叠加 LoRA 条目（面板提交用）。文件为空或勾选框取消启用
     * 的条目不生效，提交时过滤（enabled 缺省视为启用，兼容未写该字段的
     * 旧条目；与画布 LoraNode.getEnabledLoras 同语义）。
     * 返回值直接作为 /api/comfy-node/run 的 loras 参数——后端
     * injectLoraChain 动态拼链并追加在模板 lora 之后
     * @returns {Array<{file: string, strengthModel: number, strengthClip: number}>}
     */
    getLoras() {
        if (!this.loraStack) return [];
        return this.loras
            .filter((e) => e.file && e.enabled !== false)
            .map((e) => ({ file: e.file, strengthModel: e.strengthModel, strengthClip: e.strengthClip }));
    },

    /**
     * 叠加区生效内容变化通知（LoraTriggerManager 监听）：内嵌/用户条目的
     * 文件选择、启停、增删与整体重渲染后派发。监听方做幂等重算，
     * 重复派发无害。仅 loraStack 模式派发（画布节点无叠加区）
     */
    _emitLoraStackChanged() {
        if (!this.loraStack) return;
        document.dispatchEvent(new CustomEvent('lumen-lorastack-changed'));
    },

    /**
     * 叠加区用户条目持久化（localStorage comfyLoraStack）：F5/重启后保留
     * 用户加载的 LoRA。写入口收在全部变更点（增删/改文件/启停/强度/投递
     * 直投），读入口只有 _initLoraStackState；只落五个契约字段，未知字段
     * 不写。内嵌工作流条目（workflowId loaders）不在此列——重载工作流
     * 自愈，与本持久化无关（见 _initLoraStackState deletedLoraIds 注）
     */
    _persistLoraStack() {
        if (!this.loraStack) return;
        try {
            localStorage.setItem('comfyLoraStack', JSON.stringify(this.loras.map((e) => ({
                id: e.id,
                file: e.file || '',
                strengthModel: e.strengthModel,
                strengthClip: e.strengthClip,
                enabled: e.enabled !== false
            }))));
        } catch { /* 配额满/隐私模式：持久化失败不影响当前会话 */ }
    },

    /**
     * 恢复上次会话的叠加条目（_initLoraStackState 用）：脏数据逐条校验——
     * 非对象/无 file 字符串的条目丢弃，id 缺失补生成，强度经 _clampStrength
     * 归位，enabled 缺省视为启用（与 getLoras 同口径）。条数 200 封顶防
     * 意外巨档拖慢构造
     */
    _loadLoraStack() {
        let raw = null;
        try { raw = JSON.parse(localStorage.getItem('comfyLoraStack') || 'null'); }
        catch { return []; }
        if (!Array.isArray(raw)) return [];
        const out = [];
        for (const e of raw) {
            if (!e || typeof e !== 'object' || typeof e.file !== 'string') continue;
            if (out.length >= 200) break;
            out.push({
                id: (typeof e.id === 'string' && e.id) ||
                    (window.LumenLight && window.LumenLight.generateId
                        ? window.LumenLight.generateId()
                        : `ls-${Date.now()}-${out.length}`),
                file: e.file,
                strengthModel: ComfyParamRows._clampStrength(e.strengthModel, 1),
                strengthClip: ComfyParamRows._clampStrength(e.strengthClip, 1),
                enabled: e.enabled !== false
            });
        }
        return out;
    },

    /**
     * 导出叠加区生效条目（触发词管理器用）：内嵌条目（未删除、勾选启用、
     * 文件非空）+ 用户条目（文件非空、启用），栈序输出。file 保持
     * ComfyUI 原生形态（可能反斜杠，ADR 028）——归一由管理器侧
     * LoraTriggerText.normalizeRel 统一处理
     * @returns {Array<{file: string}>}
     */
    getStackTriggerLoras() {
        if (!this.loraStack) return [];
        const out = [];
        if (this.detected) {
            for (const loader of this.detected.loaders) {
                if (loader.kind !== 'lora' || this.deletedLoraIds.has(loader.nodeId)) continue;
                if (this.state.loraEnabled[loader.nodeId] === false) continue;
                const file = this.state.models[loader.nodeId];
                if (file) out.push({ file });
            }
        }
        for (const entry of this.loras) {
            if (entry.file && entry.enabled !== false) out.push({ file: entry.file });
        }
        return out;
    }
});
