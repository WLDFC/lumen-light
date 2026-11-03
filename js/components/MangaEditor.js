/**
 * ==========================================================================
 * 漫画编辑器（MangaEditor）——主类
 * ==========================================================================
 * 二期（多页文档，2026-11-03）：文档 = pages 页数组 + activePage，每页是
 *       完整 MOSS 草稿（一页 = 一次生成的单位）；this.draft 恒为**活动页的
 *       活引用**——七个混入模块里全部 this.draft 读写零改动，切页即换引用
 *       + 重渲染。页面栏（最左 100px 缩略图）/切页/增删复制移动在
 *       MangaPages 混入；历史快照分页级（kind:'page'，内容改动）/文档级
 *       （kind:'doc'，页面增删移动）两形态（MangaHistory）；持久化为整
 *       文档单文件，旧单页草稿打开时自动迁移为第 1 页（MangaDraftStore）。
 * 一期说明：整体复制自 CoordinateEditor（坐标编辑器，ADR 026 拆分结构）
 *       改名分叉（仍编译 MOSS 坐标提示词、共用 js/utils/CoordinateLayout.js
 *       纯函数层与全部交互逻辑）；漫画化改造（分镜格子、对话框、逐格
 *       生成等）在此基线上二期展开。与原型的既定差异：顶栏按钮插在
 *       「坐标编辑」左侧、独立草稿端点 /api/manga-draft（data/manga-draft.json）、
 *       独立 localStorage 键（lumenLight.manga*）、.manga-* 样式前缀
 *       （两弹窗常驻 DOM，类名/键名必须互不相干）、默认全屏开窗
 *       （留白 0，右缘手柄仍可拖出留白露出面板——2026-11-03 应需求分叉）。
 * 作用：顶栏「漫画编辑」按钮 + 弹窗（复用收藏页 recipe-dialog 骨架，
 *       与 LoRA 管理器/提示词收藏同款窗口）。默认全屏开窗；右缘拖拽
 *       手柄可拉出留白（--manga-gap，存 localStorage）露出画布右侧的
 *       Comfy/LLM 面板同屏操作，ESC 仅在焦点位于弹窗内时关窗；窄屏
 *       （<1500px）媒体查询强制全屏。为支持坐标编辑的新模型
 *       （MOSS-Image / Flux3 等）可视化制作布局提示词：
 *
 *   - 中央舞台：bbox 拖拽创建 / 移动 / 八向锚点缩放 / 磁吸参考线
 *     （画幅边与中心，StudioMoveTool 同款粉色粉线）/ Shift 画正方 /
 *     图层级选框——命中按层栈（数组序即绘制序），同位连点穿透逐层
 *     下探、选中框置顶重绘、选中优先拖动；卡片图层菜单可置顶/上下移/
 *     置底（ADR 017 决策十）；
 *   - 左侧面板：整体描述与元素卡片列表按 2:1 分摊画幅/模式迁出后的
 *     空间（卡片列表：类型/描述/文字内容/四坐标数值框，与舞台双向同步）；
 *   - 右侧输出面板（与左栏同宽）：画幅（16 倍数钳制 + 预设）与模式三选
 *     （single/multi_panel/collage）置顶——设一次就不常动，挪到右栏给
 *     左栏描述腾地方；其下为单一输出框——AI 文案留档与编译 JSON
 *     产物共用（最近一次输出覆盖显示）；编译产物随草稿变更即清空防过期，
 *     AI 文案留档不受草稿编辑影响，可手动选择复制；
 *   - AI 写提示词：把当前布局草稿交给 LLM 补全 summary.caption 与各元素
 *     caption/text——几何保持用户手画不动；模型经底部下拉框选择
 *     （LumenDropdown，与 LLM 面板同组件）：显式选择存 localStorage
 *     （lumenLight.mangaModel），「自动」档跟随 LLM 面板 Agent 分类选中
 *     的模型（piModelKey），无则技能栏模型 → 第一序聊天模型；
 *     模型旁技能下拉（lumenLight.mangaSkill）选 pi 技能库技能，其正文
 *     经框架语隔离后注入 system 提示作写作指引（流程性指令忽略，
 *     ADR 017 决策八）；
 *   - 编译导出：CoordinateLayout.compileDraft 产出单行 JSON（与上游
 *     compile_prompt.py 字节级一致），复制到剪贴板或直接「生成」出图
 *     （MangaGenerate 混入，Comfy/API 双模式，结果落页面参考层），
 *     宽高需单独设置到 ComfyUI 工作流（提示词不含尺寸）。
 *
 * 数据：编辑器状态即 MOSS 草稿 JSON（schema 见 CoordinateLayout.js 文件头）。
 *       草稿自动持久化到后端 data/manga-draft.json（/api/manga-draft，
 *       全局单份，防抖 800ms + pagehide keepalive 兜底；打开弹窗时恢复，
 *       恢复走 CoordinateLayout.normalizeDraft 宽松归一——见 ADR 018）。
 * 拆分：本类按职责域拆为 manga-editor/ 下十一个混入模块（partial-class，
 *       ADR 026）——方法 Object.assign 回本类 prototype，this 即实例，
 *       调用点与测试契约（Object.create(prototype) + 实例打桩）零改动：
 *       MangaDom.js        DOM 装配与事件绑定（懒建于首次 show）
 *       MangaPanel.js      左面板渲染/元素卡片/景别/画幅/图层顺序
 *       MangaStage.js      舞台渲染与指针交互/磁吸/滚轮缩放
 *       MangaTools.js      工具栏（选择/画笔）
 *       MangaLayers.js     页面图层系统（笔迹层/图片层/图层面板）
 *       MangaHistory.js    撤销重做快照栈（ADR 017 决策十一）
 *       MangaDraftStore.js 草稿自动持久化（ADR 018）
 *       MangaAi.js         AI 写提示词（模型/技能/解析/回填）
 *       MangaBackground.js 舞台背景参考图与生成图透显（悬浮工具条）
 *       MangaPages.js      页面栏与多页文档操作（切页/新建/清空）
 *       MangaGenerate.js   图像生成（Comfy/API 双模式与结果落参考层）
 *       本文件保留：构造与状态声明、开合与保存/关闭确认（右上保存蓝钮 +
 *       ×红钮，图片层同步画布对应图——干净底片+可见笔迹叠加分通道，
 *       ImageStudio 同模型）、并排窗口宽度、共享小工具（配色/稳定 id）、
 *       草稿失效枢纽与编译导出。
 *       加载顺序：本文件先于十一个混入模块（混入依赖类已定义）。
 * 纯函数层：js/utils/CoordinateLayout.js（校验/编译/几何辅助，Jest 可单测）。
 * 样式：css/manga-editor.css（窗口壳复用 recipe-manager.css 的
 *       recipe-dialog 类，本档只补内部排布）。
 * ==========================================================================
 */

