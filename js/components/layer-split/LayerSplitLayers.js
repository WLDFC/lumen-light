/**
 * LayerSplit 子模块：拆分落层 + 图层编辑舞台（Object.assign 进 LayerSplit.prototype）
 * 拆分=勾选框逐个 canvas 裁切成 PNG 图层 + 整图背景层垫底（本地零 API）；
 * 舞台=按图层序合成渲染（1:1 像素坐标，CSS contain 缩放显示），手势=
 * 点选/拖动/四角等比缩放（漫画图层同款 max 比例口径）；面板=显隐/删除/
 * 上下移/不透明度。
 */

Object.assign(LayerSplit.prototype, {

    // ==================== 拆分 ====================

    async _splitToLayers() {
        if (!this.sourceImage) return;
        const picked = this.boxes.filter((b) => b.keep);
        if (!picked.length) {
            this.status('先勾选至少一个框（右栏复选框）再拆分', true);
            return;
        }
        const src = await this._loadImage(this.sourceImage.dataUrl);
        const W = this.sourceImage.width, H = this.sourceImage.height;
        // 背景层=整图垫底（洞区补齐作用在它身上）
        const layers = [{
            id: this._layerSeq++, name: '背景', kind: 'background',
            src: this.sourceImage.dataUrl, bbox: [0, 0, W, H],
            visible: true, opacity: 1
        }];
        for (const box of picked) {
            const cv = document.createElement('canvas');
            cv.width = box.bbox[2];
            cv.height = box.bbox[3];
            cv.getContext('2d').drawImage(src,
                box.bbox[0], box.bbox[1], box.bbox[2], box.bbox[3],
                0, 0, box.bbox[2], box.bbox[3]);
            layers.push({
                id: this._layerSeq++, name: box.name, kind: 'slice',
                src: cv.toDataURL('image/png'), bbox: box.bbox.slice(),
                visible: true, opacity: 1
            });
        }
        this.layers = layers;
        this.activeLayerId = layers[layers.length - 1].id;
        this._setPhase('edit');
        this._pushHistory();
        this.status(`已拆出 ${picked.length} 个切片图层 + 背景层；被盖住的背景要补齐就点「AI 补齐背景」`);
    },

    /** 回校准阶段（框保留，图层弃） */
    _backToCalibrate() {
        this.layers = [];
        this.activeLayerId = null;
        this._setPhase('calibrate');
        this.status('已回到校准阶段');
    },

    _loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('图片解码失败'));
            img.src = src;
        });
    },

    // ==================== 舞台渲染 ====================

    _renderStage() {
        if (!this.stageCv || !this.sourceImage) return;
        const W = this.sourceImage.width, H = this.sourceImage.height;
        if (this.stageCv.width !== W || this.stageCv.height !== H) {
            this.stageCv.width = W;
            this.stageCv.height = H;
        }
        this._fitToWrap(this.stageCv, W, H);   // 竖图 contain 适配（先于锚点取 rect）
        const ctx = this.stageCv.getContext('2d');
        // 透明底棋盘格（切片 alpha 可见）
        ctx.clearRect(0, 0, W, H);
        if (!LayerSplit._checker) {
            const t = document.createElement('canvas');
            t.width = t.height = 16;
            const tc = t.getContext('2d');
            tc.fillStyle = '#1d1e24';
            tc.fillRect(0, 0, 16, 16);
            tc.fillStyle = '#26272e';
            tc.fillRect(0, 0, 8, 8);
            tc.fillRect(8, 8, 8, 8);
            LayerSplit._checker = ctx.createPattern(t, 'repeat');
        }
        ctx.fillStyle = LayerSplit._checker;
        ctx.fillRect(0, 0, W, H);
        // 图层自底向上
        for (const layer of this.layers) {
            if (!layer.visible || layer.opacity <= 0) continue;
            if (!layer._imgEl || layer._imgSrc !== layer.src) {
                // 惰性加载：渲染先跳过未就绪层，加载完成再刷
                layer._imgSrc = layer.src;
                layer._imgEl = null;
                this._loadImage(layer.src).then((img) => {
                    layer._imgEl = img;
                    if (this.phase === 'edit') this._renderStage();
                }).catch(() => { });
                continue;
            }
            if (!layer._imgEl) continue;
            ctx.globalAlpha = layer.opacity;
            ctx.drawImage(layer._imgEl, layer.bbox[0], layer.bbox[1], layer.bbox[2], layer.bbox[3]);
            ctx.globalAlpha = 1;
        }
        // 选中层：描边 + 四角锚点（屏幕尺寸恒定）
        const active = this.layers.find((l) => l.id === this.activeLayerId);
        if (active && active.visible) {
            const rect = this.stageCv.getBoundingClientRect();
            const scale = (rect.width || 1) / W;
            const [x, y, w, h] = active.bbox;
            ctx.strokeStyle = '#fbbf24';
            ctx.lineWidth = Math.max(1.5, 2 / scale);
            ctx.strokeRect(x, y, w, h);
            ctx.fillStyle = '#fff';
            ctx.strokeStyle = '#d97706';
            const r = 5 / scale;
            for (const [ax, ay] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
                ctx.beginPath();
                ctx.arc(ax, ay, r, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
        }
    },

    // ==================== 舞台手势 ====================

    _wireStageGestures() {
        const cv = this.stageCv;
        cv.addEventListener('pointerdown', (e) => {
            if (!this.sourceImage || !this.layers.length) return;
            e.preventDefault();
            const rect = cv.getBoundingClientRect();
            const scale = (rect.width || 1) / this.sourceImage.width;
            const px = (e.clientX - rect.left) / scale;
            const py = (e.clientY - rect.top) / scale;
            const active = this.layers.find((l) => l.id === this.activeLayerId && l.visible);
            // 锚点优先（仅选中层的四角，命中半径 8px/当前比例）
            if (active) {
                const [ax, ay, aw, ah] = active.bbox;
                const hit = 10 / scale;
                const corner = [[ax, ay, 'nw'], [ax + aw, ay, 'ne'],
                    [ax, ay + ah, 'sw'], [ax + aw, ay + ah, 'se']]
                    .find(([cx, cy]) => Math.abs(px - cx) <= hit && Math.abs(py - cy) <= hit);
                if (corner) {
                    this._startLayerResize(e, active, corner[2], scale);
                    return;
                }
            }
            // 命中检测：自顶向下首个含点可见层
            const hitLayer = [...this.layers].reverse()
                .find((l) => l.visible && l.opacity > 0 &&
                    px >= l.bbox[0] && px <= l.bbox[0] + l.bbox[2] &&
                    py >= l.bbox[1] && py <= l.bbox[1] + l.bbox[3]);
            if (hitLayer) {
                this.activeLayerId = hitLayer.id;
                this._renderStage();
                this._renderLayerPanel(this.sideBody);
                this._startLayerMove(e, hitLayer, scale);
            } else {
                if (this.activeLayerId != null) {
                    this.activeLayerId = null;
                    this._renderStage();
                    this._renderLayerPanel(this.sideBody);
                }
            }
        });
    },

    _startLayerMove(e, layer, scale) {
        const cv = this.stageCv;
        const rect = cv.getBoundingClientRect();
        const start = { px: e.clientX, py: e.clientY, bbox: layer.bbox.slice() };
        const W = this.sourceImage.width, H = this.sourceImage.height;
        const onMove = (ev) => {
            const dx = Math.round((ev.clientX - start.px) / scale);
            const dy = Math.round((ev.clientY - start.py) / scale);
            // 中心不许完全拖出画幅（防丢层）
            layer.bbox = [
                Math.max(-start.bbox[2] + 16, Math.min(W - 16, start.bbox[0] + dx)),
                Math.max(-start.bbox[3] + 16, Math.min(H - 16, start.bbox[1] + dy)),
                start.bbox[2], start.bbox[3]
            ];
            this._renderStage();
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            this._renderLayerPanel(this.sideBody);
            this._pushHistory();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    },

    /** 等比缩放：四角拖拽，对角固定，取两轴比例较大者（漫画图层同口径） */
    _startLayerResize(e, layer, corner, scale) {
        const start = { px: e.clientX, py: e.clientY, bbox: layer.bbox.slice() };
        const minSize = 16;
        const onMove = (ev) => {
            const dx = (ev.clientX - start.px) / scale;
            const dy = (ev.clientY - start.py) / scale;
            const [x, y, w, h] = start.bbox;
            const fx = corner.includes('w') ? x + w : x;   // 固定对角
            const fy = corner.includes('n') ? y + h : y;
            let nw = corner.includes('w') ? w - dx : w + dx;
            let nh = corner.includes('n') ? h - dy : h + dy;
            if (nw < minSize && nh < minSize) return;
            const ratio = Math.max(nw / w, nh / h);        // max 比例：任一轴到量即停
            nw = Math.max(minSize, Math.round(w * ratio));
            nh = Math.max(minSize, Math.round(h * ratio));
            layer.bbox = [
                Math.round(corner.includes('w') ? fx - nw : fx),
                Math.round(corner.includes('n') ? fy - nh : fy),
                nw, nh
            ];
            this._renderStage();
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            this._renderLayerPanel(this.sideBody);
            this._pushHistory();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    },

    // ==================== 图层面板 ====================

    _renderLayerPanel(bodyEl) {
        if (!bodyEl) return;
        bodyEl.innerHTML = '';
        const active = this.layers.find((l) => l.id === this.activeLayerId) || null;
        if (active) {
            const props = document.createElement('div');
            props.className = 'ls-layer-props';
            const isBg = active.kind === 'background';
            const hasInpaint = !!(active.inpaintFull || active.inpaintBlended);
            props.innerHTML = `
                <div class="ls-opacity-row">
                    <span>不透明度</span>
                    <input type="range" min="0" max="100" value="${Math.round(active.opacity * 100)}">
                    <span class="ls-opacity-val">${Math.round(active.opacity * 100)}%</span>
                </div>
                ${isBg && hasInpaint ? `
                <div style="margin-top:8px;">补齐版本</div>
                <div class="ls-inpaint-versions">
                    <button type="button" class="ls-btn ${active.src === active.inpaintBlended ? 'on' : ''}" data-ver="blended">局部合成（其余像素原样）</button>
                    <button type="button" class="ls-btn ${active.src === active.inpaintFull ? 'on' : ''}" data-ver="full">AI 完整版</button>
                    <button type="button" class="ls-btn ${active.src === (active.origSrc || active.src) ? 'on' : ''}" data-ver="orig">原始</button>
                </div>` : ''}
            `;
            const range = props.querySelector('input[type="range"]');
            range.addEventListener('input', () => {
                active.opacity = Number(range.value) / 100;
                props.querySelector('.ls-opacity-val').textContent = `${range.value}%`;
                this._renderStage();
            });
            range.addEventListener('change', () => this._pushHistory());   // 松手才记一步（input 是连发）
            props.querySelectorAll('.ls-inpaint-versions .ls-btn').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const ver = btn.dataset.ver;
                    if (ver === 'blended') active.src = active.inpaintBlended;
                    else if (ver === 'full') active.src = active.inpaintFull;
                    else active.src = active.origSrc;
                    active._imgSrc = null;   // 强制重载
                    this._renderStage();
                    this._renderLayerPanel(bodyEl);
                    this._pushHistory();
                });
            });
            bodyEl.appendChild(props);
        }
        if (!this.layers.length) {
            bodyEl.innerHTML = '<div class="ls-side-empty">还没有图层</div>';
            return;
        }
        // 面板自顶向下显示（数组末位=最上层画在最前）
        for (let i = this.layers.length - 1; i >= 0; i--) {
            const layer = this.layers[i];
            const item = document.createElement('div');
            item.className = 'ls-layer-item' + (layer.id === this.activeLayerId ? ' active' : '') +
                (layer.visible ? '' : ' off');
            item.dataset.layerId = String(layer.id);   // 并发任务禁用该行按钮的查询锚点
            item.innerHTML = `
                <img class="ls-layer-thumb" src="${layer.src}" alt="">
                <div class="ls-layer-info">
                    <div class="ls-layer-name">${this._escapeHtml(layer.name)}</div>
                    <div class="ls-layer-sub">${layer.bbox[2]}×${layer.bbox[3]}${layer.kind === 'background' ? ' · 背景' : ''}${layer.origSrc ? ' · 已抠图' : ''}</div>
                </div>
                <div class="ls-layer-ops">
                    ${layer.kind === 'slice' ? `<button type="button" class="ls-layer-cutout" title="本地抠图：BEN2/RMBG 语义分割去背景（免费，设置 → 抠图选模型）">${LS_ICONS.scissors}</button>` : ''}
                    ${layer.kind === 'slice' ? `<button type="button" class="ls-layer-key" title="本地去底：纯色/近纯色背景色键抠透明（零模型零成本，带软边缘；花色背景抠不动请用剪刀或 ☁）">${LS_ICONS.droplet}</button>` : ''}
                    ${layer.kind === 'slice' ? `<button type="button" class="ls-layer-cutout-ai" title="AI 抠图（云端）：用右侧补齐模型去背景，按张计费；本地抠不动或要更好边缘质量时用">${LS_ICONS.cloud}</button>` : ''}
                    ${layer.origSrc ? `<button type="button" class="ls-layer-restore" title="还原矩形裁切原图（抠坏了/想换模型重抠）">${LS_ICONS.restore}</button>` : ''}
                    <button type="button" class="ls-layer-up" title="上移一层">${LS_ICONS.up}</button>
                    <button type="button" class="ls-layer-down" title="下移一层">${LS_ICONS.down}</button>
                </div>
                <button type="button" class="ls-layer-eye" title="${layer.visible ? '隐藏' : '显示'}">${layer.visible ? LS_ICONS.eye : LS_ICONS.eyeOff}</button>
                <button type="button" class="ls-layer-del" title="删除图层">${LS_ICONS.trash}</button>
            `;
            item.addEventListener('pointerdown', (e) => {
                if (e.target.closest('button')) return;
                this.activeLayerId = layer.id;
                this._renderStage();
                this._renderLayerPanel(bodyEl);
            });
            const cutBtn = item.querySelector('.ls-layer-cutout');
            if (cutBtn) cutBtn.addEventListener('click', () => this._cutoutLayerClick(layer));
            const keyBtn = item.querySelector('.ls-layer-key');
            if (keyBtn) keyBtn.addEventListener('click', () => this._localKeyClick(layer));
            const aiCutBtn = item.querySelector('.ls-layer-cutout-ai');
            if (aiCutBtn) aiCutBtn.addEventListener('click', () => this._cutoutAiClick(layer));
            const restoreBtn = item.querySelector('.ls-layer-restore');
            if (restoreBtn) restoreBtn.addEventListener('click', () => this._restoreLayerCrop(layer));
            item.querySelector('.ls-layer-up').addEventListener('click', () => this._moveLayer(i, 1));
            item.querySelector('.ls-layer-down').addEventListener('click', () => this._moveLayer(i, -1));
            item.querySelector('.ls-layer-eye').addEventListener('click', () => {
                layer.visible = !layer.visible;
                this._renderStage();
                this._renderLayerPanel(bodyEl);
                this._pushHistory();
            });
            item.querySelector('.ls-layer-del').addEventListener('click', () => {
                this.layers = this.layers.filter((l) => l !== layer);
                if (this.activeLayerId === layer.id) this.activeLayerId = null;
                this._renderStage();
                this._renderLayerPanel(bodyEl);
                this._pushHistory();
            });
            bodyEl.appendChild(item);
        }
    },

    /** 上/下移一层：dir=1 朝数组顶（视觉更上层） */
    _moveLayer(index, dir) {
        const to = index + dir;
        if (to < 0 || to >= this.layers.length) return;
        const [layer] = this.layers.splice(index, 1);
        this.layers.splice(to, 0, layer);
        this._renderStage();
        this._renderLayerPanel(this.sideBody);
        this._pushHistory();
    },
});
