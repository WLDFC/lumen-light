/**
 * ==========================================================================
 * LumenLight 画布音频管理器（CanvasAudioManager）
 * ==========================================================================
 * 作用：画布音频对象的生命周期管理，链路形态与 CanvasVideoManager 同构：
 *   1. isAudioFile()   - 判断拖入/粘贴文件是否为音频（MIME 优先 + 扩展名兜底）
 *   2. addAudio()      - 从音频路径创建画布音频卡片对象（探测时长、自绘卡片）
 *   3. addAudioFile()  - 本地音频文件导入单一入口（上传 data/audio/ 后落画布）
 *   4. showPlayer()    - 单击音频卡片弹出就地定位的原生控件播放器
 *   5. syncPlayer()    - 每次 draw 时同步播放器位置（跟随视口平移/缩放）
 *   6. dispose()       - 销毁音频对象时清理播放器
 *
 * 设计要点：
 *   - 音频没有画面，画布上以自绘「音频卡片」表示（圆角深色卡 + 播放图标
 *     + 文件名 + 时长），卡片位图存入对象的 img——渲染器走图片通用绘制
 *     路径，零渲染器改动；选中/拖动/缩放/删除/连线命中复用图片交互
 *   - 播放器为 DOM <audio controls> 覆盖层（原生播放/进度/音量），ESC 或
 *     暂停态点击外部关闭；播放中点击外部不打断、播到结束（与视频播放器
 *     的「点击外部即关」不同，音频打断成本感知更强）
 *   - 零新增依赖：时长探测与卡片绘制全部用浏览器原生能力
 * ==========================================================================
 */

class CanvasAudioManager {
    /** 音频扩展名白名单（与后端 routes/audios.js 同一清单） */
    static AUDIO_EXTS = /\.(mp3|wav|ogg|m4a|flac|aac|opus|weba)$/i;
    // 卡片尺寸（世界坐标）：内部元素按 420×DH 设计稿等比缩放绘制
    //（_drawCard 的 k 系数，DH=H/k 随 H 常量联动），调尺寸只改这两个值
    static CARD_WIDTH = 1280;
    static CARD_HEIGHT = 450;

