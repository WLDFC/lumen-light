/**
 * ==========================================================================
 * ImageStudio 子模块：图层栈 DOM 与图层面板 UI（自 ImageStudio.js 拆出）
 * 作用：图层的增删与增量 DOM 操作、图层面板渲染（拖放排序/眼睛开关/
 *       透明度与蒙版/粗细滑块联动/右键菜单）。
 * 契约：构造时传入宿主 ImageStudio 实例并读写其字段与方法（studio.xxx）；
 *       主类保留同名薄代理，内部/外部调用点零改动。
 * 说明：_activeLayer/_stackIndex/_createLayerCanvas 属核心状态访问器，
 *       留在主类；本模块只做 DOM 与面板行为。
 * ==========================================================================
 */

class StudioLayerPanel {
    /** @param {Object} studio - 宿主 ImageStudio 实例 */
    constructor(studio) {
        this.studio = studio;
    }

    /** 新建图层：插入到激活图层上方（PS 同语义）并激活。
     *  只把新画布插进 DOM（增量插入，不全量重建——大画布重挂会卡）。
     *  opts 可传 w/h 指定图层画布尺寸（置入图片用内容尺寸） */
    addLayer(opts = {}) {
        const studio = this.studio;
        studio._layerSeq += 1;
        const layer = studio._createLayerCanvas(`图层 ${studio._layerSeq}`, opts);
        const idx = studio._stackIndex();
        studio.layers.splice(idx + 1, 0, layer);
        // DOM 锚点 = 栈上位图层的 paint 画布（无则绘制面）
        const anchor = studio.layers[idx + 2] ? studio.layers[idx + 2].paintCv : studio.paintSurface;
        studio.wrapEl.insertBefore(layer.paintCv, anchor);
        studio.wrapEl.insertBefore(layer.maskCv, anchor);
        this._applyLayerStyles(layer);
        studio._positionLayerCanvases(layer);
        this._setActive(layer.id);
        studio._pushHistory('新建图层');
    }

    /** 新建文字图层（文字工具点击画布时调用）：插入到激活图层上方并激活，
     *  文字属性取自当前顶栏选项（字体/字号/横竖排）与色板颜色；
     *  内容暂空，由 StudioTextTool 编辑态填充后渲染 */
    addTextLayer(pos) {
        const studio = this.studio;
        studio._layerSeq += 1;
        const layer = studio._createLayerCanvas(`文字 ${studio._layerSeq}`, { w: 1, h: 1 });
        layer.isText = true;
        layer.text = {
            content: '',
            font: studio.textOpts.font,
            size: studio.textOpts.size,
            vertical: studio.textOpts.vertical,
            color: studio.color
        };
        layer.tx = pos.x;
        layer.ty = pos.y;
        const idx = studio._stackIndex();
        studio.layers.splice(idx + 1, 0, layer);
        const anchor = studio.layers[idx + 2] ? studio.layers[idx + 2].paintCv : studio.paintSurface;
        studio.wrapEl.insertBefore(layer.paintCv, anchor);
        studio.wrapEl.insertBefore(layer.maskCv, anchor);
        this._applyLayerStyles(layer);
        studio._positionLayerCanvases(layer);
        this._setActive(layer.id);
        return layer;
    }

    /** 新建形状图层（形状工具按下画布时调用）：插入到激活图层上方并激活，
     *  形状属性取自当前顶栏选项（类型/填充/描边/描边宽/圆角/尾巴方位）；
     *  尺寸暂为最小值，由 StudioShapeTool 拖拽中更新并重渲染 */
    addShapeLayer(pos) {
        const studio = this.studio;
        studio._layerSeq += 1;
        const layer = studio._createLayerCanvas(`形状 ${studio._layerSeq}`, { w: 1, h: 1 });
        layer.isShape = true;
        layer.shape = {
            type: studio.shapeOpts.type,
            w: 2, h: 2,
            fill: studio.shapeOpts.fill,
            strokeColor: studio.shapeOpts.strokeColor,
            strokeWidth: studio.shapeOpts.strokeWidth,
            radius: studio.shapeOpts.radius,
            tail: studio.shapeOpts.tail
        };
        layer.tx = pos.x;
        layer.ty = pos.y;
        const idx = studio._stackIndex();
        studio.layers.splice(idx + 1, 0, layer);
        const anchor = studio.layers[idx + 2] ? studio.layers[idx + 2].paintCv : studio.paintSurface;
        studio.wrapEl.insertBefore(layer.paintCv, anchor);
        studio.wrapEl.insertBefore(layer.maskCv, anchor);
        this._applyLayerStyles(layer);
        studio._positionLayerCanvases(layer);
        this._setActive(layer.id);
        return layer;
    }

