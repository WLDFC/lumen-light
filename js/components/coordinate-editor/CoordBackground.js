/**
 * ==========================================================================
 * CoordinateEditor 子模块：背景参考图与生成图透显（自第七期新增）
 * 作用：舞台左上角悬浮工具条——「背景」下拉（本地上传…/从画布选择…/
 *       清除背景）+「生成图」开关（开着时最新生成的图自动替换为舞台
 *       背景参考）+ 背景不透明度滑块（有背景时才显示）。参考图铺满画幅
 *       半透明绘制在元素框下方，用于对照既有图参考布局描点位。
 * 契约：原型混入（partial-class，ADR 026）——方法 Object.assign 进
 *       CoordinateEditor.prototype，this 即编辑器实例；须后于主类加载。
 * 数据：
 *   - 背景引用存 draft.background（字符串 URL）——只存引用不存 base64：
 *     本地图/画布图/生成图统一经 POST /api/assets 内容寻址入库换稳定
 *     URL（重复图自动去重）；normalizeDraft 只认 /api/assets/ 前缀的
 *     引用（其余形态丢弃）；编译前 _draftForCompile 剥离（非 MOSS 契约）。
 *     背景变更不走 _invalidateCompiled（不影响编译产物），直接防抖保存。
 *   - 不透明度与生成图开关是纯视图态，存 localStorage（ADR 019 口径）：
 *     lumenLight.coordBgOpacity / lumenLight.coordGenRef。
 *   - 生成图事件源 lumenGeneratedImage（detail.src）：PlaceholderManager
 *     .replace（四类生成节点+面板链路的占位图替换收口）与 LumenSocket
 *     new-image 默认落图分支（免节点回流/桥接回流）两处派发。
 * 依赖：LumenDropdown（动作型菜单，底栏「写入」按钮同款交互）；
 *       ImageExport.toDataUrl / CanvasDelivery.getAssetPlan（画布图导出
 *       交付计划，与图片工具栏「添加到资产」同一条链路）。
 * 对应：css/coordinate-editor.css 舞台悬浮条段。
 * ==========================================================================
 */

