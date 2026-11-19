/**
 * ==========================================================================
 * ark-image 适配器：火山方舟（即梦同源 Seedream 系官方通道）
 * ==========================================================================
 * 协议：POST {endpoint}/images/generations，与 OpenAI 标准格式同构且已被
 *       兜底适配器实证可用（2026-11-10 用户实测方舟端点出图成功）——
 *       唯一实质差异是方舟默认 watermark: true（右下角「AI生成」标），
 *       本适配器固定 watermark: false 去水印（dashscope 同款用户偏好）。
 *       quality 参数方舟不支持，不透传。
 * 命中：provider 端点域名含 volces.com（方舟 API 专用域名族 *.volces.com，
 *       不误伤转发 Seedream 的中转站——那些继续走兜底适配器）。
 * 覆盖：doubao-seedream-*（文生图/图生图，4.0 起支持最多 14 张参考图
 *       复合编辑）、doubao-seededit-*（图像编辑）。Seedance 视频系为
 *       异步任务式，属未来 task 适配器范围，本适配器不处理。
 * ==========================================================================
 */

const {
    buildImageGenerationUrl,
    requestImageGeneration
} = require('../llmProviders');
const {
    supportsOutputFormat,
    buildAspectRatioHint
} = require('../llmModelRules');

const ARK_HOST_KEYWORD = 'volces.com';

module.exports = {
    id: 'ark-image',
    mode: 'sync',

    /**
     * 端点域名判定：方舟端点（ark.cn-beijing.volces.com 等区域变体）
     * 一律走本适配器
     * @param {Object} context - { model, imageList, provider }
     * @returns {boolean}
     */
    match(context) {
        const endpoint = context?.provider?.config?.endpoint || '';
        return endpoint.includes(ARK_HOST_KEYWORD);
    },

    /**
     * 执行方舟图像生成（载荷与兜底适配器一致 + watermark:false）
     * @param {Object} request - { model, prompt, size, quality, images, provider, signal }
     * @returns {Promise<{imageSrc: string}>} 图片源（URL 或 base64 data URL）
     */
    async run(request) {
        const { model, prompt, size, images, provider, signal } = request;

        // 比例指令追加在原始提示词末尾（与兜底同款：对正常透传 size 的
        // 模型与 size 参数互相印证，无冲突）
        const sizeHint = buildAspectRatioHint(size);
        const fullPrompt = sizeHint ? `${prompt || ''}\n\n${sizeHint}` : (prompt || '');

        const payload = {
            model,
            prompt: fullPrompt,
            n: 1,
            // 直接返回 base64：生成的图从源头就是 data URL，
            // 前端展示/拖拽/添加到内容全链路免代理下载，无跨域延迟
            response_format: 'b64_json',
            // 方舟默认 true（右下角「AI生成」水印）——固定关闭
            watermark: false
        };

        // 仅在明确选定比例时传 size；
        // 不传时：图生图自动跟随参考图比例，文生图使用 API 默认尺寸
        if (size && size !== 'auto') {
            payload.size = size;
        }

        // 图生图（I2I）：参考图数组透传（Seedream 4.0 起最多 14 张复合编辑）
        if (images.length > 0) {
            payload.image = images;
        }

        // Seedream 5.0 系支持 PNG 输出参数，避免默认返回有损压缩的 JPEG；
        // 4.5/4.0 等不支持该参数的模型不传入（判据与兜底同源）
        if (supportsOutputFormat(model)) {
            payload.output_format = 'png';
        }

        const url = buildImageGenerationUrl(provider.config.endpoint);
        const result = await requestImageGeneration(url, provider.config.apiKey, payload, signal);

        // 支持返回 url 或 base64（已请求 b64_json，url 为兜底）
        const first = result.data?.[0];
        let imageSrc = '';
        if (first?.url) {
            imageSrc = first.url;
        } else if (first?.b64_json) {
            // MIME 类型与实际输出格式保持一致（未请求 output_format 时 Seedream 默认 JPEG）
            const mime = payload.output_format === 'png' ? 'png' : 'jpeg';
            imageSrc = `data:image/${mime};base64,${first.b64_json}`;
        }

        if (!imageSrc) {
            throw new Error('模型未返回图片');
        }
        return { imageSrc };
    }
};
