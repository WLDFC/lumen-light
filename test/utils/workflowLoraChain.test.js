/**
 * ==========================================================================
 * injectLoraChain（画布 LoRA 堆栈图拼接，追加语义）单元测试
 * 语义分工：模板内嵌 LoRA 由 Comfy 生图节点的 LoRA 行管理（本函数不碰）；
 *           画布堆栈为增量补充，追加在模型/CLIP 信号链的最末端。
 * 用例覆盖两种真实工作流结构：
 *   - anima/qwen 型：模板自带 LoraLoader（KSampler 消费模型）
 *   - flux2 型：模板无任何 LoraLoader（CFGGuider 消费模型、无 denoise）
 * ==========================================================================
 */

const { injectLoraChain } = require('../../utils/workflowInjector');

/** anima 型：模板自带一个 LoraLoader 串在 UNETLoader 与 KSampler 之间 */
function buildAnimaWorkflow() {
    return {
        '1': { class_type: 'UNETLoader', inputs: { unet_name: 'a.safetensors', weight_dtype: 'default' } },
        '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'clip.safetensors', type: 'stable_diffusion' } },
        '3': {
            class_type: 'LoraLoader',
            inputs: {
                lora_name: 'template-lora.safetensors',
                strength_model: 0.8,
                strength_clip: 0.9,
                model: ['1', 0],
                clip: ['2', 0]
            }
        },
        '4': {
            class_type: 'KSampler',
            inputs: { steps: 30, cfg: 5, sampler_name: 'er_sde', scheduler: 'simple', denoise: 1, model: ['3', 0] }
        },
        '5': { class_type: 'CLIPTextEncode', inputs: { text: 'cat', clip: ['3', 1] } }
    };
}

/** flux2 型：模板没有任何 LoRA 节点（CFGGuider 消费模型，无 denoise） */
function buildFlux2Workflow() {
    return {
        '1': { class_type: 'UNETLoader', inputs: { unet_name: 'flux.safetensors', weight_dtype: 'default' } },
        '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen.safetensors', type: 'flux2' } },
        '3': { class_type: 'CFGGuider', inputs: { cfg: 1, model: ['1', 0] } },
        '4': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
        '5': { class_type: 'CLIPTextEncode', inputs: { text: 'p', clip: ['2', 0] } }
    };
}

const STACK = [
    { file: 'style.safetensors', strengthModel: 0.7, strengthClip: 0.6 },
    { file: 'character.safetensors', strengthModel: 1.0, strengthClip: 1.0 }
];

describe('injectLoraChain：模板无 LoRA 的工作流（flux2 型）', () => {
    test('动态创建 LoRA 链并接管模型与 clip 消费方', () => {
        const wf = injectLoraChain(buildFlux2Workflow(), STACK);

        const loraIds = Object.keys(wf).filter((id) => id.startsWith('lumen_lora_'));
        expect(loraIds).toHaveLength(2);

        // 链首接模型源，逐级串接
        expect(wf[loraIds[0]].inputs.model).toEqual(['1', 0]);
        expect(wf[loraIds[1]].inputs.model).toEqual([loraIds[0], 0]);

        // 文件与双强度逐条写入
        expect(wf[loraIds[0]].inputs.lora_name).toBe('style.safetensors');
        expect(wf[loraIds[0]].inputs.strength_model).toBe(0.7);
        expect(wf[loraIds[0]].inputs.strength_clip).toBe(0.6);
        expect(wf[loraIds[1]].inputs.lora_name).toBe('character.safetensors');

        // 消费方改指向链尾：模型 → 槽位 0，clip → 槽位 1
        expect(wf['3'].inputs.model).toEqual([loraIds[1], 0]);
        expect(wf['5'].inputs.clip).toEqual([loraIds[1], 1]);
    });

    test('空堆栈 / 全部缺 file 时原样返回、不创建链', () => {
        const wf = buildFlux2Workflow();
        expect(injectLoraChain(wf, [])).toBe(wf);
        expect(injectLoraChain(wf, [{ strengthModel: 1 }])).toBe(wf);
        expect(Object.keys(wf).filter((id) => id.startsWith('lumen_lora_'))).toHaveLength(0);
    });

    test('工作流没有 model 连线输入时安全跳过', () => {
        const wf = { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['2', 0] } },
                     '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'c' } } };
        const out = injectLoraChain(wf, STACK);
        expect(Object.keys(out).filter((id) => id.startsWith('lumen_lora_'))).toHaveLength(0);
    });
});

describe('injectLoraChain：模板自带 LoraLoader 的工作流（anima 型，追加语义）', () => {
    test('画布堆栈追加在模板 LoRA 之后（KSampler 消费链尾）', () => {
        const wf = injectLoraChain(buildAnimaWorkflow(), STACK);

        const loraIds = Object.keys(wf).filter((id) => id.startsWith('lumen_lora_'));
        expect(loraIds).toHaveLength(2);

        // 链首接当前模型信号源 = 模板 LoRA 的输出（画布堆栈叠加在其上），
        // 逐级串接后 KSampler/CLIPTextEncode 改消费链尾
        expect(wf[loraIds[0]].inputs.model).toEqual(['3', 0]);
        expect(wf[loraIds[1]].inputs.model).toEqual([loraIds[0], 0]);
        expect(wf['4'].inputs.model).toEqual([loraIds[1], 0]);
        expect(wf['5'].inputs.clip).toEqual([loraIds[1], 1]);

        // 模板 LoRA 原样保留（由 Comfy 生图节点的 LoRA 行控制，本函数不碰）
        expect(wf['3'].inputs.strength_model).toBe(0.8);
        expect(wf['3'].inputs.strength_clip).toBe(0.9);
        expect(wf['3'].inputs.lora_name).toBe('template-lora.safetensors');
    });

    test('空堆栈：原样返回，模板 LoRA 按 LoRA 行控制照常', () => {
        const wf = buildAnimaWorkflow();
        expect(injectLoraChain(wf, [])).toBe(wf);
        expect(wf['4'].inputs.model).toEqual(['3', 0]);
    });
});
