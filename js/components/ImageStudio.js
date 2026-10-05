/**
 * ==========================================================================
 * LumenLight 图像编辑器（ImageStudio）—— PS 式图层编辑灯箱（主类）
 * 作用：编辑画布图片的统一入口，持有全部编辑状态并编排各功能区子模块
 *       （js/components/image-studio/，2026-10 自本文件拆出）：
 *         StudioDomBuilder   DOM 构建与事件绑定（顶栏/工具栏/舞台/弹窗）
 *         StudioLayerPanel   图层栈 DOM 与图层面板 UI（增删/排序/联动）
 *         StudioImport       置入本地/画布图片为图层
   *         StudioMoveTool     移动工具（选中/拖动/拖角缩放 + 磁吸吸附 + 选中框）
   *         StudioTextTool     文字工具（文字层添加/就地编辑/竖排逐字自绘）
   *         StudioCropTool     裁剪/扩图（画幅框锚点拖拽 + 覆盖层渲染）
 *         StudioSave         保存拍平契约（底片/笔迹/遮罩/图层栈/扩图导出）
 *       主类保留：核心状态（图层栈/画幅框/工具/脏标记/视图变换）、
 *       打开关闭流程、统一绘制输入、状态访问器（_activeLayer 等），
 *       并为子模块方法保留同名薄代理——内部/外部调用点零改动。
 *
 * 功能（与画布 ImageToolbar 的「编辑」入口对接）：
 *     左工具栏：移动（图层选中/拖动/拖角等比缩放）/画笔/橡皮/模糊笔刷
 *     （平铺柔化，顶栏「强度」调 σ）/文字/遮罩模式/
 *     移除工具/还原/裁剪；顶栏「文件」菜单（置入本地/画布图片→新图层）+ 粗细
 *     + 文字选项（字体/字号/横竖排，文字工具激活时替换粗细）+
 *     右侧工具栏（历史记录按钮：面板回退/前进任意步骤，Ctrl+Z/Ctrl+Shift+Z）；
 *     保存；右侧色板与图层面板（透明度、拖放排序、右键菜单、Delete 键
 *     删除激活图层）；滚轮缩放 + 中键平移；ESC 关闭（脏改动先确认）。
 *
 * 保存契约（向下兼容，实现在 StudioSave）：
 *   1. 背景层/图片层有变化（涂画/变换/显隐）→ 两层按变换拍平写回
 *      image.img.src（文档底片；实时保存自动按新内容上传）；
 *   2. 上层内容 → 图层栈 2..n 自下而上按变换拍平（跳过隐藏层、逐层乘
 *      透明度）导出为 image.editStrokes（editStrokesOpacity=1）；
 *   3. 遮罩 → 全图层遮罩画布按变换取并集导出为 image.mask（Comfy
 *      提交时烘进槽位图 alpha，透明=重绘区）；
 *   4. 画幅框变更 → outpaintComplete 事件按变换合成全部可见层导出
 *      白底新图落到原图旁。
 *   图层栈结构序列化为 image.studioLayers（各层 paint/mask/变换全量
 *   存储），F5/存档恢复后图层结构与变换完整保留；旧格式自动迁移
 *   （旧 base 条目 → 图片层，editStrokes/mask → 「图层 1」）。
 * 坐标系：屏幕坐标 ÷ 缩放比 = 文档坐标（滚轮缩放 + 中键拖拽平移）。
 * 对应组件：js/components/ImageToolbar.js（入口）、css/image-studio.css、
 *           css/image-editor.css（复用基础灯箱样式）、js/app.js
 *           （outpaintComplete 落图）、ProjectSerializer（studioLayers）
 * ==========================================================================
 */

class ImageStudio {
    /** 预设色块（与原画笔灯箱一致：红/黑/白/粉红/蓝/橙/浅蓝/绿） */
    static COLORS = [
        { name: '红', value: '#ef4444' },
        { name: '黑', value: '#000000' },
        { name: '白', value: '#ffffff' },
        { name: '粉红', value: '#f472b6' },
        { name: '蓝', value: '#3b82f6' },
        { name: '橙', value: '#f97316' },
        { name: '浅蓝', value: '#7dd3fc' },
        { name: '绿', value: '#22c55e' }
    ];
    /** 遮罩笔迹颜色（全强度存储；显示层按图层透明度×0.55 压暗显示） */
    static MASK_COLOR = '#ff0000';
    /** 最近使用色条数（色板行首一格一色，4 列网格恰为一行） */
    static RECENT_MAX = 4;
    /** 历史快照上限（条）：快照 = 图层栈 dataURL 全量序列化，控内存 */
    static HISTORY_MAX = 20;
    /** 遮罩显示压暗系数：呈现惯例的"半透明红"观感，数据永远全强度 */
    static MASK_DISPLAY_OPACITY = 0.55;
    /** 遮罩判定阈值：alpha 高于此值的像素视为重绘区（Comfy 烘焙
     *  ImagePipeline.bakeMask 消费；自 ImageMaskEditor 迁移至此） */
    static ALPHA_THRESHOLD = 127;
    /** 笔刷粗细范围（原图像素） */
    static MIN_SIZE = 2;
    static MAX_SIZE = 100;
    /** 笔刷视觉倍率：滑块值 × 此系数 = 实际笔迹宽度（光标圈同步乘它，
     *  始终与笔迹 1:1）。调手感只改这一个数 */
    static SIZE_SCALE = 2;
    // ---- 画幅框约束（移植自 ImageOutpaint） ----
    static MIN_DIM = 64;        // 画幅最小边（文档像素）
    static MAX_DIM = 8192;      // 画幅最大边
    static MIN_VISIBLE = 64;    // 框与原图可见交集的最小边（防把图完全裁没）
    static ANCHOR_R = 4.5;      // 锚点视觉半径（屏幕像素）
    static HIT_R = 12;          // 锚点命中半径（屏幕像素）
    static CROP_BLEED = 48;     // 裁剪覆盖层出血边距：锚点/尺寸标签在画幅框
                                // 边缘之外绘制，不外扩会被画布边界裁掉一半
    /** 移动/缩放磁吸阈值（屏幕像素，不随缩放变化——放大后手部抖动的
     *  文档位移更小，按文档坐标算阈值反而碍事） */
    static SNAP_PX = 8;
    /** 磁吸参考线颜色（PS 对齐提示同款粉） */
    static SNAP_GUIDE_COLOR = '#ff4fd8';
    // ---- 右侧面板 ----
    static SIDE_MIN = 180;      // 面板宽度范围（可拖拽调节）
    static SIDE_MAX = 420;
    static SIDE_DEFAULT = 240;

