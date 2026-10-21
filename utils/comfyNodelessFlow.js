/**
 * ==========================================================================
 * Comfy 免节点双通道（comfyNodelessFlow）
 * ==========================================================================
 * 双模式仲裁的纯函数层 + history 轮询/下载助手。
 *
 * 背景：画布图片进出 ComfyUI 原本只认自定义节点（工作流里摆
 * LumenReceiveImageFromCanvas / LumenSendImageRealtime，且 ComfyUI 侧
 * 必须装 lumen_nodes）。不摆节点的用户走不了这条链路。本模块支撑
 * "节点继续用、没节点也能传"的双模式（提交前一次扫描仲裁两方向）：
 *   - 输入：无 Receive 节点时，把画布图经原生 /upload/image 传进
 *     ComfyUI 后改写 LoadImage 节点的 image 输入（恰好 1 个才自动，
 *     0 个 / 多个不猜——见 decideImageInject）；
 *   - 输出：无 Send 节点时，轮询原生 /history/{promptId} 拿输出文件
 *     清单，经 /view 下载后由路由层推画布（视频工作流不适用，仍走
 *     节点路径或提示安装节点）。
 *
 * 设计红线：改写只碰 class_type 白名单（LoadImage），改不动/不确定就
 * 回落节点链路并如实上报——宁可不注入也不静默错图（ADR 006 同哲学）。
 * ==========================================================================
 */

/** 画布取图/回传节点类名（与 lumen_nodes 一致） */
const RECEIVE_NODE_CLASS = 'LumenReceiveImageFromCanvas';
const SEND_NODE_CLASSES = ['LumenSendImageRealtime', 'LumenSendVideoToCanvas'];

/** LoadImage 白名单：免节点注入只改写这个原生类（子类变体不碰） */
const LOADIMAGE_CLASS = 'LoadImage';

/** 视频输出类关键词（命中则跳过 history 兜底——视频产物结构因节点而异，
 *  一期免节点只覆盖图片；V2V 视频槽位仍走 LumenReceiveVideoFromCanvas） */
const VIDEO_OUTPUT_KEYWORDS = [
    'VHS', 'VideoHelperSuite', 'VideoCombine', 'SaveVideo',
    'SaveAnimated', 'SaveWEBM'
];

/** history 产物中按扩展名剔除的视频文件（免节点回流只推图片） */
const VIDEO_FILE_EXTS = new Set(['.mp4', '.webm', '.mov', '.gif', '.mkv', '.avi']);

/**
 * 扫描工作流的画布流双通道特征（提交链路在 bypass 之后调用——
 * 被忽略的节点不该参与仲裁）
 * @param {Object} graph - 纯 ComfyUI API 格式工作流 { [nodeId]: {class_type,...} }
 * @returns {{hasReceiveNode: boolean, hasSendNode: boolean, hasVideoOutput: boolean, loadImageIds: string[]}}
 */
function scanCanvasFlow(graph) {
    const loadImageIds = [];
    let hasReceiveNode = false;
    let hasSendNode = false;
    let hasVideoOutput = false;
    for (const nodeId in graph) {
        const node = graph[nodeId];
        const cls = node.class_type || node.type || '';
        if (cls === RECEIVE_NODE_CLASS) hasReceiveNode = true;
        if (SEND_NODE_CLASSES.includes(cls)) hasSendNode = true;
        if (VIDEO_OUTPUT_KEYWORDS.some((k) => cls.includes(k))) hasVideoOutput = true;
        if (cls === LOADIMAGE_CLASS) loadImageIds.push(nodeId);
    }
    return { hasReceiveNode, hasSendNode, hasVideoOutput, loadImageIds };
}

/**
 * 免节点输入注入的仲裁：请求带画布图、工作流却没有 Receive 节点时，
 * 决定怎么处置（有 Receive 节点走槽位链路，不进本函数）。
 * @param {{loadImageIds: string[]}} scan - scanCanvasFlow 结果
 * @param {number} imageCount - 请求携带的画布图数量
 * @returns {{mode: 'none'|'auto'|'partial'|'ambiguous', loadImageId?: string, detail: string}}
 *   none      - 没有 LoadImage 可注入（图不会生效，须如实告知）
 *   auto      - 恰好 1 个 LoadImage，注入第 1 张图
 *   partial   - 1 个 LoadImage 但带了多张图（只注入第 1 张，其余没有落点）
 *   ambiguous - 多个 LoadImage，不猜（避免错图；列出节点 id 供人工判断）
 */
function decideImageInject(scan, imageCount) {
    const ids = scan.loadImageIds;
    if (ids.length === 0) {
        return {
            mode: 'none',
            detail: '该工作流没有画布取图节点，也没有 LoadImage 节点，连线图片不会生效' +
                '（可在工作流里添加 LoadImage 或安装 lumen_nodes 取图节点）'
        };
    }
    if (ids.length === 1) {
        return {
            mode: imageCount > 1 ? 'partial' : 'auto',
            loadImageId: ids[0],
            detail: imageCount > 1
                ? `工作流只有 1 个 LoadImage（节点 ${ids[0]}），已注入第 1 张图，其余 ${imageCount - 1} 张没有落点`
                : `已自动把画布图写入 LoadImage 节点 ${ids[0]}`
        };
    }
    return {
        mode: 'ambiguous',
        detail: `该工作流有 ${ids.length} 个 LoadImage 节点（${ids.join('、')}），` +
            '无法自动确定图片去向，本次未注入（可保留节点数 ≤1 或等待后续的手动映射）'
    };
}

