/**
 * ==========================================================================
 * llmModelRules.js 单元测试
 * 覆盖模型识别、输出格式、图片提取、尺寸映射等纯函数。
 * ==========================================================================
 */

const {
    isEditsImageModel,
    isChatImageEditModel,
    supportsOutputFormat,
    extractImageFromChatReply,
    mapSizeForEditsModel,
    buildAspectRatioHint
} = require('../../utils/llmModelRules');

describe('isEditsImageModel', () => {
    test('识别 gpt-image 系列为 edits 图像模型', () => {
        expect(isEditsImageModel('gpt-image-1')).toBe(true);
        expect(isEditsImageModel('gpt-image-2')).toBe(true);
        expect(isEditsImageModel('gpt-image-1.5')).toBe(true);
    });

    test('识别 dall-e 系列为 edits 图像模型', () => {
        expect(isEditsImageModel('dall-e-3')).toBe(true);
        expect(isEditsImageModel('dall-e-2')).toBe(true);
        expect(isEditsImageModel('dalle-3')).toBe(true);
    });

    test('非 edits 图像模型返回 false', () => {
        expect(isEditsImageModel('doubao-seedream-5-0-pro')).toBe(false);
        expect(isEditsImageModel('gemini-2.5-flash-image')).toBe(false);
        expect(isEditsImageModel('deepseek-chat')).toBe(false);
        expect(isEditsImageModel('')).toBe(false);
        expect(isEditsImageModel(null)).toBe(false);
    });
});

describe('isChatImageEditModel', () => {
    test('识别 Gemini 图像系列为对话式图像模型', () => {
        expect(isChatImageEditModel('gemini-2.5-flash-image')).toBe(true);
        expect(isChatImageEditModel('gemini-3.1-flash-image-1K')).toBe(true);
    });

    test('识别 nano-banana 为对话式图像模型', () => {
        expect(isChatImageEditModel('nano-banana')).toBe(true);
    });

    test('非对话式图像模型返回 false', () => {
        expect(isChatImageEditModel('gpt-image-2')).toBe(false);
        expect(isChatImageEditModel('dall-e-3')).toBe(false);
        expect(isChatImageEditModel('doubao-seedream-5-0-pro')).toBe(false);
        expect(isChatImageEditModel('')).toBe(false);
        expect(isChatImageEditModel(null)).toBe(false);
    });
});

describe('supportsOutputFormat', () => {
    test('仅 Seedream 5.0 系列支持 output_format', () => {
        expect(supportsOutputFormat('doubao-seedream-5-0-pro')).toBe(true);
        expect(supportsOutputFormat('doubao-seedream-5-0-lite')).toBe(true);
    });

    test('其他模型不支持 output_format', () => {
        expect(supportsOutputFormat('doubao-seedream-4-5')).toBe(false);
        expect(supportsOutputFormat('gpt-image-2')).toBe(false);
        expect(supportsOutputFormat('deepseek-chat')).toBe(false);
        expect(supportsOutputFormat('')).toBe(false);
        expect(supportsOutputFormat(null)).toBe(false);
    });
});

describe('extractImageFromChatReply', () => {
    test('从字符串 markdown 图片中提取 URL', () => {
        const result = extractImageFromChatReply({
            choices: [{
                message: {
                    content: '这是生成的图片：![image](https://example.com/img.png)'
                }
            }]
        });
        expect(result.imageSrc).toBe('https://example.com/img.png');
        expect(result.reply).toContain('这是生成的图片');
    });

    test('从字符串 markdown 中提取 base64 data URL', () => {
        const dataUrl = 'data:image/png;base64,abc123';
        const result = extractImageFromChatReply({
            choices: [{
                message: {
                    content: `![gen](${dataUrl})`
                }
            }]
        });
        expect(result.imageSrc).toBe(dataUrl);
    });

    test('从多模态数组中提取图片与文本', () => {
        const result = extractImageFromChatReply({
            choices: [{
                message: {
                    content: [
                        { type: 'text', text: '图片说明' },
                        { type: 'image_url', image_url: { url: 'https://example.com/gen.png' } }
                    ]
                }
            }]
        });
        expect(result.imageSrc).toBe('https://example.com/gen.png');
        expect(result.reply).toBe('图片说明');
    });

    test('无图片时返回空字符串', () => {
        const result = extractImageFromChatReply({
            choices: [{
                message: { content: '今天天气不错' }
            }]
        });
        expect(result.imageSrc).toBe('');
        expect(result.reply).toBe('今天天气不错');
    });
});

describe('mapSizeForEditsModel', () => {
    test('方形尺寸映射为 1024x1024', () => {
        expect(mapSizeForEditsModel('1024x1024')).toBe('1024x1024');
        expect(mapSizeForEditsModel('1920x1920')).toBe('1024x1024');
    });

    test('竖版尺寸映射为 1024x1536', () => {
        expect(mapSizeForEditsModel('1024x1536')).toBe('1024x1536');
        expect(mapSizeForEditsModel('1920x2880')).toBe('1024x1536');
    });

    test('横版尺寸映射为 1536x1024', () => {
        expect(mapSizeForEditsModel('1536x1024')).toBe('1536x1024');
        expect(mapSizeForEditsModel('2880x1920')).toBe('1536x1024');
    });

    test('auto 或空值返回 null', () => {
        expect(mapSizeForEditsModel('auto')).toBeNull();
        expect(mapSizeForEditsModel('')).toBeNull();
        expect(mapSizeForEditsModel(null)).toBeNull();
    });
});

describe('buildAspectRatioHint（Gemini 图像系比例指令）', () => {
    test('auto / 空值 / 无法解析的格式返回空串', () => {
        expect(buildAspectRatioHint('auto')).toBe('');
        expect(buildAspectRatioHint('')).toBe('');
        expect(buildAspectRatioHint(null)).toBe('');
        expect(buildAspectRatioHint('abc')).toBe('');
    });

    test('竖版 928x1664 识别为 9:16 并输出中英双语指令', () => {
        const hint = buildAspectRatioHint('928x1664');
        expect(hint).toContain('9:16');
        expect(hint).toContain('portrait');
        expect(hint).toContain('928x1664');
        expect(hint).toContain('竖版');
    });

    test('横版尺寸识别为横版比例', () => {
        const hint = buildAspectRatioHint('1664x928');
        expect(hint).toContain('16:9');
        expect(hint).toContain('landscape');
        expect(hint).toContain('横版');
    });

    test('方图尺寸识别为 1:1', () => {
        const hint = buildAspectRatioHint('1024x1024');
        expect(hint).toContain('1:1');
        expect(hint).toContain('square');
    });

    test('生僻比例按精确宽高比输出', () => {
        const hint = buildAspectRatioHint('1234x1777');
        expect(hint).toContain('1234:1777');
    });
});
