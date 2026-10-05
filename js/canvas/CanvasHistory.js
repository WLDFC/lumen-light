/**
 * ==========================================================================
 * LumenLight 画布历史（撤销/重做）
 * ==========================================================================
 * 作用：画布结构操作的命令栈——Ctrl+Z 撤销 / Ctrl+Shift+Z、Ctrl+Y 重做。
 *       命令式（每步操作记录 undo/redo 闭包）而非全量快照：画布图片是
 *       重对象（Image 元素 + data URL），快照栈会撑爆内存；命令只存
 *       "这一步怎么退回去"。
 *
 * 设计要点：
 *   - 位图/视频对象删除后保留原对象引用（Image 元素仍在内存），撤销时
 *     按原数组下标放回，id 不变、连线无需重映射（z 序近似还原：select()
 *     会重排数组，原下标只保证大致层位）；
 *   - DOM 节点（提示词/生图等）destroy() 不可逆（autocomplete/看门狗等
 *     内部组件被拆除，无再挂载路径），删除时捕获 toJSON() 快照，撤销走
 *     重建路径（同 ProjectSerializer.restoreNodes 的 type 分发，新 id）。
 *     新旧 id 记入 _idRemap，连线命令执行时经 _resolveId 换算——同一节点
 *     多轮撤销/重做后，先后建立的连线依然指向正确的对象；
 *   - 视频工作区文件清理（DELETE /api/videos）延迟到命令被淘汰时执行：
 *     "删除→撤销"后文件还在、视频不死链；始终不清理的（剪切）与漏网的
 *     （关页前未淘汰）由保存时的后端引用 GC 兜底回收；
 *   - 撤销/重做结束调 canvas.draw()——CanvasChangeWatcher 挂在 draw 上，
 *     实时保存自动标脏，无需额外接线；
 *   - 存档打开/恢复/新建画布走 setSuspended(true) + clear()：全量恢复
 *     期间的 add 等调用不记账，旧栈整体作废。
 * ==========================================================================
 */

class CanvasHistory {
    /** 栈上限：命令只持引用与小快照；大头是被删除位图的存活引用
     *  （Image 元素 + data URL 字符串），50 步封顶控制最坏情况内存 */
    static MAX = 50;

    /**
     * @param {Canvas} canvas - 画布主类实例
     */
    constructor(canvas) {
        this.canvas = canvas;
        this._undoStack = [];
        this._redoStack = [];
        this._applying = false;      // undo/redo 执行期间为 true，记录点据此跳过
        this._suspended = false;     // 存档恢复等批量操作期间挂起记录
        this._idRemap = new Map();   // 节点重建的旧 id → 新 id（连线执行时换算）
        // 视频清理接线：淘汰命令里被延迟清理的视频 url → 真正发起后端删除
        // （由 Canvas.init 注入，避免本模块直接依赖后端接口）
        this.onFlushVideoFile = null;
    }

    get canUndo() { return this._undoStack.length > 0; }
    get canRedo() { return this._redoStack.length > 0; }
    /** 是否处于记账状态（非撤销执行中、非存档恢复挂起中） */
    get recording() { return !this._applying && !this._suspended; }

    /** 解析 id：节点重建后旧 id 经映射表换算（无映射时原样返回） */
    _resolveId(id) { return this._idRemap.get(id) || id; }

    /** 连线记录的执行期副本：id 原样，两端 id 经映射换算 */
    _resolveConn(c) {
        return { id: c.id, fromId: this._resolveId(c.fromId), toId: this._resolveId(c.toId), order: c.order };
    }

    // ==================== 栈操作 ====================

    /**
     * 压入一条命令（调用方先自行执行 do 动作再 push）
     * @param {{label: string, undo: Function, redo: Function, onEvict?: Function}} cmd
     */
    push(cmd) {
        if (this._applying) return;   // 撤销/重做执行期间不入栈（防记录递归）
        if (!cmd || typeof cmd.undo !== 'function' || typeof cmd.redo !== 'function') return;
        // 新操作截断重做分支：被截断的命令立即淘汰（视频清理等收尾）
        for (const c of this._redoStack) this._evict(c);
        this._redoStack = [];
        this._undoStack.push(cmd);
        if (this._undoStack.length > CanvasHistory.MAX) {
            this._evict(this._undoStack.shift());
        }
        this._notify();
    }

