/**
 * ==========================================================================
 * LumenLight 存档序列化器（从 SaveManager.js 拆出）
 * 作用：画布状态 <-> 存档数据（project.json 结构）的双向转换。
 *   - 收集（保存方向）：图片 / 提示词节点 / 连线 / 编组 / 提示词 / 视口 -> 存档数据
 *   - 恢复（打开方向）：存档数据 -> 重建画布对象（图片、节点、连线、编组）
 *   - 保存成功后的文件名映射回写（applySavedMappings）
 * 不含任何 DOM 模态框逻辑（见 SaveModal.js）和 HTTP 通信（留在 SaveManager.js）。
 * 依赖：window.canvas（Canvas 实例）、全局 PromptNode 类
 * ==========================================================================
 */

class ProjectSerializer {
    /**
     * 构造函数
     * @param {Canvas} canvas - 画布主类实例
     */
    constructor(canvas) {
        this.canvas = canvas;
    }

    /**
     * 获取当前提示词内容
     * @returns {Object} 包含两个正面框与负面提示词的对象
     *   （positive 为正面框 1，positive2 为正面框 2）
     */
    getPrompts() {
        const posPrompt = document.getElementById('posPrompt');
        const posPrompt2 = document.getElementById('posPrompt2');
        const negPrompt = document.getElementById('negPrompt');
        return {
            positive: posPrompt ? posPrompt.value : '',
            positive2: posPrompt2 ? posPrompt2.value : '',
            negative: negPrompt ? negPrompt.value : ''
        };
    }

    /**
     * 设置提示词内容
     * @param {string} positive - 正面提示词（框 1）
     * @param {string} negative - 负面提示词
     * @param {string} [positive2] - 正面提示词（框 2，旧存档无此字段时为空）
     */
    setPrompts(positive, negative, positive2) {
        const posPrompt = document.getElementById('posPrompt');
        const posPrompt2 = document.getElementById('posPrompt2');
        const negPrompt = document.getElementById('negPrompt');
        if (posPrompt) posPrompt.value = positive || '';
        if (posPrompt2) posPrompt2.value = positive2 || '';
        if (negPrompt) negPrompt.value = negative || '';
    }

    /**
     * 获取当前视口状态
     * @returns {Object} 视口缩放和平移状态
     */
    getViewport() {
        const viewport = this.canvas.viewport;
        return {
            scale: viewport.scale,
            offsetX: viewport.offsetX,
            offsetY: viewport.offsetY
        };
    }

    /**
     * 设置视口状态
     * @param {Object} viewport - 视口状态对象
     */
    setViewport(viewport) {
        if (!viewport) return;
        const vp = this.canvas.viewport;
        vp.scale = viewport.scale || 1;
        vp.offsetX = viewport.offsetX || 0;
        vp.offsetY = viewport.offsetY || 0;
        vp.updateIndicator();
    }

    /**
     * 收集当前画布上的连线数据用于存档
     * 只保留引用了有效图片的连线（prune 掉指向已删除图片的残留）；
     * 保存时按 fromId 排序，保证同源连线的 order 顺序稳定可复现。
     * @returns {Array} 连线数据数组 [{fromId, toId, order}]
     */
    getConnectionsData() {
        if (!this.canvas.connections) return [];
        this.canvas.connections.prune();
        return this.canvas.connections.connections
            .slice()
            .sort((a, b) => a.fromId === b.fromId ? a.order - b.order : 0)
            .map(c => ({ fromId: c.fromId, toId: c.toId, order: c.order }));
    }

    /**
     * 视频对象的封面文件名：画布视频的封面是首帧 PNG（data URL），
     * 存档文件名必须是 .png——若沿用 .mp4 视频名，后端会把 PNG 字节
     * 写进 .mp4 文件（存档里出现"损坏的视频"，且恢复时封面加载异常）
     * @param {string} name - 视频对象名（通常为 xxx.mp4）
     * @returns {string} xxx.png
     */
    _coverFilename(name) {
        const base = (name || '').replace(/\.[^.]+$/, '');
        return (base || 'video') + '.png';
    }

