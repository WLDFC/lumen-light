/**
 * ==========================================================================
 * MangaEditor 子模块：调色工具（2026-11-07 自灯箱 StudioAdjustTool 迁移，
 * ADR 074）
 * ==========================================================================
 * 作用：左侧工具栏「调色」按钮（动作型，图标同灯箱）→ 浮动调色弹窗，对
 *       当前选中图片层做色彩调节。分两个 tab：光线（亮度/对比度/饱和度/
 *       色温）、质感（锐化/颗粒）；后续加新调色项 = 在 GROUPS/DEFS 配置表
 *       加一行定义 + 在 _processPipeline 补一段像素处理即可。
 * 语义：预览非破坏（打开时把图层图片拍成源分辨率快照，滑块实时把管线
 *       结果画进预览画布，舞台/缩略图经渲染钩子消费——与灯箱"直接写层
 *       画布"的差异点：漫画图层是 JSON 引用，预览期挂 host._adjustPreview
 *       = { layerId, cv }，_drawPageLayers/_paintLayerThumb 命中该层时改画
 *       预览画布）；关闭（× / 点外部 / 关编辑器）= 丢弃预览恢复原样；
 *       保存 = 烘焙应用（全分辨率管线 → /api/assets 换新引用写回
 *       layer.image.src，与橡皮烘焙/抠图同口径；旧 src 文件成为孤儿由
 *       保存归集/GC 收口）+ 历史快照可撤销。笔迹/文字/形状层不可调。
 * 管线：单遍循环 = 通道 LUT（亮度+对比度+色温）+ 饱和度颜色矩阵；
 *       锐化 = 3×3 非锐化掩模卷积（5-tap 盒模糊）；颗粒 = 固定噪声瓦片
 *       （拖动中噪声图案稳定不"沸腾"）。
 * 契约：构造时传入宿主 MangaEditor 实例（host.xxx）；主类保留 openAdjust
 *       薄代理（构造器 new MangaAdjustTool(this)）。索引加载序：主类之后。
 * ==========================================================================
 */

class MangaAdjustTool {
    /** 拖动中低清预览的长边上限（像素）：2K 级源图全分辨率跑一遍
     *  管线数百毫秒会卡死主线程——降到此档单帧 ~10ms，滑块全程流畅；
     *  停手 280ms 与保存时自动跑全分辨率补齐质量 */
    static PREVIEW_MAX = 1024;

    /** @param {Object} host - 宿主 MangaEditor 实例 */
    constructor(host) {
        this.host = host;
        this._open = false;         // 会话标记（勿命名 open——会遮蔽同名方法，
                                    // 灯箱曾因此点击调色按钮直接 TypeError 无响应）
        this.layer = null;          // 调色中的图层
        this.snapshot = null;       // 打开时的源分辨率快照（canvas，保存烘焙用）
        this.previewCv = null;      // 预览画布（渲染钩子消费，ADR 074）
        this.params = {};           // 当前参数 key → 数值
        this.tab = 'light';         // 当前 tab
        this._raf = 0;              // 低清预览的 rAF 句柄（节流）
        this._fullTimer = 0;        // 全分辨率精修的防抖句柄（停手后触发）
        this._outside = null;       // 点外部关闭监听
        this._noise = null;         // 颗粒噪声瓦片（固定种子，拖动中稳定）
        this._previewCv = null;     // 低清预览的降采样工作画布（复用）
        this._resultCv = null;      // 低清结果回填前的中转画布（复用）
        this._histSnap = null;      // 打开时的历史快照（保存入账基准）
    }

    // ==================== 调色项配置表 ====================

    /** tab 定义：id / 名称 / 图标（Lucide 线条风） */
    static TABS = [
        { id: 'light', name: '光线',
          icon: '<path d="M9 18h6"></path><path d="M10 22h4"></path><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2z"></path>' },
        { id: 'texture', name: '质感',
          icon: '<line x1="21" y1="4" x2="14" y2="4"></line><line x1="10" y1="4" x2="3" y2="4"></line><line x1="21" y1="12" x2="12" y2="12"></line><line x1="8" y1="12" x2="3" y2="12"></line><line x1="21" y1="20" x2="16" y2="20"></line><line x1="12" y1="20" x2="3" y2="20"></line><line x1="14" y1="2" x2="14" y2="6"></line><line x1="8" y1="10" x2="8" y2="14"></line><line x1="16" y1="18" x2="16" y2="22"></line>' }
    ];

