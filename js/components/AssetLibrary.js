/**
 * ==========================================================================
 * LumenLight 本地资产库窗口（AssetLibrary）
 * ==========================================================================
 * 作用：左侧工具栏的文件夹图标按钮（"本地上传"按钮下方），点击打开一个
 *       300 宽、贴顶栏到底部控件区之间自适应高度的资产窗口（左侧弹出）：
 *   - 标签栏：标签下拉框（LumenDropdown，一行容纳任意多标签）+ 新建
 *     （文件夹图标，选目录即建标签）+ 删除当前标签（×）；
 *   - 资产网格：展示绑定文件夹内的图片/视频缩略图（滚动懒加载），
 *     网格按标签缓存——重开窗口/切回标签图片零重新加载，后台静默
 *     重扫目录，外部文件增删自动反映；
 *   - 交互：资产可拖拽到画布（DataTransfer 自定义标记 + 实例登记 File，
 *     本组件的画布 drop 监听按标记取回）；双击资产打开灯箱预览大图/视频，
 *     单击无操作——进入画布只走拖拽。
 *
 * 内置标签「我的资产」：图片工具栏「添加到资产」的落图处（后端
 * data/assets/ 目录，经 /api/assets 列出与读取，不经 File System
 * Access API——无授权环节）。首次保存资产后自动出现在下拉框；用户
 * 可随意删除（仅隐藏视图，不动磁盘文件），再次保存即恢复显示。
 *
 * 文件夹访问基于 File System Access API（Chrome/Edge），不支持的环境
 * 自动降级为传统 webkitdirectory 选择框（仅会话内有效，刷新后重新选择）：
 *   - 绑定标签时弹一次系统文件夹选择框（用户手势要求）；
 *   - 句柄经 AssetFolderStore 持久化到 IndexedDB；
 *   - 页面刷新后权限回落为 'prompt'，首次访问该标签时显示
 *     "点击授权"覆盖层，用户点击一次即恢复（浏览器强制，无法绕过）。
 * ==========================================================================
 */

class AssetLibrary {
    constructor() {
        this.store = new AssetFolderStore();
        this.tags = [];              // [{name, handle}]
        this.activeTag = null;       // 当前选中的标签名
        // 网格缓存：tagName -> {gridEl, files, urls}——窗口重开/切回标签时
        // 直接复用已渲染的 DOM 与 blob URL，图片零重新加载；
        // 文件列表变化时由 _backgroundRefresh 重建
        this._gridCache = new Map();
        this._activeUrls = [];       // 当前正在构建/展示的网格的 blob URL
        this._scrollHandler = null;  // 资产网格滚动补填监听
        this._scrollRaf = null;      // 滚动补填的 rAF 节流句柄

        this.init();
    }

