/**
 * ==========================================================================
 * LumenLight 文本节点（画布备注/注释）
 * ==========================================================================
 * 作用：画布上的纯文本便签节点，用于写备注或注释，不参与生图流程。
 *
 * 与提示词节点（PromptNode）的关系：
 *   - 视觉样式完全复用 .text-node 面板（标题栏 + 文本域 + 右下角缩放手柄），
 *     内部同样通过 --ns 内容缩放系数实现"框变内容同变"；
 *   - 差异：没有左右端口圆点（无 statusbar 行），不能拖拽连线，
 *     CanvasConnections.isValidLink 对本类型两端都拒绝；
 *   - 不参与提示词收集与图片序列化，仅作为节点数据（toJSON）存档，
 *     恢复/复制粘贴按 type（NodeTypes.SOURCE.TEXT_NODE）分发重建。
 *
 * 交互职责划分（与 PromptNode 一致）：
 *   - 节点面板的选中/拖动/缩放由 CanvasInteraction 统一处理
 *     （本类只透传 mousedown，标记 e._canvasNodeTarget）；
 *   - textarea 的键盘输入、光标操作由原生行为接管；
 *   - 滚轮规则：编辑文本时只滚动文本、不缩放画布；
 *     非编辑态滚轮缩放画布（详见 bindEvents 的 wheel 分支）。
 *
 * 自绘光标：原生光标在画布缩放下不足半像素宽，故 textarea 隐藏原生
 * 光标（caret-color: transparent），由共享模块 NodeTextMirror 在镜像层
 * 绘制粗光标条（本节点无 @图片N 标记，不启用高亮）。
 * ==========================================================================
 */

class TextNode extends BaseCanvasNode {
    /**
     * 创建文本节点并挂载 DOM
     * @param {Canvas} canvas - 画布主类实例
     * @param {number} x - 节点左上角画布 X 坐标
     * @param {number} y - 节点左上角画布 Y 坐标
     * @param {string} [text=''] - 初始文本（恢复存档/复制粘贴时传入）
     * @param {Object} [size] - 初始尺寸 {width, height}（缺省用类常量默认值）
     */
    constructor(canvas, x, y, text = '', size = {}) {
        super(canvas, x, y);
        this.source = NodeTypes.SOURCE.TEXT_NODE;
        this.text = text;

        this.width = size.width || TextNode.DEFAULT_WIDTH;
        this.height = size.height || TextNode.DEFAULT_HEIGHT;

        this.buildDom();
        this.bindEvents();
        this.updateTransform();
    }

    /**
     * 构建 DOM 结构：标题栏 + 文本域 + 缩放手柄（无端口行，不可连线）
     * 样式类与 PromptNode 共用同一套 .text-node 体系（css/node.css），
     * 徽标文字"文本节点"区分节点类型
     */
    buildDom() {
        this.el = document.createElement('div');
        this.el.className = 'text-node';
        // data-id 供事件委托时反查节点
        this.el.dataset.id = this.id;

        this.el.innerHTML = `
            <div class="text-node-header">
                <span class="text-node-title">Note</span>
                <span class="text-node-badge">文本节点</span>
            </div>
            <div class="text-node-body">
                <div class="text-node-editor">
                    <div class="text-node-input-mirror" aria-hidden="true"></div>
                    <textarea class="text-node-input" placeholder="输入备注..." spellcheck="false"></textarea>
                </div>
            </div>
            <div class="text-node-resize" title="拖拽调整大小"></div>
        `;

        this.inputEl = this.el.querySelector('.text-node-input');
        this.mirrorEl = this.el.querySelector('.text-node-input-mirror');
        this.resizeEl = this.el.querySelector('.text-node-resize');

        this.inputEl.value = this.text;

        // 文本镜像层（通用模块）：自绘粗光标（无 tokenPattern，不做标记高亮）
        this.mirrorLayer = new NodeTextMirror(this.inputEl, this.mirrorEl);

        // 标题双击重命名（基类共用实现，六类节点同一套交互）
        this.initTitleEditor();

        // 挂到画布容器（canvas 元素的父级，即 body），跟随视口变换
        document.body.appendChild(this.el);
    }

