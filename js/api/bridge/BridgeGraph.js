/**
 * ==========================================================================
 * LumenSocket 子模块：桥接命令·节点运维与搭图（自 LumenSocket.js 拆出）
 * 作用：节点工作流的「搭→跑→改→再跑」闭环——node_update（改文本/模型/
 *       工作流/数量/比例档位/质量/标量参数/LoRA 条目/标题/位置，按节点
 *       类型取用并走与手编同款的控件事件路径）、node_delete（Delete 键
 *       同款 deleteObjects，撤销可回退）、node_run（触发生成，fire-and-
 *       forget）、edge_disconnect（断连线）；build_graph（一次性建多节点
 *       + 连线：类型白名单建表 / 工作流引用预校验 / 缺坐标自动分层布局 /
 *       端点引用名或画布 id 解析 + isValidLink 校验）。
 * 契约：原型混入（partial-class，ADR 027）——方法 Object.assign 进
 *       LumenSocket.prototype，this 即 socket 实例；须后于主类文件加载。
 *       BUILD_NODE_TYPES 是类静态（节点类型 → 创建器与布局默认几何），
 *       混入文件直接挂 window.LumenSocket 静态属性。
 * ==========================================================================
 */

Object.assign(window.LumenSocket.prototype, {

    // ==================== 节点运维（canvas_node_ops 工具） ====================

    /**
     * node_update：改已有节点。每类字段有节点类型守卫，文本/模型等走
     * 控件 + change 事件路径（与用户手编同一条路，联动全部复用）
     */
    async _bridgeNodeUpdate(params) {
        const c = this.canvas;
        const node = this._findBridgeNode(params.nodeId);
        const src = node.source;
        const changes = [];
        // 提示词/文本节点的文本：属性与输入框双向同步（generate 收集链路
        // 读属性，UI 显示读输入框，两边都要写），并派发与 blur 同款的
        // 变更事件保持与手工编辑一致的外部可观测性
        if (params.text !== undefined) {
            if (!NodeTypes.isPromptNode(src) && !NodeTypes.isTextNode(src)) {
                throw new Error('text 参数只适用于 prompt / text 节点');
            }
            // 文本修改不进撤销栈（与用户在输入框手打一致；recordValue 的
            // 裸赋值 undo 会漏掉 inputEl 双轨同步，不能用）
            node.text = String(params.text);
            if (node.inputEl) node.inputEl.value = node.text;
            window.dispatchEvent(new CustomEvent('promptNodeTextChanged', {
                detail: { node, text: node.text }
            }));
            changes.push('text');
        }
        // image_gen 换模型：走下拉控件 + change 事件（与用户手选同一条
        // 路径，模型属性/质量档位联动全部复用）；值不在选项里则明确报错
        if (params.model !== undefined) {
            if (!NodeTypes.isImageGenNode(src)) throw new Error('model 参数只适用于 image_gen 节点');
            const key = String(params.model);
            node.modelSelect.value = key;
            if (node.modelSelect.value !== key) {
                throw new Error(`模型「${key}」不在该节点的可选清单中（值为厂商||模型ID 复合键）`);
            }
            node.modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
            changes.push('model');
        }
        // comfy_gen 换工作流：onWorkflowChange 拉取工作流 JSON 并重建
        // 动态参数行（异步，旧参数行作废）
        if (params.workflowId !== undefined) {
            if (!NodeTypes.isComfyGenNode(src)) throw new Error('workflowId 参数只适用于 comfy_gen 节点');
            const wid = String(params.workflowId);
            if (!node.workflows?.some(wf => String(wf.id) === wid)) {
                throw new Error(`工作流「${wid}」不在可选清单中（先用 canvas_list_workflows 查询）`);
            }
            node.workflowId = wid;
            node.workflowSelect.value = wid;
            await node.onWorkflowChange();
            changes.push('workflowId');
        }
        // 生图节点的数量：属性为准（generate 读 this.count），同步步进器显示
        if (params.count !== undefined) {
            if (!NodeTypes.isGenNode(src)) throw new Error('count 参数只适用于生图节点');
            const n = parseInt(params.count, 10);
            if (!Number.isFinite(n) || n < 1) throw new Error('count 须为正整数');
            node.count = Math.min(9999, n);
            node.countStepper?.sync();
            changes.push('count');
        }
        // 任意节点的标题（双击重命名同款路径）
        if (params.title !== undefined) {
            node.setTitle?.(String(params.title));
            changes.push('title');
        }
        // image_gen 的比例/档位：sizePicker 状态是纯属性（generate 直接
        // 读 getRatio/getTier），赋值后 render 同步下拉显示
        if (params.ratio !== undefined || params.tier !== undefined) {
            if (!NodeTypes.isImageGenNode(src)) throw new Error('ratio/tier 参数只适用于 image_gen 节点');
            if (params.ratio !== undefined) node.sizePicker.ratio = String(params.ratio);
            if (params.tier !== undefined) node.sizePicker.tier = String(params.tier);
            node.sizePicker.render?.();
            changes.push('ratio/tier');
        }
        // image_gen 的质量档位（仅支持 quality 参数的模型生效，
        // 不支持的模型该行本就隐藏）
        if (params.quality !== undefined) {
            if (!NodeTypes.isImageGenNode(src)) throw new Error('quality 参数只适用于 image_gen 节点');
            if (node.qualitySelect) node.qualitySelect.value = String(params.quality);
            changes.push('quality');
        }
        // comfy_gen 的标量参数：setState 未提供的字段保持当前值
        // （部分更新语义，官方外部回填入口），render 重建参数行
        {
            const comfyKeys = ['steps', 'cfg', 'sampler', 'sizeW', 'sizeH', 'denoise'];
            const patch = {};
            for (const k of comfyKeys) {
                if (params[k] !== undefined) patch[k] = params[k];
            }
            if (Object.keys(patch).length > 0) {
                if (!NodeTypes.isComfyGenNode(src)) {
                    throw new Error(`${Object.keys(patch).join('/')} 参数只适用于 comfy_gen 节点`);
                }
                node.params.setState(patch);
                node.params.render();
                changes.push(Object.keys(patch).join('/'));
            }
        }
        // lora 节点条目整体替换：规范化入参（与 build_graph 同构），
        // renderEntries 全量重建条目 DOM
        if (params.entries !== undefined) {
            if (!NodeTypes.isLoraNode(src)) throw new Error('entries 参数只适用于 lora 节点');
            const list = Array.isArray(params.entries) ? params.entries : null;
            if (!list) throw new Error('entries 须为数组');
            node.entries = list.map(e => ({
                id: LumenLight.generateId(),
                file: e.file || '',
                strengthModel: Number.isFinite(+e.strengthModel) ? +e.strengthModel : 1,
                strengthClip: Number.isFinite(+e.strengthClip) ? +e.strengthClip : 1
            }));
            node.renderEntries();
            changes.push('entries');
        }
        // 任意节点的位置：快照入撤销栈（与拖拽手势同构）
        if (params.x !== undefined || params.y !== undefined) {
            const from = { x: node.x, y: node.y };
            if (Number.isFinite(+params.x)) node.x = +params.x;
            if (Number.isFinite(+params.y)) node.y = +params.y;
            if (from.x !== node.x || from.y !== node.y) {
                c.history?.recordGeometry([{ obj: node, from, to: { x: node.x, y: node.y } }], '移动节点');
            }
            node.updateTransform?.();
            changes.push('position');
        }
        if (changes.length === 0) {
            throw new Error('没有可更新的字段（支持 text/title/model/ratio/tier/quality/workflowId/count/steps/cfg/sampler/sizeW/sizeH/denoise/entries/x/y，按节点类型取用）');
        }
        c.draw();
        return { nodeId: node.id, type: src, changes };
    },

    /**
     * node_delete：deleteObjects 完整处理节点删除（toJSON 快照 + DOM 销毁 +
     * 连线清理 + 撤销可回退，与 Delete 键同一条路径）
     */
    async _bridgeNodeDelete(params) {
        const c = this.canvas;
        const node = this._findBridgeNode(params.nodeId);
        c.history?.deleteObjects([node], [], { label: '删除节点' });
        c.draw();
        return { deleted: true, nodeId: params.nodeId };
    },

    /**
     * node_run：触发生成（fire-and-forget：生成是长流程，占位图→WS 回流
     * 真图，不挂住桥接应答；产物完成后自动落画布，agent 稍后 get_state 查看）
     */
    async _bridgeNodeRun(params) {
        const c = this.canvas;
        const node = this._findBridgeNode(params.nodeId);
        if (!NodeTypes.isGenNode(node.source)) {
            throw new Error('只有生图节点（image_gen / comfy_gen / runhub_gen）可以触发生成');
        }
        if (node.isGenerating) throw new Error('该节点正在生成中，请等待完成后再触发');
        // 前置检查：generate() 内部不满足时只弹通知静默返回，agent 侧
        // 拿不到失败信号——这里显式抛错让失败可感知
        const prompt = node.collectPrompt?.() || '';
        if (!prompt) throw new Error('节点没有连入提示词链（先检查 get_state 的 edges）');
        if (NodeTypes.isImageGenNode(node.source) && !node.modelSelect.value) {
            throw new Error('节点未选择生图模型（先经 node_update 设置 model）');
        }
        node.generate();
        return {
            started: true,
            nodeId: node.id,
            note: '已触发生成，完成后图片自动落画布（占位图先行）；稍后用 get_state 查看结果，不要立即轮询'
        };
    },

    /** edge_disconnect：按 edgeId 或 from+to 断开连线（remove 自带撤销记账） */
    async _bridgeEdgeDisconnect(params) {
        const c = this.canvas;
        let conn = null;
        if (params.edgeId) {
            conn = c.connections.connections.find(cn => cn.id === params.edgeId);
        } else if (params.from && params.to) {
            conn = c.connections.connections.find(cn =>
                cn.fromId === params.from && cn.toId === params.to);
        } else {
            throw new Error('缺少定位参数：edgeId 或 from+to 至少提供一组');
        }
        if (!conn) throw new Error('未找到指定连线（拓扑见 get_state 的 edges）');
        // remove 内部自带撤销记账（recordConnectionRemove）
        c.connections.remove(conn.id);
        c.draw();
        return { removed: true, from: conn.fromId, to: conn.toId };
    },

    // ==================== 搭图（build_graph 命令） ====================

    /** build_graph：一次性创建多个画布节点并按 edges 连线（见 _execBuildGraph） */
    async _bridgeBuildGraph(params) {
        return this._execBuildGraph(params);
    },

    /**
     * build_graph 命令主体：返回创建清单与失败连线明细（无效连线逐条报告，
     * 不中断已有效的创建/连线）。数据流方向：提示词/LoRA → 生图节点
     * （与画布拖拽连线同一套规则，CanvasConnections.isValidLink 校验）。
     * @param {Object} params - { nodes: [{id?, type, x?, y?, width?, height?, ...props}],
     *                           edges: [{from, to}] }
     */
    async _execBuildGraph(params) {
        const c = this.canvas;
        const input = Array.isArray(params?.nodes) ? params.nodes : [];
        const edges = Array.isArray(params?.edges) ? params.edges : [];
        if (input.length === 0) throw new Error('缺少 nodes 数组');
        if (input.length > 20) throw new Error('单次最多创建 20 个节点，更大规模请分批搭建');

        // ===== 1. 规范化定义（类型白名单 + 引用名唯一） =====
        const TYPE_DEFS = LumenSocket.BUILD_NODE_TYPES();
        const defs = [];
        const refSet = new Set();
        input.forEach((n, i) => {
            if (!n || typeof n !== 'object') throw new Error(`nodes[${i}] 不是对象`);
            const def = TYPE_DEFS[n.type];
            if (!def) {
                throw new Error(`nodes[${i}].type「${n.type}」无效，可用类型: ${Object.keys(TYPE_DEFS).join(' / ')}`);
            }
            const ref = String(n.id || `n${i + 1}`).trim();
            if (refSet.has(ref)) throw new Error(`节点引用名「${ref}」重复`);
            refSet.add(ref);
            defs.push({
                ref, type: n.type, def, n,
                x: Number.isFinite(n.x) ? n.x : undefined,
                y: Number.isFinite(n.y) ? n.y : undefined,
                width: Number.isFinite(n.width) ? n.width : undefined,
                height: Number.isFinite(n.height) ? n.height : undefined
            });
        });

        // ===== 2. 工作流引用预校验（任何节点创建前拦截，给出可用清单） =====
        await this._validateWorkflowRefs(defs);

        // ===== 3. 布局：缺坐标的节点按连线深度自动分层 =====
        this._layoutGraphNodes(defs, edges, c);

        // ===== 4. 创建节点 =====
        const refToId = new Map();
        const created = [];
        for (const d of defs) {
            const node = d.def.create(d, c);
            c.images.images.push(node);
            refToId.set(d.ref, node.id);
            created.push({
                ref: d.ref, id: node.id, type: d.type,
                x: Math.round(node.x), y: Math.round(node.y),
                width: Math.round(node.width), height: Math.round(node.height)
            });
        }

        // ===== 5. 连线：端点优先按本次引用名解析，其余按画布对象 id（可连接到既有节点） =====
        const failedEdges = [];
        for (const e of edges) {
            const fail = (reason) => failedEdges.push({ from: e.from, to: e.to, reason });
            const fromId = refToId.get(e.from) || e.from;
            const toId = refToId.get(e.to) || e.to;
            const fromObj = c.images.images.find(img => img.id === fromId);
            const toObj = c.images.images.find(img => img.id === toId);
            if (!fromObj || !toObj) { fail('端点不存在（引用名或画布节点 id 无效）'); continue; }
            if (!CanvasConnections.isValidLink(fromObj, toObj)) {
                fail('连线规则不允许（提示词/LoRA→提示词/LoRA/生图；生图节点无输出端口）');
                continue;
            }
            if (!c.connections.add(fromId, toId)) fail('重复连线（同一对端点已连接）');
        }

        c.draw();
        return {
            created,
            connected: edges.length - failedEdges.length,
            failedEdges
        };
    },

    /**
     * build_graph 的工作流引用预校验：comfy_gen 校验本地工作流清单、
     * runhub_gen 校验登记卡清单。清单接口不可达时跳过校验（节点自身
     * 对无效 id 有回退行为），校验失败则在任何创建发生前抛出可读错误
     * @param {Array} defs - 规范化节点定义
     */
    async _validateWorkflowRefs(defs) {
        const comfy = defs.filter(d => d.type === 'comfy_gen' && d.n.workflowId);
        if (comfy.length) {
            try {
                const res = await fetch('/api/workflows');
                const json = await res.json();
                const valid = new Set((json.workflows || []).map(w => String(w.id)));
                if (valid.size) {
                    for (const d of comfy) {
                        if (!valid.has(String(d.n.workflowId))) {
                            throw new Error(
                                `comfy_gen「${d.ref}」的 workflowId「${d.n.workflowId}」不存在，可用: ${[...valid].join(', ')}`);
                        }
                    }
                }
            } catch (err) {
                if (err.message && err.message.includes('workflowId')) throw err;
                // 清单接口失败：跳过校验，交由节点自身的回退逻辑处理
            }
        }
        const rh = defs.filter(d => d.type === 'runhub_gen' && d.n.workflowId);
        if (rh.length) {
            try {
                const res = await fetch('/api/runninghub/workflows');
                const json = await res.json();
                const valid = new Set((json.workflows || []).map(w => String(w.id)));
                if (valid.size) {
                    for (const d of rh) {
                        const wid = String(d.n.workflowId);
                        if (!valid.has(wid)) {
                            throw new Error(
                                `runhub_gen「${d.ref}」的 workflowId「${d.n.workflowId}」不在登记卡中，可用: ${[...valid].join(', ')}`);
                        }
                    }
                }
            } catch (err) {
                if (err.message && err.message.includes('workflowId')) throw err;
            }
        }
    },

    /**
     * build_graph 的自动布局：显式给了 x/y 的节点原样保留；缺坐标的节点
     * 按新建节点之间引用边的最长路径分层（列=深度，行=同列堆叠），整体
     * 居中于当前视口。引用边成环时抛错拒绝布局
     * @param {Array} defs - 规范化节点定义（布局结果直接写回 d.x/d.y）
     * @param {Array} edges - 连线定义 [{from, to}]
     */
    _layoutGraphNodes(defs, edges, c) {
        if (defs.every(d => d.x !== undefined && d.y !== undefined)) return;
        const auto = defs.filter(d => d.x === undefined || d.y === undefined);

        // 最长路径分层（松弛迭代，上限节点数次；未收敛 = 有环）
        const depth = new Map(auto.map(d => [d.ref, 0]));
        const refSet = new Set(auto.map(d => d.ref));
        const rel = edges
            .filter(e => refSet.has(e.from) && refSet.has(e.to))
            .map(e => [e.from, e.to]);
        for (let i = 0; i < auto.length; i++) {
            let changed = false;
            for (const [f, t] of rel) {
                if (depth.get(t) < depth.get(f) + 1) {
                    depth.set(t, depth.get(f) + 1);
                    changed = true;
                }
            }
            if (!changed) break;
            if (i === auto.length - 1) throw new Error('edges 在新建节点之间形成环，无法布局');
        }

        // 分列（深度→列，列号连续），列内纵向堆叠、各列纵向居中，整体锚定视口中心
        const cols = [];
        for (const d of auto) {
            const k = depth.get(d.ref);
            (cols[k] = cols[k] || []).push(d);
        }
        const GAP_X = 80, GAP_Y = 40;
        const compact = cols.filter(Boolean);
        const colW = compact.map(col => Math.max(...col.map(d => d.width || d.def.w)));
        const colStackH = compact.map(col =>
            col.reduce((a, d) => a + (d.height || d.def.h), 0) + GAP_Y * (col.length - 1));
        const totalW = colW.reduce((a, b) => a + b, 0) + GAP_X * (compact.length - 1);
        const dpr = c.dpr || 1;
        const centerX = (-c.viewport.offsetX + c.canvas.width / 2 / dpr) / c.viewport.scale;
        const centerY = (-c.viewport.offsetY + c.canvas.height / 2 / dpr) / c.viewport.scale;
        let x = centerX - totalW / 2;
        for (let k = 0; k < compact.length; k++) {
            let y = centerY - colStackH[k] / 2;
            for (const d of compact[k]) {
                d.x = x;
                d.y = y;
                y += (d.height || d.def.h) + GAP_Y;
            }
            x += colW[k] + GAP_X;
        }
    },

    /**
     * 按画布对象 id 查找 DOM 节点（提示词/文本/LoRA/生图节点）。
     * 节点运维命令（node_update / node_delete / node_run）的公共入口。
     * @param {string} nodeId - 画布对象 id（get_state 的 nodes[].id）
     * @param {Object} [options] - { optional: true } 时找不到返回 null 而非抛错
     * @returns {Object} 节点对象
     */
    _findBridgeNode(nodeId, options = {}) {
        if (!nodeId) throw new Error('缺少 nodeId 参数');
        const node = this.canvas.images.images.find(img =>
            img.id === nodeId && NodeTypes.isPanelNode(img.source));
        if (!node) {
            if (options.optional) return null;
            throw new Error(`未找到 id 为「${nodeId}」的画布节点（清单见 get_state 的 nodes）`);
        }
        return node;
    },
});

