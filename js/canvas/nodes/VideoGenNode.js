/**
 * ==========================================================================
 * LumenLight 视频生成节点（VideoGenNode）
 * ==========================================================================
 * 作用：画布上的 API 视频生成节点，链路形态与 API 生图节点同构——左侧端口
 *       接收上游链路，提交 /api/llm/submit-video 建视频任务，轮询
 *       /api/llm/video-task/:id 直到成功，产物（后端已下载到 data/videos/）
 *       经 CanvasVideoManager 落画布（首帧封面 + 双击播放）。
 *       两种玩法（与生图节点同一连线规则——图片须先连入提示词节点）：
 *         - 文生视频：连提示词节点（链），文本作视频描述
 *         - 图生视频：连入的提示词链上带有画布图片时，首图作首帧
 *       任务制生成（提交→排队→生成）与图片的单请求不同步：一轮只有一个
 *       任务，按钮实时显示已等待秒数，停止 X 中止轮询（任务仍在云端跑完，
 *       产物不回流——与 LLM 聊天窗口同一语义）。
 *
 * 结构（复用 .text-node + .image-gen-node 全套样式，零新增 CSS）：
 *   - 标题栏：Generate Video + 「API 视频」徽标（与「API 生图」对仗）
 *   - 状态栏：仅左端口（in），无右端口（视频节点不对外输出）
 *   - 工具栏：模型下拉（只列视频模型）+ 比例下拉 + 时长下拉
 *   - 生成行：生成按钮 + 停止控件 X（GenStopControl，常驻两态）
 *
 * 参数与生图节点的差异（为何独立成节点）：视频无质量/分辨率档概念，
 * 换成比例（16:9/9:16/1:1）与时长（5s/10s）；一次一个任务不做并发数量。
 * ==========================================================================
 */

class VideoGenNode extends BaseCanvasNode {
    /**
     * 构造函数
     * @param {Canvas} canvas - 画布主类实例
     * @param {number} x - 画布坐标 X（左上角）
     * @param {number} y - 画布坐标 Y（左上角）
     * @param {Object} [options] - 恢复存档时的初始状态
     * @param {number} [options.width] - 节点宽度
     * @param {number} [options.height] - 节点高度
     * @param {string} [options.model] - 选中的模型复合键（"厂商||模型ID"）
     * @param {string} [options.ratio] - 比例选择（''=平台默认）
     * @param {number} [options.duration] - 时长秒数（''=平台默认）
     */
    constructor(canvas, x, y, options = {}) {
        super(canvas, x, y);
        this.source = NodeTypes.SOURCE.VIDEO_GEN_NODE;

        this.width = options.width || VideoGenNode.DEFAULT_WIDTH;
        this.height = options.height || VideoGenNode.DEFAULT_HEIGHT;

        // 工具栏选择状态（存档恢复用）
        this.model = options.model || '';
        this.ratio = options.ratio || '';
        this.duration = (options.duration === '' || options.duration === undefined)
            ? '' : (parseInt(options.duration, 10) || '');

        this.isGenerating = false;       // 生成进行中标记（防重复提交）
        this.modelsConfig = [];          // 模型配置缓存
        this._pollTimer = null;          // 轮询定时器句柄（destroy 清理）
        this._startTime = 0;             // 本轮任务开始时刻（按钮等待秒数）

        this.buildDom();
        this.bindEvents();
        this.updateTransform();
        this.loadModels();
    }

