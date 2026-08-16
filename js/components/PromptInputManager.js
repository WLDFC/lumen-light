/**
 * ==========================================================================
 * LumenLight 提示词输入管理组件
 * 作用：管理右侧面板中的正向 / 负向提示词输入区域，包括：
 *       1. 正向提示词输入框
 *       2. 负向提示词输入框
 *       3. 负面提示词折叠面板状态
 * 后续可扩展：提示词补全、提示词历史记录、提示词保存/加载等功能。
 * ==========================================================================
 */

class PromptInputManager {
    /**
     * 构造函数
     * 初始化 DOM 引用并绑定事件
     */
    constructor() {
        // 正向提示词输入框 1（质量/画风类，长期稳定）
        this.posPrompt = document.getElementById('posPrompt');
        // 正向提示词输入框 2（人物/动作等内容类，常改动）
        this.posPrompt2 = document.getElementById('posPrompt2');
        // 负向提示词输入框
        this.negPrompt = document.getElementById('negPrompt');
        // 各折叠区外层与切换按钮（id 前缀：posPrompt1 / posPrompt2 / negPrompt）
        this.negPromptWrap = document.getElementById('negPromptWrap');
        this.negPromptToggle = document.getElementById('negPromptToggle');

        this.init();

        // 跟随设置开关即时启停面板补全（SettingsManager 切换时广播）
        this._onAutocompleteSetting = (e) => {
            this.setAutocompleteEnabled(!!(e.detail && e.detail.enabled));
        };
        window.addEventListener('promptAutocompleteSettingChanged', this._onAutocompleteSetting);
    }

    /**
     * 初始化提示词输入相关功能
     */
    init() {
        this.initPromptCollapses();
        this.initAutocomplete();
    }

    /**
     * 初始化三个提示词区的折叠交互（正面 1 / 正面 2 / 负面共用）。
     * 正面框默认展开，负面框默认折叠；手动状态各自记忆在 localStorage
     */
    initPromptCollapses() {
        this.initCollapsible('posPrompt1', '正面提示词 1', 'posPrompt1Collapsed', false);
        this.initCollapsible('posPrompt2', '正面提示词 2', 'posPrompt2Collapsed', false);
        this.initCollapsible('negPrompt', '负面提示词', 'negPromptCollapsed', true);
    }

    /**
     * 初始化单个可折叠提示词区。
     * 结构约定：#<id>Wrap 内含 #<id>Header（整条标题栏可点击切换）与
     * #<id>Toggle（▶/▼ 箭头按钮）；折叠状态记忆在 localStorage
     * @param {string} id - 元素 id 前缀（Wrap/Header/Toggle 共用）
     * @param {string} name - 提示词名称（按钮 title 用）
     * @param {string} storageKey - 折叠状态在 localStorage 的键
     * @param {boolean} defaultCollapsed - 无记忆时的默认折叠状态
     */
    initCollapsible(id, name, storageKey, defaultCollapsed) {
        const wrap = document.getElementById(`${id}Wrap`);
        const header = document.getElementById(`${id}Header`);
        const toggle = document.getElementById(`${id}Toggle`);
        if (!wrap || !toggle) return;

        const saved = localStorage.getItem(storageKey);
        const collapsed = saved !== null ? saved === 'true' : defaultCollapsed;
        const apply = (isCollapsed) => {
            wrap.classList.toggle('collapsed', isCollapsed);
            toggle.textContent = isCollapsed ? '▶' : '▼';
            toggle.title = `${isCollapsed ? '展开' : '收起'}${name}`;
            localStorage.setItem(storageKey, String(isCollapsed));
        };
        apply(collapsed);

        toggle.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            apply(!wrap.classList.contains('collapsed'));
        });
        // 点击标题栏任意位置也可切换
        header?.addEventListener('click', (e) => {
            if (e.target.closest(`#${toggle.id}`)) return;
            apply(!wrap.classList.contains('collapsed'));
        });
    }

    /**
     * 初始化正 / 负面提示词输入框的自动补全功能
     */
    initAutocomplete() {
        // 为正 / 负面提示词输入框分别绑定自动补全组件
        // 词典加载/缓存在共享单例 PromptDictStore 中，所有实例只持一份数据；
        // 受通用设置开关控制，部分模型不需要 tag 补全时可全局关闭
        if (!SettingsManager.getPromptAutocompleteEnabled()) return;
        if (this.posPrompt && !this.posAutocomplete) {
            this.posAutocomplete = new PromptAutocomplete(this.posPrompt, {
                maxResults: 15,
                debounceMs: 150
            });
        }
        if (this.posPrompt2 && !this.pos2Autocomplete) {
            this.pos2Autocomplete = new PromptAutocomplete(this.posPrompt2, {
                maxResults: 15,
                debounceMs: 150
            });
        }
        if (this.negPrompt && !this.negAutocomplete) {
            this.negAutocomplete = new PromptAutocomplete(this.negPrompt, {
                maxResults: 15,
                debounceMs: 150
            });
        }
    }

    /**
     * 即时启停面板正/负向提示词输入框的补全（通用设置开关切换时调用）
     * @param {boolean} enabled - 是否启用
     */
    setAutocompleteEnabled(enabled) {
        if (enabled) {
            this.initAutocomplete();
            return;
        }
        if (this.posAutocomplete) {
            this.posAutocomplete.destroy();
            this.posAutocomplete = null;
        }
        if (this.pos2Autocomplete) {
            this.pos2Autocomplete.destroy();
            this.pos2Autocomplete = null;
        }
        if (this.negAutocomplete) {
            this.negAutocomplete.destroy();
            this.negAutocomplete = null;
        }
    }

    /**
     * 获取合并后的面板提示词。
     * 两个正面框交给 PromptMerge.join 统一合并：框 1 在前（质量/画风类）、
     * 框 2 在后（人物/动作等内容类），段间空行、拼接处自动补逗号
     * （区分中英文）。PanelComfyRunner 经此发送合并结果，画布 Comfy
     * 生图节点取负面词
     * @returns {{positive: string, negative: string}} 提示词对象
     */
    getPrompts() {
        const pos1 = this.posPrompt ? this.posPrompt.value : '';
        const pos2 = this.posPrompt2 ? this.posPrompt2.value : '';
        return {
            positive: PromptMerge.join([pos1, pos2]),
            negative: this.negPrompt ? this.negPrompt.value : ''
        };
    }
}

// 将 PromptInputManager 类暴露到全局作用域
window.PromptInputManager = PromptInputManager;