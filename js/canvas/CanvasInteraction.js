/**
 * ==========================================================================
 * LumenLight 画布交互管理器
 * 作用：处理画布上的鼠标与键盘交互，包括点击选择、拖拽图片、拖角等比缩放图片、
 *       按住空格平移画布、鼠标中键（滚轮按下）平移画布、滚轮缩放、
 *       双击图片打开灯箱查看原生分辨率大图、拖拽端口圆点连线串联图片、
 *       悬停/点击连线断开以及光标样式更新。
 *       所有交互状态通过画布主类共享。
 * 说明：本类只处理交互逻辑，渲染工作交给 CanvasRenderer。
 *
 * 结构说明（一个完整的手势状态机，勿拆分为多文件）：
 *   onMouseDown 按优先级分流（节点端口 > 中键 > 图片端口 > 缩放点 > 图片 > 连线 > 空白），
 *   每个分支调用对应的 _startXxx() 设置交互状态并绑定 window 级事件；
 *   onMouseMove / onMouseUp 按激活的交互状态分发到 _applyXxx() / _finishXxx() 收尾。
 *   优先级判定链是行为正确性的核心，必须保持在 onMouseDown 单点可见。
 * ==========================================================================
 */

class CanvasInteraction {
    /**
     * 构造函数：保存画布主类引用并绑定事件
     * @param {Canvas} canvas - 画布主类实例
     */
    constructor(canvas) {
        this.canvas = canvas;  // 画布主类实例
        // 空格键是否被按住，用于控制画布平移模式
        this.isSpacePressed = false;
        // 是否通过鼠标中键（滚轮按下）平移画布
        this.isMiddleButtonPanning = false;
        this.bindEvents();
    }

