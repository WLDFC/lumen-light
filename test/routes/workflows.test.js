/**
 * ==========================================================================
 * routes/workflows.js 集成测试（编辑器新增的写接口）
 *   - PUT /:id 写回：包装格式保留 name/note 外层字段；纯 API 格式整体覆盖
 *   - PUT /:id 非法 id（路径穿越/类型错误）拦截
 *   - GET/PUT /:id/layout 布局 sidecar 读写（缺省空 positions、多工作流互不覆盖）
 * 通过 supertest 直连 Express 应用，使用临时目录避免污染 workflows/。
 * ==========================================================================
 */

const express = require('express');
const request = require('supertest');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const createWorkflowsRouter = require('../../routes/workflows');

const WF = {
    "3": { "class_type": "KSampler", "inputs": { "seed": 1, "steps": 20 } },
    "4": { "class_type": "SaveImage", "inputs": { "filename_prefix": "x", "images": ["3", 0] } }
};

const WF_NEXT = {
    "3": { "class_type": "KSampler", "inputs": { "seed": 42, "steps": 30 } },
    "4": { "class_type": "SaveImage", "inputs": { "filename_prefix": "y", "images": ["3", 0] } }
};

function makeApp(workflowsDir, layoutsFile) {
    const app = express();
    app.use(express.json({ limit: '20mb' }));
    app.use('/api/workflows', createWorkflowsRouter({ workflowsDir, layoutsFile }));
    return app;
}

describe('routes/workflows 编辑器写接口', () => {
    let tmpDir, workflowsDir, layoutsFile, app;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-workflows-test-'));
        workflowsDir = path.join(tmpDir, 'workflows');
        layoutsFile = path.join(tmpDir, 'data', 'workflow-layouts.json');
        await fs.mkdir(workflowsDir);
        // 包装格式与纯格式各放一份
        await fs.writeFile(
            path.join(workflowsDir, 'wrapped.json'),
            JSON.stringify({ name: '包装流', note: '备注', workflow: WF }, null, 2)
        );
        await fs.writeFile(
            path.join(workflowsDir, 'pure.json'),
            JSON.stringify(WF, null, 2)
        );
        app = makeApp(workflowsDir, layoutsFile);
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    describe('PUT /:id 写回', () => {
        test('包装格式只更新 workflow 字段，保留 name/note', async () => {
            const res = await request(app).put('/api/workflows/wrapped').send({ workflow: WF_NEXT });
            expect(res.body.status).toBe('ok');
            const saved = JSON.parse(await fs.readFile(path.join(workflowsDir, 'wrapped.json'), 'utf-8'));
            expect(saved.name).toBe('包装流');
            expect(saved.note).toBe('备注');
            expect(saved.workflow['3'].inputs.seed).toBe(42);
            expect(typeof saved.updatedAt).toBe('number');
        });

        test('纯 API 格式整体覆盖，保持纯格式', async () => {
            const res = await request(app).put('/api/workflows/pure').send({ workflow: WF_NEXT });
            expect(res.body.status).toBe('ok');
            const saved = JSON.parse(await fs.readFile(path.join(workflowsDir, 'pure.json'), 'utf-8'));
            expect(saved['3'].inputs.steps).toBe(30);
            expect(saved.workflow).toBeUndefined();
        });

        test('路径穿越 id 被拦截', async () => {
            const res = await request(app).put('/api/workflows/..%2F..%2Fsettings').send({ workflow: WF });
            expect(res.status).toBe(400);
        });

        test('特殊字符 id 被拦截', async () => {
            const res = await request(app).put('/api/workflows/a%2Fb').send({ workflow: WF });
            expect(res.status).toBe(400);
        });

        test('缺少 workflow 数据返回 400', async () => {
            const res = await request(app).put('/api/workflows/pure').send({});
            expect(res.status).toBe(400);
        });
    });

    describe('布局 sidecar', () => {
        test('缺省返回空 positions', async () => {
            const res = await request(app).get('/api/workflows/pure/layout');
            expect(res.body.status).toBe('ok');
            expect(res.body.layout.positions).toEqual({});
        });

        test('保存后可读回，多工作流互不覆盖', async () => {
            await request(app).put('/api/workflows/pure/layout').send({
                positions: { '3': { x: 100, y: 50 } },
                view: { scale: 1.2, tx: 10, ty: 20 }
            });
            await request(app).put('/api/workflows/wrapped/layout').send({
                positions: { '3': { x: 0, y: 0 } }
            });
            const res1 = await request(app).get('/api/workflows/pure/layout');
            expect(res1.body.layout.positions['3']).toEqual({ x: 100, y: 50 });
            expect(res1.body.layout.view.scale).toBe(1.2);
            const res2 = await request(app).get('/api/workflows/wrapped/layout');
            expect(res2.body.layout.positions['3']).toEqual({ x: 0, y: 0 });
        });

        test('PUT 无 positions 字段不报错（按空 positions 处理）', async () => {
            const res = await request(app).put('/api/workflows/pure/layout').send({});
            expect(res.body.status).toBe('ok');
        });
    });

    describe('GET 列表/详情（既有接口回归）', () => {
        test('列表含两份工作流且 nodeCount 正确', async () => {
            const res = await request(app).get('/api/workflows');
            expect(res.body.status).toBe('ok');
            const names = res.body.workflows.map((w) => w.id).sort();
            expect(names).toEqual(['pure', 'wrapped']);
            const wrapped = res.body.workflows.find((w) => w.id === 'wrapped');
            expect(wrapped.nodeCount).toBe(2);
        });
    });
});
