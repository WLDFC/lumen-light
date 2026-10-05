/**
 * ==========================================================================
 * LumenLight 画布节点基类（BaseCanvasNode）
 * ==========================================================================
 * 作用：四类面板节点（提示词/文本/LLM 生图/Comfy 生图）的公共几何与
 *       生命周期实现。收敛此前在四个节点类中逐字重复的约 540 行代码——
 *       同一处 bug（如选中框防抖失效）曾需要改四个文件才能修完。
 *
 * 子类契约：
 *   1. constructor 先调用 super(canvas, x, y)，再初始化业务字段
 *      （source 必须取 NodeTypes.SOURCE 常量），最后自行调用
 *      buildDom() / bindEvents() / updateTransform()
 *   2. 声明静态常量 DEFAULT_WIDTH / DEFAULT_HEIGHT（基类已提供
 *      DESIGN_BASE / MIN_WIDTH / MIN_HEIGHT / RESIZE_HANDLE_SIZE 及端口
 *      几何常量，经 extends 静态继承对 this.constructor.X 直接可见）
 *   3. 覆写 destroy() 时先做子类专属清理（占位图/镜像层/看门狗等），
 *      再调用 super.destroy()
 *   4. 需要在每帧变换后追加逻辑时（如 PromptNode 刷新参考图缩略图），
 *      定义 afterUpdateTransform() 钩子，基类每帧调用
 *
 * 两种布局模式（静态常量 LAYOUT_MODE，子类可覆写）：
 *   - 'world'（默认）：DOM 布局尺寸 = 世界尺寸，内部内容按 --ns 缩放。
 *     提示词/文本节点采用——textarea 原生光标/选区行为友好
 *   - 'design'：DOM 布局尺寸固定为设计基准（世界尺寸 ÷ ns），
 *     整体 transform = ns × 视口缩放。生图节点采用——原生 <select>
 *     的弹出选项浮层不跟随 CSS transform，固定布局字号恒定，
 *     弹层与表面文字观感才一致
 * ==========================================================================
 */

class BaseCanvasNode {
    /**
     * @param {Canvas} canvas - 画布主类实例
     * @param {number} x - 节点左上角画布 X 坐标
     * @param {number} y - 节点左上角画布 Y 坐标
     */
    constructor(canvas, x, y) {
        this.canvas = canvas;
        this.id = LumenLight.generateId();

        // 节点几何（画布世界坐标），width/height 由子类按默认值/存档赋值
        this.x = x;
        this.y = y;

        this.selected = false;
        this.created = Date.now();

        // 与图片对象保持字段兼容（存档/连线链路会读取这些字段）
        this.img = null;      // 面板节点无图像数据
        this.name = null;     // 无文件名
        this.prompt = '';
        this.negativePrompt = '';

        // 自定义标题（null = 显示类默认标题 DEFAULT_TITLE；双击标题可改）
        this.title = null;
        this.titleEl = null;  // 标题元素（initTitleEditor 时缓存）
    }

    /**
     * 内容缩放系数：节点实际尺寸相对设计基准（512）的比例。
     * 节点框放大/缩小时，内部标题栏、字号、手柄等内容按此系数同步缩放
     * （通过 CSS 变量 --ns 驱动布局），避免"框大内容小"的比例失调。
     * 非等比缩放时取宽高比例的较小值。
     */
    get ns() {
        return Math.min(this.width, this.height) / this.constructor.DESIGN_BASE;
    }

    /**
     * 按画布视口变换更新节点的屏幕位置与缩放（由 CanvasRenderer 每帧调用）。
     * 节点 DOM 用 transform: scale 跟随画布缩放，transform-origin 固定
     * 左上角，与画布坐标投影一致。边框粗细除以总缩放，保证屏幕视觉粗细
     * 恒定（选中 1.7px / 未选中 1px，与图片选中边框一致）。
     * 性能：写入前与上次目标值比对，全部一致则跳过 DOM 写入。
     * 两种布局模式的行为差异见类头说明。
     */
    updateTransform() {
        const vp = this.canvas.viewport;
        const sx = vp.canvasToScreen(this.x, this.y);
        const designBasis = this.constructor.LAYOUT_MODE === 'design';
        const ns = this.ns;
        const scale = designBasis ? ns * vp.scale : vp.scale;
        const borderW = (this.selected ? 1.7 : 1) / scale;
        // 汇总本轮目标样式，与上次写入比对：全部一致则跳过 DOM 写入
        const next = {
            left: sx.x + 'px',
            top: sx.y + 'px',
            width: (designBasis ? this.width / ns : this.width) + 'px',
            height: (designBasis ? this.height / ns : this.height) + 'px',
            ns: designBasis ? '1' : String(ns),
            // 总内容缩放（内容系数 × 视口系数）：原生 select 弹层按页面像素
            // 渲染、不受 transform 影响，node.css 用它补偿 option 字号。
            // 两种布局都写入——world 布局节点（如 LoRA 节点）同样有原生下拉
            render: designBasis ? String(scale) : String(ns * vp.scale),
            transform: `scale(${scale})`,
            border: borderW + 'px'
        };
        const last = this._lastTransform;
        if (!last || last.left !== next.left || last.top !== next.top ||
            last.width !== next.width || last.height !== next.height ||
            last.ns !== next.ns || last.render !== next.render ||
            last.transform !== next.transform || last.border !== next.border) {
            this.el.style.left = next.left;
            this.el.style.top = next.top;
            this.el.style.width = next.width;
            this.el.style.height = next.height;
            this.el.style.setProperty('--ns', designBasis ? 1 : ns);
            // 同步总缩放给 CSS：原生 select 弹出的选项浮层不受 transform
            // 影响、按页面像素渲染，node.css 用它放大 option 字号
            this.el.style.setProperty('--render-scale', next.render);
            this.el.style.transformOrigin = '0 0';
            this.el.style.transform = next.transform;
            // 边框粗细补偿：除以总缩放，保证屏幕视觉粗细恒定。
            // 面板外框用 outline（不占布局空间），宽度变化不会挤压
            // 内容区导致文字重排（border 会随缩放漂移换行位置）
            this.el.style.outlineWidth = next.border;
            this._lastTransform = next;
        }
        // 子类每帧追加逻辑的钩子（如提示词节点刷新参考图缩略图）
        if (typeof this.afterUpdateTransform === 'function') {
            this.afterUpdateTransform();
        }
    }

