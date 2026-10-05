/**
 * ==========================================================================
 * LumenLight 网页桥接：ChatGPT 适配器（chatgpt）
 * ==========================================================================
 * 实现 base.js 契约，针对 chatgpt.com 网页版：
 *   - 输入框是 ProseMirror contenteditable 富文本（#prompt-textarea），
 *     文本注入走 focus + execCommand（与豆包富文本路径同款）；发送按钮
 *     aria-label 中英文随界面语言变化，候选清单里两套都收，点击失败按
 *     Enter 兜底（ChatGPT 的 Enter 即发送，真机验证可用）；
 *   - 回复块定位（2026-10-03 真机诊断校准）：ChatGPT 的回合容器是
 *     section[data-testid^="conversation-turn"]（每回合一个，无豆包式大
 *     消息列表容器）；用户消息带 data-message-author-role="user"，助手
 *     消息**不带**角色属性，正文在 .markdown 容器里。因此找块策略 =
 *     角色属性优先，落空后取"最后一个含 .markdown 正文的回合"；
 *   - 垃圾守卫：脚本/样式元素与页面引导脚本特征文本不可当回复正文
 *     （真机踩坑：容器启发式曾把 window._oai_* 引导脚本当正文交付）；
 *   - 附件注入策略与豆包同构：隐藏 <input type=file> 原生注入（评分
 *     排序，accept 收图的优先）→ CDP 原生拖放 → 合成 paste 兜底；
 *   - 页内求值体经 new Function 字符串编译：字符串里写正则必须双反斜杠
 *     （模板字符串会吃掉单层反斜杠），能用 includes 就不用正则。
 *
 * 校准说明（重要）：ChatGPT 前端无公开 API 且频繁改版，选择器以当前
 * 已知结构为准，属于"尽力而为"清单——实测若某项定位失败，跑
 * POST /api/webbridge/diagnose {"dive":"选择器"} 看真实结构，改本文件
 * 对应候选数组即可，无需动管理器。
 * ==========================================================================
 */

const { acceptAllowsImages } = require('./base');

/**
 * 页内共享：定位"最新一条助手回复块"源码。
 * 策略（三层，按稳定性排序，2026-10-03 真机诊断迭代定案）：
 *   1) 角色属性选择器（data-message-author-role="assistant"，未来恢复标注直接命中）；
 *   2) 屏幕阅读器标题文本匹配——ChatGPT 每个回合块首位都有一个 h4.sr-only
 *      标题（"ChatGPT 说："/"你说："），其**父元素即回合块**（旧形态父元素
 *      是 section[data-testid^=conversation-turn]，虚拟化新形态是
 *      div.block-<hash>），标题文本区分角色且不依赖任何哈希类名——两种
 *      实测形态通用；取最后一条命中助手的；
 *   3) 回合 section + 助手标记容器（_container 等，旧形态回退）。
 * 全部落空返回 null——绝不退化成抓页面骨架
 * @returns {string} 可嵌入 evaluate 源码的函数字面量
 */
function findAssistantBlockSource() {
    return `(function findAssistantBlock(replySels, turnSels, markerSels, headingTexts) {
        let block = null;
        for (const sel of replySels) {
            try {
                const nodes = document.querySelectorAll(sel);
                if (nodes.length) { block = nodes[nodes.length - 1]; break; }
            } catch (e) { /* 非法选择器跳过 */ }
        }
        if (!block) {
            // 屏幕阅读器标题匹配（跨形态通用锚点，见函数头注释）
            const heads = Array.from(document.querySelectorAll('h4.sr-only, .sr-only'));
            for (let i = heads.length - 1; i >= 0; i--) {
                const t = (heads[i].textContent || '').trim().toLowerCase();
                if (headingTexts.some((h) => t === h || t.startsWith(h))) {
                    block = heads[i].parentElement;
                    break;
                }
            }
        }
        if (!block) {
            let turns = [];
            for (const sel of turnSels) {
                try {
                    turns = Array.from(document.querySelectorAll(sel));
                    if (turns.length) break;
                } catch (e2) { /* 跳过 */ }
            }
            for (let i = turns.length - 1; i >= 0; i--) {
                for (const msel of markerSels) {
                    try {
                        if (turns[i].querySelector(msel)) { block = turns[i]; break; }
                    } catch (e3) { /* 跳过 */ }
                }
                if (block) break;
            }
        }
        if (block) {
            const tag = (block.tagName || '').toUpperCase();
            if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(tag)) return null;
        }
        return block;
    })`;
}

