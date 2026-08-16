/**
 * ==========================================================================
 * LumenLight 节点文本镜像层（可复用模块）
 * ==========================================================================
 * 作用：给画布节点（.text-node 系面板）的 textarea 配一副"镜像眼镜"——
 *       在输入框上方叠加一个同字号、同排版的透明镜像 div，实现两件事：
 *   1. @引用标记高亮：把文本中匹配 tokenPattern 的片段（如 @图片N）渲染成
 *      彩色 span（textarea 原生无法给部分文字着色）；
 *   2. 自绘光标：原生光标只有约 1px 且随画布缩放（15% 时不足半像素）几乎
 *      不可见，CSS 也无法调整其粗细，改由镜像层在光标位置内联插入一根
 *      粗光标条（.fake-caret，带闪烁动画）。
 *
 * 使用方式：
 *   const layer = new NodeTextMirror(textarea, mirrorDiv, {
 *       tokenPattern: /@图片\d+/g,   // 可选；不传则只画光标不做标记高亮
 *       tokenClass: 'ref-token',     // 可选，标记 span 类名
 *       caretClass: 'fake-caret'     // 可选，光标条 span 类名
 *   });
 *   layer.destroy();  // 节点销毁时调用，移除 document 级监听
 *
 * 同步时机（内部自理，调用方无需关心）：
 *   input / scroll / focus / blur / composition 起止 / document selectionchange
 * ==========================================================================
 */

class NodeTextMirror {
    /**
     * @param {HTMLTextAreaElement} textarea - 节点输入框
     * @param {HTMLElement} mirrorEl - 镜像层 div（须与 textarea 同排版样式，
     *                                 见 css/node.css 的 .text-node-input-mirror）
     * @param {Object} [options]
     * @param {RegExp} [options.tokenPattern] - 需要高亮的片段正则（带 g 标志），不传则不高亮
     * @param {string} [options.tokenClass='ref-token'] - 高亮 span 类名
     * @param {string} [options.caretClass='fake-caret'] - 光标条 span 类名
     */
    constructor(textarea, mirrorEl, options = {}) {
        this.ta = textarea;
        this.mirror = mirrorEl;
        this.tokenPattern = options.tokenPattern || null;
        this.tokenClass = options.tokenClass || 'ref-token';
        this.caretClass = options.caretClass || 'fake-caret';

        this._active = false;      // 镜像层当前是否有内容（避免无效重建）
        this._composing = false;   // 中文输入法组合输入进行中
        this._gutterPx = null;     // 输入框右侧保留宽度（滚动条槽），首次 update 时实测
        this._bind();
    }

    /**
     * 绑定全部同步事件（保存 handler 引用，destroy 时成对移除）
     */
    _bind() {
        this._onInput = () => this.update();
        this._onScroll = () => { this.mirror.scrollTop = this.ta.scrollTop; };
        this._onFocus = () => this.update();
        this._onBlur = () => this.update();
        this._onCompositionStart = () => { this._composing = true; this.update(); };
        this._onCompositionEnd = () => { this._composing = false; this.update(); };
        // 选区/光标位置变化（点击、方向键、拖选）不触发 input 事件，
        // 需要监听 document 级 selectionchange
        this._onSelectionChange = () => {
            if (document.activeElement === this.ta) this.update();
        };

        this.ta.addEventListener('input', this._onInput);
        this.ta.addEventListener('scroll', this._onScroll);
        this.ta.addEventListener('focus', this._onFocus);
        this.ta.addEventListener('blur', this._onBlur);
        this.ta.addEventListener('compositionstart', this._onCompositionStart);
        this.ta.addEventListener('compositionend', this._onCompositionEnd);
        document.addEventListener('selectionchange', this._onSelectionChange);
    }

