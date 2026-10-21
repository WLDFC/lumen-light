/**
 * 提示词收藏页面组件（RecipeManager）
 *
 * 作用：管理顶栏"提示词"按钮与全屏提示词收藏弹窗。
 * 用户在画布图片工具栏点击"保存提示词"后，收藏记录会写入后端 tag/ 目录，
 * 本组件负责读取并以瀑布流卡片形式展示，支持：
 *   1. 左侧模型标签栏（220px）：点击标签筛选右侧卡片列表——选中父标签时
 *      其全部子标签的收藏一并纳入；支持行内新建根级/子级标签（最多 3 级）
 *      与父标签折叠展开（折叠记忆存 localStorage）；标签数据与保存弹窗
 *      共用（/api/tags/models）
 *   2. 点击卡片图片 -> 打开详情弹窗（TagDetailDialog）查看大图并编辑
 *                      名字 / 模型标签 / 提示词，保存后自动刷新列表
 *   3. 双击卡片名字 -> 原地行内重命名（回车提交 / Esc 取消 / 失焦提交）
 *   4. 右键卡片 -> 「移动到…/打开所在文件夹/删除」菜单（LumenContextMenu
 *      预制件；打开所在文件夹仅非批量单卡显示，资源管理器选中图片文件、
 *      同名 .txt 提示词就在旁边）：非批量
 *      模式对单张生效；批量模式对全部所选生效（资源管理器惯例：右键
 *      未选中的卡片=只选中它）；批量删除（≥2 张）先经 LumenConfirmDialog
 *      确认，删除同步清理磁盘文件
 *   5. 点击 Copy   -> 仅复制正向提示词，按钮短暂变绿反馈
 *   6. 搜索栏左侧筛选排序下拉（LumenDropdown 文本模式 + staticIcon 固定
 *      漏斗图标，触发器「筛选」文案与批量钮一样常驻——LoRA 管理器
 *      图标+文字钮同款）：收藏先后（默认）/ 添加时间 新→旧（按收藏记录
 *      的 createdAt）/ 名称 A→Z，选择存 localStorage（key lumen.recipeSortMode）
 *   7. 批量按钮（排序旁，「批量」文字钮，LumenBatchManager 预制件）->
 *      批量管理模式：
 *      点击卡片多选（右上角绿色✓角标，替代原红色×删除钮），配套批量条
 *      （已选计数/全选/取消选择/完成）；Esc 逐层退出（右键菜单→弹窗→
 *      批量模式）。移动 = 把收藏的 model 改写为目标标签（单标签归属，
 *      与保存弹窗单选一致，复用 PUT /api/tags/:id，零后端改动）
 *
 * 侧栏标签树与折叠由 LumenTreeList 预制件渲染（折叠记忆 key
 * lumen.recipeCollapsedModelTags），本类只提供行内容与增删交互。
 *
 * 数据来源：GET /api/tags            读取收藏列表
 *           GET /api/tags/models     读取模型标签清单
 * 删除接口：DELETE /api/tags/:id     删除指定收藏
 *           DELETE /api/tags/models/:id  删除模型标签（不影响已有收藏）
 * 更新接口：PUT /api/tags/:id        详情弹窗保存编辑时调用
 * 保存入口：画布图片工具栏"保存提示词"按钮（ImageToolbar.js），
 *           保存成功后会派发全局事件 promptTagSaved，本组件监听后自动刷新。
 *
 * 配套文件：
 *   css/recipe-manager.css          # 弹窗与卡片样式
 *   css/recipe-models-sidebar.css   # 左侧模型标签栏样式
 *   routes/tags.js                  # 后端收藏与模型标签接口
 *   index.html / js/app.js          # 脚本引入与实例化（window.recipeManager）
 */
class RecipeManager {
    constructor() {
        this.triggerButton = null; // 顶栏"提示词"按钮元素
        this.dialog = null;        // 全屏弹窗根元素
        this.tags = [];            // 当前已加载的收藏列表
        this.models = [];          // 模型标签清单（[{ id, name, parentId?, createdAt }]，
                                   //  parentId 缺省 = 顶层标签，最多 3 级）
        this.selectedModel = '';   // 当前筛选的模型名（空字符串 = 全部）
        this.searchKeyword = '';   // 当前搜索词（按名字模糊检索，与标签筛选叠加）
        // 排序策略（搜索框左侧漏斗下拉，localStorage 记忆上次选择）：
        // default=收藏先后（tags.json 原顺序）/ time-desc=添加时间 新→旧 /
        // name=名称 A→Z（收藏先后与旧→新等价，不设重复档）
        this.sortMode = localStorage.getItem('lumen.recipeSortMode') || 'default';
        this.isCreatingModel = false; // 新建标签请求进行中标记（防重复提交/误收起输入框）
        // 折叠记忆与树形渲染交给 LumenTreeList 预制件（createDialog 里建）
        // 行内新建输入框的目标父标签 id（null = 根级新建，顶部 ＋ 触发）
        this.modelInputParentId = null;
        // ===== 批量管理（LumenBatchManager / LumenContextMenu /
        // LumenConfirmDialog 预制件在 createDialog 里实例化） =====
        this.visibleTagIds = [];   // 当前筛选可见的收藏 id（批量条"全选"用）
        this.movePicker = null;    // 移动目标选择弹窗（宿主自有壳，懒建）
        this.moveTree = null;      // 移动选择框里的标签树（LumenTreeList）
        this._moveIds = [];        // 正在移动的收藏 id
        this.init();
    }

