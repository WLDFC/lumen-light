/**
 * ==========================================================================
 * LumenLight 提示词词典共享单例（PromptDictStore）
 * ==========================================================================
 * 作用：词典数据层的唯一持有者，从 PromptAutocomplete 拆出。所有补全
 *       组件实例（面板正负向输入框、画布提示词节点……）共享同一份数据：
 *       词典 21.8 万条（约 14MB JSON），按实例各持一份会在多节点场景下
 *       内存翻倍，故数据与 UI 分离。
 *
 * 职责：
 *   1. 加载：首次使用时 fetch tools/prompt-dict.json，并发调用合并为
 *      一次加载（ensureLoaded 返回同一个 Promise）。
 *   2. 缓存：IndexedDB 持久缓存，缓存键 = 词典文件的 ETag/Last-Modified
 *      （HEAD 请求获取，静态服务自动携带）。词典文件更新后键值变化，
 *      下次加载自动重新下载——避免写死版本号导致缓存永不失效。
 *   3. 索引：加载后预构建小写搜索索引（每条词条的 cn/en 小写副本只算
 *      一次），搜索时免去每次按键 4 次字符串分配。
 *   4. 搜索：四级优先匹配（cn 前缀 > cn 包含 > en 前缀 > en 包含），
 *      同级按词典原序；调用方自行截断显示条数。
 *
 * UI 层（PromptAutocomplete）通过 subscribe 订阅状态变化：词典在用户
 * 已输入后才就绪时，打开中的下拉会自动刷新结果。
 * ==========================================================================
 */