    /** 调色项定义：范围/默认值/标签。新增项在这里加一行 */
    static DEFS = {
        brightness:  { min: -100, max: 100, def: 0, label: '亮度' },
        contrast:    { min: -100, max: 100, def: 0, label: '对比度' },
        saturation:  { min: -100, max: 100, def: 0, label: '饱和度' },
        temperature: { min: -100, max: 100, def: 0, label: '色温' },
        sharpen:     { min: 0, max: 100, def: 0, label: '锐化' },
        grain:       { min: 0, max: 100, def: 0, label: '颗粒' }
    };

    /** tab → 调色项清单 */
    static GROUPS = {
        light: ['brightness', 'contrast', 'saturation', 'temperature'],
        texture: ['sharpen', 'grain']
    };

    // ==================== 打开 / 关闭 ====================

    /** 打开调色弹窗（左侧工具栏按钮）：拍快照 → 构建弹窗 → 实时预览 */
    open() {
        const host = this.host;
        if (!host.visible) return;
        // 目标 = 选中图片层（漫画图层模型里只有图片层是位图可调，ADR 074）
        const layer = host._selLayerId != null ? host._layerById(host._selLayerId) : null;
        if (!layer || !layer.image || !layer.image.src) {
            host._status('调色：先在舞台或图层面板选中一个图片层', true);
            return;
        }
        const img = host._ensureLayerImage(layer.image.src);
        if (!img.complete || !img.naturalWidth) {
            host._status('调色：图片尚未加载完成，稍后再试', true);
            return;
        }
        if (this._open) this.close();          // 防重入：已开则先丢弃旧会话
        this.layer = layer;
        this._open = true;
        // 快照：源分辨率位图拷贝（保存烘焙的全分辨率基准；预览期不改层
        // 数据，丢弃零还原成本）
        this.snapshot = document.createElement('canvas');
        this.snapshot.width = img.naturalWidth;
        this.snapshot.height = img.naturalHeight;
        this.snapshot.getContext('2d').drawImage(img, 0, 0);
        // 预览画布：同尺寸，管线结果画这里（舞台/缩略图渲染钩子消费）。
        // 补 complete/naturalWidth/Height expando——消费点的"图片就绪"判据
        // 对 canvas 同样成立（Image 元素同名字段）
        this.previewCv = document.createElement('canvas');
        this.previewCv.width = img.naturalWidth;
        this.previewCv.height = img.naturalHeight;
        this.previewCv.complete = true;
        this.previewCv.naturalWidth = img.naturalWidth;
        this.previewCv.naturalHeight = img.naturalHeight;
        this.previewCv.getContext('2d').drawImage(this.snapshot, 0, 0);
        host._adjustPreview = { layerId: layer.id, cv: this.previewCv };
        for (const key of Object.keys(MangaAdjustTool.DEFS)) {
            this.params[key] = MangaAdjustTool.DEFS[key].def;
        }
        this.tab = 'light';
        this._histSnap = host._histSnapshot();
        this._buildDom();
        // 调色期间禁止涂画干扰预览：临时切到选择工具（走 _setTool 同步
        // 按钮态与光标），关闭/保存时恢复进入前的工具
        this._prevTool = host.activeTool || 'select';
        host._setTool('select');
        host.adjustBtn?.classList.add('is-active');
        this._renderStageFromPreview();
        // 点弹窗外 = 丢弃关闭（下一帧挂监听，避开本次打开的点击事件）。
        // 放行名单：弹窗内部 / 调色按钮 / 弹窗内一切子元素（含保存按钮——
        // mousedown 捕获先于 click，漏放行会导致点保存先被 close 拆窗、
        // 随后 save() 因会话已摘而静默退出，表现为「保存没反应」）
        setTimeout(() => {
            this._outside = (e) => {
                if (!this._open) return;
                if (this.panelEl?.contains(e.target)) return;
                if (e.target === host.adjustBtn || host.adjustBtn?.contains(e.target)) return;
                this.close();
            };
            document.addEventListener('mousedown', this._outside, true);
        }, 0);
    }

