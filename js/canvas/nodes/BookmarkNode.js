/**
 * ==========================================================================
 * LumenLight 书签节点（画布编组快捷跳转目录）
 * ==========================================================================
 * 作用：以编组为锚点的目录节点——自动绑定画布里的全部编组，行式列表
 *       （左数字快捷键徽标 + 中组名 + 右 → 跳转图标），点击行或按数字键
 *       1-9/0 把视口平移到对应编组（保持当前缩放仅居中）。
 *
 * 绑定语义（纯派生，不存快照）：
 *   - 条目实时从 canvas.groups.groups 按 id 派生：组改名自动同步、
 *     删除/解散自动消失、新建自动出现（GroupManager / CanvasHistory /
 *     ProjectSerializer 在组集合变化时派发 canvasGroupsChanged，本节点
 *     监听后刷新行列表）；
 *   - 因此 toJSON 只持久化几何与标题，绑定关系不进存档。
 *
 * 快捷键编号（按组全局分配）：
 *   - collectShortcutAssignments(canvas) 按 seqId 升序遍历全部书签节点，
 *     对组条目（按 groups 数组顺序）按组 id 去重后依次分配 1..9、0
 *     共 10 个名额——数字键属于组而非属于某个节点，多节点徽标显示一致；
 *   - 允许多个书签节点；同一组只占一个名额（先到先得，后建者无效）；
 *   - 组被删除后条目消失，剩余条目编号前移补位。
 *
 * 与文本节点（TextNode）的关系：
 *   - 视觉样式复用 .text-node 面板（标题栏 + body + 缩放手柄），无端口
 *     不参与连线，不参与提示词收集与生图流程，仅作为节点数据（toJSON）
 *     存档，恢复/复制粘贴按 type（NodeTypes.SOURCE.BOOKMARK_NODE）分发重建。
 *
 * 交互职责划分（与 TextNode 一致）：
 *   - 节点面板的选中/拖动/缩放由 CanvasInteraction 统一处理
 *     （本类只透传 mousedown，标记 e._canvasNodeTarget）；
 *   - 行内 → 按钮 stopPropagation，点击跳转不触发节点拖动。
 * ==========================================================================
 */

class BookmarkNode extends BaseCanvasNode {
    /**
     * 创建书签节点并挂载 DOM
     * @param {Canvas} canvas - 画布主类实例
     * @param {number} x - 节点左上角画布 X 坐标
     * @param {number} y - 节点左上角画布 Y 坐标
     * @param {Object} [size] - 初始尺寸 {width, height}（缺省用类常量默认值）
     */
    constructor(canvas, x, y, size = {}) {
        super(canvas, x, y);
        this.source = NodeTypes.SOURCE.BOOKMARK_NODE;

        this.width = size.width || BookmarkNode.DEFAULT_WIDTH;
        this.height = size.height || BookmarkNode.DEFAULT_HEIGHT;
        // 高度自适应下限（创建/存档时的高度），条目减少时回缩到它为止
        this._heightFloor = this.height;

        this.buildDom();
        this.bindEvents();
        this.updateTransform();
        this.refreshRows();
        // 序列号补算：所有创建路径（右键菜单/存档恢复/粘贴/撤销重建）都是
        // 构造之后才把节点 push 进 canvas.images.images，构造时的首次
        // refreshRows 里分配表还看不到本节点（徽标只会显示占位点）——
        // 微任务里再刷一次，此时 push 已同步完成、组集合也已就绪
        queueMicrotask(() => this.refreshRows());

        // 组集合变化（新建/删除/改名/撤销重做/存档恢复）→ 刷新行列表
        this._onGroupsChanged = () => this.refreshRows();
        window.addEventListener('canvasGroupsChanged', this._onGroupsChanged);
    }

    /**
     * 构建 DOM 结构：标题栏 + 行列表容器 + 缩放手柄（无端口行，不可连线）
     * 样式类与 TextNode 共用同一套 .text-node 体系（css/node.css），
     * 徽标文字「书签」区分节点类型
     */
    buildDom() {
        this.el = document.createElement('div');
        this.el.className = 'text-node bookmark-node';
        // data-id 供事件委托时反查节点
        this.el.dataset.id = this.id;

        this.el.innerHTML = `
            <div class="text-node-header">
                <span class="text-node-title">Bookmarks</span>
                <span class="text-node-badge">书签</span>
            </div>
            <div class="text-node-body">
                <div class="bookmark-rows"></div>
            </div>
            <div class="text-node-resize" title="拖拽调整大小"></div>
        `;

        this.rowsEl = this.el.querySelector('.bookmark-rows');
        this.resizeEl = this.el.querySelector('.text-node-resize');

        // 标题双击重命名（基类共用实现，各节点同一套交互）
        this.initTitleEditor();

        // 挂到画布容器（canvas 元素的父级，即 body），跟随视口变换
        document.body.appendChild(this.el);
    }

