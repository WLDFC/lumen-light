/**
 * ==========================================================================
 * LLM API 提供商请求库
 * 作用：封装对各类 OpenAI 兼容端点的 HTTP 请求，
 *       包括 chat/completions、/images/generations、/images/edits 以及远程图片代理下载。
 *       路由层只负责参数校验和响应组装，实际网络请求由本文件处理。
 * 响应解析（parseResponseBody，requestJson 与 requestImageEdit 共用）：
 *       1. 按内容编码解压（gzip / deflate / br，个别中转站无视规范硬压缩）；
 *       2. 剥离 UTF-8 BOM 后尝试标准 JSON；
 *       3. 失败则按 SSE 事件流聚合（部分中转站对图像生成接口默认推送
 *          event: started / heartbeat / completed 的进度流），挑选最后一个
 *          携带图片指标的完成事件作为响应对象；
 *       4. 全部失败时，把响应片段拼进错误消息回传前端，便于直接定位。
 * ==========================================================================
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');

/**
 * 将端点地址转换为 chat/completions 请求的 URL 对象
 * 兼容 https://api.example.com/v1 与 https://api.example.com/v1/ 两种写法
 * @param {string} endpoint - API 端点地址
 * @returns {URL} 完整的请求 URL
 */
function buildChatUrl(endpoint) {
    const url = new URL(endpoint.trim());
    url.pathname = url.pathname.replace(/\/$/, '') + '/chat/completions';
    return url;
}

/**
 * 将端点地址转换为图像生成请求的 URL 对象
 * 兼容 https://api.example.com/v1 与 https://api.example.com/v1/ 两种写法
 * @param {string} endpoint - API 端点地址
 * @returns {URL} 完整的请求 URL
 */
function buildImageGenerationUrl(endpoint) {
    const url = new URL(endpoint.trim());
    url.pathname = url.pathname.replace(/\/$/, '') + '/images/generations';
    return url;
}

/**
 * 将端点地址转换为图像编辑请求的 URL 对象
 * OpenAI 系（gpt-image / dall-e）图生图官方端点
 * @param {string} endpoint - API 端点地址
 * @returns {URL} 完整的请求 URL
 */
function buildImageEditUrl(endpoint) {
    const url = new URL(endpoint.trim());
    url.pathname = url.pathname.replace(/\/$/, '') + '/images/edits';
    return url;
}

/**
 * 解压响应体（个别中转站无视 Accept-Encoding 规范主动压缩，Node 原生请求不自动解压）
 * @param {Buffer} buffer - 原始响应体
 * @param {string} encoding - content-encoding 响应头
 * @returns {Buffer} 解压后的响应体（无法解压时按原文返回）
 */
function decodeBody(buffer, encoding) {
    const enc = String(encoding || '').toLowerCase();
    if (!enc || enc === 'identity') return buffer;
    try {
        if (enc.includes('br')) return zlib.brotliDecompressSync(buffer);
        if (enc.includes('gzip')) return zlib.gunzipSync(buffer);
        if (enc.includes('deflate')) return zlib.inflateSync(buffer);
    } catch {
        // 解压失败按原文处理，交给后续解析给出可读错误
    }
    return buffer;
}

/**
 * 判断一个 SSE 事件对象是否携带图片指标（用于挑选生成完成的最终事件，
 * 跳过 started / heartbeat 等进度事件）
 * @param {Object} obj - 解析后的单个 data 载荷
 * @returns {boolean}
 */
function eventHasImage(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (obj.data?.[0]?.url || obj.data?.[0]?.b64_json) return true;   // OpenAI 标准结构
    if (Array.isArray(obj.images) && obj.images.length) return true;  // 部分中转站的 images 数组
    if (obj.url || obj.b64_json || obj.image) return true;            // 扁平的图片字段
    if (Array.isArray(obj.output) && obj.output.length) return true;  // Responses API 风格
    // 结果对象嵌套在 result / response 字段里时再查一层
    for (const key of ['result', 'response']) {
        if (obj[key] && typeof obj[key] === 'object' && eventHasImage(obj[key])) return true;
    }
    return false;
}

/**
 * 把 SSE 事件流文本聚合成单个响应对象
 * 策略：解析所有 data: 行，优先返回最后一个携带图片指标的完成事件；
 * 没有任何事件带图片时返回最后一个解析成功的事件（由上层提取逻辑
 * 给出"模型未返回图片"的明确错误，而不是笼统的解析失败）。
 * @param {string} text - 原始响应文本
 * @returns {Object|null} 聚合结果；不是 SSE 流（没有 data: 行）时返回 null
 */
