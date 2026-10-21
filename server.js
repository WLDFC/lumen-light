/**
 * ==========================================================================
 * LumenLight 后端服务器主文件
 * 作用：作为 LumenLight 应用的后端服务入口，负责：
 *   1. 初始化 Express 应用和 HTTP/WebSocket 服务器
 *   2. 加载并挂载各业务路由模块
 *   3. 管理 WebSocket 客户端连接与基础消息处理
 *   4. 维护运行时内存状态（提示词、工作流、画板图片槽位等）
 *   5. 启动服务器并监听 8080 端口
 * 
 * 业务逻辑已拆分到以下模块：
 *   - routes/comfy.js       : ComfyUI 交互 API
 *   - routes/workflows.js   : 工作流文件管理 API
 *   - routes/canvasImages.js: 画板图片槽位 API
 *   - routes/upscale.js     : 高清放大 API
 *   - routes/rembg.js       : 抠图去背景 API
 *   - utils/workflowInjector.js: 工作流 Prompt 注入工具
 *   - utils/defaultWorkflow.js : 默认工作流模板
 * 
 * 默认监听端口：8080
 * ComfyUI 默认地址：http://127.0.0.1:8188
 * ==========================================================================
 */

const express = require('express');     // Express Web 框架
const cors = require('cors');           // 跨域资源共享中间件
const WebSocket = require('ws');        // WebSocket 库
const http = require('http');           // HTTP 服务器模块
const fs = require('fs').promises;      // 基于 Promise 的文件系统 API
const path = require('path');           // 路径处理模块
const { exec } = require('child_process'); // 子进程执行模块，用于自动打开浏览器
const { v4: uuidv4 } = require('uuid'); // UUID 生成库

// 导入业务路由模块
const createComfyRouter = require('./routes/comfy');
const createWorkflowsRouter = require('./routes/workflows');
const createCanvasImagesRouter = require('./routes/canvasImages');
const createCanvasVideoRouter = require('./routes/canvasVideo');
const createSavesRouter = require('./routes/saves');
const createVideosRouter = require('./routes/videos');
const createAudiosRouter = require('./routes/audios');
const createCanvasBridgeRouter = require('./routes/canvasBridge');
const createPiAgentRouter = require('./routes/piAgent');
const PiAgentManager = require('./utils/piAgentManager');
const upscaleRouter = require('./routes/upscale');
const rembgRouter = require('./routes/rembg');
const createSettingsRouter = require('./routes/settings');
const createLlmRouter = require('./routes/llm');
const createTagsRouter = require('./routes/tags');
const createComfyNodeRouter = require('./routes/comfyNode');
const createRunningHubRouter = require('./routes/runninghub');
const MCPManager = require('./utils/mcpManager');
const createMcpRouter = require('./routes/mcp');
const createWebBridgeRouter = require('./routes/webbridge');

// ==================== ComfyUI API 配置 ====================
// 从环境变量读取 ComfyUI 地址，默认使用本地 8188 端口
const COMFY_API_URL = process.env.COMFY_API_URL || 'http://127.0.0.1:8188';

// 工作流存储目录（项目根目录下的 workflows 文件夹）
const WORKFLOWS_DIR = path.join(__dirname, 'workflows');

// 项目存档目录（项目根目录下的 save 文件夹）
const SAVES_DIR = path.join(__dirname, 'save');

// 应用设置数据目录（项目根目录下的 data 文件夹）
const DATA_DIR = path.join(__dirname, 'data');
// 视频工作区目录（实时保存的临时视频落点，保存/删除时由后端清理）
const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
// 音频工作区目录（画布音频文件落点，删除时由后端清理）
const AUDIOS_DIR = path.join(DATA_DIR, 'audio');

// 图片提示词收藏目录（原图、缩略图和元数据）
const TAGS_DIR = path.join(__dirname, 'tag');

/**
 * 确保工作流目录存在，不存在则创建
 */
