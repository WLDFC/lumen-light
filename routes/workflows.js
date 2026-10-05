/**
 * ==========================================================================
 * 工作流管理路由
 * 作用：提供工作流文件的读写接口，包括：
 *   1. 获取所有工作流列表
 *   2. 获取单个工作流详情
 *   3. 写回单个工作流（工作流编辑器的参数修改落盘）
 *   4. 节点布局读写（data/workflow-layouts.json sidecar，API 格式 JSON
 *      不含坐标，编辑器的拖拽布局单独存，不污染模板文件）
 *   5. RunningHub 快照导入（POST /import-runninghub）：平台拉取的 JSON
 *      存为 workflows/RH-*-api.json，diff 基准存 data/rh-snapshots.json；
 *      编辑器写回 RH 快照时自动 diff 出字段覆盖并同步到登记卡
 *      （utils/rhSnapshot.js，提交 RunningHub 时并入 nodeInfoList 生效）
 * ==========================================================================
 */

const express = require('express');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const rhSnapshot = require('../utils/rhSnapshot');

/**
 * 创建工作流管理路由
 * @param {Object} options - 依赖项
 * @param {string} options.workflowsDir - 工作流文件存储目录
 * @param {string} [options.layoutsFile] - 节点布局 sidecar 文件路径
 *                                       （默认 data/workflow-layouts.json）
 * @param {string} [options.settingsPath] - settings.json 路径（RH 快照
 *                                       覆盖同步到登记卡用；测试可注入）
 * @param {string} [options.snapshotsFile] - RH 快照基准 sidecar 路径
 *                                       （默认 data/rh-snapshots.json）
 * @returns {express.Router} Express 路由实例
 */
