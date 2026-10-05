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
 *    （选空 = 此条不生效，故无需启用开关）、模型强度（strength_model）、
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
        // file 为空视为未配置/不生效（提交时过滤），因此无需启用开关
        this.entries = (Array.isArray(options.entries) ? options.entries : []).map((e) => ({
            id: e.id || LumenLight.generateId(),
            file: e.file || '',
            strengthModel: LoraNode._clampStrength(e.strengthModel, 1),
            strengthClip: LoraNode._clampStrength(e.strengthClip, 1)
        }));

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

        // 条目事件委托：文件切换 / 强度修改
        // （文件选空 = 此条不生效，因此无需启用开关）
        this.entriesEl.addEventListener('change', (e) => {
            const entryEl = e.target.closest('.lora-entry');
            if (!entryEl) return;
            const entry = this.entries.find((en) => en.id === entryEl.dataset.entryId);
            if (!entry) return;

            if (e.target.classList.contains('lora-file-select')) {
                entry.file = e.target.value;
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
        });

        // 添加按钮：追加一条空条目（文件下拉待选）
        this.addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.addEntry();
        });

        // 滚轮规则（与 ComfyGenNode 一致）：节点浮在 canvas 上方，wheel
        // 到不了画布层，必须在此转发缩放；交互控件（下拉/输入/按钮）放行
        // 原生行为。漏掉这个监听会导致悬停在节点任意位置（含边缘/状态栏）
        // 时滚轮缩放失效
        this.el.addEventListener('wheel', (e) => {
            if (e.target.closest('select, button, input, textarea')) return;
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
            strengthClip: 1
        });
        this.renderEntries();
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
            strengthClip: 1
        });
        this.renderEntries();
    }

    /**
     * 重建条目列表 DOM（条目数量/增删时全量重建；输入修改走事件直改不重建）。
     * 结构与 Comfy 生图节点同款节奏：标签在上、控件在下——
     * 「lora」+ 文件下拉（可选空 = 此条不生效，故无需启用开关），
     * 下方「模型强度」「CLIP强度」两个独立输入框（复用 comfy-param-pair）
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
            <div class="lora-entry" data-entry-id="${LumenLight.escapeHtml(entry.id)}">
                <div class="image-gen-row">
                    <div class="image-gen-label">lora</div>
                    <div class="lora-entry-head">
                        <select class="llm-model-select lora-file-select" title="LoRA 文件（选空则此条不生效）">
                            <option value="" ${entry.file ? '' : 'selected'}>-- 选择 LoRA 文件 --</option>
                            ${this.loraFiles.map((f) =>
                                `<option value="${LumenLight.escapeHtml(f)}" ${f === entry.file ? 'selected' : ''}>${LumenLight.escapeHtml(f)}</option>`
                            ).join('')}
                            ${entry.file && !this.loraFiles.includes(entry.file)
                                ? `<option value="${LumenLight.escapeHtml(entry.file)}" selected>${LumenLight.escapeHtml(entry.file)}</option>`
                                : ''}
                        </select>
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
        this.renderEntries();
    }

    /**
     * 获取生效中的 LoRA 条目（提交注入用；供 ImagePipeline.collectLoras 消费）。
     * 文件选空 = 此条不生效，因此无启用开关
     * @returns {Array<{file: string, strengthModel: number, strengthClip: number}>}
     */
    getEnabledLoras() {
        return this.entries
            .filter((e) => e.file)
            .map((e) => ({ file: e.file, strengthModel: e.strengthModel, strengthClip: e.strengthClip }));
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
// 内容字号/间距随 --ns 缩放：本节点覆写 DESIGN_BASE 为 384，
// 使 ns = min(2048, 1536) / 384 = 4.0，与 Comfy 生图节点（2048/512 = 4.0）
// 的排版完全一致——否则同为 2048 宽时本节点字号会小 25%
LoraNode.DESIGN_BASE = 384;
LoraNode.DEFAULT_WIDTH = 2048;    // 与提示词节点同宽量级
LoraNode.DEFAULT_TITLE = 'LoRA Stack'; // 默认标题（双击标题可自定义）
LoraNode.DEFAULT_HEIGHT = 1536;   // 纵向留多条条目的空间，超出由列表区滚动

// 将类暴露到全局作用域
window.LoraNode = LoraNode;
