/**
 * ==========================================================================
 * 坐标编辑器（CoordinateEditor）——主类
 * ==========================================================================
 * 作用：顶栏「坐标编辑」按钮 + 弹窗（复用收藏页 recipe-dialog 骨架，
 *       与 LoRA 管理器/提示词收藏同款窗口）。宽屏（≥1500px）为并排
 *       形态：右缘留白（--coord-gap，默认 540px，拖拽右缘可调并存
 *       localStorage）露出画布右侧的 Comfy/LLM 面板同屏操作，ESC 仅在
 *       焦点位于弹窗内时关窗；窄屏媒体查询回落全屏模态。为支持坐标
 *       编辑的新模型（MOSS-Image / Flux3 等）可视化制作布局提示词：
 *
 *   - 中央舞台：bbox 拖拽创建 / 移动 / 八向锚点缩放 / 磁吸参考线
 *     （画幅边与中心，StudioMoveTool 同款粉色粉线）/ Shift 画正方 /
 *     图层级选框——命中按层栈（数组序即绘制序），同位连点穿透逐层
 *     下探、选中框置顶重绘、选中优先拖动；卡片图层菜单可置顶/上下移/
 *     置底（ADR 017 决策十）；
 *   - 左侧面板：整体描述与元素卡片列表按 2:1 分摊画幅/模式迁出后的
 *     空间（卡片列表：类型/描述/文字内容/四坐标数值框，与舞台双向同步）；
 *   - 右侧输出面板（与左栏同宽）：画幅（16 倍数钳制 + 预设）与模式三选
 *     （single/multi_panel/collage）置顶——设一次就不常动，挪到右栏给
 *     左栏描述腾地方；其下为单一输出框——AI 文案留档与编译 JSON
 *     产物共用（最近一次输出覆盖显示）；编译产物随草稿变更即清空防过期，
 *     AI 文案留档不受草稿编辑影响，可手动选择复制；
 *   - AI 写提示词：把当前布局草稿交给 LLM 补全 summary.caption 与各元素
 *     caption/text——几何保持用户手画不动；模型经底部下拉框选择
 *     （LumenDropdown，与 LLM 面板同组件）：显式选择存 localStorage
 *     （lumenLight.coordModel），「自动」档跟随 LLM 面板 Agent 分类选中
 *     的模型（piModelKey），无则技能栏模型 → 第一序聊天模型；
 *     模型旁技能下拉（lumenLight.coordSkill）选 pi 技能库技能，其正文
 *     经框架语隔离后注入 system 提示作写作指引（流程性指令忽略，
 *     ADR 017 决策八）；
 *   - 编译导出：CoordinateLayout.compileDraft 产出单行 JSON（与上游
 *     compile_prompt.py 字节级一致），复制到剪贴板或写入提示词面板
 *     正向框，宽高需单独设置到 ComfyUI 工作流（提示词不含尺寸）。
 *
 * 数据：编辑器状态即 MOSS 草稿 JSON（schema 见 CoordinateLayout.js 文件头）。
 *       草稿自动持久化到后端 data/coordinate-draft.json（/api/coordinate-draft，
 *       全局单份，防抖 800ms + pagehide keepalive 兜底；打开弹窗时恢复，
 *       恢复走 CoordinateLayout.normalizeDraft 宽松归一——见 ADR 018）。
 * 拆分：本类按职责域拆为 coordinate-editor/ 下六个混入模块（partial-class，
 *       ADR 026）——方法 Object.assign 回本类 prototype，this 即实例，
 *       调用点与测试契约（Object.create(prototype) + 实例打桩）零改动：
 *       CoordDom.js        DOM 装配与事件绑定（懒建于首次 show）
 *       CoordPanel.js      左面板渲染/元素卡片/景别/画幅/图层顺序
 *       CoordStage.js      舞台渲染与指针交互/磁吸
 *       CoordHistory.js    撤销重做快照栈（ADR 017 决策十一）
 *       CoordDraftStore.js 草稿自动持久化（ADR 018）
 *       CoordAi.js         AI 写提示词（模型/技能/解析/回填）
 *       本文件保留：构造与状态声明、开合、并排窗口宽度、共享小工具
 *       （配色/稳定 id）、草稿失效枢纽、编译导出与写入目标。
 *       加载顺序：本文件先于六个混入模块（混入依赖类已定义）。
 * 纯函数层：js/utils/CoordinateLayout.js（校验/编译/几何辅助，Jest 可单测）。
 * 样式：css/coordinate-editor.css（窗口壳复用 recipe-manager.css 的
 *       recipe-dialog 类，本档只补内部排布）。
 * ==========================================================================
 */

