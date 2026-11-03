/**
 * ==========================================================================
 * MangaEditor 子模块：舞台指针手势（ADR 073 自 MangaStage.js 拆出）
 * ==========================================================================
 * 作用：舞台手势状态机（this._drag 单通道）——命中检测（八向锚点/元素
 *       层栈 _stackAt/同位连点穿透/图片层命中路由）、按下分流（activeTool
 *       路由给 MangaText/MangaTools/MangaShape，select 工具本文件实现
 *       空白画框/拖动/锚点缩放/层拖动/选中优先/连点穿透全套）、移动
 *       （元素与图片/文字/形状层的 move+resize、Shift 画正方、元素框
 *       磁吸 _snapMove/_snapEdges）、收尾（normalizeBox 归一/历史入账/
 *       连点状态）、打断回滚 _cancelDrag、双击（复位缩放/聚焦描述框）。
 *       工具专属手势实现仍在各自混入（MangaText._textStart、
 *       MangaTools._brushStart、MangaShape._shapeStart），此处只路由；
 *       图层磁吸 _snapLayerMove/_snapLayerEdges 在 MangaLayers。
 * 契约：原型混入（partial-class，ADR 026）——须后于主类加载；坐标换算
 *       _localPoint/_toDraft 与视口 _view 在 MangaStage（渲染时合成）。
 * ==========================================================================
 */

