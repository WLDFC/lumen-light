/**
 * ==========================================================================
 * MangaEditor 子模块：DOM 构建与事件绑定（自 MangaEditor.js 拆出）
 * 作用：首次 show 时一次性构建弹窗全部 DOM（三栏布局/底栏操作/右缘拖拽
 *       手柄/右上保存蓝钮与×红钮/关闭确认浮层），绑定全部事件（画幅输入/
 *       模式三选/整体描述/元素增删/舞台指针/底部 AI·技能（写入已退役）/
 *       全局键盘 ESC·Delete·Ctrl+Z·Y / resize），并在构建完成后触发
 *       草稿恢复（ADR 018）。×与 ESC 走 requestClose——距上次保存有改动
 *       先弹确认浮层（保存并关闭 / 直接关闭），逻辑在主类。
 * 契约：原型混入（partial-class，ADR 026）——本文件方法 Object.assign 进
 *       MangaEditor.prototype，this 即编辑器实例，草稿与子状态全部
 *       读写在实例字段上；须后于主类文件加载（混入依赖类已定义）。
 * 对应：css/manga-editor.css（窗口壳复用 recipe-manager.css 的
 *       recipe-dialog 骨架）；纯函数层 js/utils/CoordinateLayout.js。
 * ==========================================================================
 */

