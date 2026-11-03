/**
 * ==========================================================================
 * MangaEditor 子模块：分镜模板（2026-11-07 新增，ADR 078）
 * 作用：标题栏「分镜模板」按钮（「背景」右边，同款文字按钮）+ 模板弹窗
 *       ——两 tab（预设模板 / 我的模板）卡片网格，缩略图由格子数据现画
 *       （canvas 线稿，不存图片文件）。点卡片 = 把模板格子换算成元素框
 *       **替换当前页全部元素框**（页上已有元素先确认，一步撤销；
 *       2026-11-08 用户拍板「应用到新页」＋角标退役，点击是唯一应用入口）。
 *       「我的模板」tab 底部输入名字可把当前页元素框保存为模板（同名
 *       覆盖），卡片右上角 ✕ 可删除。
 * 数据：模板 = { name, cells }，cells 是 0~1 归一化坐标格子（x/y/w/h，
 *       label/shot 可选），与画幅解耦——应用时按当前页 width/height 换算
 *       回绝对 xyxy（CoordinateLayout.normalizeBox 钳制）。只存几何 +
 *       label/shot，不存 caption/title（文案是每页创作内容，模板不带）。
 *       后端 /api/manga-templates（routes/mangaTemplates.js，presets/ 与
 *       user/ 两目录，一个模板一个 JSON）。
 * 契约：原型混入（partial-class，ADR 026）——方法 Object.assign 进
 *       MangaEditor.prototype，this 即编辑器实例；须后于主类加载。
 * 对应：css/manga-editor.css（manga-tpl-* 区段）；按钮复用 manga-bg-btn
 *       样式类（同「背景」文字按钮观感）。
 * ==========================================================================
 */

/** 元素 label 允许的三种类型（与 CoordinateLayout.ITEM_LABELS 同源口径；
 *  经典 script 下 CoordinateLayout 暴露的是函数集合，这里独立枚举防依赖） */
const MANGA_TPL_LABELS = ['object', 'character', 'text'];

