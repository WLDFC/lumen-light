/**
 * ==========================================================================
 * LumenLight 画布渲染器
 * 作用：负责画布上所有视觉元素的绘制，包括清空画布、应用视口变换、
 *       绘制图片连线、图片、端口圆点、拖线预览、选中边框、
 *       四角缩放控制点以及框选矩形。
 * 说明：本类只处理渲染逻辑，不处理用户交互，由 Canvas 主类调用。
 *       图片绘制走两层优化（见 ImageProxyCache）：
 *         1. 视口剔除——视野外的图片直接跳过 drawImage；
 *         2. 显示代理——缩小/常规视角画低分辨率副本，放大切回原图；
 *       两者只影响绘制路径，img.img 原始对象永不被修改，
 *       灯箱/放大/保存等消费原始数据的功能不受影响。
 * ==========================================================================
 */

class CanvasRenderer {
    /**
     * 构造函数：保存画布主类引用，方便读取画布状态和图片数据
     * @param {Canvas} canvas - 画布主类实例
     */
    constructor(canvas) {
        this.canvas = canvas;  // 画布主类引用
        // 图片显示代理缓存（降采样副本，键为 imageId）
        this.proxyCache = new ImageProxyCache();
    }

    /**
     * 绘制画布上的所有内容
     */
    draw() {
        const { canvas, ctx, viewport, images } = this.canvas;

        // 高 DPI 适配：整体按设备像素比放大绘制坐标系。
        // 之后所有绘制仍使用 CSS 像素坐标，逻辑无需感知 dpr。
        const dpr = this.canvas.dpr || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // 清空画布（CSS 像素尺寸即可覆盖整个区域）
        ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

        ctx.save();
        // 应用视口变换
        ctx.translate(viewport.offsetX, viewport.offsetY);
        ctx.scale(viewport.scale, viewport.scale);

        // 绘制编组的组体（垫在最底层：组背景必须压在连线与所有成员图片之下，
        // 这是组画在 canvas 里而不是做成 DOM 节点的根本原因）
        this.drawGroupBodies();

        // 绘制图片之间的连线（置于图片下层，视觉上层级更低）
        this.drawConnections();

        // 视口剔除：计算当前可视区域的世界坐标矩形（外扩少量边距，
        // 覆盖选中边框/控制点等溢出绘制），视野外的位图直接跳过 drawImage
        const margin = 64 / viewport.scale;
        const viewLeft = -viewport.offsetX / viewport.scale - margin;
        const viewTop = -viewport.offsetY / viewport.scale - margin;
        const viewRight = viewLeft + (canvas.width / dpr) / viewport.scale + margin * 2;
        const viewBottom = viewTop + (canvas.height / dpr) / viewport.scale + margin * 2;

        // 遍历绘制所有图片（面板节点是 DOM 元素，跳过 canvas 绘制）
        images.images.forEach(img => {
            if (NodeTypes.isPanelNode(img.source)) {
                // 同步节点 DOM 的屏幕位置（跟随视口平移/缩放）
                img.updateTransform();
                img.setSelected(img.selected);
                return;
            }

            // 视口剔除：图片矩形与可视矩形不相交则跳过绘制
            // （占位图是生成反馈动画，数量少且短暂，同样受益于剔除）
            const offscreen = img.x + img.width < viewLeft || img.x > viewRight ||
                              img.y + img.height < viewTop || img.y > viewBottom;
            if (offscreen) return;

            // 绘制图片：低分辨率档位下缩小/常规视角画显示代理（异步构建，
            // 未就绪或原生档/放大查看时画原图），原始对象不被修改
            // 视频对象始终绘制封面图（播放时由 DOM 播放器覆盖层接管）
            {
                const proxy = NodeTypes.isPlaceholder(img.source)
                    ? null   // 占位图是短暂的动画对象，不值得建缓存
                    : this.proxyCache.getDrawSource(img, viewport.scale, dpr);
                if (proxy) {
                    ctx.drawImage(proxy, img.x, img.y, img.width, img.height);
                } else {
                    ctx.drawImage(img.img, img.x, img.y, img.width, img.height);
                }
            }

            // 编辑笔迹层：非破坏性叠加（图片编辑器保存的涂画内容），
            // 始终画已加载的原生分辨率笔迹图，与底层图同位置同尺寸；
            // 图层透明度（editStrokesOpacity）<1 时按 alpha 叠加
            if (img.editStrokesImg) {
                const opacity = img.editStrokesOpacity ?? 1;
                if (opacity >= 1) {
                    ctx.drawImage(img.editStrokesImg, img.x, img.y, img.width, img.height);
                } else {
                    ctx.save();
                    ctx.globalAlpha = opacity;
                    ctx.drawImage(img.editStrokesImg, img.x, img.y, img.width, img.height);
                    ctx.restore();
                }
            }

            // 遮罩层：局部重绘遮罩（遮罩灯箱保存）非破坏性叠加，固定半透明
            // 红色显示（与灯箱内观感一致）。仅影响画布绘制——合成出口
            // （getCompositeSrc：下载/收藏/加内容）与 Comfy 槽位图的烘焙
            // 语义各自独立处理，不会把遮罩误当笔迹烘进作品
            if (img.maskImg) {
                ctx.save();
                ctx.globalAlpha = 0.55;
                ctx.drawImage(img.maskImg, img.x, img.y, img.width, img.height);
                ctx.restore();
            }

            // 视频对象：绘制播放图标覆盖层（提示双击可播放）
            if (NodeTypes.isVideo(img.source)) {
                this.drawVideoOverlay(img, viewport.scale);
            }

            // 如果图片被选中且不是生成反馈占位图，绘制选中边框
            if (img.selected && !NodeTypes.isPlaceholder(img.source)) {
                this.drawSelection(img);
            }
        });

        // 单选状态下绘制缩放控制点。
        // 放在图片循环之后统一绘制，避免层级更高的图片盖住控制点导致无法点击。
        // 多选时不绘制：多选只支持整体拖动，避免整组联动缩放的坐标复杂度。
        // 注意：用户在设置里关闭锚点显示时，这里只跳过绘制，
        //       交互层的命中检测不受影响，因此缩放功能依然可用。
        if (images.selectedIds.size === 1 && SettingsManager.getShowResizeHandles()) {
            const target = images.getSelected()[0];
            if (target && NodeTypes.isRealCanvasImage(target) &&
                CanvasRenderer.shouldShowHandles(target, viewport.scale)) {
                this.drawResizeHandles(target);
            }
        }

        // 绘制选中组的顶层描边与四边缩放手柄（放在图片循环之后，
        // 避免层级更高的成员图片盖住手柄导致无法点击）
        this.drawGroupOverlays();

        // 绘制端口圆点（置于图片上层，保证圆点不被相邻图片遮挡）
        this.drawConnectionDots();

        // 如果正在拖出连线，绘制跟随鼠标的预览曲线（最高层级）
        if (this.canvas.isConnecting) {
            this.drawConnectingLine();
        }

        // 如果正在框选，绘制框选矩形
        if (this.canvas.isBoxSelecting && this.canvas.boxSelectStart && this.canvas.boxSelectEnd) {
            this.drawBoxSelection();
        }

        ctx.restore();

        // 同步视频播放器覆盖层位置（跟随视口平移/缩放）
        this.canvas.videoManager.syncPlayer();
    }

