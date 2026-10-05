/**
 * ==========================================================================
 * LumenLight pi 联网工具扩展（lumen-web）
 * ==========================================================================
 * 作用：给 pi 提供无 key、零依赖的联网能力（对标 ZCode 的 WebSearch /
 * WebFetch / webReader 三件套的功能形态；ZCode 的搜索/提炼云端服务本身
 * 不可移植，本地实现退化为"结果列表 + 干净正文"，提炼由 pi 自己完成）：
 *
 *   - web_search：关键词搜索 → 标题/链接/摘要结果列表。
 *       主源 DuckDuckGo lite 端点（无 key、无验证码、纯 HTML 表格好解析），
 *       请求失败或零结果时自动切换 Bing 中国站备源（国内直连稳定）；
 *   - web_fetch：URL → 正文文本。
 *       HTML 剥掉 script/style/标签提取正文，text/json 原样返回，
 *       二进制内容拒读并说明；限长截断防上下文爆仓；
 *   - web_image_search：关键词搜图 → 原图直链清单（含缩略图/来源页/尺寸）。
 *       默认依次尝试 Bing 图片（直链质量高、结构稳）→ 百度图片（国内必达，
 *       对国风/国内题材更准；返回百度 CDN 中图——objURL 原链加密且原图站
 *       多防盗链，middleURL 才是稳定可取的部分）→ DuckDuckGo 图片（vqd
 *       令牌 + i.js JSON 接口，网络门槛最高故居末位）；source 参数可强制
 *       指定引擎。
 *
 * 设计取舍：
 *   - 无 API key：搜索走公开 HTML 端点解析，排序质量属"够用"级；
 *     工具签名保持稳定，日后要升级 Tavily/Brave 等付费源时只换实现；
 *   - 零依赖：只用 pi 自带 Node 的内置 fetch + 手写解析，不引任何
 *     npm 包——发行包解压即用，与项目"免安装"策略一致；
 *   - 只读工具：不涉及 lumen-guard 写门禁；pi 本就有 bash+curl，
 *     网络可达面不变，本扩展改变的只是输出的质量与 token 成本；
 *   - 内网防护：web_fetch 拒绝 loopback/私网主机名（SSRF 惯例），
 *     防止 agent 把内网接口的大段 JSON 拉进上下文；需要访问内网时
 *     仍可走 bash curl（显式、可审计）。
 *
 * 安装：放入 ~/.pi/agent/extensions/（自动加载）。
 * 测试钩子：冒烟测试直接替换 globalThis.fetch 注入 mock（无需环境变量）。
 *
 * 重要实现约束：pi 以 --mode rpc 运行时 stdout 是 JSONL 协议通道，
 * 本扩展内严禁 console.log / process.stdout.write 等任何输出。
 * ==========================================================================
 */

import { Type } from "typebox";

/** 默认与上限：单次抓取体积 / 返回正文字符数（防上下文爆仓） */
const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 20000;
const MAX_CHARS_LIMIT = 60000;
const FETCH_TIMEOUT_MS = 20000;

/** 搜索结果条数上限（DDG lite 单页约 20+ 条，取前 N 条足够） */
const MAX_SEARCH_RESULTS = 8;

/** 请求标识（部分站点对无 UA 请求返回 403） */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** 工具结果的文本包装（与 lumen-skills/lumen-mcp 同契约：缺 content 包装 pi 解析为空输出） */
function text(s: string) {
    return { content: [{ type: "text" as const, text: s }] };
}

/** 带超时与 UA 的 fetch（所有网络请求统一走这里；extraHeaders 供个别源追加，如百度的 Referer） */
async function httpGet(url: string, timeoutMs = FETCH_TIMEOUT_MS,
    extraHeaders?: Record<string, string>): Promise<Response> {
    return fetch(url, {
        headers: {
            "User-Agent": UA,
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            ...extraHeaders
        },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow"
    });
}

// ==================== 内网防护（web_fetch 的 SSRF 惯例） ====================

