/**
 * ==========================================================================
 * LumenLight 通用自定义下拉（LumenDropdown）
 * ==========================================================================
 * 作用：替代原生 <select> 的 trigger + menu 下拉组件。交互范式与提示词
 *       节点技能栏（PromptSkillBar）一致，视觉遵循配色美学色板
 *       （.trae/skills/配色美学/SKILL.md）。
 *
 *   - 触发器：调用方提供的元素（通常是把原生 select 换成的 button），
 *     组件接管其内部结构：当前选项文案 + 展开箭头
 *   - 菜单：挂在 body 上、fixed 定位，展开于触发器上方（本项目的
 *     下拉都位于屏幕底部区域），空间不足时自动改为向下弹；
 *     超高自动滚动，打开时自动把当前选中项滚到可视区
 *   - 键盘：↑↓ 移动高亮、Enter 选中、Esc 关闭；
 *     触发器上 ↓ / Enter / 空格 打开
 *   - 关闭时机：选中后、点击组件外、Esc、页面滚动（capture 捕获）、窗口缩放
 *
 * 使用方式：
 *   const dd = new LumenDropdown(buttonEl, { onChange: value => ... });
 *   dd.setOptions([{ value, label }], selectedValue);
 *   dd.value;                 // 当前选中值
 *   dd.setVisible(false);     // 隐藏触发器（等价于原 select 的 display 切换）
 * ==========================================================================
 */

class LumenDropdown {
    /**
     * @param {HTMLElement} trigger - 触发器元素（原生 select 替换成的 button）
     * @param {Object} [options]
     * @param {Function} [options.onChange] - 选中变化回调 (value) => void
     * @param {string} [options.menuClass] - 菜单附加样式类
     * @param {string} [options.placeholder] - 无选项时的占位文案
     * @param {boolean} [options.iconButton] - 图标按钮模式：触发器只显示
     *        静态线条图标（不显示选项文案），当前选中在菜单里以对勾标记
     * @param {string} [options.triggerIcon] - 图标按钮模式的线条图标路径
     *        （Feather 风格 inner SVG，由组件统一包 svg 壳）
     */
    constructor(trigger, options = {}) {
        this.trigger = trigger;
        this.onChange = options.onChange || null;
        this.placeholder = options.placeholder || '';
        this.menuClass = options.menuClass || '';
        this.iconButton = !!options.iconButton;
        this.triggerIcon = options.triggerIcon || '';

        this.value = '';              // 当前选中值
        this.options = [];            // [{ value, label }]
        this.menuEl = null;           // 菜单元素（挂 body，open 时创建）
        this._activeIndex = -1;       // 键盘导航高亮索引
        this._open = false;

        this._buildTriggerUI();
        this._bind();
    }

    /** 触发器内部结构：
     *  - 图标按钮模式：仅静态线条图标（当前选中在菜单里以对勾标记，
     *    悬停 title 显示当前选中项全文，展开时按钮变强调蓝）
     *  - 文本模式：选项图标 + 选项文案 + 展开箭头
     *  按钮保留调用方的 id/class 样式 */
    _buildTriggerUI() {
        this.trigger.classList.add('lumen-dd-trigger');
        this.trigger.setAttribute('aria-haspopup', 'listbox');

        if (this.iconButton) {
            this.trigger.classList.add('lumen-dd-icon-btn');
            this.trigger.innerHTML =
                '<span class="lumen-dd-icon">' + this._svgShell(this.triggerIcon) + '</span>';
            this._iconEl = this.trigger.querySelector('.lumen-dd-icon');
            return;
        }

        this.trigger.innerHTML =
            '<span class="lumen-dd-icon"></span>' +
            '<span class="lumen-dd-label"></span>' +
            '<svg class="lumen-dd-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<polyline points="6 9 12 15 18 9"/></svg>';
        this._iconEl = this.trigger.querySelector('.lumen-dd-icon');
        this._labelEl = this.trigger.querySelector('.lumen-dd-label');
        this._setTriggerTitle('');
    }

    /** 把 Feather 风格的线条路径包进统一壳（白色描边、随图标容器着色） */
    _svgShell(inner) {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
    }

    /** 同步触发器上的选项图标 */
    _setTriggerIcon(opt) {
        this._iconEl.innerHTML = opt && opt.icon ? this._svgShell(opt.icon) : '';
    }

    _setTriggerTitle(label) {
        // 完整选项文案放 title，超宽截断时悬停可看全文
        this.trigger.title = label || '';
    }

