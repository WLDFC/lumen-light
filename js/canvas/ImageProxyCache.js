/**
 * ==========================================================================
 * 图片显示代理缓存（ImageProxyCache）
 * ==========================================================================
 * 作用：为画布渲染提供"低分辨率显示代理"，解决图片很多时每帧全分辨率
 *       绘制导致的持续掉帧。缩小/常规视角下画代理副本，放大接近像素级时
 *       自动切回原图，保证细节查看无损。
 *
 * 铁律：本类只影响 CanvasRenderer 的绘制路径，img.img 原始对象
 *       永不替换、永不降质。灯箱预览、高清放大、抠图、保存存档等
 *       一切消费原始图片数据的功能不受任何影响。
 *
 * 构成：
 *   1. 纯函数决策（static selectQuality）：输入原生长边 / 屏幕显示长边 /
 *      代理长边上限 / 当前是否已用代理，输出 'native' | 'proxy'。
 *      无 DOM 依赖，单元测试覆盖（test/canvas/imageProxyCache.test.js）。
 *      含滞回区间：避免缩放在临界点附近来回抖动时两个绘制源闪烁；
 *   2. 异步代理缓存（实例）：每张图一个固定尺寸降采样副本
 *     （canvas / ImageBitmap），按 imageId 缓存。构建走 FIFO 队列逐张
 *      分片执行（requestIdleCallback），构建完成前回退画原图，
 *      保证任何时刻画面都正确——缓存是渐进增强，不是前置条件。
 *
 * 失效策略：
 *   - 缓存键 = imageId（对象身份）。src 内容被替换时（图像编辑器保存
 *     把涂画烘焙进 img.src）必须调用 invalidate(imageId)，否则画布会
 *     持续绘制烘焙前的旧代理；
 *   - 图片删除时 invalidate(imageId)，切换质量档位时 clear()。
 * ==========================================================================
 */

class ImageProxyCache {
    constructor() {
        // imageId -> 代理条目 { mode, building, bitmap, canvas, longEdge }
        this._entries = new Map();
        // 待构建队列（FIFO，逐张分片构建，避免批量恢复时的瞬时卡顿）
        this._queue = [];
        this._processing = false;
    }

    // ==================== 纯函数决策（可单元测试） ====================

    /**
     * 决策当前应使用原生绘制还是代理绘制
     * 规则：
     *   1. 未启用代理（native 档）→ native；
     *   2. 原图本身不大于代理上限 → native（代理无收益，省内存）；
     *   3. 屏幕显示长边 < 代理长边上限 → proxy（显示分辨率低于代理，
     *      视觉无损且绘制成本大幅下降）；
     *   4. 滞回：已处于 proxy 状态时，显示长边要超过上限的 15% 才退回
     *      native，避免临界缩放附近闪烁。
     * @param {Object} p - 决策参数
     * @param {number} p.nativeLongEdge - 原图长边（像素）
     * @param {number} p.displayLongEdgePx - 屏幕上实际渲染的长边（设备像素）
     * @param {number|null} p.proxyMaxLongEdge - 代理长边上限（null = native 档）
     * @param {boolean} p.usingProxy - 当前是否已处于代理状态（滞回用）
     * @returns {'native'|'proxy'} 绘制源决策
     */
    static selectQuality({ nativeLongEdge, displayLongEdgePx, proxyMaxLongEdge, usingProxy }) {
        if (!proxyMaxLongEdge) return 'native';
        if (!nativeLongEdge || nativeLongEdge <= proxyMaxLongEdge) return 'native';
        const threshold = usingProxy
            ? proxyMaxLongEdge * ImageProxyCache.EXIT_HYSTERESIS_FACTOR
            : proxyMaxLongEdge;
        return displayLongEdgePx < threshold ? 'proxy' : 'native';
    }

