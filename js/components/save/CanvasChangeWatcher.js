/**
 * ==========================================================================
 * 画布变更捕获器（CanvasChangeWatcher）
 * ==========================================================================
 * 作用：以统一的途径感知"画布内容发生了变化"，并向订阅者广播。
 *       现有订阅方：RealtimeSaveManager（本地磁盘实时保存）。
 *
 * 捕获途径（非侵入，不改动任何组件的方法调用点）：
 *   1. Hook canvas.draw()：所有几何/图片/节点/视口变化最终都会走 draw，
 *      在此处代理即可捕获绝大多数变更。拖动/缩放时每帧触发，
 *      由订阅方各自 debounce 合并；
 *   2. 委托监听 input / change（捕获阶段）：只处理画布相关的输入源
 *     （画布节点 .text-node 与右侧提示词面板 #comfyContent），
 *     避免设置面板 / LLM 对话框 / 收藏页的输入触发无谓写入；
 *   3. visibilitychange（页面隐藏）与 pagehide（关闭/刷新）：
 *      广播 flush，订阅方跳过 debounce 立即落盘，
 *      防止 debounce 窗口内的最后一批变更丢失。
 *
 * 职责边界：本类只负责"通知变更"，不持有任何业务状态；
 *   恢复期间（restoreProject 触发 draw）的写入抑制由各订阅方
 *   用自己的 restoring 标志处理。
 * ==========================================================================
 */

class CanvasChangeWatcher {
    /**
     * 构造函数：hook 变更源，此时不产生任何通知
     * @param {Canvas} canvas - 画布主类实例
     */
    constructor(canvas) {
        this.canvas = canvas;
        this._listeners = new Set();

        this._hookCanvasDraw();
        this._bindGlobalEvents();
    }

    /**
     * 订阅变更通知
     * @param {Object} listener
     * @param {Function} [listener.onChange] - 画布内容变更时调用（高频，需自行 debounce）
     * @param {Function} [listener.onFlush] - 页面隐藏/卸载前调用（应立即落盘）
     * @returns {Function} 取消订阅函数
     */
    subscribe(listener) {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    /**
     * Hook canvas.draw()：原方法照常执行，随后广播一次变更
     */
    _hookCanvasDraw() {
        const originalDraw = this.canvas.draw.bind(this.canvas);
        this.canvas.draw = () => {
            originalDraw();
            this._emit('onChange');
        };
    }

    /**
     * 绑定全局事件：画布相关输入源的 input/change 委托 + 页面隐藏/卸载的 flush
     */
    _bindGlobalEvents() {
        const handler = (e) => {
            const target = e.target;
            if (!(target instanceof Element)) return;
            if (target.closest('.text-node, #comfyContent')) {
                this._emit('onChange');
            }
        };
        document.addEventListener('input', handler, true);
        document.addEventListener('change', handler, true);

        // 页面切到后台或关闭时广播 flush（IndexedDB / fetch 都会等待进行中的请求完成）
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') this._emit('onFlush');
        });
        window.addEventListener('pagehide', () => this._emit('onFlush'));
    }

    /**
     * 向所有订阅者广播某一类事件（单个订阅者抛错不影响其他订阅者）
     * @param {string} method - 'onChange' | 'onFlush'
     */
    _emit(method) {
        for (const listener of this._listeners) {
            try {
                if (typeof listener[method] === 'function') listener[method]();
            } catch (err) {
                console.warn('CanvasChangeWatcher 订阅者处理异常:', err);
            }
        }
    }
}

// 将类暴露到全局作用域
window.CanvasChangeWatcher = CanvasChangeWatcher;
