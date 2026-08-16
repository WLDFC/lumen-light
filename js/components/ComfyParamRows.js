/**
 * ==========================================================================
 * LumenLight Comfy 动态参数行控制器（ComfyParamRows）
 * ==========================================================================
 * 作用：从 ComfyGenNode 拆出的参数行 UI 控制器，画布 Comfy 生图节点与
 *       右侧面板 Comfy 模式共用同一套渲染与交互代码。输入一个容器元素，
 *       职责：
 *         1. setWorkflow(workflowJson)：扫描工作流（委托 ComfyParamScanner）
 *            并重建参数行——行序：模型/LoRA 下拉 → 步数+CFG（合并行）→
 *            采样器+降噪（合并行）→ 尺寸 → 数量，全部缺失时显示说明文字。
 *         2. setModelLists(lists, connected)：填充模型/采样器下拉选项
 *            （来自 /api/comfy-node/models 的 object_info 代理）。
 *         3. 持有参数状态并暴露 getState()/setState()（节点存档恢复用）
 *            与 getOverrides()（编译成 /api/comfy-node/run 的覆盖表）。
 *         4. loraStack 选项（面板专属）：在模型行下方渲染可折叠的 LoRA
 *            叠加区，getLoras() 导出生效条目，作为独立 loras 参数随
 *            /api/comfy-node/run 提交（后端 injectLoraChain 追加在模板
 *            lora 之后）；不随工作流切换重置
 *
 * 样式分上下文两档：组件只输出语义类名（comfy-param-* / comfy-* 系），
 * 尺寸规格由宿主的 CSS 决定——画布节点在 css/node.css（--ns 体系），
 * 面板在 css/prompt-panel.css 的 #comfyContent 作用域（面板 12px 档）。
 *
 * resetOnWorkflowChange 选项：面板传 true（切换工作流即重置为模板默认值，
 * 不持久化）；画布节点不传（状态随节点生命周期，入存档）。
 * ==========================================================================
 */

class ComfyParamRows {
    /**
     * @param {HTMLElement} container - 参数行渲染容器
     * @param {Object} [options]
     * @param {boolean} [options.resetOnWorkflowChange] - 切换工作流时重置状态
     * @param {number} [options.maxCount] - 数量上限，默认 8
     * @param {boolean} [options.countRow] - 是否在参数行内渲染数量下拉
     *                                        （默认 true；宿主在参数行外
     *                                        自管数量 UI 时传 false）
     * @param {boolean} [options.loraStack] - 是否渲染可折叠的 LoRA 叠加区
     *                                        （面板专属；画布节点走独立的
     *                                        LoRA 节点，不传此项）
     * @param {Function} [options.onRendered] - 参数行重建/清空/占位后的回调
     *                                        （宿主借此同步行外 UI，如
     *                                        数量步进器的显隐与数值）
     */
    constructor(container, options = {}) {
        this.container = container;
        this.resetOnWorkflowChange = options.resetOnWorkflowChange === true;
        this.maxCount = options.maxCount || 8;
        this.countRow = options.countRow !== false;
        this.loraStack = options.loraStack === true;
        this.onRendered = options.onRendered || null;

        // 参数状态（字段与画布节点存档字段一一对应）
        this.state = this._freshState();
        this.detected = null;          // ComfyParamScanner.scan 结果
        this.modelLists = null;        // { checkpoints, unets, loras, samplers }
        this.modelsConnected = false;  // ComfyUI 模型清单是否读取成功

        // LoRA 叠加堆栈（loraStack=true 时可用）。独立于 this.state：
        // 不随工作流切换重置（resetOnWorkflowChange 不影响它），也不进入
        // 画布节点的存档字段——它是面板侧的用户附加选择，跨工作流保留。
        // 条目结构与画布 LoraNode 一致：{id, file, strengthModel, strengthClip}，
        // file 为空 = 此条不生效（提交时过滤），故无需启用开关
        this.loras = [];

        // 叠加区折叠状态（与提示词框同机制，记忆在 localStorage，默认折叠）
        this.loraStackCollapsed = localStorage.getItem('comfyLoraStackCollapsed') !== 'false';
    }

    /**
     * 全新状态（与节点存档字段一一对应；null = 未设置，提交时走工作流原值）
     */
    _freshState() {
        return {
            models: {},
            loraEnabled: {},
            steps: null,
            cfg: null,
            sampler: null,
            sizeW: null,
            sizeH: null,
            denoise: null,
            count: 1
        };
    }

