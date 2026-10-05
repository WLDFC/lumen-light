/**
 * ==========================================================================
 * 生成任务停止控件（GenStopControl）——可复用的任务级 X 按钮
 * ==========================================================================
 * 提炼自 LLM 面板 ■停止按钮的机制内核，供面板与画布节点（生图节点等）
 * 复用。职责只有三件事：
 *   1. 每轮任务持有一个 AbortController：begin() 返回 signal 直接透传给
 *      fetch，配合后端 /api/llm/generate-image 的"客户端断连 → 同步掐断
 *      对上游厂商请求"机制，停止即真正中止（不再继续计费）；
 *   2. 可选的 X 按钮 UI：传入 host 时在宿主末尾渲染方块 X，常驻两态——
 *      无任务暗红灭置不可点，begin 点亮 active / end 熄回（与面板
 *      ■停止按钮同一套视觉语义），点击即 abort 本轮任务；
 *   3. AbortError 判别：isAbortError 供错误分支分流——用户主动停止是
 *      中性提示，绝不落红字失败。
 *
 * 并发语义：状态归调用方（节点/面板实例）持有，本类不设任何全局注册表
 * ——画布上多个节点并发不同厂商 API 时，各自 X 只中止自己那轮任务，
 * 互不牵连。一轮 = 一个 controller（节点一轮并发 N 张共享一个，
 * 点 X 全停，已完成的照常落图）。
 *
 * 无头模式：host 不传时不出按钮，只有 controller——面板"停止全部"即
 * 聚合多个无头实例逐个 abort（两处 UI 一个内核）。
 * ==========================================================================
 */

class GenStopControl {
    /**
     * @param {Object} [options]
     * @param {HTMLElement} [options.host] - X 按钮的挂载容器（缺省无头模式）
     * @param {Function} [options.onAbort] - 用户点击 X 后的回调（界面收尾；
     *        fetch 的 AbortError 收尾由调用方在各自 catch 里做，不走这里）
     * @param {string} [options.title] - 按钮悬停提示
     */
    constructor({ host = null, onAbort = null, title = '停止生成本任务' } = {}) {
        this._onAbort = onAbort;
        this._controller = null;
        this.btn = null;

        if (host) {
            this.btn = document.createElement('button');
            this.btn.type = 'button';
            this.btn.className = 'gen-stop-btn';
            this.btn.title = title;
            this.btn.setAttribute('aria-label', title);
            // Feather 风格 X 线条（stroke=currentColor 随按钮着色）
            this.btn.innerHTML =
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2' +
                '" stroke-linecap="round" stroke-linejoin="round">' +
                '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
            // 常驻两态（与面板 ■停止按钮一致）：无任务暗色灭置不可点，
            // begin 点亮 active、end 熄回
            this.btn.disabled = true;
            this.btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.abort();
            });
            host.appendChild(this.btn);
        }
    }

    /** 开始一轮任务：新建 controller、点亮 X。返回值直接传给 fetch 的 signal */
    begin() {
        this._controller = new AbortController();
        if (this.btn) {
            this.btn.disabled = false;
            this.btn.classList.add('active');
        }
        return this._controller.signal;
    }

    /** 当前任务的 AbortSignal（未开始时为 null） */
    get signal() {
        return this._controller ? this._controller.signal : null;
    }

    /** 本轮任务是否已被用户中止 */
    get aborted() {
        return !!(this._controller && this._controller.signal.aborted);
    }

    /** 中止本轮任务（幂等）；界面收尾由调用方在 fetch 的 catch 分支做 */
    abort() {
        if (this._controller && !this._controller.signal.aborted) {
            this._controller.abort();
            if (this._onAbort) this._onAbort();
        }
    }

    /** 一轮任务收尾：熄回暗置态、弃掉 controller（下一轮 begin 重建） */
    end() {
        this._controller = null;
        if (this.btn) {
            this.btn.disabled = true;
            this.btn.classList.remove('active');
        }
    }

    /** 节点销毁时移除按钮 */
    destroy() {
        this.end();
        if (this.btn) {
            this.btn.remove();
            this.btn = null;
        }
    }

    /**
     * 判别 fetch reject 是否为用户主动中止（错误分支分流用）：
     * 中止显示中性"已停止"，其余才按失败处理
     * @param {*} err - catch 到的错误
     * @returns {boolean}
     */
    static isAbortError(err) {
        return !!err && err.name === 'AbortError';
    }
}

// 暴露到全局作用域
window.GenStopControl = GenStopControl;
