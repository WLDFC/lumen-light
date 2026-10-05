/**
 * ==========================================================================
 * routes/comfyNode.js 集成测试
 * 覆盖模型清单代理（在线/离线）与 Comfy 生图节点运行提交（参数注入、
 * 槽位写入、提示词注入、路径穿越拦截）。
 * 通过 mock 全局 fetch 避免真实请求 ComfyUI。
 * ==========================================================================
 */

const express = require('express');
const request = require('supertest');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const createComfyNodeRouter = require('../../routes/comfyNode');

// 测试用工作流模板：含 KSampler / 空白 Latent / 画板取图节点 / 占位节点 /
// 文本编码节点，覆盖提交前预处理的全部分支
const TEST_WORKFLOW = {
    "3": {
        "class_type": "KSampler",
        "inputs": {
            "seed": 111, "steps": 4, "cfg": 1, "sampler_name": "euler",
            "scheduler": "simple", "denoise": 1,
            "model": ["75", 0], "positive": ["602", 0],
            "negative": ["604", 0], "latent_image": ["112", 0]
        }
    },
    "9": { "class_type": "LumenLoadWorkflow", "inputs": {} },
    "112": {
        "class_type": "EmptySD3LatentImage",
        "inputs": { "width": 768, "height": 768, "batch_size": 1 }
    },
    "162": {
        "class_type": "LumenReceiveImageFromCanvas",
        "inputs": { "slot": "1", "wait_for_image": true, "force_reload": true, "seed": 0 }
    },
    "157": { "class_type": "LumenSendImageRealtime", "inputs": { "auto_send": true, "images": ["8", 0] } },
    "602": { "class_type": "CLIPTextEncode", "inputs": { "text": "", "clip": ["159", 0] } },
    "604": { "class_type": "CLIPTextEncode", "inputs": { "text": "", "clip": ["159", 0] } }
};

// 不含画板取图节点的工作流（纯文生图，不应触碰槽位）
const PLAIN_WORKFLOW = {
    "3": {
        "class_type": "KSampler",
        "inputs": {
            "seed": 111, "steps": 4, "cfg": 1, "sampler_name": "euler",
            "scheduler": "simple", "denoise": 1,
            "model": ["75", 0], "positive": ["602", 0],
            "negative": ["604", 0], "latent_image": ["112", 0]
        }
    },
    "112": {
        "class_type": "EmptySD3LatentImage",
        "inputs": { "width": 768, "height": 768, "batch_size": 1 }
    },
    "602": { "class_type": "CLIPTextEncode", "inputs": { "text": "", "clip": ["159", 0] } }
};

let workflowsDir;
const canvasImages = { 1: null, 2: null, 3: null };
const canvasImagesTimestamp = { 1: 0, 2: 0, 3: 0 };
const latestPrompts = { positive: '', negative: '', timestamp: 0 };

beforeAll(async () => {
    // 在系统临时目录建工作流目录，写入两个测试模板
    workflowsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-comfy-node-test-'));
    await fs.writeFile(
        path.join(workflowsDir, 'test-wf.json'),
        JSON.stringify(TEST_WORKFLOW)
    );
    await fs.writeFile(
        path.join(workflowsDir, 'plain-wf.json'),
        JSON.stringify(PLAIN_WORKFLOW)
    );
});

afterAll(async () => {
    await fs.rm(workflowsDir, { recursive: true, force: true });
});

beforeEach(() => {
    jest.clearAllMocks();
    canvasImages[1] = null;
    canvasImages[2] = null;
    canvasImages[3] = null;
    latestPrompts.positive = '';
    latestPrompts.negative = '';
});

function createApp() {
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api/comfy-node', createComfyNodeRouter({
        workflowsDir,
        canvasImages,
        canvasImagesTimestamp,
        latestPrompts,
        comfyApiUrl: 'http://127.0.0.1:8188'
    }));
    return app;
}