    /**
     * @param {Object} canvas - 画布实例（保存写回后触发重绘用）
     */
    constructor(canvas) {
        this.canvas = canvas;
        this.image = null;          // 当前编辑的画布图片对象
        this.iw = 0;                // 原图尺寸（文档像素）
        this.ih = 0;
        this.frame = { fx: 0, fy: 0, fw: 0, fh: 0 };
        this.tool = 'brush';        // 'brush' | 'eraser' | 'crop'
        this.activeLayerId = null;  // 激活图层（绘制目标）
        this.layers = [];           // 图层栈（自下而上；[0] = 原图层）
        this._layerSeq = 0;         // 图层命名计数
        this.color = ImageStudio.COLORS[0].value;
        this.recentColors = [];     // 最近使用色（MRU 去重，DomBuilder 渲染行首）
        this.sizes = { strokes: 14, mask: 30 };   // 按涂画模式记忆笔刷粗细（上限 MAX_SIZE）
        this.drawing = false;
        this.last = null;
        this.moveDrag = null;       // 移动工具拖拽态 {mode:'move'|'resize', ...}
        this._snapGuides = null;    // 磁吸参考线 {v,h}（吸附线文档坐标，拖拽中
                                    // 由 StudioMoveTool 写入，松手清除）
        // 文字工具当前选项（顶栏可改；addTextLayer 取其为新文字层默认值）
        this.textOpts = { font: 'Microsoft YaHei', size: 48, vertical: false };
        // 形状工具当前选项（顶栏可改；addShapeLayer 取其为新形状层默认值；
        // strokeWidth 0 = 无边框，_lastStrokeWidth 供「无」按钮恢复边宽）
        this.shapeOpts = {
            type: 'rect', fill: '#ffffff', strokeColor: '#000000',
            strokeWidth: 6, radius: 24, tail: 'lb'
        };
        this._lastStrokeWidth = 6;
        this._lastFill = '#ffffff';   // 去填充后恢复用
        // base = 原图层涂画（保存时烘焙进 img.src）；strokes = 上层笔迹；
        // mask = 遮罩；frame = 画幅框；layers = 图层结构（增删/排序/显隐/
        // 透明度——驱动保存时重新拍平并序列化 studioLayers）
        this.dirty = { base: false, strokes: false, mask: false, frame: false, layers: false };
        this.dragEdge = null;       // 裁剪拖拽中的边
        this.dragLabel = '';
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.panning = false;       // 中键拖拽平移中

        // 功能区子模块：持有宿主实例读写 this 上的状态与方法；
        // 主类在文件尾保留同名薄代理，调用点零改动。
        // DomBuilder 收尾构建 DOM 并绑定全部事件（依赖前述状态字段）
        this._layers = new StudioLayerPanel(this);
        this._import = new StudioImport(this);
        this._move = new StudioMoveTool(this);
        this._text = new StudioTextTool(this);
        this._shape = new StudioShapeTool(this);
        this._blur = new StudioBlurTool(this);
        // 模糊笔刷强度（文档像素，σ = 强度/10），顶栏强度滑杆设置
        this.fxStrength = 16;
        this._colorPicker = new StudioColorPicker(this);
        this._history = new StudioHistory(this);
        this._crop = new StudioCropTool(this);
        this._save = new StudioSave(this);
        this._dom = new StudioDomBuilder(this);
    }

    // ==================== 打开 / 关闭 ====================