    /**
     * 恢复状态（画布节点存档恢复 / 外部回填）。未提供的字段保持当前值
     * @param {Object} init - { models, loraEnabled, steps, cfg, sampler,
     *                          sizeW, sizeH, denoise, count }
     */
    setState(init) {
        if (!init) return;
        const s = this.state;
        if (init.models) s.models = { ...(init.models) };
        if (init.loraEnabled) s.loraEnabled = { ...(init.loraEnabled) };
        if (init.steps !== undefined) s.steps = init.steps === null ? null : init.steps;
        if (init.cfg !== undefined) s.cfg = init.cfg === null ? null : init.cfg;
        if (init.sampler !== undefined) s.sampler = init.sampler || null;
        if (init.sizeW !== undefined) s.sizeW = init.sizeW || null;
        if (init.sizeH !== undefined) s.sizeH = init.sizeH || null;
        if (init.denoise !== undefined) s.denoise = init.denoise === null ? null : init.denoise;
        if (init.count !== undefined) {
            s.count = Math.min(this.countMax(), Math.max(1, parseInt(init.count, 10) || 1));
        }
    }

    /**
     * 数量上限：上限值很大时（面板步进器 9999）以四位数封顶
     * @returns {number}
     */
    countMax() {
        return Math.min(this.maxCount, 9999);
    }

    /**
     * 当前工作流是否含批次输入（数量行/步进器的显隐依据）
     * @returns {boolean}
     */
    hasBatchInput() {
        return !!(this.detected && this.detected.batchTargets.length > 0);
    }

    /**
     * 读取当前数量（无批次输入的工作流固定为 1，提交时后端跳过批次覆盖）
     * @returns {number}
     */
    getCount() {
        return this.state.count;
    }

    /**
     * 写入数量（钳制在 1 ~ countMax），供面板步进器绑定
     * @param {number|string} value
     * @returns {number} 钳制后的实际值
     */
    setCount(value) {
        this.state.count = Math.min(this.countMax(), Math.max(1, parseInt(value, 10) || 1));
        return this.state.count;
    }

    /**
     * 导出状态副本（节点存档序列化用）
     * @returns {Object} { models, loraEnabled, steps, cfg, sampler,
     *                     sizeW, sizeH, denoise, count }
     */
    getState() {
        return JSON.parse(JSON.stringify(this.state));
    }

    /**
     * 更新模型清单并重渲染（清单可能晚于工作流加载完成，重渲染回填选项）
     * @param {Object} lists - { checkpoints, unets, loras, samplers }
     * @param {boolean} connected - ComfyUI 是否连接
     */
    setModelLists(lists, connected) {
        this.modelLists = lists || { checkpoints: [], unets: [], loras: [], samplers: [] };
        this.modelsConnected = !!connected;
        if (this.detected) this.render();
    }

    /**
     * 从后端拉取模型清单（object_info 代理），完成后自动重渲染。
     * ComfyUI 未连接时保留空清单，参数行以现有状态值兜底显示
     */
    async loadModelLists() {
        try {
            const response = await fetch('/api/comfy-node/models');
            const data = await response.json();
            this.setModelLists({
                checkpoints: data.checkpoints || [],
                unets: data.unets || [],
                loras: data.loras || [],
                samplers: data.samplers || []
            }, !!data.connected);
        } catch (error) {
            console.error('加载 ComfyUI 模型清单失败:', error);
            this.setModelLists(null, false);
        }
    }

    /**
     * 设置工作流并重建参数行。resetOnWorkflowChange 时先重置为默认状态。
     * 传 null 等价于 clear()（清空参数行）
     * @param {Object|null} workflowJson - API 格式工作流 JSON，null 清空参数行
     */
    setWorkflow(workflowJson) {
        if (!workflowJson) {
            this.clear();
            return;
        }
        this.detected = ComfyParamScanner.scan(workflowJson);
        if (this.resetOnWorkflowChange) {
            this.state = this._freshState();
        }
        this.render();
    }

    /**
     * 显示占位提示（读取中/读取失败等，容器内单行说明文字）。
     * 文本经转义，可传任意字符串
     * @param {string} text
     */
    showStatus(text) {
        this.container.innerHTML =
            `<div class="comfy-param-row"><div class="comfy-param-label">${LumenLight.escapeHtml(text)}</div></div>`;
        this.onRendered?.();
    }

