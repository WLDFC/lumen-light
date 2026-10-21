/**
 * ==========================================================================
 * CoordinateEditor 子模块：撤销/重做快照栈（自 CoordinateEditor.js 拆出）
 * 作用：快照式撤销/重做（ADR 017 决策十一）——草稿是纯 JSON 小对象，全量
 *       快照比命令闭包简单可靠（StudioHistory 同款取舍）。入账去重（删了
 *       又改回不入账）、重做分支截断、上限裁剪最旧；文本连续输入按防抖
 *       合并成一步（pending 挂起 + blur/撤销前立即结算，LIFO）；快捷键
 *       焦点守卫（并排形态面板内放行）。
 * 契约：原型混入（partial-class，ADR 026）——方法 Object.assign 进
 *       CoordinateEditor.prototype，this 即编辑器实例；须后于主类加载。
 *       栈与挂起状态存实例字段（_undoStack/_redoStack/_textHistPending/
 *       _histTimer）；setTimeout 用裸全局引用——测试经 vm context 注入
 *       桩（真实定时器或手动队列），不得改成捕获式引用。
 * ==========================================================================
 */

const HIST_MAX = 50;          // 撤销栈上限（超出裁剪最旧）
const HIST_DEBOUNCE = 1000;   // 文本连续输入合并成一步的窗口（ms）

Object.assign(window.CoordinateEditor.prototype, {

    // ==================== 撤销/重做（快照式，ADR 017 决策十一） ====================

    _histSnapshot() {
        return JSON.parse(JSON.stringify(this.draft));
    },

    /**
     * 入账一步：beforeSnap = 操作前的草稿快照，label = 操作名（撤销提示用）。
     * 与当前状态相同（删了又改回）不入账；重做分支截断；上限裁剪最旧
     */
    _commitHistory(beforeSnap, label) {
        if (!beforeSnap) return;
        if (JSON.stringify(beforeSnap) === JSON.stringify(this.draft)) return;
        this._undoStack.push({ label, snap: beforeSnap });
        if (this._undoStack.length > HIST_MAX) this._undoStack.shift();
        this._redoStack = [];
    },

    /** 恢复到某快照（选择清空、连点链断、渲染+自动保存同步回滚） */
    _applyHistoryState(snap) {
        this.draft = JSON.parse(JSON.stringify(snap));
        this.selected = -1;
        this._clickBurst = null;
        this._invalidateCompiled();   // 草稿变了 → 自动保存（持久化跟随回滚）
        this._renderAll();
    },

    _undoHist() {
        this._flushTextInputHist();   // 先结算挂起的文本合并（它可能就是栈顶这一步）
        const entry = this._undoStack.pop();
        if (!entry) { this._status('没有可撤销的操作'); return; }
        this._redoStack.push({ label: entry.label, snap: this._histSnapshot() });
        this._applyHistoryState(entry.snap);
        this._status(`已撤销：${entry.label}`);
    },

    _redoHist() {
        this._flushTextInputHist();
        const entry = this._redoStack.pop();
        if (!entry) { this._status('没有可重做的操作'); return; }
        this._undoStack.push({ label: entry.label, snap: this._histSnapshot() });
        this._applyHistoryState(entry.snap);
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
        }, HIST_DEBOUNCE);
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
