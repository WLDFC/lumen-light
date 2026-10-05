/**
 * ==========================================================================
 * routes/comfyTools.js 集成测试
 * 覆盖：system-stats / job(status+cancel 不误中断) / run-workflow（UI 格式
 * 自动转换+槽位覆盖后提交）/ list-workflow-slots / nodes / search-models /
 * get-logs / download-model 未配置根目录报错。通过 mock 全局 fetch 避免
 * 真实请求 ComfyUI。
 * ==========================================================================
 */

const express = require('express');
const request = require('supertest');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const createComfyToolsRouter = require('../../routes/comfyTools');
const { convertUiToApi } = require('../../utils/comfyWorkflowFormat');

// 与 comfyWorkflowFormat.test.js 同构的最小 object_info 与 UI 工作流
const OBJECT_INFO = {
    CheckpointLoaderSimple: {
        input: { required: { ckpt_name: [['a.safetensors', 'model.safetensors'], {}] } },
        output: ['MODEL', 'CLIP', 'VAE']
    },
    CLIPTextEncode: {
        input: { required: { text: ['STRING', { default: '' }], clip: ['CLIP', { link: 1 }] } },
        output: ['CONDITIONING']
    },
    KSampler: {
        input: {
            required: {
                seed: ['INT', { default: 0 }],
                steps: ['INT', { default: 20 }],
                cfg: ['FLOAT', { default: 8.0 }],
                sampler_name: [['euler'], {}],
                scheduler: [['normal'], {}],
                denoise: ['FLOAT', { default: 1.0 }],
                model: ['MODEL', { link: 1 }],
                positive: ['CONDITIONING', { link: 1 }],
                negative: ['CONDITIONING', { link: 1 }],
                latent_image: ['LATENT', { link: 1 }]
            }
        },
        output: ['LATENT']
    }
};

const UI_WORKFLOW = {
    nodes: [
        { id: 4, type: 'CheckpointLoaderSimple', title: 'Load Checkpoint', widgets_values: ['model.safetensors'], inputs: [] },
        { id: 6, type: 'CLIPTextEncode', title: 'Positive', widgets_values: ['a cat'], inputs: [{ name: 'clip', type: 'CLIP', link: 1 }] },
        {
            id: 3, type: 'KSampler', title: 'KSampler',
            widgets_values: [123, 'randomize', 20, 7, 'euler', 'normal', 1],
            inputs: [
                { name: 'model', type: 'MODEL', link: 3 },
                { name: 'positive', type: 'CONDITIONING', link: 4 }
            ]
        }
    ],
    links: [[1, 4, 1, 6, 0, 'CLIP'], [3, 4, 0, 3, 0, 'MODEL'], [4, 6, 0, 3, 1, 'CONDITIONING']]
};

let workflowsDir;
let comfyRootDir;

beforeAll(async () => {
    workflowsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-comfy-tools-'));
    comfyRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-comfy-root-'));
    await fs.writeFile(path.join(workflowsDir, 'ui-wf.json'), JSON.stringify(UI_WORKFLOW));
});

afterAll(async () => {
    await fs.rm(workflowsDir, { recursive: true, force: true });
    await fs.rm(comfyRootDir, { recursive: true, force: true });
});

beforeEach(() => {
    jest.clearAllMocks();
});

function createApp({ comfyRoot = '' } = {}) {
    const app = express();
    app.use(express.json());
    app.use('/api/comfy-tools', createComfyToolsRouter({
        comfyApiUrl: 'http://127.0.0.1:8188',
        getComfyRoot: () => comfyRoot
    }));
    return app;
}

describe('GET /api/comfy-tools/system-stats', () => {
    test('透传 ComfyUI 系统状态', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({ system: { comfyui_version: '0.3.x' }, devices: [{ vram_total: 1 }] })
        }));
        const res = await request(createApp()).get('/api/comfy-tools/system-stats');
        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.data.system.comfyui_version).toBe('0.3.x');
    });

    test('ComfyUI 离线时返回可读错误', async () => {
        global.fetch = jest.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }));
        const res = await request(createApp()).get('/api/comfy-tools/system-stats');
        expect(res.statusCode).toBe(500);
        expect(res.body.message).toContain('未在线');
    });
});