    /**
     * 清空参数行（未选择工作流时）
     */
    clear() {
        this.detected = null;
        this.container.innerHTML = '';
        this.onRendered?.();
    }

    /**
     * 编译当前状态为 /api/comfy-node/run 的参数覆盖表
     * @param {number} [batchCount] - 覆盖表使用的数量值，缺省用当前状态值。
     *   循环入队模式（数量 N = N 个 batch_size=1 的独立任务）传 1，
     *   使每次提交的批次恒为 1，任务数量由提交方循环控制
     * @returns {Object} { [工作流节点id]: { [输入键]: 新值 } }
     */
    getOverrides(batchCount) {
        const state = batchCount === undefined
            ? this.state
            : { ...this.state, count: batchCount };
        return ComfyParamScanner.buildOverrides(this.detected, state);
    }

    /**
     * 依据探测结果重建动态参数行。重建时用当前状态值（含存档恢复值）
     * 回填控件。合并行里的两个参数各自独立（标签+控件），只有其一时
     * 回退为单参数行，不出现空占位。
     */
    render() {
        if (!this.detected) return;
        const { loaders, stepsTargets, cfgTargets, samplerTargets, denoiseTargets, sizeTargets, batchTargets } = this.detected;
        const s = this.state;

        const rows = [];

        // 模型/LoRA 下拉：主模型在前、LoRA 在后（LoRA 是附加项），
        // 同类多个时按节点序加序号区分。
        // 模板内嵌 lora 由本行的启用开关管理（画布 LoRA 节点堆栈是增量补充，
        // 提交时追加在模板 lora 之后——见 workflowInjector.injectLoraChain）
        const orderedLoaders = [...loaders].sort((a, b) =>
            (a.kind === 'lora' ? 1 : 0) - (b.kind === 'lora' ? 1 : 0));
        const kindCount = {};
        for (const loader of orderedLoaders) {
            kindCount[loader.kind] = (kindCount[loader.kind] || 0) + 1;
            const seq = kindCount[loader.kind];
            const total = loaders.filter((l) => l.kind === loader.kind).length;
            const label = loader.kind === 'lora' ? 'LoRA' : '主模型';
            const labelText = total > 1 ? `${label} ${seq}` : label;

            // LoRA 行带"启用"勾选框（默认不勾选 = 注入强度 0 软关闭；
            // 工作流 strength 不是字面数值时无法软关闭，不出开关）
            const hasSwitch = loader.kind === 'lora' &&
                loader.strengthFields && loader.strengthFields.length > 0;
            const loraOff = hasSwitch && s.loraEnabled[loader.nodeId] !== true;
            const selectHtml =
                `<select class="llm-model-select comfy-model-select"${loraOff ? ' data-lora-off="1"' : ''}` +
                ` data-node-id="${LumenLight.escapeHtml(loader.nodeId)}" title="${labelText}"></select>`;

            rows.push(`
                <div class="comfy-param-row">
                    <div class="comfy-param-label">${labelText}</div>
                    <div class="${hasSwitch ? 'comfy-lora-row' : ''}">
                        ${selectHtml}${hasSwitch ? `
                        <label class="comfy-lora-enable" title="勾选后 LoRA 生效；取消勾选则注入强度 0 关闭 LoRA">
                            <input type="checkbox" class="comfy-lora-enable-input"
                                   data-node-id="${LumenLight.escapeHtml(loader.nodeId)}"${loraOff ? '' : ' checked'}>启用
                        </label>` : ''}
                    </div>
                </div>
            `);
        }

        // 面板 LoRA 叠加区（options.loraStack）：可堆叠条目独立于工作流模板，
        // 提交时作为独立 loras 参数注入（追加在模板 lora 之后）。位置在
        // 模型/LoRA 行之后、步数行之前——常规工作流（无模板 lora）里
        // 即"主模型下面"
        if (this.loraStack) rows.push(this._renderLoraStack());

        // 合并行辅助：两个参数都有探测值时并排一行（comfy-param-pair，
        // 左右两组「标签+输入框」各自独立）；只有其一时回退为单参数行，
        // 不出现空占位。步数+CFG 与 采样器+降噪 两个合并行共用此模式
        const pushRow = (label, control) => rows.push(`
            <div class="comfy-param-row">
                <div class="comfy-param-label">${label}</div>
                ${control}
            </div>
        `);
        const pushPairRow = (left, right) => rows.push(`
            <div class="comfy-param-pair">
                <div class="comfy-param-row">
                    <div class="comfy-param-label">${left.label}</div>
                    ${left.control}
                </div>
                <div class="comfy-param-row">
                    <div class="comfy-param-label">${right.label}</div>
                    ${right.control}
                </div>
            </div>
        `);

        // 步数 + CFG 合并行
        const hasSteps = stepsTargets.length > 0;
        const hasCfg = cfgTargets.length > 0;
        const stepsControl = (value) =>
            `<input type="number" class="comfy-num-input comfy-steps-input" min="1" max="200" step="1"
                    value="${value}" title="采样步数（应用到工作流内全部采样/调度节点）">`;
        const cfgControl = (value) =>
            `<input type="number" class="comfy-num-input comfy-cfg-input" min="0" max="100" step="0.1"
                    value="${value}" title="CFG 引导系数（应用到工作流内全部 cfg 输入，如 KSampler/CFGGuider）">`;
        if (hasSteps && hasCfg) {
            const stepsValue = s.steps !== null ? s.steps : stepsTargets[0].current;
            const cfgValue = s.cfg !== null ? s.cfg : cfgTargets[0].current;
            pushPairRow({ label: '步数', control: stepsControl(stepsValue) },
                        { label: 'CFG', control: cfgControl(cfgValue) });
        } else if (hasSteps) {
            pushRow('步数', stepsControl(s.steps !== null ? s.steps : stepsTargets[0].current));
        } else if (hasCfg) {
            pushRow('CFG', cfgControl(s.cfg !== null ? s.cfg : cfgTargets[0].current));
        }

        // 采样器 + 降噪 合并行：采样器为下拉框（选项来自 ComfyUI /object_info，
        // ComfyUI 离线时至少保留工作流当前值）
        const hasSampler = samplerTargets.length > 0;
        const hasDenoise = denoiseTargets.length > 0;
        const samplerControl = () =>
            `<select class="llm-count-select comfy-sampler-select"
                     title="采样算法（应用到工作流内全部 sampler_name 输入，如 KSampler/KSamplerSelect）"></select>`;
        const denoiseControl = (value) =>
            `<input type="number" class="comfy-num-input comfy-denoise-input" min="0" max="1" step="0.05"
                    value="${value}" title="降噪强度 0-1（文生图保持 1）">`;
        if (hasSampler && hasDenoise) {
            const denoiseValue = s.denoise !== null ? s.denoise : denoiseTargets[0].current;
            pushPairRow({ label: '采样器', control: samplerControl() },
                        { label: '降噪', control: denoiseControl(denoiseValue) });
        } else if (hasSampler) {
            pushRow('采样器', samplerControl());
        } else if (hasDenoise) {
            pushRow('降噪', denoiseControl(s.denoise !== null ? s.denoise : denoiseTargets[0].current));
        }

        // 尺寸（宽 × 高同行）
        if (sizeTargets.length > 0) {
            const w = s.sizeW !== null ? s.sizeW : sizeTargets[0].width;
            const h = s.sizeH !== null ? s.sizeH : sizeTargets[0].height;
            rows.push(`
                <div class="comfy-param-row">
                    <div class="comfy-param-label">尺寸</div>
                    <div class="comfy-size-row">
                        <input type="number" class="comfy-num-input comfy-width-input" min="64" max="8192" step="8"
                               value="${w}" title="宽度">
                        <span class="comfy-size-x">×</span>
                        <input type="number" class="comfy-num-input comfy-height-input" min="64" max="8192" step="8"
                               value="${h}" title="高度">
                    </div>
                </div>
            `);
        }

        // 数量（工作流没有批次输入时不显示，固定 1 张；
        // 面板模式 countRow=false 时由按钮旁的步进器接管数量 UI）
        if (this.countRow && batchTargets.length > 0) {
            rows.push(`
                <div class="comfy-param-row">
                    <div class="comfy-param-label">数量</div>
                    <select class="llm-count-select comfy-count-select" title="单次生成的图片数量（工作流批次）">
                        ${Array.from({ length: this.maxCount }, (_, i) =>
                            `<option value="${i + 1}" ${i + 1 === s.count ? 'selected' : ''}>${i + 1} 张</option>`
                        ).join('')}
                    </select>
                </div>
            `);
        }

        if (rows.length === 0) {
            rows.push(`
                <div class="comfy-param-row">
                    <div class="comfy-param-label">该工作流没有可调参数，按工作流原样生成</div>
                </div>
            `);
        }

        this.container.innerHTML = rows.join('');
        this._bindDynamicRows();
        this.onRendered?.();
    }

