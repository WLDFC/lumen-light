/**
 * lumen-web.ts 扩展的冒烟测试
 * 与 lumenSkills.smoke.mjs 同一套机制：Node 原生 type-stripping 加载 .ts，
 * mock ExtensionAPI 捕获注册的工具并直调 execute；typebox 以最小 stub 替换。
 *
 * 本扩展的差异点：工具会发起真实网络请求——测试用 mock fetch 注入
 * 预录的搜索引擎 HTML / 网页 HTML（固件取自真实端点的典型结构），
 * 验证解析与分流逻辑，不依赖外网（CI/离线可跑）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const src = fs.readFileSync('pi-extensions/lumen-web.ts', 'utf8');
const js = stripTypeScriptTypes(
    src.replace(/from "typebox"/g, 'from "./typebox-stub.mjs"'),
    { mode: 'strip' }
);
const stub = `export const Type = new Proxy({}, { get: () => (..._a) => ({ __type: true }) });`;
const stubUrl = 'data:text/javascript;base64,' + Buffer.from(stub).toString('base64');
const jsPatched = js.replace('from "./typebox-stub.mjs"', `from "${stubUrl}"`);
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(jsPatched, 'utf8').toString('base64');
const mod = await import(dataUrl);
const { default: factory, htmlToText, parseDdgLite, parseBing,
    parseBingImages, parseDdgImages, parseBaiduImages } = mod;

// ---- mock pi：捕获注册的工具 ----
const tools = {};
factory({ registerTool: (t) => { tools[t.name] = t; } });
assert.ok(tools.web_search && tools.web_fetch && tools.web_image_search,
    'web_search / web_fetch / web_image_search 未注册');

const txt = (r) => {
    assert.ok(r && Array.isArray(r.content) && r.content[0]?.type === 'text',
        '工具返回必须含 content[0].text 包装');
    return r.content[0].text;
};

/** 构造 mock Response（扩展用到 ok/status/statusText/headers/text/arrayBuffer） */
function mockResponse(body, { status = 200, contentType = 'text/html; charset=utf-8' } = {}) {
    const buffer = Buffer.from(body, 'utf8');
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
        text: async () => body,
        arrayBuffer: async () => buffer.buffer.slice(
            buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    };
}

// ==================== 解析器单元（固件模拟真实端点结构） ====================

// ---- DDG lite 解析：结果链接 + 摘要按顺序配对；uddg 跳转解包；非 http 跳过 ----
{
    const ddgHtml = `<html><body><table>
        <tr><td>1.&nbsp;</td><td><a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=abc">Example A 标题</a></td></tr>
        <tr><td class="result-snippet">Example A 的<b>摘要</b>内容</td></tr>
        <tr><td>2.&nbsp;</td><td><a rel="nofollow" class="result-link" href="https://example.com/b">Example B</a></td></tr>
        <tr><td class="result-snippet">Example B 摘要</td></tr>
        <tr><td>3.&nbsp;</td><td><a rel="nofollow" class="result-link" href="/internal?x=1">内部相对链接应被跳过</a></td></tr>
    </table></body></html>`;
    const parsed = parseDdgLite(ddgHtml);
    assert.equal(parsed.length, 2, 'DDG：非 http 链接应跳过');
    assert.equal(parsed[0].url, 'https://example.com/a', 'DDG：uddg 跳转应解包为真实 URL');
    assert.equal(parsed[0].title, 'Example A 标题', 'DDG：标题应解码');
    assert.equal(parsed[0].snippet, 'Example A 的摘要内容', 'DDG：摘要应剥标签解码');
}

