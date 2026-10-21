/**
 * ==========================================================================
 * LoraTriggerManager — LoRA 触发词管理器（面板 Comfy 叠加区）
 * ==========================================================================
 * 职责：
 *   1. 自动同步引擎（面板模式）：叠加区生效 LoRA 的 Civitai 触发词按用户
 *      配置拼成「托管块」写入目标正向框末尾（与原提示词空一行）；叠加区
 *      变更（ComfyParamRows 派发的 lumen-lorastack-changed）即时重算。
 *      拼装与写入策略收口在 utils/LoraTriggerText.js 纯函数层（书签
 *      契约见其文件头）
 *   2. 自动同步引擎（画布模式）：画布 LoRA 节点（lumen-lora-node-changed，
 *      detail.node）的生效条目拼块写入链上提示词节点末尾——书签与目标
 *      选择按节点 id 隔离（nodeBlocks/nodeTargets），同一提示词节点可
 *      承接多只 LoRA 节点各自的块；写入经 _writePromptNode 同步镜像层
 *   3. 管理弹窗（双模式共用一套 UI）：面板模式由叠加区标题栏「触发词」
 *      按钮唤出（lumen-lora-triggers-open），写入目标=正向框1/2 分段；
 *      画布模式由 LoRA 节点标题栏按钮唤出（lumen-lora-node-triggers-open，
 *      detail.node），写入目标=链上提示词节点下拉（默认最近的一个，
 *      用户选择持久化）。逐词开关与权重两模式共用（按归一化 rel 分键，
 *      同一只 LoRA 面板/画布配置互通）
 *   4. 配置持久化：localStorage lumen.loraTriggers.v1；未记录的词默认
 *      开 + 权重 1（Civitai 后补词自动进块）
 *
 * 依赖：LoraFileSelect（封面下拉 + loadMeta() 的 /api/lora/pins 进程共享
 *       缓存——触发词与名称口径来源，名称与面板行一致取文件名）、
 *       LumenDropdown（画布模式的提示词节点选择）、LoraTriggerText。
 *       由 PromptPanel 实例化（注入 comfyParams 条目导出与提示词框）。
 * ==========================================================================
 */

/** 配置持久化键（localStorage） */
const LORA_TRIGGER_STATE_KEY = 'lumen.loraTriggers.v1';

class LoraTriggerManager {

    /**
     * @param {Object} deps
     * @param {Function} [deps.getStackLoras] - () => 叠加区生效条目
     *        [{file}]（ComfyParamRows.getStackTriggerLoras；file 为
     *        ComfyUI 原生形态，可能反斜杠，入表前统一归一）
     * @param {Object} [deps.promptInputManager] - PromptInputManager 实例
     *        （posPrompt / posPrompt2 输入框引用；缺省按 id 兜底查找）
     */
    constructor(deps = {}) {
        this.getStackLoras = deps.getStackLoras || (() => []);
        this.promptInputManager = deps.promptInputManager || null;

        this.state = this._loadState();
        this.dialogEl = null;        // 弹窗根（overlay，懒建于首次打开）
        this._lfs = null;            // LoRA 封面下拉（LoraFileSelect，面板同款）
        this._selectedFile = '';     // 弹窗当前选中的条目 file（ComfyUI 原生形态）
        this._mode = 'panel';        // 弹窗模式：'panel'（面板正向框）| 'node'（画布 LoRA 节点）
        this._node = null;           // node 模式的宿主 LoRA 节点
        this._nodeTargetDd = null;   // node 模式的提示词节点选择下拉（LumenDropdown）
        this._syncTimer = null;      // 权重键入防抖
        this._syncing = false;       // meta 就绪等待闸（面板同步防并发重入）
        this._nodeSyncing = false;   // 画布节点同步闸
        this._nodeSyncPending = new Set();  // 同步期间到达的待处理节点

        this._onStackChanged = () => this.syncFromStack();
        this._onOpenRequest = () => this.openDialog();
        this._onNodeOpenRequest = (e) => this.openNodeDialog(e.detail && e.detail.node);
        this._onNodeChanged = (e) => this._onNodeStackChanged(e.detail && e.detail.node);
        this._onNodeRemoved = (e) => this._onNodeRemoved(e.detail && e.detail.node);
        document.addEventListener('lumen-lorastack-changed', this._onStackChanged);
        document.addEventListener('lumen-lora-triggers-open', this._onOpenRequest);
        document.addEventListener('lumen-lora-node-triggers-open', this._onNodeOpenRequest);
        document.addEventListener('lumen-lora-node-changed', this._onNodeChanged);
        document.addEventListener('lumen-lora-node-removed', this._onNodeRemoved);

        // 元数据就绪后做一次初始同步（页面加载即带内嵌 LoRA 的场景）
        if (window.LoraFileSelect) {
            LoraFileSelect.loadMeta().then(() => this.syncFromStack()).catch(() => {});
        }
    }

