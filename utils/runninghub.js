/**
 * ==========================================================================
 * RunningHub 云端工作流 API 客户端
 * ==========================================================================
 * 作用：封装 RunningHub 平台（云端 ComfyUI 托管）的 OpenAPI 调用：
 *   1. 提交工作流任务（POST /openapi/v2/run/workflow/{rhWorkflowId}，
 *      Bearer 认证，body 为 nodeInfoList 参数映射）；
 *   2. 查询任务状态与结果（POST /openapi/v2/query，轮询制——平台 webhook
 *      需公网可达的回调地址，本地部署用不了，只能轮询）；
 *   3. 上传素材文件（POST /openapi/v2/media/upload/binary，multipart），
 *      返回的 fileName 回填到工作流的 IMAGE 参数槽位；
 *   4. 任务轮询器（startTaskPolling）：提交成功后由路由层调用，定时查询
 *      直到 SUCCESS/FAILED。成功时把 results 里的文件 URL 立即下载转存
 *      （平台链接仅 24 小时有效，逾期永久失效），图片转 base64 走
 *      new-image、视频存 data/videos/ 走 new-video，全部结果推完后发
 *      generation-complete 完成信号，经 push 回调推给画布——与本地
 *      ComfyUI 的回流消息格式同构，前端落图链路零改动。
 *   5. fetchWorkflowJson：拉取云端工作流 JSON（设置面板「从平台拉取」
 *      一键生成登记卡参数映射的数据源）。
 *
 * 响应兼容：RunningHub 新版接口直接返回顶层字段（{ taskId, status, ... }），
 * 旧版包装为 { code, msg, data: {...} }——本模块统一解包后处理。
 * ==========================================================================
 */

const fsp = require('fs').promises;
const path = require('path');

/** 平台默认端点（设置里留空时使用；支持镜像/代理域名覆盖） */
const DEFAULT_ENDPOINT = 'https://www.runninghub.cn';

/** 任务轮询间隔 */
const POLL_INTERVAL_MS = 5 * 1000;
/** 任务轮询超时（云端生视频可能较慢，放宽到 30 分钟） */
const POLL_TIMEOUT_MS = 30 * 60 * 1000;
/** 结果文件下载超时 */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** 视频类扩展名（outputType 按此分流：走 new-video 落 data/videos/） */
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'gif', 'mkv', 'avi']);

/** 生成结果转存目录（视频与 data/videos 工作区共用，静态服务可直接访问） */
const VIDEOS_DIR = path.join(__dirname, '..', 'data', 'videos');

/**
 * 规整端点地址：去尾部斜杠；空值回退默认端点
 * @param {string} [endpoint] - 用户配置的端点
 * @returns {string}
 */
function normalizeEndpoint(endpoint) {
    const base = String(endpoint || '').trim() || DEFAULT_ENDPOINT;
    return base.replace(/\/+$/, '');
}

/**
 * 统一解包 RunningHub 响应：兼容顶层字段与 { code, msg, data } 两种包装
 * @param {Object} json - 平台响应 JSON
 * @returns {Object} 业务数据对象
 */
function unwrap(json) {
    if (!json || typeof json !== 'object') return {};
    if (json.data && typeof json.data === 'object' && json.code !== undefined) {
        return json.data;
    }
    return json;
}

/**
 * 带超时的 fetch（GET/POST 通用）
 * @param {string} url - 请求地址
 * @param {Object} options - fetch 参数
 * @param {number} timeoutMs - 超时毫秒
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
    return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * 提交工作流任务
 * @param {Object} options
 * @param {string} options.apiKey - RunningHub API Key（32 位）
 * @param {string} [options.endpoint] - 平台端点（空用默认）
 * @param {string} options.rhWorkflowId - 平台工作流 id（api-detail 页 URL 末段数字）
 * @param {Array<{nodeId: string, fieldName: string, fieldValue: string}>} options.nodeInfoList - 参数映射
 * @returns {Promise<{taskId: string}>} 任务 id
 */
