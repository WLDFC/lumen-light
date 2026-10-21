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

// 免节点 history 轮询的测试钩子：轮询间隔与总超时同压到 20ms，
// 后台回流任务在任何用例里都秒级收敛（含既有用例触发的兜底路径）
process.env.LUMEN_TEST_HISTORY_MS = '20';

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

// 无 lumen 节点的社区工作流：LoadImage + SaveImage（免节点双通道的目标形态）
const COMMUNITY_WORKFLOW = {
    "3": {
        "class_type": "KSampler",
        "inputs": {
            "seed": 111, "steps": 4, "cfg": 1, "sampler_name": "euler",
            "scheduler": "simple", "denoise": 1,
            "model": ["75", 0], "positive": ["602", 0],
            "negative": ["604", 0], "latent_image": ["112", 0]
        }
    },
    "100": { "class_type": "LoadImage", "inputs": { "image": "example.png" } },
    "112": {
        "class_type": "EmptySD3LatentImage",
        "inputs": { "width": 768, "height": 768, "batch_size": 1 }
    },
    "5": { "class_type": "SaveImage", "inputs": { "filename_prefix": "ComfyUI", "images": ["3", 0] } },
    "602": { "class_type": "CLIPTextEncode", "inputs": { "text": "", "clip": ["159", 0] } },
    "604": { "class_type": "CLIPTextEncode", "inputs": { "text": "", "clip": ["159", 0] } }
};

// 双 LoadImage 的社区工作流（免节点不猜歧义场景）
const MULTI_LOAD_WORKFLOW = {
    "3": {
        "class_type": "KSampler",
        "inputs": {
            "seed": 111, "steps": 4, "cfg": 1, "sampler_name": "euler",
            "scheduler": "simple", "denoise": 1,
            "model": ["75", 0], "positive": ["602", 0],
            "negative": ["604", 0], "latent_image": ["112", 0]
        }
    },
    "100": { "class_type": "LoadImage", "inputs": { "image": "a.png" } },
    "101": { "class_type": "LoadImage", "inputs": { "image": "b.png" } },
    "112": {
        "class_type": "EmptySD3LatentImage",
        "inputs": { "width": 768, "height": 768, "batch_size": 1 }
    },
    "5": { "class_type": "SaveImage", "inputs": { "filename_prefix": "ComfyUI", "images": ["3", 0] } },
    "602": { "class_type": "CLIPTextEncode", "inputs": { "text": "", "clip": ["159", 0] } },
    "604": { "class_type": "CLIPTextEncode", "inputs": { "text": "", "clip": ["159", 0] } }
};

// 视频产物工作流（无回传节点，history 兜底明确不覆盖）
const VIDEO_WORKFLOW = {
    "1": { "class_type": "VHS_VideoCombine", "inputs": {} }
};

let workflowsDir;
const canvasImages = { 1: null, 2: null, 3: null };
const canvasImagesTimestamp = { 1: 0, 2: 0, 3: 0 };
const latestPrompts = { positive: '', negative: '', timestamp: 0 };

