/**
 * ==========================================================================
 * LumenLight MCP 设置面板（SettingsMcpPanel）
 * ==========================================================================
 * 作用：设置 → MCP。管理用户自挂的 MCP 服务器（一期仅 stdio 传输）：
 *   - 服务器卡片：名称 / 启动命令 / 参数（空格分隔）/ 环境变量（KEY=VALUE 行）
 *     / 启用开关；
 *   - 「保存并应用」即差量生效：新增/启用 → 连接，移除/停用 → 断开；
 *   - 连接状态 + 工具清单预览（10s 轻轮询，离开页面停止）；
 *   - agent 侧：pi 桥接扩展（lumen-mcp）在 pi 启动时注册工具，
 *     修改服务器后需重启 pi（点击面板头部状态灯）生效。
 *
 * 安全：stdio 服务器 = 在本机执行任意命令，仅添加可信来源（面板内有醒目警告）。
 * ==========================================================================
 */

class SettingsMcpPanel {
    /**
     * @param {Object} manager - SettingsManager 实例（提供 contentEl）
     */
    constructor(manager) {
        this.manager = manager;
        this._cards = [];    // 本地编辑态 [{id, name, command, argsText, envText, enabled}]
        this._timer = null;  // 状态轮询定时器
    }

    /** 渲染面板内容（设置界面切到 MCP 分类时调用） */
    render() {
        const contentEl = this.manager.contentEl;
        if (!contentEl) return;
        this._stopPolling();

        contentEl.innerHTML = `
            <div class="settings-form">
                <div class="mcp-topbar">
                    <div class="settings-models-header">
                        <span class="settings-models-title">MCP 服务器</span>
                        <div class="settings-models-actions">
                            <button type="button" class="settings-models-btn" id="settingsMcpAdd">+ 添加服务器</button>
                        </div>
                    </div>
                    <div class="settings-switch-desc" style="margin: 4px 0 0;">
                        ⚠️ stdio 服务器会在本机执行其启动命令（等于任意代码执行），仅添加可信来源。<br>
                        「保存并应用」立即生效；agent 侧工具在 pi 重启后可用（点击面板头部状态灯重启）。
                    </div>
                </div>
                <div id="settingsMcpList"></div>
                <div class="settings-switch-desc" id="settingsMcpHint">加载中…</div>
            </div>`;

        this.listEl = contentEl.querySelector('#settingsMcpList');
        this.hintEl = contentEl.querySelector('#settingsMcpHint');
        contentEl.querySelector('#settingsMcpAdd')
            .addEventListener('click', () => {
                this._cards.push(this._blankCard());
                this._renderCards();
            });

        this._reload();
        this._startPolling();
    }

    /** 离开面板：停止状态轮询 */
    onLeave() {
        this._stopPolling();
    }

    // ==================== 数据流 ====================

    /** 拉取总览：覆盖本地编辑态（若有未保存改动会被覆盖，状态区有提示） */
    async _reload() {
        try {
            const res = await fetch('/api/mcp/overview');
            const data = await res.json();
            if (data.status !== 'ok') throw new Error(data.message || '加载失败');
            this._cards = (data.servers || []).map((s) => {
                const card = this._toCard(s);
                // 保留用户正在填的认领路径（按 id 对应）
                const old = this._cards.find((c) => c.id && c.id === s.id);
                if (old) card.comfyRoot = old.comfyRoot;
                return card;
            });
            this._renderCards();
            this._renderStatus(data.servers || []);
            const n = (data.servers || []).length;
            this.hintEl.textContent = n
                ? `已登记 ${n} 个服务器。`
                : '尚未添加 MCP 服务器。点击「+ 添加服务器」，填入启动命令即可（如 npx -y 某个 mcp 服务器包名）。';
        } catch (err) {
            this.hintEl.textContent = '加载失败：' + err.message;
        }
    }

    /** 轻轮询：只刷新状态与工具清单，不打断正在编辑的输入框 */
    _startPolling() {
        this._stopPolling();
        this._timer = setInterval(async () => {
            try {
                const res = await fetch('/api/mcp/overview');
                const data = await res.json();
                if (data.status === 'ok') this._renderStatus(data.servers || []);
            } catch { /* 后端未就绪：下轮再试 */ }
        }, 10000);
    }

    _stopPolling() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    // ==================== 卡片渲染 ====================

    _blankCard() {
        return {
            id: '', name: '', transport: 'stdio', command: '', argsText: '', envText: '',
            url: '', headersText: '', enabled: true
        };
    }