    /**
     * 获取左/右端口的画布坐标（世界坐标）。
     * 端口圆点位于标题栏下方的状态栏行：左右两端、距边缘少许内缩，
     * 连线锚点与端口圆心重合，保证线始终接在圆点上。
     * 所有尺寸均乘内容缩放系数 ns。
     * 仅端口节点（NodeTypes.hasDomPorts）会被外部调用。
     * @param {'in'|'out'} side - 端口方位
     * @returns {{x: number, y: number}} 端口圆心坐标
     */
    getPortPoint(side) {
        const ns = this.ns;
        const portOffset = (this.constructor.PORT_INSET + this.constructor.PORT_RADIUS) * ns;
        const cy = this.y + (this.constructor.HEADER_HEIGHT +
                   this.constructor.STATUSBAR_HEIGHT / 2) * ns;
        return side === 'in'
            ? { x: this.x + portOffset, y: cy }
            : { x: this.x + this.width - portOffset, y: cy };
    }

    /**
     * 设置节点几何（拖动/缩放时由交互层调用）
     * @param {number} x - 左上角 X
     * @param {number} y - 左上角 Y
     * @param {number} [width] - 宽度（缺省时只更新位置）
     * @param {number} [height] - 高度
     */
    setGeometry(x, y, width, height) {
        this.x = x;
        this.y = y;
        if (width !== undefined) {
            this.width = Math.max(width, this.constructor.MIN_WIDTH);
            this.height = Math.max(height, this.constructor.MIN_HEIGHT);
        }
        this.updateTransform();
    }

    /**
     * 选中状态同步到 DOM（选中边框高亮）。
     * 注意不能做"值未变化时跳过"的防抖：ImageManager.select() 会绕过本方法
     * 直接改 img.selected，flag 已相等时 class 将永远无法切换
     * （节点选中后仍显示灰色边框的原因）。classList.toggle 对相同状态
     * 是浏览器级 no-op，直接同步即可
     * @param {boolean} selected - 是否选中
     */
    setSelected(selected) {
        this.selected = selected;
        this.el.classList.toggle('selected', selected);
    }

    // ==================== 标题（双击行内重命名，六类节点共用） ====================

    /**
     * 当前显示标题：自定义标题为空时回退类默认标题（子类 DEFAULT_TITLE 常量）
     * @returns {string}
     */
    getTitle() {
        return this.title || this.constructor.DEFAULT_TITLE;
    }

    /**
     * 初始化标题编辑（子类 buildDom 构建 DOM 后调用）：
     * 缓存标题元素并按当前标题设置文字，绑定双击进入行内重命名。
     * 六类节点标题栏 DOM 同构（.text-node-title），故收口在基类实现
     */
    initTitleEditor() {
        this.titleEl = this.el.querySelector('.text-node-title');
        if (!this.titleEl) return;
        this.refreshTitle();
        this.titleEl.addEventListener('dblclick', () => this.startTitleRename());
    }

    /** 刷新标题栏文字显示（恢复存档/程序化改名后调用） */
    refreshTitle() {
        if (this.titleEl) this.titleEl.textContent = this.getTitle();
    }

