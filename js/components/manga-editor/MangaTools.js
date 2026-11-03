/**
 * ==========================================================================
 * MangaEditor 子模块：工具栏与画笔工具（自灯箱 ImageStudio 迁移轻量化）
 * 作用：舞台左缘竖排工具条（select 选择/移动/缩放 = 既有舞台手势的显式化，
 *       行为零变化；brush 画笔在页面上画线，笔迹写进活动图层——图层系统
 *       见 MangaLayers 混入；cutout 抠图为动作型按钮——对选中图片层就地
 *       去背景写回，非切换模式）。每笔一计入页级历史（撤销=整笔回退，
 *       _histSnapshot 深拷贝天然覆盖）。
 * 契约：原型混入（partial-class，ADR 026）——方法 Object.assign 进
 *       MangaEditor.prototype，this 即编辑器实例；须后于主类加载。
 *       手势分流在 MangaStage._onPointerDown/Move/Up 的 activeTool 分支；
 *       笔迹渲染 _drawStrokes 由 _renderStage 在画幅底与元素框之间调用
 *       （笔迹是「草图层」，元素框盖在其上，半透明填充不遮笔迹）；
 *       持久化随 draft.strokes 走 /api/manga-draft（路由宽松校验存原样，
 *       恢复由 MangaDraftStore._normalizeDocument 原样带回——normalizeDraft
 *       是双编辑器共享层，不认识漫画专属字段）。
 * 画笔选项（2026-11-05 迁标题栏）：色板 + 粗细滑块挂在标题栏工具选项条
 *       （_buildBrushBar，灯箱顶栏同位）——画笔激活时显示；颜色存
 *       localStorage（mangaBrushColor，预设六色用户拍板口径）、笔宽
 *       同记忆（mangaBrushWidth，1~40 草稿像素，越界回落 4）。
 * ==========================================================================
 */