    /**
     * 重建镜像层内容：纯文本 + 高亮标记 span + 光标位置的自绘光标条。
     * 光标显示规则：仅聚焦且选区折叠时显示；IME 组合输入期间跟随组合串
     * 末端（selectionEnd）。无标记且无光标时清空镜像层。
     */
    update() {
        const v = this.ta.value;

        // 首次执行时实测输入框右侧保留宽度（scrollbar-gutter / 滚动条槽）。
        // 各浏览器数值不同（Chrome thin 滚动条为 10px，旧版 webkit 样式为 6px），
        // 硬编码会导致镜像层排版宽度与输入框不一致——换行点错位后，
        // 自绘光标和高亮标记在行尾画错位置（视觉上"光标卡住"）。
        // offsetWidth - clientWidth 恰好等于边框 + 滚动条槽（边框为 0）。
        // 延迟到首次 update：构造时节点可能尚未挂载 DOM，尺寸无效。
        if (this._gutterPx === null) {
            this._gutterPx = Math.max(0, this.ta.offsetWidth - this.ta.clientWidth);
            this.mirror.style.paddingRight = this._gutterPx + 'px';
        }

        const showCaret = document.activeElement === this.ta &&
            this.ta.selectionStart === this.ta.selectionEnd;
        const caretIndex = showCaret
            ? (this._composing ? this.ta.selectionEnd : this.ta.selectionStart)
            : -1;
        // 每次用 source 新建正则（避免复用实例残留状态）
        const re = this.tokenPattern
            ? new RegExp(this.tokenPattern.source, 'g')
            : null;
        const hasToken = re ? re.test(v) : false;
        // test() 会把 /g 正则的 lastIndex 推进到第一个匹配的末尾，
        // 不归零的话下面的 exec 循环会跳过文本中第一个 @图片N——
        // 它被当成普通文本渲染（镜像层透明），露出下层白字
        if (re) re.lastIndex = 0;

        if (!hasToken && caretIndex < 0) {
            if (this._active) {
                this.mirror.textContent = '';
                this._active = false;
            }
            return;
        }
        this._active = true;

        const frag = document.createDocumentFragment();
        let pos = 0;                        // 已输出到 v 的偏移
        let caretPlaced = false;            // 光标条只插一根
        const placeCaret = () => {
            if (!caretPlaced && caretIndex >= 0 && caretIndex === pos) {
                frag.appendChild(this._makeCaret());
                caretPlaced = true;
            }
        };
        // 输出 [pos, end) 的纯文本；光标落在段内时拆成两半、中间插光标条
        const emitPlain = (end) => {
            placeCaret();                   // 段首边界恰为光标位置
            if (end > pos) {
                if (caretIndex > pos && caretIndex < end) {
                    frag.appendChild(document.createTextNode(v.slice(pos, caretIndex)));
                    frag.appendChild(this._makeCaret());
                    frag.appendChild(document.createTextNode(v.slice(caretIndex, end)));
                    caretPlaced = true;
                } else {
                    frag.appendChild(document.createTextNode(v.slice(pos, end)));
                }
            }
            pos = end;
            placeCaret();                   // 段尾边界（标记起点）恰为光标位置
        };

        if (re) {
            let m;
            while ((m = re.exec(v)) !== null) {
                emitPlain(m.index);
                const tEnd = m.index + m[0].length;
                if (caretIndex > m.index && caretIndex < tEnd) {
                    // 光标在标记内部：拆成两个高亮 span，中间插光标条，
                    // 否则整个标记作为一个 span 无法在中间落光标（光标会消失）。
                    // 两个 span 同样式紧邻、透明底，视觉上与单个标记完全一致
                    frag.appendChild(this._makeToken(m[0].slice(0, caretIndex - m.index)));
                    frag.appendChild(this._makeCaret());
                    caretPlaced = true;
                    frag.appendChild(this._makeToken(m[0].slice(caretIndex - m.index)));
                } else {
                    frag.appendChild(this._makeToken(m[0]));
                }
                pos = tEnd;
                placeCaret();
            }
        }
        emitPlain(v.length);
        placeCaret();

        // 文本以换行结尾时补一个零宽字符，让镜像层的末行行盒与 textarea
        // 一致，避免滚动到底部时 scrollTop 同步钳制错位
        if (v.endsWith('\n')) {
            frag.appendChild(document.createTextNode('\u200b'));
        }
        this.mirror.replaceChildren(frag);
        this.mirror.scrollTop = this.ta.scrollTop;
    }

    /**
     * 创建高亮标记 span
     * @param {string} text - 标记文本
     * @returns {HTMLSpanElement}
     */
    _makeToken(text) {
        const span = document.createElement('span');
        span.className = this.tokenClass;
        span.textContent = text;
        return span;
    }

    /**
     * 创建自绘光标条 span（样式见 .fake-caret）
     * @returns {HTMLSpanElement}
     */
    _makeCaret() {
        const span = document.createElement('span');
        span.className = this.caretClass;
        return span;
    }

    /**
     * 销毁：移除挂在 textarea 与 document 上的全部监听（节点删除时调用）
     */
    destroy() {
        this.ta.removeEventListener('input', this._onInput);
        this.ta.removeEventListener('scroll', this._onScroll);
        this.ta.removeEventListener('focus', this._onFocus);
        this.ta.removeEventListener('blur', this._onBlur);
        this.ta.removeEventListener('compositionstart', this._onCompositionStart);
        this.ta.removeEventListener('compositionend', this._onCompositionEnd);
        document.removeEventListener('selectionchange', this._onSelectionChange);
    }
}

// 将 NodeTextMirror 类暴露到全局作用域
window.NodeTextMirror = NodeTextMirror;