    /**
     * 设置选项列表与选中值。
     * 内容与上次完全一致时跳过重渲染（保留打开状态，避免无谓重建）。
     * @param {Array<{value: string, label: string}>} list - 选项列表
     * @param {string} [selectedValue] - 要选中的值（缺省保持当前值）
     */
    setOptions(list, selectedValue) {
        const fingerprint = JSON.stringify(list);
        if (fingerprint === this._optionsFingerprint) {
            if (selectedValue !== undefined && selectedValue !== this.value) {
                this.value = selectedValue;
                this._refreshSelectionUI();
            }
            return;
        }
        this._optionsFingerprint = fingerprint;
        this.options = list.slice();

        // 关闭状态下重渲染；打开中先收起（选项集变化属于低频操作）
        if (this._open) this.close();

        // 选中值：显式指定优先；否则保持当前值（若仍存在于列表）；否则第一项
        let chosen = selectedValue !== undefined ? selectedValue : this.value;
        if (!this.options.some((o) => o.value === chosen)) {
            chosen = this.options.length > 0 ? this.options[0].value : '';
        }
        this.value = chosen;

        const current = this.options.find((o) => o.value === this.value);
        // 图标按钮模式没有文案/动态图标元素，只更新悬停 title（当前选中全文）
        this._setTriggerTitle(current ? current.label : '');
        if (!this.iconButton) {
            this._labelEl.textContent = current ? current.label : this.placeholder;
            this._setTriggerIcon(current);
        }
        this._refreshSelectionUI();
    }

    /** 当前选中值 */
    get value() {
        return this._value !== undefined ? this._value : '';
    }

    set value(v) {
        this._value = v;
    }

    /** 隐藏/显示触发器（等价于原 select 的 display 切换） */
    setVisible(visible) {
        this.trigger.style.display = visible ? '' : 'none';
        if (!visible && this._open) this.close();
    }

    /** 下拉是否展开 */
    get isOpen() {
        return this._open;
    }

    /** 展开菜单：挂 body、按触发器位置定位（默认向上弹，空间不足向下弹） */
    open() {
        if (this._open || this.options.length === 0) return;
        this._open = true;
        this.trigger.setAttribute('aria-expanded', 'true');

        this.menuEl = document.createElement('div');
        this.menuEl.className = 'lumen-dropdown-menu' + (this.menuClass ? ' ' + this.menuClass : '');
        this.menuEl.setAttribute('role', 'listbox');

        // 渲染选项
        this._activeIndex = Math.max(0, this.options.findIndex((o) => o.value === this.value));
        this.options.forEach((opt, i) => {
            const item = document.createElement('div');
            item.className = 'lumen-dropdown-option' +
                (opt.value === this.value ? ' selected' : '') +
                (i === this._activeIndex ? ' active' : '');
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', opt.value === this.value ? 'true' : 'false');
            item.dataset.value = opt.value;
            item.dataset.index = String(i);
            // 纯白线条图标（Feather 风格路径由调用方提供）
            if (opt.icon) {
                const icon = document.createElement('span');
                icon.className = 'lumen-dd-icon';
                icon.innerHTML = this._svgShell(opt.icon);
                item.appendChild(icon);
            }
            const label = document.createElement('span');
            label.className = 'dd-label';
            label.textContent = opt.label;
            item.appendChild(label);
            const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            check.setAttribute('class', 'dd-check');
            check.setAttribute('viewBox', '0 0 24 24');
            check.setAttribute('fill', 'none');
            check.setAttribute('stroke', 'currentColor');
            check.setAttribute('stroke-width', '2.4');
            check.setAttribute('stroke-linecap', 'round');
            check.setAttribute('stroke-linejoin', 'round');
            check.innerHTML = '<polyline points="20 6 9 17 4 12"/>';
            item.appendChild(check);
            item.addEventListener('click', () => {
                this._selectByIndex(i);
            });
            this.menuEl.appendChild(item);
        });

        document.body.appendChild(this.menuEl);
        this._positionMenu();
        this._scrollActiveIntoView();
        this.trigger.classList.add('lumen-dd-open');
    }

    /** 收起菜单 */
    close() {
        if (!this._open) return;
        this._open = false;
        this.trigger.setAttribute('aria-expanded', 'false');
        this.trigger.classList.remove('lumen-dd-open');
        if (this.menuEl && this.menuEl.parentNode) {
            this.menuEl.parentNode.removeChild(this.menuEl);
        }
        this.menuEl = null;
    }

