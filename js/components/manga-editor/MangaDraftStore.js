/**
 * ==========================================================================
 * MangaEditor 子模块：草稿持久化收口（自 MangaEditor.js 拆出）
 * 作用：保存语义灯箱化（ADR 072）——自动保存退役，显式保存（保存钮/关闭
 *       确认「保存并关闭」）是唯一持久化写：草稿变更只标脏（_scheduleSave
 *       25 处调用点零改动），_saveNow 落盘（项目化路由，失败报错不推进
 *       保存点）、首次构建后 GET 恢复（normalizeDraft 宽松归一，GET 返回前
 *       用户已动手则远端作废的竞态闸）。未保存的改动退窗/刷新即还原为
 *       上次保存态（灯箱同语义），F5 有 beforeunload 拦截兜底。
 * 契约：原型混入（partial-class，ADR 026）——方法 Object.assign 进
 *       MangaEditor.prototype，this 即编辑器实例；须后于主类加载。
 *       脏标记/竞态闸存实例字段（_saveDirty/_draftTouched/_saveAbort）；
 *       fetch/setTimeout/AbortController 用裸全局引用——测试经 vm
 *       context 注入桩，不得改成捕获式引用。
 * ==========================================================================
 */

Object.assign(window.MangaEditor.prototype, {

    // ==================== 草稿持久化（ADR 072：显式保存是唯一持久化写） ====================

    /** 草稿变更 → 只标脏不落盘（未保存的改动在退窗/刷新时还原，灯箱同语义） */
    _scheduleSave() {
        this._saveDirty = true;
    },

    /** 显式落盘（保存钮/关闭确认/切项目确认共用）。返回是否成功；失败时
     *  脏标记保留、调用方不得推进保存点（关窗确认仍视作脏） */
    async _saveNow() {
        // 掐掉在途的旧保存，避免乱序覆盖（单用户本地应用，最新草稿为准）
        if (this._saveAbort) this._saveAbort.abort();
        const ac = new AbortController();
        this._saveAbort = ac;
        // 项目化（ADR 071）：当前项目落 data/manga/<id>/draft.json；
        // 无项目（默认草稿兜底）落旧全局 manga-draft.json
        const url = this.currentProjectId
            ? '/api/manga-projects/' + encodeURIComponent(this.currentProjectId) + '/draft'
            : '/api/manga-draft';
        try {
            const r = await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ draft: { pages: this.pages, active: this.activePage } }),
                signal: ac.signal
            });
            const result = await r.json().catch(() => null);
            if (r.ok && result && result.status === 'ok') {
                this._saveDirty = false;
                return true;
            }
            this._status('保存失败：' + ((result && result.message) || r.status), true);
            return false;
        } catch (err) {
            if (err && err.name === 'AbortError') return false;
            this._status('保存失败：' + (err && err.message ? err.message : err), true);
            return false;
        } finally {
            if (this._saveAbort === ac) this._saveAbort = null;
        }
    },

    /**
     * 存档形状归一为多页文档 { pages:[页草稿...], active }：
     * 文档形态逐页走 normalizeDraft 宽松归一（救不回的页丢弃）；旧单页
     * 草稿（无 pages 字段，一期数据）自动迁移为单页文档；全部救不回 → null
     */
    _normalizeDocument(saved) {
        const rawPages = saved && Array.isArray(saved.pages) ? saved.pages : [saved];
        const pages = [];
        for (const raw of rawPages) {
            const page = CoordinateLayout.normalizeDraft(raw);
            if (!page) continue;
            // 图层/笔迹（漫画侧专属，MangaLayers 混入）：normalizeDraft 是
            // 双编辑器共享的宽松归一，不认识漫画专属字段——在此带回。
            // drawLayers 逐项守卫直收；旧平铺 strokes（图层系统上线前的
            // 数据）自动包成单个笔迹图层垫底
            if (raw && Array.isArray(raw.drawLayers)) {
                page.drawLayers = raw.drawLayers.filter((l) => l && typeof l === 'object');
            } else if (raw && Array.isArray(raw.strokes)) {
                page.drawLayers = raw.strokes.length
                    ? [{ id: 1, name: '图层 1', visible: true, strokes: raw.strokes }]
                    : [];
            }
            pages.push(page);
        }
        if (!pages.length) return null;
        let active = saved && Number.isInteger(saved.active) ? saved.active : 0;
        active = Math.max(0, Math.min(pages.length - 1, active));
        return { pages, active };
    },

    /**
     * 首次构建后恢复上次文档（项目化，ADR 071）：localStorage
     * lumenLight.mangaLastProject 指向上次项目 → GET /api/manga-projects/:id
     * 载入；无记录/项目已失效 → 回落最近使用的项目（补遗三：存在任何项目
     * 时编辑器恒在项目内工作，生图转存/资源归集才有归属）；全无项目才兜底
     * 旧全局草稿 /api/manga-draft（currentProjectId 置 null）。GET →
     * 归一/迁移 → 替换默认文档
     */
    async _loadSavedDraft() {
        let saved = null;
        let loadedProject = null;
        const lastId = localStorage.getItem('lumenLight.mangaLastProject') || '';
        // 项目列表一次拉取（已按最近使用排序）：lastId 命中优先，否则收编首个
        let projects = [];
        try {
            const r = await fetch('/api/manga-projects');
            const result = await r.json().catch(() => null);
            if (r.ok && result && result.status === 'ok') projects = result.projects || [];
        } catch { /* 后端不可达：静默用默认文档 */ }
        let target = projects.find((p) => p.id === lastId) || null;
        if (!target && projects.length) target = projects[0];
        if (target) {
            try {
                const r = await fetch('/api/manga-projects/' + encodeURIComponent(target.id));
                const result = await r.json().catch(() => null);
                if (r.ok && result && result.status === 'ok') {
                    saved = result.draft;   // 空项目为 null → 下方按默认单页开进该项目
                    loadedProject = result.project || { id: target.id, name: target.name };
                    localStorage.setItem('lumenLight.mangaLastProject', target.id);
                } else if (target.id === lastId) {
                    localStorage.removeItem('lumenLight.mangaLastProject');   // 项目已被删
                }
            } catch { /* 后端不可达：静默用默认文档 */ }
        }
        if (this._draftTouched) return;   // GET 返回前用户已动手，远端作废
        if (loadedProject) {
            const doc = saved !== null ? this._normalizeDocument(saved) : null;
            this._applyLoadedDocument(doc || { pages: [CoordinateLayout.createDraft()], active: 0 }, loadedProject);
            this._status(`已打开项目「${loadedProject.name}」（${(doc ? doc.pages.length : 0) || 1} 页）`);
            return;
        }
        try {
            const r = await fetch('/api/manga-draft');
            const result = await r.json().catch(() => null);
            if (r.ok && result && result.status === 'ok') saved = result.draft;
        } catch { /* 后端不可达：静默用默认文档 */ }
        if (saved === null) return;
        const doc = this._normalizeDocument(saved);
        if (!doc) return;                 // 坏到救不回来：保持默认文档
        this._applyLoadedDocument(doc, null);
        this._status(doc.pages.length > 1 ? `已恢复上次文档（${doc.pages.length} 页）` : '已恢复上次草稿');
    },
});