async function ensureWorkflowsDir() {
    try {
        await fs.access(WORKFLOWS_DIR);
    } catch {
        await fs.mkdir(WORKFLOWS_DIR, { recursive: true });
        console.log('📁 创建工作流目录:', WORKFLOWS_DIR);
    }
}

/**
 * 确保存档目录存在，不存在则创建
 */
async function ensureSavesDir() {
    try {
        await fs.access(SAVES_DIR);
    } catch {
        await fs.mkdir(SAVES_DIR, { recursive: true });
        console.log('📁 创建存档目录:', SAVES_DIR);
    }
}

/**
 * 确保设置数据目录存在，不存在则创建
 */
async function ensureDataDir() {
    try {
        await fs.access(DATA_DIR);
    } catch {
        await fs.mkdir(DATA_DIR, { recursive: true });
        console.log('📁 创建数据目录:', DATA_DIR);
    }
}

// 创建 Express 应用和 HTTP 服务器
const app = express();
const server = http.createServer(app);

// ==================== HTTP 超时防护 ====================
// 防线说明：requestTimeout 只覆盖“接收请求体”阶段，管不到“handler 不应答”
// 的挂起响应（那种靠各路由自己的超时兜底，如 piAgent 20s RPC 超时、
// 桥接 30s 超时）。这里收紧到 2 分钟是防半截请求体占住 socket
// （浏览器同域仅 6 条连接，历史上曾因此整页互锁）
server.requestTimeout = 120 * 1000;   // 单请求接收超时（含请求体）
server.headersTimeout = 60 * 1000;    // 请求头超时（保持 Node 默认值，显式声明）

// 创建 WebSocket 服务器，复用 HTTP 服务器
const wss = new WebSocket.Server({ server });

// ==================== 内存数据存储 ====================

// 存储所有 WebSocket 客户端连接
const clients = new Map();

// 存储最新提示词（ComfyUI 会从 /api/prompts 获取）
const latestPrompts = {
    positive: "masterpiece, best quality",
    negative: "low quality, bad anatomy",
    timestamp: 0
};

// 存储最新工作流（用于 /api/run-comfy 运行）
const latestWorkflow = {
    workflow: null,
    timestamp: 0
};

// 存储画板图片（供 Edit / 局部重绘 / 多图编辑工作流取用；上限 9 与
// LumenReceiveImageFromCanvas.MAX_SLOTS 对齐，未初始化的中间槽位按需
// 动态落键——对象键写入免预分配，校验在 canvasImages 路由层）
const MAX_IMAGE_SLOTS = 9;
const canvasImages = Object.fromEntries(
    Array.from({ length: MAX_IMAGE_SLOTS }, (_, i) => [i + 1, null])
);

// 记录每个槽位图片的更新时间戳
const canvasImagesTimestamp = Object.fromEntries(
    Array.from({ length: MAX_IMAGE_SLOTS }, (_, i) => [i + 1, 0])
);

// 遮罩槽位（局部重绘：黑白遮罩图，白=重绘区；与图片槽按位对齐，
// 由生图提交写入/清空，From Canvas 节点的 mask 输出读取）
const canvasMasks = Object.fromEntries(
    Array.from({ length: MAX_IMAGE_SLOTS }, (_, i) => [i + 1, null])
);
const canvasMasksTimestamp = Object.fromEntries(
    Array.from({ length: MAX_IMAGE_SLOTS }, (_, i) => [i + 1, 0])
);

// 视频槽位（引用式：槽位存 {videoUrl, filename} 指向 data/videos/ 已落盘
// 文件，不搬字节——视频体积大，由 canvasVideo 路由按需 sendFile 流式回传；
// 与图片槽按位对称，From Canvas (Video Ref) 节点读取）
const canvasVideos = {
    1: null,
    2: null,
    3: null
};
const canvasVideosTimestamp = {
    1: 0,
    2: 0,
    3: 0
};

// ==================== Express 中间件 ====================