    /** 关闭弹窗。discard=true 丢弃预览（预览钩子随摘，舞台/缩略图自然
     *  还原）；save() 走自己的收尾（内容已烘焙换 src） */
    close(discard = true) {
        if (!this._open) return;
        this._open = false;
        const host = this.host;
        if (discard && this.previewCv) {
            host._adjustPreview = null;
            host._renderStage();
            host._scheduleThumbRefresh();
        }
        this._teardown();
    }

    /** 保存 = 烘焙应用：全分辨率管线 → 入资产库换新引用写回 src，
     *  历史快照可撤销（草稿落盘仍走显式保存，ADR 072） */
    async save() {
        if (!this._open || !this.layer) return;
        const host = this.host;
        const layer = this.layer;
        const prevTool = this._prevTool;
        // 摘会话标记先行（此后本对象上的 rAF/定时器回调全部自失效），
        // 再做全分辨率精修与收尾
        this._open = false;
        clearTimeout(this._fullTimer);
        this._fullTimer = 0;
        cancelAnimationFrame(this._raf);
        this._raf = 0;
        if (this._outside) {
            document.removeEventListener('mousedown', this._outside, true);
            this._outside = null;
        }
        // 全分辨率精修（快照/预览画布引用仍在手上；摘标后 _schedulePreview
        // 的回调已自失效，此处显式放行最后一次渲染保证烘焙质量）
        this._renderPreview(true);
        try {
            const dataUrl = this.previewCv.toDataURL('image/png');
            const url = await host._uploadToAssets(dataUrl, `manga-adjust-${Date.now()}.png`);
            layer.image.src = url;   // fromSrc 不动（与橡皮烘焙同口径）
            host._commitHistory(this._histSnap, '调色');
            host._draftTouched = true;
            host._scheduleSave();
            host._status('调色已应用');
        } catch (err) {
            // 上传失败：预览态保留在舞台上（钩子还在），用户可重试保存或关闭丢弃
            this._open = true;
            this._rearmOutside();
            host._status('调色保存失败：' + ((err && err.message) || err), true);
            return;
        }
        host._adjustPreview = null;   // 摘预览钩子（新 src 走正常加载渲染）
        this._teardown();
        host._scheduleThumbRefresh();
        host._renderLayerPanel();
        host._renderStage();
    }

    /** 会话拆窗公共收尾（close/save 成功路径共用；save 失败路径不调——
     *  预览钩子和面板都须留在原地） */
    _teardown() {
        const host = this.host;
        this.layer = null;
        this.snapshot = null;
        this.previewCv = null;
        this._histSnap = null;
        cancelAnimationFrame(this._raf);
        this._raf = 0;
        clearTimeout(this._fullTimer);
        this._fullTimer = 0;
        if (this._outside) {
            document.removeEventListener('mousedown', this._outside, true);
            this._outside = null;
        }
        this.panelEl?.remove();
        this.panelEl = null;
        host._adjustPreview = null;
        host.adjustBtn?.classList.remove('is-active');
        // 恢复进入调色前的工具（异常时回落选择工具）
        host._setTool(this._prevTool || 'select');
    }

    /** 保存失败回到会话态后重挂点外部关闭监听（原监听已摘） */
    _rearmOutside() {
        const host = this.host;
        setTimeout(() => {
            if (!this._open) return;
            this._outside = (e) => {
                if (!this._open) return;
                if (this.panelEl?.contains(e.target)) return;
                if (e.target === host.adjustBtn || host.adjustBtn?.contains(e.target)) return;
                this.close();
            };
            document.addEventListener('mousedown', this._outside, true);
        }, 0);
    }

    /** 预览画布就绪后的舞台刷新（初始基线与每次渲染共用） */
    _renderStageFromPreview() {
        this.host._renderStage();
        this.host._scheduleThumbRefresh();
    }

    // ==================== 弹窗 DOM ====================