Object.assign(window.MangaEditor.prototype, {

    // ==================== 标题栏按钮（MangaDom._buildDom 调用） ====================

    _buildTemplateTools() {
        const header = this.dialog.querySelector('.recipe-dialog-header');
        if (!header || !this.bgBtn) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'manga-bg-btn';
        btn.title = '分镜模板：套用预设布局替换当前页元素框，或把当前页存为自己的模板';
        btn.textContent = '分镜模板';
        btn.addEventListener('click', () => this._openTemplatePopup());
        this.bgBtn.after(btn);   // 插在「背景」右边
        this._tplBtnEl = btn;
    },

    // ==================== 模板弹窗（懒建于首次打开） ====================

    _openTemplatePopup() {
        if (!this._tplMaskEl) this._buildTemplatePopup();
        this._positionTemplatePanel();
        this._tplMaskEl.hidden = false;
        this._loadTemplateList().catch((err) => {
            this._status('模板列表加载失败：' + ((err && err.message) || err), true);
        });
    },

    /**
     * 面板定位（用户拍板 2026-11-07）：固定盖在左栏（整体描述+元素卡片
     * 那块 aside.manga-side）的实测矩形上——标题栏「分镜模板」按钮正下方，
     * 大小=左栏那块（宽度随窗口分摊变化，不能写死），内容超高网格内部
     * 滚动。左栏元素缺失时回落居中定宽（is-centered）
     */
    _positionTemplatePanel() {
        if (!this._tplMaskEl || !this._tplPanelEl) return;
        const anchor = this.dialog.querySelector('.manga-side:not(.manga-out-side)');
        if (!anchor) {
            this._tplMaskEl.classList.add('is-centered');
            this._tplPanelEl.style.left = this._tplPanelEl.style.top = '';
            this._tplPanelEl.style.width = this._tplPanelEl.style.height = '';
            return;
        }
        this._tplMaskEl.classList.remove('is-centered');
        const rect = anchor.getBoundingClientRect();
        const p = this._tplPanelEl.style;
        p.left = rect.left + 'px';
        p.top = rect.top + 'px';
        p.width = rect.width + 'px';
        p.height = rect.height + 'px';
    },

    _closeTemplatePopup() {
        if (this._tplMaskEl) this._tplMaskEl.hidden = true;
    },

    _buildTemplatePopup() {
        const mask = document.createElement('div');
        mask.className = 'manga-tpl-mask';
        mask.hidden = true;
        mask.innerHTML = `
            <div class="manga-tpl-panel">
                <div class="manga-tpl-head">
                    <span>分镜模板</span>
                    <button type="button" class="manga-tpl-close" title="关闭">✕</button>
                </div>
                <div class="manga-tpl-tabs">
                    <button type="button" class="manga-tpl-tab" data-tab="preset">预设模板</button>
                    <button type="button" class="manga-tpl-tab" data-tab="user">我的模板</button>
                </div>
                <div class="manga-tpl-grid"></div>
                <div class="manga-tpl-foot">
                    <input type="text" class="manga-tpl-name-input" maxlength="40"
                        placeholder="模板名（把当前页元素框保存为模板）">
                    <button type="button" class="manga-tpl-save">保存当前页为模板</button>
                </div>
            </div>
        `;
        this.dialog.appendChild(mask);
        this._tplMaskEl = mask;
        this._tplPanelEl = mask.querySelector('.manga-tpl-panel');
        this._tplGridEl = mask.querySelector('.manga-tpl-grid');
        this._tplNameInputEl = mask.querySelector('.manga-tpl-name-input');
        this._tplTab = this._tplTab || 'preset';   // 会话内记忆所选 tab

        mask.querySelector('.manga-tpl-close').addEventListener('click', () => this._closeTemplatePopup());
        // 窗口尺寸变化跟随重定位（编辑器并排留白/窄屏都会改左栏矩形）
        window.addEventListener('resize', () => {
            if (this._tplMaskEl && !this._tplMaskEl.hidden) this._positionTemplatePanel();
        });
        // 点遮罩空白关闭（点面板内部不关）
        mask.addEventListener('mousedown', (e) => {
            if (e.target === mask) this._closeTemplatePopup();
        });
        // tab 切换
        for (const tabBtn of mask.querySelectorAll('.manga-tpl-tab')) {
            tabBtn.addEventListener('click', () => {
                this._tplTab = tabBtn.dataset.tab;
                this._renderTemplatePopup();
            });
        }
        // 保存当前页为模板
        mask.querySelector('.manga-tpl-save').addEventListener('click', () => this._saveCurrentAsTemplate());
        this._tplNameInputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this._saveCurrentAsTemplate();
            }
        });
        this._renderTemplatePopup();
    },

    /** 拉清单并重渲染（打开弹窗 / 保存 / 删除后共用） */
    async _loadTemplateList() {
        const r = await fetch('/api/manga-templates');
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || j.status !== 'ok') {
            throw new Error((j && j.message) || ('HTTP ' + r.status));
        }
        this._tplPresets = Array.isArray(j.presets) ? j.presets : [];
        this._tplUser = Array.isArray(j.user) ? j.user : [];
        this._renderTemplatePopup();
    },

    _renderTemplatePopup() {
        if (!this._tplMaskEl) return;
        // tab 高亮与计数
        const presetCount = this._tplPresets ? this._tplPresets.length : 0;
        const userCount = this._tplUser ? this._tplUser.length : 0;
        for (const tabBtn of this._tplMaskEl.querySelectorAll('.manga-tpl-tab')) {
            const isPreset = tabBtn.dataset.tab === 'preset';
            tabBtn.classList.toggle('active', this._tplTab === tabBtn.dataset.tab);
            tabBtn.textContent = isPreset ? `预设模板 ${presetCount}` : `我的模板 ${userCount}`;
        }
        // 「我的模板」tab 才显示保存行
        this._tplMaskEl.querySelector('.manga-tpl-foot')
            .classList.toggle('is-visible', this._tplTab === 'user');
        // 卡片网格
        const grid = this._tplGridEl;
        grid.innerHTML = '';
        const list = this._tplTab === 'user' ? this._tplUser : this._tplPresets;
        if (!list || !list.length) {
            const empty = document.createElement('div');
            empty.className = 'manga-tpl-empty';
            empty.textContent = this._tplTab === 'user'
                ? '还没有自己的模板——在下方输入名字，把当前页元素框保存为模板'
                : '暂无预设模板';
            grid.appendChild(empty);
            return;
        }
        for (const tpl of list) {
            grid.appendChild(this._buildTemplateCard(tpl));
        }
    },

    _buildTemplateCard(tpl) {
        const card = document.createElement('div');
        card.className = 'manga-tpl-card';
        card.title = `${tpl.name}（${(tpl.cells || []).length} 格）——点击替换当前页元素框`;
        const cv = document.createElement('canvas');
        const name = document.createElement('div');
        name.className = 'manga-tpl-name';
        name.textContent = tpl.name;
        card.append(cv, name);
        this._drawTemplateThumb(cv, tpl);

        // 我的模板才有删除角标（✕）；应用只有点击卡片一个入口（用户拍板
        // 2026-11-08：「应用到新页」＋角标退役）
        if (this._tplTab === 'user') {
            const acts = document.createElement('div');
            acts.className = 'manga-tpl-acts';
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'manga-tpl-act is-danger';
            delBtn.title = '删除此模板';
            delBtn.textContent = '✕';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._deleteTemplate(tpl);
            });
            acts.appendChild(delBtn);
            card.appendChild(acts);
        }

        card.addEventListener('click', () => this._applyTemplate(tpl));
        return card;
    },

    /** 模板缩略图：按当前页画幅比例现画格子线稿（深底白线，与编辑器同观感） */
    _drawTemplateThumb(cv, tpl) {
        const d = this.draft;
        const aspect = d.width > 0 && d.height > 0 ? d.width / d.height : 1;
        const W = 100, MAXH = 100;
        const w = aspect >= 1 ? W : Math.max(48, Math.round(W * aspect));
        const h = aspect >= 1 ? Math.max(48, Math.round(W / aspect)) : MAXH;
        const dpr = window.devicePixelRatio || 1;
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
        cv.style.width = w + 'px';
        cv.style.height = h + 'px';
        const ctx = cv.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        // 页底（深色卡面上衬一层微亮，格子线用白）
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.4;
        for (const c of (Array.isArray(tpl.cells) ? tpl.cells : [])) {
            if (!c || typeof c !== 'object') continue;
            const x = Number(c.x), y = Number(c.y), cw = Number(c.w), ch = Number(c.h);
            if (![x, y, cw, ch].every(Number.isFinite)) continue;
            ctx.strokeRect(x * w + 0.5, y * h + 0.5, Math.max(1, cw * w - 1), Math.max(1, ch * h - 1));
        }
    },

    // ==================== 格子 ↔ 元素框换算（纯逻辑，Jest 可单测） ====================

    /**
     * 归一化格子 → 当前页元素框：按 draft.width/height 换算回绝对 xyxy
     * （normalizeBox 钳进画幅），cid 就地分配，label 缺省 object，
     * caption 置空串（合法中间态，编译前由用户/AI 补）；无效格子跳过
     */
    _tplCellsToItems(cells) {
        const d = this.draft;
        const items = [];
        for (const c of (Array.isArray(cells) ? cells : [])) {
            if (!c || typeof c !== 'object') continue;
            const x = Number(c.x), y = Number(c.y), w = Number(c.w), h = Number(c.h);
            if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
            const bbox = CoordinateLayout.normalizeBox(
                [x * d.width, y * d.height, (x + w) * d.width, (y + h) * d.height],
                d.width, d.height);
            const item = {
                cid: this._nextCid++,
                label: MANGA_TPL_LABELS.includes(c.label) ? c.label : 'object',
                caption: '',
                bbox
            };
            if (typeof c.shot === 'string' && c.shot) item.shot = c.shot;
            items.push(item);
        }
        return items;
    },

    /**
     * 当前页元素框 → 归一化格子（保存模板用）：bbox 除以画幅，钳 0~1；
     * 只带走几何 + label/shot，caption/title（页内创作内容）不进模板；
     * 无效条目跳过
     */
    _tplItemsToCells(items) {
        const d = this.draft;
        const clamp01 = (v) => Math.min(1, Math.max(0, v));
        const cells = [];
        for (const it of (Array.isArray(items) ? items : [])) {
            if (!it || typeof it !== 'object' || !Array.isArray(it.bbox) || it.bbox.length !== 4) continue;
            const [x1, y1, x2, y2] = it.bbox.map(Number);
            if (![x1, y1, x2, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) continue;
            const cell = {
                x: clamp01(x1 / d.width),
                y: clamp01(y1 / d.height),
                w: clamp01((x2 - x1) / d.width),
                h: clamp01((y2 - y1) / d.height)
            };
            if (MANGA_TPL_LABELS.includes(it.label)) cell.label = it.label;
            if (typeof it.shot === 'string' && it.shot) cell.shot = it.shot;
            cells.push(cell);
        }
        return cells;
    },

    // ==================== 应用模板（替换当前页元素框） ====================

    /**
     * 应用模板：替换当前页全部元素框（页上有元素先确认，页级快照一步
     * 撤销，图层/背景/笔迹不动）。AI 写作进行中拦下（防回填落错页，
     * 切页守卫同口径）
     */
    async _applyTemplate(tpl) {
        if (!tpl || !Array.isArray(tpl.cells) || !tpl.cells.length) {
            this._status('模板没有分镜格', true);
            return;
        }
        if (this.aiRunning) {
            this._status('AI 写提示词进行中，完成后再应用模板', true);
            return;
        }
        if (this._textEdit) this._commitTextEdit();
        if (this.draft.items.length) {
            const ok = await this.pageConfirmDialog.confirm({
                title: `应用「${tpl.name}」？`,
                note: `当前页已有 ${this.draft.items.length} 个元素框，将被模板整体替换（可 Ctrl+Z 撤销）`,
                okText: '替换'
            });
            if (!ok) return;
        }
        const items = this._tplCellsToItems(tpl.cells);
        if (!items.length) {
            this._status('模板分镜格数据无效', true);
            return;
        }
        const before = this._histSnapshot();
        this.draft.items = items;
        this.selected = -1;
        this._commitHistory(before, '应用分镜模板');
        this._invalidateCompiled();
        this._renderItems();
        this._renderStage();
        this._status(`已应用「${tpl.name}」（${items.length} 格，原元素框已替换）`);
        this._closeTemplatePopup();
    },

    // ==================== 保存 / 删除我的模板 ====================

    /** 当前页元素框保存为模板（同名覆盖；caption/title 不带走） */
    async _saveCurrentAsTemplate() {
        const input = this._tplNameInputEl;
        const name = ((input && input.value) || '').trim();
        if (!name) {
            this._status('请先填写模板名', true);
            if (input) input.focus();
            return;
        }
        if (!this.draft.items.length) {
            this._status('当前页没有元素框，先画分镜再保存', true);
            return;
        }
        const cells = this._tplItemsToCells(this.draft.items);
        if (!cells.length) {
            this._status('当前页元素框数据无效，无法保存', true);
            return;
        }
        try {
            const r = await fetch('/api/manga-templates', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, cells })
            });
            const j = await r.json().catch(() => null);
            if (!r.ok || !j || j.status !== 'ok') {
                throw new Error((j && j.message) || ('HTTP ' + r.status));
            }
            this._status(j.overwritten ? `已覆盖同名模板「${name}」` : `已保存模板「${name}」`);
            if (input) input.value = '';
            this._tplTab = 'user';
            await this._loadTemplateList();
        } catch (err) {
            this._status('模板保存失败：' + ((err && err.message) || err), true);
        }
    },

    async _deleteTemplate(tpl) {
        const ok = await this.pageConfirmDialog.confirm({
            title: `删除模板「${tpl.name}」？`,
            note: '删除后不可恢复',
            okText: '删除'
        });
        if (!ok) return;
        try {
            const r = await fetch('/api/manga-templates/user/' + encodeURIComponent(tpl.id),
                { method: 'DELETE' });
            const j = await r.json().catch(() => null);
            if (!r.ok || !j || j.status !== 'ok') {
                throw new Error((j && j.message) || ('HTTP ' + r.status));
            }
            this._status(`已删除模板「${tpl.name}」`);
            await this._loadTemplateList();
        } catch (err) {
            this._status('模板删除失败：' + ((err && err.message) || err), true);
        }
    },
});
