/**
 * ==========================================================================
 * MangaEditor 子模块：漫画项目管理（ADR 071 交付独立）
 * 作用：一本漫画 = data/manga/<id>/ 独立文件夹（project.json 元数据 +
 *       draft.json 草稿 + images/ 生图），顶栏「项目」钮弹项目面板——
 *       列表（封面/名称/页数）/新建/打开/改名/删除；打开编辑器恢复上次
 *       项目（localStorage lumenLight.mangaLastProject，无记录回落默认
 *       草稿）。当前项目态存 currentProjectId/currentProjectName：
 *       自动保存按项目路由（MangaDraftStore）、生成图转存项目夹
 *       （MangaGenerate._transferGenImage）、状态文案按归属汇报。
 * 「导出本页」钮（同在顶栏）：整页所见即所得合成一张 PNG 落画布视口中
 *       心（_exportPageToCanvas，主类）——唯一保留的画布交付口，逐层写
 *       回已退役（层与画布不再互相渗透）。
 * 打开项目遇未保存改动先弹确认（保存并打开 / 放弃修改，ADR 072——未保
 *       存改动不自动落盘也不静默丢弃）；删除当前项目后回落默认草稿。
 * 契约：原型混入（partial-class，ADR 026）——须后于主类加载
 *       （index.html 第十四混入）。
 * ==========================================================================
 */

