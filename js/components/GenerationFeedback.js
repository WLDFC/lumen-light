/**
 * ==========================================================================
 * LumenLight 生成反馈动画组件（面板侧占位图门面）
 * ==========================================================================
 * 作用：右侧 Comfy 提示词面板的生成占位图入口。占位图的创建/动画/移除/
 *       落图已上收到全局 PlaceholderManager（与两类生图节点共用同一实现），
 *       本类只剩面板侧的队列语义：
 *         - show(count)：在视口中心创建 count 张 832×1216 占位图
 *           （与生成任务数一致，同 owner 级联横向排开）
 *         - hide()：按先进先出移除最早的面板占位图
 *         - hideExtra(n)：从最新一端移除至多 n 张（提交中止时清理）
 *       LumenSocket 的默认落图路径依赖这一 FIFO（placeholders[0] + hide()）。
 *
 * 原有公开字段（loaded/image1/image2/placeholders）全部保留并委托给
 * 全局管理器，外部调用方（LumenSocket、PromptPanel）无需感知改动。
 * 面板占位图归属标记为 'panel'——与生图节点的占位图互不干扰，
 * 管理器按归属隔离，并发生成时不会误删/误占彼此的占位图。
 * ==========================================================================
 */

class GenerationFeedback {
    /**
     * 构造函数：绑定画布实例，接入全局占位图管理器
     * @param {Canvas} canvas - 画布主类实例
     */
    constructor(canvas) {
        this.canvas = canvas;
        // 复用全局管理器（app.js 先建）；兜底自建，保证组件单独可用
        this.manager = window.placeholderManager ||
            (window.placeholderManager = new PlaceholderManager(canvas));
        // 任务中心联动队列：PanelComfyRunner 提交完成后 attachTask 挂入，
        // hide()（一个占位图被真实结果消费）推进队首任务进度。
        // 队列而非单槽——上一轮没收满时新一轮可继续排队，按 FIFO 对齐
        this._taskQueue = [];
        this._taskWatchdog = null;
    }

    /**
     * 面板名下的占位图队列（按创建序，先进先出）。
     * LumenSocket 默认落图路径读取 placeholders[0] 的位置并调用 hide()
     */
    get placeholders() {
        return this.manager.getByOwner('panel');
    }

    /** 动画帧是否加载完成 */
    get loaded() {
        return this.manager.loaded;
    }

    /** 占位动画帧 1（保留字段，历史调用方兼容） */
    get image1() {
        return this.manager.image1;
    }

    /** 占位动画帧 2（保留字段，历史调用方兼容） */
    get image2() {
        return this.manager.image2;
    }

    /**
     * 创建面板生成占位图（视口中心，固定 832×1216）。
     * 数量与生成数量一致（循环入队 N 个任务 → N 张占位图），管理器按
     * 同 owner 级联横向排开；每张任务完成时 LumenSocket 默认落图路径
     * 按 FIFO 消费最早的一张
     * @param {number} [count=1] - 占位图数量
     * @param {Object} [genInfo] - 本轮生成参数记录（溯源/生成同款，
     *   GenRecord）——每张占位图句柄独立持有，回图落定时随图盖章
     */
    show(count = 1, genInfo = null) {
        for (let i = 0; i < count; i++) {
            this.manager.create('panel', { width: 832, height: 1216, genInfo });
        }
    }

    /**
     * 移除最早创建的一个面板占位图（FIFO，收到生成结果时调用）。
     * 一个占位图被真实结果消费 = 一个结果落定：推进队首任务进度，
     * 收满即自动结算（提交完成≠生成完成，生成完成以回图为准）
     */
    hide() {
        const oldest = this.placeholders[0];
        if (!oldest) return;   // 无占位图可消费（存档恢复清空等）：原样空操作
        this.manager.remove(oldest);

        const front = this._taskQueue[0];
        if (front) {
            front.received++;
            front.ref.update({ done: front.received });
            this._armTaskWatchdog();   // 有回图 = 有进展，重置看门狗
            this._settleIfComplete(front);
        }
    }