    /** 释放监听与弹窗（页面生命周期内通常不调，主要供测试） */
    destroy() {
        document.removeEventListener('lumen-lorastack-changed', this._onStackChanged);
        document.removeEventListener('lumen-lora-triggers-open', this._onOpenRequest);
        document.removeEventListener('lumen-lora-node-triggers-open', this._onNodeOpenRequest);
        document.removeEventListener('lumen-lora-node-changed', this._onNodeChanged);
        document.removeEventListener('lumen-lora-node-removed', this._onNodeRemoved);
        if (this._onKeydown) document.removeEventListener('keydown', this._onKeydown);
        clearTimeout(this._syncTimer);
        this._nodeSyncPending.clear();
        if (this._lfs) { this._lfs.destroy(); this._lfs = null; }
        if (this.dialogEl) this.dialogEl.remove();
        this.dialogEl = null;
        this._node = null;
    }

    // ==================== 配置状态（localStorage） ====================

    /**
     * 读取持久化配置（坏数据静默回落默认：目标框 1 / 全部默认开权重 1）
     * @returns {{target: number, loras: Object, lastBlock: string,
     *            nodeBlocks: Object, nodeTargets: Object}}
     */
    _loadState() {
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(LORA_TRIGGER_STATE_KEY) || 'null');
        } catch (e) { saved = null; }
        return {
            target: (saved && saved.target === 2) ? 2 : 1,
            loras: (saved && saved.loras && typeof saved.loras === 'object') ? saved.loras : {},
            lastBlock: (saved && typeof saved.lastBlock === 'string') ? saved.lastBlock : '',
            // 画布模式：书签与目标选择按 LoRA 节点 id 分键（节点 id 随存档
            // 持久化，跨 F5 稳定）；nodeBlocks[id] = { lastBlock, lastTargetId }
            nodeBlocks: (saved && saved.nodeBlocks && typeof saved.nodeBlocks === 'object') ? saved.nodeBlocks : {},
            nodeTargets: (saved && saved.nodeTargets && typeof saved.nodeTargets === 'object') ? saved.nodeTargets : {}
        };
    }

    _saveState() {
        try {
            localStorage.setItem(LORA_TRIGGER_STATE_KEY, JSON.stringify({
                target: this.state.target,
                loras: this.state.loras,
                lastBlock: this.state.lastBlock,
                nodeBlocks: this.state.nodeBlocks,
                nodeTargets: this.state.nodeTargets
            }));
        } catch (e) { /* 存储不可用：功能照常，仅不记忆 */ }
    }

    /**
     * 取指定 LoRA 的配置条目（就地补齐默认结构；读取侧 composeBlock
     * 不经此方法——缺省即默认态，不为「看一眼」而物化条目）
     * @param {string} rel - 归一化相对路径
     * @returns {{enabled: boolean, words: Object<string, {on?: boolean, weight?: number}>}}
     */
    _loraCfg(rel) {
        let cfg = this.state.loras[rel];
        if (!cfg || typeof cfg !== 'object') {
            cfg = { enabled: true, words: {} };
            this.state.loras[rel] = cfg;
        }
        if (typeof cfg.enabled !== 'boolean') cfg.enabled = true;
        if (!cfg.words || typeof cfg.words !== 'object') cfg.words = {};
        return cfg;
    }

    // ==================== 自动同步引擎 ====================

    /**
     * 当前弹窗语境的条目来源：面板=叠加区生效条目；画布=宿主节点生效条目
     * @returns {Array<{file: string}>}
     */
    _sourceItems() {
        if (this._mode === 'node') {
            return this._node ? (this._node.getEnabledLoras() || []) : [];
        }
        return this.getStackLoras() || [];
    }

    /**
     * 生效条目 → 归一化并挂上 Civitai 触发词（无触发词的条目
     * 不进托管块）。同文件多条目去重（同词重复注入无意义）
     * @returns {Array<{rel: string, words: string[]}>} 栈序
     */
    _effectiveEntries() {
        const meta = (window.LoraFileSelect && LoraFileSelect._meta) || {};
        const triggers = meta.triggers || {};
        const out = [];
        const seen = new Set();
        for (const item of this._sourceItems()) {
            const rel = LoraTriggerText.normalizeRel(item.file);
            if (!rel || seen.has(rel)) continue;
            seen.add(rel);
            const words = LoraTriggerText.parseWords(triggers[rel]);
            if (words.length) out.push({ rel, words });
        }
        return out;
    }

    /**
     * 同步入口：确保元数据就绪（loadMeta 为进程共享缓存，命中即秒回）
     * 后重算托管块。叠加区每次变更都走这里，幂等
     */
    syncFromStack() {
        if (this._syncing) return;
        this._syncing = true;
        const run = () => { this._syncing = false; this._syncNow(); };
        if (window.LoraFileSelect) {
            LoraFileSelect.loadMeta().then(run).catch(run);
        } else {
            run();
        }
    }

    /** 重算托管块并写回目标框（书签策略见 LoraTriggerText.applyBlock） */
    _syncNow() {
        const block = LoraTriggerText.composeBlock(this._effectiveEntries(), this.state.loras);
        const box = this._targetBox(this.state.target);
        if (box) {
            const res = LoraTriggerText.applyBlock(box.value, block, this.state.lastBlock);
            if (res.changed) box.value = res.value;
        }
        this.state.lastBlock = block;
        this._saveState();
    }

    /**
     * 切换写入目标框：先按书签从旧框摘除托管块，再同步进新框
     * @param {number} target - 1 | 2
     */
    setTarget(target) {
        const next = target === 2 ? 2 : 1;
        if (this.state.target === next) return;
        const oldBox = this._targetBox(this.state.target);
        if (oldBox && this.state.lastBlock) {
            const res = LoraTriggerText.applyBlock(oldBox.value, '', this.state.lastBlock);
            if (res.changed) oldBox.value = res.value;
        }
        this.state.target = next;
        this._saveState();
        this.syncFromStack();
    }

    /**
     * 取目标正向框元素
     * @param {number} target - 1 | 2
     * @returns {HTMLTextAreaElement|null}
     */
    _targetBox(target) {
        const pim = this.promptInputManager || {};
        if (target === 2) {
            return pim.posPrompt2 || document.getElementById('posPrompt2');
        }
        return pim.posPrompt || document.getElementById('posPrompt');
    }

    /** 权重键入防抖同步（停手 300ms 落框，打字不闪） */
    _debouncedSync() {
        clearTimeout(this._syncTimer);
        this._syncTimer = setTimeout(() => this.syncFromStack(), 300);
    }

    // ==================== 画布模式：LoRA 节点同步引擎 ====================

    /**
     * 画布 LoRA 节点条目变化入口：确保元数据就绪后按节点重算托管块。
     * 并发到达的节点进 pending 集，本轮完成后依次消化（幂等）
     * @param {Object} node - LoraNode 实例
     */
    _onNodeStackChanged(node) {
        if (!node) return;
        if (this._nodeSyncing) {
            this._nodeSyncPending.add(node);
            return;
        }
        this._nodeSyncing = true;
        const run = () => {
            this._nodeSyncing = false;
            this._syncNodeBlockNow(node);
            // 弹窗开着且正在看这只节点（清单异步就绪/补归一等场景）：刷新展示
            if (this.dialogEl && this.dialogEl.classList.contains('open') &&
                this._mode === 'node' && this._node === node) {
                this._renderDialog();
            }
            if (this._nodeSyncPending.size) {
                const rest = [...this._nodeSyncPending];
                this._nodeSyncPending.clear();
                rest.forEach((n) => this._syncNodeBlockNow(n));
            }
        };
        if (window.LoraFileSelect) {
            LoraFileSelect.loadMeta().then(run).catch(run);
        } else {
            run();
        }
    }

    /**
     * 重算指定 LoRA 节点的托管块并写回目标提示词节点。
     * 书签与目标按节点 id 隔离（nodeBlocks/nodeTargets），同一提示词节点
     * 可承接多只 LoRA 节点各自的块（各管各的段落，互不覆盖）
     * @param {Object} node - LoraNode 实例
     */
    _syncNodeBlockNow(node) {
        // 节点已不在画布（删除/切存档后的残留事件）：清块与书签
        if (!node.el || !document.body.contains(node.el)) {
            this._removeNodeBlock(node.id);
            return;
        }

        const entries = (node.getEnabledLoras() || []).map((e) => ({
            rel: LoraTriggerText.normalizeRel(e.file),
            words: LoraTriggerText.parseWords(
                ((window.LoraFileSelect && LoraFileSelect._meta.triggers) || {})[LoraTriggerText.normalizeRel(e.file)])
        })).filter((e) => e.rel && e.words.length);
        // 同文件多条目去重（与面板 _effectiveEntries 同规则）
        const seen = new Set();
        const deduped = entries.filter((e) => !seen.has(e.rel) && seen.add(e.rel));
        const block = LoraTriggerText.composeBlock(deduped, this.state.loras);

        const bm = (typeof this.state.nodeBlocks[node.id] === 'object' && this.state.nodeBlocks[node.id]) || {};
        const targets = node.getUpstreamPromptNodes();

        // 目标解析：用户选择优先（仍是上游时），否则最近的一个（列表末位）
        const chosen = this.state.nodeTargets[node.id];
        const target = targets.find((n) => n.id === chosen) || targets[targets.length - 1] || null;

        // 上次写入的提示词节点（书签所在）：优先按 id 现查（连线改过后
        // 旧目标可能已不在上游清单里，仍要找到它摘除旧块）
        let prevTarget = null;
        if (bm.lastTargetId) {
            if (target && bm.lastTargetId === target.id) {
                prevTarget = target;
            } else {
                prevTarget = node.findCanvasObject(bm.lastTargetId) || null;
            }
        }

        // 换目标：先从旧目标摘除旧块（避免残留）
        if (prevTarget && (!target || prevTarget.id !== target.id)) {
            this._writePromptNode(prevTarget,
                LoraTriggerText.applyBlock(this._promptText(prevTarget), '', bm.lastBlock || '').value);
        }

        if (!target || !target.inputEl) {
            // 无可写目标：清书签（块恢复后由下一次变更事件重新落位）
            if (block || bm.lastBlock) {
                this.state.nodeBlocks[node.id] = { lastBlock: '', lastTargetId: '' };
                this._saveState();
            }
            return;
        }

        const res = LoraTriggerText.applyBlock(
            this._promptText(target), block, bm.lastBlock || '');
        if (res.changed) this._writePromptNode(target, res.value);
        this.state.nodeBlocks[node.id] = { lastBlock: block, lastTargetId: target.id };
        this._saveState();
    }

    /**
     * 把托管块变更写入提示词节点：textarea 赋值 + 镜像层直接 update +
     * 广播 promptNodeTextChanged（对齐 blur 路径的联动口径）。
     * 刻意不派发合成 input 事件——提示词节点挂着自动补全（词典含
     * ">=:嘟嘴" 类词条），合成 input 会让补全建议条在写入后弹出扰人；
     * 镜像层高亮经 NodeTextMirror.update() 直接刷新
     * @param {Object} promptNode - PromptNode 实例
     * @param {string} value - 新文本
     */
    _writePromptNode(promptNode, value) {
        const ta = promptNode.inputEl;
        if (!ta) return;
        ta.value = value;
        promptNode.text = value;
        if (promptNode.mirrorLayer) promptNode.mirrorLayer.update();
        window.dispatchEvent(new CustomEvent('promptNodeTextChanged', {
            detail: { node: promptNode, text: value }
        }));
    }

    /** 读提示词节点当前文本（textarea 缺失时回落 node.text） */
    _promptText(promptNode) {
        return promptNode.inputEl ? promptNode.inputEl.value : (promptNode.text || '');
    }

    /**
     * 清除指定节点的托管块与书签（节点删除/换存档后的残留清理；
     * 旧目标节点找不到时块留在原处——与手打文本同命运，不追杀）
     * @param {string} nodeId - LoRA 节点 id
     */
    _removeNodeBlock(nodeId) {
        const bm = this.state.nodeBlocks[nodeId];
        if (!bm) return;
        delete this.state.nodeBlocks[nodeId];
        delete this.state.nodeTargets[nodeId];
        this._saveState();
    }

    /**
     * 画布 LoRA 节点销毁（LoraNode.destroy 派发）：按书签把本节点的托管块
     * 从目标提示词节点摘除，再清书签。撤销删除重建节点时构造链路
     * （loadLoraFiles 完成后的变更事件）会自动把块写回来
     * @param {Object} node - 被销毁的 LoraNode 实例
     */
    _onNodeRemoved(node) {
        if (!node) return;
        const bm = this.state.nodeBlocks[node.id];
        if (bm && bm.lastBlock && bm.lastTargetId) {
            const target = typeof node.findCanvasObject === 'function'
                ? node.findCanvasObject(bm.lastTargetId) : null;
            if (target && target.inputEl) {
                this._writePromptNode(target,
                    LoraTriggerText.applyBlock(this._promptText(target), '', bm.lastBlock).value);
            }
        }
        this._removeNodeBlock(node.id);
    }

    // ==================== 管理弹窗 ====================

    /** 叠加区/宿主节点生效条目全量信息（弹窗下拉用，含无触发词的条目） */
    _stackItems() {
        const meta = (window.LoraFileSelect && LoraFileSelect._meta) || {};
        const triggers = meta.triggers || {};
        const out = [];
        const seen = new Set();
        for (const item of this._sourceItems()) {
            const rel = LoraTriggerText.normalizeRel(item.file);
            if (!rel || seen.has(rel)) continue;
            seen.add(rel);
            out.push({ rel, file: item.file, words: LoraTriggerText.parseWords(triggers[rel]) });
        }
        return out;
    }

    /** 打开弹窗（面板模式；先强刷一次元数据——刚在 LoRA 管理器拉过触发词的场景） */
    openDialog() {
        this._mode = 'panel';
        this._node = null;
        const refresh = (window.LoraFileSelect)
            ? LoraFileSelect.loadMeta(true).catch(() => {})
            : Promise.resolve();
        refresh.then(() => {
            this._ensureDialog();
            this._renderDialog();
            this.dialogEl.classList.add('open');
        }).catch((e) => {
            // 渲染链路异常不能无声吞掉——此前缺脚本挂载时表现为「按钮没反应」
            console.error('[LoraTriggerManager] 触发词弹窗打开失败', e);
        });
    }

    /**
     * 打开弹窗（画布模式：宿主为画布 LoRA 节点——条目下拉=本节点生效条目，
     * 写入目标=链上提示词节点）
     * @param {Object} node - LoraNode 实例（lumen-lora-node-triggers-open detail）
     */
    openNodeDialog(node) {
        if (!node) return;
        this._mode = 'node';
        this._node = node;
        const refresh = (window.LoraFileSelect)
            ? LoraFileSelect.loadMeta(true).catch(() => {})
            : Promise.resolve();
        refresh.then(() => {
            this._ensureDialog();
            this._renderDialog();
            this.dialogEl.classList.add('open');
            // 打开即同步一次：覆盖「节点先有词、提示词节点后连线」的场景
            // （连线变化无独立事件，弹窗打开是可靠的重算时机）
            this._onNodeStackChanged(node);
        }).catch((e) => {
            console.error('[LoraTriggerManager] 触发词弹窗打开失败', e);
        });
    }

    closeDialog() {
        if (this.dialogEl) this.dialogEl.classList.remove('open');
    }

    /** 建弹窗骨架并绑定一次性事件（只建一次，重开只刷内容） */
    _ensureDialog() {
        if (this.dialogEl) return;

        const overlay = document.createElement('div');
        overlay.className = 'lora-trigger-overlay';
        overlay.innerHTML = `
            <div class="lora-trigger-dialog" role="dialog" aria-label="LoRA 触发词管理">
                <div class="ltd-header">
                    <span class="ltd-title">LoRA 触发词</span>
                    <div class="ltd-target"
                         title="触发词块写入哪个正面提示词框（末尾，与原提示词空一行）">
                        <span class="ltd-target-label">写入</span>
                        <button type="button" class="ltd-target-btn" data-target="1">正向框1</button>
                        <button type="button" class="ltd-target-btn" data-target="2">正向框2</button>
                    </div>
                    <div class="ltd-node-target"
                         title="选择触发词块写入的提示词节点（末尾，与原提示词空一行）">
                        <button type="button" class="ltd-node-target-dd"></button>
                    </div>
                    <button type="button" class="ltd-close" title="关闭">✕</button>
                </div>
                <div class="ltd-lora-row">
                    <div class="ltd-lora-dd lfs-host"></div>
                    <span class="ltd-lora-status"></span>
                </div>
                <div class="ltd-body"></div>
                <div class="ltd-footer">开关与权重即时写回目标框末尾的触发词块；权重 ≠1 时以 (词:权重) 语法写入</div>
            </div>`;
        document.body.appendChild(overlay);
        this.dialogEl = overlay;

        // 外点（overlay 自身）/ 关闭钮 / Esc 关闭
        overlay.addEventListener('mousedown', (e) => {
            if (e.target === overlay) this.closeDialog();
        });
        overlay.querySelector('.ltd-close').addEventListener('click', () => this.closeDialog());
        // 封面菜单打开时 Esc 让位（菜单自带关闭处理），只关弹窗层
        this._onKeydown = (e) => {
            if (e.key !== 'Escape') return;
            if (document.querySelector('.lfs-menu')) return;
            if (this.dialogEl && this.dialogEl.classList.contains('open')) {
                this.closeDialog();
            }
        };
        document.addEventListener('keydown', this._onKeydown);

        // 写入目标切换
        overlay.querySelectorAll('.ltd-target-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.setTarget(Number(btn.dataset.target));
                this._renderTargetButtons();
                this._renderLoraDropdown();   // 状态徽标里的「写入正向框N」跟随刷新
            });
        });

        // LoRA 下拉：沿用面板叠加区同款封面选择器（LoraFileSelect——封面/
        // 文件夹名/搜索/置顶与面板行完全一致，名称口径统一取文件名），
        // 用户选中经 change 事件回流（el.value expando 兼容）
        this._lfs = new LoraFileSelect(overlay.querySelector('.ltd-lora-dd'), {
            files: [],
            value: '',
            allowEmpty: false
        });
        overlay.querySelector('.ltd-lora-dd').addEventListener('change', (e) => {
            this._selectedFile = e.target.value || '';
            this._renderBody();
        });

        // 画布模式的写入目标下拉（LumenDropdown 文本菜单：提示词节点清单）
        this._nodeTargetDd = new LumenDropdown(overlay.querySelector('.ltd-node-target-dd'), {
            onChange: (value) => this._setNodeTarget(value)
        });
    }

    /** 弹窗全量重渲（打开时）：模式切换 + 目标区 + LoRA 封面下拉 + 主体 */
    _renderDialog() {
        const isNode = this._mode === 'node';
        // 目标行显隐必须显式赋 display 值——.ltd-node-target 的样式表
        // 默认就是 display:none，置空字符串会落回隐藏规则（写入下拉
        // 消失正是这个坑）；.ltd-target 样式表默认 flex，置空可复原
        this.dialogEl.querySelector('.ltd-target').style.display =
            isNode ? 'none' : '';
        this.dialogEl.querySelector('.ltd-node-target').style.display =
            isNode ? 'flex' : 'none';
        this.dialogEl.querySelector('.ltd-footer').textContent = isNode
            ? '开关与权重即时写回所选提示词节点末尾的触发词块；权重 ≠1 时以 (词:权重) 语法写入'
            : '开关与权重即时写回目标框末尾的触发词块；权重 ≠1 时以 (词:权重) 语法写入';
        if (isNode) {
            this._renderNodeTarget();
        } else {
            this._renderTargetButtons();
        }
        this._renderLoraSelect();
        this._renderBody();
    }

    _renderTargetButtons() {
        this.dialogEl.querySelectorAll('.ltd-target-btn').forEach((btn) => {
            btn.classList.toggle('is-active', Number(btn.dataset.target) === this.state.target);
        });
    }

    /**
     * 画布模式：写入目标下拉（链上提示词节点，"离本节点由远到近"序——
     * 默认选最近的一个=列表末位；用户选择持久化，失效回落最近）。
     * 触发器显「写入：节点名 #ID」——既标明写入动作又常显当前目标，
     * 菜单里以对勾标记当前节点
     */
    _renderNodeTarget() {
        const targets = this._node ? (this._node.getUpstreamPromptNodes() || []) : [];
        const options = targets.map((n) => ({
            value: n.id,
            // 节点标题栏同款显示名（getTitle：自定义标题/类默认 + #NNN 编号）
            label: (typeof n.getTitle === 'function' && n.getTitle()) || '提示词节点'
        }));
        if (options.length === 0) {
            options.push({ value: '', label: '链上没有提示词节点' });
        }
        const chosen = this._node ? this.state.nodeTargets[this._node.id] : '';
        const selected = options.some((o) => o.value === chosen)
            ? chosen
            : options[options.length - 1].value;   // 默认最近的一个
        this._nodeTargetDd.setOptions(options, selected);
        // 有目标时触发器显「写入：当前节点名 #ID」；无目标时如实显示占位文案
        if (targets.length > 0) {
            const sel = options.find((o) => o.value === selected);
            this._nodeTargetDd.setLabel(`写入：${sel ? sel.label : ''}`);
        }
    }

    /**
     * 画布模式：用户切换写入目标提示词节点——持久化选择并立即重算
     * （旧目标上的块由同步引擎按书签摘除）；触发器刷新为
     * 「写入：新目标名 #ID」
     * @param {string} nodeId - 提示词节点 id（空=无有效目标）
     */
    _setNodeTarget(nodeId) {
        if (!this._node) return;
        if (nodeId) {
            this.state.nodeTargets[this._node.id] = nodeId;
        } else {
            delete this.state.nodeTargets[this._node.id];
        }
        this._saveState();
        this._renderNodeTarget();
        this._onNodeStackChanged(this._node);
    }

    _renderLoraSelect() {
        const items = this._stackItems();
        const files = items.map((it) => it.file);
        if (!files.includes(this._selectedFile)) this._selectedFile = files[0] || '';
        this._lfs.setFiles(files, this._selectedFile);
        // 无条目：隐藏选择行（主体已给空态引导）
        this.dialogEl.querySelector('.ltd-lora-row').style.display =
            files.length ? '' : 'none';

        // 状态徽标：当前托管块规模一览
        const entries = this._effectiveEntries();
        const wordCount = entries.reduce((n, e) => n + e.words.length, 0);
        const statusEl = this.dialogEl.querySelector('.ltd-lora-status');
        if (wordCount > 0) {
            if (this._mode === 'node') {
                statusEl.textContent = `本节点：${entries.length} 只 / ${wordCount} 词`;
            } else {
                const targetName = this.state.target === 2 ? '正向框2' : '正向框1';
                statusEl.textContent = `已写入${targetName}：${entries.length} 只 / ${wordCount} 词`;
            }
        } else {
            statusEl.textContent = '触发词块为空';
        }
    }

    /** 渲染主体：选中 LoRA 的逐词开关 + 权重（每次换选重建，控件焦点无连续性诉求） */
    _renderBody() {
        const body = this.dialogEl.querySelector('.ltd-body');
        const items = this._stackItems();
        const cur = items.find((it) => it.file === this._selectedFile);

        if (!cur) {
            body.innerHTML = this._mode === 'node'
                ? `<div class="ltd-empty">本节点暂无生效的 LoRA 条目——<br>先添加条目、选择文件并保持勾选启用</div>`
                : `<div class="ltd-empty">叠加区当前没有生效的 LoRA——<br>先在「LoRA 叠加」区添加条目并选择 LoRA 文件</div>`;
            return;
        }
        // 名称口径与下拉/面板行一致（LoraFileSelect._displayName：文件名）
        const name = this._lfs._displayName(cur.file);
        if (cur.words.length === 0) {
            body.innerHTML = `<div class="ltd-empty">「${LumenLight.escapeHtml(name)}」尚未获取 Civitai 触发词。<br>` +
                `可到 LoRA 管理器（顶栏「LoRA」）选中该模型 → 信息窗 → 「从 Civitai 获取」拉取触发词，` +
                `再回到这里管理。</div>`;
            return;
        }

        const cfg = this._loraCfg(cur.rel);
        const rows = cur.words.map((w) => {
            const st = cfg.words[w] || {};
            const on = st.on !== false;
            const weight = (st.weight === undefined) ? 1 : st.weight;
            return `
                <div class="ltd-word-row${on ? '' : ' is-off'}" data-word="${LumenLight.escapeHtml(w)}">
                    <input type="checkbox" class="ltd-word-on"${on ? ' checked' : ''}
                           title="勾选后写入正向框">
                    <span class="ltd-word-text" title="${LumenLight.escapeHtml(w)}">${LumenLight.escapeHtml(w)}</span>
                    <input type="number" class="ltd-word-weight" min="0.1" max="2" step="0.05" value="${weight}"
                           title="权重（1 = 原文写入；≠1 写 (词:权重)）"${on ? '' : ' disabled'}>
                </div>`;
        }).join('');

        body.innerHTML = `
            <label class="ltd-master-row" title="整体开关：关闭后此 LoRA 的触发词全部退出触发词块">
                <input type="checkbox" class="ltd-master-on"${cfg.enabled === false ? '' : ' checked'}>
                <span>启用「${LumenLight.escapeHtml(name)}」的触发词</span>
            </label>
            <div class="ltd-word-list">${rows}</div>`;

        // LoRA 级总开关
        body.querySelector('.ltd-master-on').addEventListener('change', (e) => {
            cfg.enabled = e.target.checked;
            this._saveState();
            this.syncFromStack();
        });

        // 逐词开关与权重（事件委托在词列表上）
        const list = body.querySelector('.ltd-word-list');
        list.addEventListener('change', (e) => {
            const row = e.target.closest('.ltd-word-row');
            if (!row) return;
            const word = row.dataset.word;
            const wordCfg = this._loraCfg(cur.rel).words;
            const st = wordCfg[word] = wordCfg[word] || {};
            if (e.target.classList.contains('ltd-word-on')) {
                st.on = e.target.checked;
                row.classList.toggle('is-off', !st.on);
                row.querySelector('.ltd-word-weight').disabled = !st.on;
                this._saveState();
                this.syncFromStack();
            }
        });
        list.addEventListener('input', (e) => {
            if (!e.target.classList.contains('ltd-word-weight')) return;
            const row = e.target.closest('.ltd-word-row');
            if (!row) return;
            const word = row.dataset.word;
            const wordCfg = this._loraCfg(cur.rel).words;
            const st = wordCfg[word] = wordCfg[word] || {};
            let v = parseFloat(e.target.value);
            if (!isFinite(v)) v = 1;
            st.weight = Math.max(0.1, Math.min(2, v));
            this._saveState();
            this._debouncedSync();
        });
    }
}

// 暴露到全局作用域
window.LoraTriggerManager = LoraTriggerManager;
