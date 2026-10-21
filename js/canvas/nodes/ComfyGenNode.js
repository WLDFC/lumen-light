/**
 * ==========================================================================
 * LumenLight Comfy 生图节点（ComfyGenNode）
 * ==========================================================================
 * 作用：画布上的 ComfyUI 工作流生成节点面板，与 LLM 生图节点（ImageGenNode）
 *       平行的另一条生图链路。左侧端口接收提示词节点链（收集逻辑复用
 *       ImagePipeline，链上的 LoRA 节点堆栈一并收集），选中一个 ComfyUI
 *       工作流后扫描其 JSON 动态展示可调参数（主模型/步数+CFG/采样器+
 *       降噪/尺寸/数量——工作流里有什么就显示什么），点击生成后提交到
 *       /api/comfy-node/run，由后端注入参数、LoRA 堆栈与提示词后提交
 *       ComfyUI；生成结果经 WebSocket 带 target 精确回落到本节点的占位图上。
 *
 * 动态参数行的探测与渲染已拆出共用（右侧面板 Comfy 模式渲染同一套行）：
 *   - js/utils/ComfyParamScanner.js：工作流参数扫描（detectParams）与
 *     覆盖表编译（buildOverrides），纯数据层
 *   - js/components/ComfyParamRows.js：参数行 UI 控制器（渲染/事件/状态），
 *     本类持有其实例 this.params，状态随节点生命周期入存档
 *   - 模型/采样器下拉选项来自 ComfyUI /object_info（后端
 *     /api/comfy-node/models 代理，由 ComfyUI 自己枚举模型文件）
 *   - LoRA 加载节点由参数行的启用开关管理（未启用时提交注入强度 0
 *     软关闭；加速 lora 等功能性模板 lora 默认照常生效，画布 LoRA
 *     节点堆栈是其上的增量补充）
 *   - 负面提示词固定取右侧 Comfy 提示词面板的负面框（不设独立输入）
 *
 * 结构（复用 .text-node 与 .image-gen-node 全套样式，扩展 .comfy-gen-node）：
 *   - 标题栏：Comfy Generate + 「Comfy 生图」徽标
 *   - 状态栏：仅左端口（in），无右端口
 *   - 工具栏：工作流下拉 + 动态参数行 + 生成按钮 + 停止 X（GenStopControl，
 *     常驻两态；点 X 调 /api/comfy-node/stop 按 promptId 中断/删队列）
 *   - 内容区：动态参数容器（按检测结果逐行渲染）
 *
 * 交互职责划分（与 ImageGenNode 一致）：
 *   - 面板的选中/拖动由 CanvasInteraction 统一处理（mousedown 透传）
 *   - 下拉框/按钮等控件拦截透传，走原生行为
 *   - 生成流程由本类自行管理（占位图队列 → 提交 → WebSocket 回流落图）
 * ==========================================================================
 */

class ComfyGenNode extends BaseCanvasNode {
    /**
     * 构造函数
     * @param {Canvas} canvas - 画布主类实例
     * @param {number} x - 画布坐标 X（左上角）
     * @param {number} y - 画布坐标 Y（左上角）
     * @param {Object} [options] - 恢复存档/粘贴时的初始状态
     * @param {number} [options.width] - 节点宽度
     * @param {number} [options.height] - 节点高度
     * @param {string} [options.workflowId] - 选中的工作流 id
     * @param {Object} [options.models] - 加载节点选择 { [nodeId]: 模型文件名 }
     * @param {number} [options.steps] - 步数
     * @param {number} [options.cfg] - CFG 引导系数
     * @param {string} [options.sampler] - 采样器名（sampler_name）
     * @param {number} [options.sizeW] - 生成宽度
     * @param {number} [options.sizeH] - 生成高度
     * @param {number} [options.denoise] - 降噪强度（0-1）
     * @param {number} [options.count] - 生成数量（1-8）
     */
    constructor(canvas, x, y, options = {}) {
        super(canvas, x, y);
        this.source = NodeTypes.SOURCE.COMFY_GEN_NODE;

        this.width = options.width || ComfyGenNode.DEFAULT_WIDTH;
        this.height = options.height || ComfyGenNode.DEFAULT_HEIGHT;

        // 工具栏选择状态（存档恢复用）在 this.params（ComfyParamRows）里，
        // 此处仅保留工作流 id；models 以"工作流节点 id → 模型文件名"存储：
        // 同一工作流文件里节点 id 稳定，恢复后能对上号。
        // （LoRA 不在此管理：已迁移到画布 LoRA 节点，提交时图拼接注入）
        this.workflowId = options.workflowId || '';

        // 工作流列表缓存
        this.workflows = [];             // 工作流列表缓存
        this.workflowJson = null;        // 当前选中工作流的 API 格式 JSON

        // 生成流程状态
        this.isGenerating = false;       // 生成进行中标记（防重复提交）
        this._pending = null;            // { expected, received } 本轮待收图片计数
        this._submitting = false;        // 提交循环进行中（停止 X 的 onAbort 分流用）
        this._submittedPromptIds = [];   // 本轮已入队的 ComfyUI 任务 id（停止时按 id 取消）
        this._watchdog = null;           // 生成看门狗（ComfyUI 长时间无响应时兜底复位）

        this.buildDom();

        // 动态参数行控制器（在 buildDom 之后创建，容器才存在）；
        // 存档恢复的参数状态经 setState 回填，随节点生命周期保存。
        // 数量下拉不在参数行内渲染（countRow=false），由生成按钮旁的
        // 步进器接管（1-9999，与右侧面板步进器共用 CountStepper 行为层）
        this.params = new ComfyParamRows(this.dynamicRowsEl, {
            countRow: false,
            maxCount: 9999,
            onRendered: () => this.updateCountStepper()
        });
        this.params.setState(options);

        this.bindEvents();
        this.updateTransform();
        this.loadWorkflows();
        this.loadModelLists();
    }

