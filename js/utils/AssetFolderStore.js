/**
 * ==========================================================================
 * LumenLight 本地资产库标签持久化（AssetFolderStore）
 * ==========================================================================
 * 作用：把"标签 ↔ 本地文件夹句柄"的绑定关系持久化到 IndexedDB。
 *       基于 File System Access API：showDirectoryPicker() 返回的
 *       FileSystemDirectoryHandle 是可结构化克隆的对象，可直接存入
 *       IndexedDB，页面刷新后取出即可重新请求授权访问同一文件夹。
 *
 * 说明：
 *   - 仅 Chrome/Edge 支持（LumenLight 目标运行环境）；
 *   - 句柄的读权限在浏览器刷新后会回落为 'prompt'，恢复访问需要
 *     用户手势下调用 handle.requestPermission()（见 AssetLibrary）；
 *   - 无数据库/无 IDB 环境下全部方法安全降级为空操作。
 * ==========================================================================
 */

class AssetFolderStore {
    constructor() {
        this.dbName = 'lumen-asset-library';
        this.storeName = 'folders';
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
                    // keyPath = 标签名；value = { name, handle, addedAt }
                    db.createObjectStore(this.storeName, { keyPath: 'name' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            // 打开失败（隐私模式等）：降级为无持久化，资产库退化为会话内可用
            request.onerror = () => {
                console.warn('资产库 IndexedDB 打开失败:', request.error);
                resolve(null);
            };
        });
        return this._dbPromise;
    }

    /**
     * 读取全部标签（含文件夹句柄），按添加时间倒序
     * @returns {Promise<Array<{name: string, handle: FileSystemDirectoryHandle}>>}
     */
    async getAllTags() {
        const db = await this._open();
        if (!db) return [];
        return new Promise((resolve) => {
            try {
                const request = db.transaction(this.storeName, 'readonly')
                    .objectStore(this.storeName).getAll();
                request.onsuccess = () => {
                    // handle 为 null 的是降级标签（传统选择框绑定，
                    // 仅会话内有效），同样要返回给调用方
                    const tags = (request.result || [])
                        .filter((t) => t && t.name)
                        .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
                    resolve(tags);
                };
                request.onerror = () => resolve([]);
            } catch {
                resolve([]);
            }
        });
    }

    /**
     * 新建或更新标签的文件夹绑定
     * @param {string} name - 标签名
     * @param {FileSystemDirectoryHandle} handle - 文件夹句柄
     */
    async saveTag(name, handle) {
        const db = await this._open();
        if (!db) return;
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(this.storeName, 'readwrite');
                tx.objectStore(this.storeName).put({ name, handle, addedAt: Date.now() });
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch {
                resolve();
            }
        });
    }

    /**
     * 删除标签（不影响本地文件夹本身）
     * @param {string} name - 标签名
     */
    async deleteTag(name) {
        const db = await this._open();
        if (!db) return;
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(this.storeName, 'readwrite');
                tx.objectStore(this.storeName).delete(name);
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch {
                resolve();
            }
        });
    }
}

// 暴露到全局作用域
window.AssetFolderStore = AssetFolderStore;
