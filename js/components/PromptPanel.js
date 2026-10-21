/**
 * ==========================================================================
 * LumenLight 提示词面板主组件
 * 作用：管理界面右上角可拖拽调整大小的提示词面板，负责协调以下子模块：
 *       1. PromptInputManager：正向 / 负向提示词输入、负面提示词折叠
 *       2. WorkflowManager：工作流选择、加载、保存、删除
 *       3. PanelThumbnailManager：图片缩略图槽位（按工作流取图节点数自动
 *          扩展，上限 9）与上传
 *       4. PanelComfyRunner："发送到 ComfyUI"运行流程与按钮反馈
 *       5. ComfyParamRows：Comfy 动态参数行（与画布 Comfy 生图节点共用）
 *       本类保留职责：
 *       - 面板的展开 / 收起控制
 *       - Comfy / LLM 模式切换
 *       - 面板左侧边框拖拽调整宽度
 *       - ComfyUI 连接状态检测
 *
 * 注意：window.promptPanel.promptInputManager 被画布 Comfy 生图节点读取
 * （负面提示词来源），子模块拆分时此公开字段保持不变。
 * 该组件通过后端 API（localhost:8080）与工作流服务、ComfyUI 服务进行通信。
 * ==========================================================================
 */

class PromptPanel {
    /**
     * 构造函数
     * 初始化所有 DOM 引用、子管理器，并调用 init() 启动组件
     */
    constructor() {
        // ===== DOM 元素引用 =====
        // 打开面板的按钮
        this.toggleBtn = document.getElementById('promptBtn');
        // 面板根节点
        this.panel = document.getElementById('promptPanel');
        // 关闭面板的按钮
        this.closeBtn = document.getElementById('closePrompt');
        // Comfy / LLM 模式切换下拉框
        this.modeSelect = document.getElementById('promptMode');
        // Comfy 模式内容区
        this.comfyContent = document.getElementById('comfyContent');
        // LLM 模式内容区
        this.llmContent = document.getElementById('llmContent');
        // ComfyUI 状态显示元素
        this.comfyStatusEl = document.getElementById('comfyStatus');

        // ===== 子管理器 =====
        // 提示词输入管理器
        this.promptInputManager = new PromptInputManager();
        // 全局别名：桥接命令（BridgeState/BridgeView）与生成同款回放
        // （GenReplay）按惯例读 window.promptInputManager——与
        // window.promptPanel.promptInputManager 同一实例的两条路径
        window.promptInputManager = this.promptInputManager;
        // Comfy 动态参数行（与画布 Comfy 生图节点共用 ComfyParamRows；
        // 切换工作流即重置为模板默认值，参数不持久化）。
        // 数量下拉不在参数行内渲染（countRow=false），由运行按钮旁的
        // 步进器接管，上限四位数（面板独有，画布节点仍为 1-8 下拉）。
        // loraStack=true：在主模型行下方渲染可折叠的 LoRA 叠加区（面板独有，
        // 画布侧的 LoRA 堆栈走独立的 LoRA 节点），堆栈跨工作流保留
        this.comfyParams = new ComfyParamRows(
            document.getElementById('comfyParams'),
            { resetOnWorkflowChange: true, countRow: false, maxCount: 9999, loraStack: true }
        );
        // 工作流管理器，工作流切换时更新当前工作流引用并刷新参数行，
        // 同时让内容槽位（图片/视频混合）跟随工作流的内容节点清单
        // （空清单 = 隐藏缩略图区）
        this.workflowManager = new WorkflowManager((workflow) => {
            this.currentWorkflow = workflow;
            // 传工作流 id（上下文标识）；重新加载工作流会清空内嵌 lora
            // 删除记录——内嵌 lora 自动恢复
            this.comfyParams.setWorkflow(
                workflow ? workflow.workflow : null,
                this.workflowManager.getCurrentWorkflowId());
            this.thumbnailManager?.setSlots(
                this.collectContentSlots(workflow ? workflow.workflow : null));
            this.updateCountStepper();
        });
        // 当前工作流引用（由 WorkflowManager 回调同步）
        this.currentWorkflow = this.workflowManager.getCurrentWorkflow();
        // 图片缩略图管理器（槽位选择/清除/上传，见 PanelThumbnailManager）。
        // 初始 0 槽：未选工作流时缩略图区隐藏，选中后槽位数跟随工作流
        this.thumbnailManager = new PanelThumbnailManager();
        // ComfyUI 运行器（发送按钮的运行流程与按钮反馈，见 PanelComfyRunner）
        this.comfyRunner = new PanelComfyRunner({
            getPrompts: () => this.promptInputManager.getPrompts(),
            getWorkflowId: () => this.workflowManager.getCurrentWorkflowId(),
            getOverrides: (batchCount) => this.comfyParams.getOverrides(batchCount),
            getLoras: () => this.comfyParams.getLoras(),
            getDeletedLoraIds: () => this.comfyParams.getDeletedLoraIds(),
            getBatchCount: () =>
                this.comfyParams.hasBatchInput() ? this.comfyParams.getCount() : 1,
            updateWorkflowStatus: (message, isError) =>
                this.workflowManager.updateWorkflowStatus(message, isError),
            uploadThumbnails: () => this.thumbnailManager.sendThumbnailsToBackend(),
            // 免节点 LoadImage 直注载荷（无取图节点的工作流）：非 null 时
            // 跳过槽位上传，图片随提交体直注（见 PanelComfyRunner）
            getNodelessImages: () => this.collectNodelessImagePayload(),
            // 生成参数记录（溯源/生成同款）：本轮提交的提示词/工作流/参数
            // 快照（GenRecord），随占位图绑定到回图——params 取面板参数行
            // 状态（null = 工作流模板值），主模型取第一个 checkpoint/unet 加载器
            getGenInfo: () => {
                const prompts = this.promptInputManager.getPrompts();
                const st = this.comfyParams.state;
                const loader = (this.comfyParams.detected?.loaders || [])
                    .find((l) => l.kind === 'checkpoint' || l.kind === 'unet');
                return GenRecord.forComfy({
                    positive: prompts.positive,
                    negative: prompts.negative,
                    workflowId: this.workflowManager.getCurrentWorkflowId(),
                    workflowName: this.currentWorkflow?.name || '',
                    params: {
                        steps: st.steps,
                        cfg: st.cfg,
                        sampler: st.sampler,
                        sizeW: st.sizeW,
                        sizeH: st.sizeH,
                        denoise: st.denoise
                    },
                    model: loader
                        ? (st.models[loader.nodeId] || loader.current || '')
                        : '',
                    loras: this.comfyParams.getLoras(),
                    node: null
                });
            }
        });
        // LoRA 触发词管理器（叠加区标题栏「触发词」按钮唤出弹窗）：监听
        // 叠加区变更，把生效 LoRA 的 Civitai 触发词按开关/权重配置自动写入
        // 正向框末尾（托管块契约见 utils/LoraTriggerText.js）
        this.triggerManager = new LoraTriggerManager({
            getStackLoras: () => this.comfyParams.getStackTriggerLoras(),
            promptInputManager: this.promptInputManager
        });

        // ===== 拖拽调整宽度状态 =====
        // 是否正在拖拽
        this.isResizing = false;
        // 拖拽开始时鼠标的 X 坐标
        this.startX = 0;
        // 拖拽开始时面板的宽度
        this.startWidth = 0;

        // ===== ComfyUI 状态检测定时器 =====
        // 每 3 秒检测一次连接状态
        this.statusCheckInterval = null;

        // 启动初始化
        this.init();
    }