    /**
     * 构建 DOM 结构：标题栏 + 状态栏（左端口）+ 工作流行 + 动态参数区 + 生成按钮
     */
    buildDom() {
        this.el = document.createElement('div');
        this.el.className = 'text-node image-gen-node comfy-gen-node';
        this.el.dataset.id = this.id;

        this.el.innerHTML = `
            <div class="text-node-header">
                <span class="text-node-title">Comfy Generate</span>
                <span class="text-node-badge">Comfy 生图</span>
            </div>
            <div class="text-node-statusbar">
                <div class="text-node-port text-node-port-in" title="输入端口：连接提示词节点"></div>
            </div>
            <div class="image-gen-form">
                <div class="image-gen-row">
                    <div class="image-gen-label">工作流</div>
                    <select class="llm-model-select comfy-workflow-select" title="选择 ComfyUI 工作流">
                        <option value="">加载中…</option>
                    </select>
                </div>
                <div class="comfy-dynamic-rows"></div>
                <!-- 生成行：数量步进器（工作流含批次输入时显示，1-9999）+ 生成按钮 -->
                <div class="comfy-generate-row">
                    <div class="comfy-count-stepper" hidden
                         title="生成数量（每张为独立任务依次入队，跑完一张回传一张），上下箭头步进或直接键入">
                        <input type="text" class="comfy-count-stepper-input"
                               inputmode="numeric" maxlength="4" value="1" aria-label="生成数量">
                        <div class="comfy-count-stepper-arrows">
                            <button type="button" class="comfy-count-stepper-arrow" data-step="up" aria-label="增加数量">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
                            </button>
                            <button type="button" class="comfy-count-stepper-arrow" data-step="down" aria-label="减少数量">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                            </button>
                        </div>
                    </div>
                    <button class="image-gen-generate-btn" type="button"
                            title="收集连入的提示词并按当前工作流生成">生成</button>
                    <!-- 生成任务停止控件（GenStopControl）的 X 按钮插在本行末尾：
                         常驻两态（暗置/点亮），点击中断已入队的 ComfyUI 任务
                         （按 promptId 精确取消）并立即收尾 -->
                </div>
            </div>
            <div class="text-node-resize" title="拖拽调整大小"></div>
        `;

        this.workflowSelect = this.el.querySelector('.comfy-workflow-select');
        this.dynamicRowsEl = this.el.querySelector('.comfy-dynamic-rows');
        this.generateBtn = this.el.querySelector('.image-gen-generate-btn');

        // 生成任务停止控件：X 在生成按钮右侧，常驻两态（暗置/点亮）；状态归
        // 本节点实例持有，与 API 生图节点（ImageGenNode）同一套组件。
        // Comfy 链路的停止与 API 节点不同：提交是异步入队、结果走 WS 回流，
        // 光 abort fetch 够不着已入队的 ComfyUI 任务——点 X 须调
        // /api/comfy-node/stop 按 promptId 中断/删队列（见 _onStopClicked）
        this.stopControl = new GenStopControl({
            host: this.el.querySelector('.comfy-generate-row'),
            title: '停止本轮生成',
            onAbort: () => this._onStopClicked()
        });

        this.countStepperEl = this.el.querySelector('.comfy-count-stepper');
        this.countInputEl = this.el.querySelector('.comfy-count-stepper-input');
        this.portInEl = this.el.querySelector('.text-node-port-in');

        // 标题双击重命名（基类共用实现，六类节点同一套交互）
        this.initTitleEditor();

        // 挂到画布容器（canvas 元素的父级，即 body），跟随视口变换
        document.body.appendChild(this.el);
    }