class CoordinateEditor {
    constructor() {
        // 顶栏按钮：注入中段工具区（LoRA/提示词/Comfy 之后，appendChild 排最右）
        this.btn = null;
        const center = document.getElementById('topToolbarCenter');
        if (center) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'top-toolbar-btn';
            b.title = '坐标编辑：bbox 布局 → MOSS/Flux3 坐标提示词';
            b.setAttribute('aria-haspopup', 'dialog');
            b.setAttribute('aria-expanded', 'false');
            b.innerHTML = `
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.5"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg>
                <span>坐标编辑</span>
            `;
            b.addEventListener('click', () => this.toggle());
            center.appendChild(b);
            this.btn = b;
        }

        this.dialog = null;        // 弹窗 DOM（懒建）
        this.visible = false;
        this.draft = CoordinateLayout.createDraft();   // 编辑器状态 = MOSS 草稿
        this.selected = -1;        // 选中元素下标（-1 = 无）
        this.compiled = null;      // 最近一次编译产物 { ok, prompt?, error? }

        // 舞台交互状态
        this._drag = null;         // {mode:'draw'|'move'|'resize', ...}
        this._guides = [];         // 拖拽中的磁吸参考线 [{axis:'x'|'y', pos}]
        this._view = null;         // 视口变换 {scale, ox, oy}
        this._clickBurst = null;   // 同位连点状态 {t, px, py}——连点穿透选层用

        // AI 写提示词
        this.aiRunning = false;
        this._aiModels = [];       // 聊天模型清单缓存（显示名/兜底用）
        this._skillBodies = new Map();   // 技能正文缓存 id→body（pi 技能库，ADR 017 决策八）

        // 草稿持久化（ADR 018）：防抖定时器 / 自上次成功保存是否脏 /
        // 首次构建后是否动过草稿（GET 恢复与用户首编辑的竞态闸）/ 在途保存的中止器
        this._saveTimer = null;
        this._saveDirty = false;
        this._draftTouched = false;
        this._saveAbort = null;

        // 撤销/重做（ADR 017 决策十一）：快照式——草稿是纯 JSON 小对象，
        // 全量快照比命令闭包简单可靠（StudioHistory 同款取舍）。栈存
        // {label, snap}（snap = 变更前草稿），文本输入按防抖合并成一步
        this._undoStack = [];
        this._redoStack = [];
        this._textHistPending = null;   // 文本输入的"变更前"快照（防抖期间挂起）
        this._histTimer = null;

        // F5/关页兜底：防抖未落盘的草稿用 keepalive 补一次保存
        window.addEventListener('pagehide', () => this._flushSave());

