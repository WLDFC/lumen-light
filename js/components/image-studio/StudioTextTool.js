/**
 * ==========================================================================
 * ImageStudio 子模块：文字工具（给图层添加/编辑文字）
 * 作用：文字层 = 属性驱动的普通图层——文字按属性（内容/字体/字号/横竖排/
 *       颜色）渲染进图层自己的 paintCv，移动/缩放/透明度/删除/保存拍平
 *       全部复用现有图层管线（保存契约零改动：拍平时它就是一层像素）。
 *       可再编辑性靠文字属性随 studioLayers 序列化（StudioSave 落盘、
 *       ImageStudio.open 恢复时按属性重渲染），文字工具下点击文字层即
 *       重新进入编辑。
 * 交互（PS 文字工具同款）：点击画布 → 新建文字层并就地输入；点击已有
 *       文字层 → 再次编辑；Ctrl+Enter 或点击编辑框外 → 提交；Esc → 撤销
 *       本次修改；提交时空内容 → 删除该层（新建）或恢复原文字（重编辑）。
 * 竖排：canvas 无原生竖排，逐字自绘——CJK 字符直立逐字下排（列自右向
 *       左），连续西文/数字段整体顺时针旋转 90°（顶朝右，PS 同规则）。
 * 契约：构造时传入宿主 ImageStudio 实例并读写其字段与方法（studio.xxx）；
 *       主类保留同名薄代理（_onTextDown/_renderTextLayer）。
 * ==========================================================================
 */

class StudioTextTool {
    /** 行距/列距与竖排字距（字号倍数）——画布渲染与编辑框样式共用同一值，
     *  保证提交瞬间（textarea → 位图）文字位置不跳 */
    static LINE_H = 1.4;
    static CHAR_ADV = 1.15;

