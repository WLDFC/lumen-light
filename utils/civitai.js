/**
 * ==========================================================================
 * Civitai 数据获取工具（LoRA 管理器「一键获取」的后端支撑）
 * ==========================================================================
 * 参考 ComfyUI-Lora-Manager 插件（willmiao）的实现方式：
 *   - 以 LoRA 文件的完整 SHA256 为身份，请求 civitai.red 镜像站的
 *     /model-versions/by-hash/{sha256} 端点拿到版本数据（触发词、示例图、
 *     底模、作者等），再以 /models/{modelId} 富化；
 *   - 封面取第一张示例图，URL 重写为 width=450 优化档再下载（省流量）。
 *
 * 本模块只做无 UI 的纯能力层：
 *   - calculateSha256 / getSha256：流式哈希 + 按 (size, mtime) 缓存到
 *     data/lora-hashes.json（LoRA 动辄上 GB，缓存是性能关键）；
 *   - resolveProxy：手动配置 → 环境变量 → Windows 系统代理（注册表）
 *     的三级解析，配 undici ProxyAgent 供 fetch 走代理；
 *   - civitaiFetch / fetchVersionByHash / downloadPreview：带鉴权、超时、
 *     429/5xx 退避重试的 HTTP 层。
 * ==========================================================================
 */

const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');

const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'settings.json');
const HASH_CACHE_FILE = path.join(__dirname, '..', 'data', 'lora-hashes.json');
const CIVITAI_API_BASE = 'https://civitai.red/api/v1';
const HASH_CHUNK = 4 * 1024 * 1024;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function readJsonSafe(file, fallback) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf-8'));
    } catch {
        return fallback;
    }
}

async function writeJsonAtomic(file, data) {
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await fsp.rename(tmp, file);
}

// ==================== 设置（data/settings.json 的 civitai 区块） ====================

/** 读取 Civitai 相关设置：{ apiKey, proxy }（均为可选） */
async function getCivitaiSettings() {
    const s = await readJsonSafe(SETTINGS_FILE, {});
    const c = (s.civitai && typeof s.civitai === 'object') ? s.civitai : {};
    return {
        apiKey: typeof c.apiKey === 'string' ? c.apiKey.trim() : '',
        proxy: typeof c.proxy === 'string' ? c.proxy.trim() : ''
    };
}

// ==================== 代理解析 ====================

let _proxyCache = { value: null, at: 0 };
const PROXY_CACHE_TTL = 5 * 60 * 1000;

