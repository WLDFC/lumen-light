/**
 * ==========================================================================
 * 文字层共享纯函数层（TextLayout）——文字测量/绘制/拆段/字体清单/字体取数
 * ==========================================================================
 * 作用：文字工具的核心算法收敛于此，两个宿主消费——
 *   - js/components/image-studio/StudioTextTool.js（灯箱文字工具：渲染进
 *     图层 paintCv 的 DOM canvas 元素）；
 *   - js/components/manga-editor/MangaText.js（漫画文字工具：渲染进 stage
 *     画布的 drawLayers 第三形态，ADR 066）。
 *   两宿主的差异只在渲染载体与交互接线（手势/选项条 DOM），测量与绘制
 *   算法必须同一份——历史上 _splitRuns 的负类双重嵌套 bug（竖排西文静
 *   默丢字，ADR 066）就是复制扩散的代价，本层即为此而设。
 * 契约：
 *   - 本文件零业务 DOM 依赖；唯一 DOM 触点是内部测量画布（懒建），
 *     measureTextLayout 可注入 mctx 供 Jest 测试（test/utils/textLayout.test.js）；
 *   - 经典 script：IIFE + window 挂载（CoordinateLayout 同款），index.html
 *     须先于两个编辑器主类加载；
 *   - 消费方（勿复制本文件）：
 *       StudioTextTool.js（_render 测量与绘制、_syncEditor 行距/字距常量、
 *         StudioDomBuilder._buildFontMenu 字体清单与「加载系统全部字体」）、
 *       MangaText.js（_measureTextLayout/_drawTextContent/_splitTextRuns
 *         委托、选项条字体清单与加载）。
 * 坐标系：测量与绘制都在「草稿像素」作画——调用方先把 ctx 平移/缩放到
 *   目标载体（text.x/y 锚点 × text.scale × 载体缩放），本层不管定位。
 * ==========================================================================
 */