    /**
     * 收集当前画布上所有图片的存档数据（轻量模式，实时保存用）
     * 提示词节点没有图像数据，序列化为独立字段 nodes，
     * 后端存入 project.json，恢复时按 type 重建。
     * @returns {Array} 图片数据数组
     */
    collectImages() {
        // 过滤掉生成反馈占位图与面板节点（提示词/生图/文本节点单独收集）
        return this.canvas.images.images
            .filter(img => !NodeTypes.isPlaceholder(img.source) &&
                           !NodeTypes.isPanelNode(img.source))
            .map(img => ({
                id: img.id,                       // 图片唯一ID（保存后回写映射用）
                src: this._normalizeSrc(img.img.src),
                filename: NodeTypes.isVideo(img.source)
                    ? this._coverFilename(img.name)
                    : (img.name || `image_${img.id}.png`),
                x: img.x,
                y: img.y,
                width: img.width,
                height: img.height,
                name: img.name,
                source: img.source,
                prompt: img.prompt || '',
                negativePrompt: img.negativePrompt || '',
                // 生成参数记录（溯源/生成同款，GenRecord；无记录的图不写字段）
                ...(img.genInfo ? { genInfo: img.genInfo } : {}),
                // 编辑笔迹层（非破坏性图层，data URL；无笔迹时不写字段）
                ...(img.editStrokes ? { editStrokes: img.editStrokes } : {}),
                ...(img.editStrokesOpacity !== undefined
                    ? { editStrokesOpacity: img.editStrokesOpacity } : {}),
                // 遮罩层（局部重绘元数据，非破坏性图层，data URL）
                ...(img.mask ? { mask: img.mask } : {}),
                // 图像编辑器图层栈（ImageStudio：每层笔迹/遮罩/透明度，
                // data URL 内嵌；无图层结构时不写字段）
                ...(img.studioLayers ? { studioLayers: img.studioLayers } : {}),
                // 视频对象额外保存视频地址（恢复时重建 videoEl）
                ...(NodeTypes.isVideo(img.source) && img.videoUrl ? { videoUrl: img.videoUrl } : {}),
                // 音频对象额外保存音频地址与时长（恢复时重建卡片展示）
                ...(NodeTypes.isAudio(img.source) && img.audioUrl ? { audioUrl: img.audioUrl, duration: img.duration } : {})
            }));
    }

    /**
     * 收集图片数据（手动存档专用，异步弹性模式）。
     * 先并发 HEAD 探测源文件是否存在：
     *   - 存在 → 相对路径（后端 copyFile，零编码开销）；
     *   - 不存在（被外部删除）→ 从内存位图编码为 data URL，保证仍可保存。
     * 只有真正缺失的文件才触发昂贵的同步 PNG 编码，正常保存零卡顿。
     * @returns {Promise<Array>} 图片数据数组
     */
    async collectImagesForSave() {
        const filtered = this.canvas.images.images
            .filter(img => !NodeTypes.isPlaceholder(img.source) &&
                           !NodeTypes.isPanelNode(img.source));

        return Promise.all(filtered.map(async img => {
            const rawSrc = img.img.src || '';
            let src = rawSrc;

            if (!rawSrc.startsWith('data:') && !rawSrc.startsWith('blob:')) {
                const relative = this._normalizeSrc(rawSrc);
                const exists = await this._fileExists(relative);
                src = exists ? relative : this._toDataUrl(img.img);
            }

            return {
                id: img.id,
                src,
                filename: NodeTypes.isVideo(img.source)
                    ? this._coverFilename(img.name)
                    : (img.name || `image_${img.id}.png`),
                x: img.x,
                y: img.y,
                width: img.width,
                height: img.height,
                name: img.name,
                source: img.source,
                prompt: img.prompt || '',
                negativePrompt: img.negativePrompt || '',
                // 生成参数记录（溯源/生成同款，GenRecord；无记录的图不写字段）
                ...(img.genInfo ? { genInfo: img.genInfo } : {}),
                // 编辑笔迹层（非破坏性图层，data URL 内嵌 project.json）
                ...(img.editStrokes ? { editStrokes: img.editStrokes } : {}),
                ...(img.editStrokesOpacity !== undefined
                    ? { editStrokesOpacity: img.editStrokesOpacity } : {}),
                // 遮罩层（局部重绘元数据，非破坏性图层，data URL 内嵌 project.json）
                ...(img.mask ? { mask: img.mask } : {}),
                // 图像编辑器图层栈（同上，studioLayers 随存档持久化）
                ...(img.studioLayers ? { studioLayers: img.studioLayers } : {}),
                // 视频对象额外保存视频地址（恢复时重建 videoEl）
                ...(NodeTypes.isVideo(img.source) && img.videoUrl ? { videoUrl: img.videoUrl } : {}),
                // 音频对象额外保存音频地址与时长（恢复时重建卡片展示）
                ...(NodeTypes.isAudio(img.source) && img.audioUrl ? { audioUrl: img.audioUrl, duration: img.duration } : {})
            };
        }));
    }

