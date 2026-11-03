/**
 * ==========================================================================
 * MangaEditor 子模块：图层面板 UI（ADR 073 自 MangaLayers.js 拆出）
 * ==========================================================================
 * 作用：右栏「图层」分区——事件绑定 _buildLayerPanel（新建/置入/文件选择/
 *       不透明度滑块）、层栈渲染 _renderLayerPanel（顶→底层行：眼睛/内容
 *       缩略图/名称/复制/删除；活动笔迹层=实心蓝，选中图片层=蓝边）、
 *       行右键菜单、行缩略图绘制 _paintLayerThumb（缩略图即类型视觉：
 *       图片层铺图/笔迹层迷你预览/文字层文字预览）、透明度 UI 同步。
 *       层栈模型 CRUD/图片层/磁吸在 MangaLayers，渲染在 MangaPageRender。
 * 契约：原型混入（partial-class，ADR 026）——须后于主类加载。
 * ==========================================================================
 */

Object.assign(window.MangaEditor.prototype, {
    // ==================== 图层面板（右栏分区） ====================

    /** 面板事件绑定（MangaDom._buildDom 调用）：新建/置入/文件选择/不透明度滑块/右键菜单 */
    _buildLayerPanel() {
        if (!this.layersAddBtn) return;
        this.layersAddBtn.addEventListener('click', () => {
            this._addStrokeLayer(false);
            this._status('已新建笔迹图层');
        });
        this.layersAddImgBtn.addEventListener('click', () => this.layerFileEl.click());
        this.layerFileEl.addEventListener('change', () => {
            const f = this.layerFileEl.files && this.layerFileEl.files[0];
            this.layerFileEl.value = '';
            if (!f) return;
            this._placeImageFile(f)
                .catch((err) => this._status('置入图片失败：' + (err && err.message ? err.message : err), true));
        });
        this._bindLayerOpacitySlider();
        // 图层右键菜单（灯箱同款三件，作用于右键的那一行）
        this.layerCtxMenu = new LumenContextMenu({ container: this.dialog });
        this._renderLayerPanel();
    },

    /** 图层右键菜单（灯箱 StudioLayerPanel 同款：新建/复制/删除） */
    _openLayerMenu(x, y, id) {
        if (!this.layerCtxMenu) return;
        this.layerCtxMenu.open({
            x, y,
            items: [
                { label: '新建笔迹图层', onClick: () => {
                    this._addStrokeLayer(false);
                    this._status('已新建笔迹图层');
                } },
                { label: '复制图层', onClick: () => this._duplicateLayer(id) },
                { label: '删除图层', danger: true, onClick: () => this._deleteLayer(id) }
            ]
        });
    },

    /**
     * 层栈行渲染：顶→底；结构变化（增删/排序/显隐/切页）后整表重建。
     * 行形态与灯箱 ImageStudio 对齐（2026-11-04 用户拍板"跟图片编辑器
     * 一样"）：缩略图（28px 棋盘格垫透明）+ 名字 + 眼睛（行尾）——行上
     * 不摆操作按钮，复制/删除/新建走右键菜单；排序=行上按住拖拽；
     * 激活/选中=蓝描边（非实心填充）
     */
    _renderLayerPanel() {
        if (!this.layersEl) return;   // 未建 DOM（vm 测试）
        const layers = this._ensureDrawLayers();
        // 当前层（PS 语义）：选中图片层优先，否则活动笔迹层——与画笔/橡皮
        // 落笔目标、不透明度滑块目标同一个概念，高亮永远只有这一行
        const cur = this._currentEditableLayer();
        if (this.layersNoteEl) {
            this.layersNoteEl.textContent = layers.length ? `（${layers.length}）` : '';
        }
        this.layersEl.innerHTML = '';
        for (let idx = layers.length - 1; idx >= 0; idx--) {
            const layer = layers[idx];
            const row = document.createElement('div');
            row.className = 'manga-layer-row' +
                (cur && cur.id === layer.id && !layer.image && !layer.text && !layer.shape ? ' is-active' : '') +
                (layer.id === this._selLayerId && (layer.image || layer.text || layer.shape) ? ' selected' : '');
            row.dataset.id = layer.id;
            // 高亮=当前层（唯一蓝框）：笔迹行 is-active、图片/文字/形状行
            // selected（两类同蓝实线互斥，ADR 062）——语义见
            // _currentEditableLayer（落笔处/滑块目标/舞台选中同一概念）
            row.title = layer.image
                ? '图片层：拖动 / 缩放 / 抠图 / 删除的目标；画笔与橡皮也落在它上面'
                : layer.text
                    ? '文字层：文字工具点它再编辑；select 工具可拖动 / 等比缩放'
                    : layer.shape
                        ? '形状层：形状工具点它改属性；select 工具可拖动 / 八向拉伸'
                        : '笔迹层：画笔 / 橡皮的落笔处（点行切换）';
            row.innerHTML = `
                <canvas class="manga-layer-thumb" width="56" height="56" aria-hidden="true"></canvas>
                <span class="manga-layer-name"></span>
                <button type="button" class="manga-layer-eye" title="显示 / 隐藏"></button>
            `;
            // 名称是自动编号非用户输入；仍走 textContent 保持惯例
            row.querySelector('.manga-layer-name').textContent =
                layer.name || (layer.image ? '图片' : layer.text ? '文字' : layer.shape ? '形状' : '图层');
            const eye = row.querySelector('.manga-layer-eye');
            eye.innerHTML = MANGA_EYE_SVG;
            eye.classList.toggle('hidden-layer', layer.visible === false);
            this._paintLayerThumb(row.querySelector('.manga-layer-thumb'), layer);
            row.addEventListener('click', () => this._layerRowClick(layer.id));
            row.addEventListener('pointerdown', (e) => this._onLayerRowPointerDown(e, layer, row));
            row.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this._openLayerMenu(e.clientX, e.clientY, layer.id);
            });
            eye.addEventListener('click', (e) => {
                e.stopPropagation();
                this._toggleLayerVisible(layer.id);
            });
            this.layersEl.appendChild(row);
        }
        this._syncLayerOpacityUi();
    },

    /**
     * 面板行内容缩略图（56px 背衬 = 28px 显示的 2x，高分屏清晰；棋盘格
     * 垫透明由 CSS 提供——PS 同款语义，空层即纯棋盘格）：图片层 contain
     * 铺图（未加载完异步补绘——onload 就绪后行仍在 DOM 就地重画）；
     * 文字层渲染文字内容预览；笔迹层按笔迹包围盒画迷你预览；未来的
     * 形状层在此加绘制分支
     */
    _paintLayerThumb(cv, layer) {
        if (!cv || !layer) return;
        const ctx = cv.getContext('2d');
        ctx.clearRect(0, 0, cv.width, cv.height);
        if (layer.image && layer.image.src) {
            // 调色预览钩子（MangaAdjustTool，ADR 074）：该层调色中缩略图
            // 同步画预览结果（预览画布与源图同分辨率，映射口径不变）
            const img = (this._adjustPreview && this._adjustPreview.layerId === layer.id)
                ? this._adjustPreview.cv
                : this._layerThumbImg(layer.image.src, cv, layer);
            // 图片层可落笔后缩略图按页坐标渲染（笔迹与图片同基准对齐），
            // 不再对图片本身 contain 铺满——生成图 bbox 本就 contain 铺页，
            // 常规观感不变；用户拖小图片层后缩略图如实反映其位置大小
            const pw = (this.draft && this.draft.width) || 1;
            const ph = (this.draft && this.draft.height) || 1;
            const fit = Math.min(cv.width / pw, cv.height / ph);
            const ox = (cv.width - pw * fit) / 2, oy = (cv.height - ph * fit) / 2;
            if (img.complete && img.naturalWidth && layer.image.bbox) {
                const [x1, y1, x2, y2] = layer.image.bbox;
                ctx.drawImage(img, ox + x1 * fit, oy + y1 * fit, (x2 - x1) * fit, (y2 - y1) * fit);
            }
            // 层内笔迹按页坐标叠图上，按条目切合成模式——橡皮条目在此
            // 正确擦除图片像素（与舞台新渲染语义一致）
            const strokes = (Array.isArray(layer.strokes) ? layer.strokes : [])
                .filter((st) => st && Array.isArray(st.points) && st.points.length >= 2);
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            for (const st of strokes) {
                ctx.globalCompositeOperation = st.erase ? 'destination-out' : 'source-over';
                const pts = st.points;
                ctx.strokeStyle = st.color || '#ff5a5a';
                ctx.lineWidth = Math.max(0.6, (st.width || 4) * fit);
                ctx.beginPath();
                if (pts.length < 4) {
                    ctx.arc(ox + pts[0] * fit, oy + pts[1] * fit,
                        Math.max(0.6, (st.width || 4) * fit / 2), 0, Math.PI * 2);
                    ctx.fillStyle = ctx.strokeStyle;
                    ctx.fill();
                    continue;
                }
                ctx.moveTo(ox + pts[0] * fit, oy + pts[1] * fit);
                for (let i = 2; i + 1 < pts.length; i += 2) ctx.lineTo(ox + pts[i] * fit, oy + pts[i + 1] * fit);
                ctx.stroke();
            }
            ctx.globalCompositeOperation = 'source-over';   // 循环里按条目切过合成模式，收口还原
            return;
        }
        if (layer.text) {
            // 文字层（2026-11-05 自灯箱复刻，注释预留位兑现）：内容按属性
            // 渲染缩进预览（缩略图即类型视觉——空文字=纯棋盘格，灯箱空层
            // 同语义）；文字本身按 fit×text.scale 等比缩进
            if (!String(layer.text.content || '').trim()) return;
            const layout = this._measureTextLayout(layer.text);
            const ts = Number(layer.text.scale) || 1;
            const bw = (Math.ceil(layout.w) + layout.pad * 2) * ts;
            const bh = (Math.ceil(layout.h) + layout.pad * 2) * ts;
            const pad = 3;
            const fit = Math.min((cv.width - pad * 2) / Math.max(1, bw),
                (cv.height - pad * 2) / Math.max(1, bh));
            const ox = (cv.width - bw * fit) / 2, oy = (cv.height - bh * fit) / 2;
            ctx.save();
            ctx.translate(ox, oy);
            ctx.scale(fit * ts, fit * ts);
            this._drawTextContent(ctx, layer.text, layout);
            ctx.restore();
            return;
        }
        if (layer.shape) {
            // 形状层（ADR 069，注释预留位兑现）：矢量绘制缩进预览——灯箱
            // 用 ▢ 字符徽标，漫画面板全形态都是画出来的（缩略图即类型视觉）
            const b = this._shapeLayerBounds(layer);
            const sh = layer.shape;
            const pad = 3;
            const bw = Math.max(1, b[2] - b[0]), bh = Math.max(1, b[3] - b[1]);
            const fit = Math.min((cv.width - pad * 2) / bw, (cv.height - pad * 2) / bh);
            const ox = (cv.width - bw * fit) / 2, oy = (cv.height - bh * fit) / 2;
            ctx.save();
            ctx.translate(ox - b[0] * fit, oy - b[1] * fit);
            ctx.scale(fit, fit);
            this._drawShapeContent(ctx, sh, layer.x, layer.y, sh.w, sh.h);
            ctx.restore();
            return;
        }
        const strokes = Array.isArray(layer.strokes) ? layer.strokes : [];
        if (strokes.length === 0) return;   // 空层=纯棋盘格（灯箱同款语义）
        // 笔迹迷你预览：按笔迹包围盒 contain 缩进
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const st of strokes) {
            const pts = st && st.points;
            if (!Array.isArray(pts)) continue;
            for (let i = 0; i + 1 < pts.length; i += 2) {
                x1 = Math.min(x1, pts[i]); y1 = Math.min(y1, pts[i + 1]);
                x2 = Math.max(x2, pts[i]); y2 = Math.max(y2, pts[i + 1]);
            }
        }
        if (!Number.isFinite(x1)) return;
        const pad = 3;
        const fit = Math.min((cv.width - pad * 2) / Math.max(1, x2 - x1),
            (cv.height - pad * 2) / Math.max(1, y2 - y1));
        const ox = (cv.width - (x2 - x1) * fit) / 2, oy = (cv.height - (y2 - y1) * fit) / 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        for (const st of strokes) {
            // 橡皮笔迹：缩略图是单层视图（透明底），destination-out 天然正确
            ctx.globalCompositeOperation = st && st.erase ? 'destination-out' : 'source-over';
            const pts = st && st.points;
            if (!Array.isArray(pts) || pts.length < 2) continue;
            ctx.strokeStyle = st.color || '#ff5a5a';
            ctx.lineWidth = Math.max(1, (st.width || 4) * fit);
            ctx.beginPath();
            if (pts.length < 4) {
                ctx.arc(ox + pts[0] * fit, oy + pts[1] * fit, Math.max(1, (st.width || 4) * fit / 2), 0, Math.PI * 2);
                ctx.fillStyle = ctx.strokeStyle;
                ctx.fill();
                continue;
            }
            ctx.moveTo(ox + pts[0] * fit, oy + pts[1] * fit);
            for (let i = 2; i + 1 < pts.length; i += 2) ctx.lineTo(ox + pts[i] * fit, oy + pts[i + 1] * fit);
            ctx.stroke();
        }
        ctx.globalCompositeOperation = 'source-over';   // 循环里按条目切过合成模式，收口还原
    },

    /** 行缩略图图片缓存（url → Image；onload 就绪后行仍在 DOM 就地补绘） */
    _layerThumbImg(src, cv, layer) {
        if (!this._layerThumbImgCache) this._layerThumbImgCache = new Map();
        let img = this._layerThumbImgCache.get(src);
        if (img) return img;
        img = new Image();
        img.onload = () => { if (cv.isConnected) this._paintLayerThumb(cv, layer); };
        img.src = src;
        this._layerThumbImgCache.set(src, img);
        return img;
    },

    /**
     * 不透明度滑块（面板头，2026-11-04 自灯箱迁移）：作用于当前可调层
     * （选中图片层优先，否则活动笔迹层）；input 实时改值重绘，change
     * 一次性入历史（快照在首次 input 时拍，拖一次滑块=一条记录）。
     * 常驻显示（2026-11-04 用户要求）：无可调层时置灰禁用而非整行隐藏，
     * 面板头布局不随选中态跳动
     */
    _syncLayerOpacityUi() {
        if (!this.layerOpacityWrap) return;
        const layer = this._currentEditableLayer();
        this.layerOpacityWrap.hidden = false;
        this.layerOpacityRange.disabled = !layer;
        if (!layer) return;
        const v = this._layerOpacity(layer);
        this.layerOpacityRange.value = String(v);
        this.layerOpacityVal.textContent = Math.round(v * 100) + '%';
    },

    /** 不透明度滑块事件（_buildLayerPanel 里接线） */
    _bindLayerOpacitySlider() {
        if (!this.layerOpacityRange) return;
        this.layerOpacityRange.addEventListener('input', () => {
            const layer = this._currentEditableLayer();
            if (!layer) return;
            if (!this._opacityHistSnap) this._opacityHistSnap = this._histSnapshot();
            this._setLayerOpacity(layer.id, Number(this.layerOpacityRange.value));
            this.layerOpacityVal.textContent =
                Math.round(this._layerOpacity(layer) * 100) + '%';
        });
        this.layerOpacityRange.addEventListener('change', () => {
            if (this._opacityHistSnap) {
                this._commitHistory(this._opacityHistSnap, '图层不透明度');
                this._opacityHistSnap = null;
            }
        });
    },

    /** 面板高亮就地同步（选中态切换不重建列表）：活动笔迹层/选中图片层；
     *  不透明度滑块跟随当前可调层 */
    _syncLayerPanelUi() {
        if (!this.layersEl) return;
        this.layersEl.querySelectorAll('.manga-layer-row').forEach((row) => {
            const layer = this._layerById(Number(row.dataset.id));
            if (!layer) return;
            const cur = this._currentEditableLayer();
            row.classList.toggle('is-active',
                !!(layer.strokes && !layer.image && !layer.text && cur && cur.id === layer.id));
            row.classList.toggle('selected',
                !!(layer.id === this._selLayerId && (layer.image || layer.text || layer.shape)));
        });
        this._syncLayerOpacityUi();
    },
});

// （2026-11-04）层类型小图标已随「行内容缩略图」退役——缩略图本身即
// 类型视觉：图片层铺图、笔迹层画笔迹预览、文字层渲染文字预览（2026-11-05
// 文字层加入）；未来的形状层在此加绘制分支