/**
 * ==========================================================================
 * LumenLight RunningHub 云端工作流路由
 * ==========================================================================
 * 作用：把 RunningHub 平台（云端 ComfyUI 托管）的工作流/应用能力暴露给画布：
 *   - GET  /api/runninghub/workflows   登记的工作流列表（旧登记卡兼容，
 *                                     画布节点下拉的「已登记」数据源）
 *   - POST /api/runninghub/run         提交一次生成（组装 nodeInfoList →
 *                                     提交平台 → 后端轮询 → 结果回流画布；
 *                                     直接模式 kind+resourceId+params 随
 *                                     请求下发，登记卡模式按 workflowId 查卡）
 *   - POST /api/runninghub/fetch-workflow 拉取云端工作流 JSON（节点输入
 *                                     工作流 ID 后拉取解析的数据源，apiKey 不进浏览器）
 *   - POST /api/runninghub/fetch-app   拉取 AI 应用参数模板（apiCallDemo，
 *                                     节点输入应用 ID 后动态布局的数据源）
 *
 * 链路：画布节点（RunningHubGenNode）按"登记卡"收集参数值 → 本路由把
 * 值对齐到登记卡的 nodeId/fieldName 组装 nodeInfoList（IMAGE 槽位先经
 * 平台上传接口转 fileName）→ 提交拿 taskId → utils/runninghub.js 的
 * startTaskPolling 轮询 → SUCCESS 后下载转存（平台 URL 仅 24h 有效）→
 * 经 WebSocket 推 new-image / new-video / generation-complete /
 * generation-failed（均带 target），消息格式与本地 ComfyUI 回流链路
 * （routes/comfy.js）同构，前端落图机制完全复用。
 *
 * 登记卡存于 data/settings.json 的 runninghub.workflows：
 *   { id, name, rhWorkflowId,
 *     params: [{ nodeId, fieldName, label, type: 'string'|'list'|'image',
 *                role?: 'prompt'|'negative', options?: string[] }],
 *     editorOverrides?: [{ nodeId, fieldName, fieldValue }] }
 * 参数映射（nodeId/fieldName）由登记卡「从平台拉取」自动解析（RhWorkflowImporter），
 * 也支持导入本地导出的 JSON 或手工填写；一个工作流登记一次即可。
 * editorOverrides 由工作流编辑器保存 RH 快照时自动 diff 生成
 * （utils/rhSnapshot.js），提交时并入 nodeInfoList——运行时参数行优先。
 * ==========================================================================
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const WebSocket = require('ws');
const rh = require('../utils/runninghub');
const rhSnapshot = require('../utils/rhSnapshot');

/**
 * 创建 RunningHub 路由
 * @param {Object} options - 依赖项
 * @param {Map} options.clients - WebSocket 客户端表（server.js 集中管理）
 * @param {string} options.dataDir - 数据目录（读 settings.json）
 * @returns {express.Router}
 */
