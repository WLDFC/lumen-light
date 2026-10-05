/**
 * ==========================================================================
 * edits-image 适配器：OpenAI 系图像模型图生图（gpt-image / dall-e）
 * ==========================================================================
 * 协议：POST {endpoint}/images/edits，multipart/form-data，
 *       参考图以二进制文件字段上传（OpenAI 官方规范）。
 *       这类模型不支持 Chat Completions，直接对话会报
 *       "This model is not supported on the Chat Completions endpoint"。
 * 尺寸：优先透传前端选择的任意像素尺寸（gpt-image-2 等新模型支持 2K）；
 *       接口报"尺寸不支持"时按宽高比回退到官方档位重试。
 * ==========================================================================
 */

const {
    buildImageEditUrl,
    requestImageEdit
} = require('../llmProviders');
const {
    isEditsImageModel,
    mapSizeForEditsModel
} = require('../llmModelRules');

module.exports = {
    id: 'edits-image',
    mode: 'sync',

    /**
     * 是否命中本适配器：有参考图且模型属于 OpenAI edits 图像系
     * @param {Object} context - { model, imageList }
     * @returns {boolean}
     */
    match({ model, imageList }) {
        return imageList.length > 0 && isEditsImageModel(model);
    },

    /**
     * 执行图像编辑请求
     * @param {Object} request - { model, prompt, size, quality, images, provider }
     * @returns {Promise<{imageSrc: string}>} 图片源（URL 或 base64 data URL）
     */
    async run(request) {
        const { model, prompt, size, quality, images, provider, signal } = request;
        const editUrl = buildImageEditUrl(provider.config.endpoint);

        // 优先透传前端选择的原始尺寸；若接口报尺寸不支持，
        // 再回退到官方 1024/1536 档位重试
        const requestedSize = (size && size !== 'auto') ? size : null;
        const editParams = { model, prompt: prompt || '', images, quality };

        let editResult;
        try {
            console.log(`🖌️ [${provider.name}] 图像编辑(/images/edits): 模型=${model}, 参考图数量=${images.length}, 尺寸=${requestedSize || '自动'}, 质量=${quality || '自动'}`);
            editResult = await requestImageEdit(editUrl, provider.config.apiKey, { ...editParams, size: requestedSize, signal });
        } catch (error) {
            if (!requestedSize || !/size|尺寸|dimension/i.test(error.message)) throw error;
            const fallbackSize = mapSizeForEditsModel(requestedSize);
            console.warn(`尺寸 ${requestedSize} 不被支持，回退官方档位 ${fallbackSize || 'auto'}: ${error.message}`);
            editResult = await requestImageEdit(editUrl, provider.config.apiKey, { ...editParams, size: fallbackSize, signal });
        }

        const editFirst = editResult.data?.[0];
        let imageSrc = '';
        if (editFirst?.url) {
            imageSrc = editFirst.url;
        } else if (editFirst?.b64_json) {
            // gpt-image 系列固定输出 PNG
            imageSrc = `data:image/png;base64,${editFirst.b64_json}`;
        }

        if (!imageSrc) {
            throw new Error('模型未返回图片');
        }
        return { imageSrc };
    }
};