    /** 删除激活图层（背景层不可删；图片层有背景层垫底后同样可删——
     *  删掉即文档失去照片内容，保存时底片只剩背景）。只移除该层画布，
     *  不全量重建 */
    deleteActiveLayer() {
        const studio = this.studio;
        const layer = studio._activeLayer();
        if (!layer || layer.isBackground) return;
        const idx = studio._stackIndex();
        layer.paintCv.remove();
        layer.maskCv.remove();
        studio.layers.splice(idx, 1);
        studio.activeLayerId = studio.layers[Math.min(idx, studio.layers.length - 1)].id;
        // 图层结构变化：必须置 layers 脏标记驱动保存时重新序列化
        // studioLayers——不置的话只删未涂，保存会跳过序列化，重开编辑
        // 时按旧 studioLayers 重建，被删图层"复活"
        studio.dirty.layers = true;
        this._renderLayerList();
        this._syncPanels();
        studio._drawSelOverlay();
        studio._pushHistory('删除图层');
    }

    /** 复制激活图层：内容/遮罩/变换/透明度/文字属性整体克隆，副本为
     *  普通图层（不继承背景/图片层身份——底片烘焙只认原层，副本混进
     *  底片会双份叠加），插到原层上方并激活（PS 同语义，名加「副本」）。
     *  背景层也可复制（副本即白底普通层） */
    duplicateActiveLayer() {
        const studio = this.studio;
        const src = studio._activeLayer();
        if (!src) return;
        const idx = studio._stackIndex();
        const copy = studio._createLayerCanvas(`${src.name} 副本`,
            { w: src.paintCv.width, h: src.paintCv.height });
        copy.paintCv.getContext('2d').drawImage(src.paintCv, 0, 0);
        copy.maskCv.getContext('2d').drawImage(src.maskCv, 0, 0);
        copy.visible = src.visible;
        copy.opacity = src.opacity;
        copy.tx = src.tx;
        copy.ty = src.ty;
        copy.tscale = src.tscale;
        copy.flipX = src.flipX;
        copy.empty = src.empty;
        if (src.isText) {
            copy.isText = true;
            copy.text = { ...src.text };
            studio._text._render(copy);
        }
        if (src.isShape) {
            copy.isShape = true;
            copy.shape = { ...src.shape };
            // 外伸快照随层复制：_render 以「tx + 外伸 = 包围盒」反推锚点，
            // 不带快照会把副本包围盒算错（向左上漂移一个外伸量）
            copy._shapeExt = src._shapeExt ? { ...src._shapeExt } : null;
            studio._shape._render(copy);
        }
        studio.layers.splice(idx + 1, 0, copy);
        // DOM 锚点 = 栈上原层上方一层的 paint 画布（无则绘制面）
        const anchor = studio.layers[idx + 2]
            ? studio.layers[idx + 2].paintCv : studio.paintSurface;
        studio.wrapEl.insertBefore(copy.paintCv, anchor);
        studio.wrapEl.insertBefore(copy.maskCv, anchor);
        this._applyLayerStyles(copy);
        studio._positionLayerCanvases(copy);
        // 图层结构变化：置脏驱动保存时重新序列化 studioLayers
        studio.dirty.layers = true;
        this._setActive(copy.id);
        studio._pushHistory('复制图层');
    }

