/**
 * ==========================================================================
 * LumenLight 生图节点（ImageGenNode）
 * ==========================================================================
 * 作用：画布上的图像生成节点面板，左侧端口接收提示词节点（或提示词节点串联
 *       链的末端）连入，沿整条上游提示词链收集文本并合并（每个节点之间
 *       空一行，按"离本节点由远到近"排序）后调用 /api/llm/generate-image
 *       生成图片，生成结果以画布图片形式落在节点旁的占位图位置。
 *       同时支持图生图（I2I）：连入本节点或上游提示词链任意节点的画布图片
 *       会自动转为 base64 随请求发送，作为参考图。
 *
 * 结构（复用 .text-node 基础样式，扩展 .image-gen-node 修饰类）：
 *   - 标题栏：Generate + 「API 生图」徽标（与 Comfy 生图节点的
 *     「Comfy 生图」对仗，标明这是走厂商 API 的生图链路）
 *   - 状态栏：仅左端口（in），无右端口（生图节点不对外输出）
 *   - 工具栏：模型下拉 + 比例/分辨率双段下拉（复用 LlmSizePicker）
 *             + 质量下拉（gpt-image 系模型时显示）
 *   - 生成行：数量步进器（CountStepper，1-8 张并发）+ 生成按钮
 *             + 停止控件 X（GenStopControl，常驻两态）
 *   - 内容区：提示文本
 *
 * 交互职责划分（与 PromptNode 一致）：
 *   - 面板的选中/拖动由 CanvasInteraction 统一处理（mousedown 透传，
 *     e._canvasNodeTarget 标记本节点）
 *   - 下拉框/按钮等控件拦截透传，走原生行为
 *   - 生成流程由本类自行管理（占位图 → API 请求 → 落图）
 *
 * 提示词/参考图的链路收集与 base64 转换已拆至 js/utils/ImagePipeline.js
 * （纯数据层，不碰 DOM），本类仅保留薄委托。
 * ==========================================================================
 */

class ImageGenNode extends BaseCanvasNode {
    /**
     * 构造函数
     * @param {Canvas} canvas - 画布主类实例
     * @param {number} x - 画布坐标 X（左上角）
     * @param {number} y - 画布坐标 Y（左上角）
     * @param {Object} [options] - 恢复存档时的初始状态
     * @param {number} [options.width] - 节点宽度
     * @param {number} [options.height] - 节点高度
     * @param {string} [options.model] - 选中的模型 ID
     * @param {string} [options.ratio] - 比例选择
     * @param {string} [options.tier] - 分辨率档位
     * @param {string} [options.quality] - 质量选择
     * @param {number} [options.count] - 同时生成数量（1-8）
     */
    constructor(canvas, x, y, options = {}) {
        super(canvas, x, y);
        this.source = NodeTypes.SOURCE.IMAGE_GEN_NODE;

        this.width = options.width || ImageGenNode.DEFAULT_WIDTH;
        this.height = options.height || ImageGenNode.DEFAULT_HEIGHT;

        // 工具栏选择状态（存档恢复用）
        this.model = options.model || '';
        this.ratio = options.ratio || '1:1';
        this.tier = options.tier || '2K';
        this.quality = options.quality || '';
        // 同时生成数量（1-8 张，前端并发请求，各请求独立落图）
        this.count = Math.min(ImageGenNode.MAX_COUNT, Math.max(1, parseInt(options.count, 10) || 1));

        this.isGenerating = false;       // 生成进行中标记（防重复提交）
        this.modelsConfig = [];          // 模型配置缓存

        this.buildDom();
        this.bindEvents();
        this.updateTransform();
        this.loadModels();
    }

