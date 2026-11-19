/**
 * LayerSplit 子模块：窗口 DOM 与取图（Object.assign 进 LayerSplit.prototype）
 * 壳复用 recipe-dialog 体系（与 LoRA 管理器同尺寸观感）；取图三通道：
 * 画布选中图 / 本地文件 / 拖拽入窗。模型设置行渲染也在此（pick 阶段侧栏）
 */

// 图标小片段（Feather 风格，与顶栏工具钮同族）
const LS_ICONS = {
    eye: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
    trash: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    up: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>',
    down: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    scissors: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>',
    droplet: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>',
    cloud: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>',
    restore: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>'
};

Object.assign(LayerSplit.prototype, {

    _buildDom() {
        const el = document.createElement('div');
        el.className = 'recipe-dialog layer-split-dialog';
        el.innerHTML = `
            <div class="recipe-dialog-panel">
                <header class="recipe-dialog-header">
                    <div class="recipe-dialog-title-group">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m12 8 4 4-4 4-4-4z"/></svg>
                        <h2>图层拆分</h2>
                    </div>
                    <button class="recipe-dialog-close" type="button" title="关闭图层拆分" aria-label="关闭图层拆分窗口"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                </header>
                <div class="ls-toolbar">
                    <button type="button" class="ls-btn ls-act-restore ls-hidden" title="恢复上次保存的会话（原图、识别框、图层原样回来，不用重新识别）"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>恢复上次</button>
                    <button type="button" class="ls-btn ls-act-canvas-pick" title="取画布当前选中的图片（未选中时提示）">取画布选中图</button>
                    <button type="button" class="ls-btn ls-act-upload" title="从本地选择 PNG / JPG / WebP 图片">上传图片</button>
                    <button type="button" class="ls-btn primary ls-act-detect" title="调用视觉模型识别前景元素（按 token 计费，很便宜）" disabled>开始识别</button>
                    <button type="button" class="ls-btn ls-act-add-box" title="画框模式开关：开启后在图上连续拉框（点在已有框上也画新框），再点一次或按 Esc 退出">＋添加框</button>
                    <button type="button" class="ls-btn ls-act-redetect" title="重新调用视觉模型识别（当前手调的框会被覆盖）">重新识别</button>
                    <button type="button" class="ls-btn primary ls-act-split" title="按勾选的框裁切出图层进入编辑（本地操作，不花 API）">拆分为图层</button>
                    <button type="button" class="ls-btn primary ls-act-ai-split" title="API 两调管线：第 1 调用补齐模型整图提取全部主体（透明底），按框裁出图层；第 2 调补齐背景。共 2 次调用">AI 拆图</button>
                    <button type="button" class="ls-btn primary ls-act-ai-split-precise" title="逐层精抠（API）：每个勾选框单独调用一次补齐模型，点名提取该元素成透明图层（带遮挡补全）——N 个元素 N 次调用，按张计费">逐层精抠</button>
                    <button type="button" class="ls-btn ls-act-recalibrate" title="回到校准阶段重新调整框（图层弃重置）">重新校准</button>
                    <button type="button" class="ls-btn ls-act-inpaint" title="把被前景遮住的背景补齐：挖透明送图像编辑模型，局部合成只动洞区（按张计费）">AI 补齐背景</button>
                    <button type="button" class="ls-btn ls-act-cutout-all" title="对全部可见切片依次跑本地 AI 抠图去背景（背景层不参与；单个切片也可在右栏单独抠）">全部抠图</button>
                    <button type="button" class="ls-btn ls-act-download" title="把当前可见图层合成为一张 PNG 下载">下载 PNG</button>
                    <button type="button" class="ls-btn primary ls-act-canvas-send" title="可见图层分层落到画布：背景垫底、切片按原位摆放（各自独立可拖动）">落画布</button>
                    <button type="button" class="ls-btn ls-act-save" title="保存当前会话到本机（IndexedDB）：F5 / 重开浏览器后在取图阶段点「恢复上次」继续，不用重新识别"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>保存</button>
                    <button type="button" class="ls-btn ls-act-change-image" title="换一张图重新开始（当前成果丢弃）">换图</button>
                    <button type="button" class="ls-layout-btn" title="布局：窄化本窗口露出右侧 Comfy 面板" aria-label="切换布局模式"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg><span>布局</span></button>
                </div>
                <div class="ls-status"></div>
                <div class="ls-content">
                    <div class="ls-main">
                        <div class="ls-pick">
                            <div class="ls-pick-drop">
                                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                                <div>把图片拖到这里，或点上方「上传图片」/「取画布选中图」</div>
                                <div>支持 PNG / JPG / WebP，最长边 ≤ ${LayerSplit.MAX_IMAGE_EDGE}px</div>
                            </div>
                        </div>
                        <div class="ls-preview-wrap ls-hidden">
                            <div class="ls-preview-box"></div>
                        </div>
                        <div class="ls-stage-wrap ls-hidden">
                            <canvas class="ls-stage-cv"></canvas>
                        </div>
                    </div>
                    <aside class="ls-side">
                        <div class="ls-side-panel">
                            <div class="ls-side-header">模型设置</div>
                            <div class="ls-side-body"></div>
                        </div>
                        <div class="ls-side-rail">
                            <button type="button" class="ls-rail-btn ls-rail-model" title="模型设置（识别/补齐模型与提示词，全阶段可用）"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg></button>
                            <button type="button" class="ls-rail-btn ls-rail-boxes" title="识别结果（校准框列表）"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"/><path d="M1 6.13L16 6a2 2 0 0 1 2 2v15"/></svg></button>
                            <button type="button" class="ls-rail-btn ls-rail-layers" title="图层列表"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg></button>
                        </div>
                    </aside>
                </div>
            </div>
        `;
        document.body.appendChild(el);
        this.dialog = el;
        this.statusEl = el.querySelector('.ls-status');
        this.previewBox = el.querySelector('.ls-preview-box');
        this.stageCv = el.querySelector('.ls-stage-cv');
        this.sideHeader = el.querySelector('.ls-side-header');
        this.sideBody = el.querySelector('.ls-side-body');
        el.querySelector('.recipe-dialog-close').addEventListener('click', () => this.hide());

        // 布局开关（2026-11-14，LumenLayoutPanel 预制件，同 LoRA/提示词/
        // 漫画/坐标编辑器五处收敛）：默认全屏（坐标编辑器同款——壳无条件
        // 吃 --ls-gap 变量、默认 0px，cssClass=null 只动变量），布局钮开=
        // 右缘拉出留白露出右侧 Comfy 面板、关=0px 全屏。留白改变宿主宽度
        // → onChange 里把预览图/舞台重新 contain 适配
        this._layout = new LumenLayoutPanel({
            button: el.querySelector('.ls-layout-btn'),
            dialog: () => this.dialog,
            storageKey: 'lumen.layerSplitLayout',
            cssClass: null,
            gapVar: '--ls-gap',
            offGap: '0px',
            onChange: () => {
                if (!this.visible) return;
                const img = this.previewBox && this.previewBox.querySelector('img');
                if (img && this.sourceImage) {
                    this._fitToWrap(img, this.sourceImage.width, this.sourceImage.height);
                    this._renderPreviewBoxes();
                }
                if (this.phase === 'edit') this._renderStage();
            }
        });
        // 侧栏图标轨：点谁显谁（漫画编辑器右侧工具轨同款交互）
        el.querySelector('.ls-rail-model').addEventListener('click', () => { this._sideView = 'model'; this._renderSide(); });
        el.querySelector('.ls-rail-boxes').addEventListener('click', () => { this._sideView = 'boxes'; this._renderSide(); });
        el.querySelector('.ls-rail-layers').addEventListener('click', () => { this._sideView = 'layers'; this._renderSide(); });

        // 隐藏 file input（value 置空支持重复选同一文件）
        this._fileInput = document.createElement('input');
        this._fileInput.type = 'file';
        this._fileInput.accept = 'image/png,image/jpeg,image/webp';
        this._fileInput.style.display = 'none';
        this._fileInput.addEventListener('change', () => {
            const file = this._fileInput.files && this._fileInput.files[0];
            this._fileInput.value = '';
            if (file) this._loadLocalImage(file);
        });
        document.body.appendChild(this._fileInput);

        // 拖拽入窗（dragover 必须 preventDefault 才能触发 drop）
        const dropZone = el.querySelector('.ls-pick-drop');
        el.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('dragover');
        });
        el.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
        el.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (file && /^image\//.test(file.type)) this._loadLocalImage(file);
        });

        // 工具行接线
        el.querySelector('.ls-act-restore').addEventListener('click', () => this._restoreSessionClick());
        el.querySelector('.ls-act-canvas-pick').addEventListener('click', () => this._pickCanvasImage());
        el.querySelector('.ls-act-upload').addEventListener('click', () => this._fileInput.click());
        el.querySelector('.ls-act-detect').addEventListener('click', () => this._startDetect());
        el.querySelector('.ls-act-add-box').addEventListener('click', () => this._toggleDrawMode());
        el.querySelector('.ls-act-redetect').addEventListener('click', () => this._startDetect());
        el.querySelector('.ls-act-split').addEventListener('click', () => this._splitToLayers());
        el.querySelector('.ls-act-ai-split').addEventListener('click', () => this._runAiSplit());
        el.querySelector('.ls-act-ai-split-precise').addEventListener('click', () => this._runAiSplitPrecise());
        el.querySelector('.ls-act-recalibrate').addEventListener('click', () => this._backToCalibrate());
        el.querySelector('.ls-act-inpaint').addEventListener('click', () => this._runInpaint());
        el.querySelector('.ls-act-cutout-all').addEventListener('click', () => this._cutoutAllLayers());
        el.querySelector('.ls-act-download').addEventListener('click', () => this._downloadPng());
        el.querySelector('.ls-act-canvas-send').addEventListener('click', () => this._sendToCanvas());
        el.querySelector('.ls-act-save').addEventListener('click', () => this._saveSessionClick());
        el.querySelector('.ls-act-change-image').addEventListener('click', () => this._changeImage());
        this._wireStageGestures();   // 舞台手势一次接线（编辑阶段复用）
    },

    /** 侧栏渲染收口（2026-11-13 用户反馈：上传后就没法选模型了）：右侧栏
     *  改漫画编辑器式图标轨——「模型设置」全阶段可切，「识别结果」校准阶段
     *  出现、「图层」编辑阶段出现；this._sideView 决定面板内容，阶段切换
     *  只重置默认值（_setPhase），用户手选的视图不被删框等刷新踢掉 */
    _renderSide() {
        if (!this.dialog) return;
        const rail = {
            model: this.dialog.querySelector('.ls-rail-model'),
            boxes: this.dialog.querySelector('.ls-rail-boxes'),
            layers: this.dialog.querySelector('.ls-rail-layers'),
        };
        // 轨按钮按阶段显隐 + 高亮当前视图
        rail.model.classList.remove('ls-hidden');
        rail.boxes.classList.toggle('ls-hidden', this.phase !== 'calibrate');
        rail.layers.classList.toggle('ls-hidden', this.phase !== 'edit');
        for (const [key, el] of Object.entries(rail)) {
            el.classList.toggle('on', this._sideView === key);
        }
        // 视图与阶段不匹配（阶段切换残留）→ 回到该阶段默认
        const defaults = { pick: 'model', calibrate: 'boxes', edit: 'layers' };
        if (this._sideView !== 'model' && defaults[this.phase] !== this._sideView) {
            this._sideView = defaults[this.phase];
        }
        const headEl = this.dialog.querySelector('.ls-side-header');
        const bodyEl = this.dialog.querySelector('.ls-side-body');
        if (this._sideView === 'boxes') {
            headEl.textContent = `识别结果（${this.boxes.length}）`;
            this._renderBoxList(bodyEl);
        } else if (this._sideView === 'layers') {
            headEl.textContent = `图层（${this.layers.length}）`;
            this._renderLayerPanel(bodyEl);
        } else {
            headEl.textContent = '模型设置';
            this._renderModelSettings(bodyEl);
        }
    },

    /** pick 阶段侧栏：模型设置。顶部 Comfy|API 分段开关（漫画编辑器同款，
     *  2026-11-13 用户拍板：补齐+抠图两环节随通道切换）——
     *  - API：补齐模型下拉（图像类清单）+云端抠图（用补齐模型去背景）
     *  - Comfy：补齐工作流下拉（画布工作流清单 /api/workflows）+本地 rembg
     *  识别恒走 API（本地没有视觉定位链路）。识别取对话/视觉类清单、
     *  补齐取图像类清单（LumenLight.collectConfiguredModels + classifyModel
     *  统一口径）；value 用「厂商||模型」复合键，请求时拆包显式路由 */
    _renderModelSettings(bodyEl) {
        const mode = this._mode();
        bodyEl.innerHTML = `
            <div class="ls-mode-row">
                <div class="ls-mode-switch">
                    <button type="button" class="ls-mode-btn" data-mode="comfy">Comfy</button>
                    <button type="button" class="ls-mode-btn" data-mode="api">API</button>
                </div>
                <span class="ls-mode-desc">${mode === 'comfy' ? '本地' : '云端'}</span>
            </div>
            <div class="ls-model-rows">
                <div class="ls-model-row">
                    <label>识别模型</label>
                    <button type="button" class="ls-model-dd ls-detect-dd"></button>
                </div>
                <div class="ls-model-row">
                    <label>${mode === 'comfy' ? '补齐工作流' : '补齐模型'}</label>
                    <button type="button" class="ls-model-dd ls-inpaint-dd"></button>
                </div>
                <div class="ls-model-row">
                    <label>抠图通道</label>
                    <span class="ls-cutout-channel">剪刀=本地 rembg（免费）· 水滴=色键去底（纯色底）· ☁=AI 抠图（用补齐模型，按张计费）</span>
                </div>
            </div>
            <div class="ls-model-hint" style="margin-top:10px;">
                ${mode === 'comfy'
                    ? 'Comfy 模式：补齐把挖洞图直注进所选工作流的 LoadImage 节点跑本地 ComfyUI（免费）；工作流需含 LoadImage 和 SaveImage。抠图走本地抠图模型，不花钱。'
                    : 'API 模式：选项来自「设置 → API」里已配置厂商的模型清单（识别=对话/视觉类，补齐=图像类）。识别按 token 计费很便宜；补齐/☁ AI 抠图按张计费（约 0.3 元/张）；剪刀走本地 rembg 模型不花钱（模型未下载先到 设置 → 抠图 下载，纯色底也可用水滴「本地去底」）。'}
            </div>
            <div class="ls-model-hint" style="margin-top:10px;">
                流程：取图 → 识别（花钱）→ 校准框 → 拆分为图层（免费）→
                需要干净背景就 AI 补齐 → 落画布 / 下载。
            </div>
        `;
        bodyEl.querySelectorAll('.ls-mode-btn').forEach((b) => {
            b.classList.toggle('active', b.dataset.mode === mode);
            b.addEventListener('click', () => this._setMode(b.dataset.mode));
        });
        this._detectDd = new LumenDropdown(bodyEl.querySelector('.ls-detect-dd'), {
            menuClass: 'ls-model-menu',
            placeholder: '选择识别模型',
            onChange: (v) => {
                this.detectModel = v;
                localStorage.setItem('lumen.layerSplit.detectModel', v);
            }
        });
        const inpaintBtn = bodyEl.querySelector('.ls-inpaint-dd');
        if (mode === 'comfy') {
            this._workflowDd = new LumenDropdown(inpaintBtn, {
                menuClass: 'ls-model-menu',
                placeholder: '选择补齐工作流',
                onChange: (v) => {
                    this.comfyWorkflowId = v;
                    localStorage.setItem('lumen.layerSplit.comfyWorkflow', v);
                }
            });
            this._refreshWorkflowDropdown();
        } else {
            this._inpaintDd = new LumenDropdown(inpaintBtn, {
                menuClass: 'ls-model-menu',
                placeholder: '选择补齐模型',
                onChange: (v) => {
                    this.inpaintModel = v;
                    localStorage.setItem('lumen.layerSplit.inpaintModel', v);
                }
            });
            this._refreshModelDropdowns();
        }
        this._renderPromptEditor(bodyEl);
    },

    /** 提示词编辑区（2026-11-13 用户拍板：识别+补齐两套都可编辑，对应
     *  原库 slice-detection / 背景修补两段提示词的分工；提取提示词随 AI
     *  拆图上线加入，仅 API 模式显示）：预填内置模板，支持
     *  {{width}}/{{height}} 占位符；清空=回到内置默认；存值与模板一字不差
     *  视为未自定义不落存储（内置模板改进可跟进） */
    _renderPromptEditor(bodyEl) {
        bodyEl.appendChild(this._buildPromptEditorBlock({
            name: '识别', label: '识别提示词（找元素规则）', rows: 9,
            storageKey: 'lumen.layerSplit.detectPrompt',
            template: () => LayerSplit.DETECT_PROMPT_TEMPLATE,
            get: () => this.detectPrompt,
            set: (v) => { this.detectPrompt = v; }
        }));
        bodyEl.appendChild(this._buildPromptEditorBlock({
            name: '补齐', label: '补齐提示词（背景还原指令）', rows: 5,
            storageKey: 'lumen.layerSplit.inpaintPrompt',
            template: () => LayerSplit.INPAINT_PROMPT_TEMPLATE,
            get: () => this.inpaintPrompt,
            set: (v) => { this.inpaintPrompt = v; }
        }));
        if (this._mode() === 'api') {
            bodyEl.appendChild(this._buildPromptEditorBlock({
                name: '提取', label: '提取提示词（AI 拆图第 1 调）', rows: 6,
                storageKey: 'lumen.layerSplit.extractPrompt',
                template: () => LayerSplit.EXTRACT_PROMPT_TEMPLATE,
                get: () => this.extractPrompt,
                set: (v) => { this.extractPrompt = v; }
            }));
            bodyEl.appendChild(this._buildPromptEditorBlock({
                name: '精抠', label: '精抠提示词（逐层精抠，逐元素点名提取）', rows: 7,
                storageKey: 'lumen.layerSplit.precisePrompt',
                placeholderHint: '支持 {{name}} / {{kind}} 占位符（随元素替换为名称与类型）',
                template: () => LayerSplit.PRECISE_PROMPT_TEMPLATE,
                get: () => this.precisePrompt,
                set: (v) => { this.precisePrompt = v; }
            }));
        }
    },

    _buildPromptEditorBlock(cfg) {
        const block = document.createElement('div');
        block.className = 'ls-prompt-block';
        block.innerHTML = `
            <div class="ls-prompt-head">
                <span>${this._escapeHtml(cfg.label)}</span>
                <button type="button" class="ls-prompt-reset" title="恢复内置默认${cfg.name}提示词">恢复默认</button>
            </div>
            <textarea class="ls-prompt-ta" spellcheck="false"
                placeholder="留空使用内置默认${cfg.name}提示词；${cfg.placeholderHint || '{{width}} / {{height}} 会替换为实际图片尺寸'}"></textarea>
        `;
        const ta = block.querySelector('.ls-prompt-ta');
        ta.rows = cfg.rows;
        ta.value = cfg.get() || cfg.template();
        ta.addEventListener('change', () => {
            const val = ta.value.trim();
            const custom = val === cfg.template() ? '' : val;
            cfg.set(custom);
            if (custom) localStorage.setItem(cfg.storageKey, custom);
            else localStorage.removeItem(cfg.storageKey);
            this.status(custom ? `已保存自定义${cfg.name}提示词` : `已恢复内置默认${cfg.name}提示词`);
        });
        block.querySelector('.ls-prompt-reset').addEventListener('click', () => {
            ta.value = cfg.template();
            cfg.set('');
            localStorage.removeItem(cfg.storageKey);
            this.status(`已恢复内置默认${cfg.name}提示词`);
        });
        return block;
    },

    /** 拉设置 → 组两份清单 → 存量值迁移 → setOptions。
     *  存量迁移：复合键失效（模型被删/厂商改）按裸 id 匹配；裸名旧值/
     *  手动名不在清单时注入「（手动）」项保留可用 */
    async _refreshModelDropdowns() {
        let chatItems = [], imageItems = [], providerCount = 0;
        try {
            const r = await fetch('/api/settings');
            const result = await r.json();
            const api = (result && result.settings && result.settings.api) || {};
            const collected = LumenLight.collectConfiguredModels(api);
            providerCount = collected.providerCount;
            const label = (m) => providerCount > 1
                ? `${m.displayName || m.id} · ${m.provider}`
                : (m.displayName || m.id);
            chatItems = collected.models
                .filter((m) => LumenLight.classifyModel(m) === 'chat')
                .map((m) => ({ value: m.key, label: label(m) }));
            imageItems = collected.models
                .filter((m) => LumenLight.classifyModel(m) === 'image')
                .map((m) => ({ value: m.key, label: label(m) }));
        } catch { /* 后端不可达：空清单走 placeholder */ }
        const detectSel = this._migrateModelChoice(chatItems, this.detectModel);
        const inpaintSel = this._migrateModelChoice(imageItems, this.inpaintModel);
        this.detectModel = detectSel;
        this.inpaintModel = inpaintSel;
        if (this._detectDd) {
            this._detectDd.setOptions(chatItems,
                chatItems.some((o) => o.value === detectSel) ? detectSel : '');
        }
        if (this._inpaintDd) {
            this._inpaintDd.setOptions(imageItems,
                imageItems.some((o) => o.value === inpaintSel) ? inpaintSel : '');
        }
    },

    /** 存量选择迁移到当前清单：命中原样；复合键失效按裸 id 匹配；裸名
     *  旧值/手动名注入「（手动）」项。返回应保留的存储值 */
    _migrateModelChoice(items, stored) {
        const val = String(stored || '').trim();
        if (!val) return '';
        if (items.some((o) => o.value === val)) return val;
        const byId = items.find((o) => o.value.endsWith('||' + val));
        if (byId) return byId.value;
        items.unshift({ value: val, label: `${val}（手动）` });
        return val;
    },

    /** 模型选择值 → {provider, id}：「厂商||模型」复合键拆包；裸名（手动
     *  项/旧存储）provider 留空走后端自动路由。LumenLight 是 config.js
     *  顶层 const（裸全局，不挂 window）——必须裸名引用 */
    _parseModelChoice(stored) {
        if (typeof LumenLight !== 'undefined' && LumenLight.parseModelKey) {
            const parsed = LumenLight.parseModelKey(stored);
            if (parsed && parsed.id) return parsed;
        }
        return { provider: '', id: String(stored || '').trim() };
    },

    // ==================== 取图 ====================

    /** 取画布当前选中的图（未选中提示；多选取第一张） */
    _pickCanvasImage() {
        const images = (window.canvas && window.canvas.images && window.canvas.images.images) || [];
        const picked = images.find((im) => im.selected && im.img && !im.videoEl) || null;
        if (!picked) {
            this.status('画布上没有选中的图片——先在画布点选一张图，或用「上传图片」', true);
            return;
        }
        const img = picked.img;
        if (!img.naturalWidth) {
            this.status('选中的画布图尚未加载完成，请稍后重试', true);
            return;
        }
        this._adoptSourceImage(img.src, img.naturalWidth, img.naturalHeight,
            picked.name || 'canvas-image');
    },

    _loadLocalImage(file) {
        if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
            this.status('仅支持 PNG / JPG / WebP 图片', true);
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = String(reader.result || '');
            const img = new Image();
            img.onload = () => {
                this._adoptSourceImage(dataUrl, img.naturalWidth, img.naturalHeight, file.name);
            };
            img.onerror = () => this.status('图片解码失败', true);
            img.src = dataUrl;
        };
        reader.onerror = () => this.status('读取本地文件失败', true);
        reader.readAsDataURL(file);
    },

    /** 接纳来源图：尺寸校验 → 记状态 → 预览 → 停在校准阶段等识别 */
    _adoptSourceImage(dataUrl, width, height, name) {
        if (Math.max(width, height) > LayerSplit.MAX_IMAGE_EDGE) {
            this.status(`图片 ${width}×${height} 超过上限（最长边 ${LayerSplit.MAX_IMAGE_EDGE}px），请先缩小`, true);
            return;
        }
        this.sourceImage = { dataUrl, width, height, name: name || 'image' };
        this.boxes = [];
        this.activeBoxId = null;
        this.layers = [];
        this.activeLayerId = null;
        // 预览：img 元素按容器 contain 缩放（框叠加按显示比例换算）
        this.previewBox.innerHTML = '';
        const img = document.createElement('img');
        img.src = dataUrl;
        img.alt = name || '';
        this.previewBox.appendChild(img);
        this.dialog.querySelector('.ls-act-detect').disabled = false;
        this.status(`已载入 ${name || '图片'}（${width}×${height}），点「开始识别」让模型找前景元素`);
        this._setPhase('calibrate');
        this._fitToWrap(img, width, height);   // 先显阶段（wrap 才有尺寸）再适配
        this._resetHistory();   // 新图=新基线，旧图历史不跨图
    },

    /** 换图：清空全部成果回取图阶段 */
    _changeImage() {
        this.sourceImage = null;
        this.boxes = [];
        this.activeBoxId = null;
        this.layers = [];
        this.activeLayerId = null;
        this.previewBox.innerHTML = '';
        this.dialog.querySelector('.ls-act-detect').disabled = true;
        this._setPhase('pick');
        this._resetHistory();   // 清空=新基线
        this.status('已清空，取一张新图');
    },
});
