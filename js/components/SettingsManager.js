/**
 * ==========================================================================
 * LumenLight 设置管理器组件
 * 作用：设置界面的外壳与调度中心。负责创建弹窗 DOM、渲染左侧分类列表、
 *       按当前分类把右侧内容区交给对应面板渲染，并统一管理设置数据的
 *       加载与本地偏好（localStorage）的读写。
 *
 * 分类面板拆分在 js/components/settings/ 目录下：
 *   - SettingsGeneralPanel  通用（画布锚点显隐）
 *   - SettingsApiPanel      API（提供商 / 端点 / Key / 模型配置 / 保存）
 *   - SettingsRembgPanel    抠图模型（下载 / 续传 / 取消 / 删除）
 * 面板统一接口：constructor(manager) / render() / onLeave()
 *
 * 注意：本文件的两个静态方法被画布相关模块直接调用
 *       （CanvasRenderer 读锚点开关、ImageToolbar 读当前抠图模型），
 *       拆分面板时必须保持它们挂在 SettingsManager 上，不可迁走。
 * ==========================================================================
 */

/** 当前选用的抠图模型在 localStorage 中的键名 */
const REMBG_ACTIVE_KEY = 'lumenlight_rembg_model';

/** 抠图默认模型 ID，需与后端 rembg.js 的 DEFAULT_MODEL 保持一致 */
const REMBG_DEFAULT_MODEL = 'ben2';

/** 是否显示图片四角缩放锚点在 localStorage 中的键名 */
const SHOW_RESIZE_HANDLES_KEY = 'lumenlight_show_resize_handles';

/** 画布显示质量档位在 localStorage 中的键名 */
const IMAGE_QUALITY_KEY = 'lumenlight_canvas_image_quality';

/** 提示词自动补全开关在 localStorage 中的键名 */
const PROMPT_AUTOCOMPLETE_KEY = 'lumenlight_prompt_autocomplete';

class SettingsManager {
    /**
     * 读取当前选用的抠图模型 ID
     * 供 ImageToolbar 等调用方获取，未设置过时返回默认模型
     * @returns {string} 模型 ID
     */
    static getActiveRembgModel() {
        return localStorage.getItem(REMBG_ACTIVE_KEY) || REMBG_DEFAULT_MODEL;
    }

    /**
     * 写入当前选用的抠图模型 ID
     * 由抠图面板在用户切换下拉框、或已选模型被删除时回退调用
     * @param {string} modelId - 模型 ID
     */
    static setActiveRembgModel(modelId) {
        localStorage.setItem(REMBG_ACTIVE_KEY, modelId);
    }

    /**
     * 读取是否显示图片四角缩放锚点
     * 供 CanvasRenderer 在绘制时判断，未设置过时默认显示。
     * 注意：该开关只影响锚点的"可见性"，不影响缩放功能本身——
     * 关闭后拖拽图片四角依然可以缩放，光标提示也依然保留。
     * @returns {boolean} 是否显示锚点
     */
    static getShowResizeHandles() {
        // 只有显式存过 'false' 才隐藏，其余情况（含未设置）均显示
        return localStorage.getItem(SHOW_RESIZE_HANDLES_KEY) !== 'false';
    }

    /**
     * 写入是否显示图片四角缩放锚点
     * @param {boolean} show - 是否显示
     */
    static setShowResizeHandles(show) {
        localStorage.setItem(SHOW_RESIZE_HANDLES_KEY, show ? 'true' : 'false');
    }

    /**
     * 读取画布显示质量档位
     * 供 ImageProxyCache 在绘制时获取代理长边上限，未设置过时默认
     * 'native'（原生质量，不降采样）。档位只影响画布显示性能，
     * 灯箱查看 / 高清放大 / 抠图 / 保存始终使用原始图片数据。
     * @returns {string} 'native' | 'balanced' | 'performance'
     */
    static getImageQuality() {
        return localStorage.getItem(IMAGE_QUALITY_KEY) || 'native';
    }

    /**
     * 写入画布显示质量档位
     * @param {string} quality - 'native' | 'balanced' | 'performance'
     */
    static setImageQuality(quality) {
        localStorage.setItem(IMAGE_QUALITY_KEY, quality);
    }

    /**
     * 读取提示词自动补全开关
     * 供 PromptNode / PromptInputManager 在创建补全实例前判断，
     * 未设置过时默认开启（部分模型不需要 tag 补全，可在通用设置关闭）
     * @returns {boolean} 是否启用补全
     */
    static getPromptAutocompleteEnabled() {
        // 只有显式存过 'false' 才关闭，其余情况（含未设置）均开启
        return localStorage.getItem(PROMPT_AUTOCOMPLETE_KEY) !== 'false';
    }

