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
     */
    show(count = 1) {
        for (let i = 0; i < count; i++) {
            this.manager.create('panel', { width: 832, height: 1216 });
        }
    }

    /**
     * 移除最早创建的一个面板占位图（FIFO，收到生成结果时调用）
     */
    hide() {
        const oldest = this.placeholders[0];
        if (oldest) {
            this.manager.remove(oldest);
        }
    }

    /**
     * 从最新的一端移除至多 n 个占位图（提交中止时清理多余的占位图——
     * 未入队的任务不会再回传图片，对应的占位图应随之消失；
     * 已入队任务对应的头部占位图保留给即将回传的图片）
     * @param {number} n - 计划移除数量（自动按现存数量钳制）
     */
    hideExtra(n) {
        const list = this.placeholders;
        for (let i = 0; i < n && list.length > 0; i++) {
            this.manager.remove(list[list.length - 1]);
        }
    }
}

// 导出为全局变量，供其他模块使用
window.GenerationFeedback = GenerationFeedback;
