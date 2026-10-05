/**
 * ==========================================================================
 * LumenLight WebSocket 客户端模块
 * 作用：负责前端与 LumenLight 后端建立 WebSocket 连接，接收 ComfyUI
 *       生成的图片消息，并将图片添加到画布中。同时提供连接状态更新
 *       和通知提示功能。
 * ==========================================================================
 */

class LumenSocket {
    /**
     * 构造函数
     * @param {Canvas} canvas - 画布实例，用于重绘
     * @param {ImageManager} imageManager - 图片管理器实例，用于添加图片
     */
    constructor(canvas, imageManager) {
        this.canvas = canvas;                  // 画布实例引用
        this.imageManager = imageManager;      // 图片管理器实例引用
        this.ws = null;                        // WebSocket 实例

        // 初始化时立即尝试连接
        this.connect();
    }

    /**
     * 建立 WebSocket 连接并绑定事件处理
     */
    connect() {
        try {
            // 连接到本地后端的 WebSocket 服务
            this.ws = new WebSocket('ws://localhost:8080');

            // 连接成功回调
            this.ws.onopen = () => {
                // 向后端注册当前客户端角色为 canvas
                this.ws.send(JSON.stringify({
                    type: 'register',
                    role: 'canvas',
                    name: 'LumenLight-Canvas'
                }));
                // 派发连接状态页面事件：pi 状态灯等组件重连后重新校正状态
                window.dispatchEvent(new CustomEvent('lumenWsOpen'));

                // 心跳（5s）：让后端持续刷新本客户端的 lastSeen，
                // 桥接命令才能路由到"最近活跃"的标签页；
                // 后端对未知消息类型安全忽略
                if (this._pingTimer) clearInterval(this._pingTimer);
                this._pingTimer = setInterval(() => {
                    if (this.ws.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({
                            type: 'ping',
                            bridgeReceived: this._bridgeReceived || 0
                        }));
                    }
                }, 5000);
            };
            
            // 接收消息回调（JSON.parse 与分发均有防护：单条坏消息
            // 不再中断后续消息处理，避免整条 WS 链路假死）
            this.ws.onmessage = (event) => {
                let msg = null;
                try { msg = JSON.parse(event.data); } catch (err) {
                    console.error('WS 消息 JSON 解析失败:', err.message, String(event.data).slice(0, 120));
                    return;
                }
                try {
                    this._dispatchWsMessage(msg);
                } catch (err) {
                    console.error('WS 消息处理失败:', err);
                }
            };

            // 连接关闭回调
            this.ws.onclose = () => {
                if (this._pingTimer) {
                    clearInterval(this._pingTimer);
                    this._pingTimer = null;
                }
                // 派发断连事件：pi 状态灯等组件据此标记"状态未知"，
                // 避免显示过期状态误导用户
                window.dispatchEvent(new CustomEvent('lumenWsClosed'));
                // 5秒后自动重连
                setTimeout(() => this.connect(), 5000);
            };

        } catch(e) {
        }
    }
    
    /**
     * 添加 ComfyUI 生成的图片到画板
     * @param {string} base64 - 图片的 base64 编码数据（不含 data URL 前缀）
     * @param {Object|null} placeholderPosition - 占位图位置信息 {x, y, width, height}
     * @param {Object|null} prompt - 生成该图片时使用的提示词
     */
    addImageToCanvas(base64, placeholderPosition = null, prompt = null) {
        const img = new Image();

        // 图片加载完成后添加到画布
        img.onload = () => {
            // 一次性回调：添加后立即解绑，
            // 防止后续修改图片 src（如保存后回写存档地址）时重复添加
            img.onload = null;

            let x, y, w, h;

            if (placeholderPosition) {
                // 使用占位图的中心位置，生成图片按自身原始尺寸居中显示
                w = img.width;
                h = img.height;
                x = placeholderPosition.x + placeholderPosition.width / 2 - w / 2;
                y = placeholderPosition.y + placeholderPosition.height / 2 - h / 2;
            } else {
                // 没有占位图时，默认放到当前视口中心
                const cp = this.canvas.viewport.screenToCanvas(
                    this.canvas.cssWidth / 2,
                    this.canvas.cssHeight / 2
                );
                w = img.width;
                h = img.height;
                x = cp.x - w / 2;
                y = cp.y - h / 2;

                // 多图连续落画布（网页桥接一轮回多图等）错开排布：
                // 与已有图片重叠时沿对角线每次偏移 24px，直到让开为止
                const overlaps = (nx, ny, nw, nh) => this.imageManager.images.some(
                    (im) => nx < im.x + im.width && im.x < nx + nw &&
                            ny < im.y + im.height && im.y < ny + nh
                );
                let guard = 0;
                while (guard++ < 100 && overlaps(x, y, w, h)) {
                    x += 24;
                    y += 24;
                }
            }

            // 创建图片对象并添加到图片管理器
            this.imageManager.images.push({
                id: LumenLight.generateId(),    // 生成唯一ID
                img: img,                       // 图片DOM对象
                x: x,                           // x坐标
                y: y,                           // y坐标
                width: w,                       // 图片原始宽度
                height: h,                      // 图片原始高度
                selected: false,                // 默认未选中
                source: 'comfy',                // 来源标记为ComfyUI
                prompt: prompt?.positive || '',
                negativePrompt: prompt?.negative || '',
                created: Date.now()             // 创建时间戳
            });

            // 触发画布重绘
            this.canvas.draw();

            // 显示收到图片的通知
            this.showNotification('生成完成');
        };
        
        // 设置图片源为 base64 编码的 PNG
        img.src = 'data:image/png;base64,' + base64;
    }

    /**
     * 画布桥接命令处理：执行浏览器侧画布操作并把结果回传给后端
     * （命令清单即"画布对外工具集"，pi / 未来 MCP 的能力来源）
     * @param {{id: string, command: string, params: Object}} msg - 桥接命令
     */
        /**
         * WS 消息分发（onmessage 委托至此，独立方法便于防护与测试）
         * @param {Object} msg - 已解析的消息对象
         */
        _dispatchWsMessage(msg) {
// 处理新图片消息
                if (msg.type === 'new-image') {
                    // Comfy 生图节点的定向投递：带 target 的消息路由到
                    // 发起生成的节点占位图（并发多个节点互不串图）。
                    // 目标节点不存在（已删除）时按默认路径落图，避免图片丢失
                    if (msg.target) {
                        const node = this.canvas.images.images.find(
                            (img) => img.id === msg.target &&
                                     typeof img.receiveGeneratedImage === 'function'
                        );
                        if (node) {
                            node.receiveGeneratedImage(msg.image, msg.prompt);
                            return;
                        }
                    }

                    // 无 target 的兜底路由：ComfyUI 侧 lumen_nodes 未同步
                    // （旧版 Python 节点不回传 lumen_target）时，图片交给
                    // 正在生成中的 Comfy 生图节点，占位图才有人消费；
                    // 没有节点在生成则走默认落图（提示词面板流程不受影响）
                    const genNode = this.canvas.images.images.find(
                        (img) => NodeTypes.isComfyGenNode(img.source) && img.isGenerating &&
                                 typeof img.receiveGeneratedImage === 'function'
                    );
                    if (genNode) {
                        genNode.receiveGeneratedImage(msg.image, msg.prompt);
                        return;
                    }

                    let placeholderPosition = null;

                    // 在移除占位图之前记录它的位置，生成图片将出现在该位置
                    if (window.generationFeedback && window.generationFeedback.placeholders.length > 0) {
                        const firstPlaceholder = window.generationFeedback.placeholders[0].imageObj;
                        placeholderPosition = {
                            x: firstPlaceholder.x,
                            y: firstPlaceholder.y,
                            width: firstPlaceholder.width,
                            height: firstPlaceholder.height
                        };
                    }

                    // 收到生成结果后移除一个最早的生成反馈占位图
                    if (window.generationFeedback) {
                        window.generationFeedback.hide();
                    }
                    this.addImageToCanvas(msg.image, placeholderPosition, msg.prompt);
                }

                // 处理新视频消息（ComfyUI 视频工作流经 LumenSendVideoToCanvas 上传）
                if (msg.type === 'new-video' && msg.videoUrl) {
                    // 诊断日志：视频回流有三层（WS 到达 → target 节点消费 →
                    // 兜底落画布），占位图未被消费时靠这行定位断在哪层
                    console.log(`[回流] new-video 到达 target=${msg.target || '无'} url=${msg.videoUrl}`);

                    // 定向投递：带 target 的消息（RunningHub 云端工作流回流）
                    // 路由到发起生成的节点（视频落占位图中心）；目标节点
                    // 不存在（已删除/页面刷新过）时按默认路径落画布，视频不丢
                    if (msg.target) {
                        const node = this.canvas.images.images.find(
                            (img) => img.id === msg.target &&
                                     typeof img.receiveGeneratedVideo === 'function'
                        );
                        if (node) {
                            console.log(`[回流] new-video 定向到节点 ${msg.target}（receiveGeneratedVideo）`);
                            node.receiveGeneratedVideo(msg.videoUrl, msg.prompt);
                            return;
                        }
                        console.warn(`[回流] new-video 目标节点 ${msg.target} 不存在（页面刷新过/已删除），走兜底落画布`);
                    }
                    this.addVideoToCanvas(msg.videoUrl, msg.prompt);
                }

                // 处理生成失败消息（RunningHub 云端任务失败，带 target 定向通知
                // 节点清占位图并复位；无 target 或目标已删除时忽略）
                if (msg.type === 'generation-failed' && msg.target) {
                    const failedNode = this.canvas.images.images.find(
                        (img) => img.id === msg.target &&
                                 typeof img.onGenerationFailed === 'function'
                    );
                    if (failedNode) {
                        failedNode.onGenerationFailed(msg.message || '未知错误');
                    }
                }

                // 处理生成完成消息（RunningHub 云端任务的全部结果已推完，带 target
                // 定向通知节点复位生成态——产出数量不可知，完成只能由后端判定，
                // 前端计数会在首个结果就复位导致后续结果被丢弃）
                if (msg.type === 'generation-complete' && msg.target) {
                    const doneNode = this.canvas.images.images.find(
                        (img) => img.id === msg.target &&
                                 typeof img.onGenerationComplete === 'function'
                    );
                    if (doneNode) {
                        doneNode.onGenerationComplete();
                    }
                }

                // 处理画布桥接命令（pi 等外部 agent 经 /api/canvas-bridge 下发）
                if (msg.type === 'bridge-command' && msg.id) {
                    this.handleBridgeCommand(msg);
                }

                // pi 智能体事件流：转发为页面事件供 LLM 窗口的流式气泡消费
                if (msg.type === 'pi-event' && msg.event) {
                    window.dispatchEvent(new CustomEvent('piEvent', { detail: msg.event }));
                }

                // 网页桥接事件流：转发为页面事件供 LLM 窗口的网页桥接气泡消费
                if (msg.type === 'webbridge-event' && msg.event) {
                    window.dispatchEvent(new CustomEvent('webbridgeEvent', { detail: msg.event }));
                }
            
        }

            

    async handleBridgeCommand(msg) {
        const { id, command, params = {} } = msg;
        this._bridgeReceived = (this._bridgeReceived || 0) + 1;
        let ok = true, data = null, error = null;

        // 分阶段耗时诊断：页面"假死"（UI 可点但请求全挂）历来难以定位，
        // 这里把执行耗时与应答回传耗时分开记录——
        // 执行慢 = 主线程被占；回传慢 = 同源连接池拥塞
        const tRecv = Date.now();

        // 执行看门狗：执行器卡死时 25s 内必回超时应答（不让 pi 干等 30s+），
        // 并把卡死暴露到控制台
        let timedOut = false;
        const watchdog = setTimeout(() => {
            timedOut = true;
            console.error(`桥接命令 ${command} (id=${id}) 执行超过 25 秒未完成`);
            fetch('/api/canvas-bridge/response', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, ok: false, error: '浏览器执行超时（25 秒未完成）' })
            }).catch(() => {});
        }, 25000);

        try {
            data = await this._execBridgeCommand(command, params);
        } catch (err) {
            ok = false;
            error = err.message || String(err);
            console.error(`桥接命令 ${command} 执行失败:`, err);
        }
        clearTimeout(watchdog);
        const execMs = Date.now() - tRecv;
        if (execMs > 3000) {
            console.warn(`桥接命令 ${command} 执行耗时 ${execMs}ms（主线程被长任务占用？）`);
        }
        if (timedOut) return;   // 看门狗已应答过，不再重复

        const tSend = Date.now();
        try {
            await fetch('/api/canvas-bridge/response', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, ok, data, error })
            });
        } catch (err) {
            console.error('回传桥接结果失败:', err);
        }
        const sendMs = Date.now() - tSend;
        if (sendMs > 3000) {
            console.warn(`桥接命令 ${command} 应答回传耗时 ${sendMs}ms（同源连接池拥塞？检查是否有挂起的 HTTP 请求）`);
        }
    }

    /**
     * 桥接命令分发。命令即画布对外暴露的原子工具：
     *   - get_state   ：画布状态快照（图片/视频清单、选中列表、节点数、视口、提示词、存档名）
     *   - get_image   ：取一张画布图片的 base64（params: {name?} 或 {index?}，
     *                    均缺省时优先取当前选中的图片）
     *   - drop_image  ：落一张图（params: {dataUrl?|url?, name?, x?, y?}——
     *                    dataUrl 为 base64 数据，url 为公网图片直链（经后端
     *                    同源代理取图，base64 不进 agent 上下文）；缺省落视口中心）
     *   - drop_video  ：落一个视频（params: {videoPath, name?, x?, y?}——
     *                    videoPath 为 data/videos/ 工作区相对路径，pi 视频任务
     *                    完成后由后端下载落盘，此处直接引用不二次上传）
     *   - get_prompts ：读取正面/负面提示词
     * @param {string} command - 命令名
     * @param {Object} params - 命令参数
     */
    async _execBridgeCommand(command, params) {
        const c = this.canvas;

        if (command === 'get_state') {
            const media = c.images.images
                .filter(img => !NodeTypes.isPanelNode(img.source) && !NodeTypes.isPlaceholder(img.source))
                .map((img, index) => ({
                    index,
                    id: img.id,
                    name: img.name || '',
                    type: NodeTypes.isVideo(img.source) ? 'video' : 'image',
                    x: Math.round(img.x), y: Math.round(img.y),
                    width: Math.round(img.width), height: Math.round(img.height)
                }));
            // 当前选中的图片（ImageManager.selectedIds 维护，多选有序）：
            // agent 据此知道用户正在操作哪些图，配合 get_image 的 name/index
            // 参数即可对"选中的那张"做后续处理
            const selected = c.images.getSelected().map((img) => ({
                index: c.images.images
                    .filter(m => !NodeTypes.isPanelNode(m.source) && !NodeTypes.isPlaceholder(m.source))
                    .indexOf(img),
                id: img.id,
                name: img.name || ''
            })).filter(s => s.index >= 0);
            // DOM 节点清单（提示词/文本/LoRA/三类生图节点）：agent 搭建或
            // 修改节点工作流前需要知道现有节点的 id/类型/内容/位置
            const nodes = c.images.images
                .filter(img => NodeTypes.isPanelNode(img.source))
                .map(n => ({
                    id: n.id,
                    type: n.source,
                    x: Math.round(n.x), y: Math.round(n.y),
                    width: Math.round(n.width), height: Math.round(n.height),
                    ...(NodeTypes.isPromptNode(n.source) || NodeTypes.isTextNode(n.source))
                        ? { text: n.text || '' } : {},
                    ...(n.workflowId ? { workflowId: n.workflowId } : {}),
                    ...(n.count ? { count: n.count } : {}),
                    ...(NodeTypes.isLoraNode(n.source) ? {
                        loraFiles: (n.entries || []).filter(e => e.file).map(e => e.file)
                    } : {})
                }));
            return {
                // selected 放最前：这是 agent 判断"用户正在操作哪张图"的关键
                // 信息，媒体清单可能很长（实测 14KB+），靠前放置保证长结果
                // 下也不易被截断遗漏
                selected,
                archive: window.saveManager?.currentSave || null,
                viewport: {
                    scale: c.viewport.scale,
                    offsetX: Math.round(c.viewport.offsetX),
                    offsetY: Math.round(c.viewport.offsetY)
                },
                prompts: window.promptInputManager?.getPrompts() || { positive: '', negative: '' },
                nodes,
                media
            };
        }

        if (command === 'get_prompts') {
            return window.promptInputManager?.getPrompts() || { positive: '', negative: '' };
        }

        if (command === 'get_image') {
            const media = c.images.images
                .filter(img => !NodeTypes.isPanelNode(img.source) &&
                               !NodeTypes.isPlaceholder(img.source) &&
                               !NodeTypes.isVideo(img.source));
            let target = null;
            if (params.name) {
                target = media.find(img => (img.name || '') === params.name);
            } else if (params.index !== undefined) {
                target = media[params.index];
            } else {
                // 无参数：优先取当前选中的图片（用户正在操作的那张），
                // 未选中任何图片时回落第一张
                const sel = c.images.getSelected().find(
                    img => !NodeTypes.isVideo(img.source));
                target = sel || media[0];
            }
            if (!target) throw new Error('未找到指定的画布图片');
            return await this._imageToBase64(target);
        }

        if (command === 'get_images') {
            // 多图取用（供 agent 对比选图）：按 names 数组或前 limit 张
            const media = c.images.images
                .filter(img => !NodeTypes.isPanelNode(img.source) &&
                               !NodeTypes.isPlaceholder(img.source) &&
                               !NodeTypes.isVideo(img.source));
            let selected = media;
            if (Array.isArray(params.names) && params.names.length > 0) {
                selected = params.names
                    .map((n) => media.find((img) => (img.name || '') === n))
                    .filter(Boolean);
            } else {
                const limit = Math.max(1, Math.min(8, parseInt(params.limit, 10) || 4));
                selected = media.slice(0, limit);
            }
            if (selected.length === 0) throw new Error('画布上没有图片');
            return { images: await Promise.all(selected.map((img) => this._imageToBase64(img))) };
        }

        if (command === 'search_assets') {
            // 资产库检索：在已加载的标签网格缓存中按名称子串匹配
            const lib = window.assetLibrary;
            if (!lib) throw new Error('资产库未初始化');
            const keyword = (params.keyword || '').toLowerCase();
            const results = [];
            for (const [tagName, entry] of lib._gridCache) {
                for (const f of entry.files) {
                    if (!keyword || f.name.toLowerCase().includes(keyword)) {
                        results.push({
                            tag: tagName,
                            name: f.name,
                            type: CanvasVideoManager.isVideoFile(f) ? 'video' : 'image'
                        });
                    }
                }
            }
            return { keyword, count: results.length, results: results.slice(0, 50) };
        }

        if (command === 'clear_media') {
            // 批量清空：删除画布上全部图片/视频（面板节点与占位图不受影响）。
            // 供 agent 一条命令完成"清空画布"，避免逐张循环
            const targets = c.images.images.filter(img =>
                !NodeTypes.isPanelNode(img.source) &&
                !NodeTypes.isPlaceholder(img.source));
            // 撤销记账：agent 批量清除可回退（误清救回）
            c.history?.deleteObjects(targets, [], { label: '清空画布' });
            c.draw();
            return { deleted: targets.length };
        }

        if (command === 'delete_media') {
            if (!params.name) throw new Error('缺少 name');
            const targets = c.images.images.filter(img =>
                !NodeTypes.isPanelNode(img.source) &&
                !NodeTypes.isPlaceholder(img.source) &&
                (img.name || '') === params.name);
            if (targets.length === 0) throw new Error(`未找到名为「${params.name}」的画布对象`);
            c.history?.deleteObjects(targets, [], { label: '删除对象' });
            c.draw();
            return { deleted: targets.length };
        }

        if (command === 'drop_image') {
            // 图片来源二选一：dataUrl（pi 自带 base64，如画布取图回传）或
            // url（搜图直链——浏览器经后端同源代理 /api/llm/download-image
            // 取字节，避开 CORS，且 base64 全程不进 agent 上下文）
            let dataUrl = params.dataUrl;
            if (!dataUrl && params.url) {
                const proxyUrl = '/api/llm/download-image?url=' +
                    encodeURIComponent(params.url) +
                    '&filename=' + encodeURIComponent(params.name || 'bridge-image');
                const resp = await fetch(proxyUrl);
                if (!resp.ok) {
                    throw new Error(`取图失败：HTTP ${resp.status}（${params.url}）`);
                }
                const blob = await resp.blob();
                if (!blob.size) throw new Error('取图失败：内容为空');
                // 代理返回的 Content-Type 不可信（可能是 octet-stream）：
                // 非 image/* 时按魔数嗅探重写——声明错 mime 会让 <img> 拒绝解码
                let mime = (blob.type || '').startsWith('image/') ? blob.type : null;
                if (!mime) {
                    const head = await blob.slice(0, 16).arrayBuffer();
                    mime = window.ImageExport?.sniffImageMime?.(head) || null;
                }
                if (!mime) throw new Error(`该地址不是可识别的图片格式（${params.url}）`);
                dataUrl = await window.ImageExport.blobToDataUrl(blob, mime);
            }
            if (!dataUrl) throw new Error('缺少图片来源：dataUrl 与 url 至少提供一个');
            const img = new Image();
            await new Promise((resolve, reject) => {
                img.onload = () => resolve();
                img.onerror = () => reject(new Error('图片数据无法解码'));
                // 用上文解析出的 dataUrl（url 模式下来自代理下载，非 params 原值）
                img.src = dataUrl;
            });
            // 缺省落点：当前视口中心
            const dpr = c.dpr || 1;
            let x = params.x, y = params.y;
            if (x === undefined || y === undefined) {
                x = (-c.viewport.offsetX + c.canvas.width / 2 / dpr) / c.viewport.scale;
                y = (-c.viewport.offsetY + c.canvas.height / 2 / dpr) / c.viewport.scale;
                x -= img.naturalWidth / 2;
                y -= img.naturalHeight / 2;
            }
            const obj = c.images.addImage({
                img,
                x, y,
                width: img.naturalWidth,
                height: img.naturalHeight,
                source: 'bridge',
                name: params.name || `bridge_${Date.now()}.png`
            });
            c.draw();
            return { id: obj.id, name: obj.name };
        }

        if (command === 'drop_video') {
            // 落视频到画布：videoPath 为后端视频工作区的相对路径
            // （如 data/videos/video_xxx.mp4——pi 视频任务完成后已由后端
            // 下载落盘，这里直接引用，不再二次上传）。只接受工作区路径，
            // 防止借命令探测任意文件
            const videoPath = String(params.videoPath || '');
            if (!/^data\/videos\/[\w.\-\u4e00-\u9fff]+$/.test(videoPath)) {
                throw new Error(`非法的 videoPath：${videoPath}（须为 data/videos/ 下的文件）`);
            }
            if (!c.videoManager) throw new Error('视频管理器未初始化');
            const opts = {};
            if (params.name) opts.name = params.name;
            if (params.x !== undefined && params.y !== undefined) {
                opts.x = params.x;
                opts.y = params.y;
            }
            const obj = await c.videoManager.addVideo('/' + videoPath, opts);
            c.draw();
            return { id: obj.id, name: obj.name };
        }

        if (command === 'build_graph') {
            return this._execBuildGraph(params);
        }

        throw new Error(`未知桥接命令: ${command}`);
    }

    /**
     * build_graph 节点类型表：桥接入参类型名 → 创建器与布局默认几何。
     * 创建复用各节点类的存档恢复契约（与 ProjectSerializer.restoreNodes
     * 同一构造路径），保证 agent 建出的节点与手建/存档恢复的完全同构
     */
    static BUILD_NODE_TYPES() {
        const clampCount = (v) => {
            const n = parseInt(v, 10);
            return Number.isFinite(n) ? Math.max(1, Math.min(9999, n)) : undefined;
        };
        return {
            prompt: {
                w: PromptNode.DEFAULT_WIDTH, h: PromptNode.DEFAULT_HEIGHT,
                create: (d, c) => new PromptNode(c, d.x, d.y, (d.n.text || '').trim(),
                    { width: d.width, height: d.height })
            },
            text: {
                w: TextNode.DEFAULT_WIDTH, h: TextNode.DEFAULT_HEIGHT,
                create: (d, c) => new TextNode(c, d.x, d.y, (d.n.text || ''),
                    { width: d.width, height: d.height })
            },
            lora: {
                w: LoraNode.DEFAULT_WIDTH, h: LoraNode.DEFAULT_HEIGHT,
                create: (d, c) => new LoraNode(c, d.x, d.y, {
                    width: d.width, height: d.height,
                    entries: (Array.isArray(d.n.entries) ? d.n.entries : []).map(e => ({
                        id: LumenLight.generateId(),
                        file: e.file || '',
                        strengthModel: Number.isFinite(+e.strengthModel) ? +e.strengthModel : 1,
                        strengthClip: Number.isFinite(+e.strengthClip) ? +e.strengthClip : 1
                    }))
                })
            },
            image_gen: {
                w: ImageGenNode.DEFAULT_WIDTH, h: ImageGenNode.DEFAULT_HEIGHT,
                create: (d, c) => new ImageGenNode(c, d.x, d.y, {
                    width: d.width, height: d.height,
                    model: d.n.model, ratio: d.n.ratio, tier: d.n.tier,
                    quality: d.n.quality, count: clampCount(d.n.count)
                })
            },
            comfy_gen: {
                w: ComfyGenNode.DEFAULT_WIDTH, h: ComfyGenNode.DEFAULT_HEIGHT,
                create: (d, c) => new ComfyGenNode(c, d.x, d.y, {
                    width: d.width, height: d.height,
                    workflowId: d.n.workflowId, count: clampCount(d.n.count),
                    loraEnabled: d.n.loraEnabled, steps: d.n.steps, cfg: d.n.cfg,
                    sampler: d.n.sampler, sizeW: d.n.sizeW, sizeH: d.n.sizeH,
                    denoise: d.n.denoise
                })
            },
            runhub_gen: {
                w: RunningHubGenNode.DEFAULT_WIDTH, h: RunningHubGenNode.DEFAULT_HEIGHT,
                create: (d, c) => new RunningHubGenNode(c, d.x, d.y, {
                    width: d.width, height: d.height,
                    workflowId: d.n.workflowId, values: d.n.values,
                    count: clampCount(d.n.count)
                })
            }
        };
    }

    /**
     * build_graph 命令：一次性创建多个画布节点并按 edges 连线，返回创建
     * 清单与失败连线明细（无效连线逐条报告，不中断已有效的创建/连线）。
     * 数据流方向：提示词/LoRA → 生图节点（与画布拖拽连线同一套规则，
     * CanvasConnections.isValidLink 校验）。
     * @param {Object} params - { nodes: [{id?, type, x?, y?, width?, height?, ...props}],
     *                           edges: [{from, to}] }
     */
    async _execBuildGraph(params) {
        const c = this.canvas;
        const input = Array.isArray(params?.nodes) ? params.nodes : [];
        const edges = Array.isArray(params?.edges) ? params.edges : [];
        if (input.length === 0) throw new Error('缺少 nodes 数组');
        if (input.length > 20) throw new Error('单次最多创建 20 个节点，更大规模请分批搭建');

        // ===== 1. 规范化定义（类型白名单 + 引用名唯一） =====
        const TYPE_DEFS = LumenSocket.BUILD_NODE_TYPES();
        const defs = [];
        const refSet = new Set();
        input.forEach((n, i) => {
            if (!n || typeof n !== 'object') throw new Error(`nodes[${i}] 不是对象`);
            const def = TYPE_DEFS[n.type];
            if (!def) {
                throw new Error(`nodes[${i}].type「${n.type}」无效，可用类型: ${Object.keys(TYPE_DEFS).join(' / ')}`);
            }
            const ref = String(n.id || `n${i + 1}`).trim();
            if (refSet.has(ref)) throw new Error(`节点引用名「${ref}」重复`);
            refSet.add(ref);
            defs.push({
                ref, type: n.type, def, n,
                x: Number.isFinite(n.x) ? n.x : undefined,
                y: Number.isFinite(n.y) ? n.y : undefined,
                width: Number.isFinite(n.width) ? n.width : undefined,
                height: Number.isFinite(n.height) ? n.height : undefined
            });
        });

        // ===== 2. 工作流引用预校验（任何节点创建前拦截，给出可用清单） =====
        await this._validateWorkflowRefs(defs);

        // ===== 3. 布局：缺坐标的节点按连线深度自动分层 =====
        this._layoutGraphNodes(defs, edges, c);

        // ===== 4. 创建节点 =====
        const refToId = new Map();
        const created = [];
        for (const d of defs) {
            const node = d.def.create(d, c);
            c.images.images.push(node);
            refToId.set(d.ref, node.id);
            created.push({
                ref: d.ref, id: node.id, type: d.type,
                x: Math.round(node.x), y: Math.round(node.y),
                width: Math.round(node.width), height: Math.round(node.height)
            });
        }

        // ===== 5. 连线：端点优先按本次引用名解析，其余按画布对象 id（可连接到既有节点） =====
        const failedEdges = [];
        for (const e of edges) {
            const fail = (reason) => failedEdges.push({ from: e.from, to: e.to, reason });
            const fromId = refToId.get(e.from) || e.from;
            const toId = refToId.get(e.to) || e.to;
            const fromObj = c.images.images.find(img => img.id === fromId);
            const toObj = c.images.images.find(img => img.id === toId);
            if (!fromObj || !toObj) { fail('端点不存在（引用名或画布节点 id 无效）'); continue; }
            if (!CanvasConnections.isValidLink(fromObj, toObj)) {
                fail('连线规则不允许（提示词/LoRA→提示词/LoRA/生图；生图节点无输出端口）');
                continue;
            }
            if (!c.connections.add(fromId, toId)) fail('重复连线（同一对端点已连接）');
        }

        c.draw();
        return {
            created,
            connected: edges.length - failedEdges.length,
            failedEdges
        };
    }

    /**
     * build_graph 的工作流引用预校验：comfy_gen 校验本地工作流清单、
     * runhub_gen 校验登记卡清单。清单接口不可达时跳过校验（节点自身
     * 对无效 id 有回退行为），校验失败则在任何创建发生前抛出可读错误
     * @param {Array} defs - 规范化节点定义
     */
    async _validateWorkflowRefs(defs) {
        const comfy = defs.filter(d => d.type === 'comfy_gen' && d.n.workflowId);
        if (comfy.length) {
            try {
                const res = await fetch('/api/workflows');
                const json = await res.json();
                const valid = new Set((json.workflows || []).map(w => String(w.id)));
                if (valid.size) {
                    for (const d of comfy) {
                        if (!valid.has(String(d.n.workflowId))) {
                            throw new Error(
                                `comfy_gen「${d.ref}」的 workflowId「${d.n.workflowId}」不存在，可用: ${[...valid].join(', ')}`);
                        }
                    }
                }
            } catch (err) {
                if (err.message && err.message.includes('workflowId')) throw err;
                // 清单接口失败：跳过校验，交由节点自身的回退逻辑处理
            }
        }
        const rh = defs.filter(d => d.type === 'runhub_gen' && d.n.workflowId);
        if (rh.length) {
            try {
                const res = await fetch('/api/runninghub/workflows');
                const json = await res.json();
                const valid = new Set((json.workflows || []).map(w => String(w.id)));
                if (valid.size) {
                    for (const d of rh) {
                        const wid = String(d.n.workflowId);
                        if (!valid.has(wid)) {
                            throw new Error(
                                `runhub_gen「${d.ref}」的 workflowId「${d.n.workflowId}」不在登记卡中，可用: ${[...valid].join(', ')}`);
                        }
                    }
                }
            } catch (err) {
                if (err.message && err.message.includes('workflowId')) throw err;
            }
        }
    }

    /**
     * build_graph 的自动布局：显式给了 x/y 的节点原样保留；缺坐标的节点
     * 按新建节点之间引用边的最长路径分层（列=深度，行=同列堆叠），整体
     * 居中于当前视口。引用边成环时抛错拒绝布局
     * @param {Array} defs - 规范化节点定义（布局结果直接写回 d.x/d.y）
     * @param {Array} edges - 连线定义 [{from, to}]
     */
    _layoutGraphNodes(defs, edges, c) {
        if (defs.every(d => d.x !== undefined && d.y !== undefined)) return;
        const auto = defs.filter(d => d.x === undefined || d.y === undefined);

        // 最长路径分层（松弛迭代，上限节点数次；未收敛 = 有环）
        const depth = new Map(auto.map(d => [d.ref, 0]));
        const refSet = new Set(auto.map(d => d.ref));
        const rel = edges
            .filter(e => refSet.has(e.from) && refSet.has(e.to))
            .map(e => [e.from, e.to]);
        for (let i = 0; i < auto.length; i++) {
            let changed = false;
            for (const [f, t] of rel) {
                if (depth.get(t) < depth.get(f) + 1) {
                    depth.set(t, depth.get(f) + 1);
                    changed = true;
                }
            }
            if (!changed) break;
            if (i === auto.length - 1) throw new Error('edges 在新建节点之间形成环，无法布局');
        }

        // 分列（深度→列，列号连续），列内纵向堆叠、各列纵向居中，整体锚定视口中心
        const cols = [];
        for (const d of auto) {
            const k = depth.get(d.ref);
            (cols[k] = cols[k] || []).push(d);
        }
        const GAP_X = 80, GAP_Y = 40;
        const compact = cols.filter(Boolean);
        const colW = compact.map(col => Math.max(...col.map(d => d.width || d.def.w)));
        const colStackH = compact.map(col =>
            col.reduce((a, d) => a + (d.height || d.def.h), 0) + GAP_Y * (col.length - 1));
        const totalW = colW.reduce((a, b) => a + b, 0) + GAP_X * (compact.length - 1);
        const dpr = c.dpr || 1;
        const centerX = (-c.viewport.offsetX + c.canvas.width / 2 / dpr) / c.viewport.scale;
        const centerY = (-c.viewport.offsetY + c.canvas.height / 2 / dpr) / c.viewport.scale;
        let x = centerX - totalW / 2;
        for (let k = 0; k < compact.length; k++) {
            let y = centerY - colStackH[k] / 2;
            for (const d of compact[k]) {
                d.x = x;
                d.y = y;
                y += (d.height || d.def.h) + GAP_Y;
            }
            x += colW[k] + GAP_X;
        }
    }

    /**
     * 画布图片对象 → PNG base64 信息（get_image / get_images 共用）。
     * 无论 src 是 data: 还是 http:，都从内存位图重绘导出，保证自包含。
     * 所见即所得：有编辑笔迹时先合成原图+笔迹（重绘说明随图可见，
     * 与 ImageManager.getCompositeSrc 同源），无笔迹/合成失败沿用内存位图
     * @param {Object} target - 画布图片对象
     */
    async _imageToBase64(target) {
        let img = target.img;
        const composite = this.canvas.images.getCompositeSrc(target);
        if (composite !== target.img.src) {
            // 有笔迹（返回了合成 data URL）：加载合成结果再导出
            img = await new Promise((resolve, reject) => {
                const im = new Image();
                im.onload = () => resolve(im);
                im.onerror = () => reject(new Error('合成图（原图+笔迹）加载失败'));
                im.src = composite;
            });
        }
        const cnv = document.createElement('canvas');
        cnv.width = img.naturalWidth;
        cnv.height = img.naturalHeight;
        cnv.getContext('2d').drawImage(img, 0, 0);
        const dataUrl = cnv.toDataURL('image/png');
        return {
            name: target.name || '',
            width: img.naturalWidth,
            height: img.naturalHeight,
            base64: dataUrl.split(',')[1],
            mediaType: 'image/png'
        };
    }

    /**
     * 添加 ComfyUI 生成的视频到画板（委托给 CanvasVideoManager，
     * 画布上以首帧封面展示，双击打开播放器）
     * @param {string} videoUrl - 视频地址（后端 data/videos 下的相对路径）
     * @param {Object|null} prompt - 生成该视频时使用的提示词
     */
    addVideoToCanvas(videoUrl, prompt = null) {
        const videoManager = this.canvas.videoManager;
        if (!videoManager) {
            console.error('画布视频管理器未初始化，无法落视频');
            return;
        }

        // 有生成反馈占位图时按占位图中心落视频并消费一个占位
        let centerX, centerY;
        if (window.generationFeedback && window.generationFeedback.placeholders.length > 0) {
            const first = window.generationFeedback.placeholders[0].imageObj;
            centerX = first.x + first.width / 2;
            centerY = first.y + first.height / 2;
            window.generationFeedback.hide();
        }

        videoManager.addVideo('/' + String(videoUrl).replace(/^\//, ''), {
            prompt: prompt?.positive || '',
            name: String(videoUrl).split('/').pop(),
            ...(centerX !== undefined ? { centerX, centerY } : {})
        }).then(() => {
            this.showNotification('视频已生成');
        }).catch((err) => {
            console.error('添加视频到画布失败:', err);
            this.showNotification('视频落画布失败', 4000);
        });
    }
    
    /**
     * 显示顶部通知提示（多条通知纵向堆叠，避免相互遮挡）
     * @param {string} text - 通知文本内容
     * @param {number} [duration=2000] - 停留时长（毫秒），到时开始淡出
     */
    showNotification(text, duration = 2000) {
        // 创建通知元素；按当前存活数量向下偏移，实现堆叠
        const div = document.createElement('div');
        div.className = 'lumen-notification';
        div.textContent = text;
        const offset = document.querySelectorAll('.lumen-notification').length;
        div.style.cssText = `
            position: fixed;
            top: ${80 + offset * 48}px;
            left: 50%;
            transform: translateX(-50%);
            background: var(--accent);
            color: white;
            padding: 10px 20px;
            border-radius: 20px;
            z-index: 10000;
            font-size: 14px;
            transition: opacity 0.3s;
            animation: fadeIn 0.3s;
        `;
        document.body.appendChild(div);

        // 到时开始淡出，淡出动画完成后移除元素
        setTimeout(() => {
            div.style.opacity = '0';
            setTimeout(() => div.remove(), 300);
        }, duration);
    }
}
