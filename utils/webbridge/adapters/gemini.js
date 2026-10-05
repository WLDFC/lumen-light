/**
 * ==========================================================================
 * LumenLight 网页桥接：Gemini 适配器（gemini）
 * ==========================================================================
 * 实现 base.js 契约，针对 gemini.google.com 网页版：
 *   - DOM 是 Angular + 自定义元素（Web Components）：助手回复是
 *     <model-response>、用户消息是 <user-query>——标签名语义化且多年
 *     稳定，是找块的首要锚点（无哈希类依赖）；
 *   - 输入框是 Quill 富文本编辑器（div.ql-editor[contenteditable]，包在
 *     <rich-textarea> 自定义元素里），文本注入走 focus + execCommand；
 *   - 回复提取返回"最新一条 model-response 的完整文本 + 图片/视频 URL"，
 *     增量与稳定判定由 turnWatcher 统一做，适配器只做单次快照；
 *   - 图片是 googleusercontent CDN 直链，URL 尾部带 `=w400-h300` 形态的
 *     尺寸指令段——imageVariants 剥掉尺寸段并补 `=s0`（原图尺寸指令）
 *     作原图候选，管理器逐候选下载按像素取最大；
 *   - 附件注入策略与豆包/ChatGPT 同构：隐藏 <input type=file> 原生注入
 *     → CDP 原生拖放 → 合成 paste 兜底；
 *   - 页内求值体经 new Function 字符串编译：字符串里写正则必须双反斜杠
 *     （模板字符串会吃掉单层反斜杠），能用 includes 就不用正则。
 *
 * 校准说明（重要）：Gemini 前端无公开 API 且会改版，选择器以当前已知
 * 结构为准，属于"尽力而为"清单——实测若某项定位失败，跑
 * POST /api/webbridge/diagnose {"dive":"选择器"} 看真实结构，改本文件
 * 对应候选数组即可，无需动管理器。
 * ==========================================================================
 */

const { findReplyBlockSource, acceptAllowsImages } = require('./base');

/**
 * 共享的"找最新回复块"页内函数源码：自定义元素候选取最后一个，
 * 加脚本类元素守卫（垃圾守卫，真机踩坑见 doubao/chatgpt 同款逻辑）
 */
const FIND_BLOCK_SRC = `(function findAssistantBlock(replySels) {
    let block = null;
    for (const sel of replySels) {
        try {
            const nodes = document.querySelectorAll(sel);
            if (nodes.length) { block = nodes[nodes.length - 1]; break; }
        } catch (e) { /* 非法选择器跳过 */ }
    }
    if (block) {
        const tag = (block.tagName || '').toUpperCase();
        if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(tag)) return null;
    }
    return block;
})`;

/** 输入框候选（按优先级；Quill 编辑器包在 rich-textarea 自定义元素里） */
const INPUT_SELECTORS = [
    'rich-textarea div.ql-editor[contenteditable="true"]',
    'rich-textarea div[contenteditable="true"][role="textbox"]',
    'div.ql-editor[contenteditable="true"]',
    'rich-textarea [role="textbox"]',
    'div[contenteditable="true"][role="textbox"]',
    'form div[contenteditable="true"]',
    'form textarea'
];

/** 发送按钮候选（发送态；生成中会换成停止按钮） */
const SEND_BUTTON_SELECTORS = [
    'button[aria-label="发送消息"]',
    'button[aria-label="Send message"]',
    'button.send-button',
    '[data-test-id="send-button"]',
    'button[aria-label*="发送"]',
    'button[aria-label*="Send"]',
    'form button[type="submit"]'
];

/** 停止按钮候选（存在 = 仍在生成；判定不了由 turnWatcher 文本稳定兜底） */
const STOP_BUTTON_SELECTORS = [
    'button[aria-label="停止"]',
    'button[aria-label="Stop"]',
    '[data-test-id="stop-button"]',
    'button[aria-label*="停止生成"]',
    'button[aria-label*="Stop generating"]'
];