    /**
     * 打开编辑器
     * @param {Object} imageObj - 画布图片对象（ImageToolbar.selectedImages[0]）
     * @param {string} [focus] - 入口聚焦：'crop' 裁剪扩图（其余入口一律
     *                           默认移动工具——先选层/摆位，再涂画）
     */
    open(imageObj, focus = 'strokes') {
        if (!imageObj?.img) return;
        this.image = imageObj;
        // 取消画布上的选中态：灯箱遮罩是半透明的（rgba 0.85），画布给
        // 图片画的青色选中框会透出来，与灯箱自己的选中框叠成两个框——
        // 画布框套的是画布显示矩形（画布坐标系），和灯箱文档视图对不上，
        // 看起来就是"选框比图片大"。同步 draw() 立即抹掉画布上的框
        if (this.canvas?.images?.selectedIds?.size) {
            this.canvas.images.select(null);
            this.canvas.draw();
        }
        this.drawing = false;
        this.dragEdge = null;
        this.dragLabel = '';
        this.dirty = { base: false, strokes: false, mask: false, frame: false, layers: false };
        this.confirmEl.hidden = true;
        this.msgEl.textContent = '';
        this._maskMode = false;
        this._autoRemove = false;   // 移除模式（自带遮罩涂抹，松手自动抹除）
        this._restoring = false;    // 历史恢复中（防重入）
        this._cursorInStage = false; // 指针是否在舞台内（光标圈显隐的门禁之一：
                                     //  顶栏/面板调滑杆时不应把圈点亮在旧位置）
        this.layerMenuEl.hidden = true;

        // 原图尺寸与画幅框
        this.iw = imageObj.img.naturalWidth;
        this.ih = imageObj.img.naturalHeight;
        this.frame = { fx: 0, fy: 0, fw: this.iw, fh: this.ih };

        // 重建图层栈：底部固定「背景（白底，锁变换）+ 图层 0（图片层，
        // 可移动缩放）」两层，其上按 studioLayers 重建常规图层。
        // _imagePristine 保存图片层 pristine 内容快照，供「还原」恢复。
        // 旧格式自动迁移：旧 base 条目（visible/opacity/mask，涂画已烘焙
        // 进 img）→ 图片层；editStrokes/mask → 「图层 1」
        this._layerSeq = 0;
        this.layers = [];
        const loadJobs = [];

        const bg = this._createLayerCanvas('背景', { isBackground: true });
        const bgCtx = bg.paintCv.getContext('2d');
        bgCtx.fillStyle = '#ffffff';
        bgCtx.fillRect(0, 0, this.iw, this.ih);
        bg.empty = false;
        // 注意：bg/imgLayer 不在此处入栈——入栈位置由下方分支决定
        // （新格式按保存顺序重建，旧格式在此处固定入栈），push 两次
        // 会导致图层列表出现成对的背景/图层 0

        const imgLayer = this._createLayerCanvas('图层 0', { isImage: true });
        imgLayer.paintCv.getContext('2d').drawImage(imageObj.img, 0, 0);
        imgLayer.empty = false;
        this._imagePristine = document.createElement('canvas');
        this._imagePristine.width = this.iw;
        this._imagePristine.height = this.ih;
        this._imagePristine.getContext('2d').drawImage(imageObj.img, 0, 0);

        const specs = Array.isArray(imageObj.studioLayers) ? imageObj.studioLayers : null;
        if (specs && specs[0] && specs[0].isBackground) {
            // 新格式：按保存顺序重建图层栈（图片层可被拖到任意 ≥1 的
            // 位置）——背景层/图片层以标志识别而非固定下标。 sawBg/sawImg
            // 防御：若历史版本存过重复条目，加载时静默去重
            let sawBg = false, sawImg = false;
            for (const spec of specs) {
                if (spec.isBackground) {
                    if (sawBg) continue;
                    sawBg = true;
                    bg.visible = spec.visible !== false;
                    bg.opacity = spec.opacity ?? 1;
                    loadJobs.push(this._loadInto(bg.paintCv, spec.paint));
                    loadJobs.push(this._loadInto(bg.maskCv, spec.mask));
                    this.layers.push(bg);
                } else if (spec.isImage) {
                    if (sawImg) continue;
                    sawImg = true;
                    imgLayer.visible = spec.visible !== false;
                    imgLayer.opacity = spec.opacity ?? 1;
                    imgLayer.tx = Number(spec.x) || 0;
                    imgLayer.ty = Number(spec.y) || 0;
                    imgLayer.tscale = Number(spec.scale) > 0 ? Number(spec.scale) : 1;
                    // 图片层内容以持久化 paint 为准（img.src 已是含背景的合成底片）；
                    // pristine 快照必须等异步加载完成后再拍，否则会拍到空画布
                    if (spec.paint) {
                        imgLayer.paintCv.getContext('2d').clearRect(0, 0, this.iw, this.ih);
                        loadJobs.push(this._loadInto(imgLayer.paintCv, spec.paint).then(() => {
                            const pctx = this._imagePristine.getContext('2d');
                            pctx.clearRect(0, 0, this.iw, this.ih);
                            pctx.drawImage(imgLayer.paintCv, 0, 0);
                        }));
                    }
                    loadJobs.push(this._loadInto(imgLayer.maskCv, spec.mask));
                    this.layers.push(imgLayer);
                } else {
                    this._layerSeq += 1;
                    const layer = this._createLayerCanvas(
                        spec.name || `图层 ${this._layerSeq}`,
                        { w: Number(spec.w) || undefined, h: Number(spec.h) || undefined });
                    layer.visible = spec.visible !== false;
                    layer.opacity = spec.opacity ?? 1;
                    layer.tx = Number(spec.x) || 0;
                    layer.ty = Number(spec.y) || 0;
                    layer.tscale = Number(spec.scale) > 0 ? Number(spec.scale) : 1;
                    layer.empty = !spec.paint;
                    const paintJob = this._loadInto(layer.paintCv, spec.paint);
                    loadJobs.push(paintJob);
                    loadJobs.push(this._loadInto(layer.maskCv, spec.mask));
                    if (spec.text) {
                        // 文字层：恢复文字属性并按属性重渲染——落盘 paint 仅作
                        // 字体缺失时的兜底，重渲染保证与当前字体环境一致
                        layer.isText = true;
                        layer.text = {
                            font: 'Microsoft YaHei', size: 48,
                            vertical: false, color: '#ef4444', ...spec.text
                        };
                        if (layer.text.content) layer.empty = false;
                        paintJob.then(() => this._text._render(layer));
                    }
                    if (spec.shape) {
                        // 形状层：恢复形状属性并按属性重渲染（paint 同为兜底）
                        layer.isShape = true;
                        layer.shape = {
                            type: 'rect', w: 100, h: 80, fill: '#ffffff',
                            strokeColor: '#000000', strokeWidth: 6,
                            radius: 0, tail: 'lb', ...spec.shape
                        };
                        paintJob.then(() => this._shape._render(layer));
                    }
                    this.layers.push(layer);
                }
            }
            // 兜底：背景层条目缺失时补回最底（图片层没有兜底——
            // 它可被用户删除，栈里没有就是没有，不许复活）
            if (!sawBg) this.layers.unshift(bg);
        } else {
            // 旧格式/无栈数据：底片两层固定垫底
            this.layers.push(bg);
            this.layers.push(imgLayer);
            if (specs) {
                // 旧格式迁移：specs[0] 是旧原图层条目 → 并入图片层
                const oldBase = specs[0] || {};
                imgLayer.visible = oldBase.visible !== false;
                imgLayer.opacity = oldBase.opacity ?? 1;
                loadJobs.push(this._loadInto(imgLayer.maskCv, oldBase.mask));
                for (let i = 1; i < specs.length; i++) {
                    const spec = specs[i];
                    this._layerSeq += 1;
                    const layer = this._createLayerCanvas(
                        spec.name || `图层 ${this._layerSeq}`);
                    layer.visible = spec.visible !== false;
                    layer.opacity = spec.opacity ?? 1;
                    layer.empty = !spec.paint;
                    loadJobs.push(this._loadInto(layer.paintCv, spec.paint));
                    loadJobs.push(this._loadInto(layer.maskCv, spec.mask));
                    this.layers.push(layer);
                }
            } else if (imageObj.editStrokes || imageObj.mask) {
                // 更旧迁移：已有笔迹/遮罩映射为「图层 1」
                this._layerSeq = 1;
                const layer = this._createLayerCanvas('图层 1');
                loadJobs.push(this._loadInto(layer.paintCv, imageObj.editStrokes));
                loadJobs.push(this._loadInto(layer.maskCv, imageObj.mask));
                this.layers.push(layer);
            }
        }

        // 就绪门闩：既有图层内容全部加载完才允许落笔/保存
        // （防止在空画布上擦除/保存，覆盖掉尚未加载的图层内容）
        this._readyDone = false;
        this._readyAll = Promise.all(loadJobs).then(() => {
            this._readyDone = true;
            // 历史基线：刚打开未修改的完整状态（此后每个操作完成点追加）
            this._history.reset();
            this._pushHistory('打开');
        });

        this.activeLayerId = this.layers[this.layers.length - 1].id;
        if (focus === 'crop') {
            this.setTool('crop');
        } else {
            // 默认移动工具：进入即见选中框，先摆位/缩放，涂画再切画笔
            this.setTool('move');
        }
        this._rebuildLayerDom();
        this._renderLayerList();
        this._syncPanels();

        // 先显示再适配：舞台尺寸要在可见状态下测量
        this.overlayEl.style.display = 'flex';
        this.fitView();
    }

    /** 把 data URL 内容异步画进画布（空内容立即完成） */
    _loadInto(cv, dataUrl) {
        return new Promise((resolve) => {
            if (!dataUrl) { resolve(); return; }
            const loader = new Image();
            loader.onload = () => {
                cv.getContext('2d').drawImage(loader, 0, 0);
                resolve();
            };
            loader.onerror = () => resolve();
            loader.src = dataUrl;
        });
    }