Object.assign(window.MangaEditor.prototype, {

    // ==================== 工具栏 ====================

    /** 舞台左缘竖排工具条（MangaDom._buildDom 里调用，懒建于首次 show） */
    _buildToolRail() {
        // 挂 stage-wrap（横排 flex 容器）——stage-area 是 canvas 的绝对定位
        // 基准，插进去会被 canvas（inset:0）整个盖住
        const wrap = this.stageCv &&
            (this.stageCv.closest('.manga-stage-wrap') || this.stageCv.parentElement);
        if (!wrap) return;
        const rail = document.createElement('div');
        rail.className = 'manga-tool-rail';
        const btn = (id, title, svg, onClick) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'manga-tool-btn';
            b.dataset.tool = id;
            b.title = title;
            b.innerHTML = svg;
            // 缺省点击=切工具（模式型）；传 onClick 则为动作型按钮
            //（不参与 activeTool 高亮，_setTool 白名单也会拒绝该 id）
            b.addEventListener('click', onClick || (() => this._setTool(id)));
            return b;
        };
        rail.appendChild(btn('select', '选择 / 移动 / 缩放（默认）',
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M4 3l7.5 17 2.3-7.2L21 10.5z"/></svg>'));
        rail.appendChild(btn('brush', '画笔：在页面上画线（撤销按整笔回退）',
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>'));
        // 橡皮（2026-11-05 自灯箱 ImageStudio 迁移，图标同款）：擦除活动
        // 笔迹层的已有笔迹——层内 destination-out 合成（不伤页底/下层），
        // 数据=带 erase 标记的笔迹条目随草稿持久化
        rail.appendChild(btn('eraser', '橡皮：擦除活动笔迹层上的笔迹（撤销按整笔回退）',
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21M22 21H7m-2-10 9 9"/></svg>'));
        // 文字（2026-11-05 自灯箱 StudioTextTool 复刻，图标同款 T）：点击
        // 页面新建文字层就地输入、点击已有文字再编辑；字体/字号/横竖排/
        // 颜色在标题栏选项条（_buildTextBar，画笔选项条同位）。文字层
        // 可被 select 工具选中/拖动/等比缩放（MangaStage 手势泛化）
        rail.appendChild(btn('text', '文字：点击页面添加文字（顶部选字体/字号/横竖排/颜色），点击已有文字再次编辑',
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>'));
        // 形状（2026-11-06 自灯箱 StudioShapeTool 迁移，ADR 069）：拖拽创建
        // 矩形/圆角矩形/椭圆/气泡框，点击已有形状改属性；类型/填充/边框/
        // 边宽/圆角在标题栏选项条（_buildShapeBar，画笔/文字选项条同位）。
        // 形状层可被 select 工具选中/拖动/八向非等比拉伸（MangaStage 手势泛化）
        rail.appendChild(btn('shape', '形状：拖拽创建矩形/圆角/椭圆/气泡框（顶部选类型/填充/边框），点击已有形状改属性',
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="9.5" height="9.5" rx="1"/><circle cx="16.5" cy="16.5" r="4.5"/></svg>'));
        // 抠图（动作型，2026-11-04 自灯箱 ImageStudio 迁移）：对选中图片
        // 层就地去背景——先在舞台点选图片或图层面板点图片行；图标与
        // 图片工具栏/灯箱「去除背景」同款（用户点名，不用剪刀）
        rail.appendChild(btn('cutout', '抠图：去除选中图片层背景（本地推理，结果就地写回该层）',
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="12" height="16" rx="2"/><circle cx="7.5" cy="9" r="1.5"/><path d="m5 17 3.5-3.5 2.5 2.5 2-2"/><path d="m15 14 3.5-3.5 3 3-5.5 5.5H13v-3z"/><path d="m17 12 2 2"/></svg>',
            () => this._cutoutSelectedLayer()));
        // 移除（工具型，2026-11-07 自灯箱 ImageStudio 移除模式迁移，ADR 076，
        // 图标同款创可贴）：对选中图片层涂抹要移除的区域，松手自动 LaMa
        // 本地推理抹除并智能填充——结果烘焙换 src 可撤销（MangaRemoveTool
        // 会话；涂抹手势由 MangaGestures 路由，切走工具未提交遮罩丢弃）
        rail.appendChild(btn('remove', '移除工具：涂抹要移除的区域，松手自动 AI 抹除并智能填充（本地模型）',
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 10.01h.01"></path><path d="M10 14.01h.01"></path><path d="M14 10.01h.01"></path><path d="M14 14.01h.01"></path><path d="M18 6v11.5"></path><path d="M6 6v12"></path><rect x="2" y="6" width="20" height="12" rx="2"></rect></svg>'));
        // 调色（动作型，2026-11-07 自灯箱 StudioAdjustTool 迁移，ADR 074，
        // 图标同款调音台推子）：对选中图片层浮动弹窗调亮度/对比度/饱和度/
        // 色温/锐化/颗粒——非破坏预览，关闭丢弃，保存烘焙换 src 可撤销
        this.adjustBtn = btn('adjust', '调色：对选中图片层调节亮度/对比度/饱和度/色温/锐化/颗粒（关闭丢弃，保存生效）',
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="21" y1="4" x2="14" y2="4"/><line x1="10" y1="4" x2="3" y2="4"/><line x1="21" y1="12" x2="12" y2="12"/><line x1="8" y1="12" x2="3" y2="12"/><line x1="21" y1="20" x2="16" y2="20"/><line x1="12" y1="20" x2="3" y2="20"/><line x1="14" y1="2" x2="14" y2="6"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="16" y1="18" x2="16" y2="22"/></svg>',
            () => this.openAdjust());
        rail.appendChild(this.adjustBtn);
        wrap.insertBefore(rail, wrap.firstChild);
        this._toolRailEl = rail;
        this._syncToolRailUi();
    },

    /**
     * 画笔选项条（标题栏，2026-11-05 自左缘工具条迁入——灯箱顶栏工具
     * 选项栏同位，用户拍板）：粗细滑块（草稿像素 1~40，localStorage 记
     * 忆）。画笔工具激活时显示。色板已迁右栏「色板」分区（2026-11-06
     * 自灯箱迁移完整取色器，ADR 068——原六预设色点退役）
     * （MangaDom._buildDom 在背景工具组之后调用）
     */
    _buildBrushBar() {
        const header = this.dialog && this.dialog.querySelector('.recipe-dialog-header');
        if (!header) return;
        const bar = document.createElement('div');
        bar.className = 'manga-brush-tools';
        bar.hidden = true;
        const label = document.createElement('span');
        label.className = 'manga-brush-width-label';
        label.textContent = '粗细';
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'manga-brush-width';
        slider.min = '1';
        slider.max = '40';
        slider.step = '1';
        slider.value = String(this._brushWidth);
        slider.title = '画笔粗细（草稿像素，随画布缩放等比渲染）';
        const val = document.createElement('span');
        val.className = 'manga-brush-width-val';
        val.textContent = String(this._brushWidth);
        slider.addEventListener('input', () => {
            // 按当前工具分发（2026-11-07 移除工具接入，ADR 076——灯箱
            // 遮罩模式独立笔宽同语义）：remove 写会话遮罩宽并独立记忆，
            // 其余写画笔宽
            if (this.activeTool === 'remove' && this._remove) {
                this._remove.width = Number(slider.value);
                try { localStorage.setItem('lumenLight.mangaRemoveWidth', slider.value); } catch { /* 隐私模式等 */ }
            } else {
                this._brushWidth = Number(slider.value);
                try { localStorage.setItem('lumenLight.mangaBrushWidth', slider.value); } catch { /* 隐私模式等 */ }
            }
            val.textContent = slider.value;
            this._syncBrushCursor();   // 光标圈直径跟随笔宽（所见即所得）
        });
        bar.append(label, slider, val);
        this._brushSliderEl = slider;       // _syncBrushBar 显示值跟随当前工具
        this._brushWidthValEl = val;
        // 插在右侧状态/关闭组之前（背景工具组之后，标题栏次序：
        // 标题 | 背景工具 | 画笔选项 | 状态+关闭）
        const right = header.querySelector('.manga-header-right');
        if (right) header.insertBefore(bar, right);
        else header.appendChild(bar);
        this._brushBarEl = bar;
    },

    /** 切换工具：进行中的拖拽/笔迹先收掉，离开文字工具先提交在途编辑；
     *  标题栏选项条随工具显隐（画笔条/文字条各自联动） */
    _setTool(id) {
        if (id !== 'select' && id !== 'brush' && id !== 'eraser' && id !== 'text' && id !== 'shape' && id !== 'remove') return;
        if (this.activeTool === id) return;
        // 离开移除工具：未提交遮罩随会话丢弃（灯箱同语义——遮罩只在
        // 会话内有效，漫画无手动提交链路故不保留，ADR 076）
        if (this.activeTool === 'remove' && this._remove) this._remove.close();
        // 进入移除工具：守卫失败（无选中图片层/图未就绪）不切换
        if (id === 'remove' && this._remove && !this._remove.open()) return;
        if (id !== 'text' && this._textEdit) this._commitTextEdit();
        if (this._stroke) this._cancelStroke();
        if (this._drag) this._cancelDrag();   // 形状拖拽创建的临时层在此静默摘除
        this.activeTool = id;
        if (this.stageCv) {
            this.stageCv.style.cursor =
                (id === 'brush' || id === 'eraser') ? 'crosshair'
                    : id === 'text' ? 'text'
                        : id === 'shape' ? 'crosshair' : '';
        }
        this._syncToolRailUi();
    },

    _syncToolRailUi() {
        if (!this._toolRailEl) return;
        this._toolRailEl.querySelectorAll('.manga-tool-btn').forEach((b) => {
            b.classList.toggle('is-active', b.dataset.tool === this.activeTool);
        });
        this._syncBrushBar();
        this._syncTextBar();
        this._syncShapeBar();
        this._syncPaletteUi();
        this._syncBrushCursor();
    },

    _syncBrushBar() {
        // 色板/粗细滑块服务画笔与橡皮（橡皮只用粗细，色板对它无效果但
        // 保持同位——灯箱顶栏工具选项栏同语义）；2026-11-07 移除工具
        // 接入（ADR 076）：粗细滑杆控制遮罩笔宽，光标圈实时跟随
        if (this._brushBarEl) {
            this._brushBarEl.hidden = this.activeTool !== 'brush' &&
                this.activeTool !== 'eraser' && this.activeTool !== 'remove';
        }
        // 滑块显示值跟随当前工具的笔宽（brush/eraser 共用画笔宽，remove
        // 用会话遮罩宽——切工具时回填，避免上一工具的值残留显示）
        if (this._brushSliderEl) {
            const w = this.activeTool === 'remove' && this._remove
                ? this._remove.width : this._brushWidth;
            this._brushSliderEl.value = String(w);
            if (this._brushWidthValEl) this._brushWidthValEl.textContent = String(w);
        }
    },

    /**
     * 画笔光标同步入口（工具切换/粗细滑块调用）：画笔工具下隐藏系统
     * 光标（cursor:none），圆圈改画在舞台覆盖层画布上——灯箱 ImageStudio
     * 同机制（selCanvas 光标圈迁移，SVG data-URI 方案被悬停分支的
     * cursor 重设打败，弃）。圈径与位置的重算在 _redrawCursorRing；
     * select 工具恢复系统光标并清圈
     */
    _syncBrushCursor() {
        if (!this.stageCv) return;
        // 文字工具的 I 形光标在此保序（本方法在 _setTool/_syncToolRailUi
        // 末尾统一跑，会覆写前者设置的光标）
        this.stageCv.style.cursor = (this.activeTool === 'brush' || this.activeTool === 'remove') ? 'none'
            : this.activeTool === 'text' ? 'text'
                : this.activeTool === 'shape' ? 'crosshair' : '';
        this._redrawCursorRing();
    },

    _setBrushColor(c) {
        this._brushColor = c;
        try { localStorage.setItem('lumenLight.mangaBrushColor', c); } catch { /* 隐私模式等 */ }
    },

    // ==================== 画笔/橡皮（笔迹写进当前层，MangaLayers） ====================

    /**
     * 起笔：目标层按 PS 语义（用户拍板「总体上模仿 PS」）——选中图片层
     * 优先（笔迹叠在该层图片上方，首笔扩出 strokes 数组），其次活动笔迹
     * 层，全无才自动建层（建层不单独入账），拍历史快照。旧版绕开图片层
     * 自动建层，与灯箱/PS 的「落在当前层」不符（2026-11-05 用户反馈）
     */
    _brushStart(px, py) {
        if (!this._view) return;
        const p = this._toDraft(px, py);
        const sel = this._selLayerId != null ? this._layerById(this._selLayerId) : null;
        const onImage = !!(sel && sel.image);
        let layer = onImage ? sel : this._activeStrokeLayer();
        if (!layer) layer = this._addStrokeLayer(true);
        if (!layer) {
            this._status('没有可见的笔迹图层——在图层面板新建或取消隐藏', true);
            return;
        }
        if (onImage) {
            if (!Array.isArray(layer.strokes)) layer.strokes = [];   // 图片层首笔扩笔迹数组
        } else if (layer.id !== this._activeLayerId) {
            this._activeLayerId = layer.id;   // 回落同步面板高亮（选中图片层不动它）
        }
        this._stroke = {
            layerId: layer.id,
            color: this._brushColor,
            width: this._brushWidth,
            points: [p.x, p.y],
            erase: this.activeTool === 'eraser',   // 橡皮：条目带标记，渲染走层内 destination-out
            histSnap: this._histSnapshot()
        };
        this._clickBurst = null;
    },

    /** 运笔：按草稿距离抽稀点列（<1 草稿像素不动笔，数组不膨胀） */
    _brushMove(px, py) {
        if (!this._stroke) return;
        const p = this._toDraft(px, py);
        const pts = this._stroke.points;
        const dx = p.x - pts[pts.length - 2], dy = p.y - pts[pts.length - 1];
        if (dx * dx + dy * dy < 1) return;
        pts.push(p.x, p.y);
    },

    /** 收笔：单点也保留（点击=一个点迹，渲染画圆点）；空笔迹丢弃 */
    _brushEnd() {
        const st = this._stroke;
        this._stroke = null;
        if (!st) return;
        if (st.points.length >= 2) {
            const layer = this._layerById(st.layerId);
            if (layer) {
                const entry = { color: st.color, width: st.width, points: st.points };
                if (st.erase) entry.erase = true;   // 橡皮条目：纯笔迹条目不带该键（旧数据零迁移）
                layer.strokes.push(entry);
                if (st.erase && layer.image) {
                    // PS 语义（2026-11-05 用户拍板）：图片层橡皮=擦除图片像素。
                    // 先以条目驱动离屏擦除（即时可见），收笔烘焙进 src 承接后
                    // 条目退役；烘焙串行化防连笔竞态
                    this._draftTouched = true;
                    this._scheduleSave();
                    this._scheduleThumbRefresh();
                    this._renderLayerPanel();
                    this._renderStage();
                    this._bakeEraseOnImage(layer, entry, st.histSnap);
                } else {
                    this._commitHistory(st.histSnap, st.erase ? '橡皮' : '画笔');
                    // 笔迹不参与编译（_draftForCompile 剥离）——不走 _invalidateCompiled
                    // 防误清右栏编译产物；保存与缩略图跟随手动收口
                    this._draftTouched = true;
                    this._scheduleSave();
                    this._scheduleThumbRefresh();
                    this._renderLayerPanel();   // 首笔自动建层后面板跟随（已建时重建无感）
                }
            }
        }
        this._renderStage();
    },

    /** 橡皮烘焙串行链（快速连笔按序承接，防旧图覆盖新图的竞态） */
    _bakeEraseOnImage(layer, entry, histSnap) {
        this._bakeChain = (this._bakeChain || Promise.resolve())
            .then(() => this._doBakeErase(layer, entry, histSnap))
            .catch(() => { /* _doBakeErase 内部已兜底 */ });
    },

    /**
     * 橡皮在图片层的持久化（PS 语义：擦除=烘焙进图片像素）：层内当前
     * 图片 + 该条目擦除重绘为位图 → /api/assets 换新引用写回 src（bbox
     * 与尺寸不变），条目退役（擦除已由 src 承接，留条目会双重擦）；撤
     * 销=历史快照回滚旧 src。失败保留条目降级——离屏数据驱动照样擦
     * （页锚定，图片移动后擦痕不跟随）；条目已被撤销移除时烘焙作废
     */
    async _doBakeErase(layer, entry, histSnap) {
        try {
            const img = this._ensureLayerImage(layer.image.src);
            if (!img.complete || !img.naturalWidth) throw new Error('图片未就绪');
            const natW = img.naturalWidth, natH = img.naturalHeight;
            const [x1, y1, x2, y2] = layer.image.bbox;
            const k = natW / Math.max(1, x2 - x1);   // 页像素 → 图片像素（bbox contain 等比）
            const cv = document.createElement('canvas');
            cv.width = natW;
            cv.height = natH;
            const g = cv.getContext('2d');
            g.drawImage(img, 0, 0);
            g.lineJoin = 'round';
            g.lineCap = 'round';
            g.globalCompositeOperation = 'destination-out';
            this._drawStrokePath(g, entry, (px) => (px - x1) * k, (py) => (py - y1) * k, k);
            const dataUrl = cv.toDataURL('image/png');
            const url = await this._uploadToAssets(dataUrl, `manga-erase-${Date.now()}.png`);
            const idx = layer.strokes.indexOf(entry);
            if (idx < 0) return;   // 条目已被撤销/移除：烘焙作废，不动 src
            layer.strokes.splice(idx, 1);
            layer.image.src = url;
            this._commitHistory(histSnap, '橡皮');
            this._draftTouched = true;
            this._scheduleSave();
            this._scheduleThumbRefresh();
            this._renderLayerPanel();
            this._renderStage();
        } catch (err) {
            this._status('橡皮擦除保存失败：' + ((err && err.message) || err), true);
            this._draftTouched = true;
            this._scheduleSave();
        }
    },

    /** 笔迹作废（pointercancel/切工具）：不落不记账 */
    _cancelStroke() {
        if (!this._stroke) return;
        this._stroke = null;
        this._renderStage();
    },

    // ==================== 色板（右栏分区，自灯箱迁移 ADR 068） ====================

    /** 右栏「色板」分区构建（MangaDom._buildDom 调用）：取色器挂载 +
     *  最近使用/预设色块网格 */
    _buildPaletteSection() {
        const host = this.dialog && this.dialog.querySelector('.manga-palette-host');
        const grid = this.dialog && this.dialog.querySelector('.manga-palette-grid');
        if (!host || !grid) return;
        this._colorPicker = new LumenColorPicker(this);
        this._colorPicker.mount(host);
        this._paletteGridEl = grid;
        this._buildPaletteSwatches();
    },

    /** 色块网格重建：最近使用色行首（新→旧）+ 预设 8 色；高亮 = 当前
     *  工具色（brush→笔色 / text→文字色） */
    _buildPaletteSwatches() {
        const grid = this._paletteGridEl;
        if (!grid) return;
        const cur = String(this.color).toLowerCase();
        grid.innerHTML = '';
        const mk = (value, title) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'manga-swatch' +
                (String(value).toLowerCase() === cur ? ' is-active' : '');
            b.dataset.color = value;
            b.style.background = value;
            b.title = title;
            b.setAttribute('aria-label', title);
            b.addEventListener('click', () => this.setColor(value));
            grid.appendChild(b);
        };
        for (const c of this.recentColors) mk(c, `最近使用 ${c}`);
        for (const c of LumenColorPicker.PRESETS) mk(c.value, `预设色：${c.name}`);
    },

    /** 网格高亮就地同步（不重建列表） */
    _syncPaletteSwatchUi() {
        const grid = this._paletteGridEl;
        if (!grid) return;
        const cur = String(this.color).toLowerCase();
        grid.querySelectorAll('.manga-swatch').forEach((b) => {
            b.classList.toggle('is-active',
                String(b.dataset.color || '').toLowerCase() === cur);
        });
    },

    /** 色板统一入口（取色器拖拽/Hex/色块点击都到这，灯箱 setColor 同
     *  构）：按当前工具分发——文字工具改文字色（目标层实时生效）、形状
     *  工具改形状填充色（边框色走选项条原生色块），其余改笔色；回环防
     *  护由组件 _hex 去重保证（setColor→syncFromColor 同色跳过） */
    setColor(value) {
        if (this.activeTool === 'text') this._setTextColor(value);
        else if (this.activeTool === 'shape') this._setShapeFillColor(value);
        else this._setBrushColor(value);
        if (this._colorPicker) this._colorPicker.syncFromColor(value);
        this._syncPaletteSwatchUi();
    },

    /** 最近使用色入列（组件松手/Hex 提交/色块点击调，灯箱同款时机）：
     *  已在列或属预设一律跳过（防网格洗牌），新色 unshift 后截断 */
    pushRecentColor(value) {
        if (!value || this.recentColors.includes(value)) return;
        if (LumenColorPicker.PRESETS.some((c) => c.value === value)) return;
        this.recentColors.unshift(value);
        this.recentColors = this.recentColors.slice(0, LumenColorPicker.RECENT_MAX);
        this._buildPaletteSwatches();
    },

    /** 工具切换联动（_syncToolRailUi 调）：取色器与网格高亮跟随当前
     *  工具色（brush↔text 切换时色板无缝换目标） */
    _syncPaletteUi() {
        if (this._colorPicker) this._colorPicker.syncFromColor(this.color);
        this._syncPaletteSwatchUi();
    },

    // ==================== 抠图（动作型：选中图片层就地写回） ====================

    /**
     * 抠图（2026-11-04 自灯箱 ImageStudio.removeBackground 迁移）：选中
     * 图片层的图提交 /api/rembg 本地推理（BEN2/RMBG，模型在设置中选），
     * 透明结果经资产库换新引用写回该层——bbox 不动（后端保持原尺寸
     * 回传，1:1 无偏移）。与画布图片工具栏的抠图（结果作新图落画布）
     * 不同，这里是就地编辑语义。层引用换 url 后 _layerImgCache 旧条目
     * 自然失效（缓存按 src 取，新 src 新条目，onload 自动重绘）；输入
     * 须转 dataURL（rembg 接口只收 base64），复用 ImageExport.toDataUrl。
     * 历史/存档/缩略图走既有收口
     */
    async _cutoutSelectedLayer() {
        if (this._removingBg) return;
        const layer = this._layerById(this._selLayerId);
        if (!layer || !layer.image) {
            this._status('请先选中图片图层（舞台点选图片，或图层面板点图片行）', true);
            return;
        }
        const model = window.SettingsManager &&
            typeof window.SettingsManager.getActiveRembgModel === 'function' &&
            window.SettingsManager.getActiveRembgModel();
        if (!model) {
            this._status('抠图模型未配置（设置 → 图像工具）', true);
            return;
        }
        this._removingBg = true;
        this._status('抠图中…（本地模型推理，请稍候）');
        try {
            const dataUrl = await window.ImageExport.toDataUrl(null, layer.image.src);
            const resp = await fetch('/api/rembg', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imageData: dataUrl, model })
            });
            const j = await resp.json();
            if (j.status !== 'ok') throw new Error(j.message || '未知错误');

            // 结果入资产库换稳定引用（内容寻址去重），写回选中层
            const url = await this._uploadToAssets(j.image, `manga-cutout-${Date.now()}.png`);
            const before = this._histSnapshot();
            layer.image.src = url;
            this._commitHistory(before, '抠图');
            this._draftTouched = true;
            this._scheduleSave();
            this._scheduleThumbRefresh();
            this._renderStage();
            this._status(`抠图完成（${(j.cost / 1000).toFixed(1)}s，${j.provider}）`);
            clearTimeout(this._cutoutMsgTimer);
            this._cutoutMsgTimer = setTimeout(() => {
                if (this.statusEl && String(this.statusEl.textContent || '').startsWith('抠图完成')) {
                    this._status('');
                }
            }, 3000);
        } catch (err) {
            this._status('抠图失败：' + ((err && err.message) || err), true);
        } finally {
            this._removingBg = false;
        }
    },
});

// 取色器宿主契约的访问器属性（ADR 068）：Object.assign 会把 getter 求值
// 成数据属性（拿到 undefined），访问器必须单独 defineProperty——
// color = 当前工具色（组件 mount/拖拽快照读它，画笔/文字/形状填充各持
// 记忆——形状的边框色不经色板，走选项条原生色块），
// _readyDone = 拖拽门闸（灯箱同名契约，编辑器开着才可拖）
Object.defineProperty(window.MangaEditor.prototype, 'color', {
    get() {
        return this.activeTool === 'text' ? this._textColor
            : this.activeTool === 'shape' ? this._fillColor : this._brushColor;
    },
    configurable: true,
});
Object.defineProperty(window.MangaEditor.prototype, '_readyDone', {
    get() { return this.visible; },
    configurable: true,
});
