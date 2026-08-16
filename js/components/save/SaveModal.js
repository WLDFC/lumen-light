/**
 * ==========================================================================
 * LumenLight 存档模态框（从 SaveManager.js 拆出）
 * 作用：存档相关的全部模态框 UI：
 *   1. 打开画布：列出 save/ 目录下的存档供选择；
 *   2. 另存为：输入名称 + 同名覆盖确认（showSaveAsModal 完整流程版）；
 *   3. 另存为（简化版）：仅输入名称与覆盖确认，返回 Promise<name|null>，
 *      供 NewCanvasManager"保存并新建"流程复用（promptSaveAsName）；
 *   4. 纯进度框：保存过程中的进度反馈（showProgressModal）。
 * 本类只负责弹窗交互，不含保存/读取的业务逻辑——
 * 打开、保存的执行通过构造时传入的 host（SaveManager 实例）回调完成。
 * 依赖：全局 LumenLight 工具（escapeHtml）
 * ==========================================================================
 */

class SaveModal {
    /**
     * 构造函数
     * @param {SaveManager} host - 宿主（SaveManager 实例），提供业务回调：
     *   loadFromServer(name) / saveViaHttp(...) / saveExists(name) /
     *   saveProject 流程所需的 currentSave / applySavedMappings 等
     */
    constructor(host) {
        this.host = host;
    }

