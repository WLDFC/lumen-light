/**
 * ==========================================================================
 * RunningHub 快照与编辑器覆盖测试
 *   - utils/rhSnapshot.js 纯函数：字段级 diff（改值/新增字段/增删节点/换类型/
 *     数值字符串等价）、mergeEditorOverrides（优先级与去重）
 *   - routes/workflows.js 集成：POST /import-runninghub 落快照（upsert 语义、
 *     非法格式拦截）、PUT /:id 写回联动（diff → 登记卡 editorOverrides、
 *     结构变化报告、重新导入清除覆盖、登记卡缺失容忍）
 * 通过 supertest 直连 Express 应用，使用临时目录避免污染项目数据。
 * ==========================================================================
 */

const express = require('express');
const request = require('supertest');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');
const path = require('path');

const createWorkflowsRouter = require('../../routes/workflows');
const {
    computeFieldDiff, mergeEditorOverrides, serializeFieldValue,
    applyOverridesToSnapshots, readOverridesFromSnapshots
} = require('../../utils/rhSnapshot');

/** 拉取原版：KSampler(seed=1, steps=20) + SaveImage */
const ORIGINAL = {
    "3": { "class_type": "KSampler", "inputs": { "seed": 1, "steps": 20, "model": ["7", 0] } },
    "4": { "class_type": "SaveImage", "inputs": { "filename_prefix": "x" } }
};

describe('utils/rhSnapshot 纯函数', () => {
    test('serializeFieldValue：数字/布尔/对象/空的字符串化口径', () => {
        expect(serializeFieldValue(42)).toBe('42');
        expect(serializeFieldValue('42')).toBe('42');
        expect(serializeFieldValue(true)).toBe('true');
        expect(serializeFieldValue([1, 2])).toBe('[1,2]');
        expect(serializeFieldValue(undefined)).toBe('');
        expect(serializeFieldValue(null)).toBe('');
    });

    test('computeFieldDiff：改值进覆盖，未动字段不产生噪音', () => {
        const edited = JSON.parse(JSON.stringify(ORIGINAL));
        edited["3"].inputs.seed = 42;
        const diff = computeFieldDiff(ORIGINAL, edited);
        expect(diff.overrides).toEqual([
            { nodeId: '3', fieldName: 'seed', fieldValue: '42' }
        ]);
        expect(diff.addedNodeIds).toEqual([]);
        expect(diff.removedNodeIds).toEqual([]);
        expect(diff.structuralNodeIds).toEqual([]);
    });

    test('computeFieldDiff：数值与等值字符串视为同值（2 与 "2" 不产生覆盖）', () => {
        const edited = JSON.parse(JSON.stringify(ORIGINAL));
        edited["3"].inputs.steps = '20';
        const diff = computeFieldDiff(ORIGINAL, edited);
        expect(diff.overrides).toEqual([]);
    });

    test('computeFieldDiff：节点新增字段被忽略（平台节点未必支持，不冒进）', () => {
        const edited = JSON.parse(JSON.stringify(ORIGINAL));
        edited["3"].inputs.new_field = 'x';
        const diff = computeFieldDiff(ORIGINAL, edited);
        expect(diff.overrides).toEqual([]);
    });

    test('computeFieldDiff：新增/删除节点报告为结构变化，不出覆盖', () => {
        const edited = JSON.parse(JSON.stringify(ORIGINAL));
        edited["9"] = { "class_type": "Note", "inputs": { "text": "hi" } };
        delete edited["4"];
        const diff = computeFieldDiff(ORIGINAL, edited);
        expect(diff.overrides).toEqual([]);
        expect(diff.addedNodeIds).toEqual(['9']);
        expect(diff.removedNodeIds).toEqual(['4']);
    });

    test('computeFieldDiff：换节点类型按结构变化整体跳过', () => {
        const edited = JSON.parse(JSON.stringify(ORIGINAL));
        edited["4"].class_type = 'SaveImageDebug';
        const diff = computeFieldDiff(ORIGINAL, edited);
        expect(diff.overrides).toEqual([]);
        expect(diff.structuralNodeIds).toEqual(['4']);
    });

    test('mergeEditorOverrides：运行时参数行优先，未冲突的覆盖并入', () => {
        const runtime = [{ nodeId: '3', fieldName: 'seed', fieldValue: '7' }];
        const overrides = [
            { nodeId: '3', fieldName: 'seed', fieldValue: '42' },   // 被参数行压住
            { nodeId: '3', fieldName: 'steps', fieldValue: '30' },  // 并入
            null                                                     // 脏数据跳过
        ];
        const merged = mergeEditorOverrides(runtime, overrides);
        expect(merged).toBe(1);
        expect(runtime).toHaveLength(2);
        expect(runtime[1]).toEqual({ nodeId: '3', fieldName: 'steps', fieldValue: '30' });
    });

    test('mergeEditorOverrides：空/非法输入返回 0', () => {
        expect(mergeEditorOverrides([], undefined)).toBe(0);
        expect(mergeEditorOverrides([], [])).toBe(0);
        expect(mergeEditorOverrides(undefined, [{ nodeId: '1', fieldName: 'a', fieldValue: 'b' }])).toBe(0);
    });

    test('applyOverridesToSnapshots：覆盖写入按 rhWorkflowId 反查的条目，空数组清除', async () => {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-rh-ov-test-'));
        const file = path.join(tmp, 'rh-snapshots.json');
        try {
            await fs.writeFile(file, JSON.stringify({
                'RH-a-api': { rhWorkflowId: '111', original: {} },
                'RH-b-api': { rhWorkflowId: '222', original: {} }
            }), 'utf-8');

            const applied = await applyOverridesToSnapshots(file, '222', [
                { nodeId: '3', fieldName: 'steps', fieldValue: '30' }
            ]);
            expect(applied).toEqual({ found: true, count: 1 });
            expect(readOverridesFromSnapshots(file, '222'))
                .toEqual([{ nodeId: '3', fieldName: 'steps', fieldValue: '30' }]);
            // 其他条目不受影响
            expect(readOverridesFromSnapshots(file, '111')).toEqual([]);

            // 空数组 = 清除（不留空数组字段）
            const cleared = await applyOverridesToSnapshots(file, '222', []);
            expect(cleared.count).toBe(0);
            expect(readOverridesFromSnapshots(file, '222')).toEqual([]);
            const snapshots = JSON.parse(await fs.readFile(file, 'utf-8'));
            expect(snapshots['RH-b-api'].editorOverrides).toBeUndefined();
        } finally {
            await fs.rm(tmp, { recursive: true, force: true });
        }
    });

    test('applyOverridesToSnapshots：快照不存在返回 found=false，读取返回空数组', async () => {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-rh-ov-test-'));
        const file = path.join(tmp, 'rh-snapshots.json');
        try {
            const applied = await applyOverridesToSnapshots(file, '999', [
                { nodeId: '1', fieldName: 'a', fieldValue: 'b' }
            ]);
            expect(applied.found).toBe(false);
            expect(readOverridesFromSnapshots(file, '999')).toEqual([]);
        } finally {
            await fs.rm(tmp, { recursive: true, force: true });
        }
    });
});

