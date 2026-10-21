/**
 * ==========================================================================
 * LoRA 封面更换子模块（LoraCoverPicker）
 * ==========================================================================
 * 从 LoraManager.js 拆出的封面更换链路：
 *   - 画布选图浮层（信息窗之上的二级弹层）：网格列出画布可用图片，点击取为封面；
 *   - 本地图片：读取 file input 的文件转 data URL（file input 本体在宿主，
 *     change 事件经宿主薄代理回调到 readLocal）；
 *   - 上传：POST /api/lora/cover 写 sidecar 预览文件，成功后记缓存击穿
 *     时间戳（绕过 /preview 的 1 天浏览器缓存）并刷新网格。
 *
 * 模式：持有宿主（LoraManager 实例）引用读写其状态（_pickerOverlay/
 * _infoLora/_bustMap 等），与 image-studio/ 子模块同款契约。
 * ==========================================================================
 */

class LoraCoverPicker {
    /** @param {LoraManager} host - 宿主管理器实例 */
    constructor(host) {
        this.host = host;
    }

    /** 读取本地图片文件为 data URL 并上传（宿主 file input 的 change 回调） */
    readLocal(file) {
        const reader = new FileReader();
        reader.onload = () => this.upload(String(reader.result));
        reader.onerror = () => this.host._infoStatus('读取文件失败', true);
        reader.readAsDataURL(file);
    }

    /**
     * 打开画布选图浮层（信息窗之上的二级弹层）：网格列出画布上的
     * 图片对象（排除面板节点/占位图/视频），点击即取为封面
     */
    open(lora) {
        const host = this.host;
        host._pickerOverlay?.remove();
        const canvas = window.canvas;
        const imgs = canvas
            ? canvas.images.images.filter((im) =>
                im?.img?.src &&
                !NodeTypes.isPanelNode(im.source) &&
                !NodeTypes.isPlaceholder(im.source) &&
                !NodeTypes.isVideo(im.source))
            : [];

        const overlay = document.createElement('div');
        overlay.className = 'lora-canvas-picker';
        const head = document.createElement('div');
        head.className = 'lora-picker-head';
        head.textContent = '选择画布图片作为封面';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'lora-picker-close';
        close.textContent = '×';
        close.title = '关闭';
        close.addEventListener('click', () => {
            overlay.remove();
            host._pickerOverlay = null;
        });
        head.appendChild(close);

        const grid = document.createElement('div');
        grid.className = 'lora-picker-grid';
        if (imgs.length === 0) {
            grid.innerHTML = '<div class="lora-picker-empty">画布上没有可用图片</div>';
        }
        for (const im of imgs) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'lora-picker-item';
            const thumb = document.createElement('img');
            thumb.src = im.img.src;
            item.appendChild(thumb);
            item.title = im.name || '';
            item.addEventListener('click', async () => {
                try {
                    const dataUrl = await ImageExport.toDataUrl(im.img, im.img.src);
                    overlay.remove();
                    host._pickerOverlay = null;
                    this.upload(dataUrl);
                } catch (err) {
                    host._infoStatus('取图失败：' + (err.message || err), true);
                }
            });
            grid.appendChild(item);
        }

        const panel = document.createElement('div');
        panel.className = 'lora-picker-panel';
        panel.append(head, grid);
        overlay.appendChild(panel);
        overlay.addEventListener('mousedown', (e) => {
            if (e.target === overlay) {
                overlay.remove();
                host._pickerOverlay = null;
            }
        });
        document.body.appendChild(overlay);
        host._pickerOverlay = overlay;
    }

    /** 上传封面（POST /api/lora/cover），成功后缓存击穿并刷新网格 */
    async upload(dataUrl) {
        const host = this.host;
        const lora = host._infoLora;
        if (!lora) return;
        host._infoStatus('上传中…');
        try {
            const resp = await fetch('/api/lora/cover', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: lora.path, dataUrl })
            });
            const r = await resp.json().catch(() => null);
            if (!resp.ok || !r || r.status !== 'ok') {
                // 非 JSON 响应（多半是后端未重启、路由 404 的 HTML 错误页）给明示
                throw new Error(r?.message || `上传失败（HTTP ${resp.status}；若刚更新过程序请重启后端）`);
            }
            host._bustMap = host._bustMap || {};
            host._bustMap[lora.path] = Date.now();   // 绕过 /preview 的 1 天浏览器缓存
            host._closeInfoModal();
            host._renderGrid();
        } catch (err) {
            host._infoStatus('❌ ' + (err.message || err), true);
        }
    }
}

window.LoraCoverPicker = LoraCoverPicker;
