/**
 * ==========================================================================
 * LumenLight 工作流模板窗口（WorkflowTemplateLibrary）
 * ==========================================================================
 * 作用：左侧工具栏的工作流图标按钮弹出窗口，用于存储画布工作流模板。
 *       窗口形态与本地资产库同款（fixed 贴顶栏、left 62 / top 56 /
 *       bottom 100 / 宽 300，见 css/workflow-template.css），与资产库、
 *       任务中心互斥（同列弹窗不叠开）。
 *
 * 数据链路：
 *   - 模板存后端 workflows/canvas-templates/ 子目录（一模板一 JSON，
 *     routes/canvasTemplates.js 提供 /api/canvas-templates 列表/详情）；
 *   - 条目文字可拖拽（dragstart 带自定义 MIME 标记），拖到画布释放后
 *     applyTemplate 按快照重建整套节点+连线：节点经构造器分发重建
 *     （同 ProjectSerializer.restoreNodes 的分发表）、id 全部换新、
 *     整组以落点为中心平移、入撤销栈（Ctrl+Z 一次回退整套）。
 *
 * 「存为模板」入口后续迭代接入（届时补 POST 路由 + 选中节点导出）。
 * ==========================================================================
 */

class WorkflowTemplateLibrary {
    /** 拖拽数据流标记（画布 drop 监听据此识别模板拖拽，与文件/资产拖放互不干扰） */
    static DRAG_MIME = 'application/x-lumen-canvas-template';

    constructor() {
        this.el = null;
        this.bodyEl = null;
        this._dragTemplateId = null;   // 拖拽中的模板 id（drop 时消费）
        this.init();
    }

