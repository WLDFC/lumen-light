/**
 * ==========================================================================
 * MangaEditor 子模块：背景参考图与生成图透显（自第七期新增）
 * 作用：舞台左上角悬浮工具条——「背景」下拉（本地上传…/从画布选择…/
 *       清除背景）+「生成图」开关（开着时最新生成的图自动替换为舞台
 *       背景参考）+ 背景不透明度滑块（有背景时才显示）。参考图铺满画幅
 *       半透明绘制在元素框下方，用于对照既有图参考布局描点位。
 * 契约：原型混入（partial-class，ADR 026）——方法 Object.assign 进
 *       MangaEditor.prototype，this 即编辑器实例；须后于主类加载。
 * 数据：
 *   - 背景引用存 draft.background（字符串 URL）——只存引用不存 base64：
 *     本地图/画布图/生成图统一经 POST /api/assets 内容寻址入库换稳定
 *     URL（重复图自动去重）；normalizeDraft 只认 /api/assets/ 前缀的
 *     引用（其余形态丢弃）；编译前 _draftForCompile 剥离（非 MOSS 契约）。
 *     背景变更不走 _invalidateCompiled（不影响编译产物），直接防抖保存。
 *   - 来源联动（2026-11-04 拍板）：可溯源的背景（从画布选择/生成图透显）
 *     另存 draft.backgroundSrcId=来源画布图 id——画布删除该图时联动清
 *     背景（lumenCanvasImageDeleted 事件）；本地上传为无源快照不联动。
 *   - 生成图透显开关已退役（2026-11-05 用户拍板：一切图像皆图层，不再
 *     自动设背景参考）。生成图事件监听保留，只为「生成」按钮的定点捕获
 *     （MangaGenerate._consumeGenCapture）服务。
 *   - 生成图事件源 lumenGeneratedImage（detail.src）：PlaceholderManager
 *     .replace（四类生成节点+面板链路的占位图替换收口）与 LumenSocket
 *     new-image 默认落图分支（免节点回流/桥接回流）两处派发。
 * 依赖：LumenDropdown（动作型菜单，底栏「写入」按钮同款交互）；
 *       ImageExport.toDataUrl / CanvasDelivery.getAssetPlan（画布图导出
 *       交付计划，与图片工具栏「添加到资产」同一条链路）。
 * 对应：css/manga-editor.css 舞台悬浮条段。
 * ==========================================================================
 */