Object.assign(window.MangaEditor.prototype, {
    /** 命中八向锚点：选中目标是图片/文字层（_selLayerId）用层包围盒
     *  （_layerBounds——图片=image.bbox、文字=测量包围盒），否则用选中元素 */
    _hitAnchor(px, py) {
        let bbox = null;
        if (this._selLayerId != null) {
            const layer = this._layerById(this._selLayerId);
            if (!layer) return null;
            bbox = this._layerBounds(layer);
            if (!bbox) return null;
        } else if (this.selected >= 0) {
            const item = this.draft.items[this.selected];
            if (!item) return null;
            bbox = item.bbox;
        } else {
            return null;
        }
        const v = this._view;
        const X = (x) => v.ox + x * v.scale, Y = (y) => v.oy + y * v.scale;
        for (const a of this._anchors(bbox, X, Y)) {
            const dx = px - a.x, dy = py - a.y;
            if (dx * dx + dy * dy <= 7 * 7) return a.id;
        }
        return null;
    },

    /**
     * 该点压着的全部元素（层顶→底顺序，即索引降序——数组末位后画在上层）。
     * 遮挡选层（连点穿透/选中优先）都基于这个层栈
     */
    _stackAt(px, py) {
        const v = this._view;
        const out = [];
        for (let i = this.draft.items.length - 1; i >= 0; i--) {
            if (this._hiddenCids.has(this.draft.items[i].cid)) continue;   // 隐藏框不可命中
            const [x1, y1, x2, y2] = this.draft.items[i].bbox;
            if (px >= v.ox + x1 * v.scale && px <= v.ox + x2 * v.scale &&
                py >= v.oy + y1 * v.scale && py <= v.oy + y2 * v.scale) out.push(i);
        }
        return out;
    },

    _hitBox(px, py) {
        return this._stackAt(px, py)[0] ?? -1;
    },

    /** 连点穿透的下一个目标：当前选中者在层栈里的下一层，到底回顶 */
    _cycleCandidate(stack) {
        const pos = stack.indexOf(this.selected);
        return pos >= 0 ? stack[(pos + 1) % stack.length] : stack[0];
    },

    /** 同位连点是否有效（600ms 内、6px 内、且当前选中者也在该层栈里） */
    _isClickBurst(px, py, stack) {
        const b = this._clickBurst;
        return !!b && Date.now() - b.t < 600 &&
            Math.hypot(px - b.px, py - b.py) < 6 &&
            stack.includes(this.selected);
    },

    _onPointerDown(e) {
        // 中键拖动平移（2026-11-07 灯箱 ImageStudio 同款迁移，ADR 077）：
        // 在左键手势分流之前接住——进行中的左键笔迹/拖拽不打断；平移走
        // 独立 _panning 标志不进 _drag 状态机；zoom===1 铺满态时 _panX/_panY
        // 会被 _computeStageView 强制归零（铺满本就无需平移），放大后生效
        if (e.button === 1) {
            if (!this._view || this._stroke || this._drag) return;
            e.preventDefault();
            const p = this._localPoint(e);
            this._panning = { x: p.px, y: p.py };
            try { this.stageCv.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
            this.stageCv.classList.add('panning');   // grabbing 光标（CSS !important 压过内联）
            return;
        }
        if (e.button !== 0 || !this._view) return;
        e.preventDefault();
        // 舞台按下 = 用户离开输入框：主动交还焦点。pointerdown 的
        // preventDefault 会阻止浏览器把焦点挪出输入框——原焦点滞留时
        // Delete 会被该输入框吞掉（表现为选了框按 Del 删不掉）
        const ae = document.activeElement;
        if (ae && ae !== document.body && this.dialog?.contains(ae) &&
            (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) ae.blur();
        const { px, py } = this._localPoint(e);
        // 文字工具：命中文字层重编辑/空白新建就地输入（无拖拽手势，归
        // MangaText 混入）；编辑中点编辑框外=提交（两段式，灯箱同款）
        if (this.activeTool === 'text') {
            this._textStart(px, py);
            this._renderStage();
            return;
        }
        // 画笔/橡皮工具：空白/框上都直接落笔（不选中、不画框），手势归 MangaTools
        if (this.activeTool === 'brush' || this.activeTool === 'eraser') {
            this._brushStart(px, py);
            try { this.stageCv.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
            this._renderStage();
            return;
        }
        // 移除工具：遮罩涂抹（手势归 MangaRemoveTool 会话，ADR 076；
        // 松手自动提交 LaMa——生命周期在会话内，镜像画笔分支）
        if (this.activeTool === 'remove') {
            this._remove._strokeStart(px, py);
            try { this.stageCv.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
            this._renderStage();
            return;
        }
        // 形状工具：命中形状层选中并同步选项条，空白开始拖拽创建（手势归
        // MangaShape 混入；临时层走通用 _drag 通道，提交/干点摘除在收尾）
        if (this.activeTool === 'shape') {
            this._shapeStart(px, py);
            try { this.stageCv.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
            this._renderStage();
            return;
        }
        const anchor = this._hitAnchor(px, py);
        if (anchor) {
            // 锚点缩放：选中目标是图片/文字层走层包围盒（layer-resize），
            // 否则元素。文字层的起始几何（x/y/scale）快照进 origGeom——
            // 缩放是等比改 text.scale，取消回滚要恢复三件套而非 bbox
            const isLayer = this._selLayerId != null;
            const layer = isLayer ? this._layerById(this._selLayerId) : null;
            const layerBbox = layer ? this._layerBounds(layer) : null;
            if (isLayer && !layerBbox) { this._selLayerId = null; return; }
            const orig = isLayer ? layerBbox.slice()
                : this.draft.items[this.selected].bbox.slice();
            this._drag = {
                mode: isLayer ? 'layer-resize' : 'resize',
                layerId: isLayer ? this._selLayerId : null,
                anchor, histSnap: this._histSnapshot(), orig,
                origGeom: layer && layer.text
                    ? { x: layer.text.x, y: layer.text.y, scale: layer.text.scale }
                    : layer && layer.shape
                        ? { x: layer.x, y: layer.y, w: layer.shape.w, h: layer.shape.h } : null
            };
        } else {
            // 已选层优先（与元素「选中优先」同构，元素/层选中互斥故二选一）：
            // 选中图片/文字/形状层后再按它直接拖层——否则全画幅元素 bbox
            // （角色框常盖满幅面）会在元素分支吃掉按下，层永远拖不动
            const selLayer = this._selLayerId != null ? this._layerById(this._selLayerId) : null;
            const selBbox = selLayer ? this._layerBounds(selLayer) : null;
            const insideSel = !!(selBbox && this._pointInBbox(px, py, selBbox));
            if (insideSel) {
                this._drag = {
                    mode: 'layer-move', layerId: selLayer.id, moved: false,
                    orig: selBbox.slice(),
                    origGeom: selLayer.text
                        ? { x: selLayer.text.x, y: selLayer.text.y, scale: selLayer.text.scale }
                        : selLayer.shape
                            ? { x: selLayer.x, y: selLayer.y, w: selLayer.shape.w, h: selLayer.shape.h } : null,
                    start: this._toDraft(px, py),
                    histSnap: this._histSnapshot()
                };
            } else {
                const stack = this._stackAt(px, py);
                let target = -1;
                if (this._isClickBurst(px, py, stack)) {
                    // 同位连点（元素专属）：不拖拽，纯选择逐层下探（选中优先让位给穿透）
                    this._select(this._cycleCandidate(stack));
                    this._clickBurst = { t: Date.now(), px, py };
                } else if (stack.includes(this.selected)) {
                    target = this.selected;   // 选中优先：点中已选框直接拖它（哪怕被上层盖住）
                } else if (stack.length) {
                    target = stack[0];        // 常规：选顶层并拖动（元素优先于图片层）
                }
                if (target >= 0) {
                    this._select(target);
                    const p = this._toDraft(px, py);
                    this._drag = { mode: 'move', orig: this.draft.items[target].bbox.slice(), start: p, moved: false, histSnap: this._histSnapshot() };
                } else {
                    // 图片/文字层：命中顶层可见层（已选层已在上方分支处理）；
                    // 都没有回落画框
                    const hitId = this._hitImageLayer(px, py);
                    if (hitId != null) {
                        this._selectImageLayer(hitId);
                        const layer = this._layerById(this._selLayerId);
                        this._drag = {
                            mode: 'layer-move', layerId: layer.id, moved: false,
                            orig: this._layerBounds(layer).slice(),
                            origGeom: layer.text
                                ? { x: layer.text.x, y: layer.text.y, scale: layer.text.scale }
                                : layer.shape
                                    ? { x: layer.x, y: layer.y, w: layer.shape.w, h: layer.shape.h } : null,
                            start: this._toDraft(px, py),
                            histSnap: this._histSnapshot()
                        };
                    } else if (!stack.length) {
                        const p = this._toDraft(px, py);
                        this._drag = { mode: 'draw', start: p, box: null, startPx: px, startPy: py, histSnap: this._histSnapshot() };
                    }
                }
            }
        }
        try { this.stageCv.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
        this._renderStage();
    },

    _onPointerMove(e) {
        const { px, py } = this._localPoint(e);
        // 画笔光标圈跟随（每动必更——悬停与运笔中都保持显示）
        this._cursorPos = { x: px, y: py };
        this._cursorInStage = true;
        this._redrawCursorRing();
        if (!this._view) return;

        // 中键平移中：屏幕像素增量直接加视口偏移（本地坐标增量=屏幕增量，
        // 走廊钳制在 _computeStageView 自动做），每步更新起点——照灯箱
        // ImageStudio 平移模型（ADR 077）
        if (this._panning) {
            this._panX += px - this._panning.x;
            this._panY += py - this._panning.y;
            this._panning = { x: px, y: py };
            this._renderStage();
            return;
        }

        // 画笔运笔中：只喂点不碰选择态
        if (this._stroke) {
            this._brushMove(px, py);
            this._renderStage();
            return;
        }

        // 移除遮罩运笔中：只喂点（遮罩画布即时成画，舞台红罩经钩子反馈）
        if (this._remove && this._remove._stroke) {
            this._remove._strokeMove(px, py);
            this._renderStage();
            return;
        }

        if (!this._drag) {
            // 画笔/橡皮悬停：系统光标已隐藏（cursor:none），圈即光标，无命中反馈
            if (this.activeTool === 'brush' || this.activeTool === 'eraser' || this.activeTool === 'remove') return;
            // 文字工具：I 形光标由 _setTool/_syncBrushCursor 设定，悬停不改
            if (this.activeTool === 'text') return;
            const anchor = this._hitAnchor(px, py);
            let cursor = 'crosshair';
            if (anchor) {
                cursor = (anchor === 'nw' || anchor === 'se') ? 'nwse-resize'
                    : (anchor === 'ne' || anchor === 'sw') ? 'nesw-resize'
                    : (anchor === 'n' || anchor === 's') ? 'ns-resize' : 'ew-resize';
            } else if (this._hitBox(px, py) >= 0 || this._hitImageLayer(px, py) != null) cursor = 'move';
            this.stageCv.style.cursor = cursor;
            return;
        }

        const d = this.draft;
        const p = this._toDraft(px, py);

        if (this._drag.mode === 'shape-create') {
            // 拖拽创建中（MangaShape 混入，ADR 069）：宽高/左上角实时更新，
            // 提交与干点摘除在 _onPointerUp 收尾
            this._shapeCreateMove(p, e);
        } else if (this._drag.mode === 'draw') {
            let x2 = p.x, y2 = p.y;
            if (e.shiftKey) {   // Shift 画正方：取两轴拖拽量的较大者（保方向）
                const dx = x2 - this._drag.start.x, dy = y2 - this._drag.start.y;
                const m = Math.max(Math.abs(dx), Math.abs(dy)) || 1;
                x2 = this._drag.start.x + Math.sign(dx || 1) * m;
                y2 = this._drag.start.y + Math.sign(dy || 1) * m;
            }
            this._drag.box = [this._drag.start.x, this._drag.start.y, x2, y2];
        } else if (this._drag.mode === 'move') {
            const { orig, start } = this._drag;
            let dx = p.x - start.x, dy = p.y - start.y;
            // 真实拖动即超出连点判定：挂 moved 标记并解除连点状态
            if (!this._drag.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
                this._drag.moved = true;
                this._clickBurst = null;
            }
            // 钳制：整框不出画幅
            dx = Math.max(-orig[0], Math.min(d.width - orig[2], dx));
            dy = Math.max(-orig[1], Math.min(d.height - orig[3], dy));
            // 磁吸：框两边 + 中心 对齐画幅 0/中心/边 与其他元素边缘
            const box = [orig[0] + dx, orig[1] + dy, orig[2] + dx, orig[3] + dy];
            const snapped = this._snapMove(box);
            d.items[this.selected].bbox = snapped.box;
            this._guides = snapped.guides;
            this._syncBboxInputs();
        } else if (this._drag.mode === 'resize') {
            const { orig, anchor } = this._drag;
            const box = orig.slice();
            const edgesX = [], edgesY = [];
            if (anchor.includes('w')) { box[0] = Math.max(0, Math.min(d.width, p.x)); edgesX.push(0); }
            if (anchor.includes('e')) { box[2] = Math.max(0, Math.min(d.width, p.x)); edgesX.push(2); }
            if (anchor.includes('n')) { box[1] = Math.max(0, Math.min(d.height, p.y)); edgesY.push(1); }
            if (anchor.includes('s')) { box[3] = Math.max(0, Math.min(d.height, p.y)); edgesY.push(3); }
            // 磁吸活动边
            const snapped = this._snapEdges(box, edgesX, edgesY);
            d.items[this.selected].bbox = snapped.box;
            this._guides = snapped.guides;
            this._syncBboxInputs();
        } else if (this._drag.mode === 'layer-move') {
            // 图片/文字层拖动：出界移动放开（灯箱同款，ADR 070——不做画幅
            // 钳制，含带笔迹层写回合成在页界裁剪是既有行为）+ 磁吸画幅
            // 目标（边/中心）。图片层写 bbox；文字层包围盒由 x/y 现算，
            // 写 text.x/y（左上角）
            const layer = this._layerById(this._drag.layerId);
            if (layer && layer.image) {
                const { orig, start } = this._drag;
                const dx = p.x - start.x, dy = p.y - start.y;
                if (!this._drag.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) this._drag.moved = true;
                const snapped = this._snapLayerMove([orig[0] + dx, orig[1] + dy, orig[2] + dx, orig[3] + dy]);
                layer.image.bbox = snapped.box;
                this._guides = snapped.guides;
            } else if (layer && layer.text) {
                const { orig, start } = this._drag;
                const dx = p.x - start.x, dy = p.y - start.y;
                if (!this._drag.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) this._drag.moved = true;
                const snapped = this._snapLayerMove([orig[0] + dx, orig[1] + dy, orig[2] + dx, orig[3] + dy]);
                layer.text.x = snapped.box[0];
                layer.text.y = snapped.box[1];
                this._guides = snapped.guides;
            } else if (layer && layer.shape) {
                // 形状层拖动：包围盒（含外伸）由 x/y 现算，写 x/y（形状框
                // 左上角，外伸随动）——位移量从 origGeom 换算防外伸基准漂
                // 移。出界移动放开（2026-11-07 用户拍板补遗，与图片/文字层
                // 一致）；创建仍限画幅内（ADR 069 拍板不随此放开）
                const { orig, start, origGeom } = this._drag;
                const dx = p.x - start.x, dy = p.y - start.y;
                if (!this._drag.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) this._drag.moved = true;
                const snapped = this._snapLayerMove([orig[0] + dx, orig[1] + dy, orig[2] + dx, orig[3] + dy]);
                layer.x = origGeom.x + (snapped.box[0] - orig[0]);
                layer.y = origGeom.y + (snapped.box[1] - orig[1]);
                this._guides = snapped.guides;
            }
        } else if (this._drag.mode === 'layer-resize') {
            // 图片层锚点缩放：活动边钳画幅内 + 磁吸画幅目标
            const layer = this._layerById(this._drag.layerId);
            if (layer && layer.image) {
                const { orig, anchor } = this._drag;
                const box = orig.slice();
                const edgesX = [], edgesY = [];
                if (anchor.includes('w')) { box[0] = Math.max(0, Math.min(d.width, p.x)); edgesX.push(0); }
                if (anchor.includes('e')) { box[2] = Math.max(0, Math.min(d.width, p.x)); edgesX.push(2); }
                if (anchor.includes('n')) { box[1] = Math.max(0, Math.min(d.height, p.y)); edgesY.push(1); }
                if (anchor.includes('s')) { box[3] = Math.max(0, Math.min(d.height, p.y)); edgesY.push(3); }
                const snapped = this._snapLayerEdges(box, edgesX, edgesY);
                layer.image.bbox = snapped.box;
                this._guides = snapped.guides;
            } else if (layer && layer.text) {
                // 文字层锚点缩放：等比（锁纵横比）——按被拖边算拉伸比取两轴
                // 较大者写 text.scale，对侧边锚定不动（t.x/t.y 反向补偿）。
                // 不钳画幅不出界（文字常贴边，渲染本就按画幅裁剪），磁吸
                // 不做（等比下双轴同时动，吸附语义含糊——灯箱同语义）
                const { orig, anchor, origGeom } = this._drag;
                const ow = Math.max(1, orig[2] - orig[0]);
                const oh = Math.max(1, orig[3] - orig[1]);
                const hasX = anchor.includes('w') || anchor.includes('e');
                const hasY = anchor.includes('n') || anchor.includes('s');
                let factor = 1;
                if (hasX && hasY) {
                    const rx = anchor.includes('e') ? (p.x - orig[0]) / ow : (orig[2] - p.x) / ow;
                    const ry = anchor.includes('s') ? (p.y - orig[1]) / oh : (orig[3] - p.y) / oh;
                    factor = Math.max(rx, ry);   // 等比锁纵横：主轴（较大拉伸）带动
                } else if (hasX) {
                    factor = anchor.includes('e') ? (p.x - orig[0]) / ow : (orig[2] - p.x) / ow;
                } else if (hasY) {
                    factor = anchor.includes('s') ? (p.y - orig[1]) / oh : (orig[3] - p.y) / oh;
                }
                const s0 = Math.max(0.0001, origGeom.scale);
                const s = Math.min(20, Math.max(0.05, s0 * factor));
                layer.text.scale = s;
                // 对侧边锚定：拖 e=左缘固定、拖 w=右缘固定（y 轴同理）
                const grow = s / s0;
                if (anchor.includes('w')) layer.text.x = orig[2] - (orig[2] - origGeom.x) * grow;
                if (anchor.includes('n')) layer.text.y = orig[3] - (orig[3] - origGeom.y) * grow;
            } else if (layer && layer.shape) {
                // 形状层锚点拉伸（非等比，图片层同款自由度，用户拍板 ADR 069）：
                // 直接改 x/y/w/h——向量每次重渲染永远锐利，边宽/圆角保持设定值
                // 不随缩放（灯箱的 tscale 烘焙是位图管线专属，漫画不需要）；
                // 磁吸不做（对侧锚定+自由拉伸下吸附语义含糊，文字层同理由）
                const { anchor, origGeom } = this._drag;
                const cx = Math.max(0, Math.min(d.width, p.x));
                const cy = Math.max(0, Math.min(d.height, p.y));
                let left = origGeom.x, top = origGeom.y;
                let right = origGeom.x + origGeom.w, bottom = origGeom.y + origGeom.h;
                if (anchor.includes('w')) left = cx;
                if (anchor.includes('e')) right = cx;
                if (anchor.includes('n')) top = cy;
                if (anchor.includes('s')) bottom = cy;
                layer.x = Math.min(left, right);
                layer.y = Math.min(top, bottom);
                layer.shape.w = Math.max(2, Math.round(Math.abs(right - left)));
                layer.shape.h = Math.max(2, Math.round(Math.abs(bottom - top)));
            }
        }
        this._renderStage();
    },

    _onPointerUp(e) {
        // 中键平移收尾：清状态移类，光标按当前工具恢复（_syncBrushCursor
        // 顺带重画光标圈）
        if (this._panning) {
            this._panning = null;
            this.stageCv.classList.remove('panning');
            this._syncBrushCursor();
            return;
        }
        // 画笔收笔（生命周期与入账在 MangaTools）
        if (this._stroke) {
            this._brushEnd();
            return;
        }
        // 移除遮罩收笔：自动提交 LaMa 抹除（MangaRemoveTool，ADR 076）
        if (this._remove && this._remove._stroke) {
            this._remove._strokeEnd();
            return;
        }
        if (!this._drag) return;
        const drag = this._drag;
        this._drag = null;
        this._guides = [];

        if (drag.mode === 'shape-create') {
            // 拖拽创建收尾（MangaShape 混入）：正常提交入账/干点静默摘除
            this._shapeCreateUp(drag);
            this._renderStage();
            return;
        }
        if (drag.mode === 'draw') {
            const { px, py } = this._localPoint(e);
            // 拖拽距离太小按点击处理：取消选中
            if (!drag.box || Math.hypot(px - drag.startPx, py - drag.startPy) < 6) {
                this.selected = -1;
                if (this._selLayerId != null) {
                    this._selLayerId = null;   // 点空白同样取消图片层选中
                    this._syncLayerPanelUi();
                }
                this._clickBurst = null;
                this._renderItems();
            } else {
                const box = CoordinateLayout.normalizeBox(drag.box, this.draft.width, this.draft.height);
                const cid = this._nextCid++;
                this.draft.items.push({ cid, label: 'object', caption: '', bbox: box });
                this.selected = this.draft.items.length - 1;
                this._commitHistory(drag.histSnap, '画框');
                this._invalidateCompiled();
                this._renderItems();
            }
        } else if (drag.mode === 'layer-move' || drag.mode === 'layer-resize') {
            // 图片/文字层收尾：真实移动/缩放才入账（点击选中在 pointerdown 已完成）
            if (drag.moved) {
                const moved = this._layerById(drag.layerId);
                const isText = !!(moved && moved.text);
                const isShape = !!(moved && moved.shape);
                this._commitHistory(drag.histSnap, drag.mode === 'layer-move'
                    ? (isText ? '移动文字' : isShape ? '移动形状' : '移动图片')
                    : (isText ? '缩放文字' : isShape ? '拉伸形状' : '缩放图片'));
                this._draftTouched = true;
                this._scheduleSave();
                this._scheduleThumbRefresh();
            }
        } else {
            // move/resize 收尾：归一（允许拖过头的边自动换向/收回画幅）；
            // 未发生真实移动的 move = 一次"点击"——挂连点状态供下一次穿透
            const item = this.draft.items[this.selected];
            if (item) {
                item.bbox = CoordinateLayout.normalizeBox(item.bbox, this.draft.width, this.draft.height);
                this._syncBboxInputs();
                if (drag.mode === 'move' && !drag.moved) {
                    const { px, py } = this._localPoint(e);
                    this._clickBurst = { t: Date.now(), px, py };
                }
                if (drag.mode === 'resize' || drag.moved) {
                    this._commitHistory(drag.histSnap, drag.mode === 'resize' ? '缩放' : '移动');
                }
                this._invalidateCompiled();
            }
        }
        this._renderStage();
    },

    _cancelDrag() {
        if (this._panning) {
            // 指针被打断：平移状态清理（pointercancel 路径，ADR 077）
            this._panning = null;
            this.stageCv.classList.remove('panning');
            this._syncBrushCursor();
            return;
        }
        if (this._stroke) {
            this._cancelStroke();   // 指针被打断：进行中笔迹作废（MangaTools）
            return;
        }
        if (this._remove && this._remove._stroke) {
            this._remove._cancelStroke();   // 进行中遮罩涂抹作废（MangaRemoveTool）
            return;
        }
        if (this._drag && this._drag.mode === 'shape-create') {
            // 拖拽创建被打断：临时层从未入账，直接摘除（MangaShape）
            this._shapeCreateAbort();
            this._guides = [];
            this._renderStage();
            return;
        }
        if (this._drag && (this._drag.mode === 'layer-move' || this._drag.mode === 'layer-resize')) {
            // 指针被打断：图片/文字/形状层回到拖拽前几何（文字=x/y/scale
            // 三件套、形状=x/y/w/h 四件套）
            const layer = this._layerById(this._drag.layerId);
            if (layer && layer.image) layer.image.bbox = this._drag.orig;
            else if (layer && layer.shape && this._drag.origGeom) {
                layer.x = this._drag.origGeom.x;
                layer.y = this._drag.origGeom.y;
                layer.shape.w = this._drag.origGeom.w;
                layer.shape.h = this._drag.origGeom.h;
            } else if (layer && layer.text && this._drag.origGeom) {
                layer.text.x = this._drag.origGeom.x;
                layer.text.y = this._drag.origGeom.y;
                layer.text.scale = this._drag.origGeom.scale;
            }
        } else if (this._drag && this._drag.mode !== 'draw' && this.selected >= 0) {
            // 指针被系统打断：回到拖拽前几何，避免半截状态
            this.draft.items[this.selected].bbox = this._drag.orig;
            this._syncBboxInputs();
        }
        this._drag = null;
        this._guides = [];
        this._renderStage();
    },

    _onStageDblClick() {
        // 双击空白（此刻无选中）= 复位缩放回铺满；双击框 → 聚焦当前选中
        // 项的卡片描述框（选中由前置 click 建立——连点穿透时双击聚焦的是
        // 穿透到的层，不再是重命中的顶层）
        if (this.selected < 0) {
            if ((this._zoom || 1) !== 1 || this._panX || this._panY) {
                this._zoom = 1;
                this._panX = 0;
                this._panY = 0;
                this._renderStage();
            }
            return;
        }
        const card = this.itemsEl.querySelector(`.manga-item[data-index="${this.selected}"]`);
        const ta = card && card.querySelector('.manga-item-caption');
        if (ta) { ta.focus(); ta.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    },

    /** 其他元素的边缘/中心作磁吸目标（排除正在拖的框） */
    _otherEdges(excludeIndex) {
        const xs = [], ys = [];
        this.draft.items.forEach((item, i) => {
            if (i === excludeIndex) return;
            if (this._hiddenCids.has(item.cid)) return;   // 隐藏框不参与磁吸
            const [x1, y1, x2, y2] = item.bbox;
            xs.push(x1, x2, (x1 + x2) / 2);
            ys.push(y1, y2, (y1 + y2) / 2);
        });
        return { xs, ys };
    },

    /** 移动磁吸：框两边+中心对齐目标线，取最小位移 */
    _snapMove(box) {
        const thr = 6 / this._view.scale;
        const { xs, ys } = this._otherEdges(this.selected);
        const tx = CoordinateLayout.axisTargets(this.draft.width, xs);
        const ty = CoordinateLayout.axisTargets(this.draft.height, ys);
        const guides = [];
        let dx = 0, dy = 0;
        // x 轴：三个候选边（左、右、中心）各自对全部目标求最近吸附
        let bestX = null, bestXDist = thr;
        const candX = [box[0], box[2], (box[0] + box[2]) / 2];
        for (const edge of candX) {
            const s = CoordinateLayout.snapValue(edge, tx, thr);
            if (s.snapped) {
                const delta = s.value - edge;
                if (Math.abs(delta) < Math.abs(bestXDist)) { bestXDist = delta; bestX = s.value; }
            }
        }
        if (bestX !== null) { dx = bestXDist; guides.push({ axis: 'x', pos: bestX }); }
        let bestY = null, bestYDist = thr;
        const candY = [box[1], box[3], (box[1] + box[3]) / 2];
        for (const edge of candY) {
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

    /** 缩放磁吸：只吸附正在移动的边 */
    _snapEdges(box, edgesX, edgesY) {
        const thr = 6 / this._view.scale;
        const { xs, ys } = this._otherEdges(this.selected);
        const tx = CoordinateLayout.axisTargets(this.draft.width, xs);
        const ty = CoordinateLayout.axisTargets(this.draft.height, ys);
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

    /** 舞台拖拽后同步选中卡片上的四个坐标数值框 */
    _syncBboxInputs() {
        if (this.selected < 0) return;
        const card = this.itemsEl.querySelector(`.manga-item[data-index="${this.selected}"]`);
        if (!card) return;
        const item = this.draft.items[this.selected];
        card.querySelectorAll('.manga-bbox-n').forEach((inp) => {
            if (document.activeElement !== inp) inp.value = item.bbox[Number(inp.dataset.k)];
        });
    },
});