    /**
     * 质量档位 → 代理长边上限（像素）。'native' 返回 null 表示禁用代理
     * @param {string} quality - 'native' | 'balanced' | 'performance'
     * @returns {number|null}
     */
    static getProxyMaxLongEdge(quality) {
        return ImageProxyCache.QUALITY_PROXY_MAX[quality] ?? null;
    }

    // ==================== 实例：绘制源获取与异步构建 ====================

    /**
     * 获取图片当前的绘制源。返回代理对象（canvas/ImageBitmap）表示用代理
     * 绘制；返回 null 表示画原图（native 档 / 原图不大 / 代理尚未就绪）。
     * 需要代理但未就绪时会自动排队构建，下次绘制生效。
     * @param {Object} img - 画布图片对象（含 img.img 原始 Image、x/y/width/height）
     * @param {number} scale - 视口缩放比例
     * @param {number} dpr - 设备像素比
     * @returns {CanvasImageSource|null}
     */
    getDrawSource(img, scale, dpr) {
        const proxyMax = ImageProxyCache.getProxyMaxLongEdge(
            (typeof SettingsManager !== 'undefined' && SettingsManager.getImageQuality()) || 'native'
        );
        const entry = this._entry(img.id);

        if (!proxyMax) {
            entry.mode = 'native';
            return null;
        }

        // 原图长边（优先真实像素，未加载完成时退回显示尺寸）
        const native = img.img;
        const nativeLongEdge = (native && native.naturalWidth)
            ? Math.max(native.naturalWidth, native.naturalHeight)
            : Math.max(img.width, img.height);
        // 屏幕上实际渲染的长边（设备像素）
        const displayLongEdgePx = Math.max(img.width, img.height) * scale * dpr;

        const mode = ImageProxyCache.selectQuality({
            nativeLongEdge,
            displayLongEdgePx,
            proxyMaxLongEdge: proxyMax,
            usingProxy: entry.mode === 'proxy'
        });
        entry.mode = mode;

        if (mode === 'native') return null;
        if (entry.bitmap || entry.canvas) return entry.bitmap || entry.canvas;

        // 代理未就绪：排队构建（异步、逐张分片），本轮先画原图兜底
        this._enqueue(img, proxyMax);
        return null;
    }

    /**
     * 图片被删除时释放其代理
     * @param {string} imageId - 图片 id
     */
    invalidate(imageId) {
        this._entries.delete(imageId);
    }

    /**
     * 清空全部代理（切换质量档位时调用）
     */
    clear() {
        this._entries.clear();
        this._queue.length = 0;
    }

    /**
     * 取（或初始化）图片的缓存条目
     * @param {string} imageId - 图片 id
     * @returns {Object} 条目 { mode, building, bitmap, canvas, longEdge }
     */
    _entry(imageId) {
        let entry = this._entries.get(imageId);
        if (!entry) {
            entry = { mode: 'native', building: false, bitmap: null, canvas: null, longEdge: 0 };
            this._entries.set(imageId, entry);
        }
        return entry;
    }

    /**
     * 入队构建请求（去重：同一图片未完成的构建不重复排队）
     * @param {Object} img - 画布图片对象
     * @param {number} proxyMax - 代理长边上限
     */
    _enqueue(img, proxyMax) {
        const entry = this._entry(img.id);
        if (entry.building) return;
        entry.building = true;
        this._queue.push({ img, proxyMax });
        this._pump();
    }

    /**
     * 队列泵：逐张分片构建。空闲时段执行，避免批量恢复画布时
     * 集中构建几十张代理造成新的卡顿
     */
    _pump() {
        if (this._processing) return;
        this._processing = true;

        const step = () => {
            const job = this._queue.shift();
            if (!job) {
                this._processing = false;
                return;
            }
            try {
                this._build(job.img, job.proxyMax);
            } catch (err) {
                console.warn('图片显示代理构建失败:', err);
            }
            // 每张代理构建后让出主线程；下一轮 draw 会按需继续排队
            ImageProxyCache._scheduleIdle(step);
        };
        ImageProxyCache._scheduleIdle(step);
    }