    /** 命令淘汰收尾（视频文件清理等），异常吞掉不影响栈运转 */
    _evict(cmd) {
        try {
            if (typeof cmd.onEvict === 'function') cmd.onEvict();
        } catch (err) {
            console.warn('[history] 命令淘汰收尾失败:', err);
        }
    }

    /**
     * 撤销最近一步
     * @returns {boolean} 是否执行了撤销
     */
    undo() {
        if (!this.canUndo || this._applying) return false;
        const cmd = this._undoStack.pop();
        this._applying = true;
        try { cmd.undo(); } catch (err) { console.error('[history] 撤销失败:', err); }
        this._applying = false;
        this._redoStack.push(cmd);
        this.canvas.draw();
        this._toast('已撤销：' + cmd.label);
        this._notify();
        return true;
    }

    /**
     * 重做最近一步被撤销的操作
     * @returns {boolean} 是否执行了重做
     */
    redo() {
        if (!this.canRedo || this._applying) return false;
        const cmd = this._redoStack.pop();
        this._applying = true;
        try { cmd.redo(); } catch (err) { console.error('[history] 重做失败:', err); }
        this._applying = false;
        this._undoStack.push(cmd);
        this.canvas.draw();
        this._toast('已重做：' + cmd.label);
        this._notify();
        return true;
    }

    /**
     * 清空历史（存档打开/恢复/新建画布）：全部按淘汰处理（视频清理收尾），
     * id 映射一并作废
     */
    clear() {
        for (const c of [...this._undoStack, ...this._redoStack]) this._evict(c);
        this._undoStack = [];
        this._redoStack = [];
        this._idRemap.clear();
        this._notify();
    }

    /** 存档恢复等批量操作期间挂起/恢复记账 */
    setSuspended(on) { this._suspended = !!on; }

    _notify() {
        window.dispatchEvent(new CustomEvent('canvasHistoryChanged', {
            detail: { canUndo: this.canUndo, canRedo: this.canRedo }
        }));
    }

    // ==================== 记录工厂（各管理器调用） ====================

    /**
     * 新增记录：对象刚被推入 images 数组后调用。
     * 位图/视频 undo=原对象摘下、redo=按下标放回；DOM 节点 undo=摘下并
     * destroy、redo=从 toJSON 快照重建（新 id 记入映射表）。
     * @param {Object[]} objs - 新增的画布对象（位图/视频/面板节点混排）
     * @param {string} [label]
     */
    recordCreate(objs, label = '添加') {
        if (!this.recording) return;
        const im = this.canvas.images;
        const items = (objs || []).filter(Boolean).map(obj => {
            const isNode = typeof obj.toJSON === 'function' && NodeTypes.isPanelNode(obj.source);
            return isNode
                ? { kind: 'node', json: obj.toJSON(), node: obj, index: im.images.indexOf(obj) }
                : { kind: 'image', obj, index: im.images.indexOf(obj) };
        });
        if (items.length === 0) return;

        this.push({
            label,
            undo: () => {
                for (const it of items) {
                    const obj = it.kind === 'node' ? it.node : it.obj;
                    const idx = im.images.indexOf(obj);
                    if (idx > -1) im.images.splice(idx, 1);
                    im.selectedIds.delete(obj.id);
                    if (it.kind === 'node') { obj.destroy(); it.node = null; }
                }
            },
            redo: () => {
                for (const it of items) {
                    if (it.kind === 'node') {
                        const node = this._recreateNode(it.json);
                        if (!node) continue;
                        it.node = node;
                        im.images.splice(Math.min(it.index, im.images.length), 0, node);
                    } else if (!im.images.includes(it.obj)) {
                        im.images.splice(Math.min(it.index, im.images.length), 0, it.obj);
                    }
                }
            }
        });
    }

