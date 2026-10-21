/**
 * ==========================================================================
 * ImageStudio CSS 拆分契约测试（image-studio.css / -panel / -picker 三件套）
 * ==========================================================================
 * 拆分约定（见 css/image-studio.css 文件头）：三文件按序加载、选择器互不
 * 相交。本测试不测视觉（无头环境渲染不了），测的是「拆分结构本身」——
 * 防止后续往任一文件加样式时把选择器加错文件/重复定义，或调整 index.html
 * 加载顺序时无声破坏契约：
 *   1. 三文件存在且非空；
 *   2. 花括号配对（文件结构完好）；
 *   3. 跨文件选择器零重复（拆分红线：同一选择器只允许出现在一个文件；
 *      文件内部重复定义合法——如 .image-studio.cropping .is-crop 分两处
 *      各写一条声明）；
 *   4. index.html 按契约顺序加载三件套；
 *   5. 各 UI 区域的代表选择器落在正确文件里（防止整块搬家搬错地方）。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');

const CSS_DIR = path.join(__dirname, '..', '..', 'css');
const FILES = [
    'image-studio.css',        // 主文件：布局壳 + 顶栏（先加载）
    'image-studio-panel.css',  // 右侧面板区（次加载）
    'image-studio-picker.css', // 画布选图弹窗
    'image-studio-adjust.css'  // 调色工具弹窗（末加载）
];

/** 读文件（相对 css/ 目录） */
const read = (name) =>
    fs.readFileSync(path.join(CSS_DIR, name), 'utf8');

/** 去掉 /* ... *​/ 注释（跨行），让选择器/括号解析不受注释干扰 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * 解析一份 CSS 的全部顶层选择器组：
 * 按 { 与 } 扫深度，取每条规则开括号前的选择器文本，再按逗号拆成
 * 单个选择器（多行选择器组合并换行为单空格）。@规则（@media 等）
 * 内部的嵌套选择器也会被收集——本三件套目前没有 @media，语义等价
 * 于顶层；引入嵌套 @ 规则时该函数依旧正确（嵌套选择器同样受查重约束）。
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

describe('ImageStudio CSS 拆分契约（image-studio 三件套）', () => {
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
        // 各写部分声明是本项目的既有写法（如 .image-studio.cropping
        // .is-crop 在主文件分写 display 与 cursor），不属拆分违规
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

    test('index.html 按契约顺序加载三件套（均在 image-editor.css 之后）', () => {
        const html = fs.readFileSync(
            path.join(__dirname, '..', '..', 'index.html'), 'utf8');
        const pos = FILES.map(name => html.indexOf(`css/${name}"`));
        pos.forEach(p => expect(p).toBeGreaterThan(-1));   // 三个都引用了
        const sorted = [...pos].sort((a, b) => a - b);
        expect(pos).toEqual(sorted);                       // 顺序 = 契约顺序
        const editor = html.indexOf('css/image-editor.css"');
        expect(editor).toBeGreaterThan(-1);
        expect(editor).toBeLessThan(pos[0]);               // 基础样式在前
    });

    test('各 UI 区域代表选择器落在正确文件（防整块搬家搬错地方）', () => {
        const cases = [
            // [文件, 选择器, 区域说明]
            ['image-studio.css', '.is-toolbar', '布局壳：左工具栏'],
            ['image-studio.css', '.is-side', '布局壳：右侧面板壳'],
            ['image-studio.css', '.is-flip-btn', '顶栏：翻转图标钮'],
            ['image-studio.css', '.is-rotate-btn', '顶栏：旋转图标钮'],
            ['image-studio.css', '.is-file-menu', '顶栏：浮起层菜单'],
            ['image-studio.css', '.is-paint-surface', '画布层：统一绘制面'],
            ['image-studio.css', '.is-text-editor', '文字工具：就地编辑框'],
            ['image-studio-panel.css', '.is-layer-row', '面板：图层面板行'],
            ['image-studio-panel.css', '.is-ctxmenu', '面板：图层右键菜单'],
            ['image-studio-panel.css', '.is-cp-hex', '面板：内嵌取色器'],
            ['image-studio-panel.css', '.is-history-row', '面板：历史面板'],
            ['image-studio-panel.css', '.is-palette', '面板：色板容器'],
            ['image-studio-picker.css', '.is-picker-grid', '弹窗：瀑布流网格'],
            ['image-studio-picker.css', '.is-picker-badge', '弹窗：勾选角标'],
            ['image-studio-picker.css', '.is-picker-ok', '弹窗：确认按钮'],
            ['image-studio-adjust.css', '.is-adjust', '弹窗：调色面板壳'],
            ['image-studio-adjust.css', '.is-adjust-tab', '弹窗：调色分段 tab'],
            ['image-studio-adjust.css', '.is-adjust-save', '弹窗：调色保存按钮']
        ];
        for (const [file, sel, why] of cases) {
            expect(parseSelectors(read(file))).toContain(sel);   // 在
        }
        for (const [, sel, why] of cases) {
            for (const other of FILES.filter(f => {
                const hit = cases.find(c => c[1] === sel);
                return hit && f !== hit[0];
            })) {
                expect(parseSelectors(read(other))).not.toContain(sel);
            }
        }
    });
});
