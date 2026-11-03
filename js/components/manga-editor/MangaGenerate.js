/**
 * ==========================================================================
 * MangaEditor 子模块：图像生成（Comfy / API 双模式，自第九个混入）
 * 作用：底栏右侧生成簇——模式分段开关（Comfy|API）+ 生图模型下拉
 *       （仅 API 模式）+「生成」按钮。取代原「写入」按钮：编译后的坐标
 *       提示词直接出图，结果经资产库落「提交时刻的活动页」为图片图层
 *       （2026-11-04 起，页面内容化；原落背景参考层设计退役——切页不串图）。
 * 链路（2026-11-04 起 Comfy 委托右侧面板，ADR 058 修订）：
 *   - Comfy：编辑器不再自带工作流/主模型选择——编译产物写入右侧面板
 *     正面提示词框 2（框 1 留给质量词与 LoRA 触发词块不碰，getPrompts
 *     按框 1→框 2 合并提交）→ 调 promptPanel.comfyRunner.run() 委托
 *     面板提交，负面提示词/LoRA 叠加区/步数 CFG 采样器/负面预设全部
 *     沿用面板现值。不进运行态：运行反馈（按钮三态/任务中心行/停止）
 *     由面板接管；出图经 WS 回流落画布并派发 lumenGeneratedImage，本
 *     模块武装一次性捕获（_consumeGenCapture）把这张图收进参考层。
 *   - API：POST /api/llm/generate-image（画布 API 生图节点同端点），同步
 *     返回 imageUrl 直接收进参考层；尺寸按页面画幅经 LlmResolution 归一
 *     （长边 2K、模型约束钳制）。
 *   - 提示词编译可选（2026-11-04）：编译成功用 MOSS 坐标产物；失败不拦
 *     生成，回落右栏输出框现文当普通提示词，两处皆空才拦下。
 * 状态：模式与 API 模型选择持久化 localStorage——lumenLight.mangaGenMode /
 *       mangaGenModel.api（旧单键 mangaGenModel 首次读取时迁移到 api 键；
 *       comfy: 前缀的旧值随 Comfy 模型选择退役不再消费）。
 * 契约：原型混入（partial-class，ADR 026）——方法 Object.assign 进
 *       MangaEditor.prototype，this 即编辑器实例；须后于主类加载。
 *       fetch/localStorage 用裸全局引用（测试经 vm context 注入桩）。
 * ==========================================================================
 */

// 生图模型下拉选项图标（Feather image，自 MangaAi 移入——只有 API 模式
// 的生图模型清单在用；Comfy 模型图标随 comfy 委托面板退役）
const MANGA_DD_ICON_IMAGE = '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>';

// API 生图默认档位：页面画幅按长边 2K 等比换算（与 LLM 面板默认档一致）
const MANGA_GEN_TIER = '2K';