    /**
     * 绑定动态行控件的事件并回填模型下拉选项
     */
    _bindDynamicRows() {
        if (!this.detected) return;
        const { loaders, cfgTargets, samplerTargets } = this.detected;
        const s = this.state;
        const root = this.container;

        // 模型下拉：填充选项（存档值不在清单里时前置保留，避免恢复后丢失显示）
        for (const loader of loaders) {
            const select = root.querySelector(
                `.comfy-model-select[data-node-id="${CSS.escape(loader.nodeId)}"]`
            );
            if (!select) continue;
            this._fillModelSelect(select, this._modelListFor(loader.kind),
                                  s.models[loader.nodeId] || loader.current);
            select.addEventListener('change', () => {
                s.models[loader.nodeId] = select.value;
            });
        }

        // LoRA 启用勾选框：状态记录 + 下拉框置灰反馈（未启用半透明）
        root.querySelectorAll('.comfy-lora-enable-input').forEach((input) => {
            const nodeId = input.dataset.nodeId;
            const applyState = () => {
                s.loraEnabled[nodeId] = input.checked;
                const select = root.querySelector(
                    `.comfy-model-select[data-node-id="${CSS.escape(nodeId)}"]`
                );
                if (select) {
                    if (input.checked) {
                        delete select.dataset.loraOff;
                    } else {
                        select.dataset.loraOff = '1';
                    }
                }
            };
            input.addEventListener('change', applyState);
            applyState();   // 渲染后立即同步一次置灰态（存档恢复/默认关闭）
        });

        const stepsInput = root.querySelector('.comfy-steps-input');
        if (stepsInput) {
            stepsInput.addEventListener('change', () => {
                s.steps = Math.max(1, Math.min(200, parseInt(stepsInput.value, 10) || 1));
                stepsInput.value = s.steps;
            });
        }

        // CFG：浮点 0-100，清空/非法时回落到工作流原值
        const cfgInput = root.querySelector('.comfy-cfg-input');
        if (cfgInput) {
            cfgInput.addEventListener('change', () => {
                let v = parseFloat(cfgInput.value);
                if (isNaN(v)) v = cfgTargets.length > 0 ? cfgTargets[0].current : 8;
                v = Math.max(0, Math.min(100, v));
                s.cfg = v;
                cfgInput.value = v;
            });
        }

        // 采样器：填充枚举选项（ComfyUI 清单优先，当前值不在清单时前置保留）
        const samplerSelect = root.querySelector('.comfy-sampler-select');
        if (samplerSelect) {
            const current = s.sampler !== null ? s.sampler : samplerTargets[0].current;
            const options = (this.modelLists && this.modelLists.samplers) ? this.modelLists.samplers.slice() : [];
            if (!options.includes(current)) options.unshift(current);
            samplerSelect.innerHTML = options.map((name) =>
                `<option value="${LumenLight.escapeHtml(name)}"${name === current ? ' selected' : ''}>${LumenLight.escapeHtml(name)}</option>`
            ).join('');
            samplerSelect.addEventListener('change', () => {
                s.sampler = samplerSelect.value;
            });
        }

        const widthInput = root.querySelector('.comfy-width-input');
        const heightInput = root.querySelector('.comfy-height-input');
        const clampSize = (v) => Math.max(64, Math.min(8192, parseInt(v, 10) || 64));
        if (widthInput) {
            widthInput.addEventListener('change', () => {
                s.sizeW = clampSize(widthInput.value);
                widthInput.value = s.sizeW;
            });
        }
        if (heightInput) {
            heightInput.addEventListener('change', () => {
                s.sizeH = clampSize(heightInput.value);
                heightInput.value = s.sizeH;
            });
        }

        const denoiseInput = root.querySelector('.comfy-denoise-input');
        if (denoiseInput) {
            denoiseInput.addEventListener('change', () => {
                let v = parseFloat(denoiseInput.value);
                if (isNaN(v)) v = 1;
                v = Math.max(0, Math.min(1, v));
                s.denoise = v;
                denoiseInput.value = v;
            });
        }

        const countSelect = root.querySelector('.comfy-count-select');
        if (countSelect) {
            countSelect.addEventListener('change', () => {
                s.count = Math.min(this.maxCount,
                    Math.max(1, parseInt(countSelect.value, 10) || 1));
            });
        }

        this._bindLoraStack();
    }