    /**
     * 绑定节点内部 DOM 事件
     * 交互职责划分（与 TextNode 一致）：
     *   - 节点面板的点击/拖动由 CanvasInteraction 统一处理（本类只透传 mousedown）
     *   - 行内 → 按钮与整行点击都做跳转，stopPropagation 防误入拖动流程
     */
    bindEvents() {
        // mousedown 转发给画布交互层：节点是 DOM 元素浮在 canvas 上方，
        // 事件不会自然到达 canvas，必须主动转发才能复用统一的选中/拖动逻辑。
        // e._canvasNodeTarget 标记本节点，交互层据此进入节点专属交互流程。
        // 点击行/按钮：拦截转发，走跳转逻辑（见下方行级委托）
        this.el.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;   // 只转发左键
            if (e.target.closest('.bookmark-row')) {
                e.stopPropagation();
                return;
            }
            e._canvasNodeTarget = this;
            this.canvas.interaction.onMouseDown(e);
        });

        // 行列表事件委托：点击整行或 → 图标都跳转对应编组
        this.rowsEl.addEventListener('click', (e) => {
            const row = e.target.closest('.bookmark-row');
            if (!row) return;
            const group = this.canvas.groups.groups.find(
                (g) => g.id === row.dataset.groupId
            );
            if (group) this.jumpToGroup(group);
        });

        // 缩放手柄：悬停光标 + 按下立即进入缩放（拦截冒泡，避免被
        // 上方的 el 转发逻辑当作普通面板点击处理成拖动）
        this.resizeEl.addEventListener('mouseenter', () => {
            this.el.style.cursor = 'nwse-resize';
        });
        this.resizeEl.addEventListener('mouseleave', () => {
            this.el.style.cursor = '';
        });
        this.resizeEl.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e._canvasNodeTarget = this;
            this.canvas.interaction.onMouseDown(e);
        });

        // 滚轮缩放画布（与 TextNode 非编辑态同规则）
        this.el.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.canvas.interaction.handleWheel(e);
        }, { passive: false });

        // 右键在节点上：不弹画布菜单（与图片/其他节点一致）
        this.el.addEventListener('contextmenu', (e) => {
            e.stopPropagation();
        });
    }

    /**
     * 刷新行列表：从 canvas.groups.groups 实时派生条目（纯派生绑定，
     * 组 id 不在本节点持久化），跳过已删除的组；编号按全局分配结果显示。
     * 条目数量变化 → 节点高度自适应（加组自动长高、删组自动回缩）
     */
    refreshRows() {
        if (!this.rowsEl || !this.rowsEl.isConnected) return;
        const groups = this.canvas.groups.groups;
        // 全局快捷键分配（按组去重、1..9、0 先到先得），反查各组编号——
        // 数字键属于组而非节点，多书签节点徽标显示一致
        const assignments = BookmarkNode.collectShortcutAssignments(this.canvas);
        const digitByGroup = new Map();   // groupId → 数字键
        for (const [digit, hit] of assignments) {
            digitByGroup.set(hit.group.id, digit);
        }

        this.rowsEl.innerHTML = '';
        if (groups.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'bookmark-empty';
            empty.textContent = '画布中暂无编组（右键空白处 → 新建组）';
            this.rowsEl.appendChild(empty);
            this._autoFitHeight();
            return;
        }

        for (const group of groups) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'bookmark-row';
            row.dataset.groupId = group.id;

            // 左：数字快捷键徽标（未分配显示占位点）
            const badge = document.createElement('span');
            badge.className = 'bookmark-row-key';
            badge.textContent = digitByGroup.get(group.id) || '·';

            // 中：组名（textContent 防注入）
            const name = document.createElement('span');
            name.className = 'bookmark-row-name';
            name.textContent = group.title || '新建组';

            // 右：跳转图标（Feather 风格箭头，与截图布局一致）
            const go = document.createElement('span');
            go.className = 'bookmark-row-go';
            go.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';

            row.appendChild(badge);
            row.appendChild(name);
            row.appendChild(go);
            this.rowsEl.appendChild(row);
        }
        this._autoFitHeight();
    }

    /**
     * 跳转到指定编组：保持当前缩放仅居中（用户拍板，不用 fitToBounds
     * 的自适应缩放）——组中心移到屏幕中心，scale 不动。
     * 跳转前按 id 重新查找组（防失效引用），随后 draw + 派发
     * canvasViewportChanged（CollectZone 同款约定，订阅方跟随刷新）
     * @param {Object} group - 组对象（只需 id 有效）
     */
    jumpToGroup(group) {
        const g = this.canvas.groups.groups.find((x) => x.id === group.id);
        if (!g) return;
        const vp = this.canvas.viewport;
        vp.offsetX = this.canvas.cssWidth / 2 - (g.x + g.width / 2) * vp.scale;
        vp.offsetY = this.canvas.cssHeight / 2 - (g.y + g.height / 2) * vp.scale;
        this.canvas.draw();
        window.dispatchEvent(new CustomEvent('canvasViewportChanged'));
    }

    /**
     * 内容自适应高度：量取内容自然高度直接写回 this.height 并应用变换
     * （添加条目自动长高、删除自动回缩，不出滚动条）。world 布局下
     * 布局像素=世界像素（transform 不影响布局），量测时把行列表临时
     * 置为内容尺寸；下限为 _heightFloor（创建/存档时的高度）
     */
    _autoFitHeight() {
        const el = this.el;
        if (!el || !el.isConnected) return;
        const list = this.rowsEl;
        const prevH = el.style.height;
        const prevListFlex = list.style.flex;
        const prevListOv = list.style.overflowY;
        el.style.height = 'auto';
        list.style.flex = '0 0 auto';
        list.style.overflowY = 'visible';
        const natural = el.scrollHeight;
        el.style.height = prevH;
        list.style.flex = prevListFlex;
        list.style.overflowY = prevListOv;
        if (!natural) return;
        const next = Math.max(natural, this._heightFloor || BookmarkNode.DEFAULT_HEIGHT);
        if (next === this.height) return;
        this.height = next;
        this.updateTransform();
    }

    /**
     * 从 DOM 移除节点（删除时调用）。
     * 先摘 window 上的组变化监听，再由基类移除节点 DOM 元素
     */
    destroy() {
        if (this._onGroupsChanged) {
            window.removeEventListener('canvasGroupsChanged', this._onGroupsChanged);
            this._onGroupsChanged = null;
        }
        super.destroy();
    }

    /**
     * 序列化为存档数据。
     * 绑定关系不持久化（纯派生）——恢复后 refreshRows 从当前画布组集合重建
     * @returns {Object} {id, type:'bookmark-node', x, y, width, height}
     */
    toJSON() {
        return {
            id: this.id,
            type: NodeTypes.SOURCE.BOOKMARK_NODE,
            x: this.x,
            y: this.y,
            width: this.width,
            height: this.height,
            ...(this.title ? { title: this.title } : {})
        };
    }
}

