/**
 * ==========================================================================
 * MangaEditor 子模块：左面板渲染与元素卡片（自 MangaEditor.js 拆出）
 * 作用：渲染总入口（_renderAll）与左栏——模式三选高亮、元素卡片列表
 *       整建（类型/景别/标题/描述/文字/四坐标，字段输入直写草稿不重建，
 *       文本按防抖合并成一步历史）、选中/删除、景别前缀换装（编辑器侧
 *       元数据，编译前剥离）、画幅应用（钳 16 倍数收回各框）、图层顺序
 *       （数组序 = 绘制序 = 命中优先级，重排联动三处）。
 * 契约：原型混入（partial-class，ADR 026）——方法 Object.assign 进
 *       MangaEditor.prototype，this 即编辑器实例；须后于主类加载。
 * 对应：css/manga-editor.css；卡片折叠/眼睛为视图态（localStorage
 *       不落盘，按 cid 记忆于实例集合——ADR 019 决策三）。
 * ==========================================================================
 */

/** 卡片眼睛钮图标（Feather eye / eye-off，13px 内联 svg） */
const MANGA_EYE_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const MANGA_EYE_OFF_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

Object.assign(window.MangaEditor.prototype, {

    // ==================== 渲染总入口 ====================

    _renderAll() {
        this.wInput.value = this.draft.width;
        this.hInput.value = this.draft.height;
        this.summaryTa.value = this.draft.summary.caption;
        this._renderModes();
        this._renderItems();
        this._renderStage();
    },

    _renderModes() {
        this.modesEl.querySelectorAll('.manga-mode-btn').forEach((b) =>
            b.classList.toggle('active', b.dataset.mode === this.draft.summary.canvas));
        this.modeDescEl.textContent = this._modeDesc[this.draft.summary.canvas] || '';
    },

    /**
     * 分区级眼睛图标同步（标题行，2026-11-07 用户拍板）：聚合态驱动——
     * 全部隐藏 = 划线眼（off 态），否则 = 普通眼。与单卡眼睛共用
     * _hiddenCids 视图态（页换失效），单卡切换后经 _renderItems 回到此处
     */
    _syncItemsEyeUi() {
        if (!this.itemsEyeEl) return;
        const items = this.draft.items || [];
        const hidden = this._hiddenCids || new Set();
        const allOff = items.length > 0 && items.every((it) => hidden.has(it.cid));
        this.itemsEyeEl.innerHTML = allOff ? MANGA_EYE_OFF_SVG : MANGA_EYE_SVG;
        this.itemsEyeEl.title = allOff ? '显示全部元素框' : '隐藏全部元素框（仅编辑器视图，不影响编译）';
        this.itemsEyeEl.classList.toggle('is-off', allOff);
    },

    /** 分区级眼睛点击：混合/全显态 → 全部隐藏；全隐态 → 全部显示（同一
     *  视图态集合，单卡眼睛随之联动；视图态不进编译不入历史） */
    _toggleAllItemsHidden() {
        const items = this.draft.items || [];
        if (!items.length) return;
        const hidden = this._hiddenCids || (this._hiddenCids = new Set());
        const allOff = items.every((it) => hidden.has(it.cid));
        if (allOff) items.forEach((it) => hidden.delete(it.cid));
        else items.forEach((it) => hidden.add(it.cid));
        this._renderItems();   // 单卡图标/is-hidden 态整建刷新（内含本钮同步）
        this._renderStage();
    },

    /** 元素卡片列表整建（结构变化时调用；字段输入用 input 事件直写草稿不重建） */
    _renderItems() {
        this._ensureItemIds();
        this.itemsEl.innerHTML = '';
        this.itemCountEl.textContent = this.draft.items.length ? `（${this.draft.items.length}）` : '';
        this._syncItemsEyeUi();   // 分区级眼睛图标随隐藏集合聚合态刷新
        this.draft.items.forEach((item, i) => {
            const color = this._colorFor(item.cid);
            // 卡片默认展开（完整表单），手动收起后按 cid 记忆；
            // is-hidden = 眼睛钮隐藏的框（舞台不画、不可命中、不参与磁吸）
            const collapsed = this._collapsedCids.has(item.cid);
            const hidden = this._hiddenCids.has(item.cid);
            const card = document.createElement('div');
            card.className = 'manga-item' + (i === this.selected ? ' selected' : '') +
                (collapsed ? ' collapsed' : '') + (hidden ? ' is-hidden' : '');
            card.dataset.index = i;
            card.innerHTML = `
                <div class="manga-item-head">
                    <span class="manga-item-dot" style="background:${color}"></span>
                    <span class="manga-item-num">${item.cid + 1}</span>
                    <select class="manga-item-label" title="元素类型">
                        ${Object.entries(this._labelText).map(([v, t]) =>
                            `<option value="${v}"${item.label === v ? ' selected' : ''}>${t}</option>`).join('')}
                    </select>
                    <select class="manga-item-shot" title="景别层次：选了会把景别词织进该元素的描述（编译产物仍是标准 MOSS 格式，景别是编辑器侧辅助）">
                        <option value="">景别</option>
                        ${this._shotOptions.map((s) =>
                            `<option value="${s}"${item.shot === s ? ' selected' : ''}>${s}</option>`).join('')}
                    </select>
                    <button type="button" class="manga-item-layer" title="图层顺序（上移/下移/置顶/置底）">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
                    </button>
                    <button type="button" class="manga-item-fold" title="展开/收起详情">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                    <button type="button" class="manga-item-eye" title="隐藏/显示该框"></button>
                    <button type="button" class="manga-item-del" title="删除该元素">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                </div>
                <input type="text" class="manga-item-title" placeholder="标题（可选，显示在框的标签上）">
                <textarea class="manga-item-caption" rows="4" placeholder="这块区域是什么：主体/动作/外观，或排印风格（AI 可代写）"></textarea>
                <input type="text" class="manga-item-text" placeholder="文字内容（逐字可见，支持 \\n 换行）"${item.label === 'text' ? '' : ' hidden'}>
                <div class="manga-item-bbox" title="bbox：x1, y1, x2, y2（左上角原点，像素）">
                    <input type="number" class="manga-bbox-n" data-k="0">
                    <input type="number" class="manga-bbox-n" data-k="1">
                    <input type="number" class="manga-bbox-n" data-k="2">
                    <input type="number" class="manga-bbox-n" data-k="3">
                </div>
            `;
            this.itemsEl.appendChild(card);

            const captionTa = card.querySelector('.manga-item-caption');
            const titleInput = card.querySelector('.manga-item-title');
            const textInput = card.querySelector('.manga-item-text');
            const labelSel = card.querySelector('.manga-item-label');
            const shotSel = card.querySelector('.manga-item-shot');
            const bboxInputs = card.querySelectorAll('.manga-bbox-n');
            captionTa.value = item.caption;
            titleInput.value = item.title || '';
            textInput.value = item.text || '';
            bboxInputs.forEach((inp) => { inp.value = item.bbox[Number(inp.dataset.k)]; });

            // 字段直写草稿（不重建列表，避免打断输入；文本合并成一步历史）
            // 标题：编辑器侧元数据（舞台标签显示，编译前剥离），空值删字段
            titleInput.addEventListener('input', () => {
                this._beginTextInputHist();
                const t = titleInput.value.trim();
                if (t) item.title = t; else delete item.title;
                this._invalidateCompiled();
                this._renderStage();       // 框上标签实时跟随
            });
            titleInput.addEventListener('blur', () => this._flushTextInputHist());
            captionTa.addEventListener('input', () => {
                this._beginTextInputHist();
                item.caption = captionTa.value;
                this._invalidateCompiled();
            });
            captionTa.addEventListener('blur', () => this._flushTextInputHist());
            textInput.addEventListener('input', () => {
                this._beginTextInputHist();
                item.text = textInput.value;
                this._invalidateCompiled();
            });
            textInput.addEventListener('blur', () => this._flushTextInputHist());
            labelSel.addEventListener('change', () => {
                const before = this._histSnapshot();
                item.label = labelSel.value;
                if (item.label === 'text' && !('text' in item)) item.text = '';
                if (item.label !== 'text') delete item.text;
                textInput.hidden = item.label !== 'text';
                this._commitHistory(before, '改类型');
                this._invalidateCompiled();
                this._renderStage();
            });
            shotSel.addEventListener('change', () => this._onShotChange(i, shotSel.value, captionTa));
            bboxInputs.forEach((inp) => inp.addEventListener('change', () => {
                const before = this._histSnapshot();
                const k = Number(inp.dataset.k);
                const box = item.bbox.slice();
                box[k] = Number(inp.value);
                item.bbox = CoordinateLayout.normalizeBox(box, this.draft.width, this.draft.height);
                bboxInputs.forEach((x) => { x.value = item.bbox[Number(x.dataset.k)]; });
                this._commitHistory(before, '改坐标');
                this._invalidateCompiled();
                this._renderStage();
            }));

            // 标题框可点选元素（折叠卡片唯一常驻的字段——点它也应选中，
            // 与点卡片空白处选中一致；不拦默认行为，输入不受影响）
            titleInput.addEventListener('pointerdown', () => {
                this._clickBurst = null;
                this._select(i);
            });

            // 点卡片（非控件区域）选中对应舞台框
            card.addEventListener('pointerdown', (e) => {
                if (e.target.closest('input, textarea, select, button')) return;
                this._clickBurst = null;   // 换选择途径，连点链作废
                this._select(i);
            });
            card.querySelector('.manga-item-del').addEventListener('click', () => this._deleteItem(i));

            // 折叠开关：只翻卡片类名，不重建列表（不打断其他卡片的输入焦点）
            card.querySelector('.manga-item-fold').addEventListener('click', () => {
                if (this._collapsedCids.has(item.cid)) this._collapsedCids.delete(item.cid);
                else this._collapsedCids.add(item.cid);
                card.classList.toggle('collapsed');
            });

            // 眼睛钮：隐藏/显示舞台上的框（视图态，按 cid 记忆；同步换图标）
            const eyeBtn = card.querySelector('.manga-item-eye');
            const syncEye = () => {
                const off = this._hiddenCids.has(item.cid);
                eyeBtn.innerHTML = off ? MANGA_EYE_OFF_SVG : MANGA_EYE_SVG;
                eyeBtn.title = off ? '显示该框' : '隐藏该框（仅编辑器视图，不影响编译）';
            };
            syncEye();
            eyeBtn.addEventListener('click', () => {
                if (this._hiddenCids.has(item.cid)) this._hiddenCids.delete(item.cid);
                else this._hiddenCids.add(item.cid);
                syncEye();
                card.classList.toggle('is-hidden');
                this._renderStage();
            });

            // 图层顺序下拉（动作型 LumenDropdown：图标按钮 + 无选中对勾；
            // 菜单挂 body——卡片容器 overflow 会裁剪内嵌菜单。动作带目标
            // 序号，触发时从 DOM data-index 取，避免重建后闭包过期）
            const layerBtn = card.querySelector('.manga-item-layer');
            const layerDd = new LumenDropdown(layerBtn, {
                iconButton: true,
                actionMenu: true,
                triggerIcon: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
                menuClass: 'manga-layer-menu',
                placeholder: '图层',
                onChange: (v) => {
                    const idx = Number(card.dataset.index);
                    if (Number.isInteger(idx)) {
                        this._clickBurst = null;
                        this._select(idx);
                        this._layerOp(v);
                    }
                    layerDd.setLabel('图层');
                }
            });
            layerDd.setOptions([
                { value: 'front', label: '置顶（画布最上层）' },
                { value: 'up', label: '上移一层' },
                { value: 'down', label: '下移一层' },
                { value: 'back', label: '置底（画布最下层）' }
            ], '');
        });
    },

    _select(i) {
        if (this._selLayerId != null) {
            // 元素选中与图片层选中互斥（MangaLayers）：选元素先放掉层
            this._selLayerId = null;
            this._syncLayerPanelUi();
        }
        if (this.selected === i) return;
        this.selected = i;
        // 只更新卡片选中态，不重建（避免滚跳与焦点丢失）
        this.itemsEl.querySelectorAll('.manga-item').forEach((c) =>
            c.classList.toggle('selected', Number(c.dataset.index) === i));
        this._renderStage();
    },

    _deleteItem(i) {
        const before = this._histSnapshot();
        this.draft.items.splice(i, 1);
        if (this.selected === i) this.selected = -1;
        else if (this.selected > i) this.selected--;
        this._clickBurst = null;
        this._commitHistory(before, '删除元素');
        this._invalidateCompiled();
        this._renderItems();
        this._renderStage();
    },

    /**
     * 景别切换（编辑器侧元数据，编译前剥离）：
     * 手写兜底 = 把景别词前缀进 caption（换景别自动换前缀、清除时摘掉前缀），
     * 已含该词（用户自己写过/AI 织入过）则不动；AI 路径另经 _aiFill 提示织入
     */
    _onShotChange(i, shot, captionTa) {
        const item = this.draft.items[i];
        if (!item) return;
        const before = this._histSnapshot();
        const old = item.shot || '';
        const stripPrefix = (text, word) =>
            word && text.startsWith(word + '，') ? text.slice(word.length + 1) : text;
        let caption = stripPrefix(item.caption, old);
        if (shot) {
            if (!caption.includes(shot)) caption = shot + '，' + caption;
            item.shot = shot;
        } else {
            delete item.shot;
        }
        item.caption = caption;
        if (captionTa) captionTa.value = caption;
        this._commitHistory(before, '改景别');
        this._invalidateCompiled();
        this._renderStage();   // 舞台角标同步显示「类型·景别」
    },

    // ==================== 画幅 ====================

    /** 应用新画幅：钳 16 倍数并把所有框收回画幅内 */
    _applyDims(w, h) {
        const before = this._histSnapshot();
        this.draft.width = w;
        this.draft.height = h;
        this.draft.items.forEach((item) => {
            item.bbox = CoordinateLayout.normalizeBox(item.bbox, w, h);
        });
        this.wInput.value = w;
        this.hInput.value = h;
        this._commitHistory(before, '改画幅');
        this._invalidateCompiled();
        this._renderItems();       // bbox 数值框同步
        this._renderStage();
    },

    // ==================== 图层顺序（数组序 = 绘制序 = 命中优先级） ====================

    /**
     * 图层操作：up/down 相邻交换、front 置顶（数组末位）、back 置底。
     * 重排联动三处：绘制顺序、命中优先级、卡片列表序号——选择下标跟随元素。
     * items 顺序会进编译产物，但 MOSS 是绝对坐标 bbox，模型不依赖顺序（ADR 017 决策十）
     * @param {'up'|'down'|'front'|'back'} op
     */
    _layerOp(op) {
        const from = this.selected;
        if (from < 0) { this._status('先选中一个元素再调整图层', true); return; }
        const items = this.draft.items;
        const n = items.length;
        let to = from;
        if (op === 'up') to = Math.min(n - 1, from + 1);
        else if (op === 'down') to = Math.max(0, from - 1);
        else if (op === 'front') to = n - 1;
        else if (op === 'back') to = 0;
        if (to === from) {
            this._status(op === 'up' || op === 'front' ? '已是最顶层' : '已是最底层');
            return;
        }
        const before = this._histSnapshot();
        const [item] = items.splice(from, 1);
        items.splice(to, 0, item);
        this.selected = to;
        this._clickBurst = null;
        this._commitHistory(before, '调图层');
        this._invalidateCompiled();
        this._renderItems();
        this._renderStage();
    },
});
