/**
 * 提示词收藏页面组件（RecipeManager）
 *
 * 作用：管理顶栏"提示词"按钮与全屏提示词收藏弹窗。
 * 用户在画布图片工具栏点击"保存提示词"后，收藏记录会写入后端 tag/ 目录，
 * 本组件负责读取并以瀑布流卡片形式展示，支持：
 *   1. 左侧模型标签栏（220px）：点击标签筛选右侧卡片列表，
 *      支持行内新建、删除标签；标签数据与保存弹窗共用（/api/tags/models）
 *   2. 点击卡片图片 -> 打开详情弹窗（TagDetailDialog）查看大图并编辑
 *                      名字 / 模型标签 / 提示词，保存后自动刷新列表
 *   3. 双击卡片名字 -> 原地行内重命名（回车提交 / Esc 取消 / 失焦提交）
 *   4. 点击右上角 × -> 直接删除该收藏（无确认框，同步清理磁盘文件）
 *   5. 点击 Copy   -> 仅复制正向提示词，按钮短暂变绿反馈
 *   6. 搜索栏左侧筛选排序下拉（LumenDropdown 图标按钮模式）：收藏先后
 *      （默认）/ 添加时间 新→旧（按收藏记录的 createdAt）/ 名称 A→Z，
 *      选择存 localStorage（key lumen.recipeSortMode）
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
        this.models = [];          // 模型标签清单（[{ id, name, createdAt }]）
        this.selectedModel = '';   // 当前筛选的模型名（空字符串 = 全部）
        this.searchKeyword = '';   // 当前搜索词（按名字模糊检索，与标签筛选叠加）
        // 排序策略（搜索框左侧漏斗下拉，localStorage 记忆上次选择）：
        // default=收藏先后（tags.json 原顺序）/ time-desc=添加时间 新→旧 /
        // name=名称 A→Z（收藏先后与旧→新等价，不设重复档）
        this.sortMode = localStorage.getItem('lumen.recipeSortMode') || 'default';
        this.isCreatingModel = false; // 新建标签请求进行中标记（防重复提交/误收起输入框）
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
                            <!-- 右侧控件组：筛选排序下拉 + 搜索栏（搜索按图片名字
                                 模糊检索，与左侧标签筛选叠加生效） -->
                            <div class="recipe-toolbar-right">
                                <button class="recipe-sort-btn" type="button" aria-label="排序"></button>
                                <div class="recipe-search-box">
                                    <svg class="recipe-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                                    <input class="recipe-search-input" type="text" placeholder="搜索图片名字…" aria-label="按名字搜索收藏">
                                </div>
                            </div>
                        </div>
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

        // 搜索栏：输入即过滤（名字模糊匹配，大小写不敏感），
        // 与左侧标签筛选叠加生效；清空关键词自动恢复完整列表
        const searchInput = this.dialog.querySelector('.recipe-search-input');
        searchInput.addEventListener('input', () => {
            this.searchKeyword = searchInput.value.trim();
            this.render();
        });

        // 筛选排序下拉（LumenDropdown 图标按钮模式——提示词节点技能栏同款
        // 预制件：漏斗图标触发器，当前策略在菜单里打对勾，悬停可见全文；
        // 收藏页无置顶概念，选项比 LoRA 管理器少置顶两档）
        this.sortDropdown = new LumenDropdown(this.dialog.querySelector('.recipe-sort-btn'), {
            iconButton: true,
            triggerIcon: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
            onChange: v => {
                this.sortMode = v;
                localStorage.setItem('lumen.recipeSortMode', v);
                this.render();
            }
        });
        this.sortDropdown.setOptions([
            { value: 'default', label: '收藏先后（默认）' },
            { value: 'time-desc', label: '添加时间 新→旧' },
            { value: 'name', label: '名称 A→Z' }
        ], this.sortMode);
        // localStorage 里存了已废弃的值时归位到第一项（与下拉显示一致）
        this.sortMode = this.sortDropdown.value;

        document.body.appendChild(this.dialog);
    }

    /** 显示左侧栏的行内新建输入框；已在输入状态则聚焦 */
    showModelInput() {
        if (this.modelInput) { this.modelInput.focus(); return; }

        const list = this.dialog.querySelector('.recipe-models-list');
        this.modelInput = document.createElement('input');
        this.modelInput.className = 'recipe-models-input';
        this.modelInput.type = 'text';
        this.modelInput.maxLength = 40;
        this.modelInput.placeholder = '标签名，回车保存';

        // 回车提交；Esc 取消；失焦时若未提交则收起输入框。
        // isComposing 守卫：中文输入法组合期间的回车是"确认候选词"，
        // 不代表用户想提交，必须忽略，否则会拿半成品文本误建标签
        this.modelInput.addEventListener('keydown', async event => {
            if (event.isComposing) return;
            if (event.key === 'Enter') {
                event.preventDefault();
                await this.createModel();
            } else if (event.key === 'Escape') {
                this.removeModelInput();
            }
        });
        this.modelInput.addEventListener('blur', () => {
            // 提交请求进行中不收起输入框（避免请求期间被误移除导致状态错乱）
            if (this.modelInput && !this.isCreatingModel) this.removeModelInput();
        });

        list.appendChild(this.modelInput);
        this.modelInput.focus();
    }

    /** 收起行内输入框 */
    removeModelInput() {
        if (!this.modelInput) return;
        this.modelInput.remove();
        this.modelInput = null;
    }

    /** 提交新建的模型标签：成功后直接用响应数据刷新侧栏，失败提示且保留输入框 */
    async createModel() {
        if (!this.modelInput || this.isCreatingModel) return;
        const name = this.modelInput.value.trim();
        if (!name) { this.removeModelInput(); return; }

        this.isCreatingModel = true;   // 防重复提交，也阻止 blur 收起输入框
        try {
            const response = await fetch('/api/tags/models', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || '新建失败');

            // 直接用接口返回的完整记录追加到本地清单并重绘，
            // 不再依赖二次 GET 刷新（避免刷新请求失败导致"看不到新标签"）
            this.models.push(result.model);
            this.removeModelInput();
            this.renderModels();
            // 同步保存弹窗的标签选项
            window.saveTagDialog?.refreshModels?.(this.models.map(m => m.name));
        } catch (error) {
            alert(error.message);
            this.modelInput?.focus();
            this.modelInput?.select();
        } finally {
            this.isCreatingModel = false;
        }
    }

    /** 删除模型标签：只删标签本身，已有收藏的 model 字段不受影响 */
    async deleteModel(id) {
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
            if (window.saveTagDialog?.refreshModels) {
                window.saveTagDialog.refreshModels(this.models.map(m => m.name));
            }
        } catch (error) {
            console.error('读取模型标签失败:', error);
        }
    }

    /** 重绘左侧栏标签列表：全部 + 各模型标签（当前筛选项高亮） */
    renderModels() {
        const list = this.dialog.querySelector('.recipe-models-list');
        list.replaceChildren();
        if (this.modelInput) list.appendChild(this.modelInput); // 输入框保留在列表底部

        // "全部"项：selectedModel 为空字符串时选中
        list.appendChild(this.createModelItem({ id: '', name: '全部' }, true));

        for (const model of this.models) {
            list.appendChild(this.createModelItem(model, false));
        }
    }

    /**
     * 创建单个标签条目：主体点击切换筛选，右侧小 × 删除标签
     * @param {object} model - { id, name }；id 为空字符串表示"全部"
     * @param {boolean} isAll - 是否为"全部"项（无删除按钮）
     */
    createModelItem(model, isAll) {
        const item = document.createElement('div');
        item.className = 'recipe-models-item';
        item.setAttribute('role', 'option');
        const active = isAll ? !this.selectedModel : this.selectedModel === model.name;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-selected', String(active));

        const label = document.createElement('button');
        label.className = 'recipe-models-label';
        label.type = 'button';
        label.textContent = model.name;
        label.title = model.name;
        // 点击标签：同项再点一次取消筛选（回到全部）
        label.addEventListener('click', () => {
            this.selectedModel = active ? '' : (isAll ? '' : model.name);
            this.renderModels();
            this.render();
        });
        item.appendChild(label);

        // "全部"项没有删除按钮
        if (!isAll) {
            const removeBtn = document.createElement('button');
            removeBtn.className = 'recipe-models-remove-btn';
            removeBtn.type = 'button';
            removeBtn.textContent = '×';
            removeBtn.title = '删除标签';
            removeBtn.setAttribute('aria-label', `删除标签 ${model.name}`);
            removeBtn.addEventListener('click', event => {
                event.stopPropagation();
                this.deleteModel(model.id);
            });
            item.appendChild(removeBtn);
        }
        return item;
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

    /** 清空网格后按筛选条件与搜索词重建卡片；无匹配时显示占位提示 */
    render() {
        const grid = this.dialog.querySelector('.recipe-grid');
        const empty = this.dialog.querySelector('.recipe-empty-state');
        // 先按左侧栏选中的模型筛选（空字符串 = 全部），
        // 再叠加搜索词的名字模糊匹配（大小写不敏感）
        let visibleTags = this.selectedModel
            ? this.tags.filter(tag => tag.model === this.selectedModel)
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

        // 同步顶部当前标签名：空筛选显示"全部"
        this.dialog.querySelector('.recipe-current-model').textContent =
            this.selectedModel || '全部';
    }

    /**
     * 创建单张收藏卡片
     * 结构：图片（点击看原图）+ 左上角模型角标 + 右上角删除按钮
     *       + 底部信息栏（左侧 2/3 显示名字，右侧 Copy 按钮）
     * @param {object} tag - 收藏记录（含 id、name、model、prompt、imageUrl、width、height 等）
     * @returns {HTMLElement} article.recipe-card
     */
    createCard(tag) {
        const card = document.createElement('article');
        card.className = 'recipe-card';

        // 图片：使用原图地址保持真实比例；宽高已知时预设比例，避免加载时布局跳动
        const image = document.createElement('img');
        image.src = tag.imageUrl;
        image.alt = tag.prompt;
        image.loading = 'lazy';
        if (tag.width > 0 && tag.height > 0) {
            image.style.aspectRatio = `${tag.width} / ${tag.height}`;
        }
        // 点击卡片图片打开详情弹窗：左侧看大图，右侧编辑名字/模型/提示词
        image.addEventListener('click', () => this.detailDialog.open(tag));

        // 模型角标：保存时选择了模型才显示（旧收藏无 model 字段则不显示）
        let modelBadge = null;
        if (tag.model) {
            modelBadge = document.createElement('span');
            modelBadge.className = 'recipe-model-badge';
            modelBadge.textContent = tag.model;
        }

        // 删除按钮：点击直接删除（无确认框），请求期间禁用防止重复提交
        const removeButton = document.createElement('button');
        removeButton.className = 'recipe-remove-btn';
        removeButton.type = 'button';
        removeButton.title = '删除提示词收藏';
        removeButton.setAttribute('aria-label', '删除提示词收藏');
        removeButton.textContent = '×';
        removeButton.addEventListener('click', async event => {
            event.stopPropagation(); // 阻止冒泡触发图片点击
            removeButton.disabled = true;
            const response = await fetch(`/api/tags/${encodeURIComponent(tag.id)}`, { method: 'DELETE' });
            if (!response.ok) {
                removeButton.disabled = false; // 失败时恢复按钮，允许重试
                return;
            }
            await this.loadTags(); // 删除成功后重新拉取并渲染
        });

        // 底部信息栏：左侧 2/3 显示用户保存时填写的名字，右侧放 Copy 按钮
        const infoBar = document.createElement('div');
        infoBar.className = 'recipe-card-info';

        const nameLabel = document.createElement('span');
        nameLabel.className = 'recipe-card-name';
        // 名字超长时省略号截断，悬停显示完整内容
        nameLabel.textContent = tag.name || '无题';
        nameLabel.title = tag.name || '无题';
        // 双击名字原地进入编辑（类似桌面重命名），空名保存时后端回退"无题"
        nameLabel.addEventListener('dblclick', () => this.startRename(tag, nameLabel));

        // Copy 按钮：仅复制正向提示词（不含负向词），成功后变绿 1.2 秒反馈
        const copyButton = document.createElement('button');
        copyButton.className = 'recipe-copy-btn';
        copyButton.type = 'button';
        copyButton.textContent = 'Copy';
        copyButton.title = '复制正面提示词';
        copyButton.addEventListener('click', async () => {
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
            card.append(image, modelBadge, removeButton, infoBar);
        } else {
            card.append(image, removeButton, infoBar);
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

    /** 关闭弹窗：收起新建输入框、隐藏弹窗、焦点还给顶栏按钮 */
    close() {
        this.removeModelInput();   // 避免输入框残留到下次打开
        this.dialog.classList.remove('is-open');
        this.dialog.setAttribute('aria-hidden', 'true');
        this.triggerButton.setAttribute('aria-expanded', 'false');
        this.triggerButton.focus();
    }
}
