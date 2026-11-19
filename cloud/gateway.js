/**
 * ==========================================================================
 * LumenLight 云端网关（cloud/gateway.js）—— 公网部署门卫
 * ==========================================================================
 * 作用：本地项目源码零改动的公网部署方案。本文件是独立反向代理，夹在
 *       公网浏览器与原始后端（server.js，原样跑在本机 8080）之间，三件事：
 *         1. 鉴权：访问码登录页 + HttpOnly cookie，HTTP 与 WebSocket 升级
 *            统一拦截（公网裸奔 = settings.json 里的厂商 key 迟早被人拿走）
 *         2. 出站改写：前端 js 里有 9 处写死的 localhost:8080（WS 连接/
 *            工作流列表/槽位缩略图/放大等），发给浏览器前把字面量替换成
 *            「按当前访问地址动态计算」的同源地址——源文件一个字不动
 *         3. 反向代理：HTTP 流式转发 + WebSocket 升级（http-proxy），
 *            转发时剥掉 accept-encoding 强制明文（改写才能安全做）
 *
 * 运行：cd cloud && npm install && node gateway.js
 *       首次启动自动生成 config.json（token 在里面，打开看一眼）；
 *       也可用环境变量 LUMEN_GATEWAY_TOKEN / LUMEN_GATEWAY_PORT 覆盖。
 *
 * 端口约定：原始后端 8080 只许 loopback 访问（公网防火墙/安全组不开
 *       8080！）；本网关对外 8081（IP 直连门），Caddy 443 反代到本网关
 *       （域名 HTTPS 门）——两扇门都被同一道 token 锁住。
 *
 * 自检：启动 1.5s 后拉一次内层的 LumenSocket.js 验证改写映射仍有效——
 *       主项目升级后若字面量变了，映射会扑空（扑空是安全的：不改写，
 *       但写死地址会断），自检会在日志里给出 ⚠️ 提示。
 * ==========================================================================
 */

'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createProxyServer } = require('http-proxy');

// ==================== 配置 ====================

const CFG_PATH = path.join(__dirname, 'config.json');

/** 读取/自动生成 config.json：token 缺失时生成 32 位随机 hex */
function loadConfig() {
    let cfg = {};
    if (fs.existsSync(CFG_PATH)) {
        cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf-8'));
    }
    if (!cfg.token) {
        cfg.token = crypto.randomBytes(16).toString('hex');
        fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
        console.log(`🔑 已生成访问码 → ${CFG_PATH}（打开文件查看，浏览器登录页输入它）`);
    }
    return cfg;
}

const cfg = loadConfig();
const PORT = Number(process.env.LUMEN_GATEWAY_PORT) || cfg.port || 8081;
const TARGET = cfg.target || 'http://127.0.0.1:8080';
const TOKEN = process.env.LUMEN_GATEWAY_TOKEN || cfg.token;
if (!TOKEN) {
    console.error('❌ 未配置访问码（config.json 的 token 或环境变量 LUMEN_GATEWAY_TOKEN）');
    process.exit(1);
}

const inner = new URL(TARGET);
const COOKIE = 'lumen_gate';
const COOKIE_HASH = sha256(TOKEN);          // cookie 存 token 的哈希（不落明文）
const COOKIE_MAX_AGE = 30 * 86400;          // 30 天免登录

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

// ==================== 鉴权 ====================

