/**
 * ==========================================================================
 * LumenLight LoRA 节点（LoraNode）
 * ==========================================================================
 * 作用：画布上可堆叠的 LoRA 组合节点。左右双端口串在提示词链路中
 *       （提示词节点 → LoRA 节点 → Comfy 生图节点），连线表达"作用范围"：
 *       堆栈作用于下游的 Comfy 生图节点；提示词文本原样透传，不做任何修改。
 *
 * 堆栈与注入（与 Comfy 生图节点的分工）：
 *   - 节点内是 LoRA 条目列表（可不断"+ 添加 LoRA"堆叠），每条含文件下拉
 *    （选空 = 此条不生效）、启用勾选框（与面板叠加区同语义：取消勾选 =
 *     提交时跳过，不影响已填的强度值）、模型强度（strength_model）、
 *     CLIP 强度（strength_clip）；
 *   - 提交时 ComfyGenNode 经 ImagePipeline.collectLoras 收集链上全部生效
 *     条目，由后端 injectLoraChain 图拼接注入工作流（动态创建 LoraLoader
 *     链），并**追加在模板 lora 之后**（叠加语义）；
 *   - 模板内嵌的 LoRA 由 Comfy 生图节点的 LoRA 行管理（含加速 lora 等
 *     功能性必需项），本节点是其上的增量补充；工作流模板里有没有
 *     LoraLoader 都不影响本节点生效——没有模板 lora 的工作流由此获得
 *     lora 能力，这正是本节点的价值之一。
 *
 * 交互职责划分（与 PromptNode 一致）：面板的选中/拖动由 CanvasInteraction
 *   统一处理（mousedown 透传）；连线规则见 CanvasConnections.isValidLink
 *   （左端口只收提示词/LoRA，右端口只连 LoRA/生图节点）。
 * ==========================================================================
 */

class LoraNode extends BaseCanvasNode {
    /**
     * 构造函数
     * @param {Canvas} canvas - 画布主类实例
     * @param {number} x - 画布坐标 X（左上角）
     * @param {number} y - 画布坐标 Y（左上角）
     * @param {Object} [options] - 恢复存档/粘贴时的初始状态
     * @param {Array<{id?, file?, strengthModel?, strengthClip?}>} [options.entries] - LoRA 条目
     * @param {number} [options.width] - 节点宽度
     * @param {number} [options.height] - 节点高度
     */
    constructor(canvas, x, y, options = {}) {
        super(canvas, x, y);
        this.source = NodeTypes.SOURCE.LORA_NODE;

        this.width = options.width || LoraNode.DEFAULT_WIDTH;
        this.height = options.height || LoraNode.DEFAULT_HEIGHT;

        // LoRA 条目（可堆叠）。每条独立 id 供增删定位；
        // file 为空视为未配置/不生效（提交时过滤）；enabled 缺省视为启用
        // （兼容未写该字段的旧存档，与面板叠加区条目同语义）
        this.entries = (Array.isArray(options.entries) ? options.entries : []).map((e) => ({
            id: e.id || LumenLight.generateId(),
            file: e.file || '',
            strengthModel: LoraNode._clampStrength(e.strengthModel, 1),
            strengthClip: LoraNode._clampStrength(e.strengthClip, 1),
            enabled: e.enabled !== false
        }));

        // 高度自适应下限：创建/存档恢复时的高度——自适应只在内容超过它时
        // 向上生长，删除条目回缩到它为止，用户既有几何不被吃掉
        this._heightFloor = this.height;

        // LoRA 文件清单（来自 /api/comfy-node/models 的 loras 类别）
        this.loraFiles = [];
        this.lorasConnected = false;

        this.buildDom();
        this.bindEvents();
        this.updateTransform();
        this.loadLoraFiles();
    }

