/**
 * PromptAutocomplete.js
 * 提示词自动补全组件（UI 层）
 *
 * 功能说明：
 *   1. 在绑定的 textarea/输入框下方显示匹配结果下拉列表，最多 15 条。
 *   2. 支持方向键选择、回车确认、鼠标点击、ESC 关闭。
 *   3. 确认后自动将对应的英文提示词插入到当前光标位置。
 *
 * 数据层已拆分到共享单例 PromptDictStore（词典加载 / IndexedDB 缓存 /
 * 小写索引 / 匹配搜索）。本组件只负责 UI 与交互，所有实例共享一份数据，
 * 可安全地绑定到任意数量的输入框（含动态创建销毁的画布节点）。
 *
 * 中文输入法（IME）兼容：
 *   组合输入期间（选拼音候选、回车上屏）不劫持任何按键、不触发搜索，
 *   组合结束后自动刷新一次查询——避免输入法候选导航被补全下拉抢占。
 *
 * 生命周期：
 *   面板输入框与页面同生命周期可直接忽略；画布节点等动态场景销毁时
 *   必须调用 destroy() 释放监听与下拉 DOM。
 *
 * 定位策略（IDE 式光标就近弹出）：
 *   下拉锚定在当前补全词起点（光标所在行）而不是整个输入框矩形——
 *   textarea 原生不暴露光标坐标，用镜像测量法求得：在 textarea 的
 *   offsetParent（同一 CSS transform 上下文）内放一个同宽同排版、
 *   不可见的测量 div，文本截到锚点后放零宽标记 span，Range 量出的
 *   矩形即屏幕坐标（画布节点的 --ns 缩放无需手动换算），再补偿
 *   textarea 自身滚动量。排版样式逐项复制 computed style，改字号/
 *   行高/内边距不会错位。下方空间不足时翻转到词起点上方。
 *
 * 词典数据结构（见 PromptDictStore）：
 *   [{ "cn": "1个女孩", "en": "1girl" }, { "cn": "高分辨率", "en": "highres" }]
 */
class PromptAutocomplete {
    /**
     * 构造函数
     * @param {HTMLTextAreaElement|HTMLInputElement} inputElement - 需要绑定自动补全的输入框
     * @param {Object} options - 可选配置
     * @param {number} options.maxResults - 最大显示条数，默认 15
     * @param {number} options.debounceMs - 输入防抖毫秒数，默认 150
     */
    constructor(inputElement, options = {}) {
        this.input = inputElement;
        this.maxResults = options.maxResults || 15;
        this.debounceMs = options.debounceMs || 150;

        // 组件状态
        this.filtered = [];          // 当前匹配结果
        this.activeIndex = -1;       // 当前高亮项索引
        this.isOpen = false;         // 下拉列表是否显示
        this.debounceTimer = null;   // 输入防抖定时器
        this.lastQueryStart = 0;     // 当前匹配词在输入框中的起始位置
        this.lastQueryEnd = 0;       // 当前匹配词在输入框中的结束位置
        this._measurer = null;       // 光标测量 div（懒创建，随宿主销毁）

        // 初始化 DOM 元素
        this.listEl = this.createListElement();
        document.body.appendChild(this.listEl);

        this.bindEvents();

        // 订阅词典状态：组件创建时词典可能仍在加载（或刚失败），
        // 就绪后刷新一次打开中的下拉；destroy 时取消订阅
        this._unsubStore = PromptDictStore.subscribe((status) => {
            if (status === 'ready' && this.isOpen) {
                this.performSearch();
            }
        });
        PromptDictStore.ensureLoaded();
    }

    /**
     * 创建下拉列表 DOM 元素
     * @returns {HTMLElement} 下拉列表容器
     */
    createListElement() {
        const el = document.createElement('div');
        el.className = 'prompt-autocomplete-list';
        return el;
    }