describe('routes/workflows RH 快照联动', () => {
    let tmpDir, workflowsDir, dataDir, settingsFile, snapshotsFile, app;

    /** 带 RH 登记卡的 settings.json（api.providers 模拟密钥区块验证保留） */
    async function writeSettings(overrides) {
        const settings = {
            api: { providers: { someVendor: { endpoint: 'https://x', apiKey: 'sk-secret' } } },
            runninghub: { apiKey: 'rh-key', workflows: [{
                id: 'wf_1', name: '测试流', rhWorkflowId: '123456',
                params: [{ nodeId: '3', fieldName: 'seed', label: '种子', type: 'string' }],
                ...(overrides ? { editorOverrides: overrides } : {})
            }] }
        };
        await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf-8');
        return settings;
    }

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-rh-snapshot-test-'));
        workflowsDir = path.join(tmpDir, 'workflows');
        dataDir = path.join(tmpDir, 'data');
        settingsFile = path.join(dataDir, 'settings.json');
        snapshotsFile = path.join(dataDir, 'rh-snapshots.json');
        await fs.mkdir(workflowsDir);
        await fs.mkdir(dataDir);
        await writeSettings();
        app = express();
        app.use(express.json({ limit: '20mb' }));
        app.use('/api/workflows', createWorkflowsRouter({
            workflowsDir, settingsPath: settingsFile, snapshotsFile
        }));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    async function readSettingsFile() {
        return JSON.parse(await fs.readFile(settingsFile, 'utf-8'));
    }

    test('导入快照：文件落盘 + sidecar 记录基准 + created 标记', async () => {
        const res = await request(app)
            .post('/api/workflows/import-runninghub')
            .send({ name: '测试流', rhWorkflowId: '123456', workflow: ORIGINAL });
        expect(res.status).toBe(200);
        expect(res.body.created).toBe(true);
        expect(res.body.id).toBe('RH-测试流-api');

        const saved = JSON.parse(await fs.readFile(
            path.join(workflowsDir, 'RH-测试流-api.json'), 'utf-8'));
        expect(saved["3"].inputs.seed).toBe(1);

        const snapshots = JSON.parse(await fs.readFile(snapshotsFile, 'utf-8'));
        expect(snapshots['RH-测试流-api'].rhWorkflowId).toBe('123456');
        expect(snapshots['RH-测试流-api'].original["4"].inputs.filename_prefix).toBe('x');
    });

    test('重复导入同一 rhWorkflowId：复用同一文件不产生副本', async () => {
        await request(app).post('/api/workflows/import-runninghub')
            .send({ name: '测试流', rhWorkflowId: '123456', workflow: ORIGINAL });
        const v2 = JSON.parse(JSON.stringify(ORIGINAL));
        v2["3"].inputs.steps = 25;
        const res = await request(app).post('/api/workflows/import-runninghub')
            .send({ name: '测试流', rhWorkflowId: '123456', workflow: v2 });
        expect(res.status).toBe(200);
        expect(res.body.created).toBe(false);
        expect(res.body.id).toBe('RH-测试流-api');
        const files = fsSync.readdirSync(workflowsDir).filter((f) => f.startsWith('RH-'));
        expect(files).toEqual(['RH-测试流-api.json']);
    });

    test('非 API 格式（节点缺 class_type）拒绝保存', async () => {
        const res = await request(app).post('/api/workflows/import-runninghub')
            .send({ name: 'x', rhWorkflowId: '1', workflow: { "1": { inputs: {} } } });
        expect(res.status).toBe(400);
    });

    test('编辑器写回快照：diff 同步登记卡 editorOverrides，密钥区块保留', async () => {
        await request(app).post('/api/workflows/import-runninghub')
            .send({ name: '测试流', rhWorkflowId: '123456', workflow: ORIGINAL });

        const edited = JSON.parse(JSON.stringify(ORIGINAL));
        edited["3"].inputs.seed = 42;
        edited["4"].inputs.filename_prefix = 'y';
        const res = await request(app).put('/api/workflows/RH-测试流-api')
            .send({ workflow: edited });
        expect(res.status).toBe(200);
        expect(res.body.rhOverrides.count).toBe(2);
        expect(res.body.rhOverrides.appliedToCard).toBe(true);

        const settings = await readSettingsFile();
        const card = settings.runninghub.workflows[0];
        expect(card.editorOverrides).toEqual([
            { nodeId: '3', fieldName: 'seed', fieldValue: '42' },
            { nodeId: '4', fieldName: 'filename_prefix', fieldValue: 'y' }
        ]);
        // 整体读改写不得破坏文件其余区块
        expect(settings.api.providers.someVendor.apiKey).toBe('sk-secret');
    });

    test('写回时新增节点被报告为无法上云，不混入覆盖', async () => {
        await request(app).post('/api/workflows/import-runninghub')
            .send({ name: '测试流', rhWorkflowId: '123456', workflow: ORIGINAL });
        const edited = JSON.parse(JSON.stringify(ORIGINAL));
        edited["9"] = { "class_type": "Note", "inputs": { "text": "x" } };
        const res = await request(app).put('/api/workflows/RH-测试流-api')
            .send({ workflow: edited });
        expect(res.body.rhOverrides.count).toBe(0);
        expect(res.body.rhOverrides.addedNodeIds).toEqual(['9']);
    });

    test('重新导入（拉取刷新）：覆盖基准重置，登记卡旧覆盖被清除', async () => {
        await request(app).post('/api/workflows/import-runninghub')
            .send({ name: '测试流', rhWorkflowId: '123456', workflow: ORIGINAL });
        // 先制造一项覆盖
        const edited = JSON.parse(JSON.stringify(ORIGINAL));
        edited["3"].inputs.seed = 42;
        await request(app).put('/api/workflows/RH-测试流-api').send({ workflow: edited });
        let settings = await readSettingsFile();
        expect(settings.runninghub.workflows[0].editorOverrides).toHaveLength(1);

        // 重新拉取导入 → 基准重置 + 旧覆盖清除
        await request(app).post('/api/workflows/import-runninghub')
            .send({ name: '测试流', rhWorkflowId: '123456', workflow: ORIGINAL });
        settings = await readSettingsFile();
        expect(settings.runninghub.workflows[0].editorOverrides).toBeUndefined();
    });

    test('登记卡不存在（未登记/已删除）：写回不报错，覆盖仅标记未应用', async () => {
        await request(app).post('/api/workflows/import-runninghub')
            .send({ name: '孤儿快照', rhWorkflowId: '999', workflow: ORIGINAL });
        const res = await request(app).put('/api/workflows/RH-孤儿快照-api')
            .send({ workflow: ORIGINAL });
        expect(res.status).toBe(200);
        expect(res.body.rhOverrides.appliedToCard).toBe(false);
    });

    test('非快照文件的普通写回不带 rhOverrides 字段（行为不变）', async () => {
        const res = await request(app).put('/api/workflows/普通工作流')
            .send({ workflow: ORIGINAL });
        expect(res.status).toBe(200);
        expect(res.body.rhOverrides).toBeUndefined();
    });
});
