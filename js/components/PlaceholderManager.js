/**
 * ==========================================================================
 * LumenLight 生成占位图管理器（PlaceholderManager）
 * ==========================================================================
 * 作用：全项目唯一的"生成中占位图"实现，负责占位图的创建、动画切换、
 *       按句柄移除与真实结果落图。三条生图链路——右侧 Comfy 提示词面板
 *       （GenerationFeedback）、LLM 生图节点（ImageGenNode）、Comfy 生图
 *       节点（ComfyGenNode）——全部经由本管理器创建占位图，各自的回传
 *       结果按句柄精确替换，不再各自维护私有副本。
 *
 * 归属（owner）设计：create 时传入 owner（节点实例或 'panel' 字符串），
 * 句柄终生携带。"谁创建、谁消费"，归属决定占位图属于谁：
 *   - LLM 节点：HTTP 响应闭包按句柄替换，N 张并发一一对应
 *   - Comfy 节点：WebSocket 消息带 target 路由到节点，再从该节点
 *     名下的队列（getByOwner）按先进先出弹出
 *   - 面板：匿名 FIFO（GenerationFeedback.show / hide）
 * 并发生成（LLM 节点 + Comfy 节点 + 面板同时出图）互不串图：
 * 全局的只是"存"（动画/清理/过滤），"认领"依赖各回传路径自带的归属信息。
 *
 * 占位图 imageObj 仍标记 source='generation-placeholder'，复用现有全套
 * 规则：不参与连线、不入存档、不参与命中检测与缩放手柄。
 * ==========================================================================
 */

class PlaceholderManager {
    /**
     * 构造函数：绑定画布实例，预加载占位动画帧
     * @param {Canvas} canvas - 画布主类实例
     */
    constructor(canvas) {
        this.canvas = canvas;
        this.handles = [];      // 所有存活的占位图句柄（各 owner 混存，按创建序）
        this.frameIndex = 0;    // 动画起始帧序号（全局交替，多占位图起始帧自然错开）
        this.image1 = null;     // 动画帧 1
        this.image2 = null;     // 动画帧 2
        this.loaded = false;    // 动画帧是否加载完成
        this._loadFrames();
    }

    /**
     * 预加载两张占位动画帧
     * 不等待加载完成——占位图对象立即出现，帧加载完成后重绘画布自动显形
     */
    _loadFrames() {
        this.image1 = new Image();
        this.image2 = new Image();

        let loadedCount = 0;
        const onLoad = () => {
            loadedCount++;
            if (loadedCount === 2) {
                this.loaded = true;
                if (this.canvas) {
                    this.canvas.draw();
                }
            }
        };

        this.image1.onload = onLoad;
        this.image2.onload = onLoad;
        this.image1.src = 'image/1.png';
        this.image2.src = 'image/2.png';
    }

    /**
     * 创建一个占位图
     * @param {Object|string} owner - 归属方（节点实例或 'panel'）
     * @param {Object} [opts] - { x, y, width, height }（画布坐标）
     *   缺省 x/y 时放在当前视口中心；同 owner 已有占位图时向右级联偏移避免重叠
     * @returns {Object} 句柄 { id, owner, imageObj, intervalId }
     */
    create(owner, opts = {}) {
        const width = opts.width || 1024;
        const height = opts.height || 1024;
        const gap = 40;   // 同 owner 多个占位图之间的级联间距

        let x = opts.x;
        let y = opts.y;
        if (x === undefined || y === undefined) {
            // 未指定位置：放当前视口中心（画布坐标）
            const centerCanvas = this.canvas.viewport.screenToCanvas(
                this.canvas.cssWidth / 2,
                this.canvas.cssHeight / 2
            );
            x = centerCanvas.x - width / 2;
            y = centerCanvas.y - height / 2;
        }
        // 同 owner 级联偏移（面板连续 show 的原有行为）
        const cascade = this.handles.filter(h => h.owner === owner).length * (width + gap);
        x += cascade;

        // 初始显示的动画帧（Image 对象立即赋值，未加载完成时 drawImage 自动跳过）
        const initialImg = this.frameIndex % 2 === 0 ? this.image1 : this.image2;
        this.frameIndex++;

        const imageObj = {
            id: LumenLight.generateId(),
            name: 'generation-placeholder',
            img: initialImg,
            x,
            y,
            width,
            height,
            selected: false,
            source: NodeTypes.SOURCE.GENERATION_PLACEHOLDER,
            created: Date.now()
        };

        // 添加到画布图片数组末尾，确保显示在最顶层
        this.canvas.images.images.push(imageObj);

        // 每 0.5 秒切换一次动画帧，形成循环动画
        const intervalId = setInterval(() => {
            imageObj.img = imageObj.img === this.image1 ? this.image2 : this.image1;
            this.canvas.draw();
        }, 500);

        this.canvas.draw();

        const handle = { id: imageObj.id, owner, imageObj, intervalId };
        this.handles.push(handle);
        return handle;
    }

