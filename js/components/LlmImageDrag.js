/**
 * ==========================================================================
 * LumenLight 图片拖到画布组件
 * 作用：为任意 <img> 元素挂载「拖拽到画布」能力（自定义指针拖拽，
 *       不走浏览器原生 HTML5 拖拽）。松手落点在画布内时，
 *       按原生分辨率把图片添加到画布上的对应位置。
 * 为何不用原生拖拽：原生拖拽在 Windows 上起步与快速移动时会显示“禁止”光标
 *       且画面更新滞后，体验差且无法根治；自定义拖拽用幽灵图跟随鼠标，
 *       光标全程可控。
 * 说明：本组件从 LlmChat 中拆分出来，不含任何 LLM 相关逻辑，可被其他模块复用。
 * ==========================================================================
 */

class LlmImageDrag {
    // 判定为拖拽的最小移动距离（px）：小于该值视为普通点击，交给原有 click 事件
    static DRAG_THRESHOLD = 5;

    /**
     * 为图片元素挂载拖拽到画布的能力
     * @param {HTMLImageElement} imgEl - 图片元素（已设置好 src）
     * @param {Object} [metadata] - 图片生成信息
     */
    static attach(imgEl, metadata = {}) {
        // 禁用原生拖拽，从根上消除“禁止”光标
        imgEl.draggable = false;

        imgEl.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;   // 仅左键拖拽

            const startX = e.clientX;
            const startY = e.clientY;
            let dragging = false;
            let ghost = null;

            const onMouseMove = (ev) => {
                if (!dragging) {
                    // 移动超过阈值才进入拖拽状态，避免误判点击
                    if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < LlmImageDrag.DRAG_THRESHOLD) return;
                    dragging = true;

                    ghost = LlmImageDrag.createGhost(imgEl.src);
                    document.body.style.userSelect = 'none';
                    document.body.style.cursor = 'grabbing';
                    ev.preventDefault();
                }

                ghost.style.left = `${ev.clientX}px`;
                ghost.style.top = `${ev.clientY}px`;
                // 落点在画布上时高亮提示可放置
                ghost.style.outlineColor = LlmImageDrag.isOverCanvas(ev.clientX, ev.clientY) ? '#3b82f6' : 'transparent';
            };

            const onMouseUp = (ev) => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                document.body.style.userSelect = '';
                document.body.style.cursor = '';

                // 纯点击：不处理，交给原有的 click 事件（如打开灯箱）
                if (!dragging) return;

                ghost?.remove();
                if (!LlmImageDrag.isOverCanvas(ev.clientX, ev.clientY)) return;

                LlmImageDrag.dropToCanvas(imgEl.src, ev.clientX, ev.clientY, metadata);
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }

    /**
     * 创建跟随鼠标的幽灵缩略图
     * @param {string} src - 图片地址
     * @returns {HTMLImageElement} 已插入 body 的幽灵元素
     */
    static createGhost(src) {
        const ghost = document.createElement('img');
        ghost.src = src;
        ghost.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;width:120px;height:120px;object-fit:cover;opacity:0.85;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.5);transform:translate(-50%,-50%);outline:2px solid transparent;';
        document.body.appendChild(ghost);
        return ghost;
    }

    /**
     * 判断屏幕坐标是否落在画布区域内
     * @param {number} x - 屏幕 X 坐标
     * @param {number} y - 屏幕 Y 坐标
     * @returns {boolean}
     */
    static isOverCanvas(x, y) {
        const canvasEl = window.canvas?.canvas;
        if (!canvasEl) return false;
        const rect = canvasEl.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }

    /**
     * 以原生分辨率把图片添加到画布落点（以落点为图片中心）
     * @param {string} src - 图片地址
     * @param {number} clientX - 松手时的屏幕 X 坐标
     * @param {number} clientY - 松手时的屏幕 Y 坐标
     */
    static dropToCanvas(src, clientX, clientY, metadata = {}) {
        const cp = window.canvas.viewport.screenToCanvas(clientX, clientY);
        const img = new Image();
        img.onload = () => {
            // 清除一次性回调：保存存档后 SaveManager 会回写 img.src，
            // 重新赋值 src 会再次触发 load，不清除会导致同一张图重复入画布
            img.onload = null;
            window.canvas.images.addImage({
                img,
                x: cp.x - img.width / 2,
                y: cp.y - img.height / 2,
                width: img.width,
                height: img.height,
                isPlaceholder: false,
                source: 'llm',
                prompt: metadata.prompt || '',
                negativePrompt: metadata.negativePrompt || ''
            });
            window.canvas.draw();
        };
        img.src = src;
    }
}

// 将 LlmImageDrag 类暴露到全局作用域
window.LlmImageDrag = LlmImageDrag;