describe('POST /api/comfy-tools/job', () => {
    test('status：摘要 running/pending', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                queue_running: [[7, 'run-1'], [8, 'run-2']],
                queue_pending: [[9, 'pend-1']]
            })
        }));
        const res = await request(createApp()).post('/api/comfy-tools/job').send({ action: 'status' });
        expect(res.body.data.running).toEqual([
            { number: 7, promptId: 'run-1' }, { number: 8, promptId: 'run-2' }
        ]);
        expect(res.body.data.pending).toEqual([{ number: 9, promptId: 'pend-1' }]);
    });

    test('cancel：目标任务正在执行才中断，否则不误杀', async () => {
        global.fetch = jest.fn(async (url) => {
            if (String(url).endsWith('/queue')) {
                return { ok: true, json: async () => ({ queue_running: [[7, 'other-run']], queue_pending: [] }) };
            }
            return { ok: true, json: async () => ({}) };
        });
        const res = await request(createApp())
            .post('/api/comfy-tools/job')
            .send({ action: 'cancel', prompt_id: 'my-run' });
        expect(res.body.data).toMatchObject({ interrupted: false, deleted: 0 });
        // 不应发起 /interrupt
        expect(global.fetch.mock.calls.some((c) => String(c[0]).endsWith('/interrupt'))).toBe(false);
    });
});

describe('POST /api/comfy-tools/run-workflow', () => {
    test('UI 格式自动转换 + 槽位覆盖后提交', async () => {
        let submitted = null;
        global.fetch = jest.fn(async (url, options) => {
            const u = String(url);
            if (u.endsWith('/object_info')) return { ok: true, json: async () => OBJECT_INFO };
            if (u.endsWith('/prompt')) {
                submitted = JSON.parse(options.body).prompt;
                return { ok: true, json: async () => ({ prompt_id: 'pf-1' }) };
            }
            return { ok: true, json: async () => ({}) };
        });

        const res = await request(createApp())
            .post('/api/comfy-tools/run-workflow')
            .send({
                path: path.join(workflowsDir, 'ui-wf.json'),
                overrides: { 'positive.text': 'a dog', '3.seed': 777 }
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.data.promptId).toBe('pf-1');
        expect(submitted).not.toBeNull();
        // UI 格式已转换为 API 格式（nodes 数组 → id 键对象）
        expect(submitted['6'].inputs.text).toBe('a dog');
        expect(submitted['3'].inputs.seed).toBe(777);
        expect(submitted['3'].inputs.model).toEqual(['4', 0]);
        expect(submitted['3'].inputs.positive).toEqual(['6', 0]);
    });

    test('文件不存在返回 500 可读错误', async () => {
        global.fetch = jest.fn();
        const res = await request(createApp())
            .post('/api/comfy-tools/run-workflow')
            .send({ path: 'D:/no/such/file.json' });
        expect(res.statusCode).toBe(500);
        expect(res.body.status).toBe('error');
    });
});

describe('POST /api/comfy-tools/list-workflow-slots', () => {
    test('返回格式与槽位清单', async () => {
        global.fetch = jest.fn(async (url) => {
            if (String(url).endsWith('/object_info')) return { ok: true, json: async () => OBJECT_INFO };
            return { ok: true, json: async () => ({}) };
        });
        const res = await request(createApp())
            .post('/api/comfy-tools/list-workflow-slots')
            .send({ path: path.join(workflowsDir, 'ui-wf.json') });
        expect(res.body.data.format).toBe('ui');
        const addrs = res.body.data.slots.map((s) => s.address);
        expect(addrs).toContain('6.text');
        expect(addrs).toContain('3.seed');
        expect(addrs).not.toContain('3.model');   // 连线输入不算槽位
    });
});

describe('POST /api/comfy-tools/nodes 与 search-models', () => {
    test('nodes search 子串过滤', async () => {
        global.fetch = jest.fn(async () => ({ ok: true, json: async () => OBJECT_INFO }));
        const res = await request(createApp()).post('/api/comfy-tools/nodes').send({ action: 'search', query: 'ksampler' });
        expect(res.body.data.classes.map((c) => c.class_type)).toEqual(['KSampler']);
    });

    test('search-models 按类别聚合组合框文件清单', async () => {
        global.fetch = jest.fn(async () => ({ ok: true, json: async () => OBJECT_INFO }));
        const res = await request(createApp()).post('/api/comfy-tools/search-models').send({});
        expect(res.body.data.categories.checkpoints).toEqual(['a.safetensors', 'model.safetensors']);
    });
});

describe('POST /api/comfy-tools/download-model', () => {
    test('未配置 ComfyUI 根目录时给可读错误', async () => {
        global.fetch = jest.fn();
        const res = await request(createApp())
            .post('/api/comfy-tools/download-model')
            .send({ url: 'https://example.com/m.safetensors' });
        expect(res.statusCode).toBe(500);
        expect(res.body.message).toContain('ComfyUI 根目录');
    });
});

describe('GET /api/comfy-tools/get-logs', () => {
    test('透传 tail 截取后的日志行', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({ entries: [{ m: 'line-1' }, { m: 'line-2' }] })
        }));
        const res = await request(createApp()).get('/api/comfy-tools/get-logs?tail=1');
        expect(res.body.data.entries).toEqual(['line-2']);
    });
});
