/**
 * ==========================================================================
 * routes/llm.js 集成测试
 * 覆盖聊天、图像生成（三种模型分支）和代理下载路由。
 * 通过 mock utils/llmProviders.js 避免真实 HTTP 请求。
 * ==========================================================================
 */

const express = require('express');
const request = require('supertest');
const path = require('path');

//  mock 设置文件内容，避免读取真实 data/settings.json
jest.mock('fs', () => ({
    promises: {
        readFile: jest.fn(async (filePath) => {
            if (filePath.includes('settings.json')) {
                return JSON.stringify({
                    api: {
                        currentProvider: 'TestProvider',
                        providers: {
                            TestProvider: {
                                endpoint: 'https://api.test.com/v1',
                                apiKey: 'test-key',
                                models: [
                                    { id: 'doubao-seedream-5-0-pro', type: 'image' },
                                    { id: 'gpt-image-2', type: 'image' },
                                    { id: 'gemini-2.5-flash-image', type: 'image' },
                                    { id: 'deepseek-chat', type: 'chat' }
                                ]
                            },
                            // 与 TestProvider 有同名模型的第二个厂商：
                            // 验证显式 provider 路由与同名模型遮蔽行为
                            OtherRelay: {
                                endpoint: 'https://other.test.com/v1',
                                apiKey: 'other-key',
                                models: [
                                    { id: 'gpt-image-2', type: 'image' },
                                    { id: 'deepseek-chat', type: 'chat' }
                                ]
                            }
                        }
                    }
                });
            }
            throw new Error('unexpected file read');
        })
    }
}));

// mock 提供商请求函数
const mockRequestChatCompletions = jest.fn();
const mockRequestImageGeneration = jest.fn();
const mockRequestImageEdit = jest.fn();
const mockProxyImageDownload = jest.fn();

jest.mock('../../utils/llmProviders', () => ({
    buildChatUrl: jest.fn((endpoint) => new URL(`${endpoint}/chat/completions`)),
    buildImageGenerationUrl: jest.fn((endpoint) => new URL(`${endpoint}/images/generations`)),
    buildImageEditUrl: jest.fn((endpoint) => new URL(`${endpoint}/images/edits`)),
    requestChatCompletions: (...args) => mockRequestChatCompletions(...args),
    requestImageGeneration: (...args) => mockRequestImageGeneration(...args),
    requestImageEdit: (...args) => mockRequestImageEdit(...args),
    proxyImageDownload: (...args) => mockProxyImageDownload(...args)
}));

const createLlmRouter = require('../../routes/llm');