/** 共享的"找最新助手回复块"页内函数源码（四处复用） */
const FIND_BLOCK_SRC = findAssistantBlockSource();

/** 输入框候选（按优先级；ProseMirror contenteditable 与 textarea 双形态） */
const INPUT_SELECTORS = [
    '#prompt-textarea',
    'div#prompt-textarea[contenteditable="true"]',
    'textarea#prompt-textarea',
    'div[contenteditable="true"].ProseMirror',
    'form [contenteditable="true"]',
    'textarea[data-id="root"]',
    'form textarea'
];

/** 发送按钮候选（发送态；生成中会换成停止按钮。点击失败按 Enter 兜底） */
const SEND_BUTTON_SELECTORS = [
    '#composer-submit-button',
    'button[data-testid="send-button"]',
    'button[data-testid="composer-submit-button"]',
    'button[data-testid="composer-send-button"]',
    'button[aria-label="发送提示"]',
    'button[aria-label="Send prompt"]',
    'form button[type="submit"]'
];

/** 停止按钮候选（存在 = 仍在生成；判定不了由 turnWatcher 文本稳定兜底） */
const STOP_BUTTON_SELECTORS = [
    'button[data-testid="stop-button"]',
    'button[aria-label="停止流式输出"]',
    'button[aria-label="Stop streaming"]',
    '#composer-stop-button'
];

/** 助手回复块候选（角色属性；2026-10 仅用户消息带角色属性，常落空走回退） */
const REPLY_SELECTORS = [
    'div[data-message-author-role="assistant"]'
];

/** 回合容器候选（找块回退入口：最后一个含助手标记的回合） */
const TURN_SELECTORS = [
    'section[data-testid^="conversation-turn"]',
    '[data-testid^="conversation-turn"]'
];

/**
 * 助手回合标记候选（2026-10-03 真机 diagnose dive 校准，旧形态回退用）：
 * 旧形态助手回合内含 _container 内容容器/图片容器；虚拟化新形态两者皆无，
 * 靠屏幕阅读器标题文本找块（见 ASSISTANT_HEADING_TEXTS）
 */
const ASSISTANT_MARKER_SELECTORS = [
    '[class*="_container"]',
    '.markdown',
    'div[id^="image-"]'
];

/**
 * 屏幕阅读器标题的助手角色文本（小写前缀匹配；随界面语言增长此清单）。
 * 每个回合块首位的 h4.sr-only 标题用"角色名+说"标注作者，是虚拟化
 * 新形态下唯一稳定的角色锚点
 */
const ASSISTANT_HEADING_TEXTS = ['chatgpt 说', 'chatgpt said'];

/** 推荐追问区候选（ChatGPT 很少出追问胶囊，候选收敛，落空即空数组） */
const SUGGESTION_SELECTORS = [
    '[data-testid^="follow-up"]',
    '[class*="suggestion"]'
];

/** 从正文里剔除的干扰区候选（操作栏/按钮区/屏幕阅读器标题等非正文内容） */
const STRIP_SELECTORS = [
    ...SUGGESTION_SELECTORS,
    '.sr-only',
    '[class*="action"]',
    '[role="group"]',
    '[class*="toolbar"]'
];

/** 任务进行中提示候选（生图的骨架屏/进度区/思考指示器） */
const TASK_HINT_SELECTORS = [
    '[class*="shimmer"]',
    '[data-testid="thinking-indicator"]',
    '[class*="result-thinking"]',
    '[class*="loading"]',
    '[class*="placeholder"]'
];

/** 任务进行中的文本特征（限短文本命中，避免把历史回复的叙述当进度） */
const TASK_TEXT_RE = /(正在创建|正在生成|正在搜索|正在思考|生成中|创建图像|Creating image|Generating|Creating)/;