    /**
     * 绑定节点内部 DOM 事件
     */
    bindEvents() {
        // mousedown 透传给画布交互层：节点是 DOM 元素浮在 canvas 上方，
        // 事件不会自然到达 canvas，必须主动转发才能复用统一的选中/拖动逻辑。
        // 下拉框/按钮等交互控件拦截透传，走原生行为（选择、点击）。
        this.el.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;   // 只转发左键
            if (e.target.closest('select, button, input, textarea')) {
                e.stopPropagation();
                return;
            }
            e._canvasNodeTarget = this;
            this.canvas.interaction.onMouseDown(e);
        });

        // 左端口圆点：悬停放大反馈由 CSS 完成，按下进入拖线模式
        this.portInEl.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e._canvasNodeTarget = this;
            e._promptNodePortSide = 'in';
            this.canvas.interaction.onMouseDown(e);
        });

        // 工作流切换：加载工作流 JSON → 探测参数 → 重建动态行
        this.workflowSelect.addEventListener('change', () => {
            this.workflowId = this.workflowSelect.value;
            this.onWorkflowChange();
        });

        // 生成按钮
        this.generateBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.generate();
        });

        // 数量步进器（生成按钮左侧，与面板步进器共用 CountStepper 行为层）
        this.countStepper = new CountStepper(
            { input: this.countInputEl,
              up: this.el.querySelector('.comfy-count-stepper-arrow[data-step="up"]'),
              down: this.el.querySelector('.comfy-count-stepper-arrow[data-step="down"]') },
            { get: () => this.params.getCount(),
              set: (v) => this.params.setCount(v) }
        );

        // 滚轮转发：节点浮在 canvas 上方，wheel 到不了画布层。
        // 悬停在交互控件上时放行原生行为（下拉选项滚动等），其余转发缩放画布
        this.el.addEventListener('wheel', (e) => {
            if (e.target.closest('select, button, input, textarea')) return;
            e.preventDefault();
            this.canvas.interaction.handleWheel(e);
        }, { passive: false });

        // 右键在节点上：不弹画布菜单（与图片一致）
        this.el.addEventListener('contextmenu', (e) => {
            e.stopPropagation();
        });
    }

    /**
     * 按当前工作流刷新数量步进器的显隐与数值（参数行重建/清空后经
     * onRendered 回调触发）：工作流含批次输入才显示
     */
    updateCountStepper() {
        if (!this.countStepperEl || !this.countInputEl) return;
        const show = this.params.hasBatchInput();
        this.countStepperEl.hidden = !show;
        if (show) {
            this.countStepper.sync();
        }
    }

    // ==================== 工作流与参数探测 ====================

    /**
     * 从后端加载工作流列表并填充下拉框（与右侧面板 WorkflowManager 同源接口），
     * 恢复存档时按 workflowId 回选中项
     */
    async loadWorkflows() {
        try {
            const response = await fetch('/api/workflows');
            const data = await response.json();
            this.workflows = data.status === 'ok' ? data.workflows : [];

            if (this.workflows.length === 0) {
                this.workflowSelect.innerHTML = '<option value="">暂无工作流</option>';
                return;
            }

            this.workflowSelect.innerHTML =
                '<option value="">-- 选择工作流 --</option>' +
                this.workflows.map((wf) =>
                    `<option value="${LumenLight.escapeHtml(wf.id)}">${LumenLight.escapeHtml(wf.name)}</option>`
                ).join('');

            // 恢复之前/存档中的选择（工作流可能已被删除，找不到则停留默认项）
            if (this.workflowId && this.workflows.some((wf) => wf.id === this.workflowId)) {
                this.workflowSelect.value = this.workflowId;
                this.onWorkflowChange();
            } else if (this.workflowId) {
                this.workflowId = '';
                this.params.clear();
            }
        } catch (error) {
            console.error('Comfy 生图节点加载工作流列表失败:', error);
            this.workflowSelect.innerHTML = '<option value="">加载失败</option>';
        }
    }

    /**
     * 从后端读取 ComfyUI 模型文件清单（object_info 代理），委托参数行
     * 控制器缓存并刷新已渲染的模型下拉（清单可能晚于工作流加载完成）
     */
    async loadModelLists() {
        await this.params.loadModelLists();
    }

    /**
     * 选中工作流发生变化：拉取工作流 JSON 并重建动态参数行
     */
    async onWorkflowChange() {
        this.workflowJson = null;
        this.params.showStatus('读取工作流中…');

        if (!this.workflowId) {
            this.params.clear();
            return;
        }

        try {
            const response = await fetch(`/api/workflows/${encodeURIComponent(this.workflowId)}`);
            const data = await response.json();
            if (data.status !== 'ok' || !data.workflow) {
                throw new Error(data.message || '工作流不存在');
            }
            this.workflowJson = data.workflow;
            this.params.setWorkflow(this.workflowJson);
        } catch (error) {
            console.error('Comfy 生图节点加载工作流失败:', error);
            this.params.showStatus(`工作流读取失败：${error.message}`);
        }
    }

    // ==================== 提示词/参考图收集（与 ImageGenNode 同机制） ====================

    /**
     * 沿整条上游提示词链收集文本并合并（详见 ImagePipeline.collectPrompt）
     * @returns {string} 拼接后的提示词（无可用提示词时返回空串）
     */
    collectPrompt() {
        return this._pipeline().collectPrompt(this.id);
    }

    /**
     * 收集整条链路的参考图（详见 ImagePipeline.collectImages）
     * @returns {Promise<string[]>} base64 data URL 数组
     */
    collectImages() {
        return this._pipeline().collectImages(this.id);
    }

    /**
     * 收集槽位载荷（详见 ImagePipeline.collectImageEntries）：每张图
     * { image, mask } 按位对齐——mask 是黑白遮罩 PNG（白=重绘区），
     * 无遮罩为 null。提交端据此写/清遮罩槽位
     * @returns {Promise<Array<{image: string|null, mask: string|null}>>}
     */
    collectSlotPayloads() {
        return this._pipeline().collectImageEntries(this.id);
    }

    /**
     * 收集连线进链路的画布视频引用（详见 ImagePipeline.collectVideos）。
     * 提交时随请求发给后端写 canvas-video 槽位——与"图片连线写图片槽"
     * 同一机制：视频对象连进本节点或上游提示词节点即被收集，
     * 按连线顺序按位对齐视频槽位（工作流含
     * LumenReceiveVideoFromCanvas 时后端才写入）
     * @returns {string[]} videoUrl 数组（指向 data/videos/ 文件的引用）
     */
    collectVideos() {
        return this._pipeline().collectVideos(this.id);
    }

    /**
     * 收集链路上游 LoRA 节点的堆栈（详见 ImagePipeline.collectLoras）
     * @returns {Array<{file: string, strengthModel: number, strengthClip: number}>}
     */
    collectLoras() {
        return this._pipeline().collectLoras(this.id);
    }

    /**
     * 构建管线实例（每次收集时新建，保证使用最新连线/画布数据）
     * @returns {ImagePipeline}
     */
    _pipeline() {
        return new ImagePipeline(
            this.canvas.connections.connections,
            this.canvas.images.images
        );
    }

    // ==================== 生成流程 ====================

    /**
     * 执行生成：收集提示词 → 创建占位图 → 循环入队 N 个独立任务 →
     * 等待 WebSocket 逐张回传落图。
     * 数量 N = N 次 batch_size=1 的提交（跑完一张回传一张，单张失败只
     * 影响自己），每次提交后端注入新随机种子；负面提示词固定取右侧
     * Comfy 提示词面板的负面框（与面板流程共用一份数据）
     */
    async generate() {
        if (this.isGenerating) return;

        const positive = this.collectPrompt();
        if (!positive) {
            window.socket?.showNotification?.('请先从左侧端口连接提示词节点');
            return;
        }
        if (!this.workflowId) {
            window.socket?.showNotification?.('请先选择 ComfyUI 工作流');
            return;
        }
        const negative = window.promptPanel?.promptInputManager?.getPrompts()?.negative || '';

        // 连线的画布图片随请求上传到后端槽位（Edit 工作流经
        // LumenReceiveImageFromCanvas 拉取；纯文生图工作流由后端跳过）。
        // masks 与 images 按位对齐：带遮罩的图为黑白遮罩 PNG（白=重绘区），
        // 后端写入遮罩槽位供 From Canvas 的 mask 输出读取
        const payloads = await this.collectSlotPayloads();
        const images = payloads.map((p) => p.image);
        const masks = payloads.map((p) => p.mask);

        // 连线的画布视频引用随请求发后端写视频槽位（V2V 工作流经
        // LumenReceiveVideoFromCanvas 拉取；纯图片工作流由后端跳过）。
        // 引用式：只传 videoUrl 不搬字节，视频本体经槽位 /file 端点流式取回
        const videos = this.collectVideos();

        // 免节点 LoadImage 直注：工作流没有画布取图节点时，连线图按
        // 「节点 id 升序」映射进原生 LoadImage（连线图 1 → 第 1 个，
        // 少连的节点保持 ComfyUI 侧已选图不碰）；有取图节点走槽位
        // 链路，不组映射（一个工作流一条输入通道）
        let imageMapping = null;
        if (images.length > 0 && this.workflowJson) {
            const scan = window.ComfyParamScanner?.scanLoadImageInputs?.(this.workflowJson);
            if (scan && !scan.hasReceiveNode && scan.loadImageIds.length > 0) {
                imageMapping = {};
                const pairs = Math.min(scan.loadImageIds.length, images.length);
                for (let i = 0; i < pairs; i++) {
                    imageMapping[scan.loadImageIds[i]] = i;
                }
            }
        }

        // 链路上游 LoRA 节点堆栈（提交时由后端 injectLoraChain 图拼接注入，
        // 追加在模板内嵌 lora 之后——模板 lora 由本节点的 LoRA 行管理）
        const loras = this.collectLoras();

        // 生成参数记录（溯源/生成同款）：随占位图绑定到回图（imageObj.genInfo，
        // GenInfoPopup 展示与回填）——存面板可读摘要（null = 工作流模板值），
        // 主模型取第一个 checkpoint/unet 加载器当前值
        const checkpointLoader = (this.params.detected?.loaders || [])
            .find((l) => l.kind === 'checkpoint' || l.kind === 'unet');
        this._activeGenInfo = window.GenRecord ? GenRecord.forComfy({
            positive,
            negative,
            workflowId: this.workflowId,
            workflowName: this.workflowSelect?.selectedOptions?.[0]?.text || '',
            params: {
                steps: this.params.state.steps,
                cfg: this.params.state.cfg,
                sampler: this.params.state.sampler,
                sizeW: this.params.state.sizeW,
                sizeH: this.params.state.sizeH,
                denoise: this.params.state.denoise
            },
            model: checkpointLoader
                ? (this.params.state.models[checkpointLoader.nodeId] || checkpointLoader.current || '')
                : '',
            loras,
            node: this
        }) : null;

        const hasBatch = this.params.hasBatchInput();
        const count = hasBatch ? this.params.state.count : 1;

        // 大数量确认：N 张 = N 个队列任务，提交前让用户知情
        if (count > 100 &&
            !window.confirm(`即将向 ComfyUI 队列提交 ${count} 个生成任务，确定继续吗？`)) {
            return;
        }

        // 锁定按钮，进入生成态；停止控件点亮 X（一轮一个 controller，
        // 与 ImageGenNode 同一机制）。占位图按数量沿对角线级联创建。
        // 尺寸跟随本次生图尺寸（与 LLM 生图节点行为一致）：用户设置过用
        // 设置值，未设置但工作流有尺寸节点时用工作流当前值——两者就是
        // 实际会注入工作流的尺寸；编辑类工作流尺寸跟随输入图无法预知，
        // 回退 1024（真实图落图按占位图中心对齐，尺寸偏差不影响位置）
        this.isGenerating = true;
        this._pending = { expected: count, received: 0 };
        this._submittedPromptIds = [];
        this._submitting = true;
        this.generateBtn.disabled = true;
        this.generateBtn.textContent = count > 1 ? `生成中 0/${count}` : '生成中';
        this.stopControl.begin();

        // 任务中心登记：一轮 N 张为一个任务，进度在 WS 回图处推进。
        // 停止与节点 X 同一内核，定位聚焦本节点
        this._taskRef = window.taskRegistry?.register({
            kind: 'comfy',
            label: positive || 'Comfy 生成',
            total: count,
            onStop: () => this.stopControl.abort(),
            locateTarget: this
        });

        let res = null;
        if (this.params.state.sizeW !== null && this.params.state.sizeH !== null) {
            res = { width: this.params.state.sizeW, height: this.params.state.sizeH };
        } else if (this.params.detected && this.params.detected.sizeTargets.length > 0) {
            res = {
                width: this.params.detected.sizeTargets[0].width,
                height: this.params.detected.sizeTargets[0].height
            };
        }

        this.removePlaceholder();
        for (let i = 0; i < count; i++) {
            this.createPlaceholder(res, i);
        }

        // 看门狗为"无进展超时"：每收到一张图就重新计时（大批次整批
        // 耗时远超固定时长也能正常工作）；长时间无新图才兜底复位
        this._armWatchdog();

        // 循环入队：每次提交 batch_size=1，ComfyUI 队列按序执行，
        // 跑完一张回传一张；某张提交失败即中止剩余，已入队的不受影响。
        // X 停止不在 fetch 上挂 signal——提交请求本身几十毫秒就返回，
        // 真正耗时的是队列执行；改为每张提交前检查 aborted，点 X 后停在
        // 下一张提交前，已入队的由 _stopComfyTasks 统一取消
        let submitted = 0;
        try {
            for (let i = 0; i < count; i++) {
                if (this.stopControl.aborted) break;
                this.generateBtn.textContent =
                    count > 1 ? `生成中 ${this._pending.received}/${count}` : '生成中';
                const response = await fetch('/api/comfy-node/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        workflowId: this.workflowId,
                        positive,
                        negative,
                        overrides: this.params.getOverrides(1),
                        loras,
                        target: this.id,
                        images,
                        masks,
                        videos,
                        ...(imageMapping ? { imageMapping } : {})
                    })
                });
                const result = await response.json();
                if (!response.ok || result.status !== 'ok') {
                    throw new Error(result.message || '未知错误');
                }
                submitted++;
                // 免节点双通道的如实上报：图片没有生效（无 LoadImage 可注入/
                // 多个无法定位/上传失败/映射条目被跳过）只在第一张提交时
                // 提示一次，不逐张刷屏
                if (i === 0 && result.imageInject &&
                    (result.imageInject.mode === 'none' || result.imageInject.mode === 'ambiguous')) {
                    window.socket?.showNotification?.(`⚠️ ${result.imageInject.detail}`, 10000);
                }
                if (i === 0 && result.imageInject && result.imageInject.mode === 'mapped' &&
                    ((Array.isArray(result.imageInject.skipped) && result.imageInject.skipped.length > 0) ||
                     (Array.isArray(result.imageInject.placeholders) && result.imageInject.placeholders.length > 0))) {
                    window.socket?.showNotification?.(`⚠️ ${result.imageInject.detail}`, 10000);
                }
                if (result.promptId) {
                    this._submittedPromptIds.push(result.promptId);
                }
            }
        } catch (error) {
            this._submitting = false;
            console.error('Comfy 生图节点提交失败:', error);
            // 一张都没提交出去：任务中心按失败驻留（有部分入队则走
            // 正常收尾路径，按完成/预期附注结算）
            if (submitted === 0) {
                this._taskRef?.end('failed', `提交失败：${error.message}`);
                this._taskRef = null;
            }
            const remaining = count - submitted;
            window.socket?.showNotification?.(
                `第 ${submitted + 1} 张提交失败：${error.message}` +
                (remaining > 0 ? `，已中止剩余 ${remaining} 张` : ''), 8000);

            // 已入队的任务继续跑：期望数量缩减为已提交数，
            // 多出的占位图（不会收到图）按 FIFO 末尾移除
            this._pending.expected = submitted;
            const handles = window.placeholderManager.getByOwner(this);
            const keep = Math.max(0, submitted - this._pending.received);
            for (let i = handles.length - 1; i >= keep; i--) {
                this.removePlaceholder(handles[i]);
            }
            if (this._pending.received >= this._pending.expected) {
                this._finishGeneration();
                return;
            }
        }
        this._submitting = false;

        // 提交循环中点了 X（含最后一张提交期间）：取消已入队任务并立即收尾，
        // 不再等待 WS 回图（失败收尾路径已在 catch 里 return，不会走到这里）
        if (this.stopControl.aborted && this.isGenerating && this._pending) {
            this._stopComfyTasks();
        }
    }

    /**
     * X 停止按钮回调（GenStopControl onAbort）：提交循环进行中时，循环内
     * 的 aborted 检查会在下一张提交前拦停并统一走到 _stopComfyTasks；
     * 这里只处理「提交已全部完成、正在等 WebSocket 回图」的窗口——
     * 该窗口内没有任何 fetch 可中断，必须主动取消 ComfyUI 侧任务
     */
    _onStopClicked() {
        if (this.isGenerating && !this._submitting && this._pending) {
            this._stopComfyTasks();
        }
    }

    /**
     * 停止本轮生成：通知后端按 promptId 中断/删除已入队的 ComfyUI 任务
     * （fire-and-forget，失败不阻断收尾），不再等待 WS 回图，清掉未落图
     * 的占位图并立即复位。刚完成落图的照常保留
     */
    _stopComfyTasks() {
        fetch('/api/comfy-node/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ promptIds: this._submittedPromptIds })
        }).catch(() => {});

        const received = this._pending ? this._pending.received : 0;
        window.socket?.showNotification?.(
            received > 0 ? `已停止生成（已完成 ${received} 张）` : '⛔ 已停止生成', 8000);
        this.removePlaceholder();
        this._finishGeneration();
    }

    /**
     * 武装看门狗（无进展超时）：每次收到新图或重新提交时调用以重置计时，
     * ComfyUI 长时间无任何新图（宕机/队列卡死）时兜底复位按钮并清掉
     * 残留占位图；迟到图片不接收（视为失败）
     */
    _armWatchdog() {
        if (this._watchdog) {
            clearTimeout(this._watchdog);
        }
        this._watchdog = setTimeout(() => {
            if (!this.isGenerating) return;
            window.socket?.showNotification?.('ComfyUI 长时间未响应，已停止等待', 8000);
            this._taskRef?.end('failed', 'ComfyUI 长时间未响应');
            this._taskRef = null;
            this.removePlaceholder();
            this._finishGeneration();
        }, ComfyGenNode.WATCHDOG_TIMEOUT);
    }

    /**
     * 结束本轮生成：复位按钮与计数状态（占位图清理由落图/失败路径自行处理）
     */
    _finishGeneration() {
        // 任务中心结算：停止=中性（已完成部分附注），正常=完成
        if (this._taskRef) {
            const p = this._pending;
            if (this.stopControl.aborted) {
                this._taskRef.end('stopped',
                    p && p.received > 0 ? `已完成 ${p.received}/${p.expected}` : '已停止');
            } else {
                this._taskRef.end('done', p && p.expected > 1 ? `完成 ${p.received}/${p.expected}` : '');
            }
            this._taskRef = null;
        }
        if (this._watchdog) {
            clearTimeout(this._watchdog);
            this._watchdog = null;
        }
        this.isGenerating = false;
        this._pending = null;
        this._activeGenInfo = null;
        this.stopControl.end();
        this.generateBtn.disabled = false;
        this.generateBtn.textContent = '生成';
    }

    /**
     * 接收生成结果（由 LumenSocket 按 target 路由调用，一张图调用一次）。
     * 占位图先进先出逐张替换；占位图不足（部分批次失败等）时直接落到节点右侧
     * @param {string} base64 - PNG 裸 base64 数据（不含 data URL 前缀）
     * @param {Object} [promptMeta] - { positive, negative } 生成时使用的提示词
     */
    receiveGeneratedImage(base64, promptMeta = {}) {
        if (!this._pending) return;   // 非生成态的迟到消息，忽略

        this._armWatchdog();          // 收到新图 = 有进展，重置无进展看门狗

        const prompt = promptMeta?.positive || '';
        const negativePrompt = promptMeta?.negative || '';
        // 本节点名下占位图按创建序先进先出（全局管理器按归属过滤）
        const handle = window.placeholderManager.getByOwner(this)[0];

        if (handle) {
            this.replacePlaceholder(handle, base64, prompt, negativePrompt);
        } else {
            // 占位图已被清空（如存档恢复打断生成）：图片仍要落到画布，
            // 放在节点右侧避免与现有内容重叠
            this._appendImageRightOfNode(base64, prompt, negativePrompt);
        }

        this._pending.received++;
        this._taskRef?.update({ done: this._pending.received });
        this.generateBtn.textContent =
            `生成中 ${this._pending.received}/${this._pending.expected}`;

        if (this._pending.received >= this._pending.expected) {
            window.socket?.showNotification?.(
                this._pending.expected > 1
                    ? `生成完成，共 ${this._pending.expected} 张` : '生成完成', 8000);
            this._finishGeneration();
        }
    }

    /**
     * 接收生成的视频（V2V 工作流经 LumenSendVideoToCanvas 回流，带
     * lumen_target 定向到本节点）。行为对齐 RunningHubGenNode 同名方法：
     * 移除一个本节点占位图、视频落占位图中心；计数达预期即完成收尾
     * （与 receiveGeneratedImage 共用 _pending 计数——图视频混合回流的
     * 工作流两者都能推进进度）
     * @param {string} videoUrl - 视频 URL（data/videos/xxx.mp4）
     * @param {Object} [promptMeta] - 提示词元数据（预留，与图片回流同形）
     */
    receiveGeneratedVideo(videoUrl, promptMeta = {}) {
        if (!this._pending) return;   // 非生成态的迟到消息，忽略

        this._armWatchdog();          // 收到新视频 = 有进展，重置无进展看门狗

        const videoManager = window.canvas?.videoManager;
        if (!videoManager) {
            console.error('画布视频管理器未初始化，无法落 Comfy 视频');
            window.socket?.showNotification?.('视频管理器未初始化，无法落视频', 4000);
            return;
        }

        // 本节点名下占位图先进先出消费一个，视频落其中心（无占位图时
        // 由视频管理器自适应落位）
        const handle = window.placeholderManager.getByOwner(this)[0];
        let center;
        if (handle) {
            const ph = handle.imageObj;
            center = { centerX: ph.x + ph.width / 2, centerY: ph.y + ph.height / 2 };
            window.placeholderManager.remove(handle);
        }

        videoManager.addVideo('/' + String(videoUrl).replace(/^\//, ''), {
            name: String(videoUrl).split('/').pop(),
            ...(center || {})
        }).then(() => {
            window.socket?.showNotification?.('视频已生成', 8000);
        }).catch((err) => {
            console.error('Comfy 视频落画布失败:', err);
            window.socket?.showNotification?.('视频落画布失败', 4000);
        });

        // 进度推进与完成判定（与图片回流同一套计数）
        this._pending.received++;
        this._taskRef?.update({ done: this._pending.received });
        this.generateBtn.textContent =
            `生成中 ${this._pending.received}/${this._pending.expected}`;
        if (this._pending.received >= this._pending.expected) {
            window.socket?.showNotification?.(
                this._pending.expected > 1
                    ? `生成完成，共 ${this._pending.expected} 个` : '生成完成', 8000);
            this._finishGeneration();
        }
    }

    /**
     * 在节点右侧创建生成占位图（创建/动画统一交给全局占位图管理器）
     * 占位图归属标记为本节点，WebSocket 回流的图片按归属队列先进先出替换
     * @param {{width: number, height: number}|null} res - 生成尺寸
     *   （无法预知时为 null，回退 1024）
     * @param {number} [index] - 多张生成时的序号（沿对角线级联偏移，避免相互遮挡）
     * @returns {Object} 占位图句柄
     */
    createPlaceholder(res, index = 0) {
        const width = res ? res.width : 1024;
        const height = res ? res.height : 1024;

        // 位置：节点右侧留出间距，垂直居中；多张生成时沿对角线级联
        const cascade = index * ComfyGenNode.PLACEHOLDER_CASCADE;
        const x = this.x + this.width + ComfyGenNode.PLACEHOLDER_GAP + cascade;
        const y = this.y + this.height / 2 - height / 2 + cascade;

        return window.placeholderManager.create(this, { x, y, width, height });
    }

    /**
     * 移除占位图（生成失败 / 节点销毁时调用），委托全局占位图管理器
     * @param {Object} [target] - 要移除的占位图句柄；缺省时移除本节点全部占位图
     */
    removePlaceholder(target) {
        if (target) {
            window.placeholderManager.remove(target);
        } else {
            window.placeholderManager.removeAll(this);
        }
    }

    /**
     * 用真实生成图片替换占位图：委托全局管理器按占位图中心、原始尺寸落图
     * @param {Object} placeholder - 占位图句柄
     * @param {string} base64 - PNG 裸 base64 数据（不含 data URL 前缀）
     * @param {string} prompt - 生成时使用的提示词
     * @param {string} negativePrompt - 生成时使用的负面提示词
     * @returns {Promise<Object>} 落图后的真实图片对象
     */
    replacePlaceholder(placeholder, base64, prompt, negativePrompt) {
        return window.placeholderManager.replace(
            placeholder,
            'data:image/png;base64,' + base64,
            {
                name: `comfy_gen_${Date.now()}.png`,
                source: 'comfy',
                prompt: prompt,
                negativePrompt: negativePrompt,
                genInfo: this._activeGenInfo || null
            }
        ).catch((err) => {
            console.error('Comfy 生图节点落图失败:', err);
        });
    }

    /**
     * 无占位图可替换时的兜底落图：放在节点右侧空白处（垂直居中）
     * @param {string} base64 - PNG 裸 base64 数据
     * @param {string} prompt - 生成时使用的提示词
     * @param {string} negativePrompt - 生成时使用的负面提示词
     */
    _appendImageRightOfNode(base64, prompt, negativePrompt) {
        const img = new Image();
        img.onload = () => {
            img.onload = null;
            this.canvas.images.images.push({
                id: LumenLight.generateId(),
                name: `comfy_gen_${Date.now()}.png`,
                img: img,
                x: this.x + this.width + ComfyGenNode.PLACEHOLDER_GAP,
                y: this.y + this.height / 2 - img.height / 2,
                width: img.width,
                height: img.height,
                selected: false,
                source: 'comfy',
                prompt: prompt,
                negativePrompt: negativePrompt,
                ...(this._activeGenInfo ? { genInfo: this._activeGenInfo } : {}),
                created: Date.now()
            });
            this.canvas.draw();
        };
        img.src = 'data:image/png;base64,' + base64;
    }

    // ==================== 生命周期 ====================
    // 几何（ns/updateTransform/getPortPoint/setGeometry/contains 等）与
    // 选中同步由基类 BaseCanvasNode 提供（LAYOUT_MODE='design' 布局模式）

    /**
     * 从 DOM 移除节点（删除时调用）。
     * 先清理生成占位图与看门狗，再由基类移除节点 DOM 元素
     */
    destroy() {
        this.removePlaceholder();
        if (this._watchdog) {
            clearTimeout(this._watchdog);
            this._watchdog = null;
        }
        this.stopControl.destroy();
        super.destroy();
    }

    /**
     * 序列化为存档数据（含全部工具栏选择状态）
     */
    toJSON() {
        return {
            id: this.id,
            type: NodeTypes.SOURCE.COMFY_GEN_NODE,
            x: this.x,
            y: this.y,
            width: this.width,
            height: this.height,
            workflowId: this.workflowId,
            ...this.params.getState(),
            ...(this.title ? { title: this.title } : {})
        };
    }
}

