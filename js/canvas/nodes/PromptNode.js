/**
 * ==========================================================================
 * LumenLight 提示词节点
 * 作用：画布上的可视化提示词容器节点，用于把提示词文本传送给
 *       ComfyUI / LLM API。可与其他提示词节点串联（右出左入），
 *       图片也可连入其左端作为内容素材。
 *
 * 形态说明：
 *   - 节点本体是 DOM 元素（div.text-node），随画布视口变换定位缩放，
 *     内部textarea 原生支持光标点击输入、选中文本、多行编辑。
 *   - 与图片对象统一放在 images.images 数组中，source 为 'prompt-node'，
 *     通过 source 字段区分类型，复用现有选中/拖动/连线/存档链路。
 *   - 技能栏：底部「技能下拉 + 执行按钮」，调用聊天模型处理节点文字与
 *     直连参考图（优化提示词 / 反推图像 + 用户自定义技能），
 *     实现独立在 PromptSkillBar.js，本类仅持有其实例并负责销毁。
 *   - 文本镜像层由共享模块 NodeTextMirror 驱动（@图片N 高亮 + 自绘粗光标），
 *     文本节点（TextNode）复用同一模块，光标相关的坑都在模块层修。
 *
 * 参考图缩略图（图生图辅助）：
 *   - 有画布图片连入本节点时，输入框上方显示缩略图条，每张图带序号徽标
 *     （①②③...），顺序与 ImagePipeline.collectImages 的收集顺序一致
 *     （按连线数组顺序 = 连线创建先后），帮助用户了解图生图的参考图顺序；
 *   - 点击缩略图自动在输入框光标处插入 "@图片N" 引用标记，正文中该标记
 *     由镜像层高亮显示（textarea 文本本身无法着色，用同尺寸镜像层叠加）；
 *   - 原生光标在画布缩放下只有不到半像素宽，几乎不可见，故隐藏原生光标，
 *     由镜像层在光标位置自绘粗光标条（.fake-caret，带闪烁动画）；
 *   - 缩略图条在 updateTransform（每帧）里做签名比对刷新：连线被截断、
 *     图片被删除、存档恢复等任何连线变动都会让签名变化，缩略图随之消失，
 *     无需在各变更点逐一通知。
 *
 * 关键规则：
 *   - 连线规则：左端口只接收图片或提示词节点的输入；
 *     右端口输出只能连向其他提示词节点的左端口或将来的 API 节点，
 *     不能连向图片（图片是内容载体，不接收提示词）。
 *   - 缩放：右下角拖拽手柄自由调整宽高（非等比），文本自动重排。
 * ==========================================================================
 */

class PromptNode extends BaseCanvasNode {
    /**
     * 创建提示词节点并挂载 DOM
     * @param {Canvas} canvas - 画布主类实例
     * @param {number} x - 节点左上角画布 X 坐标
     * @param {number} y - 节点左上角画布 Y 坐标
     * @param {string} [text=''] - 初始提示词文本
     * @param {Object} [size] - 初始尺寸 {width, height}
     */
    constructor(canvas, x, y, text = '', size = {}) {
        super(canvas, x, y);
        this.source = NodeTypes.SOURCE.PROMPT_NODE;
        this.text = text;

        this.width = size.width || PromptNode.DEFAULT_WIDTH;
        this.height = size.height || PromptNode.DEFAULT_HEIGHT;

        this.buildDom();
        this.bindEvents();
        this.updateTransform();

        // 跟随设置开关即时启停补全（SettingsManager 切换时广播）
        this._onAutocompleteSetting = (e) => {
            this.setAutocompleteEnabled(!!(e.detail && e.detail.enabled));
        };
        window.addEventListener('promptAutocompleteSettingChanged', this._onAutocompleteSetting);
    }