/** 把 "host:port" 归一成 "http://host:port"（ProxyAgent 接受完整 URL） */
function normalizeProxy(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (/^(https?|socks[45]?):\/\//i.test(s)) return s;
    return 'http://' + s;
}

/**
 * Windows 系统代理解析（注册表 Internet Settings，Clash/v2rayN 等都写这里）。
 * ProxyServer 可能是 "host:port" 或 "http=..;https=..;socks=.." 两种形态，
 * 后者优先取 https 段。非 Windows / 检测失败返回 ''（直连）。
 */
async function detectSystemProxy() {
    if (process.platform !== 'win32') return '';
    const cmd = "$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; " +
        "if ($p.ProxyEnable -eq 1 -and $p.ProxyServer) { Write-Output $p.ProxyServer }";
    const { stdout } = await new Promise((resolve) => {
        execFile('powershell.exe', ['-NoProfile', '-Command', cmd],
            { timeout: 6000 }, (err, out) => resolve({ err, stdout: out || '' }));
    });
    const s = stdout.trim();
    if (!s) return '';
    if (s.includes(';') || s.includes('=')) {
        const m = /(?:^|;)(?:https?)=([^;]+)/i.exec(s);
        return m ? normalizeProxy(m[1]) : '';
    }
    return normalizeProxy(s);
}

/**
 * 代理解析（按优先级）：
 *   1. settings.json 的 civitai.proxy（手动配置，如 http://127.0.0.1:7890）
 *   2. 环境变量 HTTPS_PROXY / HTTP_PROXY
 *   3. Windows 系统代理（注册表，5 分钟缓存——powershell 检测不便宜）
 * 返回 '' 表示直连。
 */
async function resolveProxy() {
    const { proxy } = await getCivitaiSettings();
    if (proxy) return normalizeProxy(proxy);
    const env = process.env.HTTPS_PROXY || process.env.https_proxy ||
        process.env.HTTP_PROXY || process.env.http_proxy;
    if (env && env.trim()) return normalizeProxy(env);
    if (Date.now() - _proxyCache.at < PROXY_CACHE_TTL) return _proxyCache.value || '';
    let detected = '';
    try { detected = await detectSystemProxy(); } catch { /* 检测失败按直连 */ }
    _proxyCache = { value: detected, at: Date.now() };
    return detected;
}

/** 由代理 URL 构造 undici ProxyAgent；undici 未安装时警告并返回 undefined（直连） */
function getDispatcher(proxyUrl) {
    if (!proxyUrl) return undefined;
    try {
        const { ProxyAgent } = require('undici');
        return new ProxyAgent(proxyUrl);
    } catch (err) {
        console.warn('[civitai] 检测到代理', proxyUrl, '但 undici 未安装（npm install undici），本次请求将尝试直连:', err.message);
        return undefined;
    }
}

// ==================== SHA256 哈希（含缓存） ====================

let _hashCache = null;

async function loadHashCache() {
    if (!_hashCache) _hashCache = await readJsonSafe(HASH_CACHE_FILE, {});
    return _hashCache;
}

/** 把内存里的哈希缓存落盘（批任务结束后与每次计算后均可调用） */
async function saveHashCache() {
    if (_hashCache) await writeJsonAtomic(HASH_CACHE_FILE, _hashCache);
}

/** 流式计算文件 SHA256（4MB 分块，内存占用恒定） */
async function calculateSha256(filePath) {
    const hash = crypto.createHash('sha256');
    const fh = await fsp.open(filePath, 'r');
    try {
        const stream = fh.createReadStream({ highWaterMark: HASH_CHUNK });
        for await (const chunk of stream) hash.update(chunk);
    } finally {
        await fh.close();
    }
    return hash.digest('hex');
}

/**
 * 取 LoRA 文件的 SHA256（带缓存）：缓存的 sizeBytes/mtimeMs 与当前 stat 一致
 * 直接命中，否则重算并更新缓存。relPath 为 lorasDir 相对路径（与 /list 同源）。
 */
async function getSha256(lorasDir, relPath, stat) {
    const cache = await loadHashCache();
    const hit = cache[relPath];
    if (hit && hit.sha256 && hit.sizeBytes === stat.size && hit.mtimeMs === stat.mtimeMs) {
        return hit.sha256;
    }
    const sha = await calculateSha256(path.join(lorasDir, relPath));
    cache[relPath] = { sha256: sha, sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
    await saveHashCache();
    return sha;
}

// ==================== Civitai HTTP 层 ====================

/**
 * 带鉴权/超时/退避重试的 Civitai 请求。
 * 返回原生 Response（200），404 抛 err.code='NOT_FOUND'（模型未收录），
 * 429/5xx 指数退避重试后仍失败则抛错。
 */
async function civitaiFetch(url, { apiKey, dispatcher, timeoutMs = 30000, retries = 2 } = {}) {
    const headers = { 'User-Agent': 'LumenLight/1.0' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const resp = await fetch(url, { headers, dispatcher, signal: ctrl.signal });
            if (resp.ok) return resp;
            if (resp.status === 404) {
                const e = new Error('not found');
                e.code = 'NOT_FOUND';
                throw e;
            }
            if (resp.status === 429 || resp.status >= 500) {
                lastErr = new Error(`HTTP ${resp.status}`);
                if (attempt < retries) {
                    await sleep(resp.status === 429 ? 10000 : 2000 * (attempt + 1));
                    continue;
                }
                throw lastErr;
            }
            const text = await resp.text().catch(() => '');
            const e = new Error(`HTTP ${resp.status}${text ? ': ' + text.slice(0, 200) : ''}`);
            e.code = 'HTTP_ERROR';
            throw e;
        } catch (err) {
            if (err.code === 'NOT_FOUND' || err.code === 'HTTP_ERROR') throw err;
            lastErr = err;   // 网络层错误（超时/DNS/连接拒绝）→ 退避重试
            if (attempt < retries) {
                await sleep(2000 * (attempt + 1));
                continue;
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastErr || new Error('请求失败');
}

/** 以 SHA256 查 Civitai 版本数据（含 trainedWords / images / baseModel 等） */
async function fetchVersionByHash(sha256, { apiKey, dispatcher } = {}) {
    const resp = await civitaiFetch(`${CIVITAI_API_BASE}/model-versions/by-hash/${sha256}`, { apiKey, dispatcher });
    return resp.json();
}

/** 拉取模型页正文（/models/{id} 的模型描述，HTML 格式；失败返回空串不阻塞） */
async function fetchModelDescription(modelId, { apiKey, dispatcher } = {}) {
    try {
        const resp = await civitaiFetch(`${CIVITAI_API_BASE}/models/${modelId}`, { apiKey, dispatcher });
        const data = await resp.json();
        return (data && typeof data.description === 'string') ? data.description : '';
    } catch {
        return '';
    }
}

/** 从版本数据里挑封面：优先静态图（跳过视频类示例），兜底第一张 */
function pickCoverImage(version) {
    const images = Array.isArray(version && version.images) ? version.images : [];
    if (!images.length) return null;
    const staticImg = images.find((i) => i && i.url && (i.type === 'image' || !i.type));
    return (staticImg || images.find((i) => i && i.url) || {}).url || null;
}

/** 封面 URL 重写：original=true → width=450 优化档（与插件同款，省流量） */
function rewriteCoverUrl(sourceUrl) {
    if (!sourceUrl || !sourceUrl.includes('/original=true')) return sourceUrl;
    return sourceUrl.replace('/original=true', '/width=450,optimized=true');
}

/** 由 URL 后缀 / Content-Type 推断封面扩展名（落 sidecar 用） */
function pickCoverExt(imageUrl, contentType) {
    if (contentType && contentType.includes('png')) return 'png';
    const m = /\.(jpe?g|png|webp|gif)(?:\?|#|$)/i.exec(imageUrl || '');
    if (m) {
        const e = m[1].toLowerCase();
        return e === 'jpeg' ? 'jpg' : e;
    }
    return 'jpg';
}

/** 下载封面图到本地 sidecar 路径（图床无需鉴权，走同一代理） */
async function downloadPreview(imageUrl, savePath, { dispatcher } = {}) {
    const resp = await fetch(rewriteCoverUrl(imageUrl), { dispatcher });
    if (!resp.ok) throw new Error(`封面下载失败 HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) throw new Error('封面数据为空');
    await fsp.mkdir(path.dirname(savePath), { recursive: true });
    await fsp.writeFile(savePath, buf);
    return buf.length;
}

module.exports = {
    sleep,
    getCivitaiSettings,
    resolveProxy,
    getDispatcher,
    calculateSha256,
    getSha256,
    saveHashCache,
    civitaiFetch,
    fetchVersionByHash,
    fetchModelDescription,
    pickCoverImage,
    rewriteCoverUrl,
    pickCoverExt,
    downloadPreview
};
