/**
 * ==========================================================================
 * MangaEditor 子模块：导出（2026-11-08 新增，ADR 079）
 * 作用：标题栏右上「导出」按钮 + 自绘菜单（复用 manga-file-menu 样式类，
 *       「文件」同款交互）——三个入口：
 *         1. 导出本页到画布：主类 _exportPageToCanvas（原有行为不变）；
 *         2. 导出本页到本地：整页所见即所得合成 PNG（白页底 + 图层栈，
 *            与舞台同一渲染口径 _drawPageLayers）→ 浏览器下载；
 *         3. 导出本项目到本地：全部页面逐页合成 PNG（用户拍板口径：
 *            所见即所得成书，不是工程文件备份）→ POST /api/manga-projects
 *            /export-zip → 后端 archiver 流式打包 → zip 下载。
 * 按页合成的关键点：_drawPageLayers 的层列表来自 _ensureDrawLayers()
 *       （绑 this.draft，不吃 page 参数）——渲染非活动页时临时换 draft
 *       引用再恢复（try/finally），并摘除调色/移除遮罩的渲染钩子与进行中
 *       笔迹，保证缩略图外任何页的合成与舞台同口径且零副作用。
 * 契约：原型混入（partial-class，ADR 026）——方法 Object.assign 进
 *       MangaEditor.prototype，this 即编辑器实例；须后于主类加载。
 * 对应：css/manga-editor.css（manga-export-wrap / manga-export-menu 段）。
 * ==========================================================================
 */

