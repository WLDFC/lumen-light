/**
 * ==========================================================================
 * LumenLight 网页桥接：资产管线（assets）
 * ==========================================================================
 * 从 WebBridgeManager 拆出的纯函数模块：资源下载（页面上下文/后端直连
 * 两级回退）、原图候选择优、内容签名去重、附件暂存。显式传入 page/
 * cookie 等依赖，不持有状态——便于单元测试与新站点复用。
 * ==========================================================================
 */

const fsp = require('fs').promises;
const path = require('path');

/** 视频类扩展名（决定产物按图片还是视频回流） */
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'gif', 'mkv', 'avi']);

/** 后端直连时的通用 UA（部分 CDN 校验 UA，空 UA 会被拒） */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 后端直连下载超时：CDN 偶发停滞会让交付无限等（视频放宽到 2 分钟） */
const NODE_FETCH_TIMEOUT_MS = 120 * 1000;
/** 页面内小资源（图片等）直连超时 */
const NODE_FETCH_IMAGE_TIMEOUT_MS = 30 * 1000;

/**
 * 页面上下文 fetch 下载为 data URL（自动带站点 Cookie/Referer；
 * blob:/data: 地址只能走这里）。分块转 base64，避免大图爆栈
 */
async function pageFetchDataUrl(page, url) {
    return page.evaluate(async (u) => {
        const resp = await fetch(u, { credentials: 'include' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        const type = resp.headers.get('content-type') || 'image/png';
        return `data:${type.split(';')[0]};base64,${btoa(binary)}`;
    }, url);
}

/**
 * 后端直连（Node fetch + Cookie/Referer/UA 注入）下载为 data URL。
 * CDN 图片常不带 CORS 头，页面 fetch 被浏览器拦截时走这里
 */
async function nodeFetchDataUrl(url, { cookieHeader = '', referer = '' } = {}) {
    const resp = await fetch(url, {
        headers: { 'Cookie': cookieHeader, 'Referer': referer, 'User-Agent': BROWSER_UA },
        signal: AbortSignal.timeout(NODE_FETCH_IMAGE_TIMEOUT_MS)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const mime = (resp.headers.get('content-type') || 'image/png').split(';')[0];
    const buffer = Buffer.from(await resp.arrayBuffer());
    return `data:${mime};base64,${buffer.toString('base64')}`;
}

/**
 * 下载资源为 data URL，两级回退：
 *   1) 页面上下文 fetch（自动带站点 Cookie/Referer；blob:/data: 只能走这里）
 *   2) 后端直连——不受 CORS 约束
 * @param {Object} page - puppeteer Page
 * @param {string} url - 资源地址
 * @param {{cookieHeader?: string, referer?: string}} opts
 */
async function downloadAsDataUrl(page, url, { cookieHeader = '', referer = '' } = {}) {
    if (!/^(blob:|data:)/.test(url)) {
        try {
            return await pageFetchDataUrl(page, url);
        } catch (err) {
            console.warn('[WebBridge] 页面内下载失败，回退后端直连:', err.message);
            return await nodeFetchDataUrl(url, { cookieHeader, referer });
        }
    }
    return pageFetchDataUrl(page, url);
}

/** 图片像素尺寸（sharp 惰性加载；解码失败返回 null） */
async function imageMeta(dataUrl) {
    try {
        const sharp = require('sharp');
        const buffer = Buffer.from(String(dataUrl).split(',')[1] || '', 'base64');
        return await sharp(buffer).metadata();
    } catch {
        return null;
    }
}

/**
 * 图片路径基键：剥掉 URL 里的 ~tplv 模板段与查询参数后的路径。
 * 同一张图的缩略/原图请求共享同一基键（只差参数段）——网络捕获的
 * 大图响应据此归属到对应的回复图片；UI 资源（气泡图标等）路径不同，
 * 自然对不上号被丢弃
 * @param {string} url
 * @returns {string}
 */
function imageBaseKey(url) {
    try {
        const u = new URL(url);
        return u.pathname.split('~tplv-')[0];
    } catch {
        return String(url).split('?')[0].split('~tplv-')[0];
    }
}

/**
 * 下载最佳图片：候选来源多路合并（调用方传入的 URL 清单，可含网络捕获
 * 的原图 URL），每个 URL 再按适配器的原图候选（imageVariants，可选）展开，
 * 按实际像素取最大者——回复块里的 <img> 常是缩略变体（如 288x384）；
 * 解不出像素的候选（如剥模板后 404 返回的 HTML）不参与比较；
 * 全部候选失败才抛错。
 * 适配器可选质量门槛：
 *   goodEnoughPixels——像素达标且字节达标即提前收工（后续候选只可能
 *   大一点点，却要再花一轮页面内下载）；
 *   minImageBytes——字节下限：同分辨率常有多个质量档（真机对比：网页
 *   下载 753KB 原图 vs 交付的 233KB 压缩档，分辨率相同清晰度肉眼可见
 *   差异），像素比不出质量差，字节量才能。达标候选里取像素最大者；
 *   全部不达标才退回全部候选里像素最大者（保底有图，宁低清不空手）
 */
async function downloadBestImage({ page, urls, adapter, cookieHeader = '', referer = '' }) {
    const baseList = Array.isArray(urls) ? urls : [urls];
    const allUrls = [...new Set(baseList.flatMap((u) => (adapter.imageVariants ? adapter.imageVariants(u) : [u])))];
    const goodEnough = adapter && adapter.goodEnoughPixels > 0 ? adapter.goodEnoughPixels : 0;
    const minBytes = adapter && adapter.minImageBytes > 0 ? adapter.minImageBytes : 0;
    const tried = [];      // 可解码候选 { dataUrl, pixels, bytes }
    let fallback = null;   // 第一个能下载的（全部候选都解码失败时的兜底）
    for (const variant of allUrls) {
        try {
            const dataUrl = await downloadAsDataUrl(page, variant, { cookieHeader, referer });
            if (!fallback) fallback = dataUrl;
            const meta = await imageMeta(dataUrl);
            // 解不出像素尺寸的候选（如剥模板后 404 返回的 HTML）不参与比较，
            // 防止非图片内容混进画布
            if (!meta) {
                console.log(`[WebBridge] 图片候选不可解码: ${variant.slice(0, 120)}`);
                continue;
            }
            const pixels = meta.width * meta.height;
            const bytes = Buffer.from(String(dataUrl).split(',')[1] || '', 'base64').length;
            console.log(`[WebBridge] 图片候选: ${variant.slice(0, 120)} → ${meta.width}x${meta.height} (${Math.round(bytes / 1024)}KB)`);
            tried.push({ dataUrl, pixels, bytes });
            if (goodEnough && pixels >= goodEnough && (!minBytes || bytes >= minBytes)) break;
        } catch (err) {
            console.log(`[WebBridge] 图片候选失败: ${variant.slice(0, 120)} → ${err.message}`);
        }
    }
    if (!tried.length) {
        if (fallback) return fallback;
        throw new Error('全部原图候选下载失败');
    }
    const pool = minBytes ? tried.filter((c) => c.bytes >= minBytes) : tried;
    return (pool.length ? pool : tried).reduce((a, b) => (b.pixels > a.pixels ? b : a)).dataUrl;
}

/**
 * 图片内容签名：16x16 灰度 raw buffer（sharp 惰性加载）。
 * 用于"同图多尺寸 CDN 变体"的近似重复判定——URL 去重兜不住的场景
 */
async function imageSignature(dataUrl) {
    try {
        const sharp = require('sharp');
        const buffer = Buffer.from(String(dataUrl).split(',')[1] || '', 'base64');
        return await sharp(buffer).resize(16, 16, { fit: 'fill' }).greyscale().raw().toBuffer();
    } catch {
        return null;   // 解码失败（非法图等）：不参与签名比对
    }
}

/** 两个签名的平均绝对差（0-255）；<3 视为同图 */
function sigMeanDiff(a, b) {
    if (!a || !b || a.length !== b.length) return 255;
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
}

/**
 * 下载视频转存到指定目录（后端直连 + Cookie/Referer/UA 注入；
 * 视频体积大，不走页面 evaluate 的 base64 中转）
 * @param {{url: string, cookieHeader?: string, referer?: string, dir: string, namePrefix?: string}} opts
 * @returns {Promise<{fileBase: string, ext: string}>} 文件名（不含目录）
 */
async function downloadVideoToFile({ url, cookieHeader = '', referer = '', dir, namePrefix = 'wb' }) {
    const resp = await fetch(url, {
        headers: { 'Cookie': cookieHeader, 'Referer': referer, 'User-Agent': BROWSER_UA },
        signal: AbortSignal.timeout(NODE_FETCH_TIMEOUT_MS)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const pathPart = (url.split('?')[0].split('.').pop() || '').toLowerCase();
    const ext = VIDEO_EXTS.has(pathPart) ? pathPart : 'mp4';
    await fsp.mkdir(dir, { recursive: true });
    const fileBase = `${namePrefix}_${Date.now()}.${ext}`;
    const buffer = Buffer.from(await resp.arrayBuffer());
    await fsp.writeFile(path.join(dir, fileBase), buffer);
    return { fileBase, ext };
}

/**
 * 附件 data URL → 磁盘临时文件（供 uploadFile 原生注入使用）
 * @param {{dataDir: string, dataUrls: string[]}} opts
 * @returns {Promise<string[]>} 磁盘路径清单
 */
async function stageImageFiles({ dataDir, dataUrls }) {
    const dir = path.join(dataDir, 'webbridge', 'tmp');
    await fsp.mkdir(dir, { recursive: true });
    const paths = [];
    for (let i = 0; i < dataUrls.length; i++) {
        const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrls[i]);
        if (!m) continue;
        const ext = (m[1].split('/')[1] || 'png').replace('jpeg', 'jpg');
        const file = path.join(dir, `attach_${Date.now()}_${i}.${ext}`);
        await fsp.writeFile(file, Buffer.from(m[2], 'base64'));
        paths.push(file);
    }
    return paths;
}

/** 清理暂存文件（尽力而为，失败不影响主流程） */
function cleanupStagedFiles(paths) {
    for (const file of paths || []) {
        fsp.unlink(file).catch(() => {});
    }
}

module.exports = {
    VIDEO_EXTS,
    pageFetchDataUrl,
    nodeFetchDataUrl,
    downloadAsDataUrl,
    imageMeta,
    imageSignature,
    sigMeanDiff,
    imageBaseKey,
    downloadBestImage,
    downloadVideoToFile,
    stageImageFiles,
    cleanupStagedFiles
};
