/**
 * Responses API 接口格式支持测试（2026-11-20）
 * 覆盖：chat/completions 载荷 → Responses 载荷转换（system 合并 instructions/
 * 角色部件类型映射/多模态 image_url→input_image/无效项丢弃）、响应文本
 * 提取（标准 output[]/output_text 便捷字段/choices 兜底/reasoning 跳过）。
 * 网络层（requestChatAuto 实发）属后端集成，vm 不覆盖。
 */

const {
    buildResponsesUrl,
    convertChatPayloadToResponses,
    extractResponsesText
} = require('../../utils/llmProviders');

describe('buildResponsesUrl 端点转换', () => {
    test('端点拼接 /responses，尾斜杠兼容', () => {
        expect(buildResponsesUrl('https://api.example.com/v1').href)
            .toBe('https://api.example.com/v1/responses');
        expect(buildResponsesUrl('https://api.example.com/v1/').href)
            .toBe('https://api.example.com/v1/responses');
    });
});

describe('convertChatPayloadToResponses 载荷转换', () => {
    test('system 合并为 instructions（多条换行拼接）', () => {
        const body = convertChatPayloadToResponses({
            model: 'gpt-6.1',
            messages: [
                { role: 'system', content: '你是助手' },
                { role: 'system', content: '回答要简洁' },
                { role: 'user', content: '你好' }
            ]
        });
        expect(body.model).toBe('gpt-6.1');
        expect(body.instructions).toBe('你是助手\n\n回答要简洁');
        expect(body.input).toEqual([
            { role: 'user', content: [{ type: 'input_text', text: '你好' }] }
        ]);
    });

    test('纯文本消息：user→input_text，assistant→output_text', () => {
        const body = convertChatPayloadToResponses({
            model: 'm',
            messages: [
                { role: 'user', content: '第一问' },
                { role: 'assistant', content: '第一答' }
            ]
        });
        expect(body.input).toEqual([
            { role: 'user', content: [{ type: 'input_text', text: '第一问' }] },
            { role: 'assistant', content: [{ type: 'output_text', text: '第一答' }] }
        ]);
        expect(body.instructions).toBeUndefined();   // 无 system 不出 instructions 键
    });

    test('多模态部件：image_url→input_image（dataUrl 直传）', () => {
        const body = convertChatPayloadToResponses({
            model: 'm',
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: '看这张图' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }
                ]
            }]
        });
        expect(body.input[0].content).toEqual([
            { type: 'input_text', text: '看这张图' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAA' }
        ]);
    });

    test('无效项防御：非目标角色/空文本/缺 url 的图片部件全部丢弃', () => {
        const body = convertChatPayloadToResponses({
            model: 'm',
            messages: [
                { role: 'tool', content: '工具结果' },
                { role: 'user', content: '' },
                { role: 'user', content: [{ type: 'image_url', image_url: {} }] },
                { role: 'user', content: [{ type: 'text', text: '真话' }, null] }
            ]
        });
        expect(body.input).toHaveLength(1);
        expect(body.input[0].content).toEqual([{ type: 'input_text', text: '真话' }]);
    });
});

describe('extractResponsesText 响应文本提取', () => {
    test('标准 output[]：message 项 output_text 拼接，reasoning 项跳过', () => {
        const text = extractResponsesText({
            output: [
                { type: 'reasoning', summary: [{ text: '思考中' }] },
                { type: 'message', content: [
                    { type: 'output_text', text: '你好，' },
                    { type: 'output_text', text: '我是助手。' }
                ] }
            ]
        });
        expect(text).toBe('你好，我是助手。');
    });

    test('output_text 便捷字段兜底（SDK/中转代理）', () => {
        expect(extractResponsesText({ output_text: '直接答案' })).toBe('直接答案');
    });

    test('choices 兜底（中转在 /responses 上回 completions 形状）', () => {
        expect(extractResponsesText({ choices: [{ message: { content: '兼容回复' } }] }))
            .toBe('兼容回复');
        expect(extractResponsesText({ choices: [{ message: { content: [
            { type: 'text', text: '分段' }, { type: 'text', text: '回复' }
        ] } }] })).toBe('分段回复');
    });

    test('提取不到返回空串；垃圾入参安全', () => {
        expect(extractResponsesText({ output: [{ type: 'reasoning' }] })).toBe('');
        expect(extractResponsesText({})).toBe('');
        expect(extractResponsesText(null)).toBe('');
        expect(extractResponsesText('文本')).toBe('');
    });
});
