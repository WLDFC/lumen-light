/**
 * ==========================================================================
 * LumenLight 提示词节点技能栏（PromptSkillBar）
 * ==========================================================================
 * 作用：提示词节点底部的「技能下拉 + 执行按钮」工具行（交互样式参考
 *       对话输入框的「模式三角下拉 + 圆形发送按钮」）。
 *
 *   - 技能（skill）= 发给聊天模型的指令模板 + 输入配置（文本/图片）。
 *     技能来源有两种：内置（本文件 SKILLS 数组）+ 用户自定义
 *     （data/skills/ 目录下一个技能一个 JSON，经 /api/skills 读取，
 *      格式见 data/skills/README.md），同 id 时内置优先。
 *   - 执行流程：收集节点文本与直连参考图 → POST /api/llm/chat
 *     （复用右侧 LLM 对话框当前选中的聊天模型与 API 配置）→ 结果填回节点。
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
        id: 'optimize-prompt',
        name: '优化提示词',
        icon: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
        instruction: [
            '你是绘画提示词优化专家。把用户发来的绘画提示词改写得更具体、更有画面感，适合用于 AI 绘图。用户可能附带参考图：参考图是提示词所指的画面内容依据。',
            '规则：',
            '1. 只输出优化后的提示词本身，不要任何解释、前言或引号；',
            '2. 保留原意，不新增与原意无关的元素；',
            '3. 原文中的 @图片N 引用标记必须原样保留，位置和编号都不能改动；',
            '4. 若附带参考图，优化后的描述需与参考图内容保持一致（如人物外观、场景、色调），但不要输出对图片的单独描述；',
            '5. 保持语言与原文一致（中文输入输出中文，英文输入输出英文）。'
        ].join('\n'),
        inputText: true,
        inputImages: true,      // 可选输入：有连线图就附带（作为画面依据），没有则纯文本优化
        requireImages: false
    },
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

        this.buildDom();
        this.bindEvents();
        this.loadUserSkills();
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
        };
        document.addEventListener('mousedown', this._onDocMouseDown);
    }

    openMenu() {
        if (this.running) return;
        this.menuOpen = true;
        this.renderMenu();
        this.menuEl.hidden = false;
    }

    closeMenu() {
        this.menuOpen = false;
        this.menuEl.hidden = true;
    }

    /**
     * 解析技能使用的模型：
     *   1. 优先「设置 → API → 技能模型」的绑定（如把视觉模型绑给反推，
     *      不必动右侧对话框的对话模型）；
     *   2. 未绑定时回落右侧对话框当前选中的模型。
     * 每次执行时实时读取，设置改动即时生效。
     * @returns {Promise<{model: string, provider: string}>} 模型 ID 与所属厂商
     *          （model 可能为空串，由调用方提示；provider 为空表示由后端自动路由）
     */
    async resolveModel() {
        try {
            const response = await fetch('/api/settings');
            const result = await response.json();
            const binding = result.settings?.api?.bindings?.skill;
            if (binding && binding.model) {
                return { model: binding.model, provider: binding.provider || '' };
            }
        } catch {
            // 设置读取失败时静默回落到对话框模型
        }
        // 回落：右侧对话框当前选中项（下拉 value 为"厂商||模型ID"复合键，
        // 裸 ID 也兼容解析），拆出厂商供后端显式路由
        const raw = window.llmChat?.modelSelect?.value || '';
        return LumenLight.parseModelKey(raw);
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
            notify('未指定技能模型：请在设置 → API → 技能模型 中绑定，或在右侧对话框选择模型', 8000);
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
        if (running) this.closeMenu();
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