// ---- Bing 解析：li.b_algo 块取 h2>a 与第一个 <p> ----
{
    const bingHtml = `<html><body><ol id="b_results">
        <li class="b_algo"><h2><a href="https://example.com/x">X 的标题</a></h2>
            <div class="b_caption"><p>X 摘要文字</p></div></li>
        <li class="b_algo"><h2><a href="https://example.com/y">Y 的标题</a></h2>
            <p>Y 摘要</p></li>
    </ol></body></html>`;
    const parsed = parseBing(bingHtml);
    assert.equal(parsed.length, 2, 'Bing：应解析出全部 b_algo 块');
    assert.deepEqual(
        [parsed[0].url, parsed[0].title, parsed[0].snippet],
        ['https://example.com/x', 'X 的标题', 'X 摘要文字'],
        'Bing：标题/链接/摘要字段应对应');
}

// ---- htmlToText：script/style 剥除、块级转换行、实体解码、空行压缩 ----
{
    const out = htmlToText(`<!DOCTYPE html><html><head><style>p{color:red}</style>
        <script>var x = "<li>伪标签</li>";</script></head>
        <body><!-- 注释 <b>不应出现</b> -->
        <h1>标题一</h1><p>第一段 &amp; 实体&nbsp;测试</p>
        <ul><li>条目甲</li><li>条目乙</li></ul>
        <div>尾行<br>换行内容</div></body></html>`);
    assert.ok(!out.includes('color:red'), 'style 块应剥除');
    assert.ok(!out.includes('伪标签'), 'script 块应整块剥除（其中伪标签不得泄漏）');
    assert.ok(!out.includes('不应出现'), 'HTML 注释应剥除');
    assert.ok(out.includes('## 标题一'), 'h1 应转为 ## 标记');
    assert.ok(out.includes('第一段 & 实体 测试'), '实体应解码、&nbsp; 应转空格');
    assert.ok(out.includes('• 条目甲'), 'li 应转列表标记');
    assert.ok(!/<[a-z]+/i.test(out), '不应残留任何 HTML 标签');
    assert.ok(!/\n{3,}/.test(out), '连续空行应压缩');
}

// ==================== web_search：主源成功 / 主源失败切备源 / 双源失败 ----

const origFetch = globalThis.fetch;

// ---- 主源 DDG 成功：不触发备源 ----
{
    let requested = [];
    globalThis.fetch = async (url) => {
        requested.push(String(url));
        if (String(url).includes('lite.duckduckgo.com')) {
            return mockResponse('<a class="result-link" href="https://example.com/r1">R1</a>' +
                '<td class="result-snippet">S1</td>');
        }
        throw new Error('不应请求备源');
    };
    const r = txt(await tools.web_search.execute('t1', { query: '测试' }));
    assert.ok(r.includes('R1') && r.includes('example.com/r1'), 'DDG 结果应返回');
    assert.ok(r.includes('源：duckduckgo'), '应标注主源');
    assert.equal(requested.length, 1, '主源成功不应请求备源');
}

// ---- 主源零结果（被拦截）→ 自动切 Bing 备源成功 ----
{
    globalThis.fetch = async (url) => {
        if (String(url).includes('lite.duckduckgo.com')) return mockResponse('<html>异常页</html>');
        if (String(url).includes('cn.bing.com')) {
            return mockResponse('<li class="b_algo"><h2><a href="https://example.com/b1">B1</a></h2><p>b 摘要</p></li>');
        }
        throw new Error('unexpected ' + url);
    };
    const r = txt(await tools.web_search.execute('t2', { query: '测试' }));
    assert.ok(r.includes('B1') && r.includes('源：bing'), '备源结果应返回并标注 bing');
}

// ---- 双源都失败 → 报错并附两源原因 ----
{
    globalThis.fetch = async () => { throw new Error('net down'); };
    await assert.rejects(
        () => tools.web_search.execute('t3', { query: '测试' }),
        /两个搜索源都不可用.*net down.*net down/s,
        '双源失败应汇总原因');
}

// ---- 空关键词拒绝 ----
await assert.rejects(() => tools.web_search.execute('t4', { query: '  ' }), /不能为空/);

// ==================== web_fetch：HTML 提取 / json 直返 / 二进制拒读 / 分段 ----

