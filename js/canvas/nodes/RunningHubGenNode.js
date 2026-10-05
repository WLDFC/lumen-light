/**
 * ==========================================================================
 * LumenLight RunningHub 云端工作流生成节点（RunningHubGenNode）
 * ==========================================================================
 * 作用：画布上调用 RunningHub 平台（云端 ComfyUI 托管）工作流的生成节点，
 *       与本地 Comfy 生图节点（ComfyGenNode）、LLM 生图节点（ImageGenNode）
 *       平行的第三条生成链路。
 *
 * 与本地 ComfyUI 的本质差异：工作流本体在平台云端（本地没有工作流 JSON），
 * 平台只暴露若干可变参数字段。因此本节点不扫描工作流模板，而是按
 * "登记卡"渲染参数行——登记卡在设置 → API 里登记（「从平台拉取」自动
 * 解析参数映射），存于 settings.json 的 runninghub.workflows。
 *
 * 生成链路：
 *   生成按钮 → N × POST /api/runninghub/run 并发提交（参数值 + 连线图片
 *     + target，N 为数量步进器值）→ 后端上传图片/组装 nodeInfoList/提交
 *     平台 → 拿 taskId 轮询 → 成功后下载转存（平台 URL 仅 24h 有效）→
 *     WebSocket 推 new-image / new-video（带 target），每个任务全部结果
 *     推完后推 generation-complete，失败推 generation-failed
 *     → 本节点 receiveGeneratedImage / receiveGeneratedVideo 逐个消费，
 *        onGenerationComplete / onGenerationFailed 按任务计数收尾；
 *        占位图先进先出替换——回流机制与本地 ComfyUI 链路同构。
 *
 * 结构与交互（与 ComfyGenNode 一致，复用全套样式）：
 *   - 标题栏：RunningHub + 「云端工作流」徽标
 *   - 状态栏：仅左端口（in），接收提示词节点链
 *   - 工具栏：工作流下拉（登记列表）+ 动态参数行 + 数量步进器 + 生成按钮
 *   - 数量 N = N 个并发云端任务（平台 API 支持并发，按平台计费）；占位图
 *     按 N 张级联预建，单任务多产出时超出部分兜底落到节点右侧
 * ==========================================================================
 */

class RunningHubGenNode extends BaseCanvasNode {
    /**
     * 构造函数
     * @param {Canvas} canvas - 画布主类实例
     * @param {number} x - 画布坐标 X（左上角）
     * @param {number} y - 画布坐标 Y（左上角）
     * @param {Object} [options] - 恢复存档/粘贴时的初始状态
     * @param {number} [options.width] - 节点宽度
     * @param {number} [options.height] - 节点高度
     * @param {string} [options.workflowId] - 选中的工作流 id（'rh:登记id'）
     * @param {Object} [options.values] - 参数值快照 { [key]: string }（存档恢复/粘贴）
     * @param {number} [options.count] - 生成数量（存档恢复/粘贴）
     */
    constructor(canvas, x, y, options = {}) {
        super(canvas, x, y);
        this.source = NodeTypes.SOURCE.RUNHUB_GEN_NODE;

        this.width = options.width || RunningHubGenNode.DEFAULT_WIDTH;
        this.height = options.height || RunningHubGenNode.DEFAULT_HEIGHT;

        this.workflowId = options.workflowId || '';

        this.workflows = [];       // 登记卡列表缓存（/api/runninghub/workflows）
        this.currentWf = null;     // 当前选中的登记卡（含 params 定义）

        // 生成流程状态：云端任务产出数量不可知，按"任务"计数收尾——每个
        // 任务以 generation-complete / generation-failed 结束（WS 同连接
        // 有序，完成信号必然晚于该任务的全部结果消息），全部任务收尾即结束
        this.isGenerating = false;
        // 生成数量（随节点入存档；范围 1-9999 与步进器一致）
        this.count = Math.max(1, Math.min(9999, parseInt(options.count, 10) || 1));
        this._pending = null;      // { expected, done } 本轮待收尾任务计数
        this._watchdog = null;     // 无进展看门狗

        this.buildDom();
        // 参数行控制器：动态参数区（comfy-dynamic-rows）的渲染与取值；
        // 存档/粘贴带来的参数值快照先回填状态，工作流加载渲染时按 key 回填
        this.params = new RunningHubParamRows(this.dynamicRowsEl);
        this.params.setState(options.values);
        this.bindEvents();
        this.updateTransform();
        this.loadWorkflows();
    }

