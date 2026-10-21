/**
 * ==========================================================================
 * LumenLight LoRA 管理窗口（LoraManager）——主类（骨架 + 数据 + 渲染）
 * ==========================================================================
 * 作用：顶栏「LoRA」按钮打开的全屏管理窗口（骨架复用提示词收藏页
 * RecipeManager 的弹窗样式类：recipe-dialog 全屏遮罩 + 面板 + 头部 +
 * 左右分栏 + 左侧栏条目），管理用户 ComfyUI 的 LoRA 文件：
 *   - 左栏：loras 目录的文件夹层级树（LumenTreeList 预制件：磁盘子文件夹
 *     自动成树、可折叠记忆），全部/根目录固定项置顶，点击筛选（父文件夹
 *     含子文件夹内容）；
 *   - 右区：当前文件夹大标题 + 刷新按钮（重扫本地目录：外部增删 LoRA
 *     文件后同步；show 每次开窗都重扫 + 按钮手动刷新，防重入转圈，
 *     清单就位后做文件夹失效回落/批量选择清失效项/diff 轻提示）+
 *     批量按钮 + Civitai 获取 + 筛选排序下拉 +
 *     搜索框 + LoRA 封面网格（3:4 比例、一行 8 个），封面读 sidecar 预览图
 *     （<同名>.preview.png/.jpg 等，无图显示名称首字占位块）；筛选排序下拉
 *     为 LumenDropdown 图标按钮模式（置顶优先/添加时间 新→旧/旧→新/
 *     仅看置顶，选择存 localStorage，时间口径用 /list 返回的 mtime 近似）；
 *   - 批量管理（LumenBatchManager 预制件）：批量按钮进入多选模式（封面
 *     右上角绿✓选择圈，星星/投递钮左移让位），配套批量条；卡片右键
 *     菜单（LumenContextMenu 预制件）提供投递/置顶/移动到文件夹/打开
 *     所在文件夹/删除——非批量对单只生效，批量对全部所选生效，删除/
 *     移动经 LumenConfirmDialog 确认（路径写死的工作流引用会断链）。
 *   - 封面右上角星星：点击置顶/取消置顶，置顶项排最前且星星变金色；
 *     状态持久化在后端 data/lora-meta.json（按 lora 相对路径记）。
 *
 * 子模块（js/components/lora-manager/，与 image-studio/ 同款拆分契约：
 * 子模块持有宿主实例读写状态，本类留同名薄代理，调用点零改动）：
 *   LoraInfoModal      信息窗（元信息/封面预览/触发词备注就地编辑/状态行）
 *   LoraCoverPicker    封面更换（画布选图浮层 + 本地图片 + 上传/缓存击穿）
 *   LoraSendPopup      纸飞机投递弹窗（投递到画布 LoRA 节点/Comfy 面板）
 *   LoraConfirmDelete  删除确认弹窗（含删后本地清单同步）
 * ESC 关闭优先级链在本类键盘监听里收口：确认框 > 信息窗 > 投递弹窗 > 主窗。
 *
 * 定位是「全局台账」：只读 Comfy 目录，不做重命名（工作流 JSON 里路径
 * 写死，改名会静默断链），删除走显式确认。数据源 /api/lora（routes/lora.js）。
 * 后续规划：可选生图入口（本版未含）。
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

        // 弹层子模块（见文件头注；构造顺序无关，仅运行时调用）
        this._infoModal = new LoraInfoModal(this);
        this._coverPicker = new LoraCoverPicker(this);
        this.sendPopupCtl = new LoraSendPopup(this);
        this._deleteConfirm = new LoraConfirmDelete(this);

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
        this._refreshing = false;    // 清单扫描防重入（show/按钮/删除移动共用）
        this._refreshBtn = null;     // 工具行刷新按钮（_buildDom 建好存引用）
        this._diffNoteTimer = null;  // 刷新 diff 轻提示自动消退定时器

        // ===== 批量管理 / 右键菜单 / 确认弹窗 / 文件夹树（Lumen 预制件，
        // _buildDom 建好 DOM 后实例化接线） =====
        this.batch = null;          // LumenBatchManager（批量按钮+批量条+选择集）
        this.ctxMenu = null;        // LumenContextMenu（卡片右键菜单）
        this.confirm = null;        // LumenConfirmDialog（批量删除/移动确认）
        this.folderTree = null;     // LumenTreeList（左侧文件夹层级树）
        this.movePickerEl = null;   // 移动目标选择弹窗（懒建）
        this.moveTree = null;       // 选择弹窗里的文件夹树
        this._movePaths = [];       // 正在移动的 lora 相对路径

        // ESC 关闭（右键菜单 > 移动选择 > 确认框 > Civitai 弹窗 > 信息窗 >
        // 投递弹窗 > 管理器窗口；菜单/确认框预制件自身也监听 Esc，
        // 这里 isOpen 先判负责"只退一层"）
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (this.ctxMenu?.isOpen) { this.ctxMenu.close(); return; }
            if (this.movePickerEl?.classList.contains('is-open')) { this._closeMovePicker(); return; }
            if (this.confirm?.isOpen) return;   // 预制件自关
            if (this.batch?.isOpen) { this.batch.exit(); return; }
            if (this._fetchOverlay) {
                const resolve = this._fetchResolve;
                this._fetchOverlay.remove();
                this._fetchOverlay = null;
                this._fetchResolve = null;
                if (resolve) resolve(null);   // 取消 = 弹窗 Promise 返回 null
                return;
            }
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

    // ==================== 薄代理：弹层子模块（保持调用点零改动） ====================

    _openInfoModal(lora) { this._infoModal.open(lora); }
    _closeInfoModal() { this._infoModal.close(); }
    _infoStatus(text, isError) { this._infoModal.status(text, isError); }
    _openCanvasPicker(lora) { this._coverPicker.open(lora); }
    _readLocalCover(file) { this._coverPicker.readLocal(file); }
    _uploadCover(dataUrl) { this._coverPicker.upload(dataUrl); }
    _openSendPopup(lora, anchor) { this.sendPopupCtl.open(lora, anchor); }
    _closeSendPopup() { this.sendPopupCtl.close(); }
    _confirmDelete(lora) { this._deleteConfirm.confirm(lora); }

    // ==================== 开合 ====================

    toggle() { this.visible ? this.hide() : this.show(); }

    async show() {
        if (!this.dialog) this._buildDom();
        this.dialog.classList.add('is-open');      // 复用 recipe-dialog 显隐
        this.visible = true;
        if (this.btn) this.btn.setAttribute('aria-expanded', 'true');
        // 每次打开都重扫：/list 是实时扫盘（毫秒级），外部增删 LoRA 文件
        // 后重开窗口即同步（旧逻辑 if (!this.data) 只首开拉一次，之后
        // 一直吃内存缓存——过期清单的主因）
        await this.refresh();
        if (!this._pinsLoaded) await this.loadPins();
    }

    hide() {
        if (!this.dialog) return;
        this.ctxMenu?.close();
        this._closeMovePicker();
        this.confirm?.cancel();
        this.batch?.exit();
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
                                <button class="lora-refresh-btn" type="button" title="刷新清单：重新扫描本地 LoRA 目录（外部增删文件后同步）" aria-label="刷新 LoRA 清单">
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                                    <span>刷新</span>
                                </button>
                                <button class="lora-batch-btn" type="button" title="批量管理：多选后右键投递/置顶/移动/删除" aria-label="批量管理">
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"></rect><path d="m8.5 12 2.5 2.5 5-5"></path></svg>
                                    <span>批量</span>
                                </button>
                                <button class="lora-fetch-btn" type="button" title="从 Civitai 获取封面与触发词">
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 12v9"/><path d="m16 16-4-4-4 4"/></svg>
                                    <span>获取</span>
                                </button>
                                <button class="lora-sort-btn" type="button" aria-label="排序与筛选"></button>
                                <div class="recipe-search-box">
                                    <svg class="recipe-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                                    <input type="text" class="recipe-search-input lora-search-input" placeholder="搜索 LoRA 名称..." aria-label="搜索 LoRA 名称">
                                </div>
                            </div>
                        </div>
                        <div class="lora-fetch-status hidden"></div>
                        <!-- 批量条槽位：LumenBatchManager 预制件把批量条插这里 -->
                        <div class="lora-batch-bar-slot"></div>
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
        this.fetchStatus = el.querySelector('.lora-fetch-status');
        el.querySelector('.recipe-dialog-close').addEventListener('click', () => this.hide());
        this._refreshBtn = el.querySelector('.lora-refresh-btn');
        this._refreshBtn.addEventListener('click', () => this.refresh());
        el.querySelector('.lora-fetch-btn').addEventListener('click', () => this._openFetchAllDialog());
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

        // ===== 批量管理 / 右键菜单 / 确认弹窗 / 文件夹树（Lumen 预制件） =====
        this.batch = new LumenBatchManager({
            trigger: el.querySelector('.lora-batch-btn'),
            barContainer: el.querySelector('.lora-batch-bar-slot'),
            gridEl: this.grid,
            getVisibleIds: () => this._filteredLoras().map((l) => l.path),
            onChange: () => this._syncBatchSelection()
        });
        this.ctxMenu = new LumenContextMenu({ container: el });
        this.confirm = new LumenConfirmDialog({ container: el });
        // 文件夹层级树：磁盘子文件夹自动成树，折叠记忆独立 key
        this.folderTree = new LumenTreeList({
            container: document.createElement('div'),
            collapsedKey: 'lumen.loraFolderCollapsed',
            buildRows: (row, node) => this._buildFolderRow(row, node)
        });
    }

    // ==================== 批量管理（LumenBatchManager 接线） ====================

    /** 同步 LoRA 卡片选择态（批量条计数由预制件维护） */
    _syncBatchSelection() {
        for (const card of this.grid.querySelectorAll('.lora-card')) {
            card.classList.toggle('is-selected', this.batch.isSelected(card.dataset.path));
        }
    }

    // ==================== 数据加载 ====================

    async refresh() {
        // 防重入：扫描进行中再点忽略（show 每次开窗、删除/移动后都会走这里）
        if (this._refreshing) return;
        this._refreshing = true;
        this._setRefreshBusy(true);
        // 旧清单路径集：加载成功后 diff 出「新增/移除」作可见反馈
        const prevPaths = this.data ? new Set(this.data.loras.map((l) => l.path)) : null;
        try {
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
                this._settleRefresh(prevPaths);
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
        } finally {
            this._refreshing = false;
            this._setRefreshBusy(false);
        }
    }

    /** 刷新按钮转圈/恢复（扫描通常毫秒级，转圈主要是「确实在动」的反馈） */
    _setRefreshBusy(busy) {
        this._refreshBtn?.classList.toggle('is-busy', busy);
    }

    /**
     * 清单就位后的收尾（渲染前执行，三件事）：
     *  1. 当前文件夹被外部删除时回落「全部」——否则空网格且侧栏无高亮；
     *  2. 批量选择集里已消失的条目清掉（计数与后续批量操作都以 path 为准）；
     *  3. 对比旧清单 diff，真的变了才弹「已刷新：新增 X · 移除 Y」轻提示
     *     （扫描毫秒级完成，没有提示用户会怀疑没生效）
     */
    _settleRefresh(prevPaths) {
        const paths = new Set(this.data.loras.map((l) => l.path));

        if (this.activeFolder !== null) {
            const f = this.activeFolder;
            const alive = this.data.loras.some((l) => f === ''
                ? !l.folder
                : (l.folder === f || l.folder.startsWith(f + '/')));
            if (!alive) this.activeFolder = null;
        }

        if (this.batch?.isOpen && this.batch.selectedIds.size) {
            let pruned = false;
            for (const id of [...this.batch.selectedIds]) {
                if (!paths.has(id)) { this.batch.selectedIds.delete(id); pruned = true; }
            }
            // 批量条计数在预制件 _notify 里维护，剪枝后手动同步一次
            if (pruned) this.batch._notify();
        }

        if (prevPaths) {
            let added = 0, removed = 0;
            for (const p of paths) if (!prevPaths.has(p)) added++;
            for (const p of prevPaths) if (!paths.has(p)) removed++;
            if (added || removed) this._flashDiffNote(added, removed);
        }
    }

    /** 头部轻提示「已刷新：新增 X · 移除 Y」，4 秒后自动消退 */
    _flashDiffNote(added, removed) {
        this.detectNote.textContent = `已刷新：新增 ${added} · 移除 ${removed}`;
        clearTimeout(this._diffNoteTimer);
        this._diffNoteTimer = setTimeout(() => {
            if (this.detectNote.textContent.startsWith('已刷新')) this.detectNote.textContent = '';
        }, 4000);
    }

    async loadPins() {
        try {
            const r = await fetch('/api/lora/pins').then((r) => r.json());
            if (r.status === 'ok') {
                this.pinned = new Set(r.pinned);
                this.triggers = r.triggers || {};
                this.notes = r.notes || {};
                this.civitai = r.civitai || {};   // 含 pageUrl，信息窗「C 站页面」按钮用
            }
            this._pinsLoaded = true;
        } catch { /* 置顶/触发词状态加载失败不阻塞窗口 */ }
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

    // ==================== 渲染 ====================

    _renderFolders() {
        const { loras } = this.data;
        const rootCount = loras.filter((l) => !l.folder).length;
        this.folderList.replaceChildren();

        // 全部 / （根目录）：树外固定项（无层级语义）
        this.folderList.appendChild(this._makeFolderItem('全部', null, loras.length));
        if (rootCount > 0) this.folderList.appendChild(this._makeFolderItem('（根目录）', '', rootCount));
        this.folderList.appendChild(this.folderTree.container);

        // 磁盘文件夹路径拆段合成树节点：a/b/c → a、a/b、a/b/c 三节点
        // （LumenTreeList 负责缩进/折叠；value 用完整相对路径做筛选）
        this.folderTree.setNodes(this._folderNodes());
        this.folderTree.render();
    }

    /** 把 /list 的扁平文件夹路径清单拆段合成树节点（侧栏与移动选择框共用） */
    _folderNodes() {
        const byId = new Map();
        const nodes = [];
        for (const f of (this.data?.folders || [])) {
            const segs = f.split('/');
            let prefix = '';
            for (const seg of segs) {
                const id = prefix ? `${prefix}/${seg}` : seg;
                if (!byId.has(id)) {
                    const node = { id, name: seg, parentId: prefix || null };
                    byId.set(id, node);
                    nodes.push(node);
                }
                prefix = id;
            }
        }
        return nodes;
    }

    /** 树外固定项（全部/根目录）：结构与树行一致，复用侧栏样式类 */
    _makeFolderItem(label, value, count) {
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
    }

    /** LumenTreeList 行内容：文件夹名（点击筛选，含子文件夹内容）+ 计数 */
    _buildFolderRow(row, node) {
        row.classList.add('recipe-models-item');
        const count = this.data.loras.filter(
            (l) => l.folder === node.id || l.folder.startsWith(node.id + '/')
        ).length;
        const active = this.activeFolder === node.id;
        row.classList.toggle('is-active', active);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'recipe-models-label';
        btn.textContent = node.name;
        btn.title = node.id;   // 完整相对路径（子文件夹名与父级可能重名）
        btn.addEventListener('click', () => {
            this.activeFolder = active ? null : node.id;
            this._renderFolders();
            this._renderGrid();
        });
        const countEl = document.createElement('span');
        countEl.className = 'lora-folder-count';
        countEl.textContent = count;
        row.append(btn, countEl);
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
            card.dataset.path = lora.path;
            if (this.batch.isSelected(lora.path)) card.classList.add('is-selected');

            // 批量模式：整卡点击切换选中（普通模式整卡暂无行为）
            card.addEventListener('click', () => {
                if (this.batch.isOpen) this.batch.toggleOne(lora.path);
            });
            // 右键菜单：投递/置顶/移动/打开文件夹/删除（非批量=单只）
            card.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this._openCardMenu(e, lora);
            });

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
            const bust = (this._bustMap && this._bustMap[lora.path]) || this._bustAll;
            img.src = `/api/lora/preview?path=${encodeURIComponent(lora.path)}${bust ? `&t=${bust}` : ''}`;
            cover.appendChild(img);
            cover.addEventListener('click', () => {
                if (!this.batch.isOpen) this._openInfoModal(lora);
            });

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

            // 选择圈（LumenBatchManager 预制件）：批量模式显示，选中变绿✓；
            // 星星/投递钮在批量模式下经 CSS 左移让位
            cover.appendChild(LumenBatchManager.createCheckBadge());

            // 名称（封面下方一行截断）
            const label = document.createElement('div');
            label.className = 'lora-name';
            label.textContent = lora.name;
            label.title = `${lora.name}${lora.folder ? `\n目录：${lora.folder}` : ''}\n大小：${(lora.sizeBytes / 1048576).toFixed(1)} MB`;

            card.append(cover, label);
            this.grid.appendChild(card);
        }
    }

    // ==================== 卡片右键菜单（LumenContextMenu 接线） ====================

    /**
     * 卡片右键菜单：非批量对单只生效，批量对全部所选生效（资源管理器
     * 惯例：右键未选中的卡=收拢选中它）。移动/确认弹窗开着时不响应。
     */
    _openCardMenu(event, lora) {
        if (this.movePickerEl?.classList.contains('is-open') || this.confirm.isOpen) {
            event.preventDefault();
            return;
        }
        if (this.batch.isOpen && !this.batch.isSelected(lora.path)) {
            this.batch.clearSelection();
            this.batch.toggleOne(lora.path);
        }
        const paths = this.batch.isOpen ? this.batch.getIds() : [lora.path];
        if (!paths.length) return;
        const many = paths.length > 1;
        const anchor = event.target?.closest?.('.lora-card') || this.grid;
        this.ctxMenu.open({
            x: event.clientX,
            y: event.clientY,
            items: [
                {
                    label: many ? `投递所选（${paths.length} 只）` : '投递到…',
                    onClick: () => this._openSendPopup(this._lorasByPaths(paths), anchor)
                },
                ...this._pinMenuItems(paths),
                {
                    label: many ? `移动所选（${paths.length} 只）到文件夹…` : '移动到文件夹…',
                    onClick: () => this._openMovePicker(paths)
                },
                {
                    label: '打开所在文件夹',
                    onClick: () => this._revealLora(paths[0])
                },
                {
                    label: many ? `删除所选（${paths.length} 只）` : '删除',
                    danger: true,
                    onClick: () => this._deleteLoras(paths)
                }
            ]
        });
    }

    /** 按相对路径取 lora 数据（批量投递用） */
    _lorasByPaths(paths) {
        return paths.map((p) => this.data.loras.find((l) => l.path === p)).filter(Boolean);
    }

    /** 置顶菜单项：全钉→只给取消；全未钉→只给置顶；混合→两档都给 */
    _pinMenuItems(paths) {
        const allPinned = paths.every((p) => this.pinned.has(p));
        const anyPinned = paths.some((p) => this.pinned.has(p));
        const many = paths.length > 1;
        const items = [];
        if (!allPinned) {
            items.push({
                label: many ? `置顶所选（${paths.length} 只）` : '置顶',
                onClick: () => this._setBatchPin(paths, true)
            });
        }
        if (anyPinned) {
            items.push({
                label: many ? `取消置顶所选（${paths.length} 只）` : '取消置顶',
                onClick: () => this._setBatchPin(paths, false)
            });
        }
        return items;
    }

    /** 批量置顶：先乐观更新一次界面，再逐只落盘（写整份 meta，串行防互相覆盖） */
    async _setBatchPin(paths, on) {
        for (const p of paths) {
            if (on) this.pinned.add(p); else this.pinned.delete(p);
        }
        this._renderGrid();
        for (const p of paths) {
            try {
                const r = await fetch('/api/lora/pins', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: p, pinned: on })
                }).then((r) => r.json());
                if (r.status !== 'ok') throw new Error(r.message);
            } catch (err) {
                if (on) this.pinned.delete(p); else this.pinned.add(p);
                console.warn('[lora] 批量置顶保存失败:', p, err.message || err);
            }
        }
        this._renderGrid();
    }

    /** 打开所在文件夹（资源管理器选中该文件，复用 /reveal） */
    async _revealLora(path) {
        try {
            const r = await fetch('/api/lora/reveal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path })
            }).then((r) => r.json());
            if (r.status !== 'ok') throw new Error(r.message);
        } catch (err) {
            alert('打开文件夹失败：' + (err.message || err));
        }
    }

    /** 删除（右键入口）：批量≥2 经预制件确认框；单只沿用既有确认弹窗 */
    async _deleteLoras(paths) {
        if (paths.length > 1) {
            const ok = await this.confirm.confirm({
                title: `删除所选的 ${paths.length} 只 LoRA 文件？`,
                note: '删除源文件与封面等 sidecar，不可恢复；已写进工作流的引用路径会断链',
                okText: '删除'
            });
            if (!ok) return;
        } else {
            const lora = this.data.loras.find((l) => l.path === paths[0]);
            if (!lora) return;
            this._confirmDelete(lora);   // LoraConfirmDelete 自带确认与清单同步
            return;
        }
        const failed = [];
        for (const p of paths) {
            try {
                const r = await fetch('/api/lora/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: p })
                }).then((r) => r.json());
                if (r.status !== 'ok') throw new Error(r.message);
            } catch (err) {
                failed.push(p);
            }
        }
        if (failed.length) alert(`${failed.length} 只删除失败：\n${failed.join('\n')}`);
        this.batch.clearSelection();
        this._pinsLoaded = false;
        await this.refresh();
    }

    // ==================== 移动到文件夹（/move 接口） ====================

    /** 移动目标选择弹窗：文件夹树（含子文件夹）+ 根目录项，选中后确认 */
    _openMovePicker(paths) {
        if (!this.movePickerEl) {
            const picker = document.createElement('div');
            picker.className = 'lumen-confirm-overlay lora-move-overlay';
            picker.innerHTML = `
                <div class="lora-move-panel" role="dialog" aria-label="移动到文件夹">
                    <h4 class="lora-move-title">移动到文件夹</h4>
                    <div class="lora-move-list"></div>
                    <div class="lumen-confirm-actions">
                        <button type="button" class="lumen-btn" data-act="cancel">取消</button>
                    </div>
                </div>`;
            picker.addEventListener('click', (e) => {
                if (e.target === picker) this._closeMovePicker();
            });
            picker.querySelector('[data-act="cancel"]').addEventListener('click', () => this._closeMovePicker());
            this.dialog.appendChild(picker);
            this.movePickerEl = picker;
            this.moveTree = new LumenTreeList({
                container: picker.querySelector('.lora-move-list'),
                // 无 collapsedKey = 始终展开（选择场景不折叠）
                buildRows: (row, node) => {
                    const item = document.createElement('button');
                    item.type = 'button';
                    item.className = 'lora-move-item';
                    item.textContent = node.name;
                    item.title = node.id;
                    item.addEventListener('click', () => this._applyMove(this._movePaths, node.id));
                    row.appendChild(item);
                }
            });
        }
        this._movePaths = paths;
        this.movePickerEl.querySelector('.lora-move-title').textContent = `移动 ${paths.length} 只 LoRA 到：`;

        // 重建列表：先渲染文件夹树（render 会清容器），再插入根目录固定项
        const list = this.movePickerEl.querySelector('.lora-move-list');
        this.moveTree.setNodes(this._folderNodes());
        this.moveTree.render();
        const rootBtn = document.createElement('button');
        rootBtn.type = 'button';
        rootBtn.className = 'lora-move-item';
        rootBtn.textContent = '（根目录）';
        rootBtn.addEventListener('click', () => this._applyMove(this._movePaths, ''));
        list.insertBefore(rootBtn, list.firstChild);
        if (!this.moveTree.container.children.length) {
            const empty = document.createElement('p');
            empty.className = 'lora-move-empty';
            empty.textContent = 'loras 目录下还没有任何子文件夹';
            list.appendChild(empty);
        }
        this.movePickerEl.classList.add('is-open');
    }

    _closeMovePicker() {
        if (this.movePickerEl?.classList.contains('is-open')) {
            this.movePickerEl.classList.remove('is-open');
        }
    }

    /** 应用移动：确认（断链警示）→ POST /move → 重拉清单与置顶映射 */
    async _applyMove(paths, target) {
        // 已在目标文件夹的自动跳过（后端也会兜底）
        const targets = paths.filter((p) => {
            const lora = this.data.loras.find((l) => l.path === p);
            return lora && lora.folder !== target;
        });
        this._closeMovePicker();
        if (!targets.length) return;
        const ok = await this.confirm.confirm({
            title: `移动 ${targets.length} 只 LoRA 到「${target || '（根目录）'}」？`,
            note: '移动文件与封面并同步置顶/触发词记录；工作流里写死的旧路径会断链',
            okText: '移动'
        });
        if (!ok) return;
        const r = await fetch('/api/lora/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: targets, target })
        }).then((r) => r.json()).catch(() => null);
        if (!r || r.status !== 'ok') {
            alert('移动失败：' + ((r && r.message) || '请检查后端是否已重启（/move 接口未生效）'));
            return;
        }
        const skipped = (r.skipped || []).length;
        const failed = (r.failed || []).length;
        if (skipped || failed) {
            const lines = [];
            if (skipped) lines.push(`跳过 ${skipped} 个（目标同名冲突或已在目标文件夹）`);
            if (failed) lines.push(`失败 ${failed} 个（${(r.failed || []).map((f) => f.reason).join('、')}）`);
            alert(`已移动 ${r.moved} 个；${lines.join('；')}`);
        }
        this.batch.clearSelection();
        this._pinsLoaded = false;   // 路径变了，置顶/触发词映射需重拉
        await this.refresh();
    }

    // ==================== Civitai 一键获取（封面 + 触发词） ====================

    /**
     * 冲突策略三选一弹窗（单只获取时已有手填触发词的情况下询问）。
     * 返回 'overwrite' | 'merge' | 'skip'，取消（按钮/遮罩/ESC）返回 null。
     */
    _askCivitaiConflict(title, desc) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'lora-info-overlay lora-fetch-overlay';
            overlay.innerHTML = `
                <div class="lora-info-panel lora-fetch-panel">
                    <header class="lora-info-header">
                        <span class="lora-info-title"></span>
                        <button type="button" class="lora-info-close" title="关闭"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                    </header>
                    <p class="lora-fetch-desc"></p>
                    <div class="lora-fetch-choices">
                        <button type="button" data-v="overwrite">覆盖已有</button>
                        <button type="button" data-v="merge" class="primary">合并（追加去重）</button>
                        <button type="button" data-v="skip">跳过已填</button>
                    </div>
                </div>
            `;
            overlay.querySelector('.lora-info-title').textContent = title;
            overlay.querySelector('.lora-fetch-desc').textContent = desc;
            const done = (v) => {
                overlay.remove();
                if (this._fetchOverlay === overlay) this._fetchOverlay = null;
                this._fetchResolve = null;
                resolve(v);
            };
            this._fetchResolve = done;
            overlay.querySelectorAll('.lora-fetch-choices button').forEach((b) => {
                b.addEventListener('click', () => done(b.dataset.v));
            });
            overlay.querySelector('.lora-info-close').addEventListener('click', () => done(null));
            overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(null); });
            document.body.appendChild(overlay);
            this._fetchOverlay = overlay;
        });
    }

    /** 批量获取入口：策略弹窗 → 保存 Key/代理设置 → 启动批任务 → 进度轮询 */
    async _openFetchAllDialog() {
        // 已有批任务在跑：直接切回进度态，不重复弹窗
        const prog = await fetch('/api/lora/civitai/progress').then((r) => r.json()).catch(() => null);
        if (prog && prog.status === 'ok' && prog.running) {
            this._showFetchProgress();
            return;
        }

        const overlay = document.createElement('div');
        overlay.className = 'lora-info-overlay lora-fetch-overlay';
        overlay.innerHTML = `
            <div class="lora-info-panel lora-fetch-panel">
                <header class="lora-info-header">
                    <span class="lora-info-title">从 Civitai 获取</span>
                    <button type="button" class="lora-info-close" title="关闭"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                </header>
                <p class="lora-fetch-desc">按文件 SHA256 在 Civitai 检索每个 LoRA，拉取封面与触发词。首次批量需计算全部文件哈希，可能耗时较长；进度显示在工具栏下方，可随时取消。</p>
                <div class="lora-fetch-field">
                    <span>已有触发词时</span>
                    <label><input type="radio" name="loraCivitaiConflict" value="merge" checked> 合并（追加去重）</label>
                    <label><input type="radio" name="loraCivitaiConflict" value="overwrite"> 覆盖已有</label>
                    <label><input type="radio" name="loraCivitaiConflict" value="skip"> 跳过已填</label>
                </div>
                <div class="lora-fetch-field">
                    <label><input type="checkbox" id="loraCivitaiSkipCover" checked> 跳过已有自定义封面</label>
                    <label><input type="checkbox" id="loraCivitaiSkipFetched" checked> 跳过已获取过的 LoRA</label>
                </div>
                <div class="lora-fetch-field">
                    <span>Civitai API Key（可选：提高限额并支持 NSFW 模型，留空匿名查询）</span>
                    <input type="password" id="loraCivitaiKey" placeholder="Civitai → Account Settings → API Keys">
                </div>
                <div class="lora-fetch-field">
                    <span>代理（可选：留空自动检测系统代理/环境变量）</span>
                    <input type="text" id="loraCivitaiProxy" placeholder="http://127.0.0.1:7890">
                </div>
                <div class="lora-fetch-actions">
                    <button type="button" class="lora-fetch-start">开始获取</button>
                </div>
            </div>
        `;
        // 预填已保存的 Key/代理
        fetch('/api/settings').then((r) => r.json()).then((j) => {
            const c = (j.settings && j.settings.civitai) || {};
            const keyEl = overlay.querySelector('#loraCivitaiKey');
            const proxyEl = overlay.querySelector('#loraCivitaiProxy');
            if (keyEl && c.apiKey) keyEl.value = c.apiKey;
            if (proxyEl && c.proxy) proxyEl.value = c.proxy;
        }).catch(() => { /* 预填失败不影响手填 */ });

        const done = () => {
            overlay.remove();
            if (this._fetchOverlay === overlay) this._fetchOverlay = null;
        };
        overlay.querySelector('.lora-info-close').addEventListener('click', done);
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(); });
        overlay.querySelector('.lora-fetch-start').addEventListener('click', async () => {
            const onConflict = overlay.querySelector('input[name="loraCivitaiConflict"]:checked').value;
            const skipCustomCover = overlay.querySelector('#loraCivitaiSkipCover').checked;
            const skipFetched = overlay.querySelector('#loraCivitaiSkipFetched').checked;
            const apiKey = overlay.querySelector('#loraCivitaiKey').value.trim();
            const proxy = overlay.querySelector('#loraCivitaiProxy').value.trim();
            // Key/代理存设置（POST /api/settings 为合并语义，只动 civitai 字段）
            try {
                await fetch('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ civitai: { apiKey, proxy } })
                });
            } catch { /* 设置保存失败不阻塞获取（用旧值） */ }
            done();
            const resp = await fetch('/api/lora/civitai/fetch-all', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ onConflict, skipCustomCover, skipFetched })
            }).then((r) => r.json()).catch(() => null);
            if (!resp || resp.status !== 'ok') {
                console.warn('[lora] 批量获取启动失败:', resp && resp.message);
                this.fetchStatus.classList.remove('hidden');
                this.fetchStatus.textContent = '启动失败：' + ((resp && resp.message) || '请检查后端是否已重启（新增接口未生效）');
                return;
            }
            this._showFetchProgress();
        });
        document.body.appendChild(overlay);
        this._fetchOverlay = overlay;
    }

    /** 进度轮询（1.2s 间隔）：运行中显示进度条，结束后汇总并刷新网格 */
    _showFetchProgress() {
        const el = this.fetchStatus;
        el.classList.remove('hidden');
        if (this._fetchPolling) return;   // 已在轮询
        this._fetchPolling = true;
        const tick = async () => {
            if (!this._fetchPolling) return;
            const p = await fetch('/api/lora/civitai/progress').then((r) => r.json()).catch(() => null);
            if (!p || p.status !== 'ok') {
                this._fetchTimer = setTimeout(tick, 2500);
                return;
            }
            if (p.running) {
                const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
                el.innerHTML = `
                    <div class="lora-fetch-bar"><i style="width:${pct}%"></i></div>
                    <span class="lora-fetch-text"></span>
                    <button type="button" class="lora-fetch-cancel">取消</button>
                `;
                el.querySelector('.lora-fetch-text').textContent =
                    `${p.done}/${p.total} · 成功 ${p.found} · 未找到 ${p.notFound} · 失败 ${p.failed}${p.skipped ? ' · 跳过 ' + p.skipped : ''}${p.current ? ' · ' + p.current : ''}`;
                el.querySelector('.lora-fetch-cancel').addEventListener('click', async () => {
                    await fetch('/api/lora/civitai/cancel', { method: 'POST' }).catch(() => {});
                });
                this._fetchTimer = setTimeout(tick, 1200);
                return;
            }
            // 结束：汇总 + 刷新（新封面需要整体击穿浏览器缓存；
            // _pinsLoaded 复位让 loadPins 重拉——批量写入的触发词必须进前端缓存）
            this._fetchPolling = false;
            clearTimeout(this._fetchTimer);
            this._bustAll = Date.now();
            this._pinsLoaded = false;
            const summary = p.cancel
                ? '已取消'
                : `获取完成：成功 ${p.found}，未找到 ${p.notFound}，失败 ${p.failed}${p.skipped ? '，跳过 ' + p.skipped : ''}${p.lastError ? '；最后错误：' + p.lastError : ''}`;
            el.innerHTML = '';
            el.textContent = summary;
            await this.refresh();
            setTimeout(() => { el.classList.add('hidden'); el.textContent = ''; }, 8000);
        };
        tick();
    }
}

window.LoraManager = LoraManager;
