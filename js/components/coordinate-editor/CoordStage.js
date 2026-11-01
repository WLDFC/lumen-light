/**
 * ==========================================================================
 * CoordinateEditor 子模块：舞台渲染与指针交互（自 CoordinateEditor.js 拆出）
 * 作用：中央舞台这个「内嵌小画布编辑器」——dpr 适配渲染（画幅底/三分线/
 *       磁吸参考线/元素框/编号徽标/类型·景别标签/尺寸标签/八向锚点，选中
 *       框置顶重绘保证遮挡下可抓）、指针全手势（空白拖拽画框/拖动移动/
 *       锚点缩放/Shift 画正方/同位连点穿透选层/选中优先拖动）、磁吸
 *       （框边+中心对齐画幅与其他元素，StudioMoveTool 同款粉色粉线）、
 *       双击聚焦卡片描述框。
 * 契约：原型混入（partial-class，ADR 026）——方法 Object.assign 进
 *       CoordinateEditor.prototype，this 即编辑器实例；须后于主类加载。
 *       视口变换存实例字段 _view（渲染时按容器尺寸自适应，坐标换算
 *       _toDraft 供手势反解）。
 * 对应：css/coordinate-editor.css；磁吸纯函数在 js/utils/CoordinateLayout.js
 *       （axisTargets/snapValue）；命中/连点/图层纯逻辑有 Jest 覆盖。
 * ==========================================================================
 */

