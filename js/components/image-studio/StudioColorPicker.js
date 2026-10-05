/**
 * ==========================================================================
 * ImageStudio 子模块：色板取色器（PS 式内嵌面板，自 StudioDomBuilder
 * 色板段的「预设块 + 原生弹窗」方案升级）
 * 作用：内嵌取色面板——当前色/上次色叠放块 + SV 渐变方框（横=饱和度、
 *       纵=明度）+ 垂直色相条 + Hex 输入。拖拽 SV/色相实时
 *       setColor（画笔/文字颜色即时跟随），松手确认入最近使用色；
 *       预设/最近色块点击（外部来色）经 setColor → syncFromColor
 *       反向同步面板 UI。
 * 颜色流：唯一出口 studio.setColor(hex)；唯一入口 syncFromColor(hex)
 *       （以 _hex 去重防回环）。上次色 = 每次拖拽/Hex 提交开始时的
 *       当前色，点击上次色块回填（PS 同款）。
 * 契约：构造时传入宿主实例；DomBuilder 调 mount(host) 构建面板；
 *       主类 setColor 调 syncFromColor、pushRecentColor 薄代理到
 *       DomBuilder 的最近色逻辑。
 * ==========================================================================
 */

class StudioColorPicker {
    constructor(studio) {
        this.studio = studio;
        this.hsv = { h: 0, s: 0, v: 0 };
        this.prev = null;       // 上次色（hex，拖拽/提交开始时快照）
        this._hex = null;       // 面板当前色 hex（syncFromColor 去重）
        this._drag = null;      // 'sv' | 'hue' | null
    }

    // ==================== 颜色纯函数 ====================

    static hexToRgb(hex) {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
        if (!m) return null;
        const n = parseInt(m[1], 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }

    static rgbToHex(r, g, b) {
        const to = (n) =>
            Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
        return '#' + to(r) + to(g) + to(b);
    }

    static hsvToRgb(h, s, v) {
        const f = (n) => {
            const k = (n + h / 60) % 6;
            return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
        };
        return { r: f(5) * 255, g: f(3) * 255, b: f(1) * 255 };
    }

    static rgbToHsv(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
        let h = 0;
        if (d) {
            if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
            else if (max === g) h = ((b - r) / d + 2) * 60;
            else h = ((r - g) / d + 4) * 60;
        }
        return { h, s: max ? d / max : 0, v: max };
    }

    // ==================== DOM 与交互 ====================

    /** DomBuilder 挂载：构建面板 DOM 到宿主容器 */
    mount(host) {
        const studio = this.studio;
        const wrap = document.createElement('div');
        wrap.className = 'is-color-picker';

        // 主区：SV 渐变方框（横=饱和度、纵=明度）+ 垂直色相条
        this.svEl = document.createElement('div');
        this.svEl.className = 'is-cp-sv';
        this.svCursor = document.createElement('div');
        this.svCursor.className = 'is-cp-sv-cursor';
        this.svEl.appendChild(this.svCursor);
        this.hueEl = document.createElement('div');
        this.hueEl.className = 'is-cp-hue';
        this.hueCursor = document.createElement('div');
        this.hueCursor.className = 'is-cp-hue-cursor';
        this.hueEl.appendChild(this.hueCursor);
        const main = document.createElement('div');
        main.className = 'is-cp-main';
        main.append(this.svEl, this.hueEl);

        // 当前色/上次色叠放块（上次色在右下露一角，点击回填，PS 同款）
        const pair = document.createElement('div');
        pair.className = 'is-cp-pair';
        this.curEl = document.createElement('div');
        this.curEl.className = 'is-cp-cur';
        this.prevEl = document.createElement('button');
        this.prevEl.className = 'is-cp-prev';
        this.prevEl.title = '上次使用色：点击恢复';
        this.prevEl.addEventListener('click', () => {
            if (!this.prev) return;
            studio.setColor(this.prev);
            studio.pushRecentColor(this.prev);
        });
        pair.append(this.curEl, this.prevEl);

        // Hex 输入（回车/失焦确认，非法回显当前色）
        this.hexEl = document.createElement('input');
        this.hexEl.type = 'text';
        this.hexEl.className = 'is-cp-hex';
        this.hexEl.maxLength = 7;
        this.hexEl.spellcheck = false;
        this.hexEl.title = '十六进制色值，回车确认';
        this.hexEl.addEventListener('keydown', (e) => {
            e.stopPropagation();   // 编辑器全局快捷键让路
            if (e.key === 'Enter') { e.preventDefault(); this.hexEl.blur(); }
        });
        this.hexEl.addEventListener('change', () => {
            const rgb = StudioColorPicker.hexToRgb(this.hexEl.value);
            if (!rgb) { this._syncHexInput(); return; }
            this.prev = studio.color;   // 提交前的色即上次色
            this.hsv = StudioColorPicker.rgbToHsv(rgb.r, rgb.g, rgb.b);
            this._apply();
            studio.pushRecentColor(this._hex);
        });

        const row = document.createElement('div');
        row.className = 'is-cp-row';
        row.append(pair, this.hexEl);
        wrap.append(main, row);
        host.appendChild(wrap);

        // SV/色相拖拽：按下记上次色 + 指针捕获（拖出面板持续跟踪），
        // 松手确认入最近使用色
        const bindDrag = (el, onPos) => {
            el.addEventListener('pointerdown', (e) => {
                if (!studio._readyDone) return;
                e.preventDefault();
                this.prev = studio.color;
                el.setPointerCapture(e.pointerId);
                this._drag = true;
                onPos(e);
            });
            el.addEventListener('pointermove', (e) => { if (this._drag) onPos(e); });
            const up = () => {
                if (!this._drag) return;
                this._drag = null;
                studio.pushRecentColor(this._hex);
            };
            el.addEventListener('pointerup', up);
            el.addEventListener('pointercancel', up);
        };
        bindDrag(this.svEl, (e) => {
            const r = this.svEl.getBoundingClientRect();
            this.hsv.s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
            this.hsv.v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
            this._apply();
        });
        bindDrag(this.hueEl, (e) => {
            const r = this.hueEl.getBoundingClientRect();
            this.hsv.h = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) * 360;
            this._apply();
        });

        this.syncFromColor(studio.color);   // 初始 UI 对齐当前色
    }