    /** 服务器总览条目 → 卡片编辑态 */
    _toCard(s) {
        return {
            id: s.id || '',
            name: s.name || '',
            transport: s.transport === 'http' ? 'http' : 'stdio',
            command: s.command || '',
            argsText: (s.args || []).join(' '),
            envText: this._envToText(s.env || {}),
            url: s.url || '',
            headersText: this._envToText(s.headers || {}),
            enabled: s.enabled !== false,
            status: s.status || 'stopped',
            error: s.error || '',
            tools: s.tools || [],
            resources: s.resources || [],
            prompts: s.prompts || [],
            hasComfyCli: !!s.hasComfyCli,
            claimedWorkspace: s.claimedWorkspace || '',
            comfyRoot: s.comfyRoot || '',
            minLevel: s.minLevel || 'standard',
            disabledTools: Array.isArray(s.disabledTools) ? [...s.disabledTools] : []
        };
    }

    _envToText(env) {
        return Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
    }

    _parseEnv(text) {
        const env = {};
        for (const line of String(text || '').split('\n')) {
            const t = line.trim();
            if (!t || !t.includes('=')) continue;
            const eq = t.indexOf('=');
            env[t.slice(0, eq).trim()] = t.slice(eq + 1);
        }
        return env;
    }

    /** 收集全部卡片为提交结构（按传输类型裁剪字段） */
    _collect() {
        return this._cards.map((c) => {
            const base = {
                id: c.id || undefined,
                name: c.name,
                enabled: c.enabled,
                minLevel: c.minLevel || 'standard',
                disabledTools: c.disabledTools || [],
                comfyRoot: (c.comfyRoot || '').trim()
            };
            if (c.transport === 'http') {
                return { ...base, transport: 'http', url: c.url, headers: this._parseEnv(c.headersText) };
            }
            return {
                ...base,
                transport: 'stdio',
                command: c.command,
                args: c.argsText.trim() ? c.argsText.trim().split(/\s+/) : [],
                env: this._parseEnv(c.envText)
            };
        });
    }