async function submitWorkflow({ apiKey, endpoint, rhWorkflowId, nodeInfoList }) {
    // 注意前缀：api-detail 页 curl 实测平台当前启用 /openapi/v2 前缀，
    // 旧文档的 /run/workflow/{id} 已失效（返回 401）
    const url = `${normalizeEndpoint(endpoint)}/openapi/v2/run/workflow/${rhWorkflowId}`;
    const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ nodeInfoList })
    }, 60000);

    const json = await res.json().catch(() => null);
    const data = unwrap(json);
    const taskId = data.taskId || (json && json.taskId);

    if (!res.ok || !taskId) {
        // 平台错误信息优先取业务字段（errorMessage/msg），便于定位
        // 余额不足 / Key 无效 / 内容审核失败等真实原因
        const message = (json && (json.errorMessage || json.msg)) ||
            `提交失败（HTTP ${res.status}）`;
        throw new Error(message);
    }
    return { taskId };
}

/**
 * 查询任务状态与结果
 * @param {Object} options
 * @param {string} options.apiKey - API Key
 * @param {string} [options.endpoint] - 平台端点
 * @param {string} options.taskId - 任务 id
 * @returns {Promise<Object>} { status, results, errorMessage, ... }
 */
async function queryTask({ apiKey, endpoint, taskId }) {
    const url = `${normalizeEndpoint(endpoint)}/openapi/v2/query`;
    const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ taskId })
    }, 30000);

    const json = await res.json().catch(() => null);
    if (!res.ok || !json) {
        throw new Error(`查询任务失败（HTTP ${res.status}）`);
    }
    return unwrap(json);
}

/**
 * 上传素材文件（IMAGE 参数槽位用），返回平台侧 fileName
 * @param {Object} options
 * @param {string} options.apiKey - API Key
 * @param {string} [options.endpoint] - 平台端点
 * @param {string} options.dataUri - 图片 data URI（data:image/png;base64,...）
 * @param {string} [options.filename] - 上传文件名
 * @returns {Promise<string>} 平台文件名（回填 nodeInfoList 的 fieldValue）
 */
async function uploadMedia({ apiKey, endpoint, dataUri, filename = 'image.png' }) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUri || '');
    if (!match) throw new Error('图片数据不是有效的 data URI');
    const isBase64 = !!match[2];
    const buffer = isBase64 ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]));

    const url = `${normalizeEndpoint(endpoint)}/openapi/v2/media/upload/binary`;
    const form = new FormData();
    form.append('file', new Blob([buffer]), filename);

    const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: form
    }, 120000);

    const json = await res.json().catch(() => null);
    const data = unwrap(json);
    const fileName = data && (data.fileName || data.download_url);
    if (!res.ok || (json && json.code !== undefined && json.code !== 0) || !fileName) {
        throw new Error((json && (json.msg || json.message)) || `素材上传失败（HTTP ${res.status}）`);
    }
    return String(fileName);
}

/**
 * 下载结果文件为 Buffer（平台结果 URL 无需鉴权，直接 GET）
 * @param {string} url - 结果文件 URL
 * @returns {Promise<Buffer>}
 */
async function downloadFile(url) {
    const res = await fetchWithTimeout(url, {}, DOWNLOAD_TIMEOUT_MS);
    if (!res.ok) throw new Error(`结果下载失败（HTTP ${res.status}）`);
    return Buffer.from(await res.arrayBuffer());
}

/**
 * 拉取云端工作流 JSON（POST /api/openapi/getJsonApiFormat）。
 * 设置面板「从平台拉取」的数据源：拿到的即云端正在运行的版本，
 * 与手动导出相比天然不存在版本漂移。apiKey 仅在服务端流转
 * @param {Object} options
 * @param {string} options.apiKey - API Key
 * @param {string} [options.endpoint] - 平台端点
 * @param {string} options.workflowId - 平台工作流 id（纯数字字符串）
 * @returns {Promise<Object>} API 格式工作流对象
 */
