/**
 * ==========================================================================
 * LumenLight LLM 聊天记录持久化（ChatHistoryStore）
 * ==========================================================================
 * 作用：把 LLM 窗口的消息区 DOM 快照（含图片 data URL 与生成参数映射）
 *       按持久化键存入 IndexedDB，F5 刷新后由 LlmChat 恢复。
 *       键由 LlmHistoryController 决定：跨存档统一键（'_global'），
 *       网页桥接模式按站点分键。
 *       选 IndexedDB 而非 localStorage：消息里的图片多为 data URL，
 *       体积轻松超过 localStorage 的 ~5MB 配额。
 *
 * 说明：
 *   - 无 IndexedDB（隐私模式等）时全部方法安全降级为空操作，
 *     聊天记录退化为会话内可见（与无持久化时行为一致）；
 *   - 写入失败静默跳过，不阻塞聊天主流程。
 * ==========================================================================
 */

class ChatHistoryStore {
    constructor() {
        this.dbName = 'lumen-chat-history';
        this.storeName = 'messages';
        this._dbPromise = null;
    }

    /**
     * 打开（或创建）IndexedDB 数据库
     * @returns {Promise<IDBDatabase|null>} 打开失败时返回 null
     */
    _open() {
        if (this._dbPromise) return this._dbPromise;
        if (!window.indexedDB) return Promise.resolve(null);

        this._dbPromise = new Promise((resolve) => {
            const request = indexedDB.open(this.dbName, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    // keyPath = 持久化键；value = { key, html, gen, savedAt }
                    db.createObjectStore(this.storeName, { keyPath: 'key' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            // 打开失败（隐私模式等）：降级为无持久化
            request.onerror = () => {
                console.warn('聊天记录 IndexedDB 打开失败:', request.error);
                resolve(null);
            };
        });
        return this._dbPromise;
    }

    /**
     * 读取一份聊天快照
     * @param {string} key - 持久化键（统一键 '_global' 或 web-站点）
     * @returns {Promise<{html: string, gen: Object}|null>} 无记录时返回 null
     */
    async get(key) {
        const db = await this._open();
        if (!db) return null;
        return new Promise((resolve) => {
            try {
                const request = db.transaction(this.storeName, 'readonly')
                    .objectStore(this.storeName).get(key);
                request.onsuccess = () => resolve(request.result || null);
                request.onerror = () => resolve(null);
            } catch {
                resolve(null);
            }
        });
    }

    /**
     * 写入一份聊天快照（覆盖同键旧值）
     * @param {string} key - 持久化键
     * @param {string} html - 消息区序列化 HTML
     * @param {Object} gen - 生成图片块参数映射 { [genId]: requestParams }
     * @param {Object|null} [usage] - 面板头部 pi 调用统计 {usage, modelId}（随快照恢复）
     */
    async put(key, html, gen = {}, usage = null) {
        const db = await this._open();
        if (!db) return;
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(this.storeName, 'readwrite');
                tx.objectStore(this.storeName).put({ key, html, gen, usage, savedAt: Date.now() });
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch {
                resolve();
            }
        });
    }

    /**
     * 删除一份快照（清空对话时调用）
     * @param {string} key - 持久化键
     */
    async delete(key) {
        const db = await this._open();
        if (!db) return;
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(this.storeName, 'readwrite');
                tx.objectStore(this.storeName).delete(key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch {
                resolve();
            }
        });
    }
}

// 暴露到全局作用域
window.ChatHistoryStore = ChatHistoryStore;