    // ==================== 颜色流转 ====================

    /** 外部来色同步（主类 setColor 调）：hex 相同跳过，防 setColor 回环 */
    syncFromColor(value) {
        const rgb = StudioColorPicker.hexToRgb(value);
        if (!rgb) return;
        const hex = StudioColorPicker.rgbToHex(rgb.r, rgb.g, rgb.b);
        if (hex === this._hex) return;
        this.hsv = StudioColorPicker.rgbToHsv(rgb.r, rgb.g, rgb.b);
        this._hex = hex;
        this._render();
    }

    /** 拖拽/Hex 改色：渲染面板并写 studio.setColor（syncFromColor 因
     *  _hex 已更新而跳过，不回环） */
    _apply() {
        const rgb = StudioColorPicker.hsvToRgb(this.hsv.h, this.hsv.s, this.hsv.v);
        this._hex = StudioColorPicker.rgbToHex(rgb.r, rgb.g, rgb.b);
        this._render();
        this.studio.setColor(this._hex);
    }

    _render() {
        // SV 方框底色 = 两层渐变叠加：黑（自下）+ 白→当前色相纯色（自右）
        this.svEl.style.background =
            'linear-gradient(to top, #000, rgba(0,0,0,0)), ' +
            `linear-gradient(to right, #fff, hsl(${this.hsv.h}, 100%, 50%))`;
        this.svCursor.style.left = (this.hsv.s * 100) + '%';
        this.svCursor.style.top = ((1 - this.hsv.v) * 100) + '%';
        this.hueCursor.style.top = (this.hsv.h / 360 * 100) + '%';
        this.curEl.style.background = this._hex || 'transparent';
        this.prevEl.style.background = this.prev || 'transparent';
        this._syncHexInput();
    }

    /** Hex 输入框回显当前色（聚焦中不打扰输入） */
    _syncHexInput() {
        if (document.activeElement !== this.hexEl) {
            this.hexEl.value = (this._hex || '').toUpperCase();
        }
    }
}

// 暴露到全局作用域（经典 script，ImageStudio.js 之后实例化时消费）
window.StudioColorPicker = StudioColorPicker;