    /** 初始化：创建顶栏按钮、弹窗结构，并监听全局保存事件 */
    init() {
        const toolbarCenter = document.getElementById('topToolbarCenter');
        if (!toolbarCenter) return;

        // 创建顶栏居中的"提示词"按钮（书本图标 + 文字）
        this.triggerButton = document.createElement('button');
        this.triggerButton.className = 'top-toolbar-btn recipe-trigger-btn';
        this.triggerButton.type = 'button';
        this.triggerButton.title = '打开提示词收藏';
        this.triggerButton.setAttribute('aria-haspopup', 'dialog');
        this.triggerButton.setAttribute('aria-expanded', 'false');
        this.triggerButton.innerHTML = `
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M2 4h6a4 4 0 0 1 4 4v12H2z"></path>
                <path d="M22 4h-6a4 4 0 0 0-4 4v12h10z"></path>
            </svg>
            <span>提示词</span>
        `;
        this.triggerButton.addEventListener('click', () => this.open());
        toolbarCenter.appendChild(this.triggerButton);

        this.createDialog();

        // 详情弹窗：点击卡片图片时打开，保存成功后刷新列表；
        // 参考图即时增删后把最新记录就地合并进缓存列表（保持对象引用，
        // 否则再次打开弹窗时卡片闭包传入的还是旧数据，槽位会显示为空）
        this.detailDialog = new TagDetailDialog({
            onSaved: () => this.loadTags(),
            onTagUpdated: updatedTag => this.syncTag(updatedTag)
        });

        // 画布工具栏保存成功后会派发 promptTagSaved，自动刷新列表
        window.addEventListener('promptTagSaved', () => this.loadTags());
    }

