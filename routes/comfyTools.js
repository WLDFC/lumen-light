/**
 * ==========================================================================
 * Comfy 原生工具路由（comfy-mcp 工具原生化，供 pi 扩展 lumen-comfy 调用）
 * ==========================================================================
 * comfy-mcp MCP 服务器（comfy-cli 封装，venv 不可随包分发）退役后，
 * 其精选工具在本路由用「ComfyUI HTTP API + Manager API + 模板画廊直连」
 * 原生重实现，零 venv 零 spawn。每个端点对应一个 agent 工具
 * （comfy_mcp_*），返回约定：{status:'ok', data} / {status:'error', message}。
 *
 * 工具 → 端点对照（上游 comfy-mcp v0.10.0 命名一一对应，便于日后
 * MCP 更新时对照升级）：
 *   system_stats          GET  /system-stats        ComfyUI /system_stats
 *   free_memory           POST /free-memory         ComfyUI /free
 *   job                   POST /job                 /queue + /interrupt + /history
 *   fetch_outputs         POST /fetch-outputs       /history + /view
 *   run_workflow          POST /run-workflow        本地 JSON →(UI 格式先转)→ /prompt
 *   list_workflow_slots   POST /list-workflow-slots utils/comfyWorkflowFormat
 *   set_workflow_slot     POST /set-workflow-slot   同上，写回文件
 *   search_templates      POST /search-templates    GitHub 画廊 index.json
 *   fetch_template        POST /fetch-template      GitHub 画廊模板 JSON
 *   run_template          POST /run-template        取模板→转格式→填槽→提交
 *   nodes                 POST /nodes               /object_info 搜索/检视
 *   search_models         POST /search-models       /object_info 按类别聚合
 *   download_model        POST /download-model      流式下载到 ComfyUI 根目录（需配置）
 *   download              POST /download            下载任务状态/取消（内存注册表）
 *   upload_file           POST /upload-file         /upload/image（multipart）
 *   install_node          POST /install-node        ComfyUI Manager API
 *   workflow_deps         POST /workflow-deps       object_info + Manager 映射
 *   get_logs              GET  /get-logs            ComfyUI /internal/logs
 * ==========================================================================
 */

const express = require('express');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { submitPromptToComfy } = require('../utils/comfySubmit');
const {
    isUiFormat,
    convertUiToApi,
    collectClassTypes,
    listWorkflowSlots,
    setWorkflowSlots
} = require('../utils/comfyWorkflowFormat');

// 模板画廊（Comfy-Org/workflow_templates 仓库直连，comfy-cli 同源）
const GALLERY_INDEX_URL =
    'https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/index.json';
const TEMPLATE_WORKFLOW_URL =
    'https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/{name}.json';

// 已知加载类 → 模型类别（search_models 的聚合依据；字段取值与
// routes/comfyNode.js LOADER_CLASSES 同源思路，此处覆盖面更宽）
const MODEL_CATEGORIES = [
    ['checkpoints', ['CheckpointLoaderSimple', 'CheckpointLoaderAdvanced'], ['ckpt_name']],
    ['unets', ['UNETLoader', 'UnetLoaderGGUF', 'UnetLoaderGGUFAdvanced'], ['unet_name']],
    ['loras', ['LoraLoader', 'LoraLoaderModelOnly'], ['lora_name']],
    ['vae', ['VAELoader'], ['vae_name']],
    ['clip', ['CLIPLoader', 'DualCLIPLoader', 'TripleCLIPLoader', 'QuadrupleCLIPLoader'], ['clip_name']],
    ['clip_vision', ['CLIPVisionLoader'], ['clip_name']],
    ['controlnet', ['ControlNetLoader'], ['control_net_name']],
    ['style_models', ['StyleModelLoader'], ['style_model_name']],
    ['upscale_models', ['UpscaleModelLoader'], ['model_name']],
    ['ipadapter', ['IPAdapterModelLoader'], ['ipadapter_file']],
    ['photomaker', ['PhotoMakerLoader'], ['photomaker_model_name']]
];

/**
 * 创建 Comfy 原生工具路由
 * @param {Object} options - 依赖项
 * @param {string} options.comfyApiUrl - ComfyUI API 地址
 * @param {Function} options.getComfyRoot - 读取 ComfyUI 根目录配置（实时，
 *        存于 data/settings.json 的 comfy.root；download_model 落盘用）
 * @returns {express.Router} Express 路由实例
 */