    /**
     * @param {Canvas} canvas - 画布主类实例
     */
    constructor(canvas) {
        this.canvas = canvas;
        // 当前打开的播放器状态 { imageObj, wrapEl, audioEl }
        this._player = null;

        // ESC 关闭播放器
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this._player) this.hidePlayer();
        });

        // 点击播放器外部关闭（监听画布 mousedown）：仅暂停态收起——
        // 播放中不打断，让音乐播到结束；手动停止靠暂停键或 ESC
        canvas.canvas.addEventListener('mousedown', (e) => {
            if (this._player && !this._player.wrapEl.contains(e.target)
                && this._player.audioEl.paused) {
                this.hidePlayer();
            }
        });
    }

    /**
     * 判断文件是否为音频：MIME 优先，扩展名兜底。
     * Windows 资源管理器拖入文件时浏览器给出的 File.type 常为空字符串，
     * 仅按 MIME 判断会静默漏掉这些文件
     * @param {File} file - 待判断的文件
     * @returns {boolean}
     */
    static isAudioFile(file) {
        if (!file) return false;
        if ((file.type || '').startsWith('audio/')) return true;
        return CanvasAudioManager.AUDIO_EXTS.test(file.name || '');
    }

    /**
     * 将音频添加到画布（探测时长 + 自绘卡片 + 记录 audioUrl）
     * @param {string} audioUrl - 音频可访问 URL（如 /data/audio/xxx.mp3）
     * @param {Object} [options] - { name, prompt, x/y 或 centerX/centerY }
     * @returns {Promise<Object>} 添加成功的画布对象
     */
    addAudio(audioUrl, options = {}) {
        return new Promise((resolve, reject) => {
            const probeEl = document.createElement('audio');
            probeEl.src = audioUrl;
            probeEl.preload = 'metadata';

            // 加载兜底超时：元数据读不出时仍落卡片（时长显示 --:--），
            // 不静默挂起
            const failTimer = setTimeout(() => finish(null), 10000);

            const finish = (duration) => {
                clearTimeout(failTimer);
                try {
                    const pos = this._computePosition(options);
                    const name = options.name || audioUrl.split('/').pop();

                    // 卡片位图转 data URL 加载成 Image 再落画布（与视频封面
                    // 同一契约）：对象的 img 必须是带 src 的 Image——存档
                    // 序列化按 img.src 存资产，canvas 元素没有 src，直接
                    // 塞 canvas 会让自动保存存不出、F5 恢复 404 跳过整个
                    // 音频对象（曾致「存档图片加载失败：钢琴曲.mp3」）
                    const card = this._drawCard(name, duration);
                    const coverImg = new Image();
                    coverImg.onload = () => {
                        const imageObj = this.canvas.images.addImage({
                            img: coverImg,
                            x: pos.x,
                            y: pos.y,
                            width: pos.width,
                            height: pos.height,
                            source: 'audio',
                            name,
                            prompt: options.prompt || '',
                            audioUrl,
                            duration
                        });
                        this.canvas.draw();
                        resolve(imageObj);
                    };
                    coverImg.onerror = () => reject(new Error('音频卡片位图创建失败'));
                    coverImg.src = card.toDataURL('image/png');
                } catch (err) {
                    reject(err);
                }
            };

            probeEl.addEventListener('loadedmetadata', () => {
                finish(Number.isFinite(probeEl.duration) ? probeEl.duration : null);
            }, { once: true });
            probeEl.addEventListener('error', () => {
                finish(null);   // 元数据失败不阻断，卡片照落（时长未知）
            }, { once: true });
            probeEl.load();
        });
    }

    /**
     * 导入本地音频文件：上传到 data/audio/ 持久化，再落画布。
     * 拖放 / 系统剪贴板粘贴共用的单一入口
     * @param {File} file - 音频文件
     * @param {Object} [options] - 透传给 addAudio 的参数（x/y/centerX/centerY 等）
     * @returns {Promise<Object>} 添加成功的画布对象
     */
    addAudioFile(file, options = {}) {
        return fetch(`/api/audios?filename=${encodeURIComponent(file.name || 'audio.mp3')}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file
        }).then(async (resp) => {
            const result = await resp.json().catch(() => null);
            if (!resp.ok || !result || result.status !== 'ok') {
                throw new Error((result && result.message) || `音频上传失败（HTTP ${resp.status}）`);
            }
            return this.addAudio('/' + result.audioPath, {
                ...options,
                name: options.name || file.name
            });
        });
    }

    // ==================== 播放器覆盖层 ====================

    /**
     * 打开就地播放器：在音频卡片的画布位置弹出带原生控件的 <audio> 播放器。
     * 关闭语义：ESC 或暂停态点击外部收起；播放中点击外部/选中取消不打断，
     * 一轮播到结束（ended 后回到暂停态，再点外部即收起）
     * @param {Object} imageObj - 画布音频对象
     */
    showPlayer(imageObj) {
        if (!imageObj || !imageObj.audioUrl) return;

        // 同一张卡已有播放器时不动它——卡片是单击唤起，播放中再点卡片
        // 不能把播放器关掉重启（音乐从头再来）；换一张卡才走关闭重开
        if (this._player && this._player.imageObj === imageObj) return;

        // 已有别的播放器打开时先关闭（同一时间只允许一个播放器）
        if (this._player) this.hidePlayer();

        const wrap = document.createElement('div');
        wrap.className = 'canvas-video-player canvas-audio-player';

        const audio = document.createElement('audio');
        audio.src = imageObj.audioUrl;
        audio.controls = true;
        wrap.appendChild(audio);

        // 不设关闭按钮：ESC 或点击播放器外部即关闭（构造函数里的全局
        // 监听）——音频条较矮，右上角浮按钮容易误触
        // 挂载到 body（position: fixed，直接以视口坐标定位）
        document.body.appendChild(wrap);

        this._player = { imageObj, wrapEl: wrap, audioEl: audio };
        this.syncPlayer();
    }

    /**
     * 关闭播放器（暂停 + 移除 DOM）。调用方负责关闭时机：
     * 外部点击只在暂停态触发（见构造函数），播放中须先手动暂停或 ESC
     */
    hidePlayer() {
        if (!this._player) return;
        this._player.audioEl.pause();
        this._player.audioEl.src = '';
        this._player.wrapEl.remove();
        this._player = null;
        this.canvas.draw();
    }

    /**
     * 同步播放器位置到音频卡片的当前屏幕坐标（每次 draw 时调用），
     * 播放器跟随视口平移/缩放
     */
    syncPlayer() {
        if (!this._player) return;
        const { imageObj, wrapEl } = this._player;
        const vp = this.canvas.viewport;

        const screenX = imageObj.x * vp.scale + vp.offsetX;
        const screenY = imageObj.y * vp.scale + vp.offsetY;
        const screenW = imageObj.width * vp.scale;

        // 播放器按 420×54 设计稿整块 transform 缩放，视觉宽度始终跟随
        // 卡片屏幕宽（放大到 420px 封顶不再变大）——缩小时与卡片一起
        // 变小，不再出现「卡片缩成一点、浮层反而巨大」的观感；命中区
        // 随缩放同步缩小，精细操作放大视图即可
        const DESIGN_W = 420;
        const DESIGN_H = 54;
        const k = Math.min(1, screenW / DESIGN_W);
        const centerX = screenX + screenW / 2;

        // 紧贴卡片上缘、间隙随缩放等比（钳在 4–14px）——固定屏幕偏移
        // 在视图缩小时会让播放器看起来脱离卡片漂移
        const gap = Math.min(14, Math.max(4, 6 * vp.scale));

        wrapEl.style.width = `${DESIGN_W}px`;
        wrapEl.style.height = `${DESIGN_H}px`;
        wrapEl.style.left = `${centerX - DESIGN_W / 2}px`;
        wrapEl.style.top = `${screenY - DESIGN_H * k - gap}px`;
        wrapEl.style.transform = `scale(${k})`;
        wrapEl.style.transformOrigin = 'top center';
    }

    /**
     * 销毁音频对象时清理资源（若播放器正显示该音频则关闭）
     * @param {Object} imageObj - 画布音频对象
     */
    dispose(imageObj) {
        if (this._player && this._player.imageObj === imageObj) {
            this.hidePlayer();
        }
    }

    /**
     * 从存档数据恢复音频对象（记录 audioUrl；卡片位图由恢复方按需重绘）
     * @param {Object} imageObj - 画布对象（已由 ProjectSerializer 恢复）
     * @param {string} audioUrl - 音频 URL
     */
    restoreAudioElement(imageObj, audioUrl) {
        imageObj.audioUrl = audioUrl;
        // 旧存档元数据没有 duration 字段（该字段晚于音频功能首个版本）：
        // 探测一次元数据补齐并重绘卡片，避免恢复后永远显示「时长未知」
        if (imageObj.duration === undefined || imageObj.duration === null) {
            const probe = document.createElement('audio');
            probe.preload = 'metadata';
            probe.src = audioUrl;
            probe.addEventListener('loadedmetadata', () => {
                if (Number.isFinite(probe.duration)) {
                    imageObj.duration = probe.duration;
                    this.refreshCard(imageObj);
                }
            }, { once: true });
        }
    }

    /**
     * 按对象当前的 name/duration 重绘卡片位图并异步换上（存档恢复用）：
     * 历史版本的卡片位图是旧小尺寸绘制的，直接拉伸到新标准尺寸会糊，
     * 重绘才能保持 2x 超采样清晰度；位图就位后自动补一次重绘
     * @param {Object} imageObj - 画布音频对象
     */
    refreshCard(imageObj) {
        if (!imageObj) return;
        const card = this._drawCard(imageObj.name, imageObj.duration ?? null);
        const img = new Image();
        img.onload = () => {
            imageObj.img = img;
            this.canvas.draw();
        };
        img.src = card.toDataURL('image/png');
    }

    // ==================== 内部方法 ====================

    /**
     * 计算音频卡片在画布上的放置位置（与视频同一约定）：
     * x/y 直接指定 > centerX/centerY 反推 > 视口中心
     * @private
     */
    _computePosition(options) {
        const width = CanvasAudioManager.CARD_WIDTH;
        const height = CanvasAudioManager.CARD_HEIGHT;

        let x, y;
        if (options.x !== undefined && options.y !== undefined) {
            x = options.x;
            y = options.y;
        } else if (options.centerX !== undefined && options.centerY !== undefined) {
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

    /**
     * 自绘音频卡片位图（2x 分辨率绘制保证清晰度）：
     * 圆角深色卡 + 播放圆标 + 文件名 + 时长，配色取自配色美学色板
     * @param {string} name - 展示文件名
     * @param {number|null} duration - 时长秒数（null = 未知）
     * @returns {HTMLCanvasElement} 卡片位图（对象 img 字段，走图片通用渲染）
     * @private
     */
    _drawCard(name, duration) {
        const W = CanvasAudioManager.CARD_WIDTH;
        const H = CanvasAudioManager.CARD_HEIGHT;
        const S = 2;               // 2x 超采样
        const k = W / 420;         // 设计稿缩放系数（内部元素随卡片等比放大）
        const DH = H / k;          // 设计稿高（≈110，随 H 常量联动）
        const cv = document.createElement('canvas');
        cv.width = W * S;
        cv.height = H * S;
        const ctx = cv.getContext('2d');
        ctx.scale(S * k, S * k);

        // 以下全部使用 420×110 设计稿坐标（乘 k 后即实际世界坐标）
        // 卡片底：面板色 #1b1c21 + 通用边框（配色美学：凹陷层与边框层）
        ctx.beginPath();
        ctx.roundRect(1, 1, 420 - 2, DH - 2, 14);
        ctx.fillStyle = '#1b1c21';
        ctx.fill();
        ctx.strokeStyle = 'rgba(128, 128, 128, 0.3)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // 左侧播放圆标（白圆底 + 深色三角，与 gi-run 执行键同款语义）
        const cx = 56, cy = DH / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, 24, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(cx - 7, cy - 11);
        ctx.lineTo(cx + 13, cy);
        ctx.lineTo(cx - 7, cy + 11);
        ctx.closePath();
        ctx.fillStyle = '#0f0f12';
        ctx.fill();

        // 文件名（主文字）+ 时长（次要文字）
        ctx.fillStyle = '#ffffff';
        ctx.font = '600 19px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        let label = name || '音频';
        while (ctx.measureText(label).width > 420 - 130 && label.length > 1) {
            label = label.slice(0, -2) + '…';
        }
        ctx.fillText(label, 96, DH / 2 - 14);

        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.font = '15px system-ui, sans-serif';
        ctx.fillText(duration != null ? this._formatDuration(duration) : '时长未知', 96, DH / 2 + 14);

        return cv;
    }

    /** 秒数 → 'm:ss' 展示 */
    _formatDuration(sec) {
        const s = Math.round(sec);
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
}

// 将 CanvasAudioManager 暴露到全局作用域
window.CanvasAudioManager = CanvasAudioManager;