function tryParseSsePayload(text) {
    if (!text.includes('data:')) return null;
    const candidates = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
            const obj = JSON.parse(payload);
            if (obj && typeof obj === 'object') candidates.push(obj);
        } catch {
            // 非 JSON 的 data 行（如纯文本增量）忽略
        }
    }
    if (!candidates.length) return null;
    for (let i = candidates.length - 1; i >= 0; i--) {
        if (eventHasImage(candidates[i])) return candidates[i];
    }
    return candidates[candidates.length - 1];
}

/**
 * 统一解析 API 响应体（requestJson 与 requestImageEdit 共用）
 * 流程见文件头注释。任何失败都以包含响应片段的错误抛出，
 * 片段随错误消息回传前端，免去翻后端日志定位。
 * @param {Buffer} raw - 原始响应体
 * @param {number} statusCode - HTTP 状态码
 * @param {Object} headers - 响应头（读取 content-encoding）
 * @param {string} errorHint - 错误提示前缀
 * @returns {Object} 解析后的 JSON
 */
function parseResponseBody(raw, statusCode, headers, errorHint) {
    const text = decodeBody(raw, headers && headers['content-encoding'])
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .trim();

    if (!text) {
        throw new Error(`${errorHint}：上游返回空响应（HTTP ${statusCode}）`);
    }

    // 一级：标准 JSON
    try {
        return JSON.parse(text);
    } catch {
        // 继续尝试 SSE 聚合
    }

    // 二级：SSE 事件流聚合
    const sse = tryParseSsePayload(text);
    if (sse) {
        // 流里显式携带错误事件时，透出真实原因（如额度不足、通道故障）
        if (sse.error) {
            throw new Error(sse.error.message || JSON.stringify(sse.error).slice(0, 160));
        }
        return sse;
    }

    // 三级：全部失败，片段回传
    throw new Error(`${errorHint}（HTTP ${statusCode}）：${text.slice(0, 160)}`);
}

/**
 * 发起通用 JSON POST 请求
 * @param {URL} url - 请求地址
 * @param {string} apiKey - API Key
 * @param {string} body - JSON 字符串请求体
 * @param {number} timeout - 超时时间（毫秒）
 * @param {string} errorHint - 解析失败时的错误提示
 * @returns {Promise<Object>} 接口返回的 JSON
 */
function requestJson(url, apiKey, body, timeout, errorHint) {
    const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
        },
        timeout
    };

    return new Promise((resolve, reject) => {
        const client = url.protocol === 'https:' ? https : http;
        const request = client.request(options, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                try {
                    const statusCode = response.statusCode;
                    const json = parseResponseBody(
                        Buffer.concat(chunks), statusCode, response.headers, errorHint
                    );
                    if (statusCode < 200 || statusCode >= 300) {
                        const message = json.error?.message || json.message || `请求失败，HTTP ${statusCode}`;
                        return reject(new Error(message));
                    }
                    return resolve(json);
                } catch (error) {
                    // 响应不是合法 JSON：把解析错误（含响应片段）打进日志，便于定位
                    // （服务商高并发下可能返回空响应 / HTML 错误页 / 被截断的内容）
                    console.error(`⚠️ ${errorHint}: HTTP ${response.statusCode}，${error.message}`);
                    return reject(error);
                }
            });
        });

        request.on('timeout', () => {
            request.destroy();
            reject(new Error('请求超时'));
        });

        request.on('error', (error) => reject(error));

        request.write(body);
        request.end();
    });
}

/**
 * 向 API 提供商发起 chat/completions 请求
 * @param {URL} url - 请求地址
 * @param {string} apiKey - API Key
 * @param {Object} payload - 请求体（OpenAI 兼容格式）
 * @returns {Promise<Object>} 接口返回的 JSON
 */
function requestChatCompletions(url, apiKey, payload) {
    return requestJson(
        url,
        apiKey,
        JSON.stringify(payload),
        120000, // 模型生成可能较慢，给足超时时间
        '解析模型响应失败'
    );
}

/**
 * 向 API 提供商发起图像生成请求
 * @param {URL} url - 请求地址
 * @param {string} apiKey - API Key
 * @param {Object} payload - 请求体
 * @returns {Promise<Object>} 接口返回的 JSON
 */
function requestImageGeneration(url, apiKey, payload) {
    return requestJson(
        url,
        apiKey,
        JSON.stringify(payload),
        180000, // 图像生成可能较慢，超时 180 秒
        '解析图像生成响应失败'
    );
}

/**
 * 解析 base64 data URL 为二进制图片
 * @param {string} dataUrl - 形如 data:image/png;base64,xxx
 * @returns {{mime: string, ext: string, buffer: Buffer}}
 */
function parseDataUrlImage(dataUrl) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl || '');
    if (!match) throw new Error('参考图格式错误（仅支持 base64 data URL）');
    const mime = match[1];
    const ext = mime.split('/')[1].split('+')[0];
    return { mime, ext, buffer: Buffer.from(match[2], 'base64') };
}

