/**
 * ==========================================================================
 * LumenLight 任务中心窗口（TaskCenter）
 * ==========================================================================
 * 作用：左侧工具栏的列表图标按钮弹出窗口，本地资产库同款非模态形态
 *       （fixed 贴顶栏、宽 320、矮版 max-height 48vh 收缩不碍眼），
 *       直观展示当前任务序列与最近结算结果。纯视图：数据全部来自
 *       window.taskRegistry（各生成链路自行登记），本类不持有任务状态。
 *
 *   - 行内动作：✕ 停止（运行中且登记了 onStop——与节点 X 同一停止内核）、
 *     ⌖ 定位（目标含合法几何时显示，视口聚焦到节点/图片）、
 *     ✕ 清除（失败条目驻留，手动移除）；
 *   - 结算展示：done/stopped 变灰停留约 6 秒后自动消失（注册表 TTL 驱动），
 *     failed 标红驻留直到手动清除；
 *   - 角标：按钮数字 = 运行中任务数；存在未读失败时优先显示失败数并
 *     标红，开窗即标记已读（失败条目仍在列表中等候处理）；
 *   - 刷新：订阅 lumen-tasks-changed 全量重渲（列表小、频率低，够用）；
 *     秒表仅在窗口打开期间走 1s 计时器，只改时间单元格不重渲整表。
 * ==========================================================================
 */

class TaskCenter {
    /** 任务类型 → 图标（feather 风格线框，stroke 随 currentColor） */
    static KIND_META = {
        api: {
            name: 'API 生图',
            icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>'
        },
        comfy: {
            name: 'Comfy 节点',
            icon: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/><path d="M11 7h5.5v6"/>'
        },
        rh: {
            name: 'RunningHub',
            icon: '<path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.4 1.6A4 4 0 0 0 7 19z"/>'
        },
        panel: {
            name: 'Comfy 面板',
            icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>'
        },
        upscale: {
            name: '高清放大',
            icon: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>'
        },
        // pi 后台任务镜像（后端 /api/tasks 中继，kind 前缀 pi-）：
        // 无停止/定位句柄，视图自然只展示
        'pi-llm_image': {
            name: 'Agent 生图',
            icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>'
        },
        'pi-video': {
            name: 'Agent 视频',
            icon: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>'
        },
        'pi-upscale': {
            name: 'Agent 放大',
            icon: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>'
        },
        'pi-rembg': {
            name: 'Agent 抠图',
            icon: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/>'
        }
    };

    /** 行内动作图标 */
    static ACTIONS = {
        stop: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
        locate: '<circle cx="12" cy="12" r="7"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/>'
    };

    constructor() {
        this.el = null;
        this.listEl = null;
        this.badgeEl = null;
        this._ticker = null;    // 窗口打开期间的秒表计时器

        this.init();
    }