    _buildDom() {
        const host = this.host;
        const panel = document.createElement('div');
        panel.className = 'manga-adjust';

        // 标题行：调色 | 重置 | 关闭（Lucide 图标，与项目线条风一致）
        const head = document.createElement('div');
        head.className = 'manga-adjust-head';
        const title = document.createElement('span');
        title.className = 'manga-adjust-title';
        title.textContent = '调色';
        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'manga-adjust-icon-btn';
        resetBtn.title = '重置：全部参数归零（保持调色中）';
        resetBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>`;
        resetBtn.addEventListener('click', () => this._reset());
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'manga-adjust-icon-btn';
        closeBtn.title = '关闭（丢弃本次调色，恢复原图）';
        closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
        closeBtn.addEventListener('click', () => this.close());
        head.append(title, resetBtn, closeBtn);

        // tab 行：光线 / 质感（分段按钮，同横竖排切换样式）
        const tabs = document.createElement('div');
        tabs.className = 'manga-adjust-tabs';
        this._tabBtns = {};
        for (const t of MangaAdjustTool.TABS) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'manga-adjust-tab' + (t.id === this.tab ? ' active' : '');
            btn.title = t.name;
            btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg><span>${t.name}</span>`;
            btn.addEventListener('click', () => {
                if (this.tab === t.id) return;
                this._tabBtns[this.tab]?.classList.remove('active');
                this.tab = t.id;
                btn.classList.add('active');
                this._syncTabBody();
            });
            this._tabBtns[t.id] = btn;
            tabs.append(btn);
        }

        // 滑块区：两 tab 各一份（切 tab 只做显隐，保参数态）
        this._rows = {};
        this._tabBodies = {};
        for (const t of MangaAdjustTool.TABS) {
            const body = document.createElement('div');
            body.className = 'manga-adjust-body';
            body.style.display = t.id === this.tab ? '' : 'none';
            for (const key of MangaAdjustTool.GROUPS[t.id]) {
                body.append(this._buildRow(key));
            }
            this._tabBodies[t.id] = body;
        }

        // 底部：提示文字 + 保存（主按钮强调蓝）
        const foot = document.createElement('div');
        foot.className = 'manga-adjust-foot';
        const hint = document.createElement('span');
        hint.className = 'manga-adjust-hint';
        hint.textContent = '保存后生效，可撤销';
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'manga-adjust-save';
        saveBtn.textContent = '保存';
        saveBtn.addEventListener('click', () => this.save());
        foot.append(hint, saveBtn);

