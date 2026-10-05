/**
 * ==========================================================================
 * LumenLight 网页桥接：回合轮询状态机（turnWatcher）
 * ==========================================================================
 * 从 WebBridgeManager 拆出的统一轮询循环：主回合（用户发消息后捕获回复）
 * 与异步产物看护（豆包视频"稍后另发一条"的投递捕捉）共用同一套
 * "文本轮询 → 稳定判定（含确认复检与任务检测）"逻辑——此前是两份相似
 * 实现，每次改轮询规则都要记得改两处（已经漏过一次）。
 *
 * 职责边界：本模块只做"轮询与判定"，不做资源下载/事件落地——那些由
 * 管理器的交付环节处理；本模块通过 emit 上报 stream_text / task_progress。
 * ==========================================================================
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 稳定复检宽限：首稳后隔此时长再确认一次才收尾（给晚到的图片一个到达窗口） */
const CONFIRM_STABLE_MS = 1200;

/**
 * 回复快照的内容键：文本 + 图片/视频 URL（URL 去掉 query 防签名参数
 * 抖动）。以此判定"内容是否变化"——文本为中心的旧判定漏掉纯图回复
 * （真机踩坑：ChatGPT 的生图回复没有正文，旧门禁整轮当"没抓到回复"）
 */
function contentKeyOf(reply) {
    if (!reply) return '';
    const text = (reply.text || '').trim();
    const urls = [
        ...(Array.isArray(reply.imageUrls) ? reply.imageUrls : []),
        ...(Array.isArray(reply.videoUrls) ? reply.videoUrls : [])
    ].map((u) => String(u).split('?')[0]);
    return [text, ...urls].filter(Boolean).join('\n');
}

/**
 * 运行一轮轮询直到"文本稳定且非生成中且无进行中任务"或让位/超时
 * @param {Object} opts
 * @param {Object} opts.page - puppeteer Page
 * @param {Object} opts.adapter - 站点适配器（base.js 契约）
 * @param {Function} opts.emit - 事件出口（stream_text / task_progress）
 * @param {string} [opts.knownText=''] - 已知文本（异步看护模式传入上一轮
 *      交付文本，仅捕获其后的新内容）；空 = 主回合从头捕获
 * @param {string} [opts.baselineKey=''] - 回合内容基线键（contentKeyOf 生成）：
 *      主回合在**发送前**对页面最新回复快照的键——新回复未渲染时页面上的
 *      最新助手块仍是上一轮内容，不做基线比对会把旧图当本轮新内容提前
 *      交付（真机踩坑）。轮询只认与基线键不同的快照；看护模式不传，
 *      退化为 knownText 文本基线
 * @param {number} [opts.timeoutMs] - 总时长上限，超时抛错
 * @param {number} [opts.pollMs=700] - 轮询间隔（异步看护用低频 3000）
 * @param {number} [opts.stableMs=2500] - 文本稳定窗口
 * @param {number} [opts.firstReplyGraceMs=0] - >0 时：超此时长仍未捕获到
 *      任何回复则报错（主回合 30s；异步看护传 0，静默等下一份投递）
 * @param {Function} [opts.superseded] - 让位判定（主回合：中止标志；
 *      异步看护：seq 变化或新回合启动）。返回 true 时立即结束
 * @param {boolean} [opts.withTaskDetection=true] - 是否运行适配器的
 *      detectTask（生图/生视频进行中检测）
 * @returns {Promise<{text: string, reply: Object, suggestions: string[]}|{superseded: true, text: string}>}
 */
