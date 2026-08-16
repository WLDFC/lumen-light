/**
 * ==========================================================================
 * LumenLight 设置 - 抠图模型面板
 * 作用：渲染「抠图模型」分类，负责模型清单展示、下载（支持断点续传）、
 *       取消下载、删除模型文件，以及下载进度的定时轮询。
 * 数据来源：/api/rembg/models、/api/rembg/download 等后端接口。
 * 「当前使用的模型」保存在 localStorage，由 SettingsManager 的静态方法统一读写。
 * 由 SettingsManager 在构造时实例化并按分类调用 render()。
 * ==========================================================================
 */

class SettingsRembgPanel {
    /**
     * @param {SettingsManager} manager - 设置管理器实例（提供 contentEl、isOpen 等）
     */
    constructor(manager) {
        this.manager = manager;

        // 抠图模型清单（来自 /api/rembg/models）
        this.models = [];

        // 下载进度轮询定时器，切换分类或关闭界面时清除
        this.pollTimer = null;
    }

    /**
     * 渲染抠图模型管理内容
     * 首次进入先显示加载中，拉到清单后再渲染列表
     */
    render() {
        const contentEl = this.manager.contentEl;
        if (!contentEl) return;

        contentEl.innerHTML = `
            <div class="settings-form">
                <div class="settings-form-item">
                    <label for="settingsRembgActive">当前使用的模型</label>
                    <select class="settings-input" id="settingsRembgActive">
                        <option value="">加载中...</option>
                    </select>
                    <div class="settings-models-hint">
                        仅可选择已下载的模型，抠图时使用此处选定的模型
                    </div>
                </div>
                <div class="settings-models-section">
                    <div class="settings-models-header">
                        <span class="settings-models-title">抠图模型</span>
                    </div>
                    <div id="settingsRembgList">
                        <div class="settings-models-hint">加载中...</div>
                    </div>
                    <div class="settings-models-hint">
                        模型文件保存在 models/rembg 目录，下载中断后再次下载会自动续传
                    </div>
                </div>
            </div>
        `;
        this.loadModels();
    }

    /**
     * 离开该分类（或关闭设置界面）时停止轮询，避免后台无谓请求
     */
    onLeave() {
        this.stopPoll();
    }

    /**
     * 拉取抠图模型清单并渲染
     */
    async loadModels() {
        try {
            const response = await fetch('/api/rembg/models');
            const result = await response.json();
            if (result.status !== 'ok') throw new Error(result.message || '获取失败');

            this.models = result.models || [];
            this.renderActiveSelect();
            this.renderList();

            // 若有模型正在下载，启动进度轮询
            if (this.models.some(m => m.progress && m.progress.state === 'downloading')) {
                this.startPoll();
            }
        } catch (error) {
            console.error('获取抠图模型清单失败:', error);
            const listEl = document.getElementById('settingsRembgList');
            if (!listEl) return;
            // TypeError: Failed to fetch 表示连不上本地后端，而非接口本身报错
            const message = error instanceof TypeError
                ? '无法连接到本地后端服务，请确认 server.js 已启动（8080 端口）'
                : error.message;
            listEl.innerHTML = `<div class="settings-save-status error">${LumenLight.escapeHtml(message)}</div>`;
        }
    }

    /**
     * 渲染顶部「当前使用的模型」下拉框
     * 按用户约定只列出已下载的模型，避免选中却用不了
     */
    renderActiveSelect() {
        const selectEl = document.getElementById('settingsRembgActive');
        if (!selectEl) return;

        const downloaded = this.models.filter(m => m.downloaded);

        // 一个都没下载时禁用下拉，引导用户先去下面下载
        if (downloaded.length === 0) {
            selectEl.innerHTML = '<option value="">请先下载模型</option>';
            selectEl.disabled = true;
            return;
        }

        // 已选模型可能已被删除，此时回退到第一个可用模型
        let active = SettingsManager.getActiveRembgModel();
        if (!downloaded.some(m => m.id === active)) {
            active = downloaded[0].id;
            SettingsManager.setActiveRembgModel(active);
        }

        selectEl.disabled = false;
        selectEl.innerHTML = downloaded.map(m => `
            <option value="${m.id}" ${m.id === active ? 'selected' : ''}>
                ${LumenLight.escapeHtml(m.name)}
            </option>
        `).join('');

        // 选择即生效，无需点保存
        selectEl.onchange = () => {
            SettingsManager.setActiveRembgModel(selectEl.value);
        };
    }

    /**
     * 渲染抠图模型列表，并绑定下载 / 取消 / 删除按钮
     */
    renderList() {
        const listEl = document.getElementById('settingsRembgList');
        if (!listEl) return;

        if (this.models.length === 0) {
            listEl.innerHTML = '<div class="settings-models-hint">暂无可用模型</div>';
            return;
        }

        listEl.innerHTML = this.models.map(m => this.renderRow(m)).join('');

        // 事件委托：三个操作按钮共用一个监听
        listEl.querySelectorAll('[data-rembg-action]').forEach(btn => {
            btn.addEventListener('click', () => {
                const { rembgAction: action, modelId } = btn.dataset;
                if (action === 'download') this.downloadModel(modelId);
                else if (action === 'cancel') this.cancelDownload(modelId);
                else if (action === 'delete') this.deleteModel(modelId);
            });
        });
    }

