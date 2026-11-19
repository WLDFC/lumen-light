/**
 * ==========================================================================
 * Civitai 在线画廊适配器（提示词管理器「在线画廊」视图）
 * ==========================================================================
 * 纯函数层：查询构造 + 响应归一化，不做任何网络/文件操作。
 * 网络层复用 utils/civitai.js（resolveProxy 三级代理 + getDispatcher +
 * civitaiFetch 超时退避），消费方是 routes/gallery.js。
 *
 * 端点：GET {host}/api/v1/images（host 由路由层做 civitai.red 镜像 →
 * civitai.com 主站回退，见路由层 CIVITAI_HOSTS）。
 *
 * 与站点 UI 的筛选映射（用户拍板三档制；nsfw 参数只收单值，语义为
 * 「展示到该档为止」——实测逗号列表被 API 的 Zod 校验 400 拒收）：
 *   SFW  → nsfw=None（仅安全图）
 *   Soft → nsfw=Soft（到轻度为止）
 *   R18  → nsfw=X（到露骨为止 = 全部）
 * 排序：hot=Most Reactions（最热，**默认档**——站内 Images 板块口径，
 *       period 恒定下发缺省 Month：用户反馈 AllTime 全期榜全是陈年旧图
 *       +模型封面观感，月榜保持新鲜度；且实测月榜作者多样性最好，
 *       SFW+最新组合的全龄池子极小易被单模型霸屏）／
 *       new=Newest（最新发布）。
 * 分页：cursor 模式（响应 metadata.nextCursor，请求 cursor= 追加）。
 * ==========================================================================
 */

/** SFW 三档 → Civitai nsfw 参数值（单值，上限语义） */
const NSFW_MAP = {
    sfw: 'None',
    soft: 'Soft',
    r18: 'X'
};

/** 排序两档 → Civitai sort 参数值（period 独立成档，恒定下发） */
const SORT_MAP = {
    hot: 'Most Reactions',
    new: 'Newest'
};

/**
 * 时间范围五档 → period 参数（用户拍板对齐站内 Images 板块筛选样式，
 * 中文档名：今天/本周/本月/今年/全部时间；默认 month）。对「最新发布」
 * 排序时 period 可能被站方忽略（无日期过滤效果的场合无害）。
 */
const PERIOD_MAP = {
    day: 'Day',
    week: 'Week',
    month: 'Month',
    year: 'Year',
    all: 'AllTime'
};

/**
 * 构造 /images 查询路径（不含 host 前缀）。
 * @param {Object} [opts]
 * @param {string} [opts.nsfw=sfw]    - 三档 key（NSFW_MAP）
 * @param {string} [opts.sort=new]    - 两档 key（SORT_MAP）
 * @param {string} [opts.period=month]- 时间范围 key（PERIOD_MAP，恒定下发）
 * @param {string} [opts.basemodels]  - 基模筛选（可空；/images 的 baseModels
 *                                      参数实测生效，逗号多值待验证只用单值）
 * @param {string} [opts.cursor]      - 下一页游标（首次为空）
 * @param {string} [opts.username]    - 按作者筛选（可空）
 * @param {number} [opts.limit=48]    - 每页条数
 * @returns {string} 如 /api/v1/images?limit=48&nsfw=None&sort=Newest&period=Month
 */
function buildPath({ nsfw, sort, period, basemodels, cursor, username, limit } = {}) {
    const params = new URLSearchParams();
    params.set('limit', String(Math.min(Math.max(Number(limit) || 48, 1), 200)));
    params.set('nsfw', NSFW_MAP[nsfw] || NSFW_MAP.sfw);
    const sortKey = SORT_MAP[sort] ? sort : 'hot';
    params.set('sort', SORT_MAP[sortKey]);
    params.set('period', PERIOD_MAP[period] || PERIOD_MAP.month);
    if (basemodels) params.set('baseModels', basemodels);
    if (username) params.set('username', username);
    if (cursor) params.set('cursor', cursor);
    return `/api/v1/images?${params.toString()}`;
}

/**
 * 缩略图 URL 重写：Civitai 图床的 URL 路径段里嵌了尺寸声明
 * （/original=true/ 原图 或 /width=N/ 优化档），替换为指定宽度档省流量。
 * 识别不了的形态原样返回（原图即缩略，代价是流量）。
 * @param {string} url   - /images 返回的原图 url
 * @param {number} [width=450]
 */
function rewriteThumbUrl(url, width = 450) {
    if (!url || typeof url !== 'string') return url;
    if (/\/original=true(?=\/|$)/.test(url)) {
        return url.replace('/original=true', `/width=${width},optimized=true`);
    }
    if (/\/width=\d+/.test(url)) {
        return url.replace(/\/width=\d+/, `/width=${width}`);
    }
    return url;
}

