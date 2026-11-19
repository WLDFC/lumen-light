/**
 * ==========================================================================
 * 在线画廊路由（/api/gallery，提示词管理器「在线画廊」视图的后端支撑）
 * ==========================================================================
 * 三个端点：
 *   GET /:source/list  列表（source=civitai|danbooru）——转发源站 API 并归一化
 *   GET /image?u=      图片代理——浏览器 <img> 全部经此取图，内存 LRU 缓存
 *
 * 设计要点：
 *   - 网络层复用 utils/civitai.js 的三级代理解析（settings civitai.proxy →
 *     环境变量 → Windows 系统代理注册表）+ 超时退避——与 LoRA 一键获取
 *     同一条联网通道，系统挂代理即自动走代理，零新增配置（ADR 090）；
 *   - Civitai 域名回退：civitai.red 镜像（LoRA 已验证可用）→ civitai.com
 *     主站，进程内驻留命中域；Danbooru 无镜像直连 donmai.us；
 *   - 列表响应内存 TTL 缓存（3 分钟）：瀑布流快速翻页极易打满源站匿名
 *     限流，缓存是最便宜的护盾；
 *   - 图片缓存为字节封顶 LRU（128MB，超出逐出最旧）：**只驻内存不落盘**，
 *     重启即清——「浏览不保存」的结构性保证（不写 tag/、不进资产库）；
 *   - 图片代理带域名后缀白名单 + 内网地址拒绝：暴露为 HTTP 端点的
 *     取图口必须防 SSRF（防当内网探针用）；
 *   - Danbooru 鉴权可选：data/settings.json 加 danbooru: { username,
 *     apiKey } 后以 query 参数注入，匿名 tag 配额 2 → 登录配额 6。
 * ==========================================================================
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { resolveProxy, getDispatcher, getCivitaiSettings, civitaiFetch } = require('../utils/civitai');
const civitaiGallery = require('../utils/gallery/civitai');
const danbooruGallery = require('../utils/gallery/danbooru');
const imageMeta = require('../utils/gallery/imageMeta');

// ==================== 内嵌元数据缓存（图片代理时顺手提取，ADR 090） ====================
// 用户建议采纳：加载图片的同时提取内嵌元数据并缓存——复制词/详情秒出，
// 不再按需二次提取。value: { meta, at }（meta 可为 null=文件确实不带）。
const genMetaCache = new Map();
const GEN_META_TTL = 30 * 60 * 1000;
const GEN_META_MAX = 200;

function genMetaGet(url) {
    const hit = genMetaCache.get(url);
    if (!hit) return undefined;               // undefined=未提取过；null=提取过但无元数据
    if (Date.now() - hit.at > GEN_META_TTL) { genMetaCache.delete(url); return undefined; }
    return hit.meta;
}

function genMetaSet(url, meta) {
    genMetaCache.set(url, { meta: meta || null, at: Date.now() });
    while (genMetaCache.size > GEN_META_MAX) {
        genMetaCache.delete(genMetaCache.keys().next().value);
    }
}

const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'settings.json');

// ==================== 代理 dispatcher（按代理地址驻留） ====================

let _dispCache = { url: null, agent: undefined };

/** 解析当前应走的代理并取/建 dispatcher（resolveProxy 自带 5 分钟缓存） */
async function currentDispatcher() {
    const proxyUrl = await resolveProxy();
    if (_dispCache.url !== proxyUrl) {
        _dispCache = { url: proxyUrl, agent: getDispatcher(proxyUrl) };
    }
    return _dispCache.agent;
}

// ==================== 列表响应 TTL 缓存 ====================

const apiCache = new Map();          // key → { body, at }
const API_CACHE_TTL = 3 * 60 * 1000; // 3 分钟：翻页快于限流窗口，够用且不陈旧
const API_CACHE_MAX = 40;            // 条数上限（按 key 驻留）

function apiCacheGet(key) {
    const hit = apiCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > API_CACHE_TTL) {
        apiCache.delete(key);
        return null;
    }
    // LRU 触达前置
    apiCache.delete(key);
    apiCache.set(key, hit);
    return hit.body;
}

function apiCacheSet(key, body) {
    apiCache.delete(key);
    apiCache.set(key, { body, at: Date.now() });
    while (apiCache.size > API_CACHE_MAX) {
        apiCache.delete(apiCache.keys().next().value);
    }
}

// ==================== Civitai 域名回退（主站 → 镜像，进程内驻留） ====================

// 主站在前：/images 的 meta（提示词）只有主站返回——镜像域 civitai.red
// 会剥掉 meta（实测 20 条全 null），只能出图/底模/热度，作为无代理时的
// 浏览兜底（提示词由详情懒加载版本接口富化，见 /civitai/version）。
const CIVITAI_HOSTS = ['https://civitai.com', 'https://civitai.red'];
let _civitaiHostIdx = 0;

