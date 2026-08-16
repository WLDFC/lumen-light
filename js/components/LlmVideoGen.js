/**
 * ==========================================================================
 * LumenLight 视频生成控制器（LlmVideoGen）
 * ==========================================================================
 * 作用：处理 LLM 聊天窗口中视频生成的完整流程：
 *   1. 提交生成任务（文生视频 / 图生视频）
 *   2. 轮询任务状态并更新进度 UI
 *   3. 任务完成后渲染视频播放器（带控件）
 *   4. 支持将视频拖拽到画布（首帧静态图 + 点击播放）
 *
 * 设计要点：
 *   - 从 LlmChat 中解耦：LlmChat 只负责判断模型类型后委托本模块执行，
 *     不污染聊天/生图的现有链路
 *   - 轮询间隔自适应：前 10 秒每 3 秒一次（快速响应），之后每 5 秒一次
 *   - 超时保护：5 分钟未完成自动终止轮询并报错
 * ==========================================================================
 */

class LlmVideoGen {
    /** 轮询配置 */
    static POLL_INTERVAL_FAST = 3000;   // 前 10 秒：每 3 秒轮询
    static POLL_INTERVAL_SLOW = 5000;   // 10 秒后：每 5 秒轮询
    static POLL_FAST_DURATION = 10000;  // 快速轮询持续时间
    static POLL_TIMEOUT = 300000;       // 总超时：5 分钟

    /**
     * @param {LlmChat} chat - LlmChat 实例引用（复用其 DOM 和辅助方法）
     */
    constructor(chat) {
        this.chat = chat;
        // 活跃的轮询定时器集合（用于清空对话时终止所有进行中的任务）
        this._activePolls = new Set();
    }

    /**
     * 判断给定模型 ID 是否为视频生成模型
     * 优先使用设置中的 type='video' 标记，其次按名称关键词自动识别
     * @param {string} modelId - 模型 ID（可能是"厂商||模型ID"复合键）
     * @returns {boolean}
     */
    isVideoModel(modelId) {
        if (!modelId) return false;

        // 1. 手动标记优先
        const marked = (this.chat.modelsConfig || [])
            .find((m) => m && (m.key === modelId || m.id === modelId));
        if (marked) {
            if (marked.type === 'video') return true;
            if (marked.type === 'image' || marked.type === 'chat') return false;
        }

        // 2. 自动识别：按模型名称关键词
        const keywords = ['seedance', 'video', 'i2v', 't2v', 'kling', 'runway', 'pika', 'minimax'];
        const lower = LumenLight.parseModelKey(modelId).id.toLowerCase();
        return keywords.some((k) => lower.includes(k));
    }

