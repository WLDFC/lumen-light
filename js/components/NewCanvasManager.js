/**
 * ==========================================================================
 * LumenLight 新建画布管理器组件
 * 作用：承接文件菜单中"新建画布"功能的全部逻辑：
 *   1. 画布为空（不含生成占位图）时直接重置到全新状态；
 *   2. 画布上有图片时弹出三按钮确认框：
 *      - 保存并新建：调用 SaveManager 的保存流程，成功后重置；
 *      - 直接新建：不保存，立即重置；
 *      - 取消：留在当前画布；
 *   3. 重置内容包括：清空图片与选择、清空提示词、视口复位、
 *      画布名改"未命名"、解除当前存档关联。
 * 依赖：SaveManager 实例（构造时传入），共享其 currentSave 状态与
 *       保存/模态框方法，避免状态复制。
 * ==========================================================================
 */

class NewCanvasManager {
    /**
     * 构造函数：绑定菜单按钮并保存 SaveManager 引用
     * @param {SaveManager} saveManager - 存档管理器实例（状态单一数据源）
     */
    constructor(saveManager) {
        this.saveManager = saveManager;
        this.canvas = saveManager.canvas;

        // 菜单项按钮（拆分前由 SaveManager 绑定，现职责随逻辑迁入）
        this.newCanvasBtn = document.getElementById('newCanvasBtn');
        this.bindEvents();
    }

    /**
     * 绑定"新建画布"菜单项点击事件
     */
    bindEvents() {
        this.newCanvasBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.saveManager.hideMenu();
            this.newCanvas();
        });
    }

    /**
     * 新建画布：
     * - 画布上有图片（不含生成占位图）时弹出三按钮确认框；
     * - 画布为空时直接重置
     */
    newCanvas() {
        const hasImages = this.saveManager.collectImages().length > 0;
        if (!hasImages) {
            this.resetProject();
            return;
        }

        // 复用存档模态框遮罩层，保持视觉风格统一
        const overlay = this.saveManager.ensureModalOverlay();
        overlay.innerHTML = `
            <div class="save-modal">
                <h3>新建画布</h3>
                <div class="save-modal-status">当前画布上有图片，是否先保存？</div>
                <div class="save-modal-actions save-modal-actions-3">
                    <button class="save-modal-btn primary" id="newCanvasSaveBtn">保存并新建</button>
                    <button class="save-modal-btn secondary" id="newCanvasDiscardBtn">直接新建</button>
                    <button class="save-modal-btn secondary" id="newCanvasCancelBtn">取消</button>
                </div>
            </div>
        `;
        overlay.classList.add('show');

        const saveBtn = document.getElementById('newCanvasSaveBtn');
        const discardBtn = document.getElementById('newCanvasDiscardBtn');
        const cancelBtn = document.getElementById('newCanvasCancelBtn');

        cancelBtn.addEventListener('click', () => this.saveManager.closeModal());
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this.saveManager.closeModal();
        });

        // 直接新建：不保存，立即重置
        discardBtn.addEventListener('click', () => {
            this.saveManager.closeModal();
            this.resetProject();
        });

        // 保存并新建：走"保存画布"流程（无当前存档时自动进入另存为），
        // 保存成功后才重置；保存失败/取消另存为则留在当前画布
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            try {
                const saved = await this.saveProjectForNew();
                if (!saved) return;          // 用户在另存为中取消或保存失败
                this.saveManager.closeModal();
                this.resetProject();
            } finally {
                saveBtn.disabled = false;
            }
        });
    }

    /**
     * 为"保存并新建"执行保存：等待保存流程结束并报告是否成功
     * @returns {Promise<boolean>} 保存是否成功完成
     */
    async saveProjectForNew() {
        try {
            await this.saveManager.saveProjectInternal();
            return true;
        } catch {
            // 失败详情已由进度弹窗展示，这里只需阻止重置画布
            return false;
        }
    }

    /**
     * 重置画布到全新状态：清空图片与选择、清空提示词、
     * 视口复位、画布名改"未命名"、解除当前存档关联。
     * 提示词节点是真实 DOM 元素（不是 canvas 绘制），必须先调用
     * destroy() 移除其根元素，否则节点会残留在页面上且事件失联卡死；
     * 普通图片对象清空数组后不再被引用，由垃圾回收自动释放内存。
     */
    resetProject() {
        // 先销毁 DOM 节点（提示词/生图节点，与 restoreProject 清场逻辑一致）
        for (const img of this.canvas.images.images) {
            if (typeof img.destroy === 'function') {
                img.destroy();
            }
        }
        this.canvas.images.images = [];
        this.canvas.images.selectedIds.clear();
        this.canvas.connections.clear(); // 同步清空连线，避免残留指向已清空图片的连线
        this.saveManager.setPrompts('', '');
        // 视口复位到 15%：默认视角下用户可见范围更大，上传图片/新建节点后不易只见局部
        this.saveManager.setViewport({ scale: 0.15, offsetX: 0, offsetY: 0 });
        this.saveManager.currentSave = null;
        this.saveManager.updateCanvasName('未命名');
        this.canvas.draw();
    }
}

window.NewCanvasManager = NewCanvasManager;