    init() {
        // 在左侧工具栏（上传按钮下方）插入文件夹按钮。
        // SideToolbar 先于本组件初始化（app.js 顺序），#sideToolbar 必然存在
        const bar = document.getElementById('sideToolbar');
        if (!bar) return;

        this.btn = document.createElement('button');
        this.btn.className = 'side-toolbar-btn asset-library-btn';
        this.btn.id = 'assetLibraryBtn';
        this.btn.type = 'button';
        this.btn.title = '本地资产库';
        // 文件夹图标（feather 风格，与工具栏现有图标统一）
        this.btn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
        `;
        this.btn.addEventListener('click', () => this.toggle());
        bar.appendChild(this.btn);

        this.buildWindow();

        // 画布拖放接收：资产卡片拖拽携带自定义类型标记 + 本组件登记的
        // File（Chrome 禁止把 File 写入页面拖拽数据流），按落点添加到画布。
        // 画布现有 drop 处理器只认 files，对本标记不响应，互不干扰
        window.canvas.canvas.addEventListener('drop', (e) => {
            if (!this._dragFile) return;
            if (!e.dataTransfer.types.includes('application/x-lumen-asset')) return;
            const rect = window.canvas.canvas.getBoundingClientRect();
            this.handleCanvasDrop(e.clientX - rect.left, e.clientY - rect.top);
        });
    }

    /**
     * 构建资产窗口 DOM（隐藏，toggle 控制显隐）
     */
    buildWindow() {
        this.el = document.createElement('div');
        this.el.className = 'asset-library';
        this.el.innerHTML = `
            <div class="asset-library-header">
                <span class="asset-library-title">本地资产库</span>
                <span class="asset-library-header-spacer"></span>
                <button type="button" class="asset-library-icon-btn asset-library-close-btn"
                        title="关闭">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" stroke-width="2"
                         stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>
            <div class="asset-library-tagbar">
                <button type="button" class="asset-library-tag-select"
                        title="选择标签"></button>
                <div class="asset-library-tag-add" title="新建标签并绑定文件夹">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" stroke-width="2"
                         stroke-linecap="round" stroke-linejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                </div>
                <button type="button" class="asset-library-tag-del"
                        title="删除当前标签" disabled>×</button>
            </div>
            <div class="asset-library-body"></div>
        `;
        document.body.appendChild(this.el);

        this.bodyEl = this.el.querySelector('.asset-library-body');

        this.el.querySelector('.asset-library-close-btn')
            .addEventListener('click', () => this.hide());

        // 标签下拉（LumenDropdown）：一行容纳全部标签，选中即切换资产网格；
        // '' = 未选择（下拉首项占位）。+ 新建 / × 删除当前标签
        this.tagSelectEl = this.el.querySelector('.asset-library-tag-select');
        this.tagDelBtn = this.el.querySelector('.asset-library-tag-del');
        this.tagDropdown = new LumenDropdown(this.tagSelectEl, {
            placeholder: '-- 选择标签 --',
            onChange: (value) => this.selectTag(value || null)
        });
        this.el.querySelector('.asset-library-tag-add')
            .addEventListener('click', () => this.createTag());
        this.tagDelBtn.addEventListener('click', () => this.deleteCurrentTag());
    }

    /** 打开/关闭窗口 */
    async toggle() {
        if (this.el.classList.contains('show')) {
            this.hide();
            return;
        }
        // 与任务中心互斥：同列弹窗不叠开（点击哪个哪个开，另一个收起）
        window.taskCenter?.hide();
        this.el.classList.add('show');
        this.btn.classList.add('active');
        await this.refreshTags();
        // 窗口已瞬时显示缓存网格，后台静默重扫目录：
        // 外部增删了文件才重建（重建期间用户看的仍是缓存，无感知）
        this._backgroundRefresh();
    }

    hide() {
        this.el.classList.remove('show');
        this.btn?.classList.remove('active');
        // 不清缓存：下次打开瞬时恢复，blob URL 继续有效
    }

    // ==================== 标签管理 ====================

    /** 重新读取标签并按当前选中项渲染（选中与否由用户决定，不自动选中） */
    async refreshTags() {
        this.tags = await this.store.getAllTags();
        // 内置标签「我的资产」：后端 data/assets 目录已建立即显示（首次
        // 「添加到资产」后自动出现）；用户删除只是隐藏视图，再保存即恢复
        try {
            const response = await fetch('/api/assets');
            const data = await response.json();
            const hidden = localStorage.getItem(AssetLibrary.BUILTIN_HIDDEN_KEY) === '1';
            if (data.status === 'ok' && data.exists && !hidden) {
                this.tags = [AssetLibrary.BUILTIN_TAG, ...this.tags];
            }
        } catch { /* 后端不可用时不显示内置标签 */ }
        // 上一次选中的标签已被删除时清空选中状态
        if (this.activeTag && !this.tags.some((t) => t.name === this.activeTag)) {
            this.activeTag = null;
        }
        this.renderTagBar();
        await this.loadAssets();
    }

    /**
     * 同步标签下拉框：全部标签作为选项，当前选中项带对勾标记；
     * 无选中时显示占位文案。删除按钮仅在选中标签时可用
     */
    renderTagBar() {
        this.tagDropdown.setOptions(
            [{ value: '', label: '-- 选择标签 --' }]
                .concat(this.tags.map((t) => ({
                    value: t.name,
                    label: t.builtin ? t.label : t.name
                }))),
            this.activeTag || ''
        );
        this.tagDelBtn.disabled = !this.activeTag;
    }

    /**
     * 新建标签：直接弹出系统文件夹选择框（与上传按钮的体验一致），
     * 标签名自动取文件夹名，重名自动追加序号
     */
    async createTag() {
        await this.pickFolder(async (picked) => {
            // 注意：name 必须用 let 声明在 if/else 外——若在块内 const，
            // 外面的 this.activeTag = name 会静默解析到全局 window.name（""）
            let name;
            if (picked.handle) {
                name = this._uniqueTagName(picked.handle.name || '本地文件夹');
                await this.store.saveTag(name, picked.handle);
            } else {
                name = this._uniqueTagName(picked.folderName || '本地文件夹');
                this._sessionFiles = this._sessionFiles || new Map();
                this._sessionFiles.set(name, picked.files);
                await this.store.saveTag(name, null);
            }
            this.activeTag = name;
            await this.refreshTags();
        });
    }

    /**
     * 生成不与现有标签重名的名字（重名自动追加序号）
     * @param {string} base - 基础名
     * @returns {string} 唯一名
     */
    _uniqueTagName(base) {
        let name = base;
        let i = 2;
        while (this.tags.some((t) => t.name === name)) {
            name = `${base} ${i++}`;
        }
        return name;
    }

    /**
     * 弹出文件夹选择（双通道 + 自动降级）：
     *   1. 优先 File System Access API——句柄可持久化，刷新后授权即恢复；
     *   2. 调用失败（内嵌环境不弹窗、API 缺失等）自动降级为传统
     *      webkitdirectory 选择框——文件列表仅本会话有效；
     *   3. 任一通道成功后记忆，后续固定走该通道。
     * 取消与环境失败的区分：两者都抛 AbortError，但真实对话框需要
     * 用户操作（耗时 > 300ms），环境失败是立即抛错——按耗时判定，
     * 用户取消时锁定通道并直接结束，绝不连弹第二个框
     * @param {Function} onPicked - 选择完成回调：
     *   ({handle}) => void 或 ({folderName, files}) => void
     */
    async pickFolder(onPicked) {
        const channel = this._pickerChannel ||
            (window.showDirectoryPicker ? 'fsa' : 'input');

        if (channel === 'fsa') {
            const startedAt = performance.now();
            try {
                const handle = await window.showDirectoryPicker({ mode: 'read' });
                this._pickerChannel = 'fsa';
                onPicked({ handle });
                return;
            } catch (err) {
                const elapsed = performance.now() - startedAt;
                if (err.name === 'AbortError' && elapsed > 300) {
                    // 对话框确实弹出了，用户主动取消：记住通道可用，
                    // 直接结束（不降级、不重弹）
                    this._pickerChannel = 'fsa';
                    return;
                }
                // 立即抛错（含 NotAllowedError 等）= 环境不支持弹窗 → 降级
                console.warn('showDirectoryPicker 不可用，降级为传统选择框:',
                    err?.name, err?.message);
            }
        }

        this._openFolderInput((folderName, files) => {
            this._pickerChannel = 'input';
            onPicked({ folderName, files });
        });
    }

    /**
     * 打开传统文件夹选择框（webkitdirectory），回调根文件夹名与
     * 根层级的文件列表（与 File System Access 扫描一样只取根层级）
     * @param {Function} onPicked - (folderName, files[]) => void
     */
    _openFolderInput(onPicked) {
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', () => {
            const all = Array.from(input.files || []);
            const rootNames = new Set(
                all.map((f) => (f.webkitRelativePath || f.name).split('/')[0])
            );
            const folderName = rootNames.size === 1 ? [...rootNames][0] : '';
            // 只保留根层级文件（webkitRelativePath 恰好两段：目录/文件名）
            const rootFiles = all.filter(
                (f) => (f.webkitRelativePath || '').split('/').length === 2
            );
            input.remove();
            onPicked(folderName, rootFiles);
        }, { once: true });
        input.click();
    }

    /**
     * 删除标签：先在窗口内显示确认（window.confirm 在部分内嵌环境被
     * 抑制，不可依赖）。仅删除绑定关系，不影响本地文件夹；
     * 内置标签「我的资产」特殊：删除只是 localStorage 隐藏视图，
     * 磁盘资产文件不动，再次「添加到资产」即恢复
     * @param {string} name - 标签名
     */
    async deleteTag(name) {
        const isBuiltin = name === AssetLibrary.BUILTIN_TAG.name;
        const tip = isBuiltin
            ? '仅隐藏该标签，已保存的资产文件不受影响<br>再次点击「添加到资产」即可恢复显示'
            : '仅删除绑定关系，不影响本地文件夹';
        this.bodyEl.innerHTML = `
            <div class="asset-library-permission">
                <div class="asset-library-permission-text">
                    确认删除标签「${LumenLight.escapeHtml(
                        isBuiltin ? AssetLibrary.BUILTIN_TAG.label : name
                    )}」？<br>
                    ${tip}
                </div>
                <div class="asset-library-confirm-row">
                    <button type="button" class="asset-library-confirm-btn danger" data-act="ok">删除</button>
                    <button type="button" class="asset-library-confirm-btn" data-act="cancel">取消</button>
                </div>
            </div>`;
        this.bodyEl.querySelector('[data-act="ok"]').addEventListener('click', async () => {
            if (isBuiltin) {
                localStorage.setItem(AssetLibrary.BUILTIN_HIDDEN_KEY, '1');
            } else {
                await this.store.deleteTag(name);
            }
            this._revokeGrid(name);            // 释放该标签网格与 blob URL
            this._sessionFiles?.delete(name);  // 会话文件列表一并清除
            if (this.activeTag === name) this.activeTag = null;
            await this.refreshTags();
        });
        this.bodyEl.querySelector('[data-act="cancel"]')
            .addEventListener('click', () => this.loadAssets());
    }

    async selectTag(name) {
        this.activeTag = name;
        this.renderTagBar();
        await this.loadAssets();
    }

    /** 删除当前选中标签（无选中时提示）；确认流程走 deleteTag 的内联确认 */
    async deleteCurrentTag() {
        if (!this.activeTag) {
            window.socket?.showNotification?.('没有选择标签，无法删除', 3000);
            return;
        }
        await this.deleteTag(this.activeTag);
    }

    // ==================== 资产加载与展示 ====================

    /** 释放指定标签网格持有的全部 blob URL 并移除其缓存 */
    _revokeGrid(tagName) {
        const cached = this._gridCache.get(tagName);
        if (!cached) return;
        cached.urls.forEach((u) => URL.revokeObjectURL(u));
        this._gridCache.delete(tagName);
    }

    /**
     * 扫描当前标签绑定的文件夹并渲染资产网格。
     * 权限回落（页面刷新后）时显示"点击授权"覆盖层——浏览器要求
     * 恢复句柄访问必须由用户手势触发，无法静默完成
     */
    /**
     * 加载当前标签的资产网格。
     * @param {boolean} [force] - 强制重建（跳过缓存）。
     *   默认优先复用缓存网格——窗口重开/切回标签瞬时显示，图片零重新加载
     */
    async loadAssets(force = false) {
        this.bodyEl.innerHTML = '';

        const tag = this.tags.find((t) => t.name === this.activeTag);
        if (!tag) {
            this.bodyEl.innerHTML =
                '<div class="asset-library-empty">请选择标签，或点击 + 新建标签</div>';
            return;
        }

        const cached = this._gridCache.get(tag.name);

        // 内置标签「我的资产」：文件列表走后端 /api/assets（data/assets/
        // 目录），不经 File System Access API——无授权环节，列表即磁盘内容
        if (tag.builtin) {
            if (cached && !force) {
                this.bodyEl.appendChild(cached.gridEl);
                this._fillVisibleCards();
                return;
            }
            if (cached) this._revokeGrid(tag.name);
            try {
                const response = await fetch('/api/assets');
                const data = await response.json();
                if (data.status !== 'ok') throw new Error(data.message || '列表失败');
                if (!data.exists || data.items.length === 0) {
                    this.bodyEl.innerHTML =
                        '<div class="asset-library-empty">还没有资产——选中画布图片后点「添加到资产」保存</div>';
                    return;
                }
                this._renderGrid(data.items.map((it) => AssetLibrary.makeBuiltinAsset(it)));
            } catch (err) {
                console.error('读取资产列表失败:', err);
                this.bodyEl.innerHTML =
                    '<div class="asset-library-empty">读取资产列表失败，请确认后端已启动</div>';
            }
            return;
        }

        // 缓存命中：直接复用已渲染的网格（瞬时，图片不重新加载）。
        // FSA 标签需权限仍有效；失效（如系统里撤销了权限）则删除缓存
        // 重建并显示授权覆盖层
        if (cached && !force) {
            if (tag.handle) {
                let permission = 'granted';
                try {
                    permission = await tag.handle.queryPermission({ mode: 'read' });
                } catch {
                    permission = 'denied';
                }
                if (permission !== 'granted') {
                    this._revokeGrid(tag.name);
                } else {
                    this.bodyEl.appendChild(cached.gridEl);
                    this._fillVisibleCards();
                    return;
                }
            } else {
                // 降级标签：文件列表存于会话，直接复用
                this.bodyEl.appendChild(cached.gridEl);
                this._fillVisibleCards();
                return;
            }
        } else if (cached) {
            this._revokeGrid(tag.name);
        }

        // 降级标签（无句柄）：优先用本会话的文件列表；没有则提示重新选择。
        // 浏览器无法持久化 File 对象，刷新后需要重新选一次文件夹
        if (!tag.handle) {
            const sessionFiles = this._sessionFiles?.get(tag.name);
            if (sessionFiles && sessionFiles.length > 0) {
                this._renderGrid(sessionFiles);
                return;
            }
            this._showRepickOverlay(tag.name);
            return;
        }

        // 权限检查与恢复。句柄失效导致 queryPermission 抛异常时保持
        // 'granted' 继续尝试扫描——扫描同样会失败，落入"读取文件夹失败"
        // 的错误提示，比直接弹授权层更能反映真实问题
        let permission = 'granted';
        try {
            permission = await tag.handle.queryPermission({ mode: 'read' });
        } catch { /* 句柄失效，交给下方扫描的错误分支提示 */ }
        if (permission !== 'granted') {
            const overlay = document.createElement('div');
            overlay.className = 'asset-library-permission';
            overlay.innerHTML =
                `<div class="asset-library-permission-text">访问「${LumenLight.escapeHtml(tag.name)}」需要重新授权</div>
                 <button type="button" class="asset-library-permission-btn">点击授权</button>`;
            overlay.querySelector('.asset-library-permission-btn')
                .addEventListener('click', async () => {
                    try {
                        const result = await tag.handle.requestPermission({ mode: 'read' });
                        if (result === 'granted') {
                            await this.loadAssets(true);
                        } else {
                            window.socket?.showNotification?.('未获得文件夹访问权限', 3000);
                        }
                    } catch (err) {
                        console.error('请求文件夹权限失败:', err);
                    }
                });
            this.bodyEl.appendChild(overlay);
            return;
        }

        // 扫描目录根层级的图片/视频文件（不递归子文件夹）
        const files = [];
        try {
            for await (const [name, entry] of tag.handle.entries()) {
                if (entry.kind !== 'file') continue;
                const file = await entry.getFile();
                if (CanvasVideoManager.isVideoFile(file) || AssetLibrary.isImageFile(file)) {
                    files.push(file);
                }
            }
        } catch (err) {
            console.error('读取文件夹失败:', err);
            this.bodyEl.innerHTML =
                '<div class="asset-library-empty">读取文件夹失败，请确认文件夹仍存在，或删除标签后重新添加</div>';
            return;
        }
        this._renderGrid(files);
    }

    /**
     * 后台静默重扫当前标签绑定的目录（toggle 打开窗口后调用）：
     * 文件名列表与缓存一致时什么都不做（用户无感知）；
     * 有增删时重建该标签的网格（外部改动得以实时反映）。
     * 仅对 FSA 标签有意义——降级标签的文件列表存于内存，不会外部变化
     */
    async _backgroundRefresh() {
        const tag = this.tags.find((t) => t.name === this.activeTag);
        const cached = this._gridCache.get(this.activeTag);
        if (!tag?.handle || !cached) return;
        try {
            if (await tag.handle.queryPermission({ mode: 'read' }) !== 'granted') return;
            const names = [];
            for await (const [name, entry] of tag.handle.entries()) {
                if (entry.kind !== 'file') continue;
                const file = await entry.getFile();
                if (CanvasVideoManager.isVideoFile(file) || AssetLibrary.isImageFile(file)) {
                    names.push(file.name);
                }
            }
            names.sort();
            const cachedNames = cached.files.map((f) => f.name).sort();
            if (names.join('\u0000') !== cachedNames.join('\u0000')) {
                this._revokeGrid(tag.name);
                if (this.el.classList.contains('show') && this.activeTag === tag.name) {
                    await this.loadAssets();
                }
            }
        } catch (err) {
            console.warn('后台刷新资产列表失败:', err);
        }
    }

    /**
     * 降级标签的重新选择覆盖层：点击弹出传统文件夹选择框
     * @param {string} name - 标签名
     */
    _showRepickOverlay(name) {
        const overlay = document.createElement('div');
        overlay.className = 'asset-library-permission';
        overlay.innerHTML =
            `<div class="asset-library-permission-text">「${LumenLight.escapeHtml(name)}」的文件夹绑定仅本会话有效<br>请重新选择文件夹</div>
             <button type="button" class="asset-library-permission-btn">选择文件夹</button>`;
        overlay.querySelector('.asset-library-permission-btn')
            .addEventListener('click', () => {
                this.pickFolder(async (picked) => {
                    if (picked.handle) {
                        // 真实 Chrome 环境重选可直接升级为持久句柄
                        await this.store.saveTag(name, picked.handle);
                    } else {
                        this._sessionFiles = this._sessionFiles || new Map();
                        this._sessionFiles.set(name, picked.files);
                    }
                    this._revokeGrid(name);  // 文件夹已更换，旧网格作废
                    await this.loadAssets();
                });
            });
        this.bodyEl.appendChild(overlay);
    }

    /**
     * 渲染资产网格：过滤图片/视频、按名称排序、懒加载缩略图
     * @param {File[]} files - 文件列表
     */
    _renderGrid(files) {
        const assetFiles = files.filter(
            (f) => CanvasVideoManager.isVideoFile(f) || AssetLibrary.isImageFile(f)
        );
        assetFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

        // 旧缓存（若有）作废：新网格将持有全新的 blob URL
        this._revokeGrid(this.activeTag);
        this._activeUrls = [];

        if (assetFiles.length === 0) {
            this.bodyEl.innerHTML = '<div class="asset-library-empty">该文件夹内没有图片或视频</div>';
            return;
        }

        const grid = document.createElement('div');
        grid.className = 'asset-library-grid';
        for (const file of assetFiles) {
            grid.appendChild(this._makeCard(file));
        }
        this.bodyEl.appendChild(grid);

        // 登记缓存：重开窗口/切回标签时瞬时复用（图片零重新加载）
        this._gridCache.set(this.activeTag, {
            gridEl: grid,
            files: assetFiles,
            urls: this._activeUrls
        });

        // 懒加载：渲染时先填可视区内的卡片，滚动时补填（rAF 节流）。
        // 不用 IntersectionObserver——部分内嵌/隐藏环境不触发回调
        this._fillVisibleCards();
        if (!this._scrollHandler) {
            this._scrollHandler = () => {
                if (this._scrollRaf) return;
                this._scrollRaf = requestAnimationFrame(() => {
                    this._scrollRaf = null;
                    this._fillVisibleCards();
                });
            };
            this.bodyEl.addEventListener('scroll', this._scrollHandler, { passive: true });
        }
    }

    /**
     * 填充可视区内（含上下 200px 预载区）尚未加载缩略图的卡片
     */
    _fillVisibleCards() {
        const bodyRect = this.bodyEl.getBoundingClientRect();
        for (const card of this.bodyEl.querySelectorAll('.asset-card')) {
            const thumb = card.querySelector('.asset-card-thumb');
            if (!thumb || thumb.dataset.loaded) continue;
            const r = card.getBoundingClientRect();
            if (r.bottom < bodyRect.top - 200 || r.top > bodyRect.bottom + 200) continue;
            this._fillThumbnail(card);
        }
    }

    /**
     * 生成资产卡片：可拖拽（携带真实 File）、双击灯箱预览
     * @param {File} file - 目录内的文件
     * @returns {HTMLElement} 卡片元素
     */
    _makeCard(file) {
        const isVideo = CanvasVideoManager.isVideoFile(file);
        const card = document.createElement('div');
        card.className = 'asset-card';
        card.draggable = true;
        card.title = file.name + '（拖拽到画布，双击预览）';
        card.dataset.fileName = file.name;
        card.dataset.kind = isVideo ? 'video' : 'image';
        card._file = file;

        // 缩略图占位：懒加载就绪后由 _fillThumbnail 填充
        const thumb = document.createElement('div');
        thumb.className = 'asset-card-thumb' + (isVideo ? ' is-video' : '');
        thumb.innerHTML = isVideo
            ? '<span class="asset-card-play">▶</span>'
            : '<span class="asset-card-loading">…</span>';
        card.appendChild(thumb);

        const label = document.createElement('div');
        label.className = 'asset-card-name';
        label.textContent = file.name;
        card.appendChild(label);

        // 拖拽到画布：Chrome 禁止把 File 写入拖拽数据流（items.add(file)
        // 静默失败），改用自定义类型标记 + 实例登记 _dragFile，画布侧
        // drop 监听按标记取回文件（见 init）。不可 setData('text/plain')
        // ——画布 drop 处理器视其为页面内元素拖拽而忽略
        card.addEventListener('dragstart', (e) => {
            if (typeof file.getFile === 'function') {
                // 内置资产：File 需异步从后端拉取；drop 晚于 dragstart，
                // 拉取完成前落点会被忽略（handleCanvasDrop 有空值保护）
                file.getFile().then((f) => { this._dragFile = f; }).catch((err) => {
                    console.error('拉取资产文件失败:', err);
                });
            } else {
                this._dragFile = file;
            }
            e.dataTransfer.setData('application/x-lumen-asset', '1');
            e.dataTransfer.effectAllowed = 'copy';
        });
        card.addEventListener('dragend', () => { this._dragFile = null; });

        // 双击打开灯箱预览大图/视频。单击无操作——进入画布只走拖拽
        card.addEventListener('dblclick', () => this.openPreview(file));
        return card;
    }

    /** 懒加载填充缩略图（卡片进入可视区时调用） */
    _fillThumbnail(card) {
        const file = card._file;
        const thumb = card.querySelector('.asset-card-thumb');
        if (!file || !thumb || thumb.dataset.loaded) return;
        thumb.dataset.loaded = '1';

        // 内置资产：后端静态 URL 直连（http URL 不需要 revoke）；
        // 本地 File：blob URL，登记到当前网格缓存统一释放
        let url;
        if (file.url) {
            url = file.url;
        } else {
            url = URL.createObjectURL(file);
            this._activeUrls.push(url);
        }

        if (thumb.classList.contains('is-video')) {
            // 视频缩略图：#t=0.1 媒体片段让浏览器定位并显示首帧
            const video = document.createElement('video');
            video.className = 'asset-card-video-thumb';
            video.muted = true;
            video.preload = 'metadata';
            video.src = url + '#t=0.1';
            video.addEventListener('loadeddata', () => {
                const play = thumb.querySelector('.asset-card-play');
                if (play) play.classList.add('show-bg');
            }, { once: true });
            thumb.insertBefore(video, thumb.firstChild);
        } else {
            thumb.innerHTML = '';
            const img = document.createElement('img');
            img.className = 'asset-card-img';
            img.src = url;
            img.alt = file.name;
            thumb.appendChild(img);
        }
    }

    /**
     * 画布 drop 接收（init 注册的监听调用）：把拖拽的资产文件
     * 添加到画布落点——图片以落点为左上角，视频以落点为中心
     * @param {number} vx - 视口坐标 X（相对画布元素左上角）
     * @param {number} vy - 视口坐标 Y
     */
    async handleCanvasDrop(vx, vy) {
        const file = this._dragFile;
        if (!file) return;
        const c = window.canvas;
        try {
            if (CanvasVideoManager.isVideoFile(file)) {
                const p = c.viewport.screenToCanvas(vx, vy);
                await c.videoManager.addVideoFile(file, { centerX: p.x, centerY: p.y });
            } else {
                await c.images.add(file, vx, vy, c.viewport, 0);
            }
            c.draw();
            window.socket?.showNotification?.('已添加到画布');
        } catch (err) {
            console.error('拖放资产到画布失败:', err);
            window.socket?.showNotification?.('添加失败：' + err.message, 4000);
        }
    }

    /**
     * 「添加到资产」保存成功后由图片工具栏调用：清除内置标签的隐藏
     * 标记并刷新——窗口开着时「我的资产」立即出现/更新；未开窗口则
     * 下次打开生效
     */
    async onAssetsSaved() {
        localStorage.removeItem(AssetLibrary.BUILTIN_HIDDEN_KEY);
        this._revokeGrid(AssetLibrary.BUILTIN_TAG.name);
        if (!this.el.classList.contains('show')) return;
        await this.refreshTags();
    }

    /**
     * 双击资产：打开灯箱预览（图片直显大图，视频用带控件播放器）。
     * 灯箱优先复用聊天窗口的实例，聊天未初始化时自建一个
     * @param {File} file - 资产文件
     */
    openPreview(file) {
        const lightbox = window.llmChat?.lightbox ||
            (this._lightbox = this._lightbox || new LlmLightbox());
        // 内置资产直连后端 URL；本地 File 走 blob URL 并登记到当前网格
        // 缓存，网格重建时随统一 revoke 释放；灯箱为全屏模态，展示期间
        // 不可能触发网格刷新，URL 不会提前失效
        let url;
        if (file.url) {
            url = file.url;
        } else {
            url = URL.createObjectURL(file);
            this._activeUrls.push(url);
        }
        lightbox.open(url, { video: CanvasVideoManager.isVideoFile(file) });
    }
}

// 图片扩展名兜底（File.type 为空时使用，与视频判断同策略）
AssetLibrary.isImageFile = function (file) {
    if (!file) return false;
    if ((file.type || '').startsWith('image/')) return true;
    return /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name || '');
};

// 内置标签「我的资产」：name 用哨兵值避免与用户自建的同名 FSA 标签
// 在下拉框里 value 冲突；label 才是显示名
AssetLibrary.BUILTIN_TAG = { name: '__builtin__', label: '我的资产', builtin: true };

// 内置标签隐藏标记（localStorage）：删除标签只是隐藏视图，保存资产即恢复
AssetLibrary.BUILTIN_HIDDEN_KEY = 'lumen-asset-builtin-hidden';

/**
 * 把 /api/assets 列表条目包装成资产卡片可用的"伪文件"对象：
 * name/type 供 isImageFile/isVideoFile 判断，url 直连后端静态读取
 * （缩略图与灯箱零 blob），getFile 惰性拉取真实 File（拖拽入画布时才下载）
 * @param {Object} item - 列表条目 { filename, name, size, savedAt, url }
 */
AssetLibrary.makeBuiltinAsset = function (item) {
    const ext = (((item.name || item.filename || '').match(/\.(\w+)$/i) || [])[1] || 'png').toLowerCase();
    const mimeMap = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp'
    };
    return {
        name: item.name || item.filename,
        type: mimeMap[ext] || 'image/png',
        url: item.url,
        savedAt: item.savedAt,
        getFile: async () => {
            const response = await fetch(item.url);
            if (!response.ok) throw new Error(`读取资产失败（HTTP ${response.status}）`);
            const blob = await response.blob();
            return new File([blob], item.name || item.filename,
                { type: blob.type || 'image/png' });
        }
    };
};

// 暴露到全局作用域
window.AssetLibrary = AssetLibrary;
