/**
 * ==========================================================================
 * LayerSplit 图层拆分窗口（2026-11-13）
 * 作用：顶栏「拆图」按钮（LoRA 管理器左边）弹出编辑器窗口，把一张 UI 图
 *       拆成多个图层：VLM 识别前景元素（像素坐标 bbox）→ 用户校准 →
 *       本地裁切成图层（背景层=整图垫底）→ 可选 AI 补齐被前景遮住的
 *       背景（挖透明 + 图像编辑模型，局部合成保原始像素）→ 分层落画布 /
 *       合成下载。窗口本身是带图层的编辑器（用户拍板：拆出的图层就在
 *       本编辑器里）。
 * 链路（后端零改动，全部复用现有通道）：
 *   - 识别：POST /api/llm/chat，images=[整图 dataURL]（后端转多模态
 *     content 数组），provider 留空——由后端 resolveProviderConfig 按
 *     模型名在设置 → API 的厂商清单里解析（用户拍板：厂商走画布 API
 *     配置、Key 用设置里的）
 *   - 补齐：POST /api/llm/generate-image，images=[挖洞图]（dashscope
 *     适配器"图片在前文本在后"=编辑形态，Qwen-Image-Edit 同构）；远程
 *     返回经 /api/llm/download-image 代理转 dataURL（canvas 合成防 tainted）
 *   - 落画布：切片 dataURL 先 POST /api/assets 内容寻址转稳定 URL，
 *     再 window.canvas.images.addImage 分层原位摆放
 * 三阶段状态机：pick（取图+模型设置）→ calibrate（识别结果校准框）→
 *   edit（图层编辑舞台）。
 * 原理参考：github.com/50kg/image-to-slice（VLM 语义规划 + 生图模型修补，
 *   零本地模型）；bbox 坐标防御式解析（剥围栏/白名单/clamp/最小尺寸）
 *   抽成静态纯函数（LayerSplit.parseDetectResult 等，vm 可测）。
 * 契约：主类 + layer-split/ 子目录混入（Object.assign 进 prototype，
 *   ADR 026 partial-class 同款），子模块须后于主类加载。
 * ==========================================================================
 */

class LayerSplit {
    constructor() {
        // 顶栏按钮：注入中段工具区，插在 LoRA 管理器按钮左边（app.js 在
        // LoraManager 之后实例化本类，故 loraManager.btn 已就位）
        this.btn = null;
        const center = document.getElementById('topToolbarCenter');
        if (center) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'top-toolbar-btn';
            b.title = '图层拆分：把一张 UI 图拆成多个图层（VLM 识别前景元素 + AI 补齐被遮挡背景）';
            b.setAttribute('aria-haspopup', 'dialog');
            b.setAttribute('aria-expanded', 'false');
            b.innerHTML = `
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m12 8 4 4-4 4-4-4z"/></svg>
                <span>拆图</span>
            `;
            b.addEventListener('click', () => this.toggle());
            const loraBtn = (window.loraManager && window.loraManager.btn) || null;
            if (loraBtn && loraBtn.parentNode === center) center.insertBefore(b, loraBtn);
            else center.insertBefore(b, center.firstChild);   // 兜底：LoRA 按钮不在时插最左
            this.btn = b;
        }

        this.dialog = null;          // 弹窗 DOM（懒建）
        this.visible = false;

        // ===== 三阶段状态机 =====
        this.phase = 'pick';         // 'pick' | 'calibrate' | 'edit'
        this.sourceImage = null;     // { dataUrl, width, height, name }
        this.boxes = [];             // 校准框 [{ id, name, kind, bbox:[x,y,w,h], keep }]
        this.activeBoxId = null;
        this.layers = [];            // 图层 [{ id, name, kind:'background'|'slice', src, bbox:[x,y,w,h], visible, opacity }]
        this.activeLayerId = null;
        this._hasSaved = false;      // IndexedDB 里有没有已存会话（决定「恢复上次」显隐）
        this._savedAt = null;
        this._sideView = 'model';    // 右侧栏当前视图：'model' | 'boxes' | 'layers'（漫画编辑器式图标轨切换）
        this.comfyWorkflowId = localStorage.getItem('lumen.layerSplit.comfyWorkflow') || '';
        this._history = [];          // 快照式撤销（画布同款）：初始状态+每次变更后各一份
        this._historyIndex = -1;
        this._boxSeq = 1;
        this._layerSeq = 1;

        // 模型配置（用户拍板：窗内可切换、厂商留空走设置里的 Key）——
        // 默认值预填百炼系，模型名须已在设置 → API 对应厂商的清单里
        //（或命中回落当前厂商），解析失败状态栏会提示
        this.detectModel = localStorage.getItem('lumen.layerSplit.detectModel') || 'qwen-vl-max-latest';
        this.inpaintModel = localStorage.getItem('lumen.layerSplit.inpaintModel') || 'qwen-image-edit';
        // 自定义提示词（空=内置默认；{{width}}/{{height}} 占位符随图替换）
        this.detectPrompt = localStorage.getItem('lumen.layerSplit.detectPrompt') || '';
        this.inpaintPrompt = localStorage.getItem('lumen.layerSplit.inpaintPrompt') || '';
        this.extractPrompt = localStorage.getItem('lumen.layerSplit.extractPrompt') || '';
        this.precisePrompt = localStorage.getItem('lumen.layerSplit.precisePrompt') || '';
        this._detectRunning = false;   // 识别防重入（按钮互切停止态）
        this._inpaintRunning = false;
        this._preciseRunning = false;   // 逐层精抠防重入

