/**
 * ==========================================================================
 * LumenLight 画布视频管理器（CanvasVideoManager）
 * ==========================================================================
 * 作用：统一管理画布上视频对象的完整生命周期：
 *   1. addVideo()      - 从视频路径创建画布视频对象（提取首帧封面）
 *   2. showPlayer()    - 双击视频时弹出就地定位的原生控件播放器
 *   3. hidePlayer()    - 关闭播放器（暂停 + 移除 DOM）
 *   4. syncPlayer()    - 每次 draw 时同步播放器位置（跟随视口平移/缩放）
 *   5. dispose()       - 销毁视频对象时清理资源
 *
 * 设计要点：
 *   - 画布上视频以首帧封面 + 播放图标展示（静态，不消耗 CPU）
 *   - 双击打开 DOM <video controls> 播放器覆盖层：原生播放/暂停/进度条/
 *     音量/全屏控件，与 LLM 聊天窗口的视频体验一致
 *   - 播放器跟随视口平移/缩放（每次 draw 时同步 CSS 位置）
 *   - ESC 或点击播放器外部关闭
 * ==========================================================================
 */

class CanvasVideoManager {
    /**
     * @param {Canvas} canvas - 画布主类实例
     */
    constructor(canvas) {
        this.canvas = canvas;
        // 当前打开的播放器状态 { imageObj, wrapEl, videoEl }
        this._player = null;

        // ESC 关闭播放器
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this._player) this.hidePlayer();
        });

        // 点击播放器外部关闭（监听画布 mousedown）
        canvas.canvas.addEventListener('mousedown', (e) => {
            if (this._player && !this._player.wrapEl.contains(e.target)) {
                this.hidePlayer();
            }
        });
    }

    /**
     * 将视频添加到画布（提取首帧作为封面 + 记录 videoUrl）
     * @param {string} videoUrl - 视频的可访问 URL（如 /data/videos/xxx.mp4）
     * @param {Object} [options] - 可选参数
     * @param {string} [options.prompt] - 关联的提示词
     * @param {string} [options.name] - 文件名
     * @param {number} [options.x] - 画布 X 坐标（默认居中）
     * @param {number} [options.y] - 画布 Y 坐标（默认居中）
     * @returns {Promise<Object>} 添加成功的画布对象
     */
    addVideo(videoUrl, options = {}) {
        return new Promise((resolve, reject) => {
            const probeEl = document.createElement('video');
            probeEl.src = videoUrl;
            probeEl.muted = true;
            probeEl.preload = 'auto';

            // 加载兜底超时：loadeddata/error 都不触发时（后台标签节流、
            // 编解码异常等）明确失败并提示，不再静默挂起（曾致"视频
            // 既不上画布也无任何报错"的排查困局）
            const failTimer = setTimeout(
                () => reject(new Error('视频加载超时（15s 无响应）: ' + videoUrl)),
                15000
            );

            probeEl.addEventListener('loadeddata', () => {
                clearTimeout(failTimer);
                try {
                    // 从首帧提取封面图（画布上静态显示）
                    const coverCanvas = document.createElement('canvas');
                    coverCanvas.width = probeEl.videoWidth;
                    coverCanvas.height = probeEl.videoHeight;
                    coverCanvas.getContext('2d').drawImage(probeEl, 0, 0);

                    const coverImg = new Image();
                    coverImg.onload = () => {
                        coverImg.onload = null;
                        probeEl.src = ''; // 释放探测元素

                        // 计算放置位置（默认画布中心）
                        const pos = this._computePosition(coverImg.width, coverImg.height, options);

                        const imageObj = this.canvas.images.addImage({
                            img: coverImg,
                            x: pos.x,
                            y: pos.y,
                            width: pos.width,
                            height: pos.height,
                            source: 'video',
                            name: options.name || videoUrl.split('/').pop(),
                            prompt: options.prompt || '',
                            videoUrl
                        });

                        this.canvas.draw();
                        resolve(imageObj);
                    };
                    coverImg.onerror = () => reject(new Error('视频封面图创建失败'));
                    coverImg.src = coverCanvas.toDataURL('image/png');
                } catch (err) {
                    reject(err);
                }
            }, { once: true });

            probeEl.addEventListener('error', () => {
                clearTimeout(failTimer);
                reject(new Error('视频加载失败: ' + videoUrl));
            }, { once: true });

            probeEl.load();
        });
    }

    /**
     * 从存档数据恢复视频对象（封面图已随存档恢复，只需记录 videoUrl）
     * @param {Object} imageObj - 画布对象（已由 ProjectSerializer 恢复）
     * @param {string} videoUrl - 视频 URL
     */
    restoreVideoElement(imageObj, videoUrl) {
        imageObj.videoUrl = videoUrl;
    }

    /**
     * 打开就地播放器：在视频对象的画布位置弹出带原生控件的 <video> 播放器
     * （播放/暂停/进度条/音量/全屏，与 LLM 窗口体验一致）
     * @param {Object} imageObj - 画布视频对象
     */
    showPlayer(imageObj) {
        if (!imageObj || !imageObj.videoUrl) return;

        // 已有播放器打开时先关闭（同一时间只允许一个播放器）
        if (this._player) this.hidePlayer();

        // 创建播放器容器
        const wrap = document.createElement('div');
        wrap.className = 'canvas-video-player';

        const video = document.createElement('video');
        video.src = imageObj.videoUrl;
        video.controls = true;
        video.loop = true;
        video.playsInline = true;
        video.autoplay = true;
        wrap.appendChild(video);

        // 关闭按钮（右上角 ×）
        const closeBtn = document.createElement('button');
        closeBtn.className = 'canvas-video-player-close';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.hidePlayer();
        });
        wrap.appendChild(closeBtn);

        // 挂载到 body（position: fixed，直接以视口坐标定位）
        document.body.appendChild(wrap);

        this._player = { imageObj, wrapEl: wrap, videoEl: video };
        this.syncPlayer();

        // 自动播放（muted 保证浏览器允许自动播放）
        video.muted = true;
        video.play().catch(() => {});
    }

    /**
     * 关闭播放器（暂停 + 移除 DOM）
     */
    hidePlayer() {
        if (!this._player) return;
        this._player.videoEl.pause();
        this._player.videoEl.src = '';
        this._player.wrapEl.remove();
        this._player = null;
        this.canvas.draw();
    }

    /**
     * 同步播放器位置到视频对象的当前屏幕坐标（每次 draw 时调用）
     * 播放器跟随视口平移/缩放，视觉上"贴"在画布视频对象上
     */
    syncPlayer() {
        if (!this._player) return;
        const { imageObj, wrapEl } = this._player;
        const vp = this.canvas.viewport;

        // 画布世界坐标 → 屏幕坐标（相对于画布容器）
        const screenX = imageObj.x * vp.scale + vp.offsetX;
        const screenY = imageObj.y * vp.scale + vp.offsetY;
        const screenW = imageObj.width * vp.scale;
        const screenH = imageObj.height * vp.scale;

        wrapEl.style.left = `${screenX}px`;
        wrapEl.style.top = `${screenY}px`;
        wrapEl.style.width = `${screenW}px`;
        wrapEl.style.height = `${screenH}px`;
    }

    /**
     * 判断播放器是否打开
     * @returns {boolean}
     */
    isPlayerOpen() {
        return !!this._player;
    }

    /**
     * 销毁视频对象时清理资源（若播放器正显示该视频则关闭）
     * @param {Object} imageObj - 画布视频对象
     */
    dispose(imageObj) {
        if (this._player && this._player.imageObj === imageObj) {
            this.hidePlayer();
        }
    }

    // ==================== 本地视频文件导入 ====================

    /**
     * 判断文件是否为视频：MIME 优先，扩展名兜底。
     * Windows 资源管理器拖入 .mkv/.mov 等文件时浏览器给出的
     * File.type 常为空字符串，仅按 MIME 判断会静默漏掉这些文件
     * @param {File} file - 待判断的文件
     * @returns {boolean}
     */
    static isVideoFile(file) {
        if (!file) return false;
        if ((file.type || '').startsWith('video/')) return true;
        return CanvasVideoManager.VIDEO_EXTS.test(file.name || '');
    }

    /**
     * 导入本地视频文件：上传到 data/videos/ 持久化，再落画布。
     * 拖放 / 系统剪贴板粘贴 / 左侧工具栏上传 共用的单一入口
     * @param {File} file - 视频文件
     * @param {Object} [options] - 透传给 addVideo 的参数（x/y/centerX/centerY 等）
     * @returns {Promise<Object>} 添加成功的画布对象
     */
    addVideoFile(file, options = {}) {
        return fetch(`/api/llm/upload-video?filename=${encodeURIComponent(file.name || 'video.mp4')}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file
        }).then(async (resp) => {
            const result = await resp.json().catch(() => null);
            if (!resp.ok || !result || result.status !== 'ok') {
                throw new Error((result && result.message) || `视频上传失败（HTTP ${resp.status}）`);
            }
            return this.addVideo('/' + result.videoPath, {
                ...options,
                name: options.name || file.name
            });
        });
    }

    // ==================== 内部方法 ====================

    /**
     * 计算视频在画布上的放置位置和尺寸
     * @private
     */
    _computePosition(naturalW, naturalH, options) {
        // 限制画布上视频对象的最大显示尺寸
        const maxDim = 800;
        const scale = Math.min(1, maxDim / Math.max(naturalW, naturalH));
        const width = Math.round(naturalW * scale);
        const height = Math.round(naturalH * scale);

        let x, y;
        if (options.x !== undefined && options.y !== undefined) {
            x = options.x;
            y = options.y;
        } else if (options.centerX !== undefined && options.centerY !== undefined) {
            // 中心点定位（生成占位图中心落视频用）：视频尺寸在封面
            // 加载后才确定，由本函数反推左上角
            x = options.centerX - width / 2;
            y = options.centerY - height / 2;
        } else {
            // 默认放置在画布视口中心
            const vp = this.canvas.viewport;
            const dpr = this.canvas.dpr || 1;
            const centerX = (-vp.offsetX + this.canvas.canvas.width / 2 / dpr) / vp.scale;
            const centerY = (-vp.offsetY + this.canvas.canvas.height / 2 / dpr) / vp.scale;
            x = centerX - width / 2;
            y = centerY - height / 2;
        }

        return { x, y, width, height };
    }
}

// 将 CanvasVideoManager 暴露到全局作用域
window.CanvasVideoManager = CanvasVideoManager;

// 视频扩展名白名单（MIME 缺失时按扩展名兜底判断，见 isVideoFile）
CanvasVideoManager.VIDEO_EXTS = /\.(mp4|webm|mov|mkv|avi|gif)$/i;
