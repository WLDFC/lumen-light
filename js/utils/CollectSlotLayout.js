/**
 * ==========================================================================
 * LumenLight 聚集区槽位布局纯函数层（CollectSlotLayout）
 * ==========================================================================
 * 作用：聚集编组（GroupManager collect 字段，全局至多一个）启用时，
 *       新生成占位图在区内的落点计算。与 GroupLayout 同款定位——
 *       零 DOM 依赖的纯几何函数，Jest 可单测；DOM 侧的编组查询、
 *       视口判定与轻提示在 CollectZone（components）。
 *
 * 落点规则（与用户约定的契约）：
 *   1. 来图尺寸能放进区内空槽 → 按阅读序（上→下、左→右）找第一个
 *      与已占矩形不重叠的槽位，N 张图整齐不重叠；
 *   2. 放不下（图比编组大 / 区内已满）→ 不缩放、不裁切，按原始尺寸
 *      落在编组位置，向右级联避让（与 PlaceholderManager 同 owner
 *      级联同语言）；
 *   3. 溢出编组边界的来图不满足几何包含判定、不算组成员——既有
 *      成员语义不为此改动（图像完整性优先）。
 *
 * 已占矩形由调用方给出（画布图片 + DOM 节点同存 images 数组，
 * 占位图也在内——后建的槽位要避开先落的占位图）。
 * ==========================================================================
 */

class CollectSlotLayout {
    /**
     * 判定两矩形是否视为重叠：各向外扩 gap/2 后求交——等价于
     * 「矩形间距小于 gap 即重叠」，让相邻槽位之间留出呼吸空隙
     * @param {{x,y,width,height}} a
     * @param {{x,y,width,height}} b
     * @param {number} gap - 期望的最小间距（世界坐标）
     * @returns {boolean}
     */
    static intersects(a, b, gap = 0) {
        const m = gap / 2;
        return a.x - m < b.x + b.width && a.x + a.width + m > b.x &&
               a.y - m < b.y + b.height && a.y + a.height + m > b.y;
    }

    /**
     * 区内空槽扫描：按阅读序找第一个容得下来图且不与已占矩形
     * 重叠的位置。候选锚点 = 区左上角 + 每个已占矩形的右缘/下缘
     * 外推一个间隙（经典打包候选集：新槽必然贴着某个已有边缘或区角）
     * @param {{x,y,width,height}} inner - 槽位扫描范围（调用方已扣除
     *   编组标题栏；标题栏画在组矩形内部，槽位须避开）
     * @param {Array<{x,y,width,height}>} occupied - 已占矩形数组
     * @param {{width,height}} size - 来图尺寸
     * @param {number} [gap=24] - 槽位最小间距
     * @returns {{x,y}|null} 槽位左上角；区内放不下返回 null（调用方
     *   回落级联落点，本函数不做缩放裁定）
     */
    static findSlot(inner, occupied, size, gap = 24) {
        if (size.width > inner.width || size.height > inner.height) return null;
        const eps = 0.5;

        const xs = [inner.x];
        const ys = [inner.y];
        for (const r of occupied) {
            xs.push(r.x + r.width + gap);
            ys.push(r.y + r.height + gap);
        }
        xs.sort((a, b) => a - b);
        ys.sort((a, b) => a - b);

        for (const y of ys) {
            for (const x of xs) {
                if (x < inner.x - eps || y < inner.y - eps) continue;
                if (x + size.width > inner.x + inner.width + eps) continue;
                if (y + size.height > inner.y + inner.height + eps) continue;
                const rect = { x, y, width: size.width, height: size.height };
                let hit = false;
                for (const r of occupied) {
                    if (CollectSlotLayout.intersects(rect, r, gap)) {
                        hit = true;
                        break;
                    }
                }
                if (!hit) return { x, y };
            }
        }
        return null;
    }

    /**
     * 编组位置级联：从锚点（编组左上角）向右逐格试探，返回第一个
     * 不与已占矩形重叠的位置——放不下空槽的来图按原始尺寸落编组
     * 位置的避让路径。不缩放不裁切；上限 500 步防病态数据死循环
     * @param {{x,y}} anchor - 编组左上角
     * @param {Array<{x,y,width,height}>} occupied - 已占矩形数组
     * @param {{width,height}} size - 来图尺寸
     * @param {number} [gap=24] - 级联步进间距
     * @returns {{x,y}}
     */
    static cascade(anchor, occupied, size, gap = 24) {
        let x = anchor.x;
        const y = anchor.y;
        for (let i = 0; i < 500; i++) {
            const rect = { x, y, width: size.width, height: size.height };
            let hit = false;
            for (const r of occupied) {
                if (CollectSlotLayout.intersects(rect, r, gap)) {
                    hit = true;
                    break;
                }
            }
            if (!hit) return { x, y };
            x += size.width + gap;
        }
        return { x, y };
    }
}

// 将 CollectSlotLayout 类暴露到全局作用域
window.CollectSlotLayout = CollectSlotLayout;
