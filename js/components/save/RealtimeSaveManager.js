/**
 * ==========================================================================
 * 实时保存管理器（RealtimeSaveManager）
 * ==========================================================================
 * 作用：把画布变更自动、增量地持久化到本地磁盘（经本机 Node 后端写入
 *       data/autosave/ 目录），页面刷新（F5）后静默恢复画布状态，
 *       是唯一的自动持久层。
 *
 * 数据组织（对应 routes/autosave.js）：
 *   - 图片资产：内容寻址（SHA-256 哈希命名），一张图整个会话只上传一次，
 *     重复图天然去重；已在服务器上的图（save/... 等路径）直接引用不重传；
 *   - 恢复元数据：project.json 结构的轻量 JSON（图片引用/节点/连线/视口/
 *     提示词/当前存档名），每次变更 debounce 2s 后整体覆盖写入，
 *     体积通常只有几 KB，因此高频触发也无压力。
 *
 * 与其他组件的关系：
 *   - 复用 SaveManager.serializer（ProjectSerializer）收集/恢复画布状态，
 *     数据格式与正式存档 project.json 完全一致；
 *   - 变更来源：订阅共享的 CanvasChangeWatcher；
 *   - 恢复时机：启动时读取磁盘恢复槽位，有数据则静默恢复（不弹窗）；
 *   - 正式保存成功后 SaveManager 会调用本类 flush()，把回写后的
 *     服务器图片路径与 currentSave 关联同步进恢复元数据。
 *
 * 写入策略（三层）：
 *   1. 内容比对：写入前与上一份已写入内容做 JSON 比对，完全一致则跳过——
 *      点击空白处（取消选中）等不改变保存数据的操作零写盘；
 *   2. 防抖 2s + 强制落盘：变更停止 2s 后写入；连续操作导致防抖不断顺延时，
 *      距上次写入超过 5s 强制写一次，防止长时间拖动期间数据只在内存里；
 *   3. 失败重试：写入失败每 30s 重试，直到成功。
 *
 * 状态显示（失败才告警）：顶栏画布名旁的圆点平时是灰色的
 *   「✓ 已自动保存 HH:MM:SS」，仅同步失败进入重试时变为红色
 *   「⚠ 保存失败，正在重试」，恢复后自动回到灰色——不播报正常路径，
 *   只在用户需要行动时出现。
 * ==========================================================================
 */

class RealtimeSaveManager {
    /**
     * 构造函数：绑定依赖、初始化状态、订阅变更通知。
     * 注意：构造后处于"未启动"状态，需调用 start() 后才开始同步——
     * 这样启动恢复（restoreProject 触发的大量 draw）不会被当成变更。
     * @param {Canvas} canvas - 画布主类实例
     * @param {SaveManager} saveManager - 存档管理器（复用其 serializer 与 currentSave）
     * @param {CanvasChangeWatcher} changeWatcher - 共享变更捕获器
     */
    constructor(canvas, saveManager, changeWatcher) {
        this.canvas = canvas;
        this.saveManager = saveManager;
        this.serializer = saveManager.serializer;

        this._started = false;          // start() 后才开始响应变更
        this._isRestoring = false;      // 恢复期间抑制变更触发的同步
        this._isSyncing = false;        // 一次同步流程进行中（串行化）
        this._pendingSync = false;      // 同步期间又收到新变更，完成后补一次
        this._timer = null;             // debounce 定时器
        this._retryTimer = null;        // 失败后的周期重试定时器
        this._dirty = false;            // 是否有未同步到磁盘的变更
        this._lastWrittenJson = null;   // 上一份已成功写入的完整负载（内容比对用）
        this._lastSyncStart = 0;        // 最近一次同步开始时间（强制落盘判定用）

        // 图片内容哈希缓存：imageId -> Promise<hex|null>（null = 计算失败）
        // 同一张图会话内只取一次字节与算一次哈希
        this._hashCache = new Map();
        // 本会话已成功上传的资产哈希（含后端已存在的），避免重复请求
        this._uploadedHashes = new Set();

        // 顶栏状态元素（index.html 中画布名旁，缺失时降级为无 UI）
        this._statusEl = document.getElementById('autosaveStatus');

        // 订阅共享变更捕获器
        changeWatcher.subscribe({
            onChange: () => {
                if (!this._started || this._isRestoring) return;
                this.scheduleSync();
            },
            onFlush: () => this.flush()
        });
    }

