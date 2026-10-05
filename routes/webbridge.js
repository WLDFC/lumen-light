/**
 * ==========================================================================
 * LumenLight 网页桥接路由
 * ==========================================================================
 * 作用：网页桥接模式（LLM 面板模型下拉的「网页桥接」项）的后端接口。
 * 本路由是网页桥接的装配层：拥有 WebBridgeManager 实例，并把管理器的
 * 领域事件映射为 WS 消息——
 *   领域事件（manager.emit）            → WS 消息（广播给画布客户端）
 *   status/stream_text/task_progress/
 *   message_end/error                   → { type: 'webbridge-event', event }
 *   asset_image {dataUrl, prompt}       → { type: 'new-image', image: 裸base64 }
 *   asset_video {videoPath, prompt}     → { type: 'new-video', videoUrl }
 * 产物回流与 Comfy/RunningHub 同构（带 source: 'webbridge' 可区分），
 * 前端落图落视频链路零改动。
 *
 * 接口清单：
 *   GET  /api/webbridge/overview  状态 + 站点清单（设置界面/面板数据源）
 *   POST /api/webbridge/config    保存配置（settings.json webbridge 区块）
 *   POST /api/webbridge/start     拉起浏览器并打开当前站点对话页
 *   POST /api/webbridge/stop      关闭浏览器
 *   POST /api/webbridge/message   { text, images } 发送消息（立即应答）
 *   POST /api/webbridge/abort     中止当前回合的捕获
 *   POST /api/webbridge/diagnose  页面结构诊断（只读，校准适配器用）
 *
 * 与既有 API 生图链路完全隔离：本路由不引用 /api/llm 相关模块。
 * 路由对象上挂 manager 引用（router.manager），server.js 退出钩子用。
 * ==========================================================================
 */

const express = require('express');
const WebBridgeManager = require('../utils/webBridgeManager');

/**
 * 创建网页桥接路由
 * @param {Object} options - 依赖项
 * @param {Map} options.clients - server.js 的 WS 客户端表（事件广播用）
 * @param {string} options.dataDir - 数据目录（settings.json 所在）
 * @returns {express.Router} router.manager - WebBridgeManager 实例
 */