Object.assign(window.MangaEditor.prototype, {

    // ==================== DOM 构建 ====================

    _buildDom() {
        const el = document.createElement('div');
        el.className = 'recipe-dialog manga-dialog';
        el.innerHTML = `
            <div class="recipe-dialog-panel">
                <header class="recipe-dialog-header">
                    <div class="recipe-dialog-title-group">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="13" y1="12" x2="13" y2="21"/></svg>
                        <h2>漫画编辑</h2>
                    </div>
                    <div class="manga-file-wrap">
                        <button type="button" class="manga-file-btn" title="文件：置入图片（本地 / 画布）">文件</button>
                        <div class="manga-file-menu" hidden>
                            <button type="button" class="manga-file-item" data-act="local"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>置入本地图片…</button>
                            <button type="button" class="manga-file-item" data-act="canvas"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>从画布选择图片…</button>
                        </div>
                    </div>
                    <div class="manga-header-right">
                        <span class="manga-status"></span>
                        <button type="button" class="manga-project-btn" title="项目：新建/打开/删除漫画项目（一本漫画一个独立文件夹，生成图落项目内）">项目</button>
                        <div class="manga-export-wrap">
                            <button type="button" class="manga-export-page-btn" title="导出：本页到画布 / 本页到本地 / 本项目全部页面合成图打包到本地">导出</button>
                            <div class="manga-file-menu manga-export-menu" hidden>
                                <button type="button" class="manga-export-item" data-act="canvas"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>导出本页到画布</button>
                                <button type="button" class="manga-export-item" data-act="local"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>导出本页到本地</button>
                                <button type="button" class="manga-export-item" data-act="project"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8"></path><path d="M1 3h22v5H1z"></path><path d="M10 12h4"></path></svg>导出本项目到本地（zip）</button>
                            </div>
                        </div>
                        <button type="button" class="manga-save-btn" title="保存：草稿落盘到当前项目文件夹（保存后不退出；退出点右侧 ×）">保存</button>
                        <button class="recipe-dialog-close" type="button" title="关闭漫画编辑（有未保存的修改会先询问）" aria-label="关闭漫画编辑窗口"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                    </div>
                </header>
                <div class="manga-body">
                    <aside class="manga-side">
                        <section class="manga-sec manga-sec-summary">
                            <div class="manga-sec-title">整体描述</div>
                            <textarea class="manga-summary" rows="3" placeholder="这张图整体是什么：题材、风格、光线、氛围……（AI 写提示词的依据）"></textarea>
                        </section>
                        <section class="manga-sec manga-sec-items">
                            <div class="manga-sec-title">元素 <span class="manga-item-count"></span><button type="button" class="manga-items-eye" title="隐藏全部元素框（仅编辑器视图，不影响编译）"></button></div>
                            <div class="manga-items"></div>
                            <button type="button" class="manga-add-item">＋ 添加元素</button>
                        </section>
                    </aside>
                    <div class="manga-stage-wrap">
                        <div class="manga-stage-area">
                            <canvas class="manga-stage"></canvas>
                        </div>
                    </div>
                    <aside class="manga-side manga-out-side">
                        <div class="manga-out-body">
                        <section class="manga-sec manga-sec-palette" data-out-sec="palette">
                            <div class="manga-sec-title">色板 <span class="manga-dim-note">（画笔/文字按当前工具生效）</span></div>
                            <div class="manga-palette-host"></div>
                            <div class="manga-palette-grid"></div>
                        </section>
                        <section class="manga-sec" data-out-sec="size">
                            <div class="manga-sec-title">画幅 <span class="manga-dim-note">（16 的倍数）</span></div>
                            <div class="manga-dims">
                                <label class="manga-dim-field">宽 <input type="number" class="manga-w" min="${CoordinateLayout.MIN_DIM}" max="${CoordinateLayout.MAX_DIM}" step="16"></label>
                                <label class="manga-dim-field">高 <input type="number" class="manga-h" min="${CoordinateLayout.MIN_DIM}" max="${CoordinateLayout.MAX_DIM}" step="16"></label>
                                <select class="manga-preset" title="常用画幅预设"></select>
                            </div>
                        </section>
                        <section class="manga-sec" data-out-sec="size">
                            <div class="manga-sec-title">模式</div>
                            <div class="manga-modes"></div>
                            <div class="manga-mode-desc"></div>
                        </section>
                        <section class="manga-sec manga-sec-layers" data-out-sec="layers">
                            <div class="manga-layers-head">
                                <span class="manga-sec-title">图层 <span class="manga-layers-note"></span></span>
                                <span class="manga-layers-actions">
                                    <button type="button" class="manga-layers-add-img" title="置入本地图片为图层（适配画幅居中，可拖动/锚点缩放）">
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                                    </button>
                                    <button type="button" class="manga-layers-add" title="新建笔迹图层（画笔画在活动层上）">＋</button>
                                </span>
                            </div>
                            <div class="manga-layer-opacity" hidden>
                                <span class="manga-layer-opacity-label">不透明度</span>
                                <input type="range" class="manga-layer-opacity-range" min="0.05" max="1" step="0.05" value="1" title="当前图层的不透明度（选中图片层或活动笔迹层）">
                                <span class="manga-layer-opacity-val">100%</span>
                            </div>
                            <div class="manga-layers"></div>
                            <input type="file" class="manga-layer-file" accept="image/*" hidden>
                        </section>
                        <section class="manga-sec manga-sec-ai-out" data-out-sec="output">
                            <div class="manga-sec-title">输出 <span class="manga-out-note">AI 文案 · 编译 JSON</span></div>
                            <textarea class="manga-ai-out" spellcheck="false" placeholder="AI 写提示词 / 编译 JSON 的输出显示在这里，可直接编辑——AI 输出态下改完再编译，按你改后的文案编译"></textarea>
                            <div class="manga-json-note"></div>
                            <div class="manga-out-actions">
                                <button type="button" class="manga-compile-btn" title="把当前草稿编译成坐标提示词 JSON 显示在上方输出框">编译 JSON</button>
                                <button type="button" class="manga-copy-btn" disabled title="复制编译产物到剪贴板">复制</button>
                            </div>
                        </section>
                        </div>
                        <div class="manga-out-rail">
                            <button type="button" class="manga-tool-btn manga-out-toggle" data-out-sec="palette" title="色板：收起/展开（画笔/文字取色）" aria-pressed="true">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>
                            </button>
                            <button type="button" class="manga-tool-btn manga-out-toggle" data-out-sec="size" title="画幅与模式：收起/展开" aria-pressed="true">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"/><path d="M1 6.13L16 6a2 2 0 0 1 2 2v15"/></svg>
                            </button>
                            <button type="button" class="manga-tool-btn manga-out-toggle" data-out-sec="layers" title="图层：收起/展开" aria-pressed="true">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
                            </button>
                            <button type="button" class="manga-tool-btn manga-out-toggle" data-out-sec="output" title="输出 / 提示词框：收起/展开" aria-pressed="true">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                            </button>
                        </div>
                    </aside>
                </div>
                <footer class="manga-footer">
                    <div class="manga-footer-left">
                        <div class="manga-ai-split">
                            <button type="button" class="manga-ai-btn" title="用 AI 模型补全整体描述与各元素文案（几何保持不动）">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z"/></svg>
                                <span>AI 写提示词</span>
                            </button>
                            <button type="button" class="manga-ai-model-btn" aria-label="选择 AI 写提示词使用的模型" title="AI 写提示词使用的模型"></button>
                        </div>
                        <button type="button" class="manga-skill-select" aria-label="选择 AI 写提示词的技能指引" aria-haspopup="listbox" title="AI 写提示词附加的写作指引：选自 pi 技能库（data/pi/skills/，面板「工具与技能」弹窗管理），技能正文注入提示词；「不使用技能」保持默认风格"></button>
                    </div>
                    <div class="manga-footer-right">
                        <div class="manga-gen-modes" role="group" aria-label="生成模式">
                            <button type="button" class="manga-gen-mode" data-mode="comfy" title="Comfy 模式：委托右侧 Comfy 面板提交（工作流/主模型/负面/LoRA/参数都在面板选）">Comfy</button>
                            <button type="button" class="manga-gen-mode" data-mode="api" title="API 模式：选 API 生图模型直出（按页面画幅比例）">API</button>
                        </div>
                        <button type="button" class="manga-genmodel-select" aria-label="选择 API 生图模型" aria-haspopup="listbox" title="API 生图模型（仅 API 模式可用；Comfy 模式的工作流与主模型在右侧面板选择，此按钮占位锁定防跳动）"></button>
                        <button type="button" class="manga-gen-btn" title="Comfy 模式：编译产物写入面板正面框 2（框 1 留质量词）并触发面板提交，出图自动落当前页图层；API 模式：直连出图。编译失败时改用右栏文本">生成</button>
                    </div>
                </footer>
            </div>
        `;
        document.body.appendChild(el);
        this.dialog = el;

        // 元素引用
        this.bodyEl = el.querySelector('.manga-body');
        this.statusEl = el.querySelector('.manga-status');
        this.wInput = el.querySelector('.manga-w');
        this.hInput = el.querySelector('.manga-h');
        this.presetSel = el.querySelector('.manga-preset');
        this.modesEl = el.querySelector('.manga-modes');
        this.modeDescEl = el.querySelector('.manga-mode-desc');
        this.summaryTa = el.querySelector('.manga-summary');
        this.itemsEl = el.querySelector('.manga-items');
        this.itemCountEl = el.querySelector('.manga-item-count');
        this.itemsEyeEl = el.querySelector('.manga-items-eye');   // 分区级眼睛（全隐/全显元素框）
        // 文件菜单（ADR 075 自灯箱迁移）：置入本地 / 从画布选图
        this.fileBtnEl = el.querySelector('.manga-file-btn');
        this.fileMenuEl = el.querySelector('.manga-file-menu');
        // 图层面板（MangaLayers 混入）
        this.layersEl = el.querySelector('.manga-layers');
        this.layersNoteEl = el.querySelector('.manga-layers-note');
        this.layersAddBtn = el.querySelector('.manga-layers-add');
        this.layersAddImgBtn = el.querySelector('.manga-layers-add-img');
        this.layerOpacityWrap = el.querySelector('.manga-layer-opacity');
        this.layerOpacityRange = el.querySelector('.manga-layer-opacity-range');
        this.layerOpacityVal = el.querySelector('.manga-layer-opacity-val');
        this.layerFileEl = el.querySelector('.manga-layer-file');
        this.stageCv = el.querySelector('.manga-stage');
        this.aiOutTa = el.querySelector('.manga-ai-out');
        this.jsonNote = el.querySelector('.manga-json-note');
        this._outMode = '';           // 右栏输出内容来源：'' | 'ai' | 'compile'
        this.aiBtn = el.querySelector('.manga-ai-btn');
        this.modelSelectBtn = el.querySelector('.manga-ai-model-btn');
        this.skillSelectBtn = el.querySelector('.manga-skill-select');
        this.compileBtn = el.querySelector('.manga-compile-btn');
        this.copyBtn = el.querySelector('.manga-copy-btn');
        this.saveBtn = el.querySelector('.manga-save-btn');
        this.projectBtn = el.querySelector('.manga-project-btn');
        this.exportPageBtn = el.querySelector('.manga-export-page-btn');

        // AI 模型下拉（LumenDropdown 图标按钮模式，与 LLM 面板模型下拉同组件
        // 同图标风格；菜单挂 body 自动向上弹，适配底栏位置）。触发器是
        // 「AI 写提示词」分体钮右侧的 caret 区——只显示静态箭头不显示选项
        // 文案，当前选中进菜单对勾与悬停 title（写作模型并入 AI 按钮，
        // footer 只留生图一个模型下拉防混扰）
        this.modelDropdown = new LumenDropdown(this.modelSelectBtn, {
            menuClass: 'manga-model-menu',
            placeholder: '选择模型',
            iconButton: true,
            triggerIcon: '<polyline points="6 9 12 15 18 9"/>',
            onChange: (v) => {
                // 显式选择持久化；选「自动」清掉选择回到跟随模式
                if (v) localStorage.setItem('lumenLight.mangaModel', v);
                else localStorage.removeItem('lumenLight.mangaModel');
            }
        });

        // 技能下拉（同款 LumenDropdown；数据源 pi 技能库 /api/pi-skills，
        // 选中技能的正文作为写作指引注入 AI 提示——见 _aiSystemPrompt）
        this.skillDropdown = new LumenDropdown(this.skillSelectBtn, {
            menuClass: 'manga-skill-menu',
            placeholder: '技能',
            onChange: (v) => {
                if (v) localStorage.setItem('lumenLight.mangaSkill', v);
                else localStorage.removeItem('lumenLight.mangaSkill');
            }
        });

        // 生图模型下拉与「生成」按钮：MangaGenerate 混入自建
        //（_buildGenerateTools，本文件只出 DOM 壳）

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
            b.className = 'manga-mode-btn';
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
        el.querySelector('.manga-add-item').addEventListener('click', () => {
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

        // 分区级眼睛（标题行）：全部元素框一键隐藏/显示（_toggleAllItemsHidden
        // 在 MangaPanel 混入，与单卡眼睛共用 _hiddenCids 视图态）
        this.itemsEyeEl.addEventListener('click', () => this._toggleAllItemsHidden());

        // 文件菜单（ADR 075）：按钮开合下拉，菜单项分流置入本地/画布选图；
        // 点外部关闭（mousedown 捕获，放行按钮与菜单自身）
        this.fileBtnEl.addEventListener('click', () => {
            this.fileMenuEl.hidden = !this.fileMenuEl.hidden;
        });
        // 绑定范围必须收在文件菜单容器内——全弹窗查 .manga-file-item 会
        // 把其他复用该类样式的菜单项（如导出菜单）也绑进来，点击时两个
        // handler 同时触发（2026-11-08 用户实测踩中：导出项弹出画布选图）
        el.querySelector('.manga-file-wrap').querySelectorAll('.manga-file-item').forEach((item) => {
            item.addEventListener('click', () => {
                this.fileMenuEl.hidden = true;
                if (item.dataset.act === 'local') this._openLocalImageFiles();
                else this._openFileCanvasPicker();
            });
        });
        document.addEventListener('mousedown', (e) => {
            if (this.fileMenuEl.hidden) return;
            if (this.fileWrapEl?.contains(e.target)) return;
            this.fileMenuEl.hidden = true;
        }, true);
        this.fileWrapEl = el.querySelector('.manga-file-wrap');

        // 画布选图弹窗（+ 文件菜单 → 从画布选择图片）：多选网格，逻辑在
        // MangaLayers 混入（_openFileCanvasPicker/_onFileCanvasPickerOk）
        this.pickerEl = document.createElement('div');
        this.pickerEl.className = 'manga-picker-mask';
        this.pickerEl.hidden = true;
        this.pickerEl.innerHTML = `
            <div class="manga-picker">
                <div class="manga-picker-head">
                    <span class="manga-picker-title">选择画布图片</span>
                    <button type="button" class="manga-picker-close" title="关闭">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                </div>
                <div class="manga-picker-body"><div class="manga-picker-grid"></div></div>
                <div class="manga-picker-foot">
                    <span class="manga-picker-count"></span>
                    <button type="button" class="manga-picker-cancel">取消</button>
                    <button type="button" class="manga-picker-ok">确定</button>
                </div>
            </div>`;
        this.pickerEl.addEventListener('pointerdown', (e) => {
            if (e.target === this.pickerEl) this._closeFileCanvasPicker();
        });
        this.pickerEl.querySelector('.manga-picker-close')
            .addEventListener('click', () => this._closeFileCanvasPicker());
        this.pickerEl.querySelector('.manga-picker-cancel')
            .addEventListener('click', () => this._closeFileCanvasPicker());
        this.pickerEl.querySelector('.manga-picker-ok')
            .addEventListener('click', () => this._onFileCanvasPickerOk());
        el.appendChild(this.pickerEl);

        // 舞台指针交互
        // 中键默认行为拦截（ADR 077）：pointerdown 的 preventDefault 拦不住
        // 浏览器中键自动滚动，须在 mousedown/auxclick 上按 button===1 单独
        // preventDefault（主画布 CanvasInteraction 与灯箱 StudioDomBuilder 同款）
        this.stageCv.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
        this.stageCv.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
        this.stageCv.addEventListener('pointerdown', (e) => this._onPointerDown(e));
        this.stageCv.addEventListener('pointermove', (e) => this._onPointerMove(e));
        this.stageCv.addEventListener('pointerup', (e) => this._onPointerUp(e));
        this.stageCv.addEventListener('pointercancel', () => this._cancelDrag());
        this.stageCv.addEventListener('pointerleave', () => this._hideCursorRing());   // 画笔光标圈离台隐藏
        this.stageCv.addEventListener('dblclick', (e) => this._onStageDblClick(e));
        // 滚轮缩放画布（passive:false 才能 preventDefault 拦截弹窗滚动）
        this.stageCv.addEventListener('wheel', (e) => this._onStageWheel(e), { passive: false });
        // 舞台左缘工具条（选择/画笔，MangaTools 混入）
        this._buildToolRail();
        // 右栏右缘收纳图标栏（画幅+模式 / 图层 / 输出框，独立开关）
        this._buildOutRail();
        // 图层面板事件（新建/置入图片，MangaLayers 混入）
        this._buildLayerPanel();
        // 右栏色板分区（取色器 + 最近使用/预设网格，MangaTools 混入，ADR 068）
        this._buildPaletteSection();

        // 底部操作
        this.aiBtn.addEventListener('click', () => this._aiFill());
        this.compileBtn.addEventListener('click', () => this._compile());
        this.copyBtn.addEventListener('click', () => this._copyJson());

        // 右上保存/关闭（参考 ImageStudio：保存不退出；关闭走 requestClose
        // ——距上次保存有改动先弹确认，确认浮层见 _buildSaveConfirm）。
        // 项目钮逻辑在 MangaProjects 混入（ADR 071）；导出菜单在 MangaExport
        // 混入（ADR 079：本页到画布 / 本页到本地 / 本项目 zip 三项）
        this.saveBtn.addEventListener('click', () => this.save());
        this.projectBtn.addEventListener('click', () => this._openProjectModal());
        this._buildExportTools();
        el.querySelector('.recipe-dialog-close').addEventListener('click', () => this.requestClose());
        this._buildSaveConfirm();

        // 全局键盘：ESC 关窗；Delete 删除选中元素/图层；Ctrl+Z/Y 撤销重做
        // （Delete 与历史快捷键都不拦焦点在输入框里的原生气——Ctrl+Z 在
        // 输入框里撤销的是输入本身，并排时焦点在右侧面板同理放行）
        document.addEventListener('keydown', (e) => {
            if (!this.visible) return;
            // 移除推理进行中（忙碌遮罩已挡指针）：键盘入口一并守卫——
            // Ctrl+Z/Y 会回滚到推理前的快照、Delete 删层会让结果无处落
            // 层，灯箱 _setBusy 同语义（2026-11-07 ADR 076）
            if (this._remove && this._remove._removing) {
                if (e.key === 'Escape' || e.ctrlKey || e.metaKey ||
                    e.key === 'Delete' || e.key === 'Backspace') e.preventDefault();
                return;
            }
            if (e.key === 'Escape') {
                // 关闭确认浮层开着时先收浮层（取消，留在编辑器）
                if (this._confirmEl && !this._confirmEl.hidden) {
                    this._hideSaveConfirm();
                    return;
                }
                // 页面右键菜单开着时先让它收（预制件约定：宿主 Esc 链先查 isOpen）
                if (this.railCtxMenu && this.railCtxMenu.isOpen) return;
                // 并排形态下焦点可能在右露出的面板里——只响源自弹窗内/
                // 无焦点目标的 ESC，不替面板吃掉取消输入的按键
                if (this._shouldCloseOnEscape(e.target)) this.requestClose();
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
            if (e.key === 'Delete' || e.key === 'Backspace') {
                const t = e.target;
                if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
                const target = this._keyDeleteTarget();
                if (!target) return;
                if (target.kind === 'element') { this._deleteItem(target.index); return; }
                // 图层删除（键盘入口，等同右键菜单「删除图层」，灯箱同款语义）。
                // 生成回填期冻结——结果落层，与层栈改动冲突
                if (this.genRunning) return;
                e.preventDefault();
                this._deleteLayer(target.id);
            }
        });

        // 窗口尺寸变化 → 重绘舞台（dpr/布局变了）
        window.addEventListener('resize', () => {
            if (this.visible) this._renderStage();
        });

        // 舞台悬浮工具条：背景参考图与生成图透显（MangaBackground 混入）
        this._buildBackgroundTools();

        // 标题栏「分镜模板」按钮（MangaTemplates 混入，插在「背景」右边）
        this._buildTemplateTools();

        // 标题栏画笔选项条：色板 + 粗细滑块（MangaTools 混入，画笔激活时显示）
        this._buildBrushBar();

        // 标题栏文字选项条：字体/字号/横竖排/色板（MangaText 混入，文字工具激活时显示）
        this._buildTextBar();

        // 标题栏形状选项条：类型/填充/边框/边宽/圆角（MangaShape 混入，ADR 069，
        // 形状工具激活时显示）
        this._buildShapeBar();

        // 底栏生成簇：模式开关/生图模型/生成（MangaGenerate 混入）
        this._buildGenerateTools();

        // 页面栏（最左 100px：多页缩略图与页面操作——MangaPages 混入）
        this._buildPageRail();

        // 右缘拖拽手柄：调整留给 Comfy/LLM 面板的宽度（窄屏由媒体查询隐藏）
        const rz = document.createElement('div');
        rz.className = 'manga-resize-handle';
        rz.title = '拖拽调整窗口宽度（右侧留白给 Comfy/LLM 面板）';
        el.appendChild(rz);
        rz.addEventListener('pointerdown', (ev) => this._onEdgeResizeStart(ev, rz));
        this._applyStoredGap();

        // 首次构建后恢复上次保存的草稿（异步；见 ADR 018）。保存点快照
        // 先按当前文档建基线（恢复成功后 _loadSavedDraft 会重建）
        this._exportSnap = this._docSnapshot();
        this._loadSavedDraft();
    },

    /**
     * 关闭确认浮层（保存/X 的 X 触发，requestClose 弹出）：遮罩盖全弹窗
     * + 居中小面板，两选项——「保存并关闭」（save() 成功才关）/「直接
     * 关闭」（不落画布图直接关）。点遮罩空白 = 取消；ESC 先收浮层
     * （MangaDom 键盘分支）。选项语义见 MangaEditor.requestClose 注记
     */
    _buildSaveConfirm() {
        const el = document.createElement('div');
        el.className = 'manga-confirm';
        el.hidden = true;
        el.innerHTML = `
            <div class="manga-confirm-panel">
                <div class="manga-confirm-text">页面有未保存的修改，保存后关闭吗？</div>
                <div class="manga-confirm-btns">
                    <button type="button" class="manga-confirm-save">保存并关闭</button>
                    <button type="button" class="manga-confirm-close">直接关闭</button>
                </div>
            </div>
        `;
        el.querySelector('.manga-confirm-save').addEventListener('click', () => this._confirmSaveAndClose());
        el.querySelector('.manga-confirm-close').addEventListener('click', () => this._confirmCloseOnly());
        // 文案/按钮引用（_showSaveConfirm 按场景换文案与标签，ADR 072）
        this._confirmTextEl = el.querySelector('.manga-confirm-text');
        this._confirmSaveBtnEl = el.querySelector('.manga-confirm-save');
        this._confirmCloseBtnEl = el.querySelector('.manga-confirm-close');
        // 点遮罩空白（面板之外）= 取消，留在编辑器
        el.addEventListener('click', (e) => {
            if (e.target === el) this._hideSaveConfirm();
        });
        this.dialog.appendChild(el);
        this._confirmEl = el;
    },

    /**
     * Delete 键删除对象决策（键盘入口与右键菜单同语义，纯查状态无副作用，
     * vm 可测）：元素选中优先（图层选中与元素选中互斥，此序只作防御性
     * 兜底）→ 图片层选中（舞台锚点/面板蓝描边）→ 活动笔迹层（删空后
     * 画笔回落/自动重建见 _activeStrokeLayer）。无目标返回 null
     */
    _keyDeleteTarget() {
        if (this.selected >= 0) return { kind: 'element', index: this.selected };
        if (this._selLayerId != null && this._layerById(this._selLayerId)) {
            return { kind: 'layer', id: this._selLayerId };
        }
        if (this._activeLayerId != null && this._layerById(this._activeLayerId)) {
            return { kind: 'layer', id: this._activeLayerId };
        }
        return null;
    },

    /**
     * 右栏右缘收纳图标栏：两个图标独立开关「画幅+模式」「输出框」。
     * 全收起时分区主体隐藏，右栏从 308px 缩到只剩 40px 图标栏（舞台变宽）；
     * 状态存 localStorage（lumenLight.mangaOutSections，主类构造恢复）
     */
    _buildOutRail() {
        const rail = this.dialog.querySelector('.manga-out-rail');
        if (!rail) return;
        rail.querySelectorAll('.manga-out-toggle').forEach((btn) => {
            btn.addEventListener('click', () => {
                const key = btn.dataset.outSec;
                if (!(key in this._outSections)) return;
                this._outSections[key] = !this._outSections[key];
                try {
                    localStorage.setItem('lumenLight.mangaOutSections',
                        JSON.stringify(this._outSections));
                } catch { /* 隐私模式等：只影响记忆 */ }
                this._applyOutSections();
            });
        });
        this._applyOutSections();   // 恢复上次分区状态
    },

    /** 应用分区显隐：图标激活态 + 分区 hidden + 全收起时主体让位 */
    _applyOutSections() {
        const side = this.dialog && this.dialog.querySelector('.manga-out-side');
        if (!side) return;
        const anyOpen = Object.values(this._outSections).some(Boolean);
        const body = side.querySelector('.manga-out-body');
        if (body) body.hidden = !anyOpen;
        side.classList.toggle('is-collapsed', !anyOpen);   // 放开 308px 宽（CSS）
        side.querySelectorAll('[data-out-sec]').forEach((el) => {
            const key = el.dataset.outSec;
            if (!(key in this._outSections)) return;
            if (el.classList.contains('manga-out-toggle')) {
                el.classList.toggle('is-active', !!this._outSections[key]);
                if (el.hasAttribute('aria-pressed')) {
                    el.setAttribute('aria-pressed', String(!!this._outSections[key]));
                }
            } else {
                el.hidden = !this._outSections[key];
            }
        });
    },
});