        // ESC 优先退画框模式、再关窗；Ctrl+Z / Ctrl+Shift+Z(或 Ctrl+Y) 撤销重做
        // （快照式，画布同款；焦点在输入框时放行原生文字撤销）；Delete 删除
        // 选中校准框（焦点在输入框/文本域时不劫持，那是原生的文字删除）
        this._onKeyDown = (e) => {
            if (!this.visible) return;
            if (e.key === 'Escape') {
                if (this._drawMode) {
                    this._exitDrawMode();
                    this.status('已退出画框模式');
                    return;
                }
                this.hide();
                return;
            }
            if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
                const ae0 = document.activeElement;
                if (ae0 && (ae0.tagName === 'INPUT' || ae0.tagName === 'TEXTAREA' ||
                    ae0.tagName === 'SELECT' || ae0.isContentEditable)) return;   // 文字撤销归原生
                if (this._drawMode || this._detectRunning ||
                    this._inpaintRunning || this._cutoutRunning ||
                    this._aiSplitRunning || this._preciseRunning) return;   // 手头有活不搅
                e.preventDefault();
                if (e.key === 'y' || e.key === 'Y' || e.shiftKey) this._redo();
                else this._undo();
                return;
            }
            if (e.key === 'Delete' && this.phase === 'calibrate' && this.activeBoxId != null) {
                const ae = document.activeElement;
                if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' ||
                    ae.tagName === 'SELECT' || ae.isContentEditable)) return;
                const box = this.boxes.find((b) => b.id === this.activeBoxId);
                if (box) {
                    e.preventDefault();
                    this._deleteBox(box);
                }
            }
        };
        document.addEventListener('keydown', this._onKeyDown);
    }

    toggle() { this.visible ? this.hide() : this.show(); }

    show() {
        if (!this.dialog) this._buildDom();
        this.dialog.classList.add('is-open');
        this.visible = true;
        if (this.btn) this.btn.setAttribute('aria-expanded', 'true');
        if (this._layout) this._layout.applyStored();   // 布局记忆恢复+视口判定+留白实测
        this._setPhase(this.phase);
        this._refreshRestoreUi();   // 有已存会话时在取图阶段亮「恢复上次」
    }

    hide() {
        if (!this.dialog) return;
        this.dialog.classList.remove('is-open');
        this.visible = false;
        if (this.btn) this.btn.setAttribute('aria-expanded', 'false');
        // 关窗自动兜底存一份（手动「保存」同槽位覆盖，最新状态为准）
        if (this.sourceImage) {
            this._writeSession(this._snapshot())
                .then(() => { this._hasSaved = true; })
                .catch(() => { });
        }
    }

    /** 状态栏提示（isError 红字） */
    status(text, isError) {
        if (!this.statusEl) return;
        this.statusEl.textContent = text || '';
        this.statusEl.classList.toggle('error', !!isError);
    }

    // ==================== 补齐/抠图双通道（Comfy 本地 | API 云端） ====================

    /** 当前通道（localStorage lumen.layerSplit.mode，默认 api=现状链路） */
    _mode() {
        return localStorage.getItem('lumen.layerSplit.mode') === 'comfy' ? 'comfy' : 'api';
    }

    _setMode(mode) {
        if (mode !== 'comfy' && mode !== 'api') return;
        localStorage.setItem('lumen.layerSplit.mode', mode);
        if (this._sideView === 'model') this._renderSide();   // 重渲模型面板（补齐行换形态）
        // AI 拆图 / 逐层精抠按钮随模式显隐（校准阶段）
        ['.ls-act-ai-split', '.ls-act-ai-split-precise'].forEach((sel) => {
            const b = this.dialog && this.dialog.querySelector(sel);
            if (b && this.phase === 'calibrate') {
                b.classList.toggle('ls-hidden', mode !== 'api');
            }
        });
        this.status(mode === 'comfy'
            ? '已切换 Comfy 模式：补齐跑本地工作流，抠图走本地 rembg'
            : '已切换 API 模式：补齐/抠图走云端模型（按张计费）');
    }

    /** 阶段切换：主区/侧栏/工具行按阶段显隐重渲 */
    _setPhase(phase) {
        const prevPhase = this.phase;
        this.phase = phase;
        // 画框模式只在离开校准阶段时自动退出（画完一个框刷 _setPhase('calibrate') 不受影响）
        if (phase !== prevPhase && this._drawMode && phase !== 'calibrate') {
            this._exitDrawMode();
        }
        if (!this.dialog) return;
        const pickEl = this.dialog.querySelector('.ls-pick');
        const previewEl = this.dialog.querySelector('.ls-preview-wrap');
        const stageEl = this.dialog.querySelector('.ls-stage-wrap');
        pickEl.classList.toggle('ls-hidden', phase !== 'pick' || !!this.sourceImage);
        previewEl.classList.toggle('ls-hidden', !(this.sourceImage && phase !== 'edit'));
        stageEl.classList.toggle('ls-hidden', phase !== 'edit');
        // 工具行显隐
        const show = (sel, on) => {
            const el = this.dialog.querySelector(sel);
            if (el) el.classList.toggle('ls-hidden', !on);
        };
        show('.ls-act-canvas-pick', phase === 'pick');
        show('.ls-act-upload', phase === 'pick');
        show('.ls-act-detect', phase === 'pick');
        show('.ls-act-add-box', phase === 'calibrate');
        show('.ls-act-redetect', phase === 'calibrate');
        show('.ls-act-split', phase === 'calibrate');
        show('.ls-act-ai-split', phase === 'calibrate' && this._mode() === 'api');   // 两调管线仅 API 模式
        show('.ls-act-ai-split-precise', phase === 'calibrate' && this._mode() === 'api');   // 逐层精抠仅 API 模式
        show('.ls-act-recalibrate', phase === 'edit');
        show('.ls-act-inpaint', phase === 'edit');
        show('.ls-act-cutout-all', phase === 'edit');
        show('.ls-act-download', phase === 'edit');
        show('.ls-act-canvas-send', phase === 'edit');
        show('.ls-act-save', phase === 'calibrate' || phase === 'edit');
        show('.ls-act-restore', phase === 'pick' && !!this._hasSaved);
        show('.ls-act-change-image', phase === 'edit');
        // 阶段默认侧栏视图（用户可在图标轨自由切换，见 _renderSide）；
        // 只在阶段真正变化时重置——删框等刷新路径调 _setPhase 不应踢掉用户正在看的视图
        if (phase !== prevPhase || !this._sideView) {
            this._sideView = phase === 'calibrate' ? 'boxes' : phase === 'edit' ? 'layers' : 'model';
        }
        if (phase === 'calibrate') {
            this._renderPreviewBoxes();   // 识别结果叠加到预览图（漏调修复 2026-11-13：此前框只在列表里，图上不可见）
        }
        this._renderSide();
        if (phase === 'edit') this._renderStage();
    }

    // ==================== 快照式撤销/重做（画布同款，2026-11-13） ====================

    /** 把预览 img / 舞台 canvas 按容器 contain 缩到恰好放得下（保持纵横比）。
     *  CSS 百分比 max-* 对自动尺寸父级解析不了——竖图会溢出（父级没上限）
     *  或压扁（只砍高度不缩宽度），显式算尺寸让「预览盒=元素=内容」三体
     *  对齐，框叠加的百分比定位才准。窗口壳尺寸固定，无需监听 resize */
    _fitToWrap(el, naturalW, naturalH) {
        if (!el || !naturalW || !naturalH) return;
        const wrap = el.closest('.ls-preview-wrap') || el.closest('.ls-stage-wrap');
        if (!wrap) return;
        const pad = 24;   // wrap 上下/左右 padding 12×2
        const availW = Math.max(40, wrap.clientWidth - pad);
        const availH = Math.max(40, wrap.clientHeight - pad);
        const s = Math.min(availW / naturalW, availH / naturalH, 1);
        el.style.width = Math.max(1, Math.round(naturalW * s)) + 'px';
        el.style.height = Math.max(1, Math.round(naturalH * s)) + 'px';
    }

    /** 当前工作状态快照。要点：只浅拷贝对象+切 bbox 数组——dataURL 等字符串
     *  是不可变原始值，跨快照按引用共享，50 步历史也不膨胀内存；
     *  图层运行时字段（_imgEl/_imgSrc）不入快照，恢复后舞台惰性加载自愈 */
    _captureState() {
        return {
            phase: this.phase,
            activeBoxId: this.activeBoxId,
            activeLayerId: this.activeLayerId,
            boxes: this.boxes.map((b) => ({ ...b, bbox: b.bbox.slice() })),
            layers: this.layers.map((l) => {
                const { _imgEl, _imgSrc, ...rest } = l;
                return { ...rest, bbox: l.bbox.slice() };
            })
        };
    }

    /** 每次变更完成后调用：截断重做分支 + 追加快照（上限 50 步） */
    _pushHistory() {
        this._history = this._history.slice(0, this._historyIndex + 1);
        this._history.push(this._captureState());
        if (this._history.length > 50) this._history.shift();
        this._historyIndex = this._history.length - 1;
    }

    /** 基线重置（取新图 / 换图 / 恢复会话）：丢弃全部历史，当前态为起点 */
    _resetHistory() {
        this._history = [this._captureState()];
        this._historyIndex = 0;
    }

    _undo() {
        if (this._historyIndex <= 0) {
            this.status('没有更早的操作了');
            return;
        }
        this._historyIndex--;
        this._applyHistory(this._history[this._historyIndex]);
        this.status('已撤销（Ctrl+Shift+Z 重做）');
    }

    _redo() {
        if (this._historyIndex >= this._history.length - 1) {
            this.status('已是最新状态');
            return;
        }
        this._historyIndex++;
        this._applyHistory(this._history[this._historyIndex]);
        this.status('已重做');
    }

    /** 回放快照：重建框/图层集合（新对象，后续改动不污染历史）并跳回
     *  快照时的阶段——删框回校准、撤拆分回编辑前，都自然成立 */
    _applyHistory(s) {
        this.boxes = s.boxes.map((b) => ({ ...b, bbox: b.bbox.slice() }));
        this.layers = s.layers.map((l) => ({ ...l, bbox: l.bbox.slice() }));
        this.activeBoxId = s.activeBoxId;
        this.activeLayerId = s.activeLayerId;
        this._setPhase(s.phase);
    }
}