// ---- HTML 页面：正文提取 + 头部元信息 ----
{
    globalThis.fetch = async () => mockResponse(
        '<html><head><title>t</title></head><body><p>正文第一段</p><p>正文第二段</p></body></html>',
        { contentType: 'text/html; charset=utf-8' });
    const r = txt(await tools.web_fetch.execute('t5', { url: 'https://example.com/page' }));
    assert.ok(r.includes('【web_fetch】https://example.com/page'), '应含 URL 头');
    assert.ok(r.includes('正文第一段') && r.includes('正文第二段'), '应含提取的正文');
    assert.ok(!r.includes('<p>'), '正文不应残留标签');
}

// ---- JSON 原样返回（非 HTML 不走正文提取）----
{
    const json = JSON.stringify({ ok: 1, msg: 'hello' });
    globalThis.fetch = async () => mockResponse(json, { contentType: 'application/json' });
    const r = txt(await tools.web_fetch.execute('t6', { url: 'https://example.com/api' }));
    assert.ok(r.includes('"ok":1'), 'JSON 应原样返回');
}

// ---- 二进制内容拒读 ----
{
    globalThis.fetch = async () => mockResponse('binary', { contentType: 'image/png' });
    await assert.rejects(
        () => tools.web_fetch.execute('t7', { url: 'https://example.com/a.png' }),
        /二进制内容/,
        '图片应拒读');
}

// ---- HTTP 错误状态抛错 ----
{
    globalThis.fetch = async () => mockResponse('gone', { status: 404 });
    await assert.rejects(
        () => tools.web_fetch.execute('t8', { url: 'https://example.com/404' }),
        /HTTP 404/,
        '404 应抛错');
}

// ---- 内网地址拒绝（SSRF 惯例）----
{
    globalThis.fetch = async () => { throw new Error('不应发起请求'); };
    for (const url of ['http://localhost:8080/api', 'http://127.0.0.1/x',
        'http://192.168.1.5/router', 'http://10.0.0.2/internal']) {
        await assert.rejects(() => tools.web_fetch.execute('t9', { url }),
            /内网/, `内网地址 ${url} 应被拒绝`);
    }
}

// ---- 超长正文截断 + startOffset 续读（maxChars 钳制下限 500，用 700 验证显式值生效）----
{
    const longBody = Array.from({ length: 2000 }, (_, i) => `<p>行${i}</p>`).join('');
    globalThis.fetch = async () => mockResponse(`<html><body>${longBody}</body></html>`);
    const r1 = txt(await tools.web_fetch.execute('t10', { url: 'https://example.com/long', maxChars: 700 }));
    assert.ok(r1.includes('未完') && r1.includes('startOffset=700'), '超长应提示续读偏移');
    const r2 = txt(await tools.web_fetch.execute('t11', {
        url: 'https://example.com/long', maxChars: 700, startOffset: 700
    }));
    const shown = r1.match(/（显示 (\d+)–(\d+)）/);
    assert.deepEqual([+shown[1], +shown[2]], [0, 700], '显示区间应与参数一致');
    assert.ok(r2.includes('（显示 700–'), '续读应从偏移处开始');
}

// ---- 非法 URL / 非法协议拒绝 ----
await assert.rejects(() => tools.web_fetch.execute('t12', { url: 'not-a-url' }), /非法的 URL/);
await assert.rejects(() => tools.web_fetch.execute('t13', { url: 'ftp://example.com/f' }), /仅支持 http/);

// ==================== web_image_search：Bing 主源 / DDG 备源 / 双源失败 ----

