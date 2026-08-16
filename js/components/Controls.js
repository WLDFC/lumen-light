/**
 * LumenLight 视图控制组件
 *
 * 该文件负责管理 LumenLight 应用左下角的视图控制区域，包括：
 * - 自适应屏幕按钮（fitBtn）：一键将画布内容适配到当前窗口大小
 * - 缩放指示器（zoomIndicator）：由 Viewport 负责更新，此处仅保留按钮逻辑
 */

// Controls 类：封装所有视图控制相关的 DOM 操作与事件绑定
class Controls {
    /**
     * 构造函数：初始化 Controls 实例
     * @param {Object} canvas - 画布组件实例，提供 fitToScreen、draw 等视图操作方法
     */
    constructor(canvas) {
        this.canvas = canvas; // 持有画布实例，用于调用视图操作方法
        this.init(); // 初始化 DOM 事件监听
    }

    /**
     * 初始化方法：查找相关 DOM 元素并绑定事件监听器
     */
    init() {
        // 适应屏幕按钮：点击时调用画布的 fitToScreen 方法，使内容自适应窗口
        document.getElementById('fitBtn').addEventListener('click', () => {
            this.canvas.fitToScreen();
        });
    }
}

// 将 Controls 类导出到全局作用域，便于其他模块使用
window.Controls = Controls;
