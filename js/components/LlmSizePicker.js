/**
 * ==========================================================================
 * LumenLight LLM 尺寸选择器组件
 * 作用：LLM 对话框工具栏中的「比例 + 分辨率档位」双段式下拉面板。
 *       原生 select 仅作为折叠按钮与键盘/无障碍回退，
 *       实际交互由覆盖在其下方的自定义面板承担（上段选比例、下段选档位）。
 *       比例列表、档位定义与图标样式等纯计算逻辑来自 js/utils/llmResolution.js。
 * 说明：本组件从 LlmChat 中拆分出来，与聊天逻辑解耦，
 *       聊天类只需 getRatio() / getTier() 读取当前选择，
 *       并在模型切换时调用 setModel() 同步档位可用性。
 * ==========================================================================
 */

class LlmSizePicker {
    /**
     * 构造函数
     * @param {string|HTMLSelectElement} select - 折叠用的 select 元素（DOM 元素或 ID）
     */
    constructor(select) {
        this.selectEl = typeof select === 'string' ? document.getElementById(select) : select;

        // ===== 当前选择状态 =====
        this.ratio = '1:1';   // 画面比例
        this.tier = '2K';     // 分辨率档位
        this.modelId = null;  // 当前模型（决定档位可用性）

        // 自定义面板相关的事件处理器引用（重建面板时需先解绑，防止重复绑定）
        this.toggleHandler = null;
        this.outsideClickHandler = null;

        this.init();
    }

    /**
     * 初始化：绑定折叠 select 的回退行为
     */
    init() {
        if (!this.selectEl) return;

        // 键盘操作原生 select 触发 change 时收起自定义面板，避免两套 UI 状态不一致
        this.selectEl.addEventListener('change', () => this.closePanel());
    }

    /**
     * 获取当前选中的画面比例
     * @returns {string} 如 '1:1'、'16:9'、'auto'
     */
    getRatio() {
        return this.ratio;
    }

    /**
     * 获取当前选中的分辨率档位
     * @returns {string} 如 '1K'、'2K'、'4K'
     */
    getTier() {
        return this.tier;
    }

    /**
     * 同步当前模型（模型切换/列表刷新时由宿主组件调用）
     * 若当前档位整档低于模型最小总像素（如 Seedream 4.5 不支持 1K），
     * 可见地切换到最低可用档，保证面板状态与实际可生成的尺寸一致
     * @param {string} modelId - 模型 ID
     */
    setModel(modelId) {
        const minArea = LlmResolution.getMinTotalPixels(modelId);
        if (minArea > 0) {
            const tiers = LlmResolution.getResolutionTiers();
            const current = tiers.find((t) => t.label === this.tier);
            if (current && current.longEdge * current.longEdge < minArea) {
                const fallback = tiers.find((t) => t.longEdge * t.longEdge >= minArea);
                if (fallback) this.tier = fallback.label;
            }
        }
        this.modelId = modelId;

        // render 在折叠选项文本未变化时会跳过面板重建，
        // 这里强制重建一次，让档位的禁用标记与最新模型保持同步
        this.render();
        if (this.selectEl) this.decorateOptions();
    }

    /**
     * 显示或隐藏尺寸选择器（仅绘图模型需要显示）
     * @param {boolean} visible - 是否显示
     */
    setVisible(visible) {
        if (!this.selectEl) return;

        this.selectEl.style.display = visible ? '' : 'none';
        if (visible) this.render();
    }

    /**
     * 刷新折叠 select 的选项文本，并按需重建自定义面板
     * 仅在选项 HTML 发生变化时才重建，避免不必要的 DOM 重绘与状态丢失
     */
    render() {
        if (!this.selectEl) return;

        // 折叠 select 的 option 保存合并值 "ratio|tier"，文本显示 "ratio / tier"
        const currentValue = `${this.ratio}|${this.tier}`;
        const optionsHtml = LlmResolution.getSizeOptions().map((ratio) => {
            const isSelected = ratio === this.ratio;
            const text = `${LumenLight.escapeHtml(ratio)} / ${LumenLight.escapeHtml(this.tier)}`;
            return `<option value="${LumenLight.escapeHtml(ratio)}|${LumenLight.escapeHtml(this.tier)}" ${isSelected ? 'selected' : ''}>${text}</option>`;
        }).join('');

        if (this.selectEl.innerHTML === optionsHtml) return;

        this.selectEl.innerHTML = optionsHtml;
        this.selectEl.value = currentValue;
        this.decorateOptions();
    }

    /**
     * 收起自定义下拉面板
     */
    closePanel() {
        const wrap = this.selectEl?.parentElement?.querySelector('.llm-size-options-wrap');
        if (wrap) wrap.style.display = 'none';
    }