// ==================== 静态纯函数（识别解析/几何，vm 可测） ====================

/** 识别结果 kind 白名单（UI 素材词表，厚涂游戏 UI 导向） */
LayerSplit.ALLOWED_KINDS = new Set([
    'icon', 'button', 'avatar', 'portrait', 'illustration', 'decoration',
    'frame', 'panel', 'bar', 'title-text', 'logo', 'chart', 'other'
]);

/** kind 的中文显示名（下拉用；value 保持英文——识别解析与存储都以英文为准） */
LayerSplit.KIND_LABELS = {    'icon': '图标',
    'button': '按钮',
    'avatar': '头像',
    'portrait': '立绘',
    'illustration': '插画',
    'decoration': '装饰',
    'frame': '边框',
    'panel': '面板',
    'bar': '栏',
    'title-text': '标题文字',
    'logo': '标志',
    'chart': '图表',
    'other': '其他'
};

/** AI 抠图提示词（云端去背景，2026-11-14 复活为切片行独立按钮；同日
 *  用户要求「保持风格和色彩才行」→ 吸收 image-to-slice
 *  buildAiTransparentPrompt 完整纪律段：唯一事实来源/只去背景/保护清单
 *  逐项点名（含风格质感与抗锯齿边缘）/八禁动词/输出规格，另加色彩
 *  保护条款（饱和度/曝光/色温对齐，禁美化打光锐化调色） */
