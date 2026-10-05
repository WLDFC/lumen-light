/**
 * ==========================================================================
 * LumenLight 画布主类
 * 作用：负责整个画布的生命周期管理，包括初始化、尺寸调整、状态维护，
 *       并协调渲染器、交互管理器和剪贴板管理器完成具体工作。
 * 说明：本类持有画布核心状态（选中、拖拽、平移等），各子模块通过引用
 *       本类实例进行协作，避免状态分散。
 * ==========================================================================
 */

class Canvas {
    /**
     * 构造函数：获取画布 DOM 元素，初始化视口、图片管理器和各子模块
     */
    constructor() {
        this.canvas = document.getElementById('board');  // 画布 DOM 元素
        this.ctx = this.canvas.getContext('2d');         // 2D 绘图上下文
        this.viewport = new Viewport();                  // 视口管理器
        this.images = new ImageManager();                // 图片管理器

        // 节点编号计数器（#001 起递增，随存档持久化，删除不复用）。
        // 存档恢复/新建画布时分别做下限同步与归零（ProjectSerializer/NewCanvasManager）
        this.nodeSeq = 0;

        // 拖动/平移状态（由 CanvasInteraction 读写）
        this.isDraggingImage = false;    // 是否正在拖动图片
        this.isPanning = false;          // 是否正在平移画布
        this.isBoxSelecting = false;     // 是否正在进行框选
        this.boxSelectStart = null;      // 框选起点（画布坐标）
        this.boxSelectEnd = null;        // 框选终点（画布坐标）
        this.lastMouse = { x: 0, y: 0 }; // 上一次鼠标位置
        this.dragTarget = null;          // 当前拖动的目标图片
        this.dragOffsets = null;         // 选中图片相对于鼠标的偏移数组
        this.dragStartMouse = null;      // 拖动开始时的鼠标位置

        // 缩放状态（由 CanvasInteraction 读写）
        this.isResizing = false;         // 是否正在拖角缩放图片
        this.resizeTarget = null;        // 当前缩放的目标图片
        this.resizeHandle = null;        // 当前拖拽的控制点方位：'nw' | 'ne' | 'se' | 'sw'
        this.resizeStartRect = null;     // 缩放开始时图片的矩形快照 {x, y, width, height}

        // 连线状态（由 CanvasInteraction 读写，数据由 connections 管理）
        this.isConnecting = false;       // 是否正在拖出一条连线
        this.connectingFrom = null;      // 拖线的起点图片对象
        this.connectingFromSide = null;  // 拖线起点端口方位：'out' | 'in'
        this.connectingMouse = null;     // 拖线过程中鼠标的画布坐标 {x, y}
        this.connectingHoverTarget = null; // 拖线过程中鼠标悬停的目标图片（用于高亮反馈）
        this.hoverConnection = null;     // 鼠标悬停的连线（用于红色高亮与点击断开）

        // 编组（Group）手势状态（由 CanvasInteraction 读写，数据在 this.groups 管理）
        this.isDraggingGroup = false;    // 是否正在拖动组（标题栏拖动，成员联动）
        this.dragGroup = null;           // 当前拖动的组对象
        this.groupDragOrigin = null;     // 拖动开始的鼠标画布坐标 {x, y}
        this.groupDragStartRect = null;  // 拖动开始的组矩形快照 {x, y}
        this.groupDragMembers = null;    // 拖动开始时的成员快照 [{obj, ox, oy}]
        this.isResizingGroup = false;    // 是否正在拖组边缘手柄缩放
        this.resizeGroupTarget = null;   // 当前缩放的组对象
        this.resizeGroupHandle = null;   // 手柄方位 'n'|'s'|'w'|'e'
        this.resizeGroupStartRect = null;// 缩放开始的组矩形快照 {x, y, width, height}

        this.init();
    }

    /**
     * 分配下一个节点编号（BaseCanvasNode 构造时调用；只增不减防顶替）
     * @returns {number}
     */
    allocNodeSeq() {
        return ++this.nodeSeq;
    }

