/**
 * ==========================================================================
 * RecipeGallery —— 提示词管理器「在线画廊」视图（ADR 090）
 * ==========================================================================
 * 作用：在提示词收藏弹窗内提供 Civitai / Danbooru 两源图片的只读浏览——
 *       瀑布流、SFW 三档筛选、排序、源内搜索、详情浮层、无限滚动。
 *       图片全部经后端 /api/gallery/image 代理（内存 LRU，不落盘），
 *       前端零本地存储——「只是浏览，不保存」。
 *
 * 宿主契约：RecipeManager 持有实例，负责：
 *   - new RecipeGallery({ host }) 并把 .root 插进 .recipe-cards-area；
 *   - 视图状态机（gallery-mode 类切换 + show/hide + 下拉菜单重建）；
 *   - Esc 逐层退出链里最优先调 isDetailOpen()/closeDetail()。
 *
 * 数据口径：卡片模型由后端适配器归一化（utils/gallery/*）——
 *   { id, source, thumb, full, prompt, negativePrompt, tags[], model,
 *     baseModel, loras[], sampler/steps/cfgScale/seed/size, link, ... }
 *   字段缺失一律空串/空数组，详情面板按空值隐藏对应行。
 *
 * 分页：civitai=cursor 令牌 / danbooru=页码自增，由 nextToken 是否为空
 *   统一判定"还有下一页"（danbooru 有更多时后端给 nextToken='1'）。
 * ==========================================================================
 */

/** 分级档位按钮集：按源差异化（用户拍板 Danbooru 用站方原生四档+全部，
 *  Civitai 保持官网 SFW/Soft/R18 三档观感）。default=开窗默认档：
 *  civitai 默认 R18（对齐站内 Images 板块登录账号的全量观感——SFW+最新
 *  组合的全龄池子极小，实测 50 条里 39 条同版本，是「同质化」根因）；
 *  danbooru 默认全部（用户拍板）。 */
const GALLERY_PILL_SETS = {
    civitai: {
        default: 'r18',
        items: [
            { v: 'sfw', label: 'SFW' },
            { v: 'soft', label: 'Soft' },
            { v: 'r18', label: 'R18' }
        ]
    },
    danbooru: {
        default: 'all',
        items: [
            { v: 'all', label: '全部' },
            { v: 'g', label: '全龄' },
            { v: 's', label: '敏感' },
            { v: 'q', label: '擦边' },
            { v: 'e', label: '露骨' }
        ]
    }
};

class RecipeGallery {

    constructor({ host }) {
        this.host = host;                 // RecipeManager 实例（取 dialog 等）
        this._source = null;              // 'civitai' | 'danbooru'（null=未激活）
        this._items = [];
        this._nextToken = null;           // civitai=cursor 串；danbooru='1' 哨兵
        this._page = 1;                   // danbooru 页码
        this._loading = false;
        this._abort = null;               // 在途列表请求中止器
        this._detailAbort = null;         // 详情大图载入计时（防串图）
        this._q = { civitai: '', danbooru: '' };   // 源内搜索词（会话内记忆）
        this._debounceTimer = null;
        this._io = null;                  // 无限滚动观察器
        this._buildDom();
    }

    // ==================== DOM 装配 ====================