    /** 创建全屏弹窗的 DOM 结构（默认隐藏），并绑定关闭事件 */
    createDialog() {
        this.dialog = document.createElement('div');
        this.dialog.className = 'recipe-dialog';
        // 无障碍语义：对话框 / 模态 / 由标题元素描述
        this.dialog.setAttribute('role', 'dialog');
        this.dialog.setAttribute('aria-modal', 'true');
        this.dialog.setAttribute('aria-labelledby', 'recipeDialogTitle');
        this.dialog.setAttribute('aria-hidden', 'true');
        this.dialog.innerHTML = `
            <section class="recipe-dialog-panel">
                <header class="recipe-dialog-header">
                    <div class="recipe-dialog-title-group">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h6a4 4 0 0 1 4 4v12H2z"></path><path d="M22 4h-6a4 4 0 0 0-4 4v12h10z"></path></svg>
                        <h2 id="recipeDialogTitle">提示词</h2>
                    </div>
                    <button class="recipe-dialog-close" type="button" title="关闭提示词" aria-label="关闭提示词窗口"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
                </header>
                <main class="recipe-dialog-content">
                    <!-- 左侧模型标签栏：点击筛选卡片，支持新建/删除标签 -->
                    <aside class="recipe-models-sidebar" aria-label="模型标签筛选">
                        <header class="recipe-models-header">
                            <span class="recipe-models-title">模型</span>
                            <button class="recipe-models-add-btn" type="button" title="新建模型标签" aria-label="新建模型标签">＋</button>
                        </header>
                        <nav class="recipe-models-list" role="listbox" aria-label="模型标签列表"></nav>
                    </aside>
                    <!-- 右侧卡片区：顶部标签名 + 搜索栏 + 瀑布流 + 空状态提示 -->
                    <div class="recipe-cards-area">
                        <div class="recipe-toolbar">
                            <h3 class="recipe-current-model" aria-live="polite">全部</h3>
                            <!-- 右侧控件组：批量按钮 + 筛选排序下拉 + 搜索栏（搜索按
                                 图片名字模糊检索，与左侧标签筛选叠加生效） -->
                            <div class="recipe-toolbar-right">
                                <button class="lumen-batch-btn recipe-batch-btn" type="button" title="批量管理：多选后右键移动/删除" aria-label="批量管理">
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"></rect><path d="m8.5 12 2.5 2.5 5-5"></path></svg>
                                    <span>批量</span>
                                </button>
                                <button class="recipe-sort-btn" type="button" aria-label="排序"></button>
                                <div class="recipe-search-box">
                                    <svg class="recipe-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                                    <input class="recipe-search-input" type="text" placeholder="搜索图片名字…" aria-label="按名字搜索收藏">
                                </div>
                            </div>
                        </div>
                        <!-- 批量条槽位：LumenBatchManager 预制件把批量条插这里 -->
                        <div class="recipe-batch-bar-slot"></div>
                        <div class="recipe-grid" aria-label="提示词图片列表"></div>
                        <div class="recipe-empty-state"><p>暂无收藏的提示词</p></div>
                    </div>
                </main>
            </section>
        `;

        // 关闭按钮 / 点击遮罩空白处均可关闭
        this.dialog.querySelector('.recipe-dialog-close').addEventListener('click', () => this.close());
        this.dialog.addEventListener('click', event => {
            if (event.target === this.dialog) this.close();
        });

        // 新建模型标签：显示行内输入框，回车提交 / Esc 或失焦取消
        this.dialog.querySelector('.recipe-models-add-btn').addEventListener('click', () => this.showModelInput());

        // ===== 批量管理 / 右键菜单 / 确认弹窗（Lumen 预制件） =====
        this.batch = new LumenBatchManager({
            trigger: this.dialog.querySelector('.lumen-batch-btn'),
            barContainer: this.dialog.querySelector('.recipe-batch-bar-slot'),
            gridEl: this.dialog.querySelector('.recipe-grid'),
            getVisibleIds: () => this.visibleTagIds,
            onChange: () => this.updateBatchSelection()
        });
        this.ctxMenu = new LumenContextMenu({ container: this.dialog });
        this.confirmDialog = new LumenConfirmDialog({ container: this.dialog });
        // 侧栏标签树：折叠记忆沿用旧 key，升级后用户已折叠的标签不丢
        this.tagTree = new LumenTreeList({
            container: document.createElement('div'),
            collapsedKey: 'lumen.recipeCollapsedModelTags',
            buildRows: (row, node, depth) => this.buildTagRow(row, node, depth)
        });

        // Esc 逐层退出：右键菜单 → 移动选择框 → 确认弹窗 → 批量模式。
        // 菜单与确认弹窗自身也监听 Esc，这里 isOpen 先判负责"只退一层"
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            if (this.ctxMenu.isOpen) { this.ctxMenu.close(); return; }
            if (this.movePicker?.classList.contains('is-open')) { this.closeMovePicker(); return; }
            if (this.confirmDialog.isOpen) return;   // 预制件自关
            if (this.batch.isOpen) this.batch.exit();
        });

        // 搜索栏：输入即过滤（名字模糊匹配，大小写不敏感），
        // 与左侧标签筛选叠加生效；清空关键词自动恢复完整列表
        const searchInput = this.dialog.querySelector('.recipe-search-input');
        searchInput.addEventListener('input', () => {
            this.searchKeyword = searchInput.value.trim();
            this.render();
        });

        // 筛选排序下拉（LumenDropdown 文本模式 + staticIcon 固定漏斗图标——
        // 触发器「图标+筛选」静态文案与批量钮同款常驻，当前策略在菜单里
        // 打对勾、悬停触发器可见全文；收藏页无置顶概念，选项比 LoRA
        // 管理器少置顶两档）
        this.sortDropdown = new LumenDropdown(this.dialog.querySelector('.recipe-sort-btn'), {
            triggerIcon: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
            staticIcon: true,
            onChange: v => {
                this.sortMode = v;
                localStorage.setItem('lumen.recipeSortMode', v);
                this.render();
                this.sortDropdown.setLabel('筛选');   // 文案固定为「筛选」，不随选中项变（动作型同款）
            }
        });
        this.sortDropdown.setOptions([
            { value: 'default', label: '收藏先后（默认）' },
            { value: 'time-desc', label: '添加时间 新→旧' },
            { value: 'name', label: '名称 A→Z' }
        ], this.sortMode);
        // 初次同步后固定触发器文案（否则显示当前选项全文），与批量钮文案常驻一致
        this.sortDropdown.setLabel('筛选');
        // localStorage 里存了已废弃的值时归位到第一项（与下拉显示一致）
        this.sortMode = this.sortDropdown.value;

        document.body.appendChild(this.dialog);
    }

    /**
     * 显示行内新建输入框；parentId 传父标签 id 时作为其子级插入（并自动
     * 展开该父标签），不传则为根级（列表底部）。已在输入状态则只聚焦。
     */
    showModelInput(parentId = null) {
        if (this.modelInput) {
            // 已开的输入框指向同一目标：只聚焦；目标不同（如先点了顶部
            // ＋又点了某标签的＋）：收起旧的按新目标重开——只聚焦会让
            // 用户对着根级输入框打出子标签名，建出来却是顶层标签
            if (this.modelInputParentId === (parentId || null)) {
                this.modelInput.focus();
                return;
            }
            this.removeModelInput();
        }

        const input = document.createElement('input');
        this.modelInput = input;
        this.modelInputParentId = parentId || null;
        input.className = 'recipe-models-input';
        input.type = 'text';
        input.maxLength = 40;
        input.placeholder = parentId ? '子标签名，回车保存' : '标签名，回车保存';

        // 回车提交；Esc 取消；失焦时若未提交则收起输入框。
        // isComposing 守卫：中文输入法组合期间的回车是"确认候选词"，
        // 不代表用户想提交，必须忽略，否则会拿半成品文本误建标签。
        // blur 走 setTimeout：renderModels 会把输入框摘下再插回（子级输入框
        // 插在树中间），这一程序性失焦不算取消——焦点回到输入框就保留
        input.addEventListener('keydown', async event => {
            if (event.isComposing) return;
            if (event.key === 'Enter') {
                event.preventDefault();
                await this.createModel();
            } else if (event.key === 'Escape') {
                this.removeModelInput();
            }
        });
        input.addEventListener('blur', () => {
            window.setTimeout(() => {
                if (document.activeElement === this.modelInput) return;
                if (this.modelInput && !this.isCreatingModel) this.removeModelInput();
            }, 0);
        });

        if (parentId && !this.tagTree.isOpen(parentId)) this.tagTree.expand(parentId); // 输入框要插进子级，先展开
        this.renderModels();
        this.modelInput.focus();
    }

    /** 收起行内输入框（子级输入框插在树中间，收起需重绘摘除） */
    removeModelInput() {
        if (!this.modelInput) return;
        this.modelInput.remove();
        this.modelInput = null;
        const wasChild = this.modelInputParentId;
        this.modelInputParentId = null;
        if (wasChild) this.renderModels();
    }

    /**
     * 输入框按所在层级缩进（根级贴底通栏，子级随深度右移、宽度折减），
     * 返回输入框自身便于 renderModels 里 appendChild
     */
    styleModelInput(depth) {
        const indent = depth * 18;
        this.modelInput.classList.toggle('is-child', depth > 0);
        this.modelInput.style.marginLeft = depth > 0 ? `${indent}px` : '';
        this.modelInput.style.width = depth > 0 ? `calc(100% - ${indent}px)` : '';
        return this.modelInput;
    }

    /** 提交新建的标签（根级或子级）：成功后直接用响应数据刷新侧栏，失败提示且保留输入框 */
    async createModel() {
        if (!this.modelInput || this.isCreatingModel) return;
        const name = this.modelInput.value.trim();
        const parentId = this.modelInputParentId; // 先取：removeModelInput 会重置
        if (!name) { this.removeModelInput(); return; }

        this.isCreatingModel = true;   // 防重复提交，也阻止 blur 收起输入框
        try {
            const response = await fetch('/api/tags/models', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, parentId })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || '新建失败');

            // 直接用接口返回的完整记录追加到本地清单并重绘，
            // 不再依赖二次 GET 刷新（避免刷新请求失败导致"看不到新标签"）
            this.models.push(result.model);
            this.removeModelInput();
            this.renderModels();
            this.syncSaveDialogModels();
        } catch (error) {
            alert(error.message);
            this.modelInput?.focus();
            this.modelInput?.select();
        } finally {
            this.isCreatingModel = false;
        }
    }

    /**
     * 删除模型标签：先弹确认框防误删（标签×是一击触发，误碰代价高），
     * 有子标签时提示将上移一级（后端不级联删除）；已有收藏的 model
     * 字段不受影响，卡片角标照常显示
     */
    async deleteModel(id) {
        const target = this.models.find(m => m.id === id);
        if (!target) return;
        const childCount = this.models.filter(m => m.parentId === id).length;
        const ok = await this.showConfirm(
            `删除标签「${target.name}」？`,
            childCount > 0
                ? `其 ${childCount} 个子标签将上移一级；已收藏图片的标签角标保留不受影响`
                : '已收藏图片的标签角标保留，不受影响'
        );
        if (!ok) return;

        try {
            const response = await fetch(`/api/tags/models/${encodeURIComponent(id)}`, { method: 'DELETE' });
            if (!response.ok) {
                const result = await response.json().catch(() => ({}));
                throw new Error(result.message || '删除失败');
            }
            // 若删除的是当前筛选中的标签，重置筛选为"全部"
            if (this.selectedModel) {
                const deleted = this.models.find(m => m.id === id);
                if (deleted && deleted.name === this.selectedModel) this.selectedModel = '';
            }
            await this.loadModels();
            this.render();
        } catch (error) {
            alert(error.message);
        }
    }

    /** 从后端拉取模型标签清单并重绘左侧栏；成功后同步保存弹窗的选项 */
    async loadModels() {
        try {
            const response = await fetch('/api/tags/models');
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || '读取失败');
            this.models = result.models;
            this.renderModels();

            // 保存弹窗的模型标签选项与侧栏共用同一份清单
            this.syncSaveDialogModels();
        } catch (error) {
            console.error('读取模型标签失败:', error);
        }
    }

    /** 把标签清单按树的先序（父在前、子紧随其后）同步给保存弹窗的选项 */
    syncSaveDialogModels() {
        if (!window.saveTagDialog?.refreshModels) return;
        const { roots, childrenMap } = this.buildModelTree();
        const names = [];
        const walk = models => {
            for (const model of models) {
                names.push(model.name);
                walk(childrenMap.get(model.id) || []);
            }
        };
        walk(roots);
        window.saveTagDialog.refreshModels(names);
    }

    /** 读取标签层级（根 = 0，沿 parentId 上溯；断链/成环按已到顶处理） */
    getModelDepth(model) {
        let depth = 0;
        let current = model;
        const seen = new Set([model?.id]);
        while (current?.parentId) {
            if (seen.has(current.parentId)) break;
            const parent = this.models.find(m => m.id === current.parentId);
            if (!parent) break;
            seen.add(parent.id);
            current = parent;
            depth += 1;
        }
        return depth;
    }

    /**
     * 把扁平标签清单装配成树：roots 顶层标签、childrenMap 父 id → 子标签数组
     * （数组序即 createdAt 序，与原有顶层排序一致）。父引用断链（父标签
     * 已被删等）按顶层兜底；成环脏数据从任何根都不可达，DFS 后仍未归位的
     * 也并回顶层，保证一个不丢。
     */
    buildModelTree() {
        const byId = new Map(this.models.map(m => [m.id, m]));
        const childrenMap = new Map();
        const roots = [];
        for (const model of this.models) {
            const parent = model.parentId ? byId.get(model.parentId) : null;
            if (parent) {
                if (!childrenMap.has(model.parentId)) childrenMap.set(model.parentId, []);
                childrenMap.get(model.parentId).push(model);
            } else {
                roots.push(model);
            }
        }
        const reachable = new Set();
        const walk = id => {
            reachable.add(id);
            for (const child of childrenMap.get(id) || []) walk(child.id);
        };
        for (const root of roots) walk(root.id);
        for (const model of this.models) {
            if (!reachable.has(model.id)) roots.push(model);
        }
        return { roots, childrenMap };
    }

    /** 重绘左侧栏标签列表：全部 + LumenTreeList 树（子标签缩进、可折叠） */
    renderModels() {
        const list = this.dialog.querySelector('.recipe-models-list');
        list.replaceChildren(
            this.createModelItem({ id: '', name: '全部' }, true),
            this.tagTree.container
        );
        this.tagTree.setNodes(this.models.map(m => ({ id: m.id, name: m.name, parentId: m.parentId || null })));
        this.tagTree.render();

        // 行内输入框定位：根级贴底；子级插在目标父标签行后（第一个子位置），
        // 缩进随父级深度 +1
        if (!this.modelInput) return;
        if (!this.modelInputParentId) {
            list.appendChild(this.styleModelInput(0));
            return;
        }
        const row = this.tagTree.container.querySelector(`[data-node-id="${CSS.escape(this.modelInputParentId)}"]`);
        if (!row) { list.appendChild(this.styleModelInput(0)); return; }
        const parent = this.models.find(m => m.id === this.modelInputParentId);
        row.after(this.styleModelInput(this.getModelDepth(parent) + 1));
    }

    /**
     * 创建"全部"条目（树外特殊项，无操作钮）：主体点击清除筛选
     * @param {object} model - { id: '', name: '全部' }
     */
    createModelItem(model) {
        const item = document.createElement('div');
        item.className = 'recipe-models-item';
        item.setAttribute('role', 'option');
        const active = !this.selectedModel;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-selected', String(active));

        const label = document.createElement('button');
        label.className = 'recipe-models-label';
        label.type = 'button';
        label.textContent = model.name;
        label.title = model.name;
        label.addEventListener('click', () => {
            this.selectedModel = '';
            this.renderModels();
            this.render();
        });
        item.appendChild(label);
        return item;
    }

    /**
     * LumenTreeList 行内容：标签主体（点击切换筛选）+ 悬停操作钮
     * （＋新建子标签 / ×删除标签）；行上叠加 recipe-models-item 样式类
     * 复用侧栏配色（行几何与折叠箭头由预制件的 lumen-tree-* 提供）
     * @param {HTMLElement} row - 树行（已带 lumen-tree-item / is-depth-N）
     * @param {object} node - { id, name }
     * @param {number} depth - 层级深度（0 根级；深度 2 = 第 3 级，不可再建子级）
     */
    buildTagRow(row, node, depth) {
        row.classList.add('recipe-models-item');
        const active = this.selectedModel === node.name;
        row.classList.toggle('is-active', active);
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(active));

        const label = document.createElement('button');
        label.className = 'recipe-models-label';
        label.type = 'button';
        label.textContent = node.name;
        label.title = node.name;
        // 点击标签：同项再点一次取消筛选（回到全部）
        label.addEventListener('click', () => {
            this.selectedModel = active ? '' : node.name;
            this.renderModels();
            this.render();
        });
        row.appendChild(label);

        // ＋新建子标签：悬停淡入，最多 3 级（深度 2 封顶）
        if (depth < 2) {
            const addChildBtn = document.createElement('button');
            addChildBtn.className = 'recipe-models-child-btn';
            addChildBtn.type = 'button';
            addChildBtn.textContent = '＋';
            addChildBtn.title = '新建子标签';
            addChildBtn.setAttribute('aria-label', `在标签 ${node.name} 下新建子标签`);
            addChildBtn.addEventListener('click', event => {
                event.stopPropagation();
                this.showModelInput(node.id);
            });
            row.appendChild(addChildBtn);
        }

        const removeBtn = document.createElement('button');
        removeBtn.className = 'recipe-models-remove-btn';
        removeBtn.type = 'button';
        removeBtn.textContent = '×';
        removeBtn.title = '删除标签';
        removeBtn.setAttribute('aria-label', `删除标签 ${node.name}`);
        removeBtn.addEventListener('click', event => {
            event.stopPropagation();
            this.deleteModel(node.id);
        });
        row.appendChild(removeBtn);
    }

    /** 同步所有卡片的选择态（批量条计数由 LumenBatchManager 维护） */
    updateBatchSelection() {
        const grid = this.dialog.querySelector('.recipe-grid');
        for (const card of grid.querySelectorAll('.recipe-card')) {
            card.classList.toggle('is-selected', this.batch.isSelected(card.dataset.id));
        }
    }

    /**
     * 卡片右键菜单（LumenContextMenu 预制件）：批量模式针对全部所选，
     * 非批量针对单张。移动/确认弹窗开着时不响应（避免菜单叠在弹窗上层）。
     */
    openCardMenu(event, tag) {
        if (this.movePicker?.classList.contains('is-open') || this.confirmDialog.isOpen) {
            event.preventDefault();
            return;
        }
        if (this.batch.isOpen && !this.batch.isSelected(tag.id)) {
            // 资源管理器惯例：右键未选中的卡片时，选择收拢为它
            this.batch.clearSelection();
            this.batch.toggleOne(tag.id);
        }
        const ids = this.batch.isOpen ? this.batch.getIds() : [tag.id];
        if (!ids.length) return;

        this.ctxMenu.open({
            x: event.clientX,
            y: event.clientY,
            items: [
                {
                    label: `移动到…${ids.length > 1 ? `（所选 ${ids.length} 张）` : ''}`,
                    onClick: () => this.showMovePicker(ids)
                },
                // 打开所在文件夹仅对单卡有意义（资源管理器只定位一个文件），
                // 批量模式不显示；选中图片的同时，同名 .txt 提示词就在旁边
                ...(this.batch.isOpen ? [] : [{
                    label: '打开所在文件夹',
                    onClick: () => this.revealCard(tag.id)
                }]),
                {
                    label: ids.length > 1 ? `删除所选（${ids.length} 张）` : '删除',
                    danger: true,
                    onClick: () => this.deleteCards(ids)
                }
            ]
        });
    }

    /** 打开所在文件夹（右键菜单入口）：后端资源管理器定位到图片文件 */
    async revealCard(id) {
        try {
            const r = await fetch('/api/tags/reveal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            }).then(r => r.json());
            if (r.status !== 'ok') throw new Error(r.message || '打开失败');
        } catch (error) {
            console.error('打开所在文件夹失败:', error);
            alert(error.message);
        }
    }

    /** 删除收藏（右键菜单入口）：≥2 张先弹确认框；完成后重拉列表 */
    async deleteCards(ids) {
        if (ids.length > 1) {
            const ok = await this.showConfirm(
                `删除所选的 ${ids.length} 张收藏？`,
                '删除会同时清理图片与提示词，不可恢复'
            );
            if (!ok) return;
        }
        const results = await Promise.allSettled(ids.map(id =>
            fetch(`/api/tags/${encodeURIComponent(id)}`, { method: 'DELETE' })
        ));
        const failed = results.filter(r => r.status === 'rejected' || !r.value.ok).length;
        if (failed) alert(`${failed} 张删除失败，请重试`);
        this.batch.clearSelection();
        await this.loadTags();
    }

    /** 移动目标选择弹窗：LumenTreeList 渲染标签树（展开态），点击即应用 */
    showMovePicker(ids) {
        const picker = this.ensureMovePicker();
        picker.querySelector('.recipe-move-title').textContent = `移动 ${ids.length} 张收藏到：`;
        const list = picker.querySelector('.recipe-move-list');
        list.classList.remove('is-busy');
        if (!this.moveTree) {
            this.moveTree = new LumenTreeList({
                container: list,
                // 无 collapsedKey = 不显示折叠箭头、始终展开（选择场景）
                buildRows: (row, node) => {
                    const item = document.createElement('button');
                    item.type = 'button';
                    item.className = 'recipe-move-item';
                    item.textContent = node.name;
                    item.title = node.name;
                    item.addEventListener('click', () => this.applyMove(this._moveIds, node.name));
                    row.appendChild(item);
                }
            });
        }
        this._moveIds = ids;
        this.moveTree.setNodes(this.models.map(m => ({ id: m.id, name: m.name, parentId: m.parentId || null })));
        this.moveTree.render();
        if (!this.models.length) {
            const empty = document.createElement('p');
            empty.className = 'recipe-move-empty';
            empty.textContent = '还没有任何标签，先在左侧栏新建';
            list.appendChild(empty);
        }
        picker.classList.add('is-open');
    }

    /** 懒建移动选择弹窗（遮罩 + 标签树列表 + 取消） */
    ensureMovePicker() {
        if (this.movePicker) return this.movePicker;
        const picker = document.createElement('div');
        picker.className = 'recipe-batch-overlay';
        picker.innerHTML = `
            <div class="recipe-move-panel" role="dialog" aria-label="移动到标签">
                <h4 class="recipe-move-title">移动到标签</h4>
                <div class="recipe-move-list"></div>
                <div class="recipe-batch-actions">
                    <button type="button" class="recipe-btn" data-act="cancel">取消</button>
                </div>
            </div>`;
        picker.addEventListener('click', event => {
            if (event.target === picker) this.closeMovePicker();
        });
        picker.querySelector('[data-act="cancel"]').addEventListener('click', () => this.closeMovePicker());
        this.dialog.appendChild(picker);
        this.movePicker = picker;
        return picker;
    }

    closeMovePicker() {
        if (this.movePicker?.classList.contains('is-open')) this.movePicker.classList.remove('is-open');
    }

    /** 应用移动：把所选收藏的 model 改写为目标标签名（已是该标签的跳过） */
    async applyMove(ids, name) {
        const list = this.movePicker.querySelector('.recipe-move-list');
        const targets = this.tags.filter(t => ids.includes(t.id) && t.model !== name);
        if (!targets.length) { this.closeMovePicker(); return; }
        list.classList.add('is-busy');  // 应用中禁列表防连点
        const results = await Promise.allSettled(targets.map(tag =>
            fetch(`/api/tags/${encodeURIComponent(tag.id)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: name })
            })
        ));
        const failed = results.filter(r => r.status === 'rejected' || !r.value.ok).length;
        this.closeMovePicker();
        if (failed) alert(`${failed} 张移动失败，请重试`);
        await this.loadTags();
        this.updateBatchSelection();
    }

    /** 批量删除确认（LumenConfirmDialog 预制件包装）：Promise<true=确认> */
    showConfirm(title, note) {
        return this.confirmDialog.confirm({ title, note, okText: '删除' });
    }

    /** 从后端拉取收藏列表并重新渲染；失败时仅打印日志不弹窗 */
    async loadTags() {
        try {
            const response = await fetch('/api/tags');
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || '读取失败');
            this.tags = result.tags;
            this.render();
        } catch (error) {
            console.error('读取提示词收藏失败:', error);
        }
    }

    /**
     * 把服务端返回的最新记录就地合并进缓存的收藏列表（详情弹窗参考图
     * 即时增删后调用）。用 Object.assign 改原有对象而非替换数组元素，
     * 因为卡片的点击闭包持有的是同一个对象引用——替换元素会导致闭包
     * 仍指向旧数据，再次打开详情弹窗时参考图槽位显示为空。
     * @param {object} updatedTag - 服务端返回的完整收藏记录
     */
    syncTag(updatedTag) {
        const existing = this.tags?.find(tag => tag.id === updatedTag.id);
        if (existing) Object.assign(existing, updatedTag);
    }

    /**
     * 双击名字进入原地行内编辑：名字替换为输入框（自动全选），
     * 回车提交、Esc 取消、失焦提交（输入法组合中的回车忽略）
     * 提交调用 PUT /api/tags/:id 仅更新 name 字段，成功后就地更新文字
     * @param {object} tag - 该卡片对应的收藏记录（成功后同步改其 name 字段）
     * @param {HTMLElement} nameLabel - 名字展示元素（输入框替换它，结束后恢复）
     */
    startRename(tag, nameLabel) {
        // 已在编辑状态（输入框存在）则忽略
        if (nameLabel.previousElementSibling?.classList?.contains('recipe-card-name-input')) return;

        const input = document.createElement('input');
        input.className = 'recipe-card-name-input';
        input.type = 'text';
        input.maxLength = 40;
        input.value = nameLabel.textContent;
        input.placeholder = '无题';

        let done = false;       // 编辑已结束（提交或取消）
        let committing = false; // 提交请求进行中（防止回车 + 失焦重复发请求）

        /** 恢复名字展示（可选地用新名字） */
        const finish = newName => {
            if (done) return;
            done = true;
            input.remove();
            if (newName !== undefined) {
                nameLabel.textContent = newName;
                nameLabel.title = newName;
            }
        };

        /** 提交改名：成功后更新本地记录与界面文字，失败恢复原名 */
        const commit = async () => {
            if (done || committing) return;
            const name = input.value.trim();
            // 名字没变化或为空都不发请求（空名回退展示"无题"）
            if (name === nameLabel.textContent || !name) { finish(); return; }

            committing = true;
            try {
                const response = await fetch(`/api/tags/${encodeURIComponent(tag.id)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name })
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message || '重命名失败');
                tag.name = result.tag.name;        // 后端空名会回退"无题"
                finish(tag.name);
            } catch (error) {
                finish();
                alert(error.message);
            }
        };

        input.addEventListener('keydown', event => {
            if (event.isComposing) return; // 输入法组合中的按键忽略
            if (event.key === 'Enter') {
                event.preventDefault();
                commit();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                finish(); // 取消：恢复原名
            }
        });
        input.addEventListener('blur', () => {
            // Esc 已恢复则跳过；否则失焦视为确认提交
            if (input.isConnected) commit();
        });

        nameLabel.before(input);
        input.focus();
        input.select();
    }

    /**
     * 当前筛选命中的标签名集合：选中父标签时包含其全部后代——父标签
     * 筛选 = 自身与子孙标签的收藏一起看。未筛选（"全部"）返回 null。
     */
    getSelectedModelNames() {
        if (!this.selectedModel) return null;
        const target = this.models.find(m => m.name === this.selectedModel);
        if (!target) return new Set([this.selectedModel]); // 标签刚被删等极端情况
        const { childrenMap } = this.buildModelTree();
        const names = new Set([target.name]);
        const walk = id => {
            for (const child of childrenMap.get(id) || []) {
                names.add(child.name);
                walk(child.id);
            }
        };
        walk(target.id);
        return names;
    }

    /** 清空网格后按筛选条件与搜索词重建卡片；无匹配时显示占位提示 */
    render() {
        const grid = this.dialog.querySelector('.recipe-grid');
        const empty = this.dialog.querySelector('.recipe-empty-state');
        // 先按左侧栏选中的模型筛选（选中父标签时子标签收藏一并纳入；
        // 空字符串 = 全部），再叠加搜索词的名字模糊匹配（大小写不敏感）
        const selectedNames = this.getSelectedModelNames();
        let visibleTags = selectedNames
            ? this.tags.filter(tag => selectedNames.has(tag.model))
            : this.tags;
        if (this.searchKeyword) {
            const keyword = this.searchKeyword.toLowerCase();
            visibleTags = visibleTags.filter(tag =>
                (tag.name || '').toLowerCase().includes(keyword)
            );
        }
        // 排序（漏斗下拉选择）：default=收藏先后（tags.json 原顺序，
        // 即旧→新）；time-desc=按收藏记录的 createdAt 新→旧；name=名称
        visibleTags = [...visibleTags];
        if (this.sortMode === 'time-desc') {
            visibleTags.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        } else if (this.sortMode === 'name') {
            visibleTags.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        }
        grid.replaceChildren();
        empty.style.display = visibleTags.length ? 'none' : 'flex';
        // 筛选无结果时给出更具体的提示文案
        empty.querySelector('p').textContent = this.searchKeyword
            ? `没有名字包含「${this.searchKeyword}」的收藏`
            : this.selectedModel
                ? `没有模型为「${this.selectedModel}」的收藏`
                : '暂无收藏的提示词';
        for (const tag of visibleTags) grid.appendChild(this.createCard(tag));

        // 批量模式：记录当前筛选的可见集合（批量条"全选"的作用范围），
        // 并同步卡片选择态与计数（重绘后 createCard 已带 is-selected）
        this.visibleTagIds = visibleTags.map(t => t.id);
        this.updateBatchSelection();

        // 同步顶部当前标签名：空筛选显示"全部"
        this.dialog.querySelector('.recipe-current-model').textContent =
            this.selectedModel || '全部';
    }

    /**
     * 创建单张收藏卡片
     * 结构：图片（点击看原图，批量模式整卡点击=多选）+ 左上角模型角标
     *       + 右上角选择圈（批量模式显示，选中变绿✓）+ 右键菜单
     *       + 底部信息栏（左侧 2/3 显示名字，右侧 Copy 按钮）
     * 原"悬停红色×删除"已移除——删除/移动统一走右键菜单
     * @param {object} tag - 收藏记录（含 id、name、model、prompt、imageUrl、width、height 等）
     * @returns {HTMLElement} article.recipe-card
     */
    createCard(tag) {
        const card = document.createElement('article');
        card.className = 'recipe-card';
        card.dataset.id = tag.id;
        if (this.batch.isSelected(tag.id)) card.classList.add('is-selected');

        // 批量模式：整卡点击切换选中（普通模式整卡无点击行为）
        card.addEventListener('click', () => {
            if (this.batch.isOpen) this.batch.toggleOne(tag.id);
        });
        // 右键菜单：删除/移动（非批量=单张，批量=全部所选）
        card.addEventListener('contextmenu', event => {
            event.preventDefault();
            this.openCardMenu(event, tag);
        });

        // 图片：使用原图地址保持真实比例；宽高已知时预设比例，避免加载时布局跳动
        const image = document.createElement('img');
        image.src = tag.imageUrl;
        image.alt = tag.prompt;
        image.loading = 'lazy';
        if (tag.width > 0 && tag.height > 0) {
            image.style.aspectRatio = `${tag.width} / ${tag.height}`;
        }
        // 点击卡片图片打开详情弹窗：左侧看大图，右侧编辑名字/模型/提示词
        // 批量模式不打开（详情交给整卡点击多选，气泡冒泡触发切换）
        image.addEventListener('click', () => {
            if (!this.batch.isOpen) this.detailDialog.open(tag);
        });

        // 选择圈：批量模式显示空圈占位（提示可多选），选中后变绿打白勾
        const check = LumenBatchManager.createCheckBadge();

        // 模型角标：保存时选择了模型才显示（旧收藏无 model 字段则不显示）
        let modelBadge = null;
        if (tag.model) {
            modelBadge = document.createElement('span');
            modelBadge.className = 'recipe-model-badge';
            modelBadge.textContent = tag.model;
        }

        // 底部信息栏：左侧 2/3 显示用户保存时填写的名字，右侧放 Copy 按钮
        const infoBar = document.createElement('div');
        infoBar.className = 'recipe-card-info';

        const nameLabel = document.createElement('span');
        nameLabel.className = 'recipe-card-name';
        // 名字超长时省略号截断，悬停显示完整内容
        nameLabel.textContent = tag.name || '无题';
        nameLabel.title = tag.name || '无题';
        // 双击名字原地进入编辑（类似桌面重命名），空名保存时后端回退"无题"；
        // 批量模式禁用（点击语义已让位给多选）
        nameLabel.addEventListener('dblclick', () => {
            if (!this.batch.isOpen) this.startRename(tag, nameLabel);
        });

        // Copy 按钮：仅复制正向提示词（不含负向词），成功后变绿 1.2 秒反馈；
        // 阻止冒泡——批量模式点 Copy 不应连带切换选中
        const copyButton = document.createElement('button');
        copyButton.className = 'recipe-copy-btn';
        copyButton.type = 'button';
        copyButton.textContent = 'Copy';
        copyButton.title = '复制正面提示词';
        copyButton.addEventListener('click', async event => {
            event.stopPropagation();
            try {
                await navigator.clipboard.writeText(tag.prompt || '');
                copyButton.textContent = 'Copied';
                copyButton.classList.add('is-copied');
                window.setTimeout(() => {
                    copyButton.textContent = 'Copy';
                    copyButton.classList.remove('is-copied');
                }, 1200);
            } catch (error) {
                console.error('复制提示词失败:', error);
            }
        });

        infoBar.append(nameLabel, copyButton);

        if (modelBadge) {
            card.append(image, modelBadge, check, infoBar);
        } else {
            card.append(image, check, infoBar);
        }
        return card;
    }

    /** 打开弹窗：显示弹窗、拉取最新数据（收藏 + 模型标签）、焦点移到关闭按钮 */
    open() {
        this.dialog.classList.add('is-open');
        this.dialog.setAttribute('aria-hidden', 'false');
        this.triggerButton.setAttribute('aria-expanded', 'true');
        this.loadTags();
        this.loadModels();
        this.dialog.querySelector('.recipe-dialog-close').focus();
    }

    /** 关闭弹窗：收起新建输入框、退出批量模式、关菜单与弹窗、焦点还给顶栏按钮 */
    close() {
        this.removeModelInput();   // 避免输入框残留到下次打开
        this.ctxMenu.close();
        this.closeMovePicker();
        this.confirmDialog.cancel();
        this.batch.exit();            // 退出批量模式并清空选择
        this.dialog.classList.remove('is-open');
        this.dialog.setAttribute('aria-hidden', 'true');
        this.triggerButton.setAttribute('aria-expanded', 'false');
        this.triggerButton.focus();
    }
}
