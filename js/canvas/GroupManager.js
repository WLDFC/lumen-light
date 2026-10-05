/**
 * ==========================================================================
 * LumenLight 画布编组管理器
 * 作用：管理画布上的「组」对象——把一组图片/节点用带标题栏的矩形框起来，
 *       作为画布最底层的视觉容器。负责：
 *   1. 组数据管理（增删、单选/多选，结构与 ImageManager 同风格）
 *   2. 纯几何命中检测（标题栏 / 边缘手柄，static 方法，可单测）
 *   3. 成员判定（几何包含：完全落在组矩形内的图片/节点即为成员，
 *      拖动组时按拖动开始瞬间的成员快照联动，组不存储成员清单）
 *   4. 标题双击改名（浮动输入框，回车/失焦提交、Esc 取消、IME 兼容）
 *   5. 标题栏配色（工具栏下拉选择，颜色键存组对象 color 字段，随存档持久化）
 * 组本身画在 canvas 里（CanvasRenderer.drawGroupBodies，垫在连线与图片
 * 之下），不是 DOM 节点——组背景必须压在成员图片下面，DOM 方案做不到。
 * 存档走 project.json 顶层 groups 字段（ProjectSerializer 收集/恢复），
 * 实时保存经 canvas.draw() 变更捕获自动覆盖，无需额外接入。
 * ==========================================================================
 */

class GroupManager {
    /**
     * 构造函数：初始化组数组和选中 ID 集合
     * @param {Canvas} canvas - 画布主类实例
     */
    constructor(canvas) {
        this.canvas = canvas;
        this.groups = [];              // 所有组对象 [{id, type:'group', title, x, y, width, height, selected}]
        this.selectedIds = new Set();  // 选中的组 ID 集合（与图片选中互相独立，可共存）
        this._renameInput = null;      // 标题改名浮动输入框（单例 {input, group}）
    }

    // ---- 几何常量 ----
    // 标题栏走节点的 ns 缩放体系（BaseCanvasNode：ns = 最短边 / DESIGN_BASE，
    // 标题栏高 = 48px × ns、字号 18px × ns），组与节点在任何缩放级别下
    // 标题观感一致——屏幕恒定方案会在缩小视角下压过节点、放大视角下
    // 反而比节点标题还小，两头的突兀都已实测否决。
    // 与节点的差异：组的 ns 在创建时按初始尺寸算好存进 titleNS，
    // 之后调整组宽高**不改变**标题栏大小——ns 若跟随当前最短边，
    // 把高度缩到比宽度小后标题栏会被压成细条（实测不可读）
    static HEADER_BASE = 48;         // 标题栏基准高（= 节点 header 48px）
    static TITLE_FONT_BASE = 18;     // 标题基准字号（= 节点标题 18px）
    static TITLE_INSET_BASE = 16;    // 标题左缘间距基准（世界坐标，随 ns 缩放）
    static DESIGN_BASE = 512;        // 设计基准（与 BaseCanvasNode.DESIGN_BASE 对齐）
    static EDGE_HANDLE_LEN = 26;     // 边缘手柄长度（屏幕像素，绘制/命中均做反缩放补偿）
    static EDGE_HANDLE_THICK = 4;    // 边缘手柄厚度（屏幕像素），细条不喧宾夺主
    static EDGE_HIT_PADDING = 6;     // 手柄命中容差（屏幕像素），提升抓取手感
    static MIN_WIDTH = 200;          // 组最小宽（世界坐标），防止缩没了无法再抓取
    static MIN_HEIGHT = 140;         // 组最小高（世界坐标）
    // 空白新建组的默认尺寸下限（节点量级）。实际默认值由 CanvasContextMenu
    // 按画布内容自适应（取现有对象最大宽高 × 1.2，可视范围 80% 封顶），
    // 固定值在高分辨率内容（2K 图片/2048 宽节点）面前会显得比图片还小
    static DEFAULT_WIDTH = 2048;
    static DEFAULT_HEIGHT = 1800;
    static ENCLOSURE_PADDING = 100;  // 智能默认：包住所选元素时四边外扩（节点量级）
    static DEFAULT_TITLE = '新建组';
    // 标题栏配色预设（唯一出处）：band = 画布标题栏色带填充（半透明，压深色
    // 组体），swatch = 下拉菜单里的圆形色块（实色，深色菜单底上辨识度优先）。
    // 色相取自项目色板（.trae/skills/配色美学）：红/错误 #ef4444、蓝/强调
    // #3b82f6、青/选中 #6cebff；紫为色板外补充（#a855f7，与同族饱和度对齐）。
    // 无色的色块是通用灰 #808080（项目边框层基准灰，同色系带出"未着色"语义；
    // 色带仍是默认白 6% = 原色）。键 '' 即无色，组对象 color 字段存的就是这里的键
    static COLOR_PRESETS = {
        '':      { label: '无色', band: 'rgba(255, 255, 255, 0.06)', swatch: '#808080' },
        'red':   { label: '红色', band: 'rgba(239, 68, 68, 0.45)',   swatch: '#ef4444' },
        'blue':  { label: '蓝色', band: 'rgba(59, 130, 246, 0.45)',  swatch: '#3b82f6' },
        'cyan':  { label: '青色', band: 'rgba(108, 235, 255, 0.35)', swatch: '#6cebff' },
        'purple':{ label: '紫色', band: 'rgba(168, 85, 247, 0.45)',  swatch: '#a855f7' }
    };
    // 完全包含判定的容差（世界坐标），抵消拖动中的浮点误差
    static CONTAIN_EPS = 0.5;