    /**
     * 构建 DOM 结构：标题栏 + 状态栏（左端口）+ 工具栏 + 生成行
     * 类名复用 .image-gen-node 全套表单样式（配色美学：节点设计规范），
     * 仅以 .video-gen-node 修饰类标记类型
     */
    buildDom() {
        this.el = document.createElement('div');
        this.el.className = 'text-node image-gen-node video-gen-node';
        this.el.dataset.id = this.id;

        this.el.innerHTML = `
            <div class="text-node-header">
                <span class="text-node-title">Generate Video</span>
                <span class="text-node-badge">API 视频</span>
            </div>
            <div class="text-node-statusbar">
                <div class="text-node-port text-node-port-in" title="输入端口：连接提示词节点（链上可带首帧图，图生视频）"></div>
            </div>
            <div class="text-node-body image-gen-form">
                <div class="image-gen-row">
                    <div class="image-gen-label">模型</div>
                    <select class="llm-model-select" title="选择视频生成模型">
                        <option value="">加载中…</option>
                    </select>
                </div>
                <div class="image-gen-row">
                    <div class="image-gen-label">比例</div>
                    <select class="video-ratio-select llm-model-select" title="画面比例（默认 = 模型平台值）">
                        <option value="" selected>默认</option>
                        <option value="16:9">16:9</option>
                        <option value="9:16">9:16</option>
                        <option value="1:1">1:1</option>
                    </select>
                </div>
                <div class="image-gen-row">
                    <div class="image-gen-label">时长</div>
                    <select class="video-duration-select llm-model-select" title="视频时长（默认 = 模型平台值）">
                        <option value="" selected>默认</option>
                        <option value="5">5 秒</option>
                        <option value="10">10 秒</option>
                    </select>
                </div>
                <div class="image-gen-actions">
                    <button class="image-gen-generate-btn" type="button"
                            title="收集连入的提示词/首帧图并提交视频生成任务">生成</button>
                    <!-- 生成任务停止控件（GenStopControl）的 X 按钮插在本行末尾：
                         常驻两态（暗置/点亮），点击中止本轮任务轮询 -->
                </div>
            </div>
            <div class="text-node-resize" title="拖拽调整大小"></div>
        `;

        this.modelSelect = this.el.querySelector('.llm-model-select');
        this.ratioSelect = this.el.querySelector('.video-ratio-select');
        this.durationSelect = this.el.querySelector('.video-duration-select');
        this.generateBtn = this.el.querySelector('.image-gen-generate-btn');
        this.portInEl = this.el.querySelector('.text-node-port-in');

        // 生成任务停止控件：X 在生成按钮右侧，常驻两态；状态归本节点实例持有
        this.stopControl = new GenStopControl({
            host: this.el.querySelector('.image-gen-actions'),
            title: '停止本轮任务轮询'
        });

        // 恢复存档的选择
        if (this.ratio) this.ratioSelect.value = this.ratio;
        if (this.duration) this.durationSelect.value = String(this.duration);

        // 标题双击重命名（基类共用实现，六类节点同一套交互）
        this.initTitleEditor();

        // 挂到画布容器（canvas 元素的父级，即 body），跟随视口变换
        document.body.appendChild(this.el);
    }

    /**
     * 绑定节点内部 DOM 事件（透传/拦截策略与 ImageGenNode 一致）
     */
    bindEvents() {
        // mousedown 透传给画布交互层：节点是 DOM 元素浮在 canvas 上方，
        // 事件不会自然到达 canvas，必须主动转发才能复用统一的选中/拖动逻辑。
        // 下拉框/按钮等交互控件拦截透传，走原生行为（选择、点击）。
        this.el.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;   // 只转发左键
            if (e.target.closest('select, button, input, textarea, .llm-size-options-wrap')) {
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

        // 选择变化：记录（存档用）
        this.modelSelect.addEventListener('change', () => {
            this.model = this.modelSelect.value;
        });
        this.ratioSelect.addEventListener('change', () => {
            this.ratio = this.ratioSelect.value;
        });
        this.durationSelect.addEventListener('change', () => {
            this.duration = this.durationSelect.value
                ? parseInt(this.durationSelect.value, 10) : '';
        });

        // 生成按钮
        this.generateBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.generate();
        });

        // 滚轮转发：节点浮在 canvas 上方，wheel 到不了画布层。
        // 悬停在交互控件上时放行原生行为（下拉选项滚动等），其余转发缩放画布
        this.el.addEventListener('wheel', (e) => {
            if (e.target.closest('select, button, input, textarea, .llm-size-options-wrap')) return;
            e.preventDefault();
            this.canvas.interaction.handleWheel(e);
        }, { passive: false });