    /**
     * HEAD 探测服务器文件是否存在（localhost 上并发极快）
     * @param {string} relativePath - 相对路径
     * @returns {Promise<boolean>}
     */
    async _fileExists(relativePath) {
        try {
            const res = await fetch('/' + relativePath, { method: 'HEAD' });
            return res.ok;
        } catch {
            return false;
        }
    }

    /**
     * 将同源绝对 URL 转为相对路径（去除 origin 前缀）。
     * 浏览器中 img.src 始终返回解析后的绝对 URL，如不去除 origin，
     * 后端会误认为是远程 URL 而发起 HTTP 自下载（多余且脆弱）。
     * @param {string} src - 图片 src（可能是绝对 URL 或相对路径）
     * @returns {string} 相对路径或原始值
     */
    _normalizeSrc(src) {
        if (!src) return src;
        const origin = location.origin;
        if (src.startsWith(origin + '/')) {
            return decodeURIComponent(src.slice(origin.length + 1));
        }
        return src;
    }

    /**
     * 从 Image 元素的内存位图提取 data URL（自包含保存用）。
     * 已经是 data: URL 的直接返回（避免无谓的重编码）；
     * 服务器路径的图片通过临时 Canvas 重编码为 PNG——
     * 即使源文件已被外部删除，只要图片仍在画布上显示就能保存。
     * @param {HTMLImageElement} imageEl - 图片 DOM 元素
     * @returns {string} data URL
     */
    _toDataUrl(imageEl) {
        const src = imageEl.src || '';
        // 已经是 data URL：直接复用，不重编码
        if (src.startsWith('data:')) return src;
        // 图片未加载成功（naturalWidth = 0）：无法绘制，回退为相对路径
        if (!imageEl.naturalWidth) return this._normalizeSrc(src);
        // 从内存位图绘制到临时 Canvas 并导出为 PNG data URL
        if (!this._tempCanvas) this._tempCanvas = document.createElement('canvas');
        const c = this._tempCanvas;
        c.width = imageEl.naturalWidth;
        c.height = imageEl.naturalHeight;
        c.getContext('2d').drawImage(imageEl, 0, 0);
        return c.toDataURL('image/png');
    }

    /**
     * 收集当前画布上所有 DOM 节点的存档数据（提示词/生图/文本节点）
     * @returns {Array} 节点数据数组（按各自 toJSON 序列化）
     */
    collectNodes() {
        return this.canvas.images.images
            .filter(img => NodeTypes.isPanelNode(img.source))
            .map(node => {
                const d = node.toJSON();
                if (node.seqId) d.seqId = node.seqId;   // 编号随存档持久化（删除不复用）
                return d;
            });
    }

    /**
     * 收集当前画布上所有编组的存档数据（顶层 groups 字段）
     * 组是纯几何对象（不持有成员清单，成员按几何包含实时判定），
     * 只需序列化几何、标题、标题栏颜色（COLOR_PRESETS 键）与标题栏
     * 缩放系数 titleNS（创建时定格，恢复后调整宽高不改变标题栏大小），
     * 恢复无需 id 换算。
     * @returns {Array} 组数据数组 [{id, title, color, titleNS, collect, x, y, width, height}]
     */
    collectGroups() {
        const groups = this.canvas.groups ? this.canvas.groups.groups : [];
        return groups.map(g => ({
            id: g.id,
            title: g.title,
            color: g.color || '',
            titleNS: g.titleNS,
            collect: !!g.collect,
            x: g.x,
            y: g.y,
            width: g.width,
            height: g.height
        }));
    }

