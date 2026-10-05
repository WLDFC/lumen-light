/**
 * ==========================================================================
 * workflowBypass 单元测试
 * 覆盖 bypass 直通重连的核心分支：类型匹配直通、链式穿透、
 * 离线同名启发式、断链移除、防环、模板不被修改。
 * 模块为纯 CommonJS，可直接 require。
 * ==========================================================================
 */

const { applyBypass, typesMatch } = require('../../utils/workflowBypass');

/** object_info 样例：类型信息取自真实节点族的形态 */
const CLASS_INFO = {
    CheckpointLoaderSimple: {
        input: { required: { ckpt_name: [['a.safetensors'], {}] } },
        output: ['MODEL', 'CLIP', 'VAE'],
        output_name: ['MODEL', 'CLIP', 'VAE']
    },
    LoraLoaderModelOnly: {
        input: { required: { model: ['MODEL'], lora_name: [['x.safetensors'], {}], strength_model: ['FLOAT', { default: 1 }] } },
        output: ['MODEL'],
        output_name: ['MODEL']
    },
    CLIPTextEncode: {
        input: { required: { text: 'STRING', clip: ['CLIP'] } },
        output: ['CONDITIONING'],
        output_name: ['CONDITIONING']
    },
    KSampler: {
        input: { required: { model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'] } },
        output: ['LATENT'],
        output_name: ['LATENT']
    },
    VAEDecode: {
        input: { required: { samples: ['LATENT'], vae: ['VAE'] } },
        output: ['IMAGE'],
        output_name: ['IMAGE']
    },
    // 测试专用：三类型输入/输出（验证多槽位分流）
    TripleNode: {
        input: { required: { model: ['MODEL'], clip: ['CLIP'], vae: ['VAE'] } },
        output: ['MODEL', 'CLIP', 'VAE'],
        output_name: ['MODEL', 'CLIP', 'VAE']
    }
};

describe('typesMatch', () => {
    test('字符串相等 / 多类型声明交集 / 空值不匹配', () => {
        expect(typesMatch('MODEL', 'MODEL')).toBe(true);
        expect(typesMatch(['MODEL', 'CLIP'], 'CLIP')).toBe(true);
        expect(typesMatch('MODEL', ['VAE', 'CLIP'])).toBe(false);
        expect(typesMatch(null, 'MODEL')).toBe(false);
        expect(typesMatch('MODEL', undefined)).toBe(false);
    });
});

describe('applyBypass', () => {
    test('空 bypass 列表返回原对象', () => {
        const wf = { '1': { class_type: 'KSampler', inputs: {} } };
        expect(applyBypass(wf, [], CLASS_INFO)).toBe(wf);
        expect(applyBypass(wf, null, CLASS_INFO)).toBe(wf);
    });

    test('类型匹配直通：bypass LoRA 后下游 model 接回上游输出', () => {
        const wf = {
            '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
            '2': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: 'x.safetensors', strength_model: 1 } },
            '3': { class_type: 'KSampler', inputs: { model: ['2', 0], positive: ['p', 0], negative: ['n', 0], latent_image: ['l', 0] } },
            'p': { class_type: 'CLIPTextEncode', inputs: { text: 'hi', clip: ['1', 1] } },
            'n': { class_type: 'CLIPTextEncode', inputs: { text: 'bad', clip: ['1', 1] } },
            'l': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } }
        };
        const out = applyBypass(wf, ['2'], CLASS_INFO);
        expect(out['2']).toBeUndefined();                     // 被剔除
        expect(out['3'].inputs.model).toEqual(['1', 0]);      // 直通到 checkpoint 的 MODEL 槽
        expect(out['3'].inputs.positive).toEqual(['p', 0]);   // 无关输入不动
        // 模板不被修改
        expect(wf['3'].inputs.model).toEqual(['2', 0]);
        expect(wf['2']).toBeDefined();
    });

    test('多输出槽按槽位各自直通（bypass 三类型节点：MODEL/CLIP/VAE 分流）', () => {
        const wf = {
            '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
            '2': { class_type: 'TripleNode', inputs: { model: ['1', 0], clip: ['1', 1], vae: ['1', 2] } },
            '3': { class_type: 'KSampler', inputs: { model: ['2', 0], positive: ['p', 0], negative: ['n', 0], latent_image: ['l', 0] } },
            'p': { class_type: 'CLIPTextEncode', inputs: { text: 'hi', clip: ['2', 1] } },
            'n': { class_type: 'CLIPTextEncode', inputs: { text: 'bad', clip: ['2', 1] } },
            'l': { class_type: 'EmptyLatentImage', inputs: {} },
            '4': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['2', 2] } }
        };
        const out = applyBypass(wf, ['2'], CLASS_INFO);
        expect(out['3'].inputs.model).toEqual(['1', 0]);   // MODEL 槽直通
        expect(out['p'].inputs.clip).toEqual(['1', 1]);    // CLIP 槽直通
        expect(out['4'].inputs.vae).toEqual(['1', 2]);     // VAE 槽直通
    });

    test('链式 bypass：递归穿透到最终上游', () => {
        const wf = {
            '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
            '2': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: 'x.safetensors', strength_model: 1 } },
            '3': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['2', 0], lora_name: 'y.safetensors', strength_model: 0.5 } },
            '4': { class_type: 'KSampler', inputs: { model: ['3', 0], positive: ['p', 0], negative: ['n', 0], latent_image: ['l', 0] } },
            'p': { class_type: 'CLIPTextEncode', inputs: { text: 'hi', clip: ['1', 1] } },
            'n': { class_type: 'CLIPTextEncode', inputs: { text: 'bad', clip: ['1', 1] } },
            'l': { class_type: 'EmptyLatentImage', inputs: {} }
        };
        const out = applyBypass(wf, ['2', '3'], CLASS_INFO);
        expect(out['2']).toBeUndefined();
        expect(out['3']).toBeUndefined();
        expect(out['4'].inputs.model).toEqual(['1', 0]);
    });

    test('无匹配类型输入 → 断链移除（与 ComfyUI 行为一致）', () => {
        const wf = {
            '1': { class_type: 'CLIPTextEncode', inputs: { text: 'hi', clip: ['c', 0] } },
            '2': { class_type: 'KSampler', inputs: { model: ['m', 0], positive: ['1', 0], negative: ['n', 0], latent_image: ['l', 0] } },
            'c': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a' } },
            'm': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'b' } },
            'n': { class_type: 'CLIPTextEncode', inputs: { text: 'bad', clip: ['c', 0] } },
            'l': { class_type: 'EmptyLatentImage', inputs: {} }
        };
        const out = applyBypass(wf, ['1'], CLASS_INFO);
        // positive 需要 CONDITIONING，bypass 的 CLIPTextEncode 输入只有 CLIP（text 是常量）→ 无匹配 → 移除
        expect(out['1']).toBeUndefined();
        expect(out['2'].inputs.positive).toBeUndefined();
        expect(out['2'].inputs.model).toEqual(['m', 0]);   // 其他输入不动
    });

    test('离线启发式：同名输入优先，唯一连接输入直通', () => {
        const wf = {
            '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
            '2': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: 'x.safetensors', strength_model: 1 } },
            '3': { class_type: 'KSampler', inputs: { model: ['2', 0], positive: ['p', 0], negative: ['n', 0], latent_image: ['l', 0] } },
            'p': { class_type: 'CLIPTextEncode', inputs: { text: 'hi', clip: ['1', 1] } },
            'n': { class_type: 'CLIPTextEncode', inputs: { text: 'bad', clip: ['1', 1] } },
            'l': { class_type: 'EmptyLatentImage', inputs: {} }
        };
        // classInfo 传空（离线）：LoraLoaderModelOnly 的连接输入只有 model，
        // 同名匹配 + 唯一连接输入双条件命中
        const out = applyBypass(wf, ['2'], {});
        expect(out['2']).toBeUndefined();
        expect(out['3'].inputs.model).toEqual(['1', 0]);
    });

    test('成环引用按断链处理，不无限递归', () => {
        const wf = {
            '1': { class_type: 'CLIPTextEncode', inputs: { text: 'hi', clip: ['2', 0] } },
            '2': { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['1', 0] } },
            '3': { class_type: 'KSampler', inputs: { model: ['m', 0], positive: ['1', 0], negative: ['n', 0], latent_image: ['l', 0] } },
            'm': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a' } },
            'n': { class_type: 'CLIPTextEncode', inputs: { text: 'bad', clip: ['m', 1] } },
            'l': { class_type: 'EmptyLatentImage', inputs: {} }
        };
        const out = applyBypass(wf, ['1', '2'], CLASS_INFO);
        expect(out['1']).toBeUndefined();
        expect(out['2']).toBeUndefined();
        expect(out['3'].inputs.positive).toBeUndefined();   // 环 → 断链而非卡死
    });

    test('bypass 不存在的节点 id 与已删除节点安全跳过', () => {
        const wf = { '1': { class_type: 'KSampler', inputs: {} } };
        const out = applyBypass(wf, ['404'], CLASS_INFO);
        expect(out['1']).toBeDefined();
    });
});