async function fetchWorkflowJson({ apiKey, endpoint, workflowId }) {
    const url = `${normalizeEndpoint(endpoint)}/api/openapi/getJsonApiFormat`;
    const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ apiKey, workflowId })
    }, 30000);

    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.code !== 0 || !json.data) {
        throw new Error((json && (json.msg || json.message)) || `平台拉取失败（HTTP ${res.status}）`);
    }

    // data.prompt 是 API 格式工作流的 JSON 字符串（实测形态）
    let workflow = json.data.prompt;
    if (typeof workflow === 'string') {
        try { workflow = JSON.parse(workflow); } catch { workflow = null; }
    }
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow) ||
        Object.keys(workflow).length === 0) {
        throw new Error('平台返回的工作流数据为空或格式不符');
    }
    return workflow;
}

/**
 * 汇总平台失败原因：优先取 failedReason 里的具体异常（异常消息 + 节点
 * id/名称），比笼统的 errorMessage（"工作流运行失败"）更能定位问题，
 * 例如 "Value -1 smaller than min of 0（节点 9 RHMiniMaxSampler）"。
 * failedReason 可能是对象或 JSON 字符串，两种形态都兼容
 * @param {Object} data - 查询接口解包后的响应
 * @returns {string} 人类可读的失败原因
 */
function buildFailMessage(data) {
    let fr = data.failedReason;
    if (typeof fr === 'string') {
        try { fr = JSON.parse(fr); } catch { /* 非 JSON 按缺失处理 */ }
    }
    if (fr && fr.exception_message) {
        const where = [fr.node_id ? `节点 ${fr.node_id}` : '', fr.node_name || '']
            .filter(Boolean).join(' ');
        return `工作流运行失败：${fr.exception_message}${where ? `（${where}）` : ''}`;
    }
    return data.errorMessage || '任务失败（平台未返回原因）';
}

/** 活跃轮询任务表（taskId -> { timer, startedAt, target }），防同任务重复轮询 */
const activeTasks = new Map();

/**
 * 启动任务轮询：定时查询直到 SUCCESS/FAILED/超时。
 * 结果处理策略：
 *   - 图片（png/jpg/webp...）：下载转裸 base64 → push('new-image')
 *   - 视频（mp4/webm...）：下载存 data/videos/ → push('new-video')
 *   - 文本：随日志记录，不推画布
 *   - 全部结果推完后 push('generation-complete')：云端任务产出数量不可
 *     知，前端不能用计数判定完成（首个结果就复位会导致后续结果被丢弃），
 *     完成信号由本层统一发出（WS 同连接有序，必然晚于所有结果消息）
 * 失败推 generation-failed；全部处理完毕后自动注销轮询。
 * @param {Object} options
 * @param {string} options.apiKey - API Key
 * @param {string} [options.endpoint] - 平台端点
 * @param {string} options.taskId - 提交返回的任务 id
 * @param {string} [options.target] - 发起生成的画布节点 id（原样随消息回传）
 * @param {{positive: string, negative: string}} [options.prompt] - 生成提示词（随结果回流存档用）
 * @param {Function} options.push - 推送回调 push(type, payload)，由路由层提供（WS 推画布）
 * @returns {void}
 */
