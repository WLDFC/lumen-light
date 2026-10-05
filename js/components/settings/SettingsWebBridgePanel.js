/**
 * ==========================================================================
 * LumenLight 网页桥接设置面板（SettingsWebBridgePanel）
 * ==========================================================================
 * 作用：设置 → 网页桥接。管理网页桥接模式（LLM 面板「网页桥接」项）的
 *       桥接目标与浏览器实例：
 *   - 桥接站点选择：清单来自后端适配器注册表（utils/webbridge/adapters/），
 *     新增站点后这里自动出现；未校准站点置灰（待适配）；
 *   - 浏览器路径：留空自动探测 Chrome/Edge 常见安装位置；
 *   - 连接控制：启动桥接（拉起专用浏览器并打开站点对话页）/ 关闭浏览器；
 *   - 状态行：运行状态、当前页面、是否回合进行中（10s 轻轮询）。
 *
 * 配置存 settings.json 的 webbridge 区块（browserPath/activeSite/headless），
 * 与 api/mcp 等区块互不影响；保存后派发 settingsSaved 让面板模式刷新。
 * ==========================================================================
 */

class SettingsWebBridgePanel {
    /**
     * @param {Object} manager - SettingsManager 实例（提供 contentEl）
     */
    constructor(manager) {
        this.manager = manager;
        this._timer = null;   // 状态轮询定时器
        this._sites = [];     // 站点清单快照（渲染下拉用）
    }

    /** 渲染面板内容（设置界面切到网页桥接分类时调用） */
    render() {
        const contentEl = this.manager.contentEl;
        if (!contentEl) return;
        this._stopPolling();

        contentEl.innerHTML = `
            <div class="settings-form">
                <div class="settings-models-section">
                    <div class="settings-models-header">
                        <span class="settings-models-title">网页桥接</span>
                        <button type="button" class="settings-models-btn" id="webBridgeStart">启动桥接</button>
                        <button type="button" class="settings-models-btn" id="webBridgeStop">关闭浏览器</button>
                        <button type="button" class="settings-models-btn primary" id="webBridgeSave">保存</button>
                    </div>
                    <div class="settings-switch-desc" style="margin: 6px 0;">
                        网页桥接模式：由后端拉起一个<b>专用浏览器</b>驱动目标站点网页（豆包等），
                        网页里跑出来的回复与图片/视频自动回流到面板与画布。<br>
                        首次使用：点「启动桥接」→ 在弹出的浏览器里<b>登录站点一次</b>，
                        登录会话持久保存在 data/webbridge/profile/，之后免登录。<br>
                        生成过程不经任何 API，与 设置 → API 配置的模型链路完全隔离。
                    </div>
                    <div class="settings-form-item">
                        <label>桥接站点</label>
                        <select id="webBridgeSite" class="settings-input"></select>
                    </div>
                    <div class="settings-form-item">
                        <label>浏览器路径</label>
                        <input type="text" id="webBridgePath" class="settings-input"
                               placeholder="留空自动探测 Chrome / Edge（如 C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe）">
                    </div>
                    <div class="settings-switch-desc" id="webBridgeStatus">加载中…</div>
                </div>
            </div>`;

        this.siteEl = contentEl.querySelector('#webBridgeSite');
        this.pathEl = contentEl.querySelector('#webBridgePath');
        this.statusEl = contentEl.querySelector('#webBridgeStatus');
        contentEl.querySelector('#webBridgeSave').addEventListener('click', () => this._save());
        contentEl.querySelector('#webBridgeStart').addEventListener('click', () => this._start());
        contentEl.querySelector('#webBridgeStop').addEventListener('click', () => this._stop());

        this._reload();
        this._startPolling();
    }

    /** 离开面板：停止状态轮询 */
    onLeave() {
        this._stopPolling();
    }

    // ==================== 数据流 ====================

    /** 拉取总览：覆盖站点下拉与浏览器路径（未保存的路径编辑会被覆盖） */
    async _reload() {
        try {
            const res = await fetch('/api/webbridge/overview');
            const data = await res.json();
            if (data.status !== 'ok') throw new Error(data.message || '加载失败');
            this._sites = data.sites || [];
            this._renderSites(data.activeSite);
            if (document.activeElement !== this.pathEl) {
                this.pathEl.value = data.browserPath || '';
            }
            this._renderStatus(data);
        } catch (err) {
            this.statusEl.textContent = '加载失败：' + err.message;
        }
    }

    /** 站点下拉：未校准站点置灰（待适配），当前站点选中 */
    _renderSites(activeSite) {
        this.siteEl.innerHTML = this._sites.map((s) => `
            <option value="${s.id}" ${s.id === activeSite ? 'selected' : ''}
                    ${s.ready ? '' : 'disabled'}>
                ${s.name}${s.ready ? '' : '（待适配）'}
            </option>
        `).join('') || '<option value="">无可用站点</option>';
    }

    /** 轻轮询：只刷新状态行，不打断正在编辑的输入框 */
    _startPolling() {
        this._stopPolling();
        this._timer = setInterval(async () => {
            try {
                const res = await fetch('/api/webbridge/overview');
                const data = await res.json();
                if (data.status === 'ok') this._renderStatus(data);
            } catch { /* 后端未就绪：下轮再试 */ }
        }, 10000);
    }

    _stopPolling() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    _renderStatus(data) {
        const state = data.running
            ? `运行中（${data.siteName || data.activeSite}）${data.busy ? ' · 有回合进行中' : ''}`
            : '未启动（发送第一条消息时会自动拉起，也可点「启动桥接」提前登录）';
        const page = data.pageUrl ? ` · 页面：${data.pageUrl}` : '';
        this.statusEl.textContent = `状态：${state}${page}`;
    }

    // ==================== 操作 ====================

    /** 保存配置：站点 + 浏览器路径，保存后广播刷新（面板模式同步站点） */
    async _save() {
        try {
            const res = await fetch('/api/webbridge/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    browserPath: this.pathEl.value.trim(),
                    activeSite: this.siteEl.value
                })
            });
            const data = await res.json();
            if (data.status !== 'ok') throw new Error(data.message || '保存失败');
            this.statusEl.textContent = '已保存。站点变更已即时生效。';
            // 与其他面板同源：让 LLM 面板刷新（网页桥接模式换聊天记录键等）
            window.dispatchEvent(new CustomEvent('settingsSaved'));
        } catch (err) {
            this.statusEl.textContent = '保存失败：' + err.message;
        }
    }

    /** 启动桥接：拉起专用浏览器并打开当前站点（先用输入框里的路径与站点） */
    async _start() {
        this.statusEl.textContent = '正在启动浏览器…';
        try {
            await this._save();
            const res = await fetch('/api/webbridge/start', { method: 'POST' });
            const data = await res.json();
            if (data.status !== 'ok') throw new Error(data.message || '启动失败');
            this.statusEl.textContent = '已启动。若是首次使用，请在弹出的浏览器里登录站点。';
        } catch (err) {
            this.statusEl.textContent = '启动失败：' + err.message;
        }
        this._reload();
    }

    /** 关闭浏览器 */
    async _stop() {
        try {
            await fetch('/api/webbridge/stop', { method: 'POST' });
            this.statusEl.textContent = '浏览器已关闭。';
        } catch (err) {
            this.statusEl.textContent = '关闭失败：' + err.message;
        }
        this._reload();
    }
}

// 暴露到全局作用域
window.SettingsWebBridgePanel = SettingsWebBridgePanel;
