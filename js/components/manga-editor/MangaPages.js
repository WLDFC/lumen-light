/**
 * ==========================================================================
 * MangaEditor 子模块：页面栏与多页文档操作（二期多页，自第八个混入）
 * 作用：最左 100px 页面栏——每页一个缩略图（页面比例底 + 元素框迷你色框 +
 *       页码，纯 canvas 绘制，与舞台同配色同 cid 配色规则），点击切页：
 *       this.draft 换引用 + 整面板重渲染，元素框/提示词/背景随页切换；
 *       栏底「＋ 新页」新建空白页（继承当前页画幅，插入当前页之后）与
 *       「清空」整本归零（原底栏「新建」迁入改名）；缩略图
 *       右键菜单（LumenContextMenu）：新建/复制此页/上移/下移/删除；
 *       Ctrl+PageUp / Ctrl+PageDown 切页。页面级操作走文档级历史快照
 *       （kind:'doc'，MangaHistory），内容编辑仍是页级（kind:'page'）。
 * 契约：原型混入（partial-class，ADR 026）——方法 Object.assign 进
 *       MangaEditor.prototype，this 即编辑器实例；须后于主类加载。
 *       rail DOM 与右键菜单实例存实例字段（railEl/railListEl/railCtxMenu）。
 * 对应：css/manga-editor.css（manga-rail 区段）；AI 写作进行中禁止切页
 *       （防异步回填落错页）。
 * ==========================================================================
 */

