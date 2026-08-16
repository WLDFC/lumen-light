/**
 * ==========================================================================
 * LumenLight 画布连线管理器
 * 作用：管理画布图片之间的连接线（类似节点编辑器的端口连线），
 *       用于把多张图片串联后一起提交给 API / ComfyUI 后端，
 *       功能定位类似图片工具栏的"添加到内容"，但以可视化连线表达。
 *
 * 模型约定：
 *   - 每张图片左右各一个端口圆点：左侧为输入端口（in），右侧为输出端口（out）
 *   - 连线方向：from 图片（起点，拖出线的图） -> to 图片（终点，接收内容的图）
 *   - 一对多：一张图片可以同时连出多条线（from 端可重复），每条连线带
 *     order 序号用于区分顺序（提交 API 时按 order 升序排列）
 *   - to 端允许多条入线（不同来源图片各自连入），但同一对 (fromId, toId)
 *     只允许一条连线，重复连接会被拒绝，避免视觉与数据双重冗余
 *   - 例外——生图节点（image-gen/comfy-gen）单入：入线只保留最新一条，
 *     新提示词连线直接静默替换原有入线（ComfyUI 习惯），换线即换链
 *
 * 坐标体系：
 *   所有几何计算均在世界坐标（画布逻辑坐标）下进行，绘制时由
 *   CanvasRenderer 应用视口变换；圆点尺寸做了反视口缩放补偿，
 *   保证屏幕上的视觉大小恒定。
 * ==========================================================================
 */

class CanvasConnections {
    /**
     * 构造函数
     * @param {Canvas} canvas - 画布主类实例（用于读取图片数据）
     */
    constructor(canvas) {
        this.canvas = canvas;
        // 连线数据数组，每条连线结构：
        // { id: string, fromId: string, toId: string, order: number }
        // id 用于事件与调试定位，fromId/toId 为图片对象 id，order 为同源连线的序号
        this.connections = [];
    }

    /**
     * 计算图片连线的锚点坐标（世界坐标）
     * 锚点位于图片左/右边缘的垂直中点，连线端点锚定在此，
     * 使线视觉上直接"长"在图片边缘，而不是与图片保持距离。
     * 提示词/生图节点例外：锚点与状态栏端口圆心重合（getPortPoint 节点分支），
     * 线精确接在圆点上。生图节点若落到通用图片分支，锚点会挂到左缘垂直
     * 中点，偏离其实际端口（状态栏内），且与拖线预览的吸附点不一致。
     * @param {Object} img - 图片对象
     * @param {'in'|'out'} side - 锚点方位：'in' 输入侧 | 'out' 输出侧
     * @returns {{x: number, y: number}} 锚点坐标
     */
    static getAnchorPoint(img, side) {
        // 端口节点（提示词/生图）：锚点即端口圆心（位于标题栏下方的状态栏行两端）
        if (NodeTypes.hasDomPorts(img.source)) {
            return img.getPortPoint(side);
        }
        const cy = img.y + img.height / 2;
        return side === 'in'
            ? { x: img.x, y: cy }
            : { x: img.x + img.width, y: cy };
    }

    /**
     * 计算图片端口的圆心坐标（世界坐标）
     * 输入端口位于图片左侧垂直居中，输出端口位于图片右侧垂直居中，
     * 均按配置的间距（默认 5px + 圆点半径）向外偏移，不与图片重叠。
     * 连线本身锚定在图片边缘（getAnchorPoint），绘制时线会穿过圆点。
     * 提示词节点例外：端口圆点嵌在节点边缘上（圆心落在边界线），
     * 与节点面板视觉上融为一体（参考 ComfyUI 节点样式）。
     * @param {Object} img - 图片对象
     * @param {'in'|'out'} side - 端口方位：'in' 输入端口 | 'out' 输出端口
     * @param {number} scale - 当前视口缩放比例（用于反缩放补偿，保持屏幕视觉大小恒定）
     * @returns {{x: number, y: number}} 端口圆心坐标
     */
    static getPortPoint(img, side, scale) {
        // 端口节点：端口是状态栏内的 DOM 圆点，直接返回其世界坐标
        if (NodeTypes.hasDomPorts(img.source)) {
            return img.getPortPoint(side);
        }
        const cy = img.y + img.height / 2;
        const radius = LumenLight.config.connectionDotRadius / scale;
        const gap = LumenLight.config.connectionDotGap / scale;
        if (side === 'in') {
            return { x: img.x - gap - radius, y: cy };
        }
        return { x: img.x + img.width + gap + radius, y: cy };
    }