LayerSplit.CUTOUT_PROMPT = [
    'Use the attached image as the only source of truth.',
    'Only remove the background and make it transparent.',
    "Preserve the subject's shape, colors, proportions, angle, shadows, antialiased edges, art style, texture, gradients and composition exactly.",
    'Keep the original art style, saturation, exposure and color temperature exactly — do not beautify, relight, sharpen, grade or restyle the image.',
    'Do not redraw, regenerate, complete, replace, crop, resize, reposition, recolor or add anything.',
    'Output one transparent PNG with the original canvas dimensions.'
].join('\n');

/**
 * AI 抠图发送尺寸规划（image-to-slice toOpenAIImageSize 同款三档）：
 * 按切片宽高比选模型标准档 → contain 等比缩放居中 → contentBox。
 * 发送时短边空隙用边缘像素复制填充（模型没有留白可脑补），输出按
 * contentBox 裁回再缩回切片原尺寸——宽高比零变形零留白闭环
 * @param {number} w - 切片宽（bbox[2]）
 * @param {number} h - 切片高（bbox[3]）
 * @returns {{size: string, W: number, H: number, contentW: number,
 *            contentH: number, x: number, y: number}} size=请求档位，
 *            x/y/contentW/contentH=内容在档位画布里的位置与大小
 */
LayerSplit.planCutoutResize = function (w, h) {
    const ratio = w / h;
    let W, H;
    if (ratio > 1.2) {
        W = 1536; H = 1024;   // 横图档
    } else if (ratio < 0.85) {
        W = 1024; H = 1536;   // 竖图档
    } else {
        W = 1024; H = 1024;   // 近方形档
    }
    const scale = Math.min(W / w, H / h);
    const contentW = Math.max(1, Math.round(w * scale));
    const contentH = Math.max(1, Math.round(h * scale));
    return {
        size: `${W}x${H}`,
        W, H,
        contentW, contentH,
        x: Math.floor((W - contentW) / 2),
        y: Math.floor((H - contentH) / 2)
    };
};

/** AI 拆图发送前缩放目标：原图按比例缩到长边≈2K 再送提取模型（gpt-image
 *  2K 档出图细节最好，小图放大后小字/图标更可辨）；输出缩回原尺寸裁层，
 *  坐标换算自动抵消 */
LayerSplit.EXTRACT_TARGET_EDGE = 2048;

/** AI 拆图第 1 调提示词（整图全前景提取，2026-11-13 用户在 LiblibAI 用
 *  gpt2.6 实测成功的短句优化而来——比框坐标契约版效果好：满屏 UI 一次
 *  抠成透明底、原地原尺寸；随后本地按框裁层，第 2 调补背景。半透明条
 *  款=用户实测毛玻璃/半透明面板提取效果差后补的提醒：要求保留半透明
 *  为真实 alpha、别画成不透明、别把透出的背景烙进元素）。
 *  {{width}}/{{height}} 会替换为实际发送图（缩放后）尺寸，同为「提取
 *  提示词」编辑区的预填内容 */
LayerSplit.EXTRACT_PROMPT_TEMPLATE = [
    '提取出图像中的所有前景元素：UI 图标、按钮、人物、动物、面板、文字标签、装饰边框、半透明浮层等。',
    '提取出来的东西保持原坐标位置不改变，大小不变，不要移动、缩放或裁剪任何元素。',
    '背景完全抠除，输出真正的透明背景（透明通道 alpha=0，不要白色、黑色或棋盘格假透明）。',
    '半透明的 UI（毛玻璃/磨砂面板、半透明按钮、提示浮层、光效）同样必须提取，并把它们原本的半透明程度保留为真实的 alpha 透明通道——不要画成完全不透明，也不要把透过它们显示的背景内容烙进元素里。',
    '不要添加原图中不存在的内容，不要遗漏或合并元素，不要改变元素的外观、颜色与细节，不要加阴影或光晕。',
    '输出画面与输入图像逐像素对齐（输入为 {{width}} x {{height}}），所有元素都留在原位置上。'
].join('\n');

/** 组装实际发送的提取 prompt：语义同 resolveInpaintPrompt（占位符可选） */
LayerSplit.resolveExtractPrompt = function (stored, width, height) {
    const custom = String(stored || '').trim();
    const tpl = custom || LayerSplit.EXTRACT_PROMPT_TEMPLATE;
    return tpl
        .replace(/\{\{width\}\}/g, Math.round(width || 0))
        .replace(/\{\{height\}\}/g, Math.round(height || 0));
};