Object.assign(window.MangaEditor.prototype, {

    // ==================== DOM 构建（由 MangaDom._buildDom 调用） ====================

    _buildBackgroundTools() {
        // 工具条挂窗口标题栏中部（标题组与右侧状态/关闭之间，30px 大行内
        // 放得下）——不占舞台空间，画幅再大也不被遮挡
        const wrap = this.stageCv.closest('.manga-stage-wrap') ||
            this.stageCv.parentElement;
        const header = this.dialog.querySelector('.recipe-dialog-header');
        if (!wrap || !header) return;

        // 工具条：背景下拉（手动参照用）。生成图开关与不透明度滑块均已
        // 退役（2026-11-05 用户拍板：生成落图层化后一切图像皆图层）
        const bar = document.createElement('div');
        bar.className = 'manga-bg-tools';
        bar.innerHTML = `
            <button type="button" class="manga-bg-btn" title="设置背景参考图：本地上传 / 从画布选择，铺满画幅显示，用于对照布局描点位">背景</button>
            <input type="file" class="manga-bg-file" accept="image/*" hidden>
        `;
        // 插在「文件」按钮右侧（2026-11-07 用户拍板两钮对调：文件贴标题，
        // 背景次之）；无文件按钮（理论不至）回落标题组紧右侧
        const fileWrap = header.querySelector('.manga-file-wrap');
        const titleGroup = header.querySelector('.recipe-dialog-title-group');
        if (fileWrap && fileWrap.nextSibling) header.insertBefore(bar, fileWrap.nextSibling);
        else if (titleGroup && titleGroup.nextSibling) header.insertBefore(bar, titleGroup.nextSibling);
        else header.appendChild(bar);
        this.bgBtn = bar.querySelector('.manga-bg-btn');
        this._bgFileEl = bar.querySelector('.manga-bg-file');

        // 画布选图面板（覆盖在舞台上的轻量浮层，单选即关）
        const picker = document.createElement('div');
        picker.className = 'manga-bg-picker';
        picker.hidden = true;
        picker.innerHTML = `
            <div class="manga-bg-picker-head">
                <span>选择画布图片作背景参考</span>
                <button type="button" class="manga-bg-picker-close" title="关闭">✕</button>
            </div>
            <div class="manga-bg-picker-grid"></div>
            <div class="manga-bg-picker-empty" hidden>画布上还没有图片</div>
        `;
        wrap.appendChild(picker);
        this._bgPickerEl = picker;
        picker.querySelector('.manga-bg-picker-close')
            .addEventListener('click', () => this._closeCanvasPicker());

        // 背景下拉改自绘菜单（2026-11-07 用户拍板：与「文件」同款文字按钮，
        // 去 caret；菜单壳复用 manga-file-menu 样式类）——动作三项（本地上
        // 传/从画布选择/清除背景[有背景时]），点开前刷新（清除项随草稿状态）
        this.bgMenuEl = document.createElement('div');
        this.bgMenuEl.className = 'manga-file-menu';
        this.bgMenuEl.hidden = true;
        this.bgBtn.after(this.bgMenuEl);
        this.bgBtn.addEventListener('click', () => {
            this._refreshBgMenu();
            this.bgMenuEl.hidden = !this.bgMenuEl.hidden;
        });
        document.addEventListener('mousedown', (e) => {
            if (this.bgMenuEl.hidden) return;
            if (bar.contains(e.target)) return;
            this.bgMenuEl.hidden = true;
        }, true);

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
    },

    // ==================== 背景下拉与选图面板 ====================

    _refreshBgMenu() {
        this.bgMenuEl.innerHTML = '';
        const mk = (label, icon, act) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'manga-file-item';
            b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>${label}`;
            b.addEventListener('click', () => {
                this.bgMenuEl.hidden = true;
                if (act === 'local') this._bgFileEl.click();
                else if (act === 'canvas') this._openCanvasPicker();
                else this._setBackground('');
            });
            this.bgMenuEl.append(b);
        };
        mk('本地上传…', '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line>', 'local');
        mk('从画布选择…', '<rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline>', 'canvas');
        if (this.draft.background) mk('清除背景', '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>', 'clear');
    },

    _openCanvasPicker() {
        const grid = this._bgPickerEl.querySelector('.manga-bg-picker-grid');
        const emptyEl = this._bgPickerEl.querySelector('.manga-bg-picker-empty');
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
        this._bgPickerEl.querySelector('.manga-bg-picker-grid').innerHTML = '';
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
            this._setBackground(url, obj.id);   // 记来源画布图 id：删图联动清背景
            this._status('已设为背景参考');
        } catch (err) {
            this._status('取图失败：' + (err && err.message ? err.message : err), true);
        }
    },

    // ==================== 背景状态与渲染 ====================

    /** 设背景（URL 引用或空串清除）：只动草稿引用字段，不碰编译产物。
     *  srcId=来源画布图 id（从画布选择/生成图透显可溯时记录，随草稿持久
     *  化）——画布上删除该图时联动清背景（lumenCanvasImageDeleted 事件，
     *  CanvasHistory.deleteObjects 派发）；本地上传无源不挂，退化为快照 */
    _setBackground(url, srcId) {
        url = (typeof url === 'string' && url.trim()) ? url.trim() : '';
        if (url) {
            this.draft.background = url;
            if (srcId) this.draft.backgroundSrcId = String(srcId);
            else delete this.draft.backgroundSrcId;
        } else {
            delete this.draft.background;
            delete this.draft.backgroundSrcId;
        }
        this._draftTouched = true;
        this._scheduleSave();      // 背景不影响编译，不走 _invalidateCompiled
        this._scheduleThumbRefresh();   // 缩略图画背景，落图/清图都要跟上
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
            this._status('背景图加载失败', true);
        };
        img.src = url;
    },

    /** 舞台渲染钩子（MangaStage._renderStage 在 clearRect 后调用）：
     *  参考图铺满画幅，全不透明画在元素框下方 */
    _drawBackground(ctx, X, Y, scale) {
        if (!this._bgImg) return;
        const d = this.draft;
        // 纸白垫底（2026-11-04）：透明 PNG 参照仍衬白底，与看图软件白底
        // 观感一致——不垫则透明区露出舞台 #141519 深底。背景恒全不透明
        // 绘制（2026-11-05 不透明度滑块退役：一切图像皆图层，调透明度走
        // 图层面板）
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(X(0), Y(0), d.width * scale, d.height * scale);
        ctx.drawImage(this._bgImg, X(0), Y(0), d.width * scale, d.height * scale);
    },

    // ==================== 画布删图联动清背景（2026-11-04 用户拍板） ====================

    /**
     * 画布图片删除事件监听：构造器即挂（幂等）——先删图后开编辑器的
     * 窗口期也能接住。事件由 CanvasHistory.deleteObjects 派发（剪切跳过，
     * redo 不重发——初次删除时引用已清）
     */
    _attachCanvasDeleteListener() {
        if (this._canvasDeleteListenerAttached) return;
        this._canvasDeleteListenerAttached = true;
        window.addEventListener('lumenCanvasImageDeleted', (e) => this._onCanvasImageDeleted(e));
    },

    /**
     * 源图被删 → 联动清背景：逐页清理匹配的 backgroundSrcId（背景是页内
     * 状态，其他页也可能引用同一张画布图）。撤销恢复图片不恢复背景
     * （拍板口径：清了就是清了，重设即可）；孤儿 URL（本地上传/快照）
     * 不受影响
     */
    _onCanvasImageDeleted(e) {
        const objs = (e && e.detail && e.detail.objs) || [];
        const ids = new Set(objs.map((o) => o && o.id).filter(Boolean));
        if (!ids.size || !Array.isArray(this.pages)) return;
        const clearedIdx = [];
        this.pages.forEach((page, i) => {
            if (page && page.backgroundSrcId && ids.has(page.backgroundSrcId)) {
                delete page.background;
                delete page.backgroundSrcId;
                clearedIdx.push(i);
            }
        });
        if (!clearedIdx.length) return;
        this._draftTouched = true;
        this._scheduleSave();
        // 缩略图含背景：被清的页逐张重画（活动页在其中的舞台也要跟上）
        if (this.railListEl) {
            for (const i of clearedIdx) {
                const thumb = this.railListEl.children[i];
                const cv = thumb && thumb.querySelector('canvas');
                if (cv) this._drawPageThumb(cv, this.pages[i]);
            }
        }
        if (clearedIdx.includes(this.activePage)) {
            this._bgImg = null;
            this._bgLoadedUrl = '';
            if (this.visible) this._renderStage();
            this._status('背景参考的源图已从画布删除，背景已清除');
        }
    },

    // ==================== 生成图回流捕获（透显开关已退役） ====================

    /**
     * 生成图事件监听：构造器即挂（不等首次 show）——页面刷新后先出图、
     * 后开编辑器的窗口期也能接住。幂等，重复调用不重复挂
     */
    _attachGeneratedImageListener() {
        if (this._genListenerAttached) return;
        this._genListenerAttached = true;
        window.addEventListener('lumenGeneratedImage', (e) => this._onGeneratedImage(e));
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
     * lumenGeneratedImage 事件：只服务「生成」按钮的定点捕获（MangaGenerate
     * 混入）——显式点生成的回流图收进提交时刻的页（落成图片图层）。
     * 原「生成图透显」开关已退役（2026-11-05 用户拍板：一切图像皆图层，
     * 不再自动设背景参考）
     */
    _onGeneratedImage(e) {
        const raw = e && e.detail && e.detail.src;
        const src = this._normalizeGenSrc(raw);
        if (!src) return;
        // 画布图对象随事件透传（PlaceholderManager 派发带 imageObj，免节点
        // 路径无）——生成捕获记到层上，保存写回时据此定位画布对应图
        const canvasImg = e && e.detail && e.detail.imageObj;
        if (this._consumeGenCapture && this._consumeGenCapture(src, canvasImg)) return;
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