    /**
     * 渲染单个抠图模型的卡片
     * @param {Object} model - 模型信息（含 downloaded / progress 等状态）
     * @returns {string} HTML 字符串
     */
    renderRow(model) {
        const progress = model.progress;
        const downloading = progress && progress.state === 'downloading';

        // 三种状态对应不同的右侧操作区
        let actionHtml;
        if (downloading) {
            actionHtml = `
                <button class="settings-models-btn" type="button"
                        data-rembg-action="cancel" data-model-id="${model.id}">取消</button>
            `;
        } else if (model.downloaded) {
            actionHtml = `
                <span class="settings-rembg-badge">已下载 ${model.actualMB} MB</span>
                <button class="settings-models-btn" type="button"
                        data-rembg-action="delete" data-model-id="${model.id}">删除</button>
            `;
        } else {
            actionHtml = `
                <button class="settings-models-btn primary" type="button"
                        data-rembg-action="download" data-model-id="${model.id}">下载</button>
            `;
        }

        // 下载中显示进度条，失败/取消显示提示文字
        let statusHtml = '';
        if (downloading) {
            statusHtml = `
                <div class="settings-rembg-progress">
                    <div class="settings-rembg-progress-bar">
                        <div class="settings-rembg-progress-fill" style="width: ${progress.percent}%"></div>
                    </div>
                    <span class="settings-rembg-progress-text">
                        ${progress.percent}% · ${progress.downloadedMB}/${progress.totalMB} MB · ${progress.speedMB} MB/s
                    </span>
                </div>
            `;
        } else if (progress && progress.state === 'error') {
            statusHtml = `<div class="settings-save-status error">下载失败：${LumenLight.escapeHtml(progress.message || '')}</div>`;
        } else if (progress && progress.state === 'cancelled') {
            statusHtml = '<div class="settings-models-hint">下载已取消，再次下载将从断点继续</div>';
        }

        return `
            <div class="settings-rembg-item">
                <div class="settings-rembg-main">
                    <div class="settings-rembg-info">
                        <span class="settings-rembg-name">${LumenLight.escapeHtml(model.name)}</span>
                        <span class="settings-rembg-desc">${LumenLight.escapeHtml(model.desc)} · 约 ${model.sizeMB} MB</span>
                    </div>
                    <div class="settings-rembg-actions">${actionHtml}</div>
                </div>
                ${statusHtml}
            </div>
        `;
    }

    /**
     * 开始下载指定抠图模型
     * @param {string} modelId - 模型 ID
     */
    async downloadModel(modelId) {
        try {
            const response = await fetch('/api/rembg/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: modelId })
            });
            const result = await response.json();
            if (result.status !== 'ok') throw new Error(result.message || '下载失败');

            await this.loadModels();
            this.startPoll();
        } catch (error) {
            console.error('下载抠图模型失败:', error);
            alert('下载失败：' + error.message);
        }
    }

    /**
     * 取消正在进行的下载
     * @param {string} modelId - 模型 ID
     */
    async cancelDownload(modelId) {
        try {
            await fetch('/api/rembg/download/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: modelId })
            });
            await this.loadModels();
        } catch (error) {
            console.error('取消下载失败:', error);
        }
    }

    /**
     * 删除已下载的模型文件
     * @param {string} modelId - 模型 ID
     */
    async deleteModel(modelId) {
        const model = this.models.find(m => m.id === modelId);
        if (!confirm(`确定删除模型「${model ? model.name : modelId}」吗？删除后需重新下载才能使用抠图功能。`)) {
            return;
        }

        try {
            const response = await fetch(`/api/rembg/models/${modelId}`, { method: 'DELETE' });
            const result = await response.json();
            if (result.status !== 'ok') throw new Error(result.message || '删除失败');
            await this.loadModels();
        } catch (error) {
            console.error('删除抠图模型失败:', error);
            alert('删除失败：' + error.message);
        }
    }

    /**
     * 启动下载进度轮询（1 秒一次）
     * 下载结束后自动停止并刷新一次清单，以更新“已下载”状态
     */
    startPoll() {
        if (this.pollTimer) return;

        this.pollTimer = setInterval(async () => {
            // 界面已关闭或已切换分类时停止轮询
            if (!this.manager.isOpen() || this.manager.currentCategory !== 'rembg') {
                this.stopPoll();
                return;
            }

            const downloading = this.models.filter(
                m => m.progress && m.progress.state === 'downloading'
            );
            if (downloading.length === 0) {
                this.stopPoll();
                return;
            }

            try {
                // 逐个查询下载中的模型进度
                const updates = await Promise.all(
                    downloading.map(async (m) => {
                        const res = await fetch(`/api/rembg/download/status?model=${encodeURIComponent(m.id)}`);
                        const data = await res.json();
                        return { id: m.id, progress: data.progress };
                    })
                );

                let finished = false;
                updates.forEach(({ id, progress }) => {
                    const target = this.models.find(m => m.id === id);
                    if (!target) return;
                    target.progress = progress;
                    if (!progress || progress.state !== 'downloading') finished = true;
                });

                // 有任务结束需重新拉清单，才能拿到 downloaded / actualMB
                if (finished) {
                    this.stopPoll();
                    await this.loadModels();
                } else {
                    this.renderList();
                }
            } catch (error) {
                console.error('查询下载进度失败:', error);
                this.stopPoll();
            }
        }, 1000);
    }

    /**
     * 停止下载进度轮询
     */
    stopPoll() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }
}

// 将 SettingsRembgPanel 暴露到全局作用域
window.SettingsRembgPanel = SettingsRembgPanel;