// ---- Bing 图片解析：m 属性转义 JSON → murl/turl/t/purl/尺寸 ----
{
    const bingImgHtml = `<div>
        <a class="iusc" m="{&quot;murl&quot;:&quot;https://example.com/img/a.jpg&quot;,&quot;turl&quot;:&quot;https://tse.mm.bing.net/th?id=A&quot;,&quot;t&quot;:&quot;A 的标题&quot;,&quot;purl&quot;:&quot;https://example.com/page-a&quot;,&quot;mw&quot;:800,&quot;mh&quot;:600}"></a>
        <a class="iusc" m="{&quot;murl&quot;:&quot;https://example.com/img/b.png&quot;,&quot;t&quot;:&quot;B 标题&quot;}"></a>
        <a class="iusc" m="{&quot;murl&quot;:&quot;not-a-url&quot;}"></a>
    </div>`;
    const parsed = parseBingImages(bingImgHtml);
    assert.equal(parsed.length, 2, 'Bing 图片：非 http 的 murl 应跳过');
    assert.deepEqual(
        [parsed[0].url, parsed[0].thumbnail, parsed[0].title, parsed[0].page, parsed[0].width, parsed[0].height],
        ['https://example.com/img/a.jpg', 'https://tse.mm.bing.net/th?id=A', 'A 的标题',
            'https://example.com/page-a', 800, 600],
        'Bing 图片：字段应对应');
    assert.equal(parsed[1].thumbnail, parsed[1].url, 'Bing 图片：缺 turl 时缩略图回退原图');
}

// ---- DDG 图片 JSON 解析 ----
{
    const ddgJson = JSON.stringify({ results: [
        { image: 'https://example.com/i/a.jpg', thumbnail: 'https://thumb/a.jpg',
            title: 'A 图', source: 'https://example.com/src-a', width: 1024, height: 768 },
        { image: 'ftp://bad/x.jpg', title: '坏条目' }
    ]});
    const parsed = parseDdgImages(ddgJson);
    assert.equal(parsed.length, 1, 'DDG 图片：非 http 应跳过');
    assert.deepEqual(
        [parsed[0].url, parsed[0].thumbnail, parsed[0].width],
        ['https://example.com/i/a.jpg', 'https://thumb/a.jpg', 1024]);
    assert.deepEqual(parseDdgImages('not-json'), [], '坏 JSON 应返回空数组');
}

// ---- 主源 Bing 成功 ----
{
    globalThis.fetch = async (url) => {
        if (String(url).includes('cn.bing.com/images')) {
            return mockResponse('<a class="iusc" m="{&quot;murl&quot;:&quot;https://example.com/pic.jpg&quot;,&quot;t&quot;:&quot;图&quot;}"></a>');
        }
        throw new Error('不应请求其他源');
    };
    const r = txt(await tools.web_image_search.execute('t14', { query: '插画' }));
    assert.ok(r.includes('example.com/pic.jpg') && r.includes('源：bing'), 'Bing 图片结果应返回');
}

// ---- 百度解析：acjson data 数组取 middleURL/hoverURL，无链接条目（广告位）跳过 ----
{
    const baiduJson = JSON.stringify({ data: [
        { middleURL: 'https://img1.baidu.com/it/u=1,a&fm=202', thumbURL: 'https://img1.baidu.com/it/u=1,a&fm=100',
            fromPageTitleEnc: '国风插画_B', fromURL: 'https://site.example/b', width: 1024, height: 768 },
        { hoverURL: 'https://img2.baidu.com/it/u=2,c&fm=202', fromPageTitle: '无中图的条目' },
        { thumbURL: '' },   // 无任何 CDN 链接：跳过
        null
    ]});
    const parsed = parseBaiduImages(baiduJson);
    assert.equal(parsed.length, 2, '百度：无 CDN 链接的条目应跳过');
    assert.deepEqual(
        [parsed[0].url, parsed[0].thumbnail, parsed[0].title, parsed[0].page, parsed[0].width],
        ['https://img1.baidu.com/it/u=1,a&fm=202', 'https://img1.baidu.com/it/u=1,a&fm=100',
            '国风插画_B', 'https://site.example/b', 1024],
        '百度：url 应取 middleURL（稳定可取）而非加密的 objURL');
    // 带包装层的响应（非纯 JSON）也应解析
    assert.equal(parseBaiduImages(`({"data":[${JSON.stringify({ middleURL: 'https://x.baidu.com/1.jpg' })}]})`).length, 1,
        '百度：带括号包装的响应应能解析');
}

