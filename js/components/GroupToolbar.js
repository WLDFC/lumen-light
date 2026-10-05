/**
 * ============================================================
 * LumenLight 编组选中工具栏组件
 * ============================================================
 * 用户选中画布编组（Group）时，在组上方显示浮动工具栏。
 * 骨架与显隐/定位模式完全照 ImageToolbar（监听选中事件、
 * 视口变化节流跟随、手势期间隐藏、点外部收起），样式复用
 * image-toolbar.css（.image-toolbar / .toolbar-btn / .toolbar-section），
 * 外加 .group-toolbar 标记类供未来编组专属样式。
 *
 * 为什么是独立文件而不是扩展 ImageToolbar：图片工具栏的全部按钮
 * 逻辑绑死图片语义（合成图源/放大/抠图/下载代理），编组按钮
 * （解组、整理成员等）与其无共通点；项目惯例一个组件一个文件。
 * 两个工具栏的解耦靠事件契约：
 *   - canvasGroupSelected  GroupManager 派发（detail.group = 选中组 | null）
 *   - canvasGroupDragStart/End  CanvasInteraction 在组拖动/缩放手势起止派发
 *
 * 当前置：左侧功能区有「标题栏颜色」「布局」两个下拉按钮，右侧功能区
 * 有「解组」按钮（破坏性动作独立分区），后续添加编组按钮照
 * ImageToolbar 的模式：createToolbar 模板加一段 HTML +
 * bindToolbarActions 加一段监听。
 * ============================================================
 */

class GroupToolbar {
    /**
     * 构造方法
     * @param {Object} canvas - 画布实例（读取 groups/viewport）
     */
    constructor(canvas) {
        this.canvas = canvas;
        this.toolbar = null;       // 工具栏根 DOM
        this.group = null;         // 当前选中的组（单选时）
        this.isVisible = false;
        this.updateThrottleTimer = null;   // 位置跟随的 rAF 节流定时器

        this.init();
    }

    /**
     * 初始化：创建工具栏 DOM 并绑定事件
     */
    init() {
        this.createToolbar();
        this.bindEvents();
    }

    /**
     * 创建工具栏 DOM 结构
     * 复用图片工具栏的样式类；分区留空待后续按钮填充
     */
    createToolbar() {
        this.toolbar = document.createElement('div');
        this.toolbar.className = 'image-toolbar group-toolbar';
        this.toolbar.style.display = 'none';

        this.toolbar.innerHTML = `
            <div class="image-toolbar-content">
                <!-- 左侧功能区：标题栏颜色下拉 + 布局下拉 -->
                <div class="toolbar-section left">
                    <button class="group-color-btn" title="标题栏颜色"></button>
                    <button class="group-layout-btn" title="排列组内成员"></button>
                </div>
                <!-- 中间功能区（预留） -->
                <div class="toolbar-section center"></div>
                <!-- 右侧功能区：解组（破坏性动作独立分区，图标 = 双叠方块 + 斜线） -->
                <div class="toolbar-section right">
                    <button class="group-ungroup-btn" title="解组（保留组内图片与节点）">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
                             stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="12" height="12" rx="2.5"/>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                            <line x1="4" y1="20" x2="20" y2="4"/>
                        </svg>
                        <span class="btn-text">解组</span>
                    </button>
                </div>
            </div>`;

        document.body.appendChild(this.toolbar);
        this.bindToolbarActions();
    }

    /**
     * 绑定工具栏按钮事件。
     * 标题栏颜色下拉：触发器是色块圆点 + 展开箭头（文案层由 CSS 隐藏，
     * 见 image-toolbar.css .group-color-btn），菜单项 = 圆形色块 + 色彩文字。
     * 颜色存组对象 color 字段（每组独立），经 GroupManager.setColor 落盘。
     * 每个监听照 ImageToolbar 惯例 stopPropagation——点击不应传给画布取消选中
     */
    bindToolbarActions() {
        // 选项由 GroupManager.COLOR_PRESETS 派生（标签/色值唯一出处），
        // 全部为实色圆 + 细白描边（深色菜单底上勾出轮廓）；无色的色块
        // 是通用灰（swatch 由预设表给出），表示"未着色"。
        // r=10 让圆撑满 24 格图标框（直径 ≈ 图标框 5/6），配 20px 框
        // 实际观感约 17px 直径，与 13px 菜单文字同量级偏大，色相一眼可辨
        this._colorOptions = Object.entries(GroupManager.COLOR_PRESETS).map(([value, preset]) => ({
            value,
            label: preset.label,
            icon: `<circle cx="12" cy="12" r="10" fill="${preset.swatch}" stroke="rgba(255,255,255,0.4)" stroke-width="1.2"/>`
        }));

        const colorBtn = this.toolbar.querySelector('.group-color-btn');
        this.colorDropdown = new LumenDropdown(colorBtn, {
            // 菜单附加类：色块比通用菜单图标大一档（见 image-toolbar.css）
            menuClass: 'group-color-menu',
            onChange: (value) => {
                if (!this.group) return;
                this.canvas.groups.setColor(this.group.id, value);
            }
        });
        this.colorDropdown.setOptions(this._colorOptions, '');

        this._bindLayoutDropdown();
        this._bindUngroupButton();
    }

