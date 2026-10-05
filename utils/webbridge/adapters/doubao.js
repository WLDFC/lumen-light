/**
 * ==========================================================================
 * LumenLight 网页桥接：豆包适配器（doubao）
 * ==========================================================================
 * 实现 base.js 契约，针对 www.doubao.com 网页版：
 *   - 输入框/发送按钮/消息块全部用"候选选择器数组"定位（站点改版时只改
 *     本文件的候选清单，框架不动）；豆包输入框是 TipTap ProseMirror
 *     contenteditable 富文本（2026-09-30 实测），发送按实际元素类型分流；
 *   - 附件注入三级策略：隐藏 <input type=file> 原生注入（uploadFile =
 *     CDP DOM.setFileInputFiles，实测输入区有两个 hidden 输入，accept 为
 *     扩展名清单，带 data-testid="upload-file-input" 的是聊天附件入口）
 *     → CDP 原生拖放 → 合成 paste 兜底；
 *   - 回复提取返回"最新一条回复的完整文本 + 推荐追问 + 图片/视频 URL"，
 *     增量与稳定判定由 turnWatcher 统一做，适配器只做单次快照；
 *   - "找最新回复块"的页内逻辑来自 base.js 共享源码，extractReply /
 *     detectTask / revealVideos 三处复用同一份（站点改版只改候选清单）。
 *
 * 校准说明（重要）：豆包前端无公开 API，data-testid 命名以当前已知结构
 * 为准，属于"尽力而为"清单——首次实测若某项定位失败，改本文件对应候选
 * 数组即可，无需动管理器。
 * ==========================================================================
 */

const { findReplyBlockSource, acceptAllowsImages } = require('./base');

/** 共享的"找最新回复块"页内函数源码（三处复用，见 base.js） */
const FIND_BLOCK_SRC = findReplyBlockSource();

/** 输入框候选（按优先级；textarea 与 contenteditable 双形态） */
const INPUT_SELECTORS = [
    'textarea[data-testid="chat_input_input"]',
    'div[data-testid="chat_input_input"]',
    '[data-testid="chat_input_input"]',
    'textarea[placeholder*="发消息"]',
    'div[contenteditable="true"][data-testid]',
    '#chat-input',
    'textarea'
];

/** 发送按钮候选（发送态；生成中豆包会把它换成停止按钮） */
const SEND_BUTTON_SELECTORS = [
    'button[data-testid="chat_input_send_button"]',
    '[data-testid="chat_input_send_button"]',
    'button[data-testid^="chat_input_send"]'
];

/** 停止按钮候选（存在 = 仍在生成） */
const STOP_BUTTON_SELECTORS = [
    'button[data-testid="chat_input_stop_button"]',
    '[data-testid="chat_input_stop_button"]',
    'button[data-testid*="stop"]'
];

/** 助手回复块候选 */
const REPLY_SELECTORS = [
    '[data-testid="receive_message"]',
    '[data-testid="receive_group"]',
    '[data-testid="message_item_receive"]'
];

/** 消息列表容器候选（回复块候选全部落空时的启发式入口） */
const LIST_SELECTORS = [
    '[data-testid="message_list"]',
    '#message-list',
    '[data-testid="chat_list"]',
    'div[class*="message-list"]'
];

/** 用户消息块候选（启发式提取时用于排除用户自己的气泡） */
const USER_MSG_SELECTORS = [
    '[data-testid="send_message"]',
    '[data-testid="message_item_send"]'
];

/** 推荐追问区候选（回复末尾的"你可以接着问"胶囊容器） */
const SUGGESTION_SELECTORS = [
    '[data-testid="chat_recommend_question"]',
    '[data-testid*="recommend"]',
    '[class*="recommend"]',
    '[class*="suggest"]'
];

/** 从正文里剔除的干扰区候选（推荐追问/操作栏/时间戳等非正文内容） */
const STRIP_SELECTORS = [
    ...SUGGESTION_SELECTORS,
    '[data-testid*="toolbar"]',
    '[class*="toolbar"]',
    '[class*="action-bar"]'
];

/** 任务进行中提示候选（生图/生视频的骨架屏/进度条/占位区） */
const TASK_HINT_SELECTORS = [
    '[class*="generating"]',
    '[class*="loading"]',
    '[class*="skeleton"]',
    '[class*="progress"]',
    '[class*="placeholder"]',
    '[class*="video-player-mask"]'
];

