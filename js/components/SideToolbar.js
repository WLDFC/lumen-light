/**
 * ==========================================================================
 * LumenLight 左侧工具栏组件
 * 作用：在画布左侧提供一个垂直工具栏（60×200、圆角、深色背景），
 *       集中放置常用画布操作入口。当前包含：
 *       - 上传图片按钮：从本地选择图片文件并添加到画布中心
 * 扩展说明：后续新增工具图标时，在 buildToolbar() 中调用对应的
 *           createXxxButton() 方法追加按钮即可。
 * ==========================================================================
 */

// SideToolbar 类：封装左侧工具栏的 DOM 创建与事件绑定
class SideToolbar {
    /**
     * 构造函数：初始化 SideToolbar 实例
     * @param {Object} canvas - 画布主类实例，提供 images.add、draw 等方法
     */
    constructor(canvas) {
        this.canvas = canvas;   // 画布主类实例
        this.fileInput = null;  // 隐藏的文件选择框（懒创建）
        this.el = null;         // 工具栏根元素
        this.init();
    }

    /**
     * 初始化方法：创建工具栏 DOM 并挂载到页面
     */
    init() {
        this.buildToolbar();
    }

    /**
     * 构建工具栏：创建容器并依次追加各工具按钮
     */
    buildToolbar() {
        // 创建工具栏根容器（样式见 css/side-toolbar.css）
        this.el = document.createElement('div');
        this.el.className = 'side-toolbar';
        this.el.id = 'sideToolbar';

        // 第一个图标：从本地上传图片到画布
        this.el.appendChild(this.createUploadButton());

        // 挂载到页面
        document.body.appendChild(this.el);
    }

    /**
     * 创建"上传图片"按钮
     * 图标为上传箭头（托盘 + 向上箭头），白色线条风格，与项目现有 SVG 图标一致
     * @returns {HTMLButtonElement} 按钮元素
     */
    createUploadButton() {
        const btn = document.createElement('button');
        btn.className = 'side-toolbar-btn';
        btn.id = 'sideUploadBtn';
        btn.type = 'button';
        btn.title = '本地上传';

        // 上传箭头图标（feather 风格：无填充、白色描边、圆角线帽）
        btn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
        `;

        // 点击打开本地文件选择框
        btn.addEventListener('click', () => this.openFileDialog());
        return btn;
    }

    /**
     * 打开本地文件选择框（支持多选图片）
     */
    openFileDialog() {
        // 懒创建隐藏的 file input，避免页面加载时多余 DOM
        if (!this.fileInput) {
            this.fileInput = document.createElement('input');
            this.fileInput.type = 'file';
            this.fileInput.accept = 'image/*,video/*,audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac'; // 图片/视频/音频均可
            this.fileInput.multiple = true; // 支持一次选择多个文件
            this.fileInput.style.display = 'none';

            // 选择完成后处理文件并重置 input（否则选同一文件不触发 change）
            this.fileInput.addEventListener('change', (e) => {
                this.handleFiles(e.target.files);
                this.fileInput.value = '';
            });

            document.body.appendChild(this.fileInput);
        }

        this.fileInput.click();
    }

    /**
     * 处理选中的文件：图片添加到画布中心，视频经共享入口上传后落画布，
     * 多个文件错开排列避免重叠
     * @param {FileList} files - 用户选中的文件列表
     */
    async handleFiles(files) {
        const c = this.canvas;
        const all = Array.from(files);
        const images = all.filter(f => f.type.startsWith('image/'));
        const videos = all.filter(f => CanvasVideoManager.isVideoFile(f));
        // 音频统一走 AudioIngest（与聊天上传按钮同一出口：上传 data/audio/
        // 后落音频卡片，批量自动级联错开并统一提示）
        const audios = all.filter(f => window.AudioIngest?.isAudioFile(f));
        if (images.length === 0 && videos.length === 0 && audios.length === 0) return;

        // 计算画布中心（视口坐标）
        const canvasRect = c.canvas.getBoundingClientRect();
        const centerX = canvasRect.width / 2;
        const centerY = canvasRect.height / 2;

        // 顺序处理每个文件，添加偏移避免多文件重叠
        let index = 0;
        for (const file of images) {
            const offset = index * 30;
            index++;
            try {
                await c.images.add(file, centerX + offset, centerY + offset, c.viewport, 0);
            } catch (err) {
                console.error(`❌ 上传图片失败:`, err);
            }
        }
        for (const file of videos) {
            const offset = index * 30;
            index++;
            try {
                // 视口坐标（含错开偏移）→ 画布世界坐标，落点跟随当前视图
                const p = c.viewport.screenToCanvas(centerX + offset, centerY + offset);
                await c.videoManager.addVideoFile(file, {
                    centerX: p.x,
                    centerY: p.y
                });
            } catch (err) {
                console.error(`❌ 上传视频失败:`, err);
            }
        }
        // 音频文件：统一出口（AudioIngest）上传落卡，自带级联与提示
        await window.AudioIngest?.ingestFiles(audios);

        // 触发画布重绘，显示新内容
        c.draw();
    }
}

// 将 SideToolbar 类导出到全局作用域，便于 app.js 使用
window.SideToolbar = SideToolbar;
