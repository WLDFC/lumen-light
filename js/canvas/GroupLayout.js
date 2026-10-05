/**
 * ==========================================================================
 * LumenLight 编组成员布局算法（GroupLayout）
 * ==========================================================================
 * 作用：编组工具栏「布局」按钮的三种排列算法（宫格/水平/垂直），纯函数、
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
 *     重复执行结果稳定
 * ==========================================================================
 */

class GroupLayout {
    /** 成员间固定间距（世界坐标，与 ENCLOSURE_PADDING 同量级） */
    static GAP = 80;

    /**
     * 排列入口
     * @param {string} mode - 'grid' | 'horizontal' | 'vertical'
     * @param {Array} members - 成员对象数组（不修改入参）
     * @returns {{placements: Array<{obj, x, y}>, width: number, height: number}}
     *   placements 归一化到 (0,0) 起点；width/height 为内容包围盒
     */
    static arrange(mode, members) {
        const ordered = GroupLayout.sortReadingOrder(members);
        if (mode === 'horizontal') return GroupLayout.horizontal(ordered);
        if (mode === 'vertical') return GroupLayout.vertical(ordered);
        return GroupLayout.grid(ordered);
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
}

// 将 GroupLayout 类暴露到全局作用域
window.GroupLayout = GroupLayout;