/** loopback / 私网 / 链路本地的主机名黑名单（按主机名判断，不做 DNS 解析——
 *  威胁模型是"agent 误拉内网接口"，不是恶意绕过） */
const PRIVATE_HOST_RE =
    /^(localhost|.*\.local|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|\[?fe80:.*|\[?fc[0-9a-f]{2}:.*|\[?fd[0-9a-f]{2}:.*)$/i;

function isPrivateHost(hostname: string): boolean {
    return PRIVATE_HOST_RE.test(hostname);
}

// ==================== HTML → 正文（web_fetch 的核心解析） ====================

/** 基础命名实体 + 数字实体的轻量解码（覆盖正文里最常见的；不追求完备） */
function decodeEntities(s: string): string {
    const named: Record<string, string> = {
        amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
        nbsp: " ", mdash: "—", ndash: "–", hellip: "…",
        laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™"
    };
    return s
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m);
}

/** 单个 HTML 标签集内剥除（如 script/style 整块删除，防 JS 代码混进正文） */
function stripBlocks(html: string, tag: string): string {
    return html.replace(
        new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), " ");
}

/** HTML → 纯文本正文：块级标签转换行、剥样式与脚本、实体解码、压缩空行 */
export function htmlToText(html: string): string {
    let s = html;
    // 先删注释与不可见块，防其中的伪标签干扰后续替换
    s = s.replace(/<!--[\s\S]*?-->/g, " ");
    for (const tag of ["script", "style", "noscript", "svg", "iframe", "template"]) {
        s = stripBlocks(s, tag);
    }
    // 块级元素边界转换行（闭合与开始都算断行点），列表项加标记
    s = s.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)>/gi, "\n");
    s = s.replace(/<(br|hr)\b[^>]*\/?>/gi, "\n");
    s = s.replace(/<li\b[^>]*>/gi, "\n• ");
    s = s.replace(/<h[1-6]\b[^>]*>/gi, "\n\n## ");
    // 剩余标签全部剥掉
    s = s.replace(/<[^>]+>/g, " ");
    s = decodeEntities(s);
    // 压缩空白：行内多空白合一；连续空行最多留一个
    s = s.split(/\r?\n/).map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim()).join("\n");
    s = s.replace(/\n{3,}/g, "\n\n");
    return s.trim();
}

// ==================== web_search：DDG lite 主源 + Bing 备源 ====================

/** 搜索结果条目 */
interface SearchResult {
    title: string;
    url: string;
    snippet: string;
}

/** HTML 转义反转义（搜索结果标题/摘要里的实体） */
function decodeHtml(s: string): string {
    return decodeEntities(s.replace(/<[^>]+>/g, "")).trim();
}

/** DDG lite 会把部分结果包一层 /l/?uddg=<编码URL>&rut=... 跳转，解出真实地址 */
function unwrapDdgUrl(href: string): string {
    const m = href.match(/[?&]uddg=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : href;
}

/** 解析 DuckDuckGo lite 结果页（表格布局：result-link / result-snippet） */
export function parseDdgLite(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    // <a rel="nofollow" class="result-link" href="...">标题</a>
    // <td class="result-snippet">摘要</td>——两两按文档顺序配对
    const linkRe = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRe = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
    const links: Array<{ url: string; title: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html))) {
        links.push({ url: unwrapDdgUrl(m[1]), title: decodeHtml(m[2]) });
    }
    const snippets: string[] = [];
    while ((m = snippetRe.exec(html))) snippets.push(decodeHtml(m[1]));
    for (let i = 0; i < links.length; i++) {
        if (!/^https?:\/\//i.test(links[i].url)) continue;   // 跳过广告/聚合条目
        results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] || "" });
    }
    return results;
}

/** 解析 Bing 结果页（li.b_algo 块：h2>a 标题链接 + 摘要） */
export function parseBing(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    const blockRe = /<li\b[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    const hrefRe = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(html))) {
        const block = m[1];
        const link = block.match(hrefRe);
        if (!link) continue;
        // 摘要取块内第一个 <p>（Bing 把摘要放在 p 或 div.b_caption>p）
        const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        const url = link[1];
        if (!/^https?:\/\//i.test(url)) continue;
        results.push({ title: decodeHtml(link[2]), url, snippet: p ? decodeHtml(p[1]) : "" });
    }
    return results;
}