    // ==================== 数据管理 ====================

    /**
     * 派发编组选中变化事件（canvasGroupSelected，detail.group 为
     * 最后选中的组或 null）。GroupToolbar 等外部组件据此显隐/定位，
     * 与图片选中经 canvasImageSelected 通知 ImageToolbar 同一模式。
     * @private
     */
    _notifySelection() {
        const selected = this.getSelected();
        window.dispatchEvent(new CustomEvent('canvasGroupSelected', {
            detail: { group: selected.length > 0 ? selected[selected.length - 1] : null }
        }));
    }

    /**
     * 新增一个组（几何被钳制到最小尺寸）
     * @param {number} x - 画布 X
     * @param {number} y - 画布 Y
     * @param {number} [width] - 宽（缺省用默认值）
     * @param {number} [height] - 高（缺省用默认值）
     * @param {string} [title] - 标题（缺省用默认标题）
     * @returns {Object} 新建的组对象
     */
    add(x, y, width, height, title) {
        const w = Math.max(width ?? GroupManager.DEFAULT_WIDTH, GroupManager.MIN_WIDTH);
        const h = Math.max(height ?? GroupManager.DEFAULT_HEIGHT, GroupManager.MIN_HEIGHT);
        const group = {
            id: LumenLight.generateId(),
            type: 'group',
            title: title || GroupManager.DEFAULT_TITLE,
            color: '',
            x,
            y,
            width: w,
            height: h,
            // 标题栏缩放系数：按创建时尺寸定格（见 getTitleNS），调整宽高不变
            titleNS: Math.max(Math.min(w, h) / GroupManager.DESIGN_BASE, 0.01),
            selected: false
        };
        this.groups.push(group);
        // 撤销记账：新建组可回退（undo=摘壳、redo=原对象放回）
        this.canvas.history?.recordGroupCreate(group);
        return group;
    }

    /**
     * 删除指定组（只删组壳，成员是 images 数组里的独立对象，原样保留）
     * @param {string} id - 组 ID
     * @returns {boolean} 是否删除成功
     */
    delete(id) {
        const idx = this.groups.findIndex(g => g.id === id);
        if (idx === -1) return false;
        this.groups.splice(idx, 1);
        this.selectedIds.delete(id);
        // 该组的改名输入框若还开着，一并关闭（不提交）
        if (this._renameInput && this._renameInput.group.id === id) {
            this._closeRename(false);
        }
        return true;
    }

    /**
     * 设置组标题栏颜色（GroupToolbar 下拉选择时调用）
     * 颜色键不存在时回退无色；重绘经 draw hook 被 CanvasChangeWatcher
     * 捕获，实时保存自动落盘（与改名同路径）
     * @param {string} id - 组 ID
     * @param {string} color - 颜色键（GroupManager.COLOR_PRESETS 的键）
     */
    setColor(id, color) {
        const g = this.groups.find(g => g.id === id);
        if (!g) return;
        const from = g.color;
        g.color = GroupManager.COLOR_PRESETS[color] ? color : '';
        // 撤销记账：配色可回退（值未变不记）
        this.canvas.history?.recordValue(g, 'color', from, g.color, '标题栏配色');
        this.canvas.draw();
    }