describe('GET /api/comfy-node/models', () => {
    test('按类别归并 object_info 的模型清单并去重', async () => {
        global.fetch = jest.fn(async (url) => {
            if (url.includes('object_info/UNETLoader')) {
                return {
                    ok: true,
                    json: async () => ({
                        UNETLoader: {
                            input: { required: { unet_name: [['flux\\b.safetensors', 'flux\\a.safetensors'], {}] } }
                        }
                    })
                };
            }
            if (url.includes('object_info/LoraLoaderModelOnly')) {
                return {
                    ok: true,
                    json: async () => ({
                        LoraLoaderModelOnly: {
                            input: { required: { lora_name: [['qwen\\lightning.safetensors', 'qwen\\lightning.safetensors'], {}] } }
                        }
                    })
                };
            }
            // 未安装的类（如 GGUF 节点）返回 404，应被静默跳过
            return { ok: false };
        });

        const res = await request(createApp()).get('/api/comfy-node/models');

        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.connected).toBe(true);
        expect(res.body.unets).toEqual(['flux\\a.safetensors', 'flux\\b.safetensors']);
        expect(res.body.loras).toEqual(['qwen\\lightning.safetensors']);
        expect(res.body.checkpoints).toEqual([]);
    });

    test('ComfyUI 不可达时返回 connected:false 而非报错', async () => {
        global.fetch = jest.fn(async () => {
            throw new Error('connect ECONNREFUSED');
        });

        const res = await request(createApp()).get('/api/comfy-node/models');

        expect(res.statusCode).toBe(200);
        expect(res.body.connected).toBe(false);
        expect(res.body.checkpoints).toEqual([]);
        expect(res.body.unets).toEqual([]);
        expect(res.body.loras).toEqual([]);
    });
});

