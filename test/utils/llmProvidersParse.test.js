/**
 * ==========================================================================
 * llmProviders 响应解析单元测试
 * 覆盖 parseResponseBody 的多级解析（标准 JSON / BOM / gzip / SSE 事件流聚合）
 * 与失败时的响应片段回传。该文件是 CommonJS 模块，可直接 require。
 * ==========================================================================
 */

const zlib = require('zlib');
const {
    parseResponseBody,
    tryParseSsePayload
} = require('../../utils/llmProviders');

describe('parseResponseBody 多级解析', () => {
    test('标准 JSON 直接解析', () => {
        const raw = Buffer.from(JSON.stringify({ data: [{ url: 'http://x/a.png' }] }));
        expect(parseResponseBody(raw, 200, {}, '解析失败').data[0].url).toBe('http://x/a.png');
    });

    test('剥离 UTF-8 BOM 后正常解析', () => {
        const raw = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('{"ok":1}')]);
        expect(parseResponseBody(raw, 200, {}, '解析失败').ok).toBe(1);
    });

    test('gzip 压缩响应按 content-encoding 解压', () => {
        const raw = zlib.gzipSync(Buffer.from('{"compressed":true}'));
        expect(parseResponseBody(raw, 200, { 'content-encoding': 'gzip' }, '解析失败').compressed).toBe(true);
    });

    test('brotli 压缩响应按 content-encoding 解压', () => {
        const raw = zlib.brotliCompressSync(Buffer.from('{"br":1}'));
        expect(parseResponseBody(raw, 200, { 'content-encoding': 'br' }, '解析失败').br).toBe(1);
    });

    test('空响应抛出明确错误', () => {
        expect(() => parseResponseBody(Buffer.alloc(0), 200, {}, '解析图像生成响应失败'))
            .toThrow(/空响应/);
    });

    test('HTML 等非 JSON 内容抛错且错误消息携带响应片段', () => {
        const html = '<html><body>gateway error</body></html>';
        expect(() => parseResponseBody(Buffer.from(html), 200, {}, '解析图像生成响应失败'))
            .toThrow(/gateway error/);
    });
});

describe('SSE 事件流聚合（中转站流式图像生成）', () => {
    const sse = [
        'event: started',
        'data: {"created":1789149705,"id":"abc","model":"gpt-image-2"}',
        '',
        'event: heartbeat',
        'data: {"created":1789149705,"id":"abc"}',
        '',
        'event: completed',
        'data: {"created":1789149800,"data":[{"url":"http://x/final.png"}]}',
        '',
        'data: [DONE]'
    ].join('\n');

    test('聚合并挑选最后一个携带图片指标的完成事件', () => {
        const result = parseResponseBody(Buffer.from(sse), 200, {}, '解析图像生成响应失败');
        expect(result.data[0].url).toBe('http://x/final.png');
    });

    test('b64_json 形式的完成事件同样可识别', () => {
        const text = [
            'event: started',
            'data: {"id":"abc"}',
            'data: {"data":[{"b64_json":"AAAA"}]}'
        ].join('\n');
        expect(tryParseSsePayload(text).data[0].b64_json).toBe('AAAA');
    });

    test('images 数组形式的完成事件同样可识别', () => {
        const text = 'data: {"id":"abc"}\ndata: {"images":["http://x/1.png"]}';
        expect(tryParseSsePayload(text).images[0]).toBe('http://x/1.png');
    });

    test('没有任何事件带图片时返回最后一个解析成功的事件（上层给出"未返回图片"）', () => {
        const text = 'data: {"created":1,"id":"abc"}\ndata: {"created":2,"id":"abc"}';
        expect(tryParseSsePayload(text).created).toBe(2);
    });

    test('没有 data: 行的普通文本返回 null（走片段回传路径）', () => {
        expect(tryParseSsePayload('<html>error page</html>')).toBeNull();
    });

    test('流中显式错误事件透出真实原因', () => {
        const text = 'event: error\ndata: {"error":{"message":"余额不足"}}';
        expect(() => parseResponseBody(Buffer.from(text), 200, {}, '解析图像生成响应失败'))
            .toThrow(/余额不足/);
    });
});