function createComfyToolsRouter({ comfyApiUrl, getComfyRoot }) {
    const router = express.Router();

    // ==================== 通用辅助 ====================

    async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    function fail(res, error, status = 500) {
        console.error('[comfy-tools]', error.message || error);
        res.status(status).json({ status: 'error', message: error.message || String(error) });
    }

    // /object_info 响应有数 MB，进程内缓存 60 秒
    let objectInfoCache = null;
    let objectInfoAt = 0;
    async function getObjectInfo(force = false) {
        if (!force && objectInfoCache && Date.now() - objectInfoAt < 60_000) {
            return objectInfoCache;
        }
        const res = await fetchWithTimeout(`${comfyApiUrl}/object_info`, {}, 20000);
        if (!res.ok) throw new Error(`ComfyUI /object_info 响应 ${res.status}（ComfyUI 未在线？）`);
        objectInfoCache = await res.json();
        objectInfoAt = Date.now();
        return objectInfoCache;
    }

    // 读取本地工作流 JSON：绝对路径，或相对 ComfyUI 根目录（未配置时相对进程 cwd）
    async function readWorkflowFile(p) {
        const raw = String(p || '').trim();
        if (!raw) throw new Error('缺少工作流文件路径');
        let full = path.isAbsolute(raw) ? raw : path.join(getComfyRoot() || process.cwd(), raw);
        full = path.normalize(full);
        const content = await fsp.readFile(full, 'utf-8');
        let workflow;
        try {
            workflow = JSON.parse(content);
        } catch (e) {
            throw new Error(`工作流文件不是合法 JSON：${e.message}`);
        }
        return { full, workflow };
    }

    // 提交并可选等待完成（轮询 /history 直到出现该 prompt_id）
    async function submitWorkflow(apiPrompt, { wait = false, timeoutSeconds = 120 } = {}) {
        const { promptId } = await submitPromptToComfy(comfyApiUrl, apiPrompt, 'comfy_tool');
        if (!wait) return { promptId };

        const deadline = Date.now() + Math.max(10, timeoutSeconds) * 1000;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 1500));
            const res = await fetchWithTimeout(`${comfyApiUrl}/history/${promptId}`, {}, 10000);
            const history = await res.json().catch(() => ({}));
            if (history[promptId]) {
                const entry = history[promptId];
                const status = entry.status || {};
                return {
                    promptId,
                    completed: status.completed !== false,
                    statusStr: status.status_str || (status.completed !== false ? 'success' : 'error'),
                    messages: (status.messages || []).length
                };
            }
        }
        return { promptId, wait: 'timeout', message: `等待 ${timeoutSeconds}s 未完成（任务仍在队列执行），可稍后用 job/fetch_outputs 查询` };
    }

    // ==================== 状态与任务 ====================

    // GET /api/comfy-tools/system-stats
    router.get('/system-stats', async (req, res) => {
        try {
            const r = await fetchWithTimeout(`${comfyApiUrl}/system_stats`);
            if (!r.ok) throw new Error(`ComfyUI /system_stats 响应 ${r.status}（ComfyUI 未在线？）`);
            res.json({ status: 'ok', data: await r.json() });
        } catch (error) {
            fail(res, error);
        }
    });

    // POST /api/comfy-tools/free-memory  { unload_models?, free_memory? }
    router.post('/free-memory', async (req, res) => {
        try {
            const { unload_models = true, free_memory = true } = req.body || {};
            const r = await fetchWithTimeout(`${comfyApiUrl}/free`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ unload_models: !!unload_models, free_memory: !!free_memory })
            });
            if (!r.ok) throw new Error(`ComfyUI /free 响应 ${r.status}`);
            res.json({ status: 'ok', data: { done: true, unload_models: !!unload_models, free_memory: !!free_memory } });
        } catch (error) {
            fail(res, error);
        }
    });

    // POST /api/comfy-tools/job  { action: 'status'|'wait'|'cancel', prompt_id?, timeout_seconds? }
    router.post('/job', async (req, res) => {
        try {
            const { action = 'status', prompt_id: promptId = '', timeout_seconds: timeoutSeconds = 120 } = req.body || {};

            if (action === 'status') {
                const r = await fetchWithTimeout(`${comfyApiUrl}/queue`);
                if (!r.ok) throw new Error(`ComfyUI /queue 响应 ${r.status}`);
                const queue = await r.json();
                // 条目格式 [执行序号, prompt_id, ...]，只取 id 摘要
                const summarize = (list) => (list || [])
                    .map((e) => (Array.isArray(e) ? { number: e[0], promptId: e[1] } : { promptId: e?.promptId }))
                    .filter((e) => e.promptId);
                return res.json({
                    status: 'ok',
                    data: { running: summarize(queue.queue_running), pending: summarize(queue.queue_pending) }
                });
            }

            if (action === 'wait') {
                if (!promptId) throw new Error('action=wait 需要 prompt_id');
                const deadline = Date.now() + Math.max(10, timeoutSeconds) * 1000;
                while (Date.now() < deadline) {
                    await new Promise((r) => setTimeout(r, 2000));
                    const hr = await fetchWithTimeout(`${comfyApiUrl}/history/${promptId}`, {}, 10000);
                    const history = await hr.json().catch(() => ({}));
                    if (history[promptId]) {
                        const st = history[promptId].status || {};
                        return res.json({
                            status: 'ok',
                            data: { promptId, completed: true, statusStr: st.status_str || 'success' }
                        });
                    }
                    // 不在历史里时查一次队列，确认还活着（被删/中断即结束）
                    const qr = await fetchWithTimeout(`${comfyApiUrl}/queue`);
                    const queue = await qr.json().catch(() => ({}));
                    const stillQueued = [].concat(queue.queue_running || [], queue.queue_pending || [])
                        .some((e) => Array.isArray(e) && e[1] === promptId);
                    if (!stillQueued) {
                        return res.json({
                            status: 'ok',
                            data: { promptId, completed: false, message: '任务已不在队列也不在历史（被取消或失败）' }
                        });
                    }
                }
                return res.json({ status: 'ok', data: { promptId, wait: 'timeout', message: `等待 ${timeoutSeconds}s 未完成` } });
            }

            if (action === 'cancel') {
                let interrupted = false;
                let deleted = 0;
                // /interrupt 无法指定 id：正在执行的确属目标任务（或未指明 id）
                // 才中断；待队列的按 id 删除
                if (promptId) {
                    const qr = await fetchWithTimeout(`${comfyApiUrl}/queue`);
                    const queue = await qr.json().catch(() => ({}));
                    const runningIds = [].concat(queue.queue_running || [])
                        .map((e) => (Array.isArray(e) ? e[1] : null)).filter(Boolean);
                    const pendingIds = [].concat(queue.queue_pending || [])
                        .map((e) => (Array.isArray(e) ? e[1] : null)).filter(Boolean);
                    if (runningIds.includes(promptId)) {
                        await fetchWithTimeout(`${comfyApiUrl}/interrupt`, { method: 'POST' });
                        interrupted = true;
                    }
                    if (pendingIds.includes(promptId)) {
                        await fetchWithTimeout(`${comfyApiUrl}/queue`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ delete: [promptId] })
                        });
                        deleted = 1;
                    }
                    if (!interrupted && deleted === 0) {
                        return res.json({
                            status: 'ok',
                            data: { promptId, interrupted: false, deleted: 0, message: '目标任务不在队列中（可能已完成）' }
                        });
                    }
                } else {
                    await fetchWithTimeout(`${comfyApiUrl}/interrupt`, { method: 'POST' });
                    interrupted = true;
                }
                return res.json({ status: 'ok', data: { promptId: promptId || null, interrupted, deleted } });
            }

            throw new Error(`未知 action "${action}"（可选 status / wait / cancel）`);
        } catch (error) {
            fail(res, error);
        }
    });

    // POST /api/comfy-tools/fetch-outputs  { prompt_id, out_dir?, inline_images?, max_inline? }
    router.post('/fetch-outputs', async (req, res) => {
        try {
            const {
                prompt_id: promptId,
                out_dir: outDir = '',
                inline_images: inlineImages = false,
                max_inline: maxInline = 4
            } = req.body || {};
            if (!promptId) throw new Error('缺少 prompt_id');

            const r = await fetchWithTimeout(`${comfyApiUrl}/history/${promptId}`);
            if (!r.ok) throw new Error(`ComfyUI /history 响应 ${r.status}`);
            const history = await r.json();
            const entry = history[promptId];
            if (!entry) throw new Error('history 中没有该 prompt_id（任务未完成或已被清理）');

            // 汇总全部节点的输出图片/视频
            const files = [];
            for (const [nodeId, out] of Object.entries(entry.outputs || {})) {
                for (const key of ['images', 'gifs', 'videos']) {
                    for (const f of (out?.[key] || [])) {
                        if (f && f.filename) {
                            files.push({ node: nodeId, kind: key, ...f });
                        }
                    }
                }
            }

            const toViewUrl = (f) => `${comfyApiUrl}/view?filename=${encodeURIComponent(f.filename)}` +
                `&subfolder=${encodeURIComponent(f.subfolder || '')}&type=${encodeURIComponent(f.type || 'output')}`;

            const data = {
                promptId,
                statusStr: entry.status?.status_str || 'success',
                files: files.map((f) => ({ ...f, url: toViewUrl(f) }))
            };

            // 落盘模式：下载到指定目录
            if (outDir) {
                const dir = path.isAbsolute(outDir) ? outDir : path.join(getComfyRoot() || process.cwd(), outDir);
                await fsp.mkdir(dir, { recursive: true });
                let saved = 0;
                for (const f of files) {
                    const vr = await fetchWithTimeout(toViewUrl(f), {}, 120000);
                    if (!vr.ok) continue;
                    const buf = Buffer.from(await vr.arrayBuffer());
                    await fsp.writeFile(path.join(dir, f.filename), buf);
                    saved++;
                }
                data.savedTo = dir;
                data.saved = saved;
            }

            // 内联模式：前 N 张转 base64（多模态模型可直接查看）
            if (inlineImages) {
                data.inline = [];
                for (const f of files.slice(0, Math.max(1, Math.min(maxInline, 8)))) {
                    const vr = await fetchWithTimeout(toViewUrl(f), {}, 120000);
                    if (!vr.ok) continue;
                    const buf = Buffer.from(await vr.arrayBuffer());
                    if (buf.length > 8 * 1024 * 1024) continue;   // 单张 8MB 上限
                    data.inline.push({
                        filename: f.filename,
                        dataUrl: `data:${vr.headers.get('content-type') || 'image/png'};base64,${buf.toString('base64')}`
                    });
                }
            }

            res.json({ status: 'ok', data });
        } catch (error) {
            fail(res, error);
        }
    });

    // ==================== 工作流执行与槽位 ====================

    // POST /api/comfy-tools/run-workflow  { path, overrides?, wait?, timeout_seconds? }
    router.post('/run-workflow', async (req, res) => {
        try {
            const { path: wfPath, overrides = {}, wait = false, timeout_seconds: timeoutSeconds = 120 } = req.body || {};
            const { workflow } = await readWorkflowFile(wfPath);
            const objectInfo = await getObjectInfo();

            let apiPrompt;
            if (isUiFormat(workflow)) {
                // 槽位覆盖在转换前应用：标题别名（如 positive.text）只存在于
                // UI 格式，转换后就只剩节点 id 地址了
                const withOverrides = (overrides && Object.keys(overrides).length > 0)
                    ? setWorkflowSlots(workflow, overrides, objectInfo)
                    : workflow;
                apiPrompt = convertUiToApi(withOverrides, objectInfo);
            } else {
                apiPrompt = (overrides && Object.keys(overrides).length > 0)
                    ? setWorkflowSlots(workflow, overrides, objectInfo)
                    : workflow;
            }
            const result = await submitWorkflow(apiPrompt, { wait, timeoutSeconds });
            res.json({ status: 'ok', data: result });
        } catch (error) {
            fail(res, error);
        }
    });

    // POST /api/comfy-tools/list-workflow-slots  { path }
    router.post('/list-workflow-slots', async (req, res) => {
        try {
            const { path: wfPath } = req.body || {};
            const { full, workflow } = await readWorkflowFile(wfPath);
            const objectInfo = await getObjectInfo();
            const slots = listWorkflowSlots(workflow, objectInfo);
            res.json({
                status: 'ok',
                data: { workflow: full, format: isUiFormat(workflow) ? 'ui' : 'api', count: slots.length, slots }
            });
        } catch (error) {
            fail(res, error);
        }
    });

    // POST /api/comfy-tools/set-workflow-slot  { path, overrides, stdout? }
    router.post('/set-workflow-slot', async (req, res) => {
        try {
            const { path: wfPath, overrides, stdout = false } = req.body || {};
            if (!overrides || typeof overrides !== 'object' || Object.keys(overrides).length === 0) {
                throw new Error('缺少 overrides（{ 槽位地址: 新值 }）');
            }
            const { full, workflow } = await readWorkflowFile(wfPath);
            const objectInfo = await getObjectInfo();
            const updated = setWorkflowSlots(workflow, overrides, objectInfo);
            if (!stdout) {
                await fsp.writeFile(full, JSON.stringify(updated, null, 2), 'utf-8');
            }
            res.json({
                status: 'ok',
                data: {
                    workflow: full, written: !stdout,
                    applied: Object.keys(overrides),
                    workflowJson: stdout ? updated : undefined
                }
            });
        } catch (error) {
            fail(res, error);
        }
    });

    // ==================== 模板画廊（GitHub 直连） ====================

    let galleryCache = null;
    let galleryAt = 0;
    async function getGallery() {
        if (galleryCache && Date.now() - galleryAt < 600_000) return galleryCache;
        const r = await fetchWithTimeout(GALLERY_INDEX_URL, {}, 20000);
        if (!r.ok) throw new Error(`模板画廊 index.json 拉取失败（HTTP ${r.status}）`);
        const categories = await r.json();
        // 扁平化（与 comfy-cli _flatten_templates 同源逻辑，字段取子集）
        const rows = [];
        for (const cat of (Array.isArray(categories) ? categories : [])) {
            if (!cat || typeof cat !== 'object') continue;
            const outputType = cat.type || '';
            for (const t of (cat.templates || [])) {
                if (!t || typeof t !== 'object') continue;
                rows.push({
                    name: t.name || '',
                    title: (t.title || '').trim(),
                    description: t.description || '',
                    output_type: outputType,
                    category_title: cat.title || '',
                    tags: Array.isArray(t.tags) ? t.tags : [],
                    models: Array.isArray(t.models) ? t.models : [],
                    requires_custom_nodes: Array.isArray(t.requiresCustomNodes) ? t.requiresCustomNodes : [],
                    date: t.date || ''
                });
            }
        }
        galleryCache = rows;
        galleryAt = Date.now();
        return rows;
    }

    // POST /api/comfy-tools/search-templates  { query?, tag?, type?, model?, name?, limit?, offset? }
    router.post('/search-templates', async (req, res) => {
        try {
            const { query = '', tag = '', type = '', model = '', name = '', limit = 20, offset = 0 } = req.body || {};
            let rows = await getGallery();
            const hit = (s, q) => !q || String(s || '').toLowerCase().includes(String(q).toLowerCase());
            rows = rows.filter((r) =>
                hit(r.name, name)
                && (!tag || r.tags.some((t) => String(t).toLowerCase() === String(tag).toLowerCase()))
                && (!type || (r.output_type || '').toLowerCase() === String(type).toLowerCase())
                && (!model || r.models.some((m) => String(m).toLowerCase().includes(String(model).toLowerCase())))
                && (!query || hit(r.name, query) || hit(r.title, query) || hit(r.description, query)));
            const total = rows.length;
            res.json({
                status: 'ok',
                data: { total, offset, count: rows.slice(offset, offset + limit).length, templates: rows.slice(offset, offset + limit) }
            });
        } catch (error) {
            fail(res, error);
        }
    });

    // POST /api/comfy-tools/fetch-template  { name, out_path? }
    router.post('/fetch-template', async (req, res) => {
        try {
            const { name, out_path: outPath = '' } = req.body || {};
            if (!name) throw new Error('缺少模板 name（先用 search_templates 查）');
            const url = TEMPLATE_WORKFLOW_URL.replace('{name}', encodeURIComponent(name));
            const r = await fetchWithTimeout(url, {}, 20000);
            if (!r.ok) throw new Error(`模板 "${name}" 拉取失败（HTTP ${r.status}）——name 需与画廊清单一致`);
            const template = await r.json();

            const data = { name, nodeCount: Array.isArray(template.nodes) ? template.nodes.length : null };
            if (outPath) {
                let full = path.isAbsolute(outPath)
                    ? outPath
                    : path.join(getComfyRoot() || process.cwd(), outPath);
                full = path.normalize(full);
                await fsp.mkdir(path.dirname(full), { recursive: true });
                await fsp.writeFile(full, JSON.stringify(template, null, 2), 'utf-8');
                data.savedTo = full;
            } else {
                data.workflow = template;
            }
            res.json({ status: 'ok', data });
        } catch (error) {
            fail(res, error);
        }
    });

    // POST /api/comfy-tools/run-template  { name, params?, wait?, timeout_seconds? }
    router.post('/run-template', async (req, res) => {
        try {
            const { name, params = {}, wait = false, timeout_seconds: timeoutSeconds = 120 } = req.body || {};
            if (!name) throw new Error('缺少模板 name（先用 search_templates 查）');
            const url = TEMPLATE_WORKFLOW_URL.replace('{name}', encodeURIComponent(name));
            const r = await fetchWithTimeout(url, {}, 20000);
            if (!r.ok) throw new Error(`模板 "${name}" 拉取失败（HTTP ${r.status}）`);
            const template = await r.json();

            const objectInfo = await getObjectInfo();
            const apiPrompt = convertUiToApi(template, objectInfo);
            const filled = Object.keys(params || {}).length > 0
                ? setWorkflowSlots(apiPrompt, params, objectInfo)
                : apiPrompt;
            const result = await submitWorkflow(filled, { wait, timeoutSeconds });
            res.json({ status: 'ok', data: { template: name, ...result } });
        } catch (error) {
            fail(res, error);
        }
    });

    // ==================== 节点与模型 ====================

    // POST /api/comfy-tools/nodes  { action: 'search'|'inspect', query?, class_type? }
    router.post('/nodes', async (req, res) => {
        try {
            const { action = 'search', query = '', class_type: classType = '' } = req.body || {};
            const objectInfo = await getObjectInfo();
            if (action === 'inspect') {
                if (!classType) throw new Error('action=inspect 需要 class_type');
                const def = objectInfo[classType];
                if (!def) throw new Error(`节点类 "${classType}" 不在 object_info 中`);
                const summary = {
                    class_type: classType,
                    input: def.input || {},
                    output: def.output || [],
                    output_name: def.output_name || [],
                    output_node: !!def.output_node
                };
                return res.json({ status: 'ok', data: summary });
            }
            // search：类名子串匹配，返回输入/输出概要
            const q = query.toLowerCase();
            const all = Object.keys(objectInfo)
                .filter((k) => !q || k.toLowerCase().includes(q))
                .sort();
            const items = all.slice(0, 100).map((k) => {
                const def = objectInfo[k];
                return {
                    class_type: k,
                    inputs: Object.keys(def?.input?.required || {}),
                    outputs: def?.output_name || def?.output || []
                };
            });
            res.json({ status: 'ok', data: { total: all.length, count: items.length, classes: items } });
        } catch (error) {
            fail(res, error);
        }
    });

    // POST /api/comfy-tools/search-models  { query?, category? }
    router.post('/search-models', async (req, res) => {
        try {
            const { query = '', category = '' } = req.body || {};
            const objectInfo = await getObjectInfo();
            const result = {};
            for (const [cat, classes, fields] of MODEL_CATEGORIES) {
                if (category && cat !== category) continue;
                const files = new Set();
                for (const cls of classes) {
                    const def = objectInfo[cls];
                    if (!def) continue;
                    for (const field of fields) {
                        const spec = def?.input?.required?.[field] || def?.input?.optional?.[field];
                        if (Array.isArray(spec?.[0])) {
                            for (const f of spec[0]) {
                                if (typeof f === 'string' && f) files.add(f);
                            }
                        }
                    }
                }
                if (files.size > 0) {
                    result[cat] = [...files].sort();
                }
            }
            // query 过滤（跨类别子串匹配）
            if (query) {
                const q = query.toLowerCase();
                for (const cat of Object.keys(result)) {
                    result[cat] = result[cat].filter((f) => f.toLowerCase().includes(q));
                    if (result[cat].length === 0) delete result[cat];
                }
            }
            res.json({ status: 'ok', data: { categories: result } });
        } catch (error) {
            fail(res, error);
        }
    });

    // ==================== 模型下载（内存任务注册表） ====================

    const downloads = new Map();   // id → {id,url,target,received,total,status,error,controller,startedAt}
    let downloadSeq = 0;

    // POST /api/comfy-tools/download-model  { url, relative_path?, filename?, wait?, timeout_seconds? }
    router.post('/download-model', async (req, res) => {
        try {
            const {
                url,
                relative_path: relativePath = '',
                filename = '',
                wait = false,
                timeout_seconds: timeoutSeconds = 600
            } = req.body || {};
            if (!url) throw new Error('缺少下载 url');

            const root = getComfyRoot();
            if (!root) {
                throw new Error('尚未配置 ComfyUI 根目录（设置 → 通用 → ComfyUI 根目录），无法确定模型落盘位置');
            }
            if (relativePath && (relativePath.includes('..') || path.isAbsolute(relativePath))) {
                throw new Error('relative_path 必须是根目录下的相对路径（如 models/checkpoints）');
            }
            const targetDir = path.join(root, relativePath || 'models/checkpoints');
            const safeName = String(filename || path.basename(new URL(url).pathname)).replace(/[\\/:*?"<>|]/g, '_');
            const target = path.join(targetDir, safeName);

            await fsp.mkdir(targetDir, { recursive: true });

            const id = `dl_${++downloadSeq}_${Date.now()}`;
            const controller = new AbortController();
            const entry = {
                id, url, target, received: 0, total: 0,
                status: 'downloading', error: null, controller, startedAt: Date.now()
            };
            downloads.set(id, entry);

            // 异步流式下载（响应先行返回任务 id，wait=true 时等完成）
            const run = (async () => {
                try {
                    const r = await fetch(url, { signal: controller.signal });
                    if (!r.ok) throw new Error(`下载响应 HTTP ${r.status}`);
                    const total = Number(r.headers.get('content-length') || 0);
                    entry.total = total;
                    const body = r.body;
                    if (!body) throw new Error('下载响应无内容流');
                    const reader = body.getReader();
                    const chunks = [];
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        chunks.push(Buffer.from(value));
                        entry.received += value.length;
                    }
                    await fsp.writeFile(target, Buffer.concat(chunks));
                    entry.status = 'done';
                } catch (e) {
                    entry.status = controller.signal.aborted ? 'cancelled' : 'error';
                    entry.error = e.message;
                    // 失败时清掉半成品文件
                    fsp.unlink(target).catch(() => {});
                }
            })();

            if (!wait) {
                res.json({ status: 'ok', data: { downloadId: id, target, message: '下载已开始，可用 download 工具查询进度' } });
                return;
            }
            const timeout = setTimeout(() => controller.abort(), Math.max(60, timeoutSeconds) * 1000);
            try {
                await run;
            } finally {
                clearTimeout(timeout);
            }
            if (entry.status !== 'done') {
                throw new Error(`下载未完成（${entry.status}）：${entry.error || '超时中止'}`);
            }
            res.json({ status: 'ok', data: { downloadId: id, target, status: 'done', received: entry.received, total: entry.total } });
        } catch (error) {
            fail(res, error);
        }
    });

    // POST /api/comfy-tools/download  { action: 'status'|'cancel', download_id }
    router.post('/download', async (req, res) => {
        try {
            const { action = 'status', download_id: downloadId } = req.body || {};
            const entry = downloads.get(downloadId);
            if (!entry) throw new Error(`下载任务 "${downloadId}" 不存在（重启后端后任务注册表清空）`);

            if (action === 'cancel') {
                if (entry.status === 'downloading') entry.controller.abort();
                return res.json({ status: 'ok', data: { downloadId, status: entry.status } });
            }
            const progress = entry.total > 0
                ? `${(entry.received / entry.total * 100).toFixed(1)}%`
                : `${entry.received} bytes`;
            res.json({
                status: 'ok',
                data: {
                    downloadId, status: entry.status, progress,
                    received: entry.received, total: entry.total, target: entry.target,
                    error: entry.error
                }
            });
        } catch (error) {
            fail(res, error);
        }
    });

    // ==================== 文件上传 / 节点包 / 日志 ====================

    // POST /api/comfy-tools/upload-file  { paths: [...] }
    router.post('/upload-file', async (req, res) => {
        try {
            const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
            if (paths.length === 0) throw new Error('缺少 paths（本机文件路径数组）');
            const uploaded = [];
            for (const p of paths.slice(0, 10)) {
                const full = path.isAbsolute(p) ? p : path.join(getComfyRoot() || process.cwd(), p);
                const buf = await fsp.readFile(full);
                const form = new FormData();
                form.append('image', new Blob([buf]), path.basename(full));
                form.append('overwrite', 'true');
                const r = await fetchWithTimeout(`${comfyApiUrl}/upload/image`, {
                    method: 'POST',
                    body: form
                }, 60000);
                const j = await r.json().catch(() => ({}));
                if (!r.ok || j.error) {
                    throw new Error(`上传 ${path.basename(full)} 失败：${j.error || `HTTP ${r.status}`}`);
                }
                uploaded.push({ name: j.name, subfolder: j.subfolder || '', type: j.type || 'input' });
            }
            res.json({ status: 'ok', data: { uploaded } });
        } catch (error) {
            fail(res, error);
        }
    });

    // Manager API 辅助：新旧路由都试
    async function managerFetch(apiPath, options = {}) {
        for (const base of [`${comfyApiUrl}/api`, comfyApiUrl]) {
            const r = await fetchWithTimeout(base + apiPath, options, 30000);
            if (r.status === 404) continue;
            return r;
        }
        throw new Error(`ComfyUI Manager 接口不可用（${apiPath}）——未安装 Manager 或版本过旧`);
    }

    // POST /api/comfy-tools/install-node  { names: [...] }
    router.post('/install-node', async (req, res) => {
        try {
            const names = Array.isArray(req.body?.names) ? req.body.names.filter(Boolean) : [];
            if (names.length === 0) throw new Error('缺少 names（节点包名数组，如 ["ComfyUI-GGUF"]）');
            const results = [];
            for (const name of names) {
                const r = await managerFetch('/customnode/install', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ node_pack: name })
                });
                const text = await r.text();
                results.push({
                    name,
                    ok: r.ok,
                    httpStatus: r.status,
                    response: text.slice(0, 300)
                });
            }
            res.json({
                status: 'ok',
                data: {
                    results,
                    message: '安装经由 ComfyUI Manager 执行；部分节点包安装后需重启 ComfyUI 生效'
                }
            });
        } catch (error) {
            fail(res, error);
        }
    });

    // POST /api/comfy-tools/workflow-deps  { path }
    router.post('/workflow-deps', async (req, res) => {
        try {
            const { path: wfPath } = req.body || {};
            const { workflow } = await readWorkflowFile(wfPath);
            const classes = collectClassTypes(workflow);
            const objectInfo = await getObjectInfo();
            const missing = classes.filter((c) => !objectInfo[c]);

            let packMap = null;
            try {
                const r = await managerFetch('/customnode/getmappings?mode=local');
                const mappings = await r.json();
                // Manager 返回 { 包名: [[类名, 显示名...], ...] }，形态有版本差异，防御性解析
                packMap = {};
                for (const [pack, entries] of Object.entries(mappings || {})) {
                    const set = new Set();
                    for (const e of (Array.isArray(entries) ? entries : [])) {
                        if (typeof e === 'string') set.add(e);
                        else if (Array.isArray(e) && typeof e[0] === 'string') set.add(e[0]);
                    }
                    packMap[pack] = set;
                }
            } catch { /* Manager 不可用：只报缺失类清单 */ }

            const providers = {};
            for (const cls of missing) {
                providers[cls] = packMap
                    ? Object.keys(packMap).filter((p) => packMap[p].has(cls))
                    : null;
            }
            res.json({
                status: 'ok',
                data: {
                    classes, missing,
                    providers,
                    message: missing.length === 0
                        ? '全部节点类本地可用'
                        : (packMap ? '缺失类 → 可提供它的节点包（用 install_node 安装）' : 'Manager 不可用，仅列出缺失类')
                }
            });
        } catch (error) {
            fail(res, error);
        }
    });

    // GET /api/comfy-tools/get-logs?tail=100
    router.get('/get-logs', async (req, res) => {
        try {
            const tail = Math.max(1, Math.min(Number(req.query.tail) || 100, 1000));
            const r = await fetchWithTimeout(`${comfyApiUrl}/internal/logs`);
            if (r.status === 404) {
                throw new Error('ComfyUI 未提供 /internal/logs 接口（版本过旧）——请直接查看 ComfyUI 控制台窗口');
            }
            if (!r.ok) throw new Error(`ComfyUI /internal/logs 响应 ${r.status}`);
            const j = await r.json();
            const entries = (j.entries || []).slice(-tail).map((e) => e?.m ?? String(e));
            res.json({ status: 'ok', data: { count: entries.length, entries } });
        } catch (error) {
            fail(res, error);
        }
    });

    return router;
}

module.exports = createComfyToolsRouter;
