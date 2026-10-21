/**
 * ==========================================================================
 * LumenLight 聚集区控制器（CollectZone）
 * ==========================================================================
 * 作用：画布聚集功能的跨文件接线层。聚集本体是编组（GroupManager 组
 *       对象的 collect 字段，全局至多一个），本组件不持有区域状态，
 *       只负责三件事：
 *   1. 落点路由：PlaceholderManager.create 生成占位图前询问本组件——
 *      聚集区启用时统一落入区内槽位（CollectSlotLayout 纯函数计算），
 *      放不下按原始尺寸落编组位置级联避让（不缩放不裁切）；
 *   2. 落图通知：真实图 replace 落定后回调——聚集区不在视口内时弹
 *      可点击轻提示，点击用 fitToBounds 聚焦（与画布「自适应屏幕」
 *      同款），解决「缩放画布做别的事后不知新图在哪」的原始痛点；
 *   3. 唯一性口子的查询面：开关联动与撤销记账在 GroupManager.setCollect，
 *      存档归一在 GroupManager.normalizeCollectGroups，本组件只消费。
 *
 * 装配：Canvas 构造时创建并挂 this.canvas.collectZone（PlaceholderManager
 * 经画布实例访问）；app.js 时序下所有 defer 脚本先于画布构造执行，
 * 类定义必然就绪。
 * ==========================================================================
 */

class CollectZone {
    /** 槽位/级联最小间距（世界坐标），与占位图级联间距 40 同量级 */
    static SLOT_GAP = 24;
    /** 轻提示自动淡出时长（可点击提示比纯告知的撤销 toast 更久） */
    static TOAST_MS = 3500;

    /**
     * 构造函数
     * @param {Object} canvas - 画布主类实例
     */
    constructor(canvas) {
        this.canvas = canvas;
        this._toastEl = null;      // 轻提示单元素复用（懒建）
        this._toastTimer = null;
        this._toastCount = 0;      // 提示存活期间累计落图数
        this._toastGroup = null;   // 提示对应的聚集编组（点击聚焦用）
    }

    /**
     * 当前聚集编组（全局至多一个；由 GroupManager.setCollect 与存档
     * 归一保证不变量，这里不做纠偏）
     * @returns {Object|null}
     */
    getGroup() {
        const groups = this.canvas.groups ? this.canvas.groups.groups : [];
        return groups.find(g => g.collect) || null;
    }

    /**
     * 占位图落点路由：聚集区启用时返回区内落点，未启用返回 null
     * （调用方走默认落点）。槽位扫描范围 = 编组矩形扣除标题栏
     * （标题栏画在组矩形内部，槽位避开）；放不下回落编组位置级联，
     * 两条路径都保证与画布现有对象不重叠
     * @param {number} width - 占位图宽（预期产出尺寸）
     * @param {number} height - 占位图高
     * @returns {{x,y}|null}
     */
    resolveSpawnPosition(width, height) {
        const group = this.getGroup();
        if (!group) return null;
        const occupied = this.canvas.images.images.map(img => ({
            x: img.x, y: img.y, width: img.width, height: img.height
        }));
        const metrics = GroupManager.getTitleMetrics(group);
        const inner = {
            x: group.x,
            y: group.y + metrics.height,
            width: group.width,
            height: group.height - metrics.height
        };
        const slot = CollectSlotLayout.findSlot(
            inner, occupied, { width, height }, CollectZone.SLOT_GAP
        );
        if (slot) return slot;
        // 放不下（图比编组大 / 区内已满）：按原始尺寸落编组位置级联避让
        return CollectSlotLayout.cascade(
            { x: group.x, y: group.y }, occupied, { width, height }, CollectZone.SLOT_GAP
        );
    }

    /**
     * 真实图落定通知（PlaceholderManager.replace 成功路径调用）：
     * 聚集区可见时不打扰；不可见时弹可点击轻提示
     * @param {Object} [_imageObj] - 落定的真实图片对象（预留，暂不消费）
     */
    notifyLanded(_imageObj) {
        const group = this.getGroup();
        if (!group) return;
        if (this._zoneVisible(group)) return;
        this._showToast(group);
    }

    /**
     * 聚集区是否（部分）在视口内：任一角落在画布可视范围即算可见。
     * canvasToScreen 返回画布元素内坐标（与 GroupToolbar 定位同基准）
     * @param {Object} group - 聚集编组
     * @returns {boolean}
     */
    _zoneVisible(group) {
        const vp = this.canvas.viewport;
        if (!vp || typeof this.canvas.cssWidth !== 'number') return true;
        const tl = vp.canvasToScreen(group.x, group.y);
        const br = vp.canvasToScreen(group.x + group.width, group.y + group.height);
        return br.x > 0 && tl.x < this.canvas.cssWidth &&
               br.y > 0 && tl.y < this.canvas.cssHeight;
    }

    /**
     * 弹/刷新落图轻提示（单元素复用，连续落图只刷新计数与计时，
     * 不堆叠）。点击聚焦聚集区并派发 canvasViewportChanged——
     * fitToBounds 只改视口不派发事件，工具栏等订阅方需补一拍
     * @param {Object} group - 聚集编组
     */
    _showToast(group) {
        if (!this._toastEl) {
            this._toastEl = document.createElement('div');
            this._toastEl.className = 'collect-zone-toast';
            this._toastEl.addEventListener('click', () => {
                const g = this._toastGroup;
                this._hideToast();
                if (!g || !this.canvas.viewport) return;
                this.canvas.viewport.fitToBounds([g], this.canvas.cssWidth, this.canvas.cssHeight);
                window.dispatchEvent(new CustomEvent('canvasViewportChanged'));
            });
            document.body.appendChild(this._toastEl);
        }
        this._toastGroup = group;
        this._toastCount++;
        this._toastEl.textContent = `新图已入聚集区（${this._toastCount} 张）· 点击定位`;
        this._toastEl.classList.add('show');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => this._hideToast(), CollectZone.TOAST_MS);
    }

    /** 收起轻提示并清零计数 */
    _hideToast() {
        if (this._toastEl) this._toastEl.classList.remove('show');
        this._toastCount = 0;
        this._toastGroup = null;
        clearTimeout(this._toastTimer);
        this._toastTimer = null;
    }
}

// 将 CollectZone 类暴露到全局作用域
window.CollectZone = CollectZone;
