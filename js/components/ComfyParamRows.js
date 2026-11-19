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
 *         4. loraStack 选项（面板专属）：LoRA 叠加区（UI/事件/持久化/
 *            生效导出/封面选择器挂载）拆至 comfy-param-rows/ComfyLoraStack.js
 *            原型混入（ADR 083，本文件之后加载），本文件保留 options.loraStack
 *            开关与调用点；getLoras() 导出生效条目作为独立 loras 参数随
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
     *                                        LoRA 节点，不传此项；实现在
     *                                        comfy-param-rows/ComfyLoraStack.js
     *                                        混入）
     * @param {boolean} [options.sizePresets] - 尺寸行右侧是否附「预设」下拉
     *                                        （面板专属；画布节点不开启）。
     *                                        选项来自 CoordinateLayout
     *                                        .COMFY_PRESET_SIZES 八档
     *                                        （共享五档 + Comfy 追加三档；
     *                                        漫画/坐标编辑器仍读五档
     *                                        PRESET_SIZES，不受追加影响）
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
        this.sizePresets = options.sizePresets === true;
        this.onRendered = options.onRendered || null;

        // 参数状态（字段与画布节点存档字段一一对应）
        this.state = this._freshState();
        this.detected = null;          // ComfyParamScanner.scan 结果
        this.modelLists = null;        // { checkpoints, unets, loras, samplers }
        this.modelsConnected = false;  // ComfyUI 模型清单是否读取成功

        // LoRA 叠加域状态（loras / workflowId / deletedLoraIds /
        // loraStackCollapsed）：初始化在 comfy-param-rows/ComfyLoraStack.js
        // 混入的 _initLoraStackState()（无条件调用，画布节点实例同样走一遍）
        this._initLoraStackState();
    }

    /**
     * 全新状态（与节点存档字段一一对应；null = 未设置，提交时走工作流原值）
     */
    _freshState() {
        return {
            models: {},
            loraEnabled: {},
            loraStrengths: {},   // 内嵌 lora 的用户改值 { [nodeId]: { strengthModel?, strengthClip? } }
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
        if (init.loraStrengths) s.loraStrengths = { ...(init.loraStrengths) };
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
        // 叠加区历史条目补归一（ADR 028 决策四，LoRA 域混入）
        this._healLoraStackEntries();
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
     * @param {string|null} [workflowId] - 工作流 id（面板模式传；删除记录仅
     *        内存级，此参数当前仅用于标识上下文）
     */
    setWorkflow(workflowJson, workflowId = null) {
        if (!workflowJson) {
            this.clear();
            return;
        }
        // 重新加载工作流（含切换与刷新后恢复选中）即清空删除记录——
        // 内嵌 lora 自动全部回来
        this.workflowId = workflowId;
        this.deletedLoraIds.clear();
        this.detected = ComfyParamScanner.scan(workflowJson);
        if (this.resetOnWorkflowChange) {
            this.state = this._freshState();
        }
        this.render();
    }

    /** 记录删除内嵌 lora（仅内存，重新加载工作流后自动恢复） */
    _deleteEmbeddedLora(nodeId) {
        this.deletedLoraIds.add(nodeId);
    }

    /**
     * 导出已删除的内嵌 lora 节点 id（面板提交用，随 /run 的 bypassLoras
     * 参数交给后端 applyBypass 剔除节点并直通重连）
     * @returns {string[]}
     */
    getDeletedLoraIds() {
        return [...this.deletedLoraIds];
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
        // 已删除的内嵌 lora 注入删除标记（buildOverrides 跳过其覆盖注入；
        // 节点剔除由后端 bypassLoras 完成）
        if (this.deletedLoraIds.size > 0) {
            state.loraDeleted = {};
            for (const id of this.deletedLoraIds) state.loraDeleted[id] = true;
        }
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
        // 模板内嵌 lora：面板模式（loraStack）并入下方 LoRA 叠加区统一管理
        // （文件/强度/启停/删除），此处不再渲染独立行；画布模式保持独立行
        // + 启用勾选框（画布的叠加走独立 LoRA 节点，见 workflowInjector 注释）
        const orderedLoaders = [...loaders].sort((a, b) =>
            (a.kind === 'lora' ? 1 : 0) - (b.kind === 'lora' ? 1 : 0));
        const kindCount = {};
        for (const loader of orderedLoaders) {
            // 面板模式：lora 行不独立渲染（叠加区统一管理），跳过
            if (this.loraStack && loader.kind === 'lora') continue;
            kindCount[loader.kind] = (kindCount[loader.kind] || 0) + 1;
            const seq = kindCount[loader.kind];
            const total = loaders.filter((l) => l.kind === loader.kind).length;
            const label = loader.kind === 'lora' ? 'LoRA' : '主模型';
            const labelText = total > 1 ? `${label} ${seq}` : label;

            // LoRA 行带启用勾选框（缺省 = 勾选生效；只有显式取消过才注入
            // 强度 0 软关闭。工作流 strength 不是字面数值时无法软关闭，
            // 不出开关）。样式与 LoRA 叠加区条目同款自绘方格
            const hasSwitch = loader.kind === 'lora' &&
                loader.strengthFields && loader.strengthFields.length > 0;
            const loraOff = hasSwitch && s.loraEnabled[loader.nodeId] === false;
            // LoRA 文件行走封面选择器（LoraFileSelect 冒充 select：class 与
            // data-node-id 原样保留，change/value 兼容）；主模型行保持原生 select
            const selectHtml = loader.kind === 'lora'
                ? `<div class="llm-model-select comfy-model-select lfs-host"${loraOff ? ' data-lora-off="1"' : ''}` +
                  ` data-node-id="${LumenLight.escapeHtml(loader.nodeId)}" title="${labelText}（点开看封面）"></div>`
                : `<select class="llm-model-select comfy-model-select"${loraOff ? ' data-lora-off="1"' : ''}` +
                  ` data-node-id="${LumenLight.escapeHtml(loader.nodeId)}" title="${labelText}"></select>`;

            rows.push(`
                <div class="comfy-param-row">
                    <div class="comfy-param-label">${labelText}</div>
                    <div class="${hasSwitch ? 'comfy-lora-row' : ''}">
                        ${selectHtml}${hasSwitch ? `
                        <input type="checkbox" class="comfy-lora-enable-input"
                               title="勾选后 LoRA 生效；取消勾选则注入强度 0 关闭 LoRA"
                               data-node-id="${LumenLight.escapeHtml(loader.nodeId)}"${loraOff ? '' : ' checked'}>` : ''}
                    </div>
                </div>
            `);
        }

        // 面板 LoRA 叠加区（options.loraStack）：可堆叠条目独立于工作流模板，
        // 提交时作为独立 loras 参数注入（追加在模板 lora 之后）。位置在
        // 模型/LoRA 行之后、步数行之前——常规工作流（无模板 lora）里
        // 即"主模型下面"（渲染在 comfy-param-rows/ComfyLoraStack.js 混入）
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

        // 尺寸（宽 × 高同行；sizePresets 开启时右侧附按钮样式的「预设」下拉，
        // 占位不带省略号——按钮定宽只求放下二字，交互同漫画编辑器画幅预设。
        // 八档清单 = 共享五档 + Comfy 追加三档（见 CoordinateLayout 注释）
        if (sizeTargets.length > 0) {
            const w = s.sizeW !== null ? s.sizeW : sizeTargets[0].width;
            const h = s.sizeH !== null ? s.sizeH : sizeTargets[0].height;
            const presetSel = this.sizePresets
                ? `<select class="comfy-size-preset" title="常用尺寸预设">` +
                  `<option value="">预设</option>` +
                  CoordinateLayout.COMFY_PRESET_SIZES.map((p, i) =>
                      `<option value="${i}">${LumenLight.escapeHtml(p.label)}</option>`).join('') +
                  `</select>`
                : '';
            rows.push(`
                <div class="comfy-param-row">
                    <div class="comfy-param-label">尺寸</div>
                    <div class="comfy-size-row">
                        <input type="number" class="comfy-num-input comfy-width-input" min="64" max="8192" step="8"
                               value="${w}" title="宽度">
                        <span class="comfy-size-x">×</span>
                        <input type="number" class="comfy-num-input comfy-height-input" min="64" max="8192" step="8"
                               value="${h}" title="高度">
                        ${presetSel}
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
        this._initLoraFileSelects();
        this._bindDynamicRows();
        this.onRendered?.();
        // 叠加区内容可能随工作流切换/内嵌删除/清单回填变化 → 通知触发词管理器
        this._emitLoraStackChanged();
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
                // 内嵌 LoRA 换文件 → 叠加区生效内容变化（触发词管理器同步）
                if (loader.kind === 'lora') this._emitLoraStackChanged();
            });
        }

        // LoRA 启用勾选框：状态记录 + 下拉框置灰反馈（未启用半透明）。
        // 同时覆盖两类勾选框：动态行 .comfy-lora-enable-input（画布节点行）
        // 与叠加区内嵌条目（同一 class + data-node-id）
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
                // 叠加区内嵌条目：勾选状态同步整条置灰（含强度输入）
                const entry = input.closest('.comfy-lorastack-entry');
                if (entry) {
                    entry.classList.toggle('is-off', !input.checked);
                    this._emitLoraStackChanged();
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

        // 预设下拉（sizePresets 选项，面板专属）：闭态恒显「预设」占位——
        // 选中即写入宽高状态并回填输入框，随后复位占位（同 MangaDom 预设交互）。
        // 占位项先短路：Number('') 为 0 会误套第一档（选预设后回选占位时触发）
        const presetSelect = root.querySelector('.comfy-size-preset');
        if (presetSelect) {
            presetSelect.addEventListener('change', () => {
                if (presetSelect.value === '') return;
                const p = CoordinateLayout.COMFY_PRESET_SIZES[Number(presetSelect.value)];
                presetSelect.value = '';
                if (!p) return;
                s.sizeW = clampSize(p.width);
                s.sizeH = clampSize(p.height);
                if (widthInput) widthInput.value = s.sizeW;
                if (heightInput) heightInput.value = s.sizeH;
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

        // LoRA 封面选择器挂载点（div 冒充 select）：经组件接口灌清单，
        // 提示语义（未连接/清单为空）与下方原生分支一致
        if (select._lfs) {
            const hint = options.length === 0
                ? (this.modelsConnected ? '清单为空' : 'ComfyUI 未连接')
                : '';
            select._lfs.setFiles(options, selected, hint);
            this.state.models[select.dataset.nodeId] = select.value;
            return;
        }

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
     * （与画布 LoraNode._clampStrength 同语义；LoRA 域混入亦经全局类引用复用）
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
