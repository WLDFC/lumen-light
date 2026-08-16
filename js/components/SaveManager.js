/**
 * ==========================================================================
 * LumenLight 存档管理器组件（编排层）
 * 作用：在画布页面左上角提供文件菜单（汉堡按钮），编排存档流程：
 *   1. 打开画布：弹框列出 save/ 目录（默认存档目录）下的所有存档，
 *      选中后从后端读取并恢复画布状态；
 *   2. 保存画布：打开过存档时覆盖存回原存档（后端接口分批上传）；
 *      尚未打开/另存过任何存档时自动进入“另存为”流程；
 *   3. 另存为：弹框输入存档名称，直接保存到 save/ 目录下，
 *      与已有存档同名时询问用户是否覆盖，用户可选择覆盖或取消。
 *
 * 职责拆分（原 800 行单类拆为三层）：
 *   - ProjectSerializer（js/components/save/ProjectSerializer.js）
 *       画布状态 <-> 存档数据的双向转换（收集/恢复/映射回写）
 *   - SaveModal（js/components/save/SaveModal.js）
 *       存档相关全部模态框 UI（打开/另存为/进度）
 *   - SaveManager（本文件）
 *       文件菜单、currentSave 状态、保存/读取 HTTP 流程编排，
 *       并以门面方法向外部（NewCanvasManager 等）暴露统一接口，
 *       拆分后外部调用方式保持不变
 *
 * "新建画布"逻辑在 NewCanvasManager.js 中（本组件构造时创建其实例，
 * 共享 currentSave 状态与保存/模态框方法）。
 * 依赖：window.canvas（Canvas 实例）、window.controls（Controls 实例）
 * ==========================================================================
 */

class SaveManager {
    /**
     * 构造函数：初始化菜单、子组件和事件绑定
     * @param {Canvas} canvas - 画布主类实例
     */
    constructor(canvas) {
        this.canvas = canvas;

        // 当前存档名称（save/ 目录下），打开/另存为后有值
        this.currentSave = null;

        // 左上角当前画布名称显示元素
        this.canvasNameDisplay = document.getElementById('canvasNameDisplay');
        // 初始显示为“未命名”
        this.updateCanvasName('未命名');

        // DOM 元素引用
        this.menuBtn = document.getElementById('fileMenuBtn');
        this.dropdown = document.getElementById('fileMenuDropdown');
        this.openSaveBtn = document.getElementById('openSaveBtn');
        this.saveProjectBtn = document.getElementById('saveProjectBtn');
        this.saveAsBtn = document.getElementById('saveAsBtn');

        // 子组件：序列化器（数据层）与模态框（UI 层）
        this.serializer = new ProjectSerializer(canvas);
        this.modal = new SaveModal(this);

        // 绑定事件
        this.bindEvents();

        // 新建画布管理器：逻辑独立成组件，共享本实例的状态与方法
        // （在 bindEvents 之后创建，确保 hideMenu 等方法可用）
        this.newCanvasManager = new NewCanvasManager(this);
    }