/** 正文里的引导脚本特征（includes 判定，见文件头转义说明） */
const JUNK_TEXT_KEYS = ['window._oai_', 'document.currentScript', 'performance.mark('];

/**
 * 定位输入框元素（首个命中的候选）。
 * SPA 渲染等待：编辑器 hydration 完成前候选会全部落空，轮询至多 15s
 */
async function findInput(page) {
    for (let i = 0; i < 30; i++) {
        const handle = await page.evaluateHandle((sels) => {
            for (const sel of sels) {
                try {
                    const el = document.querySelector(sel);
                    if (el && el.offsetParent !== null) return el;
                } catch { /* 非法选择器跳过 */ }
            }
            return null;
        }, INPUT_SELECTORS);
        const el = handle.asElement();
        if (el) return el;
        await new Promise((r) => setTimeout(r, 500));
    }
    return null;
}

/**
 * 发送消息：注入文本并触发发送，附件三级注入（按可靠性递减，与豆包同构）——
 *   a. 隐藏 <input type=file> 原生注入（站点上传管线接管，最可靠；
 *      真机确认 ChatGPT 有 #upload-photos（testid=upload-photos-input，
 *      accept=image/*）等一组隐藏输入，评分排序自动选中）
 *   b. CDP 原生拖放（Input.dispatchDragEvent，浏览器级文件拖入编辑器）
 *   c. 合成 paste（DataTransfer + data URL 内存注入，对部分编辑器无效）
 * @param {Object} page - puppeteer Page
 * @param {{text: string, images: string[], imagePaths?: string[]}} msg
 */