beforeAll(async () => {
    // 在系统临时目录建工作流目录，写入测试模板
    workflowsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-comfy-node-test-'));
    await fs.writeFile(
        path.join(workflowsDir, 'test-wf.json'),
        JSON.stringify(TEST_WORKFLOW)
    );
    await fs.writeFile(
        path.join(workflowsDir, 'plain-wf.json'),
        JSON.stringify(PLAIN_WORKFLOW)
    );
    await fs.writeFile(
        path.join(workflowsDir, 'community-wf.json'),
        JSON.stringify(COMMUNITY_WORKFLOW)
    );
    await fs.writeFile(
        path.join(workflowsDir, 'multi-load-wf.json'),
        JSON.stringify(MULTI_LOAD_WORKFLOW)
    );
    await fs.writeFile(
        path.join(workflowsDir, 'video-wf.json'),
        JSON.stringify(VIDEO_WORKFLOW)
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

function createApp(extra = {}) {
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api/comfy-node', createComfyNodeRouter({
        workflowsDir,
        canvasImages,
        canvasImagesTimestamp,
        latestPrompts,
        clients: extra.clients || new Map(),   // 免节点 history 回流推送目标
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

// ==================== 免节点双通道（utils/comfyNodelessFlow 集成） ====================

describe('POST /run 免节点双通道仲裁', () => {
    /** 轮询等待后台回流推送完成（最多 3s） */
    async function waitFor(pred, timeoutMs = 3000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (pred()) return true;
            await new Promise((r) => setTimeout(r, 25));
        }
        return false;
    }

    test('节点链路不受影响：有 Send 节点时 outputVia=send-node、不碰 LoadImage', async () => {
        let submittedPayload = null;
        global.fetch = jest.fn(async (url, options) => {
            submittedPayload = JSON.parse(options.body);
            return { ok: true, json: async () => ({ prompt_id: 'n1' }) };
        });

        const res = await request(createApp())
            .post('/api/comfy-node/run')
            .send({ workflowId: 'test-wf', positive: '一只猫', images: ['data:image/png;base64,QUJD'] });

        expect(res.statusCode).toBe(200);
        expect(res.body.outputVia).toBe('send-node');
        expect(res.body.imageInject).toBeNull();   // 有 Receive 节点走槽位，无注入动作
        expect(submittedPayload.prompt["100"]).toBeUndefined();   // 未新增/改写任何 LoadImage
    });

    test('免节点 auto：单 LoadImage 社区工作流，画布图上传后写入该节点，产物经 history 推画布', async () => {
        const wsSend = jest.fn();
        const clients = new Map([['c1', { role: 'canvas', ws: { readyState: 1, send: wsSend } }]]);
        let submittedPayload = null;
        global.fetch = jest.fn(async (url, options) => {
            if (url.includes('/upload/image')) {
                return { ok: true, json: async () => ({ name: 'lumen_canvas_test.png', subfolder: '', type: 'input' }) };
            }
            if (url.includes('/prompt')) {
                submittedPayload = JSON.parse(options.body);
                return { ok: true, json: async () => ({ prompt_id: 'hist-1' }) };
            }
            if (url.includes('/history/')) {
                return {
                    ok: true,
                    json: async () => ({
                        'hist-1': {
                            outputs: { '5': { images: [
                                { filename: 'ComfyUI_00001_.png', subfolder: '', type: 'output' },
                                { filename: 'preview.png', subfolder: '', type: 'temp' }
                            ] } },
                            status: { status_str: 'success', completed: true }
                        }
                    })
                };
            }
            if (url.includes('/view')) {
                return { ok: true, arrayBuffer: async () => new TextEncoder().encode('IMGBYTES').buffer };
            }
            return { ok: true, json: async () => ({}) };
        });

        const res = await request(createApp({ clients }))
            .post('/api/comfy-node/run')
            .send({
                workflowId: 'community-wf',
                positive: '一只猫',
                images: ['data:image/png;base64,QUJD']
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.outputVia).toBe('history');
        expect(res.body.imageInject).toMatchObject({ mode: 'auto' });
        // 提交 JSON：LoadImage 的 image 输入被改写为上传后的文件名
        expect(submittedPayload.prompt["100"].inputs.image).toBe('lumen_canvas_test.png');
        // 后台回流：new-image 推送到画布客户端，裸 base64（无 data: 前缀）+
        // target 透传 + 提示词元数据，与 LumenSendImageRealtime 链路同格式
        const pushed = await waitFor(() => wsSend.mock.calls.length > 0);
        expect(pushed).toBe(true);
        const msg = JSON.parse(wsSend.mock.calls[0][0]);
        expect(msg.type).toBe('new-image');
        expect(msg.image).toBe(Buffer.from('IMGBYTES').toString('base64'));
        expect(msg.target).toBeUndefined();   // 未传 target → 无路由兜底
        expect(msg.prompt.positive).toBe('一只猫');
        // 只推了 1 张：temp 型的 PreviewImage 产物被剔除
        expect(wsSend.mock.calls.length).toBe(1);
    });

    test('免节点 auto 带 target：回流消息原样透传画布节点 id', async () => {
        const wsSend = jest.fn();
        const clients = new Map([['c1', { role: 'canvas', ws: { readyState: 1, send: wsSend } }]]);
        global.fetch = jest.fn(async (url, options) => {
            if (url.includes('/upload/image')) {
                return { ok: true, json: async () => ({ name: 'up.png', subfolder: '', type: 'input' }) };
            }
            if (url.includes('/prompt')) {
                return { ok: true, json: async () => ({ prompt_id: 'hist-2' }) };
            }
            if (url.includes('/history/')) {
                return {
                    ok: true,
                    json: async () => ({ 'hist-2': { outputs: { '5': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } }, status: { status_str: 'success', completed: true } } })
                };
            }
            if (url.includes('/view')) {
                return { ok: true, arrayBuffer: async () => new TextEncoder().encode('X').buffer };
            }
            return { ok: true, json: async () => ({}) };
        });

        const res = await request(createApp({ clients }))
            .post('/api/comfy-node/run')
            .send({ workflowId: 'community-wf', positive: '一只猫', target: 'node-xyz', images: ['data:image/png;base64,QUJD'] });

        expect(res.body.imageInject).toMatchObject({ mode: 'auto', loadImageId: '100' });
        const pushed = await waitFor(() => wsSend.mock.calls.length > 0);
        expect(pushed).toBe(true);
        const msg = JSON.parse(wsSend.mock.calls[0][0]);
        expect(msg.target).toBe('node-xyz');
    });

    test('免节点 ambiguous：双 LoadImage 不猜，提交 JSON 不被改写', async () => {
        let submittedPayload = null;
        global.fetch = jest.fn(async (url, options) => {
            if (url.includes('/prompt')) {
                submittedPayload = JSON.parse(options.body);
                return { ok: true, json: async () => ({ prompt_id: 'n3' }) };
            }
            return { ok: true, json: async () => ({}) };
        });

        const res = await request(createApp())
            .post('/api/comfy-node/run')
            .send({ workflowId: 'multi-load-wf', positive: '一只猫', images: ['data:image/png;base64,QUJD'] });

        expect(res.statusCode).toBe(200);
        expect(res.body.imageInject).toMatchObject({ mode: 'ambiguous' });
        expect(submittedPayload.prompt["100"].inputs.image).toBe('a.png');   // 原样
        expect(submittedPayload.prompt["101"].inputs.image).toBe('b.png');
        // 未发起上传
        expect(global.fetch.mock.calls.some((c) => String(c[0]).includes('/upload/image'))).toBe(false);
    });

    test('免节点 none：无 LoadImage 时图不生效并如实上报', async () => {
        let submittedPayload = null;
        global.fetch = jest.fn(async (url, options) => {
            if (url.includes('/prompt')) {
                submittedPayload = JSON.parse(options.body);
                return { ok: true, json: async () => ({ prompt_id: 'n4' }) };
            }
            return { ok: true, json: async () => ({}) };
        });
        canvasImages[1] = 'KEEP';

        const res = await request(createApp())
            .post('/api/comfy-node/run')
            .send({ workflowId: 'plain-wf', positive: '一只猫', images: ['data:image/png;base64,QUJD'] });

        expect(res.body.imageInject).toMatchObject({ mode: 'none' });
        expect(canvasImages[1]).toBe('KEEP');   // 槽位链路不启用（无 Receive 节点）
        expect(submittedPayload.prompt["3"].inputs.steps).toBe(4);   // 工作流原样提交
    });

    test('视频工作流无 Send 节点：outputVia=none，不启动 history 轮询', async () => {
        global.fetch = jest.fn(async (url, options) => {
            if (url.includes('/prompt')) {
                return { ok: true, json: async () => ({ prompt_id: 'n5' }) };
            }
            return { ok: true, json: async () => ({}) };
        });

        const res = await request(createApp())
            .post('/api/comfy-node/run')
            .send({ workflowId: 'video-wf', positive: '一只猫' });

        expect(res.statusCode).toBe(200);
        expect(res.body.outputVia).toBe('none');
        // 等 100ms 确认没有 history 查询发生
        await new Promise((r) => setTimeout(r, 100));
        expect(global.fetch.mock.calls.some((c) => String(c[0]).includes('/history/'))).toBe(false);
    });
});

// ==================== 免节点 LoadImage 直注（显式 imageMapping） ====================

describe('POST /run 免节点显式映射注入', () => {
    // 等后台回流任务收敛（history mock 立即返回，数十毫秒内落日志），
    // 避免 poll 日志落到测试结束后触发 jest 的 log-after-done 警告
    const settle = () => new Promise((r) => setTimeout(r, 60));

    function mockComfyForMapped() {
        let submittedPayload = null;
        global.fetch = jest.fn(async (url, options) => {
            if (url.includes('/upload/image')) {
                // 文件名按上传内容长度命名——断言与上传调用顺序解耦
                // （JS 对象整数键按数值序迭代，mapping 键序≠插入序）
                const blob = options.body.get('image');
                const text = await blob.text();
                return { ok: true, json: async () => ({ name: `up-${text.length}.png`, subfolder: '', type: 'input' }) };
            }
            if (url.includes('/prompt')) {
                submittedPayload = JSON.parse(options.body);
                return { ok: true, json: async () => ({ prompt_id: 'mapped-1' }) };
            }
            if (url.includes('/history/')) {
                return {
                    ok: true,
                    json: async () => ({ 'mapped-1': { outputs: {}, status: { status_str: 'success', completed: true } } })
                };
            }
            return { ok: true, json: async () => ({}) };
        });
        return { getPayload: () => submittedPayload };
    }

    test('mapped：双 LoadImage 按映射逐条注入（映射键序无关），imageInject 上报 applied', async () => {
        const mock = mockComfyForMapped();

        const res = await request(createApp())
            .post('/api/comfy-node/run')
            .send({
                workflowId: 'multi-load-wf',
                positive: '一只猫',
                images: ['data:image/png;base64,QQ==', 'data:image/png;base64,QkJC'],
                // 故意乱序+与 id 序不同，证明映射语义优先于节点顺序
                imageMapping: { '101': 0, '100': 1 }
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.imageInject).toMatchObject({ mode: 'mapped', applied: 2 });
        expect(res.body.imageInject.skipped).toEqual([]);
        const payload = mock.getPayload();
        // 1 字节图('A') → #101，3 字节图('BBC') → #100（文件名=内容长度）
        expect(payload.prompt['101'].inputs.image).toBe('up-1.png');
        expect(payload.prompt['100'].inputs.image).toBe('up-3.png');
        await settle();
    });

    test('mapped：失效条目（节点不存在/下标越界）跳过并如实上报，有效条目照常注入', async () => {
        const mock = mockComfyForMapped();

        const res = await request(createApp())
            .post('/api/comfy-node/run')
            .send({
                workflowId: 'multi-load-wf',
                positive: '一只猫',
                images: ['data:image/png;base64,QUJD'],
                imageMapping: {
                    '999': 0,    // 不存在的节点（模拟被 bypass 剔除）
                    '100': 0,    // 有效
                    '101': 5     // 下标越界
                }
            });

        expect(res.body.imageInject).toMatchObject({ mode: 'mapped', applied: 1 });
        expect(res.body.imageInject.skipped).toHaveLength(2);
        expect(res.body.imageInject.detail).toContain('#999');
        expect(res.body.imageInject.detail).toContain('#101');
        const payload = mock.getPayload();
        expect(payload.prompt['100'].inputs.image).toBe('up-3.png');
        expect(payload.prompt['101'].inputs.image).toBe('b.png');   // 失效条目不碰
        await settle();
    });

    test('mapped 全部失效：mode=none、不发起上传', async () => {
        mockComfyForMapped();

        const res = await request(createApp())
            .post('/api/comfy-node/run')
            .send({
                workflowId: 'multi-load-wf',
                positive: '一只猫',
                images: ['data:image/png;base64,QUJD'],
                imageMapping: { '999': 0 }
            });

        expect(res.body.imageInject).toMatchObject({ mode: 'none' });
        expect(global.fetch.mock.calls.some((c) => String(c[0]).includes('/upload/image'))).toBe(false);
        await settle();
    });

    test('映射优先于自动仲裁：单 LoadImage 带 mapping 走 mapped 而非 auto', async () => {
        const mock = mockComfyForMapped();

        const res = await request(createApp())
            .post('/api/comfy-node/run')
            .send({
                workflowId: 'community-wf',
                positive: '一只猫',
                images: ['data:image/png;base64,QUJD'],
                imageMapping: { '100': 0 }
            });

        expect(res.body.imageInject).toMatchObject({ mode: 'mapped', applied: 1, loadImageId: '100' });
        expect(mock.getPayload().prompt['100'].inputs.image).toBe('up-3.png');
        await settle();
    });

    test('有画布取图节点的工作流忽略 mapping（槽位链路语义不受影响）', async () => {
        const mock = mockComfyForMapped();
        canvasImages[1] = 'KEEP';

        const res = await request(createApp())
            .post('/api/comfy-node/run')
            .send({
                workflowId: 'test-wf',
                positive: '一只猫',
                images: ['QUJD'],
                imageMapping: { '162': 0 }
            });

        // 走槽位链路：图片写槽位，无注入动作，mapping 不生效
        expect(res.body.imageInject).toBeNull();
        expect(canvasImages[1]).toBe('QUJD');
        const payload = mock.getPayload();
        expect(payload.prompt['162'].inputs.slot).toBe('1');
        expect(payload.prompt['100']).toBeUndefined();
        await settle();
    });
});

// ==================== 空槽兜底（映射外 LoadImage 模板图失效 → 占位图顶替） ====================

describe('POST /run 空槽兜底占位顶替', () => {
    const settle = () => new Promise((r) => setTimeout(r, 60));

    function mockFetchForPlaceholder({ inputList, objectInfoOk = true }) {
        let submittedPayload = null;
        global.fetch = jest.fn(async (url, options) => {
            if (url.includes('/upload/image')) {
                // 文件名按上传内容长度命名（QUJD='ABC'=3 字节；64×64 灰 PNG 更长）
                const blob = options.body.get('image');
                const text = await blob.text();
                return { ok: true, json: async () => ({ name: `up-${text.length}.png`, subfolder: '', type: 'input' }) };
            }
            if (url.includes('/object_info/LoadImage')) {
                if (!objectInfoOk) return { ok: false };
                return {
                    ok: true,
                    json: async () => ({ LoadImage: { input: { required: { image: [inputList, {}] } } } })
                };
            }
            if (url.includes('/prompt')) {
                submittedPayload = JSON.parse(options.body);
                return { ok: true, json: async () => ({ prompt_id: 'ph-1' }) };
            }
            if (url.includes('/history/')) {
                return { ok: true, json: async () => ({ 'ph-1': { outputs: {}, status: { status_str: 'success', completed: true } } }) };
            }
            return { ok: true, json: async () => ({}) };
        });
        return { getPayload: () => submittedPayload };
    }

    test('映射外 LoadImage 模板图失效 → 占位图顶替并上报 placeholders', async () => {
        const mock = mockFetchForPlaceholder({ inputList: ['other.png'] });   // 不含 b.png（temp 引用已失效）

        const res = await request(createApp())
            .post('/api/comfy-node/run')
            .send({
                workflowId: 'multi-load-wf',
                positive: '一只猫',
                images: ['data:image/png;base64,QUJD'],
                imageMapping: { '100': 0 }   // #101 空槽
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.imageInject).toMatchObject({ mode: 'mapped', applied: 1, placeholders: ['101'] });
        expect(res.body.imageInject.detail).toContain('#101');
        const payload = mock.getPayload();
        expect(payload.prompt['100'].inputs.image).toBe('up-3.png');          // 映射注入不变
        expect(payload.prompt['101'].inputs.image).not.toBe('b.png');         // 失效引用被顶替
        expect(payload.prompt['101'].inputs.image).toMatch(/^up-\d+\.png$/);
        await settle();
    });

    test('空槽但模板引用有效：不碰节点（保留 ComfyUI 已选图语义）', async () => {
        const mock = mockFetchForPlaceholder({ inputList: ['b.png', 'other.png'] });

        const res = await request(createApp())
            .post('/api/comfy-node/run')
            .send({
                workflowId: 'multi-load-wf',
                positive: '一只猫',
                images: ['data:image/png;base64,QUJD'],
                imageMapping: { '100': 0 }
            });

        expect(res.body.imageInject).toMatchObject({ mode: 'mapped', applied: 1, placeholders: [] });
        expect(mock.getPayload().prompt['101'].inputs.image).toBe('b.png');   // 有效引用原样保留
        await settle();
    });

    test('object_info 不可用时跳过空槽兜底（不报错不顶替）', async () => {
        const mock = mockFetchForPlaceholder({ inputList: [], objectInfoOk: false });

        const res = await request(createApp())
            .post('/api/comfy-node/run')
            .send({
                workflowId: 'multi-load-wf',
                positive: '一只猫',
                images: ['data:image/png;base64,QUJD'],
                imageMapping: { '100': 0 }
            });

        expect(res.body.imageInject).toMatchObject({ mode: 'mapped', placeholders: [] });
        expect(mock.getPayload().prompt['101'].inputs.image).toBe('b.png');
        await settle();
    });
});