    /**
     * 绑定节点内部 DOM 事件
     * 交互职责划分（与 PromptNode 一致）：
     *   - 节点面板的点击/拖动由 CanvasInteraction 统一处理（本类只透传 mousedown）
     *   - textarea 的键盘输入、光标操作由原生行为接管
     */
    bindEvents() {
        // 输入框获得焦点时正在编辑：阻止画布层把按键当作快捷键
        // （如 Delete 删除节点），编辑期间节点不可拖动；
        // 失焦时同步文本到 this.text（存档/快照按此字段收集）
        this.inputEl.addEventListener('focus', () => {
            this.isEditing = true;
        });
        this.inputEl.addEventListener('blur', () => {
            this.isEditing = false;
            this.text = this.inputEl.value;
        });
        this.inputEl.addEventListener('input', () => {
            this.text = this.inputEl.value;
        });

        // mousedown 转发给画布交互层：节点是 DOM 元素浮在 canvas 上方，
        // 事件不会自然到达 canvas，必须主动转发才能复用统一的选中/拖动逻辑。
        // e._canvasNodeTarget 标记本节点，交互层据此进入节点专属交互流程。
        // 点击输入框：仅当已处于编辑态（聚焦）时才放行原生行为；
        // 未聚焦的第一次点击先转发给交互层（选中/拖动），拖动失败
        // （无位移松手）后浏览器原生聚焦行为依然生效，光标定位不受影响
        this.el.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;   // 只转发左键
            if (e.target === this.inputEl && this.isEditing) {
                e.stopPropagation();
                return;
            }
            e._canvasNodeTarget = this;
            this.canvas.interaction.onMouseDown(e);
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

        // 滚轮规则：编辑文本时滚轮只滚动文本（到顶/到底也不再缩放画布），
        // 想缩放画布先点击空白处退出编辑；非编辑态滚轮缩放画布。
        // 编辑态拦下 Ctrl/⌘+滚轮，避免触发浏览器自身的页面缩放
        this.el.addEventListener('wheel', (e) => {
            const ta = this.inputEl;
            const canScroll = ta.scrollHeight > ta.clientHeight &&
                !(ta.scrollTop === 0 && e.deltaY < 0) &&
                !(ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 1 && e.deltaY > 0);
            if (this.isEditing && canScroll) return;   // 文本自身需要滚动，放行原生行为
            e.preventDefault();
            this.canvas.interaction.handleWheel(e);
        }, { passive: false });

        // 右键在节点上：不弹画布菜单（与图片/其他节点一致）
        this.el.addEventListener('contextmenu', (e) => {
            e.stopPropagation();
        });
    }

    /**
     * 从 DOM 移除节点（删除时调用）。
     * 先销毁镜像层（内部有挂在 document 上的 selectionchange 监听），
     * 再由基类移除节点 DOM 元素
     */
    destroy() {
        if (this.mirrorLayer) {
            this.mirrorLayer.destroy();
        }
        super.destroy();
    }

    /**
     * 序列化为存档数据
     * type 字段供 ProjectSerializer.restoreNodes 分发重建
     * @returns {Object} {id, type:'text-node', x, y, width, height, text}
     */
    toJSON() {
        return {
            id: this.id,
            type: NodeTypes.SOURCE.TEXT_NODE,
            x: this.x,
            y: this.y,
            width: this.width,
            height: this.height,
            text: this.text,
            ...(this.title ? { title: this.title } : {})
        };
    }
}

// ==================== 类常量 ====================
// DEFAULT_* 为节点默认尺寸；DESIGN_BASE / MIN_* / RESIZE_HANDLE_SIZE
// 已上收到基类 BaseCanvasNode（静态继承，this.constructor.X 直接可见）
TextNode.DEFAULT_WIDTH = 2048;    // 默认宽度（与提示词/生图节点同量级）
TextNode.DEFAULT_HEIGHT = 2048;   // 默认高度
TextNode.DEFAULT_TITLE = 'Note';  // 默认标题（双击标题可自定义）

// 将 TextNode 类暴露到全局作用域
window.TextNode = TextNode;