    /**
     * 保存成功后，把后端实际写入的文件名回写到画布图片对象
     * 覆盖保存会重建整个 images 目录，同名图片的实际文件名可能与上次不同
     * （如 llm_image.png → llm_image_1.png），不回写会导致画布 src 指向
     * 已被其他图片占用的新文件，出现"添加到内容显示错图"的问题
     * @param {Object} result - 保存接口返回（含 images: [{id, filename}]）
     */
    applySavedMappings(result) {
        if (!result || !Array.isArray(result.images) || !result.name) return;

        for (const meta of result.images) {
            if (!meta.id || !meta.filename) continue;
            const target = this.canvas.images.images.find(img => img.id === meta.id);
            if (!target) continue;

            // 视频对象的存档文件名是 .png 封面（_coverFilename），
            // 不能回写到 name——name 必须保持视频文件名（.mp4），
            // 它是 data/videos 回退定位与展示的依据
            if (!NodeTypes.isVideo(target.source)) {
                target.name = meta.filename;
            }

            // 地址未变化时跳过，避免无谓的重新加载
            // （img.src 读取返回绝对地址，这里用 URL 解析成同格式再比较）
            const newSrc = new URL(
                `save/${encodeURIComponent(result.name)}/images/${encodeURIComponent(meta.filename)}`,
                location.href
            ).href;
            if (target.img.src !== newSrc) {
                target.img.src = newSrc;
            }

            // 视频对象：播放地址同步指向存档内归档副本（覆盖保存后
            // data/videos 原件可能已被清理，存档内副本成为唯一数据源）
            if (NodeTypes.isVideo(target.source) && meta.videoFile) {
                const newVideoUrl =
                    `save/${encodeURIComponent(result.name)}/videos/${encodeURIComponent(meta.videoFile)}`;
                if (target.videoUrl !== newVideoUrl) {
                    target.videoUrl = newVideoUrl;
                }
            }
        }
    }

    // ==================== 恢复画布 ====================