    /**
     * 设置自定义标题：空值视为清除（回退类默认标题）。
     * 改名后补发一次 input 事件——CanvasChangeWatcher 靠 input/change
     * 委托捕获节点变更，回车提交时输入框已被移除、不再有原生事件，
     * 不补发会在防抖窗口外丢保存
     * @param {string} value - 新标题（自动去首尾空白）
     */
    setTitle(value) {
        const next = (value || '').trim() || null;
        if (next === this.title) return;
        this.title = next;
        this.refreshTitle();
        this.el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /**
     * 双击标题进入行内重命名：标题替换为输入框（自动全选），回车/失焦提交、
     * Esc 取消，输入法组合中的回车忽略（交互模式同 RecipeManager.startRename）。
     * 提交空名回退类默认标题；与当前标题相同视为取消不触发保存。
     * 编辑期间拦截 mousedown/keydown 冒泡——节点不可拖动，按键也不外泄
     * 到其他全局快捷键（CanvasInteraction 对 INPUT 目标本就放行原生行为）
     */
    startTitleRename() {
        // 已在编辑状态（输入框存在）则忽略
        if (!this.titleEl || this.titleEl.querySelector('.node-title-input')) return;

        const original = this.getTitle();
        const input = document.createElement('input');
        input.className = 'node-title-input';
        input.type = 'text';
        input.maxLength = 40;
        input.value = original;

        let done = false;      // 编辑已结束（提交或取消）
        let composing = false; // 输入法组合进行中（组合回车是选字，不是提交）

        /** 结束编辑：移除输入框恢复显示；newTitle 为 undefined 表示取消 */
        const finish = (newTitle) => {
            if (done) return;
            done = true;
            input.remove();
            if (newTitle !== undefined) this.setTitle(newTitle);
            // 同名提交时 setTitle 会早退，必须兜底刷新（输入框移除后文字为空）
            this.refreshTitle();
        };

        /** 提交：trim 后交给 setTitle（空名回退默认标题） */
        const commit = () => {
            if (done) return;
            finish(input.value.trim());
        };

        input.addEventListener('compositionstart', () => { composing = true; });
        input.addEventListener('compositionend', () => { composing = false; });
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !composing) {
                e.preventDefault();
                commit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                finish();   // 取消：不调 setTitle，恢复原名
            }
        });
        input.addEventListener('blur', () => commit());
        input.addEventListener('mousedown', (e) => e.stopPropagation());

        this.titleEl.textContent = '';
        this.titleEl.appendChild(input);
        input.focus();
        input.select();
    }

    /**
     * 从 DOM 移除节点（删除时调用）。
     * 子类覆写时先做专属清理（占位图/镜像层/看门狗等）再调用 super.destroy()
     */
    destroy() {
        if (this.el && this.el.parentNode) {
            this.el.parentNode.removeChild(this.el);
        }
    }

    /**
     * 命中检测：画布坐标是否落在节点矩形内
     * @param {number} cx - 画布 X
     * @param {number} cy - 画布 Y
     * @returns {boolean}
     */
    contains(cx, cy) {
        return cx >= this.x && cx <= this.x + this.width &&
               cy >= this.y && cy <= this.y + this.height;
    }

    /**
     * 是否命中右下角缩放手柄（画布坐标）。
     * 手柄实际大小随内容缩放系数 ns 变化，这里做反视口缩放补偿；
     * 命中区按屏幕像素封顶（16px 手柄 + 4px 容差，封顶 28 屏幕像素）：
     * ns 大时手柄世界尺寸很大，会把面板角落整块盖成缩放热区
     * @param {number} cx - 画布 X
     * @param {number} cy - 画布 Y
     * @returns {boolean}
     */
    hitResizeHandle(cx, cy) {
        const scale = this.canvas.viewport.scale;
        const hitScreen = Math.min(this.constructor.RESIZE_HANDLE_SIZE * this.ns + 4, 28);
        const size = hitScreen / scale;
        const rx = this.x + this.width;
        const ry = this.y + this.height;
        return cx >= rx - size && cx <= rx + size * 0.5 &&
               cy >= ry - size && cy <= ry + size * 0.5;
    }
}

// ==================== 基类静态常量 ====================
// 子类可覆写的：LAYOUT_MODE / DEFAULT_WIDTH / DEFAULT_HEIGHT
// （四类节点当前值完全一致，故上收到基类；经 extends 静态继承，
//   this.constructor.X 在子类中直接可见）
BaseCanvasNode.DESIGN_BASE = 512;       // 设计基准（ns = 1 时的内容尺寸）
BaseCanvasNode.LAYOUT_MODE = 'world';   // 布局模式：world | design（见类头）
BaseCanvasNode.DEFAULT_TITLE = 'Node';  // 默认标题（子类各自覆写）
BaseCanvasNode.MIN_WIDTH = 1024;        // 最小宽度
BaseCanvasNode.MIN_HEIGHT = 1024;       // 最小高度
BaseCanvasNode.RESIZE_HANDLE_SIZE = 16; // 缩放手柄边长（屏幕像素）
// 端口几何常量（与 css/node.css 中的对应样式保持一致，
// 仅端口节点使用；文本节点无端口，继承值不会被调用）
BaseCanvasNode.HEADER_HEIGHT = 48;      // 标题栏高度（px）
BaseCanvasNode.STATUSBAR_HEIGHT = 40;   // 状态栏高度（px）
BaseCanvasNode.PORT_INSET = 8;          // 端口圆点距面板左右边缘的内缩距离（px）
BaseCanvasNode.PORT_RADIUS = 9;         // 端口圆点半径（px，直径 18）

// 将 BaseCanvasNode 类暴露到全局作用域
window.BaseCanvasNode = BaseCanvasNode;