    /**
     * 单选模式：选中指定组，取消其他组选中（不影响图片选中状态）
     * @param {string|null} id - 组 ID，null 表示清空组选中
     */
    select(id) {
        this.clearSelection();
        if (id) {
            const g = this.groups.find(g => g.id === id);
            if (g) {
                g.selected = true;
                this.selectedIds.add(id);
            }
        }
        this._notifySelection();
    }

    /**
     * 多选模式：切换指定组的选中状态（Shift+点击标题栏）
     * @param {string} id - 组 ID
     */
    toggleSelect(id) {
        const g = this.groups.find(g => g.id === id);
        if (!g) return;
        if (this.selectedIds.has(id)) {
            this.selectedIds.delete(id);
            g.selected = false;
        } else {
            this.selectedIds.add(id);
            g.selected = true;
        }
        this._notifySelection();
    }

    /**
     * 清空组选中状态
     */
    clearSelection() {
        this.selectedIds.forEach(sid => {
            const g = this.groups.find(g => g.id === sid);
            if (g) g.selected = false;
        });
        this.selectedIds.clear();
        this._notifySelection();
    }

    /**
     * 获取所有选中的组
     * @returns {Array} 选中组对象数组
     */
    getSelected() {
        return this.groups.filter(g => this.selectedIds.has(g.id));
    }

    // ==================== 成员判定（几何包含） ====================

    /**
     * 判断对象是否完全落在组矩形内（成员判定）
     * @param {Object} group - 组对象
     * @param {Object} obj - 画布对象（图片或 DOM 节点，均有 x/y/width/height）
     * @returns {boolean}
     */
    static contains(group, obj) {
        const eps = GroupManager.CONTAIN_EPS;
        return obj.x >= group.x - eps && obj.y >= group.y - eps &&
               obj.x + obj.width <= group.x + group.width + eps &&
               obj.y + obj.height <= group.y + group.height + eps;
    }

    /**
     * 获取组的当前成员（拖动组时的联动对象）
     * 成员 = 拖动开始瞬间完全在组内的图片/节点快照（生成占位图除外——
     * 占位图是短暂的动画对象，位置由生成流程管理）。
     * @param {Object} group - 组对象
     * @returns {Array} 成员对象数组（images 数组元素的引用）
     */
    getMembers(group) {
        return this.canvas.images.images.filter(
            obj => !NodeTypes.isPlaceholder(obj.source) && GroupManager.contains(group, obj)
        );
    }

    // ==================== 标题栏度量（ns 缩放体系，与节点一致） ====================

    /**
     * 组的标题栏缩放系数（ns）：固定取创建时定格的 titleNS。
     * 旧存档/测试夹具的组对象没有该字段时，按当前尺寸回退计算
     * （行为与旧版一致）；绘制、命中、改名输入框三方共用本函数，
     * 保证标题栏几何永远一致。
     * @param {Object} group - 组对象
     * @returns {number} ns 缩放系数
     */
    static getTitleNS(group) {
        if (typeof group.titleNS === 'number' && group.titleNS > 0) {
            return group.titleNS;
        }
        return Math.max(Math.min(group.width, group.height) / GroupManager.DESIGN_BASE, 0.01);
    }

    /**
     * 计算组标题栏的绘制/命中度量（世界坐标）
     * ns 取创建时定格的 getTitleNS（调整组宽高不改变标题栏大小）：
     * 标题高 = 48 × ns、字号 = 18 × ns；ns 过小时按 32/13 兜底。
     * 标题高钳到组高：组被缩得比标题栏还矮时色带不溢出组矩形。
     * 绘制（CanvasRenderer.drawGroupBodies）、命中（hitGroupTitle）、
     * 改名输入框定位三方共用本函数，保证几何永远一致。
     * @param {Object} group - 组对象
     * @returns {{height: number, font: number, inset: number}} 世界坐标度量
     */
    static getTitleMetrics(group) {
        const ns = GroupManager.getTitleNS(group);
        let height = Math.max(GroupManager.HEADER_BASE * ns, 32);
        if (height > group.height) height = group.height;
        return {
            height,
            font: Math.max(GroupManager.TITLE_FONT_BASE * ns, 13),
            inset: GroupManager.TITLE_INSET_BASE * ns
        };
    }

