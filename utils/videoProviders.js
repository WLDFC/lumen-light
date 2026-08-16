/**
 * ==========================================================================
 * 视频生成任务 HTTP 封装（videoProviders）
 * ==========================================================================
 * 作用：封装火山方舟（豆包 Seedance）视频生成的异步任务协议：
 *   1. createVideoTask  - 提交生成任务，返回 task_id
 *   2. queryVideoTask   - 查询任务状态与结果视频 URL
 *   3. downloadVideo    - 将临时视频 URL 下载到本地磁盘（URL 24h 过期）
 *
 * 协议格式（火山方舟 ARK v3）：
 *   创建：POST {endpoint}/contents/generations/tasks
 *         body: { model, content: [{type:'text',text}, {type:'image_url',...}], ratio?, duration? }
 *         resp: { id: 'task_xxx' }
 *   查询：GET {endpoint}/contents/generations/tasks/{id}
 *         resp: { status: 'queued|running|succeeded|failed|...', content: { video_url } }
 *
 * 设计要点：
 *   - 与 llmProviders.js 平行独立，不干扰现有聊天/生图链路；
 *   - 仅依赖 Node 内置模块（https/http/fs），零新增依赖；
 *   - 图片输入支持 base64 data URL（前端画布/聊天附件直传）。
 * ==========================================================================
 */

const https = require('https');
const http = require('http');
const fs = require('fs').promises;
const path = require('path');

/**
 * 发起 JSON HTTP 请求（Promise 化）
 * @param {string} url - 完整请求地址
 * @param {Object} options - { method, headers, body }
 * @returns {Promise<{status: number, data: Object}>}
 */
function requestJson(url, options = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const client = parsed.protocol === 'https:' ? https : http;
        const payload = options.body ? JSON.stringify(options.body) : null;

        const req = client.request(parsed, {
            method: options.method || 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...(options.headers || {})
            }
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let data = null;
                try { data = JSON.parse(raw); } catch { data = { raw }; }
                resolve({ status: res.statusCode, data });
            });
        });

        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('请求超时')); });
        if (payload) req.write(payload);
        req.end();
    });
}

/**
 * 创建视频生成任务
 * @param {Object} provider - { endpoint, apiKey }
 * @param {Object} params
 * @param {string} params.model - 模型 ID（如 doubao-seedance-1-0-lite-i2v-250428）
 * @param {string} params.prompt - 视频描述文本
 * @param {string} [params.imageUrl] - 首帧图片（data URL 或 http URL），图生视频时必传
 * @param {string} [params.ratio] - 宽高比（如 '16:9'、'9:16'、'1:1'）
 * @param {number} [params.duration] - 时长（秒）
 * @returns {Promise<string>} 任务 ID
 */
async function createVideoTask(provider, { model, prompt, imageUrl, ratio, duration }) {
    const base = provider.endpoint.replace(/\/+$/, '');
    const url = `${base}/contents/generations/tasks`;

    // 构建 content 数组：文本 + 可选首帧图片
    const content = [{ type: 'text', text: prompt }];
    if (imageUrl) {
        content.push({
            type: 'image_url',
            image_url: { url: imageUrl },
            role: 'first_frame'
        });
    }

    const body = { model, content };
    if (ratio) body.ratio = ratio;
    if (duration) body.duration = duration;

    const { status, data } = await requestJson(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        body
    });

    if (status !== 200 || !data.id) {
        const msg = data.error?.message || data.message || data.raw || `HTTP ${status}`;
        throw new Error(`创建视频任务失败: ${msg}`);
    }
    return data.id;
}

/**
 * 查询视频生成任务状态
 * @param {Object} provider - { endpoint, apiKey }
 * @param {string} taskId - 任务 ID
 * @returns {Promise<{status: string, videoUrl: string|null, error: string|null}>}
 *   status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired'
 */
async function queryVideoTask(provider, taskId) {
    const base = provider.endpoint.replace(/\/+$/, '');
    const url = `${base}/contents/generations/tasks/${encodeURIComponent(taskId)}`;

    const { status, data } = await requestJson(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${provider.apiKey}` }
    });

    if (status !== 200) {
        const msg = data.error?.message || data.message || `HTTP ${status}`;
        throw new Error(`查询视频任务失败: ${msg}`);
    }

    return {
        status: data.status || 'queued',
        videoUrl: data.content?.video_url || null,
        error: data.error?.message || null
    };
}

/**
 * 下载视频文件到本地磁盘
 * @param {string} videoUrl - 远程视频 URL（临时签名地址）
 * @param {string} destDir - 目标目录
 * @param {string} [filename] - 文件名（默认按时间戳生成）
 * @returns {Promise<string>} 相对路径（如 data/videos/xxx.mp4）
 */
async function downloadVideo(videoUrl, destDir, filename) {
    await fs.mkdir(destDir, { recursive: true });
    const name = filename || `video_${Date.now()}.mp4`;
    const destPath = path.join(destDir, name);

    await new Promise((resolve, reject) => {
        const parsed = new URL(videoUrl);
        const client = parsed.protocol === 'https:' ? https : http;
        const req = client.get(videoUrl, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`视频下载失败，状态码: ${res.statusCode}`));
                return;
            }
            const ws = require('fs').createWriteStream(destPath);
            res.pipe(ws);
            ws.on('finish', resolve);
            ws.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(120000, () => { req.destroy(); reject(new Error('视频下载超时')); });
    });

    // 返回相对于项目根目录的路径
    return path.relative(path.join(__dirname, '..'), destPath).replace(/\\/g, '/');
}

module.exports = { createVideoTask, queryVideoTask, downloadVideo };