    /** 创建一块图层画布对（paint + mask），不进栈。
     *  尺寸默认文档大小（背景/图片层/新建空图层，可全文档涂画）；
     *  置入的图片层传 w/h = 内容自身尺寸——内容紧致，选框/命中/缩放
     *  都以内容矩形为准（画布图片对象同语义）。
     *  变换字段 tx/ty/tscale：文档坐标下的偏移与等比缩放 */
    _createLayerCanvas(name, { isBackground = false, isImage = false, w, h } = {}) {
        const cw = Math.max(1, Math.round(w || this.iw));
        const ch = Math.max(1, Math.round(h || this.ih));
        const mk = () => {
            const cv = document.createElement('canvas');
            cv.className = 'ie-strokes';
            cv.width = cw;
            cv.height = ch;
            return cv;
        };
        return {
            id: `layer_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name,
            isBackground,
            isImage,
            visible: true,
            opacity: 1,
            tx: 0,
            ty: 0,
            tscale: 1,
            empty: true,            // 尚无任何像素（命中检测跳过空图层）
            paintCv: mk(),
            maskCv: mk()
        };
    }

    _stackIndex() {
        return Math.max(0, this.layers.findIndex((l) => l.id === this.activeLayerId));
    }

    _activeLayer() {
        return this.layers.find((l) => l.id === this.activeLayerId) || null;
    }

    // ==================== 工具状态 ====================

    setTool(tool) {
        this.tool = tool;
        this.moveBtn.classList.toggle('active', tool === 'move');
        this.brushBtn.classList.toggle('active', tool === 'brush');
        this.eraserBtn.classList.toggle('active', tool === 'eraser');
        this.textBtn.classList.toggle('active', tool === 'text');
        this.shapeBtn.classList.toggle('active', tool === 'shape');
        this.fxBtn.classList.toggle('active', tool === 'fx');
        this.cropBtn.classList.toggle('active', tool === 'crop');
        // 离开文字工具先提交未完成的文字编辑（点保存/关闭也经此处收尾）
        if (tool !== 'text') this._text.commitEdit();
        // 模糊笔刷是像素效果工具，与遮罩语义无关——切入即退遮罩；
        // 形状工具 v1 只落像素图层，遮罩矩形留待后续（同语义退遮罩）
        if ((tool === 'fx' || tool === 'shape') && this._maskMode) this.setMaskMode(false);
        // 顶栏选项栏切换：文字工具显示字体/字号/横竖排，模糊笔刷显示
        // 强度，形状工具显示形状属性，其余显示笔刷粗细
        if (this.sizeRowEl) this.sizeRowEl.style.display =
            (tool === 'text' || tool === 'shape') ? 'none' : '';
        if (this.textRowEl) this.textRowEl.style.display = tool === 'text' ? '' : 'none';
        if (this.fxRowEl) this.fxRowEl.style.display = tool === 'fx' ? '' : 'none';
        if (this.shapeRowEl) {
            this.shapeRowEl.style.display = tool === 'shape' ? '' : 'none';
            if (tool === 'shape') this._syncShapeOptsDom?.();
        }
        // 切换到非画笔工具即退出移除模式（setRemoveMode 里先 setTool
        // 再置 _autoRemove，顺序不受影响）
        if (tool !== 'brush' && this._autoRemove) {
            this._autoRemove = false;
            this.removeBtn?.classList.remove('active');
        }
        // 裁剪模式：绘制面让位给裁剪覆盖层，隐藏笔刷光标；
        // 移动模式：绘制面放行指针，输入由舞台接管（覆盖整片舞台，
        // 移出文档的图层也能点选）
        this.overlayEl.classList.toggle('cropping', tool === 'crop');
        this.overlayEl.classList.toggle('moving', tool === 'move');
        if (tool === 'crop') {
            this._hideCursor();
            this._updateMsg();
            this._drawCropOverlay();
        } else if (this.dragEdge) {
            this.dragEdge = null;
        }
        // 移动工具：隐藏笔刷光标圈、光标交给悬停命中决策、显示选中框；
        // 其他工具恢复默认光标并隐藏选中框
        if (tool === 'move') {
            this._hideCursor();
            this.paintSurface.style.cursor = 'default';
        } else {
            // 文字工具须显式给绘制面 I 形光标——.is-paint-surface 基础样式
            // 是 cursor:none（画笔自定义光标的前提），不覆盖则白底上无光标；
            // 形状工具用十字光标（拖拽画框）
            this.paintSurface.style.cursor =
                tool === 'text' ? 'text' : (tool === 'shape' ? 'crosshair' : '');
        }
        // 画笔/橡皮/模糊：整个舞台（含空白区）隐藏系统鼠标，改用自定义光标圈；
        // 移动/裁剪恢复系统鼠标（各自由绘制面悬停/裁剪锚点给出形态）；
        // 文字工具用文本 I 形光标，形状工具用十字光标
        this.stageEl.style.cursor = this._brushCursorTool ? 'none'
            : (tool === 'text' ? 'text'
                : (tool === 'shape' ? 'crosshair' : ''));
        this._updateCursor();
        this._drawSelOverlay();
    }

    /** 遮罩模式开关：开启后涂画落到激活图层的遮罩画布，
     *  关闭即普通画笔。裁剪工具下开启会先切回画笔（裁剪模式不可涂画） */
    setMaskMode(on) {
        if (!!on === !!this._maskMode) return;
        this._maskMode = !!on;
        // 遮罩模式被关掉（选色/再点遮罩按钮）时移除模式随之退出
        if (!on && this._autoRemove) {
            this._autoRemove = false;
            this.removeBtn.classList.remove('active');
        }
        // 遮罩模式落在激活图层的 maskCv 上：形状工具只建像素图层不涂
        // 遮罩，开启遮罩时切回画笔（与裁剪工具同守卫）
        if (on && (this.tool === 'crop' || this.tool === 'shape')) this.setTool('brush');
        this._syncPanels();
        this._updateCursor();
    }

    /**
     * 移除模式：自带遮罩涂抹的 AI 抹除工具（对标 PS 移除工具）。
     * 激活后直接在图上涂抹（笔迹走遮罩画布，与遮罩模式同一套数据：
     * maskCv 并集 → image.mask），松开笔即自动提交 LaMa 推理抹除，
     * 完成后遮罩自动清空、可连续涂抹下一处。
     * 切换到其他工具或关掉遮罩模式即退出移除模式
     */
    setRemoveMode() {
        if (this._autoRemove) {
            // 再点一次 = 退出移除模式（保留已涂遮罩，转回遮罩模式手动提交）
            this._autoRemove = false;
            this.removeBtn.classList.remove('active');
            return;
        }
        this._autoRemove = true;
        this.setTool('brush');
        this.setMaskMode(true);
        this.removeBtn.classList.add('active');
        this.msgEl.textContent = '移除模式：涂出要移除的区域，松手自动抹除';
        setTimeout(() => { if (this.msgEl.textContent.startsWith('移除模式')) this.msgEl.textContent = ''; }, 3000);
    }

    setColor(value, swatchEl) {
        this.color = value;
        // 按色值匹配高亮（最近使用/预设两组中同色块唯一 active，
        // swatchEl 参数仅为兼容旧调用点保留）
        this.swatchEls.forEach((sw) =>
            sw.classList.toggle('active', sw.dataset.color === value));
        // 内嵌取色器反向同步（外部来色：预设/最近色块点击等）
        this._colorPicker?.syncFromColor(value);
        // 文字工具：色板直接改文字颜色（编辑中实时重渲染），不切回画笔
        if (this.tool === 'text') {
            this._text.applyColor(value);
            return;
        }
        // 选色即回到普通画笔（遮罩/橡皮/裁剪下选色没有意义）
        if (this.tool !== 'brush' || this._maskMode) {
            this.setMaskMode(false);
            this.setTool('brush');
        }
    }

    /**
     * 还原：裁剪模式重置画幅；绘制模式清空激活图层的当前涂画。
     * 背景层"清空"恢复纯白；图片层恢复 pristine 内容快照（变换保留，
     * 还原的是像素不是位置）；其余图层清成全透明。
     * 清空/恢复同样是一次修改（保存时要重算拍平/烘焙），必须置脏标记
     */
    revert() {
        if (this.tool === 'crop') {
            // 画幅与全幅一致时重置是空操作，不记历史
            const f = this.frame;
            const changed = f.fx !== 0 || f.fy !== 0
                || f.fw !== this.iw || f.fh !== this.ih;
            this.frame = { fx: 0, fy: 0, fw: this.iw, fh: this.ih };
            this.dirty.frame = false;
            this.dragLabel = '';
            this._updateMsg();
            this.fitView();
            if (changed) this._pushHistory('重置画幅');
            return;
        }
        const layer = this._activeLayer();
        if (!layer) return;
        // 遮罩模式优先：遮罩是"重绘区域"元数据而非图层内容，用户诉求
        // 是"撤销我的遮罩涂画"——全图层统一清空（激活层未必是涂遮罩的
        // 那层；且 Comfy/LaMa 消费的本来就是全层并集）。放在图层类型
        // 分支之前，激活层是文字层时同样生效
        if (this._maskMode) {
            for (const l of this.layers) {
                l.maskCv.getContext('2d')
                    .clearRect(0, 0, l.maskCv.width, l.maskCv.height);
            }
            this.dirty.mask = true;
            return;
        }
        // 文字/形状层像素由属性驱动渲染，清空像素会与属性不一致——
        // 不支持还原（改属性回对应工具再编辑，不要直接删层）
        if (layer.isText || layer.isShape) return;
        if (layer.isBackground) {
            const ctx = layer.paintCv.getContext('2d');
            ctx.clearRect(0, 0, this.iw, this.ih);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, this.iw, this.ih);
        } else if (layer.isImage) {
            layer.paintCv.getContext('2d').clearRect(0, 0, this.iw, this.ih);
            layer.paintCv.getContext('2d').drawImage(this._imagePristine, 0, 0);
        } else {
            layer.paintCv.getContext('2d')
                .clearRect(0, 0, layer.paintCv.width, layer.paintCv.height);
        }
        this.dirty[this._bakesIntoBase(layer) ? 'base' : 'strokes'] = true;
        this._pushHistory('还原涂画');
    }

    /**
     * 忙碌遮罩：模型推理期间盖住整个编辑器——画面轻压暗 + 中央应用蓝
     * 圆环转圈动画（不用系统 wait 光标，避免用户误以为程序卡死），
     * 挡住所有指针操作（按钮/滑杆/画布都点不动），防止推理途中改图层。
     * 键盘入口在 StudioDomBuilder 的 keydown 里单独守卫
     */
    _setBusy(on) {
        if (on) {
            if (!this.busyShield) {
                this.busyShield = document.createElement('div');
                this.busyShield.className = 'ie-busy-shield';
                const spinner = document.createElement('div');
                spinner.className = 'ie-busy-spinner';
                this.busyShield.appendChild(spinner);
            }
            this._hideCursor();   // 画笔光标圈藏起来，别浮在转圈上面
            this.overlayEl.appendChild(this.busyShield);
        } else if (this.busyShield) {
            this.busyShield.remove();
        }
    }

    /** 该图层是否拍进文档底片：背景层、图片层，以及排序后位于图片层
     *  之下的普通层——图片层可拖动后，底片拍平范围随图层顺序动态变化
     *  （底片 = 自下而上到图片层为止的全部可见层）。保存拍平与落笔
     *  脏标记共用此判定 */
    _bakesIntoBase(layer) {
        if (layer.isBackground || layer.isImage) return true;
        const imgIdx = this.layers.findIndex((l) => l.isImage);
        return imgIdx >= 0 && this.layers.indexOf(layer) < imgIdx;
    }

    /** 状态栏闪现提示：默认 3s 自动清除（仅当文本未被后到消息覆盖时才清，
     *  避免吞掉别的提示） */
    _flashMsg(text, ms = 3000) {
        this.msgEl.textContent = text;
        setTimeout(() => {
            if (this.msgEl.textContent === text) this.msgEl.textContent = '';
        }, ms);
    }

    /** 非文字层遮罩并集是否含有效像素（逐层扫描 alpha 首个非 0 即真）。
     *  移除的推理输入是底片（背景层+图片层），文字层不在其中——遮罩
     *  只涂在文字层上时提交只会白跑推理且文字纹丝不动；旧会话序列化
     *  落盘的文字层遮罩会随历史恢复重建，靠这道闸兜底拦截 */
    _hasBaseMask() {
        for (const layer of this.layers) {
            if (layer.isText || layer.isShape) continue;
            const data = layer.maskCv.getContext('2d')
                .getImageData(0, 0, layer.maskCv.width, layer.maskCv.height).data;
            for (let i = 3; i < data.length; i += 4) {
                if (data[i] > 0) return true;
            }
        }
        return false;
    }

    /**
     * 移除（AI 抹除）：把遮罩涂画区域交给后端 LaMa 模型本地推理，
     * 用周边内容填充后写回图片层。流程：
     *   1. 校验有遮罩涂画（dirty.mask 自打开以来置过位）；
     *   2. 校验遮罩落在底片图层上（文字层遮罩不算，见 _hasBaseMask）；
     *   3. 拍平底片（背景层+图片层）与遮罩并集提交 /api/lama/remove；
     *   4. 结果图写回图片层 paintCv（文档语义，全幅覆盖）；
     *   5. 清空全部图层遮罩（遮罩已被消费），置 base/mask 脏标记，
     *      保存时按既有契约烘焙进 img.src 并同步 Comfy 遮罩清空。
     * 「还原」仍可回到 pristine 原图（还原恢复的是像素不是本次操作）。
     */
    async removeMaskedArea() {
        if (!this.image || this._removing) return;
        if (!this.dirty.mask) {
            this._flashMsg('请先用遮罩模式涂出要移除的区域');
            return;
        }
        if (!this._hasBaseMask()) {
            this._flashMsg('遮罩只涂在文字层上——移除文字请直接删除该图层');
            return;
        }
        this._removing = true;
        this._setBusy(true);   // 转圈光标 + 拦截一切指针操作
        this.msgEl.textContent = '移除中…（本地模型推理，请稍候）';
        try {
            const imageData = this._save._flattenDoc();
            const maskData = this._save._flattenMask();
            const resp = await fetch('/api/lama/remove', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imageData, maskData })
            });
            const j = await resp.json();
            if (j.status !== 'ok') throw new Error(j.message || '未知错误');

            // 结果写回图片层：先等图加载完成，再全幅覆盖图片层画布
            const layer = this.layers.find((l) => l.isImage);
            if (layer) {
                const imgEl = new Image();
                await new Promise((resolve, reject) => {
                    imgEl.onload = resolve;
                    imgEl.onerror = () => reject(new Error('结果图加载失败'));
                    imgEl.src = j.image;
                });
                const g = layer.paintCv.getContext('2d');
                g.clearRect(0, 0, layer.paintCv.width, layer.paintCv.height);
                g.drawImage(imgEl, 0, 0, layer.paintCv.width, layer.paintCv.height);
            }
            // 遮罩已消费：清空全部图层遮罩画布，置脏驱动保存时清 Comfy 遮罩
            for (const l of this.layers) {
                l.maskCv.getContext('2d')
                    .clearRect(0, 0, l.maskCv.width, l.maskCv.height);
            }
            this.dirty.base = true;
            this.dirty.mask = true;
            this._pushHistory('移除内容');
            this.msgEl.textContent = `移除完成（${(j.cost / 1000).toFixed(1)}s，${j.provider}）`;
            setTimeout(() => { if (this.msgEl.textContent.startsWith('移除完成')) this.msgEl.textContent = ''; }, 3000);
        } catch (err) {
            console.error('移除失败:', err);
            this.msgEl.textContent = '移除失败：' + err.message;
            this.msgEl.classList.add('error');
            setTimeout(() => {
                if (this.msgEl.textContent.startsWith('移除失败')) {
                    this.msgEl.textContent = '';
                    this.msgEl.classList.remove('error');
                }
            }, 5000);
        } finally {
            this._removing = false;
            this._setBusy(false);
        }
    }

    // ==================== 绘制（统一绘制面 → 激活图层） ====================

    _onPaintDown(e) {
        if (e.button !== 0 || !this.image) return;
        if (this.tool === 'move') return this._onMoveDown(e);
        if (this.tool === 'text') return this._onTextDown(e);
        if (this.tool === 'shape') return this._onShapeDown(e);
        if (this.tool === 'crop') return;
        if (!this._readyDone) return;
        const layer = this._activeLayer();
        if (!layer) return;
        // 文字层是属性驱动对象：paintCv/maskCv 由文字属性重渲染派生，
        // 涂上去的笔迹/遮罩会在下次文字重渲染时被无声清掉——像素工具
        // （画笔/橡皮/遮罩）一律拒绝（与「还原」拒绝文字层同一立场）；
        // 移除文字的正确姿势是删除该图层。形状层同为属性驱动，同规则
        if (layer.isText || layer.isShape) {
            this._flashMsg('文字/形状层不支持涂抹——移除请直接删除该图层');
            return;
        }
        e.preventDefault();
        this.paintSurface.setPointerCapture(e.pointerId);
        this.drawing = true;
        const pos = this._toImagePos(e);
        this.last = pos;
        // 马赛克/模糊：印章替代笔迹，其余流程（捕获/脏标记/历史）共用；
        // 模糊起笔快照图层内容，此后拖动只刷遮罩预览（平铺幂等）
        if (this.tool === 'fx') {
            this._blur.startStroke();
            this._blur.strokeSegment(pos, pos);
        }
        else this._strokeSegment(pos, pos);   // 单击也落一个圆点
        if (this._maskMode) this.dirty.mask = true;
        else if (this._bakesIntoBase(layer)) this.dirty.base = true;
        else this.dirty.strokes = true;
    }

    _onPaintMove(e) {
        // 移动工具：悬停光标决策 + 拖动/缩放进行中
        if (this.tool === 'move') { this._onMoveHover(e); return; }
        // 形状工具拖拽创建中：更新宽高重渲染（不经 drawing 管线）
        if (this.tool === 'shape' && this._shape.drag) { this._shape.dragMove(e); return; }
        if (!this.drawing) return;
        // 合并高事件速率下的插值点，长笔画更顺滑
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of events) {
            const pos = this._toImagePos(ev);
            if (this.tool === 'fx') this._blur.strokeSegment(this.last, pos);
            else this._strokeSegment(this.last, pos);
            this.last = pos;
        }
    }

    _onPaintUp() {
        // 形状工具拖拽提交（不经涂画管线；干点取消在 dragUp 内处理）
        if (this.tool === 'shape' && this._shape.drag) { this._shape.dragUp(); return; }
        // 历史快照：一笔涂画/一次拖拽 = 一条记录（拖拽未实际移动不记，
        // 防止移动工具下干点把历史刷满无效条目）
        if (this.moveDrag) {
            const l = this.moveDrag.layer;
            const moved = l.tx !== this.moveDrag.startTx
                || l.ty !== this.moveDrag.startTy
                || (this.moveDrag.mode === 'resize' && Math.abs(
                    l.tscale - this.moveDrag.startRect.w / l.paintCv.width) > 1e-9);
            if (moved) {
                this._pushHistory(this.moveDrag.mode === 'move' ? '移动图层' : '缩放图层');
                // 形状层缩放：把倍率烘焙回形状属性并按属性重渲染
                // （解析图形重渲染永远锐利，等效矢量缩放）
                if (this.moveDrag.mode === 'resize' && l.isShape) {
                    this._bakeShapeScale(l);
                }
            }
        } else if (this.drawing && this.tool !== 'text') {
            this._blur.endStroke();   // 模糊收笔定型（预览已是最终内容）
            this._pushHistory(this._maskMode
                ? '遮罩涂画'
                : this.tool === 'fx' ? '模糊'
                : this.tool === 'eraser' ? '擦除' : '涂画');
            // 落笔改变图层内容：增量刷新该行缩略图（不全量重建列表；
            // 遮罩画在 maskCv 上，缩略图只反映内容，刷新是无害空转）
            this._refreshThumb(this._activeLayer());
        }
        this.drawing = false;
        this.last = null;
        this.moveDrag = null;
        // 清除磁吸参考线并重绘选中框（参考线画在选中覆盖层上，
        // 不主动重绘会残留到下一次拖拽）
        if (this._snapGuides) {
            this._snapGuides = null;
            if (this.tool === 'move') this._drawSelOverlay();
        }
        // 移除模式：一笔结束即自动提交 AI 抹除（对标 PS 移除工具的
        // "每次描边后删除"）；_removing 防重入，dirty.mask 过滤无涂画
        // 的空松手（点击工具按钮等误触不会触发推理）
        if (this._autoRemove && this._maskMode && this.dirty.mask) {
            this.removeMaskedArea();
        }
    }

    /** 绘制面屏幕坐标 → 原图文档坐标（除以当前缩放比） */
    _toImagePos(e) {
        const rect = this.paintSurface.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) / this.zoom,
            y: (e.clientY - rect.top) / this.zoom
        };
    }

    /** 在激活图层画一段笔迹：普通模式叠加当前色到笔迹画布，
     *  遮罩模式叠加全强度红到遮罩画布；橡皮对当前画布 destination-out。
     *  传入的是文档坐标，先反变换进图层局部坐标（除以缩放、减去偏移），
     *  笔刷粗细按文档视觉大小换算（图层放大 2 倍时局部画 1/2 宽） */
    _strokeSegment(from, to) {
        const layer = this._activeLayer();
        if (!layer) return;
        layer.empty = false;    // 落笔即非空（命中检测从此可见）
        const cv = this._maskMode ? layer.maskCv : layer.paintCv;
        const ctx = cv.getContext('2d');
        const color = this._maskMode ? ImageStudio.MASK_COLOR : this.color;
        const ts = layer.tscale || 1;
        // 笔刷视觉倍率：滑块值 × SIZE_SCALE = 实际笔迹宽度（与光标圈
        // 同一系数，保持所见即所得）
        const width = this.sizes[this._maskMode ? 'mask' : 'strokes']
            * ImageStudio.SIZE_SCALE / ts;
        ctx.globalCompositeOperation = this.tool === 'eraser' ? 'destination-out' : 'source-over';
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const lx = (p) => ({ x: (p.x - layer.tx) / ts, y: (p.y - layer.ty) / ts });
        const lf = lx(from);
        const lt = lx(to);
        ctx.beginPath();
        ctx.moveTo(lf.x, lf.y);
        ctx.lineTo(lt.x, lt.y);
        ctx.stroke();
        // 起笔/单击的圆点（stroke 对零长度线段不绘制）
        if (lf.x === lt.x && lf.y === lt.y) {
            ctx.beginPath();
            ctx.arc(lt.x, lt.y, width / 2, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
    }

    // ==================== 视图变换 ====================

    /** 适应屏幕：画幅完整可见并居中（不超过 100%） */
    fitView() {
        if (!this.image || !this.frame.fw) return;
        const availW = this.stageEl.clientWidth - 48;
        const availH = this.stageEl.clientHeight - 48;
        this.zoom = Math.min(availW / this.frame.fw, availH / this.frame.fh, 1);
        this.panX = 0;
        this.panY = 0;
        this._applyTransform();
    }

    /** 设置缩放比：固定视图中心原地缩放（5% ~ 1600%） */
    setZoom(zoom) {
        this.zoom = Math.min(16, Math.max(0.05, zoom));
        this._applyTransform();
    }

    _onWheel(e) {
        if (!this.image) return;
        e.preventDefault();
        const factor = Math.pow(1.0015, -e.deltaY);
        this.setZoom(this.zoom * factor);
    }

    // ---- 视图平移（中键拖拽） ----

    _onStagePointerDown(e) {
        if (!this.image || e.button !== 1) return;
        e.preventDefault();
        this.panning = true;
        this._panLast = { x: e.clientX, y: e.clientY };
        this.stageEl.setPointerCapture(e.pointerId);
        this.overlayEl.classList.add('panning');
    }

    _onStagePointerMove(e) {
        if (!this.panning) return;
        this.panX += e.clientX - this._panLast.x;
        this.panY += e.clientY - this._panLast.y;
        this._panLast = { x: e.clientX, y: e.clientY };
        this._applyTransform();
    }

    _onStagePointerUp() {
        if (!this.panning) return;
        this.panning = false;
        this.overlayEl.classList.remove('panning');
    }

    /**
     * 应用变换：画布承载区按画幅框尺寸同步（扩图后框可大于原图），
     * 全部图层画布钉在文档 (0,0)，随框偏移定位；裁剪覆盖层铺满画幅框。
     * 平移带可见性夹取：画布至少 80px 留在舞台内防拖丢
     */
    _applyTransform() {
        if (!this.stageEl) return;
        // 位置与尺寸一律用小数 CSS 像素（不取整）：wrap 与图层画布如果
        // 各自独立 Math.round，拖裁剪锚点/缩放时两处舍入误差不同步，
        // 图像相对裁剪框会 ±1px 抖动（放大越明显）。亚像素渲染足够平滑
        const w = Math.max(1, this.frame.fw * this.zoom);
        const h = Math.max(1, this.frame.fh * this.zoom);
        const stageW = this.stageEl.clientWidth;
        const stageH = this.stageEl.clientHeight;
        const marginX = Math.min(80, w);
        const marginY = Math.min(80, h);
        const maxPanX = stageW / 2 - marginX + w / 2;
        const minPanX = -stageW / 2 + marginX - w / 2;
        this.panX = Math.min(maxPanX, Math.max(minPanX, this.panX));
        const maxPanY = stageH / 2 - marginY + h / 2;
        const minPanY = -stageH / 2 + marginY - h / 2;
        this.panY = Math.min(maxPanY, Math.max(minPanY, this.panY));

        this.wrapEl.style.width = w + 'px';
        this.wrapEl.style.height = h + 'px';
        this._wrapLeft = stageW / 2 + this.panX - w / 2;
        this._wrapTop = stageH / 2 + this.panY - h / 2;
        this.wrapEl.style.left = this._wrapLeft + 'px';
        this.wrapEl.style.top = this._wrapTop + 'px';

        // 全部图层画布按各自变换定位（与选中框绘制同源，见
        // _positionLayerCanvases），绘制面铺满文档矩形（无变换）
        for (const layer of this.layers) {
            this._positionLayerCanvases(layer);
        }
        // 文字编辑框跟随视图变换（滚轮缩放/中键平移时保持与文字层对位）
        if (this._text && this._text.editing) this._text._syncEditor();
        this.paintSurface.style.left = (-this.frame.fx * this.zoom) + 'px';
        this.paintSurface.style.top = (-this.frame.fy * this.zoom) + 'px';
        this.paintSurface.style.width = Math.max(1, this.iw * this.zoom) + 'px';
        this.paintSurface.style.height = Math.max(1, this.ih * this.zoom) + 'px';

        // 选中框覆盖层铺满整个舞台（dpr 缩放保证线条清晰）；
        // 尺寸变化会清空位图，随后统一重绘
        if (this.selCanvas) {
            const dpr = window.devicePixelRatio || 1;
            const bw = Math.round(stageW * dpr);
            const bh = Math.round(stageH * dpr);
            if (this.selCanvas.width !== bw || this.selCanvas.height !== bh) {
                this.selCanvas.width = bw;
                this.selCanvas.height = bh;
            }
            this.selCanvas.style.width = stageW + 'px';
            this.selCanvas.style.height = stageH + 'px';
            this._selDpr = dpr;
            if (this.tool === 'move' || this.tool === 'text') this._drawSelOverlay();
        }

        // 裁剪覆盖层：四周外扩出血边距（锚点/尺寸标签画在框外），
        // dpr 缩放保证锚点/网格清晰
        const bleed = ImageStudio.CROP_BLEED;
        const dpr = window.devicePixelRatio || 1;
        this.cropCanvas.width = Math.round((w + bleed * 2) * dpr);
        this.cropCanvas.height = Math.round((h + bleed * 2) * dpr);
        this.cropCanvas.style.width = (w + bleed * 2) + 'px';
        this.cropCanvas.style.height = (h + bleed * 2) + 'px';
        this.cropCanvas.style.left = -bleed + 'px';
        this.cropCanvas.style.top = -bleed + 'px';
        this._dpr = dpr;

        if (this.zoomPill) this.zoomPill.textContent = Math.round(this.zoom * 100) + '%';
        this._updateCursor();
        if (this.tool === 'crop') this._drawCropOverlay();
    }

    /** 增量定位单块图层的画布（新增/移动图层后调用，避免全量重排） */
    /** 按图层变换定位它的两块画布（文档坐标 → 舞台像素，小数不取整，
     *  与 wrap 同源避免舍入抖动）。定位与选中框绘制同源同步：任何位置
     *  变化都携带选中框重绘，杜绝「框停留在上一次几何状态」的时序缝隙 */
    _positionLayerCanvases(layer) {
        const style = (el) => {
            el.style.left = ((layer.tx - this.frame.fx) * this.zoom) + 'px';
            el.style.top = ((layer.ty - this.frame.fy) * this.zoom) + 'px';
            el.style.width = Math.max(1, layer.paintCv.width * layer.tscale * this.zoom) + 'px';
            el.style.height = Math.max(1, layer.paintCv.height * layer.tscale * this.zoom) + 'px';
        };
        style(layer.paintCv);
        style(layer.maskCv);
        if (this.tool === 'move') this._drawSelOverlay();
    }

    isOpen() {
        return this.overlayEl.style.display !== 'none';
    }

    close() {
        this.overlayEl.style.display = 'none';
        this.overlayEl.classList.remove('cropping');
        this.image = null;
        this.layers = [];
        this.drawing = false;
        this.dragEdge = null;
        this.dirty = { base: false, strokes: false, mask: false, frame: false, layers: false };
        this.layerMenuEl.hidden = true;
        this.fontMenuEl.hidden = true;
        this._history.reset();      // 历史随编辑会话结束清空（释放快照内存）
        this._history.closePanel();
        this._text.abortEdit();   // 只清编辑框与状态（图层栈随即清空，无需提交）
        this._shape.drag = null;  // 形状拖拽态一并丢弃（图层栈随即清空）
        this._hideCursor();
    }

    /** 关闭请求：有任何未保存修改时先弹丢弃确认 */
    requestClose() {
        if (this.dirty.base || this.dirty.strokes || this.dirty.mask ||
            this.dirty.frame || this.dirty.layers) {
            this.confirmEl.hidden = false;
            return;
        }
        this.close();
    }

    // ==================== 光标 ====================

    /** 笔刷类工具（画笔/橡皮/模糊马赛克，遮罩模式与 AI 移除复用 brush
     *  工具位）：隐藏系统光标、显示自定义圆圈光标的统一出处——
     *  stageEl 的 cursor:none、舞台 pointermove 兜底复活、_updateCursor
     *  三处共用本谓词，防止新增工具时名单漂移（fx 曾因此漏出复活名单，
     *  调完强度光标圈一去不回） */
    get _brushCursorTool() {
        return this.tool === 'brush' || this.tool === 'eraser' || this.tool === 'fx';
    }

    /** 光标圆圈直径 = 笔刷屏幕实际宽度（粗细 × 缩放比，与画出的笔迹
     *  严格 1:1，所见即所得）；橡皮用虚线圈区分。
     *  可见性 = 笔刷类工具 且 指针在舞台内——滑杆 input、setTool 等调用
     *  发生在顶栏/面板上时（指针在舞台外），只应用尺寸样式不点亮圆圈，
     *  圈的出现由舞台 pointermove 兜底负责 */
    _updateCursor() {
        if (!this._brushCursorTool || !this._cursorInStage) {
            this._hideCursor();
            return;
        }
        const d = Math.max(4,
            this.sizes[this._maskMode ? 'mask' : 'strokes'] * this.zoom * ImageStudio.SIZE_SCALE);
        this.cursorEl.style.width = d + 'px';
        this.cursorEl.style.height = d + 'px';
        // 橡皮虚线圈区分；模糊/马赛克不填充（效果区域本身够显眼）。
        // 描边一律白色——黑白双描边由 .ie-cursor 的 box-shadow 黑晕补齐
        // （fx 曾用黑色描边，在舞台纯黑空白区完全不可见）
        this.cursorEl.style.border = this.tool === 'eraser'
            ? '1px dashed rgba(255,255,255,0.9)'
            : '1px solid rgba(255,255,255,0.9)';
        this.cursorEl.style.background = this.tool === 'fx' ? 'transparent' : '';
        this.cursorEl.style.display = 'block';
    }

    _hideCursor() {
        this.cursorEl.style.display = 'none';
    }

    // ==================== 子模块薄代理 ====================
    // 方法体在 js/components/image-studio/ 各子模块（操作宿主实例），
    // 这里保留同名入口：主类内部调用、DOM 事件绑定与外部调用点零改动

    // ---- 图层面板（StudioLayerPanel） ----
    addLayer(opts) { return this._layers.addLayer(opts); }
    addTextLayer(pos) { return this._layers.addTextLayer(pos); }
    addShapeLayer(pos) { return this._layers.addShapeLayer(pos); }
    deleteActiveLayer() { return this._layers.deleteActiveLayer(); }
    duplicateActiveLayer() { return this._layers.duplicateActiveLayer(); }
    _rebuildLayerDom() { return this._layers._rebuildLayerDom(); }
    _applyLayerStyles(layer) { return this._layers._applyLayerStyles(layer); }
    _renderLayerList() { return this._layers._renderLayerList(); }
    _refreshThumb(layer) { return this._layers.refreshThumb(layer); }
    _setActive(id) { return this._layers._setActive(id); }
    _syncPanels() { return this._layers._syncPanels(); }
    _showLayerMenu(x, y) { return this._layers._showLayerMenu(x, y); }

    // ---- 图片导入（StudioImport） ----
    importImageAsLayer(src, name) { return this._import.importImageAsLayer(src, name); }
    _openLocalFileDialog() { return this._import._openLocalFileDialog(); }
    _openPicker() { return this._import._openPicker(); }
    _closePicker() { return this._import._closePicker(); }
    _syncPickerCount() { return this._import._syncPickerCount(); }

    // ---- 移动工具（StudioMoveTool） ----
    _onMoveDown(e) { return this._move._onMoveDown(e); }
    _onMoveHover(e) { return this._move._onMoveHover(e); }
    _drawSelOverlay() { return this._move._drawSelOverlay(); }

    // ---- 文字工具（StudioTextTool） ----
    _onTextDown(e) { return this._text._onTextDown(e); }
    _renderTextLayer(layer) { return this._text._render(layer); }

    // ---- 形状工具（StudioShapeTool） ----
    _onShapeDown(e) { return this._shape._onShapeDown(e); }
    _renderShapeLayer(layer) { return this._shape._render(layer); }
    /** 形状层缩放提交：倍率烘焙回形状属性重渲染（tscale 归一，永远锐利） */
    _bakeShapeScale(layer) {
        const k = layer.tscale;
        if (!Number.isFinite(k) || k <= 0 || Math.abs(k - 1) < 1e-9) return;
        const s = layer.shape;
        s.w = Math.max(2, Math.round(s.w * k));
        s.h = Math.max(2, Math.round(s.h * k));
        s.strokeWidth = Math.max(0, s.strokeWidth * k);
        s.radius = Math.max(0, (s.radius || 0) * k);
        layer.tscale = 1;
        this._shape._render(layer);
        this._positionLayerCanvases(layer);
        this.dirty.layers = true;
        this._refreshThumb(layer);
    }

    // ---- 色板取色器（StudioColorPicker） ----
    pushRecentColor(value) { return this._dom._pushRecentColor(value); }

    // ---- 历史记录（StudioHistory） ----
    _pushHistory(label) { return this._history.push(label); }

    // ---- 裁剪/扩图（StudioCropTool） ----
    _onCropDown(e) { return this._crop._onCropDown(e); }
    _onCropMove(e) { return this._crop._onCropMove(e); }
    _updateMsg() { return this._crop._updateMsg(); }
    _drawCropOverlay() { return this._crop._drawCropOverlay(); }

    // ---- 保存（StudioSave） ----
    save() { return this._save.save(); }
}

// 暴露到全局作用域
window.ImageStudio = ImageStudio;