    // ==================== 命中检测（纯几何，static 可单测） ====================

    /**
     * 检测画布坐标是否命中某组的标题栏（从最上层组往下找）
     * 只有标题栏可选中组——组体内部透传给成员操作与框选。
     * 标题栏高度随组尺寸缩放（ns 体系），与节点标题栏观感一致。
     * @param {Canvas} canvas - 画布主类实例
     * @param {number} canvasX - 画布 X
     * @param {number} canvasY - 画布 Y
     * @returns {Object|null} 命中的组对象
     */
    static hitGroupTitle(canvas, canvasX, canvasY) {
        const groups = canvas.groups ? canvas.groups.groups : [];
        for (let i = groups.length - 1; i >= 0; i--) {
            const g = groups[i];
            const th = GroupManager.getTitleMetrics(g).height;
            if (canvasX >= g.x && canvasX <= g.x + g.width &&
                canvasY >= g.y && canvasY <= g.y + th) {
                return g;
            }
        }
        return null;
    }

    /**
     * 计算选中组四边中点手柄的矩形几何（世界坐标）
     * 手柄是屏幕恒定尺寸的短条（长边贴组边，参考样图 2 的蓝色边条），
     * 绘制与命中复用本函数保证几何一致。
     * @param {Object} group - 组对象
     * @param {number} scale - 视口缩放（手柄做反缩放补偿保持屏幕大小恒定）
     * @returns {Array<{name: string, x: number, y: number, w: number, h: number}>}
     *   上/下/左/右四个手柄矩形，name 为 'n'|'s'|'w'|'e'
     */
    static getEdgeHandleRects(group, scale) {
        const len = GroupManager.EDGE_HANDLE_LEN / scale;
        const th = GroupManager.EDGE_HANDLE_THICK / scale;
        const cx = group.x + group.width / 2;
        const cy = group.y + group.height / 2;
        return [
            { name: 'n', x: cx - len / 2, y: group.y - th / 2, w: len, h: th },
            { name: 's', x: cx - len / 2, y: group.y + group.height - th / 2, w: len, h: th },
            { name: 'w', x: group.x - th / 2, y: cy - len / 2, w: th, h: len },
            { name: 'e', x: group.x + group.width - th / 2, y: cy - len / 2, w: th, h: len }
        ];
    }

    /**
     * 检测画布坐标是否命中选中组（单选时）的边缘缩放手柄
     * 命中区域 = 手柄矩形外扩容差，保证细手柄容易抓取。
     * @param {Canvas} canvas - 画布主类实例
     * @param {number} canvasX - 画布 X
     * @param {number} canvasY - 画布 Y
     * @returns {{group: Object, handle: string}|null} 命中的组与手柄方位
     */
    static hitGroupEdgeHandle(canvas, canvasX, canvasY) {
        const groups = canvas.groups;
        if (!groups || groups.selectedIds.size !== 1) return null;
        const group = groups.getSelected()[0];
        if (!group) return null;

        const scale = canvas.viewport.scale;
        const pad = GroupManager.EDGE_HIT_PADDING / scale;
        for (const h of GroupManager.getEdgeHandleRects(group, scale)) {
            if (canvasX >= h.x - pad && canvasX <= h.x + h.w + pad &&
                canvasY >= h.y - pad && canvasY <= h.y + h.h + pad) {
                return { group, handle: h.name };
            }
        }
        return null;
    }

    /**
     * 根据组边缘手柄方位返回缩放光标
     * @param {string} handle - 手柄方位 'n'|'s'|'w'|'e'
     * @returns {string} CSS 光标值
     */
    static getGroupResizeCursor(handle) {
        return (handle === 'n' || handle === 's') ? 'ns-resize' : 'ew-resize';
    }

    // ==================== 标题改名 ====================

