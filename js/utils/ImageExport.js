/**
 * ==========================================================================
 * LumenLight 图片源导出工具（ImageExport）
 * ==========================================================================
 * 作用：把「任意图片源」统一转为可上传/可保存的 data URL / blob，
 *       供图片工具栏「添加到资产」「下载」等导出场景共用：
 *   - data URL 直通；
 *   - blob: / 同源相对路径 fetch 取字节；
 *   - 远程 http(s) 经后端 /api/llm/download-image 代理取字节（避 CORS）；
 *   - 全部失败时兜底用已加载的 <img> 重绘 canvas 转 PNG
 *     （可能受 CORS 污染限制，仅作最后手段）。
 *
 * 说明：
 *   - 响应的 Content-Type 不可信（代理可能给 octet-stream），blob 非
 *     image/* 时按文件头魔数嗅探真实格式（sniffImageMime）；
 *   - 除兜底路径碰 DOM 外均为纯逻辑，可单测（test/utils/imageExport.test.js）。
 * ==========================================================================
 */

const ImageExport = {
    /**
     * 把图片源统一转为 data URL（data:image/...;base64,...）
     * @param {HTMLImageElement|null} img - 兜底重绘用的已加载 img 元素
     * @param {string} src - 图片源（data URL / blob URL / 同源路径 / 远程 URL）
     * @returns {Promise<string>} data URL
     */
    async toDataUrl(img, src) {
        if (src && src.startsWith('data:')) return src;

        try {
            let fetchUrl = src;
            if (/^https?:\/\//i.test(src) && !src.startsWith(window.location.origin)) {
                // 远程图走后端代理，避免 CORS 导致 fetch 失败/格式异常
                fetchUrl = `/api/llm/download-image?url=${encodeURIComponent(src)}&filename=asset`;
            }
            const response = await fetch(fetchUrl);
            if (!response.ok) throw new Error(`读取图片失败（HTTP ${response.status}）`);
            const blob = await response.blob();
            if (blob.size === 0) throw new Error('图片内容为空');
            const mime = (blob.type || '').startsWith('image/')
                ? blob.type
                : ImageExport.sniffImageMime(await blob.slice(0, 16).arrayBuffer());
            if (!mime) throw new Error('无法识别的图片格式');
            return await ImageExport.blobToDataUrl(blob, mime);
        } catch (err) {
            // 兜底：canvas 重绘转 PNG
            if (!img) throw err;
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth || img.width;
            canvas.height = img.naturalHeight || img.height;
            canvas.getContext('2d').drawImage(img, 0, 0);
            const blob = await ImageExport.canvasToBlob(canvas, 'image/png');
            return ImageExport.blobToDataUrl(blob, 'image/png');
        }
    },

    /** 魔数嗅探图片真实格式（响应 Content-Type 不可信时的兜底），失败返回 null */
    sniffImageMime(arrayBuffer) {
        const b = new Uint8Array(arrayBuffer);
        if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
        if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xD8) return 'image/jpeg';
        if (b.length >= 3 && String.fromCharCode(...b.slice(0, 3)) === 'GIF') return 'image/gif';
        if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' &&
            String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
        if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
        return null;
    },

    /**
     * blob 转 data URL；mime 与 blob.type 不一致时重写前缀声明
     * （主体字节不变，仅替换 data URL 的类型段）
     */
    blobToDataUrl(blob, mime) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const text = String(reader.result);
                resolve(mime && blob.type !== mime
                    ? ImageExport.rewriteMime(text, mime)
                    : text);
            };
            reader.onerror = () => reject(new Error('读取图片数据失败'));
            reader.readAsDataURL(blob);
        });
    },

    /** 重写 data URL 的 mime 声明段（主体字节不变），纯函数 */
    rewriteMime(dataUrl, mime) {
        const base64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
        return `data:${mime};base64,${base64}`;
    },

    /** canvas 导出 blob 的 Promise 封装（默认 PNG） */
    canvasToBlob(canvas, mime = 'image/png') {
        return new Promise((resolve, reject) =>
            canvas.toBlob(
                (b) => (b ? resolve(b) : reject(new Error('无法创建图片 blob'))),
                mime
            ));
    }
};

// 暴露到全局作用域
window.ImageExport = ImageExport;