    /**
     * 删除记录 + 执行：Delete 键、剪切、agent 批量清除共用。
     * 捕获先行（toJSON/原下标/相连连线/组引用），随后执行与原删除循环
     * 等价的清理，最后入栈。视频文件清理延迟到命令淘汰（剪切完全跳过，
     * 文件留给剪贴板里的引用）。
     * @param {Object[]} objects - 待删除画布对象
     * @param {Object[]} [groups] - 待删除组（只删壳）
     * @param {{label?: string, fileCleanup?: 'defer'|'skip'}} [opts]
     */
    deleteObjects(objects, groups = [], opts = {}) {
        const im = this.canvas.images;
        const cs = this.canvas.connections;
        const objs = (objects || []).filter(o => im.images.includes(o));
        const groupRefs = (groups || []).filter(g => this.canvas.groups.groups.includes(g));
        if (objs.length === 0 && groupRefs.length === 0) return false;

        // 捕获（先于任何破坏动作）：节点存快照，位图存活引用 + 原下标；
        // 连线按对象 id 收集（对象删除后由 prune 也会清，但显式捕获才能撤销）
        const entries = objs.map(obj => {
            const isNode = typeof obj.toJSON === 'function' && NodeTypes.isPanelNode(obj.source);
            const base = {
                kind: isNode ? 'node' : 'image',
                index: im.images.indexOf(obj),
                conns: cs.connections.filter(c => c.fromId === obj.id || c.toId === obj.id)
            };
            return isNode ? { ...base, json: obj.toJSON(), node: obj, currentObj: null } : { ...base, obj };
        });
        const videoUrls = objs
            .filter(o => NodeTypes.isVideo(o.source) && o.videoUrl && o.videoUrl.includes('data/videos'))
            .map(o => o.videoUrl);

        const cmd = {
            label: opts.label || '删除',
            videoUrls: opts.fileCleanup === 'skip' ? [] : videoUrls,
            undo: () => this._restoreDeleted(entries, groupRefs),
            redo: () => this._deleteEntries(entries, groupRefs)
        };
        if (cmd.videoUrls.length > 0) {
            cmd.onEvict = () => { for (const url of cmd.videoUrls) this.onFlushVideoFile?.(url); };
        }

        // 执行删除（与原 Delete 键循环等价：管理器删除 + 节点 DOM 销毁 +
        // 连线清理 + 组壳删除 + 清选中），然后入栈
        this._deleteEntries(entries, groupRefs);
        im.select(null);
        this.canvas.groups.clearSelection();
        this.canvas.draw();
        this.push(cmd);
        return true;
    }

    /** 执行删除（deleteObjects 初次执行与 redo 共用） */
    _deleteEntries(entries, groupRefs) {
        const im = this.canvas.images;
        const cs = this.canvas.connections;
        for (const entry of entries) {
            const obj = entry.kind === 'node' ? (entry.currentObj || entry.node) : entry.obj;
            if (!obj) continue;
            const idx = im.images.indexOf(obj);
            if (idx > -1) im.images.splice(idx, 1);
            im.selectedIds.delete(obj.id);
            if (entry.kind === 'node') {
                obj.destroy();
                entry.currentObj = null;
                entry.node = null;   // 初次删除后原对象已销毁，防 redo 空回退时二次 destroy
            }
            // 该视频的就地播放器若开着，先关（立即清理路径原有的行为）
            if (NodeTypes.isVideo(obj.source)) this.canvas.videoManager?.dispose?.(obj);
        }
        // 连线直接按两端 id 过滤（不走 connections.remove——删除命令自己
        // 记账，避免双重记录）
        const ids = new Set(entries.map(e => this._resolveId(e.kind === 'node' ? e.json.id : e.obj.id)));
        cs.connections = cs.connections.filter(c => !ids.has(c.fromId) && !ids.has(c.toId));
        for (const g of groupRefs) this.canvas.groups.delete(g.id);
    }

