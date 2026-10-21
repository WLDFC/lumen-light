/**
 * ==========================================================================
 * LumenLight 通用批量管理预制件（LumenBatchManager）
 * ==========================================================================
 * 作用：给卡片网格加装"批量模式"——工具行批量按钮开关、批量条（已选
 * 计数/全选/取消选择/完成）、选择态集合。收藏页与 LoRA 管理器共用。
 * 卡片右上角的绿色✓选择圈由静态方法 createCheckBadge 生成，宿主自行
 * append 到卡片并在卡片根上切 is-selected 类（本组件只管状态与广播）。
 *
 * 使用方式：
 *   const batch = new LumenBatchManager({
 *       trigger: btnEl,          // 批量按钮（宿主建，点击语义交给本组件）
 *       barContainer: slotEl,    // 批量条插入位置（宿主在工具行下留槽位）
 *       gridEl: gridEl,          // 激活时加 .lumen-batch-mode（卡片光标/选择圈显隐）
 *       getVisibleIds: () => ids,// "全选"的作用范围（当前筛选结果）
 *       onChange: () => {}       // 选择集或模式变化回调（宿主同步卡片高亮）
 *   });
 *   batch.active; batch.isSelected(id); batch.toggleOne(id);
 *   batch.getIds(); batch.exit();
 *
 * 模式切换会清空选择集并触发 onChange；宿主据此重绘卡片选择态。
 * ==========================================================================
 */

class LumenBatchManager {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.trigger - 批量按钮元素
     * @param {HTMLElement} options.barContainer - 批量条挂载槽位
     * @param {HTMLElement} [options.gridEl] - 激活/退出时切 .lumen-batch-mode 的元素
     * @param {Function} options.getVisibleIds - 返回当前可见卡片 id 数组
     * @param {Function} [options.onChange] - 状态变化回调
     */
    constructor({ trigger, barContainer, gridEl, getVisibleIds, onChange } = {}) {
        this.trigger = trigger;
        this.gridEl = gridEl || null;
        this.getVisibleIds = getVisibleIds || (() => []);
        this.onChange = onChange || (() => {});
        this.active = false;
        this.selectedIds = new Set();
        this._buildBar(barContainer);

        // 批量按钮：点击进入/退出批量模式（激活态样式类由本组件管理）
        this.trigger.classList.add('lumen-batch-btn');
        this.trigger.setAttribute('aria-pressed', 'false');
        this.trigger.addEventListener('click', () => this.toggle());
    }

    /** 构建批量条（计数 + 全选/取消选择 + 完成退出），默认隐藏 */
    _buildBar(barContainer) {
        const bar = document.createElement('div');
        bar.className = 'lumen-batch-bar';
        bar.innerHTML = `
            <span class="lumen-batch-count" aria-live="polite">已选 0 张</span>
            <button type="button" class="lumen-batch-action" data-act="all">全选</button>
            <button type="button" class="lumen-batch-action" data-act="none">取消选择</button>
            <span class="lumen-batch-spacer"></span>
            <button type="button" class="lumen-batch-done" data-act="done">完成</button>
        `;
        bar.addEventListener('click', (event) => {
            const act = event.target.closest('[data-act]')?.dataset.act;
            if (!act) return;
            if (act === 'all') {
                this.getVisibleIds().forEach((id) => this.selectedIds.add(id));
                this._notify();
            } else if (act === 'none') {
                this.clearSelection();
            } else if (act === 'done') {
                this.exit();
            }
        });
        barContainer.appendChild(bar);
        this.bar = bar;
    }

    /** 是否处于批量模式 */
    get isOpen() {
        return this.active;
    }

    /** 进入/退出批量模式；切换时清空选择集 */
    toggle(force) {
        const next = typeof force === 'boolean' ? force : !this.active;
        if (next === this.active) return;
        this.active = next;
        this.trigger.classList.toggle('is-active', next);
        this.trigger.setAttribute('aria-pressed', String(next));
        this.bar.classList.toggle('is-visible', next);
        this.gridEl?.classList.toggle('lumen-batch-mode', next);
        this.selectedIds.clear();
        this._notify();
    }

    /** 退出批量模式（未激活时调用无副作用） */
    exit() {
        this.toggle(false);
    }

    isSelected(id) {
        return this.selectedIds.has(id);
    }

    /** 批量模式下点选一张卡片：切换选中态 */
    toggleOne(id) {
        if (this.selectedIds.has(id)) this.selectedIds.delete(id);
        else this.selectedIds.add(id);
        this._notify();
    }

    /** 当前所选 id 数组 */
    getIds() {
        return [...this.selectedIds];
    }

    /** 清空选择 */
    clearSelection() {
        if (!this.selectedIds.size) return;
        this.selectedIds.clear();
        this._notify();
    }

    /** 同步批量条计数并广播（宿主刷新卡片选择态） */
    _notify() {
        this.bar.querySelector('.lumen-batch-count').textContent = `已选 ${this.selectedIds.size} 张`;
        this.onChange();
    }

    /**
     * 生成卡片右上角的选择圈元素：批量模式显示空圈占位（宿主网格带
     * .lumen-batch-mode 时可见），宿主在卡片根上加 is-selected 后变绿打✓
     * @returns {HTMLElement} span.lumen-batch-check
     */
    static createCheckBadge() {
        const check = document.createElement('span');
        check.className = 'lumen-batch-check';
        check.setAttribute('aria-hidden', 'true');
        return check;
    }
}

window.LumenBatchManager = LumenBatchManager;
