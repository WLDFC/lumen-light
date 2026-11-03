/**
 * ==========================================================================
 * MangaEditor 子模块：撤销/重做快照栈（自 MangaEditor.js 拆出）
 * 作用：快照式撤销/重做（ADR 017 决策十一）——草稿是纯 JSON 小对象，全量
 *       快照比命令闭包简单可靠（StudioHistory 同款取舍）。入账去重（删了
 *       又改回不入账）、重做分支截断、上限裁剪最旧；文本连续输入按防抖
 *       合并成一步（pending 挂起 + blur/撤销前立即结算，LIFO）；快捷键
 *       焦点守卫（并排形态面板内放行）。二期多页：快照分两种 kind——
 *       页级 {kind:'page', pageIdx, snap}（内容改动，按 pageIdx 精确落回
 *       所属页）与文档级 {kind:'doc', snap:{pages,active}}（页面增删移动），
 *       同一栈混存，回滚按 kind 各自归位。
 * 契约：原型混入（partial-class，ADR 026）——方法 Object.assign 进
 *       MangaEditor.prototype，this 即编辑器实例；须后于主类加载。
 *       栈与挂起状态存实例字段（_undoStack/_redoStack/_textHistPending/
 *       _histTimer）；setTimeout 用裸全局引用——测试经 vm context 注入
 *       桩（真实定时器或手动队列），不得改成捕获式引用。
 * ==========================================================================
 */

const MANGA_HIST_MAX = 50;          // 撤销栈上限（超出裁剪最旧）
const MANGA_HIST_DEBOUNCE = 1000;   // 文本连续输入合并成一步的窗口（ms）

