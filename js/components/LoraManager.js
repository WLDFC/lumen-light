/**
 * ==========================================================================
 * LumenLight LoRA 管理窗口（LoraManager）
 * ==========================================================================
 * 作用：顶栏「LoRA」按钮打开的全屏管理窗口（骨架复用提示词收藏页
 * RecipeManager 的弹窗样式类：recipe-dialog 全屏遮罩 + 面板 + 头部 +
 * 左右分栏 + 左侧栏条目），管理用户 ComfyUI 的 LoRA 文件：
 *   - 左栏：loras 目录下的文件夹清单（全部/根目录/子目录），点击筛选；
 *   - 右区：当前文件夹大标题 + 筛选排序下拉 + 搜索框 + LoRA 封面网格
 *     （3:4 比例、一行 5 个），封面读 sidecar 预览图（<同名>.preview.png/.jpg
 *     等，无图显示名称首字占位块）；筛选排序下拉为 LumenDropdown 图标
 *     按钮模式（置顶优先/添加时间 新→旧/旧→新/仅看置顶，选择存
 *     localStorage，时间口径用 /list 返回的 mtime 近似）；
 *   - 封面右上角星星：点击置顶/取消置顶，置顶项排最前且星星变金色；
 *     状态持久化在后端 data/lora-meta.json（按 lora 相对路径记）。
 *
 * 定位是「全局台账」：只读 Comfy 目录，不做重命名/删除（工作流 JSON 里
 * 路径写死，改名会静默断链）。数据源 /api/lora（routes/lora.js）。
 * 后续规划：触发词备注、可选生图入口（本版未含）。
 * ==========================================================================
 */

class LoraManager {
    constructor() {
        // 顶栏按钮：注入中段工具区 #topToolbarCenter 的第一个位置——
        // 即「提示词」（RecipeManager）与「Comfy」（WorkflowEditor）按钮的左边，
        // 样式与它们同款（top-toolbar-btn：图标 + 文字）
        this.btn = null;
        const center = document.getElementById('topToolbarCenter');
        if (center) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'top-toolbar-btn';
            b.title = 'LoRA 管理';
            b.setAttribute('aria-haspopup', 'dialog');
            b.setAttribute('aria-expanded', 'false');
            b.innerHTML = `
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>
                <span>LoRA</span>
            `;
            b.addEventListener('click', () => this.toggle());
            center.insertBefore(b, center.firstChild);   // 恒插最左（提示词左边）
            this.btn = b;
        }

        this.dialog = null;        // 弹窗 DOM（懒建）
        this.visible = false;
        this.data = null;          // { lorasDir, folders, loras }
        this.pinned = new Set();   // 置顶路径集合
        this.activeFolder = null;  // null = 全部；'' = 根目录
        this.searchText = '';      // 名称过滤
        // 排序/筛选策略（工具行漏斗下拉，localStorage 记忆上次选择）：
        // default=置顶优先·按名称 / time-desc=添加时间 新→旧 /
        // time-asc=添加时间 旧→新 / pinned-only=仅看置顶（筛选）。
        // 时间口径用后端 /list 返回的 mtime（文件修改时间）作近似添加时间
        this.sortMode = localStorage.getItem('lumen.loraSortMode') || 'default';

