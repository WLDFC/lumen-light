/**
 * ==========================================================================
 * utils/comfyWorkflowFormat.js 单元测试
 * 覆盖：格式识别、UI→API 转换（控件对位消费/seed 控制词跳过/Reroute 穿透/
 * 子图与缺失类报错）、槽位扫描（UI+API 格式、唯一标题别名）、槽位写入
 * （位置定位/对象形态 widgets_values/API 直写/不可写报错）。
 * ==========================================================================
 */

const {
    isUiFormat,
    convertUiToApi,
    collectClassTypes,
    listWorkflowSlots,
    setWorkflowSlots
} = require('../../utils/comfyWorkflowFormat');

// 测试用 object_info：覆盖 INT/FLOAT/STRING/组合框/连线五类输入
const OBJECT_INFO = {
    CheckpointLoaderSimple: {
        input: { required: { ckpt_name: [['a.safetensors', 'model.safetensors'], {}] } },
        output: ['MODEL', 'CLIP', 'VAE'], output_name: ['MODEL', 'CLIP', 'VAE']
    },
    CLIPTextEncode: {
        input: { required: { text: ['STRING', { default: '' }], clip: ['CLIP', { link: 1 }] } },
        output: ['CONDITIONING'], output_name: ['CONDITIONING']
    },
    EmptyLatentImage: {
        input: { required: { width: ['INT', { default: 512 }], height: ['INT', { default: 512 }], batch_size: ['INT', { default: 1 }] } },
        output: ['LATENT'], output_name: ['LATENT']
    },
    KSampler: {
        input: {
            required: {
                seed: ['INT', { default: 0 }],
                steps: ['INT', { default: 20 }],
                cfg: ['FLOAT', { default: 8.0 }],
                sampler_name: [['euler', 'euler_ancestral'], {}],
                scheduler: [['normal', 'karras'], {}],
                denoise: ['FLOAT', { default: 1.0 }],
                model: ['MODEL', { link: 1 }],
                positive: ['CONDITIONING', { link: 1 }],
                negative: ['CONDITIONING', { link: 1 }],
                latent_image: ['LATENT', { link: 1 }]
            }
        },
        output: ['LATENT'], output_name: ['LATENT']
    },
    VAEDecode: {
        input: { required: { samples: ['LATENT', { link: 1 }], vae: ['VAE', { link: 1 }] } },
        output: ['IMAGE'], output_name: ['IMAGE']
    },
    SaveImage: {
        input: { required: { filename_prefix: ['STRING', { default: 'ComfyUI' }], images: ['IMAGE', { link: 1 }] } },
        output: [], output_name: [], output_node: true
    }
};

// 标准 UI 格式工作流（含 seed 后的 control_after_generate 控制词条目）
const UI_WORKFLOW = {
    nodes: [
        { id: 4, type: 'CheckpointLoaderSimple', title: 'Load Checkpoint', widgets_values: ['model.safetensors'], inputs: [] },
        { id: 6, type: 'CLIPTextEncode', title: 'Positive', widgets_values: ['a cat'], inputs: [{ name: 'clip', type: 'CLIP', link: 1 }] },
        { id: 7, type: 'CLIPTextEncode', title: 'Negative', widgets_values: ['bad'], inputs: [{ name: 'clip', type: 'CLIP', link: 2 }] },
        { id: 5, type: 'EmptyLatentImage', title: 'Empty Latent', widgets_values: [832, 1216, 1], inputs: [] },
        {
            id: 3, type: 'KSampler', title: 'KSampler',
            widgets_values: [123, 'randomize', 20, 7, 'euler', 'normal', 1],
            inputs: [
                { name: 'model', type: 'MODEL', link: 3 },
                { name: 'positive', type: 'CONDITIONING', link: 4 },
                { name: 'negative', type: 'CONDITIONING', link: 5 },
                { name: 'latent_image', type: 'LATENT', link: 6 }
            ]
        },
        {
            id: 8, type: 'VAEDecode', title: 'VAE Decode', widgets_values: [],
            inputs: [{ name: 'samples', type: 'LATENT', link: 7 }, { name: 'vae', type: 'VAE', link: 8 }]
        },
        { id: 9, type: 'SaveImage', title: 'Save', widgets_values: ['out'], inputs: [{ name: 'images', type: 'IMAGE', link: 9 }] }
    ],
    links: [
        [1, 4, 1, 6, 0, 'CLIP'], [2, 4, 1, 7, 0, 'CLIP'], [3, 4, 0, 3, 0, 'MODEL'],
        [4, 6, 0, 3, 1, 'CONDITIONING'], [5, 7, 0, 3, 2, 'CONDITIONING'], [6, 5, 0, 3, 3, 'LATENT'],
        [7, 3, 0, 8, 0, 'LATENT'], [8, 4, 2, 8, 1, 'VAE'], [9, 8, 0, 9, 0, 'IMAGE']
    ]
};

