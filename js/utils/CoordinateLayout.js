/**
 * ==========================================================================
 * 坐标编辑 Layout 纯函数层（CoordinateLayout）
 * ==========================================================================
 * 作用：MOSS-Image Layout 草稿的数据契约 + 校验 + 编译。编译逻辑是上游
 *       data/pi/skills/moss-image-prompt-enhancer/scripts/compile_prompt.py
 *       的 JS 逐位移植（同一套校验与坐标换算，断言对齐其
 *       test_compile_prompt.py）——保证编辑器导出的提示词与跑上游
 *       Python 脚本产物一致，Flux3 等兼容 MOSS 格式的模型直接可用。
 *
 *   - 草稿（draft）：人读 JSON。width/height 为 16 的倍数；bbox 为左上角
 *     原点的像素 xyxy；summary.canvas 三模式 single/multi_panel/collage；
 *     items 扁平数组，label ∈ object/character/text，text 类必填 text。
 *   - 编译产物：单行 JSON——bbox 换算为画布中心原点的整数
 *     abs_centralized/yxyx（floor/ceil 包络像素边界后减半宽半高），
 *     去掉宽高元数据；summary 与 items 原样保留（键序不变）。
 *   - 本模块零 DOM 依赖，Jest 可单测（test/utils/coordinateLayout.test.js）。
 *
 * 与 Python 版的已知差异（刻意）：
 *   - JSON 解析层差异：JS 无法区分 1024 与 1024.0（Number.isInteger 均真），
 *     重复键/非有限常量在 JSON.parse 层已由各自引擎处理，不在对象级 API 复检；
 *   - round(v,9) 的银行家舍入 vs Math.round 四舍五入——仅在第十位小数
 *     恰为 5 时不同，对像素坐标无实际影响。
 *
 * 消费方：js/components/CoordinateEditor.js（顶栏「坐标编辑」窗口）、
 *       js/components/MangaEditor.js（顶栏「漫画编辑」窗口，一期复制分叉
 *       共用本层——改名复制会失去与上游 Python 的对齐锚点，勿复制本文件）。
 * ==========================================================================
 */