    /**
     * 恢复画布状态
     * @param {Object} data - 存档数据（images 中每项含可加载的 src）
     */
    async restoreProject(data) {
        // 撤销栈随全量恢复作废：先挂起记录（恢复期间的 add 等调用不记账）
        // 并清栈（清栈同时收尾被延迟清理的视频文件），恢复完解除挂起
        const history = this.canvas.history;
        if (history) {
            history.setSuspended(true);
            history.clear();
        }

        // 清空当前画布图片和选择状态（DOM 节点需先销毁元素）
        for (const img of this.canvas.images.images) {
            if (typeof img.destroy === 'function') img.destroy();
        }
        this.canvas.images.images = [];
        this.canvas.images.selectedIds.clear();

        // 恢复提示词（prompt2 为正面框 2，旧存档无此字段时恢复为空）
        this.setPrompts(data.prompt, data.negativePrompt, data.prompt2);

        // 恢复视口状态
        this.setViewport(data.viewport);

        // 恢复图片
        // 存档中的图片 id → 恢复后新图片 id 的映射（连线数据按存档 id 存储，需换算）
        const idMap = new Map();
        const loadPromises = data.images.map(imgData => {
            return new Promise((resolve) => {
                const img = new Image();
                img.onload = () => {
                    // 一次性回调：添加后立即解绑，
                    // 防止后续修改图片 src（如保存后回写存档地址）时重复添加
                    img.onload = null;
                    const newId = LumenLight.generateId();
                    idMap.set(imgData.id, newId);
                    const imageObj = {
                        id: newId,
                        name: imgData.name || imgData.filename,
                        img: img,
                        x: imgData.x,
                        y: imgData.y,
                        width: imgData.width,
                        height: imgData.height,
                        selected: false,
                        source: imgData.source || 'save',
                        prompt: imgData.prompt || '',
                        negativePrompt: imgData.negativePrompt || '',
                        created: Date.now()
                    };
                    // 生成参数记录（溯源/生成同款，GenRecord）：随存档恢复
                    if (imgData.genInfo) {
                        imageObj.genInfo = imgData.genInfo;
                    }
                    // 编辑笔迹层（非破坏性图层）：恢复字段并异步加载位图，
                    // 就位后补一次重绘（渲染器把笔迹层叠画在原图上）
                    if (imgData.editStrokes) {
                        imageObj.editStrokes = imgData.editStrokes;
                        imageObj.editStrokesOpacity = imgData.editStrokesOpacity ?? 1;
                        const layer = new Image();
                        layer.onload = () => {
                            imageObj.editStrokesImg = layer;
                            this.canvas.draw();
                        };
                        layer.src = imgData.editStrokes;
                    }
                    // 图像编辑器图层栈：原样恢复（编辑器打开时按
                    // studioLayers 重建图层结构，无此字段则从
                    // editStrokes/mask 自动迁移为单图层）
                    if (imgData.studioLayers) {
                        imageObj.studioLayers = imgData.studioLayers;
                    }
                    // 遮罩层（局部重绘元数据）：恢复字段并异步加载位图。
                    // 遮罩以半透明红叠画在画布上（渲染器处理），位图就位后
                    // 补一次重绘，同时供遮罩灯箱重入与 Comfy 提交时烘焙 alpha
                    if (imgData.mask) {
                        imageObj.mask = imgData.mask;
                        const maskLayer = new Image();
                        maskLayer.onload = () => {
                            imageObj.maskImg = maskLayer;
                            this.canvas.draw();
                        };
                        maskLayer.src = imgData.mask;
                    }
                    // 视频对象：恢复播放地址。优先用存档内归档副本（读取接口已把
                    // videoUrl 重写为 save/<名>/videos/）；旧存档的元数据没有
                    // videoUrl 字段，按原始文件名回退到 data/videos/（生成时的
                    // 落盘位置，文件仍在即可播放）。历史上 name 曾被误写成
                    // 封面名（.png），这里归一化回视频扩展名 .mp4 再查找
                    if (NodeTypes.isVideo(imageObj.source)) {
                        const fallbackName = (imgData.name || '')
                            .replace(/\.[^.]+$/, '.mp4');
                        const videoUrl = imgData.videoUrl ||
                            (fallbackName ? '/data/videos/' + fallbackName : '');
                        if (videoUrl) {
                            this.canvas.videoManager.restoreVideoElement(imageObj, videoUrl);
                        }
                    }
                    // 音频对象：恢复播放地址（audioUrl 在 data/audio/ 持久化，
                    // 上传即落盘；元数据缺字段时按文件名回退）。
                    // 尺寸归一：历史版本的卡片标准尺寸偏小（420/640/960 三代），
                    // 统一放大到当前标准（中心不变），位图同步按新尺寸重绘
                    // ——旧位图直接拉伸到 1280 宽会糊
                    if (NodeTypes.isAudio(imageObj.source)) {
                        const audioUrl = imgData.audioUrl ||
                            (imgData.name ? '/data/audio/' + imgData.name : '');
                        if (audioUrl) {
                            this.canvas.audioManager.restoreAudioElement(imageObj, audioUrl);
                        }
                        const stdW = this.canvas.audioManager.constructor.CARD_WIDTH;
                        const stdH = this.canvas.audioManager.constructor.CARD_HEIGHT;
                        // 宽度升级（420/640/960 三代旧标准）与高度升级
                        // （336→450 加高代）分开判：用户手动放大过的卡片
                        // （宽已超标准）不回按标准尺寸改写
                        if (imageObj.width < stdW ||
                            (imageObj.width === stdW && imageObj.height < stdH)) {
                            const cx = imageObj.x + imageObj.width / 2;
                            const cy = imageObj.y + imageObj.height / 2;
                            imageObj.width = stdW;
                            imageObj.height = stdH;
                            imageObj.x = Math.round(cx - stdW / 2);
                            imageObj.y = Math.round(cy - stdH / 2);
                        }
                        this.canvas.audioManager.refreshCard(imageObj);
                    }
                    this.canvas.images.images.push(imageObj);
                    resolve(true);
                };
                // 加载失败（文件被外部删除等）：跳过这张图片，不阻塞整体恢复。
                // 音频对象特例：卡片位图缺失（旧版本曾把 canvas 元素直接存进
                // img 导致资产存不出，恢复必 404）但音频文件仍在工作区时，
                // 用元数据重建卡片恢复对象，不整条跳过
                img.onerror = () => {
                    if (NodeTypes.isAudio(imageObj.source) &&
                        (imgData.audioUrl || imgData.name)) {
                        const audioUrl = imgData.audioUrl ||
                            '/data/audio/' + imgData.name;
                        this.canvas.audioManager.addAudio(audioUrl, {
                            name: imgData.name,
                            prompt: imgData.prompt || '',
                            x: imgData.x,
                            y: imgData.y
                        }).then(
                            () => resolve(true),
                            () => resolve(false)
                        );
                        return;
                    }
                    console.warn('存档图片加载失败，已跳过:', imgData.filename || imgData.src);
                    resolve(false);
                };
                img.src = imgData.src;
            });
        });

        await Promise.all(loadPromises);

        // 恢复提示词节点（在连线之前，连线端点可能指向节点）
        this.restoreNodes(data.nodes, idMap);
        // 节点编号计数器下限同步（见 Canvas.syncNodeSeq；旧存档无 nodeSeq 字段跳过）
        this.canvas.syncNodeSeq?.(data.nodeSeq);

        // 恢复连线：按映射换算 id 后重建，指向已不存在图片的连线直接丢弃
        this.restoreConnections(data.connections, idMap);

        // 恢复编组（纯几何对象，无引用换算；在图片/节点之后恢复仅为顺序直观）
        this.restoreGroups(data.groups);

        // 恢复完毕：解除撤销记录挂起
        if (history) history.setSuspended(false);

        // 重绘画布
        this.canvas.draw();
    }