    /**
     * 构建 DOM 结构：标题栏 + 状态栏（左端口）+ 工具栏 + 提示区
     */
    buildDom() {
        this.el = document.createElement('div');
        this.el.className = 'text-node image-gen-node';
        this.el.dataset.id = this.id;

        this.el.innerHTML = `
            <div class="text-node-header">
                <span class="text-node-title">Generate</span>
                <span class="text-node-badge">API 生图</span>
            </div>
            <div class="text-node-statusbar">
                <div class="text-node-port text-node-port-in" title="输入端口：连接提示词节点"></div>
            </div>
            <div class="text-node-body image-gen-form">
                <div class="image-gen-row">
                    <div class="image-gen-label">模型</div>
                    <select class="llm-model-select" title="选择生图模型">
                        <option value="">加载中…</option>
                    </select>
                </div>
                <div class="image-gen-row">
                    <div class="image-gen-label">比例 / 分辨率</div>
                    <div class="llm-size-select-wrap">
                        <select class="llm-size-select" title="图片比例与分辨率"></select>
                    </div>
                </div>
                <div class="image-gen-row" data-role="quality-row">
                    <div class="image-gen-label">质量</div>
                    <select class="llm-quality-select" title="图片生成质量">
                        <option value="" selected>自动</option>
                    </select>
                </div>
                <div class="image-gen-actions">
                    <!-- 数量步进器（与 Comfy 生图节点同款交互，CountStepper
                         行为层共用）：1-8 张并发请求，上下箭头步进或直接键入 -->
                    <div class="gen-count-stepper"
                         title="同时生成的图片数量（1-8 张并发请求），上下箭头步进或直接键入">
                        <input type="text" class="gen-count-stepper-input"
                               inputmode="numeric" maxlength="2" value="1" aria-label="生成数量">
                        <div class="gen-count-stepper-arrows">
                            <button type="button" class="gen-count-stepper-arrow" data-step="up" aria-label="增加数量">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
                            </button>
                            <button type="button" class="gen-count-stepper-arrow" data-step="down" aria-label="减少数量">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                            </button>
                        </div>
                    </div>
                    <button class="image-gen-generate-btn" type="button" title="收集连入的提示词并生成图片">生成</button>
                    <!-- 生成任务停止控件（GenStopControl）的 X 按钮插在本行末尾：
                         常驻两态（暗置/点亮），点击中止本节点本轮全部并发请求 -->
                </div>
            </div>
            <div class="text-node-resize" title="拖拽调整大小"></div>
        `;

        this.modelSelect = this.el.querySelector('.llm-model-select');
        this.sizeSelect = this.el.querySelector('.llm-size-select');
        this.qualitySelect = this.el.querySelector('.llm-quality-select');
        this.qualityRow = this.el.querySelector('[data-role="quality-row"]');
        this.generateBtn = this.el.querySelector('.image-gen-generate-btn');
        this.formEl = this.el.querySelector('.image-gen-form');
        this.portInEl = this.el.querySelector('.text-node-port-in');

        // 数量步进器（迁移自数量下拉行，与 Comfy 生图节点同款交互）：
        // 行为层共用 CountStepper，状态仍是 this.count（1-8 钳制，存档兼容）
        this.countStepper = new CountStepper(
            { input: this.el.querySelector('.gen-count-stepper-input'),
              up: this.el.querySelector('.gen-count-stepper-arrow[data-step="up"]'),
              down: this.el.querySelector('.gen-count-stepper-arrow[data-step="down"]') },
            { get: () => this.count,
              set: (v) => {
                  this.count = Math.min(ImageGenNode.MAX_COUNT, Math.max(1, parseInt(v, 10) || 1));
                  return this.count;
              } }
        );
        this.countStepper.sync();

        // 生成任务停止控件：X 在生成按钮右侧，常驻两态（暗置/点亮）；状态归
        // 本节点实例持有（无全局注册表），多节点并发不同厂商时各自独立中止
        this.stopControl = new GenStopControl({
            host: this.el.querySelector('.image-gen-actions'),
            title: '停止本轮生成'
        });

        // 比例/分辨率双段下拉：复用 LLM 对话框的 LlmSizePicker 组件，
        // 恢复存档时把之前的选择写回组件状态
        this.sizePicker = new LlmSizePicker(this.sizeSelect);
        this.sizePicker.ratio = this.ratio;
        this.sizePicker.tier = this.tier;
        this.sizePicker.render();

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
            // 步进器数值框是 input：拦截透传，否则点进去会拖动节点
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

        // 模型切换：记录选择 + 按模型刷新质量下拉与尺寸档位可用性
        this.modelSelect.addEventListener('change', () => {
            this.model = this.modelSelect.value;
            this.updateQualityOptions();
            this.sizePicker.setModel(this.getModelId());
        });

        // 质量切换：记录选择
        this.qualitySelect.addEventListener('change', () => {
            this.quality = this.qualitySelect.value;
        });

        // 数量输入由 CountStepper 行为层接管（构造函数里已挂接）

        // 生成按钮
        this.generateBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.generate();
        });

        // 滚轮转发：节点浮在 canvas 上方，wheel 到不了画布层。
        // 悬停在交互控件上时放行原生行为（下拉选项/步进器滚动等），
        // 其余转发缩放画布
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

    // ==================== 工具栏状态 ====================

    /**
     * 从设置中加载模型列表并填充下拉框（与 LlmChat.loadModels 逻辑一致，显示全部模型）。
     * 聚合所有已配置厂商的模型（多厂商并存）：生图不再受「当前厂商」限制，
     * 请求显式携带厂商名由后端直接路由。多厂商时选项带厂商名。
     */
    async loadModels() {
        try {
            const response = await fetch('/api/settings');
            const result = await response.json();
            const api = result.settings?.api || {};
            const { models, providerCount } = LumenLight.collectConfiguredModels(api);

            // 只保留生图模型（分类口径与 LLM 窗口三分类统一：手动 type 标记
            // 优先，auto 按关键词识别，见 LumenLight.classifyModel）——对话/
            // 视频模型不再混进生图下拉。旧存档若选中的是已被过滤的模型，
            // 恢复匹配落空后按既有逻辑回落到清单第一项
            const imageModels = models.filter((m) => LumenLight.classifyModel(m) === 'image');

            this.modelsConfig = imageModels;

            if (imageModels.length === 0) {
                this.modelSelect.innerHTML = '<option value="">未配置生图模型</option>';
                return;
            }

            const showProvider = providerCount > 1;
            this.modelSelect.innerHTML = imageModels.map((model) => {
                const label = showProvider
                    ? `${model.displayName || model.id} · ${model.provider}`
                    : (model.displayName || model.id);
                // value 为"厂商||模型ID"复合键：不同厂商的同名模型可共存，
                // 发送请求时拆回厂商 + 模型 ID 显式路由
                return `<option value="${LumenLight.escapeHtml(model.key)}">${LumenLight.escapeHtml(label)}</option>`;
            }).join('');

            // 恢复之前/存档中的选择（旧存档存的是裸模型 ID，两种形态都认）
            if (this.model && imageModels.some((m) => m.key === this.model || m.id === this.model)) {
                this.modelSelect.value = this.model;
            }
            // 同步当前选中值（新建节点时 model 为空，取下拉框默认第一项），
            // 保证质量下拉的显隐判断基于实际选中的模型
            this.model = this.modelSelect.value;
            this.updateQualityOptions();
            // 按最新模型同步尺寸档位可用性（快照恢复的 1K 等旧档位
            // 若低于模型下限，会在此可见地切到最低可用档）
            this.sizePicker.setModel(this.getModelId());
            this.tier = this.sizePicker.getTier();
        } catch (error) {
            console.error('生图节点加载模型列表失败:', error);
            this.modelSelect.innerHTML = '<option value="">加载失败</option>';
        }
    }

    /**
     * 当前选中模型的纯模型 ID。
     * 下拉框 value 为"厂商||模型ID"复合键，质量/尺寸等按模型 ID 的
     * 模式匹配逻辑（LlmQuality / LlmResolution）应使用本方法取 ID
     * @returns {string} 模型 ID（复合键解析失败时原样返回）
     */
    getModelId() {
        return LumenLight.parseModelKey(this.model).id;
    }

    /**
     * 当前选中模型的所属厂商名（用于请求显式路由）
     * @returns {string} 厂商名（裸 ID 兼容时为空串，由后端回退自动路由）
     */
    getModelProvider() {
        return LumenLight.parseModelKey(this.model).provider;
    }

    /**
     * 按当前模型刷新质量下拉（与 LLM 对话框行为一致）：
     *   - 支持质量参数的模型（gpt-image / dall-e 系）：渲染对应档位选项并显示整行
     *   - 其他模型：隐藏整行（含"质量"标签），避免留下空白行
     * 档位判断逻辑复用 js/utils/llmQuality.js
     */
    updateQualityOptions() {
        const options = LlmQuality.getOptions(this.getModelId());
        if (options) {
            // 仅选项变化时才重绘，避免切模型时丢失当前选择
            const currentValue = this.qualitySelect.value;
            const optionsHtml = options.map((opt) =>
                `<option value="${LumenLight.escapeHtml(opt.value)}" ${opt.value === currentValue ? 'selected' : ''}>${LumenLight.escapeHtml(opt.label)}</option>`
            ).join('');
            if (this.qualitySelect.innerHTML !== optionsHtml) {
                this.qualitySelect.innerHTML = optionsHtml;
            }
            this.qualityRow.style.display = '';
        } else {
            this.qualityRow.style.display = 'none';
        }
    }

    // ==================== 生成流程 ====================

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
     * 构建管线实例（每次收集时新建，保证使用最新连线/画布数据）
     * @returns {ImagePipeline}
     */
    _pipeline() {
        return new ImagePipeline(
            this.canvas.connections.connections,
            this.canvas.images.images
        );
    }

    /**
     * 执行生成：收集提示词 → 创建占位图 → 调用生图 API → 结果落图
     */
    async generate() {
        if (this.isGenerating) return;

        const prompt = this.collectPrompt();
        if (!prompt) {
            window.socket?.showNotification?.('请先从左侧端口连接提示词节点');
            return;
        }
        const model = this.modelSelect.value;
        if (!model) {
            window.socket?.showNotification?.('请先选择生图模型');
            return;
        }

        const ratio = this.sizePicker.getRatio();
        const tier = this.sizePicker.getTier();
        const quality = this.qualityRow.style.display !== 'none' ? this.qualitySelect.value : '';

        // 按模型、比例、档位计算实际像素（auto 时交给模型决定）
        const res = ratio === 'auto' ? null : LlmResolution.getResolutionForModel(this.getModelId(), ratio, tier);
        const size = res ? `${res.width}x${res.height}` : null;
        // 档位低于模型下限被自动抬升时，明确告知实际使用的尺寸
        if (res?.upgraded) {
            window.socket?.showNotification?.(`当前模型不支持 ${tier} 档，已按 ${size} 生成`);
        }

        // 收集参考图（图生图 I2I）：连入本节点/上游提示词节点的画布图片
        const images = await this.collectImages();

        // 同时生成数量（1-8 张，各请求独立并发、独立落图）
        const count = Math.min(ImageGenNode.MAX_COUNT, Math.max(1, this.count || 1));

        // 锁定按钮，进入生成态（多张时按钮实时显示完成进度）；
        // 停止控件同步显示 X（一轮一个 controller，N 张并发共享，点 X 全停）
        this.isGenerating = true;
        this.generateBtn.disabled = true;
        this.generateBtn.textContent = `生成中 0/${count}`;
        const signal = this.stopControl.begin();

        // 任务中心登记：一轮 N 张为一个任务（进度随完成数推进）。停止与
        // 节点 X 同一内核（stopControl.abort），定位聚焦本节点
        const taskRef = window.taskRegistry?.register({
            kind: 'api',
            label: prompt,
            total: count,
            onStop: () => this.stopControl.abort(),
            locateTarget: this
        });

        // 共享请求体：N 个并发请求使用同一份提示词/参考图/尺寸。
        // 下拉 value 为"厂商||模型ID"复合键：拆开后显式指定厂商，
        // 后端直接路由（同名模型在多个中转站共存时可区分）
        const requestBody = { model: this.getModelId(), provider: this.getModelProvider(), prompt };
        if (size) requestBody.size = size;
        if (quality) requestBody.quality = quality;
        // 有连入图片时随请求发送（图生图 I2I，与 LLM 对话框行为一致）
        if (images.length > 0) requestBody.images = images;

        // 生成参数记录（溯源/生成同款）：随占位图绑定到回图（imageObj.genInfo，
        // GenInfoPopup 展示与回填）——本节点名下所有占位图共用同一份
        this._activeGenInfo = window.GenRecord ? GenRecord.forApi({
            positive: prompt,
            model: this.modelSelect.value,
            provider: this.getModelProvider(),
            size,
            quality,
            ratio,
            tier,
            refCount: images.length,
            node: this
        }) : null;

        // 清理可能残留的旧占位图后，按数量沿对角线级联创建占位图
        this.removePlaceholder();
        const placeholders = [];
        for (let i = 0; i < count; i++) {
            placeholders.push(this.createPlaceholder(res, i));
        }

        try {
            // N 个请求并发发出，互不阻塞，各自完成后独立替换占位图落图
            let done = 0;
            const runOne = async (placeholder) => {
                try {
                    const response = await fetch('/api/llm/generate-image', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(requestBody),
                        signal
                    });
                    const result = await response.json();
                    if (response.ok && result.status === 'ok' && result.imageUrl) {
                        await this.replacePlaceholder(placeholder, result.imageUrl, prompt);
                        return { ok: true };
                    }
                    this.removePlaceholder(placeholder);
                    return { ok: false, message: result.message || '未知错误' };
                } catch (error) {
                    this.removePlaceholder(placeholder);
                    // 用户点 X 主动中止：不算失败，单独标记供汇总提示分流
                    if (GenStopControl.isAbortError(error)) {
                        return { ok: false, aborted: true, message: '已停止' };
                    }
                    console.error('生图节点生成请求失败:', error);
                    return { ok: false, message: error.message };
                }
            };
            const tasks = placeholders.map(async (placeholder) => {
                const result = await runOne(placeholder);
                done++;
                taskRef?.update({ done });
                // 每张结束（无论成败）都刷新按钮进度
                this.generateBtn.textContent = `生成中 ${done}/${count}`;
                return result;
            });

            const results = await Promise.all(tasks);
            const okCount = results.filter((r) => r.ok).length;
            const failCount = count - okCount;
            const abortedCount = results.filter((r) => r.aborted).length;

            // 任务中心结算：全部停止=中性，全失败=红驻留，其余=完成
            if (taskRef) {
                if (abortedCount > 0 && okCount === 0) taskRef.end('stopped', '已停止');
                else if (okCount === 0) taskRef.end('failed', results[0]?.message || '生成失败');
                else taskRef.end('done', count > 1 ? `完成 ${okCount}/${count}` : '');
            }

            // 结果提示显示 8 秒：默认 2 秒在并发落图时容易错过。
            // 有中止时走中性提示（用户主动停止不是失败），完成数照报
            if (abortedCount > 0) {
                window.socket?.showNotification?.(
                    okCount > 0 ? `已停止生成（完成 ${okCount}/${count}）` : '⛔ 已停止生成', 8000);
            } else if (failCount === 0) {
                window.socket?.showNotification?.(count > 1 ? `生成完成，共 ${count} 张` : '生成完成', 8000);
            } else if (okCount === 0) {
                window.socket?.showNotification?.('生成失败: ' + (results[0].message || '未知错误'), 8000);
            } else {
                const firstFail = results.find((r) => !r.ok);
                window.socket?.showNotification?.(`生成完成 ${okCount}/${count}，失败: ${firstFail.message}`, 8000);
            }
        } finally {
            this.isGenerating = false;
            this.stopControl.end();
            // 兜底结算：走到这里仍未 end（异常早退）不许任务悬挂在运行态
            if (taskRef?.isRunning()) taskRef.end('failed', '生成中断');
            this._activeGenInfo = null;
            this.generateBtn.disabled = false;
            this.generateBtn.textContent = '生成';
        }
    }

    // ==================== 生命周期 ====================
    // 占位图生命周期（createPlaceholder/removePlaceholder/replacePlaceholder）
    // 由 GenNodePlaceholder 混入提供（文件末尾 Object.assign，ADR 053）；
    // 几何（ns/updateTransform/getPortPoint/setGeometry/contains 等）与
    // 选中同步由基类 BaseCanvasNode 提供（LAYOUT_MODE='design' 布局模式）

    /**
     * 从 DOM 移除节点（删除时调用），先清理生成占位图与停止控件
     * 再由基类移除元素
     */
    destroy() {
        this.removePlaceholder();
        this.stopControl.destroy();
        super.destroy();
    }

    /**
     * 序列化为存档数据（含全部工具栏选择状态）
     */
    toJSON() {
        return {
            id: this.id,
            type: NodeTypes.SOURCE.IMAGE_GEN_NODE,
            x: this.x,
            y: this.y,
            width: this.width,
            height: this.height,
            model: this.model,
            ratio: this.sizePicker.getRatio(),
            tier: this.sizePicker.getTier(),
            quality: this.quality,
            count: this.count,
            ...(this.title ? { title: this.title } : {})
        };
    }
}