/**
 * 逐层精抠提示词模板（2026-11-19 方案一）：整图一调提取不守坐标契约
 * （模型会重排版——用户实测 gpt2.6 提取质量好但画幅/布局都变了），改为
 * 每个勾选框单独一调：发送框区域+外扩边距裁片，提示词点名元素（VLM
 * 起名/用户改名的 box.name 终于派上用场），回收端不信坐标、本地按
 * alpha 连通域重新定位。{{name}}/{{kind}} 占位符随元素替换；同为
 * 「精抠提示词」编辑区的预填内容
 */
LayerSplit.PRECISE_PROMPT_TEMPLATE = [
    '这张图是一个局部截图，中心区域有一个目标前景元素（参考名称：{{name}}，类型：{{kind}}）。',
    '只提取这一个元素：把它完整抠出，输出真正的透明背景 PNG（透明通道 alpha=0，不要白色、黑色或棋盘格假透明）。',
    '边缘露出的相邻元素与背景全部抠除为透明——边缘内容只作为风格上下文，不要提取它们。',
    '目标元素保持原有大小与细节，不要缩放，不要改变它的艺术风格、颜色与纹理，不要重绘可见部分。',
    '如果目标元素被截图边缘裁断或被其他元素遮挡，按周围风格把缺失部分合理补全，补全部分与可见部分自然衔接。',
    '半透明部分（光效、毛玻璃、投影）保留为真实的 alpha 半透明通道，不要画成不透明，也不要把透出的背景烙进元素里。',
    '不要添加目标元素以外的任何新物体。输出一张只含这一个元素的透明背景 PNG。'
].join('\n');

/** 组装实际发送的精抠 prompt：语义同 resolveDetectPrompt（占位符可选，
 *  自定义没写占位符就原样发送——元素名信息由用户自己负责） */
LayerSplit.resolvePrecisePrompt = function (stored, name, kind) {
    const custom = String(stored || '').trim();
    const tpl = custom || LayerSplit.PRECISE_PROMPT_TEMPLATE;
    return tpl
        .replace(/\{\{name\}\}/g, String(name || 'target element'))
        .replace(/\{\{kind\}\}/g, String(kind || 'other'));
};

/**
 * 精抠裁片规划：勾选框四周外扩边距（取长边 25%，钳 12~192px）构成发送
 * 裁片——边距给模型「补全被遮挡部分」的上下文，也兜住 VLM 框略小的
 * 情况；贴边时钳进画幅。inner=基准框在裁片坐标系里的位置（对齐用）
 * @param {number[]} box - [x, y, w, h] 原图坐标
 * @param {number} W - 原图宽
 * @param {number} H - 原图高
 * @param {number} [marginRatio] - 边距比例（默认 0.25）
 * @returns {{crop:number[], inner:number[], margin:number}}
 */
LayerSplit.planPreciseCrop = function (box, W, H, marginRatio) {
    const [bx, by, bw, bh] = box;
    const ratio = marginRatio == null ? 0.25 : marginRatio;
    const margin = Math.round(Math.min(192, Math.max(12, Math.max(bw, bh) * ratio)));
    const cx = Math.max(0, bx - margin);
    const cy = Math.max(0, by - margin);
    const right = Math.min(W, bx + bw + margin);
    const bottom = Math.min(H, by + bh + margin);
    return {
        crop: [cx, cy, right - cx, bottom - cy],
        inner: [bx - cx, by - cy, bw, bh],
        margin
    };
};

/**
 * alpha 连通域去噪 opaque bbox（精抠回收端）：扫描 alpha>阈值 的像素做
 * 8 连通标记，小于最大连通域 minRatio（且不足 minPx）的连通域当模型
 * 输出噪点丢弃（碎屑/残边），其余并集成 bbox——目标元素的不透明区域
 * 就是它在输出坐标系里的真实位置与尺寸（坐标权威从模型收归 alpha 几何）
 * @param {Uint8ClampedArray|number[]} pixels - RGBA 像素
 * @param {number} width
 * @param {number} height
 * @param {{alphaThreshold?:number, minRatio?:number, minPx?:number}} [opts]
 * @returns {{bbox:number[], kept:number, total:number}|null} null=无前景像素
 */
LayerSplit.opaqueBboxFiltered = function (pixels, width, height, opts) {
    const aThr = (opts && opts.alphaThreshold) || 8;
    const minRatio = (opts && opts.minRatio) == null ? 0.01 : opts.minRatio;
    const minPx = (opts && opts.minPx) == null ? 4 : opts.minPx;
    const n = width * height;
    const visited = new Uint8Array(n);
    const stack = new Int32Array(n);
    const comps = [];
    for (let start = 0; start < n; start++) {
        if (visited[start] || pixels[start * 4 + 3] <= aThr) continue;
        // 8 连通洪泛（标记在入栈时做，栈深有界）
        let top = 0;
        stack[top++] = start;
        visited[start] = 1;
        let size = 0, minX = width, minY = height, maxX = -1, maxY = -1;
        while (top > 0) {
            const idx = stack[--top];
            const x = idx % width, y = (idx - x) / width;
            size++;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            for (let dy = -1; dy <= 1; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= height) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    if (nx < 0 || nx >= width) continue;
                    const nIdx = ny * width + nx;
                    if (visited[nIdx] || pixels[nIdx * 4 + 3] <= aThr) continue;
                    visited[nIdx] = 1;
                    stack[top++] = nIdx;
                }
            }
        }
        comps.push({ size, minX, minY, maxX, maxY });
    }
    if (!comps.length) return null;
    const maxSize = comps.reduce((m, c) => Math.max(m, c.size), 0);
    const kept = comps.filter((c) => c.size >= Math.max(minPx, maxSize * minRatio));
    let l = width, t = height, r = -1, b = -1;
    for (const c of kept) {
        if (c.minX < l) l = c.minX;
        if (c.minY < t) t = c.minY;
        if (c.maxX > r) r = c.maxX;
        if (c.maxY > b) b = c.maxY;
    }
    if (r < 0) return null;   // 全被当噪点滤掉（理论上 maxSize 自身必保留，防御）
    return { bbox: [l, t, r - l + 1, b - t + 1], kept: kept.length, total: comps.length };
};