/** 助手回复块候选（自定义元素标签名，语义化且多年稳定） */
const REPLY_SELECTORS = [
    'model-response',
    'response-container',
    'message-content[data-type="model"]'
];

/** 用户消息块候选（启发式排除用；本适配器回复块直接命中，少走启发式） */
const USER_MSG_SELECTORS = [
    'user-query'
];

/** 推荐追问区候选（Gemini 的追问胶囊是 suggestion-chip 自定义元素） */
const SUGGESTION_SELECTORS = [
    'suggestion-chip',
    '[class*="suggestion"]'
];

/** 从正文里剔除的干扰区候选（操作栏/按钮区等非正文内容） */
const STRIP_SELECTORS = [
    ...SUGGESTION_SELECTORS,
    '.sr-only',
    '[class*="action"]',
    '[role="group"]',
    '[class*="toolbar"]'
];

/** 任务进行中提示候选（生图/生视频的骨架屏/进度区） */
const TASK_HINT_SELECTORS = [
    '[class*="loading"]',
    '[class*="progress"]',
    '[class*="skeleton"]',
    '[class*="placeholder"]',
    'image-generation-chip'
];

/** 任务进行中的文本特征（限短文本命中，避免把历史回复的叙述当进度） */
const TASK_TEXT_RE = /(正在生成|生成中|正在创建|正在绘制|生成图像中|Generating|Creating)/;

/** 正文里的引导脚本特征（includes 判定，见文件头转义说明） */
const JUNK_TEXT_KEYS = ['window.W_j', 'document.currentScript', 'AF_initDataCallback'];

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
 * 发送消息：注入文本并触发发送，附件三级注入（按可靠性递减，与
 * 豆包/ChatGPT 同构）——
 *   a. 隐藏 <input type=file> 原生注入（站点上传管线接管，最可靠）
 *   b. CDP 原生拖放（Input.dispatchDragEvent，浏览器级文件拖入编辑器）
 *   c. 合成 paste（DataTransfer + data URL 内存注入，对部分编辑器无效）
 * @param {Object} page - puppeteer Page
 * @param {{text: string, images: string[], imagePaths?: string[]}} msg
 */