Object.assign(window.MangaEditor.prototype, {

    // ==================== 生成簇构建（由 MangaDom._buildDom 调用） ====================

    _buildGenerateTools() {
        this.genModeBtns = Array.from(this.dialog.querySelectorAll('.manga-gen-mode'));
        this.genModelSelectBtn = this.dialog.querySelector('.manga-genmodel-select');
        this.genBtn = this.dialog.querySelector('.manga-gen-btn');

        // 模式分段开关
        for (const b of this.genModeBtns) {
            b.addEventListener('click', () => this._setGenMode(b.dataset.mode));
        }

        // 生图模型下拉：仅 API 模式可用（Comfy 模式的工作流/主模型由右侧
        // 面板决定，按钮占位锁定防跳动——与原工作流按钮的 API 态同款）
        this.genModelDropdown = new LumenDropdown(this.genModelSelectBtn, {
            menuClass: 'manga-genmodel-menu',
            placeholder: '生图模型',
            onChange: (v) => this._saveGenModelChoice(this._genMode(), v)
        });

        this.genBtn.addEventListener('click', () => {
            if (this.genRunning) this._stopGenerate();
            else this._runGenerate();
        });

        this._syncGenModeUi();
    },

    // ==================== 模式状态机 ====================

    /** 当前生成模式（localStorage lumenLight.mangaGenMode，默认 comfy） */
    _genMode() {
        return localStorage.getItem('lumenLight.mangaGenMode') === 'api' ? 'api' : 'comfy';
    },

    /** 切模式：持久化 + 界面态 + 模型清单重拉（仅 API 模式消费清单） */
    _setGenMode(mode) {
        if (mode !== 'comfy' && mode !== 'api') return;
        localStorage.setItem('lumenLight.mangaGenMode', mode);
        this._syncGenModeUi();
        this._refreshGenModelDropdown();
        this._status(mode === 'comfy' ? '已切换 Comfy 模式' : '已切换 API 模式');
    },

    /**
     * 模式界面态：分段高亮 + 生图模型下拉占位锁定——Comfy 模式下模型
     * 按钮留在原位（清空显示占位文案 + disabled），不做隐藏避免切换时
     * 整行按钮跳动（原工作流按钮的 API 态同款）；切回 API 从缓存恢复
     * 清单与选中。Comfy 模式的工作流/主模型在右侧面板选择
     */
    _syncGenModeUi() {
        if (!this.genModelDropdown) return;
        const mode = this._genMode();
        for (const b of this.genModeBtns) {
            b.classList.toggle('active', b.dataset.mode === mode);
        }
        const api = mode === 'api';
        if (this.genModelSelectBtn) this.genModelSelectBtn.disabled = !api;
        if (api) {
            this.genModelDropdown.setOptions(
                this._apiModelOptions || [], this._genModelChoice('api'));
        } else {
            this.genModelDropdown.setOptions([], '');
        }
    },

    // ==================== 生图模型（按模式过滤 + 分模式记忆） ====================

    /** 分模式存储键：lumenLight.mangaGenModel.<mode> */
    _genModelStKey(mode) {
        return 'lumenLight.mangaGenModel.' + (mode === 'api' ? 'api' : 'comfy');
    },

    /**
     * 旧单键迁移（lumenLight.mangaGenModel）：按值形态分流——comfy: 前缀
     * 归 comfy 模式、其余归 api 模式，写入分模式键后删除旧键。
     * 形态与当前请求模式不符时不动（留给另一个模式首次读取时消费）
     */
    _migrateLegacyGenModel(mode) {
        const legacy = localStorage.getItem('lumenLight.mangaGenModel');
        if (legacy == null) return '';
        const fits = mode === 'comfy' ? legacy.startsWith('comfy:') : !legacy.startsWith('comfy:');
        if (!fits) return '';   // 形态不符：留给另一模式首次读取时消费
        localStorage.removeItem('lumenLight.mangaGenModel');
        localStorage.setItem(this._genModelStKey(mode), legacy);
        return legacy;
    },

    _genModelChoice(mode) {
        const own = localStorage.getItem(this._genModelStKey(mode));
        if (own != null) return own;
        return this._migrateLegacyGenModel(mode);
    },

    _saveGenModelChoice(mode, v) {
        if (v) localStorage.setItem(this._genModelStKey(mode), v);
        else localStorage.removeItem(this._genModelStKey(mode));
    },

    /**
     * 每次开窗/切模式刷新生图模型下拉：清单只服务 API 模式——
     * /api/settings 生图模型（classifyModel 口径，value 用 m.key）。
     * Comfy 模式不消费清单（工作流/主模型在右侧面板选择，下拉由
     * _syncGenModeUi 占位锁定）。存储的选择失效时清除并回落第一项
     * （setOptions 传 '' 的既有语义）
     */
    async _refreshGenModelDropdown() {
        if (!this.genModelDropdown) return;
        const items = [];
        try {
            const r = await fetch('/api/settings');
            const result = await r.json();
            const api = (result && result.settings && result.settings.api) || {};
            const { models, providerCount } = LumenLight.collectConfiguredModels(api);
            const imageModels = models.filter((m) => LumenLight.classifyModel(m) === 'image');
            items.push(...imageModels.map((m) => ({
                value: m.key,
                label: providerCount > 1
                    ? `${m.displayName || m.id} · ${m.provider}`
                    : (m.displayName || m.id),
                icon: MANGA_DD_ICON_IMAGE
            })));
        } catch { /* 后端不可达：空清单走占位文案 */ }

        this._apiModelOptions = items;    // 缓存：模式切换占位锁定后恢复用
        if (this._genMode() !== 'api') return;   // Comfy 模式：清单待命，不消费
        let selected = this._genModelChoice('api');
        if (selected && !items.some((o) => o.value === selected)) {
            this._saveGenModelChoice('api', '');
            selected = '';
        }
        this.genModelDropdown.setOptions(items, selected);
    },

    // ==================== 生成执行 ====================

    /**
     * 「生成」：编译当前草稿 → 按模式提交。编译可选——成功用编译产物
     * （MOSS 坐标提示词，正路）；失败不阻塞生成，回落右栏输出框现文
     * （用户自写/AI 文案当普通提示词直出），两处皆空才拦下。
     * Comfy 模式委托右侧面板提交（写入框 1 → 触发词补写 → comfyRunner
     * .run()，不进运行态，运行反馈由面板接管）；API 模式直连，运行态
     * 自理（按钮「■ 停止」+ 任务中心行）。结果统一落「提交时刻的活动
     * 页」参考层（API 同步返回直接落；Comfy 经 WS 回流一次性捕获收口）。
     */
    async _runGenerate() {
        if (this.genRunning) return;
        if (!this.compiled?.ok) this._compile();
        let prompt = this.compiled?.ok ? this.compiled.prompt : '';
        if (!prompt) {
            // 编译失败回落：右栏输出框现文（编译失败路径已把旧编译产物
            // 清空，此处只可能是用户/AI 文本，不会误发过期 JSON）
            const err = this.compiled?.error || '未知错误';
            prompt = (this.aiOutTa?.value || '').trim();
            if (prompt) {
                this._status(`编译失败（${err}），改用右栏文本生成`, true);
            } else {
                this._status(`无可用提示词：编译失败（${err}）且右栏为空——先画格写文案，或在右栏直接输入提示词`, true);
                return;
            }
        }

        if (this._genMode() === 'comfy') {
            await this._delegateComfyGenerate(prompt);
            return;
        }

        // ===== API 模式：直连提交，运行态自理 =====
        const pageIdx = this.activePage;          // 结果落提交时刻的页
        const modelKey = (this.genModelDropdown && this.genModelDropdown.value) || '';
        if (!modelKey || modelKey.startsWith('comfy:')) {
            this._status('请先选择 API 生图模型（设置 → API 添加，类型标记 image）', true);
            return;
        }
        const genModel = LumenLight.parseModelKey(modelKey);

        this._setGenRunning(true);
        this._genCaptureArmed = true;
        this._genCapturePage = pageIdx;
        const taskRef = window.taskRegistry ? window.taskRegistry.register({
            kind: 'api',
            label: prompt.length > 40 ? prompt.slice(0, 40) + '…' : prompt,
            total: 1,
            onStop: () => this._stopGenerate()
        }) : null;
        this._genTaskRef = taskRef;
        this._genPromptIds = [];
        this._genController = null;

        try {
            this._genController = new AbortController();
            this._status(`API 生成中…（${this.draft.width}×${this.draft.height} 画幅比例）`);
            // 页面画幅 → 模型可接受尺寸：长边 2K 等比 + 模型约束钳制
            // （gpt-image/seedream 各自的档位与上下限都在约束器里）
            const w = this.draft.width;
            const h = this.draft.height;
            const ratio = window.LlmResolution
                ? window.LlmResolution.simplifyRatio(w, h) : '1:1';
            const adaptive = window.LlmResolution
                ? window.LlmResolution.computeAdaptiveSize(w, h, MANGA_GEN_TIER)
                : { width: w, height: h };
            const size = window.LlmResolution
                ? window.LlmResolution.applyModelResolutionConstraints(
                    genModel.id, adaptive.width, adaptive.height, ratio)
                : adaptive;
            const r = await fetch('/api/llm/generate-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: this._genController.signal,
                body: JSON.stringify({
                    model: genModel.id,
                    provider: genModel.provider || undefined,
                    prompt,
                    size: `${size.width}x${size.height}`
                })
            });
            const result = await r.json();
            if (!r.ok || result.status !== 'ok' || !result.imageUrl) {
                throw new Error((result && result.message) || '未知错误');
            }
            await this._adoptGenerateResult(pageIdx, result.imageUrl);
            this._finishGenerate('done');
        } catch (err) {
            if (typeof GenStopControl !== 'undefined' &&
                GenStopControl.isAbortError && GenStopControl.isAbortError(err)) {
                // 主动停止在 _stopGenerate 里已收尾，这里只吞掉中止异常
                return;
            }
            this._finishGenerate('failed', (err && err.message) || '未知错误');
            this._status('生成失败：' + ((err && err.message) || err), true);
        }
    },

    /**
     * Comfy 模式委托右侧面板提交：编译产物写入面板正面提示词框 2
     * （2026-11-04 用户拍板：框 1 留给质量词与 LoRA 触发词块，编辑器
     * 注入不碰框 1——getPrompts 按框 1→框 2 合并提交，最终正向 =
     * 质量词 + 坐标提示词；框 1 不动即无需触发词补写与宏任务等待，
     * 面板无框 2 的异常形态回落写框 1）→ 武装一次性捕获 → 调
     * comfyRunner.run()。不进运行态——面板按钮三态/任务中心行/停止
     * 全是面板自理，本按钮立即恢复可点（再次点击=再委托一轮，与连点
     * 面板发送同义）；回流经 lumenGeneratedImage 由捕获收进提交时刻的页
     */
    async _delegateComfyGenerate(prompt) {
        const panel = window.promptPanel;
        const pim = window.promptInputManager;
        if (!panel || !pim || !panel.comfyRunner) {
            this._status('提示词面板未初始化，无法委托 Comfy 生成', true);
            return;
        }
        if (!panel.workflowManager.getCurrentWorkflowId()) {
            this._status('请先在右侧 Comfy 面板选择工作流', true);
            return;
        }
        if (pim.posPrompt2) pim.posPrompt2.value = prompt;
        else if (pim.posPrompt) pim.posPrompt.value = prompt;
        this._genCaptureArmed = true;
        this._genCapturePage = this.activePage;
        // 落画布抑制（ADR 071 交付独立）：标记随本次委托武装、消费即清
        // （LumenSocket new-image 默认分支见标记跳过 addImageToCanvas，
        // lumenGeneratedImage 照常派发——本编辑器捕获转存项目夹不受影响）。
        // 60 分钟兜底清防泄漏；委托抛错立即清
        window.__mangaGenSuppress = true;
        clearTimeout(this._genSuppressTimer);
        this._genSuppressTimer = setTimeout(() => { window.__mangaGenSuppress = false; }, 60 * 60 * 1000);
        this._status('已委托右侧面板提交 Comfy，出图自动落当前页参考…');
        try {
            await panel.comfyRunner.run();
        } catch {
            // run() 自身吞提交异常并反馈（状态栏+按钮三态）；走到这里说明
            // 提交未发生——解除武装防后续无关回流被误收进参考层（抑制标
            // 记一并解除）
            this._genCaptureArmed = false;
            window.__mangaGenSuppress = false;
            this._status('面板提交异常，本轮生成未发起', true);
        }
    },

    /** 停止（仅 API 直连路径会进运行态）：中止请求，提交路径收尾。
     *  Comfy 已委托面板——面板任务行/停止按钮自理 */
    _stopGenerate() {
        if (!this.genRunning) return;
        if (this._genController) {
            this._genController.abort();   // fetch 抛 AbortError，提交路径收尾
            this._genController = null;
        }
        this._finishGenerate('stopped', '已停止');
        this._status('已停止生成');
    },

    /** 运行态收尾：解锁按钮、清捕获/计时器、任务中心结算 */
    _finishGenerate(outcome, note) {
        this._setGenRunning(false);
        clearTimeout(this._genTimer);
        this._genTimer = null;
        this._genCaptureArmed = false;
        this._genController = null;
        this._genPromptIds = [];
        if (this._genTaskRef) {
            this._genTaskRef.end(outcome, note || '');
            this._genTaskRef = null;
        }
    },

    _setGenRunning(running) {
        this.genRunning = running;
        if (!this.genBtn) return;
        this.genBtn.classList.toggle('running', running);
        this.genBtn.textContent = running ? '■ 停止' : '生成';
    },

    // ==================== 结果落参考层 ====================

    /**
     * 一次性回流捕获（MangaBackground._onGeneratedImage 优先询问）：
     * 运行中收到下一张生成图即为本轮结果——收进提交时刻的页并结算任务。
     * canvasImg = 回流事件携带的画布图对象（PlaceholderManager 派发时带，
     * LumenSocket 免节点路径没有）——记到层上供保存写回定位画布对应图。
     * 返回 true 表示该图已被消费（开关透显路径跳过）
     */
    _consumeGenCapture(src, canvasImg) {
        if (!this._genCaptureArmed) return false;
        this._genCaptureArmed = false;
        window.__mangaGenSuppress = false;   // 落画布抑制随消费解除（ADR 071）
        clearTimeout(this._genSuppressTimer);
        const pageIdx = this._genCapturePage;
        this._finishGenerate('done');
        this._adoptGenerateResult(pageIdx, src, canvasImg);
        return true;
    },

    /**
     * 生成图转存当前项目（ADR 071 交付独立）：有项目时把生成结果
     * （data: URL 或 http(s)/本站路径）POST 到 /api/manga-projects/:id/images
     * 落 images/ 文件夹，返回项目内静态路径；无项目或转存失败回落原 src
     * （adopt 的资产库兜底通道继续兜底）
     */
    async _transferGenImage(src) {
        if (!this.currentProjectId) return src;
        try {
            const payload = src.startsWith('data:') ? { dataUrl: src } : { url: src };
            const r = await fetch('/api/manga-projects/' + encodeURIComponent(this.currentProjectId) + '/images', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await r.json().catch(() => null);
            if (r.ok && result && result.status === 'ok' && result.path) return result.path;
            this._status('生成图转存项目失败：' + ((result && result.message) || r.status), true);
        } catch (err) {
            this._status('生成图转存项目失败：' + (err && err.message ? err.message : err), true);
        }
        return src;
    },

    /**
     * 生成图入指定页：2026-11-04 用户拍板改为**落成图片图层**（页面内容
     * 化——可选中/拖动/缩放/抠图/调不透明度，想描图把该层不透明度调低），
     * 取代原「落背景参考层」设计（背景参考层保留给手动上传的参照图）。
     * 提交时刻的页与当前活动页可能已不同——活动页走 _addImageLayer 完整
     * 路径（入历史/自动选中/面板跟随）；异页直写该页层栈（不入页级历史，
     * 与旧直写背景行为一致）+ 存档 + 刷新缩略图。非稳定引用先入资产库
     * 换 URL（复用 MangaBackground 的上传通道）
     */
    async _adoptGenerateResult(pageIdx, src, canvasImg) {
        const page = this.pages && this.pages[pageIdx];
        if (!page) { this._status('生成图无处安放（页面已不存在）', true); return; }
        try {
            src = await this._transferGenImage(src);   // 有项目：转存项目夹（ADR 071）
            let url = src;
            if (!src.startsWith('/api/assets/') && !src.startsWith('/api/manga-projects/')) {
                const dataUrl = await window.ImageExport.toDataUrl(null, src);
                url = await this._uploadToAssets(dataUrl, `manga-gen-${Date.now()}.png`);
            }
            const dim = await new Promise((res, rej) => {
                const img = new Image();
                img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
                img.onerror = () => rej(new Error('结果图解码失败'));
                img.src = url;
            });
            let layer = null;
            if (pageIdx === this.activePage) {
                layer = this._addImageLayer(url, dim.w, dim.h, '生成落图');
                this._status('生成图已落当前页图层');
            } else {
                layer = this._addImageLayerToPage(page, url, dim.w, dim.h);
                this._status(`生成图已落第 ${pageIdx + 1} 页图层`);
            }
            // 画布对应图溯源（保存写回定位用）：回流事件携带画布图对象时
            // 记其 id；fromSrc 已由 _makeImageLayerRecord 盖戳
            if (layer && layer.image && canvasImg && canvasImg.id) {
                layer.image.canvasImgId = canvasImg.id;
            }
        } catch (err) {
            this._status('生成图落图层失败：' + (err && err.message ? err.message : err), true);
        }
    },
});
