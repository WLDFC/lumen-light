/**
 * ==========================================================================
 * MangaEditor 子模块：页面图层渲染（ADR 073 自 MangaLayers.js 拆出）
 * ==========================================================================
 * 作用：_drawPageLayers 渲染口径（舞台 _renderStage/页缩略图/面板行缩略
 *       图/导出本页合成共用）——底→顶逐层：笔迹层折线 _drawStrokeLayerScratch
 *       （进行中笔迹画在其所属层位置）、图片层 drawImage（未加载完跳过，
 *       onload 触发重绘）、文字/形状层矢量现画（MangaText/MangaShape）；
 *       逐内容分派页裁剪（ADR 070：图片/形状不裁页出界可见，笔迹/文字
 *       裁页）；逐层不透明度 _layerOpacity；选中图片层覆盖 _drawLayerSelection
 *       （虚线框+八向锚点）。
 * 契约：原型混入（partial-class，ADR 026）——须后于主类加载。
 * ==========================================================================
 */

Object.assign(window.MangaEditor.prototype, {
    // ==================== 舞台分层渲染（_renderStage 调用） ====================

    /**
     * 层栈渲染：底→顶逐层。笔迹层画折线，图片层 drawImage（未加载完先
     * 跳过，onload 触发舞台重绘）；进行中笔迹画在其所属层位置。
     * 层栈整体在元素框之下（元素是结构化数据恒在最上），背景参考图更在层栈之下。
     * 逐层不透明度（2026-11-04 自灯箱迁移）：layer.opacity 缺省 1，save/
     * restore 包裹防泄漏到后续绘制。
     * 页裁剪按内容分派（ADR 070）：图片位图与形状层不裁页——移出画布后
     * 在页外黑边区依然可见（灯箱同款；形状出界移动 2026-11-07 用户拍板
     * 补遗）；笔迹/文字仍裁页内（画笔不该画出页外，文字按画幅裁剪是既有
     * 语义）。离屏合成路径页锚定（页尺寸画布）天然裁页，调用处包页裁剪
     * 保持一致
     */
    _drawPageLayers(ctx, X, Y, scale, d) {
        const layers = this._ensureDrawLayers();
        if (!layers.length && !this._stroke) return;
        const pageClip = () => {
            ctx.beginPath();
            ctx.rect(X(0), Y(0), d.width * scale, d.height * scale);
            ctx.clip();
        };
        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        for (const layer of layers) {
            if (!layer || layer.visible === false) continue;
            ctx.save();
            ctx.globalAlpha = this._layerOpacity(layer);
            if (layer.image && layer.image.src) {
                const img = this._ensureLayerImage(layer.image.src);
                const imgReady = img.complete && img.naturalWidth;
                // 调色预览钩子（MangaAdjustTool，ADR 074）：该层调色中改画
                // 预览画布（非破坏预览，关闭丢弃/保存换 src 后钩子摘除）
                const adjPrev = this._adjustPreview && this._adjustPreview.layerId === layer.id
                    ? this._adjustPreview.cv : null;
                const drawSrc = adjPrev || (imgReady ? img : null);
                // 图片层可落笔（2026-11-05 PS 语义：笔迹叠在选中层图片上）。
                // 层内含橡皮（含进行中的橡皮预览）走离屏合成——橡皮擦除的是
                // 其下所有本层内容（图片像素与更早笔迹，PS 层语义，用户拍板
                // 「总体模仿 PS」）；纯画笔笔迹直接叠图上零开销。持久化由
                // _bakeEraseOnImage 收笔烘焙承接
                const strokes = Array.isArray(layer.strokes) ? layer.strokes : [];
                const previewErase = this._stroke && this._stroke.layerId === layer.id && this._stroke.erase;
                if (strokes.some((st) => st && st.erase) || previewErase) {
                    ctx.save();
                    pageClip();
                    this._drawImageLayerScratch(ctx, layer, X, Y, scale, d, drawSrc);
                    ctx.restore();
                } else {
                    if (drawSrc) {
                        const [x1, y1, x2, y2] = layer.image.bbox;
                        ctx.drawImage(drawSrc, X(x1), Y(y1), (x2 - x1) * scale, (y2 - y1) * scale);   // 不裁页：出界可见
                    }
                    ctx.save();
                    pageClip();
                    for (const st of strokes) this._drawStrokePath(ctx, st, X, Y, scale);
                    if (this._stroke && this._stroke.layerId === layer.id) {
                        this._drawStrokePath(ctx, this._stroke, X, Y, scale);   // 运笔实时预览
                    }
                    ctx.restore();
                }
            } else if (layer.text) {
                // 文字层（MangaText 混入）：按属性直接绘进舞台（矢量现画
                // 保锐利）；就地编辑中的层跳过——编辑框 textarea 覆盖呈现，
                // 提交后恢复
                if (!this._textEdit || this._textEdit.layer !== layer) {
                    ctx.save();
                    pageClip();
                    this._drawTextLayer(ctx, layer, X, Y, scale);
                    ctx.restore();
                }
            } else if (layer.shape) {
                // 形状层（MangaShape 混入，ADR 069）：按属性直接绘进舞台
                // （矢量现画，外伸随包围盒实时计算不缓存）；不裁页——出界
                // 移动后页外仍可见（2026-11-07 用户拍板补遗）
                this._drawShapeLayer(ctx, layer, X, Y, scale);
            } else if (Array.isArray(layer.strokes)) {
                // 含橡皮笔迹的层走离屏合成（destination-out 只擦本层——
                // 直接画上舞台会把页底/下层一起打穿）；纯笔迹层直画零开销
                ctx.save();
                pageClip();
                if (layer.strokes.some((st) => st && st.erase)) {
                    this._drawStrokeLayerScratch(ctx, layer, X, Y, scale, d);
                } else {
                    for (const st of layer.strokes) this._drawStrokePath(ctx, st, X, Y, scale);
                    if (this._stroke && this._stroke.layerId === layer.id) {
                        this._drawStrokePath(ctx, this._stroke, X, Y, scale);   // 运笔实时预览
                    }
                }
                ctx.restore();
            }
            ctx.restore();
        }
        ctx.restore();
    },

    /**
     * 图片层含橡皮笔迹的离屏合成（PS 层语义）：图片先落画布，层内笔迹
     * 按序混排——画笔 source-over、橡皮 destination-out，擦除的是「其下
     * 所有本层内容」（图片像素与更早笔迹）。整层由调用方按不透明度压回
     * 舞台；画布按草稿像素复用。持久化由 _bakeEraseOnImage 收笔烘焙承接
     * （不烘焙则图片移动后擦痕不跟随——擦痕是页锚定数据）
     */
    _drawImageLayerScratch(ctx, layer, X, Y, scale, d, img) {
        if (!this._imgScratch) this._imgScratch = document.createElement('canvas');
        const sc = this._imgScratch;
        if (sc.width !== d.width || sc.height !== d.height) {
            sc.width = d.width;
            sc.height = d.height;
        }
        const g = sc.getContext('2d');
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, sc.width, sc.height);
        if (img && layer.image) {
            const [x1, y1, x2, y2] = layer.image.bbox;
            g.drawImage(img, x1, y1, x2 - x1, y2 - y1);
        }
        g.lineJoin = 'round';
        g.lineCap = 'round';
        const id = (x) => x;   // 草稿像素 1:1 落离屏
        const strokes = Array.isArray(layer.strokes) ? layer.strokes : [];
        for (const st of strokes) {
            g.globalCompositeOperation = st && st.erase ? 'destination-out' : 'source-over';
            this._drawStrokePath(g, st, id, id, 1);
        }
        if (this._stroke && this._stroke.layerId === layer.id) {
            g.globalCompositeOperation = this._stroke.erase ? 'destination-out' : 'source-over';
            this._drawStrokePath(g, this._stroke, id, id, 1);   // 运笔实时预览
        }
        g.globalCompositeOperation = 'source-over';
        ctx.drawImage(sc, X(0), Y(0), d.width * scale, d.height * scale);
    },

    /** 层不透明度归一：缺省 1；0.05~1 之外越界值钳回边界（渲染层兜底，
     *  不改草稿——存档里存原样，异常值不放大） */
    _layerOpacity(layer) {
        const v = layer && Number(layer.opacity);
        return Number.isFinite(v) ? Math.min(1, Math.max(0.05, v)) : 1;
    },

    /**
     * 含橡皮笔迹层的离屏合成：本层笔迹（含进行中的橡皮）先画进页尺寸
     * 的离屏画布——橡皮笔迹以 destination-out 只擦本层已画内容，整层再
     * 由调用方按不透明度压回舞台。直接在舞台 ctx 上 destination-out 会
     * 把页底/下层一起打穿，必须隔离。画布按草稿像素 1:1 复用（多层串
     * 用清屏）；超高倍缩放下该层略软于直画路径，换正确语义的代价
     */
    _drawStrokeLayerScratch(ctx, layer, X, Y, scale, d) {
        if (!this._strokeScratch) this._strokeScratch = document.createElement('canvas');
        const sc = this._strokeScratch;
        if (sc.width !== d.width || sc.height !== d.height) {
            sc.width = d.width;
            sc.height = d.height;
        }
        const g = sc.getContext('2d');
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, sc.width, sc.height);
        g.lineJoin = 'round';
        g.lineCap = 'round';
        const id = (x) => x;   // 草稿像素 1:1 落离屏
        for (const st of layer.strokes) {
            g.globalCompositeOperation = st && st.erase ? 'destination-out' : 'source-over';
            this._drawStrokePath(g, st, id, id, 1);
        }
        if (this._stroke && this._stroke.layerId === layer.id) {
            g.globalCompositeOperation = this._stroke.erase ? 'destination-out' : 'source-over';
            this._drawStrokePath(g, this._stroke, id, id, 1);   // 运笔实时预览
        }
        g.globalCompositeOperation = 'source-over';
        ctx.drawImage(sc, X(0), Y(0), d.width * scale, d.height * scale);
    },

    /** 当前可调层：选中的图片/文字/形状层优先，否则活动笔迹层（不透明度滑块目标） */
    _currentEditableLayer() {
        const sel = this._selLayerId != null ? this._layerById(this._selLayerId) : null;
        if (sel && (sel.image || sel.text || sel.shape)) return sel;
        return this._activeStrokeLayer();
    },

    /** 设层不透明度（滑块 input 实时路径）：只变值+重绘，历史由 change 收口 */
    _setLayerOpacity(id, v) {
        const layer = this._layerById(id);
        if (!layer) return;
        const num = Number(v);
        if (!Number.isFinite(num)) return;
        layer.opacity = Math.min(1, Math.max(0.05, num));
        this._draftTouched = true;
        this._scheduleSave();
        this._scheduleThumbRefresh();
        this._renderStage();
    },

    /** 单条笔迹（两点以上折线，单点画圆点——round cap 零长线段部分实现不渲染） */
    _drawStrokePath(ctx, st, X, Y, scale) {
        const pts = st && st.points;
        if (!Array.isArray(pts) || pts.length < 2) return;
        const w = Math.max(0.5, (st.width || this._brushWidth) * scale);
        ctx.strokeStyle = st.color || '#ff5a5a';
        ctx.lineWidth = w;
        ctx.beginPath();
        if (pts.length < 4) {
            ctx.arc(X(pts[0]), Y(pts[1]), w / 2, 0, Math.PI * 2);
            ctx.fillStyle = ctx.strokeStyle;
            ctx.fill();
            return;
        }
        ctx.moveTo(X(pts[0]), Y(pts[1]));
        for (let i = 2; i < pts.length; i += 2) ctx.lineTo(X(pts[i]), Y(pts[i + 1]));
        ctx.stroke();
    },

    /** 选中图片/文字层的舞台覆盖（_renderStage 元素框之后调用）：虚线框 + 八向锚点 */
    _drawLayerSelection(ctx, X, Y, scale) {
        const layer = this._selLayerId != null ? this._layerById(this._selLayerId) : null;
        const bbox = layer ? this._layerBounds(layer) : null;
        if (!bbox) return;
        const [x1, y1, x2, y2] = bbox;
        ctx.strokeStyle = '#4d9fff';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(X(x1) + 0.5, Y(y1) + 0.5, (x2 - x1) * scale - 1, (y2 - y1) * scale - 1);
        ctx.setLineDash([]);
        for (const a of this._anchors(bbox, X, Y)) {
            ctx.beginPath();
            ctx.arc(a.x, a.y, 4.5, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.strokeStyle = '#4d9fff';
            ctx.lineWidth = 1.6;
            ctx.stroke();
        }
    },

});