// retries=0：域名回退由本函数自行处理，单域退避重试只会拖慢换域
// （直连被墙的域通常 1 秒内即失败，重试两次要 6 秒+，不值得）
async function fetchCivitai(queryPath, { apiKey, dispatcher }) {
    let lastErr = null;
    for (let i = 0; i < CIVITAI_HOSTS.length; i++) {
        const idx = (_civitaiHostIdx + i) % CIVITAI_HOSTS.length;
        try {
            const resp = await civitaiFetch(CIVITAI_HOSTS[idx] + queryPath,
                { apiKey, dispatcher, retries: 0, timeoutMs: 15000 });
            _civitaiHostIdx = idx;   // 命中域驻留，下次直接从它开始
            return resp;
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr || new Error('Civitai 全部域名不可达');
}

// ==================== Danbooru 可选鉴权 ====================

function readDanbooruCreds() {
    try {
        const j = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
        const d = (j.danbooru && typeof j.danbooru === 'object') ? j.danbooru : {};
        return {
            username: typeof d.username === 'string' ? d.username.trim() : '',
            apiKey: typeof d.apiKey === 'string' ? d.apiKey.trim() : ''
        };
    } catch {
        return { username: '', apiKey: '' };
    }
}

// ==================== 图片代理：白名单 + 字节 LRU ====================

/** 允许取图的源站域名后缀（画廊两源的图床全部落在这里面） */
const IMG_HOST_SUFFIX = ['civitai.com', 'civitai.red', 'donmai.us'];

/** 校验图片 URL：http(s) + 后缀白名单 + 内网/环回地址拒绝（SSRF 防线） */
function isAllowedImageUrl(rawUrl) {
    let u;
    try {
        u = new URL(rawUrl);
    } catch {
        return false;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = String(u.hostname || '').toLowerCase();
    if (!host) return false;
    // 内网/环回/链路本地一律拒绝（DNS 名也可能解析到内网，这里只挡
    // 字面内网地址；真内网 IP 经域名进来由企业内网自担——本地个人工具）
    if (/^(localhost|0\.|127\.|10\.|169\.254\.|192\.168\.)/.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (host === '::1' || host === '[::1]') return false;
    return IMG_HOST_SUFFIX.some((s) => host === s || host.endsWith('.' + s));
}

const IMG_CACHE_MAX_BYTES = 128 * 1024 * 1024; // 128MB：约几百张缩略图+大图
let _imgCacheBytes = 0;
const imgCache = new Map();          // url → { buf, type }

function imgCacheGet(url) {
    const hit = imgCache.get(url);
    if (!hit) return null;
    imgCache.delete(url);
    imgCache.set(url, hit);           // LRU 触达前置
    return hit;
}

function imgCacheSet(url, entry) {
    imgCache.delete(url);
    imgCache.set(url, entry);
    _imgCacheBytes += entry.buf.length;
    while (_imgCacheBytes > IMG_CACHE_MAX_BYTES && imgCache.size > 1) {
        const oldestKey = imgCache.keys().next().value;
        const oldest = imgCache.get(oldestKey);
        _imgCacheBytes -= oldest.buf.length;
        imgCache.delete(oldestKey);
    }
}

/** 取图共用助手（/image 与 /meta 共用）：缓存命中直取，未命中拉上游并写入缓存 */
async function fetchImageBuf(url) {
    const hit = imgCacheGet(url);
    if (hit) return hit;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let resp;
    try {
        resp = await fetch(url, {
            dispatcher: await currentDispatcher(),
            signal: ctrl.signal,
            headers: { 'User-Agent': 'LumenLight/1.0' }
        });
    } finally {
        clearTimeout(timer);
    }
    if (!resp.ok) {
        const e = new Error(`图片源返回 HTTP ${resp.status}`);
        e.code = 'UPSTREAM_' + resp.status;
        throw e;
    }
    const type = String(resp.headers.get('content-type') || '');
    if (!type.startsWith('image/')) {
        const e = new Error('目标不是图片：' + type);
        e.code = 'NOT_IMAGE';
        throw e;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) throw new Error('图片数据为空');
    const entry = { buf, type };
    imgCacheSet(url, entry);
    return entry;
}

// ==================== 路由装配 ====================

/** @param {Object} [deps] 预留依赖注入口（测试桩），当前实现零外部依赖 */
function createGalleryRouter(deps = {}) {
    const router = express.Router();

    // ---- 列表：GET /:source/list ----
    router.get('/:source/list', async (req, res) => {
        const source = String(req.params.source || '');
        if (source !== 'civitai' && source !== 'danbooru') {
            return res.status(404).json({ error: '未知画廊源：' + source });
        }
        const q = req.query || {};
        const limit = Math.min(Math.max(Number(q.limit) || 48, 1), 200);

        let cacheKey;
        let fetcher;
        if (source === 'civitai') {
            const { apiKey } = await getCivitaiSettings();
            let pathQ;
            if (q.mode === 'search' && q.q) {
                // Images 搜索（用户拍板 2026-11-19）：/images 无关键词维度
                // （tag/query/model 等实测被站方静默忽略）→ 搜模型聚合展示图，
                // 词支持中文；nsfw 作防御性图片级过滤
                pathQ = civitaiGallery.buildModelsSearchPath({ query: q.q, cursor: q.cursor });
                cacheKey = 'civitai-search:' + pathQ;
                fetcher = async () => {
                    const resp = await fetchCivitai(pathQ, { apiKey, dispatcher: await currentDispatcher() });
                    return civitaiGallery.normalizeModelSearch(await resp.json(), { nsfw: q.nsfw });
                };
            } else {
                pathQ = civitaiGallery.buildPath({
                    nsfw: q.nsfw, sort: q.sort, period: q.period,
                    basemodels: q.basemodels, cursor: q.cursor, limit
                });
                cacheKey = 'civitai:' + pathQ;
                fetcher = async () => {
                    const resp = await fetchCivitai(pathQ, { apiKey, dispatcher: await currentDispatcher() });
                    return civitaiGallery.normalizeItems(await resp.json());
                };
            }
        } else {
            const { username, apiKey } = readDanbooruCreds();
            const { path: pathQ, warnings } = danbooruGallery.buildPath({
                tags: q.q, nsfw: q.nsfw, sort: q.sort, page: q.page, limit
            });
            // 鉴权走 query 参数（Danbooru 官方口径），仅配置了才注入
            let fullUrl = pathQ;
            if (username && apiKey) {
                fullUrl += `&login=${encodeURIComponent(username)}&api_key=${encodeURIComponent(apiKey)}`;
            }
            cacheKey = 'danbooru:' + pathQ;   // 鉴权参数不进缓存键
            fetcher = async () => {
                const dispatcher = await currentDispatcher();
                const resp = await civitaiFetch(fullUrl, { dispatcher, timeoutMs: 30000, retries: 1 });
                const payload = await resp.json();
                const norm = danbooruGallery.normalizeItems(payload, limit);
                norm.warnings = warnings;
                return norm;
            };
        }

        const cached = apiCacheGet(cacheKey);
        if (cached) return res.json(cached);

        try {
            const norm = await fetcher();
            apiCacheSet(cacheKey, norm);
            res.json(norm);
        } catch (err) {
            console.error('[gallery] 列表拉取失败:', err.message);
            res.status(502).json({ error: '画廊源拉取失败：' + (err.message || '网络错误') });
        }
    });

    // ---- Civitai 版本详情：GET /civitai/version?id=&imageId=（详情面板富化） ----
    // /images 的 meta 已被站方全站剥除，但 **/model-versions/{id} 的
    // images[] 里仍有完整生成参数**（2026-11-19 实测 10/10 非空）——按
    // imageId 在版本示例图里精确匹配，命中即回真实提示词/负面/参数；
    // 未命中回退 trainedWords 触发词（LoRA 同款端点，两域均可达）。
    router.get('/civitai/version', async (req, res) => {
        const id = String(req.query.id || '');
        if (!/^\d+$/.test(id)) return res.status(400).json({ error: '非法版本 id' });
        const imageId = String(req.query.imageId || '');
        const cacheKey = 'civitai-version:' + id + (imageId ? ':' + imageId : '');
        const cached = apiCacheGet(cacheKey);
        if (cached) return res.json(cached);
        try {
            const { apiKey } = await getCivitaiSettings();
            const resp = await fetchCivitai(`/api/v1/model-versions/${id}`,
                { apiKey, dispatcher: await currentDispatcher() });
            const data = await resp.json();
            let meta = null;
            if (imageId) {
                const img = (Array.isArray(data.images) ? data.images : [])
                    .find((i) => i && String(i.id) === imageId && i.meta && Object.keys(i.meta).length);
                if (img) meta = civitaiGallery.normalizeMeta(img.meta);
            }
            const body = {
                trainedWords: Array.isArray(data.trainedWords) ? data.trainedWords.filter(Boolean) : [],
                baseModel: String(data.baseModel || ''),
                modelName: String((data.model && data.model.name) || ''),
                meta
            };
            apiCacheSet(cacheKey, body);
            res.json(body);
        } catch (err) {
            console.error('[gallery] 版本详情拉取失败:', err.message);
            res.status(502).json({ error: '版本数据拉取失败：' + (err.message || '网络错误') });
        }
    });

    // ---- Civitai 基模清单：GET /civitai/basemodels（模型筛选下拉数据源） ----
    // 扫 /models 最近 3 页（limit=100，该端点 200 会被 Zod 拒收）归纳条目
    // 顶层 baseModels 数组去重，按出现频次排序——代表「现在在用的基模」
    // （站方无基模枚举端点）。长 TTL 缓存 6h：清单低频变化，扫描要 3 个
    // 请求；缓存过期后拉取失败时回退旧清单兜底。
    const BASEMODEL_TTL = 6 * 60 * 60 * 1000;
    let _basemodelCache = { list: null, at: 0 };
    router.get('/civitai/basemodels', async (req, res) => {
        if (_basemodelCache.list && Date.now() - _basemodelCache.at < BASEMODEL_TTL) {
            return res.json({ basemodels: _basemodelCache.list });
        }
        try {
            const { apiKey } = await getCivitaiSettings();
            const dispatcher = await currentDispatcher();
            const counts = new Map();
            for (let page = 1; page <= 3; page++) {
                const resp = await fetchCivitai(`/api/v1/models?limit=100&page=${page}&sort=Newest`,
                    { apiKey, dispatcher });
                const d = await resp.json();
                (d.items || []).forEach((m) => {
                    (Array.isArray(m.baseModels) ? m.baseModels : []).forEach((b) => {
                        if (b) counts.set(b, (counts.get(b) || 0) + 1);
                    });
                });
                if (!d.metadata || !d.metadata.nextPage) break;
            }
            const list = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
            _basemodelCache = { list, at: Date.now() };
            res.json({ basemodels: list });
        } catch (err) {
            console.error('[gallery] 基模清单拉取失败:', err.message);
            if (_basemodelCache.list) return res.json({ basemodels: _basemodelCache.list });
            res.status(502).json({ error: '基模清单拉取失败：' + (err.message || '网络错误') });
        }
    });

    // ---- 图片代理：GET /image?u=<encodeURIComponent(源图 URL)> ----
    router.get('/image', async (req, res) => {
        const url = String(req.query.u || '');
        if (!isAllowedImageUrl(url)) {
            return res.status(400).json({ error: '图片地址不在画廊源白名单内' });
        }
        const hit = imgCacheGet(url);
        if (hit) {
            res.set('Content-Type', hit.type);
            res.set('Cache-Control', 'no-store');   // 服务端已缓存，浏览器不必再存
            return res.send(hit.buf);
        }
        try {
            const entry = await fetchImageBuf(url);
            // 加载即提取（用户建议）：元数据随首次下载入缓存，/meta 直读
            if (genMetaGet(url) === undefined) {
                genMetaSet(url, imageMeta.extractGenerationMeta(entry.buf));
            }
            res.set('Content-Type', entry.type);
            res.set('Cache-Control', 'no-store');
            return res.send(entry.buf);
        } catch (err) {
            console.error('[gallery] 图片代理失败:', url.slice(0, 120), err.message);
            return res.status(502).json({ error: '图片拉取失败：' + (err.message || '网络错误') });
        }
    });

    // ---- 图片内嵌元数据：GET /meta?u=（PNG 文本块/JPEG EXIF 提取，ADR 090） ----
    // 优先读「加载图片时」顺手提取的缓存（秒出）；未提取过才拉字节提取。
    // 注意 null 与 undefined 的区别：null=提取过但文件确实不带元数据。
    router.get('/meta', async (req, res) => {
        const url = String(req.query.u || '');
        if (!isAllowedImageUrl(url)) {
            return res.status(400).json({ error: '图片地址不在画廊源白名单内' });
        }
        const cached = genMetaGet(url);
        if (cached !== undefined) {
            return res.json({ source: cached ? cached.source : null, meta: cached || null });
        }
        try {
            const entry = await fetchImageBuf(url);
            const meta = imageMeta.extractGenerationMeta(entry.buf);
            genMetaSet(url, meta);
            res.json({ source: meta ? meta.source : null, meta: meta || null });
        } catch (err) {
            console.error('[gallery] 元数据提取失败:', url.slice(0, 120), err.message);
            res.status(502).json({ error: '元数据提取失败：' + (err.message || '网络错误') });
        }
    });

    return router;
}

// 与 routes/ 全体同款：工厂函数直出（server.js 按惯例直调 require 结果，
// 曾因导出对象形态致后端启动即崩——createGalleryRouter is not a function）
module.exports = createGalleryRouter;