/**
 * 构造 multipart/form-data 请求体
 * @param {string} boundary - 分隔符
 * @param {Array<{name: string, value: string}>} fields - 文本字段
 * @param {Array<{name: string, filename: string, contentType: string, buffer: Buffer}>} files - 文件字段
 * @returns {Buffer} 完整请求体
 */
function buildMultipartBody(boundary, fields, files) {
    const parts = [];
    for (const field of fields) {
        parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`
        ));
    }
    for (const file of files) {
        parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
        ));
        parts.push(file.buffer);
        parts.push(Buffer.from('\r\n'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return Buffer.concat(parts);
}

/**
 * 发起 multipart/form-data 的 /images/edits 图像编辑请求
 * OpenAI 系（gpt-image / dall-e）图生图的官方规范：
 * 参考图以二进制文件字段上传，而非 JSON 的 image 参数
 * @param {URL} url - 请求地址（/images/edits）
 * @param {string} apiKey - API Key
 * @param {Object} params - { model, prompt, images, size, quality }，images 为 base64 data URL 数组
 * @returns {Promise<Object>} 接口返回的 JSON
 */
function requestImageEdit(url, apiKey, { model, prompt, images, size, quality }) {
    const boundary = `----LumenLightForm${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;

    // 普通文本字段；size 已映射为 gpt-image 支持的档位，null 时不传（自动跟随参考图比例）
    const fields = [
        { name: 'model', value: model },
        { name: 'prompt', value: prompt || '' },
        { name: 'n', value: '1' }
    ];
    if (size) {
        fields.push({ name: 'size', value: size });
    }
    // quality 透传给支持该参数的模型（如 gpt-image、dall-e）
    if (quality && quality !== 'auto') {
        fields.push({ name: 'quality', value: quality });
    }

    // 文件字段：data URL 解码为二进制；多张图用 image[] 字段名（OpenAI 多图规范）
    const files = images.map((dataUrl, index) => {
        const parsed = parseDataUrlImage(dataUrl);
        return {
            name: images.length > 1 ? 'image[]' : 'image',
            filename: `image-${index}.${parsed.ext}`,
            contentType: parsed.mime,
            buffer: parsed.buffer
        };
    });

    const body = buildMultipartBody(boundary, fields, files);

    const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length
        },
        timeout: 180000 // 图像编辑可能较慢，超时 180 秒
    };

    return new Promise((resolve, reject) => {
        const client = url.protocol === 'https:' ? https : http;
        const request = client.request(options, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                try {
                    const statusCode = response.statusCode;
                    const json = parseResponseBody(
                        Buffer.concat(chunks), statusCode, response.headers, '解析图像编辑响应失败'
                    );
                    if (statusCode < 200 || statusCode >= 300) {
                        const message = json.error?.message || json.message || `请求失败，HTTP ${statusCode}`;
                        return reject(new Error(message));
                    }
                    return resolve(json);
                } catch (error) {
                    // 响应不是合法 JSON：把解析错误（含响应片段）打进日志，便于定位
                    // （中转站高并发下可能返回空响应 / HTML 错误页 / 被截断的内容）
                    console.error(`⚠️ 解析图像编辑响应失败: HTTP ${response.statusCode}，${error.message}`);
                    return reject(error);
                }
            });
        });

        request.on('timeout', () => {
            request.destroy();
            reject(new Error('请求超时（180 秒）'));
        });

        request.on('error', (error) => reject(error));

        request.end(body);
    });
}

/**
 * 代理下载远程图片
 * 用于解决浏览器前端因 CORS 限制无法直接下载跨域图片，导致文件名/格式异常的问题。
 * @param {string} imageUrl - 图片 URL
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
function proxyImageDownload(imageUrl) {
    return new Promise((resolve, reject) => {
        try {
            const url = new URL(imageUrl);
            const client = url.protocol === 'https:' ? https : http;
            const request = client.get(imageUrl, {
                timeout: 60000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0'
                }
            }, (response) => {
                const statusCode = response.statusCode;

                // 处理 301/302 重定向
                if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
                    return resolve(proxyImageDownload(response.headers.location));
                }

                if (statusCode < 200 || statusCode >= 300) {
                    return reject(new Error(`下载图片失败，HTTP ${statusCode}`));
                }

                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    const contentType = response.headers['content-type'] || 'application/octet-stream';
                    resolve({ buffer, contentType });
                });
            });

            request.on('timeout', () => {
                request.destroy();
                reject(new Error('下载图片超时'));
            });

            request.on('error', (error) => reject(error));
        } catch (error) {
            reject(error);
        }
    });
}

module.exports = {
    buildChatUrl,
    buildImageGenerationUrl,
    buildImageEditUrl,
    requestChatCompletions,
    requestImageGeneration,
    requestImageEdit,
    proxyImageDownload,
    parseDataUrlImage,
    buildMultipartBody,
    parseResponseBody,
    tryParseSsePayload
};