    /**
     * 编号计数器下限同步（存档恢复时调用）：取当前值与存档记录值的较大者——
     * 存档里删过节点时记录值大于现有节点最大编号，保证新节点不复用旧编号
     * @param {number} saved - 存档里的 nodeSeq
     */
    syncNodeSeq(saved) {
        if (Number.isFinite(saved) && saved > this.nodeSeq) this.nodeSeq = saved;
    }

    /**
     * 初始化画布：设置尺寸、创建子模块并首次绘制
     */
    init() {
        // 先设置画布尺寸，再创建子模块，避免 resize() 中 draw() 访问未初始化的渲染器
        this.applyDprSize();
        window.addEventListener('resize', () => this.resize()); // 窗口大小变化时重设尺寸

        // 创建并协调各子模块（history 最先：各管理器的记录点回查
        // canvas.history；groups 先于 renderer 创建：渲染器绘制组体时读取）
        this.history = new CanvasHistory(this);         // 撤销/重做命令栈
        // 命令淘汰时的视频文件清理接线（引用计数与后端 DELETE 在 ImageManager）
        this.history.onFlushVideoFile = (url) => this.images.cleanupVideoFileByUrl(url);
        this.groups = new GroupManager(this);           // 编组管理器
        this.renderer = new CanvasRenderer(this);       // 渲染器
        this.interaction = new CanvasInteraction(this); // 交互管理器
        this.videoManager = new CanvasVideoManager(this); // 视频播放管理器
        this.clipboard = new CanvasClipboard(this);     // 剪贴板管理器
        this.connections = new CanvasConnections(this); // 连线管理器
        this.contextMenu = new CanvasContextMenu(this); // 右键节点菜单

        this.drawNow();   // 首帧同步绘制，避免初始化竞态
    }

    /**
     * 按设备像素比（devicePixelRatio）设置画布位图尺寸
     * 高 DPI 屏幕上位图尺寸 = CSS 尺寸 × dpr，配合渲染器开头的 ctx.scale(dpr)，
     * 坐标系仍保持 CSS 像素不变（命中检测、视口换算均不受影响），
     * 但线条与圆点按物理像素绘制，消除高 DPI 下的模糊发虚问题。
     */
    applyDprSize() {
        const dpr = window.devicePixelRatio || 1;
        this.dpr = dpr;
        // CSS 尺寸由样式表控制（100vw/100vh），这里只负责位图尺寸
        this.canvas.width = Math.round(window.innerWidth * dpr);
        this.canvas.height = Math.round(window.innerHeight * dpr);
    }

    /**
     * 调整画布尺寸为窗口大小，并重绘
     */
    resize() {
        this.applyDprSize();
        this.draw();
    }

    /**
     * 画布 CSS 宽度（逻辑像素）
     * 高 DPI 适配后 canvas.width 为物理像素，屏幕坐标计算请统一使用本值。
     */
    get cssWidth() {
        return window.innerWidth;
    }

    /**
     * 画布 CSS 高度（逻辑像素）
     * 高 DPI 适配后 canvas.height 为物理像素，屏幕坐标计算请统一使用本值。
     */
    get cssHeight() {
        return window.innerHeight;
    }

    /**
     * 绘制画布上的所有内容（委托给渲染器）。
     * 重绘合帧：高频事件（mousemove 等）会连续触发 draw，这里用
     * rAF + 脏标记把一帧内的多次请求合并为一次实际绘制——
     * 高频鼠标下不再逐事件全量重绘；切回标签页的图片解码重建期，
     * 重绘成本也按帧封顶，显著缩短恢复期的卡顿。
     * rAF 回调在下一帧绘制前执行，视觉时序与同步绘制一致。
     */
    draw() {
        if (this._drawScheduled) return;
        this._drawScheduled = true;
        requestAnimationFrame(() => {
            this._drawScheduled = false;
            this.renderer.draw();
        });
    }

    /**
     * 立即同步重绘（跳过合帧），仅供初始化等确需当帧完成的场景使用
     */
    drawNow() {
        this.renderer.draw();
    }

    /**
     * 自适应所有图片到屏幕可视区域
     */
    fitToScreen() {
        this.viewport.fitToBounds(this.images.images, this.cssWidth, this.cssHeight);
        this.draw();
    }
}