    /** 精选字体清单（Windows 自带中文字体 + 常见西文）。
     *  浏览器枚举全部本地字体需 queryLocalFonts（Chromium，需授权一次），
     *  顶栏字体菜单里可按需补充加载；不支持的浏览器保持本清单 */
    static FONTS = [
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

    constructor(studio) {
        this.studio = studio;
        this.editing = null;   // 编辑态 { layer, ta, prev, prevName, isNew }
    }

    /** 枚举全部本地字体（Chromium queryLocalFonts，需用户授权一次）。
     *  不支持或用户拒绝授权时返回 null，字体菜单维持精选清单 */
    static async loadSystemFonts() {
        if (!window.queryLocalFonts) return null;
        try {
            const fonts = await window.queryLocalFonts();
            const seen = new Set();
            const list = [];
            for (const f of fonts) {
                if (seen.has(f.family)) continue;
                seen.add(f.family);
                list.push({ label: f.family, family: f.family });
            }
            return list;
        } catch {
            return null;
        }
    }

    // ==================== 输入路由（主类 _onPaintDown 转发） ====================

    /** 文字工具按下：编辑中 → 点击编辑框外 = 提交；否则命中文字层重编辑、
     *  空白处新建文字层并就地输入 */
    _onTextDown(e) {
        const studio = this.studio;
        if (!studio._readyDone) return;
        e.preventDefault();
        if (this.editing) { this.commitEdit(); return; }
        const pos = studio._toImagePos(e);
        const hit = this._hitTextLayerAt(pos);
        if (hit) {
            studio._setActive(hit.id);
            this._beginEdit(hit, false);
        } else {
            const layer = studio.addTextLayer(pos);
            this._beginEdit(layer, true);
        }
    }

    /** 自栈顶向下找第一个命中的可见文字层（文字层恒在图片层之上） */
    _hitTextLayerAt(pos) {
        const studio = this.studio;
        for (let i = studio.layers.length - 1; i >= 2; i--) {
            const layer = studio.layers[i];
            if (!layer.isText || !layer.visible || layer.empty) continue;
            const w = layer.paintCv.width * layer.tscale;
            const h = layer.paintCv.height * layer.tscale;
            if (pos.x >= layer.tx && pos.x <= layer.tx + w &&
                pos.y >= layer.ty && pos.y <= layer.ty + h) return layer;
        }
        return null;
    }

    // ==================== 编辑态 ====================

    /** 进入就地编辑：图层画布隐藏，覆盖一层同字体/字号/颜色的透明
     *  textarea 呈现文字（所见即所得）；位图在提交时才渲染 */
    _beginEdit(layer, isNew) {
        const studio = this.studio;
        const ta = document.createElement('textarea');
        ta.className = 'is-text-editor';
        ta.value = layer.text.content;
        ta.spellcheck = false;
        studio.stageEl.appendChild(ta);
        this.editing = {
            layer, ta, isNew,
            prev: layer.text.content,      // Esc 撤销本次修改用
            prevName: layer.name
        };
        ta.addEventListener('input', () => this._onInput());
        ta.addEventListener('keydown', (e) => {
            // 阻断全局快捷键（文档级 keydown 对 TEXTAREA 目标本就放行，
            // 这里再拦一层冒泡保险）
            e.stopPropagation();
            if (e.key === 'Escape') {
                e.preventDefault();
                this.cancelEdit();
            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this.commitEdit();
            }
        });
        layer.paintCv.style.visibility = 'hidden';
        this._render(layer);
        this._syncEditor();
        studio._drawSelOverlay();
        ta.focus();
        if (!isNew) ta.select();   // 重编辑全选原文字，输入即整体替换
    }

    /** 编辑框几何/样式同步：与图层画布同源换算（文档坐标 → 舞台像素，
     *  小数不取整），内边距 = 渲染周边距 → 编辑框文字与提交位图逐像素对位 */
    _syncEditor() {
        const studio = this.studio;
        if (!this.editing) return;
        const { layer, ta } = this.editing;
        const t = layer.text;
        const zoom = studio.zoom;
        const pad = Math.ceil(t.size * 0.3) * layer.tscale;
        ta.style.left = (studio._wrapLeft + (layer.tx - studio.frame.fx) * zoom) + 'px';
        ta.style.top = (studio._wrapTop + (layer.ty - studio.frame.fy) * zoom) + 'px';
        ta.style.width = Math.max(4, layer.paintCv.width * layer.tscale * zoom) + 'px';
        ta.style.height = Math.max(4, layer.paintCv.height * layer.tscale * zoom) + 'px';
        ta.style.padding = (pad * zoom) + 'px';
        ta.style.font = `${t.size * layer.tscale * zoom}px "${t.font}", sans-serif`;
        ta.style.lineHeight = String(StudioTextTool.LINE_H);
        ta.style.color = t.color;
        ta.style.writingMode = t.vertical ? 'vertical-rl' : 'horizontal-tb';
        // 竖排字距与画布渲染的 CHAR_ADV 对齐（横排由行高承担）
        ta.style.letterSpacing = t.vertical
            ? `${(StudioTextTool.CHAR_ADV - 1) * t.size * layer.tscale * zoom}px`
            : 'normal';
    }

    /** 输入中：内容写回文字属性并重渲染（画布元素编辑期隐藏，但尺寸
     *  驱动选中框与编辑框跟随内容增长） */
    _onInput() {
        const studio = this.studio;
        if (!this.editing) return;
        const { layer, ta } = this.editing;
        layer.text.content = ta.value;
        this._render(layer);
        studio._positionLayerCanvases(layer);
        this._syncEditor();
        studio._drawSelOverlay();
    }

    /** 提交（Ctrl+Enter / 点击编辑框外 / 切换工具）：位图渲染落地；
     *  空内容 → 新层删除、重编辑层恢复原文字。图层名随内容（PS 同款） */
    commitEdit() {
        const studio = this.studio;
        if (!this.editing) return;
        const { layer, ta, isNew } = this.editing;
        this.editing = null;
        ta.remove();
        layer.paintCv.style.visibility = '';
        if (!layer.text.content.trim()) {
            if (isNew) {
                if (studio.activeLayerId !== layer.id) studio._setActive(layer.id);
                studio.deleteActiveLayer();
            }
            return;
        }
        layer.name = layer.text.content.split('\n')[0].slice(0, 12);
        this._render(layer);
        studio._positionLayerCanvases(layer);
        // 文字内容/结构变化：置 layers 脏驱动保存时重拍平+重新序列化
        studio.dirty.layers = true;
        studio._pushHistory(isNew ? '新建文字' : '编辑文字');
        studio._renderLayerList();
        studio._syncPanels();
        studio._drawSelOverlay();
    }

    /** 取消（Esc）：新建层删除，重编辑层恢复进入编辑前的文字 */
    cancelEdit() {
        const studio = this.studio;
        if (!this.editing) return;
        const { layer, ta, prev, isNew } = this.editing;
        this.editing = null;
        ta.remove();
        layer.paintCv.style.visibility = '';
        if (isNew) {
            if (studio.activeLayerId !== layer.id) studio._setActive(layer.id);
            studio.deleteActiveLayer();
            return;
        }
        layer.text.content = prev;
        this._render(layer);
        studio._positionLayerCanvases(layer);
        studio._drawSelOverlay();
    }

    /** 编辑器关闭时硬清理：只移除编辑框与状态，不动图层栈（close 随即清空） */
    abortEdit() {
        if (!this.editing) return;
        this.editing.ta.remove();
        this.editing.layer.paintCv.style.visibility = '';
        this.editing = null;
    }

    // ==================== 顶栏选项实时应用 ====================

    /** 选项作用目标：编辑中的层优先；未编辑时落到当前选中的文字层
     *  （选中文字层后改字号/字体/方向也要生效，用户实测指出的漏 Case） */
    _targetLayer() {
        const studio = this.studio;
        if (this.editing) return this.editing.layer;
        const active = studio._activeLayer();
        return active && active.isText ? active : null;
    }

    /** 色板选色改文字颜色（文字工具下选色不切回画笔） */
    applyColor(value) {
        const studio = this.studio;
        const layer = this._targetLayer();
        if (!layer) return;
        layer.text.color = value;
        if (this.editing) this.editing.ta.style.color = value;
        this._render(layer);
        // 内容变化：置 layers 脏驱动保存时重拍平+重新序列化
        studio.dirty.layers = true;
    }

    /** 字体/字号/横竖排改动写入文字层（未选中文字层时只更新 textOpts，
     *  作为下次添加文字的默认值） */
    applyOpts() {
        const studio = this.studio;
        const layer = this._targetLayer();
        if (!layer) return;
        layer.text.font = studio.textOpts.font;
        layer.text.size = studio.textOpts.size;
        layer.text.vertical = studio.textOpts.vertical;
        this._render(layer);
        studio._positionLayerCanvases(layer);
        if (this.editing) this._syncEditor();
        // 画布尺寸变化驱动选中框跟随；置 layers 脏驱动保存重算
        studio.dirty.layers = true;
        studio._drawSelOverlay();
    }

    // ==================== 文字渲染 ====================

    /** 把文字按属性渲染进图层画布（画布尺寸 = 文字紧致包围盒 + 周边距，
     *  周边距防字形边缘裁切；空内容画布保持最小可点尺寸且 empty=true，
     *  命中检测跳过）。编辑中画布隐藏但尺寸照常更新 */
    _render(layer) {
        const t = layer.text;
        const size = Math.max(4, t.size);
        const pad = Math.ceil(size * 0.3);
        const font = `${size}px "${t.font}", sans-serif`;
        const lines = String(t.content || '').split('\n');
        const mctx = document.createElement('canvas').getContext('2d');
        mctx.font = font;
        let w; let h;
        if (!t.vertical) {
            // 横排：宽 = 最长行，高 = 行数 × 行距
            let maxW = 0;
            for (const line of lines) maxW = Math.max(maxW, mctx.measureText(line).width);
            w = Math.max(maxW, size);
            h = Math.max(lines.length * size * StudioTextTool.LINE_H, size);
        } else {
            // 竖排：列数 = 行数（列宽 = 字号 × 行距），列高 = 列内推进总和
            w = Math.max(lines.length * size * StudioTextTool.LINE_H, size);
            let maxCol = 0;
            for (const line of lines) {
                let col = 0;
                for (const run of this._splitRuns(line)) {
                    col += run.cjk
                        ? [...run.text].length * size * StudioTextTool.CHAR_ADV
                        : mctx.measureText(run.text).width;
                }
                maxCol = Math.max(maxCol, col);
            }
            h = Math.max(maxCol, size);
        }
        const cv = layer.paintCv;
        cv.width = Math.ceil(w) + pad * 2;
        cv.height = Math.ceil(h) + pad * 2;
        const g = cv.getContext('2d');
        g.clearRect(0, 0, cv.width, cv.height);
        if (!t.content) { layer.empty = true; return; }
        layer.empty = false;
        g.font = font;
        g.fillStyle = t.color;
        if (!t.vertical) {
            g.textAlign = 'left';
            // 垂直方向复刻 CSS 行盒排版（编辑态 textarea → 提交位图不跳）：
            // 基线 y = 行盒顶 + 半行距 + 字体内容区上升高。textBaseline='top'
            // 是 em 顶贴行顶，与 textarea 的半行距居中差约半个行距——表现为
            // 提交/切工具瞬间文字上跳（用户实测）。fontBoundingBox 不可用的
            // 环境退回行盒中心对齐（'middle' 近似内容区居中）
            const m = mctx.measureText('字');
            const fa = m.fontBoundingBoxAscent;
            const fd = m.fontBoundingBoxDescent;
            if (Number.isFinite(fa) && Number.isFinite(fd)) {
                g.textBaseline = 'alphabetic';
                const halfLead = (size * StudioTextTool.LINE_H - (fa + fd)) / 2;
                lines.forEach((line, i) =>
                    g.fillText(line, pad,
                        pad + i * size * StudioTextTool.LINE_H + halfLead + fa));
            } else {
                g.textBaseline = 'middle';
                lines.forEach((line, i) =>
                    g.fillText(line, pad, pad + (i + 0.5) * size * StudioTextTool.LINE_H));
            }
        } else {
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            // 列自右向左：首列中心 = 画布右缘内缩半列
            let colCx = cv.width - pad - (size * StudioTextTool.LINE_H) / 2;
            for (const line of lines) {
                let cy = pad;
                for (const run of this._splitRuns(line)) {
                    if (run.cjk) {
                        // CJK 字符直立逐字下排
                        for (const ch of run.text) {
                            g.fillText(ch, colCx, cy + (size * StudioTextTool.CHAR_ADV) / 2);
                            cy += size * StudioTextTool.CHAR_ADV;
                        }
                    } else {
                        // 西文/数字段整体顺时针转 90°（顶朝右，自上而下读）
                        const rw = g.measureText(run.text).width;
                        g.save();
                        g.translate(colCx, cy + rw / 2);
                        g.rotate(Math.PI / 2);
                        g.fillText(run.text, 0, 0);
                        g.restore();
                        cy += rw;
                    }
                }
                colCx -= size * StudioTextTool.LINE_H;
            }
        }
    }

    /** 按行拆 CJK/西文段：CJK（含全角标点）直立，其余整段旋转 */
    _splitRuns(line) {
        const cjkChar = '[\\u2E80-\\u9FFF\\uF900-\\uFAFF\\uFF01-\\uFF60\\u3000-\\u303F]';
        const runs = [];
        for (const m of line.match(new RegExp(`${cjkChar}+|[^${cjkChar}]+`, 'g')) || []) {
            runs.push({ text: m, cjk: new RegExp(`^${cjkChar}`).test(m) });
        }
        return runs;
    }
}

// 暴露到全局作用域（经典 script，ImageStudio.js 之后实例化时消费）
window.StudioTextTool = StudioTextTool;