// build_graph 节点类型表（类静态）：桥接入参类型名 → 创建器与布局默认几何。
// 创建复用各节点类的存档恢复契约（与 ProjectSerializer.restoreNodes 同一
// 构造路径），保证 agent 建出的节点与手建/存档恢复的完全同构
window.LumenSocket.BUILD_NODE_TYPES = function () {
    const clampCount = (v) => {
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? Math.max(1, Math.min(9999, n)) : undefined;
    };
    return {
        prompt: {
            w: PromptNode.DEFAULT_WIDTH, h: PromptNode.DEFAULT_HEIGHT,
            create: (d, c) => new PromptNode(c, d.x, d.y, (d.n.text || '').trim(),
                { width: d.width, height: d.height })
        },
        text: {
            w: TextNode.DEFAULT_WIDTH, h: TextNode.DEFAULT_HEIGHT,
            create: (d, c) => new TextNode(c, d.x, d.y, (d.n.text || ''),
                { width: d.width, height: d.height })
        },
        lora: {
            w: LoraNode.DEFAULT_WIDTH, h: LoraNode.DEFAULT_HEIGHT,
            create: (d, c) => new LoraNode(c, d.x, d.y, {
                width: d.width, height: d.height,
                entries: (Array.isArray(d.n.entries) ? d.n.entries : []).map(e => ({
                    id: LumenLight.generateId(),
                    file: e.file || '',
                    strengthModel: Number.isFinite(+e.strengthModel) ? +e.strengthModel : 1,
                    strengthClip: Number.isFinite(+e.strengthClip) ? +e.strengthClip : 1
                }))
            })
        },
        image_gen: {
            w: ImageGenNode.DEFAULT_WIDTH, h: ImageGenNode.DEFAULT_HEIGHT,
            create: (d, c) => new ImageGenNode(c, d.x, d.y, {
                width: d.width, height: d.height,
                model: d.n.model, ratio: d.n.ratio, tier: d.n.tier,
                quality: d.n.quality, count: clampCount(d.n.count)
            })
        },
        comfy_gen: {
            w: ComfyGenNode.DEFAULT_WIDTH, h: ComfyGenNode.DEFAULT_HEIGHT,
            create: (d, c) => new ComfyGenNode(c, d.x, d.y, {
                width: d.width, height: d.height,
                workflowId: d.n.workflowId, count: clampCount(d.n.count),
                loraEnabled: d.n.loraEnabled, steps: d.n.steps, cfg: d.n.cfg,
                sampler: d.n.sampler, sizeW: d.n.sizeW, sizeH: d.n.sizeH,
                denoise: d.n.denoise
            })
        },
        runhub_gen: {
            w: RunningHubGenNode.DEFAULT_WIDTH, h: RunningHubGenNode.DEFAULT_HEIGHT,
            create: (d, c) => new RunningHubGenNode(c, d.x, d.y, {
                width: d.width, height: d.height,
                workflowId: d.n.workflowId, values: d.n.values,
                count: clampCount(d.n.count)
            })
        }
    };
};