/** meta 字段宽容取值：不同生成工具写键名不同（A1111/Comfy/新式），逐个兜底 */
function pickMeta(m, keys) {
    for (const k of keys) {
        if (m && m[k] !== undefined && m[k] !== null && m[k] !== '') return m[k];
    }
    return '';
}

/**
 * meta 对象归一（两处共用：/images 条目的 meta、/model-versions 的
 * images[].meta——后者是 2026-11 起公开 API 唯一还带生成参数的地方）。
 * @param {Object} m - 原始 meta（可能是 null）
 * @returns {{ prompt, negativePrompt, model, baseModel, loras, sampler,
 *            steps, cfgScale, seed, size }}
 */
function normalizeMeta(m) {
    m = (m && typeof m === 'object') ? m : {};
    const resources = Array.isArray(m.resources) ? m.resources : [];
    return {
        prompt: String(pickMeta(m, ['prompt', 'Prompt']) || ''),
        negativePrompt: String(pickMeta(m, ['negativePrompt', 'Negative prompt', 'negative_prompt']) || ''),
        model: String(pickMeta(m, ['Model', 'model']) || ''),
        baseModel: String(pickMeta(m, ['Base model', 'baseModel']) || ''),
        loras: resources
            .filter((r) => r && r.type === 'lora' && (r.name || r.modelName))
            .map((r) => r.name || r.modelName),
        sampler: String(pickMeta(m, ['sampler', 'samplerName', 'Sampler']) || ''),
        steps: String(pickMeta(m, ['steps', 'Steps']) || ''),
        cfgScale: String(pickMeta(m, ['cfgScale', 'CFG scale', 'cfg_scale', 'CFGScale']) || ''),
        seed: String(pickMeta(m, ['seed', 'Seed']) || ''),
        size: String(pickMeta(m, ['Size', 'size']) || '')
    };
}

/**
 * 归一化 /images 响应为画廊卡片模型。
 * 兼容两种条目形态：主站（meta 内含 prompt/参数；无顶层 baseModel）与
 * civitai.red 镜像（meta 被剥成 null，顶层给 baseModel/modelVersionIds/
 * stats.likeCount，thumbnail 键常为 null）——字段逐层兜底取值。
 * @param {Object} payload - Civitai 响应 JSON（{ items, metadata }）
 * @returns {{ items: Array<Object>, nextToken: string|null }}
 *   meta 缺失的字段一律空串/空数组（UI 隐藏）；prompt 空时前端详情
 *   按 modelVersionId 懒加载触发词富化（routes /civitai/version）。
 */
function normalizeItems(payload) {
    const raw = Array.isArray(payload && payload.items) ? payload.items : [];
    const items = raw.map((it) => {
        const m = (it && it.meta && typeof it.meta === 'object') ? it.meta : {};
        const meta = normalizeMeta(m);
        const id = String((it && it.id) || '');
        const url = (it && typeof it.url === 'string') ? it.url : '';
        const type = String((it && it.type) || 'image');
        const modelVersions = Array.isArray(it && it.modelVersionIds) ? it.modelVersionIds : [];
        const stats = (it && it.stats && typeof it.stats === 'object') ? it.stats : {};
        const likeCount = Number(stats.likeCount) || 0;
        return {
            id,
            source: 'civitai',
            type,   // 'image' | 'video'（视频条目已在 filter 剔除）
            // 镜像的 thumbnail 键常为 null：有值直用，否则对原图做宽度档重写
            thumb: (it && typeof it.thumbnail === 'string' && it.thumbnail)
                ? it.thumbnail
                : rewriteThumbUrl(url, 450),
            full: url,
            width: Number(it && it.width) || 0,
            height: Number(it && it.height) || 0,
            prompt: meta.prompt,
            negativePrompt: meta.negativePrompt,
            tags: [],
            model: meta.model,
            // 底模：镜像在顶层，主站可能在 meta 里
            baseModel: String((it && it.baseModel) || meta.baseModel || ''),
            loras: meta.loras,
            sampler: meta.sampler,
            steps: meta.steps,
            cfgScale: meta.cfgScale,
            seed: meta.seed,
            size: meta.size,
            score: likeCount,                    // 热度（点赞数，卡片 footer 展示）
            username: String((it && it.username) || ''),
            // 首个版本 id：详情面板提示词富化（/civitai/version）的钥匙
            modelVersionId: modelVersions.length ? String(modelVersions[0]) : '',
            link: id ? `https://civitai.com/images/${id}` : ''
        };
    }).filter((it) => it.id && it.full && it.type === 'image');   // 视频条目剔除（<img> 无法渲染、meta 也不适用）
    const nextCursor = (payload && payload.metadata && payload.metadata.nextCursor) || null;
    return { items, nextToken: nextCursor ? String(nextCursor) : null };
}