    /**
     * 构建 DOM 结构：标题栏 + 状态栏（左右端口）+ 条目列表 + 添加按钮
     */
    buildDom() {
        this.el = document.createElement('div');
        this.el.className = 'text-node image-gen-node lora-node';
        this.el.dataset.id = this.id;

        this.el.innerHTML = `
            <div class="text-node-header">
                <span class="text-node-title">LoRA Stack</span>
                <span class="text-node-badge">LoRA</span>
            </div>
            <!-- 状态栏：左右端口圆点（文本透传，连线表达作用范围） -->
            <div class="text-node-statusbar">
                <div class="text-node-port text-node-port-in" title="输入端口：连接提示词节点或 LoRA 节点"></div>
                <div class="text-node-port text-node-port-out" title="输出端口：连接 Comfy 生图节点"></div>
            </div>
            <div class="image-gen-form">
                <!-- 触发词按钮行：条目区左上角（管理整个节点的触发词），
                     lora 条目框随之整体下移让位 -->
                <div class="lora-triggers-row">
                    <button type="button" class="lora-triggers-btn"
                            title="管理此节点 LoRA 的触发词（开关/权重，自动写入链上提示词节点末尾）"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83z"/><line x1="7" y1="7" x2="7.01" y2="7.01"/></svg>触发词</button>
                </div>
                <div class="lora-entries"></div>
                <button type="button" class="lora-add-btn" title="添加一条 LoRA">+ 添加 LoRA</button>
            </div>
            <div class="text-node-resize" title="拖拽调整大小"></div>
        `;

        this.portInEl = this.el.querySelector('.text-node-port-in');
        this.portOutEl = this.el.querySelector('.text-node-port-out');
        this.entriesEl = this.el.querySelector('.lora-entries');
        this.addBtn = this.el.querySelector('.lora-add-btn');

        // 标题双击重命名（基类共用实现，六类节点同一套交互）
        this.initTitleEditor();

        // 挂载到页面：面板节点是浮在画布上方的 DOM 元素（body 直挂，
        // 由 updateTransform 按画布视口变换定位），漏挂则完全不可见
        document.body.appendChild(this.el);

        this.renderEntries();
    }

