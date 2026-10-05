/**
 * ==========================================================================
 * LumenLight RunningHub 参数行控制器
 * ==========================================================================
 * 作用：RunningHub 云端工作流生成节点的动态参数行渲染。与 ComfyParamRows
 *       （扫描本地工作流 JSON 探测参数）不同，本控制器按"登记卡"渲染——
 *       登记卡是用户在设置 → API 里从平台 api-detail 页抄写的参数映射：
 *         params: [{ nodeId, fieldName, label, type, role?, options? }]
 *         type: 'string'（文本输入）| 'list'（下拉，选项 options）|
 *               'image'（不渲染行——生成时由节点按登记卡取连线图片）
 *         role: 'prompt'（连线提示词自动填入）/ 'negative'（右侧负面提示词）
 *
 * 复用 .comfy-param-row 行样式（与 Comfy 生图节点观感一致）。
 * 尺寸合并行：登记卡同时登记 width/height 两个文本参数时并排为一行
 * 「尺寸 W × H」（结构与 ComfyParamRows 的尺寸行一致），只登记其一时
 * 回退普通单行。
 * 参数值由 values 状态持有并随节点入存档，刷新/恢复后按 key 回填。
 * ==========================================================================
 */

class RunningHubParamRows {
    /**
     * @param {HTMLElement} containerEl - 参数行容器（节点动态参数区）
     */
    constructor(containerEl) {
        this.container = containerEl;
        this.params = [];        // 当前登记卡的参数定义
        this.inputs = new Map(); // key(`${nodeId}:${fieldName}`) → 输入控件元素
        this.values = {};        // key → 参数值快照（键入即同步，随节点入存档）
    }

    /**
     * 按登记卡重建参数行
     * @param {Object|null} wf - 登记卡 { id, name, rhWorkflowId, params }，null 清空
     */
    setWorkflow(wf) {
        this.params = (wf && Array.isArray(wf.params)) ? wf.params : [];
        this.render();
    }

    /**
     * 清空参数行（values 快照保留：切回工作流时已填参数自动回填）
     */
    clear() {
        this.params = [];
        this.container.innerHTML = '';
        this.inputs.clear();
    }

    /**
     * 显示一行状态提示（工作流加载中/失败等）
     * @param {string} text - 提示文本
     */
    showStatus(text) {
        this.container.innerHTML =
            `<div class="comfy-param-row"><div class="comfy-param-label">${LumenLight.escapeHtml(text)}</div></div>`;
        this.inputs.clear();
    }

    /**
     * 收集当前参数值（供 generate 提交）
     * @returns {Object} { [`${nodeId}:${fieldName}`]: string }
     */
    getValues() {
        const values = {};
        for (const [key, el] of this.inputs) {
            values[key] = el.value;
        }
        return values;
    }

    /**
     * 导出参数值快照（节点存档序列化用）
     * @returns {Object} { [`${nodeId}:${fieldName}`]: string }
     */
    getState() {
        return { ...this.values };
    }

    /**
     * 恢复参数值快照（存档恢复/粘贴复制用）。键不绑定登记卡：切换工作流
     * 后同键参数自动回填，失效键自然闲置（与 Comfy 节点 models 同策略）
     * @param {Object} [init] - getState 导出的快照
     */
    setState(init) {
        if (init && typeof init === 'object') {
            this.values = { ...init };
        }
    }

    /**
     * 渲染参数行（登记卡缺参数时给出说明行）。登记卡同时登记 width/height
     * 两个文本参数时合并为「尺寸 W × H」一行（结构与 ComfyParamRows 的
     * 尺寸行一致），只登记其一时回退普通单行
     */
    render() {
        this.inputs.clear();
        if (this.params.length === 0) {
            this.container.innerHTML = `
                <div class="comfy-param-row">
                    <div class="comfy-param-label">该工作流未登记参数，按云端工作流原样生成</div>
                </div>
            `;
            return;
        }

        // 尺寸合并行候选：fieldName 为 width/height 的文本参数
        // （RhWorkflowImporter 的标量白名单即按此命名登记）
        const isTextField = (p) => p.type !== 'image' && p.type !== 'list';
        const widthParam = this.params.find((p) =>
            p && p.nodeId && p.fieldName === 'width' && isTextField(p));
        const heightParam = widthParam ? this.params.find((p) =>
            p && p.nodeId && p.fieldName === 'height' && isTextField(p)) : null;
        const heightKey = heightParam ? `${heightParam.nodeId}:${heightParam.fieldName}` : '';

        const rows = [];
        for (const p of this.params) {
            if (!p || !p.nodeId || !p.fieldName) continue;
            const key = `${p.nodeId}:${p.fieldName}`;
            const label = LumenLight.escapeHtml(p.label || p.fieldName);

            if (p.type === 'image') {
                // 图片槽位：不在节点上渲染行——取图入口就是左侧端口，两行
                // 说明文字没有信息量；缺图时 generate() 有通知兜底
                continue;
            }

            if (p.type === 'list' && Array.isArray(p.options) && p.options.length > 0) {
                const options = p.options.map((opt) =>
                    `<option value="${LumenLight.escapeHtml(String(opt))}">${LumenLight.escapeHtml(String(opt))}</option>`
                ).join('');
                rows.push(`
                    <div class="comfy-param-row">
                        <div class="comfy-param-label">${label}</div>
                        <select class="llm-count-select rh-param-input" data-key="${LumenLight.escapeHtml(key)}">${options}</select>
                    </div>
                `);
                continue;
            }

            // 尺寸合并行：宽 × 高并排（两个输入各自 data-key 独立，提交取值不变）
            if (p === widthParam && heightParam) {
                rows.push(`
                    <div class="comfy-param-row">
                        <div class="comfy-param-label">尺寸</div>
                        <div class="comfy-size-row">
                            <input type="text" class="comfy-num-input rh-param-input" data-key="${LumenLight.escapeHtml(key)}"
                                   title="${label}">
                            <span class="comfy-size-x">×</span>
                            <input type="text" class="comfy-num-input rh-param-input" data-key="${LumenLight.escapeHtml(heightKey)}"
                                   title="${LumenLight.escapeHtml(heightParam.label || '高度')}">
                        </div>
                    </div>
                `);
                continue;
            }
            if (p === heightParam) continue;   // 已并入尺寸行

            // string（默认）：文本输入框
            rows.push(`
                <div class="comfy-param-row">
                    <div class="comfy-param-label">${label}</div>
                    <input type="text" class="comfy-num-input rh-param-input" data-key="${LumenLight.escapeHtml(key)}"
                           title="${label}${p.role === 'prompt' ? '（空时自动使用连线提示词）' : ''}">
                </div>
            `);
        }

        this.container.innerHTML = rows.join('');
        // 收集输入控件引用（getValues 用）：回填快照值、键入即同步进状态
        this.container.querySelectorAll('.rh-param-input').forEach((el) => {
            const key = el.dataset.key;
            if (this.values[key] !== undefined) {
                el.value = this.values[key];
            }
            this.inputs.set(key, el);
            el.addEventListener('input', () => {
                this.values[key] = el.value;
            });
        });
    }
}

// 将 RunningHubParamRows 类暴露到全局作用域
window.RunningHubParamRows = RunningHubParamRows;
