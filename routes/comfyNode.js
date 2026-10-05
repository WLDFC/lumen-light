/**
 * ==========================================================================
 * Comfy 生图节点路由
 * 作用：为画布上的 Comfy 生图节点（ComfyGenNode）提供后端支持：
 *   1. GET  /models —— 代理 ComfyUI /object_info 接口，按加载节点类型归并
 *      本地模型文件清单（由 ComfyUI 自己枚举，自动覆盖 extra_model_paths
 *      与 GGUF 等自定义节点模型目录，无需配置 ComfyUI 安装路径）
 *   2. POST /run —— 按 workflowId 读取工作流模板 → 把连线的画布图片写入
 *      槽位（供 LumenReceiveImageFromCanvas 拉取）→ 注入参数/提示词/种子 →
 *      提交 ComfyUI；生成结果经 LumenSendImageRealtime 带着透传的 target
 *      回流（见 routes/comfy.js /receive-image），由前端路由到节点占位图
 * ==========================================================================
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const {
    injectPromptsToWorkflow,
    prepareWorkflowForRun,
    applyWorkflowOverrides,
    injectLoraChain
} = require('../utils/workflowInjector');
const { applyBypass } = require('../utils/workflowBypass');
const { submitPromptToComfy } = require('../utils/comfySubmit');

/**
 * 需要读取模型清单的加载节点类型 → 模型类别与输入字段名。
 * 与前端 ComfyGenNode.LOADER_TYPES 保持一致：前端按 class_type 识别
 * 工作流里的加载节点，后端按同一张表决定查询哪些 object_info。
 */
const LOADER_CLASSES = {
    CheckpointLoaderSimple: { category: 'checkpoints', field: 'ckpt_name' },
    CheckpointLoaderAdvanced: { category: 'checkpoints', field: 'ckpt_name' },
    UNETLoader: { category: 'unets', field: 'unet_name' },
    UnetLoaderGGUF: { category: 'unets', field: 'unet_name' },
    UnetLoaderGGUFAdvanced: { category: 'unets', field: 'unet_name' },
    LoraLoader: { category: 'loras', field: 'lora_name' },
    LoraLoaderModelOnly: { category: 'loras', field: 'lora_name' }
};

/**
 * 需要读取采样器枚举的节点类型（含其 sampler_name combo 字段）。
 * 采样器下拉选项由 ComfyUI 自己枚举：内置列表 + 自定义节点新增的
 * 采样器（如 er_sde）都自动覆盖。未安装的类型静默跳过。
 */
const SAMPLER_CLASSES = ['KSampler', 'KSamplerAdvanced', 'KSamplerSelect'];

// 槽位数量上限（与 routes/canvasImages.js、LumenReceiveImageFromCanvas 一致）
const MAX_SLOTS = 3;

/**
 * 创建 Comfy 生图节点路由
 * @param {Object} options - 依赖项
 * @param {string} options.workflowsDir - 工作流模板目录
 * @param {Object} options.canvasImages - 画板图片槽位数据（1-3 号槽，与 comfy 路由共享）
 * @param {Object} options.canvasImagesTimestamp - 槽位时间戳
 * @param {Object} options.latestPrompts - 最新提示词存储（更新后随生成结果回传画布）
 * @param {string} options.comfyApiUrl - ComfyUI API 地址
 * @returns {express.Router} Express 路由实例
 */