/** 任务进行中的文本特征（限短文本命中，避免把历史回复的叙述当进度） */
const TASK_TEXT_RE = /(生成中|正在生成|排队中|等待中|预计\s*\d+\s*秒|还剩\s*\d+\s*秒|\d+\s*%)/;

/** 视频播放卡候选（聊天里的视频在点击前没有 <video> 元素可提取） */
const VIDEO_CARD_SELECTORS = [
    '[class*="video-player"]',
    '[class*="video-card"]',
    '[data-testid*="video"]'
];

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

/** CDP 输入调用的兜底超时：页面 hidden 态下输入管线可能挂起（遮挡检测
 * 已由启动参数禁用，见 webBridgeManager chromeArgs），卡死则放弃走重试 */
function withTimeout(pr, ms = 5000) {
    return Promise.race([
        pr, new Promise((_, rej) => setTimeout(() => rej(new Error('mouse 操作超时')), ms))
    ]);
}

/** 鼠标点击发送按钮（CDP 真实事件流，算用户手势）：定位按钮中心坐标后
 * 移动→按下→抬起。按钮未渲染（新版 DOM 空输入时不存在）返回 false */
async function clickSendButton(page) {
    try { await withTimeout(page.bringToFront(), 5000); } catch { /* 失败仍尝试 */ }
    const btn = await page.evaluate((sels) => {
        for (const sel of sels) {
            try {
                const b = document.querySelector(sel);
                if (b && !b.disabled) {
                    const r = b.getBoundingClientRect();
                    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                }
            } catch { /* 跳过 */ }
        }
        return null;
    }, SEND_BUTTON_SELECTORS);
    if (!btn) return false;
    await withTimeout(page.mouse.move(btn.x, btn.y, { steps: 6 })).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    await withTimeout(page.mouse.down()).catch(() => {});
    await new Promise((r) => setTimeout(r, 80));
    await withTimeout(page.mouse.up()).catch(() => {});
    return true;
}

/** 发送校验：输入框被清空 / 用户消息块变多 / 停止按钮出现（已进入生成态），
 * 任一即算已发出。轮询至多 8s——没有这道校验，点击被吞时文字会静默
 * 停在输入框（真机踩坑），上层无从得知也没机会重试
 * @param {Object} baseline - 发送前基线 { inputHasText, userMsgs }
 */