    /**
     * 双击标题栏进入改名：浮动输入框完全覆盖标题栏色带并随视口同步缩放
     * （节点标题改名的输入框嵌在随 transform 缩放的节点 DOM 里天然跟随；
     * 组的输入框是独立 DOM，由 syncRenameTransform 每帧做同等换算）。
     * 回车/失焦提交、Esc 取消、输入法组字期间不误提交。
     * 提交后调用 canvas.draw()——改名会经 draw hook 被 CanvasChangeWatcher
     * 捕获，实时保存自动落盘。
     * @param {Object} group - 要改名的组
     */
    startRename(group) {
        // 已有改名框先提交收掉，避免出现双输入框
        this._closeRename(true);

        const input = document.createElement('input');
        input.type = 'text';
        input.value = group.title || '';
        input.className = 'group-title-input';
        document.body.appendChild(input);
        this._renameInput = { input, group };
        // 下一帧绘制前由渲染器做首次对位（draw 合帧的 rAF 回调先于绘制），
        // 主动触发一次 draw 保证输入框出现的同一帧就在正确位置
        this.canvas.draw();

        // IME 组字期间回车是选字，不提交
        let composing = false;
        input.addEventListener('compositionstart', () => { composing = true; });
        input.addEventListener('compositionend', () => { composing = false; });

        input.addEventListener('keydown', (e) => {
            e.stopPropagation();   // 输入时不触发画布快捷键（Delete/空格等）
            if (e.key === 'Enter' && !composing) {
                this._closeRename(true);
            } else if (e.key === 'Escape') {
                this._closeRename(false);
            }
        });
        // 点输入框自身不冒泡：避免被当作画布空白点击（清选中/框选/关菜单）
        input.addEventListener('mousedown', (e) => e.stopPropagation());
        input.addEventListener('blur', () => this._closeRename(true));
        requestAnimationFrame(() => {
            input.focus();
            input.select();
        });
    }

    /**
     * 该组是否正在改名（渲染器据此跳过画布上的原标题文字绘制——
     * 输入框底色是半透明的，画布文字不隐藏会和输入框内容叠字，
     * 等价于节点改名时把标题文字替换成输入框的行为）
     * @param {Object} group - 组对象
     * @returns {boolean}
     */
    isRenaming(group) {
        return !!this._renameInput && this._renameInput.group.id === group.id;
    }

    /**
     * 把改名输入框重新对位到标题栏当前屏幕状态（每帧由渲染器调用）。
     * 节点的改名输入框嵌在随视口 transform 缩放的节点 DOM 里天然跟随；
     * 组的输入框是独立 DOM，由本方法做同等换算：几何完全按
     * ns × scale 推导（与 .node-title-input 的 18px × ns 字号体系一致）。
     * 挂在 drawGroupBodies 里逐帧同步是权威路径——缩放/平移/拖动等
     * 一切视觉变化最终都汇入 canvas.draw()，事件监听会漏、这里不会。
     */
    syncRenameTransform() {
        const ctx = this._renameInput;
        if (!ctx) return;
        const vp = this.canvas.viewport;
        const scale = vp.scale;
        const group = ctx.group;
        const metrics = GroupManager.getTitleMetrics(group);
        const ns = GroupManager.getTitleNS(group);
        const origin = vp.canvasToScreen(group.x, group.y);
        const bandHeight = metrics.height * scale;
        const insetScreen = metrics.inset * scale;
        const inputHeight = Math.max(bandHeight * 0.8, 22);
        ctx.input.style.left = (origin.x + insetScreen) + 'px';
        ctx.input.style.top = (origin.y + (bandHeight - inputHeight) / 2) + 'px';
        ctx.input.style.width = Math.max(group.width * scale - insetScreen * 2, 40) + 'px';
        ctx.input.style.height = inputHeight + 'px';
        // 字号/圆角/内边距与节点标题输入框同款（18px × ns / 4px × ns / 6px × ns）
        ctx.input.style.fontSize = Math.max(metrics.font * scale, 11) + 'px';
        ctx.input.style.borderRadius = Math.max(4 * ns * scale, 2) + 'px';
        ctx.input.style.padding = '0 ' + Math.max(6 * ns * scale, 2) + 'px';
    }

    /**
     * 关闭改名输入框（内部方法）
     * @param {boolean} commit - true 提交新标题，false 放弃修改
     */
    _closeRename(commit) {
        const ctx = this._renameInput;
        if (!ctx) return;
        this._renameInput = null;   // 先摘引用，防止 blur/Enter 双触发重复提交
        const value = ctx.input.value.trim();
        if (commit && value) {
            const from = ctx.group.title;
            ctx.group.title = value;
            // 撤销记账：改名可回退（值未变不记）
            this.canvas.history?.recordValue(ctx.group, 'title', from, value, '组改名');
        }
        ctx.input.remove();
        this.canvas.draw();
    }
}

// 将 GroupManager 类暴露到全局作用域
window.GroupManager = GroupManager;
