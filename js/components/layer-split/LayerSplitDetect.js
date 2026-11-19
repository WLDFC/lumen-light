/**
 * LayerSplit 子模块：VLM 识别与校准框（Object.assign 进 LayerSplit.prototype）
 * 识别=POST /api/llm/chat（images 多模态，provider 留空按模型名解析厂商）；
 * 校准=预览图上叠加绝对定位框（百分比定位随窗口缩放自适应），拖移/四角
 * 等比缩放/勾选启用/手动画新框，右栏框列表联动。
 */

Object.assign(LayerSplit.prototype, {

    // ==================== VLM 识别 ====================

    /** JSON 修复二次调用（image-to-slice 同款）：识别输出解析失败时，把
     *  原始输出原文发回同一模型修格式——纯文本消息（不带图），只修 JSON
     *  不增删改条目；修复结果再解析仍失败时由调用方按原错误报告 */
    async _repairDetectJson(modelChoice, rawText) {
        const r = await fetch('/api/llm/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: modelChoice.id,
                messages: [{
                    role: 'user',
                    content: LayerSplit.buildJsonRepairPrompt(rawText)
                }],
                provider: modelChoice.provider || ''
            })
        });
        const result = await r.json().catch(() => null);
        if (!r.ok || !result || result.status !== 'ok') {
            throw new Error((result && result.message) || `HTTP ${r.status}`);
        }
        return result.reply;
    },

    async _startDetect() {
        if (this._detectRunning) return;
        if (!this.sourceImage) {
            this.status('先取一张图（画布选中图 / 上传 / 拖拽）', true);
            return;
        }
        const modelChoice = this._parseModelChoice(this.detectModel);
        if (!modelChoice.id) {
            this.status('先在右侧选择识别模型（清单来自设置 → API）', true);
            return;
        }
        this._detectRunning = true;
        const btn = this.dialog.querySelector('.ls-act-detect');
        const redetectBtn = this.dialog.querySelector('.ls-act-redetect');
        btn.disabled = true;
        btn.textContent = '识别中…';
        if (redetectBtn) redetectBtn.disabled = true;
        this.status(`识别中：${modelChoice.id} 正在看图找前景元素…`);
        try {
            const r = await fetch('/api/llm/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: modelChoice.id,
                    messages: [{
                        role: 'user',
                        content: LayerSplit.resolveDetectPrompt(
                            this.detectPrompt,
                            this.sourceImage.width, this.sourceImage.height)
                    }],
                    images: [this.sourceImage.dataUrl],
                    provider: modelChoice.provider || ''   // 复合键拆包显式路由；裸名留空自动对号
                })
            });
            const result = await r.json().catch(() => null);
            if (!r.ok || !result || result.status !== 'ok') {
                throw new Error((result && result.message) || `HTTP ${r.status}`);
            }
            let boxes;
            try {
                boxes = LayerSplit.parseDetectResult(
                    result.reply, this.sourceImage.width, this.sourceImage.height);
            } catch (parseErr) {
                // 首次解析失败：JSON 修复二次调用后再试（模型偶发夹带
                // 解释文字/截断 JSON，自修一次能救回大半）
                this.status('返回格式异常，正在让模型自修复 JSON…');
                const repaired = await this._repairDetectJson(modelChoice, result.reply);
                boxes = LayerSplit.parseDetectResult(
                    repaired, this.sourceImage.width, this.sourceImage.height);
            }
            if (!boxes.length) {
                this.status('模型没找到可拆的前景元素（或返回格式异常）——可手动「＋添加框」', true);
            } else {
                this.status(`识别到 ${boxes.length} 个前景元素，逐个校准后点「拆分为图层」`);
            }
            this.boxes = boxes;
            this._boxSeq = boxes.reduce((m, b) => Math.max(m, b.id), 0) + 1;
            this.activeBoxId = boxes.length ? boxes[0].id : null;
            this._setPhase('calibrate');
            this._pushHistory();
        } catch (err) {
            this.status('识别失败：' + ((err && err.message) || err), true);
        } finally {
            this._detectRunning = false;
            btn.disabled = !this.sourceImage;
            btn.textContent = '开始识别';
            if (redetectBtn) redetectBtn.disabled = false;
        }
    },

    // ==================== 校准框叠加 ====================

    /** 重建预览图上的框叠加层（百分比定位，随窗口缩放自适应） */
    _renderPreviewBoxes() {
        if (!this.previewBox) return;
        this.previewBox.querySelectorAll('.ls-box').forEach((n) => n.remove());
        const W = this.sourceImage ? this.sourceImage.width : 1;
        const H = this.sourceImage ? this.sourceImage.height : 1;
        for (const box of this.boxes) {
            const el = document.createElement('div');
            el.className = 'ls-box' + (box.keep ? '' : ' off') +
                (box.id === this.activeBoxId ? ' active' : '');
            el.dataset.boxId = String(box.id);
            this._applyBoxStyle(el, box.bbox, W, H);
            el.innerHTML = `<span class="ls-box-tag">${this._escapeHtml(box.name)}</span>` +
                // 边在前、角在后（后者叠前者上，保证角上斜向热区优先命中）
                ['n', 'e', 's', 'w', 'nw', 'ne', 'sw', 'se'].map((c) =>
                    `<span class="ls-handle ls-h-${c}" data-corner="${c}"></span>`).join('');
            this.previewBox.appendChild(el);
            this._attachBoxGestures(el, box);
        }
    },

    _applyBoxStyle(el, bbox, W, H) {
        el.style.left = (bbox[0] / W * 100) + '%';
        el.style.top = (bbox[1] / H * 100) + '%';
        el.style.width = (bbox[2] / W * 100) + '%';
        el.style.height = (bbox[3] / H * 100) + '%';
    },

    _escapeHtml(s) {
        return String(s || '').replace(/[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },

    /** 显示坐标 → 图像坐标换算系数（预览盒显示宽 / 原图宽） */
    _previewScale() {
        const rect = this.previewBox.getBoundingClientRect();
        return (rect.width || 1) / (this.sourceImage ? this.sourceImage.width : 1);
    },

    /** 删除校准框（右栏垃圾桶 / 键盘 Delete 共用入口）：清集合后按阶段
     *  刷新（列表+叠加+计数都在 _setPhase('calibrate') 收口） */
    _deleteBox(box) {
        this.boxes = this.boxes.filter((b) => b !== box);
        if (this.activeBoxId === box.id) this.activeBoxId = null;
        if (this.phase === 'calibrate') this._setPhase('calibrate');
        this._pushHistory();
    },

    _attachBoxGestures(el, box) {
        el.querySelectorAll('.ls-handle').forEach((h) => {
            h.addEventListener('pointerdown', (e) => {
                if (this._drawMode) return;   // 画框模式：手柄不响应，事件冒泡去画新框
                e.stopPropagation();
                e.preventDefault();
                this._startBoxResize(e, box, h.dataset.corner, el);
            });
        });
        el.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.ls-handle')) return;
            if (this._drawMode) return;   // 画框模式：旧框不响应拖动，冒泡去画新框
            e.preventDefault();
            this._startBoxMove(e, box, el);
        });
    },

    _setBoxActive(box) {
        this.activeBoxId = box.id;
        this.previewBox.querySelectorAll('.ls-box').forEach((n) => {
            n.classList.toggle('active', Number(n.dataset.boxId) === box.id);
        });
        // 列表选中态同步
        if (this.sideBody) {
            this.sideBody.querySelectorAll('.ls-box-item').forEach((n) => {
                n.classList.toggle('active', Number(n.dataset.boxId) === box.id);
            });
        }
    },

    _startBoxMove(e, box, el) {
        const W = this.sourceImage.width, H = this.sourceImage.height;
        const scale = this._previewScale();
        const start = { px: e.clientX, py: e.clientY, bbox: box.bbox.slice() };
        this._setBoxActive(box);
        const onMove = (ev) => {
            const dx = (ev.clientX - start.px) / scale;
            const dy = (ev.clientY - start.py) / scale;
            box.bbox = [
                Math.max(0, Math.min(W - start.bbox[2], Math.round(start.bbox[0] + dx))),
                Math.max(0, Math.min(H - start.bbox[3], Math.round(start.bbox[1] + dy))),
                start.bbox[2], start.bbox[3]
            ];
            this._applyBoxStyle(el, box.bbox, W, H);
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            this._renderBoxListMeta();
            this._pushHistory();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    },

    _startBoxResize(e, box, corner, el) {
        const W = this.sourceImage.width, H = this.sourceImage.height;
        const scale = this._previewScale();
        const min = LayerSplit.MIN_BOX_SIZE;
        const start = { px: e.clientX, py: e.clientY, bbox: box.bbox.slice() };
        this._setBoxActive(box);
        const onMove = (ev) => {
            const dx = Math.round((ev.clientX - start.px) / scale);
            const dy = Math.round((ev.clientY - start.py) / scale);
            const [x, y, w, h] = start.bbox;
            let L = x, T = y, R = x + w, B = y + h;
            if (corner.includes('w')) L = x + dx;
            if (corner.includes('e')) R = x + w + dx;
            if (corner.includes('n')) T = y + dy;
            if (corner.includes('s')) B = y + h + dy;
            // 对角翻转防护：交换回正序并 clamp 进画幅
            const l = Math.max(0, Math.min(L, R)), r = Math.min(W, Math.max(L, R));
            const t = Math.max(0, Math.min(T, B)), b = Math.min(H, Math.max(T, B));
            if (r - l < min || b - t < min) return;   // 小于最小尺寸不更新
            box.bbox = [l, t, r - l, b - t];
            this._applyBoxStyle(el, box.bbox, W, H);
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            this._renderBoxListMeta();
            this._pushHistory();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    },

    /** 手动画框模式（2026-11-13 用户反馈改成开关）：开启后在图上连续拉框，
     *  每画一个保持模式继续画；再点一次按钮或按 Esc 退出。框已有四角+四边
     *  手柄可缩放，画框模式下旧框手势让位（冒泡到预览盒画新框） */
    _toggleDrawMode() {
        if (this._drawMode) {
            this._exitDrawMode();
            this.status('已退出画框模式');
            return;
        }
        this._drawMode = true;
        this.previewBox.classList.add('draw-mode');
        const btn = this.dialog.querySelector('.ls-act-add-box');
        if (btn) btn.classList.add('running');
        this.status('画框模式：在图上连续拉框（再点一次按钮或按 Esc 退出）');
        this._armDrawGesture();
    },

    /** 退出画框模式：清标志/光标/按钮态并解绑监听 */
    _exitDrawMode() {
        this._drawMode = false;
        if (this.previewBox) this.previewBox.classList.remove('draw-mode');
        const btn = this.dialog && this.dialog.querySelector('.ls-act-add-box');
        if (btn) btn.classList.remove('running');
        if (this._disarmDrawGesture) this._disarmDrawGesture();
    },

    _armDrawGesture() {
        // 绑在预览盒（而非 img）上：框叠加是 img 的兄弟节点，绑 img 时
        // 点在已有框上永远画不了框；绑盒子上冒泡全覆盖（2026-11-13）
        const onDown = (e) => {
            if (!this._drawMode) return;
            if (e.button !== 0) return;
            e.preventDefault();
            const scale = this._previewScale();
            const rect = this.previewBox.getBoundingClientRect();
            const gx = (e.clientX - rect.left) / scale;
            const gy = (e.clientY - rect.top) / scale;
            const W = this.sourceImage.width, H = this.sourceImage.height;
            const temp = document.createElement('div');
            temp.className = 'ls-box active';
            this.previewBox.appendChild(temp);
            const onMove = (ev) => {
                const cx = Math.max(0, Math.min(W, (ev.clientX - rect.left) / scale));
                const cy = Math.max(0, Math.min(H, (ev.clientY - rect.top) / scale));
                this._applyBoxStyle(temp, [
                    Math.min(gx, cx), Math.min(gy, cy),
                    Math.abs(cx - gx), Math.abs(cy - gy)
                ], W, H);
            };
            const onUp = (ev) => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                temp.remove();
                const cx = Math.max(0, Math.min(W, (ev.clientX - rect.left) / scale));
                const cy = Math.max(0, Math.min(H, (ev.clientY - rect.top) / scale));
                const bbox = LayerSplit.normalizeBox(
                    [Math.min(gx, cx), Math.min(gy, cy),
                        Math.abs(cx - gx), Math.abs(cy - gy)],
                    W, H, 4);   // 手画的框放宽到 4px（小图标）
                if (!bbox) {
                    this.status('框太小（最小 4px），重新画一个', true);
                    return;   // 模式保持开，直接再拉
                }
                const box = {
                    id: this._boxSeq++, name: `asset_${String(this._boxSeq - 1).padStart(2, '0')}`,
                    kind: 'other', bbox, keep: true, confidence: null
                };
                this.boxes.push(box);
                this.activeBoxId = box.id;
                this._renderPreviewBoxes();
                this._renderBoxList(this.sideBody);
                this._setPhase('calibrate');   // 刷新计数；不退出画框模式
                this._pushHistory();
                this.status(`已添加 ${box.name}，继续拉框或再点一次按钮退出`);
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        };
        this.previewBox.addEventListener('pointerdown', onDown);
        // 退出画框模式时解绑（_exitDrawMode 调用）
        this._disarmDrawGesture = () => this.previewBox.removeEventListener('pointerdown', onDown);
    },

    // ==================== 右栏框列表 ====================

    _renderBoxList(bodyEl) {
        if (!bodyEl) return;
        this.previewBox.classList.toggle('draw-mode', !!this._drawMode);   // 画框模式不被列表重渲吃掉光标态
        if (!this.boxes.length) {
            bodyEl.innerHTML = `<div class="ls-side-empty">还没有识别结果。<br>点上方「开始识别」，<br>或「＋添加框」手动框选。</div>`;
            return;
        }
        bodyEl.innerHTML = '';
        const kinds = [...LayerSplit.ALLOWED_KINDS];
        for (const box of this.boxes) {
            const item = document.createElement('div');
            item.className = 'ls-box-item' + (box.keep ? '' : ' off') +
                (box.id === this.activeBoxId ? ' active' : '');
            item.dataset.boxId = String(box.id);
            item.innerHTML = `
                <div class="ls-box-item-head">
                    <input type="checkbox" ${box.keep ? 'checked' : ''} title="勾选=拆分时切出该图层">
                    <input type="text" class="ls-box-item-name" value="${this._escapeHtml(box.name)}" spellcheck="false">
                    <button type="button" class="ls-box-item-del" title="删除该框">${LS_ICONS.trash}</button>
                </div>
                <div class="ls-box-item-meta">
                    <select title="元素类型">${kinds.map((k) =>
                        `<option value="${k}"${k === box.kind ? ' selected' : ''}>${LayerSplit.KIND_LABELS[k] || k}</option>`).join('')}</select>
                    <span class="ls-box-item-coords"></span>
                </div>
            `;
            this._renderBoxCoords(item.querySelector('.ls-box-item-coords'), box);
            item.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
                box.keep = e.target.checked;
                item.classList.toggle('off', !box.keep);
                this._renderPreviewBoxes();
                this._pushHistory();
            });
            item.querySelector('.ls-box-item-name').addEventListener('change', (e) => {
                box.name = e.target.value.trim() || box.name;
                this._renderPreviewBoxes();
                this._pushHistory();
            });
            item.querySelector('.ls-box-item-name').addEventListener('pointerdown', (e) => {
                this._setBoxActive(box);
            });
            item.querySelector('select').addEventListener('change', (e) => {
                box.kind = e.target.value;
                this._pushHistory();
            });
            item.querySelector('.ls-box-item-del').addEventListener('click', () => this._deleteBox(box));
            item.addEventListener('pointerdown', (e) => {
                if (e.target.closest('input, select, button')) return;
                this._setBoxActive(box);
            });
            bodyEl.appendChild(item);
        }
    },

    _renderBoxCoords(el, box) {
        if (el) el.textContent = `${box.bbox[0]},${box.bbox[1]} ${box.bbox[2]}×${box.bbox[3]}` +
            (box.confidence != null ? ` · ${Math.round(box.confidence * 100)}%` : '');
    },

    /** 拖动/缩放后只刷列表坐标（不重建列表防焦点丢失） */
    _renderBoxListMeta() {
        if (!this.sideBody) return;
        this.sideBody.querySelectorAll('.ls-box-item').forEach((item) => {
            const id = Number(item.dataset.boxId);
            const box = this.boxes.find((b) => b.id === id);
            if (box) this._renderBoxCoords(item.querySelector('.ls-box-item-coords'), box);
        });
    },
});
