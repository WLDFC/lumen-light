/**
 * ==========================================================================
 * comfyNodelessFlow 纯函数层测试（Comfy 免节点双通道）
 * 覆盖：工作流特征扫描（Receive/Send/LoadImage/视频输出识别）、
 *       注入仲裁（恰好 1 个自动 / 0 个 none / 多个 ambiguous / 多图 partial）、
 *       data URL 拆包、history 产物收集（只取 output 型、剔视频与 temp）、
 *       轮询状态机（完成/失败/超时/瞬时失败重试）。
 * pollHistoryOutputs 用注入的 fetchImpl/sleepImpl 模拟时序，不依赖真实网络。
 * ==========================================================================
 */
const {
    scanCanvasFlow,
    decideImageInject,
    dataUrlToUploadPayload,
    collectOutputFiles,
    pollHistoryOutputs
} = require('../../utils/comfyNodelessFlow');

// ---- 测试工作流构造器 ----

function node(cls, inputs = {}) {
    return { class_type: cls, inputs };
}

/** 典型文生图 + SaveImage + Lumen 回传节点（节点链路现状） */
function fullNodeWorkflow() {
    return {
        '1': node('CheckpointLoaderSimple'),
        '2': node('KSampler'),
        '3': node('LumenReceiveImageFromCanvas'),
        '4': node('LumenSendImageRealtime'),
        '5': node('SaveImage')
    };
}

/** 无 lumen 节点的社区工作流：LoadImage + SaveImage（免节点目标形态） */
function communityWorkflow(loadImageCount = 1) {
    const graph = {
        '1': node('CheckpointLoaderSimple'),
        '2': node('KSampler'),
        '5': node('SaveImage')
    };
    for (let i = 0; i < loadImageCount; i++) {
        graph[`10${i}`] = node('LoadImage');
    }
    return graph;
}

describe('scanCanvasFlow', () => {
    test('节点链路工作流：Receive/Send 识别为真', () => {
        const scan = scanCanvasFlow(fullNodeWorkflow());
        expect(scan.hasReceiveNode).toBe(true);
        expect(scan.hasSendNode).toBe(true);
        expect(scan.loadImageIds).toEqual([]);
    });

    test('社区工作流：无 lumen 节点，LoadImage 清单按序收集', () => {
        const scan = scanCanvasFlow(communityWorkflow(2));
        expect(scan.hasReceiveNode).toBe(false);
        expect(scan.hasSendNode).toBe(false);
        expect(scan.loadImageIds).toEqual(['100', '101']);
    });

    test('视频输出类命中关键词即标记 hasVideoOutput', () => {
        const scan = scanCanvasFlow({
            '1': node('CheckpointLoaderSimple'),
            '2': node('VHS_VideoCombine'),
            '3': node('SaveImage')
        });
        expect(scan.hasVideoOutput).toBe(true);
    });

    test('兼容 type 字段兜底（class_type 缺失的历史格式）', () => {
        const scan = scanCanvasFlow({ '9': { type: 'LoadImage', inputs: {} } });
        expect(scan.loadImageIds).toEqual(['9']);
    });
});

describe('decideImageInject', () => {
    test('0 个 LoadImage → none，detail 说明图不会生效', () => {
        const r = decideImageInject({ loadImageIds: [] }, 1);
        expect(r.mode).toBe('none');
        expect(r.detail).toContain('不会生效');
    });

    test('恰好 1 个 → auto，指定该节点', () => {
        const r = decideImageInject({ loadImageIds: ['100'] }, 1);
        expect(r.mode).toBe('auto');
        expect(r.loadImageId).toBe('100');
    });

    test('1 个 LoadImage 但多张图 → partial（只注入第 1 张并如实说明）', () => {
        const r = decideImageInject({ loadImageIds: ['100'] }, 3);
        expect(r.mode).toBe('partial');
        expect(r.loadImageId).toBe('100');
        expect(r.detail).toContain('其余 2 张');
    });

    test('多个 LoadImage → ambiguous 不猜，列出节点 id', () => {
        const r = decideImageInject({ loadImageIds: ['100', '101'] }, 1);
        expect(r.mode).toBe('ambiguous');
        expect(r.loadImageId).toBeUndefined();
        expect(r.detail).toContain('100');
        expect(r.detail).toContain('101');
    });
});

