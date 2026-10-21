/**
 * ==========================================================================
 * LoRA 删除确认子模块（LoraConfirmDelete）
 * ==========================================================================
 * 从 LoraManager.js 拆出的删除确认弹窗（危险操作）：明示会删源文件与
 * 封面、引用会断链、不可撤销；确认后调后端删除并在宿主上同步本地清单
 * （重算文件夹、清置顶痕迹与缓存击穿时间戳）再刷新渲染。
 *
 * 模式：持有宿主（LoraManager 实例）引用读写其状态（_confirmOverlay/data/
 * pinned/_bustMap），与 image-studio/ 子模块同款契约。
 * ==========================================================================
 */

class LoraConfirmDelete {
    /** @param {LoraManager} host - 宿主管理器实例 */
    constructor(host) {
        this.host = host;
    }

    /**
     * 打开删除确认弹窗
     * @param {Object} lora - 待删除的 lora 数据
     */
    confirm(lora) {
        const host = this.host;
        host._confirmOverlay?.remove();
        const overlay = document.createElement('div');
        overlay.className = 'lora-confirm-overlay';
        overlay.innerHTML = `
            <div class="lora-confirm-panel">
                <div class="lora-confirm-title">⚠️ 删除 LoRA</div>
                <div class="lora-confirm-text"></div>
                <div class="lora-confirm-status"></div>
                <div class="lora-confirm-actions">
                    <button type="button" class="lora-confirm-cancel">取消</button>
                    <button type="button" class="lora-confirm-ok">删除</button>
                </div>
            </div>
        `;
        overlay.querySelector('.lora-confirm-text').textContent =
            `确定删除「${lora.name}」吗？将同时删除源文件（${(lora.sizeBytes / 1048576).toFixed(1)} MB）` +
            `与封面图，画布节点和工作流里引用该文件的地方会失效，且无法撤销。`;

        const close = () => {
            overlay.remove();
            host._confirmOverlay = null;
        };
        overlay.querySelector('.lora-confirm-cancel').addEventListener('click', close);
        overlay.addEventListener('mousedown', (e) => {
            if (e.target === overlay) close();
        });
        overlay.querySelector('.lora-confirm-ok').addEventListener('click', async () => {
            const okBtn = overlay.querySelector('.lora-confirm-ok');
            const status = overlay.querySelector('.lora-confirm-status');
            okBtn.disabled = true;
            okBtn.textContent = '删除中…';
            try {
                const resp = await fetch('/api/lora/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: lora.path })
                });
                const r = await resp.json().catch(() => null);
                if (!resp.ok || !r || r.status !== 'ok') {
                    throw new Error(r?.message || `删除失败（HTTP ${resp.status}）`);
                }
                // 本地数据同步移除（文件夹清单重算），清缓存与置顶痕迹
                host.data.loras = host.data.loras.filter((l) => l.path !== lora.path);
                host.data.folders = [...new Set(host.data.loras.map((l) => l.folder).filter(Boolean))].sort();
                host.pinned.delete(lora.path);
                if (host._bustMap) delete host._bustMap[lora.path];
                close();
                host._closeInfoModal();
                host._renderFolders();
                host._renderGrid();
            } catch (err) {
                okBtn.disabled = false;
                okBtn.textContent = '删除';
                status.textContent = '❌ ' + (err.message || err);
            }
        });

        document.body.appendChild(overlay);
        host._confirmOverlay = overlay;
    }
}

window.LoraConfirmDelete = LoraConfirmDelete;