    /**
     * 绑定「布局」下拉（动作型：菜单项是动作而非状态，选中即执行，
     * 触发器文案经 setLabel 恢复为"布局"）。排列算法在 GroupLayout
     * （纯函数），这里只负责取成员、应用坐标与组矩形重_fit 等副作用
     */
    _bindLayoutDropdown() {
        // Feather 风格线性图标：宫格/水平（横排三点）/垂直（竖排三点）
        this._layoutOptions = [
            {
                value: 'grid',
                label: '宫格布局',
                icon: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>'
            },
            {
                value: 'horizontal',
                label: '水平布局',
                icon: '<circle cx="5" cy="12" r="2.4"/><circle cx="12" cy="12" r="2.4"/><circle cx="19" cy="12" r="2.4"/>'
            },
            {
                value: 'vertical',
                label: '垂直布局',
                icon: '<circle cx="12" cy="5" r="2.4"/><circle cx="12" cy="12" r="2.4"/><circle cx="12" cy="19" r="2.4"/>'
            }
        ];

        const layoutBtn = this.toolbar.querySelector('.group-layout-btn');
        this.layoutDropdown = new LumenDropdown(layoutBtn, {
            actionMenu: true,   // 动作型：菜单不打对勾，选项随时可重复执行
            onChange: (mode) => {
                this.applyLayout(mode);
                // 动作型下拉：触发器文案保持动作名（setOptions 初始渲染
                // 会写成第一项的"宫格布局"，构造后与每次执行后都要复位）
                this.layoutDropdown.setLabel('布局');
            }
        });
        this.layoutDropdown.setOptions(this._layoutOptions, 'grid');
        this.layoutDropdown.setLabel('布局');
    }

    /**
     * 绑定「解组」按钮：立即删除组壳（图片/节点是独立对象原样保留，
     * 与 Delete 快捷键同语义、同样不可撤销——组壳重建成本低，不加确认框）。
     * select(null) 清选中并派发 canvasGroupSelected(null) → 工具栏经
     * 事件自动 hide；draw() 经 hook 被 CanvasChangeWatcher 捕获，
     * 实时保存自动落盘
     */
    _bindUngroupButton() {
        const ungroupBtn = this.toolbar.querySelector('.group-ungroup-btn');
        ungroupBtn.addEventListener('click', (e) => {
            e.stopPropagation();   // 点击不传给画布（避免被当作空白点击）
            if (!this.group) return;
            this.canvas.groups.delete(this.group.id);
            this.canvas.groups.select(null);
            this.canvas.draw();
        });
    }

