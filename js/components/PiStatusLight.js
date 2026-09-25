/**
 * ==========================================================================
 * LumenLight pi 智能体健康状态灯（PiStatusLight）
 * ==========================================================================
 * 作用：右侧面板头部（模式选择器右侧、紧贴下拉框）实时显示 pi RPC 子进程
 *       的健康状态，把"pi 执行中崩溃/卡死"从黑盒变成一眼可见：
 *   - 灰 idle    ：pi 未运行（从未用过或已彻底停止）
 *   - 绿 ok      ：进程存活且最近有事件活动（流式执行中也属正常态）
 *   - 黄 stalled ：疑似卡死（后端连续探测/RPC 超时，已广播 pi_unresponsive）
 *   - 红 dead    ：进程已退出（pi_process_exit）
 *
 * 交互：
 *   - 黄/红状态点击 = POST /api/pi/restart（后端 kill 旧进程 → 等退出 →
 *     自动拉起新进程接续会话），用户无需重启整个后端；绿/灰点击无动作
 *   - 悬停 tooltip 显示状态说明与最近活动时间（界面文字不带 "pi" 前缀）
 *
 * 数据源（零轮询，纯事件驱动）：
 *   - piEvent 页面事件（LumenSocket 从 WS 'pi-event' 转发）：
 *       pi_unresponsive → 黄；pi_process_exit → 红；
 *       pi_started / pi_responsive → 绿；其余任何 pi 活动 → 绿
 *   - 初始化与 WS 重连时 GET /api/pi/state 校正状态：
 *     WS 广播只覆盖在线期间的事件，F5 / 断连重连后靠 HTTP 补初始态
 *   - WS 断连 → 置灰"状态未知"（避免展示过期状态误导用户）
 *
 * 显隐：仅 LLM 模式显示（与清空按钮 / pi 统计灰字同规则），Comfy 模式隐藏
 * ==========================================================================
 */

class PiStatusLight {
    constructor() {
        this.el = document.getElementById('piStatus');
        if (!this.el) return;
        this.dotEl = this.el.querySelector('.status-dot');
        this.textEl = this.el.querySelector('.status-text');
        this.state = 'idle';        // idle | ok | stalled | dead
        this.lastEventAt = 0;       // 最近一次 pi 活动时间（tooltip 展示）
        this.restarting = false;    // 重启请求进行中，防重复点击

        this._bindEvents();
        this._applyModeVisibility();
        this._syncFromServer();
    }

    // ==================== 事件绑定 ====================

    _bindEvents() {
        // pi 事件流（零轮询）：任何活动都是健康信号
        window.addEventListener('piEvent', (e) => this._onPiEvent(e.detail));

        // WS 断连/重连：断连置灰"状态未知"，重连后从服务器重新校正
        window.addEventListener('lumenWsClosed', () => {
            this.set('idle', '状态未知（连接断开）');
        });
        window.addEventListener('lumenWsOpen', () => this._syncFromServer());

        // 模式显隐：与清空按钮同规则（仅 LLM 模式显示）
        document.getElementById('promptMode')?.addEventListener('change', () => this._applyModeVisibility());
        window.addEventListener('llmModeEnter', () => this._applyModeVisibility());

        // 黄/红点击重启
        this.el.addEventListener('click', () => this._restartIfUnhealthy());
    }

    // ==================== 状态流转 ====================

    /**
     * 消费 pi 事件，驱动四态流转
     * @param {Object} event - 后端广播的 pi 事件对象 {type, ...}
     */
    _onPiEvent(event) {
        if (!event || !event.type) return;
        switch (event.type) {
            case 'pi_process_exit':
                // 进程退出：红灯（tooltip 带退出码便于对照 agent.log）
                this.set('dead', `已退出（code ${event.code ?? '?'}），点击重启`);
                break;
            case 'pi_unresponsive':
                // 疑似卡死：黄灯（程序不自动杀进程，交人工决策）
                this.set('stalled', '疑似卡死，点击重启');
                break;
            case 'pi_started':
            case 'pi_responsive':
                // 新进程拉起 / 卡死恢复：回绿
                this.lastEventAt = Date.now();
                this.set('ok', '健康');
                break;
            default:
                // 其余流式/工具事件：有活动即健康（只升不降，不覆盖黄/红的警示文案）
                this.lastEventAt = Date.now();
                if (this.state !== 'ok') this.set('ok', '健康');
                break;
        }
    }

    /**
     * 从服务器校正当前状态（页面加载 / WS 重连后各一次；
     * WS 广播只覆盖在线期间，F5 后灯的初始态靠这里补）
     */
    async _syncFromServer() {
        try {
            const res = await fetch('/api/pi/state');
            const body = await res.json();
            const st = body?.data || {};
            this.lastEventAt = st.lastEventAt || 0;
            if (st.running) {
                this.set('ok', '健康');
            } else {
                this.set('idle', '未运行');
            }
        } catch {
            // 查询失败多半是后端不可达：置灰不误导
            this.set('idle', '状态未知');
        }
    }

    /**
     * 黄/红状态下点击 = 重启 pi 进程：
     * 后端 kill 旧进程并拉起新进程接续会话（session-map 绑定不丢上下文）
     */
    async _restartIfUnhealthy() {
        if (this.restarting) return;
        if (this.state !== 'stalled' && this.state !== 'dead') return;
        this.restarting = true;
        this.set('idle', '重启中…');
        try {
            const res = await fetch('/api/pi/restart', { method: 'POST' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            // 重启成功：后端已拉起新进程（会广播 pi_started，这里直接置绿兜底）
            this.lastEventAt = Date.now();
            this.set('ok', '健康');
        } catch {
            this.set('dead', '重启失败，点击重试');
        } finally {
            this.restarting = false;
        }
    }

    // ==================== 渲染 ====================

    /**
     * 切换状态并刷新圆点/文字/tooltip
     * @param {'idle'|'ok'|'stalled'|'dead'} state - 目标状态
     * @param {string} text - 状态文字（同时作为 tooltip 主体）
     */
    set(state, text) {
        this.state = state;
        this.el.classList.remove('ok', 'stalled', 'dead');
        if (state !== 'idle') this.el.classList.add(state);
        if (this.textEl) this.textEl.textContent = text;
        const activity = this.lastEventAt
            ? `\n最近活动：${new Date(this.lastEventAt).toLocaleTimeString()}`
            : '';
        this.el.title = text + activity;
    }

    /** 按面板当前模式刷新显隐：LLM 模式显示，Comfy 模式隐藏 */
    _applyModeVisibility() {
        const mode = document.getElementById('promptMode')?.value;
        this.el.style.display = mode === 'llm' ? '' : 'none';
    }
}