    /**
     * 初始化方法
     * 绑定所有事件监听器并加载初始数据
     */
    init() {
        // 展开/收起事件监听器
        this.toggleBtn.addEventListener('click', () => this.show());
        this.closeBtn.addEventListener('click', () => this.hide());

        // 模式切换事件监听器
        this.modeSelect.addEventListener('change', (e) => {
            this.switchMode(e.target.value);
            this.syncModeWidth();
        });
        this.syncModeWidth();

        // 发送到 ComfyUI 按钮：绑定给运行器（按钮状态由运行器管理）
        const sendBtn = document.getElementById('sendToComfy');
        if (sendBtn) {
            this.comfyRunner.bindButton(sendBtn);
        }

        // 初始化左边框拖拽调整宽度
        this.initResize();

        // 初始化 ComfyUI 连接状态检测
        this.initComfyStatusCheck();

        // 初始化图片缩略图
        this.thumbnailManager.init();

        // 拉取 ComfyUI 模型清单填充参数行的模型/采样器下拉
        this.comfyParams.loadModelLists();

        // 绑定数量步进器（运行按钮左侧，工作流含批次输入时显示）
        this.initCountStepper();

        // 模式切换幽灵下拉的宽度自适应（按当前选中项文字）
        this.syncModeWidth();

    }

