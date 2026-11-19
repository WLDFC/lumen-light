/**
 * LayerSplit 子模块：导出（Object.assign 进 LayerSplit.prototype）
 * 落画布=可见图层逐层转稳定 URL（/api/assets 内容寻址）后 addImage
 * 原位摆放（数组序=画布 z 序，背景垫底）；下载=可见层合成单 PNG。
 */

Object.assign(LayerSplit.prototype, {

    /** 分层落画布：背景垫底 + 切片按原位摆放（各自独立可拖动/缩放） */
    async _sendToCanvas() {
        if (!this.sourceImage) return;
        const visible = this.layers.filter((l) => l.visible && l.opacity > 0);
        if (!visible.length) {
            this.status('没有可见图层可落画布', true);
            return;
        }
        if (!window.canvas || !window.canvas.images || typeof window.canvas.images.addImage !== 'function') {
            this.status('画布未初始化，无法落图', true);
            return;
        }
        const btn = this.dialog.querySelector('.ls-act-canvas-send');
        btn.disabled = true;
        btn.textContent = '落图中…';
        let landed = 0;
        try {
            for (const layer of visible) {
                // 内容寻址入库（幂等去重）：dataURL → 稳定 URL，存档恢复不吃 dataURL 体积
                const url = await this._uploadToAssets(layer.src, `${layer.name}.png`);
                const img = await this._loadImage(url);
                window.canvas.images.addImage({
                    img,
                    x: layer.bbox[0],
                    y: layer.bbox[1],
                    width: layer.bbox[2],
                    height: layer.bbox[3],
                    name: `${layer.name}.png`,
                    source: 'layer-split'
                });
                landed++;
            }
            if (window.canvas.draw) window.canvas.draw();
            this.status(`已把 ${landed} 个图层落到画布（背景垫底、切片原位）；画布上可继续拖动/缩放/抠图`);
        } catch (err) {
            this.status('落画布失败：' + ((err && err.message) || err), true);
        } finally {
            btn.disabled = false;
            btn.textContent = '落画布';
        }
    },

    /** dataURL 上传资产库换稳定 URL（内容寻址幂等，见 routes/assets.js） */
    async _uploadToAssets(dataUrl, name) {
        try {
            const r = await fetch('/api/assets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ src: dataUrl, name })
            });
            const result = await r.json().catch(() => null);
            if (r.ok && result && result.status === 'ok' && result.url) return result.url;
            this.status('资产入库失败，回落 dataURL 直落：' +
                ((result && result.message) || r.status), true);
        } catch (err) {
            this.status('资产入库失败，回落 dataURL 直落：' + (err && err.message ? err.message : err), true);
        }
        return dataUrl;   // 入库失败不阻断：直接用 dataURL 落
    },

    /** 可见图层合成单张 PNG 下载 */
    _downloadPng() {
        if (!this.sourceImage) return;
        const W = this.sourceImage.width, H = this.sourceImage.height;
        const cv = document.createElement('canvas');
        cv.width = W;
        cv.height = H;
        const ctx = cv.getContext('2d');
        for (const layer of this.layers) {
            if (!layer.visible || layer.opacity <= 0) continue;
            if (!layer._imgEl) continue;   // 未就绪层跳过（与舞台渲染同口径）
            ctx.globalAlpha = layer.opacity;
            ctx.drawImage(layer._imgEl, layer.bbox[0], layer.bbox[1], layer.bbox[2], layer.bbox[3]);
            ctx.globalAlpha = 1;
        }
        const a = document.createElement('a');
        a.href = cv.toDataURL('image/png');
        a.download = `layer-split-${Date.now()}.png`;
        a.click();
        this.status('已下载合成 PNG');
    },
});
