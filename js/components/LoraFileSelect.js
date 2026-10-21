/**
 * ==========================================================================
 * LoraFileSelect — LoRA 文件封面选择器（模拟原生 select 的替换组件）
 * ==========================================================================
 * 宿主（ComfyParamRows 叠加区 / 画布 LoraNode / Comfy 生图节点内嵌 LoRA 行）
 * 的既有代码全是「事件委托 + class 匹配 + 读 e.target.value」——本组件的
 * 兼容策略是让挂载元素本身冒充 select：
 *   - 挂载 div 保留宿主要认的全部 class 与 data-*（comfy-lorastack-file /
 *     lora-file-select / comfy-model-select[data-node-id]）
 *   - 组件维护 el.value（expando 属性），宿主 e.target.value 照常可读
 *   - 选择后 el.dispatchEvent(change, bubbles) —— 宿主的委托监听与
 *     直接绑定监听都照常命中，宿主逻辑零改动
 *   - _fillModelSelect 等灌选项代码经 el._lfs.setFiles(...) 喂清单
 *
 * 交互形态：触发器（当前封面小图 + 友好名）→ 菜单挂 body（搜索框 +
 * 封面网格）。封面走 /api/lora/preview?path=（key 与 Comfy lora_name 同源，
 * 1 天浏览器缓存）；置顶/友好名/触发词来自 /api/lora/pins（lora-meta.json，
 * 进程内共享缓存一次）。
 * ==========================================================================
 */

/** 当前打开的菜单实例（模块级单例：新开前先关旧，防孤儿菜单） */
let _openInstance = null;

class LoraFileSelect {

    // ===== 元数据共享缓存（pinned / civitai / triggers），进程一份 =====
    static _metaPromise = null;
    static _meta = { pinned: [], civitai: {}, triggers: {} };

    static loadMeta(force = false) {
        if (!force && LoraFileSelect._metaPromise) return LoraFileSelect._metaPromise;
        LoraFileSelect._metaPromise = fetch('/api/lora/pins')
            .then((r) => r.json())
            .then((j) => {
                if (j && j.status === 'ok') {
                    LoraFileSelect._meta = {
                        pinned: Array.isArray(j.pinned) ? j.pinned : [],
                        civitai: j.civitai || {},
                        triggers: j.triggers || {}
                    };
                }
            })
            .catch(() => { /* 元数据拿不到：降级为纯文件名显示，不阻塞功能 */ });
        return LoraFileSelect._metaPromise;
    }