async function verifyMessageSent(page, baseline) {
    for (let i = 0; i < 16; i++) {
        const state = await page.evaluate((inputSels, stopSels, userSels) => {
            let inputHasText = false;
            for (const sel of inputSels) {
                try {
                    const el = document.querySelector(sel);
                    if (el && el.offsetParent !== null) {
                        const t = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'
                            ? el.value : (el.innerText || el.textContent || '');
                        inputHasText = !!String(t).trim();
                        break;
                    }
                } catch { /* 跳过 */ }
            }
            let stop = false;
            for (const sel of stopSels) {
                try {
                    const b = document.querySelector(sel);
                    if (b && b.offsetParent !== null) { stop = true; break; }
                } catch { /* 跳过 */ }
            }
            let userMsgs = 0;
            for (const sel of userSels) {
                try { userMsgs += document.querySelectorAll(sel).length; } catch { /* 跳过 */ }
            }
            return { inputHasText, stop, userMsgs };
        }, INPUT_SELECTORS, STOP_BUTTON_SELECTORS, USER_MSG_SELECTORS).catch(() => null);
        if (state) {
            if (baseline.inputHasText && !state.inputHasText) return true;   // 输入框被清空
            if (state.userMsgs > baseline.userMsgs) return true;             // 新用户消息块已渲染
            if (state.stop) return true;                                     // 已进入生成态
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

/** CDP 键盘回车发送：聚焦输入框后派发 Enter（CDP 键盘事件同样是
 * 真实事件流；鼠标点击通道失效时的第二级重试） */
async function sendByKeyboard(page) {
    const input = await findInput(page);
    if (input) await input.evaluate((el) => el.focus()).catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
}

/**
 * 发送消息：注入文本并触发发送，附件三级注入（按可靠性递减）——
 *   a. 隐藏 <input type=file> 原生注入（站点上传管线接管，最可靠；
 *      imagePaths 为磁盘路径，由管理器从 data URL 暂存生成）
 *   b. CDP 原生拖放（Input.dispatchDragEvent，浏览器级文件拖入编辑器）
 *   c. 合成 paste（DataTransfer + data URL 内存注入，对部分编辑器无效）
 * @param {Object} page - puppeteer Page
 * @param {{text: string, images: string[], imagePaths?: string[]}} msg
 */
async function sendMessage(page, msg) {
    const input = await findInput(page);
    if (!input) throw new Error('豆包输入框未找到（站点可能已改版）');
    await input.scrollIntoViewIfNeeded().catch(() => {});
    await input.click().catch(() => {});

    // a) 附件：隐藏 <input type=file> 原生注入
    let attached = false;
    if (Array.isArray(msg.imagePaths) && msg.imagePaths.length) {
        const inputs = await page.$$('input[type="file"]');
        // 带上传语义 testid 的优先，accept 收图的次之
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
    if (!ok) throw new Error('豆包输入框文本注入失败');

    // 触发发送：先等发送按钮就绪（带附件时站点上传完成后才会启用，
    // 立即点会丢附件），最多等 10s。注意豆包新版 DOM 里输入框有内容
    // 时发送按钮才渲染（真机实测：空输入时按钮不存在），等待循环
    // 同时给它渲染时间
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

    // 发送前基线（发送校验的比对基准）：输入框是否已有文字 + 用户消息块数
    const baseline = await page.evaluate((inputSels, userSels) => {
        let inputHasText = false;
        for (const sel of inputSels) {
            try {
                const el = document.querySelector(sel);
                if (el && el.offsetParent !== null) {
                    const t = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'
                        ? el.value : (el.innerText || el.textContent || '');
                    inputHasText = !!String(t).trim();
                    break;
                }
            } catch { /* 跳过 */ }
        }
        let userMsgs = 0;
        for (const sel of userSels) {
            try { userMsgs += document.querySelectorAll(sel).length; } catch { /* 跳过 */ }
        }
        return { inputHasText, userMsgs };
    }, INPUT_SELECTORS, USER_MSG_SELECTORS).catch(() => ({ inputHasText: true, userMsgs: 0 }));

    // 触发发送 + 发送校验 + 按强度递增重试（2026-10-04 重构）：
    //   1) CDP 鼠标点击发送按钮（真实事件流，算用户手势）；
    //   2) 校验"已发出"（见 verifyMessageSent），未发出再点一次；
    //   3) 仍不行 → CDP 键盘 Enter；最后页内合成 Enter 兜底（窗口状态
    //      无关，对旧版 DOM 有效）。全部失败则明确报错上抛——面板可见，
    //      不再静默卡住。历史教训（2026-10-03 初版只点一次不校验）：
    //      窗口后台化时页面被遮挡检测标记 hidden、输入管线冻结，点击被
    //      静默吞掉——文字停在输入框直到用户切回窗口；遮挡问题已由启动
    //      参数根治（webBridgeManager chromeArgs），这条链兜住残余时序
    let sent = false;
    const clicked = await clickSendButton(page).catch(() => false);
    if (clicked) sent = await verifyMessageSent(page, baseline);
    if (!sent) {
        console.warn('[WebBridge][doubao] 首次点击未确认发送，重试点击');
        if (await clickSendButton(page).catch(() => false)) {
            sent = await verifyMessageSent(page, baseline);
        }
    }
    if (!sent) {
        console.warn('[WebBridge][doubao] 点击仍未确认发送，升级 CDP 键盘 Enter');
        await sendByKeyboard(page).catch(() => {});
        sent = await verifyMessageSent(page, baseline);
    }
    if (!sent) {
        console.warn('[WebBridge][doubao] CDP 回车仍未确认发送，页内合成 Enter 兜底');
        await page.evaluate(() => {
            const el = document.activeElement || document.querySelector('textarea');
            if (!el) return;
            el.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
            }));
        });
        sent = await verifyMessageSent(page, baseline);
    }
    if (!sent) {
        throw new Error('发送未生效：多次触发后消息仍未发出（输入框文字未被清空、也无新用户消息）');
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
 * 找块逻辑来自 base.js 共享源码；文本取"剔除推荐区/操作栏后的正文"
 * （推荐追问单独走 suggestions 字段，时间戳行按格式过滤）
 */
async function extractReply(page) {
    const fn = new Function('replySels', 'listSels', 'userSels', 'suggestSels', 'stripSels', 'cardSels', `
        const block = (${FIND_BLOCK_SRC})(replySels, listSels, userSels);
        if (!block) return null;

        // 时间戳行过滤："今天 22:39" / "昨天 10:00" / "22:39" 独行时剔除；
        // 播放器控件行过滤：视频卡被点开后播放器控件文字（重播/全屏等）
        // 会混进 innerText，独行的控件词剔除；"直播"是播放器徽标（真机
        // 踩坑：混进正文使文本基线变化，巡逻误当新消息重复交付）；时长
        // 显示"00:04 / 00:04"拆行后数字被上面的时间戳正则滤掉，孤立的
        // 分隔符行（纯 / | · - 等符号）一并剔除
        const isNoiseLine = (line) => {
            const t = line.trim();
            if (/^\\s*(今天|昨天|前天)?\\s*\\d{1,2}:\\d{2}\\s*$/.test(t)) return true;
            if (/^\\s*\\d{1,2}:\\d{2}\\s*\\/\\s*\\d{1,2}:\\d{2}\\s*$/.test(t)) return true;
            if (/^[\\/|·•\\-—_\\s]*$/.test(t)) return true;
            return /^(重播|播放|暂停|继续播放|进入全屏|退出全屏|全屏|静音|取消静音|倍速|连播|小窗播放|点击按住可拖动视频|按住可拖动视频|拖动视频|直播)$/.test(t);
        };

        // 内容图片：跳过头像/表情等小图与 data URL；跳过视频容器内的封面图
        // （视频卡的 poster 也是大图，不排除会被当内容图误收）；同图多 <img>
        // 按精确 src 与 URL 路径两级去重
        const pickImages = (root) => {
            const out = [];
            const seenSrc = new Set();
            const seenPath = new Set();
            for (const img of Array.from(root.querySelectorAll('img'))) {
                const src = img.src;
                if (img.naturalWidth < 200 || !src || src.startsWith('data:')) continue;
                try { if (img.closest('[class*="video"]')) continue; } catch (e) { /* 跳过 */ }
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
        // fetch，且会阻塞管理器的网络捕获兜底）；播放器常渲染在回复块外的
        // 弹层，这里块内找不到属正常，管理器会用捕获的 CDN 直链兜底。
        // 每个 <video> 元素只取一个直链：video 内部的多清晰度 <source>
        // 是同一视频的不同档位，全收会把一个视频重复交付多次（真机踩坑）
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

        // 推荐追问：容器候选命中后取其可点击子项的短文本（≤40 字，去重）
        const pickSuggestions = (root) => {
            for (const sel of suggestSels) {
                try {
                    const box = root.querySelector(sel);
                    if (!box) continue;
                    const items = Array.from(box.querySelectorAll(
                        'button, [role="button"], a, div[class*="item"], span[class*="item"]'
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
            // 正文提取：克隆后剔除推荐区/操作栏等干扰节点再取 innerText
            // （克隆操作不影响页面本身），最后按行过滤时间戳残留
            const clone = block.cloneNode(true);
            stripSels.forEach((sel) => {
                try { clone.querySelectorAll(sel).forEach((el) => el.remove()); } catch (e4) { /* 跳过 */ }
            });
            text = (clone.innerText || '').split('\\n')
                .filter((line) => line.trim() && !isNoiseLine(line))
                .join('\\n').trim();
        } catch (e5) {
            text = (block.innerText || '').trim();
        }
        // 视频播放卡计数（可见元素）：豆包视频常在文本定稿后"无文本变化"
        // 地渲染进同一回复块（播放器控件词还会被噪声过滤），文本基线感知
        // 不到——卡数进视频签名，管理器据此触发补交付
        let videoCardCount = 0;
        try {
            videoCardCount = Array.from(block.querySelectorAll(cardSels.join(',')))
                .filter((el) => el.offsetParent !== null).length;
        } catch (e6) { /* 非法选择器跳过 */ }

        return {
            text,
            suggestions,
            imageUrls: pickImages(block),
            videoUrls: pickVideos(block),
            videoCardCount
        };
    `);
    return page.evaluate(fn, REPLY_SELECTORS, LIST_SELECTORS, USER_MSG_SELECTORS,
        SUGGESTION_SELECTORS, STRIP_SELECTORS, VIDEO_CARD_SELECTORS).catch((err) => {
            console.warn('[WebBridge][doubao] extractReply 求值失败:', err && err.message);
            return null;
        });
}

/**
 * 检测站点是否在进行生图/生视频等长任务（base.js 契约可选方法）：
 * 只扫"最新回复块"内部的骨架屏/进度候选与短状态文本——不扫全页，
 * 避免把历史回复里含有"生成中"字样的叙述误判为进行中任务。
 * 返回 { active, text }，text 为进度描述（如"50%"、"视频生成中"）
 */
async function detectTask(page) {
    const fn = new Function('replySels', 'listSels', 'userSels', 'hintSels', 'textReSource', `
        const re = new RegExp(textReSource);
        const block = (${FIND_BLOCK_SRC})(replySels, listSels, userSels);
        if (!block) return { active: false, text: '' };
        // 骨架屏/进度区候选：可见且文本命中任务特征
        for (const sel of hintSels) {
            try {
                for (const el of block.querySelectorAll(sel)) {
                    if (el.offsetParent === null) continue;
                    const t = (el.innerText || '').trim();
                    if (t && t.length <= 60 && re.test(t)) return { active: true, text: t.slice(0, 40) };
                    // 骨架屏常无文本：候选命中且可见即视为进行中
                    if (!t) return { active: true, text: '生成中…' };
                }
            } catch (e) { /* 跳过 */ }
        }
        // 短状态文本扫描（限块内小元素，如"50%"状态条）
        try {
            for (const el of block.querySelectorAll('div, span, button')) {
                if (el.offsetParent === null || el.children.length > 2) continue;
                const t = (el.innerText || '').trim();
                if (t && t.length <= 40 && re.test(t)) return { active: true, text: t.slice(0, 40) };
            }
        } catch (e2) { /* 跳过 */ }
        return { active: false, text: '' };
    `);
    return page.evaluate(fn, REPLY_SELECTORS, LIST_SELECTORS, USER_MSG_SELECTORS,
        TASK_HINT_SELECTORS, TASK_TEXT_RE.source).catch(() => ({ active: false, text: '' }));
}

/**
 * 触发视频加载（base.js 契约可选方法）：在最新回复块里找到视频播放卡并
 * 模拟点击（优先播放按钮子元素，避免整卡点击弹出全屏播放器），随后跨
 * 全部标签页轮询等待 <video> 出现——拿到 src 后立即静音+暂停（只为取
 * 地址，不真播放），并尝试派发 ESC 关闭可能弹出的浮层。页面已有
 * <video> 时直接返回
 */
async function revealVideos(page) {
    const clickFn = new Function('cardSels', 'replySels', 'listSels', 'userSels', `
        const block = (${FIND_BLOCK_SRC})(replySels, listSels, userSels);
        if (!block) return false;
        const video = block.querySelector('video');
        if (video && (video.currentSrc || video.src)) {
            video.muted = true;
            return true;   // 已有视频元素，无需点击
        }
        // 优先点播放按钮状子元素，其次整卡
        for (const sel of ['[class*="play-btn"]', '[class*="playBtn"]', '[class*="play-button"]', '[class*="play"]']) {
            try {
                const btn = block.querySelector(sel);
                if (btn && btn.offsetParent !== null) { btn.click(); return true; }
            } catch (e) { /* 跳过 */ }
        }
        for (const sel of cardSels) {
            try {
                const card = block.querySelector(sel);
                if (card && card.offsetParent !== null) { card.click(); return true; }
            } catch (e2) { /* 跳过 */ }
        }
        return false;
    `);
    const clicked = await page.evaluate(clickFn, VIDEO_CARD_SELECTORS,
        REPLY_SELECTORS, LIST_SELECTORS, USER_MSG_SELECTORS).catch(() => false);

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
                // 点整卡可能弹出全屏播放器：尝试 ESC 关闭浮层（拿完地址就还页面原状）
                await page.keyboard.press('Escape').catch(() => {});
                return true;
            }
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

/**
 * 图片原图候选（base.js 契约可选方法）：豆包 CDN（字节 tos 系）URL 常带
 * `~tplv-<模板id>:resize:384:384` 模板段——回复块里的 <img> 是缩略变体。
 * 候选按命中概率排序：
 *   1) 只剥缩放参数、保留模板 id（`…tplv-xxx:resize:384:384.image` →
 *      `…tplv-xxx.image`）——模板 id 仍参与路由，最不易失效；
 *   2) 剥掉整个模板段（签名若未覆盖 tplv 段时有效）；
 *   3) 原 URL 兜底。
 * 管理器逐候选下载并按实际像素取最大者，失败候选自动跳过
 */
function imageVariants(url) {
    const variants = [];
    // 剥法一（最优先）：只剥 tplv 模板段内的操作参数（:resize:384:384 等），
    // 保留模板 id——模板 id 仍参与 CDN 路由，最不易失效
    const opsStripped = url.replace(/(~tplv-[^:~.?]+):[^?]*?(?=\.)/, '$1');
    if (opsStripped !== url) variants.push(opsStripped);
    // 剥法二：模板段以伪扩展名前的 "." 结尾（…~tplv-a:384:384.image → ….image 保留伪扩展）
    const cutAtDot = url.replace(/~tplv-[^?]*?(?=\.)/, '');
    if (cutAtDot !== url) variants.push(cutAtDot);
    // 剥法三：整个模板段连同伪扩展一起剥掉
    const cutAll = url.replace(/~tplv-[^?]*/, '');
    if (cutAll !== url) variants.push(cutAll);
    // 原 URL 兜底
    variants.push(url);
    return [...new Set(variants)];
}

/**
 * 触发大图加载（base.js 契约可选方法）：逐张点击回复块内的内容图片
 * 打开大图预览——页面会请求原始尺寸 URL（管理器的网络捕获钩子按路径
 * 基键记下），每张 1.5s 后 ESC 关闭再点下一张。回复块内没有内容图时
 * 返回 false，不影响交付流程
 */
async function revealImages(page) {
    const countFn = new Function('replySels', 'listSels', 'userSels', `
        const block = (${FIND_BLOCK_SRC})(replySels, listSels, userSels);
        if (!block) return 0;
        return Array.from(block.querySelectorAll('img'))
            .filter((img) => img.naturalWidth >= 200 && img.src && !img.src.startsWith('data:'))
            .filter((img) => {
                try { return !img.closest('[class*="video"]'); } catch (e) { return false; }
            }).length;
    `);
    const count = await page.evaluate(countFn, REPLY_SELECTORS,
        LIST_SELECTORS, USER_MSG_SELECTORS).catch(() => 0);
    if (!count) return false;

    const clickNthFn = new Function('replySels', 'listSels', 'userSels', 'n', `
        const block = (${FIND_BLOCK_SRC})(replySels, listSels, userSels);
        if (!block) return false;
        const imgs = Array.from(block.querySelectorAll('img'))
            .filter((img) => img.naturalWidth >= 200 && img.src && !img.src.startsWith('data:'))
            .filter((img) => {
                try { return !img.closest('[class*="video"]'); } catch (e) { return false; }
            });
        if (n >= imgs.length) return false;
        const img = imgs[n];
        if (img.scrollIntoViewIfNeeded) img.scrollIntoViewIfNeeded();
        img.click();
        return true;
    `);
    // 逐张：点开 → 等原图请求发出并被捕获 → ESC 关闭 → 下一张
    for (let n = 0; n < Math.min(count, 4); n++) {
        await page.evaluate(clickNthFn, REPLY_SELECTORS, LIST_SELECTORS, USER_MSG_SELECTORS, n).catch(() => {});
        await new Promise((r) => setTimeout(r, 1500));
        await page.keyboard.press('Escape').catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
    }
    return true;
}

module.exports = {
    id: 'doubao',
    name: '豆包',
    homeUrl: 'https://www.doubao.com/chat/',
    urlPattern: /doubao\.com/,
    ready: true,   // 首次实测后如有定位失败，改上方候选清单即可
    findInput,
    sendMessage,
    isGenerating,
    extractReply,
    detectTask,
    imageVariants,
    revealVideos,
    revealImages,
    stopGeneration
};
