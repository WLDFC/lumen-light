/**
 * ==========================================================================
 * LumenLight 编组成员布局算法（GroupLayout）
 * ==========================================================================
 * 作用：编组工具栏「布局」按钮的四种排列算法（宫格/瀑布流/水平/垂直），纯函数、
 *       可单测。输入成员数组（含 x/y/width/height 的画布对象），输出
 *       每个成员的新左上角坐标与内容总尺寸；应用坐标、移动 DOM 节点、
 *       重_fit 组矩形等副作用由调用方（GroupToolbar）负责。
 *
 * 设计约定：
 *   - 只移动不缩放：图片是像素资产且承担生图链路槽位语义，算法只改
 *     x/y，绝不改宽高
 *   - 输出坐标归一化到 (0,0) 起点：调用方按「组左上角 + 内边距」平移
 *     后写入成员，组矩形随之重_fit（锚点=组左上角不动）
 *   - 排列顺序 = 当前位置的阅读顺序（左→右、上→下，行容差吸收 y 抖动），
 *     重复执行结果稳定；arrange 第三参可传预排序成员（时间排序覆盖，
 *     见 sortTimeOrder）
 * ==========================================================================
 */

class GroupLayout {
    /** 成员间固定间距（世界坐标，与 ENCLOSURE_PADDING 同量级） */
    static GAP = 80;

    /**
     * 排列入口
     * @param {string} mode - 'grid' | 'waterfall' | 'horizontal' | 'vertical'
     * @param {Array} members - 成员对象数组（不修改入参）
     * @param {Array} [ordered] - 预排序成员（如 sortTimeOrder 产物）；缺省
     *   按当前位置阅读序（几何算法只消费传入序，坐标语义不受影响）
     * @returns {{placements: Array<{obj, x, y}>, width: number, height: number}}
     *   placements 归一化到 (0,0) 起点；width/height 为内容包围盒
     */
    static arrange(mode, members, ordered) {
        const finalOrder = Array.isArray(ordered)
            ? ordered
            : GroupLayout.sortReadingOrder(members);
        if (mode === 'horizontal') return GroupLayout.horizontal(finalOrder);
        if (mode === 'vertical') return GroupLayout.vertical(finalOrder);
        if (mode === 'waterfall') return GroupLayout.waterfall(finalOrder);
        return GroupLayout.grid(finalOrder);
    }

    /**
     * 阅读顺序排序：按 y 分行（y 相差小于较小者高度一半视为同行），
     * 行内按 x 升序、行间按行首 y 升序。不修改入参数组。
     * @param {Array} members - 成员对象数组
     * @returns {Array} 排序后的成员数组（新数组）
     */
    static sortReadingOrder(members) {
        const byY = members.slice().sort((a, b) => a.y - b.y);
        const rows = [];
        let current = [];
        for (const obj of byY) {
            if (current.length > 0) {
                const head = current[0];
                const tol = Math.min(head.height, obj.height) / 2;
                if (obj.y - head.y > tol) {
                    rows.push(current);
                    current = [];
                }
            }
            current.push(obj);
        }
        if (current.length > 0) rows.push(current);
        return rows.flatMap(row => row.sort((a, b) => a.x - b.x));
    }

    /**
     * 成员时间键（组内按时间排序，2026-11-16）。回退链：
     * created（随存档持久化，ProjectSerializer collectImages/collectNodes
     * 回写）→ genInfo.time（GenRecord 生成时间，旧存档生成图可用）→
     * name/videoUrl/audioUrl 内嵌 13 位毫秒戳（旧存档放大/扩图/抠图产物
     * 的 `${前缀}_${Date.now()}.扩展名` 命名约定）→ Infinity（无时间线索，
     * 如本地拖入图）
     * @param {Object} obj - 画布成员对象
     * @returns {number} 毫秒时间戳；无时间线索返回 Infinity
     */
    static timeKeyOf(obj) {
        if (typeof obj.created === 'number' &&
            Number.isFinite(obj.created) && obj.created > 0) {
            return obj.created;
        }
        if (obj.genInfo && typeof obj.genInfo.time === 'number' &&
            Number.isFinite(obj.genInfo.time) && obj.genInfo.time > 0) {
            return obj.genInfo.time;
        }
        const src = String(obj.name || obj.videoUrl || obj.audioUrl || '');
        const m = src.match(/_(\d{13})(?:\.\w+)?$/);
        return m ? Number(m[1]) : Infinity;
    }

    /**
     * 时间顺序排序（组内按时间排序）：先按当前位置阅读序打底（同毫秒
     * 并列与无时间成员的稳定基座，JS sort 稳定），再按 timeKeyOf 排序。
     * 无时间成员（Infinity）排在有时段之后、组内保持阅读序，升降两个
     * 方向语义一致。不修改入参数组。
     * @param {Array} members - 成员对象数组
     * @param {string} [dir] - 'asc'（缺省，旧→新=最旧在阅读序首位）|
     *                         'desc'（新→旧=最新在阅读序首位）
     * @returns {Array} 排序后的成员数组（新数组）
     */
    static sortTimeOrder(members, dir = 'asc') {
        const base = GroupLayout.sortReadingOrder(members);
        return base.sort((a, b) => {
            const ka = GroupLayout.timeKeyOf(a);
            const kb = GroupLayout.timeKeyOf(b);
            if (ka === Infinity && kb === Infinity) return 0;
            if (ka === Infinity) return 1;      // 无时间尾置（两方向一致）
            if (kb === Infinity) return -1;
            return dir === 'desc' ? kb - ka : ka - kb;
        });
    }