    // ==================== LoRA 叠加区（面板 loraStack 模式） ====================

    /**
     * 渲染 LoRA 叠加区 HTML：折叠标题栏（含生效条数徽标）+ 条目列表 + 添加按钮。
     * 条目结构对齐画布 LoraNode：「lora」文件下拉（选空 = 此条不生效）+
     * 「模型强度」「CLIP强度」合并行；样式复用面板参数行规格
     * @returns {string} HTML 片段
     */
    _renderLoraStack() {
        const loraFiles = (this.modelLists && this.modelLists.loras) || [];
        const enabledCount = this.loras.filter((e) => e.file).length;

        const entriesHtml = this.loras.length === 0
            ? `<div class="comfy-lorastack-empty">暂无 LoRA，点下方按钮添加；叠加的 LoRA 会作用于当前工作流的生成结果</div>`
            : this.loras.map((entry) => `
                <div class="comfy-lorastack-entry" data-entry-id="${LumenLight.escapeHtml(entry.id)}">
                    <div class="comfy-param-row">
                        <div class="comfy-param-label">lora</div>
                        <div class="comfy-lorastack-head">
                            <select class="llm-model-select comfy-model-select comfy-lorastack-file" title="LoRA 文件（选空则此条不生效）">
                                <option value="" ${entry.file ? '' : 'selected'}>-- 选择 LoRA 文件 --</option>
                                ${loraFiles.map((f) =>
                                    `<option value="${LumenLight.escapeHtml(f)}" ${f === entry.file ? 'selected' : ''}>${LumenLight.escapeHtml(f)}</option>`
                                ).join('')}
                                ${entry.file && !loraFiles.includes(entry.file)
                                    ? `<option value="${LumenLight.escapeHtml(entry.file)}" selected>${LumenLight.escapeHtml(entry.file)}（不在清单）</option>`
                                    : ''}
                            </select>
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

        return `
            <div class="comfy-lorastack collapsible${this.loraStackCollapsed ? ' collapsed' : ''}">
                <div class="collapsible-header comfy-lorastack-header" title="点击展开/收起 LoRA 叠加列表">
                    <span class="comfy-param-label">LoRA 叠加${enabledCount > 0 ? `（${enabledCount}）` : ''}</span>
                    <button type="button" class="collapse-toggle" aria-label="展开/收起 LoRA 叠加">▶</button>
                </div>
                <div class="collapsible-body comfy-lorastack-body">
                    ${entriesHtml}
                    <button type="button" class="comfy-lorastack-add" title="添加一条 LoRA">+ 添加 LoRA</button>
                </div>
            </div>
        `;
    }

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

        // 条目修改（事件委托，直接改状态不重建 DOM，保持输入焦点）
        section.addEventListener('change', (e) => {
            const entryEl = e.target.closest('.comfy-lorastack-entry');
            if (!entryEl) return;
            const entry = this.loras.find((en) => en.id === entryEl.dataset.entryId);
            if (!entry) return;

            if (e.target.classList.contains('comfy-lorastack-file')) {
                entry.file = e.target.value;
                this._updateLoraStackCount();
            } else if (e.target.classList.contains('comfy-lorastack-strength-model')) {
                entry.strengthModel = ComfyParamRows._clampStrength(e.target.value, entry.strengthModel);
                e.target.value = entry.strengthModel;
            } else if (e.target.classList.contains('comfy-lorastack-strength-clip')) {
                entry.strengthClip = ComfyParamRows._clampStrength(e.target.value, entry.strengthClip);
                e.target.value = entry.strengthClip;
            }
        });

        // 删除 / 添加（重建列表，与画布 LoraNode.renderEntries 同策略）
        section.addEventListener('click', (e) => {
            const removeBtn = e.target.closest('.comfy-lorastack-remove');
            if (removeBtn) {
                const entryEl = removeBtn.closest('.comfy-lorastack-entry');
                this.loras = this.loras.filter((en) => en.id !== entryEl.dataset.entryId);
                this.render();
                return;
            }
            if (e.target.closest('.comfy-lorastack-add')) {
                this.loras.push({
                    id: LumenLight.generateId(),
                    file: '',
                    strengthModel: 1,
                    strengthClip: 1
                });
                // 添加时自动展开，方便立即选择文件
                this._setLoraStackCollapsed(section, false);
                this.render();
            }
        });
    }

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
    }

    /**
     * 就地更新标题栏的生效条数徽标（文件选择变更时调用，不重建 DOM）
     */
    _updateLoraStackCount() {
        const label = this.container.querySelector('.comfy-lorastack-header .comfy-param-label');
        if (!label) return;
        const n = this.loras.filter((e) => e.file).length;
        label.textContent = `LoRA 叠加${n > 0 ? `（${n}）` : ''}`;
    }

    /**
     * 导出生效中的叠加 LoRA 条目（面板提交用）。文件为空的条目不生效，
     * 提交时过滤（与画布 LoraNode.getEnabledLoras 同语义）。
     * 返回值直接作为 /api/comfy-node/run 的 loras 参数——后端
     * injectLoraChain 动态拼链并追加在模板 lora 之后
     * @returns {Array<{file: string, strengthModel: number, strengthClip: number}>}
     */
    getLoras() {
        if (!this.loraStack) return [];
        return this.loras
            .filter((e) => e.file)
            .map((e) => ({ file: e.file, strengthModel: e.strengthModel, strengthClip: e.strengthClip }));
    }

    /**
     * 按加载节点类别取模型清单
     * @param {'checkpoint'|'unet'|'lora'} kind - 加载节点类别
     * @returns {string[]} 模型文件名列表
     */
    _modelListFor(kind) {
        if (!this.modelLists) return [];
        return kind === 'lora' ? this.modelLists.loras
             : kind === 'unet' ? this.modelLists.unets
             : this.modelLists.checkpoints;
    }

    /**
     * 填充模型下拉：ComfyUI 未连接或清单为空时显示提示项；
     * 存档/模板值不在清单里（模型被改名/删除）时前置保留该值保证显示不丢，
     * 但在选项文字上标注"不在清单"，避免用户选到必然校验失败的值
     * @param {HTMLSelectElement} select - 目标下拉框
     * @param {string[]} list - 模型文件名列表
     * @param {string} selected - 当前应选中的值
     */
    _fillModelSelect(select, list, selected) {
        const options = list.slice();
        const staleSelected = selected && this.modelsConnected &&
            list.length > 0 && !list.includes(selected);
        if (selected && !options.includes(selected)) options.unshift(selected);

        if (options.length === 0) {
            // ComfyUI 离线/清单为空：只显示提示项，不回写状态，
            // 保留存档里的选择值（清单就绪后会触发重渲染回填）
            select.innerHTML = `<option value="">${this.modelsConnected ? '清单为空' : 'ComfyUI 未连接'}</option>`;
            return;
        }

        select.innerHTML = options.map((name) => {
            // 前置保留的清单外值：文字加标注（value 保持原名，提交语义不变）
            const stale = name === selected && staleSelected;
            const text = stale ? `${name}（不在清单）` : name;
            return `<option value="${LumenLight.escapeHtml(name)}"${name === selected ? ' selected' : ''}>${LumenLight.escapeHtml(text)}</option>`;
        }).join('');
        // 填充即回写状态：未手动改过下拉时，models 里也记录当前生效值
        // （与拆出前 ComfyGenNode 的行为一致，存档字段不出现缺省差异）
        this.state.models[select.dataset.nodeId] = select.value;
    }

    /**
     * 强度值清洗：非法/缺省回落默认值，钳制到 [-5, 5]
     * （与画布 LoraNode._clampStrength 同语义）
     * @param {*} v - 输入值
     * @param {number} fallback - 回落值
     * @returns {number}
     */
    static _clampStrength(v, fallback) {
        const n = parseFloat(v);
        if (isNaN(n)) return fallback;
        return Math.max(-5, Math.min(5, n));
    }
}

// 将 ComfyParamRows 类暴露到全局作用域
window.ComfyParamRows = ComfyParamRows;