    /** 重绘全部卡片（结构性变化：添加/删除/保存回填/切换传输类型）。
     *  每台服务器独立成卡：卡头 = 名称输入 + 本卡「保存并应用」+ 垃圾桶 */
    _renderCards() {
        this.listEl.innerHTML = '';
        this._cards.forEach((card, idx) => {
            const cardEl = document.createElement('div');
            cardEl.className = 'settings-models-section mcp-server-card';
            cardEl.dataset.idx = String(idx);
            const isHttp = card.transport === 'http';

            // comfy-mcp 类服务器（仅 stdio）：ComfyUI 根目录（文件夹图标选择或粘贴，自动认领）
            const comfyRow = (card.hasComfyCli && card.id && !isHttp) ? `
                <div class="mcp-comfyrow" style="margin-top:6px">
                    <input type="text" class="settings-input mcp-comfyroot" placeholder="ComfyUI 根目录（点击右侧文件夹图标选择，或直接粘贴路径）"
                           value="${LumenLight.escapeHtml(card.comfyRoot || '')}"
                           title="选择或粘贴后自动认领（comfy set-default）">
                    <button type="button" class="settings-models-btn mcp-pick" title="打开文件夹选择窗口"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button>
                </div>
                <div class="settings-switch-desc mcp-claim-status" style="margin-top:4px">${(card.claimedWorkspace && !card.comfyRoot) ? `当前已认领：${LumenLight.escapeHtml(card.claimedWorkspace)}（点击右侧文件夹图标可重新选择）` : ''}</div>
            ` : '';

            // 传输形态字段：stdio = 命令/参数/环境变量；http = 地址/请求头
            const transportFields = isHttp ? `
                <input type="text" class="settings-input mcp-url" placeholder="服务器地址，如 https://example.com/mcp"
                       value="${LumenLight.escapeHtml(card.url)}" style="margin-top:6px">
                <textarea class="settings-input mcp-headers" rows="2" placeholder="请求头（每行 KEY=VALUE，如 Authorization=Bearer 你的令牌）"
                          style="margin-top:6px">${LumenLight.escapeHtml(card.headersText)}</textarea>
            ` : `
                <input type="text" class="settings-input mcp-command" placeholder="启动命令，如 npx -y 包名 或 python 路径"
                       value="${LumenLight.escapeHtml(card.command)}" title="启动命令（stdio 传输）" style="margin-top:6px">
                <input type="text" class="settings-input mcp-args" placeholder="启动参数（空格分隔，如 -y @some/mcp-server）"
                       value="${LumenLight.escapeHtml(card.argsText)}" style="margin-top:6px">
                <textarea class="settings-input mcp-env" rows="2" placeholder="环境变量（每行 KEY=VALUE；值以 + 开头=前置追加，如 PATH=+E:\\venv\\Scripts）"
                          style="margin-top:6px">${LumenLight.escapeHtml(card.envText)}</textarea>
            `;

            cardEl.innerHTML = `
                <div class="settings-models-header mcp-card-header">
                    <input type="text" class="settings-input mcp-name" placeholder="名称（agent 工具前缀）"
                           value="${LumenLight.escapeHtml(card.name)}" title="MCP 服务器名称">
                    <div class="settings-models-actions">
                        <button type="button" class="settings-models-btn primary mcp-save">保存并应用</button>
                        <button type="button" class="settings-model-delete mcp-del" title="删除该服务器"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>
                    </div>
                </div>
                <div class="settings-rh-workflow-main mcp-main-row">
                    <select class="settings-input mcp-transport" title="传输类型：本地命令（stdio）或远程 HTTP">
                        <option value="stdio" ${!isHttp ? 'selected' : ''}>本地命令</option>
                        <option value="http" ${isHttp ? 'selected' : ''}>远程 HTTP</option>
                    </select>
                    <label class="settings-switch" title="启用后保存时自动连接">
                        <input type="checkbox" class="mcp-enabled" ${card.enabled ? 'checked' : ''}>
                        <span class="settings-switch-slider"></span>
                    </label>
                </div>
                ${transportFields}
                <div style="margin-top:6px">
                    <div class="settings-switch-desc" style="margin-bottom:4px">工具可用最低权限</div>
                    <select class="settings-input mcp-minlevel" style="width:100%"
                            title="全局权限分级（设置 → 通用）低于此级别时，该服务器的工具不会暴露给 agent、调用也会被拦">
                        <option value="readonly" ${card.minLevel === 'readonly' ? 'selected' : ''}>只读</option>
                        <option value="standard" ${card.minLevel === 'standard' ? 'selected' : ''}>标准</option>
                        <option value="full" ${card.minLevel === 'full' ? 'selected' : ''}>完整</option>
                    </select>
                </div>
                ${comfyRow}
                <div class="mcp-status" style="margin-top:6px"></div>
                <details class="mcp-tools" style="margin-top:4px"><summary>工具清单</summary><div class="mcp-tools-body"></div></details>
                <details class="mcp-resources" style="margin-top:4px"><summary>资源</summary><div class="mcp-resources-body"></div></details>
                <details class="mcp-prompts" style="margin-top:4px"><summary>提示词模板</summary><div class="mcp-prompts-body"></div></details>
            `;

            // 输入绑定：改动写回本地编辑态（传输切换会重建卡片后重绑）
            cardEl.querySelector('.mcp-name').addEventListener('input', (e) => { card.name = e.target.value; });
            cardEl.querySelector('.mcp-transport').addEventListener('change', (e) => {
                card.transport = e.target.value;
                this._renderCards();   // 形态互换：命令 / URL 字段切换
            });
            cardEl.querySelector('.mcp-enabled').addEventListener('change', (e) => { card.enabled = e.target.checked; });
            // 卡头动作按钮：保存应用全部配置（_saveAll），垃圾桶只删本卡（确认框报名字防误触）
            cardEl.querySelector('.mcp-save').addEventListener('click', () => this._saveAll());
            cardEl.querySelector('.mcp-del').addEventListener('click', async () => {
                if (!confirm(`确定删除服务器「${card.name || '未命名'}」？`)) return;
                this._cards.splice(idx, 1);
                this._renderCards();
                await this._saveAll();   // 删除即应用（后端断开被移除的服务器）
            });
            cardEl.querySelector('.mcp-minlevel').addEventListener('change', (e) => {
                card.minLevel = e.target.value;
                this._saveAll();   // 权限门禁即时生效（重载工具清单）
            });
            if (isHttp) {
                cardEl.querySelector('.mcp-url').addEventListener('input', (e) => { card.url = e.target.value; });
                cardEl.querySelector('.mcp-headers').addEventListener('input', (e) => { card.headersText = e.target.value; });
            } else {
                cardEl.querySelector('.mcp-command').addEventListener('input', (e) => { card.command = e.target.value; });
                cardEl.querySelector('.mcp-args').addEventListener('input', (e) => { card.argsText = e.target.value; });
                cardEl.querySelector('.mcp-env').addEventListener('input', (e) => { card.envText = e.target.value; });
            }

            // ComfyUI 根目录（粘贴直接生效于保存；📁 选文件夹选完自动认领）
            const rootInput = cardEl.querySelector('.mcp-comfyroot');
            if (rootInput) rootInput.addEventListener('input', (e) => { card.comfyRoot = e.target.value; });

            // 📁 打开原生文件夹选择窗口 → 路径回填 → 自动认领
            const pickBtn = cardEl.querySelector('.mcp-pick');
            if (pickBtn) {
                const claimStatus = cardEl.querySelector('.mcp-claim-status');
                pickBtn.addEventListener('click', async () => {
                    pickBtn.disabled = true;
                    claimStatus.textContent = '正在打开文件夹选择窗口…（选择后自动认领）';
                    claimStatus.style.color = '';
                    try {
                        const res = await fetch('/api/mcp/pick-folder', { method: 'POST' });
                        const text = await res.text();
                        let data;
                        try { data = JSON.parse(text); }
                        catch {
                            // 非 JSON 响应（如 404 页面）= 运行中的后端还没加载该接口
                            throw new Error(`后端接口不可用（HTTP ${res.status}）——请重启后端服务后重试`);
                        }
                        if (data.status !== 'ok') throw new Error(data.message || '打开失败');
                        if (data.canceled || !data.path) {
                            claimStatus.textContent = '已取消';
                            return;
                        }
                        card.comfyRoot = data.path;
                        rootInput.value = data.path;
                        claimStatus.textContent = '认领中…';
                        const claim = await fetch('/api/mcp/comfy-set-default', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ serverId: card.id, rootPath: data.path })
                        });
                        const claimData = await claim.json();
                        claimStatus.textContent = claimData.output || (claimData.ok ? '已认领 ✓（记得点「保存并应用」持久化）' : '认领失败');
                        claimStatus.style.color = claimData.ok ? '#4ade80' : '#ef4444';
                    } catch (err) {
                        claimStatus.textContent = '选择失败：' + err.message;
                        claimStatus.style.color = '#ef4444';
                    } finally {
                        pickBtn.disabled = false;
                    }
                });
            }