async function sendMessage(page, msg) {
    const input = await findInput(page);
    if (!input) throw new Error('ChatGPT 输入框未找到（站点可能已改版或未登录）');
    await input.scrollIntoViewIfNeeded().catch(() => {});
    await input.click().catch(() => {});

    // a) 附件：隐藏 <input type=file> 原生注入
    let attached = false;
    if (Array.isArray(msg.imagePaths) && msg.imagePaths.length) {
        const inputs = await page.$$('input[type="file"]');
        const scored = await Promise.all(inputs.map(async (inp) => {
            const meta = await inp.evaluate((el) => ({
                testid: el.getAttribute('data-testid') || '',
                accept: (el.accept || '').toLowerCase()
            })).catch(() => ({ testid: '', accept: '' }));
            return { inp, meta };
        }));
        scored.sort((a, b) => {
            const score = (m) => (/upload/.test(m.testid) ? 2 : 0) +
                (acceptAllowsImages(m.accept) && m.accept ? 1 : 0);
            return score(b.meta) - score(a.meta);
        });
        console.log(`[WebBridge] 附件注入: 找到 ${scored.length} 个文件输入（${scored.map((s) => s.meta.testid || '(无testid)').join(', ')}）`);
        for (const { inp, meta } of scored) {
            try {
                if (!acceptAllowsImages(meta.accept)) continue;
                await inp.uploadFile(...msg.imagePaths);
                attached = true;
                // 等站点上传管线出缩略/完成回显，发送按钮才会带上附件
                await new Promise((r) => setTimeout(r, 2500));
                console.log('[WebBridge] 附件注入: 文件输入注入成功（' + (meta.testid || '匿名输入') + '）');
                break;
            } catch (err) {
                console.warn('[WebBridge] 附件注入: 文件输入失败:', err.message);
            }
        }
    }
    // b) 附件：CDP 原生拖放
    if (!attached && Array.isArray(msg.imagePaths) && msg.imagePaths.length) {
        try {
            const box = await input.boundingBox();
            if (box) {
                const client = await page.createCDPSession();
                const data = { items: [], files: msg.imagePaths, dragOperationsMask: 1 };
                const base = { x: box.x + box.width / 2, y: box.y + box.height / 2, data };
                await client.send('Input.dispatchDragEvent', { type: 'dragEnter', ...base });
                await client.send('Input.dispatchDragEvent', { type: 'dragOver', ...base });
                await client.send('Input.dispatchDragEvent', { type: 'drop', ...base });
                await client.detach().catch(() => {});
                attached = true;
                await new Promise((r) => setTimeout(r, 2500));
                console.log('[WebBridge] 附件注入: CDP 拖放注入成功');
            }
        } catch (err) {
            console.warn('[WebBridge] 附件注入: CDP 拖放失败:', err.message);
        }
    }
    // c) 附件：合成 paste 兜底
    if (!attached && Array.isArray(msg.images) && msg.images.length) {
        await input.evaluate((el) => el.focus()).catch(() => {});
        await page.evaluate(async (dataUrls) => {
            const target = document.activeElement || document.body;
            for (const dataUrl of dataUrls) {
                try {
                    const blob = await (await fetch(dataUrl)).blob();
                    const file = new File([blob], `image-${Date.now()}.png`, { type: blob.type || 'image/png' });
                    const dt = new DataTransfer();
                    dt.items.add(file);
                    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
                    Object.defineProperty(ev, 'clipboardData', { value: dt });
                    target.dispatchEvent(ev);
                    await new Promise((r) => setTimeout(r, 400));
                } catch { /* 单张失败跳过，不中断 */ }
            }
        }, msg.images).catch((err) => console.warn('[WebBridge] 附件注入: 合成粘贴失败:', err.message));
        console.log('[WebBridge] 附件注入: 合成粘贴已派发（结果未知）');
    }

    // 文本注入：textarea 走原生 setter + input 事件；contenteditable 走 execCommand
    // （ProseMirror 受控输入兼容路径，先 focus 再 selectAll+insertText 覆盖占位）
    const ok = await page.evaluate((sels, text) => {
        let el = null;
        for (const sel of sels) {
            try {
                const e = document.querySelector(sel);
                if (e && e.offsetParent !== null) { el = e; break; }
            } catch { /* 跳过 */ }
        }
        if (!el) return false;
        el.focus();
        const isTextarea = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
        if (isTextarea) {
            const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(el, text);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            // 富文本：清空后 insertText，兼容大多数前端框架的受控输入
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, text);
        }
        return true;
    }, INPUT_SELECTORS, msg.text);
    if (!ok) throw new Error('ChatGPT 输入框文本注入失败');

    // 触发发送：先等发送按钮就绪（带附件时站点上传完成后才会启用，
    // 立即点会丢附件），最多等 10s；然后优先点发送按钮，失败按 Enter 兜底
    // （ChatGPT 的 Enter 即发送，真机验证可用）
    for (let i = 0; i < 20; i++) {
        const ready = await page.evaluate((sels) => {
            for (const sel of sels) {
                try {
                    const btn = document.querySelector(sel);
                    if (btn && !btn.disabled) return true;
                } catch { /* 跳过 */ }
            }
            return false;
        }, SEND_BUTTON_SELECTORS);
        if (ready) break;
        await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, 150));
    const clicked = await page.evaluate((sels) => {
        for (const sel of sels) {
            try {
                const btn = document.querySelector(sel);
                if (btn && !btn.disabled) { btn.click(); return true; }
            } catch { /* 跳过 */ }
        }
        return false;
    }, SEND_BUTTON_SELECTORS);
    if (!clicked) {
        await page.keyboard.press('Enter');
    }
}

/**
 * 是否仍在生成：停止按钮存在即视为生成中（无法判定返回 false，
 * 由 turnWatcher 的"文本稳定"兜底）
 */
async function isGenerating(page) {
    try {
        return await page.evaluate((sels) => {
            for (const sel of sels) {
                try {
                    const btn = document.querySelector(sel);
                    if (btn && btn.offsetParent !== null) return true;
                } catch { /* 跳过 */ }
            }
            return false;
        }, STOP_BUTTON_SELECTORS);
    } catch {
        return false;
    }
}

/**
 * 尽力点击"停止生成"（base.js 契约可选方法）：停止按钮与发送按钮同位
 * （生成中互换），把发送候选一并试掉。管理器 abort 接口调用
 */