/** 抓取并解析一个搜索源；失败抛错由调用方切换备源 */
async function searchWith(source: "ddg" | "bing", query: string): Promise<SearchResult[]> {
    const q = encodeURIComponent(query);
    const url = source === "ddg"
        ? `https://lite.duckduckgo.com/lite/?q=${q}`
        : `https://cn.bing.com/search?q=${q}&mkt=zh-CN&setlang=zh-hans`;
    const res = await httpGet(url);
    if (!res.ok) throw new Error(`${source} HTTP ${res.status}`);
    const html = await res.text();
    const results = source === "ddg" ? parseDdgLite(html) : parseBing(html);
    if (results.length === 0) throw new Error(`${source} 零结果（可能被拦截或改版）`);
    return results;
}

// ==================== web_image_search：Bing 图片主源 + DDG 图片备源 ====================

/** 图片搜索结果条目：url=原图直链，thumbnail=缩略图（可能带尺寸参数），page=来源网页 */
interface ImageResult {
    url: string;
    thumbnail: string;
    title: string;
    page?: string;
    width?: number;
    height?: number;
}

/** 解析 Bing 图片结果页：class="iusc" 节点的 m 属性是 HTML 转义的 JSON，
 *  含原图直链 murl / 缩略图 turl / 标题 t / 来源页 purl / 尺寸 mw·mh */
export function parseBingImages(html: string): ImageResult[] {
    const out: ImageResult[] = [];
    const re = /class="iusc"[^>]*\sm="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
        try {
            const meta = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
            if (meta.murl && /^https?:\/\//i.test(meta.murl)) {
                out.push({
                    url: meta.murl,
                    thumbnail: meta.turl || meta.murl,
                    title: typeof meta.t === "string" ? meta.t.trim() : "",
                    page: typeof meta.purl === "string" ? meta.purl : undefined,
                    width: Number(meta.mw) || undefined,
                    height: Number(meta.mh) || undefined
                });
            }
        } catch { /* 单条损坏跳过，不影响其余 */ }
    }
    return out;
}