    /** 撤销删除：对象（节点重建）+ 连线（id 换算）+ 组壳按引用放回 */
    _restoreDeleted(entries, groupRefs) {
        const im = this.canvas.images;
        const cs = this.canvas.connections;
        for (const entry of entries) {
            if (entry.kind === 'node') {
                const node = this._recreateNode(entry.json);
                if (!node) continue;
                entry.currentObj = node;
                im.images.splice(Math.min(entry.index, im.images.length), 0, node);
            } else if (!im.images.includes(entry.obj)) {
                im.images.splice(Math.min(entry.index, im.images.length), 0, entry.obj);
            }
        }
        for (const c of entries.flatMap(e => e.conns)) {
            if (cs.connections.some(x => x.id === c.id)) continue;
            cs.connections.push(this._resolveConn(c));
        }
        const gs = this.canvas.groups;
        for (const g of groupRefs) {
            if (!gs.groups.some(x => x.id === g.id)) gs.groups.push(g);
        }
        // 恢复选中（直接置标志，不走 select()——它会重排数组打乱 z 序），
        // 并派发事件让图片工具栏等组件重新定位
        const restoredIds = new Set(entries.map(e => {
            const obj = e.kind === 'node' ? e.currentObj : e.obj;
            return obj ? obj.id : null;
        }).filter(Boolean));
        im.selectedIds = restoredIds;
        im.images.forEach(o => { o.selected = restoredIds.has(o.id); });
        gs.clearSelection();
        window.dispatchEvent(new CustomEvent('canvasImageSelected', {
            detail: { image: im.getSelected()[im.getSelected().length - 1] || null }
        }));
    }

    /** 按存档快照重建 DOM 节点（type 分发同 ProjectSerializer.restoreNodes） */
    _recreateNode(json) {
        const NT = NodeTypes.SOURCE;
        let node = null;
        if (json.type === NT.PROMPT_NODE) {
            node = new PromptNode(this.canvas, json.x, json.y, json.text,
                { width: json.width, height: json.height });
        } else if (json.type === NT.TEXT_NODE) {
            node = new TextNode(this.canvas, json.x, json.y, json.text,
                { width: json.width, height: json.height });
        } else if (json.type === NT.IMAGE_GEN_NODE) {
            node = new ImageGenNode(this.canvas, json.x, json.y, {
                width: json.width, height: json.height, model: json.model,
                ratio: json.ratio, tier: json.tier, quality: json.quality, count: json.count
            });
        } else if (json.type === NT.COMFY_GEN_NODE) {
            node = new ComfyGenNode(this.canvas, json.x, json.y, {
                width: json.width, height: json.height, workflowId: json.workflowId,
                models: json.models, loraEnabled: json.loraEnabled, steps: json.steps,
                cfg: json.cfg, sampler: json.sampler, sizeW: json.sizeW, sizeH: json.sizeH,
                denoise: json.denoise, count: json.count
            });
        } else if (json.type === NT.RUNHUB_GEN_NODE) {
            node = new RunningHubGenNode(this.canvas, json.x, json.y, {
                width: json.width, height: json.height, workflowId: json.workflowId,
                values: json.values, count: json.count
            });
        } else if (json.type === NT.LORA_NODE) {
            node = new LoraNode(this.canvas, json.x, json.y, {
                width: json.width, height: json.height, entries: json.entries
            });
        }
        if (!node) return null;
        if (json.title) node.setTitle(json.title);
        // 编号回填：撤销/重做重建的节点保留原编号（构造时分配的占位号作废）
        if (json.seqId) {
            node.seqId = json.seqId;
            node.refreshTitle();
        }
        this._idRemap.set(json.id, node.id);
        // 与右键菜单/粘贴路径一致，通知提示词节点相关监听方
        if (json.type === NT.PROMPT_NODE) {
            window.dispatchEvent(new CustomEvent('promptNodeAdded', { detail: { node } }));
        }
        return node;
    }

    /**
     * 几何手势记录（拖动移动/缩放/组拖动/组缩放），手势起点快照由
     * CanvasInteraction 的 _startXxx 提供，mouseup 时对比有变化才调用
     * @param {{obj: Object, from: Object, to: Object}[]} entries
     * @param {string} label
     */
    recordGeometry(entries, label) {
        if (!this.recording || !entries || entries.length === 0) return;
        this.push({
            label,
            undo: () => this._applyGeometry(entries, 'from'),
            redo: () => this._applyGeometry(entries, 'to')
        });
    }