/**
 * 精抠对齐（裁片坐标系）：输出不透明 bbox 相对基准框分两种态处置——
 * 抖动态（bbox 未明显超出基准框±tolerance）：模型小幅漂移，中心对齐
 * 基准框修正；补全态（bbox 超出基准框）：模型补全了被遮挡部分，bbox
 * 中心不再是可见部分中心，保持原位不动（平移反而错位）。
 * 返回处置后的 [x, y, w, h]（同坐标系）
 */
LayerSplit.alignPreciseSlice = function (opaque, inner, tolerance) {
    const tol = tolerance == null ? 2 : tolerance;
    const [ox, oy, ow, oh] = opaque;
    const [ix, iy, iw, ih] = inner;
    const inside = ox >= ix - tol && oy >= iy - tol &&
        ox + ow <= ix + iw + tol && oy + oh <= iy + ih + tol;
    if (inside) {
        const dx = Math.round((ix + iw / 2) - (ox + ow / 2));
        const dy = Math.round((iy + ih / 2) - (oy + oh / 2));
        return [ox + dx, oy + dy, ow, oh];
    }
    return [ox, oy, ow, oh];
};

/** bbox 最小边（像素）——小于此的识别结果丢弃（防噪点框） */
LayerSplit.MIN_BOX_SIZE = 8;

/** 输入图最大边长（与 image-to-slice 同限，VLM 上下文保护） */
LayerSplit.MAX_IMAGE_EDGE = 4096;

/**
 * 从模型输出提取 JSON 对象：剥 markdown 围栏、取首尾大括号之间。
 * 解析失败抛可读错误（上游转状态栏提示）
 * @param {string} text - 模型原始输出
 * @returns {Object}
 */