    /**
     * 初始化：向左侧工具栏插入按钮（app.js 装配顺序在本类实例化前
     * 已建好 #sideToolbar 与资产库/任务中心按钮，本按钮追加在任务中心
     * 之下），构建窗口 DOM 并注册画布 drop 监听
     */
    init() {
        const bar = document.getElementById('sideToolbar');
        if (!bar) return;

        this.btn = document.createElement('button');
        this.btn.className = 'side-toolbar-btn workflow-template-btn';
        this.btn.id = 'workflowTemplateBtn';
        this.btn.type = 'button';
        this.btn.title = '工作流模板';
        this.btn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round">
                <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/>
                <circle cx="18" cy="19" r="3"/>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
        `;
        this.btn.addEventListener('click', () => this.toggle());
        bar.appendChild(this.btn);

        this.buildWindow();
        this.bindCanvasDrop();
    }

    /** 构建窗口 DOM（隐藏，toggle 控制显隐） */
    buildWindow() {
        this.el = document.createElement('div');
        this.el.className = 'workflow-template-window';
        this.el.innerHTML = `
            <div class="workflow-template-header">
                <span class="workflow-template-title">工作流模板</span>
                <span class="workflow-template-header-spacer"></span>
                <button type="button" class="workflow-template-icon-btn workflow-template-close-btn" title="关闭">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" stroke-width="2"
                         stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>
            <div class="workflow-template-body"></div>
        `;
        document.body.appendChild(this.el);
        this.bodyEl = this.el.querySelector('.workflow-template-body');

        this.el.querySelector('.workflow-template-close-btn')
            .addEventListener('click', () => this.hide());
    }

    /** 打开/关闭窗口（与资产库/任务中心互斥：同列弹窗不叠开） */
    toggle() {
        if (this.el.classList.contains('show')) {
            this.hide();
            return;
        }
        window.assetLibrary?.hide();
        window.taskCenter?.hide();
        this.el.classList.add('show');
        this.btn.classList.add('active');
        this.render();
    }

    hide() {
        this.el.classList.remove('show');
        this.btn.classList.remove('active');
    }

    /**
     * 渲染模板列表：一模板一条目（名称 + 说明），条目可拖拽到画布铺开。
     * 后端不可达/无模板时显示对应空态
     */
    async render() {
        this.bodyEl.innerHTML = '';
        let templates = null;
        try {
            const resp = await fetch('/api/canvas-templates');
            const data = await resp.json();
            if (data.status === 'ok') templates = data.templates || [];
        } catch {
            templates = null;
        }

        if (templates === null) {
            this._appendNote('模板清单加载失败（后端不可达），请重启后端后重试。');
            return;
        }
        if (templates.length === 0) {
            this._appendNote('暂无模板。把画布工作流模板 JSON 放入 workflows/canvas-templates/ 目录即可出现在这里。');
            return;
        }

        for (const t of templates) {
            this.bodyEl.appendChild(this._buildItem(t));
        }
    }

    /** 追加一条灰字说明（空态/错误态） */
    _appendNote(text) {
        const note = document.createElement('div');
        note.className = 'workflow-template-empty';
        note.textContent = text;
        this.bodyEl.appendChild(note);
    }

    /**
     * 构建单个模板条目：名称 + 说明文字，draggable——拖到画布即整套铺开
     * （id 存实例字段 + dataTransfer 双保险：后者是标准通道，前者兜底
     * 个别浏览器 getData 在 drop 前受限的情况）
     */
    _buildItem(t) {
        const item = document.createElement('div');
        item.className = 'workflow-template-item';
        item.draggable = true;
        item.title = '拖到画布即可铺开这套工作流';

        const name = document.createElement('div');
        name.className = 'workflow-template-item-name';
        name.textContent = t.name;
        if (t.nodeCount > 0) {
            const tag = document.createElement('span');
            tag.className = 'workflow-template-item-count';
            tag.textContent = `${t.nodeCount} 节点`;
            name.appendChild(tag);
        }

        const desc = document.createElement('div');
        desc.className = 'workflow-template-item-desc';
        desc.textContent = t.description || '（无说明）';

        item.append(name, desc);
        item.addEventListener('dragstart', (e) => {
            this._dragTemplateId = t.id;
            e.dataTransfer.setData(WorkflowTemplateLibrary.DRAG_MIME, t.id);
            e.dataTransfer.effectAllowed = 'copy';
            item.classList.add('dragging');
        });
        item.addEventListener('dragend', () => {
            this._dragTemplateId = null;
            item.classList.remove('dragging');
        });
        return item;
    }

    /**
     * 注册画布 drop 监听：模板条目拖到画布释放 → 以落点为中心整套铺开。
     * 画布现有 drop 处理器只认 files/uri-list，对自定义标记不响应，互不干扰
     * （AssetLibrary 资产拖放同款接线）
     */
    bindCanvasDrop() {
        const canvas = window.canvas;
        if (!canvas?.canvas) return;
        canvas.canvas.addEventListener('drop', (e) => {
            if (!e.dataTransfer?.types?.includes(WorkflowTemplateLibrary.DRAG_MIME)) return;
            const id = this._dragTemplateId ||
                e.dataTransfer.getData(WorkflowTemplateLibrary.DRAG_MIME);
            if (!id) return;
            e.preventDefault();
            e.stopPropagation();
            const rect = canvas.canvas.getBoundingClientRect();
            // 屏幕坐标 → 画布世界坐标（Viewport 偏移以画布元素左上为原点）
            const cp = canvas.viewport.screenToCanvas(
                e.clientX - rect.left, e.clientY - rect.top);
            this.applyTemplate(id, cp.x, cp.y)
                .catch((err) => console.error('[工作流模板] 套用失败:', err));
        });
    }

    /**
     * 套用模板：拉取快照 → 按类型分发重建节点（id 全新）→ 连线按下标对
     * 重映射 → 整组以落点为中心平移 → 入撤销栈（一次回退整套）。
     * @param {string} id - 模板 id（文件名，不含 .json）
     * @param {number} cx - 落点画布 X（模板包围盒中心对齐到此）
     * @param {number} cy - 落点画布 Y
     */
    async applyTemplate(id, cx, cy) {
        const c = window.canvas;
        if (!c) return;
        const resp = await fetch(`/api/canvas-templates/${encodeURIComponent(id)}`);
        const data = await resp.json();
        if (data.status !== 'ok' || !data.template) {
            console.error('[工作流模板] 模板读取失败:', data.message);
            return;
        }
        const tpl = data.template;
        const nodes = Array.isArray(tpl.nodes) ? tpl.nodes : [];
        if (nodes.length === 0) return;

        // 平移基准：模板包围盒中心对齐到落点
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of nodes) {
            minX = Math.min(minX, n.x);
            minY = Math.min(minY, n.y);
            maxX = Math.max(maxX, n.x + (n.width || 0));
            maxY = Math.max(maxY, n.y + (n.height || 0));
        }
        const dx = cx - (minX + maxX) / 2;
        const dy = cy - (minY + maxY) / 2;

        // 按类型分发重建（分发表同 ProjectSerializer.restoreNodes）
        const created = [];
        for (const n of nodes) {
            const node = this._recreateNode(c, n, dx, dy);
            if (node) {
                c.images.images.push(node);
                created.push(node);
            } else {
                console.warn('[工作流模板] 跳过不支持的节点类型:', n.type);
            }
        }
        if (created.length === 0) return;

        // 连线：模板存下标对（静态数据无 id 漂移），重建后按新实例对接
        for (const conn of (tpl.connections || [])) {
            const from = created[conn.from];
            const to = created[conn.to];
            if (!from || !to) continue;
            const added = c.connections.add(from.id, to.id);
            if (added && typeof conn.order === 'number') added.order = conn.order;
        }

        // 新节点整体选中（与粘贴体验一致），撤销记账一条命令回退整套
        c.images.selectedIds.clear();
        for (const node of created) {
            node.selected = true;
            c.images.selectedIds.add(node.id);
        }
        c.history?.recordCreate(created, `套用模板：${tpl.name || id}`);
        c.draw();
        window.dispatchEvent(new CustomEvent('canvasViewportChanged'));
    }

    /**
     * 按 type 分发重建单个节点（坐标平移 dx/dy，分发表与
     * ProjectSerializer.restoreNodes / CanvasHistory._recreateNode 同构；
     * 新节点 id/seqId 由构造器新分配，模板快照不携带）
     */
    _recreateNode(c, n, dx, dy) {
        const NT = NodeTypes.SOURCE;
        const x = n.x + dx;
        const y = n.y + dy;
        const size = { width: n.width, height: n.height };
        switch (n.type) {
            case NT.PROMPT_NODE:
                return new PromptNode(c, x, y, n.text || '', size);
            case NT.TEXT_NODE:
                return new TextNode(c, x, y, n.text || '', size);
            case NT.BOOKMARK_NODE:
                return new BookmarkNode(c, x, y, size);
            case NT.LORA_NODE:
                return new LoraNode(c, x, y, { ...size, entries: n.entries });
            case NT.IMAGE_GEN_NODE:
                return new ImageGenNode(c, x, y, {
                    ...size, model: n.model, ratio: n.ratio,
                    tier: n.tier, quality: n.quality, count: n.count
                });
            case NT.VIDEO_GEN_NODE:
                return new VideoGenNode(c, x, y, {
                    ...size, model: n.model, ratio: n.ratio,
                    duration: n.duration
                });
            case NT.COMFY_GEN_NODE:
                return new ComfyGenNode(c, x, y, {
                    ...size, workflowId: n.workflowId, models: n.models,
                    loraEnabled: n.loraEnabled, steps: n.steps, cfg: n.cfg,
                    sampler: n.sampler, sizeW: n.sizeW, sizeH: n.sizeH,
                    denoise: n.denoise, count: n.count
                });
            case NT.RUNHUB_GEN_NODE:
                return new RunningHubGenNode(c, x, y, {
                    ...size, workflowId: n.workflowId, values: n.values,
                    count: n.count
                });
            default:
                return null;
        }
    }
}

// 暴露到全局作用域（app.js 实例化：window.workflowTemplateLibrary = new WorkflowTemplateLibrary()）
window.WorkflowTemplateLibrary = WorkflowTemplateLibrary;