    /**
     * 模式切换幽灵下拉的宽度自适应：按当前选中项的文字实测宽度设置
     * 按钮宽度，让箭头始终贴着文字（原生 select 默认按最宽 option 撑宽，
     * 选 LLM 这类短词时箭头会离得很远）。
     * 测量用隐藏探针 span，字体属性逐项复制自 select 本身。
     */
    syncModeWidth() {
        const sel = this.modeSelect;
        if (!sel || !sel.options.length) return;

        if (!this._modeWidthProbe) {
            const probe = document.createElement('span');
            probe.style.cssText =
                'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;';
            document.body.appendChild(probe);
            this._modeWidthProbe = probe;
        }
        const probe = this._modeWidthProbe;
        const cs = getComputedStyle(sel);
        probe.style.fontFamily = cs.fontFamily;
        probe.style.fontSize = cs.fontSize;
        probe.style.fontWeight = cs.fontWeight;
        probe.style.fontStyle = cs.fontStyle;
        probe.style.letterSpacing = cs.letterSpacing;
        probe.textContent = sel.options[sel.selectedIndex]?.text || '';

        // 文字宽 + 左内边距 12 + 右侧箭头区 26（与 CSS padding 对应）
        sel.style.width = (probe.offsetWidth + 38) + 'px';
    }

    /**
     * 统计工作流 JSON 里的内容槽位（按节点 id 升序），返回槽位定义清单：
     *   - LumenReceiveImageFromCanvas → {kind:'image'}（图片槽，base64 传输）
     *   - LumenReceiveVideoFromCanvas → {kind:'video'}（视频槽，引用式传输）
     *   - 免节点直注：工作流没有取图节点时，原生 LoadImage 升格为
     *     {kind:'image', loadImageId: 节点id} 直注槽（角标显示节点 id，
     *     运行时按「节点 id → 槽位内容」组 imageMapping 直注）；
     *     有取图节点时 LoadImage 不升格（一个工作流一条输入通道）
     * 图片槽上限 9 与 LumenReceiveImageFromCanvas.MAX_SLOTS 对齐（多图
     * 编辑模型按取图节点数自动扩展）；视频槽上限 3 跟随其 Python 节点；
     * LoadImage 直注槽不经过后端槽位、按节点数自动扩展不设上限。
     * 清单传给 PanelThumbnailManager.setSlots 决定槽位数与每槽类型
     * （空数组 = 纯文生图工作流，隐藏缩略图区）
     * @param {Object|null} workflowJson - ComfyUI API 格式工作流
     * @returns {Array<{kind: string, loadImageId?: string}>} 槽位定义清单
     */
    collectContentSlots(workflowJson) {
        if (!workflowJson) return [];
        const scan = window.ComfyParamScanner?.scanLoadImageInputs?.(workflowJson);
        const nodelessIds = scan && !scan.hasReceiveNode ? scan.loadImageIds : [];
        const nodelessSet = new Set(nodelessIds);
        const defs = [];
        let imageCount = 0;
        let videoCount = 0;
        for (const id of Object.keys(workflowJson).sort((a, b) => Number(a) - Number(b))) {
            const cls = workflowJson[id].class_type || workflowJson[id].type || '';
            if (cls === 'LumenReceiveImageFromCanvas') {
                if (imageCount < 9) { defs.push({ kind: 'image' }); imageCount++; }
            } else if (cls === 'LumenReceiveVideoFromCanvas') {
                if (videoCount < 3) { defs.push({ kind: 'video' }); videoCount++; }
            } else if (nodelessSet.has(id)) {
                defs.push({ kind: 'image', loadImageId: id });
            }
        }
        return defs;
    }