function createComfyNodeRouter(options) {
    const {
        workflowsDir,
        canvasImages,
        canvasImagesTimestamp,
        canvasMasks,
        canvasMasksTimestamp,
        latestPrompts,
        comfyApiUrl,
        layoutsFile
    } = options;

    // 布局 sidecar（bypass 状态存这里；与 routes/workflows.js 同一推导规则）
    const layoutFile = layoutsFile
        || path.join(path.dirname(workflowsDir), 'data', 'workflow-layouts.json');

    const router = express.Router();

    /**
     * 带超时的 fetch 请求
     * @param {string} url - 请求地址
     * @param {Object} [options] - fetch 请求参数（method/body/headers 等）
     * @param {number} [timeoutMs] - 超时毫秒数
     * @returns {Promise<Response>}
     */
    async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * 从 object_info 单节点响应中提取 combo 输入的可选值列表
     * 响应结构：{ ClassName: { input: { required: { field: [值数组, 属性对象] } } } }
     * @param {Object} data - object_info/{class} 的 JSON 响应
     * @param {string} className - 节点类型名
     * @param {string} field - 输入字段名（如 ckpt_name）
     * @returns {string[]} 模型文件名列表（结构不符时为空数组）
     */
    function extractComboValues(data, className, field) {
        const def = data && data[className];
        const required = def && def.input && def.input.required;
        const entry = required && required[field];
        if (!Array.isArray(entry) || !Array.isArray(entry[0])) return [];
        return entry[0].filter((v) => typeof v === 'string');
    }

    /**
     * GET /api/comfy-node/models
     * 并行查询各加载节点类型与采样器节点类型的 object_info，
     * 归并出三类模型文件清单 + 采样器枚举清单。
     * 某个类未安装（如未装 GGUF 节点）时该类返回空数组，不影响其他类。
     */
    router.get('/models', async (req, res) => {
        // 按类别去重后展开为待查询的 class 列表
        const classNames = Object.keys(LOADER_CLASSES);

        try {
            const results = await Promise.allSettled(
                [...classNames, ...SAMPLER_CLASSES].map(async (cls) => {
                    const response = await fetchWithTimeout(
                        `${comfyApiUrl}/object_info/${encodeURIComponent(cls)}`
                    );                    if (!response.ok) return null;   // 未安装的自定义节点，静默跳过
                    return { cls, data: await response.json() };
                })
            );

            const lists = { checkpoints: new Set(), unets: new Set(), loras: new Set() };
            const samplers = new Set();
            for (const result of results) {
                if (result.status !== 'fulfilled' || !result.value) continue;
                const { cls, data } = result.value;
                if (SAMPLER_CLASSES.includes(cls)) {
                    // 采样器枚举：多个采样器节点类型（KSampler/KSamplerSelect 等）
                    // 的同名 combo 字段取并集
                    for (const name of extractComboValues(data, cls, 'sampler_name')) {
                        samplers.add(name);
                    }
                    continue;
                }
                const { category, field } = LOADER_CLASSES[cls];
                for (const name of extractComboValues(data, cls, field)) {
                    lists[category].add(name);
                }
            }

            // 有任意一个请求成功收到响应即认为 ComfyUI 在线；
            // 全部失败（含超时）视为未连接，前端据此显示提示并保留存档选择
            const anyFulfilled = results.some((r) => r.status === 'fulfilled' && r.value);
            if (!anyFulfilled) {
                return res.json({
                    status: 'ok',
                    connected: false,
                    message: 'ComfyUI 未连接，无法读取模型清单',
                    checkpoints: [], unets: [], loras: [], samplers: []
                });
            }

            const toSortedList = (set) => Array.from(set).sort((a, b) => a.localeCompare(b));
            res.json({
                status: 'ok',
                connected: true,
                checkpoints: toSortedList(lists.checkpoints),
                unets: toSortedList(lists.unets),
                loras: toSortedList(lists.loras),
                samplers: toSortedList(samplers)
            });
        } catch (error) {
            console.error('❌ 读取 ComfyUI 模型清单失败:', error.message);
            res.json({
                status: 'ok',
                connected: false,
                message: error.message,
                checkpoints: [], unets: [], loras: [], samplers: []
            });
        }
    });

    /**
     * GET /api/comfy-node/object-info?classes=A,B,C
     * 通用 object_info 代理：按传入的 class 列表原样转发各
     * /object_info/{class} 响应（含每个输入的完整类型/枚举/取值范围），
     * 供工作流编辑器渲染全部参数控件。某类未安装时该类键省略，不影响其他类；
     * 全部失败（含 ComfyUI 离线）返回 connected:false，前端按值类型推断降级。
     */
    router.get('/object-info', async (req, res) => {
        const classNames = String(req.query.classes || '')
            .split(',').map((s) => s.trim()).filter(Boolean).slice(0, 60);
        if (classNames.length === 0) {
            return res.json({ status: 'ok', connected: false, info: {} });
        }
        const results = await Promise.allSettled(
            classNames.map(async (cls) => {
                const response = await fetchWithTimeout(
                    `${comfyApiUrl}/object_info/${encodeURIComponent(cls)}`
                );
                if (!response.ok) return null;   // 未安装的自定义节点，静默跳过
                return { cls, data: await response.json() };
            })
        );
        const info = {};
        for (const result of results) {
            if (result.status !== 'fulfilled' || !result.value) continue;
            // 解包到类条目本身（/object_info/{class} 响应是 { [类名]: {...} }，
            // 前端按 objInfo[类名].input 直接消费，这里不保留外层键）
            const { cls, data } = result.value;
            info[cls] = data[cls] || data;
        }
        res.json({ status: 'ok', connected: Object.keys(info).length > 0, info });
    });

    /**
     * 读取工作流的 bypass 状态（布局 sidecar 的 bypassed 数组）。
     * 文件缺失/损坏/字段缺失都按空处理，绝不阻塞提交
     * @param {string} workflowId - 工作流 id
     * @returns {string[]} 被忽略的节点 id 列表
     */
    async function readBypassedIds(workflowId) {
        try {
            const raw = await fs.readFile(layoutFile, 'utf-8');
            const layouts = JSON.parse(raw);
            const entry = layouts && layouts[workflowId];
            const ids = entry && Array.isArray(entry.bypassed) ? entry.bypassed : [];
            return ids.map(String).filter((id) => id);
        } catch {
            return [];
        }
    }

    /**
     * 批量获取节点类型的 object_info 定义（bypass 直通重连的类型依据）。
     * ComfyUI 离线/类缺失时对应键省略——applyBypass 内按同名启发式降级
     * @param {string[]} classNames - 节点类型列表
     * @returns {Promise<Object>} { [class_type]: def }
     */
    async function fetchClassInfo(classNames) {
        const info = {};
        if (!classNames.length) return info;
        const results = await Promise.allSettled(
            classNames.map(async (cls) => {
                const response = await fetchWithTimeout(
                    `${comfyApiUrl}/object_info/${encodeURIComponent(cls)}`
                );
                if (!response.ok) return null;
                return { cls, data: await response.json() };
            })
        );
        for (const result of results) {
            if (result.status !== 'fulfilled' || !result.value) continue;
            const { cls, data } = result.value;
            info[cls] = data[cls] || data;
        }
        return info;
    }

    /**
     * 读取工作流模板（与 routes/workflows.js 的格式兼容逻辑一致）：
     * 支持包装格式 { workflow: {...} } 与纯 ComfyUI 格式两种
     * @param {string} workflowId - 工作流 id（即 workflows/ 下的文件名，不含 .json）
     * @returns {Promise<Object>} 纯 ComfyUI 格式的工作流对象
     */
    async function loadWorkflowTemplate(workflowId) {
        // 工作流 id 直接拼接文件路径，拒绝任何路径穿越字符
        if (/[\\/]|\.\./.test(workflowId)) {
            throw new Error('非法的工作流 id');
        }
        const filePath = path.join(workflowsDir, `${workflowId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const data = JSON.parse(content);
        const isWrappedFormat = data.workflow && typeof data.workflow === 'object';
        return isWrappedFormat ? data.workflow : data;
    }

    /**
     * 把前端收集的画布图片写入槽位（供工作流内 LumenReceiveImageFromCanvas 拉取）
     * 图片为 data URL（ImagePipeline.collectImages 的输出），剥离前缀后存裸 base64，
     * 与提示词面板的上传格式保持一致（Python 端直接 base64.b64decode）。
     * 图片数量少于槽位数时清空剩余槽位，避免上次运行残留的旧图被误用。
     * masks 与 images 按位对齐（黑白遮罩 PNG data URL 或 null）：有值写入
     * 遮罩槽位（局部重绘），null 清空对应遮罩槽，防上次运行的遮罩残留
     * @param {string[]} images - data URL 数组
     * @param {string[]} [masks] - 遮罩 data URL 数组（可缺省）
     * @returns {number} 实际写入的槽位数量
     */
    function uploadImagesToSlots(images, masks) {
        const count = Math.min(MAX_SLOTS, Array.isArray(images) ? images.length : 0);
        for (let slot = 1; slot <= MAX_SLOTS; slot++) {
            if (slot <= count) {
                const dataUrl = images[slot - 1];
                const base64 = dataUrl.startsWith('data:')
                    ? dataUrl.slice(dataUrl.indexOf(',') + 1)
                    : dataUrl;
                canvasImages[slot] = base64;
                canvasImagesTimestamp[slot] = Date.now();
                console.log(`  🖼️ 槽位 ${slot} 已写入图片，长度: ${base64.length}`);
            } else {
                canvasImages[slot] = null;
                canvasImagesTimestamp[slot] = 0;
            }
            // 遮罩槽与图片槽同步写/清（仅前端传了 masks 数组时才动，
            // 旧客户端/面板旧版本不传则保留现状）
            if (canvasMasks && Array.isArray(masks)) {
                const maskUrl = slot <= masks.length ? masks[slot - 1] : null;
                if (maskUrl) {
                    canvasMasks[slot] = maskUrl.startsWith('data:')
                        ? maskUrl.slice(maskUrl.indexOf(',') + 1)
                        : maskUrl;
                    canvasMasksTimestamp[slot] = Date.now();
                    console.log(`  🎭 槽位 ${slot} 已写入遮罩，长度: ${canvasMasks[slot].length}`);
                } else {
                    canvasMasks[slot] = null;
                    canvasMasksTimestamp[slot] = 0;
                }
            }
        }
        return count;
    }

    /**
     * POST /api/comfy-node/run
     * 请求体：{
     *   workflowId - 工作流 id
     *   positive   - 正面提示词（画布提示词链收集结果）
     *   negative   - 负面提示词（右侧 Comfy 面板负面框内容，可为空）
     *   overrides  - 参数覆盖表 { [节点id]: { [输入键]: 新值 } }（前端探测生成）
     *   target     - 发起生成的画布节点 id（透传回前端做占位图路由，可为空）
     *   images     - 连线的画布图片 data URL 数组（Edit 工作流槽位图，可为空）
     * }
     */
    router.post('/run', async (req, res) => {
        const { workflowId, positive, negative, overrides, target, images, masks, loras } = req.body;

        if (!workflowId) {
            return res.status(400).json({ status: 'error', message: '请先选择工作流' });
        }
        if (!positive || !positive.trim()) {
            return res.status(400).json({ status: 'error', message: '缺少提示词（请先连接提示词节点）' });
        }

        try {
            // 读取模板并深拷贝，避免污染磁盘上的原始文件
            const template = await loadWorkflowTemplate(workflowId);
            let workflowToRun = JSON.parse(JSON.stringify(template));

            // 应用编辑器 bypass（忽略节点）：从布局 sidecar 读状态，
            // 按 ComfyUI 同款规则直通重连后剔除（此后的注入只看存留节点）。
            // 类型取 object_info；ComfyUI 离线时 applyBypass 按同名启发式降级
            const bypassedIds = await readBypassedIds(workflowId);
            if (bypassedIds.length) {
                const bypassClasses = [...new Set(
                    bypassedIds.map((id) => workflowToRun[id] && workflowToRun[id].class_type).filter(Boolean)
                )];
                const classInfo = await fetchClassInfo(bypassClasses);
                const before = Object.keys(workflowToRun).length;
                workflowToRun = applyBypass(workflowToRun, bypassedIds, classInfo);
                console.log(`  ⏭️ 已忽略节点: ${bypassedIds.join(', ')}（${before} → ${Object.keys(workflowToRun).length} 个）`);
            }

            // 工作流内含画板取图节点时才写槽位，纯文生图工作流不必动槽位。
            // 仅在请求体携带 images 数组时写入：右侧面板流程自行经
            // /api/canvas-images 上传槽位缩略图（不传 images），
            // 避免提交时把刚上传的槽位图清空
            const hasReceiveNode = Object.values(workflowToRun).some(
                (node) => (node.class_type || node.type) === 'LumenReceiveImageFromCanvas'
            );
            if (hasReceiveNode && Array.isArray(images)) {
                console.log('📤 工作流含画板取图节点，写入槽位图片...');
                uploadImagesToSlots(images, masks);
            }

            // 提交前预处理（移除占位节点、注入取图随机种子），
            // 与提示词面板的 /api/run-comfy 共用同一份实现
            prepareWorkflowForRun(workflowToRun);

            // 注入画布 LoRA 堆栈（图拼接；模板内嵌 LoRA 一律旁路忽略，
            // LoRA 唯一来源是画布 LoRA 节点）
            injectLoraChain(workflowToRun, loras);

            // 注入 Comfy 生图节点的动态参数（模型/步数/CFG/采样器/尺寸/降噪/批次）
            applyWorkflowOverrides(workflowToRun, overrides);

            // 注入提示词（正面 = 画布提示词链合并文本，负面 = Comfy 面板负面框）。
            // 同步更新 latestPrompts，生成结果回传时画布图片的提示词元数据才准确
            latestPrompts.positive = positive;
            latestPrompts.negative = negative || '';
            latestPrompts.timestamp = Date.now();
            injectPromptsToWorkflow(workflowToRun, positive, negative || '');

            // 把画布节点 id 注入全部回传节点（LumenSendImageRealtime）：
            // Python 节点把生成图 POST 回 /api/receive-image 时原样带上，
            // 后端经 WebSocket 转发，前端据此把图片精确落到本节点的占位图上。
            // 注意：需要 ComfyUI 侧使用最新 lumen_nodes（含可选 lumen_target 输入）
            if (target) {
                for (const nodeId in workflowToRun) {
                    const sendNode = workflowToRun[nodeId];
                    if ((sendNode.class_type || sendNode.type) === 'LumenSendImageRealtime') {
                        sendNode.inputs = sendNode.inputs || {};
                        sendNode.inputs.lumen_target = String(target);
                        console.log(`  🎯 节点 ${nodeId} 注入 lumen_target: ${target}`);
                    }
                }
            }

            console.log(`📤 [Comfy节点${target ? ` ${target}` : ''}] 提交工作流 ${workflowId} 到 ComfyUI...`);

            // 提交与响应校验统一走共享工具（与提示词面板的 /api/run-comfy 同一份实现）
            const { promptId } = await submitPromptToComfy(comfyApiUrl, workflowToRun, 'lumen_node');

            console.log(`✅ 工作流已启动: ${promptId}`);
            res.json({
                status: 'ok',
                promptId: promptId,
                message: '工作流已启动'
            });
        } catch (error) {
            console.error('❌ Comfy 节点运行失败:', error.message);
            res.status(500).json({
                status: 'error',
                message: error.message || '运行失败'
            });
        }
    });

    return router;
}

module.exports = createComfyNodeRouter;
