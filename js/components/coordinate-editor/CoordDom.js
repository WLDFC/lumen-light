/**
 * ==========================================================================
 * CoordinateEditor 子模块：DOM 构建与事件绑定（自 CoordinateEditor.js 拆出）
 * 作用：首次 show 时一次性构建弹窗全部 DOM（三栏布局/底栏操作/右缘拖拽
 *       手柄），绑定全部事件（画幅输入/模式三选/整体描述/元素增删/舞台
 *       指针/底部 AI·编译·复制·写入/新建草稿/全局键盘 ESC·Delete·
 *       Ctrl+Z·Y / resize），并在构建完成后触发草稿恢复（ADR 018）。
 * 契约：原型混入（partial-class，ADR 026）——本文件方法 Object.assign 进
 *       CoordinateEditor.prototype，this 即编辑器实例，草稿与子状态全部
 *       读写在实例字段上；须后于主类文件加载（混入依赖类已定义）。
 * 对应：css/coordinate-editor.css（窗口壳复用 recipe-manager.css 的
 *       recipe-dialog 骨架）；纯函数层 js/utils/CoordinateLayout.js。
 * ==========================================================================
 */

Object.assign(window.CoordinateEditor.prototype, {

    // ==================== DOM 构建 ====================

    _buildDom() {
        const el = document.createElement('div');
        el.className = 'recipe-dialog coord-dialog';
        el.innerHTML = `
            <div class="recipe-dialog-panel">
                <header class="recipe-dialog-header">
                    <div class="recipe-dialog-title-group">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.5"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg>
                        <h2>坐标编辑</h2>
                    </div>
                    <div class="coord-header-right">
                        <span class="coord-status"></span>
                        <button class="recipe-dialog-close" type="button" title="关闭坐标编辑" aria-label="关闭坐标编辑窗口"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                    </div>
                </header>
                <div class="coord-body">
                    <aside class="coord-side">
                        <section class="coord-sec coord-sec-summary">
                            <div class="coord-sec-title">整体描述</div>
                            <textarea class="coord-summary" rows="3" placeholder="这张图整体是什么：题材、风格、光线、氛围……（AI 写提示词的依据）"></textarea>
                        </section>
                        <section class="coord-sec coord-sec-items">
                            <div class="coord-sec-title">元素 <span class="coord-item-count"></span></div>
                            <div class="coord-items"></div>
                            <button type="button" class="coord-add-item">＋ 添加元素</button>
                        </section>
                    </aside>
                    <div class="coord-stage-wrap">
                        <div class="coord-stage-area">
                            <canvas class="coord-stage"></canvas>
                            <div class="coord-stage-hint">空白处拖拽画框 · 拖动移动 · 锚点缩放 · 同位连点穿透选层 · Shift 画正方 · Delete 删除选中</div>
                        </div>
                    </div>
                    <aside class="coord-side coord-out-side">
                        <section class="coord-sec">
                            <div class="coord-sec-title">画幅 <span class="coord-dim-note">（16 的倍数）</span></div>
                            <div class="coord-dims">
                                <label class="coord-dim-field">宽 <input type="number" class="coord-w" min="${CoordinateLayout.MIN_DIM}" max="${CoordinateLayout.MAX_DIM}" step="16"></label>
                                <label class="coord-dim-field">高 <input type="number" class="coord-h" min="${CoordinateLayout.MIN_DIM}" max="${CoordinateLayout.MAX_DIM}" step="16"></label>
                                <select class="coord-preset" title="常用画幅预设"></select>
                            </div>
                        </section>
                        <section class="coord-sec">
                            <div class="coord-sec-title">模式</div>
                            <div class="coord-modes"></div>
                            <div class="coord-mode-desc"></div>
                        </section>
                        <section class="coord-sec coord-sec-ai-out">
                            <div class="coord-sec-title">输出 <span class="coord-out-note">AI 文案 · 编译 JSON</span></div>
                            <textarea class="coord-ai-out" spellcheck="false" placeholder="AI 写提示词 / 编译 JSON 的输出显示在这里，可直接编辑——AI 输出态下改完再编译，按你改后的文案编译"></textarea>
                            <div class="coord-json-note"></div>
                        </section>
                    </aside>
                </div>
                <footer class="coord-footer">
                    <div class="coord-footer-left">
                        <button type="button" class="coord-ai-btn" title="用 AI 模型补全整体描述与各元素文案（几何保持不动）">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z"/></svg>
                            <span>AI 写提示词</span>
                        </button>
                        <button type="button" class="coord-model-select" aria-label="选择 AI 写提示词使用的模型" aria-haspopup="listbox" title="AI 写提示词使用的模型：自动档跟随 LLM 面板 Agent 分类选中的模型，可在此改选"></button>
                        <button type="button" class="coord-skill-select" aria-label="选择 AI 写提示词的技能指引" aria-haspopup="listbox" title="AI 写提示词附加的写作指引：选自 pi 技能库（data/pi/skills/，面板「工具与技能」弹窗管理），技能正文注入提示词；「不使用技能」保持默认风格"></button>
                        <button type="button" class="coord-new-btn" title="清空当前草稿重新开始（自动保存的草稿会被替换，不可撤销）">新建</button>
                    </div>
                    <div class="coord-footer-right">
                        <button type="button" class="coord-compile-btn">编译 JSON</button>
                        <button type="button" class="coord-copy-btn" disabled>复制</button>
                        <button type="button" class="coord-panel-btn" title="把编译产物写入：画布提示词节点 / Comfy 正向框 1·2 / LLM 输入框（点击目标时自动编译）">写入</button>
                    </div>
                </footer>
            </div>
        `;
        document.body.appendChild(el);
        this.dialog = el;

        // 元素引用
        this.statusEl = el.querySelector('.coord-status');
        this.wInput = el.querySelector('.coord-w');
        this.hInput = el.querySelector('.coord-h');
        this.presetSel = el.querySelector('.coord-preset');
        this.modesEl = el.querySelector('.coord-modes');
        this.modeDescEl = el.querySelector('.coord-mode-desc');
        this.summaryTa = el.querySelector('.coord-summary');
        this.itemsEl = el.querySelector('.coord-items');
        this.itemCountEl = el.querySelector('.coord-item-count');
        this.stageCv = el.querySelector('.coord-stage');
        this.aiOutTa = el.querySelector('.coord-ai-out');
        this.jsonNote = el.querySelector('.coord-json-note');
        this._outMode = '';           // 右栏输出内容来源：'' | 'ai' | 'compile'
        this.aiBtn = el.querySelector('.coord-ai-btn');
        this.modelSelectBtn = el.querySelector('.coord-model-select');
        this.skillSelectBtn = el.querySelector('.coord-skill-select');
        this.compileBtn = el.querySelector('.coord-compile-btn');
        this.copyBtn = el.querySelector('.coord-copy-btn');
        this.panelBtn = el.querySelector('.coord-panel-btn');

        // AI 模型下拉（LumenDropdown 平铺模式，与 LLM 面板模型下拉同组件
        // 同图标风格；菜单挂 body 自动向上弹，适配底栏位置）
        this.modelDropdown = new LumenDropdown(this.modelSelectBtn, {
            menuClass: 'coord-model-menu',
            placeholder: '选择模型',
            onChange: (v) => {
                // 显式选择持久化；选「自动」清掉选择回到跟随模式
                if (v) localStorage.setItem('lumenLight.coordModel', v);
                else localStorage.removeItem('lumenLight.coordModel');
            }
        });

        // 技能下拉（同款 LumenDropdown；数据源 pi 技能库 /api/pi-skills，
        // 选中技能的正文作为写作指引注入 AI 提示——见 _aiSystemPrompt）
        this.skillDropdown = new LumenDropdown(this.skillSelectBtn, {
            menuClass: 'coord-skill-menu',
            placeholder: '技能',
            onChange: (v) => {
                if (v) localStorage.setItem('lumenLight.coordSkill', v);
                else localStorage.removeItem('lumenLight.coordSkill');
            }
        });

        // 预设下拉（占位项 + PRESET_SIZES）
        this.presetSel.innerHTML = '<option value="">预设…</option>' +
            CoordinateLayout.PRESET_SIZES.map((p, i) =>
                `<option value="${i}">${LumenLight.escapeHtml(p.label)}</option>`).join('');
        this.presetSel.addEventListener('change', () => {
            const p = CoordinateLayout.PRESET_SIZES[Number(this.presetSel.value)];
            this.presetSel.value = '';
            if (!p) return;
            this._applyDims(p.width, p.height);
        });

        // 画幅输入（change 提交：step 箭头/键入回车都触发，避免逐字符钳制打架）
        this.wInput.addEventListener('change', () =>
            this._applyDims(CoordinateLayout.clampDim(Number(this.wInput.value) || this.draft.width), this.draft.height));
        this.hInput.addEventListener('change', () =>
            this._applyDims(this.draft.width, CoordinateLayout.clampDim(Number(this.hInput.value) || this.draft.height)));

        // 模式三选（分段按钮）
        for (const mode of CoordinateLayout.CANVAS_MODES) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'coord-mode-btn';
            b.dataset.mode = mode;
            b.textContent = mode === 'single' ? '单画布' :
                mode === 'multi_panel' ? '多格' : '拼贴';
            b.addEventListener('click', () => {
                const before = this._histSnapshot();
                this.draft.summary.canvas = mode;
                this._commitHistory(before, '改模式');
                this._renderModes();
                this._invalidateCompiled();
            });
            this.modesEl.appendChild(b);
        }

        // 整体描述（文本输入按防抖合并成一步历史，见 _beginTextInputHist）
        this.summaryTa.addEventListener('input', () => {
            this._beginTextInputHist();
            this.draft.summary.caption = this.summaryTa.value;
            this._invalidateCompiled();
        });
        this.summaryTa.addEventListener('blur', () => this._flushTextInputHist());

        // 添加元素（画幅中央 40% 见方的默认框）
        el.querySelector('.coord-add-item').addEventListener('click', () => {
            const before = this._histSnapshot();
            const { width: w, height: h } = this.draft;
            const cid = this._nextCid++;
            this.draft.items.push({
                cid,
                label: 'object', caption: '',
                bbox: CoordinateLayout.normalizeBox([w * 0.3, h * 0.3, w * 0.7, h * 0.7], w, h)
            });
            this.selected = this.draft.items.length - 1;
            this._commitHistory(before, '添加元素');
            this._invalidateCompiled();
            this._renderItems();
            this._renderStage();
        });

        // 舞台指针交互
        this.stageCv.addEventListener('pointerdown', (e) => this._onPointerDown(e));
        this.stageCv.addEventListener('pointermove', (e) => this._onPointerMove(e));
        this.stageCv.addEventListener('pointerup', (e) => this._onPointerUp(e));
        this.stageCv.addEventListener('pointercancel', () => this._cancelDrag());
        this.stageCv.addEventListener('dblclick', (e) => this._onStageDblClick(e));

        // 底部操作
        this.aiBtn.addEventListener('click', () => this._aiFill());
        this.compileBtn.addEventListener('click', () => this._compile());
        this.copyBtn.addEventListener('click', () => this._copyJson());
        // 写入下拉（动作型，模型/技能下拉同款）：目标 = 画布提示词节点
        // （打开菜单时动态枚举） / Comfy 正向框 / LLM 输入框。先注册自己的
        // click 刷新再建 LumenDropdown（at-target 按注册序触发，保证菜单
        // 展开前节点清单已刷新为当下画布状态）
        this._sendNodeMap = {};
        this._sendNodeSeq = 0;
        this.panelBtn.addEventListener('click', () => this._refreshSendTargets());
        this.sendDd = new LumenDropdown(this.panelBtn, {
            actionMenu: true,
            menuClass: 'coord-model-menu',
            placeholder: '写入',
            onChange: (v) => {
                if (!this.compiled?.ok) this._compile();
                const prompt = this.compiled?.prompt;
                if (!prompt) return;
                if (v === 'panel1') this._sendToPanel('posPrompt', '正向框 1');
                else if (v === 'panel2') this._sendToPanel('posPrompt2', '正向框 2');
                else if (v === 'llm') this._sendToLlm(prompt);
                else {
                    const node = this._sendNodeMap[v];
                    if (node) this._sendToPromptNode(node, prompt);
                }
                this.sendDd.setLabel('写入');
            }
        });
        this._refreshSendTargets();

        // 新建草稿：重置为默认草稿并立即自动保存（覆盖旧草稿，故先确认）
        el.querySelector('.coord-new-btn').addEventListener('click', () => {
            if (!confirm('新建将清空当前草稿（含已自动保存的内容），确定？')) return;
            this.draft = CoordinateLayout.createDraft();
            this.selected = -1;
            this._collapsedCids.clear();  // 收起态一并归零（默认展开）
            this._hiddenCids.clear();     // 眼睛隐藏态一并归零
            this._setBackground('');      // 背景参考图一并清除（草稿字段+舞台+悬浮条）
            this._resetHistory();         // 新基线：旧历史作废
            this._invalidateCompiled();   // 触发自动保存新草稿
            this.aiOutTa.value = '';
            this.jsonNote.textContent = '';
            this._outMode = '';
            this._renderAll();
            this._status('已新建草稿');
        });

        el.querySelector('.recipe-dialog-close').addEventListener('click', () => this.hide());

        // 全局键盘：ESC 关窗；Delete 删除选中元素；Ctrl+Z/Y 撤销重做
        // （Delete 与历史快捷键都不拦焦点在输入框里的原生气——Ctrl+Z 在
        // 输入框里撤销的是输入本身，并排时焦点在右侧面板同理放行）
        document.addEventListener('keydown', (e) => {
            if (!this.visible) return;
            if (e.key === 'Escape') {
                // 并排形态下焦点可能在右露出的面板里——只响源自弹窗内/
                // 无焦点目标的 ESC，不替面板吃掉取消输入的按键
                if (this._shouldCloseOnEscape(e.target)) this.hide();
                return;
            }
            const mod = e.ctrlKey || e.metaKey;
            if (mod && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
                if (!this._histKeyOwns(e.target)) return;
                e.preventDefault();
                this._flushTextInputHist();
                if (e.shiftKey && e.key.toLowerCase() === 'z') this._redoHist();
                else if (e.key.toLowerCase() === 'z') this._undoHist();
                else this._redoHist();
                return;
            }
            if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected >= 0) {
                const t = e.target;
                if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
                this._deleteItem(this.selected);
            }
        });

        // 窗口尺寸变化 → 重绘舞台（dpr/布局变了）
        window.addEventListener('resize', () => {
            if (this.visible) this._renderStage();
        });

        // 舞台悬浮工具条：背景参考图与生成图透显（CoordBackground 混入）
        this._buildBackgroundTools();

        // 右缘拖拽手柄：调整留给 Comfy/LLM 面板的宽度（窄屏由媒体查询隐藏）
        const rz = document.createElement('div');
        rz.className = 'coord-resize-handle';
        rz.title = '拖拽调整窗口宽度（右侧留白给 Comfy/LLM 面板）';
        el.appendChild(rz);
        rz.addEventListener('pointerdown', (ev) => this._onEdgeResizeStart(ev, rz));
        this._applyStoredGap();

        // 首次构建后恢复上次保存的草稿（异步；见 ADR 018）
        this._loadSavedDraft();
    },
});