    /**
     * 初始化：向左侧工具栏插入按钮（AssetLibrary 同款——app.js 装配顺序
     * 保证 #sideToolbar 已存在），构建窗口 DOM 并订阅注册表变更
     */
    init() {
        const bar = document.getElementById('sideToolbar');
        if (!bar) return;

        this.btn = document.createElement('button');
        this.btn.className = 'side-toolbar-btn task-center-btn';
        this.btn.id = 'taskCenterBtn';
        this.btn.type = 'button';
        this.btn.title = '任务中心';
        this.btn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round">
                <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>
                <line x1="8" y1="18" x2="21" y2="18"/>
                <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/>
                <line x1="3" y1="18" x2="3.01" y2="18"/>
            </svg>
            <span class="task-center-badge" hidden></span>
        `;
        this.badgeEl = this.btn.querySelector('.task-center-badge');
        this.btn.addEventListener('click', () => this.toggle());
        bar.appendChild(this.btn);

        this.buildWindow();

        // 注册表任何变更：窗口开着就重渲列表；角标永远刷新
        window.addEventListener('lumen-tasks-changed', () => {
            this.updateBadge();
            if (this.el?.classList.contains('show')) this.render();
        });
        this.updateBadge();

        // F5 后补拉 pi 后台任务（WS task-event 只推增量，错过登记的
        // 运行中任务靠这里按后端快照回填；fire-and-forget 失败静默）
        fetch('/api/tasks').then((r) => r.json()).then((j) => {
            if (j && j.status === 'ok' && Array.isArray(j.tasks)) {
                for (const t of j.tasks) window.taskRegistry?.mirrorExternal(t);
            }
        }).catch(() => { /* 后端不可达：跳过补水 */ });
    }

    /** 构建窗口 DOM（隐藏，toggle 控制显隐） */
    buildWindow() {
        this.el = document.createElement('div');
        this.el.className = 'task-center';
        this.el.innerHTML = `
            <div class="task-center-header">
                <span class="task-center-title">任务中心</span>
                <span class="task-center-header-spacer"></span>
                <button type="button" class="task-center-icon-btn task-center-close-btn" title="关闭">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" stroke-width="2"
                         stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>
            <div class="task-center-body"></div>
        `;
        document.body.appendChild(this.el);
        this.listEl = this.el.querySelector('.task-center-body');

        // 任务行自带行尾 ✕（取消/移除/清除），标题栏不设批量清除入口
        this.el.querySelector('.task-center-close-btn').addEventListener('click', () => this.hide());
    }

    /** 打开/关闭窗口 */
    toggle() {
        if (this.el.classList.contains('show')) {
            this.hide();
            return;
        }
        // 与资产库互斥：同列弹窗不叠开（点击哪个哪个开，另一个收起）
        window.assetLibrary?.hide();
        this.el.classList.add('show');
        this.btn.classList.add('active');
        // 定位到按钮旁边（.show 生效后量高）：水平贴工具栏右侧，
        // 垂直对齐按钮中心——工具栏位置变化后窗口依然贴着按钮
        this._positionNearButton();
        // 开窗即「已看到」：未读失败清零，红色角标熄回
        window.taskRegistry?.markAllSeen();
        this.render();
        // 秒表：仅窗口打开期间走计时器（只改时间单元格，不重渲整表）
        this._ticker = setInterval(() => this._updateElapsed(), 1000);
    }

    hide() {
        this.el.classList.remove('show');
        this.btn.classList.remove('active');
        if (this._ticker) { clearInterval(this._ticker); this._ticker = null; }
    }

    /**
     * 定位窗口到按钮旁边：水平贴工具栏右侧（按钮右缘 + 8px），
     * 垂直对齐按钮中心并钳制在视口内。须在 .show 生效后调用
     * （offsetHeight 依赖已渲染）
     */
    _positionNearButton() {
        if (!this.btn || !this.el) return;
        const rect = this.btn.getBoundingClientRect();
        const height = this.el.offsetHeight;
        const left = rect.right + 8;
        let top = rect.top + rect.height / 2 - height / 2;
        top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
        this.el.style.left = `${Math.round(left)}px`;
        this.el.style.top = `${Math.round(top)}px`;
    }

    /** 全量重渲任务列表（列表小、变更频率低，够用） */
    render() {
        const tasks = window.taskRegistry?.list() || [];
        this.listEl.innerHTML = '';

        if (tasks.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'task-center-empty';
            empty.textContent = '当前没有任务。画布生成、面板运行与高清放大都会出现在这里。';
            this.listEl.appendChild(empty);
            return;
        }

        for (const task of tasks) {
            this.listEl.appendChild(this._buildRow(task));
        }
    }

    /** 构建单行：主列（图标+标签+耗时 / 状态+定位）+ 行尾 ✕ */
    _buildRow(task) {
        const meta = TaskCenter.KIND_META[task.kind] || TaskCenter.KIND_META.api;
        const row = document.createElement('div');
        row.className = `task-center-row is-${task.status}`;
        row.dataset.id = task.id;

        const main = document.createElement('div');
        main.className = 'task-center-main';

        const label = document.createElement('div');
        label.className = 'task-center-label';
        label.textContent = task.label || meta.name;
        label.title = task.label || meta.name;

        const time = document.createElement('span');
        time.className = 'task-center-elapsed';
        time.dataset.startedAt = String(task.startedAt);
        time.dataset.endedAt = String(task.endedAt || '');
        time.textContent = TaskCenter._fmtDuration(
            (task.endedAt || Date.now()) - task.startedAt);

        const top = document.createElement('div');
        top.className = 'task-center-row-top';
        top.append(this._iconEl(meta.icon, 'task-center-kind', meta.name), label, time);

        const bottom = document.createElement('div');
        bottom.className = 'task-center-row-bottom';
        bottom.append(this._statusEl(task));

        // 定位：目标几何合法时聚焦视口（保持运行/结算都可用）
        const actions = document.createElement('div');
        actions.className = 'task-center-actions';
        if (TaskCenter._hasRect(task.locateTarget)) {
            actions.append(this._actionBtn(TaskCenter.ACTIONS.locate, '定位到画布',
                () => this._locate(task.locateTarget)));
        }
        if (actions.childElementCount > 0) bottom.appendChild(actions);

        main.append(top, bottom);
        row.append(main, this._rowCloseBtn(task));
        return row;
    }

    /**
     * 行尾 ✕：复用 GenStopControl 预制件（与画布生图节点/面板停止按钮
     * 同一套视觉与常驻两态语言）——可操作（取消任务/清除失败记录）点亮
     * active 红底白叉，无操作（Agent/云端运行中不可单独中止、已自动
     * 收尾的任务）保持暗色禁用态即不可点
     */
    _rowCloseBtn(task) {
        let active = false, title, onAbort;
        if (task.status === 'running') {
            if (task.onStop) {
                active = true;
                title = '取消任务';
                onAbort = () => task.onStop();
            } else {
                title = task.kind.startsWith('pi-')
                    ? 'Agent 后台任务无法单独中止'
                    : task.kind === 'rh'
                        ? '云端任务无法中止'
                        : '无停止通道';
            }
        } else if (task.status === 'failed') {
            active = true;
            title = '清除记录';
            onAbort = () => window.taskRegistry?.dismiss(task.id);
        } else {
            title = '任务已结束';
        }

        const holder = document.createElement('div');
        const ctrl = new GenStopControl({ title, onAbort, host: holder });
        const btn = holder.firstElementChild;
        if (active) ctrl.begin();   // 点亮两态视觉（signal 不消费，仅借预制件外观）
        btn.classList.add('task-center-row-x');
        return btn;
    }

    /** 状态行：运行进度 / 结算附注 */
    _statusEl(task) {
        const el = document.createElement('span');
        el.className = 'task-center-status';
        if (task.status === 'running') {
            const dot = document.createElement('span');
            dot.className = 'task-center-dot';
            el.appendChild(dot);
            const text = document.createElement('span');
            text.textContent = (task.total && task.total > 1)
                ? `生成中 ${task.done}/${task.total}` : '生成中…';
            el.appendChild(text);
        } else if (task.note) {
            el.textContent = task.note;
        } else if (task.status === 'done') {
            el.textContent = '完成';
        } else if (task.status === 'stopped') {
            el.textContent = '已停止';
        } else {
            el.textContent = '失败';
        }
        return el;
    }

    _iconEl(svgInner, cls, title) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('class', cls);
        svg.innerHTML = svgInner;
        if (title) svg.setAttribute('title', title);
        return svg;
    }

    _actionBtn(svgInner, title, onClick) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'task-center-act';
        btn.title = title;
        btn.appendChild(this._iconEl(svgInner, '', ''));
        btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
        return btn;
    }

    /** 定位：与画布「自适应屏幕」同款 fitToBounds，聚焦到登记的目标矩形 */
    _locate(target) {
        const canvas = window.canvas;
        if (!canvas || !TaskCenter._hasRect(target)) return;
        canvas.viewport.fitToBounds([target], canvas.cssWidth, canvas.cssHeight);
        canvas.draw();
    }

    /** 秒表 tick：只刷新时间单元格（dataset 记起止时间，无需整表重渲） */
    _updateElapsed() {
        if (!this.el?.classList.contains('show')) return;
        const now = Date.now();
        for (const el of this.listEl.querySelectorAll('.task-center-elapsed')) {
            const start = Number(el.dataset.startedAt) || now;
            const end = Number(el.dataset.endedAt) || now;
            el.textContent = TaskCenter._fmtDuration(Math.max(0, end - start));
        }
    }

    /** 角标：未读失败优先红显，其次运行数，为零隐藏 */
    updateBadge() {
        if (!this.badgeEl) return;
        const registry = window.taskRegistry;
        if (!registry) return;
        const failures = registry.unseenFailures();
        const running = registry.runningCount();
        if (failures > 0) {
            this.badgeEl.textContent = String(failures);
            this.badgeEl.classList.add('has-failures');
            this.badgeEl.hidden = false;
        } else if (running > 0) {
            this.badgeEl.textContent = String(running);
            this.badgeEl.classList.remove('has-failures');
            this.badgeEl.hidden = false;
        } else {
            this.badgeEl.hidden = true;
        }
    }

    /** 定位目标须含数值几何（节点实例/画布图片对象满足；纯引用不显示定位钮） */
    static _hasRect(t) {
        return !!t && [t.x, t.y, t.width, t.height].every(
            (n) => typeof n === 'number' && Number.isFinite(n));
    }

    /** 时长格式化：分:秒，超 1 小时进位到时 */
    static _fmtDuration(ms) {
        const total = Math.max(0, Math.round(ms / 1000));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
        return (h > 0 ? `${h}:` : '') + `${mm}:${String(s).padStart(2, '0')}`;
    }
}

// 暴露到全局作用域（app.js 实例化：window.taskCenter = new TaskCenter()）
window.TaskCenter = TaskCenter;