// ---- 主源零结果 → 自动切百度（acjson 带 Referer）----
{
    let baiduHadReferer = null;
    globalThis.fetch = async (url, opts = {}) => {
        const u = String(url);
        if (u.includes('cn.bing.com/images')) return mockResponse('<html>空页</html>');
        if (u.includes('image.baidu.com/search/acjson')) {
            baiduHadReferer = opts.headers?.Referer || null;
            return mockResponse(JSON.stringify({ data: [
                { middleURL: 'https://img1.baidu.com/it/u=9,d&fm=202', fromPageTitleEnc: '百度图', width: 800, height: 600 }
            ]}));
        }
        throw new Error('unexpected ' + u);
    };
    const r = txt(await tools.web_image_search.execute('t15', { query: '测试' }));
    assert.ok(r.includes('img1.baidu.com') && r.includes('源：baidu'), '百度源结果应返回并标注');
    assert.equal(baiduHadReferer, 'https://image.baidu.com/', '百度请求应携带 Referer');
}

// ---- Bing + 百度都失败 → 切 DDG（vqd 两跳流程）----
{
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('cn.bing.com/images')) return mockResponse('<html>空页</html>');
        if (u.includes('image.baidu.com/search/acjson')) return mockResponse('{"data":[]}');
        if (u.includes('duckduckgo.com/?q=') && u.includes('iax=images')) {
            return mockResponse('<html>if(vqd="4-123456789012345678901")</html>');
        }
        if (u.includes('duckduckgo.com/i.js')) {
            assert.ok(u.includes('vqd=4-123456789012345678901'), 'i.js 请求应携带 vqd 令牌');
            return mockResponse(JSON.stringify({ results: [
                { image: 'https://example.com/d.jpg', title: 'D 图', width: 500, height: 500 }
            ]}), { contentType: 'application/json' });
        }
        throw new Error('unexpected ' + u);
    };
    const r = txt(await tools.web_image_search.execute('t16', { query: '测试' }));
    assert.ok(r.includes('example.com/d.jpg') && r.includes('源：ddg'), '第三源结果应返回并标注');
}

// ---- source 强制指定：只请求该源，其他源不碰 ----
{
    let requested = [];
    globalThis.fetch = async (url) => {
        requested.push(String(url));
        if (String(url).includes('image.baidu.com/search/acjson')) {
            return mockResponse(JSON.stringify({ data: [
                { middleURL: 'https://img1.baidu.com/it/u=7,e&fm=202', fromPageTitleEnc: '强制百度' }
            ]}));
        }
        throw new Error('强制 source 时不应请求其他源');
    };
    const r = txt(await tools.web_image_search.execute('t17', { query: '国风', source: 'baidu' }));
    assert.ok(r.includes('强制百度') && r.includes('源：baidu'), '强制 source 应生效');
    assert.equal(requested.filter((u) => !u.includes('image.baidu.com')).length, 0,
        '强制 source 时不应请求其他源');
}

// ---- source 非法值拒绝 ----
await assert.rejects(
    () => tools.web_image_search.execute('t18', { query: '测试', source: 'google' }),
    /未知搜索引擎/);

// ---- 三源全失败 → 报错并附全部原因 ----
{
    globalThis.fetch = async () => { throw new Error('net down'); };
    await assert.rejects(
        () => tools.web_image_search.execute('t19', { query: '测试' }),
        /所有搜索源都不可用.*net down.*net down.*net down/s,
        '三源失败应汇总全部原因');
}

// ---- 空关键词拒绝 ----
await assert.rejects(() => tools.web_image_search.execute('t20', { query: '' }), /不能为空/);

globalThis.fetch = origFetch;
console.log('lumen-web 冒烟测试全部通过 ✓');