    /**
     * 构建 DOM 结构：标题栏 + 文本域 + 缩放手柄 + 左右端口圆点
     */
    buildDom() {
        this.el = document.createElement('div');
        this.el.className = 'text-node';
        // data-id 供事件委托时反查节点
        this.el.dataset.id = this.id;

        this.el.innerHTML = `
            <div class="text-node-header">
                <span class="text-node-title">Prompt</span>
                <span class="text-node-badge">提示词节点</span>
            </div>
            <!-- 状态栏：左右端口圆点（连线拖拽的起点/终点，DOM 元素骑在面板边缘） -->
            <div class="text-node-statusbar">
                <div class="text-node-port text-node-port-in" title="输入端口"></div>
                <div class="text-node-port text-node-port-out" title="输出端口"></div>
            </div>
            <!-- 参考图缩略图条：有图片连入时由 refreshRefThumbnails 填充显示 -->
            <div class="text-node-refs" hidden></div>
            <div class="text-node-body">
                <!-- 编辑器容器：镜像层（高亮/自绘光标）与 textarea 逐字对齐叠放 -->
                <div class="text-node-editor">
                    <div class="text-node-input-mirror" aria-hidden="true"></div>
                    <textarea class="text-node-input" placeholder="输入提示词..." spellcheck="false"></textarea>
                </div>
            </div>
            <div class="text-node-resize" title="拖拽调整大小"></div>
        `;

        this.inputEl = this.el.querySelector('.text-node-input');
        this.mirrorEl = this.el.querySelector('.text-node-input-mirror');
        this.refsEl = this.el.querySelector('.text-node-refs');
        this.resizeEl = this.el.querySelector('.text-node-resize');
        this.portInEl = this.el.querySelector('.text-node-port-in');
        this.portOutEl = this.el.querySelector('.text-node-port-out');

        this.inputEl.value = this.text;

        // 文本镜像层（通用模块）：@图片N 标记高亮 + 自绘粗光标
        this.mirrorLayer = new NodeTextMirror(this.inputEl, this.mirrorEl, {
            tokenPattern: /@图片\d+/g,
            tokenClass: 'ref-token'
        });

        // 提示词补全（与面板输入框共用组件与词典数据，词典在共享单例中
        // 只持一份）；下拉挂在 body 上、按屏幕坐标定位，不随节点缩放。
        // 受通用设置开关控制，部分模型不需要 tag 补全时可全局关闭
        if (SettingsManager.getPromptAutocompleteEnabled()) {
            this.autocomplete = new PromptAutocomplete(this.inputEl);
        }

        // 技能栏：底部「技能下拉 + 执行按钮」，调聊天模型处理节点文本/参考图
        this.skillBar = new PromptSkillBar(this);

        // 标题双击重命名（基类共用实现，六类节点同一套交互）
        this.initTitleEditor();

        // 挂到画布容器（canvas 元素的父级，即 body），跟随视口变换
        document.body.appendChild(this.el);
    }

