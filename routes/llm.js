/**
 * ==========================================================================
 * LumenLight 大语言模型聊天路由
 * 作用：作为前端聊天窗口与大语言模型 API 之间的代理，
 *       读取设置文件（data/settings.json）中的端点地址和 API Key，
 *       以 OpenAI 兼容格式转发 chat/completions 请求。
 *       走后端代理可以避免浏览器直连第三方 API 时的跨域（CORS）问题。
 *       请求实现与响应解析在 utils/llmProviders.js；
 *       模型家族识别与参数映射在 utils/llmModelRules.js；
 *       图像生成的协议适配器（按模型家族分派）在 utils/modelAdapters/。
 * ==========================================================================
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');

const {
    buildChatUrl,
    requestChatCompletions,
    proxyImageDownload
} = require('../utils/llmProviders');

// 视频生成任务封装（异步任务式：提交 → 轮询 → 下载）
const { createVideoTask, queryVideoTask, downloadVideo } = require('../utils/videoProviders');

// 模型协议适配器注册表：generate-image 按模型家族挑选适配器执行
const { pickImageAdapter } = require('../utils/modelAdapters');

// 文档文本提取（用户上传的 txt/pdf/docx/xlsx 等在后端解析成纯文本）
const fileTextExtractor = require('../utils/fileTextExtractor');

/**
 * 创建 LLM 聊天路由
 * @param {Object} options - 依赖项
 * @param {string} options.dataDir - 设置文件存放目录
 * @returns {express.Router} Express 路由实例
 */
