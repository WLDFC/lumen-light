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
                    this.addVideoToCanvas(msg.videoUrl, msg.prompt);
                }

                // 处理画布桥接命令（pi 等外部 agent 经 /api/canvas-bridge 下发）
                if (msg.type === 'bridge-command' && msg.id) {
                    this.handleBridgeCommand(msg);
                }

                // pi 智能体事件流：转发为页面事件供 LLM 窗口的流式气泡消费
                if (msg.type === 'pi-event' && msg.event) {
                    window.dispatchEvent(new CustomEvent('piEvent', { detail: msg.event }));
                }
            
        }

            

    async handleBridgeCommand(msg) {
        const { id, command, params = {} } = msg;
        this._bridgeReceived = (this._bridgeReceived || 0) + 1;
        let ok = true, data = null, error = null;

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
        if (timedOut) return;   // 看门狗已应答过，不再重复

        try {
            await fetch('/api/canvas-bridge/response', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, ok, data, error })
            });
        } catch (err) {
            console.error('回传桥接结果失败:', err);
        }
    }

    /**
     * 桥接命令分发。命令即画布对外暴露的原子工具：
     *   - get_state   ：画布状态快照（图片/视频清单、节点数、视口、提示词、存档名）
     *   - get_image   ：取一张画布图片的 base64（params: {name?} 或 {index?}）
     *   - drop_image  ：落一张图（params: {dataUrl, name?, x?, y?}，缺省落视口中心）
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
            return {
                archive: window.saveManager?.currentSave || null,
                viewport: {
                    scale: c.viewport.scale,
                    offsetX: Math.round(c.viewport.offsetX),
                    offsetY: Math.round(c.viewport.offsetY)
                },
                prompts: window.promptInputManager?.getPrompts() || { positive: '', negative: '' },
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
                target = media[0];
            }
            if (!target) throw new Error('未找到指定的画布图片');
            return this._imageToBase64(target);
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
            return { images: selected.map((img) => this._imageToBase64(img)) };
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
            for (const t of targets) c.images.delete(t.id);
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
            for (const t of targets) c.images.delete(t.id);
            c.draw();
            return { deleted: targets.length };
        }

        if (command === 'drop_image') {
            if (!params.dataUrl) throw new Error('缺少 dataUrl');
            const img = new Image();
            await new Promise((resolve, reject) => {
                img.onload = () => resolve();
                img.onerror = () => reject(new Error('图片数据无法解码'));
                img.src = params.dataUrl;
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

        throw new Error(`未知桥接命令: ${command}`);
    }

    /**
     * 画布图片对象 → PNG base64 信息（get_image / get_images 共用）。
     * 无论 src 是 data: 还是 http:，都从内存位图重绘导出，保证自包含
     * @param {Object} target - 画布图片对象
     */
    _imageToBase64(target) {
        const cnv = document.createElement('canvas');
        cnv.width = target.img.naturalWidth;
        cnv.height = target.img.naturalHeight;
        cnv.getContext('2d').drawImage(target.img, 0, 0);
        const dataUrl = cnv.toDataURL('image/png');
        return {
            name: target.name || '',
            width: target.img.naturalWidth,
            height: target.img.naturalHeight,
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