    /**
     * 绑定节点内部 DOM 事件
     * 交互职责划分：
     *   - 节点面板的点击/拖动由 CanvasInteraction 统一处理（本类只透传 mousedown）
     *   - textarea 的键盘输入、光标操作由原生行为接管
     */
    bindEvents() {
        // 输入框获得焦点时正在编辑：阻止画布层把按键当作快捷键
        // （如 Delete 删除节点），编辑期间节点不可拖动
        this.inputEl.addEventListener('focus', () => {
            this.isEditing = true;
        });
        this.inputEl.addEventListener('blur', () => {
            this.isEditing = false;
            this.text = this.inputEl.value;
            // 派发变更事件（当前无内置监听者，保留为扩展点：
            // 外部组件可监听 promptNodeTextChanged 做联动）
            window.dispatchEvent(new CustomEvent('promptNodeTextChanged', {
                detail: { node: this, text: this.text }
            }));
        });
        this.inputEl.addEventListener('input', () => {
            this.text = this.inputEl.value;
        });

        // 参考图缩略图条：拦截 mousedown（不选中/拖动节点、不抢走 textarea
        // 焦点），点击缩略图在光标处插入 @图片N 引用
        this.refsEl.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.preventDefault();
        });

        // mousedown 转发给画布交互层：节点是 DOM 元素浮在 canvas 上方，
        // 事件不会自然到达 canvas，必须主动转发才能复用统一的选中/拖动逻辑。
        // e._canvasNodeTarget 标记本节点，交互层据此进入节点专属交互流程。
        this.el.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;   // 只转发左键
            // 点击输入框：仅当已处于编辑态（聚焦）时才放行原生行为；
            // 未聚焦的第一次点击先转发给交互层（选中/拖动），拖动失败
            // （无位移松手）后浏览器原生聚焦行为依然生效，光标定位不受影响
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

        // 左右端口圆点：悬停放大反馈 + 按下进入拖线模式
        // （拦截冒泡，带上端口方位标记，交互层据此走连线流程）
        const bindPort = (portEl, side) => {
            portEl.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                e._canvasNodeTarget = this;
                e._promptNodePortSide = side;
                this.canvas.interaction.onMouseDown(e);
            });
        };
        bindPort(this.portInEl, 'in');
        bindPort(this.portOutEl, 'out');

        // 滚轮规则：编辑文本时滚轮只滚动文本（到顶/到底也不再缩放画布），
        // 想缩放画布先点击空白处退出编辑；非编辑态滚轮缩放画布。
        // 编辑态拦下 Ctrl/⌘+滚轮，避免触发浏览器自身的页面缩放
        this.el.addEventListener('wheel', (e) => {
            if (this.isEditing) {
                if (e.ctrlKey || e.metaKey) e.preventDefault();
                return;   // 放行 textarea 原生滚动
            }
            e.preventDefault();
            this.canvas.interaction.handleWheel(e);
        }, { passive: false });

        // 右键在节点上：不弹画布菜单（与图片一致），保持默认或无操作
        this.el.addEventListener('contextmenu', (e) => {
            e.stopPropagation();
        });
    }

    /**
     * 收集连入本节点的参考图（顺序与生图管线一致）
     * ImagePipeline.collectImages 按连线数组顺序（即连线创建先后）遍历
     * 收集参考图，这里用同样的遍历方式取直连本节点的画布图片，
     * 保证缩略图序号与实际提交 API 时的参考图顺序对应。
     * @returns {Object[]} 画布图片对象数组（按收集顺序）
     */
    collectInputImages() {
        const conns = this.canvas.connections?.connections || [];
        const result = [];
        for (const c of conns) {
            if (c.toId !== this.id) continue;
            const from = this.canvas.images.images.find(img => img.id === c.fromId);
            // 与 ImagePipeline.isCanvasImage 同规则：真实画布图片，跳过占位图与节点面板
            if (NodeTypes.isRealCanvasImage(from)) {
                result.push(from);
            }
        }
        return result;
    }

    /**
     * 刷新参考图缩略图条（由 updateTransform 每帧调用）
     * 用「连入连线的 fromId:id 签名」做脏检查：连线增删、截断、图片删除、
     * 存档恢复都会改变签名，仅变化时才重建 DOM，常规每帧调用零开销。
     * 签名含连线 id（而非仅 fromId）：恢复存档后连线全部是新建对象，
     * 即使 fromId 列表相同也重建一次，保证缩略图与当前连线状态一致。
     */
    refreshRefThumbnails() {
        if (!this.refsEl) return;
        const conns = (this.canvas.connections?.connections || [])
            .filter(c => c.toId === this.id);
        const sig = conns.map(c => c.fromId + ':' + c.id).join(',');
        if (sig === this._refsSig) return;
        this._refsSig = sig;

        const imgs = this.collectInputImages();
        if (imgs.length === 0) {
            this.refsEl.hidden = true;
            this.refsEl.innerHTML = '';
            this.mirrorLayer.update();
            return;
        }

        this.refsEl.innerHTML = '';
        this.refsEl.hidden = false;
        imgs.forEach((obj, i) => {
            const n = i + 1;
            const thumb = document.createElement('div');
            thumb.className = 'text-node-ref';
            thumb.title = `参考图 ${n}，点击插入 @图片${n}`;

            const im = document.createElement('img');
            im.src = obj.img.src;
            im.draggable = false;
            im.alt = `参考图${n}`;

            const badge = document.createElement('span');
            badge.className = 'text-node-ref-num';
            badge.textContent = n;

            thumb.appendChild(im);
            thumb.appendChild(badge);
            thumb.addEventListener('click', () => this.insertRefToken(n));
            this.refsEl.appendChild(thumb);
        });
        this.mirrorLayer.update();
    }

    /**
     * 在输入框光标处插入 "@图片N" 引用标记并聚焦
     * 前后自动补空格（紧邻非空白字符时），保证标记与已有文本分隔清晰；
     * 用 setRangeText 保留原生撤销栈，插入后手动派发 input 事件
     * 同步 this.text 与镜像层高亮。
     * @param {number} n - 参考图序号（从 1 开始）
     */
    insertRefToken(n) {
        const ta = this.inputEl;
        const token = `@图片${n}`;
        ta.focus();
        const start = ta.selectionStart ?? ta.value.length;
        const end = ta.selectionEnd ?? start;
        const padBefore = start > 0 && !/\s/.test(ta.value[start - 1]) ? ' ' : '';
        const padAfter = end < ta.value.length && !/\s/.test(ta.value[end]) ? ' ' : '';
        ta.setRangeText(padBefore + token + padAfter, start, end, 'end');
        this.text = ta.value;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /**
     * 即时启停本节点的提示词补全（通用设置开关切换时调用）
     * @param {boolean} enabled - 是否启用
     */
    setAutocompleteEnabled(enabled) {
        if (enabled && !this.autocomplete) {
            this.autocomplete = new PromptAutocomplete(this.inputEl);
        } else if (!enabled && this.autocomplete) {
            this.autocomplete.destroy();
            this.autocomplete = null;
        }
    }

    /**
     * 每帧变换后的追加逻辑（基类 afterUpdateTransform 钩子）：
     * 参考图缩略图走独立的签名脏检查，每帧照常执行
     */
    afterUpdateTransform() {
        this.refreshRefThumbnails();
    }

    /**
     * 从 DOM 移除节点（删除时调用）。
     * 先销毁镜像层（内部有挂在 document 上的 selectionchange 监听）与
     * 技能栏，避免节点销毁后监听器残留（新建画布/恢复存档都会走这里），
     * 再由基类移除节点 DOM 元素
     */
    destroy() {
        window.removeEventListener('promptAutocompleteSettingChanged', this._onAutocompleteSetting);
        if (this.autocomplete) {
            this.autocomplete.destroy();
            this.autocomplete = null;
        }
        if (this.mirrorLayer) {
            this.mirrorLayer.destroy();
        }
        if (this.skillBar) {
            this.skillBar.destroy();
        }
        super.destroy();
    }

    /**
     * 序列化为存档数据
     * type 字段供 ProjectSerializer.restoreNodes 分发重建
     * @returns {Object} {id, type:'prompt-node', x, y, width, height, text}
     */
    toJSON() {
        return {
            id: this.id,
            type: NodeTypes.SOURCE.PROMPT_NODE,
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
// DEFAULT_* 为节点默认尺寸；DESIGN_BASE / MIN_* / RESIZE_HANDLE_SIZE /
// 端口几何常量已上收到基类 BaseCanvasNode（静态继承，this.constructor.X
// 直接可见）。布局模式为基类默认的 'world'（世界尺寸布局 + --ns 缩放）
PromptNode.DEFAULT_WIDTH = 2048;    // 默认宽度（px，与画布 2K 图片同量级）
PromptNode.DEFAULT_HEIGHT = 2048;   // 默认高度（px）
PromptNode.DEFAULT_TITLE = 'Prompt'; // 默认标题（双击标题可自定义）

// 将 PromptNode 类暴露到全局作用域
window.PromptNode = PromptNode;
