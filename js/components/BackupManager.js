/**
 * ==========================================================================
 * LumenLight 备份导出/导入管理器（BackupManager）
 * ==========================================================================
 * 作用：文件菜单「备份导出 / 备份导入」两个入口的弹窗与流程编排。
 *   - 导出：勾选备份项（存档 / API 设置（可选含 Key）/ 聊天记录 / 提示词库）
 *     → 聊天记录从 IndexedDB 全量导出随请求带给后端 → 后端打包 zip 下载；
 *   - 导入：选择备份包 zip 原始上传 → 后端解包合并（策略见 routes/backup.js：
 *     同名存档自动改名不覆盖、API 设置按厂商合并、收藏/提示词并集合并）
 *     → 响应带回聊天记录 → 前端整库替换写回 IndexedDB。
 *
 * 知情确认设计（导入永不静默覆盖）：
 *   - 存档同名自动改名、设置/收藏合并——无破坏性，弹窗说明即可；
 *   - 聊天记录是唯一「替换」语义的项——独立勾选框 + 红色警示文字，
 *     不勾选就不替换、服务端也不会动它。
 *
 * 依赖：window.ChatHistoryStore（IndexedDB 聊天记录读写）。
 * ==========================================================================
 */

class BackupManager {
    constructor() {
        // 独立实例复用同一 IndexedDB 库（与 LlmHistoryController 互不干扰）
        this.chatStore = new ChatHistoryStore();

        this.exportBtn = document.getElementById('backupExportBtn');
        this.importBtn = document.getElementById('backupImportBtn');
        this.exportBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            window.saveManager?.hideMenu();
            this.showExportDialog();
        });
        this.importBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            window.saveManager?.hideMenu();
            this.showImportDialog();
        });

        this._root = null;
    }

    // ==================== 通用弹窗壳 ====================

    /** 构建并显示弹窗（一次一个），返回根元素供事件接线 */
    _openDialog(titleHtml, bodyHtml) {
        this._closeDialog();
        const root = document.createElement('div');
        root.className = 'backup-overlay is-open';
        root.innerHTML = `
            <div class="backup-dialog">
                <div class="backup-dialog-header">
                    <h3>${titleHtml}</h3>
                    <button class="backup-close-btn" title="关闭">✕</button>
                </div>
                <div class="backup-dialog-body">${bodyHtml}</div>
            </div>`;
        document.body.appendChild(root);
        this._root = root;

        root.querySelector('.backup-close-btn').addEventListener('click', () => this._closeDialog());
        root.addEventListener('mousedown', (e) => {
            if (e.target === root) this._closeDialog();
        });
        return root;
    }

    _closeDialog() {
        if (this._root) {
            this._root.remove();
            this._root = null;
        }
    }

    /** 勾选行模板：复选框 + 标题 + 可选说明小字 */
    _checkRowHtml(id, label, note = '', checked = true) {
        return `
            <label class="backup-check-row" for="${id}">
                <input type="checkbox" id="${id}" ${checked ? 'checked' : ''}>
                <span class="backup-check-label">${label}</span>
                ${note ? `<span class="backup-check-note">${note}</span>` : ''}
            </label>`;
    }

    /** 设置错误信息并复位按钮 */
    _showError(area, message, button, busyText) {
        area.textContent = message;
        area.style.display = 'block';
        if (button) {
            button.disabled = false;
            button.textContent = busyText;
        }
    }

    // ==================== 导出 ====================

    showExportDialog() {
        const root = this._openDialog('备份导出', `
            <p class="backup-desc">选择要备份的内容，打包为一个 zip 文件下载。</p>
            ${this._checkRowHtml('bk-exp-saves', '画布存档', 'save/ 目录下全部存档（含图片）')}
            ${this._checkRowHtml('bk-exp-settings', 'API 设置', '各厂商端点与模型清单')}
            <label class="backup-check-row backup-check-sub" for="bk-exp-keys">
                <input type="checkbox" id="bk-exp-keys" checked>
                <span class="backup-check-label">包含 API Key</span>
                <span class="backup-check-note backup-warn-note">导出文件含明文密钥，请妥善保管、勿外传</span>
            </label>
            ${this._checkRowHtml('bk-exp-chat', '聊天记录', 'AI 对话窗口全部消息（IndexedDB）')}
            ${this._checkRowHtml('bk-exp-prompts', '提示词库', '收藏图片 + 系统提示词 + Comfy 预设')}
            <div class="backup-error" style="display:none;"></div>
            <div class="backup-actions">
                <button class="backup-cancel-btn">取消</button>
                <button class="backup-primary-btn" id="bk-exp-go">导出备份</button>
            </div>
        `);

        // 「API 设置」不勾时禁用其子项「包含 API Key」
        const settingsRow = root.querySelector('#bk-exp-settings');
        const keysRow = root.querySelector('#bk-exp-keys');
        const syncKeysDisabled = () => { keysRow.disabled = !settingsRow.checked; };
        settingsRow.addEventListener('change', syncKeysDisabled);
        syncKeysDisabled();

        root.querySelector('.backup-cancel-btn').addEventListener('click', () => this._closeDialog());
        root.querySelector('#bk-exp-go').addEventListener('click', (e) => {
            this._doExport(root, e.target);
        });
    }

    async _doExport(root, button) {
        const errorArea = root.querySelector('.backup-error');
        const opts = {
            saves: root.querySelector('#bk-exp-saves').checked,
            settings: root.querySelector('#bk-exp-settings').checked,
            settingsIncludeKeys: root.querySelector('#bk-exp-keys').checked,
            chat: root.querySelector('#bk-exp-chat').checked,
            prompts: root.querySelector('#bk-exp-prompts').checked
        };
        if (!opts.saves && !opts.settings && !opts.chat && !opts.prompts) {
            return this._showError(errorArea, '至少选择一项要备份的内容', button, '导出备份');
        }

        button.disabled = true;
        button.textContent = '正在打包…';
        errorArea.style.display = 'none';

        try {
            // 聊天记录存在浏览器 IndexedDB，导出时随请求带给后端打包
            if (opts.chat) {
                opts.chatData = await this.chatStore.exportAll();
            }
            const response = await fetch('/api/backup/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(opts)
            });
            if (!response.ok) {
                let message = `导出失败（HTTP ${response.status}）`;
                try { message = (await response.json()).message || message; } catch { /* 非 JSON 响应 */ }
                throw new Error(message);
            }
            const blob = await response.blob();
            const disposition = response.headers.get('Content-Disposition') || '';
            const match = disposition.match(/filename="([^"]+)"/);
            const filename = match ? match[1] : `lumen-backup-${Date.now()}.zip`;

            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);

            button.textContent = '已导出 ✓';
            setTimeout(() => this._closeDialog(), 700);
        } catch (error) {
            this._showError(errorArea, error.message || '导出失败', button, '导出备份');
        }
    }

    // ==================== 导入 ====================

    showImportDialog() {
        const root = this._openDialog('备份导入', `
            <p class="backup-desc">选择流光备份包（.zip），导入以下勾选的内容：</p>
            <div class="backup-file-zone" id="bk-imp-zone">
                <input type="file" id="bk-imp-file" accept=".zip" hidden>
                <span id="bk-imp-file-label">点击选择备份包文件…</span>
            </div>
            ${this._checkRowHtml('bk-imp-saves', '画布存档', '同名存档自动改名，绝不覆盖')}
            ${this._checkRowHtml('bk-imp-settings', 'API 设置', '按厂商合并：同名厂商以备份包为准，其余保留')}
            ${this._checkRowHtml('bk-imp-prompts', '提示词库', '收藏与预设按条目合并，现有条目优先')}
            ${this._checkRowHtml('bk-imp-chat', '聊天记录', '整包替换当前聊天记录（含全部存档的对话）')}
            <div class="backup-warn-box" id="bk-imp-chat-warn" style="display:none;">
                ⚠ 勾选「聊天记录」将清空当前全部对话记录，替换为备份包内的内容，且不可撤销。
            </div>
            <div class="backup-error" style="display:none;"></div>
            <div class="backup-result" style="display:none;"></div>
            <div class="backup-actions">
                <button class="backup-cancel-btn">取消</button>
                <button class="backup-primary-btn" id="bk-imp-go" disabled>导入备份</button>
            </div>
        `);

        const fileInput = root.querySelector('#bk-imp-file');
        const fileLabel = root.querySelector('#bk-imp-file-label');
        const zone = root.querySelector('#bk-imp-zone');
        const chatCheckbox = root.querySelector('#bk-imp-chat');
        const chatWarn = root.querySelector('#bk-imp-chat-warn');
        const goBtn = root.querySelector('#bk-imp-go');
        let pickedFile = null;

        zone.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            pickedFile = fileInput.files[0] || null;
            fileLabel.textContent = pickedFile ? pickedFile.name : '点击选择备份包文件…';
            goBtn.disabled = !pickedFile;
        });
        chatCheckbox.addEventListener('change', () => {
            chatWarn.style.display = chatCheckbox.checked ? 'block' : 'none';
        });

        root.querySelector('.backup-cancel-btn').addEventListener('click', () => this._closeDialog());
        goBtn.addEventListener('click', () => this._doImport(root, goBtn, pickedFile));
    }

    async _doImport(root, button, file) {
        if (!file) return;
        const errorArea = root.querySelector('.backup-error');
        const resultArea = root.querySelector('.backup-result');
        errorArea.style.display = 'none';

        const flag = (id) => root.querySelector(id).checked ? '1' : '0';
        const params = new URLSearchParams({
            saves: flag('#bk-imp-saves'),
            settings: flag('#bk-imp-settings'),
            prompts: flag('#bk-imp-prompts'),
            chat: flag('#bk-imp-chat')
        });

        button.disabled = true;
        button.textContent = '正在导入…';

        try {
            // zip 原始字节直接作为请求体（后端流式落盘，不经 JSON 解析）
            const response = await fetch(`/api/backup/import?${params}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/zip' },
                body: file
            });
            const text = await response.text();
            let result;
            try { result = JSON.parse(text); } catch { throw new Error(`服务器返回异常响应（HTTP ${response.status}）`); }
            if (result.status !== 'ok') {
                throw new Error(result.message || '导入失败');
            }

            // 聊天记录整包替换写回 IndexedDB（后端不落盘，随响应带回）
            let chatRestored = 0;
            if (Array.isArray(result.chat)) {
                chatRestored = await this.chatStore.importReplace(result.chat);
            }

            const s = result.summary || {};
            const lines = [];
            if (s.savesImported && s.savesImported.length) {
                lines.push(`画布存档：导入 ${s.savesImported.length} 个` +
                    (s.savesRenamed ? `（${s.savesRenamed} 个因同名自动改名）` : ''));
            }
            if (s.settingsUpdated || s.settingsAdded) {
                lines.push(`API 设置：更新 ${s.settingsUpdated} 个厂商、新增 ${s.settingsAdded} 个厂商` +
                    '（刷新页面生效）');
            }
            if (s.tagsAdded || s.modelsAdded) {
                lines.push(`收藏：新增 ${s.tagsAdded} 条、模型标签新增 ${s.modelsAdded} 个`);
            }
            if (s.promptsAdded) {
                lines.push(`提示词库：新增 ${s.promptsAdded} 条`);
            }
            if (chatRestored) {
                lines.push(`聊天记录：已替换写回 ${chatRestored} 条（刷新页面生效）`);
            }
            if (!lines.length) {
                lines.push('备份包中没有匹配勾选项的内容，未做任何改动。');
            }
            resultArea.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
            resultArea.style.display = 'block';
            button.textContent = '导入完成 ✓';
        } catch (error) {
            this._showError(errorArea, error.message || '导入失败', button, '导入备份');
        }
    }
}

// 暴露到全局作用域
window.BackupManager = BackupManager;