    /**
     * 应用布局：成员按 GroupLayout 算法重排（只移动不缩放），组矩形
     * 重_fit 到内容包围盒 + 内边距（锚点 = 组左上角不动）。
     * 顶部内边距取 max(ENCLOSURE_PADDING, 标题栏高 + 40)——标题栏画在
     * 组矩形内部，留白不足时第一排成员会顶进标题栏。
     * draw() 经 hook 被 CanvasChangeWatcher 捕获，实时保存自动落盘
     * @param {string} mode - 'grid' | 'horizontal' | 'vertical'
     */
    applyLayout(mode) {
        if (!this.group) return;
        const group = this.group;
        const members = this.canvas.groups.getMembers(group);
        if (members.length === 0) return;

        const result = GroupLayout.arrange(mode, members);

        // 应用坐标：DOM 节点成员移动后同步 transform（与拖动组联动同款）
        const topPad = Math.max(
            GroupManager.ENCLOSURE_PADDING,
            GroupManager.getTitleMetrics(group).height + 40
        );
        const originX = group.x + GroupManager.ENCLOSURE_PADDING;
        const originY = group.y + topPad;
        for (const p of result.placements) {
            p.obj.x = originX + p.x;
            p.obj.y = originY + p.y;
            if (NodeTypes.isPanelNode(p.obj.source)) p.obj.updateTransform();
        }

        // 组矩形重_fit（锚点 = 左上角不动，仅改宽高）
        group.width = Math.max(
            result.width + GroupManager.ENCLOSURE_PADDING * 2,
            GroupManager.MIN_WIDTH
        );
        group.height = Math.max(
            result.height + topPad + GroupManager.ENCLOSURE_PADDING,
            GroupManager.MIN_HEIGHT
        );

        this.canvas.draw();
        // 组矩形变了，工具栏重新定位（元素可见，测量正常）
        this.updatePosition();
    }

    /**
     * 绑定各类事件监听器
     */
    bindEvents() {
        // 监听编组选中变化：仅单选组时显示（多选只支持整体拖动，无按钮可操作）
        window.addEventListener('canvasGroupSelected', (e) => {
            const group = e.detail.group;
            if (group && this.canvas.groups.selectedIds.size === 1) {
                this.show(group);
            } else {
                this.hide();
            }
        });

        // 选中图片/节点时隐藏：图片工具栏与编组工具栏不叠显
        // （选中组成员时用户操作的是成员，编组工具栏让位）
        window.addEventListener('canvasImageSelected', (e) => {
            if (e.detail.image) this.hide();
        });

        // 全局鼠标按下：点击工具栏之外的区域时隐藏。
        // 与 ImageToolbar 同逻辑——点画布且编组仍有选中时保持显示
        // （画布上的 mousedown 会先走选中/清选中流程，事件顺序上
        // document 监听后触发，此时 selectedIds 已是最新状态）。
        // 例外：各下拉菜单挂在 body（LumenDropdown 结构），点菜单
        // 选项不属于"点外部"——否则隐藏时 this.group 被清空，选项
        // click 里的动作（选色/布局）拿到 null 组直接失效
        document.addEventListener('mousedown', (e) => {
            const inDropdownMenu = [this.colorDropdown, this.layoutDropdown].some(dd => {
                return dd && dd.menuEl && dd.menuEl.contains(e.target);
            });
            if (this.isVisible && !this.toolbar.contains(e.target) && !inDropdownMenu) {
                const isCanvasClick = e.target.tagName === 'CANVAS';
                const hasSelectedGroup = this.canvas.groups.selectedIds.size > 0;
                if (!isCanvasClick || !hasSelectedGroup) {
                    this.hide();
                }
            }
        });

        // 窗口大小变化：重算位置（防抖，照 ImageToolbar 的 100ms）
        let resizeTimer = null;
        window.addEventListener('resize', () => {
            if (this.isVisible && this.group) {
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(() => this.updatePosition(), 100);
            }
        });

        // 视口缩放/平移：节流跟随（rAF 合帧，照 ImageToolbar）。
        // 展开中的下拉菜单在 rAF 内随工具栏一起重定位（不收起），
        // 与图片工具栏子菜单的跟随行为一致
        window.addEventListener('canvasViewportChanged', () => {
            if (this.isVisible && this.group) {
                this.throttledUpdatePosition();
            }
        });

        // 组拖动/缩放手势：期间隐藏避免视觉干扰，结束恢复
        window.addEventListener('canvasGroupDragStart', () => {
            if (this.isVisible) this.hideElements();
        });
        window.addEventListener('canvasGroupDragEnd', () => {
            if (this.group) this.showElements();
        });
    }

    /**
     * 节流更新位置（rAF 合帧）。
     * 工具栏就位后同步重定位展开中的下拉菜单——菜单 fixed 挂 body，
     * 触发器随视口移动而菜单不动会脱节；照图片工具栏子菜单的
     * reposition 惯例跟随（不收起），且必须排在工具栏移动之后
     * （菜单按触发器新位置计算，rAF 内同帧完成无滞后）
     */
    throttledUpdatePosition() {
        if (this.updateThrottleTimer) {
            cancelAnimationFrame(this.updateThrottleTimer);
        }
        this.updateThrottleTimer = requestAnimationFrame(() => {
            this.updatePosition();
            this._repositionDropdowns();
        });
    }