class MangaEditor {
    /** 恢复记忆色的格式校验：六位 hex 原样保留，其余回落默认。色板化
     *  （ADR 068）后记忆色不再受预设白名单约束——任意自选色都要能恢复，
     *  旧档里的老预设色也天然兼容（格式本就合法） */
    static _normalizeHexColor(saved, fallback) {
        return typeof saved === 'string' && /^#[0-9a-f]{6}$/i.test(saved) ? saved : fallback;
    }

    constructor() {
        // 顶栏按钮：注入中段工具区，插在「坐标编辑」按钮左边（app.js 中
        // coordinateEditor 先于本类实例化；拿不到参照钮时回落排最右）
        this.btn = null;
        const center = document.getElementById('topToolbarCenter');
        if (center) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'top-toolbar-btn';
            b.title = '漫画编辑：bbox 布局 → MOSS/Flux3 坐标提示词';
            b.setAttribute('aria-haspopup', 'dialog');
            b.setAttribute('aria-expanded', 'false');
            b.innerHTML = `
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="13" y1="12" x2="13" y2="21"/></svg>
                <span>漫画编辑</span>
            `;
            b.addEventListener('click', () => this.toggle());
            const coordBtn = window.coordinateEditor && window.coordinateEditor.btn;
            if (coordBtn && coordBtn.parentNode === center) center.insertBefore(b, coordBtn);
            else center.appendChild(b);
            this.btn = b;
        }

        this.dialog = null;        // 弹窗 DOM（懒建）
        this.visible = false;
        // 多页文档（二期）：this.draft 是活动页的活引用，混入层读写零改动
        this.pages = [CoordinateLayout.createDraft()];
        this.activePage = 0;       // 活动页下标
        this.draft = this.pages[0];
        // 项目化（ADR 071）：当前项目态（null=默认草稿兜底），_loadSavedDraft
        // 与项目面板（MangaProjects 混入）维护；自动保存/生图转存按此路由
        this.currentProjectId = null;
        this.currentProjectName = null;
        this.selected = -1;        // 选中元素下标（-1 = 无）
        this.compiled = null;      // 最近一次编译产物 { ok, prompt?, error? }
        this._thumbTimer = null;   // 缩略图重绘防抖（MangaPages 混入）

