/**
 * ==========================================================================
 * LumenLight 画布命中检测与光标决策
 * ==========================================================================
 * 作用：从 CanvasInteraction 拆出的纯几何判定层，负责：
 *   1. 缩放控制点命中检测（hitResizeHandle）
 *   2. 连线端口圆点命中检测（hitConnectionDot）
 *   3. 根据命中结果与手势状态决策画布光标（updateCursor / updateCursorStyle）
 * 纯计算层：所有方法均为 static，只读取传入的 canvas 对象与坐标，
 * 不持有手势状态、不修改画布数据（仅 updateCursor 写入 cursor 样式），
 * 可脱离 DOM 独立做单元测试（见 test/canvas/canvasHitTester.test.js）。
 * 依赖：LumenLight.config（命中容差等常量）、CanvasRenderer（控制点矩形与
 *       显示判定）、CanvasConnections（端口坐标）。
 * ==========================================================================
 */

class CanvasHitTester {
    /**
     * 检测画布坐标是否命中当前单选图片的缩放控制点
     * 仅单选时生效；多选、无选中或占位图均返回 null。
     * @param {Canvas} canvas - 画布主类实例
     * @param {number} canvasX - 画布 X 坐标
     * @param {number} canvasY - 画布 Y 坐标
     * @returns {{img: Object, handle: string}|null} 命中的图片与控制点方位
     */
    static hitResizeHandle(canvas, canvasX, canvasY) {
        // 多选或未选中时不提供缩放能力
        if (canvas.images.selectedIds.size !== 1) return null;

        const img = canvas.images.getSelected()[0];
        if (!img || NodeTypes.isPlaceholder(img.source)) return null;

        // 图片在屏幕上过小时禁用命中：此时控制点会盖满整张图，
        // 若仍可命中就再也无法拖动图片本身，故必须连命中一起禁掉。
        // 注意：这与设置里的"显示锚点"开关是两回事——用户关闭锚点只是不绘制，
        // 此处不读取该开关，从而保证隐藏锚点后拖角缩放依然可用。
        const scale = canvas.viewport.scale;
        if (!CanvasRenderer.shouldShowHandles(img, scale)) return null;

        // 命中区域比可视控制点略大，提升小控制点的抓取手感；
        // 与绘制一致地除以视口缩放，保证屏幕上的判定范围恒定
        const size = (LumenLight.config.resizeHandleSize + LumenLight.config.resizeHandleHitPadding * 2) / scale;
        const handles = CanvasRenderer.getHandleRects(img, size);

        for (const h of handles) {
            if (canvasX >= h.x && canvasX <= h.x + h.size &&
                canvasY >= h.y && canvasY <= h.y + h.size) {
                return { img, handle: h.name };
            }
        }
        return null;
    }

    /**
     * 根据控制点方位返回对应的缩放光标样式
     * 左上/右下为主对角线，右上/左下为副对角线
     * @param {string} handle - 控制点方位
     * @returns {string} CSS 光标值
     */
    static getResizeCursor(handle) {
        return (handle === 'nw' || handle === 'se') ? 'nwse-resize' : 'nesw-resize';
    }

