/**
 * ==========================================================================
 * LumenLight 工作流编辑器（WorkflowEditor）
 * ==========================================================================
 * 作用：顶栏「Comfy」按钮打开的浮窗——左侧工作流列表，右侧节点图。
 * 目的是方便修改工作流参数：部分工作流参数很多，画布生图节点与右侧
 * 面板都展不全，这里按 ComfyUI 节点风格把每个节点的全部参数渲染成
 * 节点内嵌控件（下拉/数字/文本/开关），改完直接写回 workflows/*.json。
 *
 * 技术要点：
 *   - 工作流是 API 格式 JSON（inputs/class_type/_meta，无坐标字段），
 *     节点图由依赖关系自动布局（拓扑分层）；连线从 inputs 里的
 *     [节点id, 输出槽] 引用重建，SVG 贝塞尔绘制
 *   - 拖拽布局存 data/workflow-layouts.json sidecar（不污染模板），
 *     视图缩放/平移一并记忆
 *   - 参数控件类型来自 /api/comfy-node/object-info 代理（枚举候选/
 *     数值范围）；ComfyUI 离线时按值类型推断降级
 *   - 保存 = PUT /api/workflows/:id 写回模板文件（保持包装/纯格式不变）
 *
 * 交互（与画布一致）：点节点选中，选中的节点任意位置拖动 / 空白处拖动平移
 * 并取消选中 / 滚轮缩放 / Ctrl+S 保存 / Esc 取消选中或关闭
 * ==========================================================================
 */

// ==================== ComfyUI socket 配色（视觉规格取自其 dark 色板，仅色值） ====================

const WF_SOCKET_COLORS = {
    MODEL: '#8978a7', CLIP: '#eacb8b', CLIP_VISION: '#a8dadc', CLIP_VISION_OUTPUT: '#ad7452',
    CONDITIONING: '#cf876f', CONTROL_NET: '#00d78d', IMAGE: '#80a1c0', LATENT: '#b38ead',
    MASK: '#a3bd8d', STYLE_MODEL: '#c2ffae', TAESD: '#dcc274', VAE: '#be616b',
    NOISE: '#8978a7', GUIDER: '#cf876f', SAMPLER: '#eacb8b', SIGMAS: '#dcc274'
};
/** 未知类型回退灰（与 ComfyUI 同策略） */
const wfSocketColor = (type) => WF_SOCKET_COLORS[String(type || '').toUpperCase()] || '#999';

/** 控件型输入的 object_info 类型（其余大写类型名一律视为连接型端口） */
const WF_WIDGET_TYPES = new Set(['STRING', 'INT', 'FLOAT', 'BOOLEAN', 'COMBO']);
/** 多类型声明（spec[0] 为数组）→ 端口的判定：全部元素都是大写类型标识符 */
const isWfPortType = (t) => {
    if (t === null || t === undefined) return false;
    if (Array.isArray(t)) {
        return t.length > 0 && t.every((x) => /^[A-Z0-9_]+$/.test(String(x)));
    }
    const ts = String(t).toUpperCase();
    if (WF_WIDGET_TYPES.has(ts)) return false;
    return /^[A-Z0-9_]+$/.test(ts);
};

class WorkflowEditor {
    constructor() {
        this.triggerButton = null;   // 顶栏 Comfy 按钮
        this.overlay = null;         // 全屏遮罩根元素
        this.listEl = null;          // 左侧工作流列表
        this.viewportEl = null;      // 图视口（overflow hidden）
        this.worldEl = null;         // 图世界（transform 缩放平移）
        this.svgEl = null;           // 连线层
        this.titleEl = null;
        this.saveBtn = null;
        this.selectedIds = new Set(); // 当前选中的节点 id 集合（画布式多选）
        this.SVG_PAD = 5000;         // 连线层向世界原点四周扩展的半宽（px）

        this.workflows = [];         // [{ id, name, nodeCount }]
        this.current = null;         // { id, name, data, positions, objInfo }
        this.view = { scale: 1, tx: 40, ty: 40 };
        this.dirty = false;
        this._layoutTimer = null;

        this.init();
    }

    // ==================== 初始化与弹窗骨架 ====================

    init() {
        const toolbarCenter = document.getElementById('topToolbarCenter');
        if (!toolbarCenter) return;

        this.triggerButton = document.createElement('button');
        this.triggerButton.className = 'top-toolbar-btn recipe-trigger-btn';
        this.triggerButton.type = 'button';
        this.triggerButton.title = '工作流编辑器：查看/修改工作流参数';
        this.triggerButton.innerHTML = `
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="5" cy="6" r="2.2"></circle>
                <circle cx="19" cy="6" r="2.2"></circle>
                <circle cx="12" cy="18" r="2.2"></circle>
                <circle cx="19" cy="18" r="2.2"></circle>
                <path d="M7 7l3.5 9"></path>
                <path d="M17 7l-3.5 9"></path>
                <path d="M17.5 18H14.5"></path>
            </svg>
            <span>Comfy</span>
        `;
        this.triggerButton.addEventListener('click', () => this.open());
        toolbarCenter.appendChild(this.triggerButton);

        this.createDialog();
    }