    /**
     * 全量重建图层画布 DOM（栈序自下而上），仅打开时调用；
     * 增删/排序走增量 DOM 操作（大画布重挂引发重合成会卡顿）
     */
    _rebuildLayerDom() {
        const studio = this.studio;
        studio.wrapEl.innerHTML = '';
        for (const layer of studio.layers) {
            studio.wrapEl.append(layer.paintCv, layer.maskCv);
            this._applyLayerStyles(layer);
        }
        // 顺序：图层画布 → 绘制面（输入）→ 裁剪覆盖层（选中框在舞台上）
        studio.wrapEl.append(studio.paintSurface, studio.cropCanvas);
    }

    /** 同步单块图层的显示样式（可见性 / 透明度；定位在 _applyTransform） */
    _applyLayerStyles(layer) {
        const studio = this.studio;
        const display = layer.visible ? '' : 'none';
        // 左右翻转：画布元素按中心轴水平镜像（盒子尺寸不变，选中框/命中
        // 矩形仍是轴对齐矩形，无需换算）。形状层除外——它由 _render 按
        // 镜像后的尾巴方位重渲染（外伸不对称，叠加 CSS 镜像会偏移/裁切）
        const flip = (layer.flipX && !layer.isShape) ? 'scaleX(-1)' : '';
        layer.paintCv.style.display = display;
        layer.paintCv.style.opacity = layer.opacity;
        layer.paintCv.style.transform = flip;
        layer.maskCv.style.display = display;
        layer.maskCv.style.opacity = layer.opacity * ImageStudio.MASK_DISPLAY_OPACITY;
        layer.maskCv.style.transform = flip;
    }

    // ==================== 图层面板 UI ====================

    /** 画单层缩略图：paintCv 等比 contain 进小画布（居中），透明区域
     *  露出 CSS 棋盘格。只取内容不乘变换（PS 同语义：缩略图反映图层
     *  内容，不反映摆放位置）；drawImage 走 GPU 路径，落笔后刷一行
     *  无感知，绝不用 toDataURL（历史面板那种全量序列化会卡） */
    _drawThumb(layer) {
        const thumb = layer._thumbEl;
        if (!thumb) return;
        const g = thumb.getContext('2d');
        g.clearRect(0, 0, thumb.width, thumb.height);
        const cv = layer.paintCv;
        if (!cv.width || !cv.height) return;
        const s = Math.min(thumb.width / cv.width, thumb.height / cv.height);
        g.imageSmoothingQuality = 'high';
        // 翻转态：缩略图同步水平镜像（内容居中，按缩略图宽镜像即可）。
        // 形状层的镜像已烘焙进画布，再镜像会翻回去
        const mirrorThumb = layer.flipX && !layer.isShape;
        if (mirrorThumb) {
            g.save();
            g.translate(thumb.width, 0);
            g.scale(-1, 1);
        }
        g.drawImage(cv, (thumb.width - cv.width * s) / 2, (thumb.height - cv.height * s) / 2,
            cv.width * s, cv.height * s);
        if (mirrorThumb) g.restore();
    }

    /** 落笔后增量刷新单行缩略图（_onPaintUp 调用；文字层无缩略图） */
    refreshThumb(layer) {
        if (!layer || layer.isText) return;
        this._drawThumb(layer);
    }

