/**
 * ==========================================================================
 * LumenLight 视口管理器
 * 作用：负责管理画布的缩放、平移以及屏幕坐标与画布坐标之间的转换。
 *       同时维护左下角缩放比例指示器的显示，并提供自适应边界功能。
 * ==========================================================================
 */

class Viewport {
    /**
     * 构造函数：初始化视口的缩放、偏移量，并获取缩放指示器DOM元素
     */
    constructor() {
        this.scale = 0.15;             // 当前缩放比例，初始 15%，让新画布的可见范围更大
        this.offsetX = 0;              // 画布在屏幕上的水平偏移量
        this.offsetY = 0;              // 画布在屏幕上的垂直偏移量
        this.element = document.getElementById('zoomIndicator'); // 缩放比例指示器
    }
    
    /**
     * 将屏幕坐标转换为画布坐标
     * @param {number} screenX - 屏幕上的 X 坐标
     * @param {number} screenY - 屏幕上的 Y 坐标
     * @returns {Object} 画布坐标 {x, y}
     */
    screenToCanvas(screenX, screenY) {
        return {
            x: (screenX - this.offsetX) / this.scale,
            y: (screenY - this.offsetY) / this.scale
        };
    }
    
    /**
     * 将画布坐标转换为屏幕坐标
     * @param {number} canvasX - 画布上的 X 坐标
     * @param {number} canvasY - 画布上的 Y 坐标
     * @returns {Object} 屏幕坐标 {x, y}
     */
    canvasToScreen(canvasX, canvasY) {
        return {
            x: canvasX * this.scale + this.offsetX,
            y: canvasY * this.scale + this.offsetY
        };
    }
    
    /**
     * 以指定中心点进行缩放
     * @param {number} delta - 滚轮增量，大于 0 缩小，小于 0 放大
     * @param {number} centerX - 缩放中心点屏幕 X 坐标
     * @param {number} centerY - 缩放中心点屏幕 Y 坐标
     * @returns {boolean} 缩放是否成功应用
     */
    zoom(delta, centerX, centerY) {
        // 记录缩放前中心点对应的画布坐标
        const before = this.screenToCanvas(centerX, centerY);
        
        // 根据滚轮方向计算缩放因子
        const factor = delta > 0 ? 0.9 : 1.1;
        
        // 限制缩放范围在最小和最大缩放之间
        const newScale = Math.max(LumenLight.config.minZoom, 
                                 Math.min(LumenLight.config.maxZoom, this.scale * factor));
        
        if (newScale !== this.scale) {
            this.scale = newScale;
            // 调整偏移量，使中心点保持在屏幕同一位置
            this.offsetX = centerX - before.x * this.scale;
            this.offsetY = centerY - before.y * this.scale;
            this.updateIndicator();
            return true;
        }
        return false;
    }
    
    /**
     * 平移画布
     * @param {number} dx - 水平移动距离
     * @param {number} dy - 垂直移动距离
     */
    pan(dx, dy) {
        this.offsetX += dx;
        this.offsetY += dy;
    }
    
    /**
     * 自适应所有图片到画布可视区域
     * @param {Array} images - 图片对象数组
     * @param {number} canvasWidth - 画布宽度
     * @param {number} canvasHeight - 画布高度
     */
    fitToBounds(images, canvasWidth, canvasHeight) {
        if (images.length === 0) return; // 没有图片时不处理
        
        // 计算所有图片的边界框
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        images.forEach(img => {
            minX = Math.min(minX, img.x);
            minY = Math.min(minY, img.y);
            maxX = Math.max(maxX, img.x + img.width);
            maxY = Math.max(maxY, img.y + img.height);
        });
        
        // 添加边界内边距
        const padding = 50;
        minX -= padding; minY -= padding;
        maxX += padding; maxY += padding;
        
        // 计算内容尺寸
        const contentW = maxX - minX;
        const contentH = maxY - minY;
        
        // 计算合适的缩放比例，最大不超过 2 倍
        this.scale = Math.min(canvasWidth / contentW, canvasHeight / contentH, 2);
        
        // 计算偏移量使内容居中
        this.offsetX = (canvasWidth - contentW * this.scale) / 2 - minX * this.scale;
        this.offsetY = (canvasHeight - contentH * this.scale) / 2 - minY * this.scale;
        
        this.updateIndicator();
    }
    
    /**
     * 更新缩放比例指示器显示
     */
    updateIndicator() {
        if (this.element) {
            this.element.textContent = Math.round(this.scale * 100) + '%';
        }
    }
}