// ==================== 类常量 ====================
// DEFAULT_* 为节点默认尺寸；DESIGN_BASE / MIN_* / RESIZE_HANDLE_SIZE /
// 端口几何常量已上收到基类 BaseCanvasNode；本类覆写 LAYOUT_MODE 为 design 布局
ComfyGenNode.LAYOUT_MODE = 'design';  // 固定设计基准布局 + 整体缩放（见 BaseCanvasNode 类头）
ComfyGenNode.DEFAULT_WIDTH = 2048;    // 默认宽度（px，与提示词节点同量级）
ComfyGenNode.DEFAULT_HEIGHT = 2600;   // 默认高度（行数比 LLM 生图节点多，留足纵向空间）
ComfyGenNode.DEFAULT_TITLE = 'Comfy Generate'; // 默认标题（双击标题可自定义）
ComfyGenNode.PLACEHOLDER_GAP = 300;   // 占位图与节点右缘的间距（px）
ComfyGenNode.PLACEHOLDER_CASCADE = 160; // 多张占位图的对角线级联间距（px）
// LOADER_TYPES 与参数扫描/覆盖表编译已迁至 js/utils/ComfyParamScanner.js，
// 数量上限常量在 ComfyParamRows（maxCount，默认 8）

// ComfyUI 无响应看门狗超时（毫秒）
ComfyGenNode.WATCHDOG_TIMEOUT = 10 * 60 * 1000;

// 将 ComfyGenNode 类暴露到全局作用域
window.ComfyGenNode = ComfyGenNode;