    /**
     * 圆角矩形路径（arcTo 实现，不依赖较新的 ctx.roundRect）。
     * 半径超组尺寸一半时自动钳制（极小组不会画出畸形路径）。
     * 仅供组体绘制使用：节点是 DOM（圆角由 CSS border-radius 保证），
     * 组画在 canvas 上需要手动构路径
     * @param {CanvasRenderingContext2D} ctx - 绘图上下文
     * @param {number} x - 左上角 X（世界坐标）
     * @param {number} y - 左上角 Y
     * @param {number} w - 宽
     * @param {number} h - 高
     * @param {number} r - 圆角半径
     */
    roundRectPath(ctx, x, y, w, h, r) {
        const rr = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + rr, y);
        ctx.arcTo(x + w, y, x + w, y + h, rr);
        ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr);
        ctx.arcTo(x, y, x + w, y, rr);
        ctx.closePath();
    }

    /**
     * 绘制所有编组的组体（最底层）：
     * 半透明深色面板底 + 标题栏色带 + 灰边框 + 标题文字，
     * 配色取自节点面板（.text-node：#1b1c21 底、白色半透明标题带、
     * rgba(128,128,128,0.3) 边框），组选中时边框换成节点青。
     * 标题栏走节点的 ns 缩放体系（GroupManager.getTitleMetrics 共享度量：
     * 高 = 48 × ns、字号 = 18 × ns），组与节点在任何缩放级别下观感一致；
     * 文字超宽时裁剪在标题栏内。
     */
    drawGroupBodies() {
        const groups = this.canvas.groups ? this.canvas.groups.groups : [];
        if (groups.length === 0) return;
        const { ctx, viewport, canvas } = this.canvas;
        const scale = viewport.scale;
        const dpr = this.canvas.dpr || 1;

        // 视口剔除（与图片剔除同一公式）
        const margin = 64 / scale;
        const viewLeft = -viewport.offsetX / scale - margin;
        const viewTop = -viewport.offsetY / scale - margin;
        const viewRight = viewLeft + (canvas.width / dpr) / scale + margin * 2;
        const viewBottom = viewTop + (canvas.height / dpr) / scale + margin * 2;

        for (const g of groups) {
            if (g.x + g.width < viewLeft || g.x > viewRight ||
                g.y + g.height < viewTop || g.y > viewBottom) continue;

            // 标题栏度量（世界坐标，ns 缩放，与节点标题栏同款）
            const metrics = GroupManager.getTitleMetrics(g);
            // 圆角 = 8px × ns（节点面板圆角参数，node.css border-radius
            // calc(8px * var(--ns))）；ns 用组自身 titleNS，与标题栏同套缩放
            const radius = 8 * GroupManager.getTitleNS(g);

            // 组体：半透明节点底色（空处透出画布网格，成员图片画在其上）
            ctx.fillStyle = 'rgba(27, 28, 33, 0.6)';
            this.roundRectPath(ctx, g.x, g.y, g.width, g.height, radius);
            ctx.fill();

            // 标题栏色带：clip 在组圆角路径内再画矩形——顶部两角跟随组
            // 圆角，色带不会溢出圆角轮廓（节点 header 与面板圆角的同款关系）
            ctx.save();
            this.roundRectPath(ctx, g.x, g.y, g.width, g.height, radius);
            ctx.clip();
            // 标题栏色带：默认白色半透明（与节点标题栏同语言）；
            // 组指定了颜色时用对应预设色带（色值唯一出处 GroupManager.COLOR_PRESETS）
            ctx.fillStyle = (GroupManager.COLOR_PRESETS[g.color] || GroupManager.COLOR_PRESETS['']).band;
            ctx.fillRect(g.x, g.y, g.width, metrics.height);
            ctx.restore();

            // 标题文字（超宽裁剪在标题栏内，字号随 ns 缩放）。
            // 改名期间跳过：输入框底色半透明，画布文字不隐藏会叠字
            if (!this.canvas.groups.isRenaming(g)) {
                ctx.save();
                ctx.beginPath();
                ctx.rect(g.x, g.y, g.width, metrics.height);
                ctx.clip();
                ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
                ctx.font = `${metrics.font}px "Segoe UI", "Microsoft YaHei", sans-serif`;
                ctx.textBaseline = 'middle';
                ctx.textAlign = 'left';
                ctx.fillText(g.title || GroupManager.DEFAULT_TITLE,
                             g.x + metrics.inset, g.y + metrics.height / 2 + 1 / scale);
                ctx.restore();
            }

            // 未选中的组画灰边框（圆角与组体一致）；
            // 选中组的描边放到 drawGroupOverlays 顶层绘制
            if (!g.selected) {
                ctx.strokeStyle = 'rgba(128, 128, 128, 0.3)';
                ctx.lineWidth = 1 / scale;
                this.roundRectPath(ctx, g.x, g.y, g.width, g.height, radius);
                ctx.stroke();
            }
        }

        // 改名输入框逐帧对位（若开着）：一切视觉变化（缩放/平移/拖动）
        // 最终都汇入 draw，这里是权威同步点，输入框永不与标题栏脱节
        this.canvas.groups.syncRenameTransform();
    }

    /**
     * 绘制选中组的顶层描边与四边缩放手柄（单选组时）。
     * 选中描边用节点青 #6cebff（与图片/节点选中语言一致）；
     * 手柄是屏幕恒定尺寸的青色短条，几何由 GroupManager.getEdgeHandleRects
     * 提供（与命中检测共用，保证所见即可抓）。
     */
    drawGroupOverlays() {
        const groups = this.canvas.groups;
        if (!groups || groups.selectedIds.size !== 1) return;
        const group = groups.getSelected()[0];
        if (!group) return;

        const { ctx } = this.canvas;
        const scale = this.canvas.viewport.scale;

        // 选中描边（线宽反缩放补偿，屏幕恒定；圆角与组体一致）
        ctx.strokeStyle = '#6cebffff';
        ctx.lineWidth = 1.7 / scale;
        this.roundRectPath(ctx, group.x, group.y, group.width, group.height,
            8 * GroupManager.getTitleNS(group));
        ctx.stroke();

        // 四边中点手柄
        ctx.fillStyle = '#6cebff';
        for (const h of GroupManager.getEdgeHandleRects(group, scale)) {
            ctx.fillRect(h.x, h.y, h.w, h.h);
        }
    }

    /**
     * 绘制图片之间的所有连线
     * 每次绘制前先惰性清理引用了已删除图片的失效连线。
     * 悬停高亮的连线（interaction 层记录的 hoverConnection）用红色绘制，
     * 提示用户点击可断开。
     */
    drawConnections() {
        const { ctx, viewport } = this.canvas;
        const connections = this.canvas.connections;
        if (!connections) return;

        // 惰性清理失效连线（图片已删除但连线残留的情况）
        connections.prune();
        if (connections.connections.length === 0) return;

        const scale = viewport.scale;
        ctx.lineWidth = LumenLight.config.connectionLineWidth / scale;
        ctx.lineCap = 'round';

        for (const conn of connections.connections) {
            const fromImg = this.canvas.images.images.find(img => img.id === conn.fromId);
            const toImg = this.canvas.images.images.find(img => img.id === conn.toId);
            if (!fromImg || !toImg) continue;

            const p = CanvasConnections.getBezierPoints(
                CanvasConnections.getAnchorPoint(fromImg, 'out'),
                CanvasConnections.getAnchorPoint(toImg, 'in'),
                scale
            );

            // 悬停高亮：红色提示可点击断开；普通连线为不透明青色（与选中边框同色系）。
            // 使用不透明颜色：半透明色在边缘与背景混色，会让线条看起来发虚。
            const isHovered = this.canvas.hoverConnection === conn;
            ctx.strokeStyle = isHovered ? '#ff5555' : '#6cebff';
            ctx.lineWidth = (isHovered ? LumenLight.config.connectionLineWidth + 1
                                       : LumenLight.config.connectionLineWidth) / scale;

            ctx.beginPath();
            ctx.moveTo(p[0].x, p[0].y);
            ctx.bezierCurveTo(p[1].x, p[1].y, p[2].x, p[2].y, p[3].x, p[3].y);
            ctx.stroke();
        }
    }

    /**
     * 绘制图片的端口圆点
     * 显示时机：
     *   1. 正在拖线时 —— 所有图片都显示左右端口，辅助用户瞄准目标
     *   2. 平时 —— 仅被选中的图片显示端口
     * 占位图不显示端口（不可参与连线）。
     */
    drawConnectionDots() {
        const { ctx, viewport, images } = this.canvas;
        const scale = viewport.scale;
        const showAll = this.canvas.isConnecting;

        for (const img of images.images) {
            // 占位图不参与连线；端口节点（提示词/生图）端口是 DOM 圆点
            // （骑在面板边缘上），不在 canvas 层绘制，避免被节点面板遮挡错位；
            // 文本节点无端口不参与连线
            if (NodeTypes.isPlaceholder(img.source) ||
                NodeTypes.isPanelNode(img.source)) continue;

            const shouldShow = showAll || img.selected;
            if (!shouldShow) continue;

            const radius = LumenLight.config.connectionDotRadius / scale;
            const inPoint = CanvasConnections.getPortPoint(img, 'in', scale);
            const outPoint = CanvasConnections.getPortPoint(img, 'out', scale);

            ctx.fillStyle = '#6cebffff';
            ctx.strokeStyle = 'rgba(15, 23, 32, 0.9)';
            ctx.lineWidth = 1.2 / scale;

            for (const pt of [inPoint, outPoint]) {
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
        }
    }

    /**
     * 绘制拖线过程中的预览曲线
     * 从起点端口到当前鼠标位置，半透明青色，帮助用户预览连线走向；
     * 悬停到目标对象（图片/节点）上时，端点自动吸附到对方的对侧端口，
     * 直观呈现"松手即连接"的结果。
     * 反向拖线（从输入端口拉出）时曲线方向相反：终点作为 from。
     */
    drawConnectingLine() {
        const { ctx, viewport } = this.canvas;
        const c = this.canvas;
        if (!c.connectingFrom || !c.connectingMouse) return;

        const scale = viewport.scale;
        // 线的端点锚定图片边缘（视觉上直接连到图片），穿过边缘外的端口圆点
        const fromPoint = CanvasConnections.getAnchorPoint(c.connectingFrom, c.connectingFromSide);

        // 悬停目标存在时，预览线端点吸附到对方的对侧端口
        // （正向拖线吸附目标 in 口，反向拖线吸附目标 out 口）
        let endPoint = c.connectingMouse;
        if (c.connectingHoverTarget) {
            const hoverSide = c.connectingFromSide === 'out' ? 'in' : 'out';
            endPoint = CanvasConnections.getPortPoint(c.connectingHoverTarget, hoverSide, scale);
        }

        // 正向拖线（out -> 目标）；反向拖线（目标 -> in）调换起终点
        const p = c.connectingFromSide === 'out'
            ? CanvasConnections.getBezierPoints(fromPoint, endPoint, scale)
            : CanvasConnections.getBezierPoints(endPoint, fromPoint, scale);

        ctx.strokeStyle = '#6cebff';
        ctx.lineWidth = LumenLight.config.connectionLineWidth / scale;
        ctx.lineCap = 'round';

        ctx.beginPath();
        ctx.moveTo(p[0].x, p[0].y);
        ctx.bezierCurveTo(p[1].x, p[1].y, p[2].x, p[2].y, p[3].x, p[3].y);
        ctx.stroke();
    }

    /**
     * 绘制框选矩形
     * 样式与选中图片的蓝色边框保持一致
     */
    drawBoxSelection() {
        const { ctx, viewport } = this.canvas;
        const start = this.canvas.boxSelectStart;
        const end = this.canvas.boxSelectEnd;

        const x = Math.min(start.x, end.x);
        const y = Math.min(start.y, end.y);
        const width = Math.abs(end.x - start.x);
        const height = Math.abs(end.y - start.y);

        // 绘制蓝色边框，与选中图片边框样式一致
        ctx.strokeStyle = '#6cebffff';
        ctx.lineWidth = 1.5 / viewport.scale;
        ctx.strokeRect(x, y, width, height);

        // 填充半透明蓝色背景，增强视觉效果
        ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
        ctx.fillRect(x, y, width, height);
    }

    /**
     * 绘制选中图片的边框
     * @param {Object} img - 图片对象
     */
    drawSelection(img) {
        const { ctx, viewport } = this.canvas;

        // 绘制蓝色边框（基于原始尺寸）
        ctx.strokeStyle = '#6cebffff';
        ctx.lineWidth = 1.7 / viewport.scale;
        ctx.strokeRect(
            img.x - 1 / viewport.scale,
            img.y - 1 / viewport.scale,
            img.width + 2 / viewport.scale,
            img.height + 2 / viewport.scale
        );
    }

    /**
     * 绘制视频对象的播放提示覆盖层：
     * 中心显示半透明圆形背景 + 白色三角形播放图标，提示双击可播放
     * @param {Object} img - 视频画布对象
     * @param {number} scale - 当前视口缩放比
     */
    drawVideoOverlay(img, scale) {
        const { ctx } = this.canvas;
        const cx = img.x + img.width / 2;
        const cy = img.y + img.height / 2;

        // 中心播放按钮：半透明黑色圆形 + 白色三角形
        const r = Math.min(img.width, img.height) * 0.12;
        ctx.save();
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = '#000000';
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        const triSize = r * 0.5;
        ctx.moveTo(cx - triSize * 0.4, cy - triSize);
        ctx.lineTo(cx - triSize * 0.4, cy + triSize);
        ctx.lineTo(cx + triSize * 0.8, cy);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    /**
     * 绘制四角缩放控制点（白色填充的圆点 + 描边）
     * 仅在单选状态下调用，多选时不绘制（多选只支持整体拖动）
     * @param {Object} img - 图片对象
     */
    drawResizeHandles(img) {
        const { ctx, viewport } = this.canvas;

        // 控制点尺寸除以视口缩放，保证在屏幕上的视觉大小恒定，不随画布缩放变化
        const size = LumenLight.config.resizeHandleSize / viewport.scale;
        const handles = CanvasRenderer.getHandleRects(img, size);
        const radius = size / 2;

        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#6cebffff';
        ctx.lineWidth = 1.7 / viewport.scale;

        for (const h of handles) {
            // 几何数据仍以外接正方形描述，圆心即该正方形的中心（也就是图片的角点）
            ctx.beginPath();
            ctx.arc(h.x + radius, h.y + radius, radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    }

    /**
     * 计算四角控制点的外接正方形几何（世界坐标）
     * 控制点以图片四个角为中心对齐，一半在图内一半在图外，是通用的交互习惯。
     * 该方法同时被渲染（绘制圆点的外接正方形）与交互（矩形命中检测）复用，
     * 确保两者几何永远一致。命中用矩形而非圆形是有意为之：矩形外接于圆点，
     * 判定范围略宽松，小控制点更易抓取。
     * @param {Object} img - 图片对象
     * @param {number} size - 控制点外接正方形边长（世界坐标，已做反视口缩放补偿）
     * @returns {Array<{name: string, x: number, y: number, size: number}>} 控制点矩形数组
     */
    static getHandleRects(img, size) {
        const half = size / 2;
        const left = img.x;
        const right = img.x + img.width;
        const top = img.y;
        const bottom = img.y + img.height;

        // 顺序为左上、右上、右下、左下，name 用于交互层判断拖拽方位
        return [
            { name: 'nw', x: left - half, y: top - half, size },
            { name: 'ne', x: right - half, y: top - half, size },
            { name: 'se', x: right - half, y: bottom - half, size },
            { name: 'sw', x: left - half, y: bottom - half, size }
        ];
    }

    /**
     * 判断当前视口下是否适合显示缩放控制点
     * 控制点尺寸在屏幕上是固定的，当图片在屏幕上显示得过小时（画布缩得很小、
     * 或图片本身很小），四角控制点会几乎盖满整张图，导致图片无法再被拖动。
     * 此时暂不显示控制点，用户放大画布后即可恢复。
     * @param {Object} img - 图片对象
     * @param {number} scale - 当前视口缩放比例
     * @returns {boolean} 是否显示控制点
     */
    static shouldShowHandles(img, scale) {
        // 要求图片在屏幕上的宽高都至少为控制点直径的 3 倍，
        // 保证扣掉四角后中间仍留有足够的可拖动区域
        const minScreenSize = LumenLight.config.resizeHandleSize * 3;
        return img.width * scale >= minScreenSize && img.height * scale >= minScreenSize;
    }
}
