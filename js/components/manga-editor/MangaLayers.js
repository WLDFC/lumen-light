/**
 * ==========================================================================
 * MangaEditor 子模块：页面图层系统（PS 式；ADR 073 渲染拆出至
 * MangaPageRender.js、面板 UI 拆出至 MangaLayerPanel.js）
 * ==========================================================================
 * 作用：draft.drawLayers 页面层栈模型（底→顶数组序）——层栈 CRUD/
 *   复制/排序/不透明度与图片层放置命中，笔迹、图片、文字、形状都是图层：
 *   - 笔迹层 { id, name, visible, strokes:[{color,width,points}...] }：
 *     画笔工具的目标（MangaTools._brush* 写活动层，本混入供给活动层）；
 *   - 图片层 { id, name, visible, image:{ src, bbox:[x1,y1,x2,y2] } }：
 *     置入本地图（/api/assets 内容寻址入库，草稿只存引用防 JSON 膨胀），
 *     舞台可选中/拖动/八向锚点缩放（手势分流在 MangaGestures），适配
 *     画幅居中落位、磁吸只对画幅目标；
 *   - 文字层 { id, name, visible, text:{content,font,size,vertical,color,
 *     x,y,scale} }（2026-11-05 自灯箱 StudioTextTool 复刻，MangaText 混入）：
 *     文字工具创建/就地编辑，包围盒由属性测量现算（_layerBounds 统一
 *     取几何），同样可选中/拖动/等比缩放；渲染分支在 MangaPageRender、
 *     缩略图在 MangaLayerPanel（形态分派按字段存在性：image / strokes /
 *     text / shape）
 *   - 面板（右栏「图层」分区）在 MangaLayerPanel：顶→底层栈行 + 不透明
 *     度滑块 + 新建/置入；排序走 PS 式指针拖拽（2026-11-04 替代上移/
 *     下移按钮）；
 *   - 2026-11-04 自灯箱补齐：复制图层（任意形态整体深克隆，副本插本层
 *     上方并接管当前层）、逐层不透明度（layer.opacity，舞台/缩略图渲染
 *     同口径）。层形态通用化：复制/排序/不透明度对任意 JSON 形态的层
 *     生效；
 *   - 背景参考图不并入（标题栏背景工具独立，用户拍板）；元素框不并入
 *     （结构化数据恒在图层之上，元素框图层管理在左侧卡片）。
 * 契约：原型混入（partial-class，ADR 026）——方法 Object.assign 进
 *       MangaEditor.prototype，this 即编辑器实例；须后于主类加载。
 *       旧平铺 draft.strokes 两处自动迁移：磁盘恢复在 MangaDraftStore
 *       ._normalizeDocument，会话内懒迁移在 _ensureDrawLayers。
 * ==========================================================================
 */

