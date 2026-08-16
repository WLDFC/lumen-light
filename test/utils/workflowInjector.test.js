/**
 * ==========================================================================
 * workflowInjector 单元测试
 * 覆盖节点类型识别辅助函数与提示词注入的核心分支。
 * 模块为纯 CommonJS（无浏览器依赖），可直接 require。
 * ==========================================================================
 */

const {
    isTextEncodeType,
    getPromptField,
    isSamplerType,
    injectPromptsToWorkflow
} = require('../../utils/workflowInjector');

describe('节点类型识别辅助函数', () => {
    test('isTextEncodeType：内置类型、自定义节点与兜底规则', () => {
        expect(isTextEncodeType('CLIPTextEncode')).toBe(true);
        expect(isTextEncodeType('CLIPTextEncodeFlux')).toBe(true);
        expect(isTextEncodeType('TextEncodeQwenImageEditPlus')).toBe(true);
        // 兜底：名字带 TextEncode 的自定义节点
        expect(isTextEncodeType('MyCustomTextEncodePlus')).toBe(true);
        // 非文本编码节点
        expect(isTextEncodeType('KSampler')).toBe(false);
        expect(isTextEncodeType('VAEDecode')).toBe(false);
        expect(isTextEncodeType(undefined)).toBe(false);
    });

    test('getPromptField：text 优先于 prompt，都无则 null', () => {
        expect(getPromptField({ text: '', clip: [] })).toBe('text');
        expect(getPromptField({ prompt: '' })).toBe('prompt');
        expect(getPromptField({})).toBeNull();
        // ConditioningZeroOut 类节点没有文本输入
        expect(getPromptField({ conditioning: [] })).toBeNull();
    });

    test('isSamplerType：KSampler 系与 SamplerCustomAdvanced', () => {
        expect(isSamplerType('KSampler')).toBe(true);
        expect(isSamplerType('KSamplerAdvanced')).toBe(true);
        expect(isSamplerType('SamplerCustomAdvanced')).toBe(true);
        expect(isSamplerType('CLIPTextEncode')).toBe(false);
        expect(isSamplerType(undefined)).toBe(false);
    });
});

describe('injectPromptsToWorkflow 注入行为', () => {
    test('单文本编码节点：正面注入自身，负面沿 Sampler negative 链追踪注入', () => {
        const workflow = {
            '3': {
                class_type: 'KSampler',
                inputs: { seed: 1, positive: ['602', 0], negative: ['604', 0] }
            },
            '602': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 0] } },
            '604': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 0] } }
        };

        injectPromptsToWorkflow(workflow, '一个女孩', 'lowres');

        expect(workflow['602'].inputs.text).toBe('一个女孩');
        expect(workflow['604'].inputs.text).toBe('lowres');
        // 随机种子也被注入
        expect(workflow['3'].inputs.seed).not.toBe(1);
    });

    test('负面链指向不存在的节点时防御跳过，正面照常注入', () => {
        const workflow = {
            '3': {
                class_type: 'KSampler',
                inputs: { seed: 1, positive: ['602', 0], negative: ['999', 0] }
            },
            '602': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 0] } }
        };

        injectPromptsToWorkflow(workflow, '一只猫', 'lowres');

        expect(workflow['602'].inputs.text).toBe('一只猫');
    });
});