const PromptDictStore = {
    /** 词典地址（express.static 直接服务 tools/ 目录） */
    DICT_URL: 'tools/prompt-dict.json',

    // IndexedDB 配置（沿用 PromptAutocomplete 原库名，旧缓存因键值格式
    // 变化（数字版本号 → 文件指纹）自然失效，一次性重新下载后按新键缓存）
    DB_NAME: 'LumenLightPromptDB',
    DB_VERSION: 1,
    STORE_NAME: 'dictionary',
    CACHE_KEY: 'prompt-dict-cache',

    dict: [],            // 完整词典数组（原始条目 { cn, en }）
    _index: [],          // 小写搜索索引 [{ cn, en, item }]
    status: 'loading',   // loading | ready | error
    _promise: null,      // 进行中的加载 Promise（并发调用合并）
    _listeners: [],      // 状态变更回调（UI 层订阅）

    /**
     * 确保词典已（在）加载。可安全并发/重复调用：只触发一次实际加载
     * @returns {Promise<void>} 就绪或失败均 resolve（看 status 区分）
     */
    ensureLoaded() {
        if (!this._promise) {
            this._promise = this._load();
        }
        return this._promise;
    },

    /**
     * 订阅词典状态变化（loading → ready/error 时回调）
     * @param {(status: string) => void} cb
     * @returns {() => void} 取消订阅函数
     */
    subscribe(cb) {
        this._listeners.push(cb);
        return () => {
            const i = this._listeners.indexOf(cb);
            if (i >= 0) this._listeners.splice(i, 1);
        };
    },

    /**
     * 在索引中搜索匹配词条（四级优先，同级保持词典原序）
     * @param {string} query - 查询词（大小写不敏感）
     * @returns {Object[]} 匹配的原始词典条目数组
     */
    search(query) {
        if (!query) return [];
        const q = query.toLowerCase();
        const startsCN = [];
        const includesCN = [];
        const startsEN = [];
        const includesEN = [];

        for (const e of this._index) {
            if (e.cn.startsWith(q)) {
                startsCN.push(e.item);
            } else if (e.cn.includes(q)) {
                includesCN.push(e.item);
            } else if (e.en.startsWith(q)) {
                startsEN.push(e.item);
            } else if (e.en.includes(q)) {
                includesEN.push(e.item);
            }
        }

        return [...startsCN, ...includesCN, ...startsEN, ...includesEN];
    },

    // ==================== 内部实现 ====================

    /**
     * 实际加载流程：解析文件指纹 → 查缓存 → 未命中则下载并回写
     */
    async _load() {
        const version = await this._resolveVersion();

        try {
            const cached = await this._getCache();
            if (cached && cached.version === version &&
                Array.isArray(cached.data) && cached.data.length > 0) {
                this._apply(cached.data);
                return;
            }
        } catch (err) {
            console.warn('[PromptDictStore] IndexedDB 读取失败，将重新加载', err);
        }

        try {
            const res = await fetch(this.DICT_URL);
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const data = await res.json();
            this._apply(data);
            // 缓存写入失败不影响本次使用（下次会重新下载）
            this._setCache({ version, data }).catch((err) =>
                console.warn('[PromptDictStore] 词典缓存写入失败', err));
        } catch (err) {
            console.error('[PromptDictStore] 加载词典失败', err);
            this.status = 'error';
            this._notify();
        }
    },

    /**
     * 解析词典文件的版本指纹：优先 ETag，退回 Last-Modified，均无则
     * 用固定占位（此时退化为"永缓存"行为，与旧版一致）
     * @returns {Promise<string>}
     */
    async _resolveVersion() {
        try {
            const res = await fetch(this.DICT_URL, { method: 'HEAD' });
            if (res.ok) {
                return res.headers.get('etag') ||
                       res.headers.get('last-modified') || 'default';
            }
        } catch (err) {
            // HEAD 失败不阻塞加载（离线/代理环境），继续走缓存或 GET
        }
        return 'default';
    },

    /**
     * 应用词典数据：记录原数组 + 预构建小写索引 + 通知订阅者
     * @param {Object[]} data
     */
    _apply(data) {
        this.dict = data;
        this._index = [];
        for (const item of data) {
            // 脏数据行（cn/en 非字符串）直接跳过，与旧版搜索时过滤等价
            if (!item || typeof item.cn !== 'string' || typeof item.en !== 'string') {
                continue;
            }
            this._index.push({
                cn: item.cn.toLowerCase(),
                en: item.en.toLowerCase(),
                item
            });
        }
        this.status = 'ready';
        this._notify();
    },

    _notify() {
        for (const cb of this._listeners.slice()) {
            try {
                cb(this.status);
            } catch (err) {
                console.error('[PromptDictStore] 订阅回调异常', err);
            }
        }
    },

    /**
     * 从 IndexedDB 读取缓存
     * @returns {Promise<Object|null>} 缓存数据或 null
     */
    _getCache() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME);
                }
            };

            request.onsuccess = (event) => {
                const db = event.target.result;
                try {
                    const tx = db.transaction(this.STORE_NAME, 'readonly');
                    const store = tx.objectStore(this.STORE_NAME);
                    const getReq = store.get(this.CACHE_KEY);
                    getReq.onsuccess = () => resolve(getReq.result || null);
                    getReq.onerror = () => reject(getReq.error);
                } catch (err) {
                    reject(err);
                }
            };

            request.onerror = () => reject(request.error);
        });
    },

    /**
     * 将数据写入 IndexedDB 缓存
     * @param {Object} data - 要缓存的数据
     */
    _setCache(data) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME);
                }
            };

            request.onsuccess = (event) => {
                const db = event.target.result;
                try {
                    const tx = db.transaction(this.STORE_NAME, 'readwrite');
                    const store = tx.objectStore(this.STORE_NAME);
                    const putReq = store.put(data, this.CACHE_KEY);
                    putReq.onsuccess = () => resolve();
                    putReq.onerror = () => reject(putReq.error);
                } catch (err) {
                    reject(err);
                }
            };

            request.onerror = () => reject(request.error);
        });
    }
};

// 将 PromptDictStore 暴露到全局作用域
window.PromptDictStore = PromptDictStore;