Object.assign(window.CoordinateEditor.prototype, {

    // ==================== DOM 构建（由 CoordDom._buildDom 调用） ====================

    _buildBackgroundTools() {
        // 工具条挂窗口标题栏中部（标题组与右侧状态/关闭之间，30px 大行内
        // 放得下）——不占舞台空间，画幅再大也不被遮挡
        const wrap = this.stageCv.closest('.coord-stage-wrap') ||
            this.stageCv.parentElement;
        const header = this.dialog.querySelector('.recipe-dialog-header');
        if (!wrap || !header) return;

        // 工具条：背景下拉 + 生成图开关 + 不透明度滑块（有背景才显示）
        const bar = document.createElement('div');
        bar.className = 'coord-bg-tools';
        bar.innerHTML = `
            <button type="button" class="coord-bg-btn" title="设置背景参考图：本地上传 / 从画布选择，铺满画幅半透明显示，用于对照布局描点位"></button>
            <label class="coord-gen-toggle" title="开着时：最新生成的图自动成为舞台背景参考（替换式）">
                <input type="checkbox" class="coord-gen-toggle-input">
                <span class="coord-gen-toggle-box"></span><span>生成图</span>
            </label>
            <input type="range" class="coord-bg-opacity" min="0.05" max="1" step="0.05"
                   title="背景不透明度" hidden>
            <input type="file" class="coord-bg-file" accept="image/*" hidden>
        `;
        // 插在标题组之后、右侧状态/关闭之前（header 是 space-between，
        // 三个子元素时工具组落在标题与右侧之间）
        const right = header.querySelector('.coord-header-right');
        if (right) header.insertBefore(bar, right);
        else header.appendChild(bar);
        this.bgBtn = bar.querySelector('.coord-bg-btn');
        this._genToggleEl = bar.querySelector('.coord-gen-toggle-input');
        this._bgOpacityEl = bar.querySelector('.coord-bg-opacity');
        this._bgFileEl = bar.querySelector('.coord-bg-file');

        // 画布选图面板（覆盖在舞台上的轻量浮层，单选即关）
        const picker = document.createElement('div');
        picker.className = 'coord-bg-picker';
        picker.hidden = true;
        picker.innerHTML = `
            <div class="coord-bg-picker-head">
                <span>选择画布图片作背景参考</span>
                <button type="button" class="coord-bg-picker-close" title="关闭">✕</button>
            </div>
            <div class="coord-bg-picker-grid"></div>
            <div class="coord-bg-picker-empty" hidden>画布上还没有图片</div>
        `;
        wrap.appendChild(picker);
        this._bgPickerEl = picker;
        picker.querySelector('.coord-bg-picker-close')
            .addEventListener('click', () => this._closeCanvasPicker());

        // 背景下拉（动作型）：菜单展开前刷新选项（有无「清除背景」随当下
        // 草稿状态；写入按钮同款「先注册 click 刷新再建下拉」次序）
        this.bgBtn.addEventListener('click', () => this._refreshBgMenu());
        this.bgDd = new LumenDropdown(this.bgBtn, {
            actionMenu: true,
            menuClass: 'coord-bg-menu',
            placeholder: '背景',
            onChange: (v) => {
                if (v === 'local') this._bgFileEl.click();
                else if (v === 'canvas') this._openCanvasPicker();
                else if (v === 'clear') this._setBackground('');
                this.bgDd.setLabel('背景');
            }
        });
        this.bgDd.setLabel('背景');

        // 生成图开关：视图态存 localStorage（ADR 019 口径）
        this._genToggleEl.checked = localStorage.getItem('lumenLight.coordGenRef') === '1';
        this._genToggleEl.addEventListener('change', () => {
            if (this._genToggleEl.checked) localStorage.setItem('lumenLight.coordGenRef', '1');
            else localStorage.removeItem('lumenLight.coordGenRef');
        });

        // 不透明度：即时生效 + 持久化
        this._bgOpacityEl.addEventListener('input', () => {
            localStorage.setItem('lumenLight.coordBgOpacity', String(this._bgOpacity()));
            if (this.visible) this._renderStage();
        });

        // 本地上传：data URL → 入资产库换稳定引用
        this._bgFileEl.addEventListener('change', () => {
            const f = this._bgFileEl.files && this._bgFileEl.files[0];
            this._bgFileEl.value = '';
            if (!f) return;
            const reader = new FileReader();
            reader.onload = async () => {
                try {
                    const url = await this._uploadToAssets(String(reader.result), f.name);
                    this._setBackground(url);
                    this._status('已设为背景参考');
                } catch (err) {
                    this._status('背景图上传失败：' + (err && err.message ? err.message : err), true);
                }
            };
            reader.onerror = () => this._status('读取本地图片失败', true);
            reader.readAsDataURL(f);
        });

        // 生成图事件（构造器已挂过，此处幂等补挂只作双保险）
        this._attachGeneratedImageListener();

        this._syncBackgroundUi();
    },

    // ==================== 背景下拉与选图面板 ====================

    _refreshBgMenu() {
        const opts = [
            { value: 'local', label: '本地上传…' },
            { value: 'canvas', label: '从画布选择…' }
        ];
        if (this.draft.background) opts.push({ value: 'clear', label: '清除背景' });
        this.bgDd.setOptions(opts, '');
        this.bgDd.setLabel('背景');
    },

    _openCanvasPicker() {
        const grid = this._bgPickerEl.querySelector('.coord-bg-picker-grid');
        const emptyEl = this._bgPickerEl.querySelector('.coord-bg-picker-empty');
        grid.innerHTML = '';
        const canvas = window.canvas;
        // 真实画布图片（排除占位图/面板节点/视频），数组末位最新 → 反转最新在前
        const objs = canvas ? canvas.images.images
            .filter((o) => window.NodeTypes.isRealCanvasImage(o) && !window.NodeTypes.isVideo(o.source))
            .slice(-80).reverse() : [];
        emptyEl.hidden = objs.length > 0;
        for (const obj of objs) {
            const im = document.createElement('img');
            im.src = obj.img.src;                       // 缩略图直接用原 src（已加载过的图不重复取流）
            im.title = obj.name || '';
            im.addEventListener('click', () => this._pickCanvasObject(obj));
            grid.appendChild(im);
        }
        this._bgPickerEl.hidden = false;
    },

    _closeCanvasPicker() {
        if (!this._bgPickerEl) return;
        this._bgPickerEl.hidden = true;
        this._bgPickerEl.querySelector('.coord-bg-picker-grid').innerHTML = '';
    },

    /** 选中画布图片：按交付计划导出（所见即所得，含笔迹合成）→ 入资产库 → 设背景 */
    async _pickCanvasObject(obj) {
        try {
            const plan = window.CanvasDelivery.getAssetPlan(
                obj, window.canvas.images.getCompositeSrc(obj));
            if (!plan.src) throw new Error('图片没有可用的图像源');
            const dataUrl = await window.ImageExport.toDataUrl(obj.img, plan.src);
            const url = await this._uploadToAssets(dataUrl, plan.filename);
            this._closeCanvasPicker();
            this._setBackground(url);
            this._status('已设为背景参考');
        } catch (err) {
            this._status('取图失败：' + (err && err.message ? err.message : err), true);
        }
    },

    // ==================== 背景状态与渲染 ====================

    /** 设背景（URL 引用或空串清除）：只动草稿引用字段，不碰编译产物 */
    _setBackground(url) {
        url = (typeof url === 'string' && url.trim()) ? url.trim() : '';
        if (url) this.draft.background = url;
        else delete this.draft.background;
        this._draftTouched = true;
        this._scheduleSave();      // 背景不影响编译，不走 _invalidateCompiled
        this._syncBackgroundUi();
        if (!url) {
            this._bgImg = null;
            this._bgLoadedUrl = '';
            if (this.visible) this._renderStage();
            return;
        }
        this._loadBackgroundImg(url);
    },

    _loadBackgroundImg(url) {
        if (this._bgLoadedUrl === url && this._bgImg) {
            if (this.visible) this._renderStage();
            return;
        }
        const img = new Image();
        img.onload = () => {
            if (this.draft.background !== url) return;   // 加载期间已被替换/清除
            this._bgImg = img;
            this._bgLoadedUrl = url;
            this._renderStage();
        };
        img.onerror = () => {
            if (this.draft.background !== url) return;
            this._bgImg = null;
            this._bgLoadedUrl = '';
            this._syncBackgroundUi();
            this._status('背景图加载失败', true);
        };
        img.src = url;
    },

    /** 舞台渲染钩子（CoordStage._renderStage 在 clearRect 后调用）：
     *  参考图铺满画幅，按不透明度画在元素框下方 */
    _drawBackground(ctx, X, Y, scale) {
        if (!this._bgImg) return;
        const d = this.draft;
        ctx.save();
        ctx.globalAlpha = this._bgOpacity();
        ctx.drawImage(this._bgImg, X(0), Y(0), d.width * scale, d.height * scale);
        ctx.restore();
    },

    /** 不透明度视图态（localStorage，默认 0.5） */
    _bgOpacity() {
        const v = Number(localStorage.getItem('lumenLight.coordBgOpacity'));
        return Number.isFinite(v) && v >= 0.05 && v <= 1 ? v : 0.5;
    },

    /** 悬浮条 UI 与草稿背景状态对齐（滑块显隐即「有背景」的可见指示） */
    _syncBackgroundUi() {
        if (!this._bgOpacityEl) return;
        const has = !!this.draft.background;
        this._bgOpacityEl.hidden = !has;
        if (has) this._bgOpacityEl.value = String(this._bgOpacity());
    },

    // ==================== 生成图透显 ====================

    /**
     * 生成图事件监听：构造器即挂（不等首次 show）——页面刷新后先出图、
     * 后开编辑器的窗口期也能接住（开关状态在 localStorage 里，不依赖
     * 工具条 DOM 已构建）。幂等，重复调用不重复挂
     */
    _attachGeneratedImageListener() {
        if (this._genListenerAttached) return;
        this._genListenerAttached = true;
        window.addEventListener('lumenGeneratedImage', (e) => this._onGeneratedImage(e));
    },

    _genToggleOn() {
        // 工具条未构建时回落 localStorage（构造器期监听依赖此路径）
        if (this._genToggleEl) return this._genToggleEl.checked;
        return localStorage.getItem('lumenLight.coordGenRef') === '1';
    },

    /**
     * 生成图 src 归一：WS new-image 的 image 字段是裸 base64
     * （addImageToCanvas 同款契约，那边同样自己补前缀）——其余形态
     * （data URL / /api/assets/ 引用 / http(s) 地址 / 同源路径）原样放行。
     * 纯函数，Jest 可单测
     */
    _normalizeGenSrc(src) {
        if (typeof src !== 'string' || !src) return '';
        if (src.startsWith('data:') || src.startsWith('/') ||
            /^(https?:)?\/\//i.test(src)) return src;
        return 'data:image/png;base64,' + src;
    },

    /**
     * lumenGeneratedImage 事件：开着开关时最新生成图替换背景参考。
     * src 可能是 data URL（节点链路占位图替换）、裸 base64（WS 默认分支）、
     * /api/assets/ 稳定 URL 或临时地址（Comfy /view 等）——统一归一后，
     * 非稳定引用入资产库换 URL 再落草稿
     */
    _onGeneratedImage(e) {
        if (!this._genToggleOn()) return;
        const raw = e && e.detail && e.detail.src;
        const src = this._normalizeGenSrc(raw);
        if (!src) return;
        if (src === this.draft.background) return;
        this._adoptReferenceSrc(src);
    },

    async _adoptReferenceSrc(src) {
        try {
            let url = src;
            if (!src.startsWith('/api/assets/')) {
                const dataUrl = await window.ImageExport.toDataUrl(null, src);
                url = await this._uploadToAssets(dataUrl, `coord-ref-${Date.now()}.png`);
            }
            if (!this._genToggleOn()) return;   // 上传期间开关被关：不入草稿
            if (url === this.draft.background) return;
            this._setBackground(url);
            if (this.visible) this._status('生成图已设为背景参考');
        } catch (err) {
            if (this.visible) this._status('生成图入参考失败：' + (err && err.message ? err.message : err), true);
        }
    },

    /** 入资产库（内容寻址去重），返回稳定引用 URL */
    async _uploadToAssets(dataUrl, name) {
        const r = await fetch('/api/assets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ src: dataUrl, name })
        });
        const result = await r.json().catch(() => null);
        if (!r.ok || !result || result.status !== 'ok') {
            throw new Error((result && result.message) || ('HTTP ' + r.status));
        }
        return result.url;
    },
});