    /**
     * 按存档数据重建画布编组（restoreProject 的辅助方法）
     * 组不引用成员（几何包含实时判定），直接按存档几何重建即可；
     * 字段异常的条目跳过，几何钳制到最小尺寸。
     * @param {Array} groups - 存档组数据 [{id, title, color, x, y, width, height}]
     */
    restoreGroups(groups) {
        const manager = this.canvas.groups;
        manager.groups = [];
        manager.selectedIds.clear();
        if (!Array.isArray(groups)) return;
        for (const g of groups) {
            if (!g || typeof g.x !== 'number' || typeof g.y !== 'number' ||
                typeof g.width !== 'number' || typeof g.height !== 'number') {
                continue;
            }
            manager.groups.push({
                id: g.id || LumenLight.generateId(),
                type: 'group',
                title: g.title || GroupManager.DEFAULT_TITLE,
                // 颜色键不在预设表内（异常/旧版脏数据）时回退无色
                color: GroupManager.COLOR_PRESETS[g.color] ? g.color : '',
                // 标题栏 ns：旧存档无此字段时按恢复尺寸计算（与旧版行为一致）
                titleNS: (typeof g.titleNS === 'number' && g.titleNS > 0)
                    ? g.titleNS
                    : Math.max(Math.min(g.width, g.height) / GroupManager.DESIGN_BASE, 0.01),
                collect: g.collect === true,
                x: g.x,
                y: g.y,
                width: Math.max(g.width, GroupManager.MIN_WIDTH),
                height: Math.max(g.height, GroupManager.MIN_HEIGHT),
                selected: false
            });
        }
        // 聚集唯一性收口：脏数据/手工编辑的存档可能带出多个 collect=true，
        // 归一只保留第一个（开关联动在 GroupManager.setCollect）
        GroupManager.normalizeCollectGroups(manager.groups);
    }

    /**
     * 按存档数据重建画布连线（restoreProject 的辅助方法）
     * 存档中的 fromId/toId 是保存时的图片 id，恢复后图片分配了新 id，
     * 必须通过 idMap 换算；任一端映射缺失（如旧版存档）则跳过该连线。
     * @param {Array} connections - 存档连线数据 [{fromId, toId, order}]
     * @param {Map<string, string>} idMap - 存档图片 id → 新图片 id 映射
     */
    restoreConnections(connections, idMap) {
        this.canvas.connections.clear();
        if (!Array.isArray(connections) || connections.length === 0) return;

        for (const c of connections) {
            const fromId = idMap.get(c.fromId);
            const toId = idMap.get(c.toId);
            if (!fromId || !toId) continue;
            const conn = this.canvas.connections.add(fromId, toId);
            // add 生成的 order 是追加序号，这里以存档 order 覆盖，
            // 保证恢复后的顺序与保存时一致
            if (conn) conn.order = c.order;
        }
    }