    /**
     * 构建单张图片的降采样代理（同步执行，单张成本仅几毫秒）
     * @param {Object} img - 画布图片对象
     * @param {number} proxyMax - 代理长边上限
     */
    _build(img, proxyMax) {
        const entry = this._entry(img.id);
        entry.building = false;
        // 构建期间图片可能已被删除或档位已切回 native，无需继续
        if (!this._entries.has(img.id) || entry.mode === 'native') return;

        const native = img.img;
        const nw = native.naturalWidth, nh = native.naturalHeight;
        if (!nw || !nh || !native.complete) return;   // 未加载完成，下次绘制会再次排队

        // 代理尺寸：长边封顶为 min(档位上限, 原生长边)，保持宽高比
        const nativeLongEdge = Math.max(nw, nh);
        const targetLongEdge = Math.min(proxyMax, nativeLongEdge);
        const factor = targetLongEdge / nativeLongEdge;
        const w = Math.max(1, Math.round(nw * factor));
        const h = Math.max(1, Math.round(nh * factor));

        // 大幅缩小先分级减半，避免一步到位的大比例缩采样产生摩尔纹/锯齿
        const canvas = ImageProxyCache._downscale(native, nw, nh, w, h);
        entry.canvas = canvas;
        entry.longEdge = targetLongEdge;

        // 有 createImageBitmap 时转成 GPU 友好的位图，绘制更快
        if (typeof createImageBitmap === 'function') {
            createImageBitmap(canvas)
                .then(bitmap => {
                    if (this._entries.get(img.id) === entry) entry.bitmap = bitmap;
                })
                .catch(() => { /* 保留 canvas 兜底 */ });
        }
    }

    // ==================== 静态工具 ====================

    /**
     * 分级减半降采样：先反复减半到接近目标，再一步微调到位。
     * 每一步都是 2:1 缩小，配合高质量平滑几乎不产生混叠伪影
     * @param {CanvasImageSource} source - 原始图像源
     * @param {number} sw - 原始宽
     * @param {number} sh - 原始高
     * @param {number} targetW - 目标宽
     * @param {number} targetH - 目标高
     * @returns {HTMLCanvasElement} 降采样结果
     */
    static _downscale(source, sw, sh, targetW, targetH) {
        let cur = source;
        let cw = sw, ch = sh;
        while (cw / 2 >= targetW && ch / 2 >= targetH) {
            const half = document.createElement('canvas');
            half.width = Math.max(1, Math.floor(cw / 2));
            half.height = Math.max(1, Math.floor(ch / 2));
            const hctx = half.getContext('2d');
            hctx.imageSmoothingEnabled = true;
            hctx.imageSmoothingQuality = 'high';
            hctx.drawImage(cur, 0, 0, half.width, half.height);
            cur = half;
            cw = half.width;
            ch = half.height;
        }

        const out = document.createElement('canvas');
        out.width = targetW;
        out.height = targetH;
        const octx = out.getContext('2d');
        octx.imageSmoothingEnabled = true;
        octx.imageSmoothingQuality = 'high';
        octx.drawImage(cur, 0, 0, targetW, targetH);
        return out;
    }

    /**
     * 空闲时段调度（requestIdleCallback 不可用时退化为 16ms 定时器）
     * @param {Function} fn - 回调
     */
    static _scheduleIdle(fn) {
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(fn, { timeout: 200 });
        } else {
            setTimeout(fn, 16);
        }
    }
}

// ==================== 类常量 ====================
// 质量档位 → 代理长边上限（像素）。'native' 不在此表中 = 禁用代理
ImageProxyCache.QUALITY_PROXY_MAX = {
    balanced: 1024,
    performance: 512
};
// 滞回系数：已用代理时，显示长边超过 上限×1.15 才退回原生，
// 防止缩放在临界点附近来回抖动时两个绘制源闪烁
ImageProxyCache.EXIT_HYSTERESIS_FACTOR = 1.15;

// 将类暴露到全局作用域
window.ImageProxyCache = ImageProxyCache;