    /** 重建图层列表 DOM（栈顶在前，PS 同序；原图层在最底、不可拖不可删）。
     *  行结构：类型视觉 + 名字 + 眼睛（背景层另有锁标）——
     *  类型视觉为 PS 同款混合式：像素层=实时缩略图（棋盘格垫透明，
     *  只反映内容不反映变换），文字层=T 徽标（按文字颜色着色；像素
     *  是属性派生物，缩略图会有同步负担，徽标则零维护且与"像素工具
     *  拒涂文字层"同一语义），空图层=纯棋盘格（本身就是有效信息） */
    _renderLayerList() {
        const studio = this.studio;
        studio.layerListEl.innerHTML = '';
        const makeRow = (layer) => {
            const row = document.createElement('div');
            row.className = 'is-layer-row' + (layer.id === studio.activeLayerId ? ' active' : '')
                + (studio._maskMode && layer.id === studio.activeLayerId ? ' masking' : '');
            row.dataset.layerId = layer.id;
            // 类型视觉：像素层缩略图（56px 背衬 = 28px 显示的 2x，高分屏清晰）；
            // _thumbEl 挂在图层对象上供落笔后增量刷新（历史恢复会重建
            // 图层对象，随列表重建自然换新，无需清理）
            let typeEl;
            if (layer.isText) {
                typeEl = document.createElement('span');
                typeEl.className = 'is-layer-type-t';
                typeEl.textContent = 'T';
                typeEl.title = '文字图层（像素工具不可涂抹；改字回文字工具）';
            } else if (layer.isShape) {
                typeEl = document.createElement('span');
                typeEl.className = 'is-layer-type-s';
                typeEl.textContent = '▢';
                typeEl.title = '形状图层（像素工具不可涂抹；改属性回形状工具）';
            } else {
                typeEl = document.createElement('canvas');
                typeEl.className = 'is-layer-thumb';
                typeEl.width = 56;
                typeEl.height = 56;
                layer._thumbEl = typeEl;
                this._drawThumb(layer);
            }
            const nameEl = document.createElement('span');
            nameEl.className = 'is-layer-name';
            nameEl.textContent = layer.name;
            const eye = document.createElement('button');
            eye.className = 'is-layer-eye' + (layer.visible ? '' : ' hidden-layer');
            eye.title = '显示 / 隐藏';
            eye.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
                eye.addEventListener('click', (e) => {
                    e.stopPropagation();
                    layer.visible = !layer.visible;
                    // 显隐影响拍平结果与图层栈序列化
                    studio.dirty.layers = true;
                    this._applyLayerStyles(layer);
                    this._renderLayerList();
                    studio._pushHistory('显隐图层');
                });
            row.append(typeEl, nameEl);
            if (layer.isBackground) {
                // 背景层锁标：锁变换/不可拖拽排序/不可删——约束前置可见，
                // 不用等右键或 Delete 时才发现
                const lock = document.createElement('span');
                lock.className = 'is-layer-lock';
                lock.title = '背景层：锁变换（不可移动缩放/排序/删除）';
                lock.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;
                row.append(lock);
            }
            row.append(eye);
            if (!layer.isBackground) {
                // PS 式指针拖拽排序：不依赖 HTML5 DnD（原生拖拽受浏览器
                // 与扩展环境影响大——空拖影中止、拖影被吞、drop 不触发），
                // pointerdown 抓取、移动高亮落点、松手落位，见 _onRowPointerDown。
                // 图片层（图层 0）同样可拖——有背景层垫底后它就是普通图层，
                // 只是仍不可删除（文档底片的组成部分）
                row.addEventListener('pointerdown', (e) => this._onRowPointerDown(e, layer, row));
                row.addEventListener('click', () => this._setActive(layer.id));
            } else {
                // 背景层：可选中涂画，但锁变换、不可拖拽排序、不可删
                row.classList.add('is-base-row');
                row.addEventListener('click', () => this._setActive(layer.id));
            }
            return row;
        };
        // 栈顶在前
        for (let i = studio.layers.length - 1; i >= 0; i--) {
            studio.layerListEl.appendChild(makeRow(studio.layers[i]));
        }
    }

    // ---- 图层拖动排序（指针拖拽 + 插入指示条，原图层固定在最底） ----