Object.assign(window.MangaEditor.prototype, {

    // ==================== 撤销/重做（快照式，ADR 017 决策十一） ====================

    /**
     * 页级快照：内容改动（画框/文案/画幅）用。pageIdx 记住快照属于哪页，
     * 回滚时精确落回（跨页撤销也正确）；无 pages 的旧实例（vm 测试）pageIdx
     * 落 0 走 draft 直替换兜底
     */
    _histSnapshot() {
        const pageIdx = this.pages ? this.pages.indexOf(this.draft) : -1;
        return {
            kind: 'page',
            pageIdx: pageIdx >= 0 ? pageIdx : 0,
            snap: JSON.parse(JSON.stringify(this.draft))
        };
    },

    /** 文档级快照：页面增删/移动/整本清空用 */
    _histSnapshotDoc() {
        return {
            kind: 'doc',
            snap: {
                pages: JSON.parse(JSON.stringify(this.pages)),
                active: this.activePage
            }
        };
    },

    /** 按快照 kind 再拍一份当前状态（undo/redo 互推对方栈的入账用） */
    _snapshotOfKind(kind) {
        return kind === 'doc' ? this._histSnapshotDoc() : this._histSnapshot();
    },

    /**
     * 入账一步：before = 操作前快照（_histSnapshot/_histSnapshotDoc 产物；
     * 兼容外部直传的裸页草稿——按当前页包装成页级），label = 操作名。
     * 与当前状态相同（删了又改回）不入账；重做分支截断；上限裁剪最旧
     */
    _commitHistory(before, label) {
        if (!before) return;
        if (!before.kind) {
            before = { kind: 'page', pageIdx: this._histSnapshot().pageIdx, snap: before };
        }
        const current = before.kind === 'doc'
            ? { pages: this.pages, active: this.activePage }
            : this.draft;
        if (JSON.stringify(before.snap) === JSON.stringify(current)) return;
        before.label = label;   // 栈条目 = 快照包装 + 操作名（撤销提示用）
        this._undoStack.push(before);
        if (this._undoStack.length > MANGA_HIST_MAX) this._undoStack.shift();
        this._redoStack = [];
    },

    /**
     * 恢复到某快照条目（选择/视图态重置、渲染+自动保存同步回滚）。
     * 兼容裸页草稿直传。页级回滚跨页时把视图跟到被恢复的页——撤销的
     * 效果必须看得见
     */
    _applyHistoryState(entry) {
        // 兼容无 kind 的旧形态：{label, snap} 栈条目取其 snap，裸页草稿直传取本身
        const e = entry && entry.kind
            ? entry
            : { kind: 'page', pageIdx: -1, snap: entry && entry.snap !== undefined ? entry.snap : entry };
        if (e.kind === 'doc') {
            this.pages = JSON.parse(JSON.stringify(e.snap.pages));
            this.activePage = Math.max(0, Math.min(this.pages.length - 1, e.snap.active | 0));
            this.draft = this.pages[this.activePage];
        } else {
            const snap = JSON.parse(JSON.stringify(e.snap));
            if (this.pages && Number.isInteger(e.pageIdx) &&
                e.pageIdx >= 0 && e.pageIdx < this.pages.length) {
                this.pages[e.pageIdx] = snap;
                this.activePage = e.pageIdx;
                this.draft = snap;
            } else {
                this.draft = snap;   // 旧实例（无 pages）兜底
            }
        }
        this._resetForPageSwap();     // 视图态全重置（MangaPages 混入，字段缺失防御）
        this._invalidateCompiled();   // 草稿变了 → 自动保存（持久化跟随回滚）
        this._renderAll();
        if (this.railListEl) this._renderRail();
        this._syncPageBackgroundUi(); // 活动页背景可能随回滚变化（MangaPages 混入）
    },

    _undoHist() {
        this._flushTextInputHist();   // 先结算挂起的文本合并（它可能就是栈顶这一步）
        const entry = this._undoStack.pop();
        if (!entry) { this._status('没有可撤销的操作'); return; }
        const redo = this._snapshotOfKind(entry.kind);
        redo.label = entry.label;
        this._redoStack.push(redo);
        this._applyHistoryState(entry);
        this._status(`已撤销：${entry.label}`);
    },

    _redoHist() {
        this._flushTextInputHist();
        const entry = this._redoStack.pop();
        if (!entry) { this._status('没有可重做的操作'); return; }
        const undoSnap = this._snapshotOfKind(entry.kind);
        undoSnap.label = entry.label;
        this._undoStack.push(undoSnap);
        this._applyHistoryState(entry);
        this._status(`已重做：${entry.label}`);
    },

    /** 新建/恢复草稿：旧历史整体作废（新基线），挂起的文本合并一并作废 */
    _resetHistory() {
        this._undoStack = [];
        this._redoStack = [];
        this._textHistPending = null;
        clearTimeout(this._histTimer);
        this._histTimer = null;
    },

    /** 文本输入的变更前快照：首字符时拍、连续输入复用，防抖到期入账一步 */
    _beginTextInputHist() {
        if (this._textHistPending === null) this._textHistPending = this._histSnapshot();
        clearTimeout(this._histTimer);
        this._histTimer = setTimeout(() => {
            this._histTimer = null;
            const before = this._textHistPending;
            this._textHistPending = null;
            this._commitHistory(before, '输入文案');
        }, MANGA_HIST_DEBOUNCE);
    },

    /** 立即结算挂起的文本合并（blur / 撤销前调用，防半步状态） */
    _flushTextInputHist() {
        if (this._textHistPending === null) return;
        clearTimeout(this._histTimer);
        this._histTimer = null;
        const before = this._textHistPending;
        this._textHistPending = null;
        this._commitHistory(before, '输入文案');
    },

    /** 快捷键是否归编辑器管：并排形态下焦点在右侧面板时放行（面板文本自己的撤销） */
    _histKeyOwns(target) {
        if (!target) return true;
        if (typeof document !== 'undefined' && (target === document || target === document.body)) return true;
        return this.dialog ? this.dialog.contains(target) : true;
    },
});
