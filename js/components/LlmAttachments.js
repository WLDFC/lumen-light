/**
 * ==========================================================================
 * LumenLight LLM 图片附件管理组件
 * 作用：管理 LLM 聊天窗口中待发送的图片附件（参考图），
 *       支持本地文件上传、远程/画布图片 URL 添加、缩略图渲染与移除。
 *       本组件从 LlmChat 中拆分出来，避免聊天主类继续膨胀。
 * ==========================================================================
 */

class LlmAttachments {
    /**
     * 构造函数
     * @param {string|HTMLElement} container - 附件缩略图容器（DOM 元素或 ID）
     * @param {Object} [options] - 配置项
     * @param {Function} [options.onChange] - 附件列表变化时的回调
     */
    constructor(container, options = {}) {
        this.containerEl = typeof container === 'string' ? document.getElementById(container) : container;
        this.onChange = options.onChange || (() => {});
        // 待发送的图片（base64 data URL 数组）
        this.images = [];
    }

    /**
     * 获取当前所有待发送图片
     * @returns {string[]} base64 data URL 数组
     */
    getAll() {
        return [...this.images];
    }

    /**
     * 当前是否有附件
     * @returns {boolean}
     */
    hasImages() {
        return this.images.length > 0;
    }

    /**
     * 清空所有附件
     */
    clear() {
        this.images = [];
        this.render();
        this.onChange();
    }

    /**
     * 从本地文件对象添加图片
     * @param {File} file - 图片文件
     */
    addFromFile(file) {
        if (!file || !file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            this.addImageUrl(e.target.result);
        };
        reader.readAsDataURL(file);
    }

    /**
     * 从图片地址添加附件
     * 支持 data URL、本站地址、第三方远程地址三种来源：
     *   - data URL：直接加入
     *   - 本站地址（画布图片）：浏览器直接抓取转 base64
     *   - 第三方远程地址（如 API 返回的 CDN 图）：受浏览器 CORS 限制，
     *     改走后端代理 /api/llm/download-image 下载后转 base64
     * @param {string} src - 图片地址
     */
    addImageUrl(src) {
        if (src.startsWith('data:')) {
            this.images.push(src);
            this.render();
            this.onChange();
            return;
        }

        // 第三方 http(s) 地址走后端代理，避免 CORS 拦截
        let fetchUrl = src;
        if (/^https?:\/\//i.test(src) && !src.startsWith(location.origin)) {
            fetchUrl = `/api/llm/download-image?url=${encodeURIComponent(src)}`;
        }

        fetch(fetchUrl)
            .then((res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.blob();
            })
            .then((blob) => {
                const reader = new FileReader();
                reader.onload = (e) => this.addImageUrl(e.target.result);
                reader.readAsDataURL(blob);
            })
            .catch((err) => {
                console.error('❌ 图片转换失败，无法添加到待发送列表:', err);
                alert(`图片添加失败：${err.message}`);
            });
    }

    /**
     * 移除指定索引的图片
     * @param {number} index - 图片索引
     */
    remove(index) {
        if (index < 0 || index >= this.images.length) return;
        this.images.splice(index, 1);
        this.render();
        this.onChange();
    }

    /**
     * 渲染输入框上方的待发送图片缩略图
     */
    render() {
        if (!this.containerEl) return;

        this.containerEl.innerHTML = this.images.map((src, index) => `
            <div class="llm-attachment">
                <img src="${src}" alt="待发送图片">
                <button class="llm-attachment-remove" data-index="${index}" title="移除">×</button>
            </div>
        `).join('');

        // 绑定移除按钮
        this.containerEl.querySelectorAll('.llm-attachment-remove').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.remove(parseInt(btn.dataset.index, 10));
            });
        });
    }
}

// 将 LlmAttachments 类暴露到全局作用域
window.LlmAttachments = LlmAttachments;