    /**
     * 绑定事件：选中/拖动透传、端口拖线、条目增删改（事件委托）、添加按钮
     */
    bindEvents() {
        // mousedown 转发给画布交互层（复用统一的选中/拖动逻辑），
        // 控件交互（下拉/输入/按钮）拦截透传走原生行为
        this.el.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            // 交互控件（下拉/输入/按钮）拦截走原生行为，其余透传给交互层
            if (e.target.closest('select, input, button')) {
                e.stopPropagation();
                return;
            }
            e._canvasNodeTarget = this;
            this.canvas.interaction.onMouseDown(e);
        });

        // 左右端口圆点：按下进入拖线模式（与 PromptNode 同机制）
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

        // 条目事件委托：启用开关 / 文件切换 / 强度修改
        // （文件选空 = 此条不生效；启用开关取消勾选 = 提交时跳过）
        this.entriesEl.addEventListener('change', (e) => {
            const entryEl = e.target.closest('.lora-entry');
            if (!entryEl) return;
            const entry = this.entries.find((en) => en.id === entryEl.dataset.entryId);
            if (!entry) return;

            if (e.target.classList.contains('comfy-lora-enable-input')) {
                // 启用开关：就地改状态与置灰态，不重建 DOM（与面板叠加区一致）
                entry.enabled = e.target.checked;
                entryEl.classList.toggle('is-off', !entry.enabled);
                this._emitStackChanged();
            } else if (e.target.classList.contains('lora-file-select')) {
                entry.file = e.target.value;
                this._emitStackChanged();
            } else if (e.target.classList.contains('lora-strength-model')) {
                entry.strengthModel = LoraNode._clampStrength(e.target.value, entry.strengthModel);
                e.target.value = entry.strengthModel;
            } else if (e.target.classList.contains('lora-strength-clip')) {
                entry.strengthClip = LoraNode._clampStrength(e.target.value, entry.strengthClip);
                e.target.value = entry.strengthClip;
            }
        });

        this.entriesEl.addEventListener('click', (e) => {
            const delBtn = e.target.closest('.lora-entry-delete');
            if (!delBtn) return;
            e.stopPropagation();
            const entryEl = delBtn.closest('.lora-entry');
            this.entries = this.entries.filter((en) => en.id !== entryEl.dataset.entryId);
            this.renderEntries();
            this._emitStackChanged();
        });

        // 添加按钮：追加一条空条目（文件下拉待选）
        this.addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.addEntry();
        });

        // 触发词按钮：唤出触发词管理器（画布模式——条目下拉/写入目标均为
        // 本节点语境，监听方为 LoraTriggerManager）
        const triggersBtn = this.el.querySelector('.lora-triggers-btn');
        if (triggersBtn) {
            triggersBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                document.dispatchEvent(new CustomEvent('lumen-lora-node-triggers-open', {
                    detail: { node: this }
                }));
            });
        }

        // 滚轮规则（与 ComfyGenNode 一致）：节点浮在 canvas 上方，wheel
        // 到不了画布层，必须在此转发缩放；交互控件（下拉/输入/按钮）放行
        // 原生行为。漏掉这个监听会导致悬停在节点任意位置（含边缘/状态栏）
        // 时滚轮缩放失效。条目列表内容超高时同样放行——此时滚轮应滚动
        // 列表而非缩放画布
        this.el.addEventListener('wheel', (e) => {
            if (e.target.closest('select, button, input, textarea')) return;
            const list = e.target.closest('.lora-entries');
            if (list && list.scrollHeight > list.clientHeight) return;
            e.preventDefault();
            this.canvas.interaction.handleWheel(e);
        }, { passive: false });
    }

    // ==================== 条目管理 ====================

    /**
     * 追加一条空条目（文件下拉待选，默认双强度 1）
     */
    addEntry() {
        this.entries.push({
            id: LumenLight.generateId(),
            file: '',
            strengthModel: 1,
            strengthClip: 1,
            enabled: true
        });
        this.renderEntries();
        this._emitStackChanged();
    }

    /**
     * 追加一条已指定文件的条目（LoRA 管理器「发送到节点」投递用；
     * 文件不在清单里时 renderEntries 会自动补一条隐藏 option 正常回显）
     * @param {string} file - lora 相对路径（与 Comfy lora_name 同源）
     */
    addLoraFile(file) {
        this.entries.push({
            id: LumenLight.generateId(),
            file: file || '',
            strengthModel: 1,
            strengthClip: 1,
            enabled: true
        });
        this.renderEntries();
        this._emitStackChanged();
    }

    /**
     * 重建条目列表 DOM（条目数量/增删时全量重建；输入修改走事件直改不重建）。
     * 结构与面板叠加区同款节奏：文件下拉（可选空 = 此条不生效）+ 启用
     * 勾选框 + 删除钮，下方「模型强度」「CLIP强度」两个独立输入框
     * （复用 comfy-param-pair）
     */
    renderEntries() {
        if (this.entries.length === 0) {
            // 空列表提示：区分 ComfyUI 离线（清单读不到）与单纯未添加
            this.entriesEl.innerHTML = this.lorasConnected
                ? '<div class="lora-empty">暂无 LoRA，点下方按钮添加；用于给当前工作流补充新的 LoRA</div>'
                : '<div class="lora-empty">ComfyUI 未连接，无法读取 LoRA 文件清单</div>';
            return;
        }

        this.entriesEl.innerHTML = this.entries.map((entry) => `
            <div class="lora-entry${entry.enabled === false ? ' is-off' : ''}" data-entry-id="${LumenLight.escapeHtml(entry.id)}">
                <div class="image-gen-row">
                    <div class="image-gen-label">lora</div>
                    <div class="lora-entry-head">
                        <div class="llm-model-select lora-file-select lfs-host" data-entry-id="${LumenLight.escapeHtml(entry.id)}" title="LoRA 文件（选空则此条不生效，点开看封面）"></div>
                        <input type="checkbox" class="comfy-lora-enable-input"
                               title="勾选后此条 LoRA 生效；取消勾选则提交时跳过（不影响已填的强度值）"${entry.enabled === false ? '' : ' checked'}>
                        <button type="button" class="lora-entry-delete" title="删除此 LoRA">✕</button>
                    </div>
                </div>
                <div class="comfy-param-pair">
                    <div class="image-gen-row">
                        <div class="image-gen-label">模型强度</div>
                        <input type="number" class="comfy-num-input lora-strength-model"
                               min="-5" max="5" step="0.05" value="${entry.strengthModel}"
                               title="模型强度（strength_model）">
                    </div>
                    <div class="image-gen-row">
                        <div class="image-gen-label">CLIP强度</div>
                        <input type="number" class="comfy-num-input lora-strength-clip"
                               min="-5" max="5" step="0.05" value="${entry.strengthClip}"
                               title="CLIP 强度（strength_clip）">
                    </div>
                </div>
            </div>
        `).join('');

        // LoRA 封面选择器初始化：挂载 div 冒充 select（class/data-entry-id
        // 原样保留，change 委托与 e.target.value 零改动兼容）
        this.entriesEl.querySelectorAll('.lfs-host').forEach((el) => {
            const entry = this.entries.find((en) => en.id === el.dataset.entryId);
            new LoraFileSelect(el, {
                files: this.loraFiles,
                value: entry ? entry.file : '',
                allowEmpty: true,
                emptyLabel: '-- 选择 LoRA 文件 --'
            });
        });

        // 条目数量变化 → 节点高度自适应（添加 LoRA 自动长高、删除自动回缩）
        this._autoFitHeight();
    }

    /**
     * 内容自适应高度：量取内容自然高度直接写回 this.height 并应用变换——
     * 添加 LoRA 节点自动长高、删除自动回缩，不出滚动条。
     * 量测关键：临时解除 flex 收缩（form flex:1 1 0 + min-height:0 在
     * auto 高容器里会塌缩成 0，直接量 scrollHeight 只剩固定件的高度，
     * 节点永远不长高——上一版正是栽在这里），把表单与条目列表置为
     * 内容尺寸后 el.scrollHeight 才是真实自然高度；world 布局下布局
     * 像素=世界像素（transform 不影响布局）。下限为 _heightFloor
     * （创建/存档时的高度），删除条目回缩到它为止
     */
    _autoFitHeight() {
        const el = this.el;
        if (!el || !el.isConnected) return;
        const form = el.querySelector('.image-gen-form');
        const list = this.entriesEl;
        const prevH = el.style.height;
        const prevForm = form ? form.style.flex : '';
        const prevList = list.style.flex;
        const prevListOv = list.style.overflowY;
        el.style.height = 'auto';
        if (form) form.style.flex = '0 0 auto';
        list.style.flex = '0 0 auto';
        list.style.overflowY = 'visible';
        const natural = el.scrollHeight;
        el.style.height = prevH;
        if (form) form.style.flex = prevForm;
        list.style.flex = prevList;
        list.style.overflowY = prevListOv;
        if (!natural) return;
        const next = Math.max(natural, this._heightFloor || LoraNode.DEFAULT_HEIGHT);
        if (next === this.height) return;
        this.height = next;
        this.updateTransform();
    }

    /**
     * 拉取 LoRA 文件清单（/api/comfy-node/models 的 loras 类别），
     * 就绪后重建条目下拉（ComfyUI 离线时保留已选文件）
     */
    async loadLoraFiles() {
        try {
            const response = await fetch('/api/comfy-node/models');
            const data = await response.json();
            this.lorasConnected = !!data.connected;
            this.loraFiles = data.loras || [];
        } catch (error) {
            console.error('LoRA 节点加载文件清单失败:', error);
            this.lorasConnected = false;
            this.loraFiles = [];
        }
        // 清单就绪后自动补归一（ADR 028 决策四）：离线期间投递的条目按
        // 原路径入栈，清单到位后回扫唯一文件名匹配的条目就地更正
        const healed = window.LoraSendPopup?.healEntries?.(this.entries, this.loraFiles);
        if (healed > 0) {
            console.info(`[LoRA节点] ${healed} 只历史条目已按 ComfyUI 清单自动更正路径`);
            window.socket?.showNotification?.(`${healed} 只历史 LoRA 已自动更正为 ComfyUI 清单路径`, 4000);
        }
        this.renderEntries();
        // 清单就绪/补归一后通知触发词管理器：异步完成时存档恢复与连线
        // 均已就绪，正好作为画布侧托管块的初始同步时机
        this._emitStackChanged();
    }

    /**
     * 获取生效中的 LoRA 条目（提交注入用；供 ImagePipeline.collectLoras 消费）。
     * 文件选空或勾选框取消启用的条目不生效（enabled 缺省视为启用，兼容
     * 未写该字段的旧存档；与面板 ComfyParamRows.getLoras 同语义）
     * @returns {Array<{file: string, strengthModel: number, strengthClip: number}>}
     */
    getEnabledLoras() {
        return this.entries
            .filter((e) => e.file && e.enabled !== false)
            .map((e) => ({ file: e.file, strengthModel: e.strengthModel, strengthClip: e.strengthClip }));
    }

    /**
     * 内容缩放系数钉死为 4.0，与 Comfy 生图节点同款字号（其 design 布局
     * 下 ns = 2048/512 = 4.0 恒定）。基类按 min(宽,高)/DESIGN_BASE 计算——
     * 本节点高度随条目自适应增长，跟随计算会让字号越加越大（实测
     * 多条目时 4.0 → 6.7+，用户看到的「太粗」即此），必须与高度解耦
     * @returns {number}
     */
    get ns() {
        return LoraNode.CONTENT_NS;
    }

    /**
     * 链上上游提示词节点（触发词块的写入目标候选）。复用
     * ImagePipeline.collectUpstreamPromptNodes 的遍历语义：从本节点沿入边
     * 向上 BFS、穿过提示词/LoRA 节点，输出"离本节点由远到近"——
     * 末位即最近的一个，作为默认写入目标
     * @returns {Object[]} 提示词节点数组（无上游提示词时为空数组）
     */
    getUpstreamPromptNodes() {
        return this._pipeline().collectUpstreamPromptNodes(this.id);
    }

    /**
     * 按 id 查画布对象（提示词节点等；canvas.images.images 实为
     * 全画布对象数组——图片与节点混存，ImagePipeline 同源约定）
     * @param {string} id
     * @returns {Object|undefined}
     */
    findCanvasObject(id) {
        return (this.canvas.images.images || []).find((o) => o.id === id);
    }

    /** 构建管线实例（与 ComfyGenNode._pipeline 同策略：每次新建保证最新连线） */
    _pipeline() {
        return new ImagePipeline(
            this.canvas.connections.connections,
            this.canvas.images.images
        );
    }

    /**
     * 本节点条目/文件变化通知（LoraTriggerManager 监听）：触发词托管块
     * 按本节点语境幂等重算。监听方做存活校验，节点删除后的残留事件无害
     */
    _emitStackChanged() {
        document.dispatchEvent(new CustomEvent('lumen-lora-node-changed', {
            detail: { node: this }
        }));
    }

    /**
     * 销毁（节点删除/撤销重建）：先通知触发词管理器把本节点的托管块从
     * 目标提示词节点摘除并清书签（撤销删除重建节点时构造链路会自动
     * 重新同步回来），再走基类清理
     */
    destroy() {
        document.dispatchEvent(new CustomEvent('lumen-lora-node-removed', {
            detail: { node: this }
        }));
        super.destroy();
    }

    // ==================== 存档 ====================

    /**
     * 序列化为存档数据（条目全量保存）
     */
    toJSON() {
        return {
            id: this.id,
            type: NodeTypes.SOURCE.LORA_NODE,
            x: this.x,
            y: this.y,
            width: this.width,
            height: this.height,
            entries: this.entries,
            ...(this.title ? { title: this.title } : {})
        };
    }

    // ==================== 静态工具 ====================

    /**
     * 强度值清洗：非法/缺省回落默认值，钳制到 [-5, 5]
     * @param {*} v - 输入值
     * @param {number} fallback - 回落值
     * @returns {number}
     */
    static _clampStrength(v, fallback) {
        const n = parseFloat(v);
        if (isNaN(n)) return fallback;
        return Math.max(-5, Math.min(5, n));
    }
}

// ==================== 类常量 ====================
// DEFAULT_* 为节点默认尺寸（world 布局，world 坐标）；布局常量继承自基类。
// 内容缩放不走基类 min(宽,高)/DESIGN_BASE（高度自适应会带动字号漂移），
// 钉死在本类 CONTENT_NS（覆写 get ns()）；DESIGN_BASE 仅保留基类接口缺省
LoraNode.CONTENT_NS = 4.0;        // 内容缩放：与 Comfy 生图节点（2048/512=4.0）同款字号
LoraNode.DESIGN_BASE = 512;
LoraNode.DEFAULT_WIDTH = 2048;    // 与提示词节点同宽量级
LoraNode.DEFAULT_TITLE = 'LoRA Stack'; // 默认标题（双击标题可自定义）
LoraNode.DEFAULT_HEIGHT = 1536;   // 创建时的高度兼自适应下限（_heightFloor）；
                                  // 条目超出时节点自动长高（_autoFitHeight）

// 将类暴露到全局作用域
window.LoraNode = LoraNode;