// ==================== 类常量 ====================
// 布局常量为设计基准尺寸（ns = 1 时的值），与 css/node.css 保持一致。
// DESIGN_BASE / MIN_WIDTH / MIN_HEIGHT / RESIZE_HANDLE_SIZE / 端口几何常量
// 已上收到基类 BaseCanvasNode；本类覆写 LAYOUT_MODE 为 design 布局
ImageGenNode.LAYOUT_MODE = 'design';  // 固定设计基准布局 + 整体缩放（见 BaseCanvasNode 类头）
ImageGenNode.DEFAULT_WIDTH = 2048;    // 默认宽度（px，与提示词节点同量级）
ImageGenNode.DEFAULT_HEIGHT = 2048;   // 默认高度（px）
ImageGenNode.DEFAULT_TITLE = 'Generate'; // 默认标题（双击标题可自定义）
ImageGenNode.PLACEHOLDER_GAP = 300;   // 占位图与节点右缘的间距（px）
ImageGenNode.PLACEHOLDER_CASCADE = 160; // 多张占位图的对角线级联间距（px）
// 占位图混入配置（GenNodePlaceholder，ADR 053）：API 生图传现成地址
ImageGenNode.PLACEHOLDER_SOURCE = 'image-gen';
ImageGenNode.PLACEHOLDER_NAME_PREFIX = 'image_gen';
ImageGenNode.PLACEHOLDER_INPUT = 'url';
ImageGenNode.MAX_COUNT = 8;           // 同时生成数量的上限（并发请求数）

// 占位图生命周期混入（ADR 053）
Object.assign(ImageGenNode.prototype, GenNodePlaceholder);

// 将 ImageGenNode 类暴露到全局作用域
window.ImageGenNode = ImageGenNode;