async function sendMessage(page, msg) {
    const input = await findInput(page);
    if (!input) throw new Error('Gemini 输入框未找到（站点可能已改版或未登录）');
    await input.scrollIntoViewIfNeeded().catch(() => {});
    await input.click().catch(() => {});

    // a) 附件：隐藏 <input type=file> 原生注入
    let attached = false;
    if (Array.isArray(msg.imagePaths) && msg.imagePaths.length) {
        const inputs = await page.$$('input[type="file"]');
        const scored = await Promise.all(inputs.map(async (inp) => {
            const meta = await inp.evaluate((el) => ({
                testid: el.getAttribute('data-test-id') || '',
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

    // 文本注入：textarea 走原生 setter + input 事件；contenteditable（Quill）
    // 走 execCommand——Quill 对 insertText 兼容良好，会同步内部模型
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
    if (!ok) throw new Error('Gemini 输入框文本注入失败');

    // 触发发送：先等发送按钮就绪（带附件时站点上传完成后才会启用，
    // 立即点会丢附件），最多等 10s；然后优先点发送按钮，失败按 Enter 兜底
    // （Gemini 的 Enter 即发送）
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
 * 提取最新一条回复（单次快照）：正文文本 + 推荐追问 + 图片/视频 URL。
 * 找块逻辑：model-response 等自定义元素候选取最后一个；正文取块内
 * .markdown 容器（克隆后剔除操作栏/按钮节点再取 innerText）
 */
async function extractReply(page) {
    const fn = new Function('replySels', 'suggestSels', 'stripSels', `
        const block = (${FIND_BLOCK_SRC})(replySels);
        if (!block) return null;

        // 噪声行过滤：纯符号行
        const isNoiseLine = (line) => {
            const t = line.trim();
            return /^[\\\\/|·•\\\\-—_\\\\s]*$/.test(t);
        };

        // 内容图片：跳过头像/表情等小图与 data URL；Gemini 生成图渲染为
        // blob: URL（且加载后会被站点回收）——blob 候选在提取后由页内
        // 转成 data URL（见 extractReply 第二段），此处按 src 去重收集；
        // 回复块里"下载"按钮指向的 googleusercontent 直链一并收集
        //（原图，最优先的候选）
        const pickImages = (root) => {
            const out = [];
            const seenSrc = new Set();
            const seenPath = new Set();
            const push = (src) => {
                if (!src || seenSrc.has(src)) return;
                seenSrc.add(src);
                let p;
                try { p = new URL(src).pathname; } catch (e2) { p = src; }
                if (seenPath.has(p)) return;
                seenPath.add(p);
                out.push(src);
            };
            for (const img of Array.from(root.querySelectorAll('img'))) {
                const src = img.src;
                if (img.naturalWidth < 200 || !src || src.startsWith('data:')) continue;
                push(src);
            }
            // 下载按钮直链（原图）：googleusercontent 的图片链接
            // （includes 判定：字符串函数体里正则的 \/ 转义会被模板字符串吃掉）
            for (const a of Array.from(root.querySelectorAll('a[href]'))) {
                const href = a.href || '';
                if (href.startsWith('https://') && href.includes('googleusercontent.com')) push(href);
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

        // 推荐追问：suggestion-chip 自定义元素取短文本（≤40 字）
        const pickSuggestions = (root) => {
            for (const sel of suggestSels) {
                try {
                    const items = Array.from(root.querySelectorAll(sel))
                        .map((el) => (el.innerText || '').trim())
                        .filter((t) => t && t.length <= 40 && !isNoiseLine(t));
                    if (items.length) return [...new Set(items)];
                } catch (e3) { /* 跳过 */ }
            }
            return [];
        };

        const suggestions = pickSuggestions(block);
        let text = '';
        try {
            // 正文提取：优先 .markdown 容器；克隆后剔除操作栏/按钮等干扰
            // 节点再取 innerText（克隆操作不影响页面本身）
            const contentRoot = block.querySelector('.markdown') || block;
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
    const result = await page.evaluate(fn, REPLY_SELECTORS, SUGGESTION_SELECTORS, STRIP_SELECTORS).catch((err) => {
        console.warn('[WebBridge][gemini] extractReply 求值失败:', err && err.message);
        return null;
    });
    if (result && Array.isArray(result.imageUrls)) {
        // blob: 图片页内转 data URL：Gemini 用 blob: 渲染生成图且加载后
        // 回收，Node 侧 fetch 会 "Failed to fetch"——趁 blob 还活着就地
        // 转成 data URL（下载管线对 data: 走页面内 fetch）。转换失败的
        // 保留 blob 原样（交付端有网络捕获配对兜底，见 webBridgeManager）
        const blobs = result.imageUrls.filter((u) => u.startsWith('blob:'));
        if (blobs.length) {
            const aligned = await page.evaluate(async (srcs) => {
                const out = [];
                for (const src of srcs) {
                    try {
                        const resp = await fetch(src);
                        if (!resp.ok) { out.push(null); continue; }
                        const blob = await resp.blob();
                        const dataUrl = await new Promise((resolve, reject) => {
                            const fr = new FileReader();
                            fr.onload = () => resolve(fr.result);
                            fr.onerror = () => reject(new Error('FileReader 失败'));
                            fr.readAsDataURL(blob);
                        });
                        out.push(dataUrl);
                    } catch (e) { out.push(null); }   // blob 已回收：跳过
                }
                return out;
            }, blobs).catch(() => blobs.map(() => null));
            result.imageUrls = result.imageUrls.map((u) => {
                if (!u.startsWith('blob:')) return u;
                const conv = aligned[blobs.indexOf(u)];
                return conv || u;
            });
        }
    }
    return result;
}

/**
 * 检测站点是否在进行生图/生视频等长任务（base.js 契约可选方法）：
 * 只扫"最新回复块"内部的骨架屏/进度候选与短状态文本——不扫全页。
 * 返回 { active, text }，text 为进度描述
 */
async function detectTask(page) {
    const fn = new Function('replySels', 'hintSels', 'textReSource', `
        const re = new RegExp(textReSource);
        const block = (${FIND_BLOCK_SRC})(replySels);
        if (!block) return { active: false, text: '' };
        // 骨架屏/进度区候选：可见且文本命中任务特征
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
        // 短状态文本扫描（限块内小元素）
        try {
            for (const el of block.querySelectorAll('div, span, button')) {
                if (el.offsetParent === null || el.children.length > 2) continue;
                const t = (el.innerText || '').trim();
                if (t && t.length <= 40 && re.test(t)) return { active: true, text: t.slice(0, 40) };
            }
        } catch (e2) { /* 跳过 */ }
        return { active: false, text: '' };
    `);
    return page.evaluate(fn, REPLY_SELECTORS, TASK_HINT_SELECTORS, TASK_TEXT_RE.source)
        .catch(() => ({ active: false, text: '' }));
}

/**
 * 图片原图候选（base.js 契约可选方法）：Gemini 的 googleusercontent CDN
 * URL 尾部带 `=w400-h300`（或 `=s640` 等）尺寸指令段——剥掉得原始文件，
 * `=s0` 是 Google CDN 的"原图尺寸"指令。候选按命中概率排序，管理器逐
 * 候选下载按像素取最大，失败候选自动跳过。
 * data:/blob: 候选原样返回（前者已是字节本体，后者基键无意义且不可变）
 */
function imageVariants(url) {
    if (!/^https?:/i.test(url)) return [url];
    const variants = [];
    // 剥法一：剥掉尾部整个尺寸指令段（=w…-h…-p-k-no… 等）
    const stripped = url.replace(/=(?:[ws]\d[^/]*)$/, '');
    if (stripped !== url) {
        variants.push(stripped);
        // 剥法二：剥掉后补 =s0（原图尺寸指令，多数情况直出原图）
        variants.push(stripped + '=s0');
    } else if (url.includes('googleusercontent.com')) {
        // 无尺寸段的捕获 URL（rd-gg-dl 一次性签名）：补 =s0 原图指令
        // 候选——命中即拿到最高质量档（真机对比：同分辨率 753KB 原图
        // vs 394KB 压缩档），失败自动跳过不拖慢
        variants.push(url + '=s0');
    }
    // 原 URL 兜底
    variants.push(url);
    return [...new Set(variants)];
}

/**
 * 触发视频加载（base.js 契约可选方法）：在最新回复块里找到视频元素或
 * 播放卡并模拟点击，随后跨全部标签页轮询等待 <video> 出现——拿到 src
 * 后立即静音+暂停（只为取地址，不真播放）。页面已有 <video> 时直接返回
 */
async function revealVideos(page) {
    const clickFn = new Function('replySels', `
        const block = (${FIND_BLOCK_SRC})(replySels);
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
    const clicked = await page.evaluate(clickFn, REPLY_SELECTORS).catch(() => false);

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
 * 触发原尺寸下载（downloadsOriginals 流程）：真实鼠标悬停图片 → 悬浮
 * 工具栏只在悬停时可见（display:none，合成 click 与页内查询都摸不到，
 * 真机踩坑）→ 在图片右上角区域找可见按钮 → 真实鼠标点击最靠右上角的
 * 一个（即"下载原尺寸"，工具栏最右）。Chrome 经 CDP setDownloadBehavior
 * 把原档直写 downloads/（管理器读盘直取），下载请求同时被捕获钩子记下
 * （双字节源）。返回是否完成点击
 */
/**
 * 触发原尺寸下载（downloadsOriginals 流程）：**纯 DOM 程序化点击**——
 * 实验定案（2026-10-03）：下载按钮不悬停时也在 DOM 里（36×36 可见，
 * 之前的普查漏掉是 offsetParent 过滤错杀 fixed 覆盖层元素），且
 * el.click() 程序化点击即可触发下载——不需要真实鼠标、不需要窗口
 * 前台，最小化/后台状态下照常工作（真实鼠标方案对用户使用有干扰、
 * 且窗口后台化时 CDP 输入会挂起，均已废弃）。
 * 下载经 CDP setDownloadBehavior 重定向到 downloads/ 落盘，管理器
 * 读盘直取原档字节。返回是否点到按钮
 */
async function revealImages(page) {
    const withTimeout = (pr, ms = 5000) => Promise.race([
        pr, new Promise((_, rej) => setTimeout(() => rej(new Error('操作超时')), ms))
    ]);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // 0) 窗口还原与前置：最小化窗口的 CDP 输入分发会挂起，且
    //    bringToFront 不会还原最小化（Windows 行为）——必须显式还原。
    //    Chrome 下载策略要求用户手势，程序化 el.click() 无 activation
    //    会被静默拦截（真机实验），真实鼠标事件才算手势——所以
    //    "还原窗口 + 真实鼠标"是不可绕过的组合，还原由程序自动完成
    try {
        const client = await page.createCDPSession();
        const win = await client.send('Browser.getWindowForTarget');
        if (win.bounds.windowState === 'minimized') {
            await client.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal' } });
            console.log('[WebBridge][gemini] 桥接浏览器处于最小化，已自动还原窗口');
        }
        await client.detach().catch(() => {});
    } catch { /* 尽力而为 */ }
    try { await withTimeout(page.bringToFront(), 5000); } catch { /* 失败仍尝试 */ }
    // 定位最新一张"可见渲染"的生成图。两阶段：优先已渲染可见的；全部
    // 未渲染（懒加载/刚生成未解码）就对最后一张反复 scrollIntoView 触发
    // 加载再查。只在图片大部分出视口时才滚动——避免悬停被滚动打断
    const locateFn = new Function('replySels', `
        return (async () => {
            const block = (${FIND_BLOCK_SRC})(replySels);
            if (!block) return { err: 'no-block' };
            const imgs = Array.from(block.querySelectorAll('img'))
                .filter((i) => i.src && !i.src.startsWith('data:'));
            if (!imgs.length) return { err: 'no-img' };
            for (let attempt = 0; attempt < 6; attempt++) {
                for (let i = imgs.length - 1; i >= 0; i--) {
                    const r = imgs[i].getBoundingClientRect();
                    if (r.width >= 80 && r.height >= 80 && imgs[i].naturalWidth >= 200) {
                        const vh = innerHeight;
                        if (r.top < 0 || r.bottom > vh) imgs[i].scrollIntoView({ block: 'start' });
                        const r2 = imgs[i].getBoundingClientRect();
                        return { cx: r2.left + r2.width / 2,
                            cy: Math.min(Math.max(r2.top + r2.height / 2, 120), vh - 120),
                            right: r2.right, top: r2.top };
                    }
                }
                imgs[imgs.length - 1].scrollIntoView({ block: 'center' });
                await new Promise((r2) => setTimeout(r2, 400));
            }
            return { err: 'no-visible-img' };
        })();
    `);
    // 按钮搜索：**重新取图片当前 rect**——悬停会引发滚动/布局变化，
    // 用旧坐标搜索必落空。下载键 aria-label=「下載原尺寸圖片」
    //（繁简+英文都收）；可见性用渲染尺寸判断（悬浮工具栏是 fixed 覆盖层，
    // offsetParent 恒为 null，不能用）；纯几何距离会误中用户消息的
    // 「複製提示詞」按钮，aria 匹配必须保留
    const findBtnFn = new Function('replySels', `
        return (async () => {
            const block = (${FIND_BLOCK_SRC})(replySels);
            if (!block) return null;
            const imgs = Array.from(block.querySelectorAll('img'))
                .filter((i) => i.naturalWidth >= 200 && i.src && !i.src.startsWith('data:'));
            const img = imgs[imgs.length - 1];
            if (!img) return null;
            const ir = img.getBoundingClientRect();
            const cands = [];
            for (const el of document.querySelectorAll('button, a')) {
                const r = el.getBoundingClientRect();
                if (r.width < 4 || r.height < 4) continue;
                if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) continue;
                const label = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('data-tooltip') || '');
                if (!/下載|下载|download/i.test(label)) continue;
                const nearOk = r.right > ir.right - 500 && r.left < ir.right + 80 &&
                    r.top > ir.top - 80 && r.bottom < ir.top + 220;
                if (!nearOk) continue;
                const dist = Math.abs(r.right - ir.right) + Math.abs(r.top - ir.top);
                cands.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, dist });
            }
            if (!cands.length) return null;
            cands.sort((a, b) => a.dist - b.dist);
            return { x: cands[0].x, y: cands[0].y };
        })();
    `);
    // 真实鼠标流：悬停 → 找按钮 → 点击（Chrome 下载策略要求用户手势，
    // 真机实验定案：移动后停留 400ms、按下-抬起间隔 80ms，瞬间点击不
    // 响应）。一轮未找到就强制滚到图片顶部再试（最多 3 轮）。所有
    // mouse 调用带 5s 超时——窗口后台化时 CDP 输入分发会挂起
    for (let attempt = 0; attempt < 3; attempt++) {
        const rect = await page.evaluate(locateFn, REPLY_SELECTORS).catch(() => null);
        if (!rect || rect.err) return false;
        try {
            await withTimeout(page.mouse.move(rect.cx, rect.cy, { steps: 8 }));
            await sleep(1000);
        } catch { return false; }
        const btn = await page.evaluate(findBtnFn, REPLY_SELECTORS).catch(() => null);
        if (btn) {
            try {
                await withTimeout(page.mouse.move(btn.x, btn.y, { steps: 6 }));
                await sleep(400);
                await withTimeout(page.mouse.down());
                await sleep(80);
                await withTimeout(page.mouse.up());
            } catch { return false; }
            return true;
        }
        await page.evaluate(() => {
            const blocks = document.querySelectorAll('model-response');
            const block = blocks[blocks.length - 1];
            const imgs = [...block.querySelectorAll('img')].filter((i) => i.naturalWidth >= 200);
            const img = imgs[imgs.length - 1];
            if (img) img.scrollIntoView({ block: 'start' });
        }).catch(() => {});
        await sleep(800);
    }
    return false;
}/**
 * 网络捕获是否为内容图：生成图走 googleusercontent CDN；gstatic.com
 * 是 UI 雪碧图（体积与内容图同量级，按尺寸阈值区分不了，按域名挡）
 */
function isContentImageUrl(url) {
    return String(url || '').toLowerCase().includes('googleusercontent.com');
}

module.exports = {
    id: 'gemini',
    name: 'Gemini',
    homeUrl: 'https://gemini.google.com/app',
    urlPattern: /gemini\.google\.com|bard\.google\.com/,
    ready: true,   // 首次实测后如有定位失败，跑 diagnose 看 DOM 后改上方候选清单
    findInput,
    sendMessage,
    isGenerating,
    extractReply,
    detectTask,
    imageVariants,
    isContentImageUrl,
    revealVideos,
    revealImages,
    stopGeneration,
    // 像素择优提前收工阈值：Gemini 全尺寸图约 1024×1024（百万像素级）；
    // minImageBytes 字节下限：同分辨率常有多个质量档（真机对比：网页
    // 下载 753KB 原图 vs 交付的 233KB 压缩档），低于下限的候选不参与
    // 择优（全部不达标才退回像素最大者保底）
    goodEnoughPixels: 900 * 1000,
    minImageBytes: 400 * 1024,
    // 原尺寸下载流程：revealImages 点击"下载原尺寸"→ Chrome 落盘 →
    // 管理器读盘直取原档字节（最高质量字节源，见 webBridgeManager）
    downloadsOriginals: true
};
