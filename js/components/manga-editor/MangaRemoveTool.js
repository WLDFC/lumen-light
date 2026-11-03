/**
 * ==========================================================================
 * MangaEditor 子模块：移除工具（2026-11-07 自灯箱 ImageStudio 移除模式迁移，
 * ADR 076）
 * ==========================================================================
 * 作用：左缘工具栏「移除」工具型按钮（图标同灯箱创可贴）→ 对当前选中
 *       图片层涂抹要移除的区域（红色遮罩），松手自动提交本地 LaMa 模型
 *       （POST /api/lama/remove，后端零改动复用）抹除并智能填充，结果
 *       烘焙换 src 写回该层（与橡皮烘焙/调色/抠图同口径，可撤销）。
 * 语义（对齐灯箱）：移除模式 = 遮罩涂抹 + 松手自动提交；推理中防重入；
 *       失败保留遮罩可继续涂改重试；切走工具 / 关编辑器 = 会话关闭，
 *       未提交遮罩丢弃（灯箱的"转回遮罩模式手动提交"在漫画无对应消费
 *       方——漫画没有遮罩局部重绘链路，故不保留）。
 * 与灯箱的结构差异（模型不同）：灯箱图层是位图 maskCv/paintCv；漫画图
 *       片层是 { image:{ src, fromSrc, bbox } } 远程引用——遮罩画布建在
 *       图片自然分辨率上，涂抹点从草稿像素按 bbox contain 等比映射进
 *       图片局部坐标（k = natW/(x2-x1)，先例 _doBakeErase）；舞台实时
 *       反馈走 host._removeMask = { layerId, cv } 预览钩子（_renderStage
 *       在图层栈上方叠画半透明红罩——舞台专属路径，不进缩略图/导出）。
 * 提交输入：底片 = 该层当前 src 位图（图片层上的画笔笔迹是 JSON 条目、
 *       仍会渲染在结果之上，不参与底片——组合天然正确）；遮罩 = 会话
 *       遮罩画布。两者同步定格成 data URL 后才发异步请求，切工具/关窗
 *       不影响在途任务（完成时按 layerId 重查落层）。
 * 契约：构造传宿主（host.xxx）；主类构造器 new MangaRemoveTool(this)；
 *       涂抹手势由 MangaGestures 按 activeTool==='remove' 路由（镜像画
 *       笔分支）；工具切换收口在 MangaTools._setTool（切走 close、切入
 *       open 守卫失败不切换）。索引加载序：主类之后。
 * ==========================================================================
 */

class MangaRemoveTool {
    /** 笔刷视觉倍率（灯箱 ImageStudio.SIZE_SCALE 同款）：滑杆值 × 此系数
     *  = 实际遮罩笔宽（草稿像素），光标圈同步乘它保持 1:1——对齐灯箱
     *  手感只改这一个数 */
    static SIZE_SCALE = 2;

    /** @param {Object} host - 宿主 MangaEditor 实例 */
    constructor(host) {
        this.host = host;
        this._open = false;     // 会话标记（勿命名 open——会遮蔽同名方法）
        this.layer = null;      // 移除中的目标图层
        this.maskCv = null;     // 遮罩画布（图片自然分辨率，红色不透明涂抹）
        this.width = 30;        // 遮罩笔宽滑杆值（1~40；实际笔宽 = 值 ×
                                // SIZE_SCALE，光标圈同径随动；粗细滑杆可调
                                // 并独立记忆 lumenLight.mangaRemoveWidth）
        this._stroke = null;    // 进行中涂抹 { points:[x,y,...], histSnap }
        this._removing = false; // LaMa 推理在途（防重入）
        this.busyShield = null; // 忙碌遮罩元素（推理期间盖住编辑器，复用不重建）
        this._hintTimer = 0;    // 模式提示语的自动清除句柄
        try {
            const saved = Number(localStorage.getItem('lumenLight.mangaRemoveWidth'));
            if (Number.isFinite(saved) && saved >= 1 && saved <= 40) this.width = saved;
        } catch { /* 隐私模式等 */ }
    }

    // ==================== 会话开关 ====================

