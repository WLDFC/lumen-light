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
const createSavesRouter = require('./routes/saves');
const createVideosRouter = require('./routes/videos');
const createCanvasBridgeRouter = require('./routes/canvasBridge');
const createPiAgentRouter = require('./routes/piAgent');
const PiAgentManager = require('./utils/piAgent');
const upscaleRouter = require('./routes/upscale');
const rembgRouter = require('./routes/rembg');
const createSettingsRouter = require('./routes/settings');
const createLlmRouter = require('./routes/llm');
const createTagsRouter = require('./routes/tags');
const createComfyNodeRouter = require('./routes/comfyNode');

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

// 存储画板图片（用于 Edit 工作流，最多 3 个槽位）
const canvasImages = {
    1: null,
    2: null,
    3: null
};

// 记录每个槽位图片的更新时间戳
const canvasImagesTimestamp = {
    1: 0,
    2: 0,
    3: 0
};

// ==================== Express 中间件 ====================

app.use(cors()); // 允许跨域请求
app.use(express.json({ limit: '100mb' })); // 解析 JSON 请求体，最大 100MB（支持 base64 图片）
app.use(express.static('.')); // 提供静态文件服务

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
wss.on('connection', (ws) => {
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

// 工作流管理 API（/api/workflows）
app.use('/api/workflows', createWorkflowsRouter({ workflowsDir: WORKFLOWS_DIR }));

// 画板图片槽位 API（/api/canvas-image）
app.use('/api/canvas-image', createCanvasImagesRouter({
    canvasImages,
    canvasImagesTimestamp
}));

// Comfy 生图节点 API（/api/comfy-node：模型清单代理 + 节点生图提交）。
// 与 comfy 路由共享画板槽位与最新提示词存储，保证两条生图链路状态一致
app.use('/api/comfy-node', createComfyNodeRouter({
    workflowsDir: WORKFLOWS_DIR,
    canvasImages,
    canvasImagesTimestamp,
    latestPrompts,
    comfyApiUrl: COMFY_API_URL
}));

// 高清放大 API（/api/upscale）
app.use('/api/upscale', upscaleRouter);

// 抠图去背景 API（/api/rembg）
app.use('/api/rembg', rembgRouter);

// 存档管理 API（/api/saves）
app.use('/api/saves', createSavesRouter({ savesDir: SAVES_DIR, videosDir: VIDEOS_DIR }));

// 视频工作区管理 API（/api/videos，data/videos 临时视频的删除）
app.use('/api/videos', createVideosRouter({ videosDir: VIDEOS_DIR }));

// 画布桥接 API（/api/canvas-bridge，pi 等外部 agent 经此操作画布）
app.use('/api/canvas-bridge', createCanvasBridgeRouter({ clients }));

// pi 编码智能体（/api/pi，LLM 窗口的 pi 模式后端）
const piAgentManager = new PiAgentManager({ projectRoot: __dirname, dataDir: DATA_DIR, clients });
app.use('/api/pi', createPiAgentRouter({ manager: piAgentManager }));

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

// 用户自定义技能 API（/api/skills，数据落盘 data/skills/ 目录，一个技能一个 JSON 文件）
const createSkillsRouter = require('./routes/skills');
app.use('/api/skills', createSkillsRouter({ skillsDir: path.join(DATA_DIR, 'skills') }));

// 实时保存 API（/api/autosave，数据落盘 data/autosave/ 目录：
// 内容寻址图片资产 + 轻量恢复元数据，与 save/ 正式存档分离）
const createAutosaveRouter = require('./routes/autosave');
app.use('/api/autosave', createAutosaveRouter({ dir: path.join(DATA_DIR, 'autosave') }));

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

    server.listen(8080, () => {
        console.log('LumenLight 后端: http://localhost:8080');
        console.log('WebSocket: ws://localhost:8080');
        console.log('工作流目录:', WORKFLOWS_DIR);
        console.log('存档目录:', SAVES_DIR);

        // 启动成功后自动打开浏览器访问前端页面
        openBrowser('http://localhost:8080');
    });
}

// 启动服务
startServer();
