/**
 * ==========================================================================
 * LumenLight 音频上传入口（AudioIngest）
 * ==========================================================================
 * 职责单一：把本地音频文件送进画布——上传 data/audio/ 持久化，再经
 * CanvasAudioManager 以音频卡片落画布。供聊天窗口上传按钮等画布外
 * 入口调用（画布拖放/粘贴走 CanvasClipboard → CanvasAudioManager，
 * 本模块不与之耦合）。
 *
 * 零依赖：只用浏览器原生能力 + 既有后端路由 /api/audios。
 * ==========================================================================
 */

const AudioIngest = {
    /** 音频扩展名白名单（与 routes/audios.js、CanvasAudioManager 同一清单） */
    AUDIO_EXTS: /\.(mp3|wav|ogg|m4a|flac|aac|opus|weba)$/i,

    /**
     * 判断文件是否为音频：MIME 优先，扩展名兜底
     *（Windows 文件选择器/拖出的文件 MIME 可能为空）
     * @param {File} file - 待判断的文件
     * @returns {boolean}
     */
    isAudioFile(file) {
        if (!file) return false;
        if ((file.type || '').startsWith('audio/')) return true;
        return AudioIngest.AUDIO_EXTS.test(file.name || '');
    },

    /**
     * 上传单个音频文件并落画布（视口中心落卡，可带级联序号）
     * @param {File} file - 音频文件
     * @param {number} [index] - 批量时的级联序号（每档偏移 40px 防重叠）
     * @returns {Promise<Object>} 落画布成功的音频对象
     */
    async ingestFile(file, index = 0) {
        const canvas = window.canvas;
        if (!canvas?.audioManager) {
            throw new Error('画布未初始化，无法添加音频');
        }
        // 级联序号 > 0 时按视口中心 + 每档 40px 错开（与画布粘贴的错开
        // 语义一致），多文件批量不叠在一起
        let opts;
        if (index > 0) {
            const p = canvas.viewport.screenToCanvas(
                canvas.cssWidth / 2 + index * 40,
                canvas.cssHeight / 2 + index * 40);
            opts = { centerX: p.x, centerY: p.y };
        }
        return canvas.audioManager.addAudioFile(file, opts);
    },

    /**
     * 批量顺序处理音频文件（逐个落卡、自动错开），结束后统一提示
     * @param {File[]} files - 音频文件数组
     * @returns {Promise<{ok: number, fail: number}>} 成功/失败计数
     */
    async ingestFiles(files) {
        let ok = 0, fail = 0;
        for (let i = 0; i < files.length; i++) {
            try {
                await AudioIngest.ingestFile(files[i], i);
                ok++;
            } catch (err) {
                console.error('音频上传落画布失败:', files[i].name, err);
                fail++;
            }
        }
        if (ok + fail > 0) {
            const msg = fail === 0
                ? `已添加 ${ok} 个音频到画布`
                : `已添加 ${ok} 个音频，${fail} 个失败`;
            window.socket?.showNotification?.(msg, 4000);
        }
        return { ok, fail };
    }
};

// 导出为全局变量，供其他模块使用
window.AudioIngest = AudioIngest;
