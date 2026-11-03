/**
 * ==========================================================================
 * 漫画编辑器 CSS 拆分契约测试（manga-editor.css / -panel / -stage 三件套）
 * ==========================================================================
 * 拆分约定（见 css/manga-editor.css 文件头）：三文件按序加载、选择器互不
 * 相交（与 imageStudioCss.test.js 同款结构契约，2026-11-03 拆分）。
 * 本测试不测视觉（无头环境渲染不了），测的是「拆分结构本身」——防止后续
 * 往任一文件加样式时把选择器加错文件/重复定义，或调整 index.html 加载
 * 顺序时无声破坏契约：
 *   1. 三文件存在且非空；
 *   2. 花括号配对（文件结构完好）；
 *   3. 跨文件选择器零重复（拆分红线：同一选择器只允许出现在一个文件；
 *      文件内部重复定义合法——基础规则与其窄屏 @media 覆盖同文件分写）；
 *   4. index.html 按契约顺序加载三件套（均在 recipe-manager.css 之后）；
 *   5. 各 UI 区域的代表选择器落在正确文件里（防止整块搬家搬错地方）。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');

const CSS_DIR = path.join(__dirname, '..', '..', 'css');
const FILES = [
    'manga-editor.css',   // 窗口壳：头部/留白/页面栏/底部操作行（先加载）
    'manga-panel.css',    // 左栏（整体描述/元素卡片）+ 右栏（画幅/模式/输出）
    'manga-stage.css'     // 中央舞台 + 背景工具组 + 画布选图浮层（末加载）
];

/** 读文件（相对 css/ 目录） */
const read = (name) =>
    fs.readFileSync(path.join(CSS_DIR, name), 'utf8');

/** 去掉 /* ... *​/ 注释（跨行），让选择器/括号解析不受注释干扰 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * 解析一份 CSS 的全部顶层选择器组：按 { 与 } 扫深度，取每条规则开括号前
 * 的选择器文本，再按逗号拆成单个选择器（多行选择器组合并换行为单空格）。
 * @media 内部的嵌套选择器同样被收集（窄屏覆盖与基础规则受同一查重约束）。
 */
function parseSelectors(css) {
    const src = stripComments(css);
    const out = [];
    let buf = '';
    let depth = 0;
    for (const ch of src) {
        if (ch === '{') {
            if (depth === 0) {
                const sel = buf.replace(/\s+/g, ' ').trim();
                // @规则本身（@media ...）不是选择器，跳过；空串同理
                if (sel && !sel.startsWith('@')) {
                    for (const one of sel.split(',').map(s => s.trim())) {
                        if (one) out.push(one);
                    }
                }
            }
            depth++;
            buf = '';
        } else if (ch === '}') {
            depth--;
            buf = '';
        } else if (depth === 0) {
            buf += ch;
        } else {
            buf = '';   // 规则体内部文本（声明值）无需收集
        }
    }
    return out;
}

