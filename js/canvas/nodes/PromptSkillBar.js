/**
 * ==========================================================================
 * LumenLight 提示词节点技能栏（PromptSkillBar）
 * ==========================================================================
 * 作用：提示词节点底部的「技能下拉 + 执行按钮」工具行（交互样式参考
 *       对话输入框的「模式三角下拉 + 圆形发送按钮」）。
 *
 *   - 技能（skill）= 发给聊天模型的指令模板 + 输入配置（文本/图片）。
 *     技能来源有两种：内置（本文件 SKILLS 数组，现仅反推图像——
 *     优化提示词已迁移为用户技能 data/skills/optimize-prompt.md）
 *     + 用户自定义（data/skills/ 目录下一个技能一个 .md，经 /api/skills
 *      读取，格式见 data/skills/README.md），同 id 时内置优先。
 *   - 模型下拉（技能右侧，2026-10 起取代 设置 → API → 技能模型 全局绑定）：
 *     选择技能使用的聊天模型，全局记忆（localStorage，所有节点共用）；
 *     只列聊天模型（排除生图与 pi/网页桥接特殊项），内部值用复合键
 *     「厂商||模型ID」保跨厂商同名模型的路由唯一性，文案只显示模型名。
 *     无存储值或存储值失效时自动选清单第一序模型（不再跟随对话框——
 *     右侧常驻 agent 模式时对话框没有可借用的 API 模型）。
 *   - 执行流程：收集节点文本与直连参考图 → POST /api/llm/chat
 *     （按技能栏选择的模型）→ 结果填回节点。
 *   - 反推图像类技能的参考图顺序与节点缩略图的 @图片N 编号一致
 *     （都来自 PromptNode.collectInputImages）。
 *
 * 依赖：window.llmChat（当前模型）、window.socket（通知提示）、
 *       ImagePipeline.imageToDataUrl（参考图转 base64，运行时才调用）。
 * ==========================================================================
 */

// ==================== 内置技能定义 ====================
// 字段说明：
//   id          唯一标识
//   name        下拉里显示的名称
//   icon        Feather 风格线稿 path（白色描边，由 CSS 控制尺寸）
//   instruction 发给模型的 system 指令（技能的本体就是这段话）
//   inputText   是否把节点文字作为内容发给模型
//   inputImages 是否把直连参考图发给模型（需要能看图的多模态模型）
const SKILLS = [
    {
        id: 'image-to-prompt',
        name: '反推图像',
        icon: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
        instruction: [
            '你是绘画提示词反推专家。用户发来的图片按顺序对应提示词中的 @图片N 编号，请为图片反推出适合 AI 绘图的提示词描述。',
            '规则：',
            '1. 多张图片时按编号分段，每段以「@图片N：」开头；单张图片直接输出提示词；',
            '2. 描述要覆盖主体、动作、构图、风格、光线、色调等绘画要素；',
            '3. 只输出提示词内容，不要任何解释或前言。'
        ].join('\n'),
        inputText: false,
        inputImages: true,
        requireImages: true     // 必需输入：没连线参考图直接报错
    }
];

// ==================== 用户技能图标键名映射 ====================
// 用户技能文件（data/skills/*.json）里的 icon 字段只允许键名，
// 由这里映射为 Feather 风格线稿 path——不直接注入用户提供的 SVG，杜绝 XSS
const SKILL_ICONS = {
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    type: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>'
};

// ==================== 聊天模型清单（技能模型下拉数据源） ====================
// 模块级共享缓存：同一页面的多个提示词节点共用一次 /api/settings 拉取
// （30s TTL）。只保留聊天模型——排除生图模型（type 标记 + 名称启发式）
// 与 pi/网页桥接两个特殊 provider（技能走 /api/llm/chat，其余无意义）。
// 清单只用于下拉展示；执行时 resolveModel 仍以选择键/对话框实时为准
const CHAT_MODELS_TTL = 30 * 1000;
let chatModelsCache = { at: 0, promise: null };