    /**
     * 进入移除会话（MangaTools._setTool('remove') 消费）。
     * @returns {boolean} 守卫是否通过（false = 调用方不切换工具）
     */
    open() {
        const host = this.host;
        if (!host.visible) return false;
        // 目标 = 选中图片层（漫画图层模型里只有图片层是位图可抹，ADR 076）
        const layer = host._selLayerId != null ? host._layerById(host._selLayerId) : null;
        if (!layer || !layer.image || !layer.image.src) {
            host._status('移除：先在舞台或图层面板选中一个图片层', true);
            return false;
        }
        const img = host._ensureLayerImage(layer.image.src);
        if (!img.complete || !img.naturalWidth) {
            host._status('移除：图片尚未加载完成，稍后再试', true);
            return false;
        }
        if (this._open) this.close();          // 防重入：已开则先丢弃旧会话
        this.layer = layer;
        this._open = true;
        // 遮罩画布：图片自然分辨率（涂抹坐标经 bbox 等比映射，提交零换算）
        this.maskCv = document.createElement('canvas');
        this.maskCv.width = img.naturalWidth;
        this.maskCv.height = img.naturalHeight;
        host._removeMask = { layerId: layer.id, cv: this.maskCv };
        host._renderStage();
        host._status('移除模式：涂出要移除的区域，松手自动抹除');
        clearTimeout(this._hintTimer);
        this._hintTimer = setTimeout(() => {
            if (host.statusEl && String(host.statusEl.textContent || '').startsWith('移除模式')) {
                host._status('');
            }
        }, 3000);
        return true;
    }

    /** 关闭会话（切走工具 / 关编辑器）：未提交遮罩随钩子一并丢弃 */
    close() {
        if (!this._open) return;
        this._open = false;
        this._stroke = null;
        const host = this.host;
        if (host._removeMask && host._removeMask.cv === this.maskCv) host._removeMask = null;
        this.maskCv = null;
        this.layer = null;
        clearTimeout(this._hintTimer);
        this._hintTimer = 0;
        host._renderStage();
    }

    // ==================== 涂抹手势（MangaGestures 路由） ====================

    /**
     * 起笔：草稿坐标记点 + 拍历史快照（提交入账基准）；推理中忽略。
     * 会话失效自愈：hide()/切页等路径会把会话关掉（或让目标层随旧页
     * 失联）而 activeTool 仍停在 remove——此时涂抹若不重建会话就是纯
     * 静默（无红罩无提示无请求，2026-11-07 用户实测踩中）。起笔时核对
     * 会话在开且目标层仍在当前文档，失聪则对齐当前选中层重开
     */
    _strokeStart(px, py) {
        const host = this.host;
        if (!host._view) return;
        if (this._removing) {
            host._status('移除中…请等当前抹除完成');
            return;
        }
        if (!this._open || !this.layer || host._layerById(this.layer.id) !== this.layer) {
            if (!this.open()) return;
        }
        const p = host._toDraft(px, py);
        this._stroke = { points: [p.x, p.y], histSnap: host._histSnapshot() };
        this._paintDot(p.x, p.y);   // 单点即有反馈（点击=一个小涂抹）
    }

    /** 运笔：按草稿距离抽稀点列（照 _brushMove），线段即时画进遮罩画布 */
    _strokeMove(px, py) {
        if (!this._stroke) return;
        const p = this.host._toDraft(px, py);
        const pts = this._stroke.points;
        const dx = p.x - pts[pts.length - 2], dy = p.y - pts[pts.length - 1];
        if (dx * dx + dy * dy < 1) return;
        this._paintSegment(pts[pts.length - 2], pts[pts.length - 1], p.x, p.y);
        pts.push(p.x, p.y);
    }

    /** 收笔：空笔迹丢弃；否则同步定格输入并自动提交（灯箱同语义） */
    _strokeEnd() {
        const st = this._stroke;
        this._stroke = null;
        if (!st || !st.points.length) return;
        const host = this.host;
        const layer = this.layer;
        // 输入同步定格（data URL 在手才发异步——切工具/关窗不失效）
        let imageData, maskData;
        try {
            const img = host._ensureLayerImage(layer.image.src);
            if (!img.complete || !img.naturalWidth) throw new Error('图片未就绪');
            const base = document.createElement('canvas');
            base.width = img.naturalWidth;
            base.height = img.naturalHeight;
            base.getContext('2d').drawImage(img, 0, 0);
            imageData = base.toDataURL('image/png');
            maskData = this.maskCv.toDataURL('image/png');
        } catch (err) {
            host._status('移除失败：' + ((err && err.message) || err), true);
            return;
        }
        this._submit(layer, imageData, maskData, st.histSnap);
    }

    /** 笔迹作废（pointercancel/切工具）：不提交不记账 */
    _cancelStroke() {
        this._stroke = null;
    }

    // ==================== 提交与遮罩绘制 ====================