        // 舞台交互状态
        this._drag = null;         // {mode:'draw'|'move'|'resize', ...}
        this._guides = [];         // 拖拽中的磁吸参考线 [{axis:'x'|'y', pos}]
        this._view = null;         // 视口变换 {scale, ox, oy}
        this._zoom = 1;            // 用户缩放倍率（1 = 自适应铺满；滚轮缩放，MangaStage）
        this._panX = 0;            // 放大后的平移偏移（舞台像素，钳制收口在 _computeStageView）
        this._panY = 0;
        this._clickBurst = null;   // 同位连点状态 {t, px, py}——连点穿透选层用

        // 工具系统与画笔（MangaTools 混入）：select=既有舞台手势的显式化，
        // brush=页面笔迹（画进活动图层，MangaLayers）
        this.activeTool = 'select';
        this._stroke = null;       // 进行中的笔迹 {layerId, color, width, points:[x,y,...]}
        // 笔宽（草稿像素，随画布缩放等比渲染）：标题栏滑块可调并记忆
        // （lumenLight.mangaBrushWidth，1~40 之外越界回落 4）
        try {
            const w = Number(localStorage.getItem('lumenLight.mangaBrushWidth'));
            this._brushWidth = Number.isFinite(w) && w >= 1 && w <= 40 ? w : 4;
        } catch { this._brushWidth = 4; }
        // 笔色记忆（lumenLight.mangaBrushColor）：色板化（ADR 068）后不再受
        // 预设白名单约束，六位 hex 格式校验通过即恢复
        try {
            this._brushColor = MangaEditor._normalizeHexColor(
                localStorage.getItem('lumenLight.mangaBrushColor'), '#ff5a5a');
        } catch { this._brushColor = '#ff5a5a'; }
        // 色板（MangaTools 混入，ADR 068）：最近使用色（会话级，灯箱同款）
        // + 取色器实例（懒建于 _buildPaletteSection）
        this.recentColors = [];
        this._colorPicker = null;

        // 文字工具（MangaText 混入，自灯箱 StudioTextTool 复刻）：_textOpts
        // 是新建文字的默认选项（未选中文字层时改顶栏选项只落这里，灯箱
        // textOpts 同语义）；_textColor 独立记忆；_textEdit 是进行中
        // 的就地编辑态 {layer, ta, isNew, prev, prevName}（空=未在编辑）
        this._textOpts = { font: 'Microsoft YaHei', size: 48, vertical: false };
        try {
            this._textColor = MangaEditor._normalizeHexColor(
                localStorage.getItem('lumenLight.mangaTextColor'), '#ff5a5a');
        } catch { this._textColor = '#ff5a5a'; }
        this._textEdit = null;

        // 形状工具（MangaShape 混入，自灯箱 StudioShapeTool 迁移，ADR 069）：
        // _shapeOpts 是新建形状的默认属性（未选中形状层时改选项条只落这里，
        // 灯箱 shapeOpts 同语义）；_fillColor/_strokeColor 是双色记忆（色板
        // setColor 按工具分发到填充色，边框色走选项条原生色块）；拖拽创建
        // 走通用 _drag（mode:'shape-create'），无独立编辑态
        this._shapeOpts = {
            type: 'rect', fill: '#ffffff', strokeColor: '#000000',
            strokeWidth: 6, radius: 24, tail: 'lb'
        };
        try {
            this._fillColor = MangaEditor._normalizeHexColor(
                localStorage.getItem('lumenLight.mangaShapeFillColor'), '#ffffff');
            this._strokeColor = MangaEditor._normalizeHexColor(
                localStorage.getItem('lumenLight.mangaShapeStrokeColor'), '#000000');
        } catch {
            this._fillColor = '#ffffff';
            this._strokeColor = '#000000';
        }
        this._shapeOpts.fill = this._fillColor;
        this._shapeOpts.strokeColor = this._strokeColor;
        // 红斜杠「去除」态的恢复值（去填充/去边框开关式记忆，灯箱同款）
        this._lastShapeFill = null;
        this._lastShapeStrokeWidth = null;

        // 图层系统（MangaLayers 混入）：draft.drawLayers 页面层栈（笔迹层/
        // 图片层，底→顶数组序），笔迹与图片都是图层；背景参考图不并入
        this._activeLayerId = null;    // 画笔目标层（笔迹层）
        this._selLayerId = null;       // 舞台选中的图片层（与元素选中互斥）
        this._layerImgCache = new Map();   // 图片层 src → {img}（跨页共享）
        this._nextLayerId = 1;

