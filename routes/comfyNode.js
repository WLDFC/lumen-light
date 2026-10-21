/**
 * ==========================================================================
 * Comfy 生图节点路由
 * 作用：为画布上的 Comfy 生图节点（ComfyGenNode）提供后端支持：
 *   1. GET  /models —— 代理 ComfyUI /object_info 接口，按加载节点类型归并
 *      本地模型文件清单（由 ComfyUI 自己枚举，自动覆盖 extra_model_paths
 *      与 GGUF 等自定义节点模型目录，无需配置 ComfyUI 安装路径）
 *   2. POST /run —— 按 workflowId 读取工作流模板 → 双通道仲裁（见下）→
 *      注入参数/提示词/种子 → 提交 ComfyUI；生成结果经 LumenSendImageRealtime
 *      带着透传的 target 回流（见 routes/comfy.js /receive-image），由前端
 *      路由到节点占位图
 *   3. POST /stop —— 按本轮 promptId 中断正在执行的任务（/interrupt）并
 *      把还在队列里的按 id 移除（/queue delete），停止 X 的后端支撑
 *
 * 双通道仲裁（utils/comfyNodelessFlow，提交前一次扫描定两方向）：
 *   - 输入：工作流有 LumenReceiveImageFromCanvas → 现有槽位链路（不变）；
 *     没有 → 把第 1 张画布图经原生 /upload/image 上传后改写 LoadImage
 *     节点（恰好 1 个才自动；0 个/多个不猜，imageInject 字段如实上报）；
 *   - 输出：有 LumenSendImageRealtime → 现有节点实时回流（不变）；没有
 *     且非视频工作流 → 轮询原生 /history/{promptId} 取产物经 /view 下载
 *     后按同一 new-image 消息推画布（无实时预览，完成后落图）。
 * ==========================================================================
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const {
    injectPromptsToWorkflow,
    prepareWorkflowForRun,
    applyWorkflowOverrides,
    injectLoraChain
} = require('../utils/workflowInjector');
const { applyBypass } = require('../utils/workflowBypass');
const { submitPromptToComfy } = require('../utils/comfySubmit');
const {
    scanCanvasFlow,
    decideImageInject,
    dataUrlToUploadPayload,
    collectOutputFiles,
    pollHistoryOutputs,
    downloadOutput,
    LOADIMAGE_CLASS
} = require('../utils/comfyNodelessFlow');

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

// 槽位数量上限（与 routes/canvasImages.js、LumenReceiveImageFromCanvas /
// LumenReceiveVideoFromCanvas 分别对齐：图片槽扩容到 9 支持多图编辑模型，
// 视频槽跟随其 Python 节点维持 3）
const MAX_IMAGE_SLOTS = 9;
const MAX_VIDEO_SLOTS = 3;

// 免节点空槽兜底用的中性占位图（64×64 中性灰 PNG，data URL）。
// 懒生成 + 模块级缓存——一次生成整个进程生命周期复用
let placeholderDataUrlPromise = null;
function getPlaceholderDataUrl() {
    if (!placeholderDataUrlPromise) {
        placeholderDataUrlPromise = sharp({
            create: { width: 64, height: 64, channels: 3, background: { r: 128, g: 128, b: 128 } }
        }).png().toBuffer().then((buf) => `data:image/png;base64,${buf.toString('base64')}`);
        placeholderDataUrlPromise.catch(() => { placeholderDataUrlPromise = null; });
    }
    return placeholderDataUrlPromise;
}

/**
 * 创建 Comfy 生图节点路由
 * @param {Object} options - 依赖项
 * @param {string} options.workflowsDir - 工作流模板目录
 * @param {Object} options.canvasImages - 画板图片槽位数据（1-9 号槽，与 comfy 路由共享）
 * @param {Object} options.canvasImagesTimestamp - 槽位时间戳
 * @param {Object} options.latestPrompts - 最新提示词存储（更新后随生成结果回传画布）
 * @param {Object} options.clients - WebSocket 客户端映射（免节点 history 回流推送用）
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
        canvasVideos,
        canvasVideosTimestamp,
        videosDir,
        latestPrompts,
        clients,
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
     * 把一张画布图（data URL）上传到 ComfyUI 原生 /upload/image，
     * 供免节点注入改写 LoadImage 的 image 输入（multipart 模式与
     * comfyTools 的 upload-file 相同）
     * @param {string} dataUrl - data:image/xxx;base64,yyy
     * @param {number} slot - 来源槽位序号（仅用于生成唯一文件名）
     * @returns {Promise<string>} ComfyUI 侧文件名（LoadImage inputs.image 的值）
     */
    async function uploadCanvasImageToComfy(dataUrl, slot) {
        const { buffer, ext } = dataUrlToUploadPayload(dataUrl);
        const filename = `lumen_canvas_${Date.now()}_s${slot}${ext}`;
        const form = new FormData();
        form.append('image', new Blob([buffer]), filename);
        const res = await fetchWithTimeout(`${comfyApiUrl}/upload/image`, {
            method: 'POST',
            body: form
        }, 60000);
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.error) {
            throw new Error(`画布图上传 ComfyUI 失败：${json.error || `HTTP ${res.status}`}`);
        }
        return json.name;
    }

    /**
     * 免节点回流（后台任务，不挂住 /run 响应）：轮询 /history/{promptId}
     * 直到执行完成，把全部输出文件经 /view 下载后按 /receive-image 同款
     * new-image 消息推画布——推送格式与 LumenSendImageRealtime 链路一致
     * （裸 base64 无 data: 前缀，前端 receiveGeneratedImage 直接消费）。
     * 图片大时逐张推送；目标节点已删除时 target 原样带上，前端按无 target
     * 兜底落图，图片不丢
     * @param {string} promptId - 提交返回的任务 id
     * @param {string|null} target - 发起生成的画布节点 id
     * @param {Object} [pollOpts] - 透传 pollHistoryOutputs（测试钩子用）
     */
    async function pushHistoryOutputsToCanvas(promptId, target, pollOpts = {}) {
        try {
            const result = await pollHistoryOutputs(comfyApiUrl, promptId, pollOpts);
            if (result.status === 'timeout') {
                console.log(`⌛ [免节点回流] ${promptId} 轮询超时，放弃（任务可能仍在执行，不影响 ComfyUI 侧产物）`);
                return;
            }
            if (result.status === 'error') {
                console.log(`⚠️ [免节点回流] ${promptId} 执行失败/被中断，无产物回流`);
                return;
            }
            const files = collectOutputFiles(result.entry);
            if (!files.length) {
                console.log(`ℹ️ [免节点回流] ${promptId} 完成但无图片型输出（可能输出节点被忽略或为视频产物）`);
                return;
            }
            const promptMeta = {
                positive: latestPrompts.positive,
                negative: latestPrompts.negative
            };
            let sentCount = 0;
            for (const file of files) {
                const buf = await downloadOutput(comfyApiUrl, file);
                const base64 = buf.toString('base64');
                for (const client of clients.values()) {
                    if (client.role === 'canvas' && client.ws.readyState === 1) {
                        try {
                            client.ws.send(JSON.stringify({
                                type: 'new-image',
                                image: base64,
                                target: target || undefined,
                                prompt: promptMeta,
                                timestamp: Date.now()
                            }));
                            sentCount++;
                        } catch { /* 单个客户端失败不阻塞其余推送 */ }
                    }
                }
            }
            console.log(`✅ [免节点回流] ${promptId} 已推送 ${files.length} 张产物给 ${sentCount} 个客户端连接`);
        } catch (err) {
            console.error(`❌ [免节点回流] ${promptId} 失败:`, err.message);
        }
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
        const count = Math.min(MAX_IMAGE_SLOTS, Array.isArray(images) ? images.length : 0);
        for (let slot = 1; slot <= MAX_IMAGE_SLOTS; slot++) {
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
     * 把前端收集的画布视频引用写入视频槽位（供 LumenReceiveVideoFromCanvas 拉取）。
     * 引用式：videos 是 videoUrl 字符串数组（data/videos/xxx.mp4），与
     * routes/canvasVideo.js 的写入语义一致——basename 归一化防路径穿越 +
     * 扩展名白名单 + 文件存在性校验（校验失败的引用清槽，避免工作流
     * 跑到一半才 404）。数量少于槽位数时清空剩余槽位，防上次运行残留
     * 的旧视频被误用
     * @param {string[]} videos - videoUrl 数组（可缺省——缺省时不动槽位，
     *        兼容不传 videos 的旧客户端/面板流程）
     * @returns {Promise<number>} 实际写入的槽位数量
     */
    async function uploadVideosToSlots(videos) {
        if (!canvasVideos || !Array.isArray(videos)) return 0;
        const ALLOWED_EXTS = new Set(['.mp4', '.webm', '.mov', '.gif', '.mkv', '.avi']);
        const count = Math.min(MAX_VIDEO_SLOTS, videos.length);
        for (let slot = 1; slot <= MAX_VIDEO_SLOTS; slot++) {
            if (slot <= count) {
                // 剥掉可选的 / 与 data/videos/ 前缀后取 basename（防穿越）
                const raw = String(videos[slot - 1] || '');
                const filename = path.basename(raw.replace(/^\/?(?:data\/videos\/)?/, ''));
                const ext = path.extname(filename).toLowerCase();
                let exists = false;
                if (filename && filename !== '.' && filename !== '..' && ALLOWED_EXTS.has(ext) && videosDir) {
                    try {
                        exists = (await fs.stat(path.join(videosDir, filename))).isFile();
                    } catch {
                        exists = false;
                    }
                }
                if (exists) {
                    canvasVideos[slot] = {
                        videoUrl: `data/videos/${filename}`,
                        filename
                    };
                    canvasVideosTimestamp[slot] = Date.now();
                    console.log(`  🎬 视频槽位 ${slot} 已写入引用: ${filename}`);
                } else {
                    canvasVideos[slot] = null;
                    canvasVideosTimestamp[slot] = 0;
                    console.log(`  ⚠️ 视频槽位 ${slot} 引用非法或文件不存在，已清空: ${raw}`);
                }
            } else {
                canvasVideos[slot] = null;
                canvasVideosTimestamp[slot] = 0;
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
     *   videos     - 连线的画布视频 videoUrl 引用数组（V2V 工作流视频槽，可为空）
     * }
     */
    router.post('/run', async (req, res) => {
        const { workflowId, positive, negative, overrides, target, images, masks, videos, loras, bypassLoras, imageMapping } = req.body;

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
            // 类型取 object_info；ComfyUI 离线时 applyBypass 按同名启发式降级。
            // 另合并请求携带的 bypassLoras——右侧面板删除的模板内嵌 lora 节点
            // （前端记录、按工作流持久化），只放行 lora 加载类节点防滥用
            const sidecarBypassed = await readBypassedIds(workflowId);
            const extraBypassed = Array.isArray(bypassLoras)
                ? bypassLoras.map(String).filter((id) => {
                    const cls = workflowToRun[id] && workflowToRun[id].class_type;
                    return cls === 'LoraLoader' || cls === 'LoraLoaderModelOnly';
                })
                : [];
            const bypassedIds = [...new Set([...sidecarBypassed, ...extraBypassed])];
            if (bypassedIds.length) {
                const bypassClasses = [...new Set(
                    bypassedIds.map((id) => workflowToRun[id] && workflowToRun[id].class_type).filter(Boolean)
                )];
                const classInfo = await fetchClassInfo(bypassClasses);
                const before = Object.keys(workflowToRun).length;
                workflowToRun = applyBypass(workflowToRun, bypassedIds, classInfo);
                console.log(`  ⏭️ 已忽略节点: ${bypassedIds.join(', ')}（${before} → ${Object.keys(workflowToRun).length} 个）`);
            }

            // ===== 双通道仲裁（一次扫描定两方向，utils/comfyNodelessFlow）=====
            const canvasFlow = scanCanvasFlow(workflowToRun);
            let imageInject = null;   // 免节点输入注入结果（随响应上报前端）

            // 输入·节点链路：工作流含画板取图节点 → 写槽位（现状不变）。
            // 仅在请求体携带 images 数组时写入：右侧面板流程自行经
            // /api/canvas-images 上传槽位缩略图（不传 images），
            // 避免提交时把刚上传的槽位图清空
            if (canvasFlow.hasReceiveNode && Array.isArray(images)) {
                console.log('📤 工作流含画板取图节点，写入槽位图片...');
                uploadImagesToSlots(images, masks);
            }

            // 输入·免节点链路：无取图节点但带了画布图。两级：
            // 1) 显式映射 imageMapping { LoadImage节点id: images下标 }——前端
            //    按「槽位/连线图从左往右、节点 id 升序」组表（空槽无条目，
            //    对应 LoadImage 完全不碰）；失效条目（节点被 bypass/不存在/
            //    下标越界/上传失败）跳过并如实上报——宁可不注入也不静默错图
            // 2) 无映射回落自动仲裁（旧客户端兼容；单 LoadImage 全自动），
            //    恰好 1 个才注入（多/无不猜）
            const imageCount = Array.isArray(images) ? images.length : 0;
            if (!canvasFlow.hasReceiveNode && imageCount > 0) {
                const mappingEntries = imageMapping && typeof imageMapping === 'object' && !Array.isArray(imageMapping)
                    ? Object.entries(imageMapping)
                        .map(([nodeId, idx]) => ({ nodeId: String(nodeId), idx: Number(idx) }))
                    : [];
                if (mappingEntries.length > 0) {
                    const applied = [];
                    const appliedIds = new Set();
                    const skipped = [];
                    for (const { nodeId, idx } of mappingEntries) {
                        const loadNode = workflowToRun[nodeId];
                        if (!loadNode || (loadNode.class_type || loadNode.type) !== LOADIMAGE_CLASS) {
                            skipped.push(`#${nodeId}(节点不存在或非 LoadImage，可能被忽略)`);
                            continue;
                        }
                        if (!Number.isInteger(idx) || idx < 0 || idx >= imageCount) {
                            skipped.push(`#${nodeId}(图片下标越界)`);
                            continue;
                        }
                        try {
                            const uploadedName = await uploadCanvasImageToComfy(images[idx], idx + 1);
                            loadNode.inputs = loadNode.inputs || {};
                            loadNode.inputs.image = uploadedName;
                            applied.push(`#${nodeId}←图${idx + 1}`);
                            appliedIds.add(nodeId);
                            console.log(`  🖼️ 免节点映射注入：图${idx + 1} 已上传为 ${uploadedName} → LoadImage 节点 ${nodeId}`);
                        } catch (err) {
                            skipped.push(`#${nodeId}(上传失败：${err.message})`);
                        }
                    }

                    // 空槽兜底：映射外的 LoadImage 若模板图引用已失效（不在
                    // ComfyUI input 清单——典型是保存模板时引用了 temp 临时
                    // 文件、文件已被清理），会让提交被校验拒绝。LoadImage 是
                    // 源头节点没有上游，剔除会断下游必填输入，改用中性占位图
                    // 顶替让提交通过；占位图仍会作为参考图参与生成，如实上报
                    // 由用户知情（真要空着请修工作流结构）。模板引用有效时不碰
                    // ——保留「ComfyUI 已选图」语义
                    const placeholders = [];
                    const unmappedIds = Object.keys(workflowToRun).filter((nodeId) => {
                        const node = workflowToRun[nodeId];
                        return (node.class_type || node.type) === LOADIMAGE_CLASS && !appliedIds.has(nodeId);
                    });
                    if (unmappedIds.length > 0) {
                        const classInfo = await fetchClassInfo(['LoadImage']);
                        const validImages = extractComboValues(classInfo, 'LoadImage', 'image');
                        const placeholderUrl = validImages.length > 0
                            ? await getPlaceholderDataUrl().catch(() => null)
                            : null;
                        if (placeholderUrl) {
                            for (const nodeId of unmappedIds) {
                                const node = workflowToRun[nodeId];
                                const current = node.inputs ? node.inputs.image : undefined;
                                // 连线输入（数组）不算失效；清单外字面值才顶替
                                if (typeof current !== 'string' || !current) continue;
                                if (validImages.includes(current)) continue;
                                try {
                                    const phName = await uploadCanvasImageToComfy(placeholderUrl, 0);
                                    node.inputs.image = phName;
                                    placeholders.push(nodeId);
                                    console.log(`  🩹 空槽兜底：LoadImage 节点 ${nodeId} 模板图 ${current} 已失效，用占位图顶替`);
                                } catch (err) {
                                    console.log(`  ⚠️ 空槽兜底失败（维持原值，由 ComfyUI 校验报错）: ${nodeId} - ${err.message}`);
                                }
                            }
                        }
                    }

                    const placeholderNote = placeholders.length > 0
                        ? `；空槽节点 ${placeholders.map((id) => `#${id}`).join('、')} 的模板图已失效，用占位图顶替`
                        : '';
                    imageInject = applied.length > 0
                        ? {
                            mode: 'mapped',
                            loadImageId: mappingEntries.length === 1 ? mappingEntries[0].nodeId : undefined,
                            applied: applied.length,
                            skipped,
                            placeholders,
                            detail: `已按映射注入 ${applied.length} 个 LoadImage（${applied.join('、')}）` +
                                (skipped.length ? `；跳过：${skipped.join('、')}` : '') + placeholderNote
                        }
                        : {
                            mode: 'none',
                            skipped,
                            placeholders,
                            detail: `映射全部失效，本次图片未注入（${skipped.join('、')}）` + placeholderNote
                        };
                    if (skipped.length) {
                        console.log(`  ⚠️ 免节点映射注入跳过 ${skipped.length} 条：${skipped.join('；')}`);
                    }
                } else {
                    const decision = decideImageInject(canvasFlow, imageCount);
                    if (decision.mode === 'auto' || decision.mode === 'partial') {
                        try {
                            const uploadedName = await uploadCanvasImageToComfy(images[0], 1);
                            const loadNode = workflowToRun[decision.loadImageId];
                            loadNode.inputs = loadNode.inputs || {};
                            loadNode.inputs.image = uploadedName;
                            console.log(`  🖼️ 免节点注入：画布图已上传为 ${uploadedName} → LoadImage 节点 ${decision.loadImageId}`);
                        } catch (err) {
                            console.error('  ❌ 免节点注入失败（回落槽位链路语义，图不生效）:', err.message);
                            decision.mode = 'none';
                            decision.detail = `画布图上传 ComfyUI 失败，本次图片未生效：${err.message}`;
                        }
                    } else {
                        console.log(`  ⚠️ 免节点注入跳过（${decision.mode}）：${decision.detail}`);
                    }
                    imageInject = { mode: decision.mode, loadImageId: decision.loadImageId, detail: decision.detail };
                }
            }

            // 工作流含画板取视频节点（V2V）时写视频槽位（引用式）。
            // 仅在请求体携带 videos 数组时写入：右侧面板流程自行经
            // /api/canvas-video 写引用（不传 videos），避免提交时
            // 把面板刚绑定的视频槽位清空
            const hasVideoReceiveNode = Object.values(workflowToRun).some(
                (node) => (node.class_type || node.type) === 'LumenReceiveVideoFromCanvas'
            );
            if (hasVideoReceiveNode && Array.isArray(videos)) {
                console.log('📤 工作流含画板取视频节点，写入视频槽位引用...');
                await uploadVideosToSlots(videos);
            }

            // 提交前预处理（移除占位节点、注入取图随机种子），
            // 与提示词面板的 /api/run-comfy 共用同一份实现
            prepareWorkflowForRun(workflowToRun);

            // 注入画布 LoRA 堆栈（图拼接，追加在模板 lora 之后；模板内嵌
            // lora 由面板叠加区/画布节点行管理，被删除的已在上方 bypass 剔除）
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
                    // 图片与视频回流节点都注入——V2V 工作流的视频经
                    // LumenSendVideoToCanvas 回流，同样要定向到发起节点
                    // （占位图消费与完成判定靠 target 路由）
                    const isSendNode = ['LumenSendImageRealtime', 'LumenSendVideoToCanvas']
                        .includes(sendNode.class_type || sendNode.type);
                    if (isSendNode) {
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

            // 输出·免节点链路：无回传节点且非视频工作流 → 轮询原生
            // /history 取产物推画布（后台任务，不挂住本响应）；有 Send
            // 节点走现有实时回流，视频工作流保留节点路径（见模块头注释）。
            // LUMEN_TEST_HISTORY_MS：测试钩子——把轮询间隔与总超时同时压到
            // 该毫秒数，集成测试里免节点回流秒级收敛（沿用
            // LUMEN_GUARD_DATA_DIR 的测试钩子先例）
            let outputVia = 'send-node';
            if (!canvasFlow.hasSendNode) {
                if (canvasFlow.hasVideoOutput) {
                    outputVia = 'none';
                    console.log('  ⚠️ 工作流无回传节点且为视频产物结构，history 兜底不覆盖（请安装 lumen_nodes 回传节点）');
                } else {
                    outputVia = 'history';
                    const historyOpts = {};
                    if (process.env.LUMEN_TEST_HISTORY_MS) {
                        const ms = Number(process.env.LUMEN_TEST_HISTORY_MS) || 20;
                        historyOpts.intervalMs = ms;
                        historyOpts.timeoutMs = ms;
                    }
                    pushHistoryOutputsToCanvas(promptId, target || null, historyOpts);
                }
            }

            res.json({
                status: 'ok',
                promptId: promptId,
                message: '工作流已启动',
                imageInject,   // 免节点输入注入结果（null = 走槽位链路/无图）
                outputVia      // 'send-node' | 'history' | 'none'
            });
        } catch (error) {
            console.error('❌ Comfy 节点运行失败:', error.message);
            res.status(500).json({
                status: 'error',
                message: error.message || '运行失败'
            });
        }
    });

    /**
     * POST /api/comfy-node/stop
     * 中断 ComfyUI 生成（Comfy 生图节点停止 X 的后端支撑）。
     * body: { promptIds: [...] } —— 本轮提交返回的全部任务 id，按 id 精确取消：
     *   - 正在执行的：POST /interrupt 中断（ComfyUI 只能中断"当前正在跑"的
     *     任务、无法指定 id——仅当正在执行的确属本轮任务时才中断，避免误杀
     *     其他节点/面板同时进行的生成）；
     *   - 还在队列里的：POST /queue {"delete": [...]} 按 id 移除。
     */
    router.post('/stop', async (req, res) => {
        const ids = Array.isArray(req.body && req.body.promptIds)
            ? req.body.promptIds.filter((v) => typeof v === 'string' && v)
            : [];
        if (!ids.length) {
            return res.json({ status: 'ok', interrupted: false, deleted: 0 });
        }

        const result = { status: 'ok', interrupted: false, deleted: 0 };
        try {
            // 查队列：正在执行的任务里是否有本轮的。queue_running 条目格式
            // 为 [执行序号, prompt_id, ...]，取 index 1（兼容对象形态兜底）
            let runningOurs = false;
            try {
                const queueRes = await fetchWithTimeout(`${comfyApiUrl}/queue`);
                const queue = await queueRes.json();
                const runningIds = [].concat(queue.queue_running || [])
                    .map((e) => (Array.isArray(e) ? e[1] : (e && e.promptId)))
                    .filter(Boolean);
                runningOurs = runningIds.some((id) => ids.includes(id));
            } catch (_) {
                // 队列查询失败不阻断：仍然尝试按 id 删队列
            }

            if (runningOurs) {
                await fetchWithTimeout(`${comfyApiUrl}/interrupt`, { method: 'POST' });
                result.interrupted = true;
            }

            const deleteRes = await fetchWithTimeout(`${comfyApiUrl}/queue`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ delete: ids })
            });
            if (!deleteRes.ok) {
                throw new Error(`ComfyUI /queue 响应 ${deleteRes.status}`);
            }
            result.deleted = ids.length;

            console.log(`⏹️ Comfy 任务已停止: interrupt=${result.interrupted}, delete=${result.deleted}`);
            res.json(result);
        } catch (error) {
            console.error('❌ Comfy 任务停止失败:', error.message);
            res.status(500).json({ status: 'error', message: error.message || '停止失败' });
        }
    });

    return router;
}

module.exports = createComfyNodeRouter;