    /**
     * 绑定输入框相关事件（保存 handler 引用，destroy 时成对移除）
     */
    bindEvents() {
        this._onInput = (e) => this.onInput(e);
        this._onKeyDown = (e) => this.onKeyDown(e);
        this._onBlur = () => this.onBlur();
        this._onCompositionEnd = () => this.performSearch();
        this._onListMousedown = (e) => e.preventDefault();
        this._onListClick = (e) => this.onListClick(e);
        this._onReposition = () => this.updatePosition();
        this._onSelectionChange = () => this.onSelectionChange();

        this.input.addEventListener('input', this._onInput);
        this.input.addEventListener('keydown', this._onKeyDown);
        this.input.addEventListener('blur', this._onBlur);
        // IME 组合结束（中文上屏）后再搜一次：组合期间的 input 事件被跳过
        this.input.addEventListener('compositionend', this._onCompositionEnd);
        // 注意：刻意不监听 focus——点击聚焦时光标尚未落到点击位置
        // （focus 先于光标落点），用旧位置搜索会弹出错误词的补全框再被
        // 随后的 selectionchange 关掉（闪现后消失）。补全只由真实键入
        // 触发；下拉已打开时的光标移动由下面的 selectionchange 跟随

        // 光标移动（点击、方向键）不触发 input 事件，需 document 级
        // selectionchange 跟随：下拉打开时光标移出查询词则重新提取，
        // 词内移动则仅重定位
        document.addEventListener('selectionchange', this._onSelectionChange);

        // 点击下拉列表时不触发输入框 blur，避免无法点击选择
        this.listEl.addEventListener('mousedown', this._onListMousedown);
        this.listEl.addEventListener('click', this._onListClick);

        // 窗口大小改变或滚动时重新定位
        window.addEventListener('resize', this._onReposition);
        window.addEventListener('scroll', this._onReposition, true);
    }

    /**
     * 销毁组件：移除全部监听与下拉 DOM（动态创建的宿主销毁时必须调用）
     */
    destroy() {
        clearTimeout(this.debounceTimer);
        this._unsubStore();

        this.input.removeEventListener('input', this._onInput);
        this.input.removeEventListener('keydown', this._onKeyDown);
        this.input.removeEventListener('blur', this._onBlur);
        this.input.removeEventListener('compositionend', this._onCompositionEnd);
        this.listEl.removeEventListener('mousedown', this._onListMousedown);
        this.listEl.removeEventListener('click', this._onListClick);
        window.removeEventListener('resize', this._onReposition);
        window.removeEventListener('scroll', this._onReposition, true);
        document.removeEventListener('selectionchange', this._onSelectionChange);

        if (this._measurer) {
            this._measurer.remove();
            this._measurer = null;
        }

        this.listEl.remove();
        this.isOpen = false;
        this.filtered = [];
    }