async function stopGeneration(page) {
    const sels = [...STOP_BUTTON_SELECTORS, ...SEND_BUTTON_SELECTORS];
    await page.evaluate((s) => {
        for (const sel of s) {
            try {
                const btn = document.querySelector(sel);
                if (btn && !btn.disabled) { btn.click(); break; }
            } catch { /* 跳过 */ }
        }
    }, sels).catch(() => {});
}

/**
 * 提取最新一条回复（单次快照）：正文文本 + 图片/视频 URL。
 * 找块逻辑来自本文件共享源码（角色属性优先 → 回合 section 回退）；
 * 正文取块内 .markdown 容器（整块是回合 section 时剔除操作栏按钮后取
 * 正文容器），最后按行过滤噪声残留
 */
async function extractReply(page) {
    const fn = new Function('replySels', 'turnSels', 'markerSels', 'headingTexts', 'suggestSels', 'stripSels', `
        const block = (${FIND_BLOCK_SRC})(replySels, turnSels, markerSels, headingTexts);
        if (!block) return null;

        // 噪声行过滤：引用回显、纯符号行
        const isNoiseLine = (line) => {
            const t = line.trim();
            if (/^[\\\\/|·•\\\\-—_\\\\s]*$/.test(t)) return true;
            return t === '你说：' || t === '你说:' || t === '您说：';
        };

        // 内容图片：跳过头像/表情等小图与 data URL；ChatGPT 生成图是
        // oaiusercontent CDN 直链 <img>，同图多 <img> 按 src 与 URL 路径去重
        const pickImages = (root) => {
            const out = [];
            const seenSrc = new Set();
            const seenPath = new Set();
            for (const img of Array.from(root.querySelectorAll('img'))) {
                const src = img.src;
                if (img.naturalWidth < 200 || !src || src.startsWith('data:')) continue;
                if (seenSrc.has(src)) continue;
                seenSrc.add(src);
                let p;
                try { p = new URL(src).pathname; } catch (e2) { p = src; }
                if (seenPath.has(p)) continue;
                seenPath.add(p);
                out.push(src);
            }
            return out;
        };
        // 视频：只收 http(s) 直链——MSE 播放器给的是 blob: 地址（节点无法
        // fetch，且会阻塞管理器的网络捕获兜底）；每个 <video> 元素只取
        // 一个直链（video 内部多清晰度 <source> 是同一视频的不同档位）
        const pickVideos = (root) => {
            const seen = new Set();
            return Array.from(root.querySelectorAll('video')).map((v) => v.currentSrc || v.src)
                .filter((s) => {
                    if (!s || !/^https?:/i.test(s)) return false;
                    const key = s.split('?')[0];   // 签名 URL 去 query 后比对
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
        };

        // 推荐追问：ChatGPT 很少出追问胶囊，候选命中后取短文本（≤40 字）
        const pickSuggestions = (root) => {
            for (const sel of suggestSels) {
                try {
                    const box = root.querySelector(sel);
                    if (!box) continue;
                    const items = Array.from(box.querySelectorAll(
                        'button, [role="button"], a'
                    )).map((el) => (el.innerText || '').trim())
                        .filter((t) => t && t.length <= 40 && !isNoiseLine(t));
                    if (items.length) return [...new Set(items)];
                } catch (e3) { /* 跳过 */ }
            }
            return [];
        };

        const suggestions = pickSuggestions(block);
        let text = '';
        try {
            // 正文容器：块是回合 section 时取块内 _container 内容容器
            // （2026-10 真机结构；.markdown 为旧版兼容回退，再退整块），
            // 克隆后剔除操作栏/按钮等干扰节点再取 innerText（克隆操作
            // 不影响页面本身）
            const contentRoot = block.querySelector('[class*="_container"]')
                || block.querySelector('.markdown') || block;
            const clone = contentRoot.cloneNode(true);
            clone.querySelectorAll('button').forEach((el) => el.remove());
            stripSels.forEach((sel) => {
                try { clone.querySelectorAll(sel).forEach((el) => el.remove()); } catch (e4) { /* 跳过 */ }
            });
            text = (clone.innerText || '').split('\\\\n')
                .filter((line) => line.trim() && !isNoiseLine(line))
                .join('\\\\n').trim();
        } catch (e5) {
            text = (block.innerText || '').trim();
        }
        // 文本级垃圾守卫：命中页面引导脚本特征即视为无效提取（返回 null
        // 让 turnWatcher 走"无回复"路径，而不是把代码当正文交付）
        for (const key of ${JSON.stringify(JUNK_TEXT_KEYS)}) {
            if (text.includes(key)) return null;
        }

        return {
            text,
            suggestions,
            imageUrls: pickImages(block),
            videoUrls: pickVideos(block)
        };
    `);
    return page.evaluate(fn, REPLY_SELECTORS, TURN_SELECTORS, ASSISTANT_MARKER_SELECTORS,
        ASSISTANT_HEADING_TEXTS, SUGGESTION_SELECTORS, STRIP_SELECTORS).catch((err) => {
            console.warn('[WebBridge][chatgpt] extractReply 求值失败:', err && err.message);
            return null;
        });
}

