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
 *
 * 聚集路由：画布存在聚集编组（GroupManager collect 字段，全局至多
 * 一个）时，create 的落点统一交 CollectZone 决定——区内槽位排布 /
 * 放不下按原始尺寸落编组位置级联（不缩放不裁切），「全部聚集」语义
 * 优先于调用方传入的 x/y；replace 真实图按占位图中心原尺寸落图，
 * 落定后回调 CollectZone.notifyLanded 做视口外轻提示。
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
        // promptId → 句柄注册表（2026-11-08）：Comfy 中继的进度/预览/失败
        // 事件按 promptId 定向，提交方（ComfyGenNode/面板）在拿到 promptId
        // 后 bindPromptId 建立映射
        this.byPromptId = new Map();
        // 看门狗（2026-11-08）：15 分钟无任何进度/预览活动 → 「疑似卡住」
        // 态（只上报不取消，与 pi 卡死「只上报不自动杀」同口径——长任务
        // 不误伤，出图后正常替换）。活动 = comfy-progress / comfy-preview
        this.STUCK_MS = 15 * 60 * 1000;
        this._watchdog = setInterval(() => this._scanStuck(), 15000);
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
     * @param {Object} [opts] - { x, y, width, height, genInfo }（画布坐标）
     *   缺省 x/y 时放在当前视口中心；同 owner 已有占位图时向右级联偏移避免重叠；
     *   genInfo 为生成参数记录（溯源/生成同款，GenRecord）——随句柄绑定，
     *   面板链路经此携带（每张占位图独立持有，取消/失败清理天然对齐）
     * @returns {Object} 句柄 { id, owner, imageObj, intervalId, genInfo }
     */
    create(owner, opts = {}) {
        const width = opts.width || 1024;
        const height = opts.height || 1024;
        const gap = 40;   // 同 owner 多个占位图之间的级联间距

        // 聚集区接管：聚集编组启用时占位图统一落入区内槽位（CollectZone
        // 路由、CollectSlotLayout 纯函数计算），放不下回落编组位置级联；
        // 槽位本身已排好，跳过同 owner 级联
        let x;
        let y;
        let zoneRouted = false;
        const zone = this.canvas.collectZone;
        if (zone) {
            const pos = zone.resolveSpawnPosition(width, height);
            if (pos) {
                x = pos.x;
                y = pos.y;
                zoneRouted = true;
            }
        }
        if (!zoneRouted) {
            x = opts.x;
            y = opts.y;
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
        }

        // 落点防遮挡（仅非聚集区路径——区内槽位由 CollectSlotLayout 自排）：
        // 落点矩形与既有不透明对象（图片/视频/音频/占位图/面板节点，统一在
        // images 清单里）任一方向覆盖率 ≥90%（新图盖住别人或被盖）即视为
        // 冲突，自动让位到就近空位——防新生成图压住已有内容（用户实测
        // 高频事故）。找不到空位保持原落点（宁重叠不丢图）。
        if (!zoneRouted) {
            const spawnRect = { x, y, width, height };
            const occupied = this.canvas.images.images.filter(
                o => o && o.width > 0 && o.height > 0
            );
            if (occupied.length > 0 &&
                OcclusionLayout.isSpawnConflicting(spawnRect, occupied)) {
                const spot = OcclusionLayout.findFreeSpot(spawnRect, occupied);
                if (spot) {
                    x = spot.x;
                    y = spot.y;
                }
            }
        }

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
            // 进度/预览/失败叠加态（CanvasRenderer.drawPlaceholderOverlay
            // 消费）：state running|failed|stuck，pct 0~1|null，stepText
            // 采样步文案，message 失败原因
            placeholderOverlay: { state: 'running', pct: null, stepText: '', message: '' },
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

        const handle = {
            id: imageObj.id, owner, imageObj, intervalId,
            genInfo: opts.genInfo || null,
            promptIds: [],          // 绑定的提交 promptId（清理用）
            lastActive: Date.now()  // 看门狗活动时间戳（进度/预览刷新）
        };
        this.handles.push(handle);
        return handle;
    }

    // ==================== Comfy 进度/预览/失败（2026-11-08） ====================

    /**
     * 绑定句柄与提交 promptId：提交方拿到 /run 响应的 promptId 后调用，
     * 此后中继事件按 promptId 定向到该句柄。一柄可绑多 id（循环多张提交）
     */
    bindPromptId(handle, promptId) {
        if (!handle || !promptId || !this.handles.includes(handle)) return;
        handle.promptIds.push(promptId);
        if (!this.byPromptId.has(promptId)) this.byPromptId.set(promptId, []);
        this.byPromptId.get(promptId).push(handle);
    }

    /** 按 promptId 找「最旧的未终态」句柄（多张并发先进先出） */
    _handleForPrompt(promptId) {
        const list = this.byPromptId.get(promptId);
        if (!list) return null;
        for (const h of list) {
            if (this.handles.includes(h) &&
                h.imageObj.placeholderOverlay.state === 'running') {
                return h;
            }
        }
        return null;
    }

    /** 采样进度（comfy-progress）：更新进度条叠加态并刷新看门狗活动 */
    setProgress(promptId, pct, stepText) {
        const handle = this._handleForPrompt(promptId);
        if (!handle) return;
        handle.lastActive = Date.now();
        const o = handle.imageObj.placeholderOverlay;
        if (o.state !== 'running') return;
        if (pct != null && Number.isFinite(pct)) o.pct = Math.max(0, Math.min(1, pct));
        if (stepText) o.stepText = stepText;
        // 进度=有进展：通知归属节点重置其无进展看门狗（否则长采样——
        // 单张超过节点 WATCHDOG_TIMEOUT 且无新图回流——会被节点误杀）
        if (handle.owner && typeof handle.owner.onGenerationActivity === 'function') {
            try { handle.owner.onGenerationActivity(); } catch { /* 节点自兜 */ }
        }
        this.canvas.draw();
    }

    /**
     * KSampler 式实时预览帧（comfy-preview）：停帧动画换成预览图
     * （预览图持续覆盖，直至真实结果 replace 或失败）。加载失败静默
     * （下一帧预览会再来，动画照跑不受影响）
     */
    setPreview(promptId, dataUrl) {
        const handle = this._handleForPrompt(promptId);
        if (!handle) return;
        handle.lastActive = Date.now();
        const o = handle.imageObj.placeholderOverlay;
        if (o.state !== 'running') return;
        const img = new Image();
        img.onload = () => {
            if (!this.handles.includes(handle) ||
                handle.imageObj.placeholderOverlay.state !== 'running') return;
            if (handle.intervalId) {
                clearInterval(handle.intervalId);   // 停帧动画，预览图顶上
                handle.intervalId = null;
            }
            handle.imageObj.img = img;
            this.canvas.draw();
        };
        img.src = dataUrl;
    }

    /**
     * 生成失败终态（generation-failed，后端 WS 中继 execution_error /
     * history 看门狗广播）：占位图进失败态（红框+原因，渲染见
     * CanvasRenderer），停帧动画，通知归属节点收尾（任务中心/状态复位）。
     * 幂等——重复广播/看门狗与中继双源只生效一次
     */
    failGeneration(promptId, message) {
        const handle = this._handleForPrompt(promptId);
        if (!handle) return;
        const o = handle.imageObj.placeholderOverlay;
        if (o.state !== 'running') return;   // 幂等
        o.state = 'failed';
        o.message = message || '生成失败';
        if (handle.intervalId) {
            clearInterval(handle.intervalId);
            handle.intervalId = null;
        }
        // 归属节点收尾（ComfyGenNode：期望数减一/全部落定按 failed 结算；
        // RunningHub 同名方法为 message 单参签名，对齐之）
        if (handle.owner && typeof handle.owner.onGenerationFailed === 'function') {
            try { handle.owner.onGenerationFailed(o.message); } catch { /* 节点自兜 */ }
        } else {
            // 无归属节点收尾（面板链路 owner='panel'）：失败占位驻留 8s
            // 展示原因后自动移除（面板状态行已有失败提示，不留僵尸卡）
            setTimeout(() => {
                if (this.handles.includes(handle)) this.remove(handle);
            }, 8000);
        }
        this.canvas.draw();
    }

    /** 看门狗扫描：running 态且超时无活动 → stuck（amber 提示，不取消） */
    _scanStuck() {
        const now = Date.now();
        let changed = false;
        for (const handle of this.handles) {
            const o = handle.imageObj.placeholderOverlay;
            if (o && o.state === 'running' &&
                now - (handle.lastActive || handle.imageObj.created) > this.STUCK_MS) {
                o.state = 'stuck';
                o.message = `长时间无响应（超过 ${Math.round(this.STUCK_MS / 60000)} 分钟），疑似卡住`;
                changed = true;
            }
        }
        if (changed) this.canvas.draw();
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
        // promptId 注册表清理（该柄绑定的全部 id，防 Map 泄漏）
        for (const pid of (handle.promptIds || [])) {
            const list = this.byPromptId.get(pid);
            if (list) {
                const i = list.indexOf(handle);
                if (i > -1) list.splice(i, 1);
                if (!list.length) this.byPromptId.delete(pid);
            }
        }
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
     * @param {Object} [meta] - 落图元数据 { name, source, prompt, negativePrompt, genInfo }
     *   genInfo（生成参数记录）缺省时回落句柄上的（面板链路经 create 携带）
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
                    // 生成参数记录（溯源/生成同款）：节点链路经 meta 显式传入，
                    // 面板链路回落句柄携带的（GenerationFeedback.show 绑定）
                    genInfo: (meta.genInfo !== undefined && meta.genInfo !== null)
                        ? meta.genInfo
                        : (handle.genInfo || null),
                    created: Date.now()
                };
                this.canvas.images.images.push(imageObj);
                // 撤销记账：生成落图可回退（undo=摘下真实图，再撤恢复占位图）
                this.canvas.history?.recordCreate([imageObj], '生成落图');
                // 聚集区提示：区内落图且聚集区不在视口内时弹可点击定位提示
                if (this.canvas.collectZone) this.canvas.collectZone.notifyLanded(imageObj);
                // 生成图事件：坐标编辑器「生成图透显」等消费方监听（四类
                // 生成节点与面板链路的占位图替换都经此收口，一处派发全覆盖）。
                // promptIds=占位图句柄绑定的提交句柄（2026-11-12 漫画逐格
                // 生成按它对位回流，超时格的迟来图不冒领后续格）
                window.dispatchEvent(new CustomEvent('lumenGeneratedImage', {
                    detail: {
                        src: imageUrl,
                        imageObj,
                        promptIds: (handle.promptIds || []).slice()
                    }
                }));
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