    /**
     * 执行视频生成流程（由 LlmChat.send() 在检测到视频模型时调用）
     * @param {string} prompt - 视频描述文本
     * @param {string} model - 模型复合键（"厂商||模型ID"）
     * @param {string[]} images - 附件图片列表（图生视频时取第一张作为首帧）
     */
    async generate(prompt, model, images = []) {
        const chat = this.chat;
        const imageUrl = images.length > 0 ? images[0] : null;
        const isI2V = !!imageUrl;

        // 清空输入区
        chat.inputEl.value = '';
        chat.attachments.clear();

        // 渲染用户消息
        chat.appendMessage('user', prompt || '（图片）', images, { rawPrompt: prompt });

        // 渲染进度气泡
        const modeText = isI2V ? '图生视频' : '文生视频';
        const thinkingEl = chat.appendMessage('assistant', `🎬 正在提交${modeText}任务…`);
        thinkingEl.parentElement.classList.add('thinking');

        // 锁定发送状态
        chat.isSending = true;
        if (chat.sendBtn) {
            chat.sendBtn.disabled = true;
            chat.sendBtn.textContent = '生成中…';
        }

        try {
            const selection = LumenLight.parseModelKey(model);

            // 1. 提交任务
            const submitResp = await fetch('/api/llm/submit-video', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: selection.id,
                    provider: selection.provider,
                    prompt: prompt || '',
                    imageUrl
                })
            });
            const submitResult = await submitResp.json();

            if (!submitResp.ok || submitResult.status !== 'ok') {
                throw new Error(submitResult.message || '提交视频任务失败');
            }

            const taskId = submitResult.taskId;
            thinkingEl.textContent = `🎬 任务已提交，等待生成…（ID: ${taskId.slice(-8)}）`;

            // 2. 轮询任务状态
            const videoPath = await this._pollTask(taskId, selection, thinkingEl);

            // 3. 渲染视频播放器
            thinkingEl.parentElement.classList.remove('thinking');
            const videoBlock = this._buildVideoBlock(videoPath, prompt);
            thinkingEl.parentElement.replaceWith(videoBlock);

        } catch (error) {
            thinkingEl.parentElement.classList.remove('thinking');
            thinkingEl.textContent = '❌ ' + error.message;
            thinkingEl.parentElement.classList.add('error');
            console.error('视频生成失败:', error);
        } finally {
            chat.isSending = false;
            if (chat.sendBtn) {
                chat.sendBtn.disabled = false;
                chat.updateToolbarForModel();
            }
            chat.scrollToBottom();
        }
    }

    /**
     * 轮询视频任务状态直到完成或超时
     * @private
     */
    _pollTask(taskId, selection, progressEl) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            let pollCount = 0;

            const poll = async () => {
                // 超时保护
                if (Date.now() - startTime > LlmVideoGen.POLL_TIMEOUT) {
                    this._activePolls.delete(timer);
                    reject(new Error('视频生成超时（5分钟），请稍后在任务列表中查看'));
                    return;
                }

                pollCount++;
                try {
                    const params = new URLSearchParams({
                        model: selection.id,
                        provider: selection.provider || ''
                    });
                    const resp = await fetch(`/api/llm/video-task/${encodeURIComponent(taskId)}?${params}`);
                    const result = await resp.json();

                    if (!resp.ok || result.status !== 'ok') {
                        this._activePolls.delete(timer);
                        reject(new Error(result.message || '查询任务状态失败'));
                        return;
                    }

                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

                    switch (result.taskStatus) {
                        case 'succeeded':
                            this._activePolls.delete(timer);
                            resolve(result.videoPath);
                            return;

                        case 'failed':
                        case 'cancelled':
                        case 'expired':
                            this._activePolls.delete(timer);
                            reject(new Error(result.error || `视频生成失败（状态: ${result.taskStatus}）`));
                            return;

                        default:
                            // queued / running：更新进度文案
                            const statusText = result.taskStatus === 'running' ? '生成中' : '排队中';
                            progressEl.textContent = `🎬 视频${statusText}…（已等待 ${elapsed}s）`;
                            break;
                    }
                } catch (err) {
                    // 网络波动不立即终止，下次轮询重试
                    console.warn('视频任务轮询网络错误（将重试）:', err.message);
                }

                // 自适应间隔：前 10 秒快速轮询，之后放慢
                const interval = (Date.now() - startTime < LlmVideoGen.POLL_FAST_DURATION)
                    ? LlmVideoGen.POLL_INTERVAL_FAST
                    : LlmVideoGen.POLL_INTERVAL_SLOW;
                timer = setTimeout(poll, interval);
            };

            let timer = setTimeout(poll, LlmVideoGen.POLL_INTERVAL_FAST);
            this._activePolls.add(timer);
        });
    }

    /**
     * 导入本地视频文件到聊天窗口：上传到 data/videos/ 持久化后，
     * 以与生成视频相同的视频块（播放器 + 添加到画布按钮）渲染成一条
     * 用户消息。聊天上传按钮的视频分支走此入口
     * @param {File} file - 本地视频文件
     */
    async importLocalVideo(file) {
        const chat = this.chat;
        const statusEl = chat.appendMessage('user', `🎬 正在导入视频：${file.name}`);
        try {
            const resp = await fetch(`/api/llm/upload-video?filename=${encodeURIComponent(file.name || 'video.mp4')}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: file
            });
            const result = await resp.json().catch(() => null);
            if (!resp.ok || !result || result.status !== 'ok') {
                throw new Error((result && result.message) || `视频上传失败（HTTP ${resp.status}）`);
            }

            // 复用生成视频的视频块（播放器 + 添加到画布/下载按钮）
            const videoBlock = this._buildVideoBlock(result.videoPath, '');
            statusEl.parentElement.replaceWith(videoBlock);
            chat.scrollToBottom();
        } catch (error) {
            statusEl.textContent = '❌ ' + error.message;
            statusEl.parentElement.classList.add('error');
            console.error('导入本地视频失败:', error);
            chat.scrollToBottom();
        }
    }

    /**
     * 构造视频播放器的完整展示块（视频 + 操作栏）
     * @private
     */
    _buildVideoBlock(videoPath, prompt) {
        const block = document.createElement('div');
        block.className = 'llm-gen-block llm-video-block';

        // 视频播放器
        const videoWrap = document.createElement('div');
        videoWrap.className = 'llm-msg-video-wrap';

        const video = document.createElement('video');
        video.className = 'llm-msg-video';
        video.src = '/' + videoPath;
        video.controls = true;
        video.loop = true;
        video.playsInline = true;
        video.preload = 'metadata';
        videoWrap.appendChild(video);

        // 拖拽到画布按钮（视频无法像图片一样直接拖拽，用按钮触发）
        const dragBtn = document.createElement('button');
        dragBtn.type = 'button';
        dragBtn.className = 'llm-video-to-canvas-btn';
        dragBtn.title = '添加到画布';
        dragBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                <line x1="12" y1="8" x2="12" y2="16"/>
                <line x1="8" y1="12" x2="16" y2="12"/>
            </svg>
        `;
        dragBtn.addEventListener('click', () => this._addVideoToCanvas(videoPath, prompt));
        videoWrap.appendChild(dragBtn);

        block.appendChild(videoWrap);

        // 底部操作栏
        const actions = document.createElement('div');
        actions.className = 'llm-gen-actions';

        const downloadBtn = document.createElement('button');
        downloadBtn.type = 'button';
        downloadBtn.className = 'llm-gen-btn';
        downloadBtn.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span>下载视频</span>
        `;
        downloadBtn.addEventListener('click', () => {
            const a = document.createElement('a');
            a.href = '/' + videoPath;
            a.download = videoPath.split('/').pop();
            a.click();
        });
        actions.appendChild(downloadBtn);

        block.appendChild(actions);
        return block;
    }

    /**
     * 将视频添加到画布（委托给 CanvasVideoManager 统一管理）
     * @private
     */
    _addVideoToCanvas(videoPath, prompt) {
        const videoUrl = '/' + videoPath;
        window.canvas.videoManager.addVideo(videoUrl, {
            prompt: prompt || '',
            name: videoPath.split('/').pop()
        }).catch(err => {
            console.error('添加视频到画布失败:', err);
        });
    }

    /**
     * 终止所有活跃的轮询任务（清空对话时调用）
     */
    cancelAll() {
        this._activePolls.forEach((timer) => clearTimeout(timer));
        this._activePolls.clear();
    }
}

// 将 LlmVideoGen 类暴露到全局作用域
window.LlmVideoGen = LlmVideoGen;