        // ESC 关闭（确认框 > 信息窗 > 投递弹窗 > 管理器窗口）
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (this._confirmOverlay) {
                this._confirmOverlay.remove();
                this._confirmOverlay = null;
                return;
            }
            if (this._infoOverlay) { this._closeInfoModal(); return; }
            if (this._sendPopup) { this._closeSendPopup(); return; }
            if (this.visible) this.hide();
        });

        // 本地封面选择的隐藏 file input（复用，value 置空支持重复选同一文件）
        this._fileInput = document.createElement('input');
        this._fileInput.type = 'file';
        this._fileInput.accept = 'image/png,image/jpeg,image/webp';
        this._fileInput.style.display = 'none';
        this._fileInput.addEventListener('change', () => {
            const file = this._fileInput.files && this._fileInput.files[0];
            this._fileInput.value = '';
            if (file && this._infoLora) this._readLocalCover(file);
        });
        document.body.appendChild(this._fileInput);
    }

    // ==================== 开合 ====================

    toggle() { this.visible ? this.hide() : this.show(); }

    async show() {
        if (!this.dialog) this._buildDom();
        this.dialog.classList.add('is-open');      // 复用 recipe-dialog 显隐
        this.visible = true;
        if (this.btn) this.btn.setAttribute('aria-expanded', 'true');
        // 首开或未加载过：拉清单与置顶状态
        if (!this.data) await this.refresh();
        if (!this._pinsLoaded) await this.loadPins();
    }

    hide() {
        if (!this.dialog) return;
        this._confirmOverlay?.remove();
        this._confirmOverlay = null;
        this._closeInfoModal();
        this._closeSendPopup();
        this.dialog.classList.remove('is-open');
        this.visible = false;
        if (this.btn) this.btn.setAttribute('aria-expanded', 'false');
    }

    // ==================== DOM 构建 ====================

    _buildDom() {
        // 骨架复用提示词收藏页样式类：recipe-dialog 全屏遮罩 + 面板 + 头部 +
        // 内容分栏 + recipe-models-sidebar 左侧栏，保证尺寸观感完全一致；
        // 仅网格（lora-grid）与星星是 LoRA 特有结构
        const el = document.createElement('div');
        el.className = 'recipe-dialog lora-dialog';
        el.innerHTML = `
            <div class="recipe-dialog-panel">
                <header class="recipe-dialog-header">
                    <div class="recipe-dialog-title-group">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>
                        <h2>LoRA 管理</h2>
                        <span class="lora-count"></span>
                        <span class="lora-detect-note"></span>
                    </div>
                    <button class="recipe-dialog-close" type="button" title="关闭 LoRA 管理" aria-label="关闭 LoRA 管理窗口"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                </header>
                <div class="recipe-dialog-content">
                    <aside class="recipe-models-sidebar">
                        <div class="recipe-models-header">
                            <span class="recipe-models-title">文件夹</span>
                        </div>
                        <div class="recipe-models-list lora-folder-list"></div>
                    </aside>
                    <div class="recipe-cards-area">
                        <div class="recipe-toolbar">
                            <h2 class="recipe-current-model lora-current-folder">全部</h2>
                            <div class="lora-toolbar-right">
                                <button class="lora-sort-btn" type="button" aria-label="排序与筛选"></button>
                                <div class="recipe-search-box">
                                    <svg class="recipe-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                                    <input type="text" class="recipe-search-input lora-search-input" placeholder="搜索 LoRA 名称..." aria-label="搜索 LoRA 名称">
                                </div>
                            </div>
                        </div>
                        <div class="lora-grid"></div>
                        <div class="lora-empty hidden"></div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(el);
        this.dialog = el;
        this.folderList = el.querySelector('.lora-folder-list');
        this.grid = el.querySelector('.lora-grid');
        this.emptyEl = el.querySelector('.lora-empty');
        this.countEl = el.querySelector('.lora-count');
        this.detectNote = el.querySelector('.lora-detect-note');
        this.currentEl = el.querySelector('.lora-current-folder');
        this.searchInput = el.querySelector('.lora-search-input');
        el.querySelector('.recipe-dialog-close').addEventListener('click', () => this.hide());
        this.searchInput.addEventListener('input', () => {
            this.searchText = this.searchInput.value.trim().toLowerCase();
            this._renderGrid();
        });

        // 筛选排序下拉（LumenDropdown 图标按钮模式——提示词节点技能栏同款
        // 预制件：触发器只显示静态漏斗图标，当前策略在菜单里打对勾，
        // 悬停触发器可见当前策略全文）
        this.sortDropdown = new LumenDropdown(el.querySelector('.lora-sort-btn'), {
            iconButton: true,
            triggerIcon: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
            onChange: (v) => {
                this.sortMode = v;
                localStorage.setItem('lumen.loraSortMode', v);
                this._renderGrid();
            }
        });
        this.sortDropdown.setOptions([
            { value: 'default', label: '置顶优先（默认）' },
            { value: 'time-desc', label: '添加时间 新→旧' },
            { value: 'time-asc', label: '添加时间 旧→新' },
            { value: 'pinned-only', label: '仅看置顶' }
        ], this.sortMode);
        // localStorage 里存了已废弃的值时归位到第一项（与下拉显示一致）
        this.sortMode = this.sortDropdown.value;
    }

    // ==================== 数据加载 ====================

    async refresh() {
        this.grid.innerHTML = '<div class="lora-loading">加载中…</div>';
        this.folderList.innerHTML = '';
        let listRes = await fetch('/api/lora/list').then((r) => r.json()).catch(() => null);

        // 未配置或配置失效：尝试自动检测（后端查运行中的 ComfyUI 进程反推
        // 根目录，命中会写回配置永久记住），成功则重拉一次清单
        if (!listRes || listRes.status !== 'ok') {
            let detect = null;
            try {
                detect = await fetch('/api/lora/detect').then((r) => r.json());
            } catch { /* 检测接口异常按未检测到处理 */ }
            if (detect && detect.status === 'ok') {
                this.detectNote.textContent = '已自动检测到 ComfyUI 目录';
                listRes = await fetch('/api/lora/list').then((r) => r.json()).catch(() => null);
            } else {
                this.grid.innerHTML = '';
                this.folderList.innerHTML = '';
                this.countEl.textContent = '';
                this.emptyEl.textContent = (detect && detect.status === 'running-but-unknown')
                    ? '检测到 ComfyUI 正在运行，但无法定位安装目录；请到 设置 → 通用 手动指定根目录'
                    : '未检测到正在运行的 ComfyUI：启动 ComfyUI 后重新打开本窗口即可自动检测，或到 设置 → 通用 手动指定根目录';
                this.emptyEl.classList.remove('hidden');
                return;
            }
        }

        try {
            if (!listRes || listRes.status !== 'ok') throw new Error(listRes?.message || '加载失败');
            this.data = listRes;
            if (!this._pinsLoaded) await this.loadPins();
            this._renderFolders();
            this._renderGrid();
        } catch (err) {
            // 静默失败：不在界面铺错误详情（原始报错进控制台排查；
            // 常见原因是后端未重启导致 /api/lora 不存在、返回了 HTML 页）
            this.grid.innerHTML = '';
            this.emptyEl.textContent = '暂无 LoRA';
            this.emptyEl.classList.remove('hidden');
            console.warn('[lora] 清单加载失败:', err);
        }
    }

    async loadPins() {
        try {
            const r = await fetch('/api/lora/pins').then((r) => r.json());
            if (r.status === 'ok') {
                this.pinned = new Set(r.pinned);
                this.triggers = r.triggers || {};
                this.notes = r.notes || {};
            }
            this._pinsLoaded = true;
        } catch { /* 置顶/触发词状态加载失败不阻塞窗口 */ }
    }

    /** 保存文本元数据（kind: 'trigger'|'note'，空串即清除），同步本地缓存 */
    async _saveMetaText(kind, relPath, text) {
        const resp = await fetch(`/api/lora/${kind}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: relPath, text })
        });
        const r = await resp.json().catch(() => null);
        if (!resp.ok || !r || r.status !== 'ok') {
            throw new Error(r?.message || `保存失败（HTTP ${resp.status}）`);
        }
        const store = kind === 'trigger' ? 'triggers' : 'notes';
        if (text) this[store][relPath] = text;
        else delete this[store][relPath];
    }

    /**
     * 信息窗文本元数据块（触发词/备注共用）：查看态显示文本（空=斜体占位），
     * 铅笔进入就地编辑（Enter/失焦保存、Shift+Enter 换行、Esc 取消）
     * @param {HTMLElement} overlay - 信息窗根
     * @param {Object} lora - lora 数据
     * @param {Object} cfg - { textSel, editSel, kind, store, label, emptyText, placeholder }
     */
    _wireMetaTextBlock(overlay, lora, cfg) {
        const textEl = overlay.querySelector(cfg.textSel);
        const editBtn = overlay.querySelector(cfg.editSel);
        if (!textEl || !editBtn) return;
        const render = () => {
            const t = this[cfg.store][lora.path];
            textEl.textContent = t || cfg.emptyText;
            textEl.classList.toggle('empty', !t);
        };
        render();
        editBtn.addEventListener('click', () => {
            if (textEl.querySelector('textarea')) return;   // 已在编辑
            const cur = this[cfg.store][lora.path] || '';
            const ta = document.createElement('textarea');
            ta.className = 'lora-trigger-input';
            ta.value = cur;
            ta.placeholder = cfg.placeholder;
            textEl.textContent = '';
            textEl.classList.remove('empty');
            textEl.appendChild(ta);
            ta.focus();
            ta.setSelectionRange(cur.length, cur.length);
            let done = false;
            const commit = () => {
                if (done) return;
                done = true;
                const val = ta.value.trim();
                this._saveMetaText(cfg.kind, lora.path, val)
                    .catch((err) => this._infoStatus('❌ ' + cfg.label + (err.message || err), true));
                render();
            };
            ta.addEventListener('keydown', (e) => {
                e.stopPropagation();   // 阻止冒泡到全局 ESC/快捷键
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    commit();
                } else if (e.key === 'Escape') {
                    done = true;
                    render();
                }
            });
            ta.addEventListener('blur', commit);
        });
    }

    async togglePin(relPath, on) {
        // 乐观更新：先改界面再发请求，失败回滚
        if (on) this.pinned.add(relPath); else this.pinned.delete(relPath);
        this._renderGrid();
        try {
            const r = await fetch('/api/lora/pins', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: relPath, pinned: on })
            }).then((r) => r.json());
            if (r.status !== 'ok') throw new Error(r.message);
        } catch (err) {
            if (on) this.pinned.delete(relPath); else this.pinned.add(relPath);
            this._renderGrid();
            console.warn('[lora] 置顶保存失败:', err.message || err);
        }
    }

    // ==================== 纸飞机投递 ====================

    /**
     * 打开投递弹窗：列出画布上所有 LoRA 节点（标题带 #NNN 编号）与
     * 恒在的「右侧 Comfy 面板」，点击即把该 lora 追加进目标堆栈
     * @param {Object} lora - 封面对应的 lora 数据（path/name）
     * @param {HTMLElement} anchor - 触发按钮（弹窗定位参照）
     */
    _openSendPopup(lora, anchor) {
        this._closeSendPopup();
        const pop = document.createElement('div');
        pop.className = 'lora-send-popup';

        const head = document.createElement('div');
        head.className = 'lora-send-head';
        head.textContent = `发送「${lora.name}」到：`;
        pop.appendChild(head);

        let hasNode = false;
        const canvas = window.canvas;
        if (canvas) {
            for (const img of canvas.images.images) {
                if (img?.source !== NodeTypes.SOURCE.LORA_NODE) continue;
                if (typeof img.addLoraFile !== 'function') continue;
                hasNode = true;
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'lora-send-target';
                b.textContent = img.getTitle();   // 自含 #NNN 编号
                b.addEventListener('click', () => {
                    img.addLoraFile(lora.path);   // 追加到节点堆栈（不破坏已有）
                    this._closeSendPopup();
                });
                pop.appendChild(b);
            }
        }

        // Comfy 面板恒在（loraStack 堆栈跨工作流保留）
        const panelBtn = document.createElement('button');
        panelBtn.type = 'button';
        panelBtn.className = 'lora-send-target';
        panelBtn.textContent = '右侧 Comfy 面板';
        panelBtn.addEventListener('click', () => {
            const cp = window.promptPanel?.comfyParams;
            if (cp) {
                cp.loras.push({
                    id: LumenLight.generateId(),
                    file: lora.path,
                    strengthModel: 1,
                    strengthClip: 1
                });
                cp.render();
            }
            this._closeSendPopup();
        });
        pop.appendChild(panelBtn);

        if (!hasNode) {
            const hint = document.createElement('div');
            hint.className = 'lora-send-hint';
            hint.textContent = '画布上暂无 LoRA 节点（右键画布可新建）';
            pop.appendChild(hint);
        }

        document.body.appendChild(pop);
        // 定位：锚点按钮下方，防溢出视口
        const r = anchor.getBoundingClientRect();
        pop.style.visibility = 'hidden';
        pop.style.display = 'block';
        const top = Math.min(r.bottom + 4, window.innerHeight - pop.offsetHeight - 8);
        const left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8));
        pop.style.top = `${Math.max(8, top)}px`;
        pop.style.left = `${left}px`;
        pop.style.visibility = '';
        this._sendPopup = pop;

        // 点击外部关闭（捕获阶段，下一帧起生效避免本次点击立即触发）
        setTimeout(() => {
            this._sendPopupOutside = (e) => {
                if (!pop.contains(e.target)) this._closeSendPopup();
            };
            document.addEventListener('mousedown', this._sendPopupOutside, true);
        }, 0);
    }

    /** 关闭投递弹窗并清理外部点击监听 */
    _closeSendPopup() {
        this._sendPopup?.remove();
        this._sendPopup = null;
        if (this._sendPopupOutside) {
            document.removeEventListener('mousedown', this._sendPopupOutside, true);
            this._sendPopupOutside = null;
        }
    }

    // ==================== 信息窗与封面更换 ====================

    /**
     * 打开 LoRA 信息窗（居中弹窗）：名称/目录/大小/修改时间 + 封面预览，
     * 封面可从画布或本地图片更换（写成 sidecar 预览文件）
     * @param {Object} lora - lora 数据（path/name/folder/sizeBytes/mtime）
     */
    _openInfoModal(lora) {
        this._closeInfoModal();
        this._infoLora = lora;
        const overlay = document.createElement('div');
        overlay.className = 'lora-info-overlay';
        const bust = this._bustMap && this._bustMap[lora.path];
        overlay.innerHTML = `
            <div class="lora-info-panel">
                <header class="lora-info-header">
                    <span class="lora-info-title"></span>
                    <button type="button" class="lora-info-delete" title="删除此 LoRA（含源文件）">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                    </button>
                    <button type="button" class="lora-info-close" title="关闭" style="margin-left: auto;">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </header>
                <div class="lora-info-body">
                    <div class="lora-info-cover">
                        <img alt="封面">
                        <div class="lora-info-placeholder hidden"></div>
                    </div>
                    <div class="lora-info-meta">
                        <div class="lora-info-row"><span class="lora-info-key">名称</span><span class="lora-info-val lora-info-name"></span></div>
                        <div class="lora-info-row"><span class="lora-info-key">目录</span><span class="lora-info-val lora-info-folder"></span></div>
                        <div class="lora-info-row"><span class="lora-info-key">大小</span><span class="lora-info-val lora-info-size"></span></div>
                        <div class="lora-info-row"><span class="lora-info-key">修改时间</span><span class="lora-info-val lora-info-mtime"></span></div>
                    </div>
                </div>
                <div class="lora-trigger-block">
                    <div class="lora-trigger-head">
                        <span>触发词</span>
                        <button type="button" class="lora-trigger-edit" title="编辑触发词">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                        </button>
                    </div>
                    <div class="lora-trigger-text"></div>
                </div>
                <div class="lora-trigger-block">
                    <div class="lora-trigger-head">
                        <span>备注</span>
                        <button type="button" class="lora-note-edit" title="编辑备注">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                        </button>
                    </div>
                    <div class="lora-note-text"></div>
                </div>
                <div class="lora-info-status"></div>
                <div class="lora-info-actions">
                    <button type="button" class="lora-info-btn">从画布选择</button>
                    <button type="button" class="lora-info-btn">上传本地图片</button>
                    <button type="button" class="lora-info-btn lora-info-reveal">打开所在文件夹</button>
                </div>
            </div>
        `;
        overlay.querySelector('.lora-info-title').textContent = lora.name;
        overlay.querySelector('.lora-info-name').textContent = lora.name;
        overlay.querySelector('.lora-info-folder').textContent = lora.folder || '（根目录）';
        overlay.querySelector('.lora-info-size').textContent = (lora.sizeBytes / 1048576).toFixed(1) + ' MB';
        overlay.querySelector('.lora-info-mtime').textContent =
            lora.mtime ? new Date(lora.mtime).toLocaleString() : '—';

        // 封面预览（加载失败显示占位）
        const preview = overlay.querySelector('.lora-info-cover img');
        const ph = overlay.querySelector('.lora-info-placeholder');
        preview.addEventListener('error', () => {
            preview.classList.add('hidden');
            ph.classList.remove('hidden');
        });
        preview.src = `/api/lora/preview?path=${encodeURIComponent(lora.path)}${bust ? `&t=${bust}` : ''}`;

        const [btnCanvas, btnLocal, btnReveal] = overlay.querySelectorAll('.lora-info-btn');
        btnCanvas.addEventListener('click', () => this._openCanvasPicker(lora));
        btnLocal.addEventListener('click', () => this._fileInput.click());
        btnReveal.addEventListener('click', async () => {
            try {
                const resp = await fetch('/api/lora/reveal', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: lora.path })
                });
                const r = await resp.json().catch(() => null);
                if (!resp.ok || !r || r.status !== 'ok') {
                    throw new Error(r?.message || `打开失败（HTTP ${resp.status}；若刚更新过程序请重启后端）`);
                }
            } catch (err) {
                this._infoStatus('❌ ' + (err.message || err), true);
            }
        });

        overlay.querySelector('.lora-info-delete').addEventListener('click', () => this._confirmDelete(lora));

        // 触发词/备注两个文本块（结构样式同款，编辑逻辑共用）
        this.triggers = this.triggers || {};
        this.notes = this.notes || {};
        this._wireMetaTextBlock(overlay, lora, {
            textSel: '.lora-trigger-text', editSel: '.lora-trigger-edit',
            kind: 'trigger', store: 'triggers', label: '触发词',
            emptyText: '无需触发词', placeholder: '逗号分隔多个触发词，留空清除'
        });
        this._wireMetaTextBlock(overlay, lora, {
            textSel: '.lora-note-text', editSel: '.lora-note-edit',
            kind: 'note', store: 'notes', label: '备注',
            emptyText: '无备注', placeholder: '记录使用心得、来源、版本等，留空清除'
        });

        overlay.addEventListener('mousedown', (e) => {
            if (e.target === overlay) this._closeInfoModal();
        });
        overlay.querySelector('.lora-info-close').addEventListener('click', () => this._closeInfoModal());

        document.body.appendChild(overlay);
        this._infoOverlay = overlay;
    }

    /** 关闭信息窗（画布选图浮层一并关闭） */
    _closeInfoModal() {
        this._pickerOverlay?.remove();
        this._pickerOverlay = null;
        this._infoOverlay?.remove();
        this._infoOverlay = null;
        this._infoLora = null;
    }

    /** 在信息窗状态行显示一条临时提示（2.5 秒后清除） */
    _infoStatus(text, isError) {
        const el = this._infoOverlay?.querySelector('.lora-info-status');
        if (!el) return;
        el.textContent = text || '';
        el.classList.toggle('error', !!isError);
        if (text) {
            clearTimeout(this._infoStatusTimer);
            this._infoStatusTimer = setTimeout(() => {
                el.textContent = '';
                el.classList.remove('error');
            }, 2500);
        }
    }

    /** 读取本地图片文件为 data URL 并上传 */
    _readLocalCover(file) {
        const reader = new FileReader();
        reader.onload = () => this._uploadCover(String(reader.result));
        reader.onerror = () => this._infoStatus('读取文件失败', true);
        reader.readAsDataURL(file);
    }

    /**
     * 打开画布选图浮层（信息窗之上的二级弹层）：网格列出画布上的
     * 图片对象（排除面板节点/占位图/视频），点击即取为封面
     */
    _openCanvasPicker(lora) {
        this._pickerOverlay?.remove();
        const canvas = window.canvas;
        const imgs = canvas
            ? canvas.images.images.filter((im) =>
                im?.img?.src &&
                !NodeTypes.isPanelNode(im.source) &&
                !NodeTypes.isPlaceholder(im.source) &&
                !NodeTypes.isVideo(im.source))
            : [];

        const overlay = document.createElement('div');
        overlay.className = 'lora-canvas-picker';
        const head = document.createElement('div');
        head.className = 'lora-picker-head';
        head.textContent = '选择画布图片作为封面';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'lora-picker-close';
        close.textContent = '×';
        close.title = '关闭';
        close.addEventListener('click', () => {
            overlay.remove();
            this._pickerOverlay = null;
        });
        head.appendChild(close);

        const grid = document.createElement('div');
        grid.className = 'lora-picker-grid';
        if (imgs.length === 0) {
            grid.innerHTML = '<div class="lora-picker-empty">画布上没有可用图片</div>';
        }
        for (const im of imgs) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'lora-picker-item';
            const thumb = document.createElement('img');
            thumb.src = im.img.src;
            item.appendChild(thumb);
            item.title = im.name || '';
            item.addEventListener('click', async () => {
                try {
                    const dataUrl = await ImageExport.toDataUrl(im.img, im.img.src);
                    overlay.remove();
                    this._pickerOverlay = null;
                    this._uploadCover(dataUrl);
                } catch (err) {
                    this._infoStatus('取图失败：' + (err.message || err), true);
                }
            });
            grid.appendChild(item);
        }

        const panel = document.createElement('div');
        panel.className = 'lora-picker-panel';
        panel.append(head, grid);
        overlay.appendChild(panel);
        overlay.addEventListener('mousedown', (e) => {
            if (e.target === overlay) {
                overlay.remove();
                this._pickerOverlay = null;
            }
        });
        document.body.appendChild(overlay);
        this._pickerOverlay = overlay;
    }

    /** 上传封面（POST /api/lora/cover），成功后缓存击穿并刷新网格 */
    async _uploadCover(dataUrl) {
        const lora = this._infoLora;
        if (!lora) return;
        this._infoStatus('上传中…');
        try {
            const resp = await fetch('/api/lora/cover', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: lora.path, dataUrl })
            });
            const r = await resp.json().catch(() => null);
            if (!resp.ok || !r || r.status !== 'ok') {
                // 非 JSON 响应（多半是后端未重启、路由 404 的 HTML 错误页）给明示
                throw new Error(r?.message || `上传失败（HTTP ${resp.status}；若刚更新过程序请重启后端）`);
            }
            this._bustMap = this._bustMap || {};
            this._bustMap[lora.path] = Date.now();   // 绕过 /preview 的 1 天浏览器缓存
            this._closeInfoModal();
            this._renderGrid();
        } catch (err) {
            this._infoStatus('❌ ' + (err.message || err), true);
        }
    }

    // ==================== 删除 lora ====================

    /**
     * 删除确认弹窗（危险操作）：明示会删源文件与封面、引用会断链、
     * 不可撤销；确认后调后端删除并同步本地清单
     * @param {Object} lora - 待删除的 lora 数据
     */
    _confirmDelete(lora) {
        this._confirmOverlay?.remove();
        const overlay = document.createElement('div');
        overlay.className = 'lora-confirm-overlay';
        overlay.innerHTML = `
            <div class="lora-confirm-panel">
                <div class="lora-confirm-title">⚠️ 删除 LoRA</div>
                <div class="lora-confirm-text"></div>
                <div class="lora-confirm-status"></div>
                <div class="lora-confirm-actions">
                    <button type="button" class="lora-confirm-cancel">取消</button>
                    <button type="button" class="lora-confirm-ok">删除</button>
                </div>
            </div>
        `;
        overlay.querySelector('.lora-confirm-text').textContent =
            `确定删除「${lora.name}」吗？将同时删除源文件（${(lora.sizeBytes / 1048576).toFixed(1)} MB）` +
            `与封面图，画布节点和工作流里引用该文件的地方会失效，且无法撤销。`;

        const close = () => {
            overlay.remove();
            this._confirmOverlay = null;
        };
        overlay.querySelector('.lora-confirm-cancel').addEventListener('click', close);
        overlay.addEventListener('mousedown', (e) => {
            if (e.target === overlay) close();
        });
        overlay.querySelector('.lora-confirm-ok').addEventListener('click', async () => {
            const okBtn = overlay.querySelector('.lora-confirm-ok');
            const status = overlay.querySelector('.lora-confirm-status');
            okBtn.disabled = true;
            okBtn.textContent = '删除中…';
            try {
                const resp = await fetch('/api/lora/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: lora.path })
                });
                const r = await resp.json().catch(() => null);
                if (!resp.ok || !r || r.status !== 'ok') {
                    throw new Error(r?.message || `删除失败（HTTP ${resp.status}）`);
                }
                // 本地数据同步移除（文件夹清单重算），清缓存与置顶痕迹
                this.data.loras = this.data.loras.filter((l) => l.path !== lora.path);
                this.data.folders = [...new Set(this.data.loras.map((l) => l.folder).filter(Boolean))].sort();
                this.pinned.delete(lora.path);
                if (this._bustMap) delete this._bustMap[lora.path];
                close();
                this._closeInfoModal();
                this._renderFolders();
                this._renderGrid();
            } catch (err) {
                okBtn.disabled = false;
                okBtn.textContent = '删除';
                status.textContent = '❌ ' + (err.message || err);
            }
        });

        document.body.appendChild(overlay);
        this._confirmOverlay = overlay;
    }

    // ==================== 渲染 ====================

    _renderFolders() {
        const { folders, loras } = this.data;
        const rootCount = loras.filter((l) => !l.folder).length;
        const makeItem = (label, value, count) => {
            // 条目结构复用 recipe-models-sidebar（.recipe-models-item/.recipe-models-label，
            // 选中态 = .is-active 绿色高亮），右侧补一个小计数
            const item = document.createElement('div');
            item.className = 'recipe-models-item' + (this.activeFolder === value ? ' is-active' : '');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'recipe-models-label';
            btn.textContent = label;
            btn.title = label;
            btn.addEventListener('click', () => {
                this.activeFolder = (this.activeFolder === value) ? null : value;
                this._renderFolders();
                this._renderGrid();
            });
            const countEl = document.createElement('span');
            countEl.className = 'lora-folder-count';
            countEl.textContent = count;
            item.append(btn, countEl);
            return item;
        };
        this.folderList.innerHTML = '';
        this.folderList.appendChild(makeItem('全部', null, loras.length));
        if (rootCount > 0) this.folderList.appendChild(makeItem('（根目录）', '', rootCount));
        for (const f of folders) {
            const count = loras.filter((l) => l.folder === f || l.folder.startsWith(f + '/')).length;
            this.folderList.appendChild(makeItem(f, f, count));
        }
    }

    _filteredLoras() {
        let list = this.data.loras;
        if (this.activeFolder !== null) {
            const f = this.activeFolder;
            list = list.filter((l) => f === '' ? !l.folder : (l.folder === f || l.folder.startsWith(f + '/')));
        }
        if (this.searchText) {
            list = list.filter((l) => l.name.toLowerCase().includes(this.searchText) ||
                l.path.toLowerCase().includes(this.searchText));
        }
        // 筛选：仅看置顶（漏斗下拉的 pinned-only 档）
        if (this.sortMode === 'pinned-only') {
            list = list.filter((l) => this.pinned.has(l.path));
        }
        // 排序：置顶永远在前，置顶组内按所选策略（默认名称 / 添加时间 mtime）
        return [...list].sort((a, b) => {
            const pa = this.pinned.has(a.path) ? 0 : 1;
            const pb = this.pinned.has(b.path) ? 0 : 1;
            if (pa !== pb) return pa - pb;
            if (this.sortMode === 'time-desc') return (b.mtime || 0) - (a.mtime || 0);
            if (this.sortMode === 'time-asc') return (a.mtime || 0) - (b.mtime || 0);
            return a.name.localeCompare(b.name);
        });
    }

    _renderGrid() {
        const list = this._filteredLoras();
        this.grid.innerHTML = '';
        this.countEl.textContent = list.length ? `${list.length} 个` : '';
        this.currentEl.textContent = this.searchText
            ? `搜索：${this.searchInput.value.trim()}`
            : (this.activeFolder === null ? '全部'
                : (this.activeFolder === '' ? '（根目录）' : this.activeFolder));
        if (list.length === 0) {
            this.emptyEl.textContent = this.searchText ? '没有匹配的 LoRA'
                : (this.sortMode === 'pinned-only' ? '没有置顶的 LoRA（点封面右上角星星置顶）'
                    : '该文件夹下没有 LoRA 文件');
            this.emptyEl.classList.remove('hidden');
            return;
        }
        this.emptyEl.classList.add('hidden');

        for (const lora of list) {
            const card = document.createElement('div');
            card.className = 'lora-card' + (this.pinned.has(lora.path) ? ' pinned' : '');

            // 封面：sidecar 预览图，404 时换占位块；点击打开信息窗。
            // 上传过新封面的 lora 带时间戳参数绕过浏览器 1 天缓存
            const cover = document.createElement('div');
            cover.className = 'lora-cover';
            cover.title = '点击查看详情 / 更换封面';
            const img = document.createElement('img');
            img.loading = 'lazy';
            img.alt = lora.name;
            img.addEventListener('error', () => {
                cover.classList.add('no-preview');
                img.remove();
                cover.insertAdjacentHTML('beforeend', `<div class="lora-placeholder"></div>`);
            });
            const bust = this._bustMap && this._bustMap[lora.path];
            img.src = `/api/lora/preview?path=${encodeURIComponent(lora.path)}${bust ? `&t=${bust}` : ''}`;
            cover.appendChild(img);
            cover.addEventListener('click', () => this._openInfoModal(lora));

            // 置顶星星（封面右上角）
            const star = document.createElement('button');
            star.type = 'button';
            star.className = 'lora-star' + (this.pinned.has(lora.path) ? ' on' : '');
            star.title = this.pinned.has(lora.path) ? '取消置顶' : '置顶';
            star.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="${this.pinned.has(lora.path) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
            star.addEventListener('click', (e) => {
                e.stopPropagation();
                const on = !this.pinned.has(lora.path);
                star.classList.toggle('on', on);
                star.querySelector('svg').setAttribute('fill', on ? 'currentColor' : 'none');
                star.title = on ? '取消置顶' : '置顶';
                this.togglePin(lora.path, on);
            });
            cover.appendChild(star);

            // 纸飞机：投递到画布 LoRA 节点 / 右侧 Comfy 面板
            const send = document.createElement('button');
            send.type = 'button';
            send.className = 'lora-send';
            send.title = '发送到 LoRA 节点 / Comfy 面板';
            send.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
            send.addEventListener('click', (e) => {
                e.stopPropagation();
                this._openSendPopup(lora, send);
            });
            cover.appendChild(send);

            // 名称（封面下方一行截断）
            const label = document.createElement('div');
            label.className = 'lora-name';
            label.textContent = lora.name;
            label.title = `${lora.name}${lora.folder ? `\n目录：${lora.folder}` : ''}\n大小：${(lora.sizeBytes / 1048576).toFixed(1)} MB`;

            card.append(cover, label);
            card.addEventListener('click', () => { /* 后续步骤：触发词/生图入口 */ });
            this.grid.appendChild(card);
        }
    }
}

window.LoraManager = LoraManager;