function fetchChatModels() {
    if (chatModelsCache.promise && Date.now() - chatModelsCache.at < CHAT_MODELS_TTL) {
        return chatModelsCache.promise;
    }
    chatModelsCache.at = Date.now();
    chatModelsCache.promise = fetch('/api/settings')
        .then((r) => r.json())
        .then((result) => {
            const { models } = LumenLight.collectConfiguredModels((result.settings && result.settings.api) || {});
            return models.filter((m) => m.provider !== 'pi' && m.provider !== 'web' &&
                m.type !== 'image' &&
                !(m.type === 'auto' && LumenLight.looksLikeImageModel(m.id)));
        })
        .catch(() => []);   // 拉取失败：空清单，不打断节点创建
    return chatModelsCache.promise;
}

class PromptSkillBar {
    /**
     * 构造函数：创建技能栏 DOM 并插入提示词节点
     * @param {PromptNode} node - 宿主提示词节点（取文本/参考图、回填结果）
     */
    constructor(node) {
        this.node = node;
        // 技能列表 = 内置（代码中的 SKILLS）+ 用户自定义（data/skills/ 目录）
        // 用户技能由 loadUserSkills 异步加载，加载完成前下拉只显示内置项
        this.skills = SKILLS.map((s) => ({ ...s, source: 'built-in' }));
        this.current = this.skills[0];   // 默认选中第一个技能
        this.running = false;            // 是否执行中（防重复触发）
        this.menuOpen = false;
        this.userPicked = false;         // 用户是否手动选过技能（默认选中迁移只发生在未挑选时）

        // 技能模型（全局记忆，所有节点共用）：'' = 跟随右侧对话框模型，
        // 否则为复合键「厂商||模型ID」。清单懒加载（首次展开模型菜单才拉取）
        this.currentModelKey = localStorage.getItem('lumenLight.skillModel') || '';
        this.chatModels = [];
        this.modelMenuOpen = false;

        this.buildDom();
        this.buildModelDom();
        this.bindEvents();
        this.loadUserSkills();
        this.loadChatModels();   // 对齐默认模型（清单来自共享缓存，多数时候已就绪）
    }

    /**
     * 拉取用户自定义技能（data/skills/ 目录，经 /api/skills）并合并进列表。
     * 同 id 冲突时内置优先；加载失败静默降级为仅内置技能。
     * 异步执行：加载完成前下拉先显示内置项，完成后自动刷新菜单。
     */
    async loadUserSkills() {
        try {
            const response = await fetch('/api/skills');
            const result = await response.json();
            if (result.status !== 'ok' || !Array.isArray(result.skills)) return;

            const builtInIds = new Set(SKILLS.map((s) => s.id));
            for (const raw of result.skills) {
                if (builtInIds.has(raw.id)) continue;   // 内置优先
                this.skills.push({
                    id: raw.id,
                    name: raw.name,
                    icon: SKILL_ICONS[raw.icon] || SKILL_ICONS.star,
                    instruction: raw.instruction,
                    inputText: !!raw.inputText,
                    inputImages: !!raw.inputImages,
                    requireImages: !!raw.requireImages,
                    source: 'user'
                });
            }
            // 技能列表可能已变化：刷新菜单与触发按钮（当前选中不受影响）
            this.renderMenu();
        } catch {
            // 后端不可达等情况：保持仅内置技能，不打断使用
        }
        // 默认选中迁移：优化提示词（历史上的默认技能）已是用户技能、排在
        // 内置项之后，若用户尚未手动挑选，把它选回来，保持开箱默认行为
        if (!this.userPicked) {
            const preferred = this.skills.find((s) => s.id === 'optimize-prompt');
            if (preferred && preferred !== this.current) {
                this.current = preferred;
                this.renderTrigger();
                this.renderMenu();
            }
        }
    }