function createApp() {
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api/llm', createLlmRouter({ dataDir: path.join(__dirname, '../../data') }));
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('POST /api/llm/chat', () => {
    test('正常转发聊天请求并返回回复', async () => {
        mockRequestChatCompletions.mockResolvedValue({
            choices: [{ message: { content: '你好，我是助手' } }]
        });

        const app = createApp();
        const res = await request(app)
            .post('/api/llm/chat')
            .send({
                model: 'deepseek-chat',
                messages: [{ role: 'user', content: '你好' }]
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.reply).toBe('你好，我是助手');
        expect(mockRequestChatCompletions).toHaveBeenCalledTimes(1);

        const [, , payload] = mockRequestChatCompletions.mock.calls[0];
        expect(payload.model).toBe('deepseek-chat');
        expect(payload.messages).toEqual([{ role: 'user', content: '你好' }]);
    });

    test('附带图片时最后一条用户消息转为多模态内容', async () => {
        mockRequestChatCompletions.mockResolvedValue({
            choices: [{ message: { content: '看到了' } }]
        });

        const app = createApp();
        const dataUrl = 'data:image/png;base64,abc';
        const res = await request(app)
            .post('/api/llm/chat')
            .send({
                model: 'deepseek-chat',
                messages: [{ role: 'user', content: '描述这张图片' }],
                images: [dataUrl]
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.reply).toBe('看到了');

        const [, , payload] = mockRequestChatCompletions.mock.calls[0];
        expect(payload.messages[0].content).toEqual([
            { type: 'text', text: '描述这张图片' },
            { type: 'image_url', image_url: { url: dataUrl } }
        ]);
    });

    test('缺少模型返回 400', async () => {
        const app = createApp();
        const res = await request(app)
            .post('/api/llm/chat')
            .send({ messages: [{ role: 'user', content: '你好' }] });

        expect(res.statusCode).toBe(400);
        expect(res.body.status).toBe('error');
    });
});

describe('POST /api/llm/generate-image', () => {
    test('豆包 Seedream 文生图走 /images/generations 并透传 size/quality', async () => {
        mockRequestImageGeneration.mockResolvedValue({
            data: [{ b64_json: 'seedream-base64' }]
        });

        const app = createApp();
        const res = await request(app)
            .post('/api/llm/generate-image')
            .send({
                model: 'doubao-seedream-5-0-pro',
                prompt: '一只猫',
                size: '1920x2880',
                quality: 'high'
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.imageUrl).toContain('seedream-base64');
        expect(mockRequestImageGeneration).toHaveBeenCalledTimes(1);

        const [, , payload] = mockRequestImageGeneration.mock.calls[0];
        expect(payload.model).toBe('doubao-seedream-5-0-pro');
        // 比例指令追加在原始提示词末尾（Gemini 图像系等忽略 size 参数的模型依赖它）
        expect(payload.prompt).toContain('一只猫');
        expect(payload.prompt).toContain('2:3');
        expect(payload.size).toBe('1920x2880');
        expect(payload.quality).toBe('high');
        expect(payload.output_format).toBe('png');
        expect(payload.response_format).toBe('b64_json');
    });

    test('豆包 Seedream 图生图把参考图放入 image 参数', async () => {
        mockRequestImageGeneration.mockResolvedValue({
            data: [{ b64_json: 'i2i-base64' }]
        });

        const app = createApp();
        const dataUrl = 'data:image/jpeg;base64,ref';
        const res = await request(app)
            .post('/api/llm/generate-image')
            .send({
                model: 'doubao-seedream-5-0-pro',
                prompt: '改成蓝色',
                images: [dataUrl]
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('ok');

        const [, , payload] = mockRequestImageGeneration.mock.calls[0];
        expect(payload.image).toEqual([dataUrl]);
        expect(payload.output_format).toBe('png');
    });

    test('gpt-image 图生图走 /images/edits 并透传 multipart 参数', async () => {
        mockRequestImageEdit.mockResolvedValue({
            data: [{ url: 'https://api.test.com/edited.png' }]
        });

        const app = createApp();
        const dataUrl = 'data:image/png;base64,ref123';
        const res = await request(app)
            .post('/api/llm/generate-image')
            .send({
                model: 'gpt-image-2',
                prompt: '改成赛博朋克风格',
                size: '2880x1920',
                quality: 'high',
                images: [dataUrl]
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.imageUrl).toBe('https://api.test.com/edited.png');
        expect(mockRequestImageEdit).toHaveBeenCalledTimes(1);

        const [, , params] = mockRequestImageEdit.mock.calls[0];
        expect(params.model).toBe('gpt-image-2');
        expect(params.prompt).toBe('改成赛博朋克风格');
        expect(params.size).toBe('2880x1920');
        expect(params.quality).toBe('high');
        expect(params.images).toEqual([dataUrl]);
    });

    test('Gemini 图像模型图生图走 chat/completions 多模态消息', async () => {
        mockRequestChatCompletions.mockResolvedValue({
            choices: [{
                message: {
                    content: '![gen](data:image/png;base64,gemini-img)'
                }
            }]
        });

        const app = createApp();
        const dataUrl = 'data:image/png;base64,ref';
        const res = await request(app)
            .post('/api/llm/generate-image')
            .send({
                model: 'gemini-2.5-flash-image',
                prompt: '重绘',
                images: [dataUrl]
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.imageUrl).toBe('data:image/png;base64,gemini-img');
        expect(mockRequestChatCompletions).toHaveBeenCalledTimes(1);

        const [, , payload] = mockRequestChatCompletions.mock.calls[0];
        expect(payload.messages[0].content).toEqual([
            { type: 'text', text: '重绘' },
            { type: 'image_url', image_url: { url: dataUrl } }
        ]);
    });

    test('缺少模型返回 400', async () => {
        const app = createApp();
        const res = await request(app)
            .post('/api/llm/generate-image')
            .send({ prompt: '一只猫' });

        expect(res.statusCode).toBe(400);
        expect(res.body.status).toBe('error');
    });
});

describe('GET /api/llm/download-image', () => {
    test('代理下载图片并设置下载头', async () => {
        const buffer = Buffer.from('fake-image-data');
        mockProxyImageDownload.mockResolvedValue({
            buffer,
            contentType: 'image/png'
        });

        const app = createApp();
        const res = await request(app)
            .get('/api/llm/download-image')
            .query({ url: 'https://example.com/img.png', filename: '测试图.png' });

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('image/png');
        expect(res.headers['content-disposition']).toContain("filename*=UTF-8''%E6%B5%8B%E8%AF%95%E5%9B%BE.png");
        expect(mockProxyImageDownload).toHaveBeenCalledWith('https://example.com/img.png');
    });

    test('缺少 url 返回 400', async () => {
        const app = createApp();
        const res = await request(app)
            .get('/api/llm/download-image')
            .query({ filename: 'test.png' });

        expect(res.statusCode).toBe(400);
        expect(res.body.status).toBe('error');
    });
});

describe('显式 provider 路由（同名模型多厂商共存）', () => {
    test('generate-image 显式指定厂商时路由到该厂商', async () => {
        mockRequestImageGeneration.mockResolvedValue({
            data: [{ b64_json: 'from-other-relay' }]
        });

        const app = createApp();
        const res = await request(app)
            .post('/api/llm/generate-image')
            .send({
                model: 'gpt-image-2',
                prompt: '一只猫',
                provider: 'OtherRelay'
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.imageUrl).toContain('from-other-relay');
        // 显式指定的 OtherRelay 命中：请求用的是它的 Key（而非先命中的 TestProvider）
        const [, apiKey] = mockRequestImageGeneration.mock.calls[0];
        expect(apiKey).toBe('other-key');
    });

    test('未指定 provider 时保持首个命中（TestProvider 优先）', async () => {
        mockRequestImageGeneration.mockResolvedValue({
            data: [{ b64_json: 'from-test-provider' }]
        });

        const app = createApp();
        const res = await request(app)
            .post('/api/llm/generate-image')
            .send({ model: 'gpt-image-2', prompt: '一只猫' });

        expect(res.statusCode).toBe(200);
        const [, apiKey] = mockRequestImageGeneration.mock.calls[0];
        expect(apiKey).toBe('test-key');
    });

    test('显式厂商不存在或不含该模型时回退自动路由', async () => {
        mockRequestImageGeneration.mockResolvedValue({
            data: [{ b64_json: 'fallback' }]
        });

        const app = createApp();
        const res = await request(app)
            .post('/api/llm/generate-image')
            .send({
                model: 'doubao-seedream-5-0-pro',   // OtherRelay 没有这个模型
                prompt: '一只猫',
                provider: 'OtherRelay'
            });

        expect(res.statusCode).toBe(200);
        const [, apiKey] = mockRequestImageGeneration.mock.calls[0];
        expect(apiKey).toBe('test-key');
    });

    test('chat 显式指定厂商时路由到该厂商', async () => {
        mockRequestChatCompletions.mockResolvedValue({
            choices: [{ message: { content: '来自 OtherRelay' } }]
        });

        const app = createApp();
        const res = await request(app)
            .post('/api/llm/chat')
            .send({
                model: 'deepseek-chat',
                messages: [{ role: 'user', content: '你好' }],
                provider: 'OtherRelay'
            });

        expect(res.statusCode).toBe(200);
        const [, apiKey] = mockRequestChatCompletions.mock.calls[0];
        expect(apiKey).toBe('other-key');
    });
});