            this.listEl.appendChild(cardEl);
        });
    }

    /** 刷新各卡片的状态行与工具清单（轮询/保存后调用，不动输入框） */
    _renderStatus(servers) {
        const listEl = this.listEl;
        if (!listEl) return;
        for (const s of servers) {
            const idx = this._cards.findIndex((c) => c.id && c.id === s.id);
            if (idx < 0) continue;
            const card = this._cards[idx];   // 本地编辑态卡片（disabledTools 等的宿主）
            const cardEl = listEl.querySelector(`[data-idx="${idx}"]`);
            if (!cardEl) continue;

            const statusEl = cardEl.querySelector('.mcp-status');
            const color = s.status === 'running' ? '#4ade80'
                : s.status === 'error' ? '#ef4444'
                : s.status === 'starting' ? '#facc15' : 'rgba(255,255,255,0.4)';
            const label = s.status === 'running' ? `已连接（${(s.tools || []).length} 个工具）`
                : s.status === 'starting' ? '连接中…'
                : s.status === 'error' ? `连接失败：${s.error || '未知错误'}`
                : s.status === 'disabled' ? '已停用' : '未连接';
            statusEl.innerHTML =
                `<span style="color:${color}">● ${LumenLight.escapeHtml(label)}</span>` +
                (s.status !== 'running' && s.enabled
                    ? ` <button type="button" class="settings-models-btn mcp-connect" style="margin-left:8px">连接</button>`
                    : '') +
                (s.status === 'running'
                    ? ` <button type="button" class="settings-models-btn mcp-disc" style="margin-left:8px">断开</button>`
                    : '');

            const connectBtn = statusEl.querySelector('.mcp-connect');
            if (connectBtn) connectBtn.addEventListener('click', () => this._connect(s.id));
            const discBtn = statusEl.querySelector('.mcp-disc');
            if (discBtn) discBtn.addEventListener('click', async () => {
                await fetch('/api/mcp/disconnect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: s.id })
                });
                this._reload();
            });

            const toolsBody = cardEl.querySelector('.mcp-tools-body');
            const summary = cardEl.querySelector('.mcp-tools summary');
            const tools = s.tools || [];
            const enabledCount = tools.filter((t) => !(card.disabledTools || []).includes(t.name)).length;
            summary.textContent = `工具清单（${enabledCount}/${tools.length} 启用）`;
            toolsBody.innerHTML = tools.length === 0
                ? '<div class="settings-switch-desc">未发现工具（服务器未连接或未暴露工具）</div>'
                : tools.map((t) => {
                    const off = (card.disabledTools || []).includes(t.name);
                    return `<div style="padding:2px 0;display:flex;align-items:center;gap:6px">
                        <label style="display:flex;align-items:center;gap:4px;cursor:pointer"
                               title="取消勾选 = 停用该工具（agent 不可见、调用被拦）">
                            <input type="checkbox" class="mcp-tool-toggle" data-tool="${LumenLight.escapeHtml(t.name)}" ${off ? '' : 'checked'}>
                            <b>${LumenLight.escapeHtml(t.name)}</b>
                        </label>
                        <span class="settings-switch-desc">— ${LumenLight.escapeHtml(t.description || '')}</span>
                    </div>`;
                }).join('');
            toolsBody.querySelectorAll('.mcp-tool-toggle').forEach((cb) => {
                cb.addEventListener('change', async () => {
                    const name = cb.dataset.tool;
                    card.disabledTools = card.disabledTools || [];
                    if (cb.checked) {
                        card.disabledTools = card.disabledTools.filter((n) => n !== name);
                    } else if (!card.disabledTools.includes(name)) {
                        card.disabledTools.push(name);
                    }
                    await this._saveAll();   // 启停即时持久化并生效
                });
            });

            // 资源 / 提示词清单预览
            const resBody = cardEl.querySelector('.mcp-resources-body');
            if (resBody) {
                const list = s.resources || [];
                const resSummary = cardEl.querySelector('.mcp-resources summary');
                if (resSummary) resSummary.textContent = `资源（${list.length}）`;
                resBody.innerHTML = list.length === 0
                    ? '<div class="settings-switch-desc">无</div>'
                    : list.map((r) =>
                        `<div style="padding:2px 0"><b>${LumenLight.escapeHtml(r.name || r.uri)}</b>` +
                        `<span class="settings-switch-desc"> — ${LumenLight.escapeHtml(r.uri || '')}</span></div>`
                    ).join('');
            }
            const promptBody = cardEl.querySelector('.mcp-prompts-body');
            if (promptBody) {
                const list = s.prompts || [];
                const promptSummary = cardEl.querySelector('.mcp-prompts summary');
                if (promptSummary) promptSummary.textContent = `提示词模板（${list.length}）`;
                promptBody.innerHTML = list.length === 0
                    ? '<div class="settings-switch-desc">无</div>'
                    : list.map((p) =>
                        `<div style="padding:2px 0"><b>${LumenLight.escapeHtml(p.name)}</b>` +
                        `<span class="settings-switch-desc"> — ${LumenLight.escapeHtml(p.description || '')}</span></div>`
                    ).join('');
            }
        }
    }

    // ==================== 操作 ====================

    /**
     * 保存全部卡片并差量应用（各卡片头部的「保存并应用」都走这里）。
     * 反馈：底部状态区闪现结果；失败时显示原因
     */
    async _saveAll() {
        try {
            const res = await fetch('/api/mcp/servers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ servers: this._collect() })
            });
            const data = await res.json();
            if (data.status !== 'ok') throw new Error(data.message || '保存失败');
            this.flashStatus('MCP 设置已保存并应用 ✓');
            await this._reload();
            // ComfyUI 根目录有变动的服务器：展示自动认领结果
            (data.claims || []).forEach((claim) => {
                const idx = this._cards.findIndex((c) => c.id === claim.id);
                const cardEl = idx >= 0 ? this.listEl.querySelector(`[data-idx="${idx}"]`) : null;
                const el = cardEl && cardEl.querySelector('.mcp-claim-status');
                if (el) {
                    el.textContent = claim.output;
                    el.style.color = claim.ok ? '#4ade80' : '#ef4444';
                }
            });
        } catch (err) {
            this.flashStatus('保存失败：' + err.message);
        }
    }

    /** 手动连接单个服务器（按当前保存的配置） */
    async _connect(id) {
        try {
            const res = await fetch('/api/mcp/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });
            const data = await res.json();
            if (data.status === 'ok' && !data.connected) {
                this.flashStatus('连接失败：' + (data.error || '未知错误'));
            }
        } catch (err) {
            this.flashStatus('连接失败：' + err.message);
        }
        this._reload();
    }

    /**
     * 在面板底部状态区闪现一条提示（2.5 秒后自动清除）
     * @param {string} text - 提示文字
     */
    flashStatus(text) {
        const statusEl = document.getElementById('settingsSaveStatus');
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.className = 'settings-save-status';
        setTimeout(() => {
            if (statusEl.textContent === text) statusEl.textContent = '';
        }, 2500);
    }
}

// 暴露到全局作用域
window.SettingsMcpPanel = SettingsMcpPanel;