    /**
     * 启动同步：先主动同步一次（把当前画布状态写入恢复槽位，
     * 空画布也会写入，即覆盖掉上一会话的残留数据），之后响应变更
     */
    start() {
        if (this._started) return;
        this._started = true;
        this.scheduleSync();
    }

    // ==================== 启动恢复 ====================
    
    /**
     * 启动时静默恢复画布。读取磁盘恢复槽位（data/autosave/project.json），
     * 有内容则直接恢复，无弹窗询问——作为唯一的自动持久层，
     * F5 后无感恢复是其核心职责。
     * 无数据 / 后端未启动 / 空画布快照时静默跳过，不影响主流程。
     * @returns {Promise<boolean>} 是否成功恢复
     */
    async restore() {
        let remote;
        try {
            const response = await fetch('/api/autosave');
            remote = await response.json();
        } catch (err) {
            console.warn('读取本地磁盘恢复数据失败（后端未运行？）:', err);
            return false;
        }
        if (!remote || remote.status !== 'ok' || !remote.exists || !remote.data) return false;
    
        // 空画布快照（上一会话结束时画布就是空的）不值得恢复
        const data = remote.data;
        const hasContent = (data.images && data.images.length > 0) ||
                           (data.nodes && data.nodes.length > 0) ||
                           (data.prompt && data.prompt.trim()) ||
                           (data.prompt2 && data.prompt2.trim()) ||
                           (data.negativePrompt && data.negativePrompt.trim());
        if (!hasContent) return false;
    
        // 静默恢复画布并还原 currentSave 关联
        this._isRestoring = true;
        try {
            await this.serializer.restoreProject(data);
            if (remote.currentSave) {
                this.saveManager.currentSave = remote.currentSave;
                this.saveManager.updateCanvasName(remote.currentSave);
            } else {
                this.saveManager.currentSave = null;
                this.saveManager.updateCanvasName('未命名');
            }
            return true;
        } catch (err) {
            console.error('本地磁盘恢复数据还原画布失败:', err);
            return false;
        } finally {
            this._isRestoring = false;
        }
    }

    // ==================== 同步调度 ====================

    /**
     * 计划一次同步：debounce 2s 合并高频变更（拖动/缩放每帧都会触发）。
     * 注意：此处只记脏标记、不做任何状态播报——是否真的有内容变化
     * 由 _sync 的内容比对判定，避免无意义操作闪烁「未同步」。
     * 连续操作会让防抖不断顺延，距上次写入超过 MAX_PENDING_MS 时
     * 强制立即落盘，防止长时间拖动期间数据只存在于内存。
     */
    scheduleSync() {
        if (!this._started) return;
        this._dirty = true;
        if (this._timer && Date.now() - this._lastSyncStart >= RealtimeSaveManager.MAX_PENDING_MS) {
            this.flush();
            return;
        }
        if (this._timer) clearTimeout(this._timer);
        this._timer = setTimeout(() => {
            this._timer = null;
            this._sync();
        }, RealtimeSaveManager.DEBOUNCE_MS);
    }

    /**
     * 立即同步（跳过 debounce）。供页面隐藏/卸载兜底与正式保存后调用。
     * 恢复期间直接返回：画布可能仅部分重建，写入会覆盖完整数据。
     */
    flush() {
        if (!this._started || this._isRestoring) return;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this._sync();
    }

    // ==================== 同步执行 ====================

