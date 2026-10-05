/**
 * ==========================================================================
 * LumenLight 设置 - 通用面板
 * 作用：渲染「通用」分类的设置项：画布缩放锚点显隐、画布显示质量档位、
 *       提示词自动补全开关。
 * 交互约定：切换即生效，无需点保存；配置存在 localStorage 而非后端。
 * 由 SettingsManager 在构造时实例化并按分类调用 render()。
 * ==========================================================================
 */

class SettingsGeneralPanel {
    /**
     * @param {SettingsManager} manager - 设置管理器实例（提供 contentEl 等共享状态）
     */
    constructor(manager) {
        this.manager = manager;
    }

    /**
     * 渲染通用设置内容
     */
    render() {
        const contentEl = this.manager.contentEl;
        if (!contentEl) return;

        const checked = SettingsManager.getShowResizeHandles() ? 'checked' : '';
        const quality = SettingsManager.getImageQuality();
        const acChecked = SettingsManager.getPromptAutocompleteEnabled() ? 'checked' : '';

        contentEl.innerHTML = `
            <div class="settings-form">
                <div class="settings-models-section">
                    <div class="settings-models-header">
                        <span class="settings-models-title">画布</span>
                    </div>
                    <div class="settings-switch-row">
                        <div class="settings-switch-info">
                            <span class="settings-switch-label">显示图片缩放锚点</span>
                            <span class="settings-switch-desc">
                                关闭后四角锚点不再绘制，但拖拽图片四角依然可以缩放
                            </span>
                        </div>
                        <label class="settings-switch">
                            <input type="checkbox" id="settingsShowResizeHandles" ${checked}>
                            <span class="settings-switch-slider"></span>
                        </label>
                    </div>
                    <div class="settings-switch-row">
                        <div class="settings-switch-info">
                            <span class="settings-switch-label">画布显示质量</span>
                            <span class="settings-switch-desc">
                                仅优化画布缩放时的显示性能：低档位下缩小查看时绘制
                                低分辨率副本，放大到接近原始分辨率时自动切回原图；
                                灯箱查看、高清放大与保存始终使用原图，不受影响
                            </span>
                        </div>
                        <select class="settings-input" id="settingsImageQuality">
                            <option value="native" ${quality === 'native' ? 'selected' : ''}>原生质量</option>
                            <option value="balanced" ${quality === 'balanced' ? 'selected' : ''}>平衡（1024px）</option>
                            <option value="performance" ${quality === 'performance' ? 'selected' : ''}>性能优先（512px）</option>
                        </select>
                    </div>
                </div>

                <div class="settings-models-section">
                    <div class="settings-models-header">
                        <span class="settings-models-title">agent模型</span>
                    </div>
                    <div class="settings-switch-row">
                        <div class="settings-switch-info">
                            <span class="settings-switch-label">权限分级</span>
                            <span class="settings-switch-desc">
                                只读：仅允许查看画布与提示词；标准：可操作画布但禁用
                                bash 等系统工具；完整：全部放行（拥有系统完整权限，
                                请谨慎）。MCP 工具按此分级过滤
                            </span>
                        </div>
                        <select class="settings-input" id="settingsPiPermission">
                            <option value="readonly">只读</option>
                            <option value="standard">标准</option>
                            <option value="full">完整</option>
                        </select>
                    </div>
                    <div class="settings-switch-row">
                        <div class="settings-switch-info">
                            <span class="settings-switch-label">agent 使用的模型</span>
                            <span class="settings-switch-desc">
                                对话所用的底层模型（来自 API 设置中的聊天/视觉模型）
                            </span>
                        </div>
                        <select class="settings-input" id="settingsPiModel"></select>
                    </div>
                </div>
                <div class="settings-models-section">
                    <div class="settings-models-header">
                        <span class="settings-models-title">提示词</span>
                    </div>
                    <div class="settings-switch-row">
                        <div class="settings-switch-info">
                            <span class="settings-switch-label">提示词自动补全</span>
                            <span class="settings-switch-desc">
                                关闭后画布提示词节点与右侧面板的正/负向提示词输入框
                                不再弹出中文 tag 补全下拉，适合不需要 tag 补全的模型
                            </span>
                        </div>
                        <label class="settings-switch">
                            <input type="checkbox" id="settingsPromptAutocomplete" ${acChecked}>
                            <span class="settings-switch-slider"></span>
                        </label>
                    </div>
                </div>
            </div>
        `;

        const switchEl = document.getElementById('settingsShowResizeHandles');
        if (switchEl) {
            // 切换即生效，无需点保存
            switchEl.onchange = () => {
                SettingsManager.setShowResizeHandles(switchEl.checked);
                // 立即重绘画布，让用户在设置界面就能看到效果
                if (window.canvas) {
                    window.canvas.draw();
                }
            };
        }

        // 显示质量切换即生效：清空旧代理缓存并立即重绘
        const qualityEl = document.getElementById('settingsImageQuality');
        if (qualityEl) {
            qualityEl.onchange = () => {
                SettingsManager.setImageQuality(qualityEl.value);
                window.canvas?.renderer?.proxyCache?.clear();
                window.canvas?.draw();
            };
        }

        // 提示词补全开关：写入即广播 promptAutocompleteSettingChanged 事件，
        // 画布提示词节点与面板正/负向输入框监听后即时启停，无需刷新
        const acEl = document.getElementById('settingsPromptAutocomplete');
        if (acEl) {
            acEl.onchange = () => {
                SettingsManager.setPromptAutocompleteEnabled(acEl.checked);
            };
        }

        // ===== pi 编码智能体 =====
        // 权限分级：localStorage 记忆 UI + 同步到后端（pi 扩展的工具拦截读取）
        const permEl = document.getElementById('settingsPiPermission');
        if (permEl) {
            permEl.value = localStorage.getItem('piPermissionLevel') || 'standard';
            permEl.onchange = () => {
                localStorage.setItem('piPermissionLevel', permEl.value);
                fetch('/api/pi/permission', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ level: permEl.value })
                }).catch((err) => console.error('同步 pi 权限分级失败:', err));
            };
        }

        // pi 使用的模型：列出全部已配置模型（排除图像与 pi 入口自身）
        const piModelEl = document.getElementById('settingsPiModel');
        if (piModelEl) {
            piModelEl.innerHTML = '<option value="">未选择</option>';
            fetch('/api/settings')
                .then((r) => r.json())
                .then((result) => {
                    const api = result.settings?.api || {};
                    const models = LumenLight.collectConfiguredModels(api)
                        .models.filter((m) => {
                            if (m.type === 'image' || m.type === 'video') return false;
                            // auto/未标记按名称口径排除（与 isImageModel 一致），
                            // 防止 gpt-image-* 等生图模型被选为 pi 底层模型
                            return m.type === 'chat' || !LumenLight.looksLikeImageModel(m.id);
                        });
                    for (const m of models) {
                        const opt = document.createElement('option');
                        opt.value = m.key;
                        opt.textContent = m.displayName || m.id;
                        piModelEl.appendChild(opt);
                    }
                    piModelEl.value = localStorage.getItem('piModelKey') || '';
                })
                .catch((err) => console.error('加载 pi 模型列表失败:', err));
            piModelEl.onchange = () => {
                localStorage.setItem('piModelKey', piModelEl.value);
            };
        }
    }

    /**
     * 离开该分类时的清理钩子
     * 通用面板没有定时器或订阅，留空以统一面板接口
     */
    onLeave() {
        // 无需清理
    }
}

// 将 SettingsGeneralPanel 暴露到全局作用域
window.SettingsGeneralPanel = SettingsGeneralPanel;