function createLlmRouter({ dataDir }) {
    const router = express.Router();
    const settingsPath = path.join(dataDir, 'settings.json');

    /**
     * 读取设置文件
     * @returns {Promise<Object>} 设置对象
     */
    async function readSettings() {
        try {
            const content = await fs.readFile(settingsPath, 'utf-8');
            return JSON.parse(content);
        } catch {
            return {};
        }
    }

    /**
     * 按模型 ID 解析它属于哪个厂商，返回该厂商的端点与 Key。
     * 多厂商并存的路由核心：请求里带什么模型，就用配置了该模型的厂商，
     * 对话、技能（反推/优化）与生图因此可以各用各的厂商，互不影响。
     * 解析顺序：
     *   1. 请求显式指定厂商（providerHint，前端下拉值为"厂商||模型"复合键，
     *      支持多个厂商配同名模型）——仅当该厂商已配置且确实含有该模型；
     *   2. 未指定或显式厂商校验失败时：当前选中厂商（保持既有行为优先）；
     *   3. 其他厂商（要求已配置端点和 Key，且模型列表里含该模型）；
     *   4. 都找不到（如手动填写的模型名）→ 回落当前厂商。
     * @param {Object} api - settings.api（providers / currentProvider）
     * @param {string} model - 请求的模型 ID
     * @param {string} [providerHint] - 请求显式指定的厂商名（可为空）
     * @returns {{name: string, config: Object}} 厂商名与配置 {endpoint, apiKey, models}
     */
    function resolveProviderConfig(api, model, providerHint) {
        const providers = api.providers || {};

        // 显式厂商路由：前端把"厂商||模型"复合键拆开后随请求带来。
        // 校验通过直接使用，避免同名模型被"首个命中"规则遮蔽
        if (providerHint && providers[providerHint]) {
            const config = providers[providerHint];
            const hasModel = Array.isArray(config.models) && config.models.some((m) => {
                const id = typeof m === 'string' ? m : m?.id;
                return id === model;
            });
            if (config.endpoint && config.apiKey && hasModel) {
                return { name: providerHint, config };
            }
            // 显式厂商未配置/不含该模型 → 回退自动路由（模型可能被挪动过）
        }

        const currentProvider = api.currentProvider || 'Deepseek';
        const candidateNames = [
            currentProvider,
            ...Object.keys(providers).filter((name) => name !== currentProvider)
        ];

        for (const name of candidateNames) {
            const config = providers[name];
            if (!config || !config.endpoint || !config.apiKey) continue;
            const hasModel = Array.isArray(config.models) && config.models.some((m) => {
                const id = typeof m === 'string' ? m : m?.id;
                return id === model;
            });
            if (hasModel) return { name, config };
        }

        // 回落：模型不在任何已配置厂商的列表里，仍按当前厂商处理
        // （由后续请求向用户报出该厂商的具体配置错误）
        return { name: currentProvider, config: providers[currentProvider] || {} };
    }

    /**
     * POST /api/llm/chat
     * 转发聊天请求到 API 提供商
     * 请求体：{ model: string, messages: [{role, content}], images: string[] }
     *   - messages：历史对话（最后一条为本次用户输入）
     *   - images：本次消息附带的图片（base64 data URL），仅挂在最后一条用户消息上
     */
    router.post('/chat', async (req, res) => {
        try {
            const { model, messages, images, files, provider } = req.body || {};

            if (!model) {
                return res.status(400).json({ status: 'error', message: '请先在聊天窗口选择模型' });
            }
            if (!Array.isArray(messages) || messages.length === 0) {
                return res.status(400).json({ status: 'error', message: '消息内容不能为空' });
            }

            // 按请求的模型解析所属厂商（多厂商并存：对话模型与生图模型
            // 可以分属不同厂商，互不影响）；provider 为前端显式指定的厂商
            const settings = await readSettings();
            const api = settings.api || {};
            const { name: providerName, config } = resolveProviderConfig(api, model, provider);

            if (!config.endpoint || !config.apiKey) {
                return res.status(400).json({
                    status: 'error',
                    message: `请先在设置 → API 中配置 ${providerName} 的端点地址和 API Key`
                });
            }

            // 构造 OpenAI 兼容的消息列表：
            // 本次消息若带图片，将最后一条用户消息转为多模态内容数组；
            // 若带文档附件，把提取出的文本拼在用户正文之后（大多数 OpenAI
            // 兼容接口不收原文件，只收文本，故统一以文本形式提交）
            const imageList = Array.isArray(images) ? images : [];
            const fileList = Array.isArray(files)
                ? files.filter((f) => f && typeof f.text === 'string' && f.text.length > 0)
                : [];
            // 附件文本块：每个文件一段，标注文件名与是否被截断
            const fileBlock = fileList
                .map((f) => `【附件 ${f.name || '文件'}${f.truncated ? '（内容过长已截断）' : ''}】\n${f.text}`)
                .join('\n\n');

            const payloadMessages = messages.map((msg, index) => {
                const isLastUser = index === messages.length - 1 && msg.role === 'user';
                if (isLastUser && (imageList.length > 0 || fileList.length > 0)) {
                    const text = (msg.content || '') + (fileBlock ? `\n\n${fileBlock}` : '');
                    // 无图片时保持纯字符串 content（兼容性最好）；有图片才转多模态数组
                    if (imageList.length === 0) {
                        return { role: 'user', content: text };
                    }
                    return {
                        role: 'user',
                        content: [
                            { type: 'text', text },
                            ...imageList.map((dataUrl) => ({
                                type: 'image_url',
                                image_url: { url: dataUrl }
                            }))
                        ]
                    };
                }
                return { role: msg.role, content: msg.content };
            });

            const chatUrl = buildChatUrl(config.endpoint);
            const result = await requestChatCompletions(chatUrl, config.apiKey, {
                model,
                messages: payloadMessages
            });

            // 提取模型回复文本
            const reply = result.choices?.[0]?.message?.content || '';
            res.json({ status: 'ok', reply });
        } catch (error) {
            console.error('LLM 聊天请求失败:', error);
            res.status(500).json({
                status: 'error',
                message: error.message || '聊天请求失败'
            });
        }
    });

    /**
     * POST /api/llm/extract-file
     * 解析用户上传的文档，返回纯文本（前端在添加附件时调用，提前拿到文本并缓存）。
     * 请求体：{ filename: string, dataUrl: string }
     *   - dataUrl：文件的 base64 data URL（与图片附件一致的传输方式，无需 multipart）
     * 返回：{ status:'ok', text, truncated, charCount, ext, empty }
     *   或 { status:'error', message }
     */
    router.post('/extract-file', async (req, res) => {
        try {
            const { filename, dataUrl } = req.body || {};

            if (!dataUrl || typeof dataUrl !== 'string') {
                return res.status(400).json({ status: 'error', message: '缺少文件数据' });
            }
            if (!fileTextExtractor.isSupported(filename)) {
                return res.status(400).json({
                    status: 'error',
                    message: '暂不支持该文件格式（支持 txt/md/csv/json/pdf/docx/xls/xlsx 等）'
                });
            }

            // 解析 data URL：data:[<mime>][;base64],<内容>；兼容直接传 base64 字符串
            const match = /^data:([^;,]*)?(;base64)?,([\s\S]*)$/.exec(dataUrl);
            let buffer;
            if (match && match[2]) {
                buffer = Buffer.from(match[3], 'base64');
            } else if (match) {
                buffer = Buffer.from(decodeURIComponent(match[3]), 'utf8');
            } else {
                buffer = Buffer.from(dataUrl, 'base64');
            }

            const result = await fileTextExtractor.extractText({ buffer, filename });
            res.json({ status: 'ok', ...result });
        } catch (error) {
            console.error('文档解析失败:', error);
            res.status(500).json({
                status: 'error',
                message: error.message || '文档解析失败'
            });
        }
    });

    /**
     * POST /api/llm/generate-image
     * 转发图像生成请求到 API 提供商（OpenAI 兼容格式）
     * 请求体：{ model: string, prompt: string, size: string, quality?: string, images?: string[] }
     *   - images：待发送图片（base64 data URL），非空时作为参考图发起图生图（I2I），
     *     对应豆包 Seedream 等模型的 image 参数
     *   - quality：图片质量（low / medium / high / standard / hd / auto），
     *     仅对 gpt-image / dall-e 等 OpenAI 系模型生效
     * 返回：{ status: 'ok', imageUrl: string }
     *   - imageUrl 可能是远程 URL，也可能是 base64 data URL
     *
     * 本路由是薄调度器：按模型家族挑选 utils/modelAdapters/ 里的协议适配器，
     * payload 构造、HTTP 请求与结果提取都在适配器内完成。接入新的模型家族
     * （如未来的视频模型）= 新增适配器文件并注册，本路由零改动。
     */
    router.post('/generate-image', async (req, res) => {
        try {
            const { model, prompt, size, quality, images, provider } = req.body || {};

            if (!model) {
                return res.status(400).json({ status: 'error', message: '请先在聊天窗口选择模型' });
            }

            // 参考图列表（图生图 I2I 用），过滤空值
            const imageList = Array.isArray(images) ? images.filter(Boolean) : [];

            // 诊断日志：确认参考图确实到达后端并转发（用于排查图生图不生效问题）。
            // 并发生成时多条到达日志应落在同一秒内，证明前端确实是同时发出的
            const startedAt = Date.now();
            console.log(`🖼️ [${new Date().toLocaleTimeString()}] 图像生成请求: 模型=${model}, 参考图数量=${imageList.length}, 尺寸=${size || '未指定(自动)'}, 质量=${quality || '自动'}`);

            // 请求结束计时：若多条请求的耗时呈阶梯状（≈单张耗时 × 序号），
            // 说明 API 服务商在按账号/Key 排队，而非本服务串行
            res.on('finish', () => {
                console.log(`⏱️ [${new Date().toLocaleTimeString()}] 生成请求结束，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
            });

            if (!prompt && imageList.length === 0) {
                return res.status(400).json({ status: 'error', message: '图像生成提示词不能为空' });
            }

            // 按请求的模型解析所属厂商（与 /chat 同一套路由规则）
            const settings = await readSettings();
            const api = settings.api || {};
            const { name: providerName, config } = resolveProviderConfig(api, model, provider);

            if (!config.endpoint || !config.apiKey) {
                return res.status(400).json({
                    status: 'error',
                    message: `请先在设置 → API 中配置 ${providerName} 的端点地址和 API Key`
                });
            }

            // 挑选协议适配器并执行（适配器失败时抛带可读 message 的错误，
            // 由下方 catch 统一回传前端）
            const adapter = pickImageAdapter({ model, imageList });
            const result = await adapter.run({
                model,
                prompt,
                size,
                quality,
                images: imageList,
                provider: { name: providerName, config }
            });

            res.json({ status: 'ok', imageUrl: result.imageSrc, ...(result.reply ? { reply: result.reply } : {}) });
        } catch (error) {
            console.error('图像生成请求失败:', error);
            res.status(500).json({
                status: 'error',
                message: error.message || '图像生成请求失败'
            });
        }
    });

    /**
     * GET /api/llm/download-image
     * 代理下载远程图片，解决浏览器跨域下载文件名/格式异常的问题
     * 查询参数：url（图片地址，必需）、filename（下载文件名，可选）
     */
    router.get('/download-image', async (req, res) => {
        try {
            const { url, filename } = req.query || {};

            if (!url) {
                return res.status(400).json({ status: 'error', message: '缺少图片 URL 参数' });
            }

            // Express 已自动解码 query 参数，这里直接使用原始 URL
            const { buffer, contentType } = await proxyImageDownload(url);

            // 设置下载文件名：ASCII 安全文件名 + UTF-8 编码文件名（兼容中文）
            const downloadName = filename || 'image';
            const encodedName = encodeURIComponent(downloadName);
            // 若文件名包含非 ASCII 字符，提供安全的 ASCII 回退名，避免旧浏览器解析错误
            const asciiName = /^[\x20-\x7E]+$/.test(downloadName)
                ? downloadName
                : 'image';
            res.setHeader('Content-Type', contentType);
            res.setHeader('Content-Disposition', `attachment; filename="${asciiName.replace(/"/g, '\\"')}"; filename*=UTF-8''${encodedName}`);
            res.send(buffer);
        } catch (error) {
            console.error('代理下载图片失败:', error);
            res.status(500).json({
                status: 'error',
                message: error.message || '下载图片失败'
            });
        }
    });

    /**
     * POST /api/llm/upload-video
     * 上传本地视频文件到服务器（用于拖拽视频到画布时持久化存储）
     * 请求体：原始二进制流（Content-Type: application/octet-stream）
     * 查询参数：filename（文件名，可选）
     * 返回：{ status: 'ok', videoPath: 'data/videos/xxx.mp4' }
     */
    const rawParser = express.raw({ type: 'application/octet-stream', limit: '500mb' });
    router.post('/upload-video', rawParser, async (req, res) => {
        try {
            if (!req.body || req.body.length === 0) {
                return res.status(400).json({ status: 'error', message: '未接收到视频数据' });
            }

            // 生成安全文件名：保留扩展名，前缀加时间戳避免重名
            const originalName = (req.query.filename || 'video.mp4').replace(/[^\w.\-\u4e00-\u9fff]/g, '_');
            const ext = path.extname(originalName) || '.mp4';
            const safeName = `video_${Date.now()}${ext}`;

            const videosDir = path.join(__dirname, '..', 'data', 'videos');
            await fs.mkdir(videosDir, { recursive: true });
            const destPath = path.join(videosDir, safeName);
            await fs.writeFile(destPath, req.body);

            const relativePath = path.relative(path.join(__dirname, '..'), destPath).replace(/\\/g, '/');
            console.log(`🎬 视频上传完成: ${relativePath} (${(req.body.length / 1024 / 1024).toFixed(1)}MB)`);
            res.json({ status: 'ok', videoPath: relativePath });
        } catch (error) {
            console.error('视频上传失败:', error);
            res.status(500).json({ status: 'error', message: error.message || '视频上传失败' });
        }
    });

    /**
     * POST /api/llm/submit-video
     * 提交视频生成任务（异步任务式：返回 taskId，前端轮询状态）
     * 请求体：{ model, prompt, imageUrl?, ratio?, duration?, provider? }
     *   - imageUrl：首帧图片（data URL 或 http URL），图生视频时必传
     *   - ratio：宽高比（如 '16:9'）
     *   - duration：时长（秒）
     * 返回：{ status: 'ok', taskId: string }
     */
    router.post('/submit-video', async (req, res) => {
        try {
            const { model, prompt, imageUrl, ratio, duration, provider } = req.body || {};

            if (!model) {
                return res.status(400).json({ status: 'error', message: '请先选择视频生成模型' });
            }
            if (!prompt && !imageUrl) {
                return res.status(400).json({ status: 'error', message: '视频生成需要提示词或首帧图片' });
            }

            const settings = await readSettings();
            const api = settings.api || {};
            const { name: providerName, config } = resolveProviderConfig(api, model, provider);

            if (!config.endpoint || !config.apiKey) {
                return res.status(400).json({
                    status: 'error',
                    message: `请先在设置 → API 中配置 ${providerName} 的端点地址和 API Key`
                });
            }

            console.log(`🎬 [${new Date().toLocaleTimeString()}] 视频生成请求: 模型=${model}, 提示词=${(prompt || '').slice(0, 50)}...`);

            const taskId = await createVideoTask(
                { endpoint: config.endpoint, apiKey: config.apiKey },
                { model, prompt: prompt || '', imageUrl, ratio, duration }
            );

            res.json({ status: 'ok', taskId });
        } catch (error) {
            console.error('提交视频任务失败:', error);
            res.status(500).json({ status: 'error', message: error.message || '提交视频任务失败' });
        }
    });

    /**
     * GET /api/llm/video-task/:id
     * 轮询视频生成任务状态。任务成功时自动下载视频到本地并返回可访问路径。
     * 返回：{ status: 'ok', taskStatus: string, videoPath?: string, error?: string }
     *   - taskStatus: 'queued' | 'running' | 'succeeded' | 'failed' | ...
     *   - videoPath: 成功时的本地视频相对路径（如 data/videos/video_xxx.mp4）
     */
    router.get('/video-task/:id', async (req, res) => {
        try {
            const taskId = req.params.id;
            const { model, provider } = req.query || {};

            // 需要厂商配置来查询任务（复用提交时的厂商路由逻辑）
            const settings = await readSettings();
            const api = settings.api || {};
            // 查询时 model 可能未传，回退到当前厂商
            const { config } = model
                ? resolveProviderConfig(api, model, provider)
                : { config: (api.providers || {})[api.currentProvider] || {} };

            if (!config.endpoint || !config.apiKey) {
                return res.status(400).json({ status: 'error', message: '厂商配置缺失，无法查询任务' });
            }

            const result = await queryVideoTask(
                { endpoint: config.endpoint, apiKey: config.apiKey },
                taskId
            );

            // 任务成功：下载视频到本地（URL 24h 过期，必须及时持久化）
            if (result.status === 'succeeded' && result.videoUrl) {
                const videosDir = path.join(__dirname, '..', 'data', 'videos');
                const videoPath = await downloadVideo(result.videoUrl, videosDir);
                console.log(`🎬 视频下载完成: ${videoPath}`);
                return res.json({ status: 'ok', taskStatus: 'succeeded', videoPath });
            }

            res.json({
                status: 'ok',
                taskStatus: result.status,
                error: result.error || undefined
            });
        } catch (error) {
            console.error('查询视频任务失败:', error);
            res.status(500).json({ status: 'error', message: error.message || '查询视频任务失败' });
        }
    });

    return router;
}

module.exports = createLlmRouter;