describe('isUiFormat', () => {
    test('UI 格式与 API 格式识别', () => {
        expect(isUiFormat(UI_WORKFLOW)).toBe(true);
        expect(isUiFormat({ '3': { class_type: 'KSampler', inputs: {} } })).toBe(false);
        expect(isUiFormat(null)).toBe(false);
    });
});

describe('convertUiToApi', () => {
    test('控件对位消费 + seed 控制词跳过 + 连线解析', () => {
        const api = convertUiToApi(UI_WORKFLOW, OBJECT_INFO);
        expect(api['4'].class_type).toBe('CheckpointLoaderSimple');
        expect(api['4'].inputs.ckpt_name).toBe('model.safetensors');
        expect(api['6'].inputs).toEqual({ text: 'a cat', clip: ['4', 1] });
        // seed=123，"randomize" 是 seed 的控制词（非 steps 的值），后续依次对位
        expect(api['3'].inputs).toEqual({
            seed: 123, steps: 20, cfg: 7,
            sampler_name: 'euler', scheduler: 'normal', denoise: 1,
            model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0]
        });
        expect(api['3']._meta.title).toBe('KSampler');
    });

    test('Reroute 链穿透到真实来源', () => {
        const wf = JSON.parse(JSON.stringify(UI_WORKFLOW));
        // 插入 reroute：KSampler 的 model 改从 reroute 取
        wf.nodes.push({ id: 10, type: 'Reroute', title: 'Reroute', widgets_values: [], inputs: [{ name: 'value', type: 'MODEL', link: 11 }] });
        wf.links = wf.links.filter((l) => l[0] !== 3);
        wf.links.push([11, 4, 0, 10, 0, 'MODEL'], [3, 10, 0, 3, 0, 'MODEL']);
        const api = convertUiToApi(wf, OBJECT_INFO);
        expect(api['3'].inputs.model).toEqual(['4', 0]);
        expect(api['10']).toBeUndefined();   // reroute 本身不出现在 API 格式
    });

    test('缺失节点类与子图报错', () => {
        const wf = JSON.parse(JSON.stringify(UI_WORKFLOW));
        wf.nodes[0].type = 'SomeUnknownLoader';
        expect(() => convertUiToApi(wf, OBJECT_INFO)).toThrow(/SomeUnknownLoader/);

        const sg = { nodes: [{ id: 1, type: 'KSampler' }], definitions: { subgraphs: [{ id: 'x' }] } };
        expect(() => convertUiToApi(sg, OBJECT_INFO)).toThrow(/子图/);
    });
});