    /**
     * 写入提示词自动补全开关并广播变更事件
     * 画布提示词节点与面板正/负向输入框监听 promptAutocompleteSettingChanged
     * 即时启停补全，无需刷新页面
     * @param {boolean} enabled - 是否启用
     */
    static setPromptAutocompleteEnabled(enabled) {
        localStorage.setItem(PROMPT_AUTOCOMPLETE_KEY, enabled ? 'true' : 'false');
        window.dispatchEvent(new CustomEvent('promptAutocompleteSettingChanged', {
            detail: { enabled }
        }));
    }

    /**
     * 构造函数
     */
    constructor() {
        // 设置分类配置（后续扩展在此处添加，并在 this.panels 里登记对应面板）
        this.categories = [
            { id: 'general', label: '通用' },
            { id: 'api', label: 'API' },
            { id: 'mcp', label: 'MCP' },
            { id: 'webbridge', label: '网页桥接' },
            { id: 'rembg', label: '抠图模型' }
        ];

        // 当前选中的分类，与分类列表首项保持一致
        this.currentCategory = 'general';

        // 当前缓存的设置数据
        // 新版结构：按 API 厂商分组保存多套配置，避免不同厂商的 key 互相串
        this.settings = this.getDefaultSettings();

        // DOM 元素引用
        this.modal = null;
        this.categoryListEl = null;
        this.contentEl = null;

        // 分类 id -> 面板实例。面板持有自己的局部状态（如模型清单、轮询定时器）
        this.panels = {
            general: new SettingsGeneralPanel(this),
            api: new SettingsApiPanel(this),
            mcp: new SettingsMcpPanel(this),
            webbridge: new SettingsWebBridgePanel(this),
            rembg: new SettingsRembgPanel(this)
        };

        this.init();
    }

    /**
     * 获取默认设置结构
     * 新版：api.currentProvider + api.providers.{Deepseek/OpenAI/Doubao}
     * @returns {Object} 默认设置
     */
    getDefaultSettings() {
        return {
            api: {
                currentProvider: 'Deepseek',
                providers: {
                    Deepseek: { endpoint: '', apiKey: '', models: [] },
                    OpenAI: { endpoint: '', apiKey: '', models: [] },
                    Doubao: { endpoint: '', apiKey: '', models: [] }
                }
            }
        };
    }

    /**
     * 兼容旧版 settings.json 结构
     * 旧版：api: { provider, endpoint, apiKey, models }
     * 新版：api: { currentProvider, providers: {...} }
     * @param {Object} settings - 从后端读取到的设置
     * @returns {Object} 迁移后的设置
     */
    migrateSettings(settings) {
        if (!settings || typeof settings !== 'object' || !settings.api) {
            return this.getDefaultSettings();
        }

        const api = settings.api;
        // 如果已经是新版结构，直接返回
        if (api.providers && typeof api.providers === 'object') {
            return settings;
        }

        // 旧版结构迁移到新版
        const provider = api.provider || 'Deepseek';
        const migrated = this.getDefaultSettings();
        migrated.api.currentProvider = provider;
        migrated.api.providers[provider] = {
            endpoint: api.endpoint || '',
            apiKey: api.apiKey || '',
            models: Array.isArray(api.models) ? api.models : []
        };
        return migrated;
    }

    /**
     * 获取当前选中厂商的配置
     * 供外部调用方读取（面板内部走自身的同名方法）
     * @returns {Object} { endpoint, apiKey, models }
     */
    getCurrentProviderConfig() {
        const api = this.settings.api || {};
        const provider = api.currentProvider || 'Deepseek';
        const providers = api.providers || {};
        return providers[provider] || { endpoint: '', apiKey: '', models: [] };
    }

    /**
     * 初始化：绑定打开按钮事件、创建模态框 DOM（初始隐藏）
     * 同时预加载设置，使 LLM 聊天等组件在应用启动后即可使用已保存的 API 配置。
     */
    init() {
        this.createModal();
        this.bindOpenButton();
        // 预加载设置，失败时不阻塞界面，仅控制台输出日志
        this.loadSettings(false);
    }