    /**
     * 获取某归属方的全部占位图句柄（按创建序，先进先出）
     * @param {Object|string} owner - 归属方
     * @returns {Object[]} 句柄数组
     */
    getByOwner(owner) {
        return this.handles.filter(h => h.owner === owner);
    }

    /**
     * 移除一个占位图（清理动画计时器并从画布移除）
     * @param {Object} handle - create 返回的句柄
     */
    remove(handle) {
        if (!handle) return;
        const idx = this.handles.indexOf(handle);
        if (idx > -1) this.handles.splice(idx, 1);
        if (handle.intervalId) clearInterval(handle.intervalId);
        const imgIdx = this.canvas.images.images.indexOf(handle.imageObj);
        if (imgIdx > -1) this.canvas.images.images.splice(imgIdx, 1);
        // 清理可能存在的选中状态
        this.canvas.images.selectedIds.delete(handle.imageObj.id);
        this.canvas.draw();
    }

    /**
     * 移除某归属方的全部占位图（节点删除 / 生成失败清理时调用）
     * @param {Object|string} owner - 归属方
     */
    removeAll(owner) {
        // 先复制再遍历：remove 会从 handles 中删元素
        for (const handle of this.handles.filter(h => h.owner === owner)) {
            this.remove(handle);
        }
    }

    /**
     * 用真实生成图片替换占位图：移除占位图，真实图按占位图中心、
     * 原始尺寸落图。加载失败时同样移除占位图并 reject。
     * @param {Object} handle - create 返回的句柄
     * @param {string} imageUrl - 图片地址（远程 URL 或 data URL）
     * @param {Object} [meta] - 落图元数据 { name, source, prompt, negativePrompt }
     * @returns {Promise<Object>} 落图后的真实图片对象
     */
    replace(handle, imageUrl, meta = {}) {
        return new Promise((resolve, reject) => {
            if (!handle || !this.handles.includes(handle)) {
                reject(new Error('占位图不存在或已被移除'));
                return;
            }
            const placeholder = handle.imageObj;
            const img = new Image();

            img.onload = () => {
                // 一次性回调：添加后立即解绑，防止重复添加
                img.onload = null;
                this.remove(handle);

                // 真实图片按占位图中心、自身原始尺寸落图
                const imageObj = {
                    id: LumenLight.generateId(),
                    name: meta.name || `placeholder_result_${Date.now()}.png`,
                    img: img,
                    x: placeholder.x + placeholder.width / 2 - img.width / 2,
                    y: placeholder.y + placeholder.height / 2 - img.height / 2,
                    width: img.width,
                    height: img.height,
                    selected: false,
                    source: meta.source || 'comfy',
                    prompt: meta.prompt || '',
                    negativePrompt: meta.negativePrompt || '',
                    created: Date.now()
                };
                this.canvas.images.images.push(imageObj);
                this.canvas.draw();
                resolve(imageObj);
            };

            img.onerror = () => {
                this.remove(handle);
                reject(new Error('生成图片加载失败'));
            };

            img.src = imageUrl;
        });
    }
}

// 将 PlaceholderManager 类暴露到全局作用域
window.PlaceholderManager = PlaceholderManager;