Object.assign(window.MangaEditor.prototype, {

    // ==================== 页面栏构建 ====================

    /** 页面栏：插在 manga-body 最左（左侧描述面板的左边），100px 竖栏 */
    _buildPageRail() {
        const rail = document.createElement('aside');
        rail.className = 'manga-rail';
        rail.innerHTML = `
            <div class="manga-rail-list"></div>
            <div class="manga-rail-actions">
                <button type="button" class="manga-rail-add" title="新建空白页（继承当前页画幅，插入当前页之后）">＋ 新页</button>
                <button type="button" class="manga-rail-clear" title="清空整本漫画重新开始（全部页面与已自动保存的内容会被覆盖，不可撤销）">清空</button>
            </div>
        `;
        this.bodyEl.insertBefore(rail, this.bodyEl.firstChild);
        this.railEl = rail;
        this.railListEl = rail.querySelector('.manga-rail-list');
        rail.querySelector('.manga-rail-add').addEventListener('click', () => this._addPage());
        rail.querySelector('.manga-rail-clear').addEventListener('click', () => this._clearDocument());
        this.railCtxMenu = new LumenContextMenu({ container: this.dialog });
        this.pageConfirmDialog = new LumenConfirmDialog({ container: this.dialog });
        this._thumbTimer = null;
        this._thumbBgCache = new Map();   // 缩略图背景图缓存（url → Image，见 _thumbBgImg）
        // Ctrl+PageUp / Ctrl+PageDown 切页（document 级，弹窗可见才响应；
        // 焦点守卫与历史快捷键同款——并排时面板内放行）
        document.addEventListener('keydown', (e) => {
            if (!this.visible) return;
            if (!(e.ctrlKey || e.metaKey)) return;
            if (e.key !== 'PageUp' && e.key !== 'PageDown') return;
            if (!this._histKeyOwns(e.target)) return;
            e.preventDefault();
            const target = e.key === 'PageUp' ? this.activePage - 1 : this.activePage + 1;
            if (this._switchPage(target)) this._status(`第 ${this.activePage + 1} 页`);
        });
        this._renderRail();
    },

    /** 页面栏整建：每页一个缩略图 + 页码角标；点击切页，右键菜单管理 */
    _renderRail() {
        if (!this.railListEl) return;
        this.railListEl.innerHTML = '';
        this.pages.forEach((page, i) => {
            const thumb = document.createElement('div');
            thumb.className = 'manga-page-thumb' + (i === this.activePage ? ' active' : '');
            thumb.title = `第 ${i + 1} 页（${page.items.length} 个元素）——右键管理页面`;
            const cv = document.createElement('canvas');
            const num = document.createElement('span');
            num.className = 'manga-page-num';
            num.textContent = String(i + 1);
            // 右上角删除 X（单页快删入口）：stopPropagation 防触发切页，
            // 点击走确认弹窗防误删（_confirmDeletePage）
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'manga-page-del';
            del.title = `删除第 ${i + 1} 页`;
            del.setAttribute('aria-label', `删除第 ${i + 1} 页`);
            del.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
            del.addEventListener('click', (e) => {
                e.stopPropagation();
                this._confirmDeletePage(i);
            });
            thumb.append(cv, num, del);
            thumb.addEventListener('click', () => this._switchPage(i));
            thumb.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this._openPageMenu(e.clientX, e.clientY, i);
            });
            this.railListEl.appendChild(thumb);
            this._drawPageThumb(cv, page);
        });
        const active = this.railListEl.children[this.activePage];
        if (active) active.scrollIntoView({ block: 'nearest' });
    },

    /** 内容编辑后的缩略图跟随：防抖 300ms 只重绘活动页（_invalidateCompiled 钩子） */
    _scheduleThumbRefresh() {
        if (!this.railListEl) return;
        clearTimeout(this._thumbTimer);
        this._thumbTimer = setTimeout(() => {
            this._thumbTimer = null;
            const thumb = this.railListEl.children[this.activePage];
            const cv = thumb && thumb.querySelector('canvas');
            if (cv) this._drawPageThumb(cv, this.draft);
        }, 300);
    },

    /**
     * 缩略图背景图缓存（url → Image）：背景引用是内容寻址资产 URL，
     * 同 url 恒同图可长期复用；未命中异步加载，onload 就绪后该缩略图
     * 仍在 DOM 时就地重绘（已被整建替换则跳过——重建路径会带缓存
     * 命中重画，不丢图）
     */
    _thumbBgImg(url, cv, page) {
        if (!this._thumbBgCache) this._thumbBgCache = new Map();
        let img = this._thumbBgCache.get(url);
        if (img) return img;
        img = new Image();
        img.onload = () => {
            if (cv.isConnected) this._drawPageThumb(cv, page);
        };
        img.src = url;
        this._thumbBgCache.set(url, img);
        return img;
    },

    /**
     * 页面缩略图：按页面比例铺底 + 元素框迷你色框（_colorFor 与舞台同源，
     * 同一框两处颜色一致）。宽度固定 64px（80px 栏 − 左右 padding 8×2），
     * 高按画幅比例、118px 封顶
     */
    _drawPageThumb(cv, page) {
        const W = 64;
        const MAXH = 118;
        const fit = Math.min(W / page.width, MAXH / page.height);
        const w = Math.max(24, Math.round(page.width * fit));
        const h = Math.max(24, Math.round(page.height * fit));
        const dpr = window.devicePixelRatio || 1;
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
        cv.style.width = w + 'px';
        cv.style.height = h + 'px';
        const ctx = cv.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(0, 0, w, h);
        const s = w / page.width;
        // 背景参考图（生成图/手动设置）：纸白垫底 + 铺满原图实显——缩略图
        // 是页面内容缩影，舞台的透显滑块是视图态不进缩略图（2026-11-04：
        // 生成图此前不进缩略图，用户看不出哪页已落图）
        if (page.background) {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            const bgImg = this._thumbBgImg(page.background, cv, page);
            if (bgImg && bgImg.complete && bgImg.naturalWidth) {
                ctx.drawImage(bgImg, 0, 0, w, h);
            }
        }
        // 图层迷你层（MangaLayers 混入）：可见笔迹层逐层画线；图片层画缓存
        // 里已就绪的图（未加载完跳过——onload 会触发舞台与面板刷新）；
        // 文字层按属性渲染文字预览；逐层不透明度与舞台同口径（_layerOpacity）
        const drawLayers = Array.isArray(page.drawLayers) ? page.drawLayers : [];
        if (drawLayers.length) {
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            for (const layer of drawLayers) {
                if (!layer || layer.visible === false) continue;
                ctx.save();
                ctx.globalAlpha = this._layerOpacity(layer);
                if (Array.isArray(layer.strokes)) {
                    for (const st of layer.strokes) {
                        const pts = st && st.points;
                        if (!Array.isArray(pts) || pts.length < 2) continue;
                        ctx.strokeStyle = st.color || '#ff5a5a';
                        ctx.lineWidth = Math.max(0.6, (st.width || 4) * s);
                        if (pts.length < 4) {
                            ctx.beginPath();
                            ctx.arc(pts[0] * s, pts[1] * s, Math.max(0.6, (st.width || 4) * s / 2), 0, Math.PI * 2);
                            ctx.fillStyle = ctx.strokeStyle;
                            ctx.fill();
                            continue;
                        }
                        ctx.beginPath();
                        ctx.moveTo(pts[0] * s, pts[1] * s);
                        for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] * s, pts[i + 1] * s);
                        ctx.stroke();
                    }
                } else if (layer.text && String(layer.text.content || '').trim()) {
                    // 文字层：页坐标 + 页缩放×text.scale 等比渲染（与舞台
                    // _drawTextLayer 同一原语，观感一致）
                    const layout = this._measureTextLayout(layer.text);
                    const ts = Number(layer.text.scale) || 1;
                    ctx.save();
                    ctx.translate(layer.text.x * s, layer.text.y * s);
                    ctx.scale(s * ts, s * ts);
                    this._drawTextContent(ctx, layer.text, layout);
                    ctx.restore();
                } else if (layer.shape) {
                    // 形状层（ADR 069）：页缩放矢量现画（与舞台同一原语，
                    // 观感一致；局部变量避让页缩放 s）
                    const sh = layer.shape;
                    ctx.save();
                    ctx.translate(layer.x * s, layer.y * s);
                    ctx.scale(s, s);
                    this._drawShapeContent(ctx, sh, 0, 0, sh.w, sh.h);
                    ctx.restore();
                } else if (layer.image && layer.image.src && this._layerImgCache) {
                    const entry = this._layerImgCache.get(layer.image.src);
                    const img = entry && entry.img;
                    if (img && img.complete && img.naturalWidth) {
                        const [x1, y1, x2, y2] = layer.image.bbox;
                        ctx.drawImage(img, x1 * s, y1 * s, (x2 - x1) * s, (y2 - y1) * s);
                    }
                }
                ctx.restore();
            }
        }
        page.items.forEach((item) => {
            if (this._hiddenCids && this._hiddenCids.has(item.cid)) return;   // 眼睛隐藏的框不画（视图态）
            const [x1, y1, x2, y2] = item.bbox;
            const id = Number.isInteger(item.cid) ? item.cid : 0;
            const color = this._colorFor(id);
            ctx.fillStyle = this._hexA(color, 0.16);
            ctx.fillRect(x1 * s, y1 * s, (x2 - x1) * s, (y2 - y1) * s);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.strokeRect(x1 * s + 0.5, y1 * s + 0.5,
                Math.max(1, (x2 - x1) * s - 1), Math.max(1, (y2 - y1) * s - 1));
        });
    },

    /** 页面右键菜单（基础款：新建/复制/上移/下移/删除；越界项不出现） */
    _openPageMenu(x, y, i) {
        const items = [
            { label: '新建页面（此后插入）', onClick: () => this._addPage(i + 1) },
            { label: '复制此页', onClick: () => this._copyPage(i) }
        ];
        if (i > 0) items.push({ label: '上移', onClick: () => this._movePage(i, -1) });
        if (i < this.pages.length - 1) items.push({ label: '下移', onClick: () => this._movePage(i, 1) });
        items.push({ label: '删除页面', danger: true, onClick: () => this._deletePage(i) });
        this.railCtxMenu.open({ x, y, items });
    },

    // ==================== 切页 ====================

    /**
     * 页面整体换血后的界面态重置（切页/删页/整本新建/历史回滚共用）：
     * 选中、折叠/眼睛视图态（按 cid 记忆，页内语义，页换即失效）、
     * 拖拽/连点/磁吸线、右栏输出框清空防串页。字段全部防御——vm 测试
     * 实例可能只有 draft
     */
    _resetForPageSwap() {
        this.selected = -1;
        this._abortTextEdit();   // 就地编辑框随页收起（正常已被 _switchPage 提交，此处兜底）
        if (this._collapsedCids) this._collapsedCids.clear();
        if (this._hiddenCids) this._hiddenCids.clear();
        this._clickBurst = null;
        this._drag = null;
        this._guides = [];
        // 图层选中态是页内状态（层 id 跨页无意义，MangaLayers 混入）
        this._activeLayerId = null;
        this._selLayerId = null;
        if (typeof this._ensureDefaultLayerSelection === 'function') this._ensureDefaultLayerSelection();   // 灯箱同语义：进页即有选中层
        this._stroke = null;
        // 舞台缩放/平移是页内视图态（各页画幅可能不同）：换页回自适应铺满
        this._zoom = 1;
        this._panX = 0;
        this._panY = 0;
        if (this.aiOutTa) {
            this.aiOutTa.value = '';
            this.jsonNote.textContent = '';
        }
        this._outMode = '';
        this.compiled = null;
        if (this.copyBtn) this.copyBtn.disabled = true;
        // 图层面板跟随换页（活动层/选中图片层已清，MangaLayers 混入）
        if (typeof this._renderLayerPanel === 'function') this._renderLayerPanel();
    },

    /**
     * 切换活动页：this.draft 换引用 + 整面板重渲染——元素框/提示词/背景
     * 全部随页切换。进行中的文字编辑与 AI 写作都先拦下：前者就地提交
     * （内容属当前页，换引用前落定），后者禁止切页（异步回填会落错页）
     */
    _switchPage(i) {
        if (!this.pages || i < 0 || i >= this.pages.length || i === this.activePage) return false;
        if (this.aiRunning) { this._status('AI 写提示词进行中，完成后再切页', true); return false; }
        if (this._textEdit) this._commitTextEdit();   // 防 this.draft 换引用后回填落错页
        this.activePage = i;
        this.draft = this.pages[i];
        this._resetForPageSwap();
        this._renderAll();
        this._syncPageBackgroundUi();
        this._renderRail();
        this._scheduleSave();   // active 序号也持久化
        return true;
    },

    /** 背景图元素对齐活动页（切页/回滚共用）：页有背景则加载，无则清空 */
    _syncPageBackgroundUi() {
        if (typeof this._loadBackgroundImg !== 'function') return;
        if (this.draft.background) {
            this._loadBackgroundImg(this.draft.background);
        } else if (this._bgImg || this._bgLoadedUrl) {
            this._bgImg = null;
            this._bgLoadedUrl = '';
            // 清掉旧页背景必须立即重绘：_switchPage 的 _renderAll 跑在本
            // 同步之前（画的是还挂着上一页背景的帧），不补绘舞台就滞留
            // 上一页的图像（2026-11-04 用户实测切页 2 仍见页 1 生成图）
            if (this.visible) this._renderStage();
        }
    },

    // ==================== 页面操作（文档级历史） ====================

    /**
     * 清空整本：全部页面归零为单页空白文档（原底栏「新建」迁入页面栏并
     * 改名「清空」）。自动保存覆盖旧文档且历史作废，故走确认弹窗防误触
     * （与删页同款 pageConfirmDialog，替换原底栏的裸 confirm）
     */
    async _clearDocument() {
        const ok = await this.pageConfirmDialog.confirm({
            title: '清空整本漫画？',
            note: '全部页面与已自动保存的内容会被覆盖，不可撤销',
            okText: '清空'
        });
        if (!ok) return;
        this.pages = [CoordinateLayout.createDraft()];
        this.activePage = 0;
        this.draft = this.pages[0];
        this._resetForPageSwap();     // 界面态全重置
        this._setBackground('');      // 背景参考图一并清除（草稿字段+舞台+悬浮条）
        this._resetHistory();         // 新基线：旧历史作废
        this._invalidateCompiled();   // 触发自动保存新文档
        this._renderAll();
        this._renderRail();
        this._status('已清空（新空白文档，1 页）');
    },

    /**
     * 删页入口（缩略图右上角 X）：最后一页直接拦下，其余弹确认框防误删。
     * i 是点击时刻的下标，确认期间页面列表可能已变——_deletePage 自带
     * 越界守卫兜底
     */
    async _confirmDeletePage(i) {
        if (this.pages.length <= 1) {
            this._status('至少保留一页（要空白页用右键「新建页面」后先建后删）', true);
            return;
        }
        const page = this.pages[i];
        const count = page ? page.items.length : 0;
        const ok = await this.pageConfirmDialog.confirm({
            title: `删除第 ${i + 1} 页？`,
            note: count > 0 ? `该页含 ${count} 个元素框与文案；误删可 Ctrl+Z 撤销` : '空页；误删可 Ctrl+Z 撤销',
            okText: '删除'
        });
        if (!ok) return;
        this._deletePage(i);
    },

    /** 新建空白页：继承当前页画幅，默认插在活动页之后（右键菜单可指定位置） */
    _addPage(at = this.activePage + 1) {
        const before = this._histSnapshotDoc();
        const page = CoordinateLayout.createDraft();
        page.width = this.draft.width;
        page.height = this.draft.height;
        this.pages.splice(at, 0, page);
        this._commitHistory(before, '新建页面');
        this._switchPage(at);
        this._status(`已新建第 ${at + 1} 页`);
    },

    /** 复制页面：深拷贝整页（含元素框/文案/背景引用），插入其后并切过去 */
    _copyPage(i) {
        if (!this.pages[i]) return;
        const before = this._histSnapshotDoc();
        const clone = JSON.parse(JSON.stringify(this.pages[i]));
        const at = i + 1;
        this.pages.splice(at, 0, clone);
        this._commitHistory(before, '复制页面');
        this._switchPage(at);
        this._status(`已复制为第 ${at + 1} 页`);
    },

    /** 删除页面：至少保留一页；活动页下标随删除收拢，视图态全重置 */
    _deletePage(i) {
        if (this.pages.length <= 1) {
            this._status('至少保留一页（要空白页用右键「新建页面」后先建后删）', true);
            return;
        }
        if (!this.pages[i]) return;
        const before = this._histSnapshotDoc();
        this.pages.splice(i, 1);
        if (this.activePage >= this.pages.length) this.activePage = this.pages.length - 1;
        else if (this.activePage > i) this.activePage--;
        this.draft = this.pages[this.activePage];
        this._commitHistory(before, '删除页面');
        this._resetForPageSwap();
        this._invalidateCompiled();   // 自动保存（缩略图刷新随之触发）
        this._renderAll();
        this._syncPageBackgroundUi();
        this._renderRail();
        this._status(`已删除第 ${i + 1} 页`);
    },

    /** 页面移动（dir: -1 上移 / +1 下移）：活动页跟随自身换位，内容不变 */
    _movePage(i, dir) {
        const j = i + dir;
        if (!this.pages[i] || j < 0 || j >= this.pages.length) return;
        const before = this._histSnapshotDoc();
        const [page] = this.pages.splice(i, 1);
        this.pages.splice(j, 0, page);
        if (this.activePage === i) this.activePage = j;
        else if (this.activePage === j) this.activePage = i;
        this._commitHistory(before, dir < 0 ? '页面上移' : '页面下移');
        this._renderRail();
        this._scheduleSave();
        this._status(`第 ${i + 1} 页已${dir < 0 ? '上移' : '下移'}`);
    },
});