    /**
     * 创建设置模态框 DOM
     */
    createModal() {
        // 如果已存在则不再创建
        if (document.getElementById('settingsModal')) return;

        const modal = document.createElement('div');
        modal.id = 'settingsModal';
        modal.className = 'settings-modal';
        modal.innerHTML = `
            <div class="settings-modal-backdrop"></div>
            <div class="settings-modal-body">
                <div class="settings-sidebar">
                    <div class="settings-sidebar-header">
                        <span>设置</span>
                    </div>
                    <ul class="settings-category-list" id="settingsCategoryList"></ul>
                </div>
                <div class="settings-content">
                    <div class="settings-content-header">
                        <h2 id="settingsContentTitle">API</h2>
                        <button class="settings-close-btn" id="settingsCloseBtn" aria-label="关闭">✕</button>
                    </div>
                    <div class="settings-content-body" id="settingsContentBody"></div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        this.modal = modal;
        this.categoryListEl = document.getElementById('settingsCategoryList');
        this.contentEl = document.getElementById('settingsContentBody');

        // 绑定关闭事件
        document.getElementById('settingsCloseBtn').addEventListener('click', () => this.close());
        modal.querySelector('.settings-modal-backdrop').addEventListener('click', () => this.close());

        // 绑定键盘 ESC 关闭
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen()) {
                this.close();
            }
        });

        this.renderCategories();
    }

    /**
     * 绑定文件菜单中的“设置”按钮
     */
    bindOpenButton() {
        const btn = document.getElementById('settingsBtn');
        if (!btn) return;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.open();
        });
    }

    /**
     * 渲染左侧分类列表
     */
    renderCategories() {
        if (!this.categoryListEl) return;

        this.categoryListEl.innerHTML = this.categories.map(cat => `
            <li class="settings-category-item ${cat.id === this.currentCategory ? 'active' : ''}"
                data-category="${cat.id}">
                ${cat.label}
            </li>
        `).join('');

        // 绑定分类点击事件
        this.categoryListEl.querySelectorAll('.settings-category-item').forEach(item => {
            item.addEventListener('click', () => {
                this.currentCategory = item.dataset.category;
                this.renderCategories();
                this.renderContent();
            });
        });

        this.renderContent();
    }

    /**
     * 渲染右侧内容区：更新标题，并把内容交给当前分类对应的面板
     */
    renderContent() {
        const titleEl = document.getElementById('settingsContentTitle');
        const cat = this.categories.find(c => c.id === this.currentCategory);
        if (titleEl && cat) {
            titleEl.textContent = cat.label;
        }

        if (!this.contentEl) return;

        // 通知所有非当前面板做清理（如抠图面板停止下载进度轮询），
        // 避免切走后仍有定时器在后台发请求
        Object.keys(this.panels).forEach(id => {
            if (id !== this.currentCategory) this.panels[id].onLeave();
        });

        const panel = this.panels[this.currentCategory];
        if (panel) {
            panel.render();
        } else {
            this.contentEl.innerHTML = '<div class="settings-empty">暂无设置项</div>';
        }
    }

    /**
     * 打开设置界面：先加载最新设置，然后重新渲染内容
     */
    async open() {
        if (!this.modal) this.createModal();
        await this.loadSettings(true);
        this.renderContent();
        this.modal.classList.add('show');
    }

    /**
     * 关闭设置界面
     */
    close() {
        if (this.modal) {
            this.modal.classList.remove('show');
        }
        // 关闭时通知所有面板清理（下载本身在后端继续，重新打开会恢复轮询）
        Object.values(this.panels).forEach(panel => panel.onLeave());
    }

    /**
     * 判断设置界面是否打开
     * @returns {boolean}
     */
    isOpen() {
        return this.modal && this.modal.classList.contains('show');
    }

    /**
     * 从后端加载设置
     * @param {boolean} showStatus - 是否在界面中显示加载状态或错误提示
     */
    async loadSettings(showStatus = false) {
        const statusEl = document.getElementById('settingsSaveStatus');
        if (showStatus && statusEl) {
            statusEl.textContent = '正在加载设置...';
            statusEl.className = 'settings-save-status';
        }

        try {
            const response = await fetch('/api/settings');
            const result = await response.json();
            if (result.status === 'ok' && result.settings) {
                // 后端已经迁移，但前端再执行一次迁移可确保兼容性
                this.settings = this.migrateSettings(result.settings);
                if (showStatus && statusEl) {
                    statusEl.textContent = '';
                }
            } else {
                throw new Error(result.message || '加载设置失败');
            }
        } catch (error) {
            console.error('加载设置失败:', error);
            if (showStatus && statusEl) {
                statusEl.textContent = '加载设置失败：' + error.message;
                statusEl.classList.add('error');
            }
        }
    }
}

// 将 SettingsManager 暴露到全局作用域
window.SettingsManager = SettingsManager;