async function runTurnLoop({
    page,
    adapter,
    emit,
    knownText = '',
    baselineKey = '',
    timeoutMs,
    pollMs = 700,
    stableMs = 2500,
    firstReplyGraceMs = 0,
    superseded = () => false,
    withTaskDetection = true
}) {
    const startedAt = Date.now();
    let lastText = knownText;
    // 内容键基线：主回合传发送前快照键；未传退化为 knownText 文本基线
    // （异步看护的旧行为）。sawReply 语义 = "已见到与基线不同的内容"，
    // 有基线键时初始为 false，基线内的旧内容不解除首答宽限计时
    let lastKey = baselineKey || knownText.trim();
    let lastChangeAt = Date.now();
    let sawReply = !baselineKey && knownText !== '';
    let finalReply = null;
    let lastSuggestions = [];
    let lastTaskText = '';
    let confirmStable = false;

    // 任务检测为适配器可选能力（base.js detectTask），未实现按无任务处理
    const detectTask = withTaskDetection && typeof adapter.detectTask === 'function'
        ? adapter.detectTask.bind(adapter)
        : null;

    while (true) {
        if (superseded()) return { superseded: true, text: lastText };
        if (timeoutMs && Date.now() - startedAt > timeoutMs) {
            throw new Error('回合超时（未在时限内捕获到稳定回复）');
        }
        if (page.isClosed()) {
            throw new Error('站点标签页已关闭，回合中断');
        }

        const reply = await adapter.extractReply(page);
        const key = contentKeyOf(reply);
        // 有实质内容（文本或图片/视频 URL）且内容有变化：记为新快照。
        // finalReply 非空 = 至少见过一次与基线不同的新内容——页面还停在
        // 基线内容（key === lastKey，新回复未渲染）时不得走"稳定收尾"，
        // 否则会把上一轮内容当本轮结果提前交付（真机踩坑）
        if (key && key !== lastKey) {
            sawReply = true;
            lastKey = key;
            lastText = reply.text || '';
            lastChangeAt = Date.now();
            finalReply = reply;
            if (Array.isArray(reply.suggestions) && reply.suggestions.length) {
                lastSuggestions = reply.suggestions;
            }
            // 全量文本（非增量）：面板直接覆盖当前气泡；纯图回复无文本
            // 不发流式事件（图片在收尾交付环节统一落），避免清空气泡
            if (lastText) {
                emit({ type: 'stream_text', site: adapter.id, text: lastText });
            }
        }
        if (key && finalReply) {

            // 任务检测（生图/生视频）：进行中则推送进度并保持回合，
            // 不进入"文本稳定=完成"判定——正文早停了图可能还没出
            if (detectTask) {
                const task = await detectTask(page);
                if (task && task.active) {
                    const pt = (task.text || '').trim() || '生成中…';
                    if (pt !== lastTaskText) {
                        lastTaskText = pt;
                        emit({ type: 'task_progress', site: adapter.id, text: pt });
                    }
                    lastChangeAt = Date.now();   // 任务期间顺延稳定基准
                    await sleep(pollMs);
                    continue;
                }
            }

            const generating = await adapter.isGenerating(page);
            const stable = Date.now() - lastChangeAt > stableMs;
            if (stable && !generating) {
                // 复检一次：给"文本已稳定、图片刚渲染进 DOM"的场景一个
                // 到达窗口（生图正文早停、图片晚到是常态）
                if (!confirmStable) {
                    confirmStable = true;
                    await sleep(CONFIRM_STABLE_MS);
                    continue;
                }
                return { text: lastText, reply: finalReply, suggestions: lastSuggestions };
            }
            confirmStable = false;
        } else {
            // 尚未捕获到新内容（页面可能还在生成，纯图生成长时间零内容
            // 是常态）：站点生成中/有进行中任务时保持等待并顺延首答宽限
            // ——旧版这些检测只在"已捕获内容"分支里跑，纯图生成 >30s 就
            // 会被首答宽限误杀（真机踩坑：报"未捕获到回复"后靠巡逻补交付）
            let busy = false;
            try { busy = await adapter.isGenerating(page); } catch { /* 判定不了按非生成中 */ }
            if (!busy && detectTask) {
                try {
                    const task = await detectTask(page);
                    if (task && task.active) {
                        busy = true;
                        const pt = (task.text || '').trim() || '生成中…';
                        if (pt !== lastTaskText) {
                            lastTaskText = pt;
                            emit({ type: 'task_progress', site: adapter.id, text: pt });
                        }
                    }
                } catch { /* 判定不了按非生成中 */ }
            }
            if (busy) {
                await sleep(pollMs);
                continue;
            }
            if (!sawReply && firstReplyGraceMs > 0 && Date.now() - startedAt > firstReplyGraceMs) {
                throw new Error('发送后未捕获到回复（输入框/消息块定位可能失效，需校准适配器）');
            }
        }
        await sleep(pollMs);
    }
}

module.exports = { runTurnLoop, contentKeyOf };