describe('POST /api/comfy-node/run', () => {
    test('缺少 workflowId 返回 400', async () => {
        const res = await request(createApp())
            .post('/api/comfy-node/run')
            .send({ positive: '一只猫' });

        expect(res.statusCode).toBe(400);
        expect(res.body.status).toBe('error');
    });

    test('缺少提示词返回 400', async () => {
        const res = await request(createApp())
            .post('/api/comfy-node/run')
            .send({ workflowId: 'test-wf', positive: '  ' });

        expect(res.statusCode).toBe(400);
        expect(res.body.status).toBe('error');
    });

    test('工作流 id 路径穿越被拦截', async () => {
        global.fetch = jest.fn();
        const res = await request(createApp())
            .post('/api/comfy-node/run')
            .send({ workflowId: '../package', positive: '一只猫' });

        expect(res.statusCode).toBe(500);
        expect(res.body.message).toContain('非法');
        expect(global.fetch).not.toHaveBeenCalled();   // 未发起任何 ComfyUI 请求
    });

    test('完整提交：注入参数/提示词/种子，清理占位节点，写槽位，回传 promptId', async () => {
        let submittedPayload = null;
        global.fetch = jest.fn(async (url, options) => {
            submittedPayload = JSON.parse(options.body);
            return { ok: true, json: async () => ({ prompt_id: 'abc-123' }) };
        });

        const res = await request(createApp())
            .post('/api/comfy-node/run')
            .send({
                workflowId: 'test-wf',
                positive: '一个女孩',
                negative: 'lowres',
                overrides: {
                    "3": { "steps": 20, "denoise": 0.55 },
                    "112": { "width": 832, "height": 1216, "batch_size": 2 }
                },
                target: 'node-abc',
                images: ['data:image/png;base64,QUJD']
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.promptId).toBe('abc-123');
        expect(global.fetch).toHaveBeenCalledTimes(1);

        const wf = submittedPayload.prompt;
        // 占位节点被移除
        expect(wf["9"]).toBeUndefined();
        // 参数覆盖生效
        expect(wf["3"].inputs.steps).toBe(20);
        expect(wf["3"].inputs.denoise).toBe(0.55);
        expect(wf["112"].inputs.width).toBe(832);
        expect(wf["112"].inputs.height).toBe(1216);
        expect(wf["112"].inputs.batch_size).toBe(2);
        // 采样种子被随机化（不再是模板里的 111）
        expect(wf["3"].inputs.seed).not.toBe(111);
        // 画板取图节点种子被强制刷新
        expect(wf["162"].inputs.seed).not.toBe(0);
        // 占位图路由 id 注入到回传节点（前端据此精确落图）
        expect(wf["157"].inputs.lumen_target).toBe('node-abc');
        // 正面/负面提示词按连接关系注入对应文本编码节点
        expect(wf["602"].inputs.text).toBe('一个女孩');
        expect(wf["604"].inputs.text).toBe('lowres');
        // 提示词元数据同步更新（生成结果回传画布时携带）
        expect(latestPrompts.positive).toBe('一个女孩');
        expect(latestPrompts.negative).toBe('lowres');
        // data URL 前缀被剥离后写入槽位 1，其余槽位清空
        expect(canvasImages[1]).toBe('QUJD');
        expect(canvasImages[2]).toBeNull();
        expect(canvasImages[3]).toBeNull();
    });

    test('纯文生图工作流不触碰槽位', async () => {
        global.fetch = jest.fn(async () => {
            return { ok: true, json: async () => ({ prompt_id: 'plain-1' }) };
        });
        canvasImages[1] = 'KEEP';

        const res = await request(createApp())
            .post('/api/comfy-node/run')
            .send({
                workflowId: 'plain-wf',
                positive: '一只猫',
                images: ['data:image/png;base64,QUJD']
            });

        expect(res.statusCode).toBe(200);
        expect(canvasImages[1]).toBe('KEEP');
    });

    test('ComfyUI 提交失败时透传错误信息', async () => {
        global.fetch = jest.fn(async () => {
            return {
                ok: false,
                json: async () => ({ error: { type: 'invalid_prompt', message: 'Checkpoint not found' } })
            };
        });

        const res = await request(createApp())
            .post('/api/comfy-node/run')
            .send({ workflowId: 'test-wf', positive: '一只猫' });

        expect(res.statusCode).toBe(500);
        expect(res.body.status).toBe('error');
        expect(res.body.message).toContain('Checkpoint not found');
    });
});

describe('POST /api/comfy-node/stop', () => {
    test('本轮任务正在执行：中断 + 按 id 删队列', async () => {
        const calls = [];
        global.fetch = jest.fn(async (url, options) => {
            calls.push({ url, body: options && options.body });
            if (url.endsWith('/queue') && (!options || !options.body)) {
                // GET /queue：queue_running 条目 [执行序号, prompt_id, ...]
                return { ok: true, json: async () => ({ queue_running: [[7, 'p-run'], [8, 'other']], queue_pending: [] }) };
            }
            return { ok: true, json: async () => ({}) };
        });

        const res = await request(createApp())
            .post('/api/comfy-node/stop')
            .send({ promptIds: ['p-run', 'p-queued'] });

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ status: 'ok', interrupted: true, deleted: 2 });
        // 第二次调用应为 POST /queue 删队列（携带 delete 清单）
        const deleteCall = calls.find((c) => c.body && c.body.includes('delete'));
        expect(deleteCall).toBeTruthy();
        const parsed = JSON.parse(deleteCall.body);
        expect(parsed.delete).toEqual(['p-run', 'p-queued']);
    });

    test('正在执行的不是本轮任务：不触发中断，只删队列', async () => {
        global.fetch = jest.fn(async (url, options) => {
            if (url.endsWith('/queue') && (!options || !options.body)) {
                return { ok: true, json: async () => ({ queue_running: [[7, 'another-run']], queue_pending: [] }) };
            }
            return { ok: true, json: async () => ({}) };
        });

        const res = await request(createApp())
            .post('/api/comfy-node/stop')
            .send({ promptIds: ['p-queued'] });

        expect(res.statusCode).toBe(200);
        expect(res.body.interrupted).toBe(false);
        expect(res.body.deleted).toBe(1);
        // 全部调用里不应出现 /interrupt
        expect(global.fetch.mock.calls.some((c) => String(c[0]).includes('/interrupt'))).toBe(false);
    });

    test('promptIds 为空或缺失：直接返回 ok，不触碰 ComfyUI', async () => {
        global.fetch = jest.fn();

        const res = await request(createApp())
            .post('/api/comfy-node/stop')
            .send({});

        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