    /**
     * 绑定文件菜单相关事件
     */
    bindEvents() {
        // 点击汉堡按钮切换下拉菜单显示
        this.menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleMenu();
        });

        // 点击页面其他地方关闭菜单
        document.addEventListener('click', () => {
            this.hideMenu();
        });

        // 点击菜单项
        this.openSaveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.hideMenu();
            this.modal.showOpenModal();
        });

        this.saveProjectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.hideMenu();
            this.saveProject();
        });

        this.saveAsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.hideMenu();
            this.modal.showSaveAsModal();
        });

        // 帮助：新标签页打开使用教程（help.html，静态服务直出）
        this.helpBtn = document.getElementById('helpBtn');
        this.helpBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.hideMenu();
            window.open('/help.html', '_blank');
        });
    }

    /**
     * 切换下拉菜单显示状态
     */
    toggleMenu() {
        this.dropdown.classList.toggle('show');
    }

    /**
     * 隐藏下拉菜单
     */
    hideMenu() {
        this.dropdown.classList.remove('show');
    }

    // ==================== 当前画布名称 ====================

    /**
     * 更新左上角显示的画布名称
     * @param {string} name - 画布/存档名称
     */
    updateCanvasName(name) {
        if (this.canvasNameDisplay) {
            const displayName = name || '未命名';
            this.canvasNameDisplay.textContent = displayName;
            this.canvasNameDisplay.title = displayName;
        }
    }

    // ==================== 保存/读取（HTTP 编排） ====================

    /**
     * 从后端读取指定存档并恢复画布
     * @param {string} name - 存档名称
     */
    async loadFromServer(name) {
        const response = await fetch(`/api/saves/${encodeURIComponent(name)}`);
        const result = await response.json();

        if (result.status !== 'ok') {
            throw new Error(result.message || '读取失败');
        }

        await this.serializer.restoreProject(result.data);

        // 记住当前存档，之后“保存画布”将覆盖存回这里
        this.currentSave = name;
        this.updateCanvasName(name);
    }

    /**
     * 检查 save/ 目录下是否已存在指定名称的存档
     * @param {string} name - 存档名称
     * @returns {Promise<boolean>} 是否存在
     */
    async saveExists(name) {
        const response = await fetch('/api/saves');
        const result = await response.json();
        if (result.status !== 'ok') {
            throw new Error(result.message || '获取存档列表失败');
        }
        return result.saves.some(s => s.name === name);
    }

    /**
     * 保存画布：
     * - 打开/另存为过存档 → 覆盖存回原存档（后端分批上传）；
     * - 尚未有当前存档 → 进入"另存为"流程
     */
    async saveProject() {
        if (!this.currentSave) {
            return this.modal.showSaveAsModal();
        }
        // 失败时进度弹窗已展示错误信息，无需再处理
        await this.saveProjectInternal();
    }

    /**
     * 保存画布核心流程（供 saveProject 与 NewCanvasManager"保存并新建"共用）：
     * 有当前存档时覆盖保存，无当前存档时先弹出另存为获取名称。
     * @throws {Error} 用户取消另存为或保存失败时抛出
     */
    async saveProjectInternal() {
        let name = this.currentSave;
        let overwrite = true;

        // 无当前存档：弹出另存为获取名称（用户取消则中止）
        if (!name) {
            name = await this.modal.promptSaveAsName();
            if (!name) throw new Error('canceled');
            overwrite = false;   // 新存档不覆盖，后端重名时自动追加序号
        }

        const progress = this.modal.showProgressModal(`正在保存到：save/${name}`);
        try {
            const result = await this.saveViaHttp(name, overwrite, (done, total) => {
                progress.update(`正在上传图片批次 ${done}/${total}...`);
            });
            this.currentSave = result.name;
            this.updateCanvasName(result.name);
            this.applySavedMappings(result);
            // currentSave 变更 + 图片 src 回写都不会自动触发 canvas.draw，
            // 主动 flush 实时保存，避免保存后立即刷新恢复到旧存档名或旧图片路径
            window.realtimeSave?.flush();
            progress.success(`已保存到：save/${result.name}`);
            setTimeout(() => progress.close(), 800);
        } catch (error) {
            progress.error(error.message);
            throw error;
        }
    }

    /**
     * 通过后端接口保存存档到 save/ 目录（三段式协议，元数据与图片解耦）：
     *   1. init     ：只发存档元数据（提示词/视口/连线/节点），返回保存会话 token；
     *   2. 批次     ：图片按体积分批上传（可 0 批——空画布/纯节点画布无图片）；
     *   3. finalize ：提交会话，后端写入 project.json 并返回实际存档名与文件映射。
     * 使用弹性模式收集图片：源文件存在时用相对路径（后端直接复制，零卡顿）；
     * 源文件被外部删除时从内存位图编码为 data URL，保证仍可保存。
     * @param {string} name - 存档名称
     * @param {boolean} overwrite - 同名时是否覆盖（false 则后端自动追加序号）
     * @param {Function} [onProgress] - 进度回调 (已完成批数, 总批数)
     * @returns {Promise<Object>} 保存结果（含实际存档名 name）
     */
    async saveViaHttp(name, overwrite, onProgress) {
        const images = await this.serializer.collectImagesForSave();

        // 按体积动态分批：data: URL 图片（新生成/缺失回退）为 base64，单张可达数 MB，
        // 固定张数分批可能超过后端 100MB 请求体限制，改为累加体积切分
        const chunks = [];
        let currentChunk = [];
        let currentSize = 0;
        for (const img of images) {
            const imgSize = (img.src ? img.src.length : 0) + 512; // base64 长度 + JSON 字段开销估算
            if (currentChunk.length > 0 && currentSize + imgSize > SaveManager.MAX_CHUNK_BYTES) {
                chunks.push(currentChunk);
                currentChunk = [];
                currentSize = 0;
            }
            currentChunk.push(img);
            currentSize += imgSize;
        }
        if (currentChunk.length > 0) chunks.push(currentChunk);

        const totalChunks = chunks.length;

        // 统一请求与防御性解析：服务端异常时可能返回非 JSON 内容
        const postSaves = async (payload) => {
            const response = await fetch('/api/saves', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const text = await response.text();
            let result;
            try {
                result = JSON.parse(text);
            } catch {
                throw new Error(`服务器返回异常响应（HTTP ${response.status}）`);
            }
            if (result.status !== 'ok') {
                throw new Error(result.message || '保存失败');
            }
            return result;
        };

        // 1. init：元数据单独请求，与图片是否为空无关
        const prompts = this.getPrompts();
        const init = await postSaves({
            name,
            overwrite,
            prompt: prompts.positive,
            prompt2: prompts.positive2,
            negativePrompt: prompts.negative,
            viewport: this.getViewport(),
            connections: this.getConnectionsData(),
            nodes: this.collectNodes()
        });
        const token = init.token;

        // 2. 图片批次（0 次或多次）
        for (let i = 0; i < totalChunks; i++) {
            await postSaves({ token, images: chunks[i] });
            if (onProgress) onProgress(i + 1, totalChunks);
        }

        // 3. finalize：提交保存
        return await postSaves({ token, finalize: true });
    }

    /**
     * 安全化存档名称，移除 Windows 非法字符
     * @param {string} name - 原始名称
     * @returns {string} 安全名称
     */
    sanitizeFolderName(name) {
        return name
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 100);
    }

    // ==================== 门面方法（委托 serializer/modal） ====================
    // 外部组件（NewCanvasManager 等）与本类内部统一走这些方法，
    // 拆分前的调用方式保持不变

    /** 获取提示词 -> 委托 ProjectSerializer */
    getPrompts() { return this.serializer.getPrompts(); }

    /** 设置提示词 -> 委托 ProjectSerializer */
    setPrompts(positive, negative) { this.serializer.setPrompts(positive, negative); }

    /** 获取视口状态 -> 委托 ProjectSerializer */
    getViewport() { return this.serializer.getViewport(); }

    /** 设置视口状态 -> 委托 ProjectSerializer */
    setViewport(viewport) { this.serializer.setViewport(viewport); }

    /** 收集连线数据 -> 委托 ProjectSerializer */
    getConnectionsData() { return this.serializer.getConnectionsData(); }

    /** 收集图片数据 -> 委托 ProjectSerializer */
    collectImages() { return this.serializer.collectImages(); }

    /** 收集节点数据 -> 委托 ProjectSerializer */
    collectNodes() { return this.serializer.collectNodes(); }

    /** 保存后回写文件名映射 -> 委托 ProjectSerializer */
    applySavedMappings(result) { this.serializer.applySavedMappings(result); }

    /** 恢复画布 -> 委托 ProjectSerializer */
    restoreProject(data) { return this.serializer.restoreProject(data); }

    /** 弹出另存为输入框（简化版） -> 委托 SaveModal */
    promptSaveAsName() { return this.modal.promptSaveAsName(); }

    /** 获取模态框遮罩层 -> 委托 SaveModal */
    ensureModalOverlay() { return this.modal.ensureModalOverlay(); }

    /** 关闭模态框 -> 委托 SaveModal */
    closeModal() { this.modal.closeModal(); }
}

// 分批保存时每批请求体的体积上限（50MB，远低于后端 100MB 限制，留出安全余量）
SaveManager.MAX_CHUNK_BYTES = 50 * 1024 * 1024;