Object.assign(window.MangaEditor.prototype, {

    // ==================== 载入态应用（项目/默认草稿共用） ====================

    /**
     * 把归一后的多页文档应用为编辑器当前态（_loadSavedDraft 与项目切换
     * 共用收口）：恢复态为新基线（撤销不越过）、保存点快照重建、脏标记
     * 清零（载入即干净态——未保存改动只活在内存，随切走丢弃）、全面板
     * 重渲染、项目钮标签跟进
     */
    _applyLoadedDocument(doc, project) {
        this._saveDirty = false;
        this.currentProjectId = project ? project.id : null;
        this.currentProjectName = project ? (project.name || project.id) : null;
        if (project) localStorage.setItem('lumenLight.mangaLastProject', project.id);
        this.pages = doc.pages;
        this.activePage = doc.active;
        this.draft = this.pages[this.activePage];
        this.selected = -1;
        this._selLayerId = null;
        if (typeof this._ensureDefaultLayerSelection === 'function') this._ensureDefaultLayerSelection();   // 灯箱同语义：进本即有选中层（调色/抠图开箱即用）
        this._resetHistory();   // 恢复态为新基线：撤销不越过本次恢复
        this._exportSnap = this._docSnapshot();   // 保存点基线随恢复重建（保存/关闭确认）
        this._renderAll();
        this._renderLayerPanel();   // 层栈随活动页恢复（面板停在首建空态，切页自愈的就是它）
        this._renderRail();     // 页面栏随恢复重建（rail 未建时方法自带守卫）
        if (this.draft.background) this._loadBackgroundImg(this.draft.background);   // 背景引用随活动页恢复（MangaBackground 混入）
        this._updateProjectBtnLabel();
    },

    /** 项目钮标签/提示跟随当前归属（无项目=默认草稿兜底态） */
    _updateProjectBtnLabel() {
        if (!this.projectBtn) return;
        this.projectBtn.textContent = this.currentProjectId ? '项目 ●' : '项目';
        this.projectBtn.title = this.currentProjectId
            ? `项目：当前「${this.currentProjectName}」（●=项目内；可切换/新建/删除）`
            : '项目：当前默认草稿（未入项目）——点此新建或打开项目（一本漫画一个独立文件夹，生成图落项目内）';
    },

    /**
     * 放弃修改后从服务端重载已保存态（关闭确认「直接关闭」的落地动作，
     * ADR 072）：只丢内存不重载的话，改动还留在内存，同一会话内重开编辑
     * 器看到的仍是改过的文档。项目归属走 _openProjectById（force=跳过脏
     * 确认），无项目=旧全局草稿兜底。重载失败保留内存现状并如实报错
     */
    async _reloadSavedDocument() {
        if (this.currentProjectId) {
            await this._openProjectById(this.currentProjectId, this.currentProjectName, { force: true });
            return;
        }
        try {
            const r = await fetch('/api/manga-draft');
            const result = await r.json().catch(() => null);
            const saved = (r.ok && result && result.status === 'ok') ? result.draft : null;
            const doc = this._normalizeDocument(saved) ||
                { pages: [CoordinateLayout.createDraft()], active: 0 };
            this._applyLoadedDocument(doc, null);
        } catch (err) {
            this._status('放弃修改后重载失败：' + (err && err.message ? err.message : err), true);
        }
    },

    // ==================== 项目面板（顶栏「项目」钮弹出） ====================

    _openProjectModal() {
        if (this._projModalEl) { this._projModalEl.hidden = false; }
        else {
            const el = document.createElement('div');
            el.className = 'manga-proj-modal';
            el.innerHTML = `
                <div class="manga-proj-panel">
                    <div class="manga-proj-head">
                        <span>漫画项目</span>
                        <button type="button" class="manga-proj-close" title="关闭项目面板">✕</button>
                    </div>
                    <div class="manga-proj-list"></div>
                    <div class="manga-proj-foot">
                        <input type="text" class="manga-proj-name" placeholder="新项目名称" maxlength="50">
                        <button type="button" class="manga-proj-create">＋ 新建项目</button>
                    </div>
                </div>
            `;
            el.querySelector('.manga-proj-close').addEventListener('click', () => { el.hidden = true; });
            el.addEventListener('mousedown', (e) => { if (e.target === el) el.hidden = true; });
            el.querySelector('.manga-proj-create').addEventListener('click', () => {
                const input = el.querySelector('.manga-proj-name');
                this._createProjectFlow(input.value.trim(), () => { input.value = ''; });
            });
            el.querySelector('.manga-proj-name').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    const input = el.querySelector('.manga-proj-name');
                    this._createProjectFlow(input.value.trim(), () => { input.value = ''; });
                }
            });
            this.dialog.appendChild(el);
            this._projModalEl = el;
        }
        this._refreshProjectList();
    },

    /** 拉列表渲染行：点行=打开（改名钮就地变输入框；删除钮两段确认） */
    async _refreshProjectList() {
        const listEl = this._projModalEl && this._projModalEl.querySelector('.manga-proj-list');
        if (!listEl) return;
        listEl.innerHTML = '<div class="manga-proj-empty">加载中…</div>';
        let projects = [];
        try {
            const r = await fetch('/api/manga-projects');
            const result = await r.json().catch(() => null);
            if (r.ok && result && result.status === 'ok') projects = result.projects || [];
        } catch { /* 后端不可达：如实显示 */ }
        if (!projects.length) {
            listEl.innerHTML = '<div class="manga-proj-empty">还没有项目——下方新建一本</div>';
            return;
        }
        listEl.innerHTML = '';
        for (const p of projects) {
            const row = document.createElement('div');
            row.className = 'manga-proj-row' + (p.id === this.currentProjectId ? ' is-current' : '');
            const coverHtml = p.cover
                ? `<img class="manga-proj-cover" src="/api/manga-projects/${p.id}/images/${p.cover}" alt="">`
                : '<div class="manga-proj-cover is-empty"></div>';
            row.innerHTML = `
                ${coverHtml}
                <div class="manga-proj-meta">
                    <div class="manga-proj-name-text"></div>
                    <div class="manga-proj-sub">${p.pages} 页 · ${new Date(p.updatedAt).toLocaleDateString()}</div>
                </div>
                <button type="button" class="manga-proj-rename" title="重命名">✎</button>
                <button type="button" class="manga-proj-del" title="删除项目（连同本地文件夹）">✕</button>
            `;
            row.querySelector('.manga-proj-name-text').textContent =
                p.name + (p.id === this.currentProjectId ? '（当前）' : '');
            row.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;   // 行内按钮不触发打开
                this._openProjectById(p.id, p.name);
            });
            row.querySelector('.manga-proj-rename').addEventListener('click', () => {
                const nameEl = row.querySelector('.manga-proj-name-text');
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'manga-proj-rename-input';
                input.value = p.name;
                input.maxLength = 50;
                nameEl.replaceWith(input);
                input.focus();
                input.select();
                const commit = async () => {
                    const name = input.value.trim();
                    if (name && name !== p.name) {
                        try {
                            await fetch('/api/manga-projects/' + encodeURIComponent(p.id), {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ name })
                            });
                            if (p.id === this.currentProjectId) this.currentProjectName = name;
                        } catch { /* 改名失败：行刷新回原名 */ }
                    }
                    this._refreshProjectList();
                };
                input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') this._refreshProjectList(); });
                input.addEventListener('blur', commit);
            });
            const delBtn = row.querySelector('.manga-proj-del');
            delBtn.addEventListener('click', () => {
                if (delBtn.dataset.arm) { this._deleteProjectFlow(p.id); return; }
                delBtn.dataset.arm = '1';
                delBtn.textContent = '确认?';
                delBtn.classList.add('is-armed');
                setTimeout(() => {
                    if (!delBtn.isConnected) return;
                    delete delBtn.dataset.arm;
                    delBtn.textContent = '✕';
                    delBtn.classList.remove('is-armed');
                }, 3000);
            });
            listEl.appendChild(row);
        }
    },

    /**
     * 打开项目。保存语义灯箱化（ADR 072）后当前项目有未保存改动先弹确认
     * （保存并打开 / 放弃修改）——未保存的改动不再自动落盘，也不能在切
     * 项目时静默持久化或静默丢弃。确认浮层 z20 盖不过项目弹窗 z40，先收
     * 弹窗再弹浮层
     */
    async _openProjectById(id, name, opts = {}) {
        if (!opts.force && this._isPageDirty()) {
            if (this._projModalEl) this._projModalEl.hidden = true;
            this._showSaveConfirm({
                text: '当前项目有未保存的修改，保存后打开吗？',
                saveLabel: '保存并打开',
                closeLabel: '放弃修改',
                onSave: async () => {
                    if (await this.save()) await this._openProjectById(id, name, { force: true });
                },
                onClose: () => this._openProjectById(id, name, { force: true }),   // 放弃：不落盘直接切
            });
            return;
        }
        try {
            const r = await fetch('/api/manga-projects/' + encodeURIComponent(id));
            const result = await r.json().catch(() => null);
            if (!r.ok || !result || result.status !== 'ok') {
                this._status('打开项目失败：' + ((result && result.message) || r.status), true);
                return;
            }
            if (result.draft === null) {
                this._status(`项目「${name}」还是空的，画第一笔吧`);
            }
            const doc = result.draft
                ? this._normalizeDocument(result.draft)
                : { pages: [CoordinateLayout.createDraft()], active: 0 };   // 空项目=默认单页
            if (!doc) { this._status('项目草稿损坏且救不回', true); return; }
            if (this._projModalEl) this._projModalEl.hidden = true;
            this._applyLoadedDocument(doc, result.project || { id, name });
            this._status(`已打开项目「${this.currentProjectName}」（${doc.pages.length} 页）`);
        } catch (err) {
            this._status('打开项目失败：' + (err && err.message ? err.message : err), true);
        }
    },

    async _createProjectFlow(name, after) {
        if (!name) { this._status('先填项目名再新建', true); return; }
        try {
            const r = await fetch('/api/manga-projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            const result = await r.json().catch(() => null);
            if (!r.ok || !result || result.status !== 'ok') {
                this._status('新建项目失败：' + ((result && result.message) || r.status), true);
                return;
            }
            if (after) after();
            // 新项目=空文档：直接切入（draft 为 null 时套默认单页结构）
            await this._openProjectById(result.project.id, result.project.name);
            this._refreshProjectList();
        } catch (err) {
            this._status('新建项目失败：' + (err && err.message ? err.message : err), true);
        }
    },

    async _deleteProjectFlow(id) {
        try {
            const r = await fetch('/api/manga-projects/' + encodeURIComponent(id), { method: 'DELETE' });
            const result = await r.json().catch(() => null);
            if (!r.ok || !result || result.status !== 'ok') {
                this._status('删除项目失败：' + ((result && result.message) || r.status), true);
                return;
            }
            this._status('项目已删除（本地文件夹一并移除）');
            if (id === this.currentProjectId) {
                // 删的是当前项目：回落默认草稿
                localStorage.removeItem('lumenLight.mangaLastProject');
                let saved = null;
                try {
                    const r2 = await fetch('/api/manga-draft');
                    const result2 = await r2.json().catch(() => null);
                    if (r2.ok && result2 && result2.status === 'ok') saved = result2.draft;
                } catch { /* 默认文档兜底 */ }
                const doc = this._normalizeDocument(saved) ||
                    { pages: [CoordinateLayout.createDraft()], active: 0 };   // 默认草稿缺/坏：空单页兜底
                this._applyLoadedDocument(doc, null);
            }
            this._refreshProjectList();
        } catch (err) {
            this._status('删除项目失败：' + (err && err.message ? err.message : err), true);
        }
    },
});