    /**
     * 绑定画布相关鼠标与键盘事件
     */
    bindEvents() {
        const { canvas } = this.canvas;

        // 滚轮缩放事件（提取为 handleWheel，供节点 DOM 转发复用）
        canvas.addEventListener('wheel', (e) => this.handleWheel(e), { passive: false });

        // 鼠标交互事件
        canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));

        // 鼠标中键（滚轮按下）辅助松开检测：中键释放时结束平移
        canvas.addEventListener('auxclick', (e) => {
            if (e.button === 1) e.preventDefault();
        });

        // 阻止中键按下触发的默认自动滚动行为（Windows Chrome 等会进入惯性滚动）
        canvas.addEventListener('mousedown', (e) => {
            if (e.button === 1) e.preventDefault();
        });

        // 双击图片：打开灯箱查看原生分辨率大图（复用 LLM 聊天的灯箱组件）
        canvas.addEventListener('dblclick', (e) => this.onDblClick(e));

        // 键盘事件：空格键控制平移模式，Delete/Backspace 删除选中图片
        window.addEventListener('keydown', (e) => this.onKeyDown(e));
        window.addEventListener('keyup', (e) => this.onKeyUp(e));
    }

    /**
     * 绑定 window 级鼠标事件（mousemove/mouseup）
     * 所有进入拖拽/连线/平移/框选的交互分支统一调用，
     * 确保鼠标拖出画布后仍能继续交互；onMouseUp 中统一解绑。
     */
    _bindWindowEvents() {
        // 避免重复绑定（连续两次 mousedown 而未经过 mouseup 的异常路径）
        if (this._boundWindowMouseMove) return;
        this._boundWindowMouseMove = (ev) => this.onMouseMove(ev);
        this._boundWindowMouseUp = (ev) => this.onMouseUp(ev);
        window.addEventListener('mousemove', this._boundWindowMouseMove);
        window.addEventListener('mouseup', this._boundWindowMouseUp);
    }

    /**
     * 解绑 window 级鼠标事件（onMouseUp 收尾时调用）
     */
    _unbindWindowEvents() {
        if (this._boundWindowMouseMove) {
            window.removeEventListener('mousemove', this._boundWindowMouseMove);
            this._boundWindowMouseMove = null;
        }
        if (this._boundWindowMouseUp) {
            window.removeEventListener('mouseup', this._boundWindowMouseUp);
            this._boundWindowMouseUp = null;
        }
    }

    /**
     * 滚轮缩放统一处理（画布与节点 DOM 共用）
     * 节点面板浮在 canvas 上方，wheel 事件不会自然到达 canvas，
     * PromptNode 会把自身 wheel 转发到这里，保证鼠标在节点/输入框上
     * 依然能缩放画布。
     * @param {WheelEvent} e - 滚轮事件对象
     */
    handleWheel(e) {
        e.preventDefault();
        const rect = this.canvas.canvas.getBoundingClientRect();
        if (this.canvas.viewport.zoom(e.deltaY, e.clientX - rect.left, e.clientY - rect.top)) {
            this.canvas.draw();
            // 触发视口变化事件，通知其他组件更新位置
            window.dispatchEvent(new CustomEvent('canvasViewportChanged'));
        }
    }

    /**
     * 双击事件处理：双击图片打开灯箱查看原生分辨率大图
     * 复用 LLM 聊天窗口的 LlmLightbox 实例（全局 window.llmChat.lightbox），
     * 点遮罩或按 ESC 关闭的行为与聊天灯箱完全一致。
     * @param {MouseEvent} e - 鼠标事件对象
     */
    onDblClick(e) {
        const c = this.canvas;
        const rect = c.canvas.getBoundingClientRect();
        const cp = c.viewport.screenToCanvas(e.clientX - rect.left, e.clientY - rect.top);

        // 双击在缩放控制点上不打开灯箱，避免与拖角缩放操作冲突
        if (CanvasHitTester.hitResizeHandle(c, cp.x, cp.y)) return;

        // 命中检测：仅图片响应双击，生成中的灰色占位图除外
        const clicked = c.images.isHit(cp.x, cp.y);
        if (!clicked || NodeTypes.isPlaceholder(clicked.source)) return;

        // 视频对象：双击打开原生控件播放器（委托给 CanvasVideoManager）
        if (NodeTypes.isVideo(clicked.source)) {
            c.videoManager.showPlayer(clicked);
            return;
        }

        // 图片对象持有原生分辨率的 HTMLImageElement，其 src 即为大图地址
        const lightbox = window.llmChat && window.llmChat.lightbox;
        if (lightbox && clicked.img && clicked.img.src) {
            lightbox.open(clicked.img.src);
        }
    }

    /**
     * 键盘按下事件处理
     * @param {KeyboardEvent} e - 键盘事件对象
     */
    onKeyDown(e) {
        // 提示词节点正在编辑文本（textarea 聚焦）时，键盘输入全部交给
        // 原生行为（文字编辑、Delete 删字符、空格输入等），画布快捷键失效
        if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) {
            return;
        }

        // 空格键按下时进入平移模式，但不阻止默认行为（避免页面滚动由 Canvas 区域单独处理）
        if (e.code === 'Space') {
            this.isSpacePressed = true;
            this.canvas.canvas.classList.add('space-panning');
            CanvasHitTester.updateCursorStyle(this.canvas, this.isSpacePressed);
            return;
        }

        // Ctrl+C / Ctrl+X：复制 / 剪切选中的画布对象（图片与提示词/生图节点）。
        // Ctrl+V 不在这里拦截，统一走 document 的 paste 事件（见 CanvasClipboard）：
        // 系统剪贴板有图片（截图等）时优先粘贴外部图片，否则粘贴内部复制的对象
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
            const key = e.key.toLowerCase();
            if (key === 'c') {
                if (this.canvas.clipboard.copySelection()) e.preventDefault();
                return;
            }
            if (key === 'x') {
                if (this.canvas.clipboard.cutSelection()) e.preventDefault();
                return;
            }
        }

        // Delete 键删除选中的图片（Backspace 不触发删除，避免输入框误操作）
        if (e.key === 'Delete') {
            const selected = this.canvas.images.getSelected();
            if (selected.length > 0) {
                e.preventDefault();
                for (const img of selected) {
                    this.canvas.images.delete(img.id);
                    // DOM 节点（提示词/生图节点）需要同步移除 DOM 元素
                    if (typeof img.destroy === 'function') img.destroy();
                    // 同步清理被删图片关联的所有连线
                    this.canvas.connections.removeByImage(img.id);
                }
                // 清空选中状态并触发事件，通知工具栏等组件隐藏
                this.canvas.images.select(null);
                this.canvas.draw();
            }
        }
    }

    /**
     * 键盘释放事件处理
     * @param {KeyboardEvent} e - 键盘事件对象
     */
    onKeyUp(e) {
        if (e.code === 'Space') {
            this.isSpacePressed = false;
            this.canvas.canvas.classList.remove('space-panning');
            CanvasHitTester.updateCursorStyle(this.canvas, this.isSpacePressed);

            // 如果松开空格时仍在平移，则结束平移
            const c = this.canvas;
            if (c.isPanning) {
                this.onMouseUp();
            }
        }
    }

    // ==================== 交互启动（onMouseDown 分支调用的 _startXxx） ====================

    /**
     * 进入拖线模式
     * @param {Object} fromImg - 连线起点图片（或提示词节点）
     * @param {'in'|'out'} side - 起点端口方位
     * @param {{x: number, y: number}} cp - 鼠标画布坐标
     */
    _startConnect(fromImg, side, cp) {
        const c = this.canvas;
        c.isConnecting = true;
        c.connectingFrom = fromImg;
        c.connectingFromSide = side;
        c.connectingMouse = { x: cp.x, y: cp.y };
        c.connectingHoverTarget = null;

        // 拖线时选中起点，让用户清楚连线的来源
        c.images.select(fromImg.id);
        this._bindWindowEvents();
        c.draw();
    }

    /**
     * 进入拖角缩放模式（快照缩放前矩形，避免逐帧累加导致浮点漂移）
     * @param {Object} img - 缩放目标图片
     * @param {string} handle - 控制点方位（提示词节点固定 'se'）
     */
    _startResize(img, handle) {
        const c = this.canvas;
        c.isResizing = true;
        c.resizeTarget = img;
        c.resizeHandle = handle;
        c.resizeStartRect = {
            x: img.x,
            y: img.y,
            width: img.width,
            height: img.height
        };

        // 通知工具栏进入缩放态：隐藏按钮组，但保留尺寸标签用于实时反馈
        window.dispatchEvent(new CustomEvent('canvasImageResizeStart'));
        this._bindWindowEvents();
    }

    /**
     * 进入图片拖动模式（支持多选同时移动，占位图只能单独移动）
     * @param {Object} clicked - 命中的图片（或提示词节点）
     * @param {{x: number, y: number}} cp - 鼠标画布坐标
     */
    _startDrag(clicked, cp) {
        const c = this.canvas;
        const isPlaceholder = NodeTypes.isPlaceholder(clicked.source);

        // 普通点击且目标未选中时，单选它
        if (!isPlaceholder && !c.images.selectedIds.has(clicked.id)) {
            c.images.select(clicked.id);
        }

        c.isDraggingImage = true;
        c.dragTarget = clicked;
        c.dragStartMouse = { x: cp.x, y: cp.y };

        // 触发拖动开始事件（占位图不触发）
        if (!isPlaceholder) {
            window.dispatchEvent(new CustomEvent('canvasImageDragStart'));
        }

        // 记录需要移动的图片相对于鼠标的位置偏移
        c.dragOffsets = [];
        if (isPlaceholder) {
            // 占位图只能单独移动，不带动其他已选中图片
            c.dragOffsets.push({
                img: clicked,
                offsetX: clicked.x - cp.x,
                offsetY: clicked.y - cp.y
            });
        } else {
            const selectedImages = c.images.getSelected();
            for (const img of selectedImages) {
                c.dragOffsets.push({
                    img: img,
                    offsetX: img.x - cp.x,
                    offsetY: img.y - cp.y
                });
            }
        }

        this._bindWindowEvents();
        c.draw();
    }

    /**
     * 进入画布平移模式（空格+左键 或 鼠标中键）
     * @param {number} sx - 鼠标屏幕 X 坐标
     * @param {number} sy - 鼠标屏幕 Y 坐标
     */
    _startPan(sx, sy) {
        const c = this.canvas;
        c.isPanning = true;
        c.lastMouse = { x: sx, y: sy };
        c.canvas.classList.add('panning');
        this._bindWindowEvents();
        c.draw();
    }

    /**
     * 进入框选模式（点击空白处且未按空格）
     * @param {{x: number, y: number}} cp - 鼠标画布坐标
     */
    _startBoxSelect(cp) {
        const c = this.canvas;
        c.isBoxSelecting = true;
        c.boxSelectStart = { x: cp.x, y: cp.y };
        c.boxSelectEnd = { x: cp.x, y: cp.y };
        this._bindWindowEvents();
        c.draw();
    }

    /**
     * 记录连线点击候选（点击空白处的连线用于断开，mouseup 仍命中同一条线才生效）
     * @param {Object} conn - 命中的连线
     */
    _startConnectionClick(conn) {
        const c = this.canvas;
        this._connectionClickCandidate = conn;
        c.hoverConnection = conn;
        this._bindWindowEvents();
        c.draw();
    }

    // ==================== 事件处理 ====================

    /**
     * 鼠标按下事件处理：按优先级分流到各交互启动方法
     * 优先级：节点端口/缩放/拖动 > 中键平移 > 图片端口拖线 >
     *         缩放控制点 > 图片拖动 > 连线点击 > 空白（平移/框选）
     * @param {MouseEvent} e - 鼠标事件对象
     */
    onMouseDown(e) {
        const c = this.canvas;
        // 在画布上按下鼠标 = 开启新一段操作，粘贴错位计数归零
        // （之后的 Ctrl+V 重新从贴近原位/画布中心开始）
        c.clipboard.resetPasteOffset();
        const rect = c.canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const cp = c.viewport.screenToCanvas(sx, sy);
        const isShiftPressed = e.shiftKey;

        // 节点 DOM（提示词/生图节点）转发的按下事件：直接进入节点专属交互流程，
        // 不走画布的端口/缩放命中链（节点是 DOM 元素，canvas 命中检测不适用，
        // 且节点边缘的端口圆点会拦截普通点击，必须在这里提前分流）
        if (e._canvasNodeTarget) {
            const node = e._canvasNodeTarget;

            // 端口圆点按下（DOM 端口自带方位标记）：进入拖线模式
            if (e._promptNodePortSide && !isShiftPressed) {
                this._startConnect(node, e._promptNodePortSide, cp);
                return;
            }

            // 命中右下角缩放手柄：进入自由宽高缩放模式
            // （提示词/生图节点均实现 hitResizeHandle，其余固定尺寸节点跳过）
            if (!isShiftPressed && typeof node.hitResizeHandle === 'function' &&
                node.hitResizeHandle(cp.x, cp.y)) {
                this._startResize(node, 'se');   // 复用 se（右下）方位
                return;
            }

            // Shift+点击：切换多选状态
            if (isShiftPressed) {
                c.images.toggleSelect(node.id);
                c.draw();
                return;
            }

            // 其余区域：选中并进入拖动模式（整块面板均可拖，不限标题栏）
            this._startDrag(node, cp);
            return;
        }

        // 中键（滚轮按下）：无论点在图片还是空白处都直接进入平移模式，不选中、不拖图
        if (e.button === 1) {
            e.preventDefault();
            this.isMiddleButtonPanning = true;
            this._startPan(sx, sy);
            return;
        }

        // 最高优先级：命中端口圆点 -> 进入拖线模式（不再选中/拖动图片）
        const hitDot = CanvasHitTester.hitConnectionDot(c, cp.x, cp.y);
        if (hitDot && !isShiftPressed) {
            this._startConnect(hitDot.img, hitDot.side, cp);
            return;
        }

        // 优先检测缩放控制点：控制点有一半落在图片外，且与图片区域部分重叠，
        // 必须排在 isHit 之前判定，否则会被识别成拖动图片
        const hitHandle = CanvasHitTester.hitResizeHandle(c, cp.x, cp.y);
        if (hitHandle && !isShiftPressed) {
            this._startResize(hitHandle.img, hitHandle.handle);
            return;
        }

        // 检查是否点中图片本身
        const clicked = c.images.isHit(cp.x, cp.y);
        // 占位图标记：生成中的灰色占位图不可选中、不可触发选中事件
        const isPlaceholder = clicked ? NodeTypes.isPlaceholder(clicked.source) : false;

        if (clicked) {
            if (isShiftPressed) {
                // Shift+点击：切换多选状态（占位图不可选中）
                if (!isPlaceholder) {
                    c.images.toggleSelect(clicked.id);
                    c.draw();
                }
            } else {
                // 普通点击：开始拖动
                this._startDrag(clicked, cp);
            }
        } else {
            // 点击空白处：先检测是否点在连线上（用于点击断开），不是才清选中/框选
            const hitConn = c.connections.hitTest(cp.x, cp.y);
            if (hitConn && !isShiftPressed) {
                this._startConnectionClick(hitConn);
                return;
            }
            this._connectionClickCandidate = null;

            // 点击空白处：非 Shift 时清除选择，隐藏工具栏、图片名字和尺寸信息
            if (!isShiftPressed) {
                c.images.select(null);
                c.draw();
            }

            // 只有在按住空格键时，点击空白处才会进入画布平移模式
            if (this.isSpacePressed) {
                this._startPan(sx, sy);
            } else {
                // 不按空格时，点击空白处开始框选
                this._startBoxSelect(cp);
            }
        }
    }

    /**
     * 鼠标移动事件处理：按激活的交互状态分发处理
     * @param {MouseEvent} e - 鼠标事件对象
     */
    onMouseMove(e) {
        const c = this.canvas;
        const rect = c.canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const cp = c.viewport.screenToCanvas(sx, sy);

        // 拖线中：更新预览线终点与悬停目标（悬停图片整体作为连接目标）
        if (c.isConnecting) {
            c.connectingMouse = { x: cp.x, y: cp.y };

            // 悬停目标：鼠标下方的图片（排除起点自身与占位图）
            const hover = c.images.isHit(cp.x, cp.y);
            c.connectingHoverTarget =
                (hover && hover !== c.connectingFrom && !NodeTypes.isPlaceholder(hover.source))
                    ? hover : null;

            c.draw();

            // 更新光标为 crosshair，表达"正在连线"的语义
            c.canvas.style.cursor = 'crosshair';
            return;
        }

        // 悬停连线高亮：非拖线/缩放/拖图状态下，鼠标在连线上时记录并重绘（红色提示可点击断开）
        if (!c.isConnecting && !c.isResizing && !c.isDraggingImage && !c.isBoxSelecting) {
            const hitConn = c.connections.hitTest(cp.x, cp.y);
            if (hitConn !== c.hoverConnection) {
                c.hoverConnection = hitConn;
                c.draw();
            }
        }

        if (c.isResizing && c.resizeTarget) {
            // 拖角缩放优先级最高
            this.applyResize(cp);
            c.draw();
            // 实时通知工具栏更新尺寸标签的文本与位置
            window.dispatchEvent(new CustomEvent('canvasImageResizing'));
        } else if (c.isDraggingImage && c.dragTarget) {
            // 多选同时移动 - 直接使用数组更新，避免重复计算
            if (c.dragOffsets && c.dragOffsets.length > 1) {
                for (let i = 0; i < c.dragOffsets.length; i++) {
                    const item = c.dragOffsets[i];
                    item.img.x = cp.x + item.offsetX;
                    item.img.y = cp.y + item.offsetY;
                }
            } else if (c.dragOffsets && c.dragOffsets.length === 1) {
                // 单选时只移动目标图片
                const item = c.dragOffsets[0];
                item.img.x = cp.x + item.offsetX;
                item.img.y = cp.y + item.offsetY;
            }
            c.draw();
        } else if (c.isPanning) {
            // 平移画布
            c.viewport.pan(sx - c.lastMouse.x, sy - c.lastMouse.y);
            c.lastMouse = { x: sx, y: sy };
            c.draw();
            // 触发视口变化事件
            window.dispatchEvent(new CustomEvent('canvasViewportChanged'));
        } else if (c.isBoxSelecting) {
            // 框选过程中实时更新终点
            c.boxSelectEnd = { x: cp.x, y: cp.y };
            c.draw();
        }

        // 更新光标样式
        CanvasHitTester.updateCursor(c, this.isSpacePressed, cp);
    }

    /**
     * 执行等比缩放计算
     * 锚点为被拖控制点的对角点：拖右下角则左上角固定不动，符合通用图片编辑器习惯。
     * 强制锁定宽高比，图片不会被拉变形。
     * @param {Object} cp - 当前鼠标的画布坐标 {x, y}
     */
    applyResize(cp) {
        const c = this.canvas;
        const img = c.resizeTarget;
        const start = c.resizeStartRect;
        const handle = c.resizeHandle;

        // 面板节点（提示词/生图/文本）：自由宽高缩放（右下角拖拽，锁定左上角）
        // 文本框类节点无需等比约束，宽高独立跟随鼠标，最小尺寸由各类静态常量声明
        if (NodeTypes.isPanelNode(img.source)) {
            const minW = img.constructor.MIN_WIDTH;
            const minH = img.constructor.MIN_HEIGHT;
            img.width = Math.max(cp.x - start.x, minW);
            img.height = Math.max(cp.y - start.y, minH);
            img.updateTransform();
            return;
        }

        // 以下为图片的等比缩放逻辑

        // 确定固定不动的对角锚点（世界坐标）
        const anchorX = (handle === 'nw' || handle === 'sw') ? start.x + start.width : start.x;
        const anchorY = (handle === 'nw' || handle === 'ne') ? start.y + start.height : start.y;

        // 鼠标相对锚点的距离即为期望的新尺寸，取绝对值以支持拖过锚点的情况
        const rawWidth = Math.abs(cp.x - anchorX);
        const rawHeight = Math.abs(cp.y - anchorY);

        // 等比换算：分别按宽、按高推算缩放倍率，取较大者，
        // 使图片始终包含鼠标位置，拖拽跟手不会有"追不上鼠标"的迟滞感
        const ratio = Math.max(rawWidth / start.width, rawHeight / start.height);

        // 限制最小尺寸，避免图片被拉成不可见的一条线后无法再次抓取控制点
        const minSize = LumenLight.config.minImageSize;
        const minRatio = Math.max(minSize / start.width, minSize / start.height);
        const finalRatio = Math.max(ratio, minRatio);

        const newWidth = start.width * finalRatio;
        const newHeight = start.height * finalRatio;

        // 由锚点反推左上角坐标：锚点在右侧时左上角需左移，锚点在下方时需上移
        img.width = newWidth;
        img.height = newHeight;
        img.x = (handle === 'nw' || handle === 'sw') ? anchorX - newWidth : anchorX;
        img.y = (handle === 'nw' || handle === 'ne') ? anchorY - newHeight : anchorY;
    }

    /**
     * 鼠标释放事件处理：完成当前交互并统一重置状态
     */
    onMouseUp(e) {
        const c = this.canvas;
        const isShiftPressed = e?.shiftKey || false;

        this._finishConnect();
        this._finishConnectionClick(e);

        // 如果之前正在拖动图片，触发拖动结束事件
        if (c.isDraggingImage) {
            window.dispatchEvent(new CustomEvent('canvasImageDragEnd'));
        }

        // 缩放结束：通知工具栏按新尺寸重新定位并恢复完整显示
        if (c.isResizing) {
            window.dispatchEvent(new CustomEvent('canvasImageResizeEnd'));
        }

        // 如果正在框选，根据选框范围选中图片
        if (c.isBoxSelecting) {
            this.applyBoxSelection(isShiftPressed);
        }

        // 重置所有交互状态
        c.isDraggingImage = false;
        c.dragTarget = null;
        c.dragOffsets = null;      // 清理拖动偏移记录
        c.dragStartMouse = null;
        c.isResizing = false;
        c.resizeTarget = null;
        c.resizeHandle = null;
        c.resizeStartRect = null;
        c.isPanning = false;
        this.isMiddleButtonPanning = false;
        c.isBoxSelecting = false;
        c.boxSelectStart = null;
        c.boxSelectEnd = null;
        c.canvas.classList.remove('panning');

        // 移除 window 级临时鼠标事件
        this._unbindWindowEvents();

        // 重置光标样式
        CanvasHitTester.updateCursorStyle(c, this.isSpacePressed);
        c.draw();
    }

    /**
     * 完成拖线：松手在目标图片上则建立连线，否则取消（onMouseUp 辅助方法）
     */
    _finishConnect() {
        const c = this.canvas;
        if (!c.isConnecting) return;

        const target = c.connectingHoverTarget;
        if (target) {
            // 正向拖线（从 out 口拉出）：from -> 目标
            // 反向拖线（从 in 口拉出）：目标 -> from
            const conn = c.connectingFromSide === 'out'
                ? c.connections.add(c.connectingFrom.id, target.id)
                : c.connections.add(target.id, c.connectingFrom.id);

            // 连接成功时触发事件，供后续 API/Comfy 提交环节监听
            if (conn) {
                window.dispatchEvent(new CustomEvent('canvasConnectionAdded', {
                    detail: { connection: conn }
                }));
            }
        }

        // 重置拖线状态
        c.isConnecting = false;
        c.connectingFrom = null;
        c.connectingFromSide = null;
        c.connectingMouse = null;
        c.connectingHoverTarget = null;

        CanvasHitTester.updateCursorStyle(c, this.isSpacePressed);
        c.draw();
    }

    /**
     * 完成连线点击断开：mousedown 起点与 mouseup 终点都命中同一条连线时视为点击断开
     * （onMouseUp 辅助方法；非拖拽状态下的点击断开）
     */
    _finishConnectionClick(e) {
        const c = this.canvas;
        if (!this._connectionClickCandidate || !e) return;

        const rect = c.canvas.getBoundingClientRect();
        const cp = c.viewport.screenToCanvas(e.clientX - rect.left, e.clientY - rect.top);
        const hit = c.connections.hitTest(cp.x, cp.y);
        if (hit && hit === this._connectionClickCandidate) {
            c.connections.remove(hit.id);
            c.hoverConnection = null;
            window.dispatchEvent(new CustomEvent('canvasConnectionRemoved', {
                detail: { connection: hit }
            }));
        }
        this._connectionClickCandidate = null;
        c.draw();
    }

    /**
     * 根据框选范围选中图片
     * @param {boolean} isShiftPressed - 是否按住 Shift（追加模式）
     */
    applyBoxSelection(isShiftPressed) {
        const c = this.canvas;

        // 计算选框范围
        const minX = Math.min(c.boxSelectStart.x, c.boxSelectEnd.x);
        const maxX = Math.max(c.boxSelectStart.x, c.boxSelectEnd.x);
        const minY = Math.min(c.boxSelectStart.y, c.boxSelectEnd.y);
        const maxY = Math.max(c.boxSelectStart.y, c.boxSelectEnd.y);

        // 非 Shift 模式下先清除已有选择
        if (!isShiftPressed) {
            c.images.select(null);
        }

        // 遍历所有图片，判断其区域是否与选框相交
        for (const img of c.images.images) {
            // 跳过生成反馈占位图
            if (NodeTypes.isPlaceholder(img.source)) continue;

            const imgLeft = img.x;
            const imgRight = imgLeft + img.width;
            const imgTop = img.y;
            const imgBottom = imgTop + img.height;

            // 判断图片显示区域与选框是否相交
            const isIntersecting = imgLeft < maxX && imgRight > minX &&
                                   imgTop < maxY && imgBottom > minY;

            if (isIntersecting) {
                if (isShiftPressed) {
                    // Shift 模式下切换选中状态
                    c.images.toggleSelect(img.id);
                } else {
                    // 普通模式下加入选中
                    c.images.selectedIds.add(img.id);
                    img.selected = true;
                }
            }
        }

        // 触发选择事件，通知工具栏等组件
        const selectedImages = c.images.getSelected();
        const lastSelected = selectedImages.length > 0 ? selectedImages[selectedImages.length - 1] : null;
        window.dispatchEvent(new CustomEvent('canvasImageSelected', {
            detail: { image: lastSelected }
        }));

    }
}