function startTaskPolling({ apiKey, endpoint, taskId, target, prompt, push }) {
    const startedAt = Date.now();

    const timer = setInterval(async () => {
        try {
            const data = await queryTask({ apiKey, endpoint, taskId });
            const status = data.status || '';

            if (status === 'SUCCESS') {
                stop();
                await handleResults(data.results || []);
            } else if (status === 'FAILED') {
                stop();
                const message = buildFailMessage(data);
                console.error(`[RunningHub] 任务 ${taskId} 失败: ${message}`);
                push('generation-failed', { target, message });
            } else if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
                stop();
                console.error(`[RunningHub] 任务 ${taskId} 轮询超时（${POLL_TIMEOUT_MS / 60000} 分钟）`);
                push('generation-failed', { target, message: 'RunningHub 任务超时' });
            } else {
                console.log(`[RunningHub] 任务 ${taskId}: ${status || '查询中'}`);
            }
        } catch (err) {
            // 单次查询失败（网络抖动等）不终止轮询，连续失败到超时为止
            console.warn(`[RunningHub] 任务 ${taskId} 查询异常: ${err.message}`);
            if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
                stop();
                push('generation-failed', { target, message: `RunningHub 查询异常: ${err.message}` });
            }
        }
    }, POLL_INTERVAL_MS);

    /** 停止轮询（从活跃表注销 + 清定时器） */
    function stop() {
        clearInterval(timer);
        activeTasks.delete(taskId);
    }

    /**
     * 处理任务结果：按 outputType 分流下载转存后推送画布
     * @param {Array<{url: string, nodeId: string, outputType: string, text: string}>} results
     */
    async function handleResults(results) {
        const promptMeta = {
            positive: (prompt && prompt.positive) || '',
            negative: (prompt && prompt.negative) || ''
        };
        let pushed = 0;
        for (const item of results) {
            if (!item || !item.url) continue;
            const ext = String(item.outputType || path.extname(item.url).replace('.', '') || '').toLowerCase();
            try {
                if (VIDEO_EXTS.has(ext)) {
                    // 视频：转存 data/videos/（与 LLM 视频/本地 ComfyUI 视频同目录），
                    // 推相对路径（静态服务直接可访问）
                    await fsp.mkdir(VIDEOS_DIR, { recursive: true });
                    const safeName = `rh_${Date.now()}_${pushed}.${ext || 'mp4'}`;
                    const buffer = await downloadFile(item.url);
                    await fsp.writeFile(path.join(VIDEOS_DIR, safeName), buffer);
                    push('new-video', {
                        videoUrl: `data/videos/${safeName}`,
                        target,
                        prompt: promptMeta,
                        timestamp: Date.now()
                    });
                    pushed++;
                } else if (ext && ext !== 'txt') {
                    // 图片：下载转裸 base64（与 /api/receive-image 的 image 字段同格式）
                    const buffer = await downloadFile(item.url);
                    push('new-image', {
                        image: buffer.toString('base64'),
                        target,
                        prompt: promptMeta,
                        timestamp: Date.now()
                    });
                    pushed++;
                } else {
                    console.log(`[RunningHub] 任务 ${taskId} 文本输出: ${String(item.text || '').slice(0, 200)}`);
                }
            } catch (err) {
                console.error(`[RunningHub] 任务 ${taskId} 结果转存失败（${item.url}）: ${err.message}`);
            }
        }
        if (pushed === 0) {
            push('generation-failed', { target, message: '任务成功但没有可用的输出文件' });
        } else {
            console.log(`[RunningHub] 任务 ${taskId} 完成，已推送 ${pushed} 个结果到画布`);
            // 完成信号最后发出（WS 同连接有序），驱动节点复位生成态
            push('generation-complete', { target });
        }
    }

    activeTasks.set(taskId, { timer, startedAt, target });
    console.log(`[RunningHub] 开始轮询任务 ${taskId}${target ? `（目标节点 ${target}）` : ''}`);
}

/**
 * 查询活跃任务数（诊断用）
 * @returns {number}
 */
function getActiveTaskCount() {
    return activeTasks.size;
}

module.exports = {
    DEFAULT_ENDPOINT,
    normalizeEndpoint,
    submitWorkflow,
    queryTask,
    uploadMedia,
    downloadFile,
    fetchWorkflowJson,
    startTaskPolling,
    getActiveTaskCount
};
