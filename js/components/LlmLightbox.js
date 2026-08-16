/**
 * ==========================================================================
 * LumenLight 图片/视频灯箱组件
 * 作用：点击 LLM 聊天窗口中的生成图片后，以全屏方式查看大图；
 *       本地资产库双击图片/视频时同样打开灯箱预览（视频带原生控件）。
 *       点击遮罩层或按 ESC 键关闭。
 *       本组件从 LlmChat 中拆分出来，避免聊天主类继续膨胀。
 * ==========================================================================
 */

class LlmLightbox {
    /**
     * 构造函数
     */
    constructor() {
        this.lightboxEl = document.getElementById('llmImageLightbox');
        this.lightboxImgEl = document.getElementById('llmLightboxImg');
        this.lightboxVideoEl = document.getElementById('llmLightboxVideo');
        this.init();
    }

    /**
     * 初始化：点击遮罩关闭、阻止媒体点击冒泡、ESC 键关闭
     */
    init() {
        if (!this.lightboxEl || !this.lightboxImgEl) return;

        // 点击遮罩层任意位置关闭灯箱
        this.lightboxEl.addEventListener('click', () => this.close());

        // 阻止媒体点击事件冒泡，避免点击大图/视频时误关闭
        // （视频的原生控件点击也必须拦截，否则点播放按钮就关灯箱）
        this.lightboxImgEl.addEventListener('click', (e) => e.stopPropagation());
        this.lightboxVideoEl?.addEventListener('click', (e) => e.stopPropagation());

        // ESC 键关闭灯箱
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.lightboxEl.classList.contains('active')) {
                this.close();
            }
        });
    }

    /**
     * 打开灯箱，显示指定媒体的大图/视频预览
     * @param {string} src - 图片地址（base64 / blob URL / http URL）
     * @param {Object} [opts] - 可选参数
     * @param {boolean} [opts.video] - 以视频模式打开（src 为视频地址）
     */
    open(src, opts = {}) {
        if (!this.lightboxEl || !this.lightboxImgEl || !src) return;

        const isVideo = !!opts.video && !!this.lightboxVideoEl;
        if (isVideo) {
            this.lightboxImgEl.style.display = 'none';
            this.lightboxVideoEl.style.display = 'block';
            this.lightboxVideoEl.src = src;
        } else {
            this._hideVideo();
            this.lightboxImgEl.src = src;
        }
        this.lightboxEl.classList.add('active');
    }

    /**
     * 关闭灯箱（视频模式下先暂停并释放地址）
     */
    close() {
        if (!this.lightboxEl) return;
        this._hideVideo();
        this.lightboxEl.classList.remove('active');
        if (this.lightboxImgEl) this.lightboxImgEl.src = '';
    }

    /** 隐藏视频元素并停止播放 */
    _hideVideo() {
        if (!this.lightboxVideoEl) return;
        this.lightboxVideoEl.pause?.();
        this.lightboxVideoEl.removeAttribute('src');
        this.lightboxVideoEl.style.display = 'none';
        this.lightboxImgEl.style.display = '';
    }
}

// 将 LlmLightbox 类暴露到全局作用域
window.LlmLightbox = LlmLightbox;