    /**
     * 收集免节点 LoadImage 直注载荷（PanelComfyRunner 运行前调用）：
     * 工作流没有画布取图节点时，把带 loadImageId 的直注槽内容按
     * 「节点 id → images 下标」组装映射；空槽不出条目，对应 LoadImage
     * 保持 ComfyUI 侧已选图不碰。有取图节点（或无工作流）返回 null——
     * 走既有槽位上传链路
     * @returns {Promise<{images: string[], imageMapping: Object}|null>}
     */
    async collectNodelessImagePayload() {
        const wf = this.currentWorkflow ? this.currentWorkflow.workflow : null;
        if (!wf) return null;
        const scan = window.ComfyParamScanner?.scanLoadImageInputs?.(wf);
        if (!scan || scan.hasReceiveNode || scan.loadImageIds.length === 0) return null;
        const images = [];
        const imageMapping = {};
        const slots = this.thumbnailManager;
        for (let i = 0; i < slots.slotCount; i++) {
            const loadImageId = slots.slotLoadImageId(i);
            const data = slots.thumbnails[i];
            if (!loadImageId || !data || !data.src) continue;
            // 已是 data URL 原样传（保真扩展名）；画布快照等其它来源经
            // imageToBase64 转裸 base64（后端按 PNG 上传）
            const payload = data.src.startsWith('data:image/')
                ? data.src
                : await slots.imageToBase64(data.src);
            imageMapping[loadImageId] = images.length;
            images.push(payload);
        }
        return { images, imageMapping };
    }

    // ==================== 数量步进器（运行按钮左侧） ====================

    /**
     * 绑定数量步进器：上下箭头步进 / 直接键入（1-9999），
     * 行为层与画布 Comfy 生图节点共用 CountStepper；
     * 值写入 ComfyParamRows 状态，运行时经 overrides 注入 batch_size。
     * 显隐跟随工作流：含批次输入才显示，与原数量行的显隐规则一致
     */
    initCountStepper() {
        this.countStepperEl = document.getElementById('comfyCountStepper');
        this.countInputEl = document.getElementById('comfyCountInput');
        if (!this.countStepperEl || !this.countInputEl) return;

        this.countStepper = new CountStepper(
            { input: this.countInputEl,
              up: document.getElementById('comfyCountUp'),
              down: document.getElementById('comfyCountDown') },
            { get: () => this.comfyParams.getCount(),
              set: (v) => this.comfyParams.setCount(v) }
        );
    }

    /**
     * 按当前工作流刷新数量步进器的显隐与数值（工作流切换时调用）
     */
    updateCountStepper() {
        if (!this.countStepperEl || !this.countInputEl) return;
        const show = this.comfyParams.hasBatchInput();
        this.countStepperEl.hidden = !show;
        if (show) {
            this.countStepper.sync();
        }
    }

    // ==================== UI 控制 ====================

    /**
     * 展开右侧面板
     */
    show() {
        this.panel.classList.add('show');
        // 用专属类而非 .hidden——后者被 lora-manager.css 定义为 display:none
        // !important，会把按钮摘出布局，顶栏中段居中图标随之整体位移
        this.toggleBtn.classList.add('prompt-hidden');
        this.panel.setAttribute('aria-hidden', 'false');
    }

    /**
     * 收起右侧面板
     */
    hide() {
        this.panel.classList.remove('show');
        this.toggleBtn.classList.remove('prompt-hidden');
        this.panel.setAttribute('aria-hidden', 'true');
    }