    /**
     * 构建 DOM 结构：标题栏 + 状态栏（左端口）+ 工作流行 + 动态参数区 + 生成按钮
     * （复用 .text-node / .image-gen-node / .comfy-gen-node 全套样式，扩展 .runhub-gen-node）
     */
    buildDom() {
        this.el = document.createElement('div');
        this.el.className = 'text-node image-gen-node comfy-gen-node runhub-gen-node';
        this.el.dataset.id = this.id;

        this.el.innerHTML = `
            <div class="text-node-header">
                <span class="text-node-title">RunningHub</span>
                <span class="text-node-badge">云端工作流</span>
            </div>
            <div class="text-node-statusbar">
                <div class="text-node-port text-node-port-in" title="输入端口：连接提示词节点"></div>
            </div>
            <div class="image-gen-form">
                <div class="image-gen-row">
                    <div class="image-gen-label">工作流</div>
                    <select class="llm-model-select comfy-workflow-select" title="选择 RunningHub 已登记的云端工作流">
                        <option value="">加载中…</option>
                    </select>
                </div>
                <div class="comfy-dynamic-rows"></div>
                <div class="comfy-generate-row">
                    <!-- 数量步进器：N = N 个并发云端任务（平台按任务计费） -->
                    <div class="comfy-count-stepper"
                         title="生成数量（N = N 个并发云端任务，按平台计费），上下箭头步进或直接键入">
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
                            title="收集连入的提示词并提交到 RunningHub 云端生成">生成</button>
                </div>
            </div>
            <div class="text-node-resize" title="拖拽调整大小"></div>
        `;

        this.workflowSelect = this.el.querySelector('.comfy-workflow-select');
        this.dynamicRowsEl = this.el.querySelector('.comfy-dynamic-rows');
        this.generateBtn = this.el.querySelector('.image-gen-generate-btn');
        this.countStepperEl = this.el.querySelector('.comfy-count-stepper');
        this.countInputEl = this.el.querySelector('.comfy-count-stepper-input');
        this.portInEl = this.el.querySelector('.text-node-port-in');

        // 标题双击重命名（基类共用实现，六类节点同一套交互）
        this.initTitleEditor();

        // 挂到画布容器（canvas 元素的父级，即 body），跟随视口变换
        document.body.appendChild(this.el);
    }

