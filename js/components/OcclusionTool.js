/**
 * ==========================================================================
 * LumenLight 被遮挡对象移开工具（OcclusionTool）
 * ==========================================================================
 * 作用：左侧工具栏「移开被遮挡」按钮——扫描全画布，找出被上层对象
 *       （图片/视频/音频/占位图 + DOM 节点面板）遮住 ≥90% 的可移动对象
 *       （图片/视频/音频卡），逐个移到就近空位，合并为一步撤销。
 *
 * 判定与找位逻辑在纯函数层 OcclusionLayout（js/utils/，可单测）：
 *   - 覆盖率 = 上层遮挡源交集的并集面积 ÷ 目标面积（坐标压缩精确计算）；
 *   - 面板节点（提示词/生图/文本，DOM 层恒在画布层上）永远算遮挡源，
 *     但自身不可被遮挡也不会被移动；占位图同理（移动会断生成回流绑定）。
 *
 * 移动走 recordGeometry（与画布手势移动同一记账路径）：一次点击的
 * 全部位移合并为一条撤销命令，实时保存/重绘自动跟上。
 * ==========================================================================
 */

class OcclusionTool {
    /**
     * 构造函数：向左侧工具栏追加按钮（SideToolbar 先于本组件初始化）
     * @param {Canvas} canvas - 画布主类实例
     */
    constructor(canvas) {
        this.canvas = canvas;
        this._insertButton();
    }

    /** 向 #sideToolbar 追加按钮（资产库/任务中心同款插入模式） */
    _insertButton() {
        const bar = document.getElementById('sideToolbar');
        if (!bar) return;
        const btn = document.createElement('button');
        btn.className = 'side-toolbar-btn occlusion-tool-btn';
        btn.id = 'sideOcclusionBtn';
        btn.type = 'button';
        btn.title = '移开被遮挡的对象（图片/视频/音频被盖住 ≥90% 时自动让位）';
        btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="13" height="13" rx="2"/><polyline points="16 8 21 8 21 21"/><line x1="21" y1="16" x2="16" y2="21" opacity="0"/><path d="M21 8v9a4 4 0 0 1-4 4H8"/></svg>`;
        btn.addEventListener('click', () => this.run());
        bar.appendChild(btn);
        this.btn = btn;
    }

    /**
     * 把画布对象清单整理成纯函数层需要的 entries 形态
     * 数据源统一是 canvas.images.images（图片/视频/音频/占位图/面板节点混存）：
     *   - 层序 = 数组序（后者在上）；面板节点标 isTopLayer（DOM 层恒最上）；
     *   - 可移动 = 非面板节点且非占位图（占位图移动会断生成回流绑定）。
     */
    _buildEntries() {
        const images = this.canvas.images.images;
        const entries = [];
        for (let i = 0; i < images.length; i++) {
            const o = images[i];
            if (!o || !(o.width > 0) || !(o.height > 0)) continue;
            const isDom = NodeTypes.isPanelNode(o.source);
            entries.push({
                obj: o,
                x: o.x,
                y: o.y,
                width: o.width,
                height: o.height,
                layer: i,
                isDom,
                isTopLayer: isDom,
                movable: !isDom && !NodeTypes.isPlaceholder(o.source)
            });
        }
        return entries;
    }

    /** 画布级轻提示（复用撤销栈的 toast 元素与样式） */
    _toast(msg) {
        if (this.canvas.history) this.canvas.history._toast(msg);
    }

    /**
     * 执行扫描与移开：
     *   1. 找出全部被遮挡对象；
     *   2. 逐个在「当前占位快照」上找空位——每次移动都更新快照，
     *      后续对象找位时把已挪走的算进去，避免连环撞位；
     *   3. 移动前重验覆盖率（前面的移动可能已让后面对象重见天日，
     *      不再重复搬移）；
     *   4. 全部位移合并 recordGeometry 一步撤销 + 重绘 + 轻提示。
     */
    run() {
        const entries = this._buildEntries();
        const occluded = OcclusionLayout.findOccluded(entries, OcclusionLayout.COVERAGE_THRESHOLD);
        if (occluded.length === 0) {
            this._toast('画布上没有被遮挡的对象');
            return;
        }

        // 当前占位快照（obj -> 矩形），随移动同步更新
        const rects = new Map();
        for (const e of entries) {
            rects.set(e.obj, { x: e.x, y: e.y, width: e.width, height: e.height });
        }
        const entriesByObj = new Map(entries.map(e => [e.obj, e]));

        const geometryEntries = [];
        for (const { obj } of occluded) {
            const self = rects.get(obj);
            const e = entriesByObj.get(obj);

            // 移动前重验：前面的移动可能已移走它的遮挡源
            const occluders = [];
            for (const other of entries) {
                if (other.obj === obj) continue;
                if (other.isTopLayer || other.layer > e.layer) {
                    occluders.push(rects.get(other.obj));
                }
            }
            const ratio = OcclusionLayout.coverageRatio(self, occluders);
            if (ratio < OcclusionLayout.COVERAGE_THRESHOLD) continue;

            // 占据清单 = 其余全部对象（含 DOM 节点，用最新快照位置）
            const occupied = [];
            for (const other of entries) {
                if (other.obj === obj) continue;
                occupied.push(rects.get(other.obj));
            }
            const spot = OcclusionLayout.findFreeSpot(self, occupied);
            if (!spot) continue;

            geometryEntries.push({
                obj,
                from: { x: obj.x, y: obj.y },
                to: { x: spot.x, y: spot.y }
            });
            rects.set(obj, { ...self, x: spot.x, y: spot.y });
        }

        if (geometryEntries.length === 0) {
            this._toast(`发现 ${occluded.length} 个被遮挡对象，但附近找不到空位`);
            return;
        }

        for (const en of geometryEntries) {
            en.obj.x = en.to.x;
            en.obj.y = en.to.y;
        }
        this.canvas.history.recordGeometry(geometryEntries, '移开被遮挡对象');
        this.canvas.draw();
        this._toast(`已移开 ${geometryEntries.length} 个被遮挡对象（Ctrl+Z 可撤销）`);
    }
}

// 暴露到全局作用域
window.OcclusionTool = OcclusionTool;