    /**
     * 水平布局：单行从左到右，整行以最高成员为基准垂直居中
     * @param {Array} ordered - 已按阅读顺序排序的成员
     */
    static horizontal(ordered) {
        const gap = GroupLayout.GAP;
        const rowHeight = Math.max(...ordered.map(o => o.height));
        let x = 0;
        const placements = ordered.map(obj => {
            const p = { obj, x, y: (rowHeight - obj.height) / 2 };
            x += obj.width + gap;
            return p;
        });
        return {
            placements,
            width: x - gap,
            height: rowHeight
        };
    }

    /**
     * 垂直布局：单列从上到下，整列以最宽成员为基准水平居中
     * @param {Array} ordered - 已按阅读顺序排序的成员
     */
    static vertical(ordered) {
        const gap = GroupLayout.GAP;
        const colWidth = Math.max(...ordered.map(o => o.width));
        let y = 0;
        const placements = ordered.map(obj => {
            const p = { obj, x: (colWidth - obj.width) / 2, y };
            y += obj.height + gap;
            return p;
        });
        return {
            placements,
            width: colWidth,
            height: y - gap
        };
    }

    /**
     * 宫格布局：列数 = ⌈√n⌉（接近方正），按阅读顺序逐行填充。
     * 格宽 = 该列成员最大宽、格高 = 该行成员最大高，成员在格内双向居中
     * ——尺寸不一的成员排出整齐网格。
     * @param {Array} ordered - 已按阅读顺序排序的成员
     */
    static grid(ordered) {
        const gap = GroupLayout.GAP;
        const cols = Math.ceil(Math.sqrt(ordered.length));

        // 按列切行：rows[r][c]
        const rows = [];
        for (let i = 0; i < ordered.length; i += cols) {
            rows.push(ordered.slice(i, i + cols));
        }
        // 每行高度 / 每列宽度取成员最大值
        const rowHeights = rows.map(row => Math.max(...row.map(o => o.height)));
        const colWidths = [];
        for (let c = 0; c < cols; c++) {
            colWidths[c] = Math.max(...rows
                .map(row => row[c])
                .filter(Boolean)
                .map(o => o.width));
        }

        const placements = [];
        let y = 0;
        for (let r = 0; r < rows.length; r++) {
            let x = 0;
            for (let c = 0; c < rows[r].length; c++) {
                const obj = rows[r][c];
                placements.push({
                    obj,
                    x: x + (colWidths[c] - obj.width) / 2,
                    y: y + (rowHeights[r] - obj.height) / 2
                });
                x += colWidths[c] + gap;
            }
            y += rowHeights[r] + gap;
        }
        return {
            placements,
            width: colWidths.reduce((sum, w) => sum + w, 0) + gap * (cols - 1),
            height: y - gap
        };
    }

    /**
     * 瀑布流布局：定宽列 + 最矮列优先（提示词收藏页 CSS 多列瀑布流的
     * 画布几何移植——收藏页是 column-count 交给浏览器排卡片，画布需要
     * 输出坐标，算法在此实现，可见 groupLayout.test.js）。列数 = ⌈√n⌉
     * （与宫格同规则）；列宽 = 成员最大宽（只移动不缩放，保证任何成员
     * 不越列）；按阅读顺序把成员放进当前最矮的列、列内水平居中——
     * 高低错落的竖排流，底部参差是瀑布流语义（与宫格的行对齐相对）。
     * @param {Array} ordered - 已按阅读顺序排序的成员
     */
    static waterfall(ordered) {
        const gap = GroupLayout.GAP;
        const cols = Math.ceil(Math.sqrt(ordered.length));
        const colWidth = Math.max(...ordered.map(o => o.width));

        // 各列当前填充高度；最矮列优先（并列取最左——严格小于才换列，
        // 等尺寸成员稳定落在前侧列，重复执行结果稳定）
        const colHeights = new Array(cols).fill(0);
        const placements = ordered.map(obj => {
            let target = 0;
            for (let c = 1; c < cols; c++) {
                if (colHeights[c] < colHeights[target]) target = c;
            }
            const p = {
                obj,
                x: target * (colWidth + gap) + (colWidth - obj.width) / 2,
                y: colHeights[target]
            };
            colHeights[target] += obj.height + gap;
            return p;
        });
        return {
            placements,
            width: cols * colWidth + gap * (cols - 1),
            height: Math.max(...colHeights) - gap
        };
    }
}

// 将 GroupLayout 类暴露到全局作用域
window.GroupLayout = GroupLayout;