        // 右栏分区收纳（MangaDom 构建/绑定）：palette=色板、size=画幅+模式、
        // layers=图层、output=输出框。独立开关、默认都展开，全收起时右栏
        // 缩到只剩 40px 图标栏；视图态存 localStorage（ADR 019 口径：不入草稿存档）
        this._outSections = { palette: true, size: true, layers: true, output: true };
        try {
            const savedSec = JSON.parse(localStorage.getItem('lumenLight.mangaOutSections') || '{}');
            for (const k of Object.keys(this._outSections)) {
                if (typeof savedSec[k] === 'boolean') this._outSections[k] = savedSec[k];
            }
        } catch { /* 坏档用默认 */ }

        // AI 写提示词
        this.aiRunning = false;
        this.genRunning = false;   // 图像生成运行态（MangaGenerate 混入）
        this._aiModels = [];       // 聊天模型清单缓存（显示名/兜底用）
        this._skillBodies = new Map();   // 技能正文缓存 id→body（pi 技能库，ADR 017 决策八）

        // 调色工具会话（MangaAdjustTool 独立类，ADR 074；adjustBtn 由
        // MangaTools 工具栏创建时挂上）；_adjustPreview = { layerId, cv }
        // 调色预览钩子（MangaPageRender/MangaLayerPanel 消费）
        this.adjustBtn = null;
        this._adjustPreview = null;
        this._adjust = new MangaAdjustTool(this);

        // 移除工具会话（MangaRemoveTool 独立类，ADR 076）；_removeMask =
        // { layerId, cv } 遮罩预览钩子（MangaStage._renderStage 消费——
        // 舞台半透明红罩反馈，不进缩略图/导出）
        this._removeMask = null;
        this._remove = new MangaRemoveTool(this);

        // 草稿持久化（ADR 072：自动保存退役，显式保存是唯一持久化写）：
        // 自上次成功保存是否脏 / 首次构建后是否动过草稿（GET 恢复与用户
        // 首编辑的竞态闸）/ 在途保存的中止器
        this._saveDirty = false;
        this._draftTouched = false;
        this._saveAbort = null;
        // 保存点快照（保存/关闭确认的比对基准，见 _docSnapshot）：
        // _buildDom 建基线，恢复成功 / 保存成功后重建
        this._exportSnap = null;

        // 撤销/重做（ADR 017 决策十一）：快照式——草稿是纯 JSON 小对象，
        // 全量快照比命令闭包简单可靠（StudioHistory 同款取舍）。栈存
        // {label, snap}（snap = 变更前草稿），文本输入按防抖合并成一步
        this._undoStack = [];
        this._redoStack = [];
        this._textHistPending = null;   // 文本输入的"变更前"快照（防抖期间挂起）
        this._histTimer = null;

        // F5/关页兜底：有未保存改动时浏览器原生拦截确认（未保存=易失，
        // 灯箱同语义——不再 keepalive 补发把未保存改动持久化）
        window.addEventListener('beforeunload', (e) => {
            if (this._isPageDirty()) { e.preventDefault(); e.returnValue = ''; }
        });

        this._boxColors = [
            '#ffb454', '#7ce38b', '#ff7ab8', '#c3a6ff', '#ffe066',
            '#64d9c8', '#ff8f6b', '#9ad0ff', '#f4a4c0', '#b8e986'
        ];
        this._nextCid = 0;         // 元素稳定 id 计数器（见 _ensureItemIds）
        this._collapsedCids = new Set();  // 手动收起的卡片 cid 集合——卡片默认展开（按 cid 记忆，重排/改名不丢）
        this._hiddenCids = new Set();     // 隐藏的元素框 cid 集合——纯编辑器视图态（不进编译、不进存档）
        this._labelText = { object: '物体', character: '角色', text: '文字' };
        // 景别层次（编辑器侧辅助元数据 item.shot，编译前剥离——MOSS 产物不含它；
        // 作用是手写时自动前缀进 caption、AI 写文案时作为织入提示。
        // 只保留空间层次三档：远景/近景/特写属镜头景别另一套体系，且与
        // 前景语义重叠——要那种镜头感直接把词写进描述框即可）
        this._shotOptions = ['前景', '中景', '后景'];
        this._modeDesc = {
            single: '单一画面：元素自由排布，可自然重叠',
            multi_panel: '多格漫画/分镜：建议格子铺满画幅互不重叠',
            collage: '拼贴：元素像贴纸一样可重叠堆放'
        };