describe('dataUrlToUploadPayload', () => {
    test('标准 data URL：拆出裸 base64 与扩展名', () => {
        const { buffer, ext } = dataUrlToUploadPayload('data:image/png;base64,QUJD');
        expect(buffer.toString()).toBe('ABC');
        expect(ext).toBe('.png');
    });

    test('jpeg 映射 .jpg；无前缀裸 base64 容错', () => {
        expect(dataUrlToUploadPayload('data:image/jpeg;base64,QUJD').ext).toBe('.jpg');
        expect(dataUrlToUploadPayload('QUJD').buffer.toString()).toBe('ABC');
    });
});

describe('collectOutputFiles', () => {
    test('只收 type=output 的图片条目，temp（PreviewImage）与视频文件剔除', () => {
        const files = collectOutputFiles({
            outputs: {
                '5': { images: [
                    { filename: 'ComfyUI_00001_.png', subfolder: '', type: 'output' },
                    { filename: 'ComfyUI_00002_.png', subfolder: 'sub', type: 'temp' },
                    { filename: 'clip.mp4', subfolder: '', type: 'output' }
                ] },
                '9': { images: [
                    { filename: 'out.webp', subfolder: '', type: 'output' },
                    { filename: null, type: 'output' }
                ] }
            }
        });
        expect(files).toEqual([
            { nodeId: '5', filename: 'ComfyUI_00001_.png', subfolder: '', type: 'output' },
            { nodeId: '9', filename: 'out.webp', subfolder: '', type: 'output' }
        ]);
    });

    test('outputs 缺失/空返回空数组；节点按数值序排列', () => {
        expect(collectOutputFiles(null)).toEqual([]);
        expect(collectOutputFiles({})).toEqual([]);
        const files = collectOutputFiles({ outputs: {
            '10': { images: [{ filename: 'b.png', subfolder: '', type: 'output' }] },
            '2': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] }
        } });
        expect(files.map((f) => f.nodeId)).toEqual(['2', '10']);
    });
});

describe('pollHistoryOutputs（注入 fetch/sleep 模拟时序）', () => {
    test('任务完成：条目出现即返回 done 带完整 entry', async () => {
        const entry = { outputs: { '5': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } }, status: { status_str: 'success', completed: true } };
        const r = await pollHistoryOutputs('http://x', 'p1', {
            fetchImpl: async () => ({ ok: true, json: async () => ({ p1: entry }) }),
            sleepImpl: async () => {}
        });
        expect(r.status).toBe('done');
        expect(r.entry.outputs['5'].images[0].filename).toBe('a.png');
    });

    test('执行中条目未出现：继续轮询直到出现', async () => {
        const script = [{}, {}, { p1: { outputs: {}, status: { status_str: 'success', completed: true } } }];
        let call = 0;
        const r = await pollHistoryOutputs('http://x', 'p1', {
            fetchImpl: async () => ({ ok: true, json: async () => script[Math.min(call++, script.length - 1)] }),
            sleepImpl: async () => {}
        });
        expect(r.status).toBe('done');
    });

    test('status_str=error → error 结果', async () => {
        const r = await pollHistoryOutputs('http://x', 'p1', {
            fetchImpl: async () => ({ ok: true, json: async () => ({ p1: { status: { status_str: 'error' } } }) }),
            sleepImpl: async () => {}
        });
        expect(r.status).toBe('error');
    });

    test('瞬时网络失败不算失败，下轮重试后成功', async () => {
        let call = 0;
        const r = await pollHistoryOutputs('http://x', 'p1', {
            fetchImpl: async () => {
                if (call++ === 0) throw new Error('ECONNRESET');
                return { ok: true, json: async () => ({ p1: { outputs: {}, status: { status_str: 'success', completed: true } } }) };
            },
            sleepImpl: async () => {}
        });
        expect(r.status).toBe('done');
    });

    test('超时：deadline 到了仍无条目 → timeout', async () => {
        const r = await pollHistoryOutputs('http://x', 'p1', {
            intervalMs: 1,
            timeoutMs: 30,   // 30ms 后到期
            fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
            sleepImpl: async (ms) => new Promise((res) => setTimeout(res, ms))
        });
        expect(r.status).toBe('timeout');
    });
});