LayerSplit.extractJson = function (text) {
    const raw = String(text || '').trim();
    const withoutFence = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```$/i, '')
        .trim();
    const start = withoutFence.indexOf('{');
    const end = withoutFence.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 对象');
    try {
        return JSON.parse(withoutFence.slice(start, end + 1));
    } catch (error) {
        throw new Error(`JSON 解析失败：${error.message || String(error)}`);
    }
};

/**
 * bbox 归一：兼容 {x,y,width,height} 与数组、允许负宽高（min/max 交换）、
 * clamp 进画幅、最小尺寸过滤。无效返回 null
 */
LayerSplit.normalizeBox = function (bbox, width, height, minSize) {
    const min = minSize || LayerSplit.MIN_BOX_SIZE;
    let x, y, w, h;
    if (Array.isArray(bbox) && bbox.length === 4) {
        [x, y, w, h] = bbox;
    } else if (bbox && typeof bbox === 'object') {
        x = bbox.x; y = bbox.y; w = bbox.width; h = bbox.height;
    } else {
        return null;
    }
    const nums = [x, y, w, h];
    if (!nums.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    const left = Math.round(Math.min(x, x + w));
    const top = Math.round(Math.min(y, y + h));
    const right = Math.round(Math.max(x, x + w));
    const bottom = Math.round(Math.max(y, y + h));
    const cl = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const L = cl(left, 0, width), T = cl(top, 0, height);
    const R = cl(right, 0, width), B = cl(bottom, 0, height);
    if (R - L < min || B - T < min) return null;
    return [L, T, R - L, B - T];
};

/**
 * 解析 VLM 识别输出 → 校准框数组。纯防御：bbox 归一、名称兜底、
 * confidence clamp。kind 白名单外的值归一为 'other'（不丢弃——自定义
 * 识别提示词的词表扩展不被静默吞掉，多出的框由校准阶段人工勾掉）。
 * width/height = 原图像素尺寸
 * @returns {Array<{id:number,name:string,kind:string,bbox:number[],keep:boolean,confidence:number|null}>}
 */
/**
 * JSON 修复 prompt（image-to-slice 同款）：识别返回解析失败时把原始输出
 * 原文发回让模型自修格式——只修 JSON，不许增删改条目（修出花样反而污染
 * 识别结果）
 */
LayerSplit.buildJsonRepairPrompt = function (rawText) {
    return [
        '修复下面的模型输出：只把它修成一个合法 JSON 对象，不新增、不删除、',
        '不合并、不去重任何条目，能恢复的值一律保持原样。',
        '只返回一个含 assets 数组的合法 JSON 对象，不要输出 JSON 以外的任何内容。',
        String(rawText || '')
    ].join('\n');
};

LayerSplit.parseDetectResult = function (text, width, height) {
    const value = LayerSplit.extractJson(text);
    const source = Array.isArray(value && value.assets) ? value.assets : [];
    const boxes = [];
    source.forEach((asset, index) => {
        const rawKind = String(asset && asset.kind || '').trim();
        const kind = LayerSplit.ALLOWED_KINDS.has(rawKind) ? rawKind : 'other';
        const bbox = LayerSplit.normalizeBox(asset && asset.bbox, width, height);
        if (!bbox) return;
        const name = String(asset && asset.name || '').trim()
            .replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
        const confidence = Number(asset && asset.confidence);
        boxes.push({
            id: index + 1,
            name: name || `asset_${String(index + 1).padStart(2, '0')}`,
            kind,
            bbox,
            keep: true,
            confidence: Number.isFinite(confidence)
                ? Math.min(1, Math.max(0, confidence)) : null
        });
    });
    return boxes;
};

/**
 * 识别 prompt 模板（image-to-slice 口径改造：UI 素材拆层导向，强制原始
 * 像素坐标防 VLM 按训练语料归一化输出）。{{width}}/{{height}} 占位符在
 * 发送时替换为实际图片尺寸——模板同时是「识别提示词」编辑区（窗口
 * 模型设置）的预填内容，用户可改词表/判据后自行使用
 */
LayerSplit.DETECT_PROMPT_TEMPLATE = [
    'Analyze the attached UI artwork image and return the foreground elements that should be extracted as separate layers.',
    'The source image is {{width}} x {{height}} pixels. All bbox values MUST use original image pixel coordinates with top-left origin. Do not normalize, do not use percentages.',
    'Return assets for visually independent foreground elements only: icons, buttons, gems, orbs, avatars, characters, creatures, weapons, props, illustrations, decorative frames, ornate borders, banners, ribbons, title lettering, logos, gauges, charts, and similar distinct elements.',
    'Do NOT return the whole background, large empty panels, plain rectangles, gradients, or flat color areas — those remain in the base layer.',
    'Do not merge visually independent elements merely because their boxes overlap. Keep each element as its own entry and preserve reading order (top-to-bottom, left-to-right).',
    'Give every asset a concise, specific English snake_case name describing its content, for example ornate_wood_frame or gem_button_red.',
    'Return one JSON object with exactly this shape:',
    '{"assets":[{"name":"ornate_wood_frame","kind":"decoration","bbox":{"x":0,"y":0,"width":8,"height":8},"confidence":0.0}]}',
    'Allowed kind values, in this exact vocabulary: icon, button, avatar, portrait, illustration, decoration, frame, panel, bar, title-text, logo, chart, other.',
    'Return JSON only. Do not include Markdown or explanations outside the JSON object.'
].join('\n');

/** 组装实际发送的识别 prompt：无自定义 → 内置模板注入尺寸；有自定义 →
 *  替换占位符（没写占位符就原样发送——尺寸信息由用户自己负责） */
LayerSplit.resolveDetectPrompt = function (stored, width, height) {
    const custom = String(stored || '').trim();
    if (!custom) return LayerSplit.buildDetectPrompt(width, height);
    return custom
        .replace(/\{\{width\}\}/g, Math.round(width))
        .replace(/\{\{height\}\}/g, Math.round(height));
};

/**
 * 补齐 prompt 模板（发图像编辑模型：挖透明图 + 本段文字）。与识别模板
 * 同款占位符语义，同为「补齐提示词」编辑区（窗口模型设置）的预填内容
 */
LayerSplit.INPAINT_PROMPT_TEMPLATE = [
    'Fill in the missing transparent region of this image: reconstruct the occluded background naturally based on the surrounding content.',
    'Keep all existing visible pixels unchanged.',
    'Match the original art style, lighting and texture.',
    'The filled content must connect seamlessly with the surrounding texture, perspective and lighting, and continue the existing background only — do not invent new objects, text, icons or characters inside the filled region.',
    'Match the protected visible pixels exactly in white balance, color temperature, tint, exposure, gamma, contrast and saturation — no global relighting, HDR, auto-enhancement, cinematic grading or sharpening.',
    'Avoid seams, halos or rectangular patch edges at the region boundary.',
    'Return the complete image with the region filled.'
].join('\n');

/** 组装实际发送的补齐 prompt：语义同 resolveDetectPrompt（占位符可选） */
LayerSplit.resolveInpaintPrompt = function (stored, width, height) {
    const custom = String(stored || '').trim();
    const tpl = custom || LayerSplit.INPAINT_PROMPT_TEMPLATE;
    return tpl
        .replace(/\{\{width\}\}/g, Math.round(width || 0))
        .replace(/\{\{height\}\}/g, Math.round(height || 0));
};

/**
 * 识别 prompt（内置模板注入尺寸基准——buildDetectPrompt 保持既有调用
 * 形态，编辑区走 resolveDetectPrompt）
 */
LayerSplit.buildDetectPrompt = function (width, height) {
    return LayerSplit.DETECT_PROMPT_TEMPLATE
        .replace(/\{\{width\}\}/g, Math.round(width))
        .replace(/\{\{height\}\}/g, Math.round(height));
};

/** 多个 bbox 求并集（补齐挖洞区）——空数组返回 null */
LayerSplit.uniteBoxes = function (boxes) {
    const valid = (boxes || []).filter((b) => Array.isArray(b) && b.length === 4);
    if (!valid.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y, w, h] of valid) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x + w > maxX) maxX = x + w;
        if (y + h > maxY) maxY = y + h;
    }
    return [minX, minY, maxX - minX, maxY - minY];
};

/**
 * 局部合成几何：模型输出已缩放回原图尺寸后，只把洞区（并集 bbox，
 * 外扩 feather 像素做过渡）从输出贴回原背景。
 * @returns {{x:number,y:number,w:number,h:number}|null} 贴回区域
 */
LayerSplit.computeBlendRect = function (holeRect, sourceW, sourceH, feather) {
    if (!holeRect) return null;
    const pad = feather || 0;
    const x = Math.max(0, Math.round(holeRect[0] - pad));
    const y = Math.max(0, Math.round(holeRect[1] - pad));
    const right = Math.min(sourceW, Math.round(holeRect[0] + holeRect[2] + pad));
    const bottom = Math.min(sourceH, Math.round(holeRect[1] + holeRect[3] + pad));
    const w = right - x, h = bottom - y;
    if (w <= 0 || h <= 0) return null;
    return { x, y, w, h };
};

/**
 * 挖洞外扩（image-to-slice 修复区同款）：洞四周扩 min(宽高)*0.1（钳
 * 4~16px）——切片不透明 bbox 是按 alpha>8 扫的，抗锯齿边缘环（半透明
 * 过渡像素）留在洞边没挖掉，补齐后出白边/鬼影；外扩让模型连边缘环
 * 一起重画。挖洞与贴回共用同一份外扩后的洞，边界像素洞外仍原封不动
 * @param {number[]} hole - [x, y, w, h] 原始洞
 * @param {number} sourceW - 原图宽（钳边界）
 * @param {number} sourceH - 原图高
 * @returns {number[]} 外扩后的 [x, y, w, h]
 */
LayerSplit.expandHole = function (hole, sourceW, sourceH) {
    const [x, y, w, h] = hole;
    const pad = Math.round(Math.min(
        16,
        Math.max(4, Math.min(w, h) * 0.1)
    ));
    const nx = Math.max(0, x - pad);
    const ny = Math.max(0, y - pad);
    const right = Math.min(sourceW, x + w + pad);
    const bottom = Math.min(sourceH, y + h + pad);
    return [nx, ny, right - nx, bottom - ny];
};

/**
 * 边缘背景色采样（image-to-slice sampleEdgeStats 同款）：四边等距采样 →
 * 按亮度排序掐头去尾（各 20%）→ 均值——边缘混进几个非背景像素不至于
 * 带偏背景色
 * @param {Uint8ClampedArray|number[]} pixels - RGBA 像素数组
 * @param {number} width
 * @param {number} height
 * @returns {{r:number, g:number, b:number}} 背景色
 */
LayerSplit.sampleEdgeBackground = function (pixels, width, height) {
    const step = Math.max(1, Math.floor(Math.min(width, height) / 18));
    const samples = [];
    for (let x = 0; x < width; x += step) {
        samples.push([x, 0], [x, height - 1]);
    }
    for (let y = 0; y < height; y += step) {
        samples.push([0, y], [width - 1, y]);
    }
    const colors = samples.map(([x, y]) => {
        const i = (y * width + x) * 4;
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        return { r, g, b, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b };
    }).sort((a, b) => a.luma - b.luma);
    // 掐头去尾（亮度极值各 20%）再均值
    const start = Math.floor(colors.length * 0.2);
    const end = Math.max(start + 1, Math.ceil(colors.length * 0.8));
    const mid = colors.slice(start, end);
    const sum = mid.reduce((s, c) => ({ r: s.r + c.r, g: s.g + c.g, b: s.b + c.b }),
        { r: 0, g: 0, b: 0 });
    return { r: sum.r / mid.length, g: sum.g / mid.length, b: sum.b / mid.length };
};

/**
 * 双阈值色键去底（image-to-slice removeEdgeBackground 同款，就地改
 * alpha，单遍语义）：与背景色距 ≤hard 全透；hard~soft 之间 alpha 按
 * 距离比例线性渐变（软边缘，保住抗锯齿过渡带；乘现有 alpha——重复
 * 跑软边带会继续变淡，调用方每张图只跑一遍）；≥soft 不动。
 * @param {Uint8ClampedArray|number[]} pixels - RGBA 像素（就地修改）
 * @param {number} width
 * @param {number} height
 * @param {{r:number, g:number, b:number}} bg - 背景色（sampleEdgeBackground）
 * @param {{hard?:number, soft?:number}} [thresholds] - 默认 34 / 82
 * @returns {number} 被完全抠透的像素数（0=背景不是纯色系，没抠到东西）
 */
LayerSplit.colorKeyTransparent = function (pixels, width, height, bg, thresholds) {
    const hard = (thresholds && thresholds.hard) || 34;
    const soft = (thresholds && thresholds.soft) || 82;
    const span = soft - hard;
    let keyed = 0;
    for (let i = 0; i < pixels.length; i += 4) {
        const dr = pixels[i] - bg.r, dg = pixels[i + 1] - bg.g, db = pixels[i + 2] - bg.b;
        const dist = Math.sqrt(dr * dr + dg * dg + db * db);
        if (dist <= hard) {
            pixels[i + 3] = 0;
            keyed++;
        } else if (dist < soft) {
            const ratio = (dist - hard) / span;
            pixels[i + 3] = Math.round(pixels[i + 3] * ratio);
        }
    }
    return keyed;
};

// 将类暴露到全局作用域
window.LayerSplit = LayerSplit;