/**
 * 构造 /models 关键词搜索路径（Images 搜索的公开 API 落地，2026-11-19）：
 * /images 无关键词维度——tag/query/q/search/model 等参数实测被站方
 * 静默忽略（返回与无参数相同的默认列表）——改搜模型，命中模型自带
 * 各版本展示图，扁平化成图片网格（与站内搜索 Images 标签同语义，
 * 站内那份数据走无文档的内部接口，不可依赖）。
 * @param {Object} opts
 * @param {string} opts.query    - 搜索词（支持中文，站方任意文本匹配）
 * @param {string} [opts.cursor] - 下一页游标（首次为空）
 * @returns {string} 如 /api/v1/models?query=asuna&limit=8
 */
function buildModelsSearchPath({ query, cursor } = {}) {
    const params = new URLSearchParams();
    params.set('query', String(query || ''));
    params.set('limit', String(MODELS_SEARCH_PAGE));
    if (cursor) params.set('cursor', cursor);
    return `/api/v1/models?${params.toString()}`;
}

/** 搜索模式每页模型数与单模型图片上限（8×8 ≈ 画廊一页 48~64 张） */
const MODELS_SEARCH_PAGE = 8;
const MODEL_IMAGE_CAP = 8;

/** 图片 nsfw 档位排序（防御性过滤：字段缺失的条目不拦） */
const IMAGE_NSFW_RANK = { None: 0, Soft: 1, Mature: 2, X: 3 };
/** 分级三档 → 可展示的最高图片档位（与 NSFW_MAP 上限语义一致） */
const NSFW_CAP_RANK = { sfw: 0, soft: 1, r18: 3 };

/**
 * 归一化 /models 搜索响应为画廊卡片模型：把每个命中模型的各版本展示图
 * 扁平化成图片条目（按图片 id 去重，单模型封顶 MODEL_IMAGE_CAP 张防
 * 单模型霸屏；版本数组 newest 在前，等于优先取最新版本的展示图）。
 * 字段映射：底模/版本 id 取图片所属版本（modelVersionId=详情富化钥匙），
 * 作者取图片 username 回退模型 creator，link 落图片详情页。
 * @param {Object} payload - Civitai /models 响应 JSON（{ items, metadata }）
 * @param {Object} [opts]
 * @param {string} [opts.nsfw=sfw] - 分级三档 key（防御性按图片 nsfw 字段过滤）
 * @returns {{ items: Array<Object>, nextToken: string|null }}
 */
function normalizeModelSearch(payload, { nsfw } = {}) {
    const capRank = NSFW_CAP_RANK[nsfw] !== undefined ? NSFW_CAP_RANK[nsfw] : 0;
    const raw = Array.isArray(payload && payload.items) ? payload.items : [];
    const seen = new Set();
    const items = [];
    for (const m of raw) {
        if (!m || typeof m !== 'object') continue;
        const modelName = String(m.name || '');
        const creator = String((m.creator && m.creator.username) || '');
        let cap = MODEL_IMAGE_CAP;
        for (const v of (Array.isArray(m.modelVersions) ? m.modelVersions : [])) {
            if (cap <= 0) break;
            const baseModel = String(v.baseModel || '');
            const versionId = String(v.id || '');
            for (const im of (Array.isArray(v.images) ? v.images : [])) {
                if (cap <= 0) break;
                const id = String((im && im.id) || '');
                const url = (im && typeof im.url === 'string') ? im.url : '';
                if (!id || !url || seen.has(id)) continue;
                if (im.type && im.type !== 'image') continue;   // 视频条目剔除
                const rank = IMAGE_NSFW_RANK[im.nsfw];
                if (rank !== undefined && rank > capRank) continue;
                seen.add(id);
                cap--;
                const meta = normalizeMeta(im.meta);
                items.push({
                    id,
                    source: 'civitai',
                    type: 'image',
                    thumb: rewriteThumbUrl(url, 450),
                    full: url,
                    width: Number(im.width) || 0,
                    height: Number(im.height) || 0,
                    prompt: meta.prompt,
                    negativePrompt: meta.negativePrompt,
                    tags: [],
                    model: meta.model || modelName,
                    baseModel,
                    loras: meta.loras,
                    sampler: meta.sampler,
                    steps: meta.steps,
                    cfgScale: meta.cfgScale,
                    seed: meta.seed,
                    size: meta.size,
                    score: 0,
                    username: String(im.username || creator),
                    modelVersionId: versionId,
                    link: id ? `https://civitai.com/images/${id}` : ''
                });
            }
        }
    }
    const nextCursor = (payload && payload.metadata && payload.metadata.nextCursor) || null;
    return { items, nextToken: nextCursor ? String(nextCursor) : null };
}

module.exports = { NSFW_MAP, SORT_MAP, PERIOD_MAP, buildPath, buildModelsSearchPath, MODELS_SEARCH_PAGE, MODEL_IMAGE_CAP, rewriteThumbUrl, normalizeMeta, normalizeItems, normalizeModelSearch };
