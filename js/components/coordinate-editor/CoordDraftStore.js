/**
 * ==========================================================================
 * CoordinateEditor 子模块：草稿自动持久化（自 CoordinateEditor.js 拆出）
 * 作用：草稿自动保存到后端 data/coordinate-draft.json（/api/coordinate-draft，
 *       全局单份，ADR 018）——变更 800ms 防抖 PUT（成功静默清脏、失败状态栏
 *       报错保留脏标记下次重试、在途保存 abort 防乱序覆盖）、F5/关页
 *       keepalive 兜底补发、首次构建后 GET 恢复（normalizeDraft 宽松归一，
 *       GET 返回前用户已动手则远端作废的竞态闸）。
 * 契约：原型混入（partial-class，ADR 026）——方法 Object.assign 进
 *       CoordinateEditor.prototype，this 即编辑器实例；须后于主类加载。
 *       定时器/脏标记/竞态闸存实例字段（_saveTimer/_saveDirty/
 *       _draftTouched/_saveAbort）；fetch/setTimeout/AbortController 用
 *       裸全局引用——测试经 vm context 注入桩，不得改成捕获式引用。
 * ==========================================================================
 */

Object.assign(window.CoordinateEditor.prototype, {

    // ==================== 草稿持久化（ADR 018） ====================

    /** 草稿变更 → 800ms 防抖后 PUT（成功静默，失败状态栏提示，下次变更自然重试） */
    _scheduleSave() {
        this._saveDirty = true;
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => { this._saveTimer = null; this._saveNow(); }, 800);
    },

    async _saveNow() {
        // 掐掉在途的旧保存，避免乱序覆盖（单用户本地应用，最新草稿为准）
        if (this._saveAbort) this._saveAbort.abort();
        const ac = new AbortController();
        this._saveAbort = ac;
        try {
            const r = await fetch('/api/coordinate-draft', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ draft: this.draft }),
                signal: ac.signal
            });
            const result = await r.json().catch(() => null);
            if (r.ok && result && result.status === 'ok') {
                this._saveDirty = false;
            } else {
                this._status('草稿自动保存失败：' + ((result && result.message) || r.status), true);
            }
        } catch (err) {
            if (err && err.name === 'AbortError') return;
            this._status('草稿自动保存失败：' + (err && err.message ? err.message : err), true);
        } finally {
            if (this._saveAbort === ac) this._saveAbort = null;
        }
    },

    /** F5/关页兜底：有未落盘变更时用 keepalive 补发（请求生命周期越过页面卸载） */
    _flushSave() {
        if (!this._saveDirty) return;
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
        try {
            fetch('/api/coordinate-draft', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ draft: this.draft }),
                keepalive: true
            }).catch(() => { /* 页面已卸载，无从提示 */ });
            this._saveDirty = false;
        } catch { /* keepalive 不可用时静默放弃 */ }
    },

    /** 首次构建后恢复上次草稿（GET → normalizeDraft 宽松归一 → 替换默认草稿） */
    async _loadSavedDraft() {
        let saved = null;
        try {
            const r = await fetch('/api/coordinate-draft');
            const result = await r.json().catch(() => null);
            if (r.ok && result && result.status === 'ok') saved = result.draft;
        } catch { /* 后端不可达：静默用默认草稿 */ }
        if (saved === null) return;
        if (this._draftTouched) return;   // GET 返回前用户已动手，远端作废
        const draft = CoordinateLayout.normalizeDraft(saved);
        if (!draft) return;               // 坏到救不回来：保持默认草稿
        this.draft = draft;
        this.selected = -1;
        this._resetHistory();   // 恢复态为新基线：撤销不越过本次恢复
        this._renderAll();
        if (draft.background) this._loadBackgroundImg(draft.background);   // 背景引用随草稿恢复（CoordBackground 混入）
        this._syncBackgroundUi();
        this._status('已恢复上次草稿');
    },
});