        this._boxColors = [
            '#ffb454', '#7ce38b', '#ff7ab8', '#c3a6ff', '#ffe066',
            '#64d9c8', '#ff8f6b', '#9ad0ff', '#f4a4c0', '#b8e986'
        ];
        this._nextCid = 0;         // 元素稳定 id 计数器（见 _ensureItemIds）
        this._expandedCids = new Set();   // 展开的卡片 cid 集合——卡片默认折叠（按 cid 记忆，重排/改名不丢）
        this._hiddenCids = new Set();     // 隐藏的元素框 cid 集合——纯编辑器视图态（不进编译、不进存档）
        this._labelText = { object: '物体', character: '角色', text: '文字' };
        // 景别层次（编辑器侧辅助元数据 item.shot，编译前剥离——MOSS 产物不含它；
        // 作用是手写时自动前缀进 caption、AI 写文案时作为织入提示。
        // 只保留空间层次三档：远景/近景/特写属镜头景别另一套体系，且与
        // 前景语义重叠——要那种镜头感直接把词写进描述框即可）
        this._shotOptions = ['前景', '中景', '后景'];
        this._modeDesc = {
            single: '单一画面：元素自由排布，可自然重叠',
            multi_panel: '多格漫画/分镜：建议格子铺满画幅互不重叠',
            collage: '拼贴：元素像贴纸一样可重叠堆放'
        };
    }

    // ==================== 开合 ====================

    toggle() { this.visible ? this.hide() : this.show(); }

    show() {
        if (!this.dialog) this._buildDom();
        this.dialog.classList.add('is-open');
        this.visible = true;
        if (this.btn) this.btn.setAttribute('aria-expanded', 'true');
        this._renderAll();
        this._refreshModelDropdown();   // 每次打开刷新（模型清单/跟随目标可能已变）
        this._refreshSkillDropdown();   // 每次打开刷新（技能库可能刚上传/启停）
    }

    hide() {
        if (!this.dialog) return;
        this.dialog.classList.remove('is-open');
        this.visible = false;
        this._drag = null;
        if (this.btn) this.btn.setAttribute('aria-expanded', 'false');
    }

    // ==================== 并排窗口宽度（右缘留白给面板） ====================

    /** 留白钳制：至少放下面板（360px）、至多保住编辑器三栏最小宽（900px） */
    _clampGap(px, innerWidth) {
        const min = 360;
        const max = Math.max(min, innerWidth - 900);
        const n = typeof px === 'number' && Number.isFinite(px) ? px : 540;
        return Math.round(Math.max(min, Math.min(max, n)));
    }

    /**
     * 默认留白：右侧面板可见时按其实测左缘对齐 +7px 呼吸（面板宽可拖
     * 480-700px，写死数字永远差一点）；面板关闭/不可测时回落 552px
     * （面板默认宽 540 + 右留边 5 + 7）
     */
    _defaultGap() {
        if (typeof document !== 'undefined') {
            const panel = document.getElementById('promptPanel');
            if (panel) {
                const r = panel.getBoundingClientRect();
                if (typeof window.innerWidth === 'number' &&
                    r.width > 0 && r.left >= 0 && r.left < window.innerWidth) {
                    return this._clampGap(window.innerWidth - r.left + 7, window.innerWidth);
                }
            }
        }
        return this._clampGap(552, window.innerWidth);
    }

    /** 启动时应用留白宽度：用户拖拽过的值（localStorage）优先，否则按面板实测 */
    _applyStoredGap() {
        const raw = Number(localStorage.getItem('lumenLight.coordDialogGap'));
        const gap = Number.isFinite(raw) && raw > 0
            ? this._clampGap(raw, window.innerWidth)
            : this._defaultGap();
        this.dialog.style.setProperty('--coord-gap', gap + 'px');
    }

    /** 右缘拖拽：更新 --coord-gap（窄屏媒体查询强制全屏时拖拽自然无效）、
     *  rAF 节流重绘舞台（舞台按容器尺寸自适应缩放草稿），松手持久化 */
    _onEdgeResizeStart(e, handle) {
        if (e.button !== 0) return;
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        handle.classList.add('dragging');
        let raf = 0;
        let lastGap = this._clampGap(window.innerWidth - e.clientX, window.innerWidth);
        const onMove = (ev) => {
            lastGap = this._clampGap(window.innerWidth - ev.clientX, window.innerWidth);
            this.dialog.style.setProperty('--coord-gap', lastGap + 'px');
            if (!raf) raf = requestAnimationFrame(() => { raf = 0; this._renderStage(); });
        };
        const finish = (ev) => {
            try { handle.releasePointerCapture(ev.pointerId); } catch { /* 已释放 */ }
            handle.classList.remove('dragging');
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', finish);
            handle.removeEventListener('pointercancel', finish);
            if (raf) cancelAnimationFrame(raf);
            this._renderStage();
            localStorage.setItem('lumenLight.coordDialogGap', String(lastGap));
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', finish);
    }

    /**
     * ESC 是否该关窗：事件源自弹窗内、或无具体焦点目标（body）时才关——
     * 并排形态下焦点在右侧面板输入框按 ESC 是取消面板输入，不是关编辑器
     */
    _shouldCloseOnEscape(target) {
        const root = typeof document !== 'undefined' ? document : null;
        if (!target || target === root || (root && target === root.body)) return true;
        return this.dialog ? this.dialog.contains(target) : true;
    }

    // ==================== 共享小工具（面板与舞台都用） ====================

    _colorFor(i) { return this._boxColors[i % this._boxColors.length]; }

    /**
     * 元素稳定 id（cid）：创建即分配、删除不复用（画布节点 #NNN 同款策略）。
     * 编号徽标与颜色跟随 cid 而非数组下标——图层重排只改 z 序，同一框的
     * 身份（颜色+编号）不变；否则置底/置顶后所有框的编号颜色轮转，按
     * 编号识别框的用户会看到「尺寸互相换错」。旧快照/磁盘草稿缺 cid 在
     * 此回填，计数器按已分配的最大值同步
     */
    _ensureItemIds() {
        for (const it of this.draft.items) {
            if (!Number.isInteger(it.cid)) it.cid = this._nextCid++;
            else this._nextCid = Math.max(this._nextCid, it.cid + 1);
        }
    }

    _status(text, isError) {
        this.statusEl.textContent = text || '';
        this.statusEl.classList.toggle('is-error', !!isError);
    }

    // ==================== 草稿失效枢纽 ====================

    /** 草稿变化后编译产物失效（复制按钮回落禁用态；右栏正在显示编译
     *  产物时清空防过期——AI 文案留档不误清）+ 防抖自动保存。
     *  写入按钮不禁用：菜单目标点击时自动编译，编译失败走状态栏报错 */
    _invalidateCompiled() {
        this.compiled = null;
        this.copyBtn.disabled = true;
        this._clearOutIfCompile();
        this._draftTouched = true;
        this._scheduleSave();
    }

    /** 右栏当前显示的是编译产物时清空（编译产物随草稿变化即过期） */
    _clearOutIfCompile() {
        if (this._outMode !== 'compile') return;
        this.aiOutTa.value = '';
        this.jsonNote.textContent = '';
        this._outMode = '';
    }

    // ==================== 编译与导出 ====================

    /** 编译输入：剥离景别（item.shot）等编辑器侧元数据——
     *  产物保持标准 MOSS schema（上游编译器拒绝未知字段） */
    _draftForCompile() {
        // 剥离编辑器侧元数据（编译层白名单会拒绝未认可字段）：
        // shot = 景别（织进 caption 后完成使命）、cid = 稳定 id（编号/颜色显示）、
        // title = 框标题（舞台标签显示）——三者都不属于 MOSS 草稿契约
        return {
            ...this.draft,
            items: this.draft.items.map(({ shot, cid, title, ...rest }) => rest)
        };
    }

    _compile() {
        const r = CoordinateLayout.compileDraft(this._draftForCompile());
        this.compiled = r;
        if (!r.ok) {
            this._clearOutIfCompile();   // 旧产物已过期，不再显示
            this.copyBtn.disabled = true;
            this._status('编译失败：' + r.error, true);
            return;
        }
        this.aiOutTa.value = r.prompt;   // 编译产物也进右栏输出框
        this.jsonNote.textContent =
            `尺寸 ${this.draft.width}×${this.draft.height} 需单独设置到工作流（提示词不含宽高）`;
        this._outMode = 'compile';
        this.copyBtn.disabled = false;
        this._status('编译成功', false);
    }

    async _copyJson() {
        if (!this.compiled?.ok) this._compile();
        const prompt = this.compiled?.prompt;
        if (!prompt) return;
        try {
            await navigator.clipboard.writeText(prompt);
            this._status('已复制到剪贴板', false);
            window.socket?.showNotification?.('坐标提示词已复制');
        } catch {
            // 剪贴板 API 不可用时回退：全选右栏输出框（此刻即编译产物）让用户 Ctrl+C
            this.aiOutTa.select();
            this._status('剪贴板不可用，已全选输出框——按 Ctrl+C 复制', true);
        }
    }

    /**
     * 写入 Comfy 面板正向框（replace 语义）。面板有两个独立正向框：
     * 框1 id=posPrompt（历史命名）、框2 id=posPrompt2，运行时空行合并。
     * 目标折叠时自动展开，让写入结果可见
     * @param {string} slotId - 目标 textarea 的 DOM id
     * @param {string} slotName - 状态栏/通知用的目标名
     */
    _sendToPanel(slotId = 'posPrompt', slotName = '正向框 1') {
        if (!this.compiled?.ok) this._compile();
        const prompt = this.compiled?.prompt;
        if (!prompt) return;
        const el = document.getElementById(slotId);
        if (!el) { this._status(`未找到 Comfy ${slotName}输入框`, true); return; }
        el.value = prompt;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        const seq = slotId === 'posPrompt' ? '1' : '2';
        const wrap = document.getElementById(`posPrompt${seq}Wrap`);
        if (wrap?.classList.contains('collapsed')) {
            document.getElementById(`posPrompt${seq}Toggle`)?.click();
        }
        this._status(`已写入 Comfy ${slotName}`, false);
        window.socket?.showNotification?.(`坐标提示词已写入 Comfy ${slotName}`);
    }

    /**
     * 写入下拉目标枚举（每次展开菜单前调用）：画布提示词节点按当下
     * 画布实时列出（标题自含 #NNN 编号，LoraSendPopup 同款遍历），
     * 面板/LLM 输入框恒在。value 用临时键映射节点对象，避免依赖节点 id
     */
    _refreshSendTargets() {
        const opts = [];
        this._sendNodeMap = {};
        const canvas = window.canvas;
        if (canvas) {
            for (const img of canvas.images.images) {
                if (img?.source !== NodeTypes.SOURCE.PROMPT_NODE) continue;
                if (!img.inputEl) continue;
                const key = 'n' + (this._sendNodeSeq++);
                this._sendNodeMap[key] = img;
                const title = (typeof img.getTitle === 'function' && img.getTitle()) || '提示词节点';
                opts.push({ value: key, label: '画布节点 · ' + title });
            }
        }
        opts.push({ value: 'panel1', label: 'Comfy 正向框 1（右侧面板）' });
        opts.push({ value: 'panel2', label: 'Comfy 正向框 2（右侧面板）' });
        opts.push({ value: 'llm', label: 'LLM 输入框' });
        this.sendDd.setOptions(opts, '');
        this.sendDd.setLabel('写入');
    }

    /** 写入 LLM 面板输入框（replace 语义，input 事件驱动草稿持久化） */
    _sendToLlm(prompt) {
        const el = document.getElementById('llmInput');
        if (!el) { this._status('未找到 LLM 输入框', true); return; }
        el.value = prompt;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        this._status('已写入 LLM 输入框', false);
        window.socket?.showNotification?.('坐标提示词已写入 LLM 输入框');
    }

    /** 写入画布提示词节点（replace 语义；input 事件走节点自身的
     *  text 同步与 @引用镜像管线，与手敲等价） */
    _sendToPromptNode(node, prompt) {
        if (!node.inputEl) { this._status('该节点没有可写的输入框', true); return; }
        node.inputEl.value = prompt;
        node.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        this._status('已写入画布提示词节点', false);
        window.socket?.showNotification?.('坐标提示词已写入画布提示词节点');
    }
}

// 暴露到全局作用域（经典 script，app.js 实例化）
window.CoordinateEditor = CoordinateEditor;
