/**
 * ==========================================================================
 * modelAdapters 适配器注册表单元测试
 * 覆盖按模型家族与请求形态的适配器匹配规则与接口完整性。
 * ==========================================================================
 */

const { pickImageAdapter, adapters } = require('../../utils/modelAdapters');

describe('pickImageAdapter 适配器匹配', () => {
    test('gpt-image 系 + 参考图 → edits-image 适配器', () => {
        const adapter = pickImageAdapter({ model: 'gpt-image-2', imageList: ['data:image/png;base64,xx'] });
        expect(adapter.id).toBe('edits-image');
    });

    test('dall-e 系 + 参考图 → edits-image 适配器', () => {
        const adapter = pickImageAdapter({ model: 'dall-e-3', imageList: ['data:image/png;base64,xx'] });
        expect(adapter.id).toBe('edits-image');
    });

    test('nano-banana / Gemini 图像系 + 参考图 → chat-image 适配器', () => {
        for (const model of ['nano-banana-2', 'gemini-2.5-flash-image']) {
            const adapter = pickImageAdapter({ model, imageList: ['data:image/png;base64,xx'] });
            expect(adapter.id).toBe('chat-image');
        }
    });

    test('无参考图时一律走 generations 兜底（含 edits / chat 家族模型）', () => {
        for (const model of ['gpt-image-2', 'nano-banana-2', 'doubao-seedream-5-0-pro']) {
            const adapter = pickImageAdapter({ model, imageList: [] });
            expect(adapter.id).toBe('generations-image');
        }
    });

    test('Seedream 等未特殊识别的模型带参考图也走 generations 兜底', () => {
        const adapter = pickImageAdapter({ model: 'doubao-seedream-5-0-pro', imageList: ['data:image/png;base64,xx'] });
        expect(adapter.id).toBe('generations-image');
    });

    test('兜底保证：任意未知模型总有适配器返回', () => {
        const adapter = pickImageAdapter({ model: 'some-future-model', imageList: [] });
        expect(adapter).toBeDefined();
        expect(typeof adapter.run).toBe('function');
    });
});

describe('适配器接口完整性', () => {
    test('每个注册适配器都实现 id / mode / match / run', () => {
        expect(adapters.length).toBeGreaterThanOrEqual(3);
        for (const adapter of adapters) {
            expect(typeof adapter.id).toBe('string');
            expect(['sync', 'task']).toContain(adapter.mode);
            expect(typeof adapter.match).toBe('function');
            expect(typeof adapter.run).toBe('function');
        }
    });

    test('兜底适配器（generations-image）必须注册在末位', () => {
        // 兜底永远命中，若不在末位会遮蔽其前面的所有适配器
        expect(adapters[adapters.length - 1].id).toBe('generations-image');
    });
});