app.use(cors()); // 允许跨域请求
app.use(express.json({ limit: '100mb' })); // 解析 JSON 请求体，最大 100MB（支持 base64 图片）
// no-cache = 每次都协商缓存（ETag/304 代价极小），但保证前端改代码后
// 刷新页面必然拿到新文件——裸 express.static 只有 Last-Modified，浏览器
// 会启发式缓存，曾出现"改了 JS 浏览器仍跑旧代码"的排查陷阱
app.use(express.static('.', {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
})); // 提供静态文件服务

// ==================== WebSocket 管理 ====================

/**
 * 广播数据给所有画板（canvas）客户端
 * @param {Object} data - 要发送的数据对象
 */
function broadcastToCanvas(data) {
    clients.forEach((client) => {
        if (client.role === 'canvas' && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(data));
        }
    });
}

/**
 * WebSocket 连接建立时的处理
 */
// 本次进程的启动标识：连接握手时下发给前端，前端与 localStorage 里的
// 上次值比对——不一致即「后端重启过而页面还是旧的」，自动刷新页面
// （部分用户重启后端后忘记 F5，旧页面会带着旧 JS 继续用，这里替他刷新）。
const BOOT_ID = uuidv4();

wss.on('connection', (ws) => {
    // 观察窗内有连接 = 旧页面（浏览器标签/IDE 内嵌预览）重连：
    // 取消自动开窗，复用旧页面，避免双窗口
    if (pendingOpenTimer) {
        clearTimeout(pendingOpenTimer);
        pendingOpenTimer = null;
        console.log('（跳过自动开窗：检测到旧页面重连，复用该页面）');
    }

    // bootId 握手（首条消息）：旧页面收到与本地记录不同的 bootId 自行刷新，
    // 与下方「跳过自动开窗」配合——旧页面负责自我更新，新窗口只在没有任何
    // 可复用页面时才开
    try {
        ws.send(JSON.stringify({ type: 'hello', bootId: BOOT_ID }));
    } catch { /* 连接刚建立即断：忽略 */ }

    const clientId = uuidv4();
    console.log('新连接:', clientId);

    /**
     * 接收客户端消息
     */
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            // 活跃度追踪：任意消息都刷新 lastSeen（含心跳），
            // 桥接命令据此路由到"最近活跃"的画布客户端
            const registered = clients.get(clientId);
            if (registered) {
                registered.lastSeen = Date.now();
                if (typeof msg.bridgeReceived === 'number') {
                    registered.bridgeReceived = msg.bridgeReceived;
                }
            }

            switch (msg.type) {
                case 'register':
                    // 注册客户端角色（如 canvas 画板）
                    clients.set(clientId, {
                        ws,
                        role: msg.role,
                        name: msg.name,
                        lastSeen: Date.now(),
                        bridgeReceived: 0
                    });
                    console.log(`注册: ${msg.role} - ${msg.name}`);

                    // 如果有画板客户端连接，广播连接状态
                    if (msg.role === 'canvas') {
                        broadcastToCanvas({
                            type: 'status',
                            message: 'connected'
                        });
                    }
                    break;
            }
        } catch (e) {
            console.error('消息解析失败:', e);
        }
    });

    /**
     * WebSocket 连接关闭时清理客户端
     */
    ws.on('close', () => {
        clients.delete(clientId);
        console.log('断开:', clientId);
    });
});

// ==================== 挂载业务路由 ====================

// ComfyUI 相关 API（/api/receive-image、/api/prompts、/api/run-comfy、/api/comfy-status）
app.use('/api', createComfyRouter({
    clients,
    latestPrompts,
    latestWorkflow,
    canvasImages,
    canvasImagesTimestamp,
    comfyApiUrl: COMFY_API_URL
}));

// 工作流管理 API（/api/workflows；布局 sidecar 存 data/workflow-layouts.json）
app.use('/api/workflows', createWorkflowsRouter({
    workflowsDir: WORKFLOWS_DIR,
    layoutsFile: path.join(__dirname, 'data', 'workflow-layouts.json')
}));

