/**
 * ==========================================================================
 * LLM 模型识别与路由规则
 * 作用：集中管理图像生成相关模型的识别逻辑，
 *       根据模型 ID 判断应该走哪条 API 通道（/images/edits、/chat/completions、
 *       /images/generations）以及支持的参数。
 *       新增模型家族时通常只需修改本文件。
 * ==========================================================================
 */

/**
 * 判断模型是否为 OpenAI 系图像模型（gpt-image / dall-e）
 * 这类模型的图生图（图像编辑）按官方规范走 /images/edits 端点，
 * 参考图以 multipart 文件字段上传；且不支持 Chat Completions，
 * 直接对话会报 "This model is not supported on the Chat Completions endpoint"。
 * @param {string} modelId - 模型 ID
 * @returns {boolean}
 */
function isEditsImageModel(modelId) {
    if (!modelId) return false;
    const lower = modelId.toLowerCase();
    return lower.includes('gpt-image') || lower.includes('dall-e') || lower.includes('dalle');
}

/**
 * 判断模型是否为"对话式图像模型"（如 Gemini 图像系列、nano-banana）
 * 这类模型的图像编辑（图生图）必须通过 chat/completions 多模态消息完成，
 * /images/generations 端点的 image 参数不被支持（会被中转站忽略，
 * 导致模型报"未收到可编辑的图片"）。
 * @param {string} modelId - 模型 ID
 * @returns {boolean}
 */
function isChatImageEditModel(modelId) {
    if (!modelId) return false;
    const lower = modelId.toLowerCase();
    // gemini-2.5-flash-image / gemini-3.1-flash-image-1K / nano-banana 等
    return (lower.includes('gemini') && lower.includes('image')) || lower.includes('nano-banana');
}

/**
 * 判断指定模型是否支持 output_format 参数
 * 根据豆包官方文档，目前仅 Seedream 5.0 Pro / 5.0 Lite 支持 PNG/JPEG 输出格式选择；
 * Seedream 4.5 / 4.0 仅支持 JPEG 输出。
 * @param {string} modelId - 模型 ID
 * @returns {boolean}
 */
function supportsOutputFormat(modelId) {
    if (!modelId) return false;
    const lower = modelId.toLowerCase();
    return lower.includes('seedream-5-0');
}

/**
 * 从 chat/completions 回复中提取生成的图片与文本说明
 * 兼容两种返回格式：
 *   - content 为字符串：Gemini 图像模型通常以 markdown 图片语法返回 ![...](url 或 data URL)
 *   - content 为数组：部分中转站以多模态结构返回 [{type:'image_url',...}, {type:'text',...}]
 * @param {Object} result - chat/completions 响应 JSON
 * @returns {{imageSrc: string, reply: string}} 提取到的图片地址与文字说明
 */
function extractImageFromChatReply(result) {
    const content = result.choices?.[0]?.message?.content;
    let imageSrc = '';
    let reply = '';

    if (typeof content === 'string') {
        reply = content;
        // 提取 markdown 图片：![替代文本](图片地址)，地址可能是 https URL 或 base64 data URL
        const match = content.match(/!\[[^\]]*\]\(\s*(data:image\/[^)\s]+|https?:\/\/[^)\s]+)\s*\)/);
        if (match) imageSrc = match[1];
    } else if (Array.isArray(content)) {
        // 结构化多模态回复：收集文本，取第一张图片
        const texts = [];
        for (const part of content) {
            if (part?.type === 'image_url' && part.image_url?.url && !imageSrc) {
                imageSrc = part.image_url.url;
            } else if (part?.type === 'text' && part.text) {
                texts.push(part.text);
            }
        }
        reply = texts.join('\n');
    }

    return { imageSrc, reply };
}

/**
 * 将前端尺寸选择映射为 gpt-image 官方支持的档位（兜底用）
 * 优先策略是直接透传前端选择的像素尺寸（中转站 gpt-image-2 等
 * 新模型支持任意尺寸，可输出 2K 级图像）；
 * 当接口报"尺寸不支持"时，才用本函数按宽高比回退到官方档位：
 *   1024x1024（方图）、1024x1536（竖版）、1536x1024（横版）
 * @param {string} size - 前端尺寸值（"宽x高" 像素格式或 'auto'）
 * @returns {string|null} gpt-image 官方尺寸档位，无法解析时返回 null
 */
function mapSizeForEditsModel(size) {
    if (!size || size === 'auto') return null;

    const match = /^(\d+)x(\d+)$/.exec(size.trim());
    if (!match) return null;

    const width = parseInt(match[1], 10);
    const height = parseInt(match[2], 10);
    const ratio = width / height;

    if (ratio > 1.15) return '1536x1024';   // 横版（4:3、3:2、16:9 等）
    if (ratio < 0.87) return '1024x1536';   // 竖版（3:4、2:3、9:16 等）
    return '1024x1024';                     // 接近方形（1:1）
}

/**
 * 构造"输出比例指令"提示词（Gemini 图像系 / nano-banana 专用手段）
 * 这类模型经 OpenAI 兼容接口调用时没有可用的尺寸参数：
 *   - /images/generations 的 size 字段会被中转站转译 Gemini 上游时丢弃；
 *   - chat/completions 链路本身没有尺寸字段；
 * Gemini 图像模型官方的比例控制方式就是提示词指令（对提示词中的
 * 比例描述跟随度很高），因此把前端选择的尺寸翻译成比例指令，
 * 由调用方追加到提示词末尾。size 为 auto 或无法解析时返回空串。
 * @param {string} size - 前端尺寸值（"宽x高" 像素格式或 'auto'）
 * @returns {string} 比例指令文本（可能为空串）
 */
function buildAspectRatioHint(size) {
    if (!size || size === 'auto') return '';

    const match = /^(\d{2,5})\s*[xX×]\s*(\d{2,5})$/.exec(String(size).trim());
    if (!match) return '';
    const width = parseInt(match[1], 10);
    const height = parseInt(match[2], 10);
    if (!width || !height) return '';

    // 简化宽高比；若非常接近常见比例（误差 ≤2%）则改用常见叫法，
    // 模型对 "9:16" 这类标准描述的跟随度远好于 "29:52" 这类生僻比
    const commonRatios = [
        [1, 1], [4, 3], [3, 4], [16, 9], [9, 16], [3, 2], [2, 3],
        [21, 9], [9, 21], [5, 4], [4, 5], [2, 1], [1, 2], [16, 10], [10, 16]
    ];
    let ratioLabel = `${width}:${height}`;
    for (const [rw, rh] of commonRatios) {
        if (Math.abs(width / height - rw / rh) / (rw / rh) <= 0.02) {
            ratioLabel = `${rw}:${rh}`;
            break;
        }
    }

    const orientation = width > height ? 'landscape / 横版'
        : width < height ? 'portrait / 竖版' : 'square / 方图';
    return [
        `Output aspect ratio: ${ratioLabel} (${orientation}), target resolution ${width}x${height} pixels.`,
        `画面比例必须为 ${ratioLabel}（${orientation.split(' /')[0] === 'landscape' ? '横版' : orientation.split(' /')[0] === 'portrait' ? '竖版' : '方图'}），目标分辨率 ${width}x${height} 像素，不要使用默认比例。`
    ].join('\n');
}

module.exports = {
    isEditsImageModel,
    isChatImageEditModel,
    supportsOutputFormat,
    extractImageFromChatReply,
    mapSizeForEditsModel,
    buildAspectRatioHint
};