    /**
     * 检测画布坐标是否命中某张图片的端口圆点
     * @param {Canvas} canvas - 画布主类实例
     * @param {number} canvasX - 画布 X 坐标
     * @param {number} canvasY - 画布 Y 坐标
     * @returns {{img: Object, side: 'in'|'out'}|null} 命中的图片与端口方位
     */
    static hitConnectionDot(canvas, canvasX, canvasY) {
        const scale = canvas.viewport.scale;
        // 命中判定半径 = 圆点半径 + 容差，均做反缩放补偿保证屏幕手感恒定
        const hitRadius = (LumenLight.config.connectionDotRadius + LumenLight.config.connectionDotHitPadding) / scale;

        // 从后往前遍历，与图片命中检测一致，优先上层图片
        for (let i = canvas.images.images.length - 1; i >= 0; i--) {
            const img = canvas.images.images[i];
            // 占位图不参与连线；面板节点端口是 DOM 圆点（自带事件转发），
            // canvas 层不参与端口命中，避免节点边缘点击被误判为拖线；
            // 文本节点无端口，不参与连线
            if (NodeTypes.isPlaceholder(img.source) ||
                NodeTypes.isPanelNode(img.source)) continue;

            const inPt = CanvasConnections.getPortPoint(img, 'in', scale);
            const outPt = CanvasConnections.getPortPoint(img, 'out', scale);

            if (Math.hypot(canvasX - inPt.x, canvasY - inPt.y) <= hitRadius) {
                return { img, side: 'in' };
            }
            if (Math.hypot(canvasX - outPt.x, canvasY - outPt.y) <= hitRadius) {
                return { img, side: 'out' };
            }
        }
        return null;
    }

    /**
     * 根据鼠标位置更新画布光标样式
     * @param {Canvas} canvas - 画布主类实例
     * @param {boolean} isSpacePressed - 空格平移模式是否按下（交互层持有该状态）
     * @param {Object} cp - 画布坐标 {x, y}
     */
    static updateCursor(canvas, isSpacePressed, cp) {
        if (canvas.isPanning) {
            canvas.canvas.style.cursor = 'grabbing';
            return;
        }

        // 缩放过程中锁定为对应方位的缩放光标，避免鼠标移出控制点后光标回跳
        if (canvas.isResizing) {
            canvas.canvas.style.cursor = CanvasHitTester.getResizeCursor(canvas.resizeHandle);
            return;
        }

        // 悬停在控制点上时给出缩放光标提示（空格平移模式下让位给 grab）
        if (!isSpacePressed) {
            const hitHandle = CanvasHitTester.hitResizeHandle(canvas, cp.x, cp.y);
            if (hitHandle) {
                canvas.canvas.style.cursor = CanvasHitTester.getResizeCursor(hitHandle.handle);
                return;
            }

            // 组缩放进行中：锁定对应方位的光标
            if (canvas.isResizingGroup && canvas.resizeGroupTarget) {
                canvas.canvas.style.cursor =
                    GroupManager.getGroupResizeCursor(canvas.resizeGroupHandle);
                return;
            }

            // 悬停选中组的边缘手柄：给出对应方位的缩放光标
            const hitGroupHandle = GroupManager.hitGroupEdgeHandle(canvas, cp.x, cp.y);
            if (hitGroupHandle) {
                canvas.canvas.style.cursor =
                    GroupManager.getGroupResizeCursor(hitGroupHandle.handle);
                return;
            }

            // 悬停组标题栏：move 光标提示可拖动整组
            if (GroupManager.hitGroupTitle(canvas, cp.x, cp.y)) {
                canvas.canvas.style.cursor = 'move';
                return;
            }
        }

        let cursor = isSpacePressed ? 'grab' : 'default';
        for (let img of canvas.images.images) {
            // 悬停在图片上时保持默认箭头光标（曾用 move 四向箭头，按需求改回默认）
            if (cp.x >= img.x && cp.x <= img.x + img.width &&
                cp.y >= img.y && cp.y <= img.y + img.height) {
                cursor = 'default';
            }
        }
        canvas.canvas.style.cursor = cursor;
    }

    /**
     * 根据当前状态更新光标样式（无鼠标坐标上下文时的简化版本）
     * @param {Canvas} canvas - 画布主类实例
     * @param {boolean} isSpacePressed - 空格平移模式是否按下（交互层持有该状态）
     */
    static updateCursorStyle(canvas, isSpacePressed) {
        if (canvas.isPanning) {
            canvas.canvas.style.cursor = 'grabbing';
        } else {
            canvas.canvas.style.cursor = isSpacePressed ? 'grab' : 'default';
        }
    }
}

// 将类暴露到全局作用域
window.CanvasHitTester = CanvasHitTester;
