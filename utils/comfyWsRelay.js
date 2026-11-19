/**
 * ==========================================================================
 * ComfyUI WebSocket 进度中继（ComfyWsRelay，2026-11-08 新增）
 * ==========================================================================
 * 作用：后端常驻一条到 ComfyUI 的 WebSocket（/ws?clientId=<固定值>），
 * 把 ComfyUI 执行期的进度事件转译成 LumenLight 自家 WS 消息推给画布/面板，
 * 填补「提交→出图」之间的反馈黑洞：
 *   - comfy-progress  采样步数（KSampler 等）：{promptId, value, max, pct, node}
 *   - comfy-preview   KSampler 式实时预览帧（base64 JPEG）：{promptId, image}
 *   - comfy-queue     队列堆积：{remaining}
 *   - generation-failed  执行报错终态：{promptId, message}
 *
 * 关键机制：ComfyUI 的 progress/preview 事件按「提交时的 client_id」定向
 * 回送——所有提交（utils/comfySubmit）统一用本模块的 CLIENT_ID，事件才会
 * 流到这条中继连接上。免节点链路此前各提交各造 client_id，预览永远无人
 * 接收；统一后历史行为不受影响（promptId 照旧返回与追踪）。
 *
 * 二进制帧格式（ComfyUI server send_bytes）：8 字节头 = 事件类型(uint32 BE)
 * + 图像类型(uint32 BE)，其后为图像字节。事件 1 = PREVIEW_IMAGE（采样过程
 * 的潜在空间预览，需 ComfyUI 侧开 --preview-method auto/latent2rgb/taesd），
 * 事件 2 = PROGRESS_BAR（无载荷，忽略）。预览帧不带 promptId——ComfyUI
 * 单卡串行执行，跟随最近一条 progress/executing 的 prompt_id 即可对位。
 *
 * 预览帧节流：每 promptId 最小间隔 500ms（本地 WS 带宽与前端重绘保护）。
 * 断线自动重连（3s 起、10s 封顶退避），ComfyUI 不在线时静默重试——中继
 * 只是增益，生成本身不经过它，断连不影响出图。
 */

const { WebSocket } = require('ws');

/** 统一提交 client_id：与中继 WS 连接的 clientId 同值（见模块头注释） */
const COMFY_RELAY_CLIENT_ID = 'lumen-relay';

/**
 * 向全部已连接的 LumenLight 客户端广播一条 JSON 消息
 * （comfy.js / comfyNode.js 的 canvas 过滤口径同源：单客户端发送失败不阻塞其余）
 * @param {Map} clients - server.js 的 WS 客户端映射 { ws, role, ... }
 * @param {Object} payload - 已组装好的消息体（带 type）
 */
function broadcastToClients(clients, payload) {
    if (!clients) return;
    const text = JSON.stringify(payload);
    for (const client of clients.values()) {
        if (client.ws && client.ws.readyState === 1) {
            try { client.ws.send(text); } catch { /* 单个客户端失败不阻塞其余 */ }
        }
    }
}

class ComfyWsRelay {
    /**
     * @param {Object} opts
     * @param {string} opts.comfyApiUrl - ComfyUI API 地址（http://127.0.0.1:8188）
     * @param {Map} opts.clients - LumenLight WS 客户端映射（转发目标）
     * @param {Function} [opts.log] - 日志（缺省 console）
     */
    constructor({ comfyApiUrl, clients, log } = {}) {
        this.comfyApiUrl = (comfyApiUrl || '').replace(/\/+$/, '');
        this.clients = clients;
        this.log = log || ((...a) => console.log(...a));
        this.ws = null;
        this.currentPromptId = null;   // 最近在跑的 prompt（预览帧归属依据）
        this._lastPreviewAt = new Map();   // promptId → 上次转发预览的时间戳
        this._retryTimer = null;
        this._retryDelay = 3000;
        this._closed = false;
    }

    /** 启动连接（幂等：进程内只起一条） */
    start() {
        if (this._closed || this.ws) return;
        this._connect();
    }

    _connect() {
        const wsUrl = this.comfyApiUrl.replace(/^http/, 'ws') +
            `/ws?clientId=${encodeURIComponent(COMFY_RELAY_CLIENT_ID)}`;
        let ws;
        try {
            ws = new WebSocket(wsUrl);
        } catch (err) {
            this._scheduleReconnect(`创建连接失败：${err.message}`);
            return;
        }
        this.ws = ws;

        ws.on('open', () => {
            this.log(`🔗 [Comfy中继] 已连接 ComfyUI（${this.comfyApiUrl}），进度/预览开始转发`);
            this._retryDelay = 3000;   // 连上即复位退避
        });
        ws.on('message', (data, isBinary) => this._onMessage(data, isBinary));
        ws.on('error', () => { /* close 必随其后，错误只静默（避免刷屏） */ });
        ws.on('close', () => {
            this.ws = null;
            this.currentPromptId = null;
            this._scheduleReconnect('连接断开');
        });
    }