    createDialog() {
        this.overlay = document.createElement('div');
        this.overlay.className = 'wf-editor-overlay';
        this.overlay.innerHTML = `
            <div class="wf-editor-window" role="dialog" aria-label="工作流编辑器">
                <div class="wf-editor-header">
                    <span class="wf-editor-title">工作流编辑器</span>
                    <span class="wf-editor-name"></span>
                    <span class="wf-editor-dirty"></span>
                    <span class="wf-editor-flex"></span>
                    <button type="button" class="wf-editor-save">保存</button>
                    <button type="button" class="wf-editor-reset-layout" title="清除拖拽布局，恢复自动排列">重排</button>
                    <button type="button" class="wf-editor-close" title="关闭 (Esc)">✕</button>
                </div>
                <div class="wf-editor-body">
                    <div class="wf-editor-list"></div>
                    <div class="wf-editor-viewport">
                        <div class="wf-editor-world">
                            <svg class="wf-editor-svg"></svg>
                        </div>
                        <div class="wf-editor-hint">中键拖动平移 · 左键空白处框选 · 点节点选中后拖动 · 滚轮缩放 · Ctrl+S 保存</div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(this.overlay);

        this.listEl = this.overlay.querySelector('.wf-editor-list');
        this.viewportEl = this.overlay.querySelector('.wf-editor-viewport');
        this.worldEl = this.overlay.querySelector('.wf-editor-world');
        this.svgEl = this.overlay.querySelector('.wf-editor-svg');
        this.titleEl = this.overlay.querySelector('.wf-editor-name');
        this.dirtyEl = this.overlay.querySelector('.wf-editor-dirty');
        this.saveBtn = this.overlay.querySelector('.wf-editor-save');

        this.overlay.querySelector('.wf-editor-close').addEventListener('click', () => this.close());
        this.saveBtn.addEventListener('click', () => this.save());
        this.overlay.querySelector('.wf-editor-reset-layout').addEventListener('click', () => this.resetLayout());
        this.overlay.addEventListener('mousedown', (e) => { if (e.target === this.overlay) this.close(); });
        document.addEventListener('keydown', (e) => {
            if (!this.overlay.classList.contains('open')) return;
            if (e.key === 'Escape') {
                // 画布式语义：Esc 先取消选中，无选中再关闭窗口
                if (this.selectedIds.size > 0) this._setSelection([]);
                else this.close();
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                this.save();
            }
            // Ctrl+B 忽略/恢复选中节点（与 ComfyUI 同快捷键）
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
                e.preventDefault();
                for (const id of this.selectedIds) this._toggleBypass(id);
            }
        });
        this._bindGraphControls();
        this._bindNodeContextMenu();
    }

    // ==================== 忽略节点（bypass，与 ComfyUI 同语义） ====================

    /** 切换节点忽略状态：只改 sidecar 里的标记，模板文件不动（运行时状态） */
    _toggleBypass(nodeId) {
        if (!this.current) return;
        const set = this.current.bypassed;
        if (set.has(nodeId)) set.delete(nodeId); else set.add(nodeId);
        const el = this.worldEl.querySelector(`.wf-node[data-id="${CSS.escape(nodeId)}"]`);
        if (el) el.classList.toggle('bypassed', set.has(nodeId));
        this._saveLayoutDebounced();
    }

    _hideNodeMenu() {
        if (this.menuEl) this.menuEl.style.display = 'none';
    }

    /** 节点右键菜单：忽略/恢复（提交时按 ComfyUI 规则直通重连并剔除） */
    _bindNodeContextMenu() {
        this.menuEl = document.createElement('div');
        this.menuEl.className = 'wf-node-menu';
        this.menuEl.style.display = 'none';
        this.viewportEl.appendChild(this.menuEl);
        this.viewportEl.addEventListener('contextmenu', (e) => {
            this._hideNodeMenu();
            const nodeEl = e.target.closest('.wf-node');
            if (!nodeEl) return;
            e.preventDefault();
            const nodeId = nodeEl.dataset.id;
            if (!this.selectedIds.has(nodeId)) this._setSelection([nodeId]);
            const bypassed = this.current.bypassed.has(nodeId);
            this.menuEl.innerHTML = '';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'wf-node-menu-item';
            btn.textContent = bypassed ? '↩ 恢复节点' : '✕ 忽略节点';
            btn.addEventListener('click', () => {
                this._toggleBypass(nodeId);
                this._hideNodeMenu();
            });
            this.menuEl.appendChild(btn);
            const rect = this.viewportEl.getBoundingClientRect();
            this.menuEl.style.display = 'block';
            this.menuEl.style.left = Math.min(e.clientX - rect.left, rect.width - 130) + 'px';
            this.menuEl.style.top = Math.min(e.clientY - rect.top, rect.height - 44) + 'px';
        });
        // 菜单外按下任意键/鼠标即收起（滚轮缩放/拖拽前先清掉浮层）
        this.viewportEl.addEventListener('mousedown', (e) => {
            if (!e.target.closest('.wf-node-menu')) this._hideNodeMenu();
        });
        this.viewportEl.addEventListener('wheel', () => this._hideNodeMenu(), { passive: true });
    }

    open() {
        this.overlay.classList.add('open');
        if (!this.workflows.length) this.loadList();
    }

    close() {
        if (this.dirty && !window.confirm('有未保存的修改，确定关闭？')) return;
        this.overlay.classList.remove('open');
    }

    // ==================== 工作流列表 ====================

    async loadList() {
        this.listEl.innerHTML = '<div class="wf-editor-list-tip">加载中…</div>';
        try {
            const res = await fetch('/api/workflows');
            const data = await res.json();
            this.workflows = data.workflows || [];
        } catch {
            this.listEl.innerHTML = '<div class="wf-editor-list-tip">列表加载失败</div>';
            return;
        }
        if (!this.workflows.length) {
            this.listEl.innerHTML = '<div class="wf-editor-list-tip">workflows/ 目录下没有工作流</div>';
            return;
        }
        this.listEl.innerHTML = '';
        for (const wf of this.workflows) {
            const item = document.createElement('div');
            item.className = 'wf-editor-item';
            item.innerHTML = `
                <div class="wf-editor-item-name"></div>
                <div class="wf-editor-item-meta">${wf.nodeCount} 节点</div>
            `;
            item.querySelector('.wf-editor-item-name').textContent = wf.name;
            item.addEventListener('click', () => this.select(wf.id));
            this.listEl.appendChild(item);
        }
        // 默认选中第一个
        this.select(this.workflows[0].id);
    }

    // ==================== 工作流加载与解析 ====================

    async select(id) {
        this.listEl.querySelectorAll('.wf-editor-item').forEach((el) => {
            el.classList.toggle('active', el.dataset.id === id);
        });
        this.viewportEl.querySelectorAll('.wf-node').forEach((el) => el.remove());
        this.titleEl.textContent = '加载中…';
        try {
            const [detailRes, layoutRes, modelsRes] = await Promise.all([
                fetch(`/api/workflows/${encodeURIComponent(id)}`),
                fetch(`/api/workflows/${encodeURIComponent(id)}/layout`),
                fetch('/api/comfy-node/models').catch(() => null)
            ]);
            const detail = await detailRes.json();
            const layout = await layoutRes.json();
            const data = detail.workflow;
            this.current = {
                id,
                name: detail.name || id,
                data,
                positions: (layout.layout && layout.layout.positions) || {},
                savedView: (layout.layout && layout.layout.view) || null,
                bypassed: new Set((layout.layout && layout.layout.bypassed) || []),
                objInfo: {},
                modelLists: null
            };
            // 模型清单与画布节点同源（/api/comfy-node/models）：主模型/LoRA/
            // 采样器等文件枚举类下拉的候选补充，object_info 缺失时兜底
            if (modelsRes && modelsRes.ok) {
                try {
                    const m = await modelsRes.json();
                    if (m.connected) {
                        this.current.modelLists = {
                            checkpoints: m.checkpoints || [],
                            unets: m.unets || [],
                            loras: m.loras || [],
                            samplers: m.samplers || []
                        };
                    }
                } catch { /* 清单解析失败：仅用 object_info */ }
            }
            this.view = this.current.savedView || { scale: 1, tx: 40, ty: 40 };
            this.dirty = false;
            this._setSelection([]);
            this._renderState();

            const classes = [...new Set(Object.values(data).map((n) => n.class_type))];
            try {
                const res = await fetch('/api/comfy-node/object-info?classes=' + encodeURIComponent(classes.join(',')));
                const info = await res.json();
                if (info.connected) this.current.objInfo = info.info || {};
            } catch { /* ComfyUI 离线：按值类型推断降级 */ }

            this.renderGraph();
        } catch (err) {
            this.titleEl.textContent = '加载失败';
            console.error('[WorkflowEditor] 加载工作流失败:', err);
        }
    }

    /** 解析节点/连线 → 自动布局 → 渲染 */
    renderGraph() {
        const cur = this.current;
        const data = cur.data;
        cur.nodes = [];
        cur.edges = [];

        for (const [id, node] of Object.entries(data)) {
            const spec = (cur.objInfo[node.class_type] || {});
            const inputSpecs = Object.assign({}, spec.input && spec.input.required, spec.input && spec.input.optional);
            const inputs = [];
            // 端口（连接型输入/输出）：类型来自 object_info；声明了但未连接的
            // 连接型输入在 API 格式里不存在于 node.inputs，必须从 spec 补齐
            const inPorts = [];
            const connectedIn = new Set();
            for (const [name, value] of Object.entries(node.inputs || {})) {
                // 连线型输入（[节点id, 输出槽]）不是参数，转为边
                if (Array.isArray(value)) {
                    cur.edges.push({ from: String(value[0]), fromSlot: value[1], to: id, toName: name });
                    connectedIn.add(name);
                }
            }
            for (const [name, sp] of Object.entries(inputSpecs)) {
                if (!isWfPortType(sp ? sp[0] : null)) continue;
                const t = sp[0];
                inPorts.push({
                    name,
                    type: (Array.isArray(t) ? String(t[0]) : String(t)).toUpperCase(),
                    connected: connectedIn.has(name)
                });
            }
            // 兜底：边指向的输入没进 spec（自定义节点离线等），按端口补齐
            for (const e of cur.edges) {
                if (e.to !== id) continue;
                if (!inPorts.some((p) => p.name === e.toName)) {
                    inPorts.push({ name: e.toName, type: null, connected: true });
                }
            }
            // 输出端口：spec.output = 类型数组 / output_name = 名称数组
            const outPorts = [];
            if (Array.isArray(spec.output)) {
                spec.output.forEach((t, i) => {
                    const nm = Array.isArray(spec.output_name) ? spec.output_name[i] : null;
                    outPorts.push({ name: nm || String(t).toUpperCase(), type: String(t).toUpperCase() });
                });
            }
            for (const [name, value] of Object.entries(node.inputs || {})) {
                if (Array.isArray(value)) continue;
                inputs.push({ name, value, spec: inputSpecs[name] || null, kind: this._widgetKind(name, value, inputSpecs[name]) });
            }
            cur.nodes.push({ id, cls: node.class_type, inputs, inPorts, outPorts, mode: node._meta && node._meta.title || '' });
        }

        // 边上色：类型优先取源节点输出槽，缺失时回退目标输入端口
        const byId = new Map(cur.nodes.map((n) => [n.id, n]));
        for (const e of cur.edges) {
            const from = byId.get(e.from), to = byId.get(e.to);
            const op = from && from.outPorts[e.fromSlot];
            const ip = to && to.inPorts.find((p) => p.name === e.toName);
            e.type = (op && op.type) || (ip && ip.type) || null;
        }

        // 自动布局（sidecar 有拖拽位置的节点沿用）
        this._autoLayout(cur.nodes, cur.edges);

        // 渲染
        this.worldEl.querySelectorAll('.wf-node').forEach((el) => el.remove());
        this.svgEl.innerHTML = '';
        const svgNS = 'http://www.w3.org/2000/svg';
        for (const node of cur.nodes) this._renderNode(node);
        for (const edge of cur.edges) {
            const path = document.createElementNS(svgNS, 'path');
            path.setAttribute('class', 'wf-edge');
            this.svgEl.appendChild(path);
            edge.path = path;
        }
        this._applyView();
        this._updateEdges();
        this._sizeSvg();
    }

    /**
     * 参数控件类型判定：优先 object_info 的类型声明，缺失时按值推断。
     * 返回 'combo' | 'int' | 'float' | 'string' | 'bool' | 'text'
     */
    _widgetKind(name, value, spec) {
        const t = spec ? spec[0] : null;
        if (Array.isArray(t)) return 'combo';
        if (t === 'COMBO') return 'combo';
        if (t === 'INT') return 'int';
        if (t === 'FLOAT') return 'float';
        if (t === 'STRING') return 'string';
        if (t === 'BOOLEAN') return 'bool';
        if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
        if (typeof value === 'boolean') return 'bool';
        if (typeof value === 'string') return value.length > 60 || value.includes('\n') ? 'string' : 'text';
        return 'text';
    }

    _comboOptions(spec, value, extra = []) {
        let options = [];
        if (spec && Array.isArray(spec[0])) options = spec[0].slice();
        else if (spec && spec[0] === 'COMBO' && spec[1] && Array.isArray(spec[1].options)) options = spec[1].options.slice();
        // 并入模型清单候选（画布节点同源）+ 当前值（清单已变时保留可见），
        // 去重保序
        const seen = new Set();
        const merged = [];
        for (const opt of [...options, ...extra, value]) {
            if (opt === null || opt === undefined) continue;
            const key = String(opt);
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(opt);
        }
        return merged;
    }

    /**
     * 字段 → 模型清单类别（与 ComfyParamScanner.LOADER_TYPES 同口径：
     * ckpt_name→checkpoints、unet_name→unets、lora_name→loras、
     * sampler_name→samplers）；非模型字段返回空数组
     */
    _modelOptionsFor(cls, name) {
        const ml = this.current && this.current.modelLists;
        if (!ml) return [];
        switch (name) {
            case 'ckpt_name': return ml.checkpoints || [];
            case 'unet_name': return ml.unets || [];
            case 'lora_name': return ml.loras || [];
            case 'sampler_name': return ml.samplers || [];
            default: return [];
        }
    }

    // ==================== 自动布局 ====================

    _autoLayout(nodes, edges) {
        const byId = new Map(nodes.map((n) => [n.id, n]));
        const deps = new Map(nodes.map((n) => [n.id, []]));
        for (const e of edges) {
            if (deps.has(e.to)) deps.get(e.to).push(e.from);
        }
        // 层号 = 最长依赖链深（有环按 1 兜底，API 格式实际不会成环）
        const levels = new Map();
        const visiting = new Set();
        const levelOf = (id) => {
            if (levels.has(id)) return levels.get(id);
            if (visiting.has(id)) return 1;
            visiting.add(id);
            const ds = deps.get(id) || [];
            const lv = ds.length ? 1 + Math.max(...ds.map((d) => (byId.has(d) ? levelOf(d) : 1))) : 1;
            visiting.delete(id);
            levels.set(id, lv);
            return lv;
        };
        nodes.forEach((n) => levelOf(n.id));

        // 估算节点高度（端口行 + 控件行行数 × 行高 + 标题栏），按层纵向堆叠
        const NODE_W = 250, ROW_H = 29, HEAD_H = 30, GAP_X = 90, GAP_Y = 26;
        const byLevel = new Map();
        for (const n of nodes) {
            n.w = NODE_W;
            const portRows = Math.max(n.inPorts ? n.inPorts.length : 0, n.outPorts ? n.outPorts.length : 0);
            n.h = HEAD_H + (portRows + n.inputs.length) * ROW_H + 12;
            const lv = levels.get(n.id) || 1;
            if (!byLevel.has(lv)) byLevel.set(lv, []);
            byLevel.get(lv).push(n);
        }
        for (const [, group] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
            let y = 0;
            for (const n of group) {
                const saved = this.current.positions[n.id];
                if (saved && typeof saved.x === 'number') {
                    n.x = saved.x; n.y = saved.y;
                } else {
                    n.x = 20 + (levels.get(n.id) - 1) * (NODE_W + GAP_X);
                    n.y = y;
                    y += n.h + GAP_Y;
                }
            }
        }
    }

    // ==================== 节点渲染 ====================

    _renderNode(node) {
        const el = document.createElement('div');
        el.className = 'wf-node';
        el.dataset.id = node.id;
        el.style.width = node.w + 'px';
        if (this.current.bypassed.has(node.id)) el.classList.add('bypassed');

        const head = document.createElement('div');
        head.className = 'wf-node-head';
        head.innerHTML = `<span class="wf-node-cls"></span><span class="wf-node-id">#${node.id}</span>`;
        head.querySelector('.wf-node-cls').textContent = node.cls;
        el.appendChild(head);

        const body = document.createElement('div');
        body.className = 'wf-node-body';
        body.appendChild(this._renderPorts(node));
        for (const input of node.inputs) body.appendChild(this._renderWidget(node, input));
        el.appendChild(body);

        // 画布式交互：左键点击节点选中；选中的节点（含多选）整体可拖动。
        // 参数控件（select/input/textarea）与步进箭头例外——交给控件自身交互；
        // 中键不拦，冒泡到视口统一走平移
        el.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.target.closest('.wf-widget, .wf-step-btn')) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.shiftKey) {
                // Shift 加选/减选
                const next = new Set(this.selectedIds);
                if (next.has(node.id)) {
                    next.delete(node.id);
                    this._setSelection(next);
                    return;   // 减选后不拖动
                }
                next.add(node.id);
                this._setSelection(next);
            } else if (!this.selectedIds.has(node.id)) {
                this._setSelection([node.id]);
            }
            this._startNodeDrag(e);
        });
        this.worldEl.appendChild(el);
        node.el = el;
        this._applyNodePos(node);
        this._measurePortAnchors(node);
    }

    /**
     * 端口行渲染（Comfy 同款：输入 = 彩色圆点+名称居左，输出 = 名称+圆点居右；
     * 行数 = max(输入端口数, 输出端口数)，两侧不足的行留空占位）
     */
    _renderPorts(node) {
        const container = document.createElement('div');
        container.className = 'wf-node-ports';
        const rows = Math.max(node.inPorts.length, node.outPorts.length);
        for (let i = 0; i < rows; i++) {
            const row = document.createElement('div');
            row.className = 'wf-port-row';
            const ip = node.inPorts[i];
            const op = node.outPorts[i];
            if (ip) {
                const p = document.createElement('div');
                p.className = 'wf-port in' + (ip.connected ? ' linked' : '');
                p.dataset.name = ip.name;
                p.innerHTML = '<span class="wf-port-dot"></span><span class="wf-port-name"></span>';
                p.querySelector('.wf-port-dot').style.background = wfSocketColor(ip.type);
                p.querySelector('.wf-port-name').textContent = ip.name;
                p.title = ip.type ? `${ip.name}（${ip.type}）` : ip.name;
                row.appendChild(p);
            } else {
                row.appendChild(Object.assign(document.createElement('div'), { className: 'wf-port-spacer' }));
            }
            if (op) {
                const p = document.createElement('div');
                p.className = 'wf-port out';
                p.dataset.slot = String(i);
                p.innerHTML = '<span class="wf-port-name"></span><span class="wf-port-dot"></span>';
                p.querySelector('.wf-port-dot').style.background = wfSocketColor(op.type);
                p.querySelector('.wf-port-name').textContent = op.name;
                p.title = `${op.name}（${op.type}）`;
                row.appendChild(p);
            } else {
                row.appendChild(Object.assign(document.createElement('div'), { className: 'wf-port-spacer' }));
            }
            container.appendChild(row);
        }
        return container;
    }

    /** 测量端口圆点在节点内的锚点坐标（连线端点用；offsetParent = .wf-node） */
    _measurePortAnchors(node) {
        node.inAnchor = {};
        node.outAnchor = {};
        for (const p of node.el.querySelectorAll('.wf-port.in')) {
            const dot = p.querySelector('.wf-port-dot');
            node.inAnchor[p.dataset.name] = dot.offsetTop + dot.offsetHeight / 2;
        }
        for (const p of node.el.querySelectorAll('.wf-port.out')) {
            const dot = p.querySelector('.wf-port-dot');
            node.outAnchor[Number(p.dataset.slot)] = dot.offsetTop + dot.offsetHeight / 2;
        }
    }

    /** 设置选中集合（画布式多选；空集合 = 全部取消选中） */
    _setSelection(ids) {
        const next = new Set(ids);
        for (const el of this.worldEl.querySelectorAll('.wf-node.selected')) {
            if (!next.has(el.dataset.id)) {
                el.classList.remove('selected');
                el.style.zIndex = '';
            }
        }
        for (const id of next) {
            const el = this.worldEl.querySelector(`.wf-node[data-id="${CSS.escape(id)}"]`);
            if (el && !el.classList.contains('selected')) {
                el.classList.add('selected');
                el.style.zIndex = 10;   // 选中的节点置顶
            }
        }
        this.selectedIds = next;
    }

    _renderWidget(node, input) {
        const row = document.createElement('div');
        row.className = 'wf-node-row';
        const label = document.createElement('label');
        label.className = 'wf-node-label';
        label.textContent = input.name;
        label.title = input.name;
        row.appendChild(label);

        const cur = this.current;
        const commit = (v) => {
            if (String(v) === String(input.value)) return;
            input.value = v;
            cur.data[node.id].inputs[input.name] = v;
            this._markDirty();
        };

        let widget;
        // 模型文件枚举类字段（ckpt_name/unet_name/lora_name/sampler_name）：
        // 候选与画布节点同源（/api/comfy-node/models），即使 object_info
        // 拿不到该自定义节点也渲染成下拉
        let kind = input.kind;
        const modelOpts = this._modelOptionsFor(node.cls, input.name);
        if (modelOpts.length && kind !== 'combo' && kind !== 'bool') kind = 'combo';

        switch (kind) {
            case 'combo': {
                widget = document.createElement('select');
                for (const opt of this._comboOptions(input.spec, input.value, modelOpts)) {
                    const o = document.createElement('option');
                    o.value = String(opt);
                    o.textContent = String(opt);
                    widget.appendChild(o);
                }
                widget.value = String(input.value);
                widget.addEventListener('change', () => commit(widget.value));
                break;
            }
            case 'int':
            case 'float': {
                widget = document.createElement('input');
                widget.type = 'number';
                widget.step = input.kind === 'int' ? '1' : 'any';
                widget.value = input.value;
                const cfg = (input.spec && typeof input.spec[1] === 'object') ? input.spec[1] : {};
                if (typeof cfg.min === 'number') widget.min = cfg.min;
                if (typeof cfg.max === 'number') widget.max = cfg.max;
                widget.addEventListener('change', () => {
                    const n = Number(widget.value);
                    if (Number.isFinite(n)) commit(kind === 'int' ? Math.round(n) : n);
                });
                break;
            }
            case 'bool': {
                widget = document.createElement('input');
                widget.type = 'checkbox';
                widget.checked = !!input.value;
                widget.addEventListener('change', () => commit(widget.checked));
                break;
            }
            case 'string': {
                widget = document.createElement('textarea');
                widget.rows = 2;
                widget.value = input.value ?? '';
                widget.addEventListener('change', () => commit(widget.value));
                break;
            }
            default: {
                widget = document.createElement('input');
                widget.type = 'text';
                widget.value = input.value ?? '';
                widget.addEventListener('change', () => commit(widget.value));
            }
        }
        widget.className = 'wf-widget';
        row.appendChild(widget);

        // Comfy 步进控件形态：数值/枚举控件两端加 ◀▶ 微调箭头
        // （数值步长取 object_info 的 step，缺省 int=1 / float=0.1，按 min/max 钳制；
        //   枚举 = 候选循环步进，下拉仍可直接选择）
        if (kind === 'int' || kind === 'float' || kind === 'combo') {
            const opts = kind === 'combo' ? this._comboOptions(input.spec, input.value, modelOpts) : null;
            const cfg = (input.spec && typeof input.spec[1] === 'object') ? input.spec[1] : {};
            const numStep = Number(cfg.step) || (kind === 'int' ? 1 : 0.1);
            const clampNum = (v) => {
                if (typeof cfg.min === 'number') v = Math.max(cfg.min, v);
                if (typeof cfg.max === 'number') v = Math.min(cfg.max, v);
                return kind === 'int' ? Math.round(v) : Math.round(v * 1e6) / 1e6;
            };
            const stepBtn = (dir) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'wf-step-btn';
                b.textContent = dir < 0 ? '◀' : '▶';
                b.addEventListener('click', () => {
                    if (kind === 'combo') {
                        if (!opts.length) return;
                        const i = opts.findIndex((o) => String(o) === String(widget.value));
                        const ni = (i + dir + opts.length) % opts.length;
                        widget.value = String(opts[ni]);
                        commit(widget.value);
                    } else {
                        const cur = Number(widget.value) || 0;
                        const nv = clampNum(cur + dir * numStep);
                        widget.value = nv;
                        commit(nv);
                    }
                });
                return b;
            };
            row.insertBefore(stepBtn(-1), widget);
            row.appendChild(stepBtn(1));
        }
        return row;
    }

    // ==================== 连线 / 视图变换 ====================

    _updateEdges() {
        if (!this.current) return;
        // 连线层是一块以世界原点为中心、向四周各扩 SVG_PAD 的固定大画布：
        // 节点可以拖到任意坐标（含负数），动态按端点算宽高会在负坐标区
        // 裁掉线条（表现为线段局部消失），固定偏移则天然全覆盖
        const PAD = this.SVG_PAD;
        if (this.svgEl.getAttribute('width') === null) {
            this.svgEl.style.left = -PAD + 'px';
            this.svgEl.style.top = -PAD + 'px';
            this.svgEl.setAttribute('width', PAD * 2);
            this.svgEl.setAttribute('height', PAD * 2);
        }
        for (const edge of this.current.edges) {
            const from = this.current.nodes.find((n) => n.id === edge.from);
            const to = this.current.nodes.find((n) => n.id === edge.to);
            if (!from || !to || !edge.path) continue;
            // 端点 = 端口圆心：x 由端口行内边距决定（圆点距节点边缘 11px），
            // y 用渲染后实测的圆点纵坐标（缺端口时回退旧的 +15 兜底）
            const y1 = from.y + ((from.outAnchor || {})[edge.fromSlot] ?? 15) + PAD;
            const y2 = to.y + ((to.inAnchor || {})[edge.toName] ?? 15) + PAD;
            const x1 = from.x + from.w - 11 + PAD;
            const x2 = to.x + 11 + PAD;
            const dx = Math.max(40, Math.abs(x2 - x1) / 2);
            edge.path.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
            // Comfy 规则：连线颜色 = 源端 socket 类型色
            edge.path.style.stroke = edge.type ? wfSocketColor(edge.type) : '';
        }
    }

    _sizeSvg() { this._updateEdges(); }

    _applyView() {
        this.worldEl.style.transform =
            `translate(${this.view.tx}px, ${this.view.ty}px) scale(${this.view.scale})`;
    }

    _applyNodePos(node) {
        node.el.style.left = node.x + 'px';
        node.el.style.top = node.y + 'px';
    }

    _bindGraphControls() {
        // 滚轮缩放（以光标为中心）
        this.viewportEl.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = this.viewportEl.getBoundingClientRect();
            const mx = e.clientX - rect.left, my = e.clientY - rect.top;
            const old = this.view.scale;
            const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
            const scale = Math.min(2.5, Math.max(0.3, old * factor));
            // 保持光标下的世界坐标不动：world 点 p 的屏幕位 = tx + p*scale
            this.view.tx = mx - ((mx - this.view.tx) / old) * scale;
            this.view.ty = my - ((my - this.view.ty) / old) * scale;
            this.view.scale = scale;
            this._applyView();
            this._saveLayoutDebounced();
        }, { passive: false });

        // 与画布统一：中键拖动平移（覆盖节点上方也生效）
        this.viewportEl.addEventListener('mousedown', (e) => {
            if (e.button === 1) {
                e.preventDefault();
                this._startPan(e);
                return;
            }
            if (e.button !== 0) return;
            if (e.target.closest('.wf-node')) return;   // 节点内部由节点自己处理
            e.preventDefault();
            this._startMarquee(e);   // 左键空白处框选
        });
    }

    /** 中键平移视图（画布同款） */
    _startPan(e) {
        const startX = e.clientX, startY = e.clientY;
        const { tx, ty } = this.view;
        const move = (ev) => {
            if (!(ev.buttons & 4)) return;   // 中键已松开时中止（防事件丢失卡拖）
            this.view.tx = tx + ev.clientX - startX;
            this.view.ty = ty + ev.clientY - startY;
            this._applyView();
        };
        const up = () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            this._saveLayoutDebounced();
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
    }

    /** 左键空白处框选（橡皮筋矩形，选中相交节点；原地点击 = 取消选中） */
    _startMarquee(e) {
        const rect = this.viewportEl.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        const marquee = document.createElement('div');
        marquee.className = 'wf-editor-marquee';
        marquee.style.display = 'none';
        this.viewportEl.appendChild(marquee);
        let moved = false;

        const move = (ev) => {
            const cx = ev.clientX - rect.left, cy = ev.clientY - rect.top;
            if (Math.abs(cx - sx) > 3 || Math.abs(cy - sy) > 3) moved = true;
            marquee.style.display = moved ? 'block' : 'none';
            marquee.style.left = Math.min(sx, cx) + 'px';
            marquee.style.top = Math.min(sy, cy) + 'px';
            marquee.style.width = Math.abs(cx - sx) + 'px';
            marquee.style.height = Math.abs(cy - sy) + 'px';
        };
        const up = (ev) => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            marquee.remove();
            if (!this.current) return;
            if (!moved) {
                this._setSelection([]);   // 原地左键点击空白 = 取消选中
                return;
            }
            // 屏幕矩形 → 世界坐标矩形，收集相交节点
            const cx = ev.clientX - rect.left, cy = ev.clientY - rect.top;
            const { tx, ty, scale } = this.view;
            const wx1 = (Math.min(sx, cx) - tx) / scale, wy1 = (Math.min(sy, cy) - ty) / scale;
            const wx2 = (Math.max(sx, cx) - tx) / scale, wy2 = (Math.max(sy, cy) - ty) / scale;
            const hits = this.current.nodes
                .filter((n) => n.x < wx2 && n.x + n.w > wx1 && n.y < wy2 && n.y + n.h > wy1)
                .map((n) => n.id);
            this._setSelection(hits);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
    }

    /** 拖动全部选中的节点（mousedown 时各节点记起始位置，统一加位移） */
    _startNodeDrag(e) {
        const nodes = this.current.nodes.filter((n) => this.selectedIds.has(n.id));
        if (!nodes.length) return;
        for (const n of nodes) n.el.classList.add('dragging');
        const rect = this.viewportEl.getBoundingClientRect();
        const startWorldX = (e.clientX - rect.left - this.view.tx) / this.view.scale;
        const startWorldY = (e.clientY - rect.top - this.view.ty) / this.view.scale;
        const startPos = new Map(nodes.map((n) => [n, { x: n.x, y: n.y }]));
        const move = (ev) => {
            const worldX = (ev.clientX - rect.left - this.view.tx) / this.view.scale;
            const worldY = (ev.clientY - rect.top - this.view.ty) / this.view.scale;
            const dx = worldX - startWorldX, dy = worldY - startWorldY;
            for (const [n, p] of startPos) {
                n.x = p.x + dx;
                n.y = p.y + dy;
                this._applyNodePos(n);
            }
            this._updateEdges();
        };
        const up = () => {
            for (const n of nodes) {
                n.el.classList.remove('dragging');
                this.current.positions[n.id] = { x: Math.round(n.x), y: Math.round(n.y) };
            }
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            this._saveLayoutDebounced();
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
    }

    // ==================== 保存 ====================

    _markDirty() {
        this.dirty = true;
        this.dirtyEl.textContent = '● 未保存';
    }

    _renderState() {
        this.titleEl.textContent = this.current ? this.current.name : '';
        this.dirtyEl.textContent = '';
        this.saveBtn.disabled = false;
    }

    async save() {
        if (!this.current) return;
        this.saveBtn.disabled = true;
        this.saveBtn.textContent = '保存中…';
        try {
            const res = await fetch(`/api/workflows/${encodeURIComponent(this.current.id)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workflow: this.current.data })
            });
            const data = await res.json();
            if (data.status !== 'ok') throw new Error(data.message || '保存失败');
            this.dirty = false;
            this.dirtyEl.textContent = '';
            this.saveBtn.textContent = '已保存 ✓';
            setTimeout(() => { this.saveBtn.textContent = '保存'; }, 1500);
        } catch (err) {
            alert('保存失败: ' + err.message);
            this.saveBtn.textContent = '保存';
        } finally {
            this.saveBtn.disabled = false;
        }
    }

    _saveLayoutDebounced() {
        if (!this.current) return;
        clearTimeout(this._layoutTimer);
        setTimeout(() => {
            fetch(`/api/workflows/${encodeURIComponent(this.current.id)}/layout`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    positions: this.current.positions,
                    view: { scale: this.view.scale, tx: this.view.tx, ty: this.view.ty },
                    bypassed: [...this.current.bypassed]
                })
            }).catch(() => { /* 布局保存失败不阻塞 */ });
        }, 600);
    }

    resetLayout() {
        if (!this.current) return;
        this.current.positions = {};
        delete this.current.savedView;
        this.view = { scale: 1, tx: 40, ty: 40 };
        this._setSelection([]);
        this.renderGraph();
        this._saveLayoutDebounced();
    }
}

window.WorkflowEditor = WorkflowEditor;
