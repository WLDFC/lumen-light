/**
 * ==========================================================================
 * ComfyParamScanner 单元测试
 * 覆盖共享扫描器的工作流参数探测与覆盖表编译：
 *   - scan：加载节点/步数/CFG/采样器/降噪/尺寸/批次分桶，连线输入排除
 *   - buildOverrides：状态 → { [节点id]: { [输入键]: 值 } } 覆盖表
 * 被测文件是浏览器端经典脚本（依赖全局 window），用 vm 模块在
 * 同一上下文中执行（与 nodeTypes.test.js 同一套做法）。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {} };
vm.createContext(context);

const source = fs.readFileSync(
    path.join(__dirname, '../../js/utils/ComfyParamScanner.js'), 'utf-8');
vm.runInContext(source, context, { filename: 'ComfyParamScanner.js' });

const Scanner = context.window.ComfyParamScanner;

/** 合成的文生图工作流（Checkpoint + KSampler + EmptyLatentImage + LoRA） */
function sampleWorkflow() {
    return {
        '1': {
            class_type: 'CheckpointLoaderSimple',
            inputs: { ckpt_name: 'modelA.safetensors' }
        },
        '2': {
            class_type: 'LoraLoader',
            inputs: {
                lora_name: 'detail.safetensors',
                strength_model: 0.8,
                strength_clip: 1.0,
                model: ['1', 0]   // 连线输入，不应被当作可调参数
            }
        },
        '3': {
            class_type: 'KSampler',
            inputs: {
                seed: 123,          // 数值但不属于任何探测字段
                steps: 20,
                cfg: 7.5,
                sampler_name: 'euler',
                denoise: 1.0,
                model: ['2', 0],
                positive: ['4', 0],
                negative: ['5', 0],
                latent_image: ['6', 0]
            }
        },
        '6': {
            class_type: 'EmptyLatentImage',
            inputs: { width: 1024, height: 768, batch_size: 1 }
        }
    };
}

describe('ComfyParamScanner.scan', () => {
    test('加载节点：checkpoint 与 lora 分桶，lora 记录强度字段', () => {
        const d = Scanner.scan(sampleWorkflow());
        expect(d.loaders).toHaveLength(2);
        const ckpt = d.loaders.find(l => l.kind === 'checkpoint');
        const lora = d.loaders.find(l => l.kind === 'lora');
        expect(ckpt).toMatchObject({ nodeId: '1', field: 'ckpt_name', current: 'modelA.safetensors' });
        expect(lora).toMatchObject({ nodeId: '2', field: 'lora_name', current: 'detail.safetensors' });
        expect(lora.strengthFields).toEqual(['strength_model', 'strength_clip']);
    });

    test('步数/CFG/采样器/降噪/尺寸/批次按字段分桶并记录工作流当前值', () => {
        const d = Scanner.scan(sampleWorkflow());
        expect(d.stepsTargets).toEqual([{ nodeId: '3', current: 20 }]);
        expect(d.cfgTargets).toEqual([{ nodeId: '3', current: 7.5 }]);
        expect(d.samplerTargets).toEqual([{ nodeId: '3', current: 'euler' }]);
        expect(d.denoiseTargets).toEqual([{ nodeId: '3', current: 1.0 }]);
        expect(d.sizeTargets).toEqual([{ nodeId: '6', width: 1024, height: 768 }]);
        expect(d.batchTargets).toEqual([{ nodeId: '6', field: 'batch_size' }]);
    });

    test('空工作流返回全空桶', () => {
        const d = Scanner.scan({});
        expect(d.loaders).toEqual([]);
        expect(d.stepsTargets).toEqual([]);
        expect(d.sizeTargets).toEqual([]);
    });
});

describe('ComfyParamScanner.buildOverrides', () => {
    test('状态值编译为 { [节点id]: { [输入键]: 值 } } 覆盖表', () => {
        const d = Scanner.scan(sampleWorkflow());
        const overrides = Scanner.buildOverrides(d, {
            models: { '1': 'modelB.safetensors', '2': 'loraX.safetensors' },
            loraEnabled: { '2': true },
            steps: 30,
            cfg: null,
            sampler: 'dpmpp_2m',
            sizeW: 1280,
            sizeH: 960,
            denoise: null,
            count: 2
        });
        expect(overrides).toEqual({
            '1': { ckpt_name: 'modelB.safetensors' },
            '2': { lora_name: 'loraX.safetensors' },  // 启用时不碰 strength
            '3': { steps: 30, sampler_name: 'dpmpp_2m' },
            '6': { width: 1280, height: 960, batch_size: 2 }
        });
    });

    test('LoRA 未启用时强度注入 0（软关闭）', () => {
        const d = Scanner.scan(sampleWorkflow());
        const overrides = Scanner.buildOverrides(d, {
            models: {}, loraEnabled: {}, steps: null, cfg: null,
            sampler: null, sizeW: null, sizeH: null, denoise: null, count: 1
        });
        expect(overrides['2']).toEqual({ strength_model: 0, strength_clip: 0 });
        // 未设置的数值参数不产生覆盖，走工作流原值
        expect(overrides['3']).toBeUndefined();
    });

    test('detected 为 null 时返回空覆盖表', () => {
        expect(Scanner.buildOverrides(null, {})).toEqual({});
    });
});