        // 生成图事件监听（MangaBackground 混入）：构造器即挂，不等首次
        // show——刷新后先出图、后开编辑器的窗口期也能接住回流
        this._attachGeneratedImageListener();
        // 画布删图联动清背景（MangaBackground 混入）：同样构造器即挂
        this._attachCanvasDeleteListener();
    }

    // ==================== 开合与保存/关闭确认 ====================

    /** 调色工具入口（左工具栏按钮消费；会话在 MangaAdjustTool，ADR 074） */
    openAdjust() { return this._adjust.open(); }

    /** 顶栏按钮开合：关走 requestClose（有未落画布的改动先确认，与 ×/ESC 同语义） */
    toggle() { this.visible ? this.requestClose() : this.show(); }

    show() {
        if (!this.dialog) this._buildDom();
        this.dialog.classList.add('is-open');
        this.visible = true;
        if (this.btn) this.btn.setAttribute('aria-expanded', 'true');
        this._renderAll();
        this._refreshModelDropdown();   // 每次打开刷新（模型清单/跟随目标可能已变）
        this._refreshSkillDropdown();   // 每次打开刷新（技能库可能刚上传/启停）
        this._refreshGenModelDropdown(); // 每次打开刷新（API 生图清单可能已变）
        this._syncGenModeUi();           // 恢复上次生成模式的高亮与显隐
    }

    hide() {
        if (!this.dialog) return;
        if (this._adjust?._open) this._adjust.close();   // 调色中关窗=丢弃预览（灯箱同语义）
        if (this._remove?._open) this._remove.close();   // 移除涂抹中关窗=丢弃未提交遮罩（ADR 076）
        // 关窗后 activeTool 不得停留在 remove（会话已关——重开时按钮
        // 高亮但涂抹静默失效，ADR 076 用户实测踩中）；起笔自愈兜底另在
        // MangaRemoveTool._strokeStart
        if (this.activeTool === 'remove') this._setTool('select');
        this.dialog.classList.remove('is-open');
        this.visible = false;
        if (this._drag && this._drag.mode === 'shape-create') {
            this._shapeCreateAbort();   // 拖拽创建中的临时层随窗摘除（从未入账零痕迹）
        }
        this._drag = null;
        this._abortTextEdit();     // 就地编辑框硬清理（layer 栈不动，下次打开按草稿恢复）
        this._hideSaveConfirm();   // 确认浮层随窗收起（下次打开保持干净态）
        if (this.btn) this.btn.setAttribute('aria-expanded', 'false');
    }

    // ==================== 保存 / 关闭确认（参考 ImageStudio 右上角） ====================

    /**
     * 文档快照字符串：整文档 JSON（pages + active——保存语义灯箱化后，
     * 切页也是未保存改动，重进回到上次保存时的页）。保存点脏检测的
     * 比对基准：this._exportSnap 由 _buildDom / 恢复成功 / 保存成功重建
     */
    _docSnapshot() {
        return JSON.stringify({ pages: this.pages, active: this.activePage });
    }

    /** 距上次「保存」是否有改动（关窗确认的依据；快照基线未建时不算脏） */
    _isPageDirty() {
        return this._exportSnap != null && this._docSnapshot() !== this._exportSnap;
    }

    /**
     * 关闭请求（右上 × / ESC / 顶栏按钮再点共用）：距上次保存有改动先弹
     * 确认浮层（保存并关闭 / 直接关闭），无改动直接关。保存语义灯箱化
     * （ADR 072）后「直接关闭」= 丢弃未保存的改动，重进还原为上次保存态
     */
    requestClose() {
        // 就地编辑中的文字先提交（内容写回草稿后才参与脏判定/写回快照）
        if (this._textEdit) this._commitTextEdit();
        if (this._isPageDirty()) {
            this._showSaveConfirm();
            return;
        }
        this.hide();
    }

    /**
     * 确认浮层弹出（默认=关窗语义；切项目等场景传 opts 换文案与动作，
     * 浮层 z20 盖不过项目弹窗 z40，调用方须先收项目弹窗）
     */
    _showSaveConfirm(opts = {}) {
        if (!this._confirmEl) return;
        this._confirmAction = {
            onSave: opts.onSave || null,     // null = 默认 save() 成功后关窗
            onClose: opts.onClose || null,   // null = 默认直接关窗
        };
        if (this._confirmTextEl) this._confirmTextEl.textContent = opts.text || '页面有未保存的修改，保存后关闭吗？';
        if (this._confirmSaveBtnEl) this._confirmSaveBtnEl.textContent = opts.saveLabel || '保存并关闭';
        if (this._confirmCloseBtnEl) this._confirmCloseBtnEl.textContent = opts.closeLabel || '直接关闭';
        this._confirmEl.hidden = false;
    }

    /** 浮层收起并还原默认文案/动作（下次弹出从干净默认态开始） */
    _hideSaveConfirm() {
        if (!this._confirmEl) return;
        this._confirmEl.hidden = true;
        this._confirmAction = null;
        if (this._confirmTextEl) this._confirmTextEl.textContent = '页面有未保存的修改，保存后关闭吗？';
        if (this._confirmSaveBtnEl) this._confirmSaveBtnEl.textContent = '保存并关闭';
        if (this._confirmCloseBtnEl) this._confirmCloseBtnEl.textContent = '直接关闭';
    }

    /** 确认浮层「保存并关闭」：save() 成功才关窗（落盘失败留在编辑器，状态栏已报错可重试） */
    async _confirmSaveAndClose() {
        const action = this._confirmAction;
        this._hideSaveConfirm();
        if (action && action.onSave) { await action.onSave(); return; }
        const ok = await this.save();
        if (ok) this.hide();
    }

    /**
     * 确认浮层「直接关闭/放弃修改」：不落盘（未保存改动按灯箱语义丢弃）。
     * 关窗分支丢弃后立即从服务端重载已保存态——只丢内存不重载的话，删除
     * 等改动仍留在内存，同一会话内重开编辑器看到的仍是改过的文档（灯箱
     * 重开=重读底图，同语义）。重载落在 MangaProjects 混入（文档归属逻辑
     * 在那边）
     */
    _confirmCloseOnly() {
        const action = this._confirmAction;
        this._hideSaveConfirm();
        if (action && action.onClose) { action.onClose(); return; }
        this.hide();
        this._reloadSavedDocument();
    }

    /**
     * 保存（右上蓝钮，保存后不退出——ImageStudio 同语义；ADR 072 后是
     * 唯一持久化写）：距上次保存点无内容变化 → 直接确认不重复落盘；
     * 有变化 → 落盘成功才推进保存点（失败如实报错、保存点不动，关窗
     * 确认仍视作脏）。图层写回画布已退役（ADR 071 交付独立：漫画活在
     * 项目文件夹里，画布只在「导出本页」显式交付时收到一张整页合成图）。
     * 返回是否成功（确认浮层「保存并关闭」分支仅在 true 时关窗）
     */
    async save() {
        const snap = this._docSnapshot();
        if (snap === this._exportSnap) {
            this._status('已保存（页面无新改动）');
            return true;
        }
        if (!(await this._saveNow())) return false;
        this._exportSnap = snap;
        this._status(this.currentProjectId ? '已保存到当前项目' : '已保存（默认草稿）');
        return true;
    }

    // ==================== 导出本页到画布（显式交付，ADR 071） ====================

    /**
     * 整页所见即所得合成一张 PNG 落画布视口中心（唯一保留的画布交付口
     * ——逐层写回已退役）：白页底 + 当前页图层栈（笔迹/图片/文字/形状，
     * 与舞台同一渲染口径 _drawPageLayers，恒等变换草稿像素 1:1）。元素
     * 景别框是结构化标注不属页面视觉，不入合成。命名 manga_page_<ts>.png
     */
    async _exportPageToCanvas() {
        const app = window.canvas;
        if (!app || !app.images || !app.viewport) {
            this._status('画布未就绪，无法导出', true);
            return;
        }
        // 整页合成收口在 MangaExport 混入 _composePageCanvas（ADR 079：
        // 本页到画布 / 本页到本地 / 本项目 zip 三口共用同一渲染口径）
        const cv = await this._composePageCanvas(this.draft);
        try {
            await this._placeCompositeAsNewImage(app, cv.toDataURL('image/png'), `manga_page_${Date.now()}.png`);
            this._status('已导出当前页到画布（整页合成图）');
        } catch (err) {
            this._status('导出失败：' + ((err && err.message) || err), true);
        }
    }

    /**
     * 无画布对应图的新建落图（导出本页交付出口，ADR 071）：页面合成图以
     * 草稿像素原生分辨率落画布视口中心（LlmImageDrag.dropToCanvas 同款落
     * 点语义），返回新建的画布图对象；name 可指定画布图文件名
     */
    async _placeCompositeAsNewImage(app, url, name) {
        const img = new Image();
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = () => reject(new Error('写回图加载失败'));
            img.src = url;
        });
        const rect = app.canvas.getBoundingClientRect();
        const cp = app.viewport.screenToCanvas(
            rect.left + rect.width / 2, rect.top + rect.height / 2);
        return app.images.addImage({
            img,
            x: cp.x - img.width / 2,
            y: cp.y - img.height / 2,
            width: img.width,
            height: img.height,
            isPlaceholder: false,
            source: 'manga',
            name: name || `manga_layer_${Date.now()}.png`
        });
    }

    /**
     * 等齐页面图层引用的图片加载完成（写回前置，防缺图/缺底片）：
     * 图片层**全部**等（含隐藏层——写回要对齐其画布图 src，隐藏层底片
     * 同样参与）；加载完成或出错都放行（出错=该层暂缺图，写回时按层
     * 计失败）；3s 超时兜底不挂死保存
     */
    _awaitLayerImages() {
        const pending = [];
        for (const l of this._ensureDrawLayers()) {
            if (!l || !l.image || !l.image.src) continue;
            const img = this._ensureLayerImage(l.image.src);
            if (img.complete) continue;
            pending.push(new Promise((resolve) => {
                if (img.complete) { resolve(); return; }
                const done = () => { img.onload = null; img.onerror = null; resolve(); };
                img.onload = done;
                img.onerror = done;
                setTimeout(done, 3000);
            }));
        }
        return Promise.all(pending);
    }

    // ==================== 并排窗口宽度（右缘留白给面板） ====================

    /**
     * 留白钳制：0（全屏）到 innerWidth-900（保住编辑器三栏最小宽）。
     * 与坐标编辑器在此分叉：无 360px 下限——漫画默认全屏（留白 0），
     * 右缘手柄拖出多少留白全由用户决定
     */
    _clampGap(px, innerWidth) {
        const max = Math.max(0, innerWidth - 900);
        const n = typeof px === 'number' && Number.isFinite(px) ? px : 0;
        return Math.round(Math.max(0, Math.min(max, n)));
    }

    /** 默认留白：恒 0（全屏开窗；用户拖拽过的值在 _applyStoredGap 里优先） */
    _defaultGap() {
        return 0;
    }

    /** 启动时应用留白宽度：用户拖拽过的值（localStorage）优先，否则全屏（0） */
    _applyStoredGap() {
        const raw = Number(localStorage.getItem('lumenLight.mangaDialogGap'));
        const gap = Number.isFinite(raw) && raw > 0
            ? this._clampGap(raw, window.innerWidth)
            : this._defaultGap();
        this.dialog.style.setProperty('--manga-gap', gap + 'px');
    }

    /** 右缘拖拽：更新 --manga-gap（窄屏媒体查询强制全屏时拖拽自然无效）、
     *  rAF 节流重绘舞台（舞台按容器尺寸自适应缩放草稿），松手持久化 */
    _onEdgeResizeStart(e, handle) {
        if (e.button !== 0) return;
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        handle.classList.add('dragging');
        let raf = 0;
        let lastGap = this._clampGap(window.innerWidth - e.clientX, window.innerWidth);
        const onMove = (ev) => {
            lastGap = this._clampGap(window.innerWidth - ev.clientX, window.innerWidth);
            this.dialog.style.setProperty('--manga-gap', lastGap + 'px');
            if (!raf) raf = requestAnimationFrame(() => { raf = 0; this._renderStage(); });
        };
        const finish = (ev) => {
            try { handle.releasePointerCapture(ev.pointerId); } catch { /* 已释放 */ }
            handle.classList.remove('dragging');
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', finish);
            handle.removeEventListener('pointercancel', finish);
            if (raf) cancelAnimationFrame(raf);
            this._renderStage();
            localStorage.setItem('lumenLight.mangaDialogGap', String(lastGap));
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', finish);
    }

    /**
     * ESC 是否该关窗：事件源自弹窗内、或无具体焦点目标（body）时才关——
     * 并排形态下焦点在右侧面板输入框按 ESC 是取消面板输入，不是关编辑器
     */
    _shouldCloseOnEscape(target) {
        const root = typeof document !== 'undefined' ? document : null;
        if (!target || target === root || (root && target === root.body)) return true;
        return this.dialog ? this.dialog.contains(target) : true;
    }

    // ==================== 共享小工具（面板与舞台都用） ====================

    _colorFor(i) { return this._boxColors[i % this._boxColors.length]; }

    /**
     * 元素稳定 id（cid）：创建即分配、删除不复用（画布节点 #NNN 同款策略）。
     * 编号徽标与颜色跟随 cid 而非数组下标——图层重排只改 z 序，同一框的
     * 身份（颜色+编号）不变；否则置底/置顶后所有框的编号颜色轮转，按
     * 编号识别框的用户会看到「尺寸互相换错」。旧快照/磁盘草稿缺 cid 在
     * 此回填，计数器按已分配的最大值同步
     */
    _ensureItemIds() {
        for (const it of this.draft.items) {
            if (!Number.isInteger(it.cid)) it.cid = this._nextCid++;
            else this._nextCid = Math.max(this._nextCid, it.cid + 1);
        }
    }

    _status(text, isError) {
        this.statusEl.textContent = text || '';
        this.statusEl.classList.toggle('is-error', !!isError);
    }

    // ==================== 草稿失效枢纽 ====================

    /** 草稿变化后编译产物失效（复制按钮回落禁用态；右栏正在显示编译
     *  产物时清空防过期——AI 文案留档不误清）+ 防抖自动保存。
     *  生成按钮不禁用：点击时自动编译，编译失败走状态栏报错 */
    _invalidateCompiled() {
        this.compiled = null;
        this.copyBtn.disabled = true;
        this._clearOutIfCompile();
        // 手动编辑草稿后，右栏 AI 输出不再参与编译（内容保留供参考，只
        // 消费标记）——否则改了左边，编译还按旧 AI 文案走，静默覆盖手改
        if (this._outMode === 'ai') this._outMode = '';
        this._draftTouched = true;
        this._scheduleSave();
        if (this.railListEl) this._scheduleThumbRefresh();   // 活动页缩略图跟随内容（MangaPages 混入）
    }

    /** 右栏当前显示的是编译产物时清空（编译产物随草稿变化即过期） */
    _clearOutIfCompile() {
        if (this._outMode !== 'compile') return;
        this.aiOutTa.value = '';
        this.jsonNote.textContent = '';
        this._outMode = '';
    }

    // ==================== 编译与导出 ====================

    /** 编译输入：剥离景别（item.shot）等编辑器侧元数据——
     *  产物保持标准 MOSS schema（上游编译器拒绝未知字段） */
    _draftForCompile() {
        // 剥离编辑器侧元数据（编译层白名单会拒绝未认可字段）：
        // shot = 景别（织进 caption 后完成使命）、cid = 稳定 id（编号/颜色显示）、
        // title = 框标题（舞台标签显示）——三者都不属于 MOSS 草稿契约；
        // background = 背景参考图 URL（MangaBackground 混入，纯参照不参与编译）；
        // backgroundSrcId = 背景来源画布图 id（删图联动用，同属编辑器侧元数据）；
        // strokes/drawLayers = 画笔笔迹与图层（MangaLayers 混入，页面草稿层
        // 不参与编译——剥离后笔迹增删不清右栏编译产物）
        const { background, backgroundSrcId, strokes, drawLayers, ...draftCore } = this.draft;
        return {
            ...draftCore,
            items: draftCore.items.map(({ shot, cid, title, ...rest }) => rest)
        };
    }

    _compile() {
        // 右栏是 AI 输出态时按右栏编译：AI 文案套在草稿几何上参与编译
        // （不回写左侧元素卡）；解析失败回落按草稿编译
        let input = this._draftForCompile();
        if (this._outMode === 'ai' && this.aiOutTa.value.trim()) {
            try {
                const merged = JSON.parse(JSON.stringify(input));
                this._applyAiParsed(merged, this._parseAiResult(this.aiOutTa.value));
                input = merged;
            } catch { /* AI 文案解析失败：按草稿原稿编译 */ }
        }
        const r = CoordinateLayout.compileDraft(input);
        this.compiled = r;
        if (!r.ok) {
            this._clearOutIfCompile();   // 旧产物已过期，不再显示
            this.copyBtn.disabled = true;
            this._status('编译失败：' + r.error, true);
            return;
        }
        this.aiOutTa.value = r.prompt;   // 编译产物也进右栏输出框
        this.jsonNote.textContent =
            `尺寸 ${this.draft.width}×${this.draft.height} 需单独设置到工作流（提示词不含宽高）`;
        this._outMode = 'compile';
        this.copyBtn.disabled = false;
        this._status('编译成功', false);
    }

    async _copyJson() {
        if (!this.compiled?.ok) this._compile();
        const prompt = this.compiled?.prompt;
        if (!prompt) return;
        try {
            await navigator.clipboard.writeText(prompt);
            this._status('已复制到剪贴板', false);
            window.socket?.showNotification?.('坐标提示词已复制');
        } catch {
            // 剪贴板 API 不可用时回退：全选右栏输出框（此刻即编译产物）让用户 Ctrl+C
            this.aiOutTa.select();
            this._status('剪贴板不可用，已全选输出框——按 Ctrl+C 复制', true);
        }
    }

}

// 暴露到全局作用域（经典 script，app.js 实例化）
window.MangaEditor = MangaEditor;