    /**
     * 行上按下：抓取潜在拖拽。pointerdown 时不立即判定——移动超过
     * 阈值才进入拖拽；未超阈值的按下-松手仍是普通点击（click 照常选层）。
     * 拖拽中其他行绝对不动：只有蓝色插入条（落点行的上/下缘）随指针
     * 移动，松手那一刻才真正改变顺序。
     * 完全自管 Pointer Events：不经浏览器拖拽控制器，跨环境行为一致。
     * pointerdown preventDefault 顺带压掉文本选区（拖名字不会选中文字）
     */
    _onRowPointerDown(e, layer, row) {
        if (e.button !== 0 || e.target.closest('button')) return;
        const studio = this.studio;
        const startX = e.clientX, startY = e.clientY;
        const DRAG_THRESHOLD = 5;   // 屏幕像素：超过才算拖拽，否则是点击
        let active = false;
        let targetRow = null, below = false;
        e.preventDefault();
        try { row.setPointerCapture(e.pointerId); } catch { /* 已释放则忽略 */ }

        const clearIndicators = () => {
            studio.layerListEl.querySelectorAll('.is-layer-row')
                .forEach((r) => r.classList.remove('drop-above', 'drop-below'));
        };
        const onMove = (ev) => {
            if (!active) {
                if (Math.abs(ev.clientX - startX) < DRAG_THRESHOLD
                    && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
                active = true;
                row.classList.add('dragging');
            }
            clearIndicators();
            // 命中检测用 elementFromPoint：落点可以是任何行（含不可拖的
            // 背景层行——它们只是插入位置的参照）
            targetRow = document.elementFromPoint(ev.clientX, ev.clientY)
                ?.closest('.is-layer-row') || null;
            if (!targetRow || targetRow === row) { targetRow = null; return; }
            const rect = targetRow.getBoundingClientRect();
            below = ev.clientY > rect.top + rect.height / 2;
            targetRow.classList.add(below ? 'drop-below' : 'drop-above');
        };
        const finish = (ev) => {
            row.removeEventListener('pointermove', onMove);
            row.removeEventListener('pointerup', finish);
            row.removeEventListener('pointercancel', finish);
            try { row.releasePointerCapture(ev.pointerId); } catch { /* 已释放 */ }
            clearIndicators();
            row.classList.remove('dragging');
            if (active && targetRow) this._reorderLayer(layer, targetRow, below);
        };
        row.addEventListener('pointermove', onMove);
        row.addEventListener('pointerup', finish);
        row.addEventListener('pointercancel', finish);
    }

    /** 落位：把 layer 插到目标行指示的位置（below=视觉上目标层之下）。
     *  layers 数组自下而上存（0=背景），面板显示是它的倒序——下半区
     *  = 数组插入点即目标原索引（把目标顶上去），上半区 = 目标索引+1 */
    _reorderLayer(layer, targetRow, below) {
        const studio = this.studio;
        const targetLayer = studio.layers
            .find((l) => l.id === targetRow.dataset.layerId);
        if (!targetLayer || targetLayer.id === layer.id) return;
        const from = studio.layers.indexOf(layer);
        let to = studio.layers.indexOf(targetLayer) + (below ? 0 : 1);
        // 摘除自身后插入点左移一格（摘除点在插入点之上时）
        if (from < to) to -= 1;
        to = Math.max(1, Math.min(studio.layers.length, to));   // 背景(0)恒定在最底
        if (to === from) return;
        // FLIP 动画起点：重排前按 layerId 记下各行旧位置
        const oldTops = new Map();
        studio.layerListEl.querySelectorAll('.is-layer-row').forEach((r) => {
            oldTops.set(r.dataset.layerId, r.getBoundingClientRect().top);
        });
        studio.layers.splice(from, 1);
        studio.layers.splice(to, 0, layer);
        this._moveLayerCanvases(layer, to);
        // 叠放序变化：重算笔迹拍平与遮罩并集，并重新序列化图层栈
        studio.dirty.strokes = true;
        studio.dirty.mask = true;
        studio.dirty.layers = true;
        this._renderLayerList();
        // FLIP 落位动画：重排后各行从旧位置平滑滑到新位置（只此一处，
        // 拖拽过程中行依旧纹丝不动）；未移动的行不参与
        studio.layerListEl.querySelectorAll('.is-layer-row').forEach((r) => {
            const oldTop = oldTops.get(r.dataset.layerId);
            if (oldTop == null) return;
            const delta = oldTop - r.getBoundingClientRect().top;
            if (Math.abs(delta) < 1) return;
            r.style.transition = 'none';
            r.style.transform = `translateY(${delta}px)`;
            void r.offsetHeight;   // 强制回流，起始状态生效后再放开过渡
            r.style.transition = 'transform 0.18s ease';
            r.style.transform = '';
            setTimeout(() => { r.style.transition = ''; r.style.transform = ''; }, 220);
        });
        this._syncPanels();
        studio._drawSelOverlay();
        studio._pushHistory('调整图层顺序');
    }

    /** 把移动图层的两块画布插到栈中新位置（增量 DOM，不全量重建） */
    _moveLayerCanvases(layer, to) {
        const studio = this.studio;
        layer.paintCv.remove();
        layer.maskCv.remove();
        const anchor = studio.layers[to + 1] ? studio.layers[to + 1].paintCv : studio.paintSurface;
        studio.wrapEl.insertBefore(layer.paintCv, anchor);
        studio.wrapEl.insertBefore(layer.maskCv, anchor);
    }

    _setActive(id) {
        const studio = this.studio;
        studio.activeLayerId = id;
        this._renderLayerList();
        this._syncPanels();
        studio._updateCursor();
        // 选中状态变化同步选中框（面板点选 = 选中该图层，移动工具下
        // 立即显示其变换框；非移动工具下重绘为空、无副作用）
        studio._drawSelOverlay();
    }

    /** 同步蒙版开关高亮 / 色板 / 透明度滑块 / 粗细滑块的联动状态 */
    _syncPanels() {
        const studio = this.studio;
        studio.maskBtn.classList.toggle('active', !!studio._maskMode);
        // 快速蒙版模式下色板无意义（遮罩只有全强度红一种语义）
        studio.paletteEl.classList.toggle('disabled', !!studio._maskMode);
        // 遮罩层高亮：遮罩模式下激活图层行 = 当前遮罩涂画目标，用 PS 式
        // 暗红底标出。行 DOM 未必重建（开关遮罩/切激活层都只走这里），
        // 按 dataset.layerId 兜底切换，不等下一次 _renderLayerList
        studio.layerListEl.querySelectorAll('.is-layer-row').forEach((row) => {
            row.classList.toggle('masking',
                !!studio._maskMode && row.dataset.layerId === studio.activeLayerId);
        });
        const layer = studio._activeLayer();
        const opacityPct = Math.round((layer ? layer.opacity : 1) * 100);
        studio.opacitySlider.value = opacityPct;
        studio.opacityValueEl.textContent = opacityPct;
        const size = studio.sizes[studio._maskMode ? 'mask' : 'strokes'];
        studio.sizeSlider.value = size;
        studio.sizeValueEl.textContent = size;
        // 删除项守卫：激活层是背景层（不可删）时禁用
        studio.deleteItemEl.classList.toggle('disabled',
            !layer || layer.isBackground);
        // 顶栏翻转按钮：无选中层 / 背景层（锁定白底）时禁用
        if (studio.flipBtn) {
            const canFlip = !!layer && !layer.isBackground;
            studio.flipBtn.disabled = !canFlip;
            studio.flipBtn.classList.toggle('on', canFlip && !!layer.flipX);
        }
        // 顶栏旋转按钮：同翻转按钮的禁用条件（无 .on 态——旋转不可再点回）
        if (studio.rotateBtn) {
            studio.rotateBtn.disabled = !layer || layer.isBackground;
        }
        // 左栏调色按钮：无选中层 / 背景层 / 空图层时禁用（没有可调的像素）
        if (studio.adjustBtn) {
            studio.adjustBtn.disabled =
                !layer || layer.isBackground || layer.empty;
        }
        // 左栏抠图按钮：同调色按钮的禁用条件，另排除文字/形状层
        // （属性驱动层像素会被下次重渲染覆盖，抠了也白抠）
        if (studio.rembgBtn) {
            studio.rembgBtn.disabled =
                !layer || layer.isBackground || layer.empty
                || layer.isText || layer.isShape;
        }
    }

    /** 图层右键菜单定位显示 */
    _showLayerMenu(x, y) {
        const studio = this.studio;
        studio.layerMenuEl.hidden = false;
        const rect = studio.layerMenuEl.getBoundingClientRect();
        studio.layerMenuEl.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
        studio.layerMenuEl.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
        this._syncPanels();
    }
}

// 暴露到全局作用域（经典 script，ImageStudio.js 之后实例化时消费）
window.StudioLayerPanel = StudioLayerPanel;
