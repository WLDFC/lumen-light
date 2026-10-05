/**
 * ==========================================================================
 * ImageStudio 子模块：历史记录（PS 历史面板同款，自右侧工具栏按钮唤出）
 * 作用：操作快照栈——每个操作完成点（涂画/文字/图层操作/画幅等，见各处
 *       _pushHistory 调用）拍一份图层栈全量快照（复用 StudioSave 序列化，
 *       含文字属性与变换），点击面板条目回退/前进到任意状态。
 * 语义：
 *   - 在历史中间状态再次操作 → 截断其后条目（标准撤销栈行为）；
 *   - 上限 HISTORY_MAX，超出淘汰最旧（快照为 dataURL 字符串，控内存）；
 *   - 快照激活层以「索引」存储（恢复时图层 id 全部重新生成）；
 *   - restore 为全量重建（显式低频操作，不走增量 DOM）。
 * 契约：构造时传入宿主实例；DomBuilder 调 buildPanel(rail)/renderList；
 *       主类 _pushHistory 薄代理；恢复后置全套脏标记驱动保存重算。
 * ==========================================================================
 */

class StudioHistory {
    constructor(studio) {
        this.studio = studio;
        this.entries = [];      // { label, specs, frame, activeIndex, iw, ih }
        this.index = -1;        // 当前所处条目
        this.renderList = null; // DomBuilder 注入的列表渲染
        this.panelEl = null;    // DomBuilder 挂载后可用
    }

    reset() {
        this.entries = [];
        this.index = -1;
        this.renderList?.();
    }

    /** 当前文档状态快照（激活层以索引存——恢复后图层 id 全新） */
    _snapshot(label) {
        const studio = this.studio;
        return {
            label,
            specs: studio._save._serializeLayers(),
            frame: { ...studio.frame },
            activeIndex: Math.max(0, studio._stackIndex()),
            iw: studio.iw,
            ih: studio.ih
        };
    }

    /** 压入一条历史（各操作完成点调用）；在中间状态操作则截断其后 */
    push(label) {
        const studio = this.studio;
        if (!studio.image || studio._restoring) return;
        const snap = this._snapshot(label);
        this.entries.splice(this.index + 1);
        this.entries.push(snap);
        if (this.entries.length > ImageStudio.HISTORY_MAX) this.entries.shift();
        this.index = this.entries.length - 1;
        this.renderList?.();
    }

    /** 恢复到第 i 条：全量重建图层栈 + 画幅，置全套脏标记驱动保存重算 */
    async restore(i) {
        const studio = this.studio;
        if (i < 0 || i >= this.entries.length || i === this.index) return;
        if (studio._removing) return;               // 推理忙碌期冻结
        this.index = i;                             // 指针先行：期间若触发
                                                    // push 会按标准语义截断未来条目
        studio._text.commitEdit();                  // 编辑中的文字先提交
        const e = this.entries[i];
        studio._restoring = true;
        try {
            studio.iw = e.iw;
            studio.ih = e.ih;
            studio.frame = { ...e.frame };
            studio.layers = [];
            const jobs = [];
            for (const spec of e.specs) {
                const layer = studio._createLayerCanvas(spec.name,
                    { w: spec.w, h: spec.h });
                layer.isBackground = !!spec.isBackground;
                layer.isImage = !!spec.isImage;
                layer.visible = spec.visible !== false;
                layer.opacity = spec.opacity ?? 1;
                layer.tx = Number(spec.x) || 0;
                layer.ty = Number(spec.y) || 0;
                layer.tscale = Number(spec.scale) > 0 ? Number(spec.scale) : 1;
                layer.empty = !spec.paint;
                const paintJob = studio._loadInto(layer.paintCv, spec.paint);
                jobs.push(paintJob);
                jobs.push(studio._loadInto(layer.maskCv, spec.mask));
                if (spec.text) {
                    layer.isText = true;
                    layer.text = { ...spec.text };
                    if (layer.text.content) layer.empty = false;
                    paintJob.then(() => studio._text._render(layer));
                }
                if (spec.shape) {
                    // 形状层：恢复属性并按属性重渲染（paint 快照同为兜底）
                    layer.isShape = true;
                    layer.shape = { ...spec.shape };
                    paintJob.then(() => studio._shape._render(layer));
                }
                if (layer.isImage) {
                    // 图片层 pristine 快照随历史恢复（还原功能依赖）
                    paintJob.then(() => {
                        studio._imagePristine.width = layer.paintCv.width;
                        studio._imagePristine.height = layer.paintCv.height;
                        const g = studio._imagePristine.getContext('2d');
                        g.clearRect(0, 0, studio._imagePristine.width, studio._imagePristine.height);
                        g.drawImage(layer.paintCv, 0, 0);
                    });
                }
                studio.layers.push(layer);
            }
            await Promise.all(jobs);
            studio.activeLayerId =
                studio.layers[e.activeIndex]?.id ||
                studio.layers[studio.layers.length - 1]?.id || null;
            // 全量重建 DOM + 样式 + 选中框（历史恢复是显式低频操作）
            studio._rebuildLayerDom();
            for (const layer of studio.layers) studio._applyLayerStyles(layer);
            studio._layerSeq = Math.max(studio.layers.length, 1);
            // 恢复即文档状态变化：置全套脏标记驱动保存时重算
            studio.dirty = { base: true, strokes: true, mask: true,
                frame: true, layers: true };
            studio._applyTransform();
            studio._renderLayerList();
            studio._syncPanels();
            studio._drawSelOverlay();
        } finally {
            studio._restoring = false;
        }
        this.renderList?.();
    }

    /** 步进（Ctrl+Z 后退 / Ctrl+Shift+Z 前进），返回恢复完成的 Promise */
    step(d) {
        return this.restore(this.index + d);
    }

    // ==================== 面板 UI ====================

    buildPanel(rail) {
        const studio = this.studio;
        this.panelEl = document.createElement('div');
        this.panelEl.className = 'is-history-panel';
        this.panelEl.hidden = true;
        const header = document.createElement('div');
        header.className = 'is-history-header';
        header.textContent = '历史记录';
        this.listEl = document.createElement('div');
        this.listEl.className = 'is-history-list';
        this.panelEl.append(header, this.listEl);
        rail.appendChild(this.panelEl);   // 锚定在工具栏左侧
    }

    togglePanel() {
        const studio = this.studio;
        if (!this.panelEl) return;
        this.panelEl.hidden = !this.panelEl.hidden;
        studio.historyBtn.classList.toggle('active', !this.panelEl.hidden);
        if (!this.panelEl.hidden) this.renderList?.();
    }

    closePanel() {
        if (!this.panelEl || this.panelEl.hidden) return;
        this.panelEl.hidden = true;
        this.studio.historyBtn.classList.remove('active');
    }

    renderListDefault() {
        if (!this.listEl) return;
        this.listEl.innerHTML = '';
        this.entries.forEach((e, i) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'is-history-row'
                + (i === this.index ? ' active' : '')
                + (i > this.index ? ' future' : '');
            row.textContent = e.label;
            row.addEventListener('click', () => this.restore(i));
            this.listEl.appendChild(row);
        });
        // 当前行滚进可视区
        this.listEl.querySelector('.is-history-row.active')
            ?.scrollIntoView({ block: 'nearest' });
    }
}

// 暴露到全局作用域（经典 script，ImageStudio.js 之后实例化时消费）
window.StudioHistory = StudioHistory;