    /**
     * 显示打开画布模态框：列出 save/ 目录下的所有存档供选择
     */
    async showOpenModal() {
        const overlay = this.ensureModalOverlay();
        overlay.innerHTML = `
            <div class="save-modal">
                <h3>打开画布</h3>
                <div class="save-list" id="saveList">
                    <div class="save-list-empty">正在读取存档列表...</div>
                </div>
                <div class="save-modal-status" id="openModalStatus"></div>
                <div class="save-modal-actions">
                    <button class="save-modal-btn secondary" id="openCancelBtn">取消</button>
                    <button class="save-modal-btn primary" id="openConfirmBtn" disabled>打开</button>
                </div>
            </div>
        `;
        overlay.classList.add('show');

        const saveList = document.getElementById('saveList');
        const status = document.getElementById('openModalStatus');
        const confirmBtn = document.getElementById('openConfirmBtn');
        const cancelBtn = document.getElementById('openCancelBtn');
        let selectedName = null;

        cancelBtn.addEventListener('click', () => this.closeModal());
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this.closeModal();
        });

        confirmBtn.addEventListener('click', async () => {
            if (!selectedName) return;
            confirmBtn.disabled = true;
            status.textContent = '正在加载...';
            status.className = 'save-modal-status';

            try {
                await this.host.loadFromServer(selectedName);
                status.textContent = '加载完成';
                status.className = 'save-modal-status success';
                setTimeout(() => this.closeModal(), 500);
            } catch (error) {
                status.textContent = error.message;
                status.className = 'save-modal-status error';
                confirmBtn.disabled = false;
            }
        });

        // 加载 save/ 目录下的存档列表
        try {
            const response = await fetch('/api/saves');
            const result = await response.json();

            if (result.status !== 'ok') {
                throw new Error(result.message || '获取存档列表失败');
            }

            if (result.saves.length === 0) {
                saveList.innerHTML = '<div class="save-list-empty">暂无存档</div>';
                return;
            }

            saveList.innerHTML = '';
            result.saves.forEach(save => {
                const item = document.createElement('div');
                item.className = 'save-list-item';
                item.dataset.name = save.name;

                const dateText = save.createdAt
                    ? new Date(save.createdAt).toLocaleString('zh-CN')
                    : '';

                item.innerHTML = `
                    <span class="save-list-item-name">${LumenLight.escapeHtml(save.name)}</span>
                    <span class="save-list-item-date">${dateText}</span>
                `;

                item.addEventListener('click', () => {
                    saveList.querySelectorAll('.save-list-item').forEach(el => el.classList.remove('selected'));
                    item.classList.add('selected');
                    selectedName = save.name;
                    confirmBtn.disabled = false;
                });

                saveList.appendChild(item);
            });
        } catch (error) {
            saveList.innerHTML = `<div class="save-list-empty">读取失败：${LumenLight.escapeHtml(error.message)}</div>`;
        }
    }

    /**
     * 显示“另存为”模态框：输入存档名称，直接保存到 save/ 目录，
     * 与已有存档同名时询问用户是否覆盖（覆盖 / 取消）
     */
    showSaveAsModal() {
        const overlay = this.ensureModalOverlay();
        overlay.innerHTML = `
            <div class="save-modal">
                <h3>另存为</h3>
                <input type="text" class="save-modal-input" id="saveAsNameInput" placeholder="输入新存档名称" value="${LumenLight.escapeHtml(this.host.currentSave || '')}">
                <div class="save-modal-status" id="saveAsModalStatus">将保存到默认存档目录 save/</div>
                <div class="save-modal-actions">
                    <button class="save-modal-btn secondary" id="saveAsCancelBtn">取消</button>
                    <button class="save-modal-btn primary" id="saveAsConfirmBtn">保存</button>
                </div>
            </div>
        `;
        overlay.classList.add('show');

        const input = document.getElementById('saveAsNameInput');
        const status = document.getElementById('saveAsModalStatus');
        const confirmBtn = document.getElementById('saveAsConfirmBtn');
        const cancelBtn = document.getElementById('saveAsCancelBtn');

        // 是否已确认覆盖同名存档（修改名称后重置）
        let overwriteConfirmed = false;

        input.focus();
        input.select();

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') confirmBtn.click();
        });

        // 名称变化时重置覆盖确认状态
        input.addEventListener('input', () => {
            overwriteConfirmed = false;
            confirmBtn.textContent = '保存';
            status.textContent = '将保存到默认存档目录 save/';
            status.className = 'save-modal-status';
        });

        cancelBtn.addEventListener('click', () => this.closeModal());
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this.closeModal();
        });

        confirmBtn.addEventListener('click', async () => {
            const name = this.host.sanitizeFolderName(input.value.trim());
            if (!name) {
                status.textContent = '请输入存档名称';
                status.className = 'save-modal-status error';
                return;
            }

            confirmBtn.disabled = true;

            try {
                // 同名存档已存在且尚未确认覆盖 → 询问用户
                if (!overwriteConfirmed && await this.host.saveExists(name)) {
                    status.textContent = `存档「${name}」已存在，是否覆盖？`;
                    status.className = 'save-modal-status error';
                    confirmBtn.textContent = '覆盖';
                    overwriteConfirmed = true;
                    confirmBtn.disabled = false;
                    return;
                }

                status.textContent = '正在保存...';
                status.className = 'save-modal-status';

                const result = await this.host.saveViaHttp(name, overwriteConfirmed, (done, total) => {
                    status.textContent = total > 1
                        ? `正在上传图片批次 ${done}/${total}...`
                        : '正在保存...';
                });

                // 记住新存档，之后“保存画布”将直接覆盖存回这里
                this.host.currentSave = result.name;
                this.host.updateCanvasName(result.name);
                this.host.applySavedMappings(result);

                status.textContent = `已保存到：save/${result.name}`;
                status.className = 'save-modal-status success';
                setTimeout(() => this.closeModal(), 1200);
            } catch (error) {
                status.textContent = error.message;
                status.className = 'save-modal-status error';
                confirmBtn.disabled = false;
            }
        });
    }

    /**
     * 弹出另存为输入框获取存档名称（简化流程：仅输入名称与覆盖确认）
     * 供 NewCanvasManager 的"保存并新建"流程复用
     * @returns {Promise<string|null>} 有效名称；用户取消时返回 null
     */
    promptSaveAsName() {
        return new Promise((resolve) => {
            const overlay = this.ensureModalOverlay();
            overlay.innerHTML = `
                <div class="save-modal">
                    <h3>另存为</h3>
                    <input type="text" class="save-modal-input" id="saveAsNameInput" placeholder="输入新存档名称">
                    <div class="save-modal-status" id="saveAsModalStatus">将保存到默认存档目录 save/</div>
                    <div class="save-modal-actions">
                        <button class="save-modal-btn secondary" id="saveAsCancelBtn">取消</button>
                        <button class="save-modal-btn primary" id="saveAsConfirmBtn">保存</button>
                    </div>
                </div>
            `;
            overlay.classList.add('show');

            const input = document.getElementById('saveAsNameInput');
            const status = document.getElementById('saveAsModalStatus');
            const confirmBtn = document.getElementById('saveAsConfirmBtn');
            const cancelBtn = document.getElementById('saveAsCancelBtn');

            input.focus();

            const finish = (name) => {
                this.closeModal();
                resolve(name);
            };

            cancelBtn.addEventListener('click', () => finish(null));
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) finish(null);
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') confirmBtn.click();
            });

            confirmBtn.addEventListener('click', async () => {
                const name = this.host.sanitizeFolderName(input.value.trim());
                if (!name) {
                    status.textContent = '请输入存档名称';
                    status.className = 'save-modal-status error';
                    return;
                }
                // 同名时提示确认覆盖，按钮变为"覆盖"后再次点击才执行
                if (confirmBtn.textContent !== '覆盖' && await this.host.saveExists(name)) {
                    status.textContent = `存档「${name}」已存在，是否覆盖？`;
                    status.className = 'save-modal-status error';
                    confirmBtn.textContent = '覆盖';
                    return;
                }
                finish(name);
            });
        });
    }

    /**
     * 显示纯进度模态框（用于保存时的进度反馈）
     * @param {string} title - 标题文字
     * @returns {Object} 控制对象：update(text) / success(text) / error(text) / close()
     */
    showProgressModal(title) {
        const overlay = this.ensureModalOverlay();
        overlay.innerHTML = `
            <div class="save-modal">
                <h3>${LumenLight.escapeHtml(title)}</h3>
                <div class="save-modal-status" id="progressModalStatus">准备中...</div>
            </div>
        `;
        overlay.classList.add('show');

        const status = document.getElementById('progressModalStatus');
        return {
            update: (text) => {
                status.textContent = text;
                status.className = 'save-modal-status';
            },
            success: (text) => {
                status.textContent = text;
                status.className = 'save-modal-status success';
            },
            error: (text) => {
                status.textContent = text;
                status.className = 'save-modal-status error';
            },
            close: () => this.closeModal()
        };
    }

    // ==================== 模态框基础工具 ====================

    /**
     * 创建模态框遮罩层（如果不存在）
     * @returns {HTMLElement} 模态框遮罩层
     */
    ensureModalOverlay() {
        let overlay = document.getElementById('saveModalOverlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'saveModalOverlay';
            overlay.className = 'save-modal-overlay';
            document.body.appendChild(overlay);
        }
        return overlay;
    }

    /**
     * 关闭模态框
     */
    closeModal() {
        const overlay = document.getElementById('saveModalOverlay');
        if (overlay) {
            overlay.classList.remove('show');
            overlay.innerHTML = '';
        }
    }
}

// 将 SaveModal 类暴露到全局作用域
window.SaveModal = SaveModal;