function createWorkflowsRouter(options) {
    const { workflowsDir } = options;
    const layoutsFile = options.layoutsFile
        || path.join(path.dirname(workflowsDir), 'data', 'workflow-layouts.json');
    const settingsPath = options.settingsPath
        || path.join(path.dirname(workflowsDir), 'data', 'settings.json');
    const snapshotsFile = options.snapshotsFile
        || path.join(path.dirname(workflowsDir), 'data', 'rh-snapshots.json');
    const router = express.Router();

    /**
     * 工作流文件路径解析（写接口防路径穿越）：id 只允许安全文件名字符，
     * 解析结果必须落在 workflowsDir 内
     */
    function resolveWorkflowFile(id) {
        if (typeof id !== 'string' || !/^[\w\u4e00-\u9fa5 ().+\-]+$/.test(id)) return null;
        const file = path.resolve(workflowsDir, `${id}.json`);
        if (file !== path.resolve(workflowsDir) && !file.startsWith(path.resolve(workflowsDir) + path.sep)) {
            return null;
        }
        return file;
    }

    /** 读布局 sidecar（文件缺失/损坏按空对象） */
    function readLayouts() {
        try {
            return JSON.parse(fsSync.readFileSync(layoutsFile, 'utf-8')) || {};
        } catch {
            return {};
        }
    }

    /**
     * GET /api/workflows
     * 获取所有工作流列表
     */
    router.get('/', async (req, res) => {
        try {
            const files = await fs.readdir(workflowsDir);
            const workflows = [];

            for (const file of files) {
                if (file.endsWith('.json')) {
                    try {
                        const content = await fs.readFile(path.join(workflowsDir, file), 'utf-8');
                        const data = JSON.parse(content);

                        // 检测工作流格式
                        // 格式1: 包装格式 { id, name, note, workflow: {...} }
                        // 格式2: 纯 ComfyUI 格式 { "1": {...}, "2": {...} }
                        const isWrappedFormat = data.workflow && typeof data.workflow === 'object';
                        const workflowData = isWrappedFormat ? data.workflow : data;

                        workflows.push({
                            id: file.replace('.json', ''),
                            name: data.name || file.replace('.json', ''),
                            note: data.note || '',
                            nodeCount: workflowData ? Object.keys(workflowData).length : 0,
                            updatedAt: data.updatedAt || Date.now()
                        });
                    } catch (e) {
                        console.error('读取工作流失败:', file, e.message);
                    }
                }
            }

            res.json({
                status: 'ok',
                workflows: workflows.sort((a, b) => b.updatedAt - a.updatedAt)
            });
        } catch (error) {
            res.status(500).json({
                status: 'error',
                message: error.message
            });
        }
    });

    /**
     * GET /api/workflows/:id
     * 获取单个工作流详情
     */
    router.get('/:id', async (req, res) => {
        try {
            const filePath = path.join(workflowsDir, `${req.params.id}.json`);
            const content = await fs.readFile(filePath, 'utf-8');
            const data = JSON.parse(content);

            // 检测工作流格式
            const isWrappedFormat = data.workflow && typeof data.workflow === 'object';

            if (isWrappedFormat) {
                // 已经是包装格式，直接返回
                res.json({
                    status: 'ok',
                    ...data
                });
            } else {
                // 纯 ComfyUI 格式，需要包装
                res.json({
                    status: 'ok',
                    id: req.params.id,
                    name: req.params.id,
                    note: '',
                    workflow: data,
                    updatedAt: Date.now()
                });
            }
        } catch (error) {
            res.status(404).json({
                status: 'error',
                message: '工作流不存在'
            });
        }
    });

    /**
     * PUT /api/workflows/:id
     * 写回工作流（工作流编辑器保存）：保持原文件的包装/纯 API 格式不变——
     * 包装格式只更新 workflow 字段（保留 name/note），纯格式整体覆盖。
     * 请求体 { workflow: {...} }
     */
    router.put('/:id', express.json({ limit: '20mb' }), async (req, res) => {
        const file = resolveWorkflowFile(req.params.id);
        if (!file) return res.status(400).json({ status: 'error', message: '非法的工作流 id' });
        const workflow = req.body && req.body.workflow;
        if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
            return res.status(400).json({ status: 'error', message: '缺少 workflow 数据' });
        }
        try {
            // 严格保持原文件形态：包装格式更新 workflow 字段（保留
            // name/note），纯 API 格式原样覆盖——纯格式里多出任何非节点
            // 外层键都会被 ComfyUI 当成一个节点（无 class_type 而报错）
            let existing = null;
            try {
                existing = JSON.parse(await fs.readFile(file, 'utf-8'));
            } catch { /* 原文件缺失/损坏：按纯格式写入 */ }
            const isWrapped = existing && existing.workflow && typeof existing.workflow === 'object'
                && !Array.isArray(existing.workflow);
            if (isWrapped) {
                existing.workflow = workflow;
                existing.updatedAt = Date.now();
                await fs.writeFile(file, JSON.stringify(existing, null, 2), 'utf-8');
            } else {
                await fs.writeFile(file, JSON.stringify(workflow, null, 2), 'utf-8');
            }
            // RH 快照联动：本文件是从平台拉取的快照时，diff 出字段级覆盖
            // 同步进登记卡（editorOverrides），提交 RunningHub 时生效。
            // 结构性改动（增删节点/换类型）无法表达为覆盖，随响应报告
            let rhOverrides = null;
            const snapshots = rhSnapshot.readSnapshots(snapshotsFile);
            const entry = snapshots[req.params.id];
            if (entry && entry.rhWorkflowId && entry.original) {
                const diff = rhSnapshot.computeFieldDiff(entry.original, workflow);
                const applied = await rhSnapshot.applyOverridesToSettings(
                    settingsPath, entry.rhWorkflowId, diff.overrides);
                // 镜像写进快照条目：节点直连模式（无登记卡）的提交链路
                // 从这里读 editorOverrides
                await rhSnapshot.applyOverridesToSnapshots(
                    snapshotsFile, entry.rhWorkflowId, diff.overrides);
                rhOverrides = {
                    count: diff.overrides.length,
                    appliedToCard: applied.found,
                    addedNodeIds: diff.addedNodeIds,
                    removedNodeIds: diff.removedNodeIds,
                    structuralNodeIds: diff.structuralNodeIds
                };
                console.log(`[RH快照] ${req.params.id} 写回：字段覆盖 ${diff.overrides.length} 项` +
                    `${applied.found ? '已同步登记卡' : '（未找到对应登记卡，仅本地生效）'}` +
                    (diff.addedNodeIds.length ? `，新增节点 ${diff.addedNodeIds.length} 个无法上云` : '') +
                    (diff.removedNodeIds.length ? `，删除节点 ${diff.removedNodeIds.length} 个无法上云` : ''));
            }
            res.json({ status: 'ok', ...(rhOverrides ? { rhOverrides } : {}) });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    /**
     * POST /api/workflows/import-runninghub
     * 把平台拉取的 RunningHub 工作流 JSON 存为本地快照（upsert：同一
     * rhWorkflowId 复用已有文件，重复拉取不产生副本）。快照以纯 API 格式
     * 落盘（编辑器可直接渲染），拉取原版存 data/rh-snapshots.json 作 diff
     * 基准。重新拉取会覆盖快照并重置基准（登记卡的编辑器覆盖一并清除——
     * 旧覆盖基于旧版工作流，留着是隐患）。
     * 请求体 { name, rhWorkflowId, workflow }，响应 { status, id, created }
     */
    router.post('/import-runninghub', express.json({ limit: '20mb' }), async (req, res) => {
        const body = req.body || {};
        const rhWorkflowId = String(body.rhWorkflowId || '').trim();
        const workflow = body.workflow;
        if (!rhWorkflowId) {
            return res.status(400).json({ status: 'error', message: '缺少 rhWorkflowId' });
        }
        if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)
            || Object.keys(workflow).length === 0) {
            return res.status(400).json({ status: 'error', message: 'workflow 数据缺失或格式不对' });
        }
        // 轻量格式校验：API 格式的节点值必须是含 class_type 的对象——
        // 平台若返回 UI 格式（数组/逐步结构）在这里拦下，不落脏文件
        const nodes = Object.values(workflow);
        if (!nodes.every((n) => n && typeof n === 'object' && !Array.isArray(n)
            && typeof n.class_type === 'string' && n.class_type)) {
            return res.status(400).json({
                status: 'error',
                message: '不是 ComfyUI API 格式的工作流（节点缺少 class_type），无法作为快照保存'
            });
        }

        try {
            const snapshots = rhSnapshot.readSnapshots(snapshotsFile);
            // upsert：同 rhWorkflowId 复用已有快照文件
            let id = Object.keys(snapshots).find(
                (k) => snapshots[k] && snapshots[k].rhWorkflowId === rhWorkflowId);
            const created = !id;
            if (!id) {
                // 文件名：RH-<净化后的名称>-api；撞已有文件时追加序号
                const safeName = String(body.name || '')
                    .replace(/[^\w\u4e00-\u9fa5 ().+\-]/g, '')
                    .trim().slice(0, 60);
                const base = `RH-${safeName || rhWorkflowId}-api`;
                id = base;
                for (let i = 2; fsSync.existsSync(path.join(workflowsDir, `${id}.json`)); i++) {
                    id = `${base}-${i}`;
                }
            }
            await fs.writeFile(
                path.join(workflowsDir, `${id}.json`),
                JSON.stringify(workflow, null, 2), 'utf-8');
            snapshots[id] = {
                rhWorkflowId,
                name: String(body.name || '').slice(0, 100),
                fetchedAt: Date.now(),
                original: workflow
            };
            await rhSnapshot.writeSnapshots(snapshotsFile, snapshots);
            // 基准已重置：旧覆盖清掉（找不到登记卡也没关系，属可选清理）
            await rhSnapshot.applyOverridesToSettings(settingsPath, rhWorkflowId, []);
            console.log(`[RH快照] ${created ? '新建' : '更新'}快照 ${id}（平台 ${rhWorkflowId}，` +
                `${Object.keys(workflow).length} 节点），diff 基准已重置`);
            res.json({ status: 'ok', id, created });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    /**
     * GET /api/workflows/:id/layout
     * 读工作流的编辑器节点布局（sidecar，缺失返回空对象）
     */
    router.get('/:id/layout', (req, res) => {
        const layouts = readLayouts();
        res.json({ status: 'ok', layout: layouts[req.params.id] || { positions: {} } });
    });

    /**
     * PUT /api/workflows/:id/layout
     * 保存工作流的编辑器节点布局（拖拽结束后由前端防抖调用）
     * 请求体 { positions: { [nodeId]: { x, y } }, view?: { scale, tx, ty },
     *          bypassed?: string[]（忽略节点 id；不传保留原值） }
     */
    router.put('/:id/layout', express.json({ limit: '2mb' }), async (req, res) => {
        if (typeof req.params.id !== 'string' || req.params.id.length > 200) {
            return res.status(400).json({ status: 'error', message: '非法的工作流 id' });
        }
        const body = req.body || {};
        const positions = body.positions && typeof body.positions === 'object' ? body.positions : {};
        try {
            const layouts = readLayouts();
            const prev = layouts[req.params.id] || {};
            layouts[req.params.id] = {
                positions,
                ...(body.view && typeof body.view === 'object' ? { view: body.view } : {}),
                // bypass（忽略节点）状态：只在请求体显式携带时更新，
                // 拖拽防抖保存不带该字段时保留原值
                ...(Array.isArray(body.bypassed)
                    ? { bypassed: body.bypassed.map(String).filter(Boolean) }
                    : (prev.bypassed ? { bypassed: prev.bypassed } : {}))
            };
            await fs.mkdir(path.dirname(layoutsFile), { recursive: true });
            await fs.writeFile(layoutsFile, JSON.stringify(layouts, null, 2), 'utf-8');
            res.json({ status: 'ok' });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    return router;
}

module.exports = createWorkflowsRouter;