Object.assign(window.CoordinateEditor.prototype, {

    // ==================== 舞台渲染 ====================

    _renderStage() {
        if (!this.dialog || !this.visible) return;
        this._ensureItemIds();
        const cv = this.stageCv;
        const wrap = cv.parentElement;
        const cssW = wrap.clientWidth, cssH = wrap.clientHeight;
        if (!cssW || !cssH) return;
        const dpr = window.devicePixelRatio || 1;
        const bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
        if (cv.width !== bw || cv.height !== bh) {
            cv.width = bw; cv.height = bh;
            cv.style.width = cssW + 'px';
            cv.style.height = cssH + 'px';
        }
        const ctx = cv.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        const d = this.draft;
        const pad = 28;
        const scale = Math.min((cssW - pad * 2) / d.width, (cssH - pad * 2) / d.height);
        const ox = (cssW - d.width * scale) / 2, oy = (cssH - d.height * scale) / 2;
        this._view = { scale, ox, oy };
        const X = (v) => ox + v * scale, Y = (v) => oy + v * scale;

        // 背景参考图（CoordBackground 混入）：铺满画幅半透明，画在元素框下方
        this._drawBackground(ctx, X, Y, scale);

        // 画幅底与边框
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.fillRect(X(0), Y(0), d.width * scale, d.height * scale);
        ctx.strokeStyle = 'rgba(200,205,215,0.30)';
        ctx.lineWidth = 1;
        ctx.strokeRect(X(0) + 0.5, Y(0) + 0.5, d.width * scale - 1, d.height * scale - 1);

        // 三分参考线（与裁剪工具同款灰细线）
        ctx.strokeStyle = 'rgba(128,128,128,0.30)';
        ctx.beginPath();
        for (let i = 1; i <= 2; i++) {
            ctx.moveTo(X(d.width * i / 3), Y(0)); ctx.lineTo(X(d.width * i / 3), Y(d.height));
            ctx.moveTo(X(0), Y(d.height * i / 3)); ctx.lineTo(X(d.width), Y(d.height * i / 3));
        }
        ctx.stroke();

        // 磁吸参考线（拖拽中，StudioMoveTool 同款粉色）
        if (this._guides.length) {
            ctx.strokeStyle = 'rgba(255,122,184,0.9)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            for (const g of this._guides) {
                if (g.axis === 'x') {
                    ctx.moveTo(X(g.pos), Y(0)); ctx.lineTo(X(g.pos), Y(d.height));
                } else {
                    ctx.moveTo(X(0), Y(g.pos)); ctx.lineTo(X(d.width), Y(g.pos));
                }
            }
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // 元素框（按列表顺序绘制，数组末位画在最上层；眼睛隐藏的框跳过）
        d.items.forEach((item, i) => {
            if (this._hiddenCids.has(item.cid)) return;
            this._drawBox(ctx, item, i, X, Y, scale, i === this.selected);
        });

        // 选中框置顶重绘（跳过填充防半透明叠深）：被上层框盖住时，
        // 选中描边/徽标/锚点仍可见可抓——遮挡编辑的前提
        if (this.selected >= 0 && this.selected < d.items.length &&
            !this._hiddenCids.has(d.items[this.selected].cid)) {
            this._drawBox(ctx, d.items[this.selected], this.selected, X, Y, scale, true, true);
        }

        // 绘制中的新框（虚线预览，用下一个颜色）
        if (this._drag && this._drag.mode === 'draw' && this._drag.box) {
            const [x1, y1, x2, y2] = this._drag.box;
            ctx.strokeStyle = this._colorFor(this._nextCid);
            ctx.lineWidth = 1.7;
            ctx.setLineDash([6, 4]);
            ctx.strokeRect(X(Math.min(x1, x2)), Y(Math.min(y1, y2)),
                Math.abs(x2 - x1) * scale, Math.abs(y2 - y1) * scale);
            ctx.setLineDash([]);
            this._drawDimLabel(ctx, X(Math.min(x1, x2)), Y(Math.max(y1, y2)),
                Math.abs(x2 - x1), Math.abs(y2 - y1));
        }
    },

    _drawBox(ctx, item, i, X, Y, scale, isSelected, overlayOnly) {
        const [x1, y1, x2, y2] = item.bbox;
        const id = Number.isInteger(item.cid) ? item.cid : i;   // 旧数据未回填时退回下标
        const color = this._colorFor(id);
        const px = X(x1), py = Y(y1), pw = (x2 - x1) * scale, ph = (y2 - y1) * scale;

        if (!overlayOnly) {           // 置顶重绘只补描边与控件，不再刷填充
            ctx.fillStyle = this._hexA(color, 0.13);
            ctx.fillRect(px, py, pw, ph);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = isSelected ? 2 : 1.7;
        ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);

        // 编号徽标（左上角圆点）
        ctx.beginPath();
        ctx.arc(px, py, 9, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.fillStyle = '#14151a';
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(id + 1), px, py + 0.5);

        // 类型小标签（框够宽才画，避免糊成一团）：标题 · 类型 · 景别 三段都在
        // ——标题只是识别名，类型（物体/角色/文字）始终保留
        if (pw > 64) {
            ctx.fillStyle = 'rgba(255,255,255,0.78)';
            ctx.font = '11px system-ui, sans-serif';
            ctx.textAlign = 'left';
            const parts = [];
            const t = (item.title || '').trim();
            if (t) parts.push(t);
            parts.push(this._labelText[item.label] || item.label);
            if (item.shot) parts.push(item.shot);
            ctx.fillText(parts.join('·'), px + 14, py + 0.5);
        }

        // 拖动中的尺寸标签
        if (this._drag && (this._drag.mode !== 'draw') && isSelected) {
            this._drawDimLabel(ctx, px, py + ph, x2 - x1, y2 - y1);
        }

        // 选中框：八向锚点（白圆 + 彩描边，屏幕尺寸恒定）
        if (isSelected) {
            for (const a of this._anchors(item.bbox, X, Y)) {
                ctx.beginPath();
                ctx.arc(a.x, a.y, 4.5, 0, Math.PI * 2);
                ctx.fillStyle = '#ffffff';
                ctx.fill();
                ctx.strokeStyle = color;
                ctx.lineWidth = 1.6;
                ctx.stroke();
            }
        }
        ctx.textAlign = 'left';
    },

    /** 拖拽尺寸标签（黑底白字圆角，贴框左下角） */
    _drawDimLabel(ctx, x, y, w, h) {
        const text = `${Math.round(w)} × ${Math.round(h)}`;
        ctx.font = '12px system-ui, sans-serif';
        const tw = ctx.measureText(text).width;
        const bw = tw + 16, bh = 22;
        let bx = x, by = y + 6;
        if (bx + bw > this.stageCv.clientWidth - 4) bx = this.stageCv.clientWidth - bw - 4;
        if (by + bh > this.stageCv.clientHeight - 4) by = y - bh - 6;
        ctx.fillStyle = 'rgba(20,21,26,0.92)';
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 5);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, bx + 8, by + bh / 2 + 1);
    },

    /** 八向锚点屏幕坐标（四角 + 四边中点） */
    _anchors(box, X, Y) {
        const [x1, y1, x2, y2] = box;
        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
        return [
            { id: 'nw', x: X(x1), y: Y(y1) }, { id: 'n', x: X(cx), y: Y(y1) },
            { id: 'ne', x: X(x2), y: Y(y1) }, { id: 'e', x: X(x2), y: Y(cy) },
            { id: 'se', x: X(x2), y: Y(y2) }, { id: 's', x: X(cx), y: Y(y2) },
            { id: 'sw', x: X(x1), y: Y(y2) }, { id: 'w', x: X(x1), y: Y(cy) }
        ];
    },

    _hexA(hex, a) {
        const n = parseInt(hex.slice(1), 16);
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    },

    // ==================== 舞台指针交互 ====================

    /** 事件 → 舞台本地像素坐标 */
    _localPoint(e) {
        const rect = this.stageCv.getBoundingClientRect();
        return { px: e.clientX - rect.left, py: e.clientY - rect.top };
    },

    /** 舞台像素 → 草图像素 */
    _toDraft(px, py) {
        const v = this._view;
        return { x: (px - v.ox) / v.scale, y: (py - v.oy) / v.scale };
    },

    _hitAnchor(px, py) {
        if (this.selected < 0) return null;
        const item = this.draft.items[this.selected];
        if (!item) return null;
        const v = this._view;
        const X = (x) => v.ox + x * v.scale, Y = (y) => v.oy + y * v.scale;
        for (const a of this._anchors(item.bbox, X, Y)) {
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
        if (e.button !== 0 || !this._view) return;
        e.preventDefault();
        // 舞台按下 = 用户离开输入框：主动交还焦点。pointerdown 的
        // preventDefault 会阻止浏览器把焦点挪出输入框——原焦点滞留时
        // Delete 会被该输入框吞掉（表现为选了框按 Del 删不掉）
        const ae = document.activeElement;
        if (ae && ae !== document.body && this.dialog?.contains(ae) &&
            (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) ae.blur();
        const { px, py } = this._localPoint(e);
        const anchor = this._hitAnchor(px, py);
        if (anchor) {
            this._drag = {
                mode: 'resize', anchor, histSnap: this._histSnapshot(),
                orig: this.draft.items[this.selected].bbox.slice()
            };
        } else {
            const stack = this._stackAt(px, py);
            let target = -1;
            if (this._isClickBurst(px, py, stack)) {
                // 同位连点：不拖拽，纯选择逐层下探（选中优先让位给穿透）
                this._select(this._cycleCandidate(stack));
                this._clickBurst = { t: Date.now(), px, py };
            } else if (stack.includes(this.selected)) {
                target = this.selected;   // 选中优先：点中已选框直接拖它（哪怕被上层盖住）
            } else if (stack.length) {
                target = stack[0];        // 常规：选顶层并拖动
            }
            if (target >= 0) {
                this._select(target);
                const p = this._toDraft(px, py);
                this._drag = { mode: 'move', orig: this.draft.items[target].bbox.slice(), start: p, moved: false, histSnap: this._histSnapshot() };
            } else if (!stack.length) {
                const p = this._toDraft(px, py);
                this._drag = { mode: 'draw', start: p, box: null, startPx: px, startPy: py, histSnap: this._histSnapshot() };
            }
        }
        try { this.stageCv.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
        this._renderStage();
    },

    _onPointerMove(e) {
        if (!this._view) return;
        const { px, py } = this._localPoint(e);

        if (!this._drag) {
            // 悬停光标反馈
            const anchor = this._hitAnchor(px, py);
            let cursor = 'crosshair';
            if (anchor) {
                cursor = (anchor === 'nw' || anchor === 'se') ? 'nwse-resize'
                    : (anchor === 'ne' || anchor === 'sw') ? 'nesw-resize'
                    : (anchor === 'n' || anchor === 's') ? 'ns-resize' : 'ew-resize';
            } else if (this._hitBox(px, py) >= 0) cursor = 'move';
            this.stageCv.style.cursor = cursor;
            return;
        }

        const d = this.draft;
        const p = this._toDraft(px, py);

        if (this._drag.mode === 'draw') {
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
        }
        this._renderStage();
    },

    _onPointerUp(e) {
        if (!this._drag) return;
        const drag = this._drag;
        this._drag = null;
        this._guides = [];

        if (drag.mode === 'draw') {
            const { px, py } = this._localPoint(e);
            // 拖拽距离太小按点击处理：取消选中
            if (!drag.box || Math.hypot(px - drag.startPx, py - drag.startPy) < 6) {
                this.selected = -1;
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
        if (this._drag && this._drag.mode !== 'draw' && this.selected >= 0) {
            // 指针被系统打断：回到拖拽前几何，避免半截状态
            this.draft.items[this.selected].bbox = this._drag.orig;
            this._syncBboxInputs();
        }
        this._drag = null;
        this._guides = [];
        this._renderStage();
    },

    _onStageDblClick() {
        // 双击框 → 聚焦当前选中项的卡片描述框（选中由前置 click 建立——
        // 连点穿透时双击聚焦的是穿透到的层，不再是重命中的顶层）
        if (this.selected < 0) return;
        const card = this.itemsEl.querySelector(`.coord-item[data-index="${this.selected}"]`);
        const ta = card && card.querySelector('.coord-item-caption');
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
        const card = this.itemsEl.querySelector(`.coord-item[data-index="${this.selected}"]`);
        if (!card) return;
        const item = this.draft.items[this.selected];
        card.querySelectorAll('.coord-bbox-n').forEach((inp) => {
            if (document.activeElement !== inp) inp.value = item.bbox[Number(inp.dataset.k)];
        });
    },
});
