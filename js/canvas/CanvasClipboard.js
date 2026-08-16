/**
 * ==========================================================================
 * LumenLight 画布剪贴板管理器
 * 作用：处理图片的拖放上传和剪贴板粘贴功能，将外部图片添加到画布中；
 *       同时提供画布对象的复制/剪切/粘贴（Ctrl+C / Ctrl+X / Ctrl+V），
 *       支持图片与提示词/生图节点，与系统剪贴板快捷键习惯一致。
 * 说明：外部图片添加由 ImageManager 完成；画布对象复制为内部剪贴板，
 *       不写系统剪贴板（粘贴时系统剪贴板里的图片优先）。
 * ==========================================================================
 */

class CanvasClipboard {
    /**
     * 构造函数：保存画布主类引用并初始化事件
     * @param {Canvas} canvas - 画布主类实例
     */
    constructor(canvas) {
        this.canvas = canvas;          // 画布主类实例
        this._internal = null;         // 画布内部剪贴板（copySelection 的快照数组）
        this._pasteCount = 0;          // 连续粘贴次数（每次 Ctrl+V 递增，用于错开位置）
        this._extPasteCount = 0;       // 外部图片（截图等）连续粘贴次数（错开落点）
        this.bindEvents();
    }

    /**
     * 绑定拖放上传和粘贴事件
     */
    bindEvents() {
        const c = this.canvas;

        // 拖拽上传：阻止默认拖拽行为
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
            document.body.addEventListener(evt, (e) => {
                e.preventDefault();
                e.stopPropagation();
            }, false);
        });

        // 处理文件拖放上传（从系统资源管理器等拖入图片/视频文件）
        c.canvas.addEventListener('drop', (e) => {
            // 页面内图片拖拽（LLM 灯箱/聊天图）的 dataTransfer 会同时携带 URL 和文件，
            // 此时交给 app.js 的 URL 拖放处理，避免同一张图被重复添加两次
            if (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')) {
                return;
            }

            const allFiles = Array.from(e.dataTransfer.files);
            const rect = c.canvas.getBoundingClientRect();

            // 图片文件：走现有流程（FileReader → data URL → addImage）
            const imageFiles = allFiles.filter(f => f.type.startsWith('image/'));
            imageFiles.forEach((file, i) => {
                c.images.add(file, e.clientX - rect.left + i * 20, e.clientY - rect.top, c.viewport, i * 20)
                    .then(() => c.draw());
            });

            // 视频文件：上传到服务器持久化存储，然后通过 CanvasVideoManager 添加到画布。
            // isVideoFile 对 MIME 为空的文件（Windows 拖 .mkv/.mov）按扩展名兜底
            const videoFiles = allFiles.filter(f => CanvasVideoManager.isVideoFile(f));
            videoFiles.forEach((file) => {
                c.videoManager.addVideoFile(file)
                    .then(() => c.draw())
                    .catch((err) => console.error('视频拖放处理失败:', err));
            });
        });

        // 初始化复制粘贴图片功能
        this.initPasteHandler();
    }

    /**
     * 初始化粘贴事件处理：支持从剪贴板粘贴图片到画布中心
     */
    initPasteHandler() {
        const c = this.canvas;

        document.addEventListener('paste', async (e) => {
            // 检查当前焦点是否在输入框/文本域中
            const activeElement = document.activeElement;
            const isInputFocused = activeElement && (
                activeElement.tagName === 'INPUT' ||
                activeElement.tagName === 'TEXTAREA' ||
                activeElement.isContentEditable
            );

            // 如果焦点在输入框中，不拦截粘贴，让默认行为处理文字粘贴
            if (isInputFocused) {
                return;
            }

            const items = e.clipboardData?.items;
            const files = e.clipboardData?.files;

            // 系统剪贴板没有图片/视频、且内部剪贴板有内容时，粘贴 Ctrl+C 复制的
            // 画布对象（图片/节点）；系统剪贴板有图片或视频文件
            // （截图/复制的文件）时仍走下方的外部粘贴流程
            const systemHasMedia = [items, files].some((list) => {
                if (!list) return false;
                for (let i = 0; i < list.length; i++) {
                    const type = list[i].type || '';
                    if (type.startsWith('image/') || CanvasVideoManager.isVideoFile(list[i])) return true;
                }
                return false;
            });
            if (!systemHasMedia && this.hasInternal()) {
                e.preventDefault();
                this.pasteInternal();
                return;
            }

            if (!items && !files) return;

            // 收集所有图片与视频
            const imagesToAdd = [];
            const videosToAdd = [];

            // 方法1：从 items 获取（支持截图等）
            if (items) {
                for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    if (item.type.startsWith('image/')) {
                        const blob = item.getAsFile();
                        if (blob) {
                            imagesToAdd.push(blob);
                        }
                    }
                }
            }

            // 方法2：从 files 获取（支持文件复制，含视频文件）
            if (files && imagesToAdd.length === 0) {
                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    if (file.type.startsWith('image/')) {
                        imagesToAdd.push(file);
                    } else if (CanvasVideoManager.isVideoFile(file)) {
                        videosToAdd.push(file);
                    }
                }
            }

            // 如果没有图片和视频，不拦截，让默认行为处理
            if (imagesToAdd.length === 0 && videosToAdd.length === 0) {
                return;
            }

            // 有图片，阻止默认行为并处理图片
            e.preventDefault();

            // 获取画布中心位置（视口坐标）；同一批多张按 200px 错开，
            // 连续多次 Ctrl+V 时整批再向右下递进 200px，避免叠在一起看不出变化
            const canvasRect = c.canvas.getBoundingClientRect();
            const centerX = canvasRect.width / 2 + this._extPasteCount * 200;
            const centerY = canvasRect.height / 2 + this._extPasteCount * 200;
            this._extPasteCount++;

            // 顺序处理每张图片，添加偏移避免重叠
            for (let i = 0; i < imagesToAdd.length; i++) {
                const blob = imagesToAdd[i];
                const offsetX = i * 200;
                const offsetY = i * 200;

                try {
                    await c.images.add(blob, centerX + offsetX, centerY + offsetY, c.viewport, 0);
                } catch (err) {
                    console.error(`❌ 粘贴图片 ${i + 1} 失败:`, err);
                }
            }

            // 视频文件：共享导入入口上传后落画布，同样错开落点。
            // 视口坐标（含错开偏移）→ 画布世界坐标，落点跟随当前视图
            for (let i = 0; i < videosToAdd.length; i++) {
                const offset = (imagesToAdd.length + i) * 200;
                try {
                    const p = c.viewport.screenToCanvas(centerX + offset, centerY + offset);
                    await c.videoManager.addVideoFile(videosToAdd[i], {
                        centerX: p.x,
                        centerY: p.y
                    });
                } catch (err) {
                    console.error(`❌ 粘贴视频 ${i + 1} 失败:`, err);
                }
            }

            c.draw();
        });

    }

    // ==================== 画布对象复制 / 剪切 / 粘贴（Ctrl+C / Ctrl+X / Ctrl+V） ====================

    /**
     * 是否有可粘贴的画布内部剪贴板内容
     * @returns {boolean}
     */
    hasInternal() {
        return Array.isArray(this._internal) && this._internal.length > 0;
    }

    /**
     * 重置粘贴错位计数（在画布上按下鼠标时调用）：
     * 点击画布代表开启新一段操作，之后的粘贴重新从贴近原位/画布中心开始
     */
    resetPasteOffset() {
        this._pasteCount = 0;
        this._extPasteCount = 0;
    }

    /**
     * 复制当前选中的画布对象（图片 / 提示词节点 / 生图节点）到内部剪贴板。
     * 生成占位图为临时对象，不参与复制。
     * @returns {boolean} 是否复制了内容
     */
    copySelection() {
        const c = this.canvas;
        const selected = c.images.getSelected().filter(
            (obj) => !NodeTypes.isPlaceholder(obj.source)
        );
        if (selected.length === 0) return false;

        // 快照选中对象：图片直接记录渲染字段（img 元素复用引用，粘贴免重新加载）；
        // DOM 节点走各自 toJSON()，粘贴时按构造参数重建
        this._internal = selected.map((obj) => {
            if (NodeTypes.isPanelNode(obj.source)) {
                return { kind: 'node', type: obj.source, data: obj.toJSON() };
            }
            return {
                kind: 'image',
                data: {
                    img: obj.img,
                    x: obj.x,
                    y: obj.y,
                    width: obj.width,
                    height: obj.height,
                    name: obj.name,
                    source: obj.source,
                    prompt: obj.prompt || '',
                    negativePrompt: obj.negativePrompt || '',
                    // 视频对象保留播放地址：剪切会跳过文件清理
                    // （delete 的 skipFileCleanup 选项），粘贴出的副本
                    // 依赖它继续可播放
                    ...(obj.videoUrl ? { videoUrl: obj.videoUrl } : {})
                }
            };
        });
        this._pasteCount = 0;    // 新一次复制后，第一次粘贴贴近原位
        this._extPasteCount = 0;
        // 同步向系统剪贴板写入占位文本：替换掉残留的旧图片内容。
        // 否则系统剪贴板里的旧图会让 Ctrl+V 永远走外部粘贴，
        // 内部复制的画布对象无法粘出（与系统应用"复制即替换剪贴板"的习惯一致）
        navigator.clipboard?.writeText('LumenLight 画布剪贴板内容（请在画布上按 Ctrl+V 粘贴）').catch(() => {});
        return true;
    }

    /**
     * 剪切：复制选中对象后删除原对象（与 Delete 键同一套清理逻辑）
     * @returns {boolean} 是否剪切了内容
     */
    cutSelection() {
        if (!this.copySelection()) return false;
        const c = this.canvas;
        for (const img of c.images.getSelected()) {
            // 剪切跳过视频文件清理：剪贴板里保留了 videoUrl，
            // 粘贴出的副本仍指向同一个工作区文件
            c.images.delete(img.id, { skipFileCleanup: true });
            // DOM 节点（提示词/生图节点）需要同步移除 DOM 元素
            if (typeof img.destroy === 'function') img.destroy();
            // 同步清理被删对象关联的所有连线
            c.connections.removeByImage(img.id);
        }
        c.images.select(null);
        c.draw();
        return true;
    }

    /**
     * 粘贴内部剪贴板内容：整体向右下偏移，连续 Ctrl+V 依次错开（系统习惯），
     * 粘贴出的对象自动选中
     * @returns {boolean} 是否粘贴了内容
     */
    pasteInternal() {
        if (!this.hasInternal()) return false;
        const c = this.canvas;
        this._pasteCount++;
        // 每次粘贴向右下错开 200 世界像素：节点/图片普遍 2000px 上下，
        // 40px 级别的位移肉眼分辨不出是否粘贴成功
        const offset = this._pasteCount * 200;

        const newObjects = [];
        for (const entry of this._internal) {
            if (entry.kind === 'node') {
                const data = entry.data;
                let node;
                if (entry.type === NodeTypes.SOURCE.PROMPT_NODE) {
                    node = new PromptNode(c, data.x + offset, data.y + offset, data.text, {
                        width: data.width,
                        height: data.height
                    });
                    c.images.images.push(node);
                    // 与右键菜单新建节点保持一致，通知快照等监听方
                    window.dispatchEvent(new CustomEvent('promptNodeAdded', { detail: { node } }));
                } else if (entry.type === NodeTypes.SOURCE.TEXT_NODE) {
                    node = new TextNode(c, data.x + offset, data.y + offset, data.text, {
                        width: data.width,
                        height: data.height
                    });
                    c.images.images.push(node);
                } else if (entry.type === NodeTypes.SOURCE.COMFY_GEN_NODE) {
                    node = new ComfyGenNode(c, data.x + offset, data.y + offset, {
                        width: data.width,
                        height: data.height,
                        workflowId: data.workflowId,
                        models: data.models,
                        loraEnabled: data.loraEnabled,
                        steps: data.steps,
                        cfg: data.cfg,
                        sampler: data.sampler,
                        sizeW: data.sizeW,
                        sizeH: data.sizeH,
                        denoise: data.denoise,
                        count: data.count
                    });
                    c.images.images.push(node);
                } else if (entry.type === NodeTypes.SOURCE.LORA_NODE) {
                    node = new LoraNode(c, data.x + offset, data.y + offset, {
                        width: data.width,
                        height: data.height,
                        entries: data.entries
                    });
                    c.images.images.push(node);
                } else {
                    node = new ImageGenNode(c, data.x + offset, data.y + offset, {
                        width: data.width,
                        height: data.height,
                        model: data.model,
                        ratio: data.ratio,
                        tier: data.tier,
                        quality: data.quality,
                        count: data.count
                    });
                    c.images.images.push(node);
                }
                newObjects.push(node);
            } else {
                const d = entry.data;
                const obj = {
                    id: LumenLight.generateId(),
                    name: d.name,
                    img: d.img,               // 复用同一 HTMLImageElement，无需重新加载
                    x: d.x + offset,
                    y: d.y + offset,
                    width: d.width,
                    height: d.height,
                    selected: false,
                    source: d.source,
                    prompt: d.prompt,
                    negativePrompt: d.negativePrompt,
                    // 视频对象恢复播放地址（复制时保留，见 copySelection）
                    ...(d.videoUrl ? { videoUrl: d.videoUrl } : {}),
                    created: Date.now()
                };
                c.images.images.push(obj);
                newObjects.push(obj);
            }
        }

        // 粘贴出的对象整体选中（与系统复制粘贴体验一致）
        c.images.selectedIds.forEach((sid) => {
            const img = c.images.images.find((i) => i.id === sid);
            if (img) img.selected = false;
        });
        c.images.selectedIds.clear();
        for (const obj of newObjects) {
            obj.selected = true;
            c.images.selectedIds.add(obj.id);
        }
        c.draw();
        return true;
    }
}