        panel.append(head, tabs, this._tabBodies.light, this._tabBodies.texture, foot);
        host.dialog.appendChild(panel);
        this.panelEl = panel;
        // 锚在调色按钮右侧（2026-11-07 用户拍板：面板在按钮右方弹出）：
        // 按钮屏幕坐标换算进弹窗（fixed 全屏）内；top 越界下钳防溢出底缘。
        // 全程防御（vm 测试宿主无 rect/offsetHeight 时静默跳过定位）
        const br = host.adjustBtn && typeof host.adjustBtn.getBoundingClientRect === 'function'
            ? host.adjustBtn.getBoundingClientRect() : null;
        const dr = host.dialog && typeof host.dialog.getBoundingClientRect === 'function'
            ? host.dialog.getBoundingClientRect() : null;
        if (br && dr && br.width) {
            panel.style.left = Math.round(br.right - dr.left + 8) + 'px';
            const maxTop = dr.height - (panel.offsetHeight || 0) - 12;
            const top = Math.max(12, Math.min(br.top - dr.top, maxTop));
            if (Number.isFinite(top)) panel.style.top = Math.round(top) + 'px';
        }
    }

    /** 构建单个滑块行：标签+数值输入框 一行，滑块整行。
     *  数值框双通道：滑块拖动写入输入框，手动键入也回推滑块并刷新预览 */
    _buildRow(key) {
        const def = MangaAdjustTool.DEFS[key];
        const row = document.createElement('div');
        row.className = 'manga-adjust-row';
        const line = document.createElement('div');
        line.className = 'manga-adjust-row-line';
        const label = document.createElement('span');
        label.textContent = def.label;
        const input = document.createElement('input');
        input.type = 'range';
        input.min = def.min;
        input.max = def.max;
        input.step = 1;
        input.value = def.def;
        // 数值输入框：键入 → 钳制回填滑块与自身 → 预览；失焦/回车提交
        const num = document.createElement('input');
        num.type = 'number';
        num.className = 'manga-adjust-num';
        num.min = def.min;
        num.max = def.max;
        num.step = 1;
        num.value = def.def;
        num.title = `输入 ${def.min} ~ ${def.max}`;
        const applyNum = () => {
            // 非法/越界输入钳回合法值并回写输入框（空串回落默认 0 语义：
            // 取当前参数，滑块与框保持一致）
            let v = Math.round(Number(num.value));
            if (!Number.isFinite(v)) v = this.params[key] ?? def.def;
            v = Math.min(def.max, Math.max(def.min, v));
            num.value = String(v);
            input.value = String(v);
            this.params[key] = v;
            row.classList.toggle('changed', v !== def.def);
            this._schedulePreview();
        };
        num.addEventListener('change', applyNum);          // 失焦/回车提交
        num.addEventListener('input', () => {
            // 键入中实时跟（合法数值即刷预览，不必等失焦——手感同拖滑块）
            const v = Math.round(Number(num.value));
            if (Number.isFinite(v) && v >= def.min && v <= def.max) {
                input.value = String(v);
                this.params[key] = v;
                row.classList.toggle('changed', v !== def.def);
                this._schedulePreview();
            }
        });
        input.addEventListener('input', () => {
            this.params[key] = Number(input.value);
            num.value = input.value;                       // 滑动 → 同步输入框
            row.classList.toggle('changed', Number(input.value) !== def.def);
            this._schedulePreview();
        });
        line.append(label, num);
        row.append(line, input);
        this._rows[key] = { input, val: num };
        return row;
    }

    /** tab 内容显隐切换 */
    _syncTabBody() {
        for (const [id, body] of Object.entries(this._tabBodies)) {
            body.style.display = id === this.tab ? '' : 'none';
        }
    }

    /** 重置：全部归零（含隐藏 tab 的滑块与输入框）并刷新预览 */
    _reset() {
        for (const key of Object.keys(MangaAdjustTool.DEFS)) {
            const def = MangaAdjustTool.DEFS[key];
            this.params[key] = def.def;
            const row = this._rows[key];
            if (row) {
                row.input.value = def.def;
                row.val.value = String(def.def);           // 数值输入框
                row.input.closest('.manga-adjust-row').classList.remove('changed');
            }
        }
        this._schedulePreview();
    }

    // ==================== 预览与像素处理 ====================

    /** 调度一次预览渲染（rAF 节流）：拖动中每帧跑低清快预览，
     *  停手 280ms 后自动跑一次全分辨率精修（最终所见即所得） */
    _schedulePreview() {
        if (!this._open || !this.layer) return;
        if (this._raf) return;
        this._raf = requestAnimationFrame(() => {
            this._raf = 0;
            this._renderPreview(false);
            clearTimeout(this._fullTimer);
            this._fullTimer = setTimeout(() => {
                this._fullTimer = 0;
                this._renderPreview(true);
            }, 280);
        });
    }

    /**
     * 快照 → 处理管线 → 写进预览画布（渲染钩子消费，ADR 074）。
     * @param {boolean} full - false=拖动中的低清快预览（长边压到
     *   PREVIEW_MAX，单帧 ~10ms 保证滑块流畅）；true=全分辨率
     *   （停顿精修与保存烘焙用，慢但只在停止操作时跑一次）
     */
    _renderPreview(full = false) {
        if (!this.layer || !this.snapshot || !this.previewCv) return;
        let pw = this.snapshot.width;
        let ph = this.snapshot.height;
        let srcData = null;
        if (!full) {
            const scale = Math.min(1, MangaAdjustTool.PREVIEW_MAX / Math.max(pw, ph));
            if (scale < 1) {
                pw = Math.max(1, Math.round(pw * scale));
                ph = Math.max(1, Math.round(ph * scale));
                // 降采样源：快照缩小画进临时画布再取像素
                if (!this._previewCv) this._previewCv = document.createElement('canvas');
                const pc = this._previewCv;
                pc.width = pw; pc.height = ph;
                const pg = pc.getContext('2d');
                pg.imageSmoothingEnabled = true;
                pg.imageSmoothingQuality = 'high';
                pg.drawImage(this.snapshot, 0, 0, pw, ph);
                srcData = pg.getImageData(0, 0, pw, ph);
            }
        }
        if (!srcData) {
            srcData = this.snapshot.getContext('2d')
                .getImageData(0, 0, pw, ph);
        }
        const out = this._processPipeline(srcData, this.params);
        if (pw === this.previewCv.width && ph === this.previewCv.height) {
            this.previewCv.getContext('2d').putImageData(out, 0, 0);
        } else {
            // 低清结果经临时画布放大回填（双线性插值，拖动中视觉平滑；
            // 全分辨率精修会在停顿后覆盖掉这次放大）
            if (!this._resultCv) this._resultCv = document.createElement('canvas');
            const rc = this._resultCv;
            rc.width = pw; rc.height = ph;
            rc.getContext('2d').putImageData(out, 0, 0);
            const g = this.previewCv.getContext('2d');
            g.imageSmoothingEnabled = true;
            g.imageSmoothingQuality = 'high';
            g.clearRect(0, 0, this.previewCv.width, this.previewCv.height);
            g.drawImage(rc, 0, 0, this.previewCv.width, this.previewCv.height);
        }
        this._renderStageFromPreview();
    }

    /**
     * 像素处理管线：LUT（亮度+对比度+色温）+ 饱和度 → 锐化卷积 → 颗粒。
     * 顺序对齐主流修图软件：先全局色调，再细节增强，最后加噪
     * @param {ImageData} src - 快照像素
     * @param {Object} p - 参数表 {brightness, contrast, saturation, temperature, sharpen, grain}
     * @returns {ImageData} 处理结果（新对象，不改输入）
     */
    _processPipeline(src, p) {
        const w = src.width;
        const h = src.height;
        const out = new ImageData(new Uint8ClampedArray(src.data), w, h);
        const d = out.data;

        // ---- 第一遍：通道 LUT（亮度/对比度/色温）+ 饱和度颜色矩阵 ----
        // 亮度：加法偏移 ±128 满幅；对比度：128 点线性拉伸；
        // 色温：暖 +R/-B，冷 -R/+B（绿通道不动）
        const cf = 1 + p.contrast / 100;                     // 对比度系数 0~2
        const bOff = p.brightness * 1.28;                    // 亮度偏移 ±128
        const tOff = p.temperature * 0.5;                    // 色温偏移 ±50
        const lutR = new Float32Array(256);
        const lutG = new Float32Array(256);
        const lutB = new Float32Array(256);
        for (let i = 0; i < 256; i++) {
            const v = (i + bOff - 128) * cf + 128;
            lutR[i] = v + tOff;
            lutG[i] = v;
            lutB[i] = v - tOff;
        }
        const sat = 1 + p.saturation / 100;                  // 饱和度系数 0~2
        const doSat = p.saturation !== 0;
        for (let i = 0; i < d.length; i += 4) {
            let r = lutR[d[i]];
            let g = lutG[d[i + 1]];
            let b = lutB[d[i + 2]];
            if (doSat) {
                // 颜色矩阵：v = 灰度 + (v - 灰度) × sat（Rec.601 亮度权值）
                const luma = 0.299 * r + 0.587 * g + 0.114 * b;
                r = luma + (r - luma) * sat;
                g = luma + (g - luma) * sat;
                b = luma + (b - luma) * sat;
            }
            d[i] = r;
            d[i + 1] = g;
            d[i + 2] = b;
        }

        // ---- 第二遍：锐化（非锐化掩模：原像素 + 强度 × (原 − 模糊)）----
        // 模糊 = 半径 2 的可分离 5-tap 盒模糊（水平→垂直两趟）。曾用半径 1
        // 十字核——线性渐变坡上「中心 = 邻域均值」恒成立，锐化量恒为 0，
        // 真实图像的抗锯齿边缘全是 2-4px 宽的坡，表现为滑块拉满也看不见；
        // 半径 2 盖住这类坡宽，任何非平坦区域都有效。只跑一遍、边缘像素
        // 按钳位索引取值（平坦区模糊 = 原值，天然不受影响）
        if (p.sharpen > 0) {
            const a = (p.sharpen / 100) * 2;                 // 锐化强度 0~2
            const srcCopy = new Uint8ClampedArray(d);        // 卷积基于处理前像素
            const w4 = w * 4;
            // 水平 5-tap 盒模糊 → tmp（通道包含 alpha 但只消费 RGB，多算
            // 无妨；x 向钳位取边界像素）
            const tmp = new Uint8ClampedArray(d.length);
            for (let y = 0; y < h; y++) {
                const row = y * w4;
                for (let x = 0; x < w; x++) {
                    const xl = (x > 1 ? x - 2 : 0) * 4;
                    const x1 = (x > 0 ? x - 1 : 0) * 4;
                    const xr = (x < w - 1 ? x + 1 : w - 1) * 4;
                    const xr2 = (x < w - 2 ? x + 2 : w - 1) * 4;
                    const i = row + x * 4;
                    for (let c = 0; c < 3; c++) {
                        tmp[i + c] = (srcCopy[row + xl + c] + srcCopy[row + x1 + c] +
                            srcCopy[i + c] + srcCopy[row + xr + c] +
                            srcCopy[row + xr2 + c]) / 5;
                    }
                }
            }
            // 垂直 5-tap（y 向钳位）得模糊值，立即应用非锐化掩模
            for (let y = 0; y < h; y++) {
                const yl = (y > 1 ? y - 2 : 0) * w4;
                const y1 = (y > 0 ? y - 1 : 0) * w4;
                const yrRow = y < h - 1 ? (y + 1) * w4 : (h - 1) * w4;
                const yr2Row = y < h - 2 ? (y + 2) * w4 : (h - 1) * w4;
                const row = y * w4;
                for (let x = 0; x < w; x++) {
                    const x4 = x * 4;                 // 列基址（行偏移由 yl/y1/... 提供）
                    const i = row + x4;
                    for (let c = 0; c < 3; c++) {
                        const blur = (tmp[yl + x4 + c] + tmp[y1 + x4 + c] +
                            tmp[i + c] + tmp[yrRow + x4 + c] +
                            tmp[yr2Row + x4 + c]) / 5;
                        d[i + c] = srcCopy[i + c] + (srcCopy[i + c] - blur) * a;
                    }
                }
            }
        }

        // ---- 第三遍：颗粒（固定噪声瓦片，拖动中图案稳定不沸腾）----
        if (p.grain > 0) {
            if (!this._noise) this._noise = this._buildNoiseTile();
            const N = this._noise;                            // 128×128 噪声瓦片
            const amp = p.grain * 0.9;                        // 最大幅度 ±45
            for (let y = 0; y < h; y++) {
                const row = (y % 128) * 128;
                for (let x = 0; x < w; x++) {
                    const n = N[row + (x % 128)] * amp;
                    const i = (y * w + x) * 4;
                    d[i] += n;
                    d[i + 1] += n;
                    d[i + 2] += n;
                }
            }
        }
        return out;
    }

    /** 构建 128×128 单色噪声瓦片（值域 -0.5~0.5，固定种子可复现）*/
    _buildNoiseTile() {
        const tile = new Float32Array(128 * 128);
        // mulberry32 固定种子：同一会话内瓦片恒定，预览不闪烁
        let s = 0x9e3779b9;
        const rand = () => {
            s |= 0; s = (s + 0x6d2b79f5) | 0;
            let t = Math.imul(s ^ (s >>> 15), 1 | s);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        for (let i = 0; i < tile.length; i++) tile[i] = rand() - 0.5;
        return tile;
    }
}

// 暴露到全局作用域（经典 script，MangaEditor.js 之后加载、构造器消费）
window.MangaAdjustTool = MangaAdjustTool;