// 画板图片槽位 API（/api/canvas-image）
app.use('/api/canvas-image', createCanvasImagesRouter({
    canvasImages,
    canvasImagesTimestamp
}));

// 遮罩槽位 API（/api/canvas-mask：局部重绘遮罩，与图片槽按位对齐）
app.use('/api/canvas-mask', createCanvasImagesRouter({
    canvasImages: canvasMasks,
    canvasImagesTimestamp: canvasMasksTimestamp
}));

// 视频槽位 API（/api/canvas-video：引用式槽位，与图片槽按位对称，
// 供 ComfyUI LumenReceiveVideoFromCanvas 节点取画布视频）
app.use('/api/canvas-video', createCanvasVideoRouter({
    canvasVideos,
    canvasVideosTimestamp,
    videosDir: VIDEOS_DIR
}));

// Comfy 生图节点 API（/api/comfy-node：模型清单代理 + 节点生图提交）。
// 与 comfy 路由共享画板槽位与最新提示词存储，保证两条生图链路状态一致；
// 视频槽位依赖（canvasVideos/videosDir）供 V2V 工作流提交时写引用
app.use('/api/comfy-node', createComfyNodeRouter({
    workflowsDir: WORKFLOWS_DIR,
    canvasImages,
    canvasImagesTimestamp,
    canvasMasks,
    canvasMasksTimestamp,
    canvasVideos,
    canvasVideosTimestamp,
    videosDir: VIDEOS_DIR,
    latestPrompts,
    clients,   // 免节点 history 回流推画布用（与 comfy 路由同一客户端表）
    comfyApiUrl: COMFY_API_URL
}));

// Comfy 原生工具 API（/api/comfy-tools：comfy-mcp 精选工具的原生实现，
// 供 pi 扩展 lumen-comfy 调用）。comfy.root（ComfyUI 根目录，模型下载
// 落盘用）实时读设置——设置面板改完即生效，5 秒缓存免每次落盘读取
const createComfyToolsRouter = require('./routes/comfyTools');
const comfySettingsPath = path.join(DATA_DIR, 'settings.json');
let comfyRootCache = { value: '', at: 0 };
function readComfyRoot() {
    if (Date.now() - comfyRootCache.at < 5000) return comfyRootCache.value;
    try {
        const s = JSON.parse(require('fs').readFileSync(comfySettingsPath, 'utf-8'));
        comfyRootCache = { value: s.comfy?.root || '', at: Date.now() };
    } catch {
        comfyRootCache = { value: '', at: Date.now() };
    }
    return comfyRootCache.value;
}
// 供 lora 自动检测写回配置后立即清缓存（否则 /list 5 秒内仍读到旧值）
function invalidateComfyRootCache() { comfyRootCache.at = 0; }
app.use('/api/comfy-tools', createComfyToolsRouter({
    comfyApiUrl: COMFY_API_URL,
    getComfyRoot: readComfyRoot
}));

// LoRA 管理 API（/api/lora：画布顶栏「LoRA 管理」窗口——扫描
// <comfy.root>/models/loras 清单、sidecar 封面图、置顶元数据）
const createLoraRouter = require('./routes/lora');
app.use('/api/lora', createLoraRouter({
    getComfyRoot: readComfyRoot,
    invalidateRootCache: invalidateComfyRootCache,
    comfyApiUrl: COMFY_API_URL
}));

// 高清放大 API（/api/upscale）
app.use('/api/upscale', upscaleRouter);

// 抠图去背景 API（/api/rembg）
app.use('/api/rembg', rembgRouter);

// 本地物体移除 API（/api/lama，LaMa inpainting 模型）
app.use('/api/lama', require('./routes/lama'));

// 存档管理 API（/api/saves）
app.use('/api/saves', createSavesRouter({ savesDir: SAVES_DIR, videosDir: VIDEOS_DIR }));