/**
 * data URL → 上传载荷（裸 base64 与图片扩展名）
 * @param {string} dataUrl - data:image/png;base64,xxx
 * @returns {{buffer: Buffer, ext: string}}
 */
function dataUrlToUploadPayload(dataUrl) {
    const m = /^data:image\/([a-z0-9.+-]+)[;,]/i.exec(String(dataUrl || ''));
    const sub = m ? m[1].toLowerCase() : 'png';
    const extMap = { jpeg: '.jpg', 'svg+xml': '.svg' };
    const ext = extMap[sub] || `.${sub}`;
    const idx = String(dataUrl || '').indexOf(',');
    const base64 = idx >= 0 ? dataUrl.slice(idx + 1) : String(dataUrl || '');
    return { buffer: Buffer.from(base64, 'base64'), ext };
}

/**
 * 从 /history 条目收集要回流画布的输出文件：
 * 只取 type === 'output'（SaveImage 落盘产物；PreviewImage 的 temp 剔除）、
 * 剔除视频扩展名（免节点回流一期只覆盖图片）
 * @param {Object} historyEntry - /history/{id} 条目的 outputs 字段
 * @returns {Array<{nodeId: string, filename: string, subfolder: string, type: string}>}
 */
function collectOutputFiles(historyEntry) {
    const outputs = historyEntry && typeof historyEntry === 'object' ? historyEntry.outputs : null;
    if (!outputs) return [];
    const files = [];
    const nodeOrder = Object.keys(outputs).sort((a, b) => Number(a) - Number(b));
    for (const nodeId of nodeOrder) {
        const out = outputs[nodeId];
        if (!out || !Array.isArray(out.images)) continue;
        for (const item of out.images) {
            if (!item || item.type !== 'output' || !item.filename) continue;
            const ext = (item.filename.match(/(\.[a-z0-9]+)$/i) || [])[1] || '';
            if (VIDEO_FILE_EXTS.has(ext.toLowerCase())) continue;
            files.push({
                nodeId,
                filename: item.filename,
                subfolder: item.subfolder || '',
                type: item.type
            });
        }
    }
    return files;
}

/**
 * 轮询 /history/{promptId} 直到任务完成（免节点回流的取产物前提）。
 * ComfyUI 在任务结束（成功或失败）时才写入 history 条目——执行中
 * GET 返回空对象，故以"条目出现"为完成信号。
 * @param {string} comfyApiUrl - ComfyUI API 地址
 * @param {string} promptId - 提交返回的任务 id
 * @param {Object} [opts]
 * @param {number} [opts.intervalMs=2500] - 轮询间隔
 * @param {number} [opts.timeoutMs=15*60*1000] - 总超时（视频 excluded 上游，
 *        图片生成一般分钟级；超时按放弃处理，不报错不打扰）
 * @param {Function} [opts.fetchImpl] - 注入 fetch（测试用）
 * @param {Function} [opts.sleepImpl] - 注入 sleep（测试用）
 * @returns {Promise<{status:'done', entry: Object}|{status:'error', message: string}|{status:'timeout'}>}
 */
async function pollHistoryOutputs(comfyApiUrl, promptId, opts = {}) {
    const fetchImpl = opts.fetchImpl || fetch;
    const sleepImpl = opts.sleepImpl || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const intervalMs = opts.intervalMs || 2500;
    const deadline = Date.now() + (opts.timeoutMs || 15 * 60 * 1000);
    // 先查后等：首次查询紧跟提交发出（条目多半还没出现，但省一个间隔）
    while (true) {
        let entry = null;
        try {
            const res = await fetchImpl(`${comfyApiUrl}/history/${encodeURIComponent(promptId)}`);
            if (res.ok) {
                const data = await res.json().catch(() => null);
                entry = data && data[promptId];
            }
        } catch {
            // 单次查询失败（瞬时网络抖动）不算失败，下一轮重试
        }
        if (entry) {
            const statusStr = entry.status && entry.status.status_str;
            if (statusStr === 'error') {
                return { status: 'error', message: 'ComfyUI 执行失败或被中断' };
            }
            // completed 且有 outputs（outputs 为空对象也返回——全部输出节点
            // 被 bypass 的工作流属实存在，避免白等到超时）
            return { status: 'done', entry };
        }
        if (Date.now() >= deadline) break;
        await sleepImpl(intervalMs);
    }
    return { status: 'timeout' };
}

/**
 * 经 /view 下载一个输出文件
 * @param {string} comfyApiUrl
 * @param {{filename: string, subfolder: string, type: string}} item
 * @param {Function} [fetchImpl]
 * @returns {Promise<Buffer>}
 */
async function downloadOutput(comfyApiUrl, item, fetchImpl = fetch) {
    const qs = new URLSearchParams({
        filename: item.filename,
        subfolder: item.subfolder || '',
        type: item.type || 'output'
    });
    const res = await fetchImpl(`${comfyApiUrl}/view?${qs}`);
    if (!res.ok) {
        throw new Error(`下载输出失败 HTTP ${res.status}: ${item.filename}`);
    }
    return Buffer.from(await res.arrayBuffer());
}

module.exports = {
    RECEIVE_NODE_CLASS,
    SEND_NODE_CLASSES,
    LOADIMAGE_CLASS,
    VIDEO_OUTPUT_KEYWORDS,
    VIDEO_FILE_EXTS,
    scanCanvasFlow,
    decideImageInject,
    dataUrlToUploadPayload,
    collectOutputFiles,
    pollHistoryOutputs,
    downloadOutput
};