/** 解析 DDG 图片 JSON 接口（i.js）返回的结果数组 */
export function parseDdgImages(raw: string): ImageResult[] {
    let data: { results?: Array<Record<string, unknown>> };
    try {
        data = JSON.parse(raw);
    } catch {
        return [];
    }
    const out: ImageResult[] = [];
    for (const r of data.results || []) {
        const url = typeof r.image === "string" ? r.image : "";
        if (!/^https?:\/\//i.test(url)) continue;
        out.push({
            url,
            thumbnail: typeof r.thumbnail === "string" ? r.thumbnail : url,
            title: typeof r.title === "string" ? r.title : "",
            page: typeof r.source === "string" ? r.source : undefined,
            width: Number(r.width) || undefined,
            height: Number(r.height) || undefined
        });
    }
    return out;
}

/** 从 DDG 首页 HTML 里挖 vqd 令牌（图片接口 i.js 的必备参数） */
function extractVqd(html: string): string | null {
    return html.match(/vqd="([^"]+)"/)?.[1] ||
        html.match(/vqd=([\d-]+)[&'"]/)?.[1] || null;
}

/** 解析百度图片 acjson 接口返回：data 数组里 middleURL/hoverURL 是百度 CDN
 *  中图（稳定可取、无需 Referer），objURL 原链是加密串且原图站多防盗链——
 *  故 url 取 middleURL 优先；接口可能直接是 JSON，也可能带包装层 */
export function parseBaiduImages(raw: string): ImageResult[] {
    let data: { data?: Array<Record<string, unknown>> };
    try {
        data = JSON.parse(raw);
    } catch {
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) return [];
        try {
            data = JSON.parse(m[0]);
        } catch {
            return [];
        }
    }
    const out: ImageResult[] = [];
    for (const it of data.data || []) {
        // acjson 的 data 数组里混有 null 占位与广告条目，先做形状过滤
        if (!it || typeof it !== "object") continue;
        const url = (typeof it.middleURL === "string" && it.middleURL) ||
            (typeof it.hoverURL === "string" && it.hoverURL) || "";
        if (!/^https?:\/\//i.test(url)) continue;   // 无 CDN 链接的条目（含广告位）跳过
        const title = typeof it.fromPageTitleEnc === "string"
            ? it.fromPageTitleEnc
            : (typeof it.fromPageTitle === "string" ? it.fromPageTitle : "");
        out.push({
            url,
            thumbnail: typeof it.thumbURL === "string" ? it.thumbURL : url,
            title: decodeHtml(title),
            page: typeof it.fromURL === "string" ? it.fromURL : undefined,
            width: Number(it.width) || undefined,
            height: Number(it.height) || undefined
        });
    }
    return out;
}

/** 抓取并解析一个图片搜索源；失败抛错由调用方切换下一源 */
async function imageSearchWith(source: "bing" | "baidu" | "ddg",
    query: string): Promise<ImageResult[]> {
    const q = encodeURIComponent(query);
    if (source === "bing") {
        const res = await httpGet(`https://cn.bing.com/images/search?q=${q}&mkt=zh-CN`);
        if (!res.ok) throw new Error(`bing HTTP ${res.status}`);
        const results = parseBingImages(await res.text());
        if (results.length === 0) throw new Error("bing 零结果（可能被拦截或改版）");
        return results;
    }
    if (source === "baidu") {
        // 百度接口对无 Referer 的请求可能拒答，补上图片站自身作来源
        const res = await httpGet(
            `https://image.baidu.com/search/acjson?tn=resultjson_com&word=${q}` +
            `&pn=0&rn=15&ie=utf-8&oe=utf-8&ct=201326592&fp=result&queryWord=${q}&ipn=r&cl=2&lm=-1`,
            FETCH_TIMEOUT_MS, { Referer: "https://image.baidu.com/" });
        if (!res.ok) throw new Error(`baidu HTTP ${res.status}`);
        const results = parseBaiduImages(await res.text());
        if (results.length === 0) throw new Error("baidu 零结果（可能触发安全验证或改版）");
        return results;
    }
    // DDG：两跳——先拿首页里的 vqd 令牌，再调 i.js JSON 接口
    const tokenPage = await httpGet(`https://duckduckgo.com/?q=${q}&iax=images&ia=images`);
    const vqd = extractVqd(await tokenPage.text());
    if (!vqd) throw new Error("ddg 未能取得 vqd 令牌（页面结构可能已改版）");
    const api = await httpGet(
        `https://duckduckgo.com/i.js?l=wt-wt&o=json&q=${q}&vqd=${vqd}&f=,,,&p=1`);
    if (!api.ok) throw new Error(`ddg HTTP ${api.status}`);
    const results = parseDdgImages(await api.text());
    if (results.length === 0) throw new Error("ddg 零结果（可能被拦截或改版）");
    return results;
}

// ==================== 工具注册 ====================

export default function (pi: {
    registerTool: (tool: unknown) => void;
}) {
    pi.registerTool({
        name: "web_search",
        label: "Web Search",
        description:
            "联网搜索：关键词 → 结果列表（标题/链接/摘要），无 API key。" +
            "用于查事实、找资料、核对最新信息。拿到结果后如需某个页面的完整内容，" +
            "用 web_fetch 按 URL 读取正文。主源 DuckDuckGo，失败自动切 Bing 中国站。",
        parameters: Type.Object({
            query: Type.String({ description: "搜索关键词（中英文均可）" }),
        }),
        async execute(_toolCallId, params) {
            const query = params.query.trim();
            if (!query) throw new Error("搜索关键词不能为空");

            // 主源失败（网络不可达/被拦截/零结果）自动切备源
            let results: SearchResult[] = [];
            let source = "duckduckgo";
            const errors: string[] = [];
            try {
                results = await searchWith("ddg", query);
            } catch (err) {
                errors.push(`duckduckgo: ${err instanceof Error ? err.message : err}`);
                try {
                    results = await searchWith("bing", query);
                    source = "bing";
                } catch (err2) {
                    errors.push(`bing: ${err2 instanceof Error ? err2.message : err2}`);
                }
            }
            if (results.length === 0) {
                throw new Error(`搜索失败——两个搜索源都不可用（${errors.join("；")}）。` +
                    `可能是当前网络无法直连搜索引擎，请检查网络/代理后重试`);
            }

            const NL = String.fromCharCode(10);
            const lines = results.slice(0, MAX_SEARCH_RESULTS).map((r, i) =>
                `${i + 1}. ${r.title}${NL}   ${r.url}${r.snippet ? NL + "   " + r.snippet : ""}`);
            return text(
                `共 ${Math.min(results.length, MAX_SEARCH_RESULTS)} 条结果（源：${source}），` +
                `需要某个页面的完整内容就用 web_fetch 按 URL 读取：` + NL + lines.join(NL)
            );
        },
    });

    pi.registerTool({
        name: "web_fetch",
        label: "Web Fetch",
        description:
            "读取指定 URL 的网页正文（HTML 自动提取纯文本，text/json 原样返回，" +
            "二进制内容拒读）。用于阅读搜索结果里的具体页面、文档、发布说明等。" +
            "返回内容超长时自动截断，可用 startOffset 分段读取。仅支持公网 http(s) 地址。",
        parameters: Type.Object({
            url: Type.String({ description: "要读取的网页地址（http/https）" }),
            maxChars: Type.Optional(Type.Number({
                description: `返回正文的字符数上限（默认 ${DEFAULT_MAX_CHARS}，最大 ${MAX_CHARS_LIMIT}）`
            })),
            startOffset: Type.Optional(Type.Number({
                description: "从正文第 N 个字符开始读取（配合截断提示分段获取长文）"
            })),
        }),
        async execute(_toolCallId, params) {
            // URL 基本校验 + 内网防护
            let target: URL;
            try {
                target = new URL(params.url);
            } catch {
                throw new Error(`非法的 URL：${params.url}`);
            }
            if (target.protocol !== "http:" && target.protocol !== "https:") {
                throw new Error(`仅支持 http(s) 地址，收到：${target.protocol}`);
            }
            if (isPrivateHost(target.hostname)) {
                throw new Error(`拒绝访问内网/本机地址（${target.hostname}）。` +
                    `如确需访问本机服务，请用 bash curl（显式操作，可审计）`);
            }

            const maxChars = Math.max(500, Math.min(MAX_CHARS_LIMIT,
                Math.floor(params.maxChars ?? DEFAULT_MAX_CHARS)));
            const startOffset = Math.max(0, Math.floor(params.startOffset ?? 0));

            const res = await httpGet(target.href);
            const contentType = res.headers.get("content-type") || "";
            if (!res.ok) {
                throw new Error(`读取失败：HTTP ${res.status} ${res.statusText}（${target.href}）`);
            }

            // 二进制内容拒读：图片/字体/PDF 等对文本上下文无意义，
            // 且 base64 化会爆仓（项目图片传输规范同理）
            if (/^(image|audio|video|font)\//i.test(contentType) ||
                /application\/(pdf|octet-stream|zip|gzip)/i.test(contentType)) {
                throw new Error(`该地址是二进制内容（${contentType}），无法作为文本读取`);
            }

            // 限体积读取：超 cap 的部分直接丢弃（正文提取在头部足够）
            const buf = await res.arrayBuffer();
            const sliced = buf.byteLength > MAX_FETCH_BYTES
                ? buf.slice(0, MAX_FETCH_BYTES)
                : buf;
            const raw = new TextDecoder("utf-8", { fatal: false }).decode(sliced);

            const isHtml = /text\/html/i.test(contentType) ||
                (!contentType && /^\s*</.test(raw));
            const body = isHtml ? htmlToText(raw) : raw.trim();
            if (!body) throw new Error(`页面没有可提取的文本内容（${contentType}）`);

            const page = body.slice(startOffset, startOffset + maxChars);
            const NL = String.fromCharCode(10);
            const head = `【web_fetch】${target.href}` + NL +
                `类型：${contentType || "未知"}｜正文字符：${body.length}` +
                `（显示 ${startOffset}–${startOffset + page.length}）`;
            const tail = startOffset + maxChars < body.length
                ? NL + `…（未完：再用 startOffset=${startOffset + maxChars} 续读）`
                : "";
            return text(head + NL + NL + page + tail);
        },
    });

    pi.registerTool({
        name: "web_image_search",
        label: "Web Image Search",
        description:
            "联网搜图：关键词 → 原图直链清单（含缩略图、来源网页、尺寸），无 API key。" +
            "默认依次尝试 Bing 图片 → 百度图片 → DuckDuckGo 图片，前一源失败自动换下一源。" +
            "百度源返回百度 CDN 中图（稳定可取），对国风/国内题材更准，可用 source 强制指定。" +
            "拿到直链后把图放到画布用 canvas_drop_image 的 url 参数即可（浏览器经后端" +
            "代理取图，base64 不进会话），也可把链接报给用户点开查看。",
        parameters: Type.Object({
            query: Type.String({ description: "图片搜索关键词（中英文均可）" }),
            maxResults: Type.Optional(Type.Number({
                description: "返回条数上限（默认 8，最大 15）"
            })),
            source: Type.Optional(Type.String({
                description: "强制指定搜索引擎：bing / baidu / ddg（缺省 auto 按上述顺序自动回退）"
            })),
        }),
        async execute(_toolCallId, params) {
            const query = params.query.trim();
            if (!query) throw new Error("搜索关键词不能为空");
            const maxResults = Math.max(1, Math.min(15,
                Math.floor(params.maxResults ?? 8)));

            // 引擎顺序：source 强制指定时只试该源；缺省按「直链质量 + 国内
            // 可达性」排序依次回退——bing 结构最稳，baidu 国内必达（对国风/
            // 国内题材更准），ddg 网络门槛最高
            const SOURCES = ["bing", "baidu", "ddg"] as const;
            type Source = typeof SOURCES[number];
            let order: Source[];
            if (params.source && params.source !== "auto") {
                if (!SOURCES.includes(params.source as Source)) {
                    throw new Error(`未知搜索引擎：${params.source}（可选 bing / baidu / ddg）`);
                }
                order = [params.source as Source];
            } else {
                order = [...SOURCES];
            }

            const errors: string[] = [];
            let results: ImageResult[] = [];
            let source = "";
            for (const s of order) {
                try {
                    results = await imageSearchWith(s, query);
                    source = s;
                    break;
                } catch (err) {
                    errors.push(`${s}: ${err instanceof Error ? err.message : err}`);
                }
            }
            if (results.length === 0) {
                throw new Error(`图片搜索失败——${order.length > 1 ? "所有搜索源都不可用" : "搜索源不可用"}` +
                    `（${errors.join("；")}）。可能是当前网络无法直连搜索引擎，` +
                    `请检查网络/代理或换一个 source 重试`);
            }

            const NL = String.fromCharCode(10);
            const lines = results.slice(0, maxResults).map((r, i) => {
                const size = r.width && r.height ? `｜${r.width}×${r.height}` : "";
                const page = r.page ? `${NL}   来源页：${r.page}` : "";
                return `${i + 1}. ${r.title || "（无标题）"}${size}${page}` +
                    `${NL}   原图：${r.url}${NL}   缩略图：${r.thumbnail}`;
            });
            return text(
                `共 ${Math.min(results.length, maxResults)} 张图（源：${source}）。` +
                `原图直链可直接落画布（canvas_drop_image 的 url 参数）或交给用户点开：` +
                NL + lines.join(NL)
            );
        },
    });
}