    /**
     * 绑定节点内部 DOM 事件（与 ComfyGenNode 同机制：mousedown 透传画布
     * 交互层，控件自身拦截透传走原生行为）
     */
    bindEvents() {
        this.el.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.target.closest('select, button, input, textarea')) {
                e.stopPropagation();
                return;
            }
            e._canvasNodeTarget = this;
            this.canvas.interaction.onMouseDown(e);
        });

        this.portInEl.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e._canvasNodeTarget = this;
            e._promptNodePortSide = 'in';
            this.canvas.interaction.onMouseDown(e);
        });

        // 工作流切换：按登记卡重建参数行
        this.workflowSelect.addEventListener('change', () => {
            this.workflowId = this.workflowSelect.value;
            this.onWorkflowChange();
        });

        this.generateBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.generate();
        });

        // 数量步进器（生成按钮左侧，与 Comfy 生图节点共用 CountStepper
        // 行为层）；RH 任务并发执行，数量即并发任务数
        this.countStepper = new CountStepper(
            { input: this.countInputEl,
              up: this.el.querySelector('.comfy-count-stepper-arrow[data-step="up"]'),
              down: this.el.querySelector('.comfy-count-stepper-arrow[data-step="down"]') },
            { get: () => this.count,
              set: (v) => {
                  this.count = Math.min(9999, Math.max(1, parseInt(v, 10) || 1));
                  return this.count;
              } }
        );
        this.countStepper.sync();   // 存档恢复的数量值同步到输入框显示

        this.el.addEventListener('wheel', (e) => {
            if (e.target.closest('select, button, input, textarea')) return;
            e.preventDefault();
            this.canvas.interaction.handleWheel(e);
        }, { passive: false });

        // 右键在节点上：不弹画布菜单（与图片一致）
        this.el.addEventListener('contextmenu', (e) => {
            e.stopPropagation();
        });

        // 设置保存后自动刷新工作流列表：节点只在构造时拉一次列表，
        // 用户后登记/删除工作流时，画布上已有节点需要同步跟进
        // （SettingsApiPanel.save() 成功后会派发 settingsSaved 事件）
        window.addEventListener('settingsSaved', () => this.loadWorkflows());
    }

    // ==================== 工作流与参数行 ====================

    /**
     * 从后端加载登记的工作流列表并填充下拉框，
     * 恢复存档时按 workflowId 回选中项
     */
    async loadWorkflows() {
        try {
            const response = await fetch('/api/runninghub/workflows');
            const data = await response.json();
            this.workflows = data.status === 'ok' ? data.workflows : [];

            if (this.workflows.length === 0) {
                this.workflowSelect.innerHTML =
                    '<option value="">未登记工作流（设置 → API）</option>';
                this.params.showStatus('请先在 设置 → API → RunningHub 里登记工作流');
                return;
            }

            this.workflowSelect.innerHTML =
                '<option value="">-- 选择工作流 --</option>' +
                this.workflows.map((wf) =>
                    `<option value="${LumenLight.escapeHtml(wf.id)}">${LumenLight.escapeHtml(wf.name)}</option>`
                ).join('');

            // 恢复之前/存档中的选择（登记可能已被删除，找不到则停留默认项）
            if (this.workflowId && this.workflows.some((wf) => wf.id === this.workflowId)) {
                this.workflowSelect.value = this.workflowId;
                this.onWorkflowChange();
            } else if (this.workflowId) {
                this.workflowId = '';
                this.params.clear();
            }
        } catch (error) {
            console.error('RunningHub 节点加载工作流列表失败:', error);
            this.workflowSelect.innerHTML = '<option value="">加载失败</option>';
        }
    }

    /**
     * 选中工作流发生变化：找登记卡并重建动态参数行
     * （RH 无本地工作流 JSON 可拉，直接按登记卡渲染）
     */
    onWorkflowChange() {
        this.currentWf = this.workflows.find((wf) => wf.id === this.workflowId) || null;
        if (!this.currentWf) {
            this.params.clear();
            return;
        }
        this.params.setWorkflow(this.currentWf);
    }

    // ==================== 提示词/参考图收集（与 ComfyGenNode 同机制） ====================

    /**
     * 沿整条上游提示词链收集文本并合并（复用 ImagePipeline）
     * @returns {string} 拼接后的提示词
     */
    collectPrompt() {
        return this._pipeline().collectPrompt(this.id);
    }

    /**
     * 收集整条链路的参考图（复用 ImagePipeline）
     * @returns {Promise<string[]>} base64 data URL 数组
     */
    collectImages() {
        return this._pipeline().collectImages(this.id);
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
     * 执行生成：按登记卡收集参数值与连线图片 → 并发提交 N 个
     * /api/runninghub/run 任务 → 创建 N 张占位图等待 WebSocket 回流。
     * 每个任务产出数量由云端工作流决定（回流几张收几张），任务收尾计数
     * 见 onGenerationComplete / onGenerationFailed。
     *
     * 种子策略：登记卡 seed 字段留空时，平台按工作流缺省种子运行，并发
     * N 个任务会得到 N 份相同结果——因此留空时逐任务注入随机种子；用户
     * 显式填写了种子则尊重原值（N 份相同是显式选择）
     */
    async generate() {
        if (this.isGenerating) return;

        const wf = this.currentWf;
        if (!wf) {
            window.socket?.showNotification?.('请先选择 RunningHub 工作流');
            return;
        }

        const positive = this.collectPrompt();
        const negative = window.promptPanel?.promptInputManager?.getPrompts()?.negative || '';

        // 登记卡含 image 槽位时才收集连线图片（按登记顺序依次填入）
        const paramDefs = Array.isArray(wf.params) ? wf.params : [];
        const needsImages = paramDefs.some((p) => p && p.type === 'image');
        const imageSlots = paramDefs.filter((p) => p && p.type === 'image').length;
        const images = needsImages ? await this.collectImages() : [];
        if (needsImages && images.length < imageSlots) {
            window.socket?.showNotification?.(
                `该工作流需要 ${imageSlots} 张连线图片，当前只有 ${images.length} 张`, 8000);
            return;
        }

        const count = Math.max(1, Math.min(9999, parseInt(this.count, 10) || 1));
        // 大数量确认：N 个并发云端任务按平台计费，提交前让用户知情
        if (count > 100 &&
            !window.confirm(`即将向 RunningHub 并发提交 ${count} 个云端任务（按平台计费），确定继续吗？`)) {
            return;
        }

        // 锁定按钮，进入生成态；占位图按数量沿对角线级联创建（产出尺寸
        // 云端未知，占位回退 1024；真实结果按原始尺寸落在占位图中心）
        this.isGenerating = true;
        this._pending = { expected: count, done: 0 };
        this.generateBtn.disabled = true;
        this.generateBtn.textContent = count > 1 ? `生成中 0/${count}` : '生成中';

        this.removePlaceholder();
        for (let i = 0; i < count; i++) {
            this.createPlaceholder(null, i);
        }
        this._armWatchdog();

        // 留空的种子字段逐任务随机化（见方法注释），其余参数值各任务相同
        const seedKeys = paramDefs
            .filter((p) => p && p.type !== 'image' && /^(noise_)?seed$/i.test(p.fieldName))
            .map((p) => `${p.nodeId}:${p.fieldName}`);
        const baseValues = this.params.getValues();

        // 并发提交：平台 API 支持并发，N 个任务同时运行（浏览器同域连接
        // 上限 6，超出部分由浏览器自行排队，提交接口轻量无碍）
        const submissions = Array.from({ length: count }, () => {
            const values = { ...baseValues };
            for (const key of seedKeys) {
                if (!String(values[key] ?? '').trim()) {
                    values[key] = String(Math.floor(Math.random() * 4294967295));
                }
            }
            return fetch('/api/runninghub/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workflowId: this.workflowId,
                    values,
                    images,
                    target: this.id,
                    positive,
                    negative
                })
            }).then(async (response) => {
                const result = await response.json();
                if (!response.ok || result.status !== 'ok') {
                    throw new Error(result.message || '未知错误');
                }
            });
        });

        const results = await Promise.allSettled(submissions);
        const failed = results.filter((r) => r.status === 'rejected');
        for (const f of failed) {
            console.error('RunningHub 任务提交失败:', f.reason);
        }
        const submitted = count - failed.length;
        if (failed.length > 0) {
            window.socket?.showNotification?.(
                `${failed.length} 个任务提交失败：${failed[0].reason?.message || '未知错误'}` +
                (submitted > 0 ? `，其余 ${submitted} 个任务继续运行` : ''), 8000);

            // 期望缩减为成功提交数，多出的占位图（不会收到结果）从队尾移除
            this._pending.expected = submitted;
            const handles = window.placeholderManager.getByOwner(this);
            for (let i = 0; i < count - submitted && handles.length > 0; i++) {
                this.removePlaceholder(handles[handles.length - 1]);
            }
            if (submitted === 0 || this._pending.done >= this._pending.expected) {
                this.removePlaceholder();
                this._finishGeneration();
                return;
            }
        }
    }

    /**
     * 武装看门狗（无进展超时）：生成是"提交即忘"模式，结果靠后端 WS 推送，
     * 看门狗只兜底"后端崩溃/WS 断连导致结果永远不到"的情况。超时与后端
     * 轮询上限（30 分钟）对齐并留出转存余量，避免长任务被前端提前放弃
     */
    _armWatchdog() {
        if (this._watchdog) {
            clearTimeout(this._watchdog);
        }
        this._watchdog = setTimeout(() => {
            if (!this.isGenerating) return;
            window.socket?.showNotification?.('RunningHub 长时间未响应，已停止等待', 8000);
            this.removePlaceholder();
            this._finishGeneration();
        }, RunningHubGenNode.WATCHDOG_TIMEOUT);
    }

    /**
     * 结束本轮生成：复位按钮与状态
     */
    _finishGeneration() {
        if (this._watchdog) {
            clearTimeout(this._watchdog);
            this._watchdog = null;
        }
        this.isGenerating = false;
        this.generateBtn.disabled = false;
        this.generateBtn.textContent = '生成';
    }

    /**
     * 接收生成图片结果（由 LumenSocket 按 target 路由调用，一张图调用一次）。
     * 占位图先进先出逐张替换；占位图不足（多产出）时直接落到节点右侧
     * @param {string} base64 - 裸 base64 图片数据（不含 data URL 前缀）
     * @param {Object} [promptMeta] - { positive, negative } 生成时使用的提示词
     */
    receiveGeneratedImage(base64, promptMeta = {}) {
        if (!this.isGenerating) return;   // 非生成态的迟到消息，忽略

        this._armWatchdog();          // 收到新结果 = 有进展，重置看门狗

        const prompt = promptMeta?.positive || '';
        const negativePrompt = promptMeta?.negative || '';
        // 本节点名下占位图按创建序先进先出（全局管理器按归属过滤）
        const handle = window.placeholderManager.getByOwner(this)[0];

        if (handle) {
            this.replacePlaceholder(handle, base64, prompt, negativePrompt);
        } else {
            this._appendImageRightOfNode(base64, prompt, negativePrompt);
        }
        // 完成不在此判定：产出数量不可知，由后端 generation-complete 统一结束
    }

    /**
     * 接收生成视频结果（由 LumenSocket 的 new-video 定向路由调用）。
     * 视频以占位图中心落画布（首帧封面，双击播放）
     * @param {string} videoUrl - 视频相对路径（data/videos/xxx.mp4）
     * @param {Object} [promptMeta] - { positive, negative } 生成时使用的提示词
     */
    receiveGeneratedVideo(videoUrl, promptMeta = {}) {
        const videoManager = window.canvas?.videoManager;
        if (!videoManager) {
            console.error('画布视频管理器未初始化，无法落 RunningHub 视频');
            window.socket?.showNotification?.('视频管理器未初始化，无法落视频', 4000);
            if (this.isGenerating) this._finishGeneration();
            return;
        }
        if (!this.isGenerating) return;   // 非生成态的迟到消息，忽略

        this._armWatchdog();

        const handle = window.placeholderManager.getByOwner(this)[0];
        let center;
        if (handle) {
            const ph = handle.imageObj;
            center = { centerX: ph.x + ph.width / 2, centerY: ph.y + ph.height / 2 };
            window.placeholderManager.remove(handle);
        }

        videoManager.addVideo('/' + String(videoUrl).replace(/^\//, ''), {
            prompt: promptMeta?.positive || '',
            name: String(videoUrl).split('/').pop(),
            ...(center || {})
        }).then(() => {
            window.socket?.showNotification?.('RunningHub 视频已生成', 8000);
        }).catch((err) => {
            console.error('RunningHub 视频落画布失败:', err);
            window.socket?.showNotification?.('视频落画布失败', 4000);
        });
        // 完成不在此判定：由后端 generation-complete 统一结束
    }

    /**
     * 处理生成完成（由 LumenSocket 的 generation-complete 定向路由调用）：
     * 后端已推完该任务全部结果（WS 同连接有序，必然晚于结果消息）。
     * 按任务计数收尾，全部任务收尾后复位生成态，并防御性清掉未消费尽的
     * 占位图（0 产出任务/个别结果转存失败时的残留）
     */
    onGenerationComplete() {
        if (!this.isGenerating) return;
        this._onTaskSettled();
    }

    /**
     * 处理生成失败（由 LumenSocket 的 generation-failed 定向路由调用）：
     * 提示失败原因，按任务计数收尾（单个任务失败不影响其余并发任务）
     * @param {string} message - 失败原因（后端透传平台 errorMessage）
     */
    onGenerationFailed(message) {
        if (!this.isGenerating) return;   // 迟到的失败消息，忽略
        window.socket?.showNotification?.(`RunningHub 任务失败：${message}`, 8000);
        this._onTaskSettled();
    }

    /**
     * 任务收尾计数：done 追平 expected 时结束本轮生成
     */
    _onTaskSettled() {
        if (!this._pending) {
            this._finishGeneration();
            return;
        }
        this._pending.done++;
        if (this._pending.done < this._pending.expected) {
            this.generateBtn.textContent =
                this._pending.expected > 1
                    ? `生成中 ${this._pending.done}/${this._pending.expected}` : '生成中';
            return;
        }
        window.socket?.showNotification?.(
            this._pending.expected > 1
                ? `RunningHub 生成完成，共 ${this._pending.expected} 个任务` : 'RunningHub 生成完成', 8000);
        this.removePlaceholder();
        this._finishGeneration();
    }

    /**
     * 创建生成占位图（创建/动画统一交给全局占位图管理器）
     * 占位图归属标记为本节点，回流的图片/视频按归属队列先进先出消费
     * @param {{width: number, height: number}|null} res - 产出尺寸（未知为 null，回退 1024）
     * @param {number} [index] - 多任务时的序号（沿对角线级联偏移，避免相互遮挡）
     * @returns {Object} 占位图句柄
     */
    createPlaceholder(res, index = 0) {
        const width = res ? res.width : 1024;
        const height = res ? res.height : 1024;

        // 位置：节点右侧留出间距，垂直居中；多任务沿对角线级联
        const cascade = index * RunningHubGenNode.PLACEHOLDER_CASCADE;
        const x = this.x + this.width + RunningHubGenNode.PLACEHOLDER_GAP + cascade;
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
     * @param {string} base64 - 裸 base64 图片数据
     * @param {string} prompt - 生成时使用的提示词
     * @param {string} negativePrompt - 生成时使用的负面提示词
     * @returns {Promise<Object>} 落图后的真实图片对象
     */
    replacePlaceholder(placeholder, base64, prompt, negativePrompt) {
        return window.placeholderManager.replace(
            placeholder,
            'data:image/png;base64,' + base64,
            {
                name: `rh_gen_${Date.now()}.png`,
                source: 'runninghub',
                prompt: prompt,
                negativePrompt: negativePrompt
            }
        ).catch((err) => {
            console.error('RunningHub 节点落图失败:', err);
        });
    }

    /**
     * 无占位图可替换时的兜底落图：放在节点右侧空白处（垂直居中）
     * @param {string} base64 - 裸 base64 图片数据
     * @param {string} prompt - 生成时使用的提示词
     * @param {string} negativePrompt - 生成时使用的负面提示词
     */
    _appendImageRightOfNode(base64, prompt, negativePrompt) {
        const img = new Image();
        img.onload = () => {
            img.onload = null;
            this.canvas.images.images.push({
                id: LumenLight.generateId(),
                name: `rh_gen_${Date.now()}.png`,
                img: img,
                x: this.x + this.width + RunningHubGenNode.PLACEHOLDER_GAP,
                y: this.y + this.height / 2 - img.height / 2,
                width: img.width,
                height: img.height,
                selected: false,
                source: 'runninghub',
                prompt: prompt,
                negativePrompt: negativePrompt,
                created: Date.now()
            });
            this.canvas.draw();
        };
        img.src = 'data:image/png;base64,' + base64;
    }

    // ==================== 生命周期 ====================

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
        super.destroy();
    }

    /**
     * 序列化为存档数据（参数值快照与生成数量随节点入存档，恢复后回填）
     */
    toJSON() {
        return {
            id: this.id,
            type: NodeTypes.SOURCE.RUNHUB_GEN_NODE,
            x: this.x,
            y: this.y,
            width: this.width,
            height: this.height,
            workflowId: this.workflowId,
            values: this.params.getState(),
            count: this.count,
            ...(this.title ? { title: this.title } : {})
        };
    }
}

// ==================== 类常量 ====================
RunningHubGenNode.LAYOUT_MODE = 'design';  // 固定设计基准布局 + 整体缩放（同生图节点族）
RunningHubGenNode.DEFAULT_WIDTH = 2048;    // 默认宽度（与 Comfy 生图节点同量级）
RunningHubGenNode.DEFAULT_HEIGHT = 1800;   // 行数少（无 LoRA），高度略小
RunningHubGenNode.DEFAULT_TITLE = 'RunningHub'; // 默认标题（双击标题可自定义）
RunningHubGenNode.PLACEHOLDER_GAP = 300;   // 占位图与节点右缘的间距（px）
RunningHubGenNode.PLACEHOLDER_CASCADE = 160; // 多任务占位图的对角线级联间距（px）
// 无进展看门狗超时（毫秒）：与后端轮询上限（30 分钟）对齐并留出结果
// 下载转存余量——前端比后端先放弃会导致长任务结果回流时被丢弃
RunningHubGenNode.WATCHDOG_TIMEOUT = 35 * 60 * 1000;

// 将 RunningHubGenNode 类暴露到全局作用域
window.RunningHubGenNode = RunningHubGenNode;