// ==================== 静态工具（快捷键分配，纯函数可测） ====================

/**
 * 全局快捷键分配（数字键 1-9、0 共 10 个名额，先到先得）：
 * 按 seqId 升序遍历画布上的全部书签节点，对条目（按 groups 数组顺序）
 * 按组 id 去重后依次分配——数字键属于组而非节点，同一组只占一个名额
 * （多节点徽标显示一致），名额用尽后剩余组仅图标跳转。
 * 组按 id 存活性实时过滤，删除组后剩余条目编号前移补位。
 * @param {Canvas} canvas - 画布主类实例
 * @returns {Map<string, {node: BookmarkNode, group: Object}>}
 *          key 为数字键字符（'1'..'9'、'0'），value 为命中条目
 *          （node 为首次遭遇该组的节点，跳转仅借其实例方法）
 */
BookmarkNode.collectShortcutAssignments = function (canvas) {
    const map = new Map();
    if (!canvas || !canvas.groups || !canvas.images) return map;
    // 数字键顺序：1-9 然后 0（键盘物理顺序，与截图徽标一致）
    const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
    const groups = canvas.groups.groups;
    const nodes = canvas.images.images
        .filter((obj) => NodeTypes.isBookmarkNode(obj.source))
        .sort((a, b) => (a.seqId || 0) - (b.seqId || 0));
    const assignedGroupIds = new Set();
    let idx = 0;
    for (const node of nodes) {
        for (const group of groups) {
            if (idx >= digits.length) return map;   // 名额用尽，后续组仅图标跳转
            if (assignedGroupIds.has(group.id)) continue;   // 同组只占一个名额
            assignedGroupIds.add(group.id);
            map.set(digits[idx++], { node, group });
        }
    }
    return map;
};

// ==================== 类常量 ====================
// DEFAULT_* 为节点默认尺寸；DESIGN_BASE / MIN_* / RESIZE_HANDLE_SIZE
// 已上收到基类 BaseCanvasNode（静态继承，this.constructor.X 直接可见）
BookmarkNode.DEFAULT_WIDTH = 2048;    // 默认宽度（规格 v1：全节点族统一 2048）
BookmarkNode.DEFAULT_HEIGHT = 2600;   // 默认高度（规格 v1：对齐 ComfyGenNode，兼自适应下限）
BookmarkNode.DEFAULT_TITLE = 'Bookmarks'; // 默认标题（双击标题可自定义）

// 将 BookmarkNode 类暴露到全局作用域
window.BookmarkNode = BookmarkNode;
