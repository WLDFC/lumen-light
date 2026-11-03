/**
 * ==========================================================================
 * LumenLight WebSocket 客户端模块——主类
 * 作用：负责前端与 LumenLight 后端建立 WebSocket 连接，接收 ComfyUI
 *       生成的图片/视频消息回流画布，转发 pi / 网页桥接事件流，并承接
 *       画布桥接命令（pi 等外部 agent 经 /api/canvas-bridge 下发）的
 *       执行与应答回传。
 * 拆分：桥接命令按能力域拆为 api/bridge/ 下四个混入模块（partial-class，
 *       ADR 027）——方法 Object.assign 回本类 prototype，this 即实例：
 *       BridgeState.js  查看/快照（get_state/get_prompts/search_assets）
 *       BridgeMedia.js  媒体（get_image·s/drop_image·video/删除清空/整理
 *                       改名 + WS 回流落画布 addImageToCanvas·addVideoToCanvas）
 *       BridgeGraph.js  节点运维与搭图（node_update·delete·run/
 *                       edge_disconnect/build_graph 三件套）
 *       BridgeView.js   视图/撤销/面板/存档（view_focus/select_set/
 *                       history_step/set_prompts/archive_save）
 *       命令名 → 方法名注册表在本类 static BRIDGE_COMMANDS()，新增命令 =
 *       混入模块加一个 _bridgeXxx 方法 + 注册表加一行。加载顺序：本文件
 *       先于四个混入模块（混入 eval 期 Object.assign 依赖类已定义并挂
 *       window）。
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
     * WS 消息分发（onmessage 委托至此，独立方法便于防护与测试）
     * @param {Object} msg - 已解析的消息对象
     */
    _dispatchWsMessage(msg) {
        // 后端启动标识握手：连接后收到的首条消息。与 localStorage 记录的
        // 上次 bootId 不一致 = 后端已重启而本页面还是旧代码/旧状态，
        // 自动刷新（等效替用户按 F5）。首访无记录只登记不刷新；
        // 刷新后再次握手 bootId 一致，不会循环；普通断线重连 bootId
        // 不变也不会触发。
        if (msg.type === 'hello' && msg.bootId) {
            const stored = localStorage.getItem('lumen.bootId');
            localStorage.setItem('lumen.bootId', msg.bootId);
            if (stored && stored !== msg.bootId) {
                console.log('[LumenSocket] 检测到后端已重启，自动刷新页面');
                window.location.reload();
                return;
            }
        }

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
            let genInfo = null;

            // 在移除占位图之前记录它的位置与生成参数记录，生成图片将
            // 出现在该位置并随图盖章（溯源/生成同款；无占位图消费方——
            // pi 落图/网页桥接/免节点无占位回流——genInfo 为 null，不登记）
            if (window.generationFeedback && window.generationFeedback.placeholders.length > 0) {
                const firstHandle = window.generationFeedback.placeholders[0];
                const firstPlaceholder = firstHandle.imageObj;
                placeholderPosition = {
                    x: firstPlaceholder.x,
                    y: firstPlaceholder.y,
                    width: firstPlaceholder.width,
                    height: firstPlaceholder.height
                };
                genInfo = firstHandle.genInfo || null;
            }

            // 收到生成结果后移除一个最早的生成反馈占位图
            if (window.generationFeedback) {
                window.generationFeedback.hide();
            }
            // 生成图事件（默认落图分支专属——有节点消费的分支已经
            // PlaceholderManager.replace 派发过，不在此重复）。src 补
            // data: 前缀成可用 URL——msg.image 是裸 base64（与下方
            // addImageToCanvas 的入参契约同源，那边同样自己补前缀）。
            // 漫画编辑器委托提交会武装 __mangaGenSuppress（ADR 071 交付
            // 独立）：事件照常派发（编辑器一次性捕获转存项目夹），跳过
            // 落画布；标记一次性消费即清
            const suppressMangaLanding = !!window.__mangaGenSuppress;
            if (suppressMangaLanding) window.__mangaGenSuppress = false;
            window.dispatchEvent(new CustomEvent('lumenGeneratedImage', {
                detail: { src: 'data:image/png;base64,' + msg.image }
            }));
            if (!suppressMangaLanding) {
                this.addImageToCanvas(msg.image, placeholderPosition, msg.prompt, genInfo);
            }
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

        // pi 后台任务上报（后端 /api/tasks 中继）：镜像进任务中心注册表。
        // running=登记、结算=就地 end，按外部 id 幂等（TaskRegistry.mirrorExternal）
        if (msg.type === 'task-event' && msg.task) {
            window.taskRegistry?.mirrorExternal(msg.task);
        }

        // 网页桥接事件流：转发为页面事件供 LLM 窗口的网页桥接气泡消费
        if (msg.type === 'webbridge-event' && msg.event) {
            window.dispatchEvent(new CustomEvent('webbridgeEvent', { detail: msg.event }));
        }
    }

    /**
     * 画布桥接命令处理：执行浏览器侧画布操作并把结果回传给后端
     * （命令清单即"画布对外工具集"，pi / 未来 MCP 的能力来源）
     * @param {{id: string, command: string, params: Object}} msg - 桥接命令
     */
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
     * 桥接命令分发：查注册表转调对应域模块的处理方法（21 条命令的实现
     * 分散在 bridge/ 四个混入模块，本类只留连接/路由/分发壳）
     * @param {string} command - 命令名
     * @param {Object} params - 命令参数
     */
    async _execBridgeCommand(command, params) {
        const handler = LumenSocket.BRIDGE_COMMANDS()[command];
        if (!handler) throw new Error(`未知桥接命令: ${command}`);
        return this[handler](params);
    }

    /**
     * 桥接命令注册表：命令名 → 处理方法名（方法按能力域分散在
     * api/bridge/ 四个混入模块，ADR 027）
     */
    static BRIDGE_COMMANDS() {
        return {
            // 查看/快照（BridgeState）
            get_state: '_bridgeGetState',
            get_prompts: '_bridgeGetPrompts',
            search_assets: '_bridgeSearchAssets',
            // 媒体（BridgeMedia）
            get_image: '_bridgeGetImage',
            get_images: '_bridgeGetImages',
            drop_image: '_bridgeDropImage',
            drop_video: '_bridgeDropVideo',
            clear_media: '_bridgeClearMedia',
            delete_media: '_bridgeDeleteMedia',
            media_arrange: '_bridgeMediaArrange',
            media_rename: '_bridgeMediaRename',
            // 节点运维与搭图（BridgeGraph）
            node_update: '_bridgeNodeUpdate',
            node_delete: '_bridgeNodeDelete',
            node_run: '_bridgeNodeRun',
            edge_disconnect: '_bridgeEdgeDisconnect',
            build_graph: '_bridgeBuildGraph',
            // 视图/撤销/面板/存档（BridgeView）
            view_focus: '_bridgeViewFocus',
            select_set: '_bridgeSelectSet',
            history_step: '_bridgeHistoryStep',
            set_prompts: '_bridgeSetPrompts',
            archive_save: '_bridgeArchiveSave'
        };
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

// 挂到全局对象（混入模块经 window.LumenSocket.prototype 装配命令实现，
// app.js 经词法全局实例化——两者都可用）
window.LumenSocket = LumenSocket;