    /**
     * 执行同步：上传新图片资产 → 收集元数据 → 内容比对 → 写入恢复槽位。
     * 串行化保证：同步进行中收到的新变更标记为 pending，完成后自动补一次。
     * 内容与上一份已写入的完全一致时（如取消选中触发的一次绘制）跳过写盘，
     * 状态维持原样——磁盘只接收真实变化。
     */
    async _sync() {
        if (this._isSyncing) {
            this._pendingSync = true;
            return;
        }
        this._isSyncing = true;
        this._lastSyncStart = Date.now();
        try {
            const data = await this._collectMeta();
            const payload = JSON.stringify({ data, currentSave: this.saveManager.currentSave });

            if (payload === this._lastWrittenJson) {
                // 内容零变化：跳过写盘，不打扰用户
                this._dirty = false;
                this._stopRetry();
                return;
            }

            const response = await fetch('/api/autosave/meta', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload
            });
            const result = await response.json().catch(() => ({}));
            if (result.status !== 'ok') {
                throw new Error(result.message || '元数据写入失败');
            }

            // 同步成功：记录已写入内容，清除脏标记与重试定时器，刷新时间戳
            this._lastWrittenJson = payload;
            this._dirty = false;
            this._stopRetry();
            this.markSynced();
        } catch (err) {
            // 常见原因：后端未启动、请求体超限、磁盘故障。显示失败告警，
            // 每 30s 自动重试，直到下一次同步成功
            console.warn('实时保存同步失败:', err);
            this._renderStatus('failed');
            this._startRetry();
        } finally {
            this._isSyncing = false;
            if (this._pendingSync) {
                this._pendingSync = false;
                this.scheduleSync();
            }
        }
    }

    /**
     * 收集当前画布状态为恢复元数据（结构与存档 project.json 的 data 一致），
     * 并把尚未持久化的图片（data:/blob: src）增量上传为内容寻址资产，
     * 元数据中统一引用服务器 URL
     * @returns {Promise<Object>} 元数据 data 字段
     */
    async _collectMeta() {
        const prompts = this.serializer.getPrompts();
        const images = this.serializer.collectImages();

        // 逐张处理图片：data:/blob: 的需要上传，其余（save/... 等服务器路径）直接引用
        for (const entry of images) {
            const src = entry.src || '';
            if (!src.startsWith('data:') && !src.startsWith('blob:')) continue;

            const url = await this._ensureAssetUploaded(entry.id, src);
            if (url) entry.src = url;
            // 上传失败时保留原 data: src（下一轮同步会再次尝试上传）
        }

        return {
            prompt: prompts.positive,
            prompt2: prompts.positive2,
            negativePrompt: prompts.negative,
            viewport: this.serializer.getViewport(),
            images,
            nodes: this.serializer.collectNodes(),
            connections: this.serializer.getConnectionsData()
        };
    }

    /**
     * 确保一张图片已上传为内容寻址资产，返回可引用的服务器 URL
     * 失败返回 null（调用方保留原 src 兜底）
     * @param {string} imageId - 图片对象 id（哈希缓存键）
     * @param {string} src - 图片源（data: / blob: URL）
     * @returns {Promise<string|null>}
     */
    async _ensureAssetUploaded(imageId, src) {
        if (typeof crypto === 'undefined' || !crypto.subtle) {
            console.warn('crypto.subtle 不可用，无法计算图片内容哈希，跳过资产上传');
            return null;
        }

        // 1. 计算内容哈希（会话内按图片 id 缓存）
        if (!this._hashCache.has(imageId)) {
            this._hashCache.set(imageId, this._computeHash(src).catch(() => null));
        }
        const hash = await this._hashCache.get(imageId);
        if (!hash) return null;

        // 2. 本会话已上传过（或确认后端已存在）直接复用
        if (this._uploadedHashes.has(hash)) {
            return `/data/autosave/assets/${hash}${this._extOf(src)}`;
        }

        // 3. 上传资产（后端按哈希幂等：文件已存在则跳过写入）
        const response = await fetch('/api/autosave/asset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hash, src })
        });
        const result = await response.json().catch(() => ({}));
        if (result.status !== 'ok' || !result.url) {
            throw new Error(result.message || '资产上传失败');
        }
        this._uploadedHashes.add(hash);
        return result.url;
    }

    /**
     * 读取图片字节并计算 SHA-256 内容哈希（十六进制小写）
     * @param {string} src - 图片源（data: / blob: URL 均可 fetch）
     * @returns {Promise<string>} 64 位十六进制哈希
     */
    async _computeHash(src) {
        const response = await fetch(src);
        const buffer = await response.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        return Array.from(new Uint8Array(digest))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    /**
     * 从图片 src 猜测扩展名（仅用于"哈希已上传但内存记录丢失"时拼 URL，
     * 正常上传路径的扩展名以后端返回为准）
     * @param {string} src - data: URL 或其他 src
     * @returns {string} 扩展名（含点）
     */
    _extOf(src) {
        const match = /^data:image\/(\w+);/i.exec(src || '');
        const kind = (match && match[1].toLowerCase()) || 'png';
        return kind === 'jpeg' ? '.jpg' : `.${kind}`;
    }

    // ==================== 失败重试 ====================

    /**
     * 启动 30s 周期重试（已有定时器时不重复启动）
     */
    _startRetry() {
        if (this._retryTimer) return;
        this._retryTimer = setInterval(() => {
            if (!this._dirty || this._isSyncing) return;
            this._sync();
        }, RealtimeSaveManager.RETRY_MS);
    }

    /** 停止重试定时器（同步成功后调用） */
    _stopRetry() {
        if (this._retryTimer) {
            clearInterval(this._retryTimer);
            this._retryTimer = null;
        }
    }

    // ==================== 顶栏状态显示 ====================
    // 失败才告警：正常路径静默（成功只刷新灰色时间戳），
    // 仅同步失败进入重试时显示红色告警，避免无意义变更播报打扰用户

    /** 标记为"已自动保存"并记录时间（同步成功后调用） */
    markSynced() {
        this._renderStatus('synced', new Date());
    }

    /**
     * 渲染顶栏状态小圆点
     * @param {string} state - 'synced' | 'failed'
     * @param {Date} [date] - 同步时间（synced 时使用）
     */
    _renderStatus(state, date) {
        if (!this._statusEl) return;
        if (state === 'failed') {
            this._statusEl.textContent = '⚠ 保存失败，正在重试';
            this._statusEl.className = 'autosave-status failed';
            this._statusEl.title = '画布变更暂时无法写入本地磁盘恢复数据（后端是否在运行？），将每 30 秒自动重试';
        } else {
            this._statusEl.textContent = `✓ 已自动保存 ${RealtimeSaveManager.formatTime(date.getTime())}`;
            this._statusEl.className = 'autosave-status synced';
            this._statusEl.title = '画布变更已自动保存到本地磁盘（data/autosave/）';
        }
    }

    /**
     * 时间戳 → HH:MM:SS（用于状态显示与恢复弹窗；精确到秒便于分辨
     * 一分钟内的连续保存）
     * @param {number} ts - 毫秒时间戳
     * @returns {string}
     */
    static formatTime(ts) {
        const d = ts ? new Date(ts) : new Date();
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    }
}

// ==================== 类常量 ====================
RealtimeSaveManager.DEBOUNCE_MS = 2000;      // 变更合并窗口
RealtimeSaveManager.MAX_PENDING_MS = 5000;   // 连续操作期间防抖顺延的最大等待，超过即强制落盘
RealtimeSaveManager.RETRY_MS = 30000;        // 同步失败后的周期重试间隔

// 将类暴露到全局作用域
window.RealtimeSaveManager = RealtimeSaveManager;