    /** 建视图骨架（constructor 调一次；root 由宿主插进 .recipe-cards-area） */
    _buildDom() {
        const root = document.createElement('div');
        root.className = 'gallery-view';
        root.hidden = true;
        root.innerHTML = `
            <div class="gallery-filterbar" role="toolbar" aria-label="画廊筛选">
                <div class="gallery-filter-row">
                    <div class="gallery-pill-group" role="group" aria-label="内容分级"></div>
                    <span class="gallery-filter-spacer"></span>
                </div>
                <!-- 时间范围行（对齐 Civitai Images 板块筛选样式，用户拍板；
                     仅 civitai 源显示——Danbooru 的日期过滤要吃 tag 配额） -->
                <div class="gallery-filter-row" id="galleryPeriodRow">
                    <span class="gallery-section-label">时间范围</span>
                    <div class="gallery-pill-group gallery-period-group" role="group" aria-label="时间范围"></div>
                </div>
                <!-- 模型行（基模下拉，清单由后端 /civitai/basemodels 归纳）：
                     仅 civitai 源显示 -->
                <div class="gallery-filter-row" id="galleryModelRow">
                    <span class="gallery-section-label">模型</span>
                    <button class="gallery-model-btn" type="button" aria-label="基模筛选"></button>
                </div>
            </div>
            <div class="gallery-warnings" hidden></div>
            <div class="gallery-grid" aria-label="画廊图片列表"></div>
            <div class="gallery-empty" hidden><p>没有匹配的图片</p></div>
            <div class="gallery-error" hidden>
                <p class="gallery-error-text"></p>
                <button class="gallery-retry-btn" type="button">↻ 重试</button>
            </div>
            <div class="gallery-sentinel" aria-hidden="true"></div>
        `;
        this.root = root;
        this.gridEl = root.querySelector('.gallery-grid');
        this.emptyEl = root.querySelector('.gallery-empty');
        this.errorEl = root.querySelector('.gallery-error');
        this.errorTextEl = root.querySelector('.gallery-error-text');
        this.warningsEl = root.querySelector('.gallery-warnings');

        // 分级档位按钮集按源动态渲染（_syncFilterBar），点击走事件委托——
        // 换源重建按钮不用重挂监听
        this.pillGroup = root.querySelector('.gallery-pill-group');
        this.pillGroup.addEventListener('click', (event) => {
            const pill = event.target.closest('.gallery-pill');
            if (pill) this._setFilter('nsfw', pill.dataset.nsfw);
        });
        this.periodRow = root.querySelector('#galleryPeriodRow');
        this.periodGroup = root.querySelector('.gallery-period-group');
        this.periodGroup.addEventListener('click', (event) => {
            const pill = event.target.closest('.gallery-pill');
            if (pill) this._setFilter('period', pill.dataset.period);
        });
        // 基模下拉（清单懒加载；触发器文案显示当前选中基模名）
        this.modelRow = root.querySelector('#galleryModelRow');
        this.modelDropdown = new LumenDropdown(root.querySelector('.gallery-model-btn'), {
            onChange: (v) => this._setFilter('basemodels', v)
        });
        this._basemodelList = null;
        this._basemodelLoading = false;
        // 卡片元数据探测（用户拍板 2026-11-19：civitai「复制词」默认置灰，
        // 探测命中提示词才解锁）——卡片渲染后后台并发探测 /meta（服务端
        // 30min 缓存去重），探完即时更新按钮状态。
        // _itemMeta: id → meta对象 | null(确认无) | undefined(探测中)
        this._itemMeta = new Map();
        this._probeQueue = [];
        this._probeActive = 0;

        // 源内搜索已收敛到宿主工具行的大搜索框（视图感知转发 setSearch，
        // 2026-11-19 拍板合并去重）；本组件只保留 _q 按源记忆与防抖逻辑

        root.querySelector('.gallery-retry-btn').addEventListener('click', () => this._load(true));

        // 无限滚动：哨兵进入可视区（滚动容器=宿主 .recipe-cards-area）即补页
        this._io = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) this._loadMore();
        }, { root: this._cardsArea(), rootMargin: '600px 0px' });
        this._io.observe(root.querySelector('.gallery-sentinel'));

        // 卡片点击（事件委托）：卡内按钮（落画布/下载/复制词）优先分发，
        // 其余区域打开详情浮层
        this.gridEl.addEventListener('click', (event) => {
            const actBtn = event.target.closest('.gallery-card-btn');
            if (actBtn) {
                const card = actBtn.closest('.gallery-card');
                const item = card && this._items.find((it) => it.id === card.dataset.id);
                if (!item) return;
                event.stopPropagation();
                const act = actBtn.dataset.act;
                if (act === 'drop') this._dropToCanvas(actBtn, item);
                else if (act === 'download') this._downloadImage(actBtn, item);
                else if (act === 'copy') this._copyCardPrompt(actBtn, item);
                return;
            }
            const card = event.target.closest('.gallery-card');
            if (!card) return;
            const item = this._items.find((it) => it.id === card.dataset.id);
            if (item) this.openDetail(item);
        });
    }

    /** 滚动容器（.recipe-cards-area）：瀑布流撑满宿主卡片区 */
    _cardsArea() {
        return this.host.dialog.querySelector('.recipe-cards-area');
    }

    // ==================== 筛选状态 ====================

    /** 时间范围五档（仅 civitai 源显示；对齐站内 Images 板块筛选） */
    static get PERIOD_SETS() {
        return [
            { v: 'day', label: '今天' },
            { v: 'week', label: '本周' },
            { v: 'month', label: '本月' },
            { v: 'year', label: '今年' },
            { v: 'all', label: '全部时间' }
        ];
    }

    /** 当前源的筛选值（localStorage 分源记忆；档位合法性按源校验，
     *  旧档残留值/换源残留自动回落首档） */
    _filter(key) {
        const v = localStorage.getItem(`lumen.gallery.${this._source}.${key}`);
        if (key === 'nsfw') {
            const set = GALLERY_PILL_SETS[this._source];
            return set && set.items.some((p) => p.v === v) ? v : (set ? set.default : '');
        }
        if (key === 'period') {
            const set = RecipeGallery.PERIOD_SETS;
            return set.some((p) => p.v === v) ? v : 'month';
        }
        if (key === 'basemodels') {
            return typeof v === 'string' ? v : '';   // 自由值：清单外的旧残留无妨
        }
        if (key === 'sort') {
            // 缺省「最热」：站内 Images 板块的默认口径（实测作者
            // 多样性最好）；曾默认「最新」但 SFW 池子小易被单模型霸屏。
            // 统计窗口不写进标签——由时间范围行独立管辖
            return ['hot', 'new'].includes(v) ? v : 'hot';
        }
        return v || '';
    }

    /** 写筛选值并重载首屏 */
    _setFilter(key, value) {
        if (!this._source) return;
        localStorage.setItem(`lumen.gallery.${this._source}.${key}`, value);
        this._syncFilterBar();
        this._load(true);
    }

    /** 排序变化（宿主「筛选」下拉在画廊态的回调；分源记忆 + 重载首屏） */
    setSort(value) {
        this._setFilter('sort', value);
    }

    /** 把记忆态刷进筛选条（档位按钮集按源重建/时间范围行/排序勾选/搜索词） */
    _syncFilterBar() {
        const nsfw = this._filter('nsfw');
        this.pillGroup.innerHTML = ((GALLERY_PILL_SETS[this._source] || {}).items || []).map((p) =>
            `<button class="gallery-pill${p.v === nsfw ? ' is-active' : ''}" data-nsfw="${p.v}" type="button">${p.label}</button>`
        ).join('');
        // 时间范围行：仅 civitai 源显示（Danbooru 日期过滤吃 tag 配额，不提供）
        const isCivitai = this._source === 'civitai';
        this.periodRow.hidden = !isCivitai;
        if (isCivitai) {
            const period = this._filter('period');
            this.periodGroup.innerHTML = RecipeGallery.PERIOD_SETS.map((p) =>
                `<button class="gallery-pill${p.v === period ? ' is-active' : ''}" data-period="${p.v}" type="button">${p.label}</button>`
            ).join('');
        }
        // 排序控件已收敛到宿主工具行的「筛选」下拉（视图感知，见
        // RecipeManager._showGallery/_showCollection——本组件不再自带）
        this.modelRow.hidden = !isCivitai;
        if (isCivitai) {
            const bm = this._filter('basemodels');
            const opts = [{ value: '', label: '全部基模' }]
                .concat((this._basemodelList || []).map((n) => ({ value: n, label: n })));
            this.modelDropdown.setOptions(opts, bm);
            this.modelDropdown.setLabel(bm || '全部基模');
        }
    }

    /** 源内搜索词转发入口（宿主大搜索框在画廊态调用）：
     *  默认防抖 500ms 生效（danbooru 每请求吃匿名配额，防抖必要）；
     *  immediate=true 跳过防抖立即加载（回车）。词按源记忆（_q） */
    setSearch(value, { immediate = false } = {}) {
        if (!this._source) return;
        const v = String(value || '').trim();
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        if (!immediate) {
            // 锁定发起时的源：防抖窗内切源则丢弃，防旧源词打到新源
            const source = this._source;
            this._debounceTimer = setTimeout(() => {
                if (this._source !== source) return;
                this.setSearch(v, { immediate: true });
            }, 500);
            return;
        }
        if (this._q[this._source] === v) return;
        this._q[this._source] = v;
        this._load(true);
    }

    // ==================== 生命周期 ====================

    /** 宿主切进画廊：激活某源，重置状态并拉首屏 */
    show(source) {
        if (this._source && this._source !== source) this.hide();
        this._source = source;
        this._syncFilterBar();
        this.root.hidden = false;
        // hide() 里观察器已断开，每次激活重挂（重复 observe 幂等）
        this._io.observe(this.root.querySelector('.gallery-sentinel'));
        this._load(true);
        if (source === 'civitai') this._ensureBasemodels();
    }

    /** 基模清单懒加载（后端 6h 缓存；失败静默——下拉退化为只有全部基模） */
    async _ensureBasemodels() {
        if (this._basemodelList || this._basemodelLoading) {
            if (this._basemodelList && this._source === 'civitai') this._syncFilterBar();
            return;
        }
        this._basemodelLoading = true;
        try {
            const resp = await fetch('/api/gallery/civitai/basemodels');
            const data = await resp.json();
            if (Array.isArray(data.basemodels) && data.basemodels.length) {
                this._basemodelList = data.basemodels;
            }
        } catch { /* 清单失败静默 */ }
        this._basemodelLoading = false;
        if (this._source === 'civitai') this._syncFilterBar();
    }

    /** 宿主切回收藏：停掉在途请求、收详情、隐藏视图（保留筛选记忆） */
    hide() {
        if (this._abort) { this._abort.abort(); this._abort = null; }
        this.closeDetail();
        this._source = null;
        this._nextToken = null;
        this._loading = false;
        if (this._io) this._io.disconnect();
        this.root.hidden = true;
    }

    _loadMore() {
        if (this._source && this._nextToken && !this._loading && !this.root.hidden) {
            this._load(false);
        }
    }

    // ==================== 数据装载 ====================

    /** 拉一页：reset=true 首屏/换筛选，false 补页。AbortController 防串页 */
    async _load(reset) {
        if (!this._source || this._loading) return;
        if (!reset && !this._nextToken) return;
        this._loading = true;
        if (this._abort) this._abort.abort();
        const ctrl = new AbortController();
        this._abort = ctrl;
        if (reset) {
            this.errorEl.hidden = true;
            this.gridEl.classList.toggle('is-loading', true);
        }

        const params = new URLSearchParams();
        params.set('nsfw', this._filter('nsfw'));
        params.set('sort', this._filter('sort'));
        params.set('limit', '48');
        const q = this._q[this._source];
        if (q) params.set('q', q);
        if (this._source === 'civitai') {
            // 词非空 = Images 搜索（模型匹配聚合，支持中文，2026-11-19 拍板）；
            // 空词 = 默认列表。搜索词变化恒走 reset，游标天然不串模式
            if (q) params.set('mode', 'search');
            params.set('period', this._filter('period'));
            const bm = this._filter('basemodels');
            if (bm) params.set('basemodels', bm);
            if (!reset && this._nextToken) params.set('cursor', this._nextToken);
        } else {
            if (reset) this._page = 1;
            else this._page += 1;
            params.set('page', String(this._page));
        }

        try {
            const resp = await fetch(`/api/gallery/${this._source}/list?${params.toString()}`,
                { signal: ctrl.signal });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
            if (reset) this._items = [];
            this._items.push(...(data.items || []));
            this._nextToken = data.nextToken || null;
            this._renderWarnings(data.warnings || []);
            this._renderGrid(reset);
            this._renderState();
        } catch (err) {
            if (ctrl.signal.aborted) return;   // 换筛选/切源打断：静默
            this.errorTextEl.textContent = '画廊拉取失败：' + (err.message || '网络错误');
            this.errorEl.hidden = false;
            if (reset) this.gridEl.innerHTML = '';
        } finally {
            this._loading = false;
            this._abort = null;
            this.gridEl.classList.remove('is-loading');
        }
    }

    /** 瀑布流重绘（reset=true 全量替换；false 追加新页） */
    _renderGrid(reset) {
        if (reset) this.gridEl.innerHTML = '';
        const frag = document.createDocumentFragment();
        const start = reset ? 0 : this.gridEl.querySelectorAll('.gallery-card').length;
        const newItems = [];
        for (let i = start; i < this._items.length; i++) {
            const item = this._items[i];
            if (this.gridEl.querySelector(`.gallery-card[data-id="${item.id}"]`)) continue;
            frag.appendChild(this._buildCard(item));
            newItems.push(item);
        }
        this.gridEl.appendChild(frag);
        if (newItems.length) this._queueMetaProbe(newItems);
    }

    /** 画廊卡片（用户拍板：参考图样式——图 + 模型/画师|尺寸信息行 +
     *  落画布/下载/复制词三按钮，两源通用） */
    _buildCard(item) {
        const card = document.createElement('figure');
        card.className = 'gallery-card';
        card.dataset.id = item.id;
        const img = document.createElement('img');
        img.className = 'gallery-card-img';
        img.loading = 'lazy';
        img.src = `/api/gallery/image?u=${encodeURIComponent(item.thumb || item.full)}`;
        img.alt = '';
        card.appendChild(img);
        // 信息行：civitai=底模、danbooru=画师；右侧尺寸
        const modelName = item.source === 'civitai'
            ? (item.baseModel || item.model || '')
            : (item.artist || this._ratingLabel(item) || '');
        const size = item.size || (item.width && item.height ? `${item.width}×${item.height}` : '');
        const metaRow = document.createElement('div');
        metaRow.className = 'gallery-card-meta';
        metaRow.innerHTML = `
            <span class="gallery-card-model">${this._escapeHtml(modelName) || '—'}</span>
            <span class="gallery-card-size">${this._escapeHtml(size) || '—'}</span>`;
        card.appendChild(metaRow);
        // 三按钮行
        const btnRow = document.createElement('div');
        btnRow.className = 'gallery-card-btns';
        btnRow.innerHTML = `
            <button class="gallery-card-btn" data-act="drop" type="button">落画布</button>
            <button class="gallery-card-btn" data-act="download" type="button">下载</button>
            <button class="gallery-card-btn" data-act="copy" type="button">复制词</button>`;
        card.appendChild(btnRow);
        // 复制词可用性（用户拍板 2026-11-19：civitai 默认置灰，探测命中
        // 提示词才解锁——_updateCardCopyState；探测已知的翻页回看直接还原）
        const known = this._itemMeta.get(item.id);
        const copyBtn = btnRow.querySelector('[data-act="copy"]');
        if (item.source === 'civitai') {
            copyBtn.disabled = !(item.prompt || (known && known.prompt));
        } else if (known !== undefined) {
            copyBtn.disabled = !(known && known.prompt);
        }
        return card;
    }

    /** 空态/哨兵连带状态 */
    _renderState() {
        this.emptyEl.hidden = !(this._items.length === 0 && !this._loading);
    }

    _renderWarnings(list) {
        if (!list.length) { this.warningsEl.hidden = true; return; }
        this.warningsEl.textContent = list.join('；');
        this.warningsEl.hidden = false;
    }

    _escapeHtml(s) {
        return String(s || '').replace(/[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // ==================== 详情浮层 ====================

    /** 卡片点击 → 详情浮层（大图 + 提示词/参数 + 复制 + 原站链接） */
    openDetail(item) {
        this._detailItem = item;
        if (!this._detailEl) this._buildDetailDom();
        const d = this._detailEl;
        d.querySelector('.gallery-detail-badge').textContent =
            item.source === 'civitai' ? 'Civitai' : 'Danbooru';

        // 大图：经同一代理端点（内存缓存不落盘）；换图先清 src 防旧图闪现
        const img = d.querySelector('.gallery-detail-img');
        img.removeAttribute('src');
        img.alt = '';
        const wrap = d.querySelector('.gallery-detail-imgwrap');
        wrap.classList.add('is-loading');
        img.onload = () => wrap.classList.remove('is-loading');
        img.onerror = () => { wrap.classList.remove('is-loading'); img.alt = '大图加载失败'; };
        this._detailAbort = item.id;
        img.src = `/api/gallery/image?u=${encodeURIComponent(item.full || item.thumb)}`;

        // 信息区：按空值隐藏行（区块标题先复位——上次富化可能改过文案）
        d.querySelector('.gallery-sec-prompt .gallery-sec-head span').textContent = '提示词';
        d.querySelector('.gallery-sec-negative .gallery-sec-head span').textContent = '负面提示词';
        this._fillSection('.gallery-sec-prompt', item.prompt, true);
        this._fillSection('.gallery-sec-negative', item.negativePrompt, true);

        // 列表条目 meta 被站方剥除（2026-11 起）：三级富化链——图片内嵌
        // 元数据 → 版本示例图匹配 → 触发词兜底
        if (item.source === 'civitai' && !item.prompt) {
            this._enrichPrompt(item);
        }
        const params = [
            ['模型', item.model], ['底模', item.baseModel],
            ['LoRA', item.loras && item.loras.length ? item.loras.join('、') : ''],
            ['采样器', item.sampler], ['步数', item.steps], ['CFG', item.cfgScale],
            ['种子', item.seed], ['尺寸', item.size],
            ['作者', item.username],
            ['评分', item.source === 'danbooru' && item.score ? `★ ${item.score}` : ''],
            ['分级', this._ratingLabel(item)]
        ].filter(([, v]) => v);
        const paramsEl = d.querySelector('.gallery-detail-params');
        paramsEl.innerHTML = params.map(([k, v]) =>
            `<div class="gallery-param"><span class="gallery-param-k">${k}</span><span class="gallery-param-v">${this._escapeHtml(v)}</span></div>`
        ).join('');
        paramsEl.hidden = params.length === 0;

        // Danbooru tag 芯片：点击复制该 tag
        const tagsEl = d.querySelector('.gallery-detail-tags');
        const tags = item.tags || [];
        tagsEl.hidden = !tags.length;
        tagsEl.innerHTML = tags.map((t) =>
            `<button class="gallery-tag-chip" type="button">${this._escapeHtml(t)}</button>`
        ).join('');

        const linkEl = d.querySelector('.gallery-detail-link');
        if (item.link) {
            linkEl.hidden = false;
            linkEl.href = item.link;
        } else {
            linkEl.hidden = true;
        }

        // 操作区（两源通用）：信息行（civitai=底模、danbooru=画师）+ 尺寸；
        // 复制词初始可用性跟随当前提示词（富化链命中后会解锁）
        const actions = d.querySelector('.gallery-detail-actions');
        const model = item.source === 'civitai'
            ? (item.baseModel || item.model || '')
            : (item.artist || this._ratingLabel(item) || '');
        const size = item.size || (item.width && item.height ? `${item.width}×${item.height}` : '');
        actions.hidden = false;
        actions.querySelector('.gallery-meta-model').textContent = model || '—';
        actions.querySelector('.gallery-meta-size').textContent = size || '—';
        this._detailPromptText = item.prompt || '';
        actions.querySelector('[data-act="copy"]').disabled = !this._detailPromptText;

        d.hidden = false;
    }

    /** 列表条目提示词富化三级链（ADR 090）：① 图片内嵌 PNG 元数据
     *  （真实提示词，25% 左右命中率）→ ② 版本示例图元数据（imageId
     *  精确匹配）→ ③ trainedWords 触发词兜底；详情已切图则丢弃 */
    async _enrichPrompt(item) {
        const sec = this._detailEl.querySelector('.gallery-sec-prompt');
        // ① 图片内嵌元数据（PNG 文本块，A1111/ComfyUI）
        try {
            const r1 = await fetch(`/api/gallery/meta?u=${encodeURIComponent(item.full || item.thumb)}`);
            const d1 = await r1.json().catch(() => ({}));
            if (!this._detailItem || this._detailItem.id !== item.id) return;   // 已切图
            if (r1.ok && d1.meta && d1.meta.prompt) {
                this._applyDetailMeta(item, d1.meta, '提示词（图片内嵌元数据）');
                return;
            }
        } catch { /* 下一步 */ }
        // ②③ 版本示例图元数据 → 触发词兜底
        try {
            const resp = await fetch(`/api/gallery/civitai/version?id=${encodeURIComponent(item.modelVersionId)}&imageId=${encodeURIComponent(item.id)}`);
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
            if (!this._detailItem || this._detailItem.id !== item.id) return;   // 已切图
            const meta = data.meta;
            if (meta && meta.prompt) {
                this._applyDetailMeta(item, meta, '提示词');
                return;
            }
            if (data.trainedWords && data.trainedWords.length) {
                const words = data.trainedWords.join(', ');
                sec.hidden = false;
                sec.querySelector('.gallery-sec-head span').textContent = '提示词（版本触发词兜底）';
                sec.querySelector('.gallery-sec-text').textContent = words;
                const copyBtn = sec.querySelector('.gallery-sec-copy');
                copyBtn.hidden = false;
                copyBtn.onclick = () => this._copyText(words, copyBtn);
                this._detailPromptText = words;
                this._detailEl.querySelector('.gallery-detail-actions [data-act="copy"]').disabled = false;
            }
        } catch { /* 富化失败静默：详情仍有底模/热度/原站链接 */ }
    }

    /** 富化命中后的统一落面板：提示词/负面/参数网格 + 各区块复制钮 */
    _applyDetailMeta(item, meta, title) {
        const sec = this._detailEl.querySelector('.gallery-sec-prompt');
        sec.querySelector('.gallery-sec-head span').textContent = title;
        sec.querySelector('.gallery-sec-text').textContent = meta.prompt;
        sec.hidden = false;
        const copyBtn = sec.querySelector('.gallery-sec-copy');
        copyBtn.hidden = false;
        copyBtn.onclick = () => this._copyText(meta.prompt, copyBtn);
        const negSec = this._detailEl.querySelector('.gallery-sec-negative');
        if (meta.negativePrompt) {
            negSec.querySelector('.gallery-sec-text').textContent = meta.negativePrompt;
            negSec.hidden = false;
            const nb = negSec.querySelector('.gallery-sec-copy');
            nb.hidden = false;
            nb.onclick = () => this._copyText(meta.negativePrompt, nb);
        } else {
            negSec.hidden = true;
        }
        this._renderDetailParams(item, meta);
        this._detailPromptText = meta.prompt;
        this._detailEl.querySelector('.gallery-detail-actions [data-act="copy"]').disabled = false;
    }

    // ==================== 三动作（落画布/下载/复制词）——卡片与详情复用 ====================

    /** 落画布：复用 pi 落图同管线（_bridgeDropImage：代理取字节→dataUrl→
     *  addImage 落视口中心），存档持久化行为与现有落图完全一致 */
    async _dropToCanvas(btn, item) {
        item = item || this._detailItem;
        if (!item) return;
        btn.disabled = true;
        try {
            const result = await window.socket._bridgeDropImage({
                url: item.full || item.thumb,
                name: `${item.source}_${item.id}.${this._extOf(item)}`
            });
            console.log('[gallery] 已落画布:', result.id, result.name);
            this._flashBtn(btn, true);
        } catch (err) {
            console.error('[gallery] 落画布失败:', err.message);
            this._flashBtn(btn, false);
        } finally {
            btn.disabled = false;
        }
    }

    /** 下载：同源代理 URL + download 属性（字节已在服务端 LRU 缓存） */
    _downloadImage(btn, item) {
        item = item || this._detailItem;
        if (!item) return;
        const a = document.createElement('a');
        a.href = `/api/gallery/image?u=${encodeURIComponent(item.full || item.thumb)}`;
        a.download = `${item.source}_${item.id}.${this._extOf(item)}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        this._flashBtn(btn, true);
    }

    // ==================== 卡片元数据探测（复制词置灰依据，用户拍板） ====================

    /** 新卡片入探测队列（civitai 专属；并发 3，服务端 30min 缓存去重） */
    _queueMetaProbe(items) {
        for (const item of items) {
            if (item.source !== 'civitai' || this._itemMeta.has(item.id)) continue;
            this._itemMeta.set(item.id, undefined);   // undefined=探测中
            this._probeQueue.push(item);
        }
        this._drainProbeQueue();
    }

    _drainProbeQueue() {
        while (this._probeActive < 3 && this._probeQueue.length) {
            const item = this._probeQueue.shift();
            this._probeActive++;
            fetch(`/api/gallery/meta?u=${encodeURIComponent(item.full || item.thumb)}`)
                .then((r) => r.json())
                .then((d) => {
                    this._itemMeta.set(item.id, d.meta || null);
                    this._updateCardCopyState(item);
                })
                .catch(() => {
                    this._itemMeta.set(item.id, null);   // 探测失败按无词处理（可重进详情再试）
                    this._updateCardCopyState(item);
                })
                .finally(() => {
                    this._probeActive--;
                    this._drainProbeQueue();
                });
        }
    }

    /** 探测结果落到卡片：命中提示词才解锁「复制词」（默认置灰） */
    _updateCardCopyState(item) {
        const card = this.gridEl.querySelector(`.gallery-card[data-id="${item.id}"]`);
        if (!card) return;
        const meta = this._itemMeta.get(item.id);
        const btn = card.querySelector('.gallery-card-btns [data-act="copy"]');
        if (btn) btn.disabled = !(item.prompt || (meta && meta.prompt));
    }

    /** 卡片上的复制词：探测结果优先，未探测/无果时懒取（详情已缓存则秒出） */
    async _copyCardPrompt(btn, item) {
        if (item.prompt) return this._copyText(item.prompt, btn);
        const known = this._itemMeta.get(item.id);
        if (known && known.prompt) return this._copyText(known.prompt, btn);
        if (item.source !== 'civitai') return this._copyText('', btn);
        try {
            const resp = await fetch(`/api/gallery/meta?u=${encodeURIComponent(item.full || item.thumb)}`);
            const data = await resp.json();
            const prompt = data.meta && data.meta.prompt;
            if (prompt) {
                this._itemMeta.set(item.id, data.meta);
                this._updateCardCopyState(item);
                return this._copyText(prompt, btn);
            }
        } catch { /* 提取失败：失败反馈 */ }
        this._flashBtn(btn, false);
    }

    _extOf(item) {
        const m = /\.(jpe?g|png|webp|gif)(?:\?|#|$)/i.exec(item.full || item.thumb || '');
        return m ? (m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()) : 'png';
    }

    /** 按钮结果反馈：成功绿 / 失败红，1.2s 后还原 */
    _flashBtn(btn, ok) {
        btn.classList.add(ok ? 'is-done' : 'is-fail');
        setTimeout(() => btn.classList.remove(ok ? 'is-done' : 'is-fail'), 1200);
    }

    /** 用版本元数据刷新详情参数网格（列表条目这些字段已被站方剥空） */
    _renderDetailParams(item, meta) {
        const params = [
            ['模型', meta.model], ['底模', meta.baseModel || item.baseModel],
            ['LoRA', meta.loras && meta.loras.length ? meta.loras.join('、') : ''],
            ['采样器', meta.sampler], ['步数', meta.steps], ['CFG', meta.cfgScale],
            ['种子', meta.seed], ['尺寸', meta.size],
            ['作者', item.username],
            ['分级', this._ratingLabel(item)]
        ].filter(([, v]) => v);
        const paramsEl = this._detailEl.querySelector('.gallery-detail-params');
        paramsEl.innerHTML = params.map(([k, v]) =>
            `<div class="gallery-param"><span class="gallery-param-k">${k}</span><span class="gallery-param-v">${this._escapeHtml(v)}</span></div>`
        ).join('');
        paramsEl.hidden = params.length === 0;
    }

    _ratingLabel(item) {
        if (item.source !== 'danbooru' || !item.rating) return '';
        return { g: 'General（全龄）', s: 'Sensitive（敏感）', q: 'Questionable（擦边）', e: 'Explicit（露骨）' }[item.rating] || item.rating;
    }

    /** 填充一个「标题+文本+复制钮」区块；内容为空时整块隐藏。
     *  提示词区块同步维护「复制词」按钮的可用性与追踪文本 */
    _fillSection(sel, text, withCopy) {
        const sec = this._detailEl.querySelector(sel);
        if (!text) {
            sec.hidden = true;
            if (sel === '.gallery-sec-prompt') {
                this._detailPromptText = '';
                this._detailEl.querySelector('.gallery-detail-actions [data-act="copy"]').disabled = true;
            }
            return;
        }
        sec.hidden = false;
        sec.querySelector('.gallery-sec-text').textContent = text;
        const copyBtn = sec.querySelector('.gallery-sec-copy');
        copyBtn.hidden = !withCopy;
        copyBtn.onclick = () => this._copyText(text, copyBtn);
        if (sel === '.gallery-sec-prompt') {
            this._detailPromptText = text;
            this._detailEl.querySelector('.gallery-detail-actions [data-act="copy"]').disabled = false;
        }
    }

    _buildDetailDom() {
        const d = document.createElement('div');
        d.className = 'gallery-detail';
        d.hidden = true;
        d.innerHTML = `
            <div class="gallery-detail-backdrop"></div>
            <div class="gallery-detail-body" role="dialog" aria-label="画廊图片详情">
                <div class="gallery-detail-imgwrap"><img class="gallery-detail-img" alt=""></div>
                <aside class="gallery-detail-info">
                    <header class="gallery-detail-head">
                        <span class="gallery-detail-badge"></span>
                        <a class="gallery-detail-link" href="#" target="_blank" rel="noopener noreferrer" title="在原站打开">原站 ↗</a>
                        <button class="gallery-detail-close" type="button" title="关闭（Esc）" aria-label="关闭详情">✕</button>
                    </header>
                    <div class="gallery-detail-scroll">
                        <section class="gallery-sec gallery-sec-prompt" hidden>
                            <header class="gallery-sec-head"><span>提示词</span><button class="gallery-sec-copy" type="button" title="复制">⧉</button></header>
                            <div class="gallery-sec-text"></div>
                        </section>
                        <section class="gallery-sec gallery-sec-negative" hidden>
                            <header class="gallery-sec-head"><span>负面提示词</span><button class="gallery-sec-copy" type="button" title="复制">⧉</button></header>
                            <div class="gallery-sec-text"></div>
                        </section>
                        <div class="gallery-detail-params" hidden></div>
                        <div class="gallery-detail-tags" hidden></div>
                    </div>
                    <!-- 操作区（参考图样式，两源通用）——
                         信息行（底模或画师/尺寸）+ 三按钮（落画布/下载/复制词） -->
                    <div class="gallery-detail-actions" hidden>
                        <div class="gallery-meta-row">
                            <span class="gallery-meta-model"></span>
                            <span class="gallery-meta-size"></span>
                        </div>
                        <div class="gallery-btn-row">
                            <button class="gallery-act-btn" data-act="drop" type="button">落画布</button>
                            <button class="gallery-act-btn" data-act="download" type="button">下载</button>
                            <button class="gallery-act-btn" data-act="copy" type="button">复制词</button>
                        </div>
                    </div>
                </aside>
            </div>
        `;
        d.querySelector('.gallery-detail-close').addEventListener('click', () => this.closeDetail());
        d.querySelector('.gallery-detail-backdrop').addEventListener('click', () => this.closeDetail());
        d.querySelector('.gallery-detail-tags').addEventListener('click', (event) => {
            const chip = event.target.closest('.gallery-tag-chip');
            if (chip) this._copyText(chip.textContent, chip);
        });
        // 操作区三按钮（落画布/下载/复制词）——事件委托统一分发
        d.querySelector('.gallery-detail-actions .gallery-btn-row').addEventListener('click', (event) => {
            const btn = event.target.closest('.gallery-act-btn');
            if (!btn || !this._detailItem) return;
            const act = btn.dataset.act;
            if (act === 'drop') this._dropToCanvas(btn, this._detailItem);
            else if (act === 'download') this._downloadImage(btn, this._detailItem);
            else if (act === 'copy') this._copyText(this._detailPromptText || '', btn);
        });
        this.host.dialog.appendChild(d);
        this._detailEl = d;
    }

    isDetailOpen() {
        return !!(this._detailEl && !this._detailEl.hidden);
    }

    closeDetail() {
        if (this._detailEl) this._detailEl.hidden = true;
        this._detailItem = null;
    }

    // ==================== 复制（clip 面板同款兜底） ====================

    async _copyText(text, btn) {
        let ok = false;
        try {
            await navigator.clipboard.writeText(text);
            ok = true;
        } catch {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                ok = document.execCommand('copy');
                ta.remove();
            } catch { ok = false; }
        }
        if (btn) {
            btn.classList.add('is-done');
            setTimeout(() => btn.classList.remove('is-done'), 900);
        }
        return ok;
    }
}

window.RecipeGallery = RecipeGallery;
