/**
 * ==========================================================================
 * LumenLight LLM 附件管理组件（图片 + 文档）
 * 作用：管理 LLM 聊天窗口中待发送的附件，支持两类：
 *       1) 图片：本地上传 / 远程 / 画布图片 URL，转 base64 缩略图，随消息多模态发送；
 *       2) 文档：txt/md/csv/json/pdf/docx/xls/xlsx 等，添加时即调后端
 *          /api/llm/extract-file 解析成纯文本并缓存，发送时以文本形式拼进消息。
 *       本组件从 LlmChat 中拆分出来，避免聊天主类继续膨胀。
 * ==========================================================================
 */

// 受支持的文档扩展名（与后端 utils/fileTextExtractor.js 保持一致）
const DOC_EXT_RE = /\.(txt|md|markdown|csv|tsv|log|json|xml|yaml|yml|ini|conf|srt|vtt|pdf|docx|xls|xlsx|xlsm)$/i;
// 单文件大小上限（与后端一致）：10MB
const DOC_MAX_BYTES = 10 * 1024 * 1024;

/**
 * HTML 文本转义（防止文件名里的 < > & 破坏结构）
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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
        // 待发送的文档（{name, ext, status, text, truncated, charCount, empty, error}）
        this.files = [];
    }

    // ==================== 读取接口 ====================

    /**
     * 获取当前所有待发送图片
     * @returns {string[]} base64 data URL 数组
     */
    getAll() {
        return [...this.images];
    }

    /**
     * 获取已成功解析的文档（供发送时拼进消息）
     * @returns {{name: string, text: string, truncated: boolean}[]}
     */
    getFiles() {
        return this.files
            .filter((f) => f.status === 'ready' && f.text)
            .map((f) => ({ name: f.name, text: f.text, truncated: !!f.truncated }));
    }

    /**
     * 是否有图片附件
     * @returns {boolean}
     */
    hasImages() {
        return this.images.length > 0;
    }

    /**
     * 是否有文档附件
     * @returns {boolean}
     */
    hasFiles() {
        return this.files.length > 0;
    }

    /**
     * 是否有任何附件（图片或文档）
     * @returns {boolean}
     */
    hasAttachments() {
        return this.images.length > 0 || this.files.length > 0;
    }

    /**
     * 是否有文档仍在解析中（发送前用于拦截，避免漏发未解析完的附件）
     * @returns {boolean}
     */
    isParsing() {
        return this.files.some((f) => f.status === 'parsing');
    }

    /**
     * 清空所有附件（图片 + 文档）
     */
    clear() {
        this.images = [];
        this.files = [];
        this.render();
        this.onChange();
    }

    // ==================== 添加图片 ====================

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

    // ==================== 添加文档 ====================

    /**
     * 从本地文件对象添加文档：先占位「解析中」，调后端提取文本后回填。
     * 解析失败会保留为错误态（缩略块标红），发送时自动跳过。
     * @param {File} file - 文档文件
     */
    addDocFromFile(file) {
        if (!file) return;
        const name = file.name || '未命名文件';
        if (!DOC_EXT_RE.test(name)) {
            alert(`暂不支持该文件格式：${name}\n（支持 txt/md/csv/json/pdf/docx/xls/xlsx 等）`);
            return;
        }
        if (file.size > DOC_MAX_BYTES) {
            alert(`文件超过 10MB 上限：${name}`);
            return;
        }

        const entry = {
            name,
            ext: (name.split('.').pop() || 'file').toLowerCase(),
            status: 'parsing',
            text: '',
            truncated: false,
            charCount: 0,
            empty: false,
            error: ''
        };
        this.files.push(entry);
        this.render();
        this.onChange();

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const resp = await fetch('/api/llm/extract-file', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: name, dataUrl: e.target.result })
                });
                const data = await resp.json();
                if (!resp.ok || data.status !== 'ok') {
                    throw new Error(data.message || `HTTP ${resp.status}`);
                }
                entry.status = 'ready';
                entry.text = data.text || '';
                entry.truncated = !!data.truncated;
                entry.charCount = data.charCount || 0;
                entry.empty = !!data.empty;
            } catch (err) {
                entry.status = 'error';
                entry.error = err.message || '解析失败';
                console.error('❌ 文档解析失败:', err);
            }
            this.render();
            this.onChange();
        };
        reader.onerror = () => {
            entry.status = 'error';
            entry.error = '读取文件失败';
            this.render();
            this.onChange();
        };
        reader.readAsDataURL(file);
    }

    // ==================== 移除 ====================

    /**
     * 移除指定索引的图片（保留旧名以兼容既有调用）
     * @param {number} index - 图片索引
     */
    remove(index) {
        this.removeImage(index);
    }

    /**
     * 移除指定索引的图片
     * @param {number} index
     */
    removeImage(index) {
        if (index < 0 || index >= this.images.length) return;
        this.images.splice(index, 1);
        this.render();
        this.onChange();
    }

    /**
     * 移除指定索引的文档
     * @param {number} index
     */
    removeFile(index) {
        if (index < 0 || index >= this.files.length) return;
        this.files.splice(index, 1);
        this.render();
        this.onChange();
    }

    // ==================== 渲染 ====================

    /**
     * 渲染单个文档缩略块
     * @param {Object} f - 文档条目
     * @param {number} index - 文档索引
     * @returns {string} HTML 片段
     */
    renderFileChip(f, index) {
        const extLabel = (f.ext || 'file').toUpperCase().slice(0, 5);
        let stateClass = 'is-ready';
        if (f.status === 'parsing') stateClass = 'is-parsing';
        else if (f.status === 'error') stateClass = 'is-error';

        let tip;
        if (f.status === 'parsing') tip = '正在解析…';
        else if (f.status === 'error') tip = `解析失败：${f.error || ''}`;
        else tip = `${f.name}${f.truncated ? '（内容过长已截断）' : ''}${f.empty ? '（空文件）' : ''}`;

        const stateLine = f.status === 'parsing' ? '<div class="llm-file-state">解析中…</div>'
            : f.status === 'error' ? '<div class="llm-file-state">解析失败</div>'
                : f.empty ? '<div class="llm-file-state">空文件</div>'
                    : f.truncated ? '<div class="llm-file-state">已截断</div>' : '';

        return `
            <div class="llm-attachment llm-attachment-file ${stateClass}" data-type="file" data-index="${index}" title="${escapeHtml(tip)}">
                <div class="llm-file-ext">${escapeHtml(extLabel)}</div>
                <div class="llm-file-name">${escapeHtml(f.name)}</div>
                ${stateLine}
                <button class="llm-attachment-remove" data-type="file" data-index="${index}" title="移除">×</button>
            </div>`;
    }

    /**
     * 渲染输入框上方的待发送附件（图片缩略图 + 文档缩略块）
     */
    render() {
        if (!this.containerEl) return;

        const parts = [];
        this.images.forEach((src, index) => {
            parts.push(`
            <div class="llm-attachment" data-type="image" data-index="${index}">
                <img src="${src}" alt="待发送图片">
                <button class="llm-attachment-remove" data-type="image" data-index="${index}" title="移除">×</button>
            </div>`);
        });
        this.files.forEach((f, index) => parts.push(this.renderFileChip(f, index)));

        this.containerEl.innerHTML = parts.join('');

        // 绑定移除按钮（按 data-type 分派到图片/文档）
        this.containerEl.querySelectorAll('.llm-attachment-remove').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.index, 10);
                if (btn.dataset.type === 'file') this.removeFile(idx);
                else this.removeImage(idx);
            });
        });
    }
}

// 将 LlmAttachments 类暴露到全局作用域
window.LlmAttachments = LlmAttachments;
