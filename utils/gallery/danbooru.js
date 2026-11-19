/**
 * ==========================================================================
 * Danbooru 在线画廊适配器（提示词管理器「在线画廊」视图）
 * ==========================================================================
 * 纯函数层：查询构造 + 响应归一化。网络层与代理解析复用 utils/civitai.js
 * （danbooru.donmai.us 与 Civitai 同走系统代理），消费方是 routes/gallery.js。
 *
 * 端点：GET /posts.json?tags=...&page=N&limit=N
 *
 * 关键约束——匿名查询最多 2 个 tag（metatag 也计数）：分级（rating:x）
 * 与排序（order:score）都是 metatag，加上用户搜索词很容易超限。
 * 组装优先级：用户词 > 分级 > 排序；超限从低优先级开始丢弃，丢弃记录
 * 进 warnings 由前端提示。配置 data/settings.json 的 danbooru 用户名+
 * apiKey 后配额升到 6（路由层负责注入，本层不管）。
 *
 * 筛选映射（用户拍板三档制）：
 *   SFW  → rating:g,s      Soft → rating:q      R18 → rating:q,e
 * 排序：hot=order:score（最热）；new=默认序（id 倒序，无 metatag 省额度）。
 * 分页：page 序号模式（items 长度==limit 视为还有下一页）。
 * ==========================================================================
 */

const POSTS_BASE = 'https://danbooru.donmai.us';

/**
 * 分级筛选 → Danbooru rating tag（用户拍板：站方原生四档 + 独立「全部」
 * 档且默认。四档为站方精确语义 rating:x 只出该档——「全部」接管了
 * 全量职责，避免与上限语义的露骨档重复；all=空串不加 rating tag）。
 * 空串值判存在须用 hasOwnProperty（真值判定会把 '' 误回退别的档）。
 */
const RATING_MAP = {
    all: '',
    g: 'rating:g',
    s: 'rating:s',
    q: 'rating:q',
    e: 'rating:e'
};

/** 排序两档 → 追加的 metatag（new 用默认序，不花 tag 额度） */
const SORT_MAP = {
    hot: 'order:score',
    new: ''
};

/**
 * 构造 /posts.json 查询路径（含 host 前缀，Danbooru 无镜像策略）。
 * @param {Object} [opts]
 * @param {string} [opts.tags]    - 用户搜索词（空格分隔，匿名限 2 tag）
 * @param {string} [opts.nsfw=sfw]- 三档 key（RATING_MAP）
 * @param {string} [opts.sort=hot]- 两档 key（SORT_MAP）
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=48]
 * @returns {{ path: string, warnings: string[] }}
 *   warnings：因 2-tag 配额被丢弃的维度提示（前端展示）
 */
function buildPath({ tags, nsfw, sort, page, limit } = {}) {
    const warnings = [];
    const userTags = String(tags || '').split(/\s+/).map(t => t.trim()).filter(Boolean);
    // 注意 RATING_MAP.all = ''（不过滤=全量，默认档）与 SORT_MAP.new = '' 同理——
    // 判存在不能用真值，会被误判回退别的档
    const rating = Object.prototype.hasOwnProperty.call(RATING_MAP, nsfw)
        ? RATING_MAP[nsfw]
        : RATING_MAP.all;
    // 注意 SORT_MAP.new = ''（默认序零额度）——判存在不能用真值，会被误判回退 hot
    const sortKey = Object.prototype.hasOwnProperty.call(SORT_MAP, sort) ? sort : 'hot';
    const sortTag = SORT_MAP[sortKey];

    // 2-tag 配额分配：用户词全保，其次分级，最后排序（ Danbooru 登录后
    // 配额 6，这里按匿名口径收窄——有 key 也不会错，只是保守）
    const budget = 2;
    const picked = [...userTags];
    if (rating && picked.length + 1 <= budget) {
        picked.push(rating);
    } else if (rating) {
        warnings.push('匿名查询最多 2 个标签（含分级）：本次搜索词已占满，分级筛选被忽略');
    }
    if (sortTag && picked.length + 1 <= budget) {
        picked.push(sortTag);
    } else if (sortTag) {
        warnings.push('匿名查询最多 2 个标签（含排序）：排序被忽略，按默认序返回');
    }

    const params = new URLSearchParams();
    params.set('tags', picked.join(' '));
    params.set('limit', String(Math.min(Math.max(Number(limit) || 48, 1), 200)));
    params.set('page', String(Math.max(Number(page) || 1, 1)));
    return { path: `${POSTS_BASE}/posts.json?${params.toString()}`, warnings };
}

/**
 * 归一化 /posts.json 响应为画廊卡片模型。
 * @param {Object} payload - Danbooru 响应 JSON（帖子数组）
 * @param {number} [reqLimit] - 请求的 limit（判定是否还有下一页）
 * @returns {{ items: Array<Object>, nextToken: string|null }}
 *   Danbooru 无提示词概念：prompt 用 general tags 逗号串等价呈现。
 */
function normalizeItems(payload, reqLimit = 48) {
    const raw = Array.isArray(payload) ? payload : [];
    const items = raw.map((p) => {
        if (!p || p.id === undefined) return null;
        const general = String(p.tag_string_general || '');
        const tagList = general ? general.split(/\s+/).filter(Boolean) : [];
        return {
            id: String(p.id),
            source: 'danbooru',
            thumb: String(p.preview_file_url || p.large_file_url || ''),
            // 原始文件优先（image_width/height 是原图尺寸，下载/落画布
            // 必须与之一致——曾用 large 样图导致尺寸对不上，用户反馈）
            full: String(p.file_url || p.large_file_url || p.preview_file_url || ''),
            width: Number(p.image_width) || 0,
            height: Number(p.image_height) || 0,
            prompt: tagList.join(', '),
            negativePrompt: '',
            tags: tagList,
            artist: String(p.tag_string_artist || '').split(/\s+/).filter(Boolean).join(', '),
            rating: String(p.rating || ''),
            score: Number(p.score) || 0,
            model: '',
            baseModel: '',
            loras: [],
            sampler: '',
            steps: '',
            cfgScale: '',
            seed: '',
            size: '',
            username: String(p.uploader_name || ''),
            link: `${POSTS_BASE}/posts/${p.id}`
        };
    }).filter(Boolean);
    const hasMore = raw.length > 0 && raw.length >= Math.max(Number(reqLimit) || 48, 1);
    return { items, nextToken: hasMore ? '1' : null };
}

module.exports = { POSTS_BASE, RATING_MAP, SORT_MAP, buildPath, normalizeItems };
