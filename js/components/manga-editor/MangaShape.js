/**
 * ==========================================================================
 * MangaEditor 子模块：形状工具（自灯箱 StudioShapeTool 迁移，ADR 069）
 * ==========================================================================
 * 作用：形状层 = draft.drawLayers 的第四种图层形态（笔迹/图片/文字之外，
 *       分派按 layer.shape 存在性）——形状按属性（类型/宽高/填充/描边色/
 *       描边宽/圆角/尾巴方位）直接绘进舞台画布，移动（layer-move 平移
 *       x/y）/非等比拉伸（layer-resize 直改 w/h，八向锚点复用）/不透明
 *       度/显隐/复制/删除全部复用既有图层管线；持久化随 drawLayers 走
 *       （路由宽松校验存原样，_normalizeDocument 逐项守卫只查 truthy
 *       object）；不参与编译（_draftForCompile 整体剥离）也不写回画布
 *       存档图（_writeBackModifiedLayers 只认图片层——形状与文字同为
 *       编辑器侧注释）。
 * 与灯箱的结构差异（迁移时改写而非照抄的部分，TextLayout 先例同款）：
 *       灯箱形状层是 DOM canvas（paintCv，tx/ty 含外伸 + tscale 缩放烘焙
 *       ——位图会糊才需要烘焙），漫画层是 stage 画布里的纯 JSON 记录，
 *       矢量现画永远锐利：x/y = 形状框左上角（不含外伸），外伸量经
 *       ShapeLayout.extFor 实时计算不缓存；拉伸=非等比直改 w/h（用户
 *       拍板），边宽/圆角保持设定值；拖拽创建走通用 _drag 通道
 *       （mode:'shape-create'，打断取消/指针捕获复用）；灯箱由移动工具
 *       承担的拖动/缩放对应漫画 select 工具的 layer-move/layer-resize。
 * 交互（灯箱同款）：形状工具下点击已有形状层 = 选中并反向同步选项条；
 *       空白拖拽创建（Shift 约束正方），干点（<6px）静默摘除零历史；
 *       选项作用目标=选中形状层→仅存 _shapeOpts 默认（灯箱同语义）。
 * 选项条（标题栏，画笔/文字选项条同位）：类型四钮 + 填充色/红斜杠去填充
 *       + 边框色/红斜杠去边框 + 边宽/圆角滑杆。尾巴方位无 UI（灯箱同款
 *       固定 'lb'）；右栏色板 setColor 按工具分发到填充色（ADR 068 契约
 *       扩一档），边框色走选项条原生色块。
 * 几何算法在共享层 js/utils/ShapeLayout.js（双编辑器共用勿复制，ADR 069
 *       ——灯箱 StudioShapeTool 同消费方），本文件只留宿主接线：
 *       _drawShapeContent 一行委托，属性与手势、选项条 DOM 均为漫画宿主侧。
 * 契约：原型混入（partial-class，ADR 026）——方法 Object.assign 进
 *       MangaEditor.prototype，this 即编辑器实例；须后于主类与 ShapeLayout
 *       加载（index.html 第十三混入）。
 * ==========================================================================
 */