    /**
     * 忙碌遮罩（灯箱 _setBusy 同款迁移）：LaMa 推理期间盖住整个编辑器
     * ——画面轻压暗 + 中央应用蓝圆环转圈（不用系统 wait 光标，避免误
     * 以为卡死），挡住所有指针操作（按钮/滑杆/画布都点不动），防止推
     * 理途中改图层；键盘入口在 MangaDom 的 keydown 里单独守卫
     */
    _setBusy(on) {
        const host = this.host;
        if (on) {
            if (!this.busyShield) {
                this.busyShield = document.createElement('div');
                this.busyShield.className = 'manga-busy-shield';
                const spinner = document.createElement('div');
                spinner.className = 'manga-busy-spinner';
                this.busyShield.appendChild(spinner);
            }
            host._hideCursorRing && host._hideCursorRing();   // 光标圈别浮在转圈上
            host.dialog.appendChild(this.busyShield);
        } else if (this.busyShield) {
            this.busyShield.remove();
        }
    }

    /**
     * LaMa 提交（灯箱 removeMaskedArea 同契约）：POST /api/lama/remove
     * { imageData, maskData } → 结果入资产库换新引用写回 src → 历史入账
     * + 保存标脏 + 遮罩消费（清空画布供下一笔）。失败保留遮罩可重试；
     * 在途期间关会话/删层：完成时按 id 重查核对身份再落层。
     * 推理全程挂忙碌遮罩（转圈 + 拦截指针，灯箱同款）
     */
    async _submit(layer, imageData, maskData, histSnap) {
        const host = this.host;
        this._removing = true;
        this._setBusy(true);
        host._status('移除中…（本地模型推理，请稍候）');
        try {
            const resp = await fetch('/api/lama/remove', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imageData, maskData })
            });
            const j = await resp.json();
            if (j.status !== 'ok') throw new Error(j.message || '未知错误');
            const url = await host._uploadToAssets(j.image, `manga-remove-${Date.now()}.png`);
            const cur = host._layerById(layer.id);
            if (!cur || cur !== layer) {
                // 层已删/切页换文档：结果无处落地——明示而非静默
                //（旧版静默 return 会把状态栏永远钉在「移除中…」）
                host._status('移除结果未落地（目标图层已不存在）', true);
                return;
            }
            layer.image.src = url;               // fromSrc/bbox 不动（烘焙同口径）
            host._commitHistory(histSnap, 'AI移除');
            host._draftTouched = true;
            host._scheduleSave();
            host._scheduleThumbRefresh();
            host._renderLayerPanel();
            // 遮罩消费：成功即清空（后续新笔从净画布起，灯箱同口径）
            if (this._open && this.maskCv) {
                this.maskCv.getContext('2d').clearRect(0, 0, this.maskCv.width, this.maskCv.height);
            }
            host._status(`移除完成（${(j.cost / 1000).toFixed(1)}s，${j.provider}）`);
        } catch (err) {
            host._status('移除失败：' + ((err && err.message) || err), true);
        } finally {
            this._removing = false;
            this._setBusy(false);
            host._renderStage();
        }
    }

    /** bbox → 图片像素几何：k = natW/(x2-x1)（contain 等比，先例 _doBakeErase） */
    _imgGeom() {
        const img = this.host._ensureLayerImage(this.layer.image.src);
        const [x1, y1, x2] = this.layer.image.bbox;
        return { x1, y1, k: img.naturalWidth / Math.max(1, x2 - x1) };
    }

    _maskCtx() {
        const g = this.maskCv.getContext('2d');
        g.lineJoin = 'round';
        g.lineCap = 'round';
        g.strokeStyle = '#ff0000';   // 纯红全强度（后端只看 alpha>127，色相随意）
        g.fillStyle = '#ff0000';
        return g;
    }

    _paintDot(dx, dy) {
        const { x1, y1, k } = this._imgGeom();
        const g = this._maskCtx();
        g.beginPath();
        g.arc((dx - x1) * k, (dy - y1) * k,
            Math.max(1, this.width * MangaRemoveTool.SIZE_SCALE * k / 2), 0, Math.PI * 2);
        g.fill();
    }

    _paintSegment(x1d, y1d, x2d, y2d) {
        const { x1, y1, k } = this._imgGeom();
        const g = this._maskCtx();
        g.lineWidth = Math.max(1, this.width * MangaRemoveTool.SIZE_SCALE * k);
        g.beginPath();
        g.moveTo((x1d - x1) * k, (y1d - y1) * k);
        g.lineTo((x2d - x1) * k, (y2d - y1) * k);
        g.stroke();
    }
}

// 暴露到全局作用域（经典 script，MangaEditor.js 之后加载、构造器消费）
window.MangaRemoveTool = MangaRemoveTool;