    /**
     * 输入事件处理，带防抖。
     * IME 组合输入期间跳过：拼音串查词典无意义，且组合结束的
     * compositionend/input 事件会触发最终查询
     * @param {InputEvent} [e]
     */
    onInput(e) {
        if (e && e.isComposing) return;
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.performSearch();
        }, this.debounceMs);
    }

    /**
     * 键盘事件处理
     * @param {KeyboardEvent} e
     */
    onKeyDown(e) {
        // IME 组合输入期间不劫持按键：方向键/回车属于输入法候选导航，
        // 劫持会导致中文选词与补全下拉互相打架（keyCode 229 兼容 Safari：
        // 组合起始 keydown 的 isComposing 尚为 false）
        if (e.isComposing || e.keyCode === 229) return;

        if (!this.isOpen) {
            // 下拉列表未打开时，按 ESC 不做处理
            return;
        }

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                this.moveActive(1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                this.moveActive(-1);
                break;
            case 'Enter':
                e.preventDefault();
                if (this.activeIndex >= 0 && this.activeIndex < this.filtered.length) {
                    this.insertItem(this.filtered[this.activeIndex]);
                }
                break;
            case 'Escape':
                e.preventDefault();
                this.close();
                break;
            case 'Tab':
                // Tab 键如果当前有高亮项则插入，否则关闭
                if (this.activeIndex >= 0 && this.activeIndex < this.filtered.length) {
                    e.preventDefault();
                    this.insertItem(this.filtered[this.activeIndex]);
                } else {
                    this.close();
                }
                break;
        }
    }

    /**
     * 输入框失焦处理
     */
    onBlur() {
        // 延迟关闭，给点击下拉列表留出时间
        setTimeout(() => this.close(), 150);
    }

    /**
     * 下拉列表点击事件
     * @param {MouseEvent} e
     */
    onListClick(e) {
        const item = e.target.closest('.prompt-autocomplete-item');
        if (!item) return;

        const index = parseInt(item.dataset.index, 10);
        if (index >= 0 && index < this.filtered.length) {
            this.insertItem(this.filtered[index]);
        }
    }

    /**
     * 执行搜索并显示结果
     */
    performSearch() {
        const text = this.input.value;
        const cursorPos = this.input.selectionStart || 0;

        // 找到光标所在位置的中文词组
        const queryInfo = this.extractQuery(text, cursorPos);
        if (!queryInfo || !queryInfo.query || queryInfo.query.length === 0) {
            this.close();
            return;
        }

        const query = queryInfo.query.toLowerCase();
        this.lastQueryStart = queryInfo.start;
        this.lastQueryEnd = queryInfo.end;

        // 词典状态：加载中/失败给出提示，就绪后正常搜索
        if (PromptDictStore.status === 'loading') {
            this.renderLoading();
            return;
        }
        if (PromptDictStore.status === 'error') {
            this.renderError();
            return;
        }

        // 搜索匹配（共享索引，结果按四级优先排序）
        const results = PromptDictStore.search(query);
        this.filtered = results.slice(0, this.maxResults);
        this.activeIndex = this.filtered.length > 0 ? 0 : -1;

        if (this.filtered.length === 0) {
            this.renderEmpty();
        } else {
            this.renderList();
        }
    }

    /**
     * 从输入文本中提取光标处需要补全的中文查询词
     * @param {string} text - 输入框完整文本
     * @param {number} cursorPos - 光标位置
     * @returns {Object|null} 包含 query、start、end 的对象
     */
    extractQuery(text, cursorPos) {
        // 定义查询词边界分隔符，同时支持中英文常用标点符号和空白字符。
        // 这样用户在输入 "1个女孩，" 后，"，" 会被识别为分隔符，后续中文仍可正常触发补全。
        const separators = new Set([
            ',', '，',             // 中英文逗号
            '.', '。',             // 中英文句号
            ':', '：',             // 中英文冒号
            ';', '；',             // 中英文分号
            '!', '！',             // 中英文感叹号
            '?', '？',             // 中英文问号
            '\n', '\r', '\t', ' '  // 换行、回车、制表符、普通空格
        ]);

        const isSeparator = (char) => separators.has(char);

        // 找到光标前最近的一个分隔符位置
        let start = cursorPos;
        while (start > 0) {
            const char = text[start - 1];
            if (isSeparator(char)) {
                break;
            }
            start--;
        }

        // 找到光标后最近的一个分隔符位置
        let end = cursorPos;
        while (end < text.length) {
            const char = text[end];
            if (isSeparator(char)) {
                break;
            }
            end++;
        }

        // 提取并清理查询词
        const query = text.substring(start, end).trim();
        if (!query) return null;

        return { query, start, end };
    }

    /**
     * 高亮项移动
     * @param {number} delta - 移动方向，1 为向下，-1 为向上
     */
    moveActive(delta) {
        if (this.filtered.length === 0) return;

        this.activeIndex += delta;
        if (this.activeIndex < 0) {
            this.activeIndex = this.filtered.length - 1;
        } else if (this.activeIndex >= this.filtered.length) {
            this.activeIndex = 0;
        }

        this.renderList();
        this.scrollActiveIntoView();
    }

    /**
     * 将选中的提示词插入到输入框
     * @param {Object} item - 词典项 { cn, en }
     */
    insertItem(item) {
        const text = this.input.value;
        const before = text.substring(0, this.lastQueryStart);
        const after = text.substring(this.lastQueryEnd);

        // 在英文后追加逗号和空格，方便继续输入
        const insertText = item.en + ', ';

        this.input.value = before + insertText + after;

        // 将光标放到插入文本之后
        const newCursorPos = this.lastQueryStart + insertText.length;
        this.input.setSelectionRange(newCursorPos, newCursorPos);

        // 触发 input 事件，让外部组件同步
        this.input.dispatchEvent(new Event('input', { bubbles: true }));

        this.input.focus();
        this.close();
    }

    /**
     * 渲染下拉列表
     */
    renderList() {
        this.listEl.innerHTML = '';

        for (let i = 0; i < this.filtered.length; i++) {
            const item = this.filtered[i];
            const el = document.createElement('div');
            el.className = 'prompt-autocomplete-item';
            if (i === this.activeIndex) {
                el.classList.add('active');
            }
            el.dataset.index = i;

            const cnSpan = document.createElement('span');
            cnSpan.className = 'prompt-autocomplete-cn';
            cnSpan.textContent = item.cn;

            const enSpan = document.createElement('span');
            enSpan.className = 'prompt-autocomplete-en';
            enSpan.textContent = item.en;

            el.appendChild(cnSpan);
            el.appendChild(enSpan);
            this.listEl.appendChild(el);
        }

        this.listEl.style.display = 'block';
        this.isOpen = true;
        this.updatePosition();
    }

    /**
     * 渲染空结果提示
     */
    renderEmpty() {
        this.listEl.innerHTML = '<div class="prompt-autocomplete-empty">无匹配结果</div>';
        this.listEl.style.display = 'block';
        this.isOpen = true;
        this.updatePosition();
    }

    /**
     * 渲染加载中提示
     */
    renderLoading() {
        this.listEl.innerHTML = '<div class="prompt-autocomplete-loading">正在加载提示词词典...</div>';
        this.listEl.style.display = 'block';
        this.isOpen = true;
        this.updatePosition();
    }

    /**
     * 渲染词典加载失败提示
     */
    renderError() {
        this.listEl.innerHTML = '<div class="prompt-autocomplete-empty">词典加载失败，请刷新页面重试</div>';
        this.listEl.style.display = 'block';
        this.isOpen = true;
        this.updatePosition();
    }

    /**
     * 关闭下拉列表
     */
    close() {
        this.listEl.style.display = 'none';
        this.listEl.innerHTML = '';
        this.isOpen = false;
        this.activeIndex = -1;
        this.filtered = [];
    }

    /**
     * 更新下拉列表位置：锚定在当前补全词起点（光标所在行），IDE 式就近弹出。
     * 下方空间不足时翻转到词起点上方；宽度按视口与屏幕右缘空间钳制。
     * 屏幕坐标由 _measureCaretRect 给出（已含画布 transform 缩放与滚动补偿）。
     */
    updatePosition() {
        if (!this.isOpen) return;

        const caret = this._measureCaretRect(
            Number.isInteger(this.lastQueryStart) && this.lastQueryStart >= 0
                ? this.lastQueryStart
                : (this.input.selectionStart || 0));

        const margin = 8;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        // 宽度：目标上限 420px；词起点离屏幕右缘太窄时压缩到可用空间，
        // 保底 200px（与 CSS min-width 一致），必要时左移保持完整可见
        let width = Math.min(420, vw - margin * 2);
        width = Math.max(200, Math.min(width, vw - caret.left - margin));
        let left = caret.left - 2;
        if (left + width > vw - margin) {
            left = vw - margin - width;
        }
        left = Math.max(margin, left);

        // 垂直：默认词起点行下方 4px。下方空间不足时先压低下拉高度
        // 贴着光标显示（能露出约 4 行候选就不上翻），只有连这点空间
        // 都没有且上方足够时才整体翻转到词起点上方
        this.listEl.style.maxHeight = '';
        let listH = this.listEl.offsetHeight;
        let top = caret.bottom + 4;
        const spaceBelow = vh - margin - top;
        const minBelow = 120;   // 下方至少露出的高度（约 4 行候选）
        const canFlip = caret.top - listH - 4 > margin;
        if (spaceBelow < Math.min(listH, minBelow) && canFlip) {
            top = caret.top - listH - 4;
        } else if (spaceBelow < listH) {
            this.listEl.style.maxHeight = `${Math.floor(spaceBelow)}px`;
            listH = this.listEl.offsetHeight;
        }
        top = Math.max(margin, Math.min(top, Math.max(margin, vh - listH - margin)));

        this.listEl.style.top = `${top}px`;
        this.listEl.style.left = `${left}px`;
        this.listEl.style.width = `${width}px`;
    }

    /**
     * 光标移动跟随（document selectionchange，仅下拉打开且宿主聚焦时）：
     * 光标移出当前查询词范围 → 按新位置重新提取查询词（可能关闭或换词）；
     * 词内移动 → 仅跟随重定位
     */
    onSelectionChange() {
        if (!this.isOpen || document.activeElement !== this.input) return;
        const pos = this.input.selectionStart ?? 0;
        if (pos < this.lastQueryStart || pos > this.lastQueryEnd) {
            this.performSearch();
        } else {
            this.updatePosition();
        }
    }

    /**
     * 测量 textarea 内 anchor 字符位置的屏幕矩形（该字符所在行的行盒）。
     * 镜像测量法：在 textarea 的 offsetParent 内放一个同宽、同排版、
     * 不可见的测量 div——与 textarea 同处一个 CSS transform 上下文，
     * Range 返回的坐标即屏幕坐标（画布节点 --ns 缩放自动包含，无需
     * 手动换算）；文本截到 anchor 后放零宽标记 span，量其矩形，再
     * 按"屏幕尺寸/布局尺寸"缩放比补偿 textarea 自身滚动量。
     * @param {number} anchor - 锚定字符位置（补全词起点）
     * @returns {{left: number, top: number, right: number, bottom: number}}
     */
    _measureCaretRect(anchor) {
        const ta = this.input;
        const parent = ta.offsetParent || document.body;
        let m = this._measurer;
        if (!m || m.parentNode !== parent) {
            if (m) m.remove();
            m = document.createElement('div');
            m.className = 'prompt-autocomplete-measurer';
            parent.appendChild(m);
            this._measurer = m;
        }

        // 排版样式逐项复制 computed style（不手抄数值，宿主样式一变
        // 测量自动跟上）。宽度 = clientWidth + 边框：clientWidth 含内边距、
        // 不含边框与滚动条，border-box 加回边框后内容宽与输入框一致；
        // textarea 出现纵向滚动条时 clientWidth 已自动变小，换行点一致。
        // 边框保留宽度但设为透明，保证内容盒位置逐像素对齐。
        const cs = getComputedStyle(ta);
        const s = m.style;
        const borderLR = (parseFloat(cs.borderLeftWidth) || 0) +
                         (parseFloat(cs.borderRightWidth) || 0);
        s.position = 'absolute';
        s.left = `${ta.offsetLeft}px`;
        s.top = `${ta.offsetTop}px`;
        s.width = `${ta.clientWidth + borderLR}px`;
        s.height = 'auto';
        s.boxSizing = 'border-box';
        s.padding = cs.padding;
        s.borderWidth = cs.borderWidth;
        s.borderStyle = 'solid';
        s.borderColor = 'transparent';
        s.fontFamily = cs.fontFamily;
        s.fontSize = cs.fontSize;
        s.fontWeight = cs.fontWeight;
        s.fontStyle = cs.fontStyle;
        s.letterSpacing = cs.letterSpacing;
        s.wordSpacing = cs.wordSpacing;
        s.lineHeight = cs.lineHeight;
        s.textAlign = cs.textAlign;
        s.textIndent = cs.textIndent;
        s.tabSize = cs.tabSize;
        s.direction = cs.direction;
        s.whiteSpace = 'pre-wrap';
        s.overflowWrap = cs.overflowWrap;
        s.wordBreak = cs.wordBreak;
        s.visibility = 'hidden';
        s.pointerEvents = 'none';
        s.zIndex = '-1';

        const span = document.createElement('span');
        span.textContent = '\u200b';   // 零宽字符：空标记也有合法的行内盒
        m.replaceChildren(document.createTextNode(ta.value.slice(0, anchor)), span);

        // 滚动补偿：测量 div 是"未滚动"的全量排版，textarea 显示内容已
        // 按 scrollTop/scrollLeft 平移；缩放比 = 屏幕宽 / 布局宽
        //（未 transform 的元素恒为 1）
        const taRect = ta.getBoundingClientRect();
        const scale = ta.offsetWidth > 0 ? taRect.width / ta.offsetWidth : 1;
        const range = document.createRange();
        range.selectNodeContents(span);
        const r = range.getBoundingClientRect();
        return {
            left: r.left - ta.scrollLeft * scale,
            top: r.top - ta.scrollTop * scale,
            right: r.right - ta.scrollLeft * scale,
            bottom: r.bottom - ta.scrollTop * scale
        };
    }

    /**
     * 将当前高亮项滚动到可视区域
     */
    scrollActiveIntoView() {
        const activeEl = this.listEl.querySelector('.prompt-autocomplete-item.active');
        if (!activeEl) return;

        activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}