// 视频工作区管理 API（/api/videos，data/videos 临时视频的删除）
app.use('/api/videos', createVideosRouter({ videosDir: VIDEOS_DIR }));

// 音频工作区管理 API（/api/audios，画布音频文件的上传与删除）
app.use('/api/audios', createAudiosRouter({ audiosDir: AUDIOS_DIR }));

// 画布桥接 API（/api/canvas-bridge，pi 等外部 agent 经此操作画布）
app.use('/api/canvas-bridge', createCanvasBridgeRouter({ clients }));

// RunningHub 云端工作流 API（/api/runninghub，画布 RunningHub 生成节点后端）
app.use('/api/runninghub', createRunningHubRouter({ clients, dataDir: DATA_DIR }));

// pi 编码智能体（/api/pi，LLM 窗口的 pi 模式后端）
const piAgentManager = new PiAgentManager({ projectRoot: __dirname, dataDir: DATA_DIR, clients });
app.use('/api/pi', createPiAgentRouter({ manager: piAgentManager }));
// pi 后台任务上报中继（lumen-canvas 扩展 POST → WS 广播给前端任务中心；
// GET 供页面刷新后补水运行中任务）
app.use('/api/tasks', require('./routes/tasks')({ clients }));
// 启动即拉起 pi RPC 进程（与下方 MCP 初始连接同理）：状态灯/agent 模式
// 开箱即用。此前为惰性启动——首次 prompt 才 spawn，后端重启后 /state
// 如实报 running:false，状态灯会一直灰到首问。失败不阻塞启动：
// starting 已复位，下次 prompt 时 ensureStarted 自动重试
piAgentManager.ensureStarted().catch((err) => {
    console.warn('[pi] 启动时拉起失败（首次使用时会自动重试）:', err.message);
    piAgentManager._logLine('[spawn] 启动时拉起失败: ' + err.message);
});

// MCP 宿主（/api/mcp，用户自挂 MCP 服务器：设置 → MCP；
// 工具经 lumen-mcp 扩展注册给 pi，agent 即可结构化调用）
const mcpManager = new MCPManager({ dataDir: DATA_DIR });
app.use('/api/mcp', createMcpRouter({ mcpManager }));
mcpManager.ensureStarted().catch((err) => console.warn('[MCP] 初始连接失败:', err.message));

// 网页桥接（/api/webbridge，LLM 面板「网页桥接」模式后端）：路由层持有
// WebBridgeManager 并负责领域事件 → WS 消息的映射（webbridge-event 推面板、
// new-image/new-video 落画布），server.js 只做挂载。惰性启动：首次发送或
// 设置里手动启动时才拉起浏览器，不在后端启动时自动弹窗
const webBridgeRouter = createWebBridgeRouter({ clients, dataDir: DATA_DIR });
app.use('/api/webbridge', webBridgeRouter);