describe('漫画编辑器 CSS 拆分契约（manga-editor 三件套）', () => {
    test('三个文件都存在且非空', () => {
        for (const name of FILES) {
            const css = read(name);
            expect(css.trim().length).toBeGreaterThan(0);
        }
    });

    test('各文件花括号配对（结构完好）', () => {
        for (const name of FILES) {
            const src = stripComments(read(name));
            const open = (src.match(/\{/g) || []).length;
            const close = (src.match(/\}/g) || []).length;
            expect(open).toBe(close);
            expect(open).toBeGreaterThan(0);   // 空壳文件也算破坏
        }
    });

    test('跨文件选择器零重复（同一选择器只归属一个文件）', () => {
        // 按文件收集选择器集合后两两求交——文件内部同选择器分两条规则
        // 各写部分声明是本项目的既有写法（如基础规则 + 窄屏 @media 覆盖
        // 同文件分写），不属拆分违规
        const byFile = new Map();   // 文件名 → Set<选择器>
        for (const name of FILES) {
            byFile.set(name, new Set(parseSelectors(read(name))));
        }
        const dupes = [];
        for (let i = 0; i < FILES.length; i++) {
            for (let j = i + 1; j < FILES.length; j++) {
                for (const sel of byFile.get(FILES[i])) {
                    if (byFile.get(FILES[j]).has(sel)) {
                        dupes.push(`${sel}  →  ${FILES[i]} 与 ${FILES[j]}`);
                    }
                }
            }
        }
        expect(dupes).toEqual([]);
    });

    test('index.html 按契约顺序加载三件套（均在 recipe-manager.css 之后）', () => {
        const html = fs.readFileSync(
            path.join(__dirname, '..', '..', 'index.html'), 'utf8');
        const pos = FILES.map(name => html.indexOf(`css/${name}"`));
        pos.forEach(p => expect(p).toBeGreaterThan(-1));   // 三个都引用了
        const sorted = [...pos].sort((a, b) => a - b);
        expect(pos).toEqual(sorted);                       // 顺序 = 契约顺序
        const base = html.indexOf('css/recipe-manager.css"');
        expect(base).toBeGreaterThan(-1);
        expect(base).toBeLessThan(pos[0]);                 // 骨架样式在前
    });

    test('各 UI 区域代表选择器落在正确文件（防整块搬家搬错地方）', () => {
        const cases = [
            // [文件, 选择器, 区域说明]
            ['manga-editor.css', '.manga-dialog', '窗口壳：并排留白'],
            ['manga-editor.css', '.manga-resize-handle', '窗口壳：右缘拖拽手柄'],
            ['manga-editor.css', '.manga-rail', '页面栏：缩略图列表'],
            ['manga-editor.css', '.manga-page-thumb', '页面栏：单页缩略图'],
            ['manga-editor.css', '.manga-body', '主体：三栏横排框架'],
            ['manga-editor.css', '.manga-footer', '底栏：操作行'],
            ['manga-editor.css', '.manga-ai-btn', '底栏：AI 分体钮主区'],
            ['manga-editor.css', '.manga-gen-mode', '底栏：Comfy|API 段开关'],
            ['manga-editor.css', '.manga-gen-btn', '底栏：生成按钮'],
            ['manga-panel.css', '.manga-side', '左栏：面板壳'],
            ['manga-panel.css', '.manga-summary', '左栏：整体描述框'],
            ['manga-panel.css', '.manga-items-eye', '左栏：分区级眼睛钮'],
            ['manga-panel.css', '.manga-item', '左栏：元素卡片'],
            ['manga-panel.css', '.manga-item-shot', '左栏：景别下拉'],
            ['manga-panel.css', '.manga-item-fold', '左栏：折叠开关'],
            ['manga-panel.css', '.manga-item-eye', '左栏：眼睛钮'],
            ['manga-panel.css', '.manga-bbox-n', '左栏：四坐标输入'],
            ['manga-panel.css', '.manga-out-side', '右栏：输出面板壳'],
            ['manga-panel.css', '.manga-palette-grid', '右栏：色板分区网格'],
            ['manga-panel.css', '.manga-swatch', '右栏：色板色块'],
            ['manga-panel.css', '.manga-ai-out', '右栏：输出框'],
            ['manga-panel.css', '.manga-json-note', '右栏：编译尺寸提醒'],
            ['manga-panel.css', '.manga-compile-btn', '右栏：编译/复制钮'],
            ['manga-stage.css', '.manga-stage-wrap', '舞台：壳'],
            ['manga-stage.css', '.manga-stage', '舞台：canvas'],
            ['manga-stage.css', '.manga-bg-tools', '标题栏：背景工具组'],
            ['manga-stage.css', '.manga-brush-tools', '标题栏：画笔选项条（色板+粗细）'],
            ['manga-stage.css', '.manga-text-tools', '标题栏：文字选项条（字体/字号/横竖排/色板）'],
            ['manga-stage.css', '.manga-shape-tools', '标题栏：形状选项条（类型/填充/边框/边宽/圆角）'],
            ['manga-stage.css', '.manga-shape-type-btn', '形状选项条：类型四钮'],
            ['manga-stage.css', '.manga-shape-none-btn', '形状选项条：红斜杠去除钮'],
            ['manga-stage.css', '.manga-font-menu', '标题栏：字体下拉菜单（挂 body fixed 定位）'],
            ['manga-stage.css', '.manga-text-editor', '文字工具：就地编辑框（透明 textarea 壳）'],
            ['manga-stage.css', '.manga-bg-picker', '浮层：画布选图面板']
        ];
        for (const [file, sel, why] of cases) {
            expect(parseSelectors(read(file))).toContain(sel);   // 在
        }
        for (const [, sel] of cases) {
            for (const other of FILES.filter(f => {
                const hit = cases.find(c => c[1] === sel);
                return hit && f !== hit[0];
            })) {
                expect(parseSelectors(read(other))).not.toContain(sel);
            }
        }
    });
});
