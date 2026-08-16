/**
 * ==========================================================================
 * LumenLight 数量步进器（CountStepper）
 * ==========================================================================
 * 作用：紧凑的"数值框 + 上下箭头"数量输入控件的行为层，画布 Comfy 生图
 *       节点与右侧面板 Comfy 模式共用。职责：
 *         - 上/下箭头步进 ±1
 *         - 直接键入：非数字字符即时过滤、超 4 位截断（1-9999）
 *         - 清空/非法值在失焦/回车时回落当前值
 *       数值存取经 handlers.get/set 委托给宿主的状态持有方
 *       （两侧都是 ComfyParamRows 的 state.count），本类不持有状态。
 *
 * 样式分上下文两档：组件只挂行为，外观由宿主 CSS 决定——
 * 画布节点在 css/node.css（--ns 体系），面板在 css/prompt-panel.css。
 * ==========================================================================
 */

class CountStepper {
    /**
     * @param {Object} hosts - DOM 元素
     * @param {HTMLInputElement} hosts.input - 数值输入框
     * @param {HTMLButtonElement} hosts.up - 上箭头按钮
     * @param {HTMLButtonElement} hosts.down - 下箭头按钮
     * @param {Object} handlers - 数值存取委托
     * @param {() => number} handlers.get - 读当前值
     * @param {(value: number|string) => number} handlers.set - 写入并返回钳制后的值
     */
    constructor(hosts, handlers) {
        this.input = hosts.input;
        this.up = hosts.up;
        this.down = hosts.down;
        this.get = handlers.get;
        this.set = handlers.set;

        if (!this.input) return;

        this.up?.addEventListener('click', () => {
            this.input.value = this.set(this.get() + 1);
        });
        this.down?.addEventListener('click', () => {
            this.input.value = this.set(this.get() - 1);
        });

        // 键入：只留数字，超 4 位截断（上限 9999）
        this._onInput = () => {
            const digits = this.input.value.replace(/\D/g, '').slice(0, 4);
            if (digits !== this.input.value) this.input.value = digits;
        };
        this.input.addEventListener('input', this._onInput);

        // 失焦/回车提交：清空/非法回落当前值，合法值钳制回写
        this._commit = () => {
            if (this.input.value === '') {
                this.input.value = this.get();
                return;
            }
            this.input.value = this.set(this.input.value);
        };
        this.input.addEventListener('blur', this._commit);
        this._onKeyDown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this._commit();
                this.input.blur();
            }
        };
        this.input.addEventListener('keydown', this._onKeyDown);
    }

    /**
     * 把宿主当前值同步到输入框显示（状态被外部重置后调用）
     */
    sync() {
        if (this.input) this.input.value = this.get();
    }

    /**
     * 销毁：移除挂在输入框上的监听（动态宿主销毁时调用）
     */
    destroy() {
        if (!this.input) return;
        this.input.removeEventListener('input', this._onInput);
        this.input.removeEventListener('blur', this._commit);
        this.input.removeEventListener('keydown', this._onKeyDown);
    }
}

// 将 CountStepper 类暴露到全局作用域
window.CountStepper = CountStepper;
