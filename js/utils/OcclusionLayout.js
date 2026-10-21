/**
 * ==========================================================================
 * LumenLight 画布遮挡检测与让位纯函数层（OcclusionLayout）
 * ==========================================================================
 * 作用：判定画布对象（图片/视频/音频卡/占位图）是否被上层的其他不透明
 *       对象遮挡，并为被遮挡对象寻找就近空位。两个消费方：
 *       - OcclusionTool（左侧工具栏「移开被遮挡」按钮）：扫描全画布，
 *         把被遮挡对象移到空位，合并为一步撤销；
 *       - PlaceholderManager.create（生成落点防遮挡）：占位图落点与既有
 *         对象互相覆盖超阈值时自动让位，防新生成图压住/压住已有内容。
 *
 * 判定模型（全部轴对齐矩形，零 DOM 依赖可单测）：
 *   - 遮挡源按「层」比较：画布层对象（图片/视频/音频/占位图）的层 =
 *     images 数组序（后者在上）；面板节点（提示词/生图/文本，DOM 层
 *     z995 恒在画布层之上）用 isTopLayer 标记，视作永远在最上层；
 *   - 覆盖率 = 遮挡源与目标交集的【并集】面积 ÷ 目标面积。必须算并集：
 *     两图各遮一半且彼此重叠时简单求和会得到 >100% 的假象；
 *   - 并集面积用坐标压缩法精确计算（把所有交集矩形切成格子统计），
 *     单个目标的遮挡源通常只有几个到几十个，微秒级。
 *
 * 让位策略（findFreeSpot）：保持尺寸原样（不缩放不裁切），从原位向右
 *   步进扫描找第一个与任何既有对象都无重叠（留 margin 间隙）的位置，
 *   右侧扫完再向下扫；原位本身无重叠时原样返回（无需移动）。
 * ==========================================================================
 */