    /**
     * 切换 Comfy 模式与 LLM 模式
     * @param {string} mode - 'comfy' 或 'llm'
     */
    switchMode(mode) {
        if (mode === 'comfy') {
            this.comfyContent.classList.remove('hidden');
            this.llmContent.classList.add('hidden');
            // ComfyUI 连接状态只在 Comfy 模式下显示
            if (this.comfyStatusEl) this.comfyStatusEl.style.display = '';
        } else {
            this.comfyContent.classList.add('hidden');
            this.llmContent.classList.remove('hidden');
            // LLM 模式与 ComfyUI 无关，隐藏连接状态指示灯
            if (this.comfyStatusEl) this.comfyStatusEl.style.display = 'none';
            // 通知聊天窗口刷新模型列表（设置可能已更新）
            window.dispatchEvent(new CustomEvent('llmModeEnter'));
        }
    }

    // ==================== 拖拽调整宽度 ====================

    /**
     * 初始化面板左侧拖拽调整宽度功能
     * 监听 resize handle 的 mousedown、document 的 mousemove 和 mouseup
     */
    initResize() {
        // 查找或创建拖拽把手
        let resizeHandle = this.panel.querySelector('.prompt-resize-handle');
        if (!resizeHandle) {
            resizeHandle = document.createElement('div');
            resizeHandle.className = 'prompt-resize-handle';
            this.panel.appendChild(resizeHandle);
        }

        // 鼠标按下：开始拖拽
        resizeHandle.addEventListener('mousedown', (e) => {
            this.isResizing = true;
            this.startX = e.clientX;
            this.startWidth = this.panel.offsetWidth;
            resizeHandle.classList.add('dragging');
            document.body.style.cursor = 'ew-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
            e.stopPropagation();
        });

        // 鼠标移动：实时调整面板宽度
        document.addEventListener('mousemove', (e) => {
            if (!this.isResizing) return;

            // 计算水平移动距离
            const deltaX = this.startX - e.clientX;
            let newWidth = this.startWidth + deltaX;

            // 限制宽度在最小和最大值之间
            const minWidth = 450;
            const maxWidth = 700;
            newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));

            this.panel.style.width = newWidth + 'px';
        });

        // 鼠标松开：结束拖拽并恢复样式
        document.addEventListener('mouseup', () => {
            if (this.isResizing) {
                this.isResizing = false;
                resizeHandle.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });
    }

    // ==================== ComfyUI 状态检测 ====================

    /**
     * 初始化 ComfyUI 连接状态检测
     * 立即检测一次，然后每 10 秒检测一次。
     * 连接状态是分钟级变化，10s 粒度对状态灯足够；
     * 3s 的旧值会让后端每天空发近 3 万次探测请求。
     */
    initComfyStatusCheck() {
        this.checkComfyStatus();
        this.statusCheckInterval = setInterval(() => {
            this.checkComfyStatus();
        }, 10000);
    }

    /**
     * 向后端发起请求检测 ComfyUI 连接状态
     */
    async checkComfyStatus() {
        try {
            const response = await fetch('http://localhost:8080/api/comfy-status');
            const data = await response.json();
            this.updateStatusUI(data.status === 'connected');
        } catch (e) {
            this.updateStatusUI(false);
        }
    }

    /**
     * 根据连接状态更新状态指示器 UI
     * @param {boolean} isConnected - 是否已连接
     */
    updateStatusUI(isConnected) {
        if (!this.comfyStatusEl) return;

        const dot = this.comfyStatusEl.querySelector('.status-dot');
        const text = this.comfyStatusEl.querySelector('.status-text');

        if (isConnected) {
            this.comfyStatusEl.classList.add('connected');
            this.comfyStatusEl.classList.remove('disconnected');
            if (text) text.textContent = '已连接';
        } else {
            this.comfyStatusEl.classList.add('disconnected');
            this.comfyStatusEl.classList.remove('connected');
            if (text) text.textContent = '未连接';
        }
    }
}

// 将 PromptPanel 类暴露到全局作用域
window.PromptPanel = PromptPanel;