describe('listWorkflowSlots', () => {
    test('UI 格式：地址 + 唯一标题别名 + 当前值', () => {
        const slots = listWorkflowSlots(UI_WORKFLOW, OBJECT_INFO);
        const byAddr = new Map(slots.map((s) => [s.address, s]));
        expect(byAddr.get('3.seed').current_value).toBe(123);
        expect(byAddr.get('3.seed').type).toBe('INT');
        expect(byAddr.get('6.text').current_value).toBe('a cat');
        expect(byAddr.get('6.text').name).toBe('positive.text');   // 唯一标题 slug
        // 两个 CLIPTextEncode 标题不重复，各自别名可用；连线输入不是槽位
        expect(byAddr.has('3.model')).toBe(false);
        expect(slots.length).toBe(13);   // 1 ckpt + 2 text + 3 latent + 6 ksampler + 1 prefix
    });

    test('API 格式：原始值输入即槽位', () => {
        const api = {
            '3': { class_type: 'KSampler', inputs: { seed: 1, cfg: 7.5, model: ['4', 0] } }
        };
        const slots = listWorkflowSlots(api);
        expect(slots.map((s) => s.address).sort()).toEqual(['3.cfg', '3.seed']);
        expect(slots.find((s) => s.address === '3.seed').type).toBe('INT');
    });
});

describe('setWorkflowSlots', () => {
    test('UI 格式：按地址写入 widgets_values 正确位置', () => {
        const updated = setWorkflowSlots(UI_WORKFLOW, { '3.seed': 999, '6.text': 'a dog' }, OBJECT_INFO);
        const ks = updated.nodes.find((n) => n.id === 3);
        expect(ks.widgets_values[0]).toBe(999);
        expect(ks.widgets_values[1]).toBe('randomize');   // 控制词条目保持在原位
        const pos = updated.nodes.find((n) => n.id === 6);
        expect(pos.widgets_values[0]).toBe('a dog');
        // 原工作流不被改动
        expect(UI_WORKFLOW.nodes.find((n) => n.id === 3).widgets_values[0]).toBe(123);
    });

    test('UI 格式：唯一标题别名可寻址', () => {
        const updated = setWorkflowSlots(UI_WORKFLOW, { 'positive.text': 'hello' }, OBJECT_INFO);
        expect(updated.nodes.find((n) => n.id === 6).widgets_values[0]).toBe('hello');
    });

    test('UI 格式：{name,value} 对象形态 widgets_values', () => {
        const wf = JSON.parse(JSON.stringify(UI_WORKFLOW));
        wf.nodes.find((n) => n.id === 3).widgets_values = [
            { name: 'seed', value: 1 }, { name: 'steps', value: 20 }
        ];
        const updated = setWorkflowSlots(wf, { '3.steps': 30 }, OBJECT_INFO);
        const raw = updated.nodes.find((n) => n.id === 3).widgets_values;
        expect(raw.find((v) => v.name === 'steps').value).toBe(30);
        expect(raw.find((v) => v.name === 'seed').value).toBe(1);
    });

    test('API 格式：直接写 node.inputs', () => {
        const api = { '3': { class_type: 'KSampler', inputs: { seed: 1 }, _meta: { title: 'K' } } };
        const updated = setWorkflowSlots(api, { '3.seed': 42 });
        expect(updated['3'].inputs.seed).toBe(42);
        expect(api['3'].inputs.seed).toBe(1);   // 不改原对象
    });

    test('连线输入/不存在的地址报错', () => {
        expect(() => setWorkflowSlots(UI_WORKFLOW, { '3.model': ['4', 0] }, OBJECT_INFO))
            .toThrow(/不是可调控件输入/);
        expect(() => setWorkflowSlots(UI_WORKFLOW, { '99.seed': 1 }, OBJECT_INFO))
            .toThrow(/找不到对应节点/);
        // 标题别名不唯一时报错
        const wf = JSON.parse(JSON.stringify(UI_WORKFLOW));
        wf.nodes.find((n) => n.id === 7).title = 'Positive';
        expect(() => setWorkflowSlots(wf, { 'positive.text': 'x' }, OBJECT_INFO))
            .toThrow(/不唯一/);
    });
});

describe('collectClassTypes', () => {
    test('两种格式都能收集节点类型', () => {
        expect(collectClassTypes(UI_WORKFLOW)).toContain('KSampler');
        expect(collectClassTypes(UI_WORKFLOW)).not.toContain('Note');
        expect(collectClassTypes({ '3': { class_type: 'KSampler' } })).toEqual(['KSampler']);
    });
});