const OcclusionLayout = (() => {

    /** 默认覆盖率阈值：≥90% 视为被遮挡（露出一条边的也算，用户拍板） */
    const COVERAGE_THRESHOLD = 0.9;
    /** 空位与既有对象要求的最小间隙（世界坐标） */
    const FREE_MARGIN = 16;
    /** 向右/向下扫描的最大步数（超出视为画布已满，保持原位） */
    const FREE_STEPS = 30;

    /**
     * 两矩形相交测试（margin 为要求的间隙，负值允许重叠）
     * @returns {boolean} 是否相交
     */
    function rectsIntersect(a, b, margin = 0) {
        return a.x - margin < b.x + b.width &&
               a.x + a.width + margin > b.x &&
               a.y - margin < b.y + b.height &&
               a.y + a.height + margin > b.y;
    }

    /**
     * 计算目标矩形被一组遮挡矩形覆盖的精确并集覆盖率
     * @param {{x,y,width,height}} target - 目标矩形
     * @param {Array<{x,y,width,height}>} occluders - 遮挡矩形清单（无需预处理）
     * @returns {number} 0~1，目标面积/遮挡源面积为 0 时返回 0
     */
    function coverageRatio(target, occluders) {
        const targetArea = target.width * target.height;
        if (!(targetArea > 0)) return 0;

        // 1) 收集与目标有交集的遮挡区域（裁剪进目标内）
        const inter = [];
        for (const o of occluders) {
            const x1 = Math.max(target.x, o.x);
            const y1 = Math.max(target.y, o.y);
            const x2 = Math.min(target.x + target.width, o.x + o.width);
            const y2 = Math.min(target.y + target.height, o.y + o.height);
            if (x2 > x1 && y2 > y1) inter.push({ x1, y1, x2, y2 });
        }
        if (inter.length === 0) return 0;

        // 2) 坐标压缩：所有边界排序去重，把目标切成格子
        const xs = [...new Set(inter.flatMap(r => [r.x1, r.x2]))].sort((a, b) => a - b);
        const ys = [...new Set(inter.flatMap(r => [r.y1, r.y2]))].sort((a, b) => a - b);

        // 3) 逐格判定覆盖（取格中心点做点内测试，格子本身来自矩形边界，
        //    中心在矩形内 ⇔ 整格在矩形内——边界即矩形边，不存在半格）
        let covered = 0;
        for (let i = 0; i < xs.length - 1; i++) {
            const cx = (xs[i] + xs[i + 1]) / 2;
            const cellW = xs[i + 1] - xs[i];
            for (let j = 0; j < ys.length - 1; j++) {
                const cy = (ys[j] + ys[j + 1]) / 2;
                for (const r of inter) {
                    if (cx >= r.x1 && cx <= r.x2 && cy >= r.y1 && cy <= r.y2) {
                        covered += cellW * (ys[j + 1] - ys[j]);
                        break;
                    }
                }
            }
        }
        return covered / targetArea;
    }

    /**
     * 扫描一组画布对象，找出被遮挡的可移动对象
     * @param {Array<Object>} entries - 对象清单，每项：
     *   { obj, x, y, width, height, layer, isTopLayer, movable }
     *   layer 为画布层序（images 数组序），isTopLayer=true 的项（面板节点）
     *   恒在最上层且不会被遮挡；movable=false 的项只做遮挡源不进结果
     * @param {number} [threshold] - 覆盖率阈值，默认 COVERAGE_THRESHOLD
     * @returns {Array<{obj, ratio}>} 被遮挡对象及其覆盖率
     */
    function findOccluded(entries, threshold = COVERAGE_THRESHOLD) {
        const result = [];
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            if (!e.movable || !(e.width > 0) || !(e.height > 0)) continue;

            // 遮挡源 = 层更高的画布对象 + 全部顶层（DOM）对象
            const occluders = [];
            for (let j = 0; j < entries.length; j++) {
                if (j === i) continue;
                const o = entries[j];
                if (!(o.width > 0) || !(o.height > 0)) continue;
                if (o.isTopLayer || o.layer > e.layer) occluders.push(o);
            }
            if (occluders.length === 0) continue;

            const ratio = coverageRatio(e, occluders);
            if (ratio >= threshold) result.push({ obj: e.obj, ratio });
        }
        return result;
    }

    /**
     * 为一个矩形寻找就近空位：从原位起先向右、再向下步进扫描，
     * 找第一个与 occupied 中所有矩形都无重叠（留 FREE_MARGIN 间隙）的位置。
     * 原位本身无重叠时直接返回原位（无需移动）。
     * @param {{x,y,width,height}} rect - 待放置矩形（尺寸不可变）
     * @param {Array<{x,y,width,height}>} occupied - 既有矩形清单
     * @param {Object} [opts] - { steps, margin } 可覆盖默认扫描参数
     * @returns {{x,y}|null} 新位置（尺寸不变，故只返回坐标）；找不到返回 null
     */
    function findFreeSpot(rect, occupied, opts = {}) {
        const steps = opts.steps || FREE_STEPS;
        const margin = opts.margin !== undefined ? opts.margin : FREE_MARGIN;
        const isFree = (x, y) => {
            const cand = { x, y, width: rect.width, height: rect.height };
            return !occupied.some(o => rectsIntersect(cand, o, margin));
        };

        if (isFree(rect.x, rect.y)) return { x: rect.x, y: rect.y };

        // 步长 = 尺寸的一半（钳最小 64，避免超大图步进过碎扫描过慢）
        const stepX = Math.max(rect.width / 2, 64);
        const stepY = Math.max(rect.height / 2, 64);

        // 先向右找（同横排就近让位最符合直觉），再向下找
        for (let i = 1; i <= steps; i++) {
            const x = rect.x + stepX * i;
            if (isFree(x, rect.y)) return { x, y: rect.y };
        }
        for (let j = 1; j <= steps; j++) {
            const y = rect.y + stepY * j;
            if (isFree(rect.x, y)) return { x: rect.x, y };
        }
        // 右+下组合兜底（右上角象限被占满时斜向找位）
        for (let j = 1; j <= steps; j++) {
            for (let i = 1; i <= steps; i++) {
                const x = rect.x + stepX * i;
                const y = rect.y + stepY * j;
                if (isFree(x, y)) return { x, y };
            }
        }
        return null;
    }

    /**
     * 判定「新落一个矩形」是否与既有矩形构成互相覆盖冲突：
     * 任一方向覆盖率 ≥ 阈值即冲突（新矩形盖住既有对象 ≥90%，
     * 或新矩形被既有对象盖住 ≥90%）——生成落点防遮挡用。
     * @param {{x,y,width,height}} spawn - 新落矩形
     * @param {Array<{x,y,width,height}>} occupied - 既有矩形清单
     * @param {number} [threshold]
     * @returns {boolean} 是否冲突
     */
    function isSpawnConflicting(spawn, occupied, threshold = COVERAGE_THRESHOLD) {
        for (const o of occupied) {
            const interW = Math.min(spawn.x + spawn.width, o.x + o.width) - Math.max(spawn.x, o.x);
            const interH = Math.min(spawn.y + spawn.height, o.y + o.height) - Math.max(spawn.y, o.y);
            if (!(interW > 0) || !(interH > 0)) continue;
            const smallerArea = Math.min(spawn.width * spawn.height, o.width * o.height);
            if (smallerArea <= 0) continue;
            if ((interW * interH) / smallerArea >= threshold) return true;
        }
        return false;
    }

    return {
        COVERAGE_THRESHOLD,
        FREE_MARGIN,
        FREE_STEPS,
        rectsIntersect,
        coverageRatio,
        findOccluded,
        findFreeSpot,
        isSpawnConflicting
    };
})();

// 暴露到全局作用域
window.OcclusionLayout = OcclusionLayout;
