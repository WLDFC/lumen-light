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
     * @param {boolean} [options.actionMenu] - 动作型菜单：选项是随时可
     *        重复执行的动作而非互斥状态，菜单里不打选中对勾（配合
     *        setLabel 让触发器文案保持动作名不变）
     */
    constructor(trigger, options = {}) {
        this.trigger = trigger;
        this.onChange = options.onChange || null;
        this.placeholder = options.placeholder || '';
        this.menuClass = options.menuClass || '';
        this.iconButton = !!options.iconButton;
        this.triggerIcon = options.triggerIcon || '';
        this.actionMenu = !!options.actionMenu;

        this.value = '';              // 当前选中值
        this.options = [];            // [{ value, label }]（分类模式下为全部分类的展平列表）
        this._categories = null;      // 分类数据（setCategories 设置；setOptions 复位）
        this._activeCatKey = '';      // 分类模式下左栏当前停留的分类
        this.menuEl = null;           // 菜单元素（挂 body，open 时创建）
        this._activeIndex = -1;       // 键盘导航高亮索引（按菜单内可见项序）
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
        this._categories = null;      // 平铺模式与分类模式互斥，后调用者定形态
        this.options = list.slice();

        // 关闭状态下重渲染；打开中先收起（选项集变化属于低频操作）
        if (this._open) this.close();

        // 选中值：显式指定优先；否则保持当前值（若仍存在于列表）；否则第一项
        let chosen = selectedValue !== undefined ? selectedValue : this.value;
        if (!this.options.some((o) => o.value === chosen)) {
            chosen = this.options.length > 0 ? this.options[0].value : '';
        }
        this.value = chosen;
        this._syncTrigger();
        this._refreshSelectionUI();
    }

    /**
     * 设置分类选项（双栏菜单形态：左栏分类、右侧该分类的条目列表）。
     * 选中值仍是跨分类单选（与 setOptions 同一 value 空间），分类只决定
     * 右侧列表的过滤，不构成独立选择。
     * @param {Array<{key: string, label: string, items: Array<{value, label,
     *        sublabel?, icon?}>, emptyText?}>} categories - 分类数组；
     *        items 为空的分类显示 emptyText 引导文案
     * @param {string} [selectedValue] - 要选中的值（缺省保持当前值）
     */
    setCategories(categories, selectedValue) {
        const cats = Array.isArray(categories) ? categories : [];
        const fingerprint = JSON.stringify(cats);
        if (fingerprint === this._optionsFingerprint) {
            if (selectedValue !== undefined && selectedValue !== this.value) {
                this.value = selectedValue;
                this._activeCatKey = this._catOf(selectedValue) || this._activeCatKey;
                this._refreshSelectionUI();
            }
            return;
        }
        this._optionsFingerprint = fingerprint;
        this._categories = cats;
        // 展平为 options：value 查找/触发器文案/既有消费方（读 .options）零改动
        this.options = [];
        for (const c of cats) {
            for (const item of (Array.isArray(c.items) ? c.items : [])) {
                this.options.push(item);
            }
        }

        if (this._open) this.close();

        let chosen = selectedValue !== undefined ? selectedValue : this.value;
        if (!this.options.some((o) => o.value === chosen)) {
            chosen = this.options.length > 0 ? this.options[0].value : '';
        }
        this.value = chosen;
        // 左栏停留分类：选中值所在分类优先，否则第一个分类
        this._activeCatKey = this._catOf(chosen) || (cats[0] && cats[0].key) || '';
        this._syncTrigger();
        this._refreshSelectionUI();
    }

    /** 值所属的分类 key（分类模式）；平铺模式恒返回 '' */
    _catOf(value) {
        if (!this._categories) return '';
        for (const c of this._categories) {
            if ((Array.isArray(c.items) ? c.items : []).some((it) => it.value === value)) {
                return c.key;
            }
        }
        return '';
    }

    /** 按值取选项对象 */
    _findOpt(value) {
        return this.options.find((o) => o.value === value) || null;
    }

    /** 同步触发器（图标 + 文案 + 悬停全文）为当前选中项 */
    _syncTrigger() {
        const current = this._findOpt(this.value);
        this._setTriggerTitle(current ? current.label : '');
        if (!this.iconButton) {
            this._labelEl.textContent = current ? current.label : this.placeholder;
            this._setTriggerIcon(current);
        }
    }

    /** 当前选中值 */
    get value() {
        return this._value !== undefined ? this._value : '';
    }

    set value(v) {
        this._value = v;
    }

    /**
     * 改写触发器文案（不改当前值与菜单对勾状态）。
     * 供「动作型」下拉使用：菜单项是动作而非状态（如编组工具栏"布局"），
     * 选中执行后由调用方把触发器文案恢复为动作名，避免触发器
     * 变成"宫格布局"与菜单项文案重复
     * @param {string} text - 触发器文案
     */
    setLabel(text) {
        if (this._labelEl) this._labelEl.textContent = text;
        this._setTriggerTitle(text);
    }

    /** 隐藏/显示触发器（等价于原 select 的 display 切换） */
    setVisible(visible) {
        this.trigger.style.display = visible ? '' : 'none';
        if (!visible && this._open) this.close();
    }

    /**
     * 重定位展开中的菜单（未展开时无操作）。
     * 触发器被外部力量移动时由调用方在移动时机调用，让 fixed 菜单
     * 跟随而不脱节——画布视口缩放/平移不是 scroll/resize，组件自带的
     * 两种自动收起路径都覆盖不到，照 UpscaleManager 子菜单的
     * reposition 惯例由宿主在 canvasViewportChanged 时机调用
     */
    reposition() {
        if (this._open) this._positionMenu();
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

        if (this._categories) {
            // ---- 分类双栏形态：左栏分类 + 右侧该分类条目 ----
            this.menuEl.classList.add('categorized');
            const rail = document.createElement('div');
            rail.className = 'lumen-dd-cats';
            for (const cat of this._categories) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'lumen-dd-cat' + (cat.key === this._activeCatKey ? ' active' : '');
                btn.textContent = cat.label || cat.key;
                btn.addEventListener('click', () => {
                    if (this._activeCatKey === cat.key) return;
                    this._activeCatKey = cat.key;
                    rail.querySelectorAll('.lumen-dd-cat').forEach((b) => {
                        b.classList.toggle('active', b === btn);
                    });
                    this._renderCategoryItems(listWrap);
                    // 列表条数变化会改变菜单高度：top 是打开时按旧高度算的，
                    // 不重定位会出现"单条目分类悬空一截 / 多条目分类向下长出
                    // 屏幕被裁"——切换后必须按新高度重新定位与钳制
                    this._positionMenu();
                    this._scrollActiveIntoView();
                });
                rail.appendChild(btn);
            }
            const listWrap = document.createElement('div');
            listWrap.className = 'lumen-dd-cat-list';
            this.menuEl.append(rail, listWrap);
            this._renderCategoryItems(listWrap);
        } else {
            // ---- 平铺形态（既有行为）----
            this._activeIndex = Math.max(0, this.options.findIndex((o) => o.value === this.value));
            this.options.forEach((opt, i) => {
                const item = this._buildOptionRow(opt, i === this._activeIndex);
                item.addEventListener('click', () => {
                    this._selectByIndex(i);
                });
                this.menuEl.appendChild(item);
            });
        }

        document.body.appendChild(this.menuEl);
        this._positionMenu();
        this._scrollActiveIntoView();
        this.trigger.classList.add('lumen-dd-open');
    }

    /**
     * 构建一个选项行（平铺与分类两形态共用）：图标 + 文案（分类形态带
     * 副标签两行展示）+ 选中对勾
     * @param {Object} opt - 选项 { value, label, sublabel?, icon? }
     * @param {boolean} [active] - 是否带键盘高亮
     * @returns {HTMLElement}
     */
    _buildOptionRow(opt, active = false) {
        const item = document.createElement('div');
        item.className = 'lumen-dropdown-option' +
            (opt.value === this.value ? ' selected' : '') +
            (active ? ' active' : '');
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', opt.value === this.value ? 'true' : 'false');
        item.dataset.value = opt.value;
        if (opt.icon) {
            const icon = document.createElement('span');
            icon.className = 'lumen-dd-icon';
            icon.innerHTML = this._svgShell(opt.icon);
            item.appendChild(icon);
        }
        // 分类形态支持两行条目（主文案 + 副标签如厂商名）；平铺保持单行
        if (opt.sublabel !== undefined && this._categories) {
            const text = document.createElement('span');
            text.className = 'dd-text';
            const label = document.createElement('span');
            label.className = 'dd-label';
            label.textContent = opt.label;
            const sub = document.createElement('span');
            sub.className = 'dd-sublabel';
            sub.textContent = opt.sublabel;
            text.append(label, sub);
            item.appendChild(text);
        } else {
            const label = document.createElement('span');
            label.className = 'dd-label';
            label.textContent = opt.label;
            item.appendChild(label);
        }
        // 选中对勾：动作型菜单不渲染（动作无"当前选中"语义）
        if (!this.actionMenu) {
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
        }
        return item;
    }

    /** 渲染分类模式下右侧条目列表（切分类/重建菜单时调用） */
    _renderCategoryItems(listWrap) {
        listWrap.innerHTML = '';
        const cat = this._categories.find((c) => c.key === this._activeCatKey);
        const items = (cat && Array.isArray(cat.items)) ? cat.items : [];
        if (items.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'lumen-dd-cat-empty';
            empty.textContent = (cat && cat.emptyText) || '该分类暂无条目';
            listWrap.appendChild(empty);
            this._activeIndex = -1;
            return;
        }
        this._activeIndex = Math.max(0, items.findIndex((o) => o.value === this.value));
        items.forEach((opt, i) => {
            const item = this._buildOptionRow(opt, i === this._activeIndex);
            item.addEventListener('click', () => {
                this._selectByValue(opt.value);
            });
            listWrap.appendChild(item);
        });
    }

    /** 按值选中：更新值/触发器/对勾，收起菜单，回调 onChange */
    _selectByValue(value) {
        const opt = this._findOpt(value);
        if (!opt) return;
        const changed = opt.value !== this.value;
        this.value = opt.value;
        // 分类模式下顺带把左栏停留分类对齐到所选值（下次打开停在该分类）
        if (this._categories) this._activeCatKey = this._catOf(value) || this._activeCatKey;
        this._syncTrigger();
        this.close();
        this._refreshSelectionUI();
        // 动作型菜单每次都触发（重复执行同一动作是正常使用）；
        // 状态型菜单仅值变化时触发
        if ((changed || this.actionMenu) && this.onChange) this.onChange(opt.value);
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

    /** 定位菜单：默认展开于触发器上方；上方空间不足且下方更宽裕时向下弹。
     *  分类双栏形态用固定高度（350px，切换分类忽高忽低体验差）——空分类
     *  留白、长列表内部滚动；视口放不下时按可用空间收缩。平铺形态维持
     *  按内容自适应 + 320px 上限。切换分类改变内容后由调用方重新调用 */
    _positionMenu() {
        if (!this.menuEl) return;
        const rect = this.trigger.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        // 上/下可用空间（各留 8px 屏幕边距 + 6px 间隙）：择大者作为可用高度，
        // 最小 140px 保住可滚动性——两侧都挤时宁可内滚也不消失
        const spaceUp = rect.top - 14;
        const spaceDown = vh - rect.bottom - 14;
        const avail = Math.max(140, Math.max(spaceUp, spaceDown));
        if (this._categories) {
            this.menuEl.style.maxHeight = 'none';
            this.menuEl.style.height = Math.min(350, avail) + 'px';
        } else {
            this.menuEl.style.maxHeight = Math.min(320, avail) + 'px';
        }

        const menuH = this.menuEl.offsetHeight;
        const menuW = Math.max(rect.width, this._categories ? 380 : 200);

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

    /** 按可见项索引选中（键盘 Enter 用）：平铺形态 DOM 序 == options 序，
     *  分类形态 DOM 序 == 当前分类条目序，统一走 DOM dataset 取值 */
    _selectByIndex(index) {
        if (!this.menuEl) return;
        const item = this.menuEl.querySelectorAll('.lumen-dropdown-option')[index];
        if (item) this._selectByValue(item.dataset.value);
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
                case 'ArrowDown': {
                    e.preventDefault();
                    // 分类模式下可见项 = 当前分类条目，上界按 DOM 实际项数
                    const count = this.menuEl
                        ? this.menuEl.querySelectorAll('.lumen-dropdown-option').length
                        : this.options.length;
                    if (count === 0) break;
                    this._activeIndex = Math.min(this._activeIndex + 1, count - 1);
                    this._paintActive();
                    break;
                }
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