Object.assign(window.MangaEditor.prototype, {

    // ==================== 层栈模型 ====================

    /**
     * 取页面层栈（懒建）：无 drawLayers 时创建空栈，并把旧平铺
     * draft.strokes（本会话内尚未走磁盘迁移的）包成单个笔迹图层垫底。
     * 顺带补盖 fromSrc 基线（2026-11-05 修复前创建的图片层没有溯源戳
     * ——写回画布的「src 是否被换过」判定依赖它，缺戳层在此按当前
     * src 补齐，此后的烘焙/抠图改动即可被检测）
     */
    _ensureDrawLayers() {
        const d = this.draft;
        if (!Array.isArray(d.drawLayers)) {
            d.drawLayers = [];
            if (Array.isArray(d.strokes) && d.strokes.length) {
                d.drawLayers.push({ id: this._allocLayerId(), name: '图层 1', visible: true, strokes: d.strokes });
            }
            delete d.strokes;
        }
        for (const l of d.drawLayers) {
            if (l && l.image && l.image.src && !l.image.fromSrc) l.image.fromSrc = l.image.src;
        }
        return d.drawLayers;
    },

    /** 分配层 id（扫描既有 id 防碰撞——恢复/迁移后计数器不必回填） */
    _allocLayerId() {
        const used = new Set();
        for (const l of (this.draft.drawLayers || [])) {
            if (l && Number.isInteger(l.id)) used.add(l.id);
        }
        let id = this._nextLayerId || 1;
        while (used.has(id)) id++;
        this._nextLayerId = id + 1;
        return id;
    },

    _layerById(id) {
        return (this.draft.drawLayers || []).find((l) => l && l.id === id) || null;
    },

    /**
     * 默认选中（灯箱同语义，2026-11-07 用户拍板）：载入/切页后无选中时
     * 自动选最顶可见图片层——调色/抠图开箱即用，不必先手点一次层。已有
     * 有效选中不动；页内没有图片层则保持无选中（调色/抠图的"先选层"
     * 提示仍适用）。防御式取字段——vm 测试实例可能只有 draft
     */
    _ensureDefaultLayerSelection() {
        if (this._selLayerId != null && this._layerById(this._selLayerId)) return;
        const layers = Array.isArray(this.draft.drawLayers) ? this.draft.drawLayers : [];
        for (let i = layers.length - 1; i >= 0; i--) {
            const l = layers[i];
            if (l && l.image && l.image.src && l.visible !== false) {
                this._selLayerId = l.id;
                this._clearElementSelection();   // 选中互斥：元素框让位
                if (typeof this._syncLayerPanelUi === 'function') this._syncLayerPanelUi();
                return;
            }
        }
    },

    /** 画笔目标层：活动笔迹层（排除图片层——图片层可落笔但不是笔迹层，
     *  2026-11-05 起图片层也带 strokes 数组），失效（隐藏/已删）回落最顶
     *  可见纯笔迹层 */
    _activeStrokeLayer() {
        const layers = this._ensureDrawLayers();
        const active = layers.find((l) =>
            l.id === this._activeLayerId && !l.image && l.strokes && l.visible !== false);
        if (active) return active;
        for (let i = layers.length - 1; i >= 0; i--) {
            const l = layers[i];
            if (!l.image && l.strokes && l.visible !== false) return l;
        }
        return null;
    },

    /** 新建笔迹层：落在活动层之上（无活动层垫顶）；silent=画笔自动建不单独入账 */
    _addStrokeLayer(silent) {
        const layers = this._ensureDrawLayers();
        const before = silent ? null : this._histSnapshot();
        const id = this._allocLayerId();
        const layer = { id, name: `图层 ${id}`, visible: true, strokes: [] };
        const at = layers.findIndex((l) => l.id === this._activeLayerId);
        layers.splice(at >= 0 ? at + 1 : layers.length, 0, layer);
        this._activeLayerId = layer.id;
        // 图片层选中态让位（2026-11-05 用户实测评测：点「新建图层」就是要
        // 在新层上画——不放开的话 _brushStart 的选中图片层优先会把笔迹
        // 塞进图片层，用户以为画在新层）
        this._selLayerId = null;
        if (before) {
            this._commitHistory(before, '新建图层');
            this._draftTouched = true;
            this._scheduleSave();
            this._renderLayerPanel();
            if (this.visible) this._renderStage();   // 图片层选中框即时让位
        }
        return layer;
    },

    _deleteLayer(id) {
        const layers = this._ensureDrawLayers();
        const before = this._histSnapshot();
        const idx = layers.findIndex((l) => l && l.id === id);
        if (idx < 0) return;
        layers.splice(idx, 1);
        if (this._activeLayerId === id) this._activeLayerId = null;
        if (this._selLayerId === id) this._selLayerId = null;
        this._commitHistory(before, '删除图层');
        this._draftTouched = true;
        this._scheduleSave();
        this._scheduleThumbRefresh();
        this._renderStage();
        this._renderLayerPanel();
    },

    /** 显隐切换：文档态（随草稿持久化、进历史），非视图态 */
    _toggleLayerVisible(id) {
        const layer = this._layerById(id);
        if (!layer) return;
        const before = this._histSnapshot();
        layer.visible = layer.visible === false;
        this._commitHistory(before, '图层显隐');
        this._draftTouched = true;
        this._scheduleSave();
        this._scheduleThumbRefresh();
        this._renderStage();
        this._renderLayerPanel();
    },

    /**
     * 复制图层（2026-11-04 自灯箱迁移）：任意形态整体深克隆——笔迹层
     * 连笔迹、图片层连引用（同 src 共享 _layerImgCache 零开销）、文字层
     * 连文字属性。副本插原图层上方（PS 同语义，数组底→顶存故为 idx+1），
     * 并按形态接管当前层（笔迹层=活动、图片/文字层=选中）。入历史可撤销
     */
    _duplicateLayer(id) {
        const layers = this._ensureDrawLayers();
        const idx = layers.findIndex((l) => l && l.id === id);
        if (idx < 0) return;
        const src = layers[idx];
        const before = this._histSnapshot();
        const copy = JSON.parse(JSON.stringify(src));
        copy.id = this._allocLayerId();
        copy.name = `${src.name || (src.image ? '图片' : src.text ? '文字' : src.shape ? '形状' : '图层')} 副本`;
        layers.splice(idx + 1, 0, copy);
        if (copy.image || copy.text || copy.shape) {
            this._selLayerId = copy.id;
            this._clearElementSelection();
        } else {
            this._activeLayerId = copy.id;
        }
        this._commitHistory(before, '复制图层');
        this._draftTouched = true;
        this._scheduleSave();
        this._scheduleThumbRefresh();
        this._renderStage();
        this._renderLayerPanel();
        this._status('已复制图层');
    },

    /**
     * 拖拽排序落位（2026-11-04 自灯箱迁移，指针拖拽的收口端）：把
     * layer 插到目标行指示的位置。数组底→顶存、面板显示倒序——
     * below（视觉在目标行之下）= 插目标原索引把目标顶上去；above =
     * 目标索引+1；摘除点在插入点之上时插入点左移一格
     */
    _reorderLayerTo(layer, targetLayer, below) {
        if (!layer || !targetLayer || layer.id === targetLayer.id) return;
        const layers = this._ensureDrawLayers();
        const from = layers.indexOf(layer);
        if (from < 0) return;
        let to = layers.indexOf(targetLayer) + (below ? 0 : 1);
        if (from < to) to -= 1;
        to = Math.max(0, Math.min(layers.length, to));
        if (to === from) return;
        // FLIP 动画起点：重排前按行记下旧位置（灯箱同款——拖拽中行不动，
        // 只有落位这一刻从旧位置平滑滑到新位置）
        const oldTops = new Map();
        if (this.layersEl) {
            this.layersEl.querySelectorAll('.manga-layer-row').forEach((r) => {
                oldTops.set(r.dataset.id, r.getBoundingClientRect().top);
            });
        }
        const before = this._histSnapshot();
        layers.splice(from, 1);
        layers.splice(to, 0, layer);
        this._commitHistory(before, '调图层顺序');
        this._draftTouched = true;
        this._scheduleSave();
        this._scheduleThumbRefresh();
        this._renderStage();
        this._renderLayerPanel();
        if (this.layersEl) {
            this.layersEl.querySelectorAll('.manga-layer-row').forEach((r) => {
                const oldTop = oldTops.get(r.dataset.id);
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
        }
    },

    /**
     * 行指针拖拽（PS 式，自灯箱 StudioLayerPanel 迁移）：按下不立即
     * 判定——移动超 5px 才进拖拽，未超阈值仍是普通点击（click 照常
     * 选层）。拖拽中其他行纹丝不动，只有蓝色插入条随指针，松手才真正
     * 改序。完全自管 Pointer Events；preventDefault 压掉文本选区
     */
    _onLayerRowPointerDown(e, layer, row) {
        if (e.button !== 0 || e.target.closest('button')) return;
        const startX = e.clientX, startY = e.clientY;
        const DRAG_THRESHOLD = 5;
        let active = false;
        let targetRow = null, below = false;
        e.preventDefault();
        try { row.setPointerCapture(e.pointerId); } catch { /* 已释放则忽略 */ }

        const clearIndicators = () => {
            if (this.layersEl) this.layersEl.querySelectorAll('.manga-layer-row')
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
            targetRow = document.elementFromPoint(ev.clientX, ev.clientY)
                ?.closest('.manga-layer-row') || null;
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
            if (active && targetRow) {
                const targetLayer = this._layerById(Number(targetRow.dataset.id));
                this._reorderLayerTo(layer, targetLayer, below);
            }
        };
        row.addEventListener('pointermove', onMove);
        row.addEventListener('pointerup', finish);
        row.addEventListener('pointercancel', finish);
    },

    /** 行点击：笔迹行=设为画笔活动层；图片/文字/形状行=舞台选中（锚点/拖动） */
    _layerRowClick(id) {
        const layer = this._layerById(id);
        if (!layer) return;
        if (layer.image || layer.text || layer.shape) {
            this._selLayerId = id;
            this._clearElementSelection();
            if (layer.shape) this._syncShapeOptsFromLayer(layer);   // 选项条跟随选中层（ADR 069）
        } else {
            this._activeLayerId = id;
            this._selLayerId = null;
        }
        this._syncLayerPanelUi();
        this._renderStage();
    },

    /** 清元素选中（图层选中与元素选中互斥的另一半，MangaStage 也用） */
    _clearElementSelection() {
        if (this.selected < 0) return;
        this.selected = -1;
        if (this.itemsEl) {
            this.itemsEl.querySelectorAll('.manga-item.selected')
                .forEach((c) => c.classList.remove('selected'));
        }
    },

    // ==================== 图片层 ====================

    /** 置入本地图：读文件 → /api/assets 内容寻址入库 → contain 适配画幅居中落层 */
    async _placeImageFile(file) {
        if (!file) return;
        const dataUrl = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(String(r.result));
            r.onerror = () => rej(new Error('读取本地图片失败'));
            r.readAsDataURL(file);
        });
        const url = await this._uploadToAssets(dataUrl, file.name);
        const dim = await new Promise((res, rej) => {
            const img = new Image();
            img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
            img.onerror = () => rej(new Error('图片解码失败'));
            img.src = url;
        });
        this._addImageLayer(url, dim.w, dim.h);
        this._status('已置入图片图层');
    },

    // ==================== 文件菜单（ADR 075 自灯箱 StudioImport 迁移） ====================

    /**
     * 置入本地图片（文件菜单）：隐藏 file input 多选（multiple、仅图片，
     * change 后重置 value 以便下次可选同一文件——灯箱同款），逐张走
     * _placeImageFile（内容寻址入库 → contain 适配画幅居中落层，各带
     * 历史入账）；单张失败不中断后续
     */
    _openLocalImageFiles() {
        if (!this._localFileInput) {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.multiple = true;
            input.style.display = 'none';
            input.addEventListener('change', async (e) => {
                const files = Array.from(e.target.files || []);
                input.value = '';
                let ok = 0;
                for (const file of files) {
                    if (!file.type.startsWith('image/')) continue;
                    try {
                        await this._placeImageFile(file);
                        ok++;
                    } catch (err) {
                        this._status(`置入「${file.name}」失败：` + ((err && err.message) || err), true);
                    }
                }
                if (files.length > 1 && ok) this._status(`已置入 ${ok} 张图片图层`);
            });
            document.body.appendChild(input);
            this._localFileInput = input;
        }
        this._localFileInput.click();
    },

    /**
     * 从画布选择图片（文件菜单）：多选弹窗网格列出画布全部真实图片
     * （官方谓词过滤——images 是混合数组装着提示词/文本等面板节点与占位
     * 图，直接遍历会在节点对象上读 img.src 抛 TypeError；视频对象有首帧
     * 封面但导入无意义，同样排除——灯箱同口径）
     */
    _openFileCanvasPicker() {
        if (!this._filePickerSelected) this._filePickerSelected = new Set();
        this._filePickerSelected.clear();
        const grid = this.pickerEl.querySelector('.manga-picker-grid');
        grid.innerHTML = '';
        const imgs = ((window.canvas && window.canvas.images && window.canvas.images.images) || [])
            .filter((o) => window.NodeTypes.isRealCanvasImage(o) && !window.NodeTypes.isVideo(o.source));
        if (!imgs.length) {
            const empty = document.createElement('div');
            empty.className = 'manga-picker-empty';
            empty.textContent = '画布上还没有图片';
            grid.appendChild(empty);
        }
        for (const o of imgs) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'manga-picker-item';
            item.title = o.name || '';
            const thumb = document.createElement('img');
            thumb.src = o.img.src;
            thumb.draggable = false;
            const badge = document.createElement('span');
            badge.className = 'manga-picker-badge';
            badge.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
            item.append(thumb, badge);
            item.addEventListener('click', () => {
                if (this._filePickerSelected.has(o.id)) {
                    this._filePickerSelected.delete(o.id);
                    item.classList.remove('selected');
                } else {
                    this._filePickerSelected.add(o.id);
                    item.classList.add('selected');
                }
                this._syncFileCanvasPickerCount();
            });
            grid.appendChild(item);
        }
        this._syncFileCanvasPickerCount();
        this.pickerEl.hidden = false;
    },

    _closeFileCanvasPicker() {
        if (!this.pickerEl) return;
        this.pickerEl.hidden = true;
        if (this._filePickerSelected) this._filePickerSelected.clear();
    },

    /** 弹窗底部已选计数与确定按钮可用态 */
    _syncFileCanvasPickerCount() {
        const n = this._filePickerSelected.size;
        this.pickerEl.querySelector('.manga-picker-count').textContent = `已选 ${n} 张`;
        this.pickerEl.querySelector('.manga-picker-ok').disabled = n === 0;
    },

    /**
     * 确定导入：勾选的画布图片逐张落为图片图层——src 用画布图对象现有
     * 引用（/api/assets 稳定引用不重传；data: / 远端引用由显式保存时的
     * 归集收进项目夹），尺寸按自然宽高 contain 适配画幅居中（_addImageLayer
     * 内建），层名「画布图片 N」按确定顺序编号
     */
    async _onFileCanvasPickerOk() {
        const imgs = ((window.canvas && window.canvas.images && window.canvas.images.images) || [])
            .filter((o) => this._filePickerSelected && this._filePickerSelected.has(o.id));
        this._closeFileCanvasPicker();
        let seq = 1;
        let ok = 0;
        for (const o of imgs) {
            try {
                const dim = await new Promise((res, rej) => {
                    const im = new Image();
                    im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
                    im.onerror = () => rej(new Error('图片解码失败'));
                    im.src = o.img.src;
                });
                this._addImageLayer(o.img.src, dim.w, dim.h, `画布图片 ${seq++}`);
                ok++;
            } catch (err) {
                this._status('导入画布图片失败：' + ((err && err.message) || err), true);
            }
        }
        if (imgs.length > 1 && ok) this._status(`已置入 ${ok} 张画布图片图层`);
    },

    _addImageLayer(url, natW, natH, label) {
        const layers = this._ensureDrawLayers();
        const before = this._histSnapshot();
        const d = this.draft;
        const id = this._allocLayerId();
        const layer = this._makeImageLayerRecord(d, url, natW, natH, id, label);
        const at = layers.findIndex((l) => l.id === this._activeLayerId);
        layers.splice(at >= 0 ? at + 1 : layers.length, 0, layer);
        this._selLayerId = id;
        this._clearElementSelection();
        this._commitHistory(before, label || '置入图片');
        this._draftTouched = true;
        this._scheduleSave();
        this._scheduleThumbRefresh();
        this._renderStage();
        this._renderLayerPanel();
        return layer;   // 生成捕获路径据此盖 canvasImgId 溯源戳（MangaGenerate）
    },

    /**
     * 图片层记录：contain 适配画幅居中（生成图/置入图同款落位几何）。
     * fromSrc = 原始引用（保存写回画布时按它定位对应图——橡皮烘焙/抠图
     * 会把 src 换成新内容，原始指向靠它保留）
     */
    _makeImageLayerRecord(page, url, natW, natH, id, name) {
        const fit = Math.min(page.width / natW, page.height / natH);
        const w = natW * fit, h = natH * fit;
        const x = (page.width - w) / 2, y = (page.height - h) / 2;
        return {
            id, name: name || `图片 ${id}`, visible: true,
            image: { src: url, fromSrc: url, bbox: [x, y, x + w, y + h] }
        };
    },

    /**
     * 生成图异页落层（2026-11-04 生成图改落图层，ADR 058 修订）：直写
     * 目标页层栈。不入页级历史——历史快照按活动页记，跨页变更与旧的
     * 直写背景行为一致不入账；收口存档+缩略图（切到该页即见）
     */
    _addImageLayerToPage(page, url, natW, natH) {
        if (!page) return null;
        if (!Array.isArray(page.drawLayers)) page.drawLayers = [];
        const id = this._allocLayerId();
        const layer = this._makeImageLayerRecord(page, url, natW, natH, id);
        page.drawLayers.push(layer);
        this._draftTouched = true;
        this._scheduleSave();
        this._scheduleThumbRefresh();
        if (this.visible) this._renderStage();
        this._renderLayerPanel();
        return layer;   // 生成捕获路径据此盖 canvasImgId 溯源戳（MangaGenerate）
    },

    /**
     * 舞台命中可交互层（图片/文字）：可见层自顶向下首个包围盒包含点
     * （草稿屏幕坐标）。名字沿用图片层时期的 _hitImageLayer（调用点
     * 不改），文字层加入后即「可选中层」命中
     */
    _hitImageLayer(px, py) {
        const v = this._view;
        if (!v) return null;
        const layers = this.draft.drawLayers || [];
        for (let i = layers.length - 1; i >= 0; i--) {
            const l = layers[i];
            if (!l || l.visible === false) continue;
            if (l.image) {
                if (this._pointInBbox(px, py, l.image.bbox)) return l.id;
            } else if (l.text && String(l.text.content || '').trim()) {
                if (this._pointInBbox(px, py, this._textLayerBounds(l))) return l.id;
            } else if (l.shape) {
                if (this._pointInBbox(px, py, this._shapeLayerBounds(l))) return l.id;
            }
        }
        return null;
    },

    /**
     * 层几何包围盒（草稿坐标，命中/手势/选中框共用）：图片层=image.bbox、
     * 文字层=按属性测量的紧致包围盒（含渲染周边距、随 text.scale 等比，
     * MangaText._textLayerBounds）、形状层=属性包围盒含渲染外伸
     * （MangaShape._shapeLayerBounds，ADR 069），其余形态 null（无舞台手势）
     */
    _layerBounds(layer) {
        if (!layer) return null;
        if (layer.image && layer.image.bbox) return layer.image.bbox;
        if (layer.text) return this._textLayerBounds(layer);
        if (layer.shape) return this._shapeLayerBounds(layer);
        return null;
    },

    /** 屏幕点是否在草稿 bbox 内（命中检测/选中层内判定共用） */
    _pointInBbox(px, py, bbox) {
        const v = this._view;
        if (!v) return false;
        return px >= v.ox + bbox[0] * v.scale && px <= v.ox + bbox[2] * v.scale &&
            py >= v.oy + bbox[1] * v.scale && py <= v.oy + bbox[3] * v.scale;
    },

    /** 舞台选中图片层（与元素选中互斥；面板高亮跟随） */
    _selectImageLayer(id) {
        this._selLayerId = id;
        this._clearElementSelection();
        this._syncLayerPanelUi();
    },

    _ensureLayerImage(src) {
        let entry = this._layerImgCache.get(src);
        if (!entry) {
            const img = new Image();
            img.onload = () => { if (this.visible) this._renderStage(); };
            img.src = src;
            entry = { img };
            this._layerImgCache.set(src, entry);
        }
        return entry.img;
    },

    // ==================== 磁吸（图片层只对画幅目标，不吸元素框） ====================

    _snapLayerMove(box) {
        const thr = 8 / this._view.scale;   // 灯箱 SNAP_PX=8 同款（元素框保持 6）
        const tx = CoordinateLayout.axisTargets(this.draft.width, []);
        const ty = CoordinateLayout.axisTargets(this.draft.height, []);
        const guides = [];
        let dx = 0, dy = 0;
        let bestX = null, bestXDist = thr;
        for (const edge of [box[0], box[2], (box[0] + box[2]) / 2]) {
            const s = CoordinateLayout.snapValue(edge, tx, thr);
            if (s.snapped) {
                const delta = s.value - edge;
                if (Math.abs(delta) < Math.abs(bestXDist)) { bestXDist = delta; bestX = s.value; }
            }
        }
        if (bestX !== null) { dx = bestXDist; guides.push({ axis: 'x', pos: bestX }); }
        let bestY = null, bestYDist = thr;
        for (const edge of [box[1], box[3], (box[1] + box[3]) / 2]) {
            const s = CoordinateLayout.snapValue(edge, ty, thr);
            if (s.snapped) {
                const delta = s.value - edge;
                if (Math.abs(delta) < Math.abs(bestYDist)) { bestYDist = delta; bestY = s.value; }
            }
        }
        if (bestY !== null) { dy = bestYDist; guides.push({ axis: 'y', pos: bestY }); }
        return {
            box: [box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy],
            guides
        };
    },

    _snapLayerEdges(box, edgesX, edgesY) {
        const thr = 8 / this._view.scale;   // 灯箱 SNAP_PX=8 同款（元素框保持 6）
        const tx = CoordinateLayout.axisTargets(this.draft.width, []);
        const ty = CoordinateLayout.axisTargets(this.draft.height, []);
        const out = box.slice();
        const guides = [];
        for (const k of edgesX) {
            const s = CoordinateLayout.snapValue(out[k], tx, thr);
            if (s.snapped) { out[k] = s.value; guides.push({ axis: 'x', pos: s.value }); }
        }
        for (const k of edgesY) {
            const s = CoordinateLayout.snapValue(out[k], ty, thr);
            if (s.snapped) { out[k] = s.value; guides.push({ axis: 'y', pos: s.value }); }
        }
        return { box: out, guides };
    },

});
