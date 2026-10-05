/**
 * ==========================================================================
 * chat-image 适配器：对话式图像编辑（Gemini 图像系列 / nano-banana）
 * ==========================================================================
 * 协议：POST {endpoint}/chat/completions，多模态消息传入参考图，
 *       生成的图片以 markdown 形式嵌在回复文本中返回。
 * 尺寸：这条链路没有可用的尺寸参数（中转站转译 Gemini 上游时也没有
 *       对应字段），比例控制依赖提示词指令（buildAspectRatioHint）。
 * ==========================================================================
 */

const {
    buildChatUrl,
    requestChatCompletions
} = require('../llmProviders');
const {
    isChatImageEditModel,
    extractImageFromChatReply,
    buildAspectRatioHint
} = require('../llmModelRules');

module.exports = {
    id: 'chat-image',
    mode: 'sync',

    /**
     * 是否命中本适配器：有参考图且模型属于 Gemini 图像系 / nano-banana
     * @param {Object} context - { model, imageList }
     * @returns {boolean}
     */
    match({ model, imageList }) {
        return imageList.length > 0 && isChatImageEditModel(model);
    },

    /**
     * 执行对话式图像编辑请求
     * @param {Object} request - { model, prompt, size, quality, images, provider }
     * @returns {Promise<{imageSrc: string, reply: string}>} 图片源与模型文本回复
     */
    async run(request) {
        const { model, prompt, size, images, provider, signal } = request;

        // 比例指令追加在提示词末尾（Gemini 图像系对提示词中的比例描述跟随度高）
        const sizeHint = buildAspectRatioHint(size);
        const fullPrompt = sizeHint ? `${prompt || ''}\n\n${sizeHint}` : (prompt || '');

        const chatUrl = buildChatUrl(provider.config.endpoint);
        console.log(`🎨 [${provider.name}] 对话式图像编辑: 模型=${model}, 参考图数量=${images.length}`);
        const chatResult = await requestChatCompletions(chatUrl, provider.config.apiKey, {
            model,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: fullPrompt },
                    ...images.map((dataUrl) => ({
                        type: 'image_url',
                        image_url: { url: dataUrl }
                    }))
                ]
            }]
        }, signal);

        const { imageSrc, reply } = extractImageFromChatReply(chatResult);
        if (!imageSrc) {
            const brief = reply ? reply.slice(0, 200) : '';
            throw new Error(brief ? `模型未返回图片，其回复为：${brief}` : '模型未返回图片');
        }
        return { imageSrc, reply: reply || '' };
    }
};