    /**
     * 计算两点之间贝塞尔连线所需的四个控制点
     * 曲线水平方向凸出量与两点距离成正比，距离越远弧度越大，
     * 视觉上类似 ComfyUI 的节点连线。
     * @param {{x: number, y: number}} from - 起点坐标
     * @param {{x: number, y: number}} to - 终点坐标
     * @param {number} scale - 当前视口缩放比例（用于最小弧度的反缩放补偿）
     * @returns {Array<{x: number, y: number}>} [p0, cp1, cp2, p1] 四个控制点
     */
    static getBezierPoints(from, to, scale) {
        // 水平控制距离取两点横向距离的一半，并限制最小值，近距离时仍有弧度
        const dx = Math.max(Math.abs(to.x - from.x) * 0.5, 40 / scale);
        return [
            from,
            { x: from.x + dx, y: from.y },
            { x: to.x - dx, y: to.y },
            to
        ];
    }

    /**
     * 校验一条连线是否合法（连线规则）
     * 规则：
     *   - 提示词节点的输出（右端）只能连向其他提示词节点或生图节点的输入，
     *     不能连向图片（图片是内容载体，不接收提示词）
     *   - 生图节点没有输出端口，不能作为连线起点；图片也不能连入生图节点
     *     （生图节点左端只接收提示词）
     *   - 图片输出可连向图片或提示词节点（图片作为提示词的内容素材）
     *   - 占位图不可参与连线
     * @param {Object} fromObj - 起点对象（图片、PromptNode 或 ImageGenNode）
     * @param {Object} toObj - 终点对象（图片、PromptNode 或 ImageGenNode）
     * @returns {boolean} 合法返回 true
     */
    static isValidLink(fromObj, toObj) {
        if (!fromObj || !toObj || fromObj.id === toObj.id) return false;
        if (NodeTypes.isPlaceholder(fromObj.source) ||
            NodeTypes.isPlaceholder(toObj.source)) return false;
        // 文本节点是画布备注，不参与任何连线（两端都拒绝）
        if (NodeTypes.isTextNode(fromObj.source) ||
            NodeTypes.isTextNode(toObj.source)) return false;
        // 提示词节点 → 其他：只允许连向提示词节点、LoRA 节点或两类生图节点（禁止连图片）
        if (NodeTypes.isPromptNode(fromObj.source)) {
            return NodeTypes.isPromptNode(toObj.source) ||
                   NodeTypes.isLoraNode(toObj.source) ||
                   NodeTypes.isGenNode(toObj.source);
        }
        // LoRA 节点（文本透传）：右端口只能连向另一 LoRA 节点或生图节点
        // （作用范围沿链传递）；左端口只接收提示词节点或另一 LoRA 节点
        // （图片不是提示词，不接收）
        if (NodeTypes.isLoraNode(fromObj.source)) {
            return NodeTypes.isLoraNode(toObj.source) ||
                   NodeTypes.isGenNode(toObj.source);
        }
        if (NodeTypes.isLoraNode(toObj.source)) {
            return NodeTypes.isPromptNode(fromObj.source) ||
                   NodeTypes.isLoraNode(fromObj.source);
        }
        // 两类生图节点：无输出端口，不允许作为连线起点（防御）
        if (NodeTypes.isGenNode(fromObj.source)) return false;
        // 图片 → 生图节点：禁止（生图节点左端只接收提示词，
        // 参考图须连入提示词节点，随提示词链收集）
        if (NodeTypes.isGenNode(toObj.source)) return false;
        return true;
    }

