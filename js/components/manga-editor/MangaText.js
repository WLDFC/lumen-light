/**
 * ==========================================================================
 * MangaEditor 子模块：文字工具（自灯箱 StudioTextTool 复刻，ADR 066）
 * ==========================================================================
 * 作用：文字层 = draft.drawLayers 的第三种图层形态（笔迹层/图片层之外，
 *       分派按 layer.text 存在性）——文字按属性（内容/字体/字号/横竖排/
 *       颜色）直接绘进舞台画布，移动（layer-move 平移 x/y）/等比缩放
 *       （layer-resize 写 text.scale）/不透明度/显隐/复制/删除全部复用
 *       既有图层管线；持久化随 drawLayers 走（路由宽松校验存原样，
 *       _normalizeDocument 逐项守卫只查 truthy object）；不参与编译
 *       （_draftForCompile 整体剥离）也不写回画布存档图
 *       （_collectOverlayContributions 只认 strokes——文字与笔迹同为
 *       编辑器侧注释）。
 * 与灯箱的结构差异（复刻时改写而非照抄的部分）：灯箱文字层是 DOM canvas
 *       元素（paintCv），漫画层是 stage 画布里的纯 JSON 记录——渲染走
 *       _drawPageLayers 文字分支现画、命中/选中框/手势用测量包围盒
 *       （_textLayerBounds）现算；灯箱由移动工具承担的拖动/缩放对应
 *       漫画 select 工具的 layer-move/layer-resize（MangaStage 泛化）。
 * 交互（PS 文字工具同款）：文字工具下点击画布 → 新建文字层就地输入；
 *       点击已有文字层 → 再次编辑（全选替换）；Ctrl+Enter 或点击编辑框
 *       外 → 提交；Esc → 撤销本次修改；提交/取消时空内容 → 新层删除
 *       （未入账静默摘除）、重编辑层恢复原文字。切页/切工具/关窗自动
 *       提交在途编辑（防 this.draft 换引用后回填落错页）。
 * 竖排：canvas 无原生竖排，逐字自绘——CJK 字符直立逐字下排（列自右向
 *       左），连续西文/数字段整体顺时针旋转 90°（顶朝右，PS 同规则）。
 * 选项条（标题栏，画笔选项条同位）：字体下拉（精选清单+后端枚举系统
 *       全量 /api/system-fonts，逐项字体预览——LumenDropdown 不支持逐项
 *       样式故自建菜单挂 body）+ 字号 + 横竖排分段 + 色板（六预设同画笔
 *       色源，独立记忆）。选项作用目标=编辑中层优先→选中文字层→仅存
 *       默认（_textOpts，灯箱 textOpts 同语义）。
 * 契约：原型混入（partial-class，ADR 026）——方法 Object.assign 进
 *       MangaEditor.prototype，this 即编辑器实例；须后于主类加载。
 *       测量/绘制/拆段/字体清单/字体取数在共享层 js/utils/TextLayout.js
 *       （双编辑器共用，勿复制——灯箱 StudioTextTool 同消费方，ADR 067），
 *       本文件只保留宿主接线：_measureTextLayout/_splitTextRuns/
 *       _drawTextContent 为一行委托（MangaLayers/MangaPages/测试经原型
 *       方法调用，签名不变），文字属性与几何（_textLayerBounds）、就地
 *       编辑、选项条 DOM 均为漫画宿主侧实现。
 * ==========================================================================
 */