/** 解析 Cookie 头 → Map */
function parseCookies(header) {
    const map = new Map();
    for (const part of String(header || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
    return map;
}

/** 请求是否已登录（cookie 哈希与期望哈希恒时比较） */
function isAuthed(req) {
    const got = parseCookies(req.headers.cookie).get(COOKIE) || '';
    const a = Buffer.from(got);
    const b = Buffer.from(COOKIE_HASH);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 登录失败限速：同 IP 10 分钟内失败 ≥8 次锁 10 分钟（防公网爆破） */
const fails = new Map();   // ip → { count, firstAt }
function loginBlocked(ip) {
    const rec = fails.get(ip);
    if (!rec) return 0;
    const age = Date.now() - rec.firstAt;
    if (age > 10 * 60 * 1000) { fails.delete(ip); return 0; }
    return rec.count >= 8 ? Math.ceil((10 * 60 * 1000 - age) / 1000) : 0;
}
function recordFail(ip) {
    const rec = fails.get(ip);
    if (!rec || Date.now() - rec.firstAt > 10 * 60 * 1000) {
        fails.set(ip, { count: 1, firstAt: Date.now() });
    } else {
        rec.count += 1;
    }
}

/** 登录页（内联，无外部资源——未登录时静态资源也拿不到） */
const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LumenLight 云端 · 登录</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0f0f12; color:#fff; font-family:system-ui,-apple-system,'Segoe UI',sans-serif; }
  .card { width:min(360px, 92vw); padding:32px 28px; border-radius:12px;
          border:1px solid rgba(128,128,128,.3); background:#1b1c21; }
  h1 { font-size:18px; margin:0 0 6px; font-weight:600; }
  p  { font-size:12px; color:rgba(255,255,255,.5); margin:0 0 20px; }
  input { width:100%; box-sizing:border-box; height:38px; padding:0 12px; border-radius:6px;
          border:1px solid rgba(128,128,128,.3); background:rgba(0,0,0,.2); color:#fff;
          font-size:13px; outline:none; }
  input:focus { border-color:#3b82f6; }
  button { width:100%; height:38px; margin-top:12px; border:none; border-radius:6px;
           background:#3b82f6; color:#fff; font-size:13px; cursor:pointer; }
  button:hover { background:#2f6fe0; }
  .err { color:#ff6b6b; font-size:12px; margin-top:10px; min-height:16px; }
</style></head><body>
<div class="card">
  <h1>LumenLight 云端</h1>
  <p>请输入访问码（服务器 cloud/config.json 中的 token）</p>
  <form method="POST" action="/__auth/login">
    <input type="password" name="token" placeholder="访问码" autofocus autocomplete="current-password">
    <button type="submit">进入</button>
    <div class="err">%%ERROR%%</div>
  </form>
</div></body></html>`;

/** auth 路由：/__auth 登录页、/__auth/login 提交、/__auth/logout 登出 */
function handleAuth(req, res) {
    const u = new URL(req.url, 'http://x');
    const ip = req.socket.remoteAddress || '?';

    if (u.pathname === '/__auth/login' && req.method === 'POST') {
        const blocked = loginBlocked(ip);
        if (blocked > 0) {
            res.writeHead(429, { 'content-type': 'text/html; charset=utf-8' });
            res.end(loginPage(`尝试过于频繁，请 ${blocked} 秒后再试`));
            return;
        }
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
        req.on('end', () => {
            const given = String(new URLSearchParams(body).get('token') || '');
            const ok = timingSafeEqStr(given, TOKEN);
            if (!ok) {
                recordFail(ip);
                res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
                res.end(loginPage('访问码不正确'));
                return;
            }
            fails.delete(ip);
            // https 门（Caddy 带 X-Forwarded-Proto）加 Secure；http IP 门不加
            const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
            res.setHeader('set-cookie',
                `${COOKIE}=${COOKIE_HASH}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${secure}`);
            // 回跳目标只接受站内路径（防开放重定向）
            const from = u.searchParams.get('from') || '/';
            const to = from.startsWith('/') && !from.startsWith('//') ? from : '/';
            res.writeHead(302, { location: to });
            res.end();
        });
        return;
    }

    if (u.pathname === '/__auth/logout') {
        res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
        res.writeHead(302, { location: '/__auth' });
        res.end();
        return;
    }

    // GET /__auth：登录页（已登录则直接进画布）
    if (isAuthed(req)) {
        res.writeHead(302, { location: '/' });
        res.end();
        return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(loginPage(''));
}

function timingSafeEqStr(a, b) {
    const ha = Buffer.from(sha256(a), 'hex');
    const hb = Buffer.from(sha256(b), 'hex');
    return crypto.timingSafeEqual(ha, hb);
}

function loginPage(errText) {
    return LOGIN_PAGE.replace('%%ERROR%%', errText || '');
}

/** 未登录响应：浏览器导航 → 302 登录页；API/XHR/WS 之类 → 401 JSON */
function unauth(req, res) {
    const accept = String(req.headers.accept || '');
    if (/text\/html/.test(accept) || req.headers['sec-fetch-mode'] === 'navigate') {
        const from = encodeURIComponent(req.url || '/');
        res.writeHead(302, { location: `/__auth?from=${from}` });
        res.end();
    } else {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '未登录' }));
    }
}

// ==================== 出站改写 ====================

// 9 处写死地址的字面量映射（精确原文，见 grep "localhost:8080" js/）：
//   js/api/LumenSocket.js:45            'ws://localhost:8080'
//   js/components/PromptPanel.js:446    'http://localhost:8080/api/comfy-status'
//   js/components/PanelThumbnailManager.js:396/430/437  `http://localhost:8080/api/canvas-*/${slot}`
//   js/components/UpscaleManager.js:212/227             `http://localhost:8080/${imageData}` 等
//   js/components/WorkflowManager.js:101/155            'http://localhost:8080/api/workflows...'
// 替换顺序敏感：先长后短。启动自检见文件尾 selfCheck()
const WS_DYNAMIC = `(location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host`;
const REWRITES = [
    [`'ws://localhost:8080'`, WS_DYNAMIC],
    [`"ws://localhost:8080"`, WS_DYNAMIC],
    [`http://localhost:8080/`, `/`],
    [`http://localhost:8080`, ``],
    [`http://127.0.0.1:8080/`, `/`],
    [`http://127.0.0.1:8080`, ``]
];

/** JS 源码出站改写（split/join 避免正则转义问题） */
function rewriteJs(buf) {
    let s = buf.toString('utf8');
    for (const [from, to] of REWRITES) s = s.split(from).join(to);
    return Buffer.from(s, 'utf8');
}

// ==================== 反向代理 ====================

/** HTTP 代理：JS 响应缓冲改写，其余流式直通。
    剥 accept-encoding 强制明文——压缩响应没法做字符串改写。 */
function proxyHttp(req, res) {
    const headers = { ...req.headers, host: `${inner.hostname}:${inner.port}` };
    delete headers['accept-encoding'];
    headers['x-forwarded-for'] = req.socket.remoteAddress || '';
    headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || 'http';

    const up = http.request({
        hostname: inner.hostname,
        port: inner.port,
        path: req.url,
        method: req.method,
        headers
    }, (ures) => {
        const ct = String(ures.headers['content-type'] || '');
        if (/javascript|ecmascript/i.test(ct)) {
            const chunks = [];
            ures.on('data', (c) => chunks.push(c));
            ures.on('end', () => {
                const body = rewriteJs(Buffer.concat(chunks));
                const out = { ...ures.headers, 'content-length': body.length };
                delete out['content-encoding'];      // 明文响应本无此头，防御性删除
                res.writeHead(ures.statusCode, out);
                res.end(body);
            });
        } else {
            res.writeHead(ures.statusCode, ures.headers);
            ures.pipe(res);
        }
    });
    req.pipe(up);
    up.on('error', () => {
        if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
            res.end('<meta charset="utf-8"><body style="background:#0f0f12;color:#fff;font-family:sans-serif;text-align:center;padding-top:20vh">后端未启动：先在服务器上运行原始后端（server.js / start-server.bat），再刷新本页。</body>');
        } else {
            res.end();
        }
    });
}

// WS 升级代理（http-proxy 只干这一件事：成熟处理 101 握手与双向管道）
const wsProxy = createProxyServer({ target: { hostname: inner.hostname, port: inner.port }, ws: true });

const server = http.createServer((req, res) => {
    if (req.url.startsWith('/__auth')) return handleAuth(req, res);
    if (!isAuthed(req)) return unauth(req, res);
    proxyHttp(req, res);
});

server.on('upgrade', (req, socket, head) => {
    // cookie 随同源 WS 握手自动携带，升级前先验
    if (!isAuthed(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
        socket.destroy();
        return;
    }
    wsProxy.ws(req, socket, head);
});

server.listen(PORT, () => {
    console.log('==============================================');
    console.log(`🛡  LumenLight 云端网关已启动`);
    console.log(`   对外:  http://0.0.0.0:${PORT}   （域名门由 Caddy 443 反代到此）`);
    console.log(`   内层:  ${TARGET} （原始后端，公网防火墙勿开 8080）`);
    console.log(`   访问码: ${CFG_PATH}`);
    console.log('==============================================');
    setTimeout(selfCheck, 1500);
});

/** 启动自检：拉内层 LumenSocket.js 验证改写映射仍有效（主项目升级后防扑空） */
function selfCheck() {
    http.get(`${TARGET}/js/api/LumenSocket.js`, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => {
            const out = rewriteJs(Buffer.from(b)).toString('utf8');
            const stale = out.includes('ws://localhost:8080') || out.includes('http://localhost:8080');
            if (stale) {
                console.log('⚠️  自检：改写后仍残留写死地址——主项目可能升级了这 9 处，请更新 gateway.js 的 REWRITES 映射');
            } else if (!out.includes('location.host')) {
                console.log('⚠️  自检：未找到预期字面量（LumenSocket.js 内容变了？）——请核对 REWRITES 映射');
            } else {
                console.log('✅ 自检通过：出站地址改写映射有效');
            }
        });
    }).on('error', () => {
        console.log('⚠️  自检跳过：内层后端（8080）未启动——网关会在后端启动后正常工作');
    });
}