function createWebBridgeRouter({ clients, dataDir }) {
    const router = express.Router();

    /** 广播数据给所有画板（canvas）客户端 */
    const broadcastToCanvas = (data) => {
        clients.forEach((client) => {
            if (client.role === 'canvas' && client.ws.readyState === 1) {   // WebSocket.OPEN
                client.ws.send(JSON.stringify(data));
            }
        });
    };

    const manager = new WebBridgeManager({
        dataDir,
        emit: (event) => {
            // 面板事件（流式文本/任务进度/回合收尾/状态/错误）：前端
            // LumenSocket 转成 webbridgeEvent 页面事件供 LlmWebBridge 消费
            if (['status', 'stream_text', 'task_progress', 'message_end', 'error'].includes(event.type)) {
                broadcastToCanvas({ type: 'webbridge-event', event });
                return;
            }
            // 产物落画布：与 RunningHub 的 push 回调同构（裸 base64 / 相对路径）
            if (event.type === 'asset_image') {
                broadcastToCanvas({
                    type: 'new-image',
                    image: String(event.dataUrl).split(',')[1] || '',
                    prompt: event.prompt,
                    source: 'webbridge',
                    timestamp: Date.now()
                });
            } else if (event.type === 'asset_video') {
                broadcastToCanvas({
                    type: 'new-video',
                    videoUrl: event.videoPath,
                    prompt: event.prompt,
                    source: 'webbridge',
                    timestamp: Date.now()
                });
            }
        }
    });

    /** 状态 + 站点清单 */
    router.get('/overview', async (req, res) => {
        try {
            res.json({ status: 'ok', ...(await manager.getStatus()) });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    /** 保存配置（browserPath / activeSite / headless） */
    router.post('/config', async (req, res) => {
        try {
            const cfg = await manager.saveConfig(req.body || {});
            res.json({ status: 'ok', config: cfg });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    /** 拉起浏览器并打开当前站点 */
    router.post('/start', async (req, res) => {
        try {
            const adapter = manager.getAdapter();
            if (!adapter) throw new Error(`站点 ${manager.activeSite} 未登记`);
            await manager.ensureStarted();
            await manager.ensurePage(adapter);
            res.json({ status: 'ok' });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    /** 关闭浏览器 */
    router.post('/stop', async (req, res) => {
        try {
            await manager.stop();
            res.json({ status: 'ok' });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    /** 发送消息（立即应答；回复流与产物经 WS 事件推送） */
    router.post('/message', async (req, res) => {
        try {
            const body = req.body || {};
            await manager.send({ text: String(body.text || ''), images: Array.isArray(body.images) ? body.images : [] });
            res.json({ status: 'ok', accepted: true });
        } catch (err) {
            res.status(err.status || 500).json({ status: 'error', message: err.message });
        }
    });

    /** 中止当前回合捕获 */
    router.post('/abort', async (req, res) => {
        try {
            await manager.abort();
            res.json({ status: 'ok' });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    /**
     * 补交付当前页面最新内容（看护被顶掉/交付异常等场景的手动补救，
     * 走正常交付链路；最新回复已交付过时报错）
     */
    router.post('/redeliver', async (req, res) => {
        try {
            res.json({ status: 'ok', ...(await manager.redeliverCurrent()) });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    /** 手动导航桥接标签页到指定 URL（并记忆为该站点的最近对话页） */
    router.post('/open', async (req, res) => {
        try {
            res.json({ status: 'ok', ...(await manager.openUrl(String((req.body || {}).url || ''))) });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    /**
     * 页面结构诊断（只读，校准适配器用）：返回站点页面里全部文件输入
     * （accept/multiple/HTML 片段）、疑似上传/图片按钮清单、输入框结构、
     * 最新回复文本，外加一份通用消息结构探针（各站点候选选择器的命中
     * 计数 + 末块 HTML/文本片段 + main 子元素普查）。附件注入/回复捕获
     * 失效时据此修适配器候选清单，不再盲猜
     */
    router.post('/diagnose', async (req, res) => {
        try {
            const adapter = manager.getAdapter();
            if (!adapter) throw new Error(`站点 ${manager.activeSite} 未登记`);
            await manager.ensureStarted();
            const page = await manager.ensurePage(adapter);
            const report = await page.evaluate(() => {
                const inputs = Array.from(document.querySelectorAll('input[type="file"]')).map((el) => ({
                    accept: el.accept || '',
                    multiple: el.multiple,
                    id: el.id || '',
                    name: el.name || '',
                    cls: String(el.className || '').slice(0, 120),
                    html: el.outerHTML.slice(0, 200)
                }));
                const buttons = Array.from(document.querySelectorAll('button, [role="button"], span, div'))
                    .filter((el) => {
                        const s = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-testid') || ''} ${String(el.className || '')} ${(el.innerText || '').trim()}`;
                        return /图片|上传|附件|照片/.test(s) && s.length < 80;
                    })
                    .slice(0, 20)
                    .map((el) => ({
                        tag: el.tagName,
                        cls: String(el.className || '').slice(0, 120),
                        text: (el.innerText || '').trim().slice(0, 30),
                        aria: el.getAttribute('aria-label') || '',
                        testid: el.getAttribute('data-testid') || ''
                    }));
                const editor = document.querySelector('textarea[data-testid="chat_input_input"], [data-testid="chat_input_input"], [contenteditable="true"]');
                // 最新回复块文本（验证消息/附件是否真到达站点）
                const replyBlocks = document.querySelectorAll('[data-testid="receive_message"], [data-testid="receive_group"], [data-testid="message_item_receive"]');
                const lastReply = replyBlocks.length
                    ? (replyBlocks[replyBlocks.length - 1].innerText || '').trim().slice(0, 400)
                    : '';
                // 通用消息结构探针：各站点候选选择器逐一命中统计——count 全为
                // 0 说明站点 DOM 改版/未登录，末块片段用来挑新的候选选择器
                const probeSelectors = [
                    '[data-message-author-role="assistant"]',
                    '[data-message-author-role="user"]',
                    'article[data-testid^="conversation-turn"]',
                    '[data-testid^="conversation-turn"]',
                    '#prompt-textarea',
                    'div[contenteditable="true"].ProseMirror',
                    '[data-testid="send-button"]',
                    '#composer-submit-button',
                    '[data-testid="stop-button"]',
                    'main article',
                    '[data-testid="receive_message"]'
                ];
                const probe = probeSelectors.map((sel) => {
                    let count = 0;
                    let lastHtml = '';
                    let lastText = '';
                    try {
                        const nodes = document.querySelectorAll(sel);
                        count = nodes.length;
                        if (count) {
                            const last = nodes[count - 1];
                            lastHtml = last.outerHTML.slice(0, 400);
                            lastText = (last.innerText || '').trim().slice(0, 300);
                        }
                    } catch (e) { lastHtml = `选择器非法: ${e.message}`; }
                    return { sel, count, lastHtml, lastText };
                });
                // main 子元素普查：回复块候选全落空时看页面主干长啥样
                const mainChildren = Array.from((document.querySelector('main') || document.body).children)
                    .slice(0, 30)
                    .map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className || '').slice(0, 60)}`);
                return {
                    inputs,
                    buttons,
                    editorTag: editor ? editor.tagName : null,
                    editorHtml: editor ? editor.outerHTML.slice(0, 600) : null,
                    lastReply,
                    probe,
                    mainChildren
                };
            });
            // 子树解剖（可选，body 传 {"dive":"css 选择器", "depth":8, "text":true})：
            // 把目标容器内部按缩进树打印（标签/id/testid/角色属性/类名/文本摘要），
            // text:true 额外返回目标容器整段 innerText（前 1500 字）——深挖
            // 回复块内部结构、确认线程区渲染状态都用它
            const diveSel = String((req.body || {}).dive || '').trim().slice(0, 200);
            if (diveSel) {
                const maxDepth = Math.min(Number((req.body || {}).depth) || 5, 14);
                const wantText = !!(req.body || {}).text;
                report.dive = await page.evaluate((sel, depthCap, wantText) => {
                    const root = document.querySelector(sel);
                    if (!root) return { sel, found: false };
                    const lines = [];
                    const KEY_ATTRS = ['data-testid', 'data-message-id', 'data-message-author-role', 'data-turn-id', 'data-content-type'];
                    const walk = (el, depth, prefix) => {
                        if (lines.length >= 150 || depth > depthCap) return;
                        const attrs = KEY_ATTRS
                            .map((a) => el.getAttribute(a) ? `[${a.slice(5)}=${el.getAttribute(a).slice(0, 40)}]` : '')
                            .join('');
                        const cls = String(el.className || '').trim().slice(0, 70);
                        const text = (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3)
                            ? ` «${(el.textContent || '').trim().slice(0, 40)}»` : '';
                        lines.push(`${prefix}${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${attrs}${cls ? '.' + cls : ''}${text}`);
                        Array.from(el.children).forEach((kid) => walk(kid, depth + 1, prefix + '  '));
                    };
                    walk(root, 0, '');
                    const out = { sel, found: true, tree: lines };
                    if (wantText) out.text = (root.innerText || '').trim().slice(0, 1500);
                    return out;
                }, diveSel, maxDepth, wantText).catch((err) => ({ sel: diveSel, error: err.message }));
            }

            // 穿透诊断（ChatGPT 新版外壳踩坑：对话内容疑似渲染在 iframe 或
            // Shadow DOM 里，主文档 querySelector/innerText 全部落空）：
            //   frames  —— 本页全部子框架的 URL（内容在 iframe 的话一目了然）
            //   shadow  —— 全文档 Shadow DOM 宿主普查（标签/类名/宿主数）
            //   locate  —— 给定文本（body {"locate":"你说："}），返回包含它的
            //               最深元素的祖先路径（沿路选择器可挑作候选）
            report.frames = page.frames().map((f) => f.url()).slice(0, 10);
            // 按钮普查（可选，body {"btnScan": true}）：全文档按钮的完整
            // 属性清单（data-*/aria-label/title/tooltip/文本/可见性）——
            // 图标按钮无文本无 aria 时（Gemini 下载按钮踩坑）靠它定位
            if ((req.body || {}).btnScan) {
                report.btnScan = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('button, a[download], [role="button"]'))
                        .filter((el) => el.offsetParent !== null)
                        .slice(0, 80)
                        .map((el) => {
                            const attrs = {};
                            for (const a of el.attributes) {
                                if (/^(data-|aria-|title$|mattooltip)/i.test(a.name) && a.value) {
                                    attrs[a.name] = a.value.slice(0, 60);
                                }
                            }
                            const icon = el.querySelector('mat-icon, gem-icon, .material-symbols-outlined, .material-icons');
                            return {
                                tag: el.tagName.toLowerCase(),
                                attrs,
                                text: (el.textContent || '').trim().slice(0, 30),
                                icon: icon ? (icon.textContent || '').trim().slice(0, 30) : ''
                            };
                        });
                }).catch((err) => ({ error: err.message }));
            }
            const locateText = String((req.body || {}).locate || '').trim().slice(0, 80);
            report.shadow = await page.evaluate(() => {
                const hosts = [];
                const all = document.querySelectorAll('*');
                for (const el of all) {
                    if (el.shadowRoot && hosts.length < 12) {
                        hosts.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className || '').slice(0, 50)}`);
                    }
                }
                return { hostCount: hosts.length, hosts };
            }).catch((err) => ({ error: err.message }));
            if (locateText) {
                report.locate = await page.evaluate((needle) => {
                    const all = Array.from(document.querySelectorAll('body *'));
                    const hits = all.filter((el) =>
                        el.children.length === 0 && (el.textContent || '').includes(needle))
                        .slice(0, 3);
                    if (!hits.length) return { needle, found: false };
                    const pathOf = (el) => {
                        const chain = [];
                        let cur = el;
                        while (cur && cur !== document.body && chain.length < 12) {
                            const cls = String(cur.className || '').trim().split(/\s+/).slice(0, 3).join('.');
                            chain.unshift(`${cur.tagName.toLowerCase()}${cur.id ? '#' + cur.id : ''}${cls ? '.' + cls : ''}${cur.getAttribute('data-testid') ? `[testid=${cur.getAttribute('data-testid')}]` : ''}${cur.getAttribute('data-message-author-role') ? `[role=${cur.getAttribute('data-message-author-role')}]` : ''}`);
                            cur = cur.parentElement;
                        }
                        return chain.join('  >  ');
                    };
                    return { needle, found: true, paths: hits.map(pathOf) };
                }, locateText).catch((err) => ({ error: err.message }));
            }
            res.json({ status: 'ok', pageUrl: page.url(), report });
        } catch (err) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    });

    router.manager = manager;   // server.js 退出钩子（closeAll）用
    return router;
}

module.exports = createWebBridgeRouter;