    /**
     * 构建 DOM：工具行（技能触发按钮 + 圆形执行按钮）+ 下拉面板
     * 插入到节点内（缩放手柄之前），随 --ns 缩放
     */
    buildDom() {
        // 工具行容器
        this.barEl = document.createElement('div');
        this.barEl.className = 'prompt-skill-bar';

        // 技能触发按钮：当前技能图标 + 名称 + 三角下拉开合
        this.triggerEl = document.createElement('button');
        this.triggerEl.type = 'button';
        this.triggerEl.className = 'prompt-skill-trigger';
        this.triggerEl.title = '选择技能';

        // 圆形执行按钮（↑，与参考交互一致）
        this.runEl = document.createElement('button');
        this.runEl.type = 'button';
        this.runEl.className = 'prompt-skill-run';
        this.runEl.title = '执行技能';
        this.runEl.innerHTML =
            '<svg class="run-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';

        // 下拉面板（默认隐藏，打开时渲染技能项）
        this.menuEl = document.createElement('div');
        this.menuEl.className = 'prompt-skill-menu';
        this.menuEl.hidden = true;

        this.barEl.appendChild(this.triggerEl);
        this.barEl.appendChild(this.runEl);
        this.barEl.appendChild(this.menuEl);

        // 插到缩放手柄之前（保持手柄在最上层可点）
        this.node.el.insertBefore(this.barEl, this.node.resizeEl);

        this.renderTrigger();
        this.renderMenu();
    }

    /**
     * 渲染触发按钮：当前技能图标 + 名称 + 三角
     * 名称来自技能定义（用户技能为外部数据），必须转义防注入
     */
    renderTrigger() {
        this.triggerEl.innerHTML =
            `<svg class="skill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${this.current.icon}</svg>` +
            `<span class="skill-name">${LumenLight.escapeHtml(this.current.name)}</span>` +
            '<svg class="skill-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
    }

    /**
     * 构建模型下拉（技能触发按钮右侧、执行按钮左侧）：
     * 复用技能下拉的交互样式与菜单类。触发按钮与菜单包一层定位容器——
     * 菜单的定位父级是容器而非整条技能栏，弹出位置才紧贴模型按钮
     */
    buildModelDom() {
        this.modelWrapEl = document.createElement('div');
        this.modelWrapEl.className = 'prompt-skill-model-wrap';

        this.modelTriggerEl = document.createElement('button');
        this.modelTriggerEl.type = 'button';
        this.modelTriggerEl.className = 'prompt-skill-trigger prompt-skill-model-trigger';
        this.modelTriggerEl.title = '技能使用的模型（全局记忆，所有节点共用）';

        this.modelMenuEl = document.createElement('div');
        this.modelMenuEl.className = 'prompt-skill-menu prompt-skill-model-menu';
        this.modelMenuEl.hidden = true;

        this.modelWrapEl.appendChild(this.modelTriggerEl);
        this.modelWrapEl.appendChild(this.modelMenuEl);
        this.barEl.insertBefore(this.modelWrapEl, this.runEl);

        this.modelTriggerEl.addEventListener('click', () => {
            this.modelMenuOpen ? this.closeModelMenu() : this.openModelMenu();
        });
        this.renderModelTrigger();
    }

    /** 模型选项文案：默认只显示模型名；跨厂商同名模型加厂商后缀消歧义 */
    modelDisplayText(m) {
        const dup = this.chatModels.some((x) => x.id === m.id && x.provider !== m.provider);
        return dup ? `${m.displayName}（${m.provider}）` : m.displayName;
    }

    renderModelTrigger() {
        const selected = this.chatModels.find((m) => m.key === this.currentModelKey);
        const label = this.currentModelKey
            ? (selected ? this.modelDisplayText(selected)
                        : LumenLight.parseModelKey(this.currentModelKey).id)
            : '模型';
        this.modelTriggerEl.innerHTML =
            `<span class="skill-name">${LumenLight.escapeHtml(label)}</span>` +
            '<svg class="skill-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
    }

    openModelMenu() {
        if (this.running) return;
        this.closeMenu();
        this.modelMenuOpen = true;
        this.modelMenuEl.innerHTML = '<div class="prompt-skill-hint">加载中…</div>';
        this.modelMenuEl.hidden = false;
        this.loadChatModels();
    }