function createRunningHubRouter({ clients, dataDir }) {
    const router = express.Router();
    const settingsPath = path.join(dataDir, 'settings.json');

    /**
     * 读取 RunningHub 配置（settings.json 缺区块时补默认值）
     * @returns {Promise<{apiKey: string, endpoint: string, workflows: Array}>}
     */
    async function readRunningHubConfig() {
        let settings = {};
        try {
            settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8')) || {};
        } catch {
            // 文件不存在/损坏按空配置处理（首次使用尚未保存过设置）
        }
        const rh_ = settings.runninghub || {};
        return {
            apiKey: String(rh_.apiKey || ''),
            endpoint: String(rh_.endpoint || ''),
            workflows: Array.isArray(rh_.workflows) ? rh_.workflows : []
        };
    }

    /**
     * 向所有画布客户端推送 WS 消息（与 comfy.js 的推送格式一致）
     * @param {Object} payload - 完整消息对象（含 type）
     * @returns {number} 实际送达的客户端数
     */
    function pushToCanvas(payload) {
        let sent = 0;
        clients.forEach((client) => {
            if (client.role === 'canvas' && client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(JSON.stringify(payload));
                sent++;
            }
        });
        return sent;
    }

    /**
     * GET /workflows
     * 登记的工作流列表（画布节点下拉数据源，不含 apiKey）
     */
    router.get('/workflows', async (req, res) => {
        try {
            const config = await readRunningHubConfig();
            res.json({
                status: 'ok',
                workflows: config.workflows.map((wf) => ({
                    // 下拉条目 id 统一加 rh: 前缀（与本地工作流 id 空间隔离，
                    // 节点存档恢复时按前缀识别来源）
                    id: `rh:${wf.id}`,
                    name: wf.name || wf.id,
                    // 完整参数定义必须下发：节点据此渲染参数行、判断 image
                    // 槽位并收集连线图片（缺了会导致前端不传图、后端报缺图）
                    params: Array.isArray(wf.params) ? wf.params : []
                }))
            });
        } catch (error) {
            console.error('[RunningHub] 读取工作流登记失败:', error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    /**
     * POST /run
     * 提交一次生成。两种资源解析模式：
     *   直接模式（节点直连，新节点用）：body 带 kind('workflow'|'app') +
     *     resourceId（平台纯数字 id）+ params（节点拉取模板后缓存的参数
     *     定义）——后端不再查登记卡，编辑器覆盖从快照 sidecar 按资源 id
     *     反查（仅工作流；应用无编辑器快照，无覆盖）；
     *   登记卡模式（旧存档节点兼容）：body 带 workflowId('rh:登记id')，
     *     参数与覆盖都取自登记卡——行为与历史版本完全一致。
     * 其余请求体共用：
     *   values     - 参数值 { [`${nodeId}:${fieldName}`]: string }（string/list 行）
     *   images     - 连线图片 data URI 数组（按 image 槽位顺序依次填入）
     *   target     - 发起生成的画布节点 id（结果原样回传，落回占位图）
     *   positive / negative - 提示词（填入 role=prompt/negative 的槽位）
     *   instanceType - 应用专用实例档位 default/plus/ultra（空走平台默认）
     */
    router.post('/run', async (req, res) => {
        const body = req.body || {};
        const { workflowId, values, images, target, positive, negative } = body;
        const kind = body.kind === 'app' ? 'app' : 'workflow';
        const resourceId = String(body.resourceId || '').trim();
        const instanceType = String(body.instanceType || '').trim();
        const directParams = Array.isArray(body.params)
            ? body.params.filter((p) => p && p.nodeId && p.fieldName)
            : null;

        try {
            const config = await readRunningHubConfig();
            if (!config.apiKey) {
                return res.status(400).json({
                    status: 'error',
                    message: '尚未配置 RunningHub API Key（设置 → API → RunningHub）'
                });
            }

            let params;      // 参数定义（组装 nodeInfoList 用）
            let rhId;        // 平台资源 id（工作流/应用同一空间，纯数字）
            let wf = null;   // 登记卡（登记卡模式才有）
            let editorOverrides = null;

            if (directParams && directParams.length > 0 && resourceId) {
                // 直接模式：参数模板由节点缓存下发，登记卡不参与
                if (!/^\d+$/.test(resourceId)) {
                    return res.status(400).json({
                        status: 'error',
                        message: `平台 ${kind === 'app' ? '应用' : '工作流'} ID 应为纯数字，收到: ${resourceId}`
                    });
                }
                rhId = resourceId;
                params = directParams;
                if (kind === 'workflow') {
                    editorOverrides = rhSnapshot.readOverridesFromSnapshots(
                        path.join(dataDir, 'rh-snapshots.json'), rhId);
                }
            } else {
                // 登记卡模式：旧存档节点的提交路径，行为与历史版本一致
                const regId = String(workflowId || '').replace(/^rh:/, '');
                wf = config.workflows.find((w) => w.id === regId);
                if (!wf) {
                    return res.status(404).json({ status: 'error', message: `未找到登记的工作流: ${workflowId}` });
                }
                rhId = wf.rhWorkflowId;
                params = Array.isArray(wf.params) ? wf.params : [];
                editorOverrides = Array.isArray(wf.editorOverrides) ? wf.editorOverrides : null;
            }
            const imageUris = Array.isArray(images) ? images : [];
            const vals = values && typeof values === 'object' ? values : {};

            // 组装 nodeInfoList：
            //   string/list 行 → 前端提交的值（缺省空串）
            //   image 行       → 连线图片先上传平台换 fileName
            //   role=prompt/negative 行 → 提交值缺省时用画布提示词兜底
            const nodeInfoList = [];
            let imageCursor = 0;
            try {
                for (const p of params) {
                    if (!p || !p.nodeId || !p.fieldName) continue;
                    const key = `${p.nodeId}:${p.fieldName}`;
                    let fieldValue = vals[key];

                    if (p.type === 'image') {
                        // 图片槽位：按登记顺序消费连线图片
                        const uri = imageUris[imageCursor++];
                        if (!uri) {
                            return res.status(400).json({
                                status: 'error',
                                message: `参数「${p.label || p.fieldName}」需要连入图片`
                            });
                        }
                        fieldValue = await rh.uploadMedia({
                            apiKey: config.apiKey,
                            endpoint: config.endpoint,
                            dataUri: uri,
                            filename: 'canvas_image.png'
                        });
                        console.log(`[RunningHub] 图片已上传: ${fieldValue}`);
                    } else if (/^(noise_)?seed$/i.test(String(p.fieldName))) {
                        // 种子特殊处理：ComfyUI 惯例用 -1 表示随机，但平台
                        // 校验 seed ≥ 0 会拒绝（Value -1 smaller than min of 0）。
                        // 留空或 -1 时自动换 0 ~ 2^32-1 的随机数
                        const v = String(fieldValue ?? '').trim();
                        if (!v || v === '-1') {
                            fieldValue = String(Math.floor(Math.random() * 4294967296));
                            console.log(`[RunningHub] 种子留空/-1，自动随机: ${fieldValue}`);
                        }
                    } else if (!fieldValue) {
                        // 提示词角色行：画布连线提示词兜底；普通行：模板
                        // 默认值（def，应用参数空串提交会给 FLOAT/INT 等
                        // 强类型字段转换失败）兜底
                        fieldValue = p.role === 'prompt' ? String(positive || '') :
                            p.role === 'negative' ? String(negative || '') :
                            (p.def !== undefined && String(p.def).trim() !== '')
                                ? String(p.def) : '';
                    }
                    nodeInfoList.push({
                        nodeId: String(p.nodeId),
                        fieldName: String(p.fieldName),
                        fieldValue: String(fieldValue ?? '')
                    });
                }
            } catch (err) {
                return res.status(502).json({
                    status: 'error',
                    message: `素材上传失败: ${err.message}`
                });
            }

            // 编辑器覆盖（工作流编辑器保存 RH 快照时 diff 生成；直接模式从
            // 快照 sidecar 按资源 id 反查，登记卡模式从卡上 editorOverrides）：
            // 运行时参数行优先（当次显式输入 > 持久覆盖），未被参数行压住的
            // 字段才应用覆盖
            const mergedOverrides = rhSnapshot.mergeEditorOverrides(nodeInfoList, editorOverrides);
            if (mergedOverrides > 0) {
                console.log(`[RunningHub] 已并入编辑器覆盖 ${mergedOverrides} 项`);
            }

            // 提交平台拿 taskId（工作流与应用仅 URL/档位参数不同，轮询与
            // 结果转存共用 startTaskPolling）；本请求立即返回（生成可能
            // 持续数分钟，不占住 HTTP 连接）
            console.log(`[RunningHub] 提交${kind === 'app' ? '应用' : '工作流'} ${rhId}` +
                `${instanceType ? `（${instanceType}）` : ''}，nodeInfoList(${nodeInfoList.length} 项): ` +
                JSON.stringify(nodeInfoList));
            const { taskId } = kind === 'app'
                ? await rh.submitAiApp({
                    apiKey: config.apiKey,
                    endpoint: config.endpoint,
                    aiAppId: rhId,
                    nodeInfoList,
                    instanceType: instanceType || undefined
                })
                : await rh.submitWorkflow({
                    apiKey: config.apiKey,
                    endpoint: config.endpoint,
                    rhWorkflowId: rhId,
                    nodeInfoList
                });

            rh.startTaskPolling({
                apiKey: config.apiKey,
                endpoint: config.endpoint,
                taskId,
                target: target || undefined,
                prompt: { positive: positive || '', negative: negative || '' },
                push: (type, payload) => {
                    const sent = pushToCanvas({ type, ...payload });
                    console.log(`[RunningHub] 推送 ${type} → ${sent} 个画布客户端`);
                }
            });

            res.json({ status: 'ok', taskId });
        } catch (error) {
            console.error('[RunningHub] 提交失败:', error.message);
            res.status(502).json({ status: 'error', message: error.message });
        }
    });

    /**
     * POST /fetch-workflow
     * 从平台拉取工作流 JSON（代理调用——apiKey 只存在服务端，浏览器不接触）。
     * 请求体：{ workflowId: '纯数字id' }。平台调用的超时/认证/解包统一在
     * utils/runninghub.js 的 fetchWorkflowJson，本路由只做校验与错误码映射
     */
    router.post('/fetch-workflow', async (req, res) => {
        try {
            const id = String((req.body || {}).workflowId || '').trim();
            if (!/^\d+$/.test(id)) {
                return res.status(400).json({ status: 'error', message: '需要纯数字的工作流 ID' });
            }
            const config = await readRunningHubConfig();
            if (!config.apiKey) {
                return res.status(400).json({
                    status: 'error',
                    message: '尚未配置 RunningHub API Key（设置 → API → RunningHub 云端工作流）'
                });
            }

            const workflow = await rh.fetchWorkflowJson({
                apiKey: config.apiKey,
                endpoint: config.endpoint,
                workflowId: id
            });
            res.json({ status: 'ok', workflow });
        } catch (error) {
            console.error('[RunningHub] 拉取工作流失败:', error.message);
            res.status(502).json({ status: 'error', message: error.message });
        }
    });

    /**
     * POST /fetch-app
     * 从平台拉取 AI 应用参数模板（代理调用——apiKey 只存在服务端）。
     * 请求体：{ aiAppId: '纯数字id' }。返回 { name, nodeInfoList } 原始
     * 模板，参数行解析在前端 RhAppImporter（与工作流的 RhWorkflowImporter
     * 同位：解析规则可独立测试，后端只做透传）
     */
    router.post('/fetch-app', async (req, res) => {
        try {
            const id = String((req.body || {}).aiAppId || '').trim();
            if (!/^\d+$/.test(id)) {
                return res.status(400).json({ status: 'error', message: '需要纯数字的应用 ID' });
            }
            const config = await readRunningHubConfig();
            if (!config.apiKey) {
                return res.status(400).json({
                    status: 'error',
                    message: '尚未配置 RunningHub API Key（设置 → API → RunningHub）'
                });
            }

            const template = await rh.fetchAiAppTemplate({
                apiKey: config.apiKey,
                endpoint: config.endpoint,
                aiAppId: id
            });
            res.json({ status: 'ok', ...template });
        } catch (error) {
            console.error('[RunningHub] 拉取应用模板失败:', error.message);
            res.status(502).json({ status: 'error', message: error.message });
        }
    });

    /**
     * GET /debug
     * 诊断：活跃轮询任务数
     */
    router.get('/debug', (req, res) => {
        res.json({ status: 'ok', activeTasks: rh.getActiveTaskCount() });
    });

    return router;
}

module.exports = createRunningHubRouter;