    /**
     * @param {HTMLElement} host - 挂载元素（div，需预先带好宿主要认的 class）
     * @param {Object} [options]
     * @param {string[]} [options.files] - LoRA 文件相对路径清单（Comfy 同源）
     * @param {string} [options.value] - 当前选中值
     * @param {boolean} [options.allowEmpty=true] - 是否提供「不使用」空选项
     * @param {string} [options.emptyLabel='-- 选择 LoRA 文件 --']
     */
    constructor(host, options = {}) {
        this.host = host;
        host._lfs = this;
        this.files = Array.isArray(options.files) ? options.files.slice() : [];
        this.value = options.value || '';
        this.allowEmpty = options.allowEmpty !== false;
        this.emptyLabel = options.emptyLabel || '-- 选择 LoRA 文件 --';
        this.hint = '';                 // 清单不可用时的灰字提示
        this.menu = null;               // 打开中的菜单元素（挂 body）

        host.value = this.value;        // 宿主 e.target.value 兼容
        this._renderTrigger();
        // 挂载点点击 → 开菜单（元素随 innerHTML 重建一起销毁，监听不必解绑）
        host.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.menu) { this._closeMenu(); return; }   // 再点触发器 = 关闭
            if (this.files.length === 0 && !this.value) return;   // 清单不可用不开
            this._openMenu();
        });
        // 元数据（友好名/置顶）就绪后刷新触发器显示
        LoraFileSelect.loadMeta().then(() => { if (this.host) this._renderTrigger(); });
    }

    // ==================== 对外接口（宿主侧） ====================

    /**
     * 灌清单（_fillModelSelect 的兼容入口；也用于清单异步就绪后更新）
     * @param {string[]} files
     * @param {string} [selected] - 选中值（不传保持当前值）
     * @param {string} [hint] - 清单不可用提示（'ComfyUI 未连接' 等；空=正常）
     */
    setFiles(files, selected, hint = '') {
        this.files = Array.isArray(files) ? files.slice() : [];
        this.hint = hint || '';
        if (selected !== undefined) this.value = selected || '';
        this.host.value = this.value;
        this._renderTrigger();
    }

    /**
     * 程序化改值（不派发 change，与用户选择区分）
     * @param {string} v
     */
    setValue(v) {
        this.value = v || '';
        this.host.value = this.value;
        this._renderTrigger();
    }

    destroy() {
        this._closeMenu();
        if (this.host && this.host._lfs === this) this.host._lfs = null;
        this.host = null;
    }

    // ==================== 显示 ====================

    /** 友好名：Civitai 模型名 > 文件名去扩展名 */
    _displayName(rel) {
        const civ = LoraFileSelect._meta.civitai[rel];
        if (civ && civ.modelName) return civ.modelName;
        const base = rel.split('/').pop();
        return base.replace(/\.[^.]+$/, '');
    }

    _dirOf(rel) {
        const i = rel.lastIndexOf('/');
        return i === -1 ? '' : rel.slice(0, i + 1);
    }

    /** 触发器：小封面 + 名字 + ▾（外观沿用 llm-model-select 皮肤基调） */
    _renderTrigger() {
        if (!this.host) return;
        const esc = (s) => LumenLight.escapeHtml(s);
        const caret = '<span class="lfs-caret">▾</span>';
        if (!this.value && this.allowEmpty) {
            this.host.innerHTML =
                `<span class="lfs-trigger is-empty">${esc(this.emptyLabel)}</span>${caret}`;
            return;
        }
        if (!this.value || (this.hint && this.files.length === 0)) {
            this.host.innerHTML =
                `<span class="lfs-trigger is-empty">${esc(this.hint || '未选择')}</span>${caret}`;
            return;
        }
        const stale = this.files.length > 0 && !this.files.includes(this.value);
        const name = this._displayName(this.value) + (stale ? '（不在清单）' : '');
        const pinned = LoraFileSelect._meta.pinned.includes(this.value);
        this.host.innerHTML =
            `<img class="lfs-trigger-cover" alt="" src="/api/lora/preview?path=${encodeURIComponent(this.value)}">` +
            `<span class="lfs-trigger-name"${pinned ? ' data-pinned="1"' : ''} title="${esc(this.value)}">${esc(name)}</span>${caret}`;
        const img = this.host.querySelector('.lfs-trigger-cover');
        img.onerror = () => { img.style.display = 'none'; };
    }

    // ==================== 菜单（挂 body 的封面网格） ====================

    _openMenu() {
        if (_openInstance && _openInstance !== this) _openInstance._closeMenu();
        const esc = (s) => LumenLight.escapeHtml(s);
        const meta = LoraFileSelect._meta;
        // 排序：置顶在前，其余保持清单原序（与 Comfy 清单一致，便于对照）
        const pinnedSet = new Set(meta.pinned);
        const ordered = [
            ...this.files.filter((f) => pinnedSet.has(f)),
            ...this.files.filter((f) => !pinnedSet.has(f))
        ];
        // 当前值不在清单（存档残留）：前置保留，行为与原生时代一致
        if (this.value && !this.files.includes(this.value)) ordered.unshift(this.value);

        const menu = document.createElement('div');
        menu.className = 'lfs-menu';
        menu.innerHTML =
            `<input class="lfs-search" type="text" placeholder="过滤：文件名 / Civitai 名 / 触发词…" autocomplete="off">` +
            `<div class="lfs-grid"></div>`;
        const grid = menu.querySelector('.lfs-grid');
        const search = menu.querySelector('.lfs-search');
        document.body.appendChild(menu);
        this.menu = menu;
        _openInstance = this;

        // 网格项构建（一次性建全部；封面 img lazy 按需加载）
        const buildCells = (list) => {
            const frag = document.createDocumentFragment();
            if (this.allowEmpty) {
                const cell = document.createElement('button');
                cell.type = 'button';
                cell.className = 'lfs-cell is-empty' + (this.value ? '' : ' is-active');
                cell.dataset.rel = '';
                cell.title = this.emptyLabel;
                cell.innerHTML =
                    `<span class="lfs-cover-fallback lfs-cover-fallback-empty">∅</span>` +
                    `<span class="lfs-cell-name">${esc(this.emptyLabel)}</span>`;
                frag.appendChild(cell);
            }
            for (const rel of list) {
                const civ = meta.civitai[rel];
                const dir = this._dirOf(rel);
                const cell = document.createElement('button');
                cell.type = 'button';
                cell.className = 'lfs-cell' + (rel === this.value ? ' is-active' : '') +
                    (pinnedSet.has(rel) ? ' is-pinned' : '');
                cell.dataset.rel = rel;
                cell.title = rel + (civ && civ.modelName ? `\n${civ.modelName}` : '');
                cell.innerHTML =
                    `<img class="lfs-cell-cover" loading="lazy" alt="" src="/api/lora/preview?path=${encodeURIComponent(rel)}">` +
                    `<span class="lfs-cell-name">${esc(this._displayName(rel))}</span>` +
                    (dir ? `<span class="lfs-cell-dir">${esc(dir)}</span>` : '');
                const img = cell.querySelector('.lfs-cell-cover');
                img.onerror = () => {
                    // 无封面：渐变占位块（与 LoRA 管理器同款视觉），格不破
                    img.replaceWith(Object.assign(document.createElement('span'),
                        { className: 'lfs-cover-fallback' }));
                };
                frag.appendChild(cell);
            }
            grid.innerHTML = '';
            grid.appendChild(frag);
        };
        buildCells(ordered);

        // 过滤：文件名 / Civitai 名 / 触发词（全部小写子串）
        const filterOf = (rel) => {
            const civ = meta.civitai[rel];
            return (rel + ' ' + (civ ? civ.modelName || '' : '') + ' ' +
                (meta.triggers[rel] || '')).toLowerCase();
        };
        search.addEventListener('input', () => {
            const q = search.value.trim().toLowerCase();
            buildCells(q ? ordered.filter((rel) => filterOf(rel).includes(q)) : ordered);
        });

        // 选择
        grid.addEventListener('click', (e) => {
            const cell = e.target.closest('.lfs-cell');
            if (cell) this._pick(cell.dataset.rel);
        });

        // 键盘：↑↓ 循环移动活跃格、Enter 选中、Esc 关闭
        menu.addEventListener('keydown', (e) => {
            const cells = [...grid.querySelectorAll('.lfs-cell')];
            if (e.key === 'Escape') { this._closeMenu(); return; }
            if (!cells.length) return;
            const cur = grid.querySelector('.lfs-cell.is-hover') ||
                grid.querySelector('.lfs-cell.is-active');
            let i = cur ? cells.indexOf(cur) : -1;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                i = e.key === 'ArrowDown' ? (i + 1) % cells.length
                    : (i - 1 + cells.length) % cells.length;
                cells.forEach((c) => c.classList.remove('is-hover'));
                cells[i].classList.add('is-hover');
                cells[i].scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'Enter' && i >= 0) {
                e.preventDefault();
                this._pick(cells[i].dataset.rel);
            }
        });

        // 定位：下方优先，视口放不下翻上方；宽度/左侧钳制在视口内。
        // 同步量尺寸（读 offsetHeight 会强制布局，无需等 rAF——
        // rAF 在页面不可见时冻结，菜单会停在 hidden）
        const rect = this.host.getBoundingClientRect();
        menu.style.visibility = 'hidden';
        const mh = menu.offsetHeight, mw = menu.offsetWidth;
        const vw = window.innerWidth, vh = window.innerHeight;
        let top = rect.bottom + 6;
        if (top + mh > vh - 8) top = Math.max(8, rect.top - mh - 6);
        const left = Math.max(8, Math.min(rect.left, vw - mw - 8));
        menu.style.top = `${top}px`;
        menu.style.left = `${left}px`;
        menu.style.visibility = '';
        search.focus();

        // 关闭时机：点击菜单外部 / 窗口尺寸变化 / 菜单外任何滚动（画布
        // 平移、面板滚动会让锚点漂移，跟随成本高，直接关闭最稳；菜单
        // 网格自身的滚动不算——contains 判掉，否则一滚就关）
        this._outside = (e) => {
            if (!menu.contains(e.target) && !this.host.contains(e.target)) this._closeMenu();
        };
        this._resize = () => this._closeMenu();
        this._scroll = (e) => {
            if (this.menu && this.menu.contains(e.target)) return;
            this._closeMenu();
        };
        document.addEventListener('mousedown', this._outside, true);
        window.addEventListener('resize', this._resize);
        window.addEventListener('scroll', this._scroll, true);
    }

    _closeMenu() {
        if (this.menu) { this.menu.remove(); this.menu = null; }
        if (_openInstance === this) _openInstance = null;
        if (this._outside) {
            document.removeEventListener('mousedown', this._outside, true);
            window.removeEventListener('resize', this._resize);
            window.removeEventListener('scroll', this._scroll, true);
            this._outside = this._resize = this._scroll = null;
        }
    }

    /** 用户选中一个值：写 value + 冒泡 change（宿主委托/直绑监听都命中） */
    _pick(rel) {
        this.value = rel || '';
        this.host.value = this.value;
        this._closeMenu();
        this._renderTrigger();
        this.host.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

// 暴露到全局（与项目其他组件同款约定）
window.LoraFileSelect = LoraFileSelect;