    _scheduleReconnect(reason) {
        if (this._closed || this._retryTimer) return;
        this.log(`🔌 [Comfy中继] ${reason}，${Math.round(this._retryDelay / 1000)}s 后重连`);
        this._retryTimer = setTimeout(() => {
            this._retryTimer = null;
            this._retryDelay = Math.min(this._retryDelay * 2, 10000);
            this._connect();
        }, this._retryDelay);
        if (this._retryTimer.unref) this._retryTimer.unref();   // 不阻塞进程退出
    }

    /** WS 消息分派：二进制=预览帧，文本=JSON 事件 */
    _onMessage(data, isBinary) {
        if (isBinary) {
            this._onBinary(Buffer.isBuffer(data) ? data : Buffer.from(data));
            return;
        }
        let msg = null;
        try { msg = JSON.parse(data.toString('utf-8')); } catch { return; }
        const d = msg && msg.data;
        if (!d) return;
        switch (msg.type) {
            case 'progress':
                // KSampler 类节点的步数推进 {value, max, prompt_id, node}
                if (d.prompt_id) this.currentPromptId = d.prompt_id;
                broadcastToClients(this.clients, {
                    type: 'comfy-progress',
                    promptId: d.prompt_id || this.currentPromptId,
                    value: d.value,
                    max: d.max,
                    pct: d.max > 0 ? d.value / d.max : null,
                    node: d.node || null,
                    timestamp: Date.now()
                });
                break;
            case 'executing':
                // 节点切换（node=null 表示该 prompt 执行完毕）
                if (d.prompt_id) this.currentPromptId = d.prompt_id;
                break;
            case 'execution_error':
                // 执行报错终态：占位图失败态的权威来源（比 history 轮询更快）
                broadcastToClients(this.clients, {
                    type: 'generation-failed',
                    promptId: d.prompt_id || null,
                    message: d.exception_message
                        ? `${d.node_type || d.node_id || 'ComfyUI'}: ${d.exception_message}`
                        : 'ComfyUI 执行失败',
                    timestamp: Date.now()
                });
                break;
            case 'status': {
                const remaining = d.status && d.status.exec_info &&
                    d.status.exec_info.queue_remaining;
                if (remaining !== undefined) {
                    broadcastToClients(this.clients, {
                        type: 'comfy-queue', remaining, timestamp: Date.now()
                    });
                }
                break;
            }
            default:
                break;   // execution_start/success/cached 等暂不消费
        }
    }

    /**
     * 二进制帧解析：8 字节头（事件类型+图像类型，均 uint32 BE）+ 图像字节。
     * 仅转发 PREVIEW_IMAGE(1)；PROGRESS_BAR(2) 无载荷直接忽略
     */
    _onBinary(buf) {
        if (buf.length <= 8) return;
        const eventType = buf.readUInt32BE(0);
        if (eventType !== 1) return;   // 1=PREVIEW_IMAGE, 2=PROGRESS_BAR
        const imageType = buf.readUInt32BE(4);   // 1=JPEG, 2=PNG
        const mime = imageType === 2 ? 'image/png' : 'image/jpeg';
        const promptId = this.currentPromptId;
        if (!promptId) return;   // 未跟踪到在跑的 prompt，预览无处归属

        // 节流：每 promptId 最小 500ms（前端重绘与 WS 带宽保护）
        const now = Date.now();
        const last = this._lastPreviewAt.get(promptId) || 0;
        if (now - last < 500) return;
        this._lastPreviewAt.set(promptId, now);
        if (this._lastPreviewAt.size > 32) {   // 兜底清理：只留最近的
            const keys = [...this._lastPreviewAt.keys()];
            for (const k of keys.slice(0, keys.length - 32)) this._lastPreviewAt.delete(k);
        }

        broadcastToClients(this.clients, {
            type: 'comfy-preview',
            promptId,
            image: `data:${mime};base64,${buf.slice(8).toString('base64')}`,
            timestamp: now
        });
    }

    stop() {
        this._closed = true;
        if (this._retryTimer) clearTimeout(this._retryTimer);
        if (this.ws) try { this.ws.close(); } catch { /* 已断 */ }
    }
}

module.exports = {
    ComfyWsRelay,
    COMFY_RELAY_CLIENT_ID,
    broadcastToClients
};