    /**
     * 按存档数据重建 DOM 节点（restoreProject 的辅助方法）
     * 与图片一样分配新 id 并记入 idMap，保证指向节点的连线也能正确换算。
     * @param {Array} nodes - 存档节点数据（提示词节点与生图节点混排）
     * @param {Map<string, string>} idMap - 存档 id → 新 id 映射（与图片共用）
     */
    restoreNodes(nodes, idMap) {
        if (!Array.isArray(nodes)) return;
        for (const n of nodes) {
            let node = null;
            if (n.type === NodeTypes.SOURCE.PROMPT_NODE) {
                node = new PromptNode(
                    this.canvas, n.x, n.y, n.text,
                    { width: n.width, height: n.height }
                );
            } else if (n.type === NodeTypes.SOURCE.TEXT_NODE) {
                // 文本节点：备注/注释，仅恢复几何与文本
                node = new TextNode(
                    this.canvas, n.x, n.y, n.text,
                    { width: n.width, height: n.height }
                );
            } else if (n.type === NodeTypes.SOURCE.IMAGE_GEN_NODE) {
                // 生图节点：恢复几何与全部工具栏选择状态
                node = new ImageGenNode(this.canvas, n.x, n.y, {
                    width: n.width,
                    height: n.height,
                    model: n.model,
                    ratio: n.ratio,
                    tier: n.tier,
                    quality: n.quality,
                    count: n.count
                });
            } else if (n.type === NodeTypes.SOURCE.VIDEO_GEN_NODE) {
                // API 视频生成节点：恢复几何与全部选择状态
                // （模型清单由节点构造后自行异步加载并回填）
                node = new VideoGenNode(this.canvas, n.x, n.y, {
                    width: n.width,
                    height: n.height,
                    model: n.model,
                    ratio: n.ratio,
                    duration: n.duration
                });
            } else if (n.type === NodeTypes.SOURCE.COMFY_GEN_NODE) {
                // Comfy 生图节点：恢复几何与全部选择状态
                // （工作流/模型清单由节点构造后自行异步加载并回填）
                node = new ComfyGenNode(this.canvas, n.x, n.y, {
                    width: n.width,
                    height: n.height,
                    workflowId: n.workflowId,
                    models: n.models,
                    loraEnabled: n.loraEnabled,
                    steps: n.steps,
                    cfg: n.cfg,
                    sampler: n.sampler,
                    sizeW: n.sizeW,
                    sizeH: n.sizeH,
                    denoise: n.denoise,
                    count: n.count
                });
            } else if (n.type === NodeTypes.SOURCE.RUNHUB_GEN_NODE) {
                // RunningHub 云端工作流节点：恢复几何、工作流选择与参数值
                // （登记卡下拉清单由节点构造后自行异步加载并回填）
                node = new RunningHubGenNode(this.canvas, n.x, n.y, {
                    width: n.width,
                    height: n.height,
                    workflowId: n.workflowId,
                    values: n.values,
                    count: n.count
                });
            } else if (n.type === NodeTypes.SOURCE.LORA_NODE) {
                // LoRA 节点：恢复几何与条目列表（文件清单由节点自行异步加载）
                node = new LoraNode(this.canvas, n.x, n.y, {
                    width: n.width,
                    height: n.height,
                    entries: n.entries
                });
            } else {
                continue;  // 未来扩展其他节点类型在这里分发
            }
            // 自定义标题回填（旧存档无 title 字段 → 保持类默认标题；
            // 恢复流程的写入由 RealtimeSaveManager 的 restoring 标志抑制）
            if (n.title) node.setTitle(n.title);
            // 编号回填：构造时已分配过占位编号，以存档记录为准
            // （旧存档无 seqId 字段 → 保留构造时新分配的编号）
            if (n.seqId) {
                node.seqId = n.seqId;
                node.refreshTitle();
            }
            this.canvas.images.images.push(node);
            idMap.set(n.id, node.id);
        }
    }
}

// 将 ProjectSerializer 类暴露到全局作用域
window.ProjectSerializer = ProjectSerializer;