/**
 * 检测站点是否在进行生图等长任务（base.js 契约可选方法）：
 * 只扫"最新回复块"内部的骨架屏/进度候选与短状态文本——不扫全页，
 * 避免把历史回复里含有"生成中"字样的叙述误判为进行中任务。
 * 返回 { active, text }，text 为进度描述（如"正在创建图像"）
 */
async function detectTask(page) {
    const fn = new Function('replySels', 'turnSels', 'markerSels', 'headingTexts', 'hintSels', 'textReSource', `
        const re = new RegExp(textReSource);
        const block = (${FIND_BLOCK_SRC})(replySels, turnSels, markerSels, headingTexts);
        if (!block) return { active: false, text: '' };
        // 骨架屏/进度区候选：可见即视为进行中（shimmer 常无文本）
        for (const sel of hintSels) {
            try {
                for (const el of block.querySelectorAll(sel)) {
                    if (el.offsetParent === null) continue;
                    const t = (el.innerText || '').trim();
                    if (t && t.length <= 60 && re.test(t)) return { active: true, text: t.slice(0, 40) };
                    if (!t) return { active: true, text: '生成中…' };
                }
            } catch (e) { /* 跳过 */ }
        }
        // 短状态文本扫描（限块内小元素，如"正在创建图像"状态条）
        try {
            for (const el of block.querySelectorAll('div, span, button')) {
                if (el.offsetParent === null || el.children.length > 2) continue;
                const t = (el.innerText || '').trim();
                if (t && t.length <= 40 && re.test(t)) return { active: true, text: t.slice(0, 40) };
            }
        } catch (e2) { /* 跳过 */ }
        return { active: false, text: '' };
    `);
    return page.evaluate(fn, REPLY_SELECTORS, TURN_SELECTORS, ASSISTANT_MARKER_SELECTORS,
        ASSISTANT_HEADING_TEXTS, TASK_HINT_SELECTORS, TASK_TEXT_RE.source)
        .catch(() => ({ active: false, text: '' }));
}

/**
 * 触发视频加载（base.js 契约可选方法）：在最新回复块里找到视频元素或
 * 播放卡并模拟点击，随后跨全部标签页轮询等待 <video> 出现——拿到 src
 * 后立即静音+暂停（只为取地址，不真播放）。页面已有 <video> 时直接返回
 */