    /**
     * 添加一条连线（从 from 图片连向 to 图片）
     * 目标是生图节点时为替换语义：先移除其全部已有入线再连入（单入，静默替换），
     * 详见类头"模型约定"。存档恢复路径在 clear 后调用，不受影响。
     * @param {string} fromId - 起点图片 id（内容输出方）
     * @param {string} toId - 终点图片 id（内容接收方）
     * @returns {Object|null} 成功返回新连线对象，失败（非法连线）返回 null
     */
    add(fromId, toId) {
        // 起终点不能是同一张图片，且两端图片必须真实存在
        if (!fromId || !toId || fromId === toId) return null;
        const findObj = (id) => this.canvas.images.images.find(img => img.id === id);
        const fromObj = findObj(fromId);
        const toObj = findObj(toId);
        if (!fromObj || !toObj) return null;

        // 校验连线规则（提示词节点右端不能接图片等）
        if (!CanvasConnections.isValidLink(fromObj, toObj)) return null;

        // 同一对图片之间只允许一条连线，重复连接直接拒绝
        // （含生图节点——把同一条线重拖一次视为无效操作，不动原线）
        if (this.connections.some(c => c.fromId === fromId && c.toId === toId)) return null;

        // 生图节点单入：已有提示词入线时，新连线直接静默替换（ComfyUI 习惯）。
        // 生图节点左端口只收提示词（isValidLink 已禁止图片连入），
        // 入线即"当前提示词链末端"，换线等于换整条链；
        // LoRA 节点同为单入（一条提示词/LoRA 上游链）；
        // 存档恢复在 clear 之后逐条 add，数组为空不会触发本分支
        if (NodeTypes.isGenNode(toObj.source) || NodeTypes.isLoraNode(toObj.source)) {
            this.connections = this.connections.filter(c => c.toId !== toId);
        }

        // order 取当前同源连线数量的相对序号，仅用于初始排序；
        // 精确顺序由 order 字段表达，后续可扩展拖拽排序等交互
        const order = this.connections.filter(c => c.fromId === fromId).length;

        const conn = { id: LumenLight.generateId(), fromId, toId, order };
        this.connections.push(conn);
        return conn;
    }

    /**
     * 删除一条连线
     * @param {string} id - 连线 id
     */
    remove(id) {
        this.connections = this.connections.filter(c => c.id !== id);
    }

    /**
     * 删除与指定图片相关的所有连线（图片被删除时调用）
     * @param {string} imageId - 图片 id
     */
    removeByImage(imageId) {
        this.connections = this.connections.filter(
            c => c.fromId !== imageId && c.toId !== imageId
        );
    }

    /**
     * 清空全部连线（新建画布 / 加载存档时调用）
     */
    clear() {
        this.connections = [];
    }

    /**
     * 清理已经失效的连线（引用的图片已不存在）
     * 采用惰性策略：不监听删除事件，每次绘制前统一清一遍，
     * 实现简单且不会遗漏边界场景（如加载存档后 id 全部变化）。
     */
    prune() {
        const validIds = new Set(this.canvas.images.images.map(img => img.id));
        this.connections = this.connections.filter(
            c => validIds.has(c.fromId) && validIds.has(c.toId)
        );
    }

    /**
     * 检测画布坐标是否命中连线（用于点击删除）
     * 采用采样法：沿贝塞尔曲线取若干点，判断坐标到采样点的距离。
     * 采样步长做了反视口缩放补偿，缩放越小采样越密，命中判定稳定。
     * @param {number} canvasX - 画布 X 命中
     * @param {number} canvasY - 画布 Y 命中
     * @returns {Object|null} 命中的连线对象，未命中返回 null
     */
    hitTest(canvasX, canvasY) {
        const scale = this.canvas.viewport.scale;
        // 屏幕上的命中容差（世界坐标），取线宽与固定容差中的较大者
        const tolerance = Math.max(
            LumenLight.config.connectionLineWidth,
            LumenLight.config.connectionHitTolerance
        ) / scale;

        for (const conn of this.connections) {
            const fromImg = this.canvas.images.images.find(img => img.id === conn.fromId);
            const toImg = this.canvas.images.images.find(img => img.id === conn.toId);
            if (!fromImg || !toImg) continue;

            const p = CanvasConnections.getBezierPoints(
                CanvasConnections.getAnchorPoint(fromImg, 'out'),
                CanvasConnections.getAnchorPoint(toImg, 'in'),
                scale
            );

            // 三次贝塞尔曲线采样检测
            const samples = 24;
            for (let i = 0; i <= samples; i++) {
                const t = i / samples;
                const x = this._bezier(t, p[0].x, p[1].x, p[2].x, p[3].x);
                const y = this._bezier(t, p[0].y, p[1].y, p[2].y, p[3].y);
                if (Math.hypot(canvasX - x, canvasY - y) <= tolerance) {
                    return conn;
                }
            }
        }
        return null;
    }

    /**
     * 三次贝塞尔单轴插值
     * @param {number} t - 参数 0~1
     * @param {number} p0 - 起点坐标分量
     * @param {number} p1 - 第一控制点分量
     * @param {number} p2 - 第二控制点分量
     * @param {number} p3 - 终点坐标分量
     * @returns {number} 插值结果
     */
    _bezier(t, p0, p1, p2, p3) {
        const u = 1 - t;
        return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
    }
}

// 将 CanvasConnections 类暴露到全局作用域
window.CanvasConnections = CanvasConnections;