        // 右键在节点上：不弹画布菜单（与图片一致）
        this.el.addEventListener('contextmenu', (e) => {
            e.stopPropagation();
        });
    }

    // ==================== 模型清单 ====================

    /**
     * 从设置中加载视频模型列表并填充下拉框：
     * 只保留 LumenLight.classifyModel 判定为 video 的模型（口径与 LLM
     * 窗口三分类统一），对话/生图模型不混入。聚合所有已配置厂商（多厂商
     * 并存），value 为"厂商||模型ID"复合键，请求时拆开显式路由
     */
    async loadModels() {
        try {
            const response = await fetch('/api/settings');
            const result = await response.json();
            const api = result.settings?.api || {};
            const { models, providerCount } = LumenLight.collectConfiguredModels(api);

            const videoModels = models.filter((m) => LumenLight.classifyModel(m) === 'video');
            this.modelsConfig = videoModels;

            if (videoModels.length === 0) {
                this.modelSelect.innerHTML = '<option value="">未配置视频模型</option>';
                return;
            }

            const showProvider = providerCount > 1;
            this.modelSelect.innerHTML = videoModels.map((model) => {
                const label = showProvider
                    ? `${model.displayName || model.id} · ${model.provider}`
                    : (model.displayName || model.id);
                return `<option value="${LumenLight.escapeHtml(model.key)}">${LumenLight.escapeHtml(label)}</option>`;
            }).join('');

            // 恢复之前/存档中的选择（旧存档存的是裸模型 ID，两种形态都认）
            if (this.model && videoModels.some((m) => m.key === this.model || m.id === this.model)) {
                this.modelSelect.value = this.model;
            }
            this.model = this.modelSelect.value;
        } catch (error) {
            console.error('视频节点加载模型列表失败:', error);
            this.modelSelect.innerHTML = '<option value="">加载失败</option>';
        }
    }

    /**
     * 当前选中模型的所属厂商名（用于请求显式路由）
     * @returns {string} 厂商名（裸 ID 兼容时为空串，由后端回退自动路由）
     */
    getModelProvider() {
        return LumenLight.parseModelKey(this.model).provider;
    }

    // ==================== 上游链路收集 ====================

    /**
     * 沿整条上游提示词链收集文本并合并（详见 ImagePipeline.collectPrompt）
     * @returns {string} 拼接后的提示词（无可用提示词时返回空串）
     */
    collectPrompt() {
        return this._pipeline().collectPrompt(this.id);
    }

    /**
     * 收集整条链路的参考图（详见 ImagePipeline.collectImages），
     * 取第一张作图生视频首帧（后端 imageUrl 单槽）
     * @returns {Promise<string[]>} base64 data URL 数组
     */
    async collectImages() {
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
     * 执行生成：收集提示词/首帧 → 提交视频任务 → 轮询 → 产物落画布
     * 任务制链路（与 LlmVideoGen 同一后端），一轮一个任务：
     *   提交 /api/llm/submit-video → taskId → 轮询 /api/llm/video-task/:id
     *   → succeeded 后端已把视频下载到 data/videos/ → 按占位图中心落画布
     */
    async generate() {
        if (this.isGenerating) return;

        const prompt = this.collectPrompt();
        const images = await this.collectImages();
        if (!prompt && images.length === 0) {
            window.socket?.showNotification?.('请先从左侧端口连接提示词节点');
            return;
        }
        const model = this.modelSelect.value;
        if (!model) {
            window.socket?.showNotification?.('请先选择视频生成模型');
            return;
        }

        // 锁定按钮，进入生成态；停止控件同步点亮（中止 = 停轮询，
        // 云端任务不受影响地跑完——与 LLM 聊天窗口同一语义）
        this.isGenerating = true;
        this.generateBtn.disabled = true;
        this.generateBtn.textContent = '提交中…';
        const signal = this.stopControl.begin();

        // 任务中心登记：一轮 = 一个任务（locateTarget 聚焦本节点）
        const taskRef = window.taskRegistry?.register({
            kind: 'api',
            label: prompt || '图生视频',
            total: 1,
            onStop: () => this.stopControl.abort(),
            locateTarget: this
        });

        // 创建占位框（视觉反馈）：比例映射占位尺寸，任务完成视频落其中心
        const placeholder = this.createPlaceholder();

        try {
            // 1. 提交任务（图生视频：首帧 base64 随请求体）
            const selection = LumenLight.parseModelKey(model);
            const submitResp = await fetch('/api/llm/submit-video', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: selection.id,
                    provider: selection.provider,
                    prompt: prompt || '',
                    ...(images.length > 0 ? { imageUrl: images[0] } : {}),
                    ...(this.ratio ? { ratio: this.ratio } : {}),
                    ...(this.duration ? { duration: this.duration } : {})
                }),
                signal
            });
            const submitResult = await submitResp.json();
            if (!submitResp.ok || submitResult.status !== 'ok') {
                throw new Error(submitResult.message || '提交视频任务失败');
            }

            // 2. 轮询任务状态（成功时后端已下载视频到本地并回传路径）
            this._startTime = Date.now();
            const videoPath = await this._pollTask(submitResult.taskId, selection, signal);

            // 3. 视频落占位框中心（与 Comfy 节点视频回流同一落位约定）：
            //    先取占位框中心再等视频就绪——任务等待期间用户可能平移
            //    画布，落点必须锚在节点旁的占位框，而不是轮询完成那一刻
            //    的视口中心（跑偏后用户在节点旁找不到视频）；占位框保留
            //    到落图结算才消费，失败路径由外层 catch 兜底移除
            const ph = placeholder.imageObj;
            const center = ph
                ? { centerX: ph.x + ph.width / 2, centerY: ph.y + ph.height / 2 }
                : {};
            try {
                await this._landVideo(videoPath, prompt, center);
                taskRef?.end('done');
                window.socket?.showNotification?.('视频已生成', 8000);
            } finally {
                window.placeholderManager.remove(placeholder);
            }
        } catch (error) {
            window.placeholderManager.remove(placeholder);
            if (GenStopControl.isAbortError(error)) {
                taskRef?.end('stopped', '已停止');
                window.socket?.showNotification?.('⛔ 已停止任务轮询', 8000);
            } else {
                console.error('视频生成失败:', error);
                taskRef?.end('failed', error.message || '生成失败');
                window.socket?.showNotification?.('生成失败: ' + (error.message || '未知错误'), 8000);
            }
        } finally {
            this.isGenerating = false;
            this._pollTimer = null;
            this.stopControl.end();
            // 兜底结算：走到这里仍未 end（异常早退）不许任务悬挂在运行态
            if (taskRef?.isRunning()) taskRef.end('failed', '生成中断');
            this.generateBtn.disabled = false;
            this.generateBtn.textContent = '生成';
        }
    }

    /**
     * 轮询视频任务状态直到完成/失败/超时（轮询节奏与 LlmVideoGen 同源：
     * 自适应间隔，网络波动不终止，下一轮重试）
     * @param {string} taskId - 提交返回的任务 ID
     * @param {{provider: string}} selection - 厂商路由信息
     * @param {AbortSignal} signal - 停止控件的中止信号
     * @returns {Promise<string>} 视频本地相对路径（data/videos/…）
     */
    _pollTask(taskId, selection, signal) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();

            const poll = async () => {
                if (signal.aborted) {
                    reject(new DOMException('已停止', 'AbortError'));
                    return;
                }
                if (Date.now() - startTime > VideoGenNode.POLL_TIMEOUT) {
                    reject(new Error('视频生成超时（10 分钟），请稍后重试'));
                    return;
                }

                try {
                    const params = new URLSearchParams({
                        model: selection.id,
                        provider: selection.provider || ''
                    });
                    const resp = await fetch(
                        `/api/llm/video-task/${encodeURIComponent(taskId)}?${params}`,
                        { signal });
                    const result = await resp.json();

                    if (!resp.ok || result.status !== 'ok') {
                        reject(new Error(result.message || '查询任务状态失败'));
                        return;
                    }

                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
                    switch (result.taskStatus) {
                        case 'succeeded':
                            resolve(result.videoPath);
                            return;
                        case 'failed':
                        case 'cancelled':
                        case 'expired':
                            reject(new Error(result.error || `视频生成失败（状态: ${result.taskStatus}）`));
                            return;
                        default: {
                            // queued / running：按钮实时显示等待秒数
                            const statusText = result.taskStatus === 'running' ? '生成中' : '排队中';
                            this.generateBtn.textContent = `${statusText} ${elapsed}s`;
                            break;
                        }
                    }
                } catch (err) {
                    // 用户中止直接结束；网络波动不终止，下一轮重试
                    if (GenStopControl.isAbortError(err)) {
                        reject(err);
                        return;
                    }
                    console.warn('视频任务轮询网络错误（将重试）:', err.message);
                }

                const interval = (Date.now() - startTime < VideoGenNode.POLL_FAST_DURATION)
                    ? VideoGenNode.POLL_INTERVAL_FAST
                    : VideoGenNode.POLL_INTERVAL_SLOW;
                this._pollTimer = setTimeout(poll, interval);
            };

            poll();
        });
    }

    /**
     * 视频落画布（委托 CanvasVideoManager，落点=占位框中心）。
     * 视频溯源（genInfo）暂不登记：视频对象序列化链路尚无该字段，
     * 生成同款对视频链路暂不开放
     * @param {string} videoPath - 后端返回的本地视频相对路径
     * @param {string} prompt - 生成时使用的提示词
     * @param {{centerX?: number, centerY?: number}} [center] - 占位框中心
     *        （世界坐标；缺省时视频管理器自适应落位）
     */
    async _landVideo(videoPath, prompt, center = {}) {
        const videoUrl = '/' + String(videoPath).replace(/^\//, '');
        await this.canvas.videoManager.addVideo(videoUrl, {
            prompt: prompt || '',
            name: String(videoPath).split('/').pop(),
            ...center
        });
    }

    // ==================== 占位反馈 ====================

    /**
     * 创建占位框（创建/动画统一交给全局占位图管理器）：位于节点右侧，
     * 尺寸按当前比例映射（默认 16:9）
     * @returns {Object} 占位图句柄
     */
    createPlaceholder() {
        const [w, h] = (this.ratio && this.ratio !== '' && this.ratio.includes(':'))
            ? this.ratio.split(':').map((v) => parseInt(v, 10))
            : [16, 9];
        const base = 1024;
        const width = w >= h ? base : Math.round(base * w / h);
        const height = w >= h ? Math.round(base * h / w) : base;

        const x = this.x + this.width + VideoGenNode.PLACEHOLDER_GAP;
        const y = this.y + this.height / 2 - height / 2;

        return window.placeholderManager.create(this, { x, y, width, height });
    }

    // ==================== 生命周期 ====================
    // 几何（ns/updateTransform/getPortPoint/setGeometry/contains 等）与
    // 选中同步由基类 BaseCanvasNode 提供（LAYOUT_MODE='design' 布局模式）

    /**
     * 从 DOM 移除节点（删除时调用）：清理停止控件与未结算的轮询定时器，
     * 再由基类移除元素（云端任务不受节点删除影响，照常跑完）
     */
    destroy() {
        if (this._pollTimer) {
            clearTimeout(this._pollTimer);
            this._pollTimer = null;
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
            type: NodeTypes.SOURCE.VIDEO_GEN_NODE,
            x: this.x,
            y: this.y,
            width: this.width,
            height: this.height,
            model: this.model,
            ratio: this.ratio,
            duration: this.duration,
            ...(this.title ? { title: this.title } : {})
        };
    }
}