const TextLayout = (() => {

    /** 行距/列距与竖排字距（字号倍数）——画布渲染与编辑框（textarea）
     *  样式共用同一值，保证提交瞬间（textarea → 位图）文字位置不跳 */
    const LINE_H = 1.4;
    const CHAR_ADV = 1.15;

    /** 精选字体清单（Windows 自带中文字体 + 常见西文），未加载系统全量
     *  时的默认清单。label 供菜单展示、family 是 CSS font-family 串 */
    const FONTS = [
        { label: '微软雅黑', family: 'Microsoft YaHei' },
        { label: '宋体', family: 'SimSun' },
        { label: '黑体', family: 'SimHei' },
        { label: '楷体', family: 'KaiTi' },
        { label: '仿宋', family: 'FangSong' },
        { label: '等线', family: 'DengXian' },
        { label: '思源黑体', family: 'Source Han Sans SC' },
        { label: '思源宋体', family: 'Source Han Serif SC' },
        { label: 'Arial', family: 'Arial' },
        { label: 'Georgia', family: 'Georgia' },
        { label: 'Times New Roman', family: 'Times New Roman' },
        { label: 'Courier New', family: 'Courier New' },
        { label: 'Impact', family: 'Impact' }
    ];

    /** 内部测量上下文（懒建；font 状态每次用时置） */
    let measureCv = null;
    function defaultMeasureCtx() {
        if (!measureCv) measureCv = document.createElement('canvas');
        return measureCv.getContext('2d');
    }

    /**
     * 按行拆 CJK/西文段：CJK（含全角标点）直立，其余整段旋转。区间串
     * 不含方括号——两侧模板各自补 [ ]（历史上把带括号的字符类直接嵌进
     * [^...] 拼出 [^[...]] 双重嵌套：负类提前闭合、尾随 ]+ 成字面量，
     * 西文段永不匹配、竖排西文静默丢字，ADR 066 修复后收敛入本层）
     */
    function splitRuns(line) {
        const cjkRange = '\\u2E80-\\u9FFF\\uF900-\\uFAFF\\uFF01-\\uFF60\\u3000-\\u303F';
        const runs = [];
        for (const m of line.match(new RegExp(`[${cjkRange}]+|[^${cjkRange}]+`, 'g')) || []) {
            runs.push({ text: m, cjk: new RegExp(`^[${cjkRange}]`).test(m) });
        }
        return runs;
    }

    /**
     * 文字布局测量（草稿像素、text.scale 无关——scale 在调用方按倍率
     * 应用）：横排宽=最长行、高=行数×行距；竖排宽=列数×列距、高=列内
     * 推进总和（CJK 逐字 CHAR_ADV、西文段按测量宽）。pad=渲染周边距
     * （30% 字号，防字形边缘裁切），进包围盒与编辑框内边距。
     * 返回 { w, h, pad, size, font, lines, vertical }
     */
    function measureTextLayout(t, mctx) {
        const ctx = mctx || defaultMeasureCtx();
        const size = Math.max(4, Number(t.size) || 48);
        const pad = Math.ceil(size * 0.3);
        const font = `${size}px "${t.font || 'Microsoft YaHei'}", sans-serif`;
        const lines = String(t.content || '').split('\n');
        ctx.font = font;
        if (!t.vertical) {
            let maxW = 0;
            for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width);
            return {
                w: Math.max(maxW, size),
                h: Math.max(lines.length * size * LINE_H, size),
                pad, size, font, lines, vertical: false
            };
        }
        let maxCol = 0;
        for (const line of lines) {
            let col = 0;
            for (const run of splitRuns(line)) {
                col += run.cjk
                    ? [...run.text].length * size * CHAR_ADV
                    : ctx.measureText(run.text).width;
            }
            maxCol = Math.max(maxCol, col);
        }
        return {
            w: Math.max(lines.length * size * LINE_H, size),
            h: Math.max(maxCol, size),
            pad, size, font, lines, vertical: true
        };
    }

    /**
     * 文字内容绘制：调用方已设好 transform（原点=包围盒左上角、缩放含
     * text.scale 与目标载体倍率），本函数在「草稿像素」坐标系作画。
     * 横排基线对齐复刻 CSS 行盒排版（编辑态 textarea → 位图不跳）：基线
     * y = 行盒顶 + 半行距 + 字体内容区上升高（fontBoundingBox 不可用退
     * 回 'middle' 近似）；竖排列自右向左，CJK 直立逐字下排、西文/数字段
     * 整体顺时针转 90°（顶朝右，PS 同规则）。空内容不落笔
     */
    function drawTextContent(g, t, layout) {
        if (!String(t.content || '')) return;
        const { pad, lines, size, font } = layout;
        const mctx = defaultMeasureCtx();
        mctx.font = font;
        g.font = font;
        g.fillStyle = t.color || '#ffffff';
        if (!layout.vertical) {
            g.textAlign = 'left';
            const m = mctx.measureText('字');
            const fa = m.fontBoundingBoxAscent;
            const fd = m.fontBoundingBoxDescent;
            if (Number.isFinite(fa) && Number.isFinite(fd)) {
                g.textBaseline = 'alphabetic';
                const halfLead = (size * LINE_H - (fa + fd)) / 2;
                lines.forEach((line, i) =>
                    g.fillText(line, pad,
                        pad + i * size * LINE_H + halfLead + fa));
            } else {
                g.textBaseline = 'middle';
                lines.forEach((line, i) =>
                    g.fillText(line, pad, pad + (i + 0.5) * size * LINE_H));
            }
            return;
        }
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        const srcW = Math.ceil(layout.w) + pad * 2;
        let colCx = srcW - pad - (size * LINE_H) / 2;   // 首列中心=右缘内缩半列
        for (const line of lines) {
            let cy = pad;
            for (const run of splitRuns(line)) {
                if (run.cjk) {
                    for (const ch of run.text) {
                        g.fillText(ch, colCx, cy + (size * CHAR_ADV) / 2);
                        cy += size * CHAR_ADV;
                    }
                } else {
                    const rw = g.measureText(run.text).width;
                    g.save();
                    g.translate(colCx, cy + rw / 2);
                    g.rotate(Math.PI / 2);
                    g.fillText(run.text, 0, 0);
                    g.restore();
                    cy += rw;
                }
            }
            colCx -= size * LINE_H;
        }
    }

    /**
     * 系统全量字体取数：后端 /api/system-fonts（Windows 字体注册表，PS
     * 同源数据，零授权任何浏览器可用，ADR 067）。成功且非空返回
     * [{label, family}]，任何失败（后端未起/枚举报错/空清单）返回 null，
     * 调用方回落精选清单并提示
     */
    async function loadSystemFonts() {
        try {
            const resp = await fetch('/api/system-fonts');
            const j = await resp.json();
            if (j && j.status === 'ok' && Array.isArray(j.fonts) && j.fonts.length) {
                return j.fonts;
            }
        } catch { /* 后端未起/网络失败：null 回落精选 */ }
        return null;
    }

    return { LINE_H, CHAR_ADV, FONTS, splitRuns, measureTextLayout, drawTextContent, loadSystemFonts };
})();

// 暴露到全局作用域（经典 script，两编辑器在 index.html 中后置消费）
window.TextLayout = TextLayout;