Object.assign(window.MangaEditor.prototype, {

    // ==================== 形状层模型 ====================

    /** 新建形状层：插层栈顶（数组底→顶序），属性取当前默认值；宽高先给
     *  最小 2 由拖拽实时改；不单独入账（提交时随「绘制形状」一并入——
     *  干点取消静默摘除零痕迹，文字层同款） */
    addShapeLayer(x, y) {
        const layers = this._ensureDrawLayers();
        const id = this._allocLayerId();
        const layer = {
            id,
            name: `形状 ${id}`,
            visible: true,
            x, y,
            shape: {
                type: this._shapeOpts.type,
                w: 2, h: 2,
                fill: this._shapeOpts.fill,
                strokeColor: this._shapeOpts.strokeColor,
                strokeWidth: this._shapeOpts.strokeWidth,
                radius: this._shapeOpts.radius,
                tail: this._shapeOpts.tail
            }
        };
        layers.push(layer);
        this._renderLayerPanel();   // 面板即时出现（提交后更名，取消则摘除）
        return layer;
    },

    /** 形状层几何包围盒（草稿坐标，含渲染外伸）：命中/手势/选中框/缩略图
     *  共用这份口径——外伸（气泡尾巴/描边外刺）实时算不缓存（灯箱缓存
     *  _shapeExt 是 paintCv 定位需要，漫画矢量现画无此依赖） */
    _shapeLayerBounds(layer) {
        const s = layer && layer.shape;
        if (!s) return null;
        const ext = ShapeLayout.extFor(s, s.w, s.h);
        return [layer.x - ext.left, layer.y - ext.top,
            layer.x + s.w + ext.right, layer.y + s.h + ext.bottom];
    },

    /** 舞台命中形状层：可见者自顶向下首个（草稿坐标判定，AABB 含外伸） */
    _hitShapeLayerAt(px, py) {
        if (!this._view) return null;
        const p = this._toDraft(px, py);
        const layers = this._ensureDrawLayers();
        for (let i = layers.length - 1; i >= 0; i--) {
            const l = layers[i];
            if (!l || !l.shape || l.visible === false) continue;
            const b = this._shapeLayerBounds(l);
            if (p.x >= b[0] && p.x <= b[2] && p.y >= b[1] && p.y <= b[3]) return l;
        }
        return null;
    },

    // ==================== 输入路由（MangaStage 转发）与拖拽创建 ====================

    /** 形状工具按下：命中形状层 → 选中并同步选项条（再编辑，灯箱同款）；
     *  空白 → 新建形状层并开始拖拽创建（走通用 _drag 通道 mode:
     *  'shape-create'，指针捕获/打断取消复用既有机制）。历史快照动手前
     *  拍，提交时随「绘制形状」一并入账 */
    _shapeStart(px, py) {
        if (!this._view) return;
        const hit = this._hitShapeLayerAt(px, py);
        if (hit) {
            this._selectImageLayer(hit.id);   // 舞台选中语义复用（清元素选中+面板高亮）
            this._syncShapeOptsFromLayer(hit);
            return;
        }
        const p = this._toDraft(px, py);
        // 只能在画幅内新建：按下点出画幅（舞台黑边区）直接忽略——灯箱
        // 绘制面=图片本身天然无此路径，漫画舞台外扩须显式守卫；画幅外
        // 已存在的形状仍可点选拖回（layer-move 钳制会把出界 bbox 拉回）
        if (p.x < 0 || p.y < 0 || p.x > this.draft.width || p.y > this.draft.height) return;
        const before = this._histSnapshot();
        const layer = this.addShapeLayer(p.x, p.y);
        this._selectImageLayer(layer.id);
        this._drag = {
            mode: 'shape-create', layer, histSnap: before,
            start: p, startPx: px, startPy: py, moved: false
        };
    },

    /** 拖拽创建中：更新形状宽高与图层位置（解析图形渲染零成本，所见即
     *  所得）；Shift 约束正方。起/终点各自钳进画幅再算宽高——拖到黑边
     *  形状贴边停住不越界（灯箱=绘制面即画布的同语义）；Shift 取大轴后
     *  仍须再钳一次（向右/下扩出的正方可能越过底/右边）。_onPointerMove
     *  的 shape-create 分支调用 */
    _shapeCreateMove(p, e) {
        const d = this._drag;
        if (!d || d.mode !== 'shape-create') return;
        const dw = this.draft.width, dh = this.draft.height;
        const cx = Math.max(0, Math.min(dw, p.x));
        const cy = Math.max(0, Math.min(dh, p.y));
        const sx = Math.max(0, Math.min(dw, d.start.x));
        const sy = Math.max(0, Math.min(dh, d.start.y));
        let w = Math.abs(cx - sx);
        let h = Math.abs(cy - sy);
        d.layer.x = Math.min(cx, sx);
        d.layer.y = Math.min(cy, sy);
        if (e && e.shiftKey) { const m = Math.max(w, h); w = m; h = m; }
        const s = d.layer.shape;
        s.w = Math.max(2, Math.round(Math.min(w, dw - d.layer.x)));
        s.h = Math.max(2, Math.round(Math.min(h, dh - d.layer.y)));
        d.moved = true;
    },

    /** 拖拽提交（_onPointerUp 的 shape-create 分支调用）：位移过小（干点）
     *  → 静默摘除刚建的层（从未入账，推历史只会刷出无效条目，灯箱同款）；
     *  正常 → 按类型命名 + 「绘制形状」入账。自清 _drag（生产路径在
     *  _onPointerUp 已先置空，这里兜底防直调残留） */
    _shapeCreateUp(drag) {
        this._drag = null;
        const layer = drag && drag.layer;
        if (!layer) return;
        if (layer.shape.w < 6 || layer.shape.h < 6) {
            this._shapeCreateAbort();
            return;
        }
        layer.name = ShapeLayout.TYPE_NAME[layer.shape.type] || '形状';
        this._commitHistory(drag.histSnap, '绘制形状');
        this._draftTouched = true;
        this._scheduleSave();
        this._scheduleThumbRefresh();
        this._renderLayerPanel();   // 名称随类型更新
    },

    /** 干点/打断/关窗取消：摘除从未入账的临时层（层栈/选中/面板回收，
     *  零历史）——MangaStage._cancelDrag 与 hide() 共用 */
    _shapeCreateAbort() {
        const d = this._drag;
        this._drag = null;
        const layer = d && d.layer;
        if (!layer) return;
        const layers = this._ensureDrawLayers();
        const idx = layers.indexOf(layer);
        if (idx >= 0) layers.splice(idx, 1);
        if (this._selLayerId === layer.id) this._selLayerId = null;
        this._renderLayerPanel();
    },

    // ==================== 选项条（标题栏，形状工具激活时显示） ====================

    /** 形状选项条：类型四钮 + 填充色/红斜杠去填充 + 边框色/红斜杠去边框
     *  + 边宽/圆角滑杆（灯箱 StudioDomBuilder 控件同款）。挂标题栏
     *  （.manga-header-right 之前，画笔/文字选项条同位同法——MangaDom 在
     *  _buildTextBar 之后调用） */
    _buildShapeBar() {
        const header = this.dialog && this.dialog.querySelector('.recipe-dialog-header');
        if (!header) return;
        const bar = document.createElement('div');
        bar.className = 'manga-shape-tools';
        bar.hidden = true;
        // 类型四钮（尾巴方位无 UI，固定 'lb'——灯箱同款，气泡尾巴朝左下）
        const glyph = (d) => '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
        const types = [
            ['rect', '矩形', '<rect x="4.5" y="6.5" width="15" height="11"/>'],
            ['round', '圆角矩形', '<rect x="4.5" y="6.5" width="15" height="11" rx="4"/>'],
            ['ellipse', '椭圆', '<ellipse cx="12" cy="12" rx="7.5" ry="5.5"/>'],
            ['bubble', '气泡框', '<path d="M12 5.5c-4.7 0-8.5 2.9-8.5 6.5 0 1.9 1 3.6 2.6 4.7L5 20l3.9-1.7c1 .3 2 .4 3.1.4 4.7 0 8.5-2.9 8.5-6.5S16.7 5.5 12 5.5z"/>']
        ];
        this._shapeTypeBtns = {};
        for (const [key, title, svg] of types) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'manga-shape-type-btn';
            b.title = title;
            b.innerHTML = glyph(svg);
            b.addEventListener('click', () => {
                this._shapeOpts.type = key;
                this._applyShapeOpts();
                this._syncShapeBarDom();
            });
            this._shapeTypeBtns[key] = b;
            bar.appendChild(b);
        }
        // 填充色 + 红斜杠去填充（开关式：去除↔恢复上次值，灯箱同款）
        const fill = document.createElement('input');
        fill.type = 'color';
        fill.className = 'manga-shape-color';
        fill.title = '填充色';
        fill.value = this._shapeOpts.fill === 'none' ? (this._lastShapeFill || '#ffffff') : this._shapeOpts.fill;
        fill.addEventListener('input', () => this._setShapeFillColor(fill.value));
        const noFill = document.createElement('button');
        noFill.type = 'button';
        noFill.className = 'manga-shape-none-btn';
        noFill.title = '无填充（透明，只要边框）';
        noFill.addEventListener('click', () => this._toggleShapeFillNone());
        // 边框色 + 红斜杠去边框
        const stroke = document.createElement('input');
        stroke.type = 'color';
        stroke.className = 'manga-shape-color';
        stroke.title = '边框色';
        stroke.value = this._shapeOpts.strokeColor;
        stroke.addEventListener('input', () => this._setShapeStrokeColor(stroke.value));
        const noStroke = document.createElement('button');
        noStroke.type = 'button';
        noStroke.className = 'manga-shape-none-btn';
        noStroke.title = '无边框';
        noStroke.addEventListener('click', () => this._toggleShapeStrokeNone());
        // 边宽/圆角滑杆（草稿像素；label 复用画笔条的 .manga-brush-width-label）
        const mkSlider = (min, max, title) => {
            const el = document.createElement('input');
            el.type = 'range';
            el.className = 'manga-shape-range';
            el.min = String(min);
            el.max = String(max);
            el.step = '1';
            el.title = title;
            return el;
        };
        const width = mkSlider(0, 60, '边框宽度（草稿像素，0=无边框）');
        width.value = String(this._shapeOpts.strokeWidth);
        width.addEventListener('input', () => {
            this._shapeOpts.strokeWidth = Number(width.value);
            this._applyShapeOpts(false);   // 拖动中轻路径（不重建面板）
        });
        width.addEventListener('change', () => this._applyShapeOpts());
        const radius = mkSlider(0, 120, '圆角（草稿像素，仅矩形类生效）');
        radius.value = String(this._shapeOpts.radius);
        radius.addEventListener('input', () => {
            this._shapeOpts.radius = Number(radius.value);
            this._applyShapeOpts(false);
        });
        radius.addEventListener('change', () => this._applyShapeOpts());
        const wLabel = document.createElement('span');
        wLabel.className = 'manga-brush-width-label';
        wLabel.textContent = '边宽';
        const rLabel = document.createElement('span');
        rLabel.className = 'manga-brush-width-label';
        rLabel.textContent = '圆角';
        bar.append(fill, noFill, stroke, noStroke, wLabel, width, rLabel, radius);
        const right = header.querySelector('.manga-header-right');
        if (right) header.insertBefore(bar, right);
        else header.appendChild(bar);
        this._shapeBarEl = bar;
        this._shapeFillEl = fill;
        this._shapeNoFillEl = noFill;
        this._shapeStrokeEl = stroke;
        this._shapeNoStrokeEl = noStroke;
        this._shapeWidthEl = width;
        this._shapeRadiusEl = radius;
        this._syncShapeBarDom();
    },

    /** 选项条随工具显隐（_setTool→_syncToolRailUi 联动，画笔/文字条同款） */
    _syncShapeBar() {
        if (!this._shapeBarEl) return;
        this._shapeBarEl.hidden = this.activeTool !== 'shape';
        if (!this._shapeBarEl.hidden) this._syncShapeBarDom();
    },

    /** 选项条 DOM 与 _shapeOpts 对表（类型高亮/色块值/红斜杠激活态/滑杆值） */
    _syncShapeBarDom() {
        if (!this._shapeBarEl) return;
        for (const [key, btn] of Object.entries(this._shapeTypeBtns || {})) {
            btn.classList.toggle('is-active', this._shapeOpts.type === key);
        }
        if (this._shapeFillEl) {
            this._shapeFillEl.value = this._shapeOpts.fill === 'none'
                ? (this._lastShapeFill || '#ffffff') : this._shapeOpts.fill;
        }
        if (this._shapeStrokeEl) this._shapeStrokeEl.value = this._shapeOpts.strokeColor;
        if (this._shapeNoFillEl) {
            this._shapeNoFillEl.classList.toggle('is-active', this._shapeOpts.fill === 'none');
        }
        if (this._shapeNoStrokeEl) {
            this._shapeNoStrokeEl.classList.toggle('is-active',
                !(Number(this._shapeOpts.strokeWidth) > 0));
        }
        if (this._shapeWidthEl) this._shapeWidthEl.value = String(this._shapeOpts.strokeWidth);
        if (this._shapeRadiusEl) this._shapeRadiusEl.value = String(this._shapeOpts.radius);
    },

    // ==================== 选项实时应用（灯箱 applyOpts 同语义） ====================

    /** 选项作用目标：当前选中的形状层（未选中时改动只更新 _shapeOpts
     *  作为下次绘制的默认值） */
    _shapeTargetLayer() {
        const sel = this._selLayerId != null ? this._layerById(this._selLayerId) : null;
        return sel && sel.shape ? sel : null;
    },

    /** 选项改动 → 选中形状层重绘（未选中则只影响默认值）。full=false =
     *  滑杆拖动中的轻路径（不重建面板，松手 change 再全量） */
    _applyShapeOpts(full = true) {
        const layer = this._shapeTargetLayer();
        if (layer) {
            Object.assign(layer.shape, {
                type: this._shapeOpts.type, fill: this._shapeOpts.fill,
                strokeColor: this._shapeOpts.strokeColor,
                strokeWidth: this._shapeOpts.strokeWidth,
                radius: this._shapeOpts.radius, tail: this._shapeOpts.tail
            });
            this._draftTouched = true;
            this._scheduleSave();
            this._scheduleThumbRefresh();
        }
        this._renderStage();
        if (full) this._renderLayerPanel();
    },

    /** 选中已有形状层时反向同步：图层属性 → _shapeOpts → 选项条 DOM
     *  （防止选项条默认值覆盖选中层的既有属性，灯箱同款） */
    _syncShapeOptsFromLayer(layer) {
        if (!layer || !layer.shape) return;
        Object.assign(this._shapeOpts, layer.shape);
        if (this._shapeOpts.fill !== 'none') this._lastShapeFill = this._shapeOpts.fill;
        if (Number(this._shapeOpts.strokeWidth) > 0) {
            this._lastShapeStrokeWidth = this._shapeOpts.strokeWidth;
        }
        this._syncShapeBarDom();
    },

    /** 填充色写入（色板 setColor 按工具分发到此，ADR 068 扩一档）：记忆 +
     *  默认值 + 选中层实时生效 */
    _setShapeFillColor(c) {
        this._fillColor = c;
        try { localStorage.setItem('lumenLight.mangaShapeFillColor', c); } catch { /* 隐私模式等 */ }
        this._shapeOpts.fill = c;
        this._lastShapeFill = c;
        this._applyShapeOpts();
        this._syncShapeBarDom();
    },

    /** 边框色写入（选项条原生色块，不走色板） */
    _setShapeStrokeColor(c) {
        this._strokeColor = c;
        try { localStorage.setItem('lumenLight.mangaShapeStrokeColor', c); } catch { /* 隐私模式等 */ }
        this._shapeOpts.strokeColor = c;
        this._applyShapeOpts();
        this._syncShapeBarDom();
    },

    /** 红斜杠去填充（开关式）：去除↔恢复上次值（灯箱 is-none-swatch 同款） */
    _toggleShapeFillNone() {
        const o = this._shapeOpts;
        if (o.fill === 'none') {
            o.fill = this._lastShapeFill || '#ffffff';
        } else {
            this._lastShapeFill = o.fill;
            o.fill = 'none';
        }
        this._applyShapeOpts();
        this._syncShapeBarDom();
    },

    /** 红斜杠去边框（开关式）：边宽 0↔恢复上次值 */
    _toggleShapeStrokeNone() {
        const o = this._shapeOpts;
        if (Number(o.strokeWidth) > 0) {
            this._lastShapeStrokeWidth = o.strokeWidth;
            o.strokeWidth = 0;
        } else {
            o.strokeWidth = this._lastShapeStrokeWidth || 6;
        }
        this._applyShapeOpts();
        this._syncShapeBarDom();
    },

    // ==================== 形状渲染（舞台/缩略图共用原语） ====================
    // 几何算法在共享层 js/utils/ShapeLayout.js（ADR 069），本节只留一行
    // 委托——MangaLayers._drawPageLayers/_paintLayerThumb、
    // MangaPages._drawPageThumb 与测试都经原型方法调用，签名保持不变

    /** 形状内容绘制（调用方已设好 transform，草稿像素坐标系）——委托 ShapeLayout */
    _drawShapeContent(g, s, x, y, w, h) {
        return ShapeLayout.drawShapeContent(g, s, x, y, w, h);
    },

    /** 舞台绘制（_drawPageLayers 形状分支调用）：草稿坐标 → 舞台变换后
     *  按属性现画（无离屏——解析图形渲染零成本，矢量永远锐利） */
    _drawShapeLayer(ctx, layer, X, Y, scale) {
        const s = layer.shape;
        ctx.save();
        ctx.translate(X(layer.x), Y(layer.y));
        ctx.scale(scale, scale);
        this._drawShapeContent(ctx, s, 0, 0, s.w, s.h);
        ctx.restore();
    },
});