Object.assign(window.MangaEditor.prototype, {

    // ==================== 导出菜单（MangaDom._buildDom 调用） ====================

    _buildExportTools() {
        if (!this.exportPageBtn) return;
        this.exportMenuEl = this.dialog.querySelector('.manga-export-menu');
        if (!this.exportMenuEl) return;
        this.exportPageBtn.addEventListener('click', () => {
            this.exportMenuEl.hidden = !this.exportMenuEl.hidden;
        });
        document.addEventListener('mousedown', (e) => {
            if (this.exportMenuEl.hidden) return;
            // 放行按钮与菜单自身——只在点真正外部时收起。只查按钮的话，
            // mousedown 在菜单项上就把菜单 display:none 了，click 永远
            // 不会落在菜单项上，三个动作全部静默丢失（2026-11-08 用户
            // 实测踩中；文件菜单用的是 wrap 整体判断，同款教训）
            if (this.exportPageBtn.contains(e.target) || this.exportMenuEl.contains(e.target)) return;
            this.exportMenuEl.hidden = true;
        }, true);
        for (const item of this.exportMenuEl.querySelectorAll('.manga-export-item')) {
            item.addEventListener('click', () => {
                this.exportMenuEl.hidden = true;
                const act = item.dataset.act;
                if (act === 'canvas') this._exportPageToCanvas();
                else if (act === 'local') this._exportPageToLocal();
                else if (act === 'project') this._exportProjectToLocal();
            });
        }
    },

    // ==================== 整页合成（画布交付/本地图/项目 zip 三口共用） ====================

    /**
     * 等齐某页图层引用的图片加载（_awaitLayerImages 的按页变体——那个绑
     * this.draft）。加载完成或出错都放行（出错=该层暂缺图，合成时按层
     * 计缺口）；3s 超时兜底不挂死导出
     */
    async _awaitPageLayerImages(page) {
        const pending = [];
        for (const l of (Array.isArray(page.drawLayers) ? page.drawLayers : [])) {
            if (!l || !l.image || !l.image.src) continue;
            const img = this._ensureLayerImage(l.image.src);
            if (img.complete) continue;
            pending.push(new Promise((resolve) => {
                if (img.complete) { resolve(); return; }
                const done = () => { img.onload = null; img.onerror = null; resolve(); };
                img.onload = done;
                img.onerror = done;
                setTimeout(done, 3000);
            }));
        }
        return Promise.all(pending);
    },

    /**
     * 整页所见即所得合成：白页底 + 页面图层栈（与舞台同一渲染口径
     * _drawPageLayers，恒等变换草稿像素 1:1），返回 canvas。
     * _drawPageLayers 的层列表来自 _ensureDrawLayers()（绑 this.draft）——
     * 渲染非活动页期间临时换 draft 引用，并摘掉调色/移除遮罩渲染钩子与
     * 进行中笔迹（它们是编辑器视图态，不该进合成图），try/finally 恢复
     */
    async _composePageCanvas(page) {
        await this._awaitPageLayerImages(page);
        const prevDraft = this.draft;
        const prevAdjust = this._adjustPreview;
        const prevMask = this._removeMask;
        const prevStroke = this._stroke;
        this.draft = page;
        this._adjustPreview = null;
        this._removeMask = null;
        this._stroke = null;
        try {
            const cv = document.createElement('canvas');
            cv.width = page.width;
            cv.height = page.height;
            const g = cv.getContext('2d');
            g.fillStyle = '#ffffff';   // 页底白（舞台画幅底的同义实体化）
            g.fillRect(0, 0, page.width, page.height);
            this._drawPageLayers(g, (v) => v, (v) => v, 1, page);
            return cv;
        } finally {
            this.draft = prevDraft;
            this._adjustPreview = prevAdjust;
            this._removeMask = prevMask;
            this._stroke = prevStroke;
        }
    },

    // ==================== 下载工具 ====================

    /** 导出文件基础名：项目名（净化文件名非法字符），默认草稿回落「漫画」 */
    _exportBaseName() {
        return String(this.currentProjectName || '漫画')
            .replace(/[\\/:*?"<>|]+/g, '_').trim() || '漫画';
    },

    /** 浏览器下载一个 Blob（临时 URL 5s 后释放） */
    _downloadBlob(blob, filename) {
        const a = document.createElement('a');
        const url = URL.createObjectURL(blob);
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    },

    // ==================== 导出本页到本地 ====================

    /** 整页合成 PNG → 浏览器下载（文件名：项目名_第N页.png） */
    async _exportPageToLocal() {
        try {
            const cv = await this._composePageCanvas(this.draft);
            const blob = await new Promise((resolve, reject) => {
                cv.toBlob((b) => b ? resolve(b) : reject(new Error('PNG 编码失败')), 'image/png');
            });
            const name = `${this._exportBaseName()}_第${this.activePage + 1}页.png`;
            this._downloadBlob(blob, name);
            this._status(`已导出本页到本地：${name}`);
        } catch (err) {
            this._status('导出本页失败：' + ((err && err.message) || err), true);
        }
    },

    // ==================== 导出本项目到本地（全部页面合成图 zip） ====================

    /**
     * 全部页面逐页合成 PNG → 后端 /api/manga-projects/export-zip 流式打包
     * → zip 下载。逐页让出主线程刷状态栏进度；文件名 第01页.png 补零排序。
     * 不拦生成/AI 运行中（渲染是只读快照，各页按当下内容合成）
     */
    async _exportProjectToLocal() {
        const total = this.pages.length;
        const files = [];
        try {
            for (let i = 0; i < total; i++) {
                this._status(`正在渲染第 ${i + 1}/${total} 页…`);
                await new Promise((r) => setTimeout(r, 0));   // 让出主线程刷状态栏
                const cv = await this._composePageCanvas(this.pages[i]);
                const dataUrl = cv.toDataURL('image/png');
                files.push({
                    name: `第${String(i + 1).padStart(2, '0')}页.png`,
                    dataUrl
                });
            }
            const base = this._exportBaseName();
            this._status(`正在打包 ${total} 页…`);
            const r = await fetch('/api/manga-projects/export-zip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: base, files })
            });
            if (!r.ok) {
                const j = await r.json().catch(() => null);
                throw new Error((j && j.message) || ('HTTP ' + r.status));
            }
            const blob = await r.blob();
            const zipName = `${base}_页面.zip`;
            this._downloadBlob(blob, zipName);
            this._status(`已导出项目到本地：${zipName}（${total} 页）`);
        } catch (err) {
            this._status('导出项目失败：' + ((err && err.message) || err), true);
        }
    },
});
