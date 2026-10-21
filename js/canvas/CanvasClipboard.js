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
     * 画布复制时写入系统剪贴板的占位文本。真实内容存在内部剪贴板，
     * 外部（如 LLM 输入框粘贴）识别到此文本时可经 extractImageDataUrls()
     * 取回真实图片，避免把这句话粘进聊天
     */
    static PLACEHOLDER_TEXT = 'LumenLight 画布剪贴板内容（请在画布上按 Ctrl+V 粘贴）';

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
            this._ingestDroppedFiles(e);
        });

        // 画布之外 DOM（提示词面板/节点/工具栏等覆盖层）上的文件拖放同样
        // 接收：document 捕获层先于 body 的默认行为吞没层执行，落点由事件
        // 坐标换算（与释放位置的元素无关）——曾只听画布一层，拖到覆盖层上
        // 静默无效（表现为"拖进去没反应、控制台也无报错"）
        document.addEventListener('drop', (e) => {
            if (e.target === c.canvas) return;   // 画布层已处理，避免双落
            this._ingestDroppedFiles(e);
        }, true);

        // 初始化复制粘贴图片功能
        this.initPasteHandler();
    }

    /**
     * 文件拖放入口（画布与画布外覆盖层共用）：
     * 图片 → FileReader 落图；视频/音频 → 上传工作区后落画布。
     * 页面内图片拖拽（LLM 灯箱/聊天图）的 dataTransfer 会同时携带 URL 和
     * 文件，此类拖拽带 text/uri-list——交给 app.js 的 URL 拖放处理，避免
     * 同一张图被重复添加两次。注意只有 uri-list 能作为跳过条件——部分
     * 文件来源（聊天工具/下载列表拖出）会同时设置 text/plain 与 Files，
     * 把 text/plain 也纳入跳过会让这类文件拖入静默无效（曾致 mp3/wav
     * 拖不进画布）
     * @param {DragEvent} e - drop 事件
     */
    _ingestDroppedFiles(e) {
        const c = this.canvas;
        if (!e.dataTransfer) return;
        if (e.dataTransfer.getData('text/uri-list')) return;

        const allFiles = Array.from(e.dataTransfer.files);
        if (allFiles.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
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

        // 音频文件：上传到 data/audio/ 后以自绘音频卡片落画布
        // （isAudioFile 同样对 MIME 为空的文件按扩展名兜底）
        const audioFiles = allFiles.filter(f => CanvasAudioManager.isAudioFile(f));
        audioFiles.forEach((file, i) => {
            c.audioManager.addAudioFile(file, {
                x: e.clientX - rect.left + i * 20,
                y: e.clientY - rect.top + i * 20
            }).then(() => c.draw())
              .catch((err) => console.error('音频拖放处理失败:', err));
        });
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
                    if (type.startsWith('image/') || CanvasVideoManager.isVideoFile(list[i]) ||
                        CanvasAudioManager.isAudioFile(list[i])) return true;
                }
                return false;
            });
            if (!systemHasMedia && this.hasInternal()) {
                e.preventDefault();
                this.pasteInternal();
                return;
            }

            if (!items && !files) return;

            // 收集所有图片与视频/音频
            const imagesToAdd = [];
            const videosToAdd = [];
            const audiosToAdd = [];

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
                    } else if (CanvasAudioManager.isAudioFile(file)) {
                        audiosToAdd.push(file);
                    }
                }
            }

            // 如果没有图片和视频/音频，不拦截，让默认行为处理
            if (imagesToAdd.length === 0 && videosToAdd.length === 0 && audiosToAdd.length === 0) {
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

            // 音频文件：上传 data/audio/ 后以音频卡片落画布，同样错开落点
            for (let i = 0; i < audiosToAdd.length; i++) {
                const offset = (imagesToAdd.length + videosToAdd.length + i) * 200;
                try {
                    const p = c.viewport.screenToCanvas(centerX + offset, centerY + offset);
                    await c.audioManager.addAudioFile(audiosToAdd[i], {
                        centerX: p.x,
                        centerY: p.y
                    });
                } catch (err) {
                    console.error(`❌ 粘贴音频 ${i + 1} 失败:`, err);
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
     * 提取内部剪贴板中图片对象的 data URL（供 LLM 附件等外部消费）。
     * 跳过节点（无位图）与视频对象（img 是封面帧，贴给 AI 会误导）。
     * 跨域污染的图片 toDataURL 会抛错，逐张捕获不影响其余。
     * @returns {string[]} base64 data URL 数组
     */
    extractImageDataUrls() {
        if (!this.hasInternal()) return [];
        const urls = [];
        for (const entry of this._internal) {
            if (entry.kind !== 'image') continue;
            const d = entry.data;
            if (d.videoUrl || !d.img) continue;
            try {
                const cv = document.createElement('canvas');
                cv.width = d.img.naturalWidth || d.img.width;
                cv.height = d.img.naturalHeight || d.img.height;
                cv.getContext('2d').drawImage(d.img, 0, 0);
                urls.push(cv.toDataURL('image/png'));
            } catch (err) {
                console.error('提取画布剪贴板图片失败:', err);
            }
        }
        return urls;
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
                    // 编辑笔迹层随图复制（粘贴出的副本带笔迹图层）
                    ...(obj.editStrokes ? { editStrokes: obj.editStrokes } : {}),
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
        navigator.clipboard?.writeText(CanvasClipboard.PLACEHOLDER_TEXT).catch(() => {});
        return true;
    }

    /**
     * 剪切：复制选中对象后删除原对象（与 Delete 键同一套清理逻辑）
     * @returns {boolean} 是否剪切了内容
     */
    cutSelection() {
        const c = this.canvas;
        const objs = c.images.getSelected();
        if (objs.length === 0 || !this.copySelection()) return false;
        // 删除统一走历史模块：剪切跳过视频文件清理（文件要留给粘贴出的
        // 新对象使用，撤销栈淘汰时也不清理——剪贴板里的引用仍可能被粘贴）
        c.history.deleteObjects(objs, [], { label: '剪切', fileCleanup: 'skip' });
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
                } else if (entry.type === NodeTypes.SOURCE.RUNHUB_GEN_NODE) {
                    // RunningHub 云端工作流节点：恢复几何、工作流选择与参数值
                    node = new RunningHubGenNode(c, data.x + offset, data.y + offset, {
                        width: data.width,
                        height: data.height,
                        workflowId: data.workflowId,
                        values: data.values,
                        count: data.count
                    });
                    c.images.images.push(node);
                } else if (entry.type === NodeTypes.SOURCE.VIDEO_GEN_NODE) {
                    // API 视频生成节点：恢复几何与选择状态
                    node = new VideoGenNode(c, data.x + offset, data.y + offset, {
                        width: data.width,
                        height: data.height,
                        model: data.model,
                        ratio: data.ratio,
                        duration: data.duration
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
                    // 编辑笔迹层随图恢复（副本共享同一笔迹 data URL，
                    // 首次渲染时各自加载 editStrokesImg）
                    ...(d.editStrokes ? { editStrokes: d.editStrokes } : {}),
                    // 视频对象恢复播放地址（复制时保留，见 copySelection）
                    ...(d.videoUrl ? { videoUrl: d.videoUrl } : {}),
                    created: Date.now()
                };
                if (obj.editStrokes) {
                    const layer = new Image();
                    layer.onload = () => {
                        obj.editStrokesImg = layer;
                        c.draw();
                    };
                    layer.src = obj.editStrokes;
                }
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
        // 撤销记账：整次粘贴（多对象混合）作为一条命令回退
        c.history?.recordCreate(newObjects, '粘贴');
        c.draw();
        return true;
    }
}