const CoordinateLayout = (() => {
    /** summary.canvas 允许的三种模式（多格漫画=multi_panel，拼贴=collage） */
    const CANVAS_MODES = ['single', 'multi_panel', 'collage'];
    /** items[].label 允许的三种元素类型 */
    const ITEM_LABELS = ['object', 'character', 'text'];

    /** 编辑器画幅输入范围（均为 16 的倍数） */
    const MIN_DIM = 256;
    const MAX_DIM = 4096;

    /** 常用画幅预设（全部为 16 的倍数） */
    const PRESET_SIZES = [
        { label: '1024 × 1024（方形）', width: 1024, height: 1024 },
        { label: '832 × 1216（竖图）', width: 832, height: 1216 },
        { label: '1216 × 832（横图）', width: 1216, height: 832 },
        { label: '1536 × 1024（宽横）', width: 1536, height: 1024 },
        { label: '1024 × 1536（长竖）', width: 1024, height: 1536 }
    ];

    // ==================== 内部校验工具（Python require 的镜像） ====================

    function _fail(message) { throw new Error(message); }

    /** 对象字段白名单/必填校验（unknown 拒绝 + missing 拒绝） */
    function _fields(value, allowed, required, location) {
        _failUnless(value && typeof value === 'object' && !Array.isArray(value),
            `${location} 必须是对象`);
        const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
        const missing = required.filter((k) => !(k in value));
        if (unknown.length) _fail(`${location}: 未知的字段 ${JSON.stringify(unknown)}`);
        if (missing.length) _fail(`${location}: 缺少字段 ${JSON.stringify(missing)}`);
    }
    function _failUnless(cond, message) { if (!cond) _fail(message); }

    function _text(value, location) {
        _failUnless(typeof value === 'string' && value.trim() !== '',
            `${location} 必须是非空文本`);
    }

    function _strings(value, location) {
        _failUnless(Array.isArray(value), `${location} 必须是数组`);
        value.forEach((item, i) => _text(item, `${location}[${i}]`));
    }

    /** Python round(v, 9) 的等价实现：消第十位及以后的浮点噪声 */
    function _round9(v) { return Math.round(v * 1e9) / 1e9; }

    // ==================== 坐标换算（compile_prompt.py centered_box 移植） ====================

    /**
     * 单个 bbox：左上角原点 xyxy → 画布中心原点整数 yxyx。
     * 与上游一致：floor/ceil 包络像素边界后再减半宽半高，拒绝越界、
     * 非法几何与导出精度下过小（round9 塌缩成零尺寸）的框。
     * @param {number[]} box [x1,y1,x2,y2]
     * @param {number} width 画幅宽（16 倍数）
     * @param {number} height 画幅高（16 倍数）
     * @param {string} location 报错定位用
     * @returns {number[]} [y1',x1',y2',x2'] 中心原点坐标
     */
    function centeredBox(box, width, height, location) {
        _failUnless(Array.isArray(box) && box.length === 4,
            `${location} 必须是 [x1,y1,x2,y2]`);
        _failUnless(box.every((v) => typeof v === 'number' && Number.isFinite(v)),
            `${location} 必须是四个有限数字`);
        const [x1, y1, x2, y2] = box;
        _failUnless(x1 < x2 && y1 < y2, `${location} 必须具有正的宽高`);
        _failUnless(0 <= x1 && x2 <= width && 0 <= y1 && y2 <= height,
            `${location} 超出 ${width}×${height} 画幅`);
        const hw = Math.floor(width / 2), hh = Math.floor(height / 2);
        const result = [
            Math.floor(_round9(y1)) - hh,
            Math.floor(_round9(x1)) - hw,
            Math.ceil(_round9(y2)) - hh,
            Math.ceil(_round9(x2)) - hw
        ];
        _failUnless(result[0] < result[2] && result[1] < result[3],
            `${location} 在导出精度下过小`);
        return result;
    }

    // ==================== 编译（compile_prompt.py compile_prompt 移植） ====================

    /**
     * 校验并编译草稿。caption 草稿（{"caption": "..."}）返回纯文本；
     * Layout 草稿返回单行 JSON（summary/items 键序原样、bbox 换算为中心
     * 原点 yxyx、无宽高字段）。不修改传入的草稿对象。
     * @param {Object} draft 草稿（见文件头注释）
     * @returns {{ok: true, prompt: string} | {ok: false, error: string}}
     */
    function compileDraft(draft) {
        try {
            return { ok: true, prompt: _compile(draft) };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }

    function _compile(draft) {
        _failUnless(draft && typeof draft === 'object' && !Array.isArray(draft),
            '草稿必须是 JSON 对象');
        if ('caption' in draft) {
            _fields(draft, ['caption'], ['caption'], 'Caption 草稿');
            _text(draft.caption, 'caption');
            return draft.caption;
        }

        const rootFields = ['width', 'height', 'bbox_coord_space', 'bbox_format', 'summary', 'items'];
        _fields(draft, rootFields, rootFields, 'Layout 草稿');
        const { width, height } = draft;
        for (const [name, value] of [['width', width], ['height', height]]) {
            _failUnless(typeof value === 'number' && Number.isInteger(value) &&
                value > 0 && value % 16 === 0,
                `${name} 必须是 16 的倍数的正整数`);
        }
        _failUnless(draft.bbox_coord_space === 'abs',
            '草稿 bbox_coord_space 必须是 abs');
        _failUnless(draft.bbox_format === 'xyxy',
            '草稿 bbox_format 必须是 xyxy');

        const summary = draft.summary;
        _fields(summary, ['caption', 'meta', 'canvas', 'palette'], ['caption'], 'summary');
        _text(summary.caption, 'summary.caption');
        if ('canvas' in summary) {
            _failUnless(CANVAS_MODES.includes(summary.canvas),
                'summary.canvas 必须是 single、multi_panel 或 collage');
        }
        for (const key of ['meta', 'palette']) {
            if (key in summary) _strings(summary[key], `summary.${key}`);
        }

        const items = draft.items;
        _failUnless(Array.isArray(items) && items.length > 0,
            'items 必须是非空扁平数组');
        const compiledItems = [];
        items.forEach((item, index) => {
            const location = `items[${index}]`;
            _fields(item, ['label', 'caption', 'bbox', 'text', 'tags', 'palette'],
                ['label', 'caption', 'bbox'], location);
            _failUnless(ITEM_LABELS.includes(item.label),
                `${location}.label 必须是 object、character 或 text`);
            _text(item.caption, `${location}.caption`);
            if (item.label === 'text') {
                _failUnless('text' in item, `${location}: text 元素必须提供文字内容`);
            }
            if ('text' in item) _text(item.text, `${location}.text`);
            for (const key of ['tags', 'palette']) {
                if (key in item) _strings(item[key], `${location}.${key}`);
            }
            // 新对象按原键序重建（bbox 原位换算），不动草稿本身
            const out = {};
            for (const key of Object.keys(item)) {
                out[key] = key === 'bbox'
                    ? centeredBox(item[key], width, height, `${location}.bbox`)
                    : item[key];
            }
            compiledItems.push(out);
        });

        const result = {
            summary,
            items: compiledItems,
            bbox_coord_space: 'abs_centralized',
            bbox_format: 'yxyx'
        };
        return JSON.stringify(result);
    }

    /**
     * 仅校验不产出（编辑器实时反馈用）。错误文案与编译路径完全同源。
     * @returns {string|null} null = 合法；否则错误信息
     */
    function validateDraft(draft) {
        const r = compileDraft(draft);
        return r.ok ? null : r.error;
    }

    // ==================== 编辑器辅助（纯几何，不出本模块测试范围外） ====================

    /** 新建空白草稿（默认 1024×1024，single 模式） */
    function createDraft(width = 1024, height = 1024) {
        return {
            width, height,
            bbox_coord_space: 'abs',
            bbox_format: 'xyxy',
            summary: { caption: '', canvas: 'single' },
            items: []
        };
    }

    /** 画幅数值钳制：就近取 16 的倍数，钳在 [MIN_DIM, MAX_DIM] */
    function clampDim(v) {
        if (typeof v !== 'number' || !Number.isFinite(v)) return 1024;
        let n = Math.round(v / 16) * 16;
        n = Math.max(MIN_DIM, Math.min(MAX_DIM, n));
        return n;
    }

    /**
     * 拖拽结束后的 bbox 归一：取整、反转坐标排序、钳回画幅内，
     * 每轴最小 2px（保证编译精度下不塌缩）。画幅过小时允许等幅钳制。
     */
    function normalizeBox(box, width, height) {
        let [x1, y1, x2, y2] = box.map((v) => (typeof v === 'number' && Number.isFinite(v)) ? v : 0);
        if (x1 > x2) [x1, x2] = [x2, x1];
        if (y1 > y2) [y1, y2] = [y2, y1];
        x1 = Math.round(x1); y1 = Math.round(y1);
        x2 = Math.round(x2); y2 = Math.round(y2);
        x1 = Math.max(0, Math.min(x1, width - 2));
        y1 = Math.max(0, Math.min(y1, height - 2));
        x2 = Math.max(x1 + 2, Math.min(x2, width));
        y2 = Math.max(y1 + 2, Math.min(y2, height));
        return [x1, y1, x2, y2];
    }

    /**
     * 加载容错归一（ADR 018）：把任意来源（data/coordinate-draft.json 可能
     * 被手改/半损坏）的 JSON 归一成合法编辑器草稿——坏的部分修掉或丢弃，
     * 救不回来返回 null。只在编辑器恢复路径用；编译路径仍走
     * validateDraft/compileDraft 严格白名单，两条路径不混。
     * 与 createDraft 的差异：保留 item.shot（编辑器侧景别元数据，编译前由
     * CoordinateEditor._draftForCompile 剥离）与上游白名单允许的
     * summary.meta/palette、item.text/tags/palette（字符串数组形态）。
     * @param {*} raw 任意 JSON
     * @returns {Object|null} 归一后的草稿；非对象返回 null
     */
    function normalizeDraft(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const width = clampDim(raw.width);
        const height = clampDim(raw.height);
        const src = (raw.summary && typeof raw.summary === 'object'
            && !Array.isArray(raw.summary)) ? raw.summary : {};
        const summary = {
            caption: typeof src.caption === 'string' ? src.caption : '',
            canvas: CANVAS_MODES.includes(src.canvas) ? src.canvas : 'single'
        };
        for (const key of ['meta', 'palette']) {
            if (Array.isArray(src[key]) && src[key].every((v) => typeof v === 'string')) {
                summary[key] = src[key];
            }
        }
        const items = [];
        if (Array.isArray(raw.items)) {
            for (const it of raw.items) {
                // 结构不完整（类型/描述/几何缺一）整条丢弃，不拖垮其余条目；
                // 描述允许空串——新建元素卡片的合法中间态（编译时报错由用户补）
                if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
                if (!ITEM_LABELS.includes(it.label)) continue;
                if (typeof it.caption !== 'string') continue;
                if (!Array.isArray(it.bbox) || it.bbox.length !== 4) continue;
                const item = {
                    label: it.label,
                    caption: it.caption,
                    bbox: normalizeBox(it.bbox, width, height)
                };
                if (typeof it.text === 'string') item.text = it.text;
                if (typeof it.shot === 'string' && it.shot) item.shot = it.shot;
                // title = 编辑器侧框标题（舞台标签显示，编译前剥离，非 MOSS 契约字段）
                if (typeof it.title === 'string' && it.title.trim()) item.title = it.title;
                for (const key of ['tags', 'palette']) {
                    if (Array.isArray(it[key]) && it[key].every((v) => typeof v === 'string')) {
                        item[key] = it[key];
                    }
                }
                items.push(item);
            }
        }
        const out = {
            width, height,
            bbox_coord_space: 'abs',
            bbox_format: 'xyxy',
            summary, items
        };
        // 背景参考图（编辑器侧元数据，编译前由 _draftForCompile 剥离）：
        // 契约是「只存 /api/assets/ 稳定引用不存图片数据」——其余形态
        // （base64/临时地址）一律丢弃，防手改草稿塞大图撑爆自动保存
        if (typeof raw.background === 'string' &&
            raw.background.startsWith('/api/assets/')) {
            out.background = raw.background;
            // 背景来源画布图 id（漫画编辑器删图联动清背景用，2026-11-04）：
            // 仅随有效背景引用一并带回，孤儿 id 不入草稿
            if (typeof raw.backgroundSrcId === 'string' && raw.backgroundSrcId) {
                out.backgroundSrcId = raw.backgroundSrcId;
            }
        }
        return out;
    }

    /** 单值磁吸：阈值内（含边界）吸附到最近目标点，同距取先加入者 */
    function snapValue(v, targets, threshold) {
        let best = null, bestDist = Infinity;
        for (const t of targets) {
            const d = Math.abs(v - t);
            if (d <= threshold && d < bestDist) { best = t; bestDist = d; }
        }
        return { value: best === null ? v : best, snapped: best !== null };
    }

    /**
     * 某轴的磁吸目标集合：画幅 0 / 中心 / 边缘 + 调用方给定的其他参考线
     * （如其他元素的同轴边缘与中心）。
     * @param {number} span 画幅宽或高
     * @param {number[]} otherEdges 其他参考坐标
     */
    function axisTargets(span, otherEdges) {
        return [0, span / 2, span, ...otherEdges];
    }

    return {
        CANVAS_MODES, ITEM_LABELS,
        MIN_DIM, MAX_DIM, PRESET_SIZES,
        centeredBox, compileDraft, validateDraft,
        createDraft, clampDim, normalizeBox, normalizeDraft, snapValue, axisTargets
    };
})();

// 暴露到全局作用域（经典 script，CoordinateEditor.js 消费）
window.CoordinateLayout = CoordinateLayout;