// ==================== 后端进程级兜底与 pi 子进程清理 ====================
// 历史教训：pi 执行中崩溃时 agent.log 只剩 spawn 记录、没有任何 [exit]——
// 说明后端进程先于 pi 死亡（unhandledRejection 崩溃或 start-server.bat 的
// taskkill /F 强杀），pi 的 exit 处理器在后端进程里、日志自然没写，且 pi
// 子进程被孤儿化后仍持有会话文件。此前的表现即"pi 崩溃必须重启后端"。
//   1) 未捕获异常/拒绝：写入 agent.log 留证后保持存活（桌面工具保可用优先，
//      后端一死画布全部功能随之下线）；排查时搜 [backend] 前缀；
//   2) 正常退出（Ctrl+C / SIGTERM / --watch 重启）：顺手终止 pi 子进程，
//      防止孤儿 pi 与新后端拉起的 pi 并发读写同一会话文件；
//      taskkill /F 强杀场景钩子不执行，属尽力而为
process.on('uncaughtException', (err) => {
    const msg = '[backend] uncaughtException: ' + (err && err.stack || err);
    console.error(msg);
    piAgentManager._logLine(msg);
});
process.on('unhandledRejection', (reason) => {
    const msg = '[backend] unhandledRejection: ' + (reason && (reason.stack || reason.message) || reason);
    console.error(msg);
    piAgentManager._logLine(msg);
});
process.on('exit', () => {
    try {
        if (piAgentManager.proc && piAgentManager.proc.exitCode === null) {
            piAgentManager._logLine('[backend] 后端退出，终止 pi 子进程防孤儿');
            piAgentManager.stop();
        }
        mcpManager.closeAll();   // 终止 MCP 服务器子进程，防孤儿
        // 桥接浏览器是独立进程（调试端口 9224），这里只断开连接不关进程：
        // 后端重启后凭端口重连原实例，登录态与打开的对话页原样保留
        webBridgeRouter.manager.closeAll();
    } catch { /* 退出清理尽力而为 */ }
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// ---- 进程心跳自监控（下次"无痕死亡"的定罪证据） ----
// 历史教训：pi 跑长任务时后端曾被无痕强杀（agent.log 无 [exit]/[backend]，
// 只能靠 --watch 父进程 fork 新 server 的间接证据定罪）。每 30s 写一行
// 心跳到 agent.log：若后端再次无痕死亡，日志会停在最后一条心跳——
// 与新 server spawn 时间对比即可精确断定死亡时刻；正常 --watch 重启
// 则心跳前必有 [backend] 后端退出记录
setInterval(() => {
    try {
        piAgentManager._logLine(`[heartbeat] alive pid=${process.pid} uptime=${Math.round(process.uptime())}s mem=${Math.round(process.memoryUsage().rss / 1048576)}MB`);
    } catch { /* 心跳失败不影响服务 */ }
}, 30 * 1000);

// 设置管理 API（/api/settings）
app.use('/api/settings', createSettingsRouter({ dataDir: DATA_DIR }));

// 大语言模型聊天代理 API（/api/llm）
app.use('/api/llm', createLlmRouter({ dataDir: DATA_DIR }));

// 图片提示词标签 API（/api/tags）
app.use('/api/tags', createTagsRouter({ tagsDir: TAGS_DIR }));

// 系统提示词库 API（数据落盘 data/prompts.json）。
// 注意：路径不能叫 /api/prompts —— ComfyUI 路由（挂载在 /api）已占用
// /api/prompts 的 GET，会把本路由的请求整个截走
const createPromptsRouter = require('./routes/prompts');
app.use('/api/system-prompts', createPromptsRouter({ dataDir: DATA_DIR }));

// Comfy 提示词预设 API（数据落盘 data/comfy-prompts.json，正面/负面两库；
// ComfyPromptPresets 面板按钮的增删改查与注入数据源）
const createComfyPromptsRouter = require('./routes/comfyPrompts');
app.use('/api/comfy-prompts', createComfyPromptsRouter({ dataDir: DATA_DIR }));

// 坐标编辑器草稿 API（数据落盘 data/coordinate-draft.json，全局单份；
// 编辑器防抖自动保存 + 打开时恢复，见 ADR 018）
const createCoordinateDraftRouter = require('./routes/coordinateDraft');
app.use('/api/coordinate-draft', createCoordinateDraftRouter({ dataDir: DATA_DIR }));

// 用户自定义技能 API（/api/skills，数据落盘 data/skills/ 目录，一个技能一个 JSON 文件）
const createSkillsRouter = require('./routes/skills');
app.use('/api/skills', createSkillsRouter({ skillsDir: path.join(DATA_DIR, 'skills') }));

// pi 技能库 API（/api/pi-skills，查阅与启停 data/pi/skills/ 技能库——
// pi agent 的 skill_list/skill_load 数据源；禁用状态落 data/pi/settings.json
// 的 disabledSkills，lumen-skills 扩展每次调用现读，勾选即时生效）
const createPiSkillsRouter = require('./routes/piSkills');
app.use('/api/pi-skills', createPiSkillsRouter({ dataDir: DATA_DIR }));

// 实时保存 API（/api/autosave，数据落盘 data/autosave/ 目录：
// 内容寻址图片资产 + 轻量恢复元数据，与 save/ 正式存档分离）
const createAutosaveRouter = require('./routes/autosave');
app.use('/api/autosave', createAutosaveRouter({ dir: path.join(DATA_DIR, 'autosave') }));

// 用户资产 API（/api/assets，数据落盘 data/assets/ 目录：图片工具栏
// 「添加到资产」的存储端，内容寻址去重；资产库内置标签「我的资产」的数据源）
const createAssetsRouter = require('./routes/assets');
app.use('/api/assets', createAssetsRouter({ assetsDir: path.join(DATA_DIR, 'assets') }));

// 备份导出/导入 API（/api/backup，文件菜单「备份导出/导入」入口：
// 存档 + API 设置 + 聊天记录 + 提示词库打包为 zip 下载 / 从 zip 合并导回，
// 导入策略见 routes/backup.js 头注——同名存档改名不覆盖、设置按厂商合并）
const createBackupRouter = require('./routes/backup');
app.use('/api/backup', createBackupRouter({ savesDir: SAVES_DIR, dataDir: DATA_DIR, tagsDir: TAGS_DIR }));

// ==================== 统一错误处理 ====================

/**
 * 全局错误处理中间件：将错误统一以 JSON 返回，
 * 避免 Express 默认返回 HTML 错误页导致前端 response.json() 解析失败
 * （例如请求体超过 express.json limit 触发的 413）
 */
app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    console.error('❌ 请求错误:', err.type || '', err.message);
    if (res.headersSent) return next(err);
    res.status(status).json({
        status: 'error',
        message: err.message || '服务器内部错误'
    });
});