    _applyGeometry(entries, key) {
        for (const en of entries) {
            const s = en[key];
            en.obj.x = s.x;
            en.obj.y = s.y;
            if (s.width !== undefined) {
                en.obj.width = s.width;
                en.obj.height = s.height;
            }
        }
    }

    /**
     * 连线添加记录（CanvasConnections.add 内部调用）。
     * replaced = 生图/LoRA 节点单入替换语义挤掉的旧入边，撤销时一并还原。
     */
    recordConnectionAdd(conn, replaced = []) {
        if (!this.recording) return;
        const cs = this.canvas.connections;
        this.push({
            label: '连线',
            undo: () => {
                cs.connections = cs.connections.filter(c => c.id !== conn.id);
                for (const r of replaced) {
                    if (!cs.connections.some(c => c.id === r.id)) cs.connections.push(this._resolveConn(r));
                }
            },
            redo: () => {
                cs.connections = cs.connections.filter(c => !replaced.some(r => r.id === c.id));
                if (!cs.connections.some(c => c.id === conn.id)) cs.connections.push(this._resolveConn(conn));
            }
        });
    }

    /** 连线删除记录（CanvasConnections.remove 内部调用） */
    recordConnectionRemove(conn) {
        if (!this.recording) return;
        const cs = this.canvas.connections;
        this.push({
            label: '断开连线',
            undo: () => {
                if (!cs.connections.some(c => c.id === conn.id)) cs.connections.push(this._resolveConn(conn));
            },
            redo: () => {
                cs.connections = cs.connections.filter(c => c.id !== conn.id);
            }
        });
    }

    /** 组创建记录（GroupManager.add 内部调用） */
    recordGroupCreate(group) {
        if (!this.recording) return;
        const gs = this.canvas.groups;
        this.push({
            label: '新建编组',
            undo: () => {
                gs.groups = gs.groups.filter(g => g.id !== group.id);
                gs.selectedIds.delete(group.id);
            },
            redo: () => {
                if (!gs.groups.some(g => g.id === group.id)) gs.groups.push(group);
            }
        });
    }

    /**
     * 组删除记录 + 执行（GroupToolbar 解组按钮用；Delete 键删组走
     * deleteObjects，两者都只删组壳、成员原样保留）
     * @param {Object[]} groups
     * @param {string} [label]
     */
    deleteGroups(groups, label = '解组') {
        const gs = this.canvas.groups;
        const refs = (groups || []).filter(g => gs.groups.includes(g));
        if (refs.length === 0) return false;
        this.push({
            label,
            undo: () => {
                for (const g of refs) {
                    if (!gs.groups.some(x => x.id === g.id)) gs.groups.push(g);
                }
            },
            redo: () => {
                for (const g of refs) gs.delete(g.id);
            }
        });
        for (const g of refs) gs.delete(g.id);
        this.canvas.draw();
        return true;
    }

    /** 单字段值变更记录（组改名/标题栏配色） */
    recordValue(obj, key, from, to, label) {
        if (!this.recording || from === to) return;
        this.push({
            label,
            undo: () => { obj[key] = from; },
            redo: () => { obj[key] = to; }
        });
    }

    // ==================== 轻提示 ====================

    /** 左下角轻提示（撤销/重做了什么），单元素复用、淡出自动移除 */
    _toast(msg) {
        if (!CanvasHistory._toastEl) {
            CanvasHistory._toastEl = document.createElement('div');
            CanvasHistory._toastEl.className = 'canvas-history-toast';
            document.body.appendChild(CanvasHistory._toastEl);
        }
        const el = CanvasHistory._toastEl;
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(CanvasHistory._toastTimer);
        CanvasHistory._toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
    }
}

// 将 CanvasHistory 类暴露到全局作用域
window.CanvasHistory = CanvasHistory;
