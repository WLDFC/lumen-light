/**
 * ==========================================================================
 * LumenLight 全局配置与工具模块
 * 作用：定义应用的全局配置项（图片尺寸限制、缩放范围），提供固定深色主题
 *       初始化方法和全局唯一 ID 生成方法。该模块作为 LumenLight 命名空间
 *       挂载到全局作用域，供其他模块调用。
 * ==========================================================================
 */

const LumenLight = {
    /**
     * 全局配置对象
     * - minZoom: 画布最小缩放比例 1%
     * - maxZoom: 画布最大缩放比例 500%
     * - resizeHandleSize: 缩放控制点（圆点）的直径（屏幕像素，绘制时会做反视口缩放补偿）
     * - resizeHandleHitPadding: 控制点命中判定的额外容差（屏幕像素），让小控制点更易抓取
     * - minImageSize: 图片缩放后的最小边长（世界坐标），防止被拉成不可见的一条线
     */
    config: {
        minZoom: 0.01,        // 最小缩放比例
        maxZoom: 5,          // 最大缩放比例
        // 圆点直径 7 + 两侧容差 4 = 命中区总宽 15px，
        // 与旧版 9px 方点 + 3px 容差的手感保持一致：看起来更小，抓起来一样容易
        resizeHandleSize: 7,          // 缩放控制点圆点直径
        resizeHandleHitPadding: 4,    // 控制点命中容差
        minImageSize: 20,             // 图片缩放最小边长
        // ---- 图片连线（节点式串联）配置：屏幕像素，绘制时做反视口缩放补偿 ----
        connectionDotRadius: 5,       // 端口圆点半径
        connectionDotGap: 5,          // 圆点与图片边缘的固定间距（需求：5 像素）
        connectionDotHitPadding: 4,   // 端口圆点命中容差（小圆点更易抓取）
        connectionLineWidth: 2.5,       // 连线线宽
        connectionHitTolerance: 12    // 连线点击命中容差（用于点击断开，屏幕像素）
    },
    
    /**
     * 初始化主题
     * 当前固定为深色模式，不读取 localStorage，也不提供主题切换功能
     */
    initTheme() {
        // 强制设置 HTML 根节点的 data-theme 属性为 dark
        document.documentElement.setAttribute('data-theme', 'dark');
    },
    
    // ✅ 已移除 toggleTheme 方法，不再支持主题切换
    // toggleTheme() { ... }
    
    /**
     * 生成全局唯一 ID
     * 格式为 "img_" 前缀加上 9 位随机字符
     * @returns {string} 生成的唯一 ID
     */
    generateId() {
        return 'img_' + Math.random().toString(36).substr(2, 9);
    },

    /**
     * 转义 HTML 特殊字符，防止用户输入污染界面
     * 供各组件在拼接 innerHTML 时使用（尤其是插入模型名、路径等外部数据时）
     * @param {string} text - 原始文本
     * @returns {string} 转义后的安全文本
     */
    escapeHtml(text) {
        if (!text) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    },

    /**
     * 构造模型复合键："厂商名||模型ID"。
     * 不同厂商可配置同名模型（如两个中转站都有 gpt-image-2），
     * 下拉框的 value 必须全局唯一才能共存，因此用复合键作身份；
     * 发送请求时用 parseModelKey 拆回厂商与模型 ID。
     * @param {string} provider - 厂商名
     * @param {string} id - 模型 ID
     * @returns {string} 复合键
     */
    modelKey(provider, id) {
        return `${provider}||${id}`;
    },

    /**
     * 解析模型复合键（modelKey 的逆操作）
     * 兼容旧格式：不含 '||' 分隔符的值视为裸模型 ID（旧存档/旧下拉值），厂商为空
     * @param {string} key - 复合键或裸模型 ID
     * @returns {{provider: string, id: string}}
     */
    parseModelKey(key) {
        const raw = String(key || '');
        const index = raw.indexOf('||');
        if (index === -1) return { provider: '', id: raw };
        return { provider: raw.slice(0, index), id: raw.slice(index + 2) };
    },

    /**
     * 聚合所有「已配置」（有端点和 Key）厂商的模型列表。
     * 多厂商并存的前端基础：对话/生图/技能的模型下拉框都从这里取数据，
     * 请求时显式携带厂商名，后端直接路由到对应厂商（见 routes/llm.js）。
     * 不做跨厂商去重：不同厂商的同名模型（如两个中转站都有 gpt-image-2）
     * 各自保留一条，靠复合键（key 字段）区分，选项文案带厂商名便于辨别。
     * @param {Object} api - settings.api（{ currentProvider, providers }）
     * @returns {{models: Array, providerCount: number}}
     *   models: [{key, id, displayName, type, provider}]；providerCount: 已配置厂商数
     */
    collectConfiguredModels(api) {
        const providers = (api && api.providers) || {};
        const currentProvider = (api && api.currentProvider) || 'Deepseek';

        // 当前厂商排最前（下拉框默认选中它的第一个模型），其余按声明顺序
        const names = [
            currentProvider,
            ...Object.keys(providers).filter((name) => name !== currentProvider)
        ];

        const models = [];
        const seen = new Set();
        let providerCount = 0;
        for (const name of names) {
            const config = providers[name];
            if (!config || !config.endpoint || !config.apiKey) continue;
            providerCount++;
            const list = Array.isArray(config.models) ? config.models : [];
            for (const entry of list) {
                const id = typeof entry === 'string' ? entry : entry?.id;
                if (!id) continue;
                const key = LumenLight.modelKey(name, id);
                // 同一厂商内部重复 id 防御（跨厂商的同名模型不去重）
                if (seen.has(key)) continue;
                seen.add(key);
                models.push({
                    key,
                    id,
                    displayName: (typeof entry === 'object' && entry.displayName) || id,
                    type: (typeof entry === 'object' && entry.type) || 'auto',
                    provider: name
                });
            }
        }
        return { models, providerCount };
    }
};
