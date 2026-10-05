/**
 * ==========================================================================
 * LumenLight 应用入口文件
 * 作用：在 DOM 加载完成后初始化整个应用，包括主题、画布、WebSocket 连接、
 *       视图控制组件、提示词面板、图片工具栏、生成反馈动画、实时保存，
 *       以及监听高清放大完成事件将放大后的图片添加到画板；
 *       LLM 聊天窗口的图片可通过自定义指针拖拽添加到画布。
 * ==========================================================================
 */

document.addEventListener('DOMContentLoaded', () => {
    // 初始化主题（深色/亮色模式）
    LumenLight.initTheme();

    // 初始化画布主类，保存到全局以便其他组件访问
    window.canvas = new Canvas();

    // 初始化 WebSocket 客户端，用于接收 ComfyUI 生成的图片
    window.socket = new LumenSocket(window.canvas, window.canvas.images);

    // 初始化视图控制组件，保存到全局以便 Canvas 内部访问图片显示缩放
    window.controls = new Controls(window.canvas);

    // 初始化提示词面板（右上角可拖拽面板）
    // 挂到 window 上：Comfy 生图节点生成时读取其负面提示词框内容
    window.promptPanel = new PromptPanel();

    // 初始化图片工具栏（选中图片时显示的浮动工具栏）
    new ImageToolbar(window.canvas);

    // 初始化编组工具栏（选中编组时显示的浮动工具栏，按钮预留；
    // 显隐经 canvasGroupSelected 事件驱动，样式复用 image-toolbar.css）
    window.groupToolbar = new GroupToolbar(window.canvas);

    // 初始化左侧工具栏（画布左侧垂直工具栏，含本地上传图片入口）
    new SideToolbar(window.canvas);

    // 初始化本地资产库（顶栏右侧文件夹按钮，标签绑定本地文件夹，
    // 资产可拖拽/单击添加到画布；见 js/components/AssetLibrary.js）
    window.assetLibrary = new AssetLibrary();

    // 初始化存档管理器（左上角文件菜单）
    // 挂到 window 上供 RealtimeSaveManager 等后续组件复用其 serializer 与 currentSave
    window.saveManager = new SaveManager(window.canvas);

    // 初始化配方管理器（顶栏配方按钮与收藏窗口）
    new RecipeManager();

    // 初始化工作流编辑器（顶栏 Comfy 按钮：左列表右节点图，全参数编辑，
    // 修改直接写回 workflows/*.json；见 js/components/WorkflowEditor.js）
    window.workflowEditor = new WorkflowEditor();

    // 初始化设置管理器
    window.settingsManager = new SettingsManager();

    // 初始化 LLM 聊天窗口（右侧面板 LLM 模式）
    window.llmChat = new LlmChat();

    // 初始化消息刻度导航（LLM 窗口左侧定位索引：点击跳转历史提问，
    // 自行监听消息区 DOM 与滚动，见 js/components/LlmMessageRail.js）
    window.llmMessageRail = new LlmMessageRail(window.llmChat);

    // 初始化 pi 健康状态灯（面板头部模式选择器左侧，黄/红可点击重启 pi 进程）
    window.piStatusLight = new PiStatusLight();

    // 初始化系统提示词管理器（面板头部按钮 + 弹窗，LlmChat 发送时消费）
    window.llmSystemPrompt = new LlmSystemPrompt();

    // 初始化技能库管理器（面板头部按钮 + 弹窗，查阅/启停 pi 技能库；
    // 在系统提示词之后初始化，按钮插入顺序形成「系统提示词-技能库-清空-收起」）
    window.llmSkillManager = new LlmSkillManager();

    // 初始化全局占位图管理器（面板与两类生图节点的占位图统一走这一份实现）
    window.placeholderManager = new PlaceholderManager(window.canvas);

    // 初始化生成反馈动画组件，传入画布实例
    window.generationFeedback = new GenerationFeedback(window.canvas);

    // ==================== 画布实时保存 ====================
    // 必须在 SaveManager 与其他画布相关组件初始化完成后启动：
    //   - CanvasChangeWatcher 统一捕获变更（hook draw + 全局事件），
    //     RealtimeSaveManager（本地磁盘）订阅通知；
    //   - restore() 从磁盘读取上次会话数据，静默重建
    //     图片/节点/连线/视口/提示词，currentSave 一并恢复；
    //   - start() 在恢复流程结束后才开始同步，避免 restoreProject
    //     触发的大量 draw 被当成新变更。
    // 生图节点在重建时会重新调用 loadModels() 拉取最新模型清单，
    // 因此改 API 后 F5 即可看到新模型；旧模型若已删除，节点会自动回退到第一项。
    const changeWatcher = new CanvasChangeWatcher(window.canvas);
    window.realtimeSave = new RealtimeSaveManager(window.canvas, window.saveManager, changeWatcher);
    (async () => {
        await window.realtimeSave.restore();
        window.realtimeSave.start();
    })();

    // ==================== 监听高清放大完成事件 ====================
    // UpscaleManager 在放大成功后会触发该自定义事件，
    // 这里将返回的放大后图片添加到画板上
    window.addEventListener('upscaleComplete', (e) => {
        const { upscaledImage, type, scale, originalImage, index, total } = e.detail;

        // 检查 canvas 和 images 是否存在
        if (!window.canvas) {
            console.error('❌ window.canvas 不存在');
            return;
        }
        if (!window.canvas.images) {
            console.error('❌ window.canvas.images 不存在');
            return;
        }
        if (!window.canvas.images.images) {
            console.error('❌ window.canvas.images.images 不存在');
            return;
        }

        // 创建图片对象
        const img = new Image();
        img.onload = () => {
            // 一次性回调：添加后立即解绑，
            // 防止后续修改图片 src（如保存后回写存档地址）时重复添加
            img.onload = null;

            // 获取原图片位置（如果有原图片信息）
            let centerX, centerY;

            if (originalImage) {
                const viewport = window.canvas.viewport;

                // 将原图片的画布坐标转换为屏幕坐标来计算中心点
                const screenPos = viewport.canvasToScreen(originalImage.x, originalImage.y);
                const screenPos2 = viewport.canvasToScreen(originalImage.x + originalImage.width, originalImage.y + originalImage.height);

                // 在原图片右侧偏移 100 像素处放置新图片
                centerX = (screenPos.x + screenPos2.x) / 2 + 100;
                centerY = (screenPos.y + screenPos2.y) / 2;
            } else {
                centerX = window.canvas.cssWidth / 2;
                centerY = window.canvas.cssHeight / 2;
            }

            // 将屏幕坐标转换回画布坐标
            const cp = window.canvas.viewport.screenToCanvas(centerX, centerY);
            const w = img.width, h = img.height;

            // 创建新的图片对象（模仿 ComfyUI 传图的方式）
            const newImageObj = {
                id: LumenLight.generateId(),                          // 生成唯一ID
                name: `upscaled_${type}_${scale}x_${Date.now()}.png`, // 放大后图片文件名
                img: img,                                             // 图片DOM对象
                x: cp.x - w/2,                                        // 居中显示：x坐标
                y: cp.y - h/2,                                        // 居中显示：y坐标
                width: w,                                             // 图片宽度
                height: h,                                            // 图片高度
                selected: false,                                      // 默认未选中
                source: 'upscale',                                    // 来源标记为高清放大
                prompt: originalImage?.prompt || '',
                negativePrompt: originalImage?.negativePrompt || '',
                created: Date.now()                                   // 创建时间戳
            };

            // 直接添加到图片数组
            window.canvas.images.images.push(newImageObj);

            // 触发画布重绘，显示新图片
            window.canvas.draw();
        };

        // 图片加载失败处理
        img.onerror = (err) => {
            console.error('❌ 图片加载失败:', err);
        };

        // 设置图片源为放大后的 base64 数据
        img.src = upscaledImage;
    });

    // ==================== 监听扩图完成事件 ====================
    // ImageOutpaint 灯箱保存后触发：按画幅导出的新图（白色填充扩展区）
    // 作为新图片落到原图右侧，原图不动（与放大/抠图同流程）
    window.addEventListener('outpaintComplete', (e) => {
        const { originalImage, imageDataUrl } = e.detail;

        if (!window.canvas?.images?.images) {
            console.error('❌ window.canvas 不存在');
            return;
        }

        const img = new Image();
        img.onload = () => {
            img.onload = null;
            const viewport = window.canvas.viewport;

            // 新图落在原图右侧偏移 100 像素处（与放大结果同placement）
            const sp1 = viewport.canvasToScreen(originalImage.x, originalImage.y);
            const sp2 = viewport.canvasToScreen(originalImage.x + originalImage.width, originalImage.y + originalImage.height);
            const centerX = (sp1.x + sp2.x) / 2 + 100;
            const centerY = (sp1.y + sp2.y) / 2;
            const cp = viewport.screenToCanvas(centerX, centerY);
            const w = img.width, h = img.height;

            const newImageObj = {
                id: LumenLight.generateId(),
                name: `outpaint_${Date.now()}.png`,
                img: img,
                x: cp.x - w / 2,
                y: cp.y - h / 2,
                width: w,
                height: h,
                selected: false,
                source: 'outpaint',
                prompt: originalImage?.prompt || '',
                negativePrompt: originalImage?.negativePrompt || '',
                created: Date.now()
            };
            window.canvas.images.images.push(newImageObj);
            window.canvas.draw();
            window.socket?.showNotification('扩图完成');
        };
        img.onerror = (err) => {
            console.error('❌ 扩图结果加载失败:', err);
        };
        img.src = imageDataUrl;
    });

    // ==================== 监听抠图完成事件 ====================
    // ImageToolbar 抠图成功后触发该事件，
    // 这里把去背景后的透明 PNG 作为新图片添加到原图右侧
    window.addEventListener('rembgComplete', (e) => {
        const { image, originalImage } = e.detail;

        if (!window.canvas?.images?.images) {
            console.error('画布未就绪，无法添加抠图结果');
            return;
        }

        const img = new Image();
        img.onload = () => {
            // 一次性回调：添加后立即解绑，
            // 防止后续修改图片 src（如保存后回写存档地址）时重复添加
            img.onload = null;

            // 抠图不改变尺寸，直接放在原图右侧 100 像素处
            const newImageObj = {
                id: LumenLight.generateId(),
                name: `rembg_${Date.now()}.png`,
                img: img,
                x: originalImage.x + originalImage.width + 100,
                y: originalImage.y,
                width: originalImage.width,
                height: originalImage.height,
                selected: false,
                source: 'rembg',            // 来源标记为抠图
                prompt: originalImage.prompt || '',
                negativePrompt: originalImage.negativePrompt || '',
                created: Date.now()
            };

            window.canvas.images.images.push(newImageObj);
            window.canvas.draw();
        };

        img.onerror = (err) => {
            console.error('抠图结果加载失败:', err);
        };

        img.src = image;
    });

});