    /**
     * 渲染自定义双选下拉面板：上段比例、下段分辨率档位
     * 点击任一段选项后更新当前选择并重新渲染折叠按钮（面板保持展开，便于连续调整）
     */
    decorateOptions() {
        if (!this.selectEl) return;

        // 移除旧的装饰层与事件监听，防止切换模型时重复绑定
        const oldWrap = this.selectEl.parentElement?.querySelector('.llm-size-options-wrap');
        const wasOpen = oldWrap && oldWrap.style.display === 'block';
        if (oldWrap) oldWrap.remove();
        if (this.toggleHandler) {
            this.selectEl.removeEventListener('mousedown', this.toggleHandler);
            this.toggleHandler = null;
        }
        if (this.outsideClickHandler) {
            document.removeEventListener('click', this.outsideClickHandler);
            this.outsideClickHandler = null;
        }

        const wrap = document.createElement('div');
        wrap.className = 'llm-size-options-wrap two-section';
        wrap.style.display = wasOpen ? 'block' : 'none';
        // 面板内部任何点击都不触发 document 关闭监听
        wrap.addEventListener('click', (e) => e.stopPropagation());

        wrap.appendChild(this.buildRatioSection());
        wrap.appendChild(this.buildTierSection());

        this.selectEl.parentElement.insertBefore(wrap, this.selectEl.nextSibling);

        // 点击 select 时显示/隐藏自定义下拉（阻止原生下拉弹出）
        this.toggleHandler = (e) => {
            e.preventDefault();
            const isShown = wrap.style.display === 'block';
            wrap.style.display = isShown ? 'none' : 'block';
        };
        this.selectEl.addEventListener('mousedown', this.toggleHandler);

        // 点击外部关闭
        this.outsideClickHandler = (e) => {
            if (!this.selectEl.parentElement.contains(e.target)) {
                wrap.style.display = 'none';
            }
        };
        document.addEventListener('click', this.outsideClickHandler);
    }

    /**
     * 构建「比例」段：图标形状 + 比例文字的网格
     * @returns {HTMLElement} 比例段容器
     */
    buildRatioSection() {
        const section = document.createElement('div');
        section.className = 'llm-size-section';

        const header = document.createElement('div');
        header.className = 'llm-size-section-header';
        header.textContent = '比例';
        section.appendChild(header);

        const grid = document.createElement('div');
        grid.className = 'llm-size-ratio-grid';
        LlmResolution.getSizeOptions().forEach((ratio) => {
            const item = document.createElement('div');
            item.className = 'llm-size-option ratio-option';
            if (ratio === this.ratio) item.classList.add('active');

            const icon = document.createElement('span');
            icon.className = 'llm-size-option-icon';
            const shape = document.createElement('span');
            shape.className = 'ratio-shape';
            if (ratio === 'auto') {
                // “自动”显示为短横线
                shape.style.cssText = 'width:14px;height:1px;background-color:rgba(255,255,255,0.55);';
            } else {
                const [wStr, hStr] = ratio.split(':');
                shape.style.cssText = LlmResolution.getRatioIconStyle(parseInt(wStr, 10), parseInt(hStr, 10));
            }
            icon.appendChild(shape);

            const text = document.createElement('span');
            text.className = 'llm-size-option-text';
            text.textContent = ratio === 'auto' ? '自动' : ratio;

            item.appendChild(icon);
            item.appendChild(text);
            item.addEventListener('click', (e) => {
                e.stopPropagation();   // 阻止冒泡，避免 document 监听器把面板关掉
                this.ratio = ratio;
                this.render();
                // 不关闭面板，方便用户继续选择分辨率档位
            });
            grid.appendChild(item);
        });
        section.appendChild(grid);

        return section;
    }

    /**
     * 构建「分辨率」段：档位按钮网格
     * @returns {HTMLElement} 档位段容器
     */
    buildTierSection() {
        const section = document.createElement('div');
        section.className = 'llm-size-section';

        const header = document.createElement('div');
        header.className = 'llm-size-section-header';
        header.textContent = '分辨率';
        section.appendChild(header);

        const grid = document.createElement('div');
        grid.className = 'llm-size-tier-grid';
        // 低于模型最小总像素的档位整档禁用（1:1 面积最大的比例都不达标时，
        // 该档位任何比例都不可用）
        const minArea = LlmResolution.getMinTotalPixels(this.modelId);
        LlmResolution.getResolutionTiers().forEach((tier) => {
            const item = document.createElement('div');
            item.className = 'llm-size-tier-option';
            if (tier.label === this.tier) item.classList.add('active');
            const belowModelLimit = minArea > 0 && tier.longEdge * tier.longEdge < minArea;
            if (belowModelLimit) {
                item.classList.add('disabled');
                item.title = '低于当前模型的最低像素要求';
            }
            item.textContent = tier.label;
            item.addEventListener('click', (e) => {
                e.stopPropagation();   // 阻止冒泡，避免 document 监听器把面板关掉
                if (belowModelLimit) return;
                this.tier = tier.label;
                this.render();
                // 不关闭面板，方便用户继续调整比例或档位
            });
            grid.appendChild(item);
        });
        section.appendChild(grid);

        return section;
    }
}

// 将 LlmSizePicker 类暴露到全局作用域
window.LlmSizePicker = LlmSizePicker;