// ==================== 自动打开浏览器 ====================

/** 自动开窗观察窗：前端 WS 断线后每 5 秒重连一次，启动后 6 秒内
 *  （5 秒间隔 + 1 秒余量）观察到任何连接，即证明存在可复用的旧页面
 *  （浏览器旧标签 / IDE 内嵌预览），跳过开窗避免双窗口；
 *  窗口内无连接 = 首次启动，开窗 */
const OPEN_OBSERVE_MS = 6000;
/** 待执行的自动开窗定时器（旧页面重连时取消并改打跳过提示） */
let pendingOpenTimer = null;

/**
 * 根据当前操作系统，调用默认浏览器打开指定 URL
 * @param {string} url - 要打开的 URL
 */
function openBrowser(url) {
    const platform = process.platform;
    let command;

    if (platform === 'win32') {
        command = `start "" "${url}"`;
    } else if (platform === 'darwin') {
        command = `open "${url}"`;
    } else {
        command = `xdg-open "${url}"`;
    }

    exec(command, (err) => {
        if (err) {
            console.error('打开浏览器失败:', err.message);
        }
    });
}

// ==================== 服务器启动 ====================

/**
 * 启动服务器
 */
async function startServer() {
    await ensureWorkflowsDir();
    await ensureSavesDir();
    await ensureDataDir();

    server.listen(8080, async () => {
        console.log('LumenLight 后端: http://localhost:8080');
        console.log('WebSocket: ws://localhost:8080');
        console.log('工作流目录:', WORKFLOWS_DIR);
        console.log('存档目录:', SAVES_DIR);

        // 启动成功后自动打开浏览器：观察窗内旧页面重连则跳过，
        // 窗口到期无连接才开（判定见 OPEN_OBSERVE_MS）
        pendingOpenTimer = setTimeout(() => {
            pendingOpenTimer = null;
            openBrowser('http://localhost:8080');
        }, OPEN_OBSERVE_MS);
    });
}

// 启动服务
startServer();
