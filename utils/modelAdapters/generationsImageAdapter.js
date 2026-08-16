/**
 * ==========================================================================
 * generations-image 适配器：标准 /images/generations 端点（兜底适配器）
 * ==========================================================================
 * 协议：POST {endpoint}/images/generations，OpenAI 标准文生图/图生图格式，
 *       豆包 Seedream 等支持 image 参数的模型与未特殊识别的模型都走这里。
 * 尺寸：size 字段在此透传；但对 Gemini 图像系（nano-banana 等），
 *       中转站转译上游时会丢弃 size，因此同时追加提示词比例指令兜底。
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

module.exports = {
    id: 'generations-image',
    mode: 'sync',

    /**
     * 兜底适配器：排在前面的适配器都不命中时到达这里，
     * 无论什么模型/是否带参考图都能处理
     * @returns {boolean}
     */
    match() {
        return true;
    },

    /**
     * 执行标准图像生成请求
     * @param {Object} request - { model, prompt, size, quality, images, provider }
     * @returns {Promise<{imageSrc: string}>} 图片源（URL 或 base64 data URL）
     */
    async run(request) {
        const { model, prompt, size, quality, images, provider } = request;

        // 比例指令追加在原始提示词末尾（Gemini 图像系等忽略 size 参数的模型依赖它；
        // 对正常透传 size 的模型则与 size 参数互相印证，无冲突）
        const sizeHint = buildAspectRatioHint(size);
        const fullPrompt = sizeHint ? `${prompt || ''}\n\n${sizeHint}` : (prompt || '');

        const payload = {
            model,
            prompt: fullPrompt,
            n: 1,
            // 直接返回 base64：生成的图从源头就是 data URL，
            // 前端展示/拖拽/添加到内容全链路免代理下载，无跨域延迟
            response_format: 'b64_json'
        };

        // 仅在明确选定比例时传 size；
        // 不传时：图生图自动跟随参考图比例，文生图使用 API 默认尺寸
        if (size && size !== 'auto') {
            payload.size = size;
        }

        // quality 透传给支持该参数的模型（如 gpt-image / dall-e），
        // 豆包 Seedream 等模型收到后会忽略或报错，因此仅在明确指定时传入
        if (quality && quality !== 'auto') {
            payload.quality = quality;
        }

        // 图生图（I2I）：把参考图传入 image 参数（豆包 Seedream 系列支持）
        if (images.length > 0) {
            payload.image = images;
        }

        // 对于支持 PNG 输出的 Seedream 5.0 系列模型，自动请求 PNG 格式，
        // 避免 API 默认返回有损压缩的 JPEG；4.5/4.0 等不支持该参数的模型不传入。
        if (supportsOutputFormat(model)) {
            payload.output_format = 'png';
        }

        const url = buildImageGenerationUrl(provider.config.endpoint);
        const result = await requestImageGeneration(url, provider.config.apiKey, payload);

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