// ==================== 类常量 ====================
// 布局常量为设计基准尺寸（ns = 1 时的值），与 css/node.css 保持一致。
// LAYOUT_MODE='design'：有原生 <select> 的节点必须用固定设计基准布局
// （select 弹出浮层不跟随 CSS transform，见配色美学技能与 BaseCanvasNode）
VideoGenNode.LAYOUT_MODE = 'design';
VideoGenNode.DEFAULT_WIDTH = 2048;      // 默认宽度（px，与生图节点同量级）
VideoGenNode.DEFAULT_HEIGHT = 2048;     // 默认高度（px）
VideoGenNode.DEFAULT_TITLE = 'Generate Video'; // 默认标题（双击标题可自定义）
VideoGenNode.PLACEHOLDER_GAP = 300;     // 占位框与节点右缘的间距（px）
// 轮询节奏（与 LlmVideoGen 同源；总超时放宽到 10 分钟——画布任务多为
// 批量编排场景，排队时间比聊天窗口单发更长）
VideoGenNode.POLL_INTERVAL_FAST = 3000;   // 前 10 秒：每 3 秒轮询
VideoGenNode.POLL_INTERVAL_SLOW = 5000;   // 之后：每 5 秒轮询
VideoGenNode.POLL_FAST_DURATION = 10000;  // 快速轮询持续时间
VideoGenNode.POLL_TIMEOUT = 600000;       // 总超时：10 分钟

// 将 VideoGenNode 类暴露到全局作用域
window.VideoGenNode = VideoGenNode;
