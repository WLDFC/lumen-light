/**
 * ==========================================================================
 * dashscope-image 适配器：阿里云百炼原生图像接口
 * ==========================================================================
 * 协议：百炼的 OpenAI 兼容模式没有 /images/generations 端点（实测 404），
 *       图像模型走原生接口——分两代：
 *       qwen-image 2.0/3.0 系（生成编辑融合模型）：同步
 *               POST /api/v1/services/aigc/multimodal-generation/generation
 *               （qwen-vl 消息格式：纯 text 消息=文生图，图片在前文本在后=编辑）
 *       wanx 系（万相）：老异步任务
 *               POST /api/v1/services/aigc/text2image/image-synthesis
 *               （X-DashScope-Async: enable）→ 轮询 GET /api/v1/tasks/{task_id}
 * 尺寸：前端 "宽x高" → 百炼 "宽*高"（星号分隔）；auto 不传走 API 默认。
 * 命中：provider 端点域名含 dashscope（精确命中，不误伤走 OpenAI 兼容
 *       协议转发 qwen-image 的中转站——那些继续由兜底适配器处理）。
 * 结果：返回的 OSS 签名 URL 有时效（约 24h），即时展示/落画布无碍，
 *       长期保存仍需走添加到资产等持久化路径。
 * ==========================================================================
 */

const DASHSCOPE_HOST_KEYWORD = 'dashscope';
const SUBMIT_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 300000; // 文生图一般 10~30s，5 分钟兜底

/** 前端 "宽x高" → 百炼 "宽*高"；auto/无法解析返回 null（走 API 默认尺寸） */
function mapSize(size) {
    if (!size || size === 'auto') return null;
    const m = /^(\d{2,5})\s*[xX×]\s*(\d{2,5})$/.exec(String(size).trim());
    return m ? `${m[1]}*${m[2]}` : null;
}

/** 带中止透传的 JSON 请求；非 2xx 时把百炼的 message 与请求 URL 拼进错误 */
async function fetchJson(url, options, signal) {
    const resp = await fetch(url, { ...options, signal });
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON 按空处理 */ }
    if (!resp.ok) {
        const msg = data?.message || data?.error?.message || '无响应体';
        throw new Error(`百炼图像接口错误（HTTP ${resp.status}）：${msg}［${url}］`);
    }
    return data;
}

function assertLive(signal) {
    if (signal?.aborted) {
        const err = new Error('图像生成已中止');
        err.name = 'AbortError';
        throw err;
    }
}

module.exports = {
    id: 'dashscope-image',
    mode: 'sync', // 对路由层表现为一次调用等结果，异步轮询封装在适配器内部

    /**
     * 端点域名判定：百炼端点（含北京 dashscope.aliyuncs.com 与
     * 新加坡 dashscope-intl.aliyuncs.com）一律走原生接口
     * @param {Object} context - { model, imageList, provider }
     * @returns {boolean}
     */
    match(context) {
        const endpoint = context?.provider?.config?.endpoint || '';
        return endpoint.includes(DASHSCOPE_HOST_KEYWORD);
    },

    /**
     * 执行百炼图像生成（文生图异步任务 / 图生图同步编辑）
     * @param {Object} request - { model, prompt, size, images, provider, signal }
     * @returns {Promise<{imageSrc: string}>}
     */
    async run(request) {
        const { model, prompt, size, images, provider, signal } = request;
        const apiKey = provider.config.apiKey;
        // 兼容端点与原生端点同源，从 endpoint 推 origin 再拼 /api/v1，
        // 用户填 compatible-mode 路径或原生路径都能正确归一
        const origin = new URL(provider.config.endpoint.trim()).origin;
        const apiBase = `${origin}/api/v1`;

        if (images && images.length > 0) {
            return this._runMultimodal(apiBase, apiKey, model, prompt, images, signal);
        }
        // wanx 系走老异步任务端点；qwen-image 系（2.0/3.0 生成编辑融合模型）
        // 走 multimodal-generation 同步端点——纯 text 消息即文生图
        //（实测 qwen-image-3.0 打 text2image 端点会返回 400 url error）
        if (/^wanx/i.test(model)) {
            return this._runTextToImage(apiBase, apiKey, model, prompt, size, signal);
        }
        return this._runMultimodal(apiBase, apiKey, model, prompt, [], signal, size);
    },

    /**
     * 文生图：提交异步任务 → 轮询至完成 → 取第一张结果 URL
     */
    async _runTextToImage(apiBase, apiKey, model, prompt, size, signal) {
        const submitUrl = `${apiBase}/services/aigc/text2image/image-synthesis`;
        const parameters = { n: 1, watermark: false };
        const mapped = mapSize(size);
        if (mapped) parameters.size = mapped;

        const submitResp = await fetchJson(submitUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'X-DashScope-Async': 'enable'
            },
            body: JSON.stringify({ model, input: { prompt: prompt || '' }, parameters })
        }, signal);

        const taskId = submitResp?.output?.task_id;
        if (!taskId) {
            throw new Error('百炼未返回任务 id，无法轮询生成结果');
        }

        const taskUrl = `${apiBase}/tasks/${taskId}`;
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        while (Date.now() < deadline) {
            assertLive(signal);
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            assertLive(signal);

            const taskResp = await fetchJson(taskUrl, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${apiKey}` }
            }, signal);
            const output = taskResp?.output || {};
            const status = output.task_status;

            if (status === 'SUCCEEDED') {
                const url = output.results?.[0]?.url;
                if (!url) throw new Error('百炼任务完成但未返回图片 URL');
                return { imageSrc: url };
            }
            if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
                throw new Error(`百炼生成任务${status === 'FAILED' ? '失败' : status === 'CANCELED' ? '被取消' : '状态未知'}：${output.message || output.code || status}`);
            }
            // PENDING / RUNNING 继续轮询
        }
        throw new Error('百炼生成任务轮询超时（5 分钟）');
    },

    /**
     * multimodal-generation 同步接口（qwen-vl 消息格式）：
     * 纯 text 消息=文生图（qwen-image 2.0/3.0 系），
     * 图片在前文本在后=图生图/编辑（与 qwen-image-edit 官方示例同构）
     */
    async _runMultimodal(apiBase, apiKey, model, prompt, images, signal, size) {
        const editUrl = `${apiBase}/services/aigc/multimodal-generation/generation`;
        const content = [
            ...images.map((src) => ({ image: src })),
            { text: prompt || '' }
        ];
        // size 仅文生图传入（编辑跟随输入图尺寸）；水印显式关闭
        const parameters = { watermark: false };
        if (!images.length) {
            const mapped = mapSize(size);
            if (mapped) parameters.size = mapped;
        }
        const resp = await fetchJson(editUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model,
                input: { messages: [{ role: 'user', content }] },
                parameters
            })
        }, signal);

        const parts = resp?.output?.choices?.[0]?.message?.content || [];
        const imagePart = parts.find((p) => typeof p.image === 'string' && p.image);
        if (!imagePart) {
            throw new Error('百炼图像生成未返回图片（模型可能拒绝了这个请求）');
        }
        return { imageSrc: imagePart.image };
    }
};
