/**
 * ==========================================================================
 * LumenLight 通用确认弹窗预制件（LumenConfirmDialog）
 * ==========================================================================
 * 作用：危险操作前的确认框（标签删除、批量删除收藏、批量删除/移动
 * LoRA 文件共用）。Promise 风格：confirm() 返回 true（确认）/false
 * （取消/Esc/点遮罩）。视觉遵循项目深色色板（.lumen-confirm-*）。
 *
 * 使用方式：
 *   const dlg = new LumenConfirmDialog({ container: someDialog });
 *   const ok = await dlg.confirm({
 *       title: '删除标签「x」？',
 *       note: '其 2 个子标签将上移一级',   // 可省
 *       okText: '删除',                    // 可省，默认「删除」
 *       cancelText: '取消'                 // 可省
 *   });
 * ==========================================================================
 */

class LumenConfirmDialog {
    /**
     * @param {Object} [options]
     * @param {HTMLElement} [options.container=document.body] - 遮罩挂载容器
     *        （建议传宿主弹窗根，随弹窗生命周期存在；默认挂 body）
     */
    constructor({ container = document.body } = {}) {
        this.container = container;
        this.overlay = null;
        this._resolve = null;
        this._escHandler = null;
    }

    /** 弹窗是否打开 */
    get isOpen() {
        return !!(this.overlay && this.overlay.classList.contains('is-open'));
    }

    /**
     * 弹出确认框
     * @param {Object} params
     * @param {string} params.title - 主文案（一行）
     * @param {string} [params.note] - 补充说明（小字，可省）
     * @param {string} [params.okText='删除'] - 确认按钮文字
     * @param {string} [params.cancelText='取消'] - 取消按钮文字
     * @returns {Promise<boolean>} true=确认 / false=取消（含 Esc 与点遮罩）
     */
    confirm({ title, note, okText = '删除', cancelText = '取消' } = {}) {
        return new Promise((resolve) => {
            if (!this.overlay) {
                this.overlay = document.createElement('div');
                this.overlay.className = 'lumen-confirm-overlay';
                this.overlay.innerHTML = `
                    <div class="lumen-confirm-panel" role="alertdialog" aria-label="操作确认">
                        <h4 class="lumen-confirm-title"></h4>
                        <p class="lumen-confirm-note"></p>
                        <div class="lumen-confirm-actions">
                            <button type="button" class="lumen-btn" data-act="cancel"></button>
                            <button type="button" class="lumen-btn is-danger" data-act="ok"></button>
                        </div>
                    </div>`;
                this.overlay.addEventListener('click', (e) => {
                    if (e.target === this.overlay) this._settle(false);
                });
                this.overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => this._settle(false));
                this.overlay.querySelector('[data-act="ok"]').addEventListener('click', () => this._settle(true));
                this.container.appendChild(this.overlay);
            }
            this.overlay.querySelector('.lumen-confirm-title').textContent = title || '';
            this.overlay.querySelector('.lumen-confirm-note').textContent = note || '';
            this.overlay.querySelector('.lumen-confirm-note').style.display = note ? '' : 'none';
            this.overlay.querySelector('[data-act="cancel"]').textContent = cancelText;
            this.overlay.querySelector('[data-act="ok"]').textContent = okText;
            this.overlay.classList.add('is-open');
            // Esc 关闭（未开时挂监听无意义，随开关挂摘）
            this._escHandler = (e) => { if (e.key === 'Escape') this._settle(false); };
            document.addEventListener('keydown', this._escHandler);
            this._resolve = resolve;
        });
    }

    /** 以"取消"收束弹窗（宿主关闭/隐藏时调用；未开时无副作用） */
    cancel() {
        this._settle(false);
    }

    /** 收束弹窗并 resolve（未开时调用无副作用） */
    _settle(result) {
        if (!this.isOpen) return;
        this.overlay.classList.remove('is-open');
        document.removeEventListener('keydown', this._escHandler);
        this._escHandler = null;
        const resolve = this._resolve;
        this._resolve = null;
        resolve?.(result);
    }
}

window.LumenConfirmDialog = LumenConfirmDialog;