Object.assign(window.MangaEditor.prototype, {

    // ==================== 文字层模型 ====================

    /** 新建文字层：插层栈顶（数组底→顶序），选项取当前默认值；不单独
     *  入账（提交时随「新建文字」一并入——取消/空内容静默摘除零痕迹） */
    addTextLayer(x, y) {
        const layers = this._ensureDrawLayers();
        const id = this._allocLayerId();
        const layer = {
            id,
            name: `文字 ${id}`,
            visible: true,
            text: {
                content: '',
                font: this._textOpts.font,
                size: this._textOpts.size,
                vertical: this._textOpts.vertical,
                color: this._textColor,
                x, y,
                scale: 1
            }
        };
        layers.push(layer);
        this._renderLayerPanel();   // 面板即时出现（提交后更名，取消则摘除）
        return layer;
    },

    /** 文字层几何包围盒（草稿坐标，含渲染周边距、随 text.scale 等比）：
     *  命中检测/选中框/拖拽钳制/磁吸共用这份口径——与舞台绘制
     *  （_drawTextLayer）和编辑框（_syncTextEditor）同源测量，天然对位 */
    _textLayerBounds(layer) {
        const t = layer && layer.text;
        if (!t) return null;
        const layout = this._measureTextLayout(t);
        const s = Number(t.scale) || 1;
        const bw = (Math.ceil(layout.w) + layout.pad * 2) * s;
        const bh = (Math.ceil(layout.h) + layout.pad * 2) * s;
        return [t.x, t.y, t.x + bw, t.y + bh];
    },

    /** 舞台命中文字层：可见且有内容者自顶向下首个（草稿坐标判定） */
    _hitTextLayerAt(px, py) {
        if (!this._view) return null;
        const p = this._toDraft(px, py);
        const layers = this._ensureDrawLayers();
        for (let i = layers.length - 1; i >= 0; i--) {
            const l = layers[i];
            if (!l || !l.text || l.visible === false) continue;
            if (!String(l.text.content || '').trim()) continue;
            const b = this._textLayerBounds(l);
            if (p.x >= b[0] && p.x <= b[2] && p.y >= b[1] && p.y <= b[3]) return l;
        }
        return null;
    },

    // ==================== 文字工具输入路由（MangaStage 转发） ====================

    /** 文字工具按下：编辑中 → 点击编辑框外 = 提交（只提交不命中，下一步
     *  再点才选层/新建——灯箱同款两段式）；否则命中文字层重编辑、空白
     *  新建文字层就地输入。历史快照在动手前拍，提交时随标签入账 */
    _textStart(px, py) {
        if (!this._view) return;
        if (this._textEdit) { this._commitTextEdit(); return; }
        const before = this._histSnapshot();
        const hit = this._hitTextLayerAt(px, py);
        if (hit) {
            this._selectImageLayer(hit.id);   // 舞台选中语义复用（清元素选中+面板高亮）
            this._beginTextEdit(hit, false, before);
        } else {
            const p = this._toDraft(px, py);
            const layer = this.addTextLayer(p.x, p.y);
            this._selectImageLayer(layer.id);
            this._beginTextEdit(layer, true, before);
        }
    },

    // ==================== 就地编辑（透明 textarea 覆盖舞台） ====================

    /** 进入就地编辑：舞台绘制跳过该层（_drawPageLayers 分支判定），覆盖
     *  一层同字体/字号/颜色的透明 textarea 呈现文字（所见即所得）；
     *  Ctrl+Enter/点外提交、Esc 取消，键事件 stopPropagation 阻断全局
     *  快捷键（Delete/撤销等不穿透） */
    _beginTextEdit(layer, isNew, histSnap) {
        this._abortTextEdit();   // 防御：先收旧编辑（正常路由下不会到达）
        const area = this.stageCv && this.stageCv.parentElement;
        if (!area) return;
        const ta = document.createElement('textarea');
        ta.className = 'manga-text-editor';
        ta.value = layer.text.content;
        ta.spellcheck = false;
        area.appendChild(ta);
        this._textEdit = {
            layer, ta, isNew, histSnap,
            prev: layer.text.content,      // Esc 撤销本次修改 / 空提交恢复用
            prevName: layer.name
        };
        ta.addEventListener('input', () => this._onTextEditorInput());
        ta.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
                e.preventDefault();
                this._cancelTextEdit();
            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this._commitTextEdit();
            }
        });
        this._syncTextEditor();
        this._renderStage();   // 编辑层舞台隐藏，选中框/锚点照画（跟随内容增长）
        ta.focus();
        if (!isNew) ta.select();   // 重编辑全选原文字，输入即整体替换
    },

    /** 编辑框几何/样式同步：与舞台绘制同源换算（草稿坐标 → 舞台像素，
     *  内边距 = 渲染周边距、字号随 text.scale 与视口缩放）→ 编辑框文字
     *  与提交渲染逐像素对位；竖排 writing-mode + letterSpacing 与画布
     *  CHAR_ADV 对齐（横排字距由行高承担） */
    _syncTextEditor() {
        if (!this._textEdit || !this._view) return;
        const { layer, ta } = this._textEdit;
        const t = layer.text;
        const v = this._view;
        const layout = this._measureTextLayout(t);
        const s = Number(t.scale) || 1;
        const zoom = v.scale;
        const bw = (Math.ceil(layout.w) + layout.pad * 2) * s;
        const bh = (Math.ceil(layout.h) + layout.pad * 2) * s;
        ta.style.left = (v.ox + t.x * zoom) + 'px';
        ta.style.top = (v.oy + t.y * zoom) + 'px';
        ta.style.width = Math.max(4, bw * zoom) + 'px';
        ta.style.height = Math.max(4, bh * zoom) + 'px';
        ta.style.padding = (layout.pad * s * zoom) + 'px';
        ta.style.font = `${t.size * s * zoom}px "${t.font}", sans-serif`;
        ta.style.lineHeight = String(TextLayout.LINE_H);
        ta.style.color = t.color;
        ta.style.writingMode = t.vertical ? 'vertical-rl' : 'horizontal-tb';
        ta.style.letterSpacing = t.vertical
            ? `${(TextLayout.CHAR_ADV - 1) * t.size * s * zoom}px`
            : 'normal';
    },

    /** 输入中：内容即写草稿（F5/关页不丢已打的字），编辑框随内容增长 */
    _onTextEditorInput() {
        if (!this._textEdit) return;
        const { layer, ta } = this._textEdit;
        layer.text.content = ta.value;
        this._syncTextEditor();
        this._draftTouched = true;
        this._scheduleSave();
        this._renderStage();
    },

    /** 提交（Ctrl+Enter / 点击编辑框外 / 切工具 / 切页 / 关窗）：图层名随
     *  内容（首行前 12 字，PS 同款）+ 历史入账；空内容 → 新层静默摘除
     *  （从未入账零痕迹）、重编辑层恢复进入编辑前的文字（灯箱头注释
     *  语义「恢复原文字」——不留隐形空层） */
    _commitTextEdit() {
        if (!this._textEdit) return;
        const { layer, ta, isNew, histSnap, prev } = this._textEdit;
        this._textEdit = null;
        if (ta && ta.parentNode) ta.remove();
        const content = String(layer.text.content || '');
        if (!content.trim()) {
            if (isNew) {
                const layers = this._ensureDrawLayers();
                const idx = layers.indexOf(layer);
                if (idx >= 0) layers.splice(idx, 1);
                if (this._selLayerId === layer.id) this._selLayerId = null;
                this._renderLayerPanel();
            } else {
                layer.text.content = prev;
            }
            this._renderStage();
            return;
        }
        const name = content.split('\n')[0].trim().slice(0, 12);
        if (name) layer.name = name;
        this._commitHistory(histSnap, isNew ? '新建文字' : '编辑文字');
        this._draftTouched = true;
        this._scheduleSave();
        this._scheduleThumbRefresh();
        this._renderLayerPanel();   // 名称随内容更新
        this._renderStage();
    },

    /** 取消（Esc）：新建层静默摘除，重编辑层恢复进入编辑前的文字 */
    _cancelTextEdit() {
        if (!this._textEdit) return;
        const { layer, ta, isNew, prev } = this._textEdit;
        this._textEdit = null;
        if (ta && ta.parentNode) ta.remove();
        if (isNew) {
            const layers = this._ensureDrawLayers();
            const idx = layers.indexOf(layer);
            if (idx >= 0) layers.splice(idx, 1);
            if (this._selLayerId === layer.id) this._selLayerId = null;
            this._renderLayerPanel();
        } else {
            layer.text.content = prev;
        }
        this._renderStage();
    },

    /** 关窗硬清理：只移除编辑框与状态，不动图层栈（已输入内容随 input
     *  即写草稿，重开后按草稿呈现；灯箱 abortEdit 同语义） */
    _abortTextEdit() {
        if (!this._textEdit) return;
        const { ta } = this._textEdit;
        this._textEdit = null;
        if (ta && ta.parentNode) ta.remove();
    },

    // ==================== 顶栏选项条（标题栏，文字工具激活时显示） ====================

    /** 文字选项条：字体下拉 + 字号 + 横竖排分段 + 色板。挂标题栏
     *  （.manga-header-right 之前，画笔选项条同位同法——MangaDom 在
     *  _buildBrushBar 之后调用） */
    _buildTextBar() {
        const header = this.dialog && this.dialog.querySelector('.recipe-dialog-header');
        if (!header) return;
        const bar = document.createElement('div');
        bar.className = 'manga-text-tools';
        bar.hidden = true;
        // 字体下拉触发器（菜单挂 body，见 _toggleFontMenu）
        const fontBtn = document.createElement('button');
        fontBtn.type = 'button';
        fontBtn.className = 'manga-font-btn';
        fontBtn.title = '字体';
        const fontLabel = document.createElement('span');
        fontLabel.textContent = this._textOpts.font;
        fontBtn.appendChild(fontLabel);
        fontBtn.insertAdjacentHTML('beforeend',
            '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>');
        fontBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleFontMenu();
        });
        this._fontBtnEl = fontBtn;
        this._fontLabelEl = fontLabel;
        this._textFontList = TextLayout.FONTS;   // 引用相等判断的基准，勿 slice
        const fontMenu = document.createElement('div');
        fontMenu.className = 'manga-font-menu';
        fontMenu.hidden = true;
        document.body.appendChild(fontMenu);   // fixed 定位挂 body（逃出弹窗层叠）
        this._fontMenuEl = fontMenu;
        // 点外收菜单（document 级；弹窗 DOM 只建一次，监听随页面生命周期）
        document.addEventListener('mousedown', (e) => {
            if (this._fontMenuEl && !this._fontMenuEl.hidden &&
                !this._fontMenuEl.contains(e.target) &&
                !this._fontBtnEl.contains(e.target)) {
                this._fontMenuEl.hidden = true;
            }
        });
        // 字号（草稿像素 8~512）
        const sizeInput = document.createElement('input');
        sizeInput.type = 'number';
        sizeInput.className = 'manga-text-size';
        sizeInput.min = '8';
        sizeInput.max = '512';
        sizeInput.value = String(this._textOpts.size);
        sizeInput.title = '字号（草稿像素，8~512）';
        sizeInput.addEventListener('change', () => {
            const v = Math.min(512, Math.max(8, Math.round(Number(sizeInput.value) || 48)));
            sizeInput.value = String(v);
            this._textOpts.size = v;
            this._applyTextOpts();
        });
        this._textSizeEl = sizeInput;
        // 横排/竖排分段（横排默认激活）
        const dirH = document.createElement('button');
        dirH.type = 'button';
        dirH.className = 'manga-dir-btn';
        dirH.textContent = '横排';
        dirH.title = '横排文字';
        dirH.addEventListener('click', () => this._setTextDirection(false));
        const dirV = document.createElement('button');
        dirV.type = 'button';
        dirV.className = 'manga-dir-btn';
        dirV.textContent = '竖排';
        dirV.title = '竖排文字（CJK 直立逐字下排，西文段转 90°）';
        dirV.addEventListener('click', () => this._setTextDirection(true));
        this._dirHEl = dirH;
        this._dirVEl = dirV;
        bar.append(fontBtn, sizeInput, dirH, dirV);
        const right = header.querySelector('.manga-header-right');
        if (right) header.insertBefore(bar, right);
        else header.appendChild(bar);
        this._textBarEl = bar;
        this._syncTextDirUi();
    },

    /** 选项条随工具显隐（_setTool→_syncToolRailUi 联动）+ 激活时同步
     *  触发器文案与分段高亮（取色已迁右栏色板，ADR 068） */
    _syncTextBar() {
        if (!this._textBarEl) return;
        this._textBarEl.hidden = this.activeTool !== 'text';
        if (this._textBarEl.hidden) return;
        this._syncFontBtnLabel();
        this._syncTextDirUi();
        if (this._textSizeEl) this._textSizeEl.value = String(this._textOpts.size);
    },

    /** 字体菜单开关：开时按当前清单重建（高亮随选项），fixed 定位在
     *  触发器正下方并钳视口内；打开即自动加载系统全量（PS 同观感） */
    _toggleFontMenu() {
        const menu = this._fontMenuEl;
        if (!menu) return;
        if (!menu.hidden) { menu.hidden = true; return; }
        this._buildFontMenu();
        menu.hidden = false;
        const r = this._fontBtnEl.getBoundingClientRect();
        menu.style.top = (r.bottom + 4) + 'px';
        menu.style.left =
            Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
        this._ensureSystemFonts(true);
    },

    /** 打开菜单自动加载系统全量字体（PS 同观感，ADR 067）：仍是精选清单
     *  时后台 fetch（每次开窗至多一次），成功换全量就地重建；失败静默回
     *  落精选并保留手动重试项（auto=false=手动重试，状态栏如实报错） */
    _ensureSystemFonts(auto) {
        if (this._textFontList !== TextLayout.FONTS || this._fontListLoading) return;
        this._fontListLoading = true;
        const more = this._fontMenuEl && this._fontMenuEl.querySelector('.manga-font-more');
        if (more) { more.textContent = '正在加载系统字体…'; more.disabled = true; }
        TextLayout.loadSystemFonts().then((list) => {
            this._fontListLoading = false;
            if (list && list.length) this._textFontList = list;
            if (this._fontMenuEl && !this._fontMenuEl.hidden) this._buildFontMenu();
            if ((!list || !list.length) && !auto) {
                this._status('无法枚举系统字体（后端 /api/system-fonts 失败）', true);
                clearTimeout(this._fontMsgTimer);
                this._fontMsgTimer = setTimeout(() => {
                    if (this.statusEl && String(this.statusEl.textContent || '')
                        .startsWith('无法枚举系统字体')) this._status('');
                }, 2500);
            }
        });
    },

    /** 字体菜单重建：逐项字体预览（item.style.fontFamily）、当前项高亮；
     *  清单尾部条件挂「加载系统全部字体…」（后端 /api/system-fonts 枚举，
     *  仍是精选清单时才挂——加载成功换全量清单重建、失败状态栏提示） */
    _buildFontMenu() {
        const menu = this._fontMenuEl;
        if (!menu) return;
        menu.innerHTML = '';
        const cur = this._textOpts.font;
        for (const f of this._textFontList) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'manga-font-item' + (f.family === cur ? ' is-active' : '');
            item.style.fontFamily = `"${f.family}", sans-serif`;
            item.textContent = f.label;
            item.addEventListener('click', () => {
                this._textOpts.font = f.family;
                this._syncFontBtnLabel();
                this._applyTextOpts();
                menu.hidden = true;
            });
            menu.appendChild(item);
        }
        if (this._textFontList === TextLayout.FONTS) {
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'manga-font-item manga-font-more';
            more.textContent = '加载系统全部字体…';
            // 手动重试入口（打开菜单已自动加载一次，见 _ensureSystemFonts）
            more.addEventListener('click', () => this._ensureSystemFonts(false));
            menu.appendChild(more);
        }
    },

    _syncFontBtnLabel() {
        if (this._fontLabelEl) this._fontLabelEl.textContent = this._textOpts.font;
    },

    _setTextDirection(vertical) {
        this._textOpts.vertical = vertical;
        this._syncTextDirUi();
        this._applyTextOpts();
    },

    _syncTextDirUi() {
        if (!this._dirHEl) return;
        this._dirHEl.classList.toggle('is-active', !this._textOpts.vertical);
        this._dirVEl.classList.toggle('is-active', !!this._textOpts.vertical);
    },

    /** 文字色写入（色板 setColor 按工具分发到此，ADR 068）：记忆 + 目标
     *  层实时生效；未选中文字层时只记忆为下次新建默认（灯箱 applyColor
     *  同语义） */
    _setTextColor(c) {
        this._textColor = c;
        try { localStorage.setItem('lumenLight.mangaTextColor', c); } catch { /* 隐私模式等 */ }
        const layer = this._textTargetLayer();
        if (!layer) return;
        layer.text.color = c;
        if (this._textEdit) this._textEdit.ta.style.color = c;   // 编辑中即时所见即所得
        this._draftTouched = true;
        this._scheduleSave();
        this._scheduleThumbRefresh();
        this._renderStage();
    },

    /** 选项作用目标：编辑中的层优先；未编辑时落到当前选中的文字层
     *  （选中后改字体/字号/方向也要生效——灯箱 _targetLayer 同语义） */
    _textTargetLayer() {
        if (this._textEdit) return this._textEdit.layer;
        const sel = this._selLayerId != null ? this._layerById(this._selLayerId) : null;
        return sel && sel.text ? sel : null;
    },

    /** 字体/字号/横竖排改动写入目标文字层并重绘（未选中文字层时只存
     *  _textOpts 默认值，作为下次新建文字的默认） */
    _applyTextOpts() {
        const layer = this._textTargetLayer();
        if (!layer) return;
        layer.text.font = this._textOpts.font;
        layer.text.size = this._textOpts.size;
        layer.text.vertical = this._textOpts.vertical;
        if (this._textEdit) this._syncTextEditor();
        this._draftTouched = true;
        this._scheduleSave();
        this._scheduleThumbRefresh();
        this._renderStage();
    },

    // ==================== 文字渲染（舞台/缩略图共用原语） ====================
    // 算法在共享层 js/utils/TextLayout.js（ADR 067），本节只留一行委托——
    // MangaLayers._drawPageLayers/_paintLayerThumb、MangaPages._drawPageThumb
    // 与测试都经原型方法调用，签名与返回形态保持不变

    /** 文字布局测量（横竖排数学/pad/行清单）——委托 TextLayout */
    _measureTextLayout(t) {
        return TextLayout.measureTextLayout(t);
    },

    /** CJK/西文拆段——委托 TextLayout */
    _splitTextRuns(line) {
        return TextLayout.splitRuns(line);
    },

    /** 文字内容绘制（调用方已设好 transform，草稿像素坐标系）——委托 TextLayout */
    _drawTextContent(g, t, layout) {
        return TextLayout.drawTextContent(g, t, layout);
    },

    /** 舞台绘制（_drawPageLayers 文字分支调用）：草稿坐标 → 舞台变换
     *  后按属性现画（无离屏——文字层数据量小，直接矢量绘制保锐利） */
    _drawTextLayer(ctx, layer, X, Y, scale) {
        const t = layer.text;
        const layout = this._measureTextLayout(t);
        const k = scale * (Number(t.scale) || 1);
        ctx.save();
        ctx.translate(X(t.x), Y(t.y));
        ctx.scale(k, k);
        this._drawTextContent(ctx, t, layout);
        ctx.restore();
    },
});