    /**
     * 拉取聊天模型清单（模块级共享缓存）并对齐默认选中：
     * 无存储值或存储值已失效（厂商/模型被删）时自动选第一序模型并持久化。
     * 触发按钮与展开中的菜单随之刷新
     */
    loadChatModels() {
        return fetchChatModels().then((models) => {
            this.chatModels = models;
            if (models.length && !models.some((m) => m.key === this.currentModelKey)) {
                this.currentModelKey = models[0].key;
                localStorage.setItem('lumenLight.skillModel', this.currentModelKey);
            }
            this.renderModelTrigger();
            if (this.modelMenuOpen) this.renderModelMenu();
        });
    }

    closeModelMenu() {
        this.modelMenuOpen = false;
        this.modelMenuEl.hidden = true;
    }

    /**
     * 渲染模型菜单：全部聊天模型（默认选中第一序，见 loadChatModels）
     */
    renderModelMenu() {
        this.modelMenuEl.innerHTML = '';
        if (!this.chatModels.length) {
            const tip = document.createElement('div');
            tip.className = 'prompt-skill-hint';
            tip.textContent = '暂无可用模型：请先在 设置 → API 配置厂商与模型';
            this.modelMenuEl.appendChild(tip);
        }
        for (const m of this.chatModels) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'prompt-skill-option' +
                (m.key === this.currentModelKey ? ' selected' : '');
            btn.title = this.modelDisplayText(m);
            btn.innerHTML =
                `<span class="skill-name">${LumenLight.escapeHtml(this.modelDisplayText(m))}</span>` +
                '<svg class="skill-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
            btn.addEventListener('click', () => {
                this.currentModelKey = m.key;
                localStorage.setItem('lumenLight.skillModel', m.key);
                this.renderModelTrigger();
                this.closeModelMenu();
            });
            this.modelMenuEl.appendChild(btn);
        }
    }

    /**
     * 渲染下拉面板的技能项（内置 + 用户自定义，当前选中项带对勾）
     */
    renderMenu() {
        this.menuEl.innerHTML = '';
        for (const skill of this.skills) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'prompt-skill-option' +
                (skill.id === this.current.id ? ' selected' : '');
            btn.title = skill.source === 'user' ? '用户自定义技能（data/skills/）' : '';
            btn.innerHTML =
                `<svg class="skill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${skill.icon}</svg>` +
                `<span class="skill-name">${LumenLight.escapeHtml(skill.name)}</span>` +
                '<svg class="skill-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
            btn.addEventListener('click', () => {
                this.current = skill;
                this.userPicked = true;   // 用户手动挑选后不再自动迁移默认选中
                this.renderTrigger();
                this.renderMenu();
                this.closeMenu();
            });
            this.menuEl.appendChild(btn);
        }
    }

    /**
     * 绑定事件：开合下拉、执行、点击外部关闭、阻止节点拖动透传
     */
    bindEvents() {
        // 工具行内的 mousedown 不转发给画布交互层（否则点按钮会变成拖动节点），
        // 同时不让 document 的「点击外部关闭」误关刚打开的面板
        this.barEl.addEventListener('mousedown', (e) => e.stopPropagation());

        this.triggerEl.addEventListener('click', () => {
            this.menuOpen ? this.closeMenu() : this.openMenu();
        });

        this.runEl.addEventListener('click', () => this.run());

        // 点击面板外关闭（工具行内部点击已被上面拦截，不会走到这里）
        this._onDocMouseDown = (e) => {
            if (this.menuOpen && !this.barEl.contains(e.target)) this.closeMenu();
            if (this.modelMenuOpen && !this.barEl.contains(e.target)) this.closeModelMenu();
        };
        document.addEventListener('mousedown', this._onDocMouseDown);
    }

    openMenu() {
        if (this.running) return;
        this.closeModelMenu();   // 两个下拉互斥，不同时展开
        this.menuOpen = true;
        this.renderMenu();
        this.menuEl.hidden = false;
    }

    closeMenu() {
        this.menuOpen = false;
        this.menuEl.hidden = true;
    }

    /**
     * 解析技能使用的模型：技能栏模型下拉的选择（全局记忆，复合键
     * 「厂商||模型ID」，后端按厂商显式路由——跨厂商同名模型也不会串）。
     * 默认选中由 loadChatModels 对齐为清单第一序；这里只在清单未就绪/
     * 为空时返回空串，交由上层提示
     * @returns {Promise<{model: string, provider: string}>} 模型 ID 与所属厂商
     */
    async resolveModel() {
        if (!this.currentModelKey) return { model: '', provider: '' };
        const { provider, id } = LumenLight.parseModelKey(this.currentModelKey);
        return { model: id, provider };
    }

    /**
     * 执行当前技能：收集输入 → 调聊天接口 → 结果填回节点
     * 校验失败/请求失败通过通知提示，不改动节点已有文本
     */
    async run() {
        if (this.running) return;
        const notify = (text, duration) =>
            window.socket?.showNotification?.(text, duration);

        const { model, provider } = await this.resolveModel();
        if (!model) {
            notify('未指定技能模型：请在技能栏的模型下拉选择（需先在 设置 → API 配置厂商与模型）', 8000);
            return;
        }

        // 收集输入：节点文字 / 直连参考图（顺序与缩略图 @图片N 一致）。
        // inputImages 为「可选输入」：有连线图就附带，没有则纯文本执行；
        // requireImages 为「必需输入」：没连线图直接报错（如反推图像）
        const text = this.node.inputEl.value.trim();
        let images = [];
        if (this.current.inputImages) {
            const objs = this.node.collectInputImages();
            if (objs.length === 0) {
                if (this.current.requireImages) {
                    notify(`「${this.current.name}」需要先连线参考图`);
                    return;
                }
            } else {
                images = (await Promise.all(
                    objs.map(obj => ImagePipeline.imageToDataUrl(obj.img.src))
                )).filter(Boolean);
                if (images.length === 0) {
                    notify('参考图读取失败，请检查连线图片');
                    return;
                }
            }
        }
        if (this.current.inputText && !text) {
            notify('节点内容为空，没有可处理的内容');
            return;
        }

        // 组装消息：指令为 system，节点文字为 user（无文字技能给一句引导）
        const messages = [{ role: 'system', content: this.current.instruction }];
        const userContent = text || '请按规则处理这些图片。';
        messages.push({ role: 'user', content: userContent });

        this.setRunning(true);
        try {
            const response = await fetch('/api/llm/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // provider 为空时由后端按模型 ID 自动路由（undefined 字段不会序列化）
                body: JSON.stringify({ model, provider: provider || undefined, messages, images })
            });
            const result = await response.json();
            if (response.ok && result.status === 'ok' && result.reply) {
                // 结果填回本节点（放法A）：走 input 事件同步 text 与镜像层
                this.node.inputEl.value = result.reply;
                this.node.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                notify('技能执行完成');
            } else {
                notify('技能执行失败: ' + (result.message || '模型未返回内容'), 8000);
            }
        } catch (err) {
            notify('技能执行失败: ' + err.message, 8000);
            console.error('技能执行失败:', err);
        } finally {
            this.setRunning(false);
        }
    }

    /**
     * 执行态切换：按钮转圈 + 禁用，防止重复触发
     */
    setRunning(running) {
        this.running = running;
        this.runEl.classList.toggle('running', running);
        this.runEl.disabled = running;
        this.triggerEl.disabled = running;
        this.modelTriggerEl.disabled = running;
        if (running) {
            this.closeMenu();
            this.closeModelMenu();
        }
    }

    /**
     * 销毁：移除 document 级监听（节点删除时由宿主调用）
     */
    destroy() {
        document.removeEventListener('mousedown', this._onDocMouseDown);
    }
}

// 将类与技能定义暴露到全局作用域
PromptSkillBar.SKILLS = SKILLS;
window.PromptSkillBar = PromptSkillBar;
