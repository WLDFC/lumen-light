/**
 * ==========================================================================
 * ComfyUI 相关路由
 * 作用：处理与 ComfyUI 交互的所有 HTTP API，包括：
 *   1. 接收 ComfyUI 生成的图片并通过 WebSocket 推送给画板客户端
 *   2. 提供提示词读取/保存接口
 *   3. 接收画板运行请求，注入提示词后提交到 ComfyUI
 *   4. 检测 ComfyUI 连接状态
 * ==========================================================================
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const {
    injectPromptsToWorkflow,
    prepareWorkflowForRun
} = require('../utils/workflowInjector');
const { submitPromptToComfy } = require('../utils/comfySubmit');

/**
 * 创建 ComfyUI 路由
 * @param {Object} options - 依赖项
 * @param {Map} options.clients - WebSocket 客户端连接映射
 * @param {Object} options.latestPrompts - 最新提示词存储
 * @param {Object} options.latestWorkflow - 最新工作流存储
 * @param {Object} options.canvasImages - 画板图片槽位数据
 * @param {Object} options.canvasImagesTimestamp - 画板图片槽位时间戳
 * @param {string} options.comfyApiUrl - ComfyUI API 地址
 * @returns {express.Router} Express 路由实例
 */
function createComfyRouter(options) {
    const {
        clients,
        latestPrompts,
        latestWorkflow,
        canvasImages,
        canvasImagesTimestamp,
        comfyApiUrl
    } = options;

    const router = express.Router();
    const WebSocket = require('ws');

    /**
     * 检测工作流输出类型：图片或视频
     * @param {Object} workflow - 工作流对象
     * @returns {string} 'image' 或 'video'
     */
    function detectOutputType(workflow) {
        const videoNodeTypes = [
            'VHS',
            'VideoHelperSuite',
            'SaveVideo',
            'VideoCombine',
            'ImageListToVideo',
            'LoadVideo',
            'LoadVideoUpload'
        ];

        for (const nodeId in workflow) {
            const node = workflow[nodeId];
            const classType = node.class_type || node.type || '';
            for (const keyword of videoNodeTypes) {
                if (classType.includes(keyword)) {
                    return 'video';
                }
            }
        }
        return 'image';
    }

    /**
     * POST /api/receive-image
     * ComfyUI 生成图片后调用此接口，后端将图片通过 WebSocket 推送给画板客户端
     */
    router.post('/receive-image', (req, res) => {
        const { image, index, total, target } = req.body;

        console.log(`📥 收到Comfy图片 ${index + 1}/${total || 1}${target ? ` (目标节点 ${target})` : ''}`);

        // 推送给所有画板客户端。
        // target：Comfy 生图节点提交工作流时注入的节点 id，原样回传给前端，
        // 前端据此把图片精确落到发起生成的节点占位图上；无 target 时
        // 前端走默认落图（占位图位置或视口中心），提示词面板流程不受影响
        let sentCount = 0;
        clients.forEach((client) => {
            if (client.role === 'canvas' && client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(JSON.stringify({
                    type: 'new-image',
                    image: image,
                    target: target || undefined,
                    prompt: {
                        positive: latestPrompts.positive,
                        negative: latestPrompts.negative
                    },
                    timestamp: Date.now()
                }));
                sentCount++;
            }
        });

        console.log(`  ✅ 已发送给 ${sentCount} 个画板客户端`);

        res.json({
            status: 'ok',
            clientsNotified: sentCount,
            message: sentCount > 0 ? '已发送到画板' : '画板未连接，已缓存'
        });
    });

    // 视频文件上传大小上限（ComfyUI 生成的视频一般几 MB 到几十 MB，留足余量）
    const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
    // 允许保存的视频扩展名（与 lumen_nodes/LumenSendVideoToCanvas 白名单一致）
    const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.gif', '.mkv', '.avi']);

    /**
     * POST /api/receive-video
     * ComfyUI 视频节点（LumenSendVideoToCanvas）把生成的视频文件
     * 二进制直传到画板：保存到 data/videos/ 后经 WebSocket 推送
     * new-video 消息给画板客户端。
     * 与 /receive-image 的 base64 JSON 不同——视频体积大，走原始字节流。
     * 查询参数：filename=原始文件名（用于扩展名识别），target=画布节点 id（预留）
     */
    router.post('/receive-video',
        express.raw({ type: () => true, limit: MAX_VIDEO_BYTES }),
        async (req, res) => {
            try {
                const { filename, target } = req.query;
                const body = req.body;

                if (!body || !body.length) {
                    return res.status(400).json({ status: 'error', message: '请求体为空' });
                }

                // 扩展名白名单校验（默认 .mp4）
                const originalName = String(filename || 'video.mp4');
                const ext = (path.extname(originalName) || '.mp4').toLowerCase();
                if (!VIDEO_EXTS.has(ext)) {
                    return res.status(400).json({
                        status: 'error',
                        message: `不支持的视频格式: ${ext}（支持: ${[...VIDEO_EXTS].join(' ')}）`
                    });
                }

                // 保存到 data/videos/（与 LLM 生成的视频同一目录，静态服务直接可访问）
                const videosDir = path.join(__dirname, '..', 'data', 'videos');
                await fs.mkdir(videosDir, { recursive: true });
                const safeName = `video_${Date.now()}_${originalName.replace(/[^\w.\-\u4e00-\u9fff]/g, '_')}`;
                const destPath = path.join(videosDir, safeName);
                await fs.writeFile(destPath, body);
                const videoUrl = `data/videos/${safeName}`;

                console.log(`📥 收到Comfy视频: ${originalName} (${(body.length / 1024 / 1024).toFixed(1)} MB) → ${videoUrl}`);

                // 推送给所有画板客户端（视频落画布走默认逻辑，
                // 不路由到生图节点占位图——占位图是图片语义）
                let sentCount = 0;
                clients.forEach((client) => {
                    if (client.role === 'canvas' && client.ws.readyState === WebSocket.OPEN) {
                        client.ws.send(JSON.stringify({
                            type: 'new-video',
                            videoUrl,
                            target: target || undefined,
                            prompt: {
                                positive: latestPrompts.positive,
                                negative: latestPrompts.negative
                            },
                            timestamp: Date.now()
                        }));
                        sentCount++;
                    }
                });

                console.log(`  ✅ 视频已发送给 ${sentCount} 个画板客户端`);

                res.json({
                    status: 'ok',
                    videoUrl,
                    clientsNotified: sentCount
                });
            } catch (error) {
                console.error('接收视频失败:', error);
                res.status(500).json({ status: 'error', message: error.message });
            }
        });

    /**
     * GET /api/prompts
     * ComfyUI 自定义节点调用此接口获取最新提示词
     */
    router.get('/prompts', (req, res) => {
        console.log('📤 发送提示词到 ComfyUI:', latestPrompts);
        res.json({
            positive: latestPrompts.positive,
            negative: latestPrompts.negative
        });
    });

    /**
     * POST /api/run-comfy
     * 前端运行 ComfyUI 工作流：注入提示词和种子后提交到 ComfyUI
     */
    router.post('/run-comfy', async (req, res) => {
        const { positive, negative, workflow } = req.body;
        const requestId = Date.now();

        console.log(`\n🚀 [${requestId}] 收到运行请求`);
        console.log(`  槽位1图片长度: ${canvasImages[1]?.length || 'null'}, 时间戳: ${canvasImagesTimestamp[1]}`);

        try {
            // 更新提示词
            if (positive !== undefined) latestPrompts.positive = positive;
            if (negative !== undefined) latestPrompts.negative = negative;
            latestPrompts.timestamp = Date.now();

            // 保存工作流（如果请求中提供了）
            if (workflow) {
                latestWorkflow.workflow = workflow;
                latestWorkflow.timestamp = Date.now();
                console.log('💾 工作流已保存');
            }

            // 检查是否有工作流
            if (!latestWorkflow.workflow) {
                return res.status(400).json({
                    status: 'error',
                    message: '请先导入工作流（从ComfyUI导出API JSON并粘贴到画板）'
                });
            }

            // 深拷贝工作流，避免修改原始对象，并做提交前预处理
            // （移除 LumenLoadWorkflow 占位节点、注入画板取图随机种子）
            let workflowToRun = prepareWorkflowForRun(JSON.parse(JSON.stringify(latestWorkflow.workflow)));

            // 将提示词注入到工作流节点
            workflowToRun = injectPromptsToWorkflow(workflowToRun, positive, negative);

            // 打印最终工作流节点列表（调试用）
            console.log('  📋 最终工作流节点:');
            for (const nodeId in workflowToRun) {
                const node = workflowToRun[nodeId];
                const classType = node.class_type || node.type;
                const inputs = node.inputs || {};
                if (inputs.seed !== undefined) {
                    console.log(`    ${nodeId}: ${classType}, seed=${inputs.seed}`);
                } else if (inputs.text !== undefined) {
                    console.log(`    ${nodeId}: ${classType}, text=${inputs.text.substring(0, 30)}...`);
                } else {
                    console.log(`    ${nodeId}: ${classType}`);
                }
            }

            console.log('📤 提交工作流到 ComfyUI...');

            // 提交与响应校验统一走共享工具（30 秒超时，错误信息含 ComfyUI 校验详情）
            const { promptId } = await submitPromptToComfy(comfyApiUrl, workflowToRun, 'lumen');

            console.log(`✅ [${requestId}] 工作流已启动:`, promptId);
            console.log(`  槽位1图片长度: ${canvasImages[1]?.length || 'null'}, 时间戳: ${canvasImagesTimestamp[1]}`);

            // 检测工作流输出类型（图片/视频）
            const outputType = detectOutputType(workflowToRun);
            console.log(`  📺 输出类型识别为: ${outputType}`);

            res.json({
                status: 'ok',
                promptId: promptId,
                outputType: outputType,
                message: '工作流已启动'
            });

        } catch (error) {
            console.error('❌ 运行失败:', error.message);
            res.status(500).json({
                status: 'error',
                message: error.message
            });
        }
    });

    /**
     * GET /api/comfy-status
     * 检测 ComfyUI 连接状态
     */
    // 记录上一次检测结果，仅状态翻转时打日志。
    // ComfyUI 没开是常态而非错误，前端 10s 轮询一次，若每次失败都记录，
    // 后端日志会被刷成瀑布（还会随控制台落盘持续写盘），故只在
    // 离线→在线 / 在线→离线 两个跳变点各记录一次。
    let lastConnected = null;

    router.get('/comfy-status', async (req, res) => {
        try {
            // 使用 AbortController 设置 3 秒超时
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);

            const response = await fetch(`${comfyApiUrl}/system_stats`, {
                method: 'GET',
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (response.ok) {
                const data = await response.json();
                if (lastConnected !== true) {
                    console.log('ComfyUI 已连接');
                    lastConnected = true;
                }
                res.json({
                    status: 'connected',
                    message: 'ComfyUI 已连接',
                    version: data.version || 'unknown'
                });
            } else {
                throw new Error('ComfyUI 响应异常');
            }
        } catch (error) {
            if (lastConnected !== false) {
                console.log('ComfyUI 未连接（离线期间不再重复提示，重新连上时会记录）');
                lastConnected = false;
            }
            res.json({
                status: 'disconnected',
                message: 'ComfyUI 未连接',
                error: error.message
            });
        }
    });

    return router;
}

module.exports = createComfyRouter;