    /**
     * 从最新的一端移除至多 n 个占位图（提交中止时清理多余的占位图——
     * 未入队的任务不会再回传图片，对应的占位图应随之消失；
     * 已入队任务对应的头部占位图保留给即将回传的图片）。
     * 尾部占位图属于队尾任务：预期数量随之缩减，收满则提前结算
     * @param {number} n - 计划移除数量（自动按现存数量钳制）
     */
    hideExtra(n) {
        const list = this.placeholders;
        for (let i = 0; i < n && list.length > 0; i++) {
            this.manager.remove(list[list.length - 1]);
        }
        const last = this._taskQueue[this._taskQueue.length - 1];
        if (last) {
            last.expected = Math.max(0, last.expected - n);
            this._settleIfComplete(last);
        }
    }

    // ==================== 任务中心联动 ====================

    static TASK_WATCHDOG_MS = 30 * 60 * 1000;   // 与 Comfy/RH 看门狗同口径

    /**
     * 挂接任务中心任务（PanelComfyRunner 提交完成后调用）：expected =
     * 本轮已入队数量（=应回传的结果数），此后占位图逐一被结果消费时
     * 推进进度，全部消费完自动结算；ComfyUI 长时间无回图由看门狗兜底。
     * 多轮并存按 FIFO 排队——队首没收满前，后续轮次的结果自然排后
     * @param {Object} ref - taskRegistry 任务引用
     * @param {number} expected - 应回传的结果数
     */
    attachTask(ref, expected) {
        this._taskQueue.push({ ref, expected, received: 0 });
        this._armTaskWatchdog();
    }

    /**
     * 取消挂接的任务（任务中心行内 ✕ 快速取消）：移出队列不再计数，并
     * 清理该任务名下仍未消费的占位图（已中断的任务不会再有结果回图，
     * 不清理会永远转圈）：
     *   - 队首任务：未消费占位图在 FIFO 头部，从头部清理；
     *   - 非队首任务：在 FIFO 尾部，从尾部清理；
     *   - 尚未挂接（提交期间取消）：本轮创建的占位图在面板 FIFO 尾部
     *     （前一轮仍在跑则其占位图在头部），按 createdCount 从尾部清理。
     * @param {Object} ref - 任务引用
     * @param {number} [createdCount] - 本轮创建的占位图数（仅未挂接分支用）
     * @returns {boolean} 是否原已挂接
     */
    cancelTask(ref, createdCount = 0) {
        const idx = this._taskQueue.findIndex(item => item.ref === ref);
        if (idx === -1) {
            const list = this.placeholders;
            for (let i = 0; i < createdCount && list.length > 0; i++) {
                this.manager.remove(list[list.length - 1]);
            }
            return false;
        }
        const [item] = this._taskQueue.splice(idx, 1);
        const remain = Math.max(0, item.expected - item.received);
        const list = this.placeholders;
        for (let i = 0; i < remain && list.length > 0; i++) {
            this.manager.remove(idx === 0 ? list[0] : list[list.length - 1]);
        }
        if (this._taskQueue.length === 0) this._disarmTaskWatchdog();
        return true;
    }

    _settleIfComplete(item) {
        if (item.expected > 0 && item.received >= item.expected && item.ref.isRunning()) {
            item.ref.end('done', item.expected > 1 ? `完成 ${item.expected} 张` : '');
            const idx = this._taskQueue.indexOf(item);
            if (idx !== -1) this._taskQueue.splice(idx, 1);
            if (this._taskQueue.length === 0) this._disarmTaskWatchdog();
        }
    }

    _armTaskWatchdog() {
        if (this._taskWatchdog) clearTimeout(this._taskWatchdog);
        this._taskWatchdog = setTimeout(() => {
            this._taskWatchdog = null;
            if (this._taskQueue.length === 0) return;
            // 长时间无任何回图（宕机/队列卡死）：整批挂起任务按失败收尾，
            // 不让任务永远悬挂在运行态（与 Comfy 节点看门狗同一兜底思路）
            for (const item of this._taskQueue) {
                if (item.ref.isRunning()) item.ref.end('failed', 'ComfyUI 长时间未响应');
            }
            this._taskQueue = [];
        }, GenerationFeedback.TASK_WATCHDOG_MS);
    }

    _disarmTaskWatchdog() {
        if (this._taskWatchdog) {
            clearTimeout(this._taskWatchdog);
            this._taskWatchdog = null;
        }
    }
}

// 导出为全局变量，供其他模块使用
window.GenerationFeedback = GenerationFeedback;