    /** 定位菜单：默认展开于触发器上方；上方空间不足时改为向下弹 */
    _positionMenu() {
        if (!this.menuEl) return;
        const rect = this.trigger.getBoundingClientRect();
        const menuH = this.menuEl.offsetHeight;
        const menuW = Math.max(rect.width, 200);
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let left = rect.left;
        if (left + menuW > vw - 8) left = vw - 8 - menuW;
        if (left < 8) left = 8;

        let top = rect.top - menuH - 6;         // 向上弹（本项目下拉都在底部区域）
        if (top < 8) top = rect.bottom + 6;     // 上方放不下：向下弹

        this.menuEl.style.left = left + 'px';
        this.menuEl.style.top = top + 'px';
        this.menuEl.style.width = menuW + 'px';
    }

    /** 把键盘高亮项滚动到可视区 */
    _scrollActiveIntoView() {
        if (!this.menuEl) return;
        const active = this.menuEl.querySelector('.lumen-dropdown-option.active');
        if (active) active.scrollIntoView({ block: 'nearest' });
    }

    /** 刷新菜单内选项的选中对勾与高亮 */
    _refreshSelectionUI() {
        if (!this.menuEl) return;
        this.menuEl.querySelectorAll('.lumen-dropdown-option').forEach((item) => {
            const selected = item.dataset.value === this.value;
            item.classList.toggle('selected', selected);
            item.setAttribute('aria-selected', selected ? 'true' : 'false');
        });
    }

    /** 按索引选中选项：更新值/文案/对勾，收起菜单，回调 onChange */
    _selectByIndex(index) {
        const opt = this.options[index];
        if (!opt) return;
        const changed = opt.value !== this.value;
        this.value = opt.value;
        this._setTriggerTitle(opt.label);
        if (!this.iconButton) {
            this._labelEl.textContent = opt.label;
            this._setTriggerIcon(opt);
        }
        this.close();
        this._refreshSelectionUI();
        if (changed && this.onChange) this.onChange(opt.value);
    }

    /** 绑定触发器与全局事件（destroy 时成对移除） */
    _bind() {
        this._onTriggerClick = () => {
            this._open ? this.close() : this.open();
        };
        this._onTriggerKeydown = (e) => {
            if (!this._open) {
                // 关闭态：↓ / Enter / 空格 打开
                if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.open();
                }
                return;
            }
            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    this._activeIndex = Math.min(this._activeIndex + 1, this.options.length - 1);
                    this._paintActive();
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    this._activeIndex = Math.max(this._activeIndex - 1, 0);
                    this._paintActive();
                    break;
                case 'Enter':
                    e.preventDefault();
                    this._selectByIndex(this._activeIndex);
                    break;
                case 'Escape':
                    e.preventDefault();
                    this.close();
                    break;
            }
        };
        this._onOutsideMousedown = (e) => {
            if (!this._open) return;
            if (this.menuEl && this.menuEl.contains(e.target)) return;
            if (this.trigger.contains(e.target)) return;
            this.close();
        };
        this._onEsc = (e) => {
            if (this._open && e.key === 'Escape') this.close();
        };
        // 页面任何滚动都收起菜单，避免 fixed 菜单与触发器脱节；
        // 例外：菜单自己内部的滚动（滚轮翻选项列表）是正常交互，不收起——
        // 否则选项多到出滚动条时，滚轮一滚菜单就消失
        this._onScrollClose = (e) => {
            if (!this._open) return;
            if (this.menuEl && this.menuEl.contains(e.target)) return;
            this.close();
        };
        this._onResize = () => {
            if (this._open) this.close();
        };

        this.trigger.addEventListener('click', this._onTriggerClick);
        this.trigger.addEventListener('keydown', this._onTriggerKeydown);
        document.addEventListener('mousedown', this._onOutsideMousedown);
        document.addEventListener('keydown', this._onEsc);
        document.addEventListener('scroll', this._onScrollClose, true);
        window.addEventListener('resize', this._onResize);
    }

    /** 键盘高亮绘制 */
    _paintActive() {
        if (!this.menuEl) return;
        this.menuEl.querySelectorAll('.lumen-dropdown-option').forEach((item, i) => {
            item.classList.toggle('active', i === this._activeIndex);
        });
        this._scrollActiveIntoView();
    }

    /** 解绑全部事件（当前无节点销毁场景，预留对称接口） */
    destroy() {
        this.close();
        this.trigger.removeEventListener('click', this._onTriggerClick);
        this.trigger.removeEventListener('keydown', this._onTriggerKeydown);
        document.removeEventListener('mousedown', this._onOutsideMousedown);
        document.removeEventListener('keydown', this._onEsc);
        document.removeEventListener('scroll', this._onScrollClose, true);
        window.removeEventListener('resize', this._onResize);
    }
}

// 将 LumenDropdown 类暴露到全局作用域
window.LumenDropdown = LumenDropdown;