    /**
     * 显示工具栏
     * @param {Object} group - 选中的组对象
     */
    show(group) {
        this.group = group;
        this.isVisible = true;
        this.toolbar.style.display = 'block';
        // 下拉同步为该组当前颜色（各组独立，换组选中时跟随）
        this.colorDropdown.setOptions(this._colorOptions, group.color || '');
        this.updatePosition();
    }

    /**
     * 隐藏元素（手势期间用，保留选中状态）
     */
    hideElements() {
        this.toolbar.style.display = 'none';
    }

    /**
     * 恢复显示（手势结束用）。
     * 顺序必须先显示再定位（与 ImageToolbar.showElements 同序）：
     * display:none 时 offsetWidth/offsetHeight 测量为 0，先定位会落到
     * ||240 / ||40 兜底尺寸上——工具栏不居中、底边贴住组顶，要等下次
     * 视口变化重算才恢复。点标题栏选中组必经「DragStart 隐藏 →
     * DragEnd 恢复」回路，此顺序错误会在每次选中时复现
     */
    showElements() {
        this.toolbar.style.display = 'block';
        this.updatePosition();
    }

    /**
     * 完全隐藏并清空选中状态
     */
    hide() {
        this.isVisible = false;
        this.toolbar.style.display = 'none';
        // 展开中的下拉菜单一并收起（菜单挂 body，不收会残留）
        this._closeDropdowns();
        this.group = null;
        if (this.updateThrottleTimer) {
            cancelAnimationFrame(this.updateThrottleTimer);
            this.updateThrottleTimer = null;
        }
    }

    /**
     * 收起全部下拉菜单（hide 用）。
     * 视口变化走 reposition 跟随而非收起（见 throttledUpdatePosition）
     */
    _closeDropdowns() {
        if (this.colorDropdown) this.colorDropdown.close();
        if (this.layoutDropdown) this.layoutDropdown.close();
    }

    /**
     * 重定位展开中的下拉菜单（视口缩放/平移时由 rAF 帧调用，
     * 排在工具栏 updatePosition 之后——菜单按触发器新位置计算）。
     * 新增下拉按钮时把实例加进两个清单（本方法与 _closeDropdowns）即可
     */
    _repositionDropdowns() {
        if (this.colorDropdown) this.colorDropdown.reposition();
        if (this.layoutDropdown) this.layoutDropdown.reposition();
    }

    /**
     * 更新工具栏位置：优先放在组顶边上方（标题栏上沿之外），
     * 贴近屏幕顶部放不下时翻转到组底边下方。
     * 定位基准是组的矩形（非标题栏）——与图片工具栏以包围盒为基准一致
     */
    updatePosition() {
        if (!this.group || !this.canvas.viewport) return;

        const viewport = this.canvas.viewport;
        const canvasRect = this.canvas.canvas.getBoundingClientRect();

        const topLeft = viewport.canvasToScreen(this.group.x, this.group.y);
        const bottomRight = viewport.canvasToScreen(
            this.group.x + this.group.width,
            this.group.y + this.group.height
        );

        const screenX = canvasRect.left + topLeft.x;
        const screenY = canvasRect.top + topLeft.y;
        const displayWidth = bottomRight.x - topLeft.x;
        const displayHeight = bottomRight.y - topLeft.y;

        const toolbarHeight = this.toolbar.offsetHeight || 40;
        const toolbarSpacing = 12;   // 与组边缘的固定间距（比图片工具栏紧凑，组顶部有标题栏）

        // 上方放得下则放上方，否则翻到下方
        const toolbarTopAbove = screenY - toolbarHeight - toolbarSpacing;
        if (toolbarTopAbove >= 10) {
            this.toolbar.style.top = `${toolbarTopAbove}px`;
        } else {
            this.toolbar.style.top = `${screenY + displayHeight + toolbarSpacing}px`;
        }
        const toolbarWidth = this.toolbar.offsetWidth || 240;
        this.toolbar.style.left = `${screenX + (displayWidth - toolbarWidth) / 2}px`;
    }
}

// 将 GroupToolbar 类挂载到全局 window 对象
window.GroupToolbar = GroupToolbar;