async function revealVideos(page) {
    const clickFn = new Function('replySels', 'turnSels', 'markerSels', 'headingTexts', `
        const block = (${FIND_BLOCK_SRC})(replySels, turnSels, markerSels, headingTexts);
        if (!block) return false;
        const video = block.querySelector('video');
        if (video && (video.currentSrc || video.src)) {
            video.muted = true;
            return true;   // 已有视频元素，无需点击
        }
        // 优先点播放按钮状子元素，其次整卡兜底
        for (const sel of ['[class*="play-btn"]', '[class*="play-button"]', '[aria-label*="播放"]', '[aria-label*="Play"]', 'video']) {
            try {
                const btn = block.querySelector(sel);
                if (btn && btn.offsetParent !== null) { btn.click(); return true; }
            } catch (e) { /* 跳过 */ }
        }
        return false;
    `);
    const clicked = await page.evaluate(clickFn, REPLY_SELECTORS, TURN_SELECTORS,
        ASSISTANT_MARKER_SELECTORS, ASSISTANT_HEADING_TEXTS).catch(() => false);

    if (!clicked) return false;
    // 等播放器初始化出 <video>（≤10s）：点击可能开新标签页播放器，
    // 跨全部页面找；拿到 src 才静音暂停（过早 pause 会打断加载）
    for (let i = 0; i < 20; i++) {
        let pages = [page];
        try { pages = await page.browser().pages(); } catch { /* 退化到当前页 */ }
        for (const p of pages) {
            const src = await p.evaluate(() => {
                const v = document.querySelector('video');
                if (!v) return '';
                const s = v.currentSrc || v.src || '';
                if (!s) return '';
                v.muted = true;
                try { v.pause(); } catch (e) { /* 跳过 */ }
                return s;
            }).catch(() => '');
            if (src) {
                await page.keyboard.press('Escape').catch(() => {});
                return true;
            }
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

/**
 * 触发大图加载（base.js 契约可选方法）：逐张点击回复块内的内容图片
 * 打开大图预览——页面会请求原始尺寸 URL（管理器的网络捕获钩子按路径
 * 基键记下），每张 1.5s 后 ESC 关闭再点下一张。回复块内没有内容图时
 * 返回 false，不影响交付流程
 */
async function revealImages(page) {
    const countFn = new Function('replySels', 'turnSels', 'markerSels', 'headingTexts', `
        const block = (${FIND_BLOCK_SRC})(replySels, turnSels, markerSels, headingTexts);
        if (!block) return 0;
        // 内容图候选：<img> 大图 + 生图容器 div[id^="image-"]（点击开大图）
        const imgs = Array.from(block.querySelectorAll('img'))
            .filter((img) => img.naturalWidth >= 200 && img.src && !img.src.startsWith('data:'));
        const boxes = Array.from(block.querySelectorAll('div[id^="image-"]'));
        return imgs.length + boxes.length;
    `);
    const count = await page.evaluate(countFn, REPLY_SELECTORS, TURN_SELECTORS,
        ASSISTANT_MARKER_SELECTORS, ASSISTANT_HEADING_TEXTS).catch(() => 0);
    if (!count) return false;

    const clickNthFn = new Function('replySels', 'turnSels', 'markerSels', 'headingTexts', 'n', `
        const block = (${FIND_BLOCK_SRC})(replySels, turnSels, markerSels, headingTexts);
        if (!block) return false;
        const cands = Array.from(block.querySelectorAll('img'))
            .filter((img) => img.naturalWidth >= 200 && img.src && !img.src.startsWith('data:'));
        cands.push(...Array.from(block.querySelectorAll('div[id^="image-"]')));
        if (n >= cands.length) return false;
        const el = cands[n];
        if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded();
        el.click();
        return true;
    `);
    // 逐张：点开 → 等原图请求发出并被捕获 → ESC 关闭 → 下一张
    for (let n = 0; n < Math.min(count, 4); n++) {
        await page.evaluate(clickNthFn, REPLY_SELECTORS, TURN_SELECTORS,
            ASSISTANT_MARKER_SELECTORS, ASSISTANT_HEADING_TEXTS, n).catch(() => {});
        await new Promise((r) => setTimeout(r, 1500));
        await page.keyboard.press('Escape').catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
    }
    return true;
}

module.exports = {
    id: 'chatgpt',
    name: 'ChatGPT',
    homeUrl: 'https://chatgpt.com/',
    urlPattern: /chatgpt\.com|chat\.openai\.com/,
    ready: true,   // 首次实测后如有定位失败，跑 diagnose 看 DOM 后改上方候选清单
    findInput,
    sendMessage,
    isGenerating,
    extractReply,
    detectTask,
    revealVideos,
    revealImages,
    stopGeneration
};
