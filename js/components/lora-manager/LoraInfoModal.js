/**
 * ==========================================================================
 * LoRA 信息窗子模块（LoraInfoModal）
 * ==========================================================================
 * 从 LoraManager.js 拆出的居中弹窗：名称/目录/大小/修改时间 + 封面预览 +
 * 触发词/备注就地编辑 + 状态行。封面更换入口（画布选图/本地图片）与删除
 * 确认只在这里触发，实际逻辑在 LoraCoverPicker / LoraConfirmDelete 子模块。
 *
 * 模式：持有宿主（LoraManager 实例）引用读写其状态（_infoOverlay/_infoLora/
 * _bustMap/triggers/notes 等），与 image-studio/ 子模块同款契约；
 * LoraManager 主类留同名薄代理，调用点零改动。
 * ==========================================================================
 */

class LoraInfoModal {
    /** @param {LoraManager} host - 宿主管理器实例 */
    constructor(host) {
        this.host = host;
    }

    /** 保存文本元数据（kind: 'trigger'|'note'，空串即清除），同步本地缓存 */
    async _saveMetaText(kind, relPath, text) {
        const resp = await fetch(`/api/lora/${kind}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: relPath, text })
        });
        const r = await resp.json().catch(() => null);
        if (!resp.ok || !r || r.status !== 'ok') {
            throw new Error(r?.message || `保存失败（HTTP ${resp.status}）`);
        }
        const store = kind === 'trigger' ? 'triggers' : 'notes';
        if (text) this.host[store][relPath] = text;
        else delete this.host[store][relPath];
    }

    /**
     * 信息窗文本元数据块（触发词/备注共用）：查看态显示文本（空=斜体占位），
     * 铅笔进入就地编辑（Enter/失焦保存、Shift+Enter 换行、Esc 取消）
     * @param {HTMLElement} overlay - 信息窗根
     * @param {Object} lora - lora 数据
     * @param {Object} cfg - { textSel, editSel, kind, store, label, emptyText, placeholder }
     */
    _wireMetaTextBlock(overlay, lora, cfg) {
        const host = this.host;
        const textEl = overlay.querySelector(cfg.textSel);
        const editBtn = overlay.querySelector(cfg.editSel);
        if (!textEl || !editBtn) return;
        // 复制按钮：把框内文本写入剪贴板，成功后图标短暂变绿反馈
        const copyBtn = overlay.querySelector(cfg.copySel);
        if (copyBtn) {
            copyBtn.addEventListener('click', async () => {
                const text = host[cfg.store][lora.path] || '';
                if (!text) return;   // 空内容不复制
                try {
                    await navigator.clipboard.writeText(text);
                } catch {
                    // 回退：隐藏 textarea + execCommand（非安全上下文兜底）
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    ta.style.position = 'fixed';
                    ta.style.opacity = '0';
                    document.body.appendChild(ta);
                    ta.select();
                    try { document.execCommand('copy'); } catch { /* 兜底失败静默 */ }
                    ta.remove();
                }
                copyBtn.classList.add('copied');
                copyBtn.title = '已复制';
                setTimeout(() => {
                    copyBtn.classList.remove('copied');
                    copyBtn.title = cfg.copyTitle || '复制';
                }, 1500);
            });
        }
        const render = () => {
            const t = host[cfg.store][lora.path];
            textEl.textContent = t || cfg.emptyText;
            textEl.classList.toggle('empty', !t);
        };
        render();
        editBtn.addEventListener('click', () => {
            if (textEl.querySelector('textarea')) return;   // 已在编辑
            const cur = host[cfg.store][lora.path] || '';
            const ta = document.createElement('textarea');
            ta.className = 'lora-trigger-input';
            ta.value = cur;
            ta.placeholder = cfg.placeholder;
            textEl.textContent = '';
            textEl.classList.remove('empty');
            textEl.appendChild(ta);
            ta.focus();
            ta.setSelectionRange(cur.length, cur.length);
            let done = false;
            const commit = () => {
                if (done) return;
                done = true;
                const val = ta.value.trim();
                this._saveMetaText(cfg.kind, lora.path, val)
                    .catch((err) => host._infoStatus('❌ ' + cfg.label + (err.message || err), true));
                render();
            };
            ta.addEventListener('keydown', (e) => {
                e.stopPropagation();   // 阻止冒泡到全局 ESC/快捷键
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    commit();
                } else if (e.key === 'Escape') {
                    done = true;
                    render();
                }
            });
            ta.addEventListener('blur', commit);
        });
    }

    /**
     * C 站正文 HTML 白名单净化：正文是站方/作者的第三方内容，直接
     * innerHTML 有 XSS 风险。策略：危险标签整体移除，白名单外的标签
     * 解包保留文字，属性只留 a[href] 且限 http(s)——链接一律新标签打开
     */
    _sanitizeCivitaiHtml(html) {
        const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
        doc.querySelectorAll('script,style,iframe,object,embed,link,meta,form,input,textarea,button,svg,img,video,audio,source')
            .forEach((el) => el.remove());
        const allowed = new Set([
            'P', 'BR', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
            'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'CODE', 'PRE', 'A',
            'UL', 'OL', 'LI', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD',
            'SPAN', 'DIV', 'SUP', 'SUB', 'CENTER', 'FIGURE', 'FIGCAPTION'
        ]);
        for (const el of [...doc.body.querySelectorAll('*')]) {
            if (!el.isConnected) continue;   // 随危险标签一并移除的节点
            if (!allowed.has(el.tagName)) {
                el.replaceWith(...el.childNodes);   // 解包：文字保留，标签壳丢弃
                continue;
            }
            // 属性清理：getAttributeNames + removeAttribute（不依赖 Attr.remove，
            // 后者在部分浏览器环境返回的遍历项上不可用——曾致整窗崩溃）
            for (const name of el.getAttributeNames()) {
                const keep = el.tagName === 'A' && name === 'href' && /^https?:\/\//i.test(el.getAttribute(name));
                if (!keep) el.removeAttribute(name);
            }
            if (el.tagName === 'A') {
                el.setAttribute('target', '_blank');
                el.setAttribute('rel', 'noopener noreferrer');
            }
        }
        return doc.body.innerHTML;
    }

    /**
     * 打开 LoRA 信息窗（居中弹窗）：名称/目录/大小/修改时间 + 封面预览，
     * 封面可从画布或本地图片更换（写成 sidecar 预览文件）
     * @param {Object} lora - lora 数据（path/name/folder/sizeBytes/mtime）
     */
    open(lora) {
        const host = this.host;
        host._closeInfoModal();
        host._infoLora = lora;
        const overlay = document.createElement('div');
        overlay.className = 'lora-info-overlay';
        const bust = host._bustMap && host._bustMap[lora.path];
        overlay.innerHTML = `
            <div class="lora-info-panel">
                <header class="lora-info-header">
                    <span class="lora-info-title"></span>
                    <button type="button" class="lora-info-delete" title="删除此 LoRA（含源文件）">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                    </button>
                    <button type="button" class="lora-info-close" title="关闭" style="margin-left: auto;">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </header>
                <div class="lora-info-body">
                    <div class="lora-info-cover">
                        <img alt="封面">
                        <div class="lora-info-placeholder hidden"></div>
                    </div>
                    <div class="lora-info-meta">
                        <div class="lora-info-row"><span class="lora-info-key">名称</span><span class="lora-info-val lora-info-name"></span></div>
                        <div class="lora-info-row"><span class="lora-info-key">目录</span><span class="lora-info-val lora-info-folder"></span></div>
                        <div class="lora-info-row"><span class="lora-info-key">底模</span><span class="lora-info-val lora-info-basemodel"></span></div>
                        <div class="lora-info-row"><span class="lora-info-key">大小</span><span class="lora-info-val lora-info-size"></span></div>
                        <div class="lora-info-row"><span class="lora-info-key">修改时间</span><span class="lora-info-val lora-info-mtime"></span></div>
                        <div class="lora-info-row"><span class="lora-info-key">Hash</span><span class="lora-info-val lora-info-hash" title="文件 SHA256（本地计算）">计算中…</span></div>
                    </div>
                </div>
                <div class="lora-trigger-block">
                    <div class="lora-trigger-head">
                        <span>触发词</span>
                        <div class="lora-trigger-tools">
                            <button type="button" class="lora-trigger-copy" title="复制触发词">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                            </button>
                            <button type="button" class="lora-trigger-edit" title="编辑触发词">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                            </button>
                        </div>
                    </div>
                    <div class="lora-trigger-text"></div>
                </div>
                <div class="lora-trigger-block lora-desc-block">
                    <div class="lora-trigger-head">
                        <span>模型说明</span>
                        <div class="lora-trigger-tools">
                            <button type="button" class="lora-desc-copy" title="复制说明（纯文本）">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                            </button>
                        </div>
                    </div>
                    <div class="lora-desc-text"></div>
                </div>
                <div class="lora-info-status"></div>
                <div class="lora-info-actions">
                    <button type="button" class="lora-info-btn lora-info-civitai" title="按文件哈希在 Civitai 检索，拉取封面与触发词">从 Civitai 获取</button>
                    <button type="button" class="lora-info-btn lora-info-civitai-page" title="在系统默认浏览器打开 Civitai 模型页（带登录态）">civitai页面</button>
                    <button type="button" class="lora-info-btn">从画布选择</button>
                    <button type="button" class="lora-info-btn">上传本地图片</button>
                    <button type="button" class="lora-info-btn lora-info-reveal">打开所在文件夹</button>
                </div>
            </div>
        `;
        overlay.querySelector('.lora-info-title').textContent = lora.name;
        overlay.querySelector('.lora-info-name').textContent = lora.name;
        overlay.querySelector('.lora-info-folder').textContent = lora.folder || '（根目录）';
        // 底模：取自 Civitai 拉取记录（meta.civitai.baseModel），未获取过显示占位
        overlay.querySelector('.lora-info-basemodel').textContent =
            (host.civitai && host.civitai[lora.path] && host.civitai[lora.path].baseModel) || '—';
        overlay.querySelector('.lora-info-size').textContent = (lora.sizeBytes / 1048576).toFixed(1) + ' MB';
        overlay.querySelector('.lora-info-mtime').textContent =
            lora.mtime ? new Date(lora.mtime).toLocaleString() : '—';

        // Hash 行：后端按需计算本地 SHA256（有缓存秒回），点击复制完整值；
        // 有 C 站拉取记录时顺带比对——不一致说明本地文件是重打包版（这也是
        // 按哈希查不到该模型的直接原因）
        const hashEl = overlay.querySelector('.lora-info-hash');
        hashEl.textContent = '计算中…';
        const hashReq = fetch(`/api/lora/civitai/hash?path=${encodeURIComponent(lora.path)}`)
            .then((r) => r.json()).catch(() => null);
        hashReq.then((r) => {
            if (host._infoOverlay !== overlay || !r || r.status !== 'ok') {
                if (host._infoOverlay === overlay && (!r || r.status !== 'ok')) hashEl.textContent = '—';
                return;
            }
            hashEl.textContent = r.sha256.slice(0, 16) + '…';
            hashEl.classList.add('copyable');
            hashEl.dataset.full = r.sha256;
            hashEl.title = r.sha256 + '\n点击复制完整 Hash';
            if (r.civitaiSha256) {
                const mark = document.createElement('span');
                if (r.match) {
                    mark.className = 'lora-hash-mark ok';
                    mark.textContent = '✓ 与 C 站一致';
                } else {
                    mark.className = 'lora-hash-mark diff';
                    mark.textContent = '≠ 与 C 站不一致';
                    hashEl.title += '\n本地文件与 C 站官方文件的 SHA256 不同（可能是重打包版），这也是按哈希检索不到它的原因';
                }
                hashEl.appendChild(mark);
            }
        });
        hashEl.addEventListener('click', async () => {
            const full = hashEl.dataset.full;
            if (!full) return;
            try {
                await navigator.clipboard.writeText(full);
                host._infoStatus('✅ Hash 已复制');
            } catch {
                const ta = document.createElement('textarea');
                ta.value = full;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand('copy'); host._infoStatus('✅ Hash 已复制'); } catch { /* 兜底失败静默 */ }
                ta.remove();
            }
        });

        // 封面预览（加载失败显示占位）
        const preview = overlay.querySelector('.lora-info-cover img');
        const ph = overlay.querySelector('.lora-info-placeholder');
        preview.addEventListener('error', () => {
            preview.classList.add('hidden');
            ph.classList.remove('hidden');
        });
        preview.src = `/api/lora/preview?path=${encodeURIComponent(lora.path)}${bust ? `&t=${bust}` : ''}`;

        const [btnCanvas, btnLocal, btnReveal] = overlay.querySelectorAll('.lora-info-btn:not(.lora-info-civitai):not(.lora-info-civitai-page)');
        // C 站页面按钮：有拉取记录（meta.civitai.pageUrl）才点亮，否则暗态禁用
        const btnPage = overlay.querySelector('.lora-info-civitai-page');
        const pageInfo = host.civitai && host.civitai[lora.path];
        if (pageInfo && pageInfo.pageUrl) {
            btnPage.title = `在系统默认浏览器打开：${pageInfo.modelName || lora.name}` +
                (pageInfo.versionName ? `（${pageInfo.versionName}）` : '');
            btnPage.addEventListener('click', async () => {
                // 走后端调起系统默认浏览器：应用所在浏览器（如 IDE 内置预览）
                // 是独立 profile，没有用户日常浏览器的 Civitai 登录 Cookie
                try {
                    const resp = await fetch('/api/lora/civitai/open-page', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url: pageInfo.pageUrl })
                    });
                    const r = await resp.json().catch(() => null);
                    if (!resp.ok || !r || r.status !== 'ok') {
                        throw new Error(r?.message || `打开失败（HTTP ${resp.status}）`);
                    }
                } catch (err) {
                    host._infoStatus('❌ ' + (err.message || err), true);
                }
            });
        } else {
            btnPage.classList.add('disabled');
            btnPage.disabled = true;
            btnPage.title = '尚未从 Civitai 获取过该 LoRA（无页面链接）';
        }
        // 从 Civitai 获取（单只）：已有手填触发词先问冲突策略，成功后刷新触发词与封面
        overlay.querySelector('.lora-info-civitai').addEventListener('click', async () => {
            try {
                const hasTriggers = ((host.triggers && host.triggers[lora.path]) || '').trim();
                let onConflict = 'merge';
                if (hasTriggers) {
                    onConflict = await host._askCivitaiConflict('已有触发词',
                        `「${lora.name}」已有手填触发词，从 Civitai 拉到的触发词如何处理？`);
                    if (!onConflict) return;   // 取消
                }
                host._infoStatus('⏳ 正在从 Civitai 获取（首次需计算文件哈希，大文件较慢）…');
                const resp = await fetch('/api/lora/civitai/fetch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: lora.path, onConflict, skipCustomCover: true })
                });
                const r = await resp.json().catch(() => null);
                if (!resp.ok || !r) throw new Error(`请求失败（HTTP ${resp.status}）`);
                if (r.status === 'not-found') {
                    host._infoStatus('未在 Civitai 找到该 LoRA（可能未收录）', true);
                    return;
                }
                if (r.status === 'error') throw new Error(r.error || '获取失败');
                if (r.triggersUpdated && r.triggers) host.triggers[lora.path] = r.triggers;
                if (r.info) {
                    host.civitai = host.civitai || {};
                    host.civitai[lora.path] = r.info;   // pageUrl 随之点亮「C 站页面」按钮
                }
                if (r.coverUpdated) {
                    host._bustMap = host._bustMap || {};
                    host._bustMap[lora.path] = Date.now();   // 绕过 /preview 的 1 天浏览器缓存
                }
                // 重建信息窗让触发词/封面立即反映新数据
                host._closeInfoModal();
                host._openInfoModal(lora);
                let msg = '✅ 已获取';
                if (r.info && (r.info.modelName || r.info.versionName || r.info.baseModel)) {
                    msg += `：${r.info.modelName || ''}${r.info.versionName ? ' / ' + r.info.versionName : ''}${r.info.baseModel ? '（' + r.info.baseModel + '）' : ''}`;
                }
                if (r.coverSkipped) msg += '；封面为自定义内容已跳过';
                if (r.coverError) msg += `；封面下载失败：${r.coverError}`;
                host._infoStatus(msg);
                host._renderGrid();
            } catch (err) {
                host._infoStatus('❌ ' + (err.message || err), true);
            }
        });
        btnCanvas.addEventListener('click', () => host._openCanvasPicker(lora));
        btnLocal.addEventListener('click', () => host._fileInput.click());
        btnReveal.addEventListener('click', async () => {
            try {
                const resp = await fetch('/api/lora/reveal', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: lora.path })
                });
                const r = await resp.json().catch(() => null);
                if (!resp.ok || !r || r.status !== 'ok') {
                    throw new Error(r?.message || `打开失败（HTTP ${resp.status}；若刚更新过程序请重启后端）`);
                }
            } catch (err) {
                host._infoStatus('❌ ' + (err.message || err), true);
            }
        });

        overlay.querySelector('.lora-info-delete').addEventListener('click', () => host._confirmDelete(lora));

        // 触发词/备注两个文本块（结构样式同款，编辑逻辑共用）
        host.triggers = host.triggers || {};
        host.notes = host.notes || {};
        this._wireMetaTextBlock(overlay, lora, {
            textSel: '.lora-trigger-text', editSel: '.lora-trigger-edit',
            copySel: '.lora-trigger-copy', copyTitle: '复制触发词',
            kind: 'trigger', store: 'triggers', label: '触发词',
            emptyText: '无需触发词', placeholder: '逗号分隔多个触发词，留空清除'
        });
        // 备注编辑框已按需求移除（历史备注数据仍保留在 lora-meta.json，
        // 后端 /note 接口未动）

        // 模型说明：净化后的 HTML 按原排版渲染（整窗滚动查看全文）；
        // 无记录显示占位——重新「从 Civitai 获取」即可补齐
        const descEl = overlay.querySelector('.lora-desc-text');
        const descHtml = (host.civitai && host.civitai[lora.path] && host.civitai[lora.path].description) || '';
        if (descHtml) {
            try {
                descEl.innerHTML = this._sanitizeCivitaiHtml(descHtml);
            } catch (err) {
                // 净化/渲染兜底：绝不让说明渲染问题阻断整个信息窗（曾致卡片点不开）
                console.warn('[lora] 模型说明渲染失败，降级为纯文本:', err);
                descEl.textContent = String(descHtml).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            }
        } else {
            descEl.classList.add('empty');
            descEl.textContent = '未获取模型说明 —— 点「从 Civitai 获取」拉取（旧记录重新获取即可补齐）';
        }
        // 复制说明：复制渲染后的纯文本（innerText），非原始 HTML
        overlay.querySelector('.lora-desc-copy').addEventListener('click', async () => {
            const text = (descEl.innerText || '').trim();
            if (!text) return;
            try {
                await navigator.clipboard.writeText(text);
            } catch {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand('copy'); } catch { /* 兜底失败静默 */ }
                ta.remove();
            }
            const copyBtn = overlay.querySelector('.lora-desc-copy');
            copyBtn.classList.add('copied');
            copyBtn.title = '已复制';
            setTimeout(() => { copyBtn.classList.remove('copied'); copyBtn.title = '复制说明（纯文本）'; }, 1500);
        });

        overlay.addEventListener('mousedown', (e) => {
            if (e.target === overlay) host._closeInfoModal();
        });
        overlay.querySelector('.lora-info-close').addEventListener('click', () => host._closeInfoModal());

        // 滚轮转发：信息窗开着时主页面永不滚动——光标在面板内走原生滚动
        // （overscroll-behavior 已断链）；在卡片外的遮罩上时，滚轮改滚卡片本身
        const infoPanel = overlay.querySelector('.lora-info-panel');
        overlay.addEventListener('wheel', (e) => {
            if (infoPanel.contains(e.target)) return;
            e.preventDefault();
            infoPanel.scrollTop += e.deltaY;
        }, { passive: false });

        document.body.appendChild(overlay);
        host._infoOverlay = overlay;
    }

    /** 关闭信息窗（画布选图浮层一并关闭） */
    close() {
        const host = this.host;
        host._pickerOverlay?.remove();
        host._pickerOverlay = null;
        host._infoOverlay?.remove();
        host._infoOverlay = null;
        host._infoLora = null;
    }

    /** 在信息窗状态行显示一条临时提示（2.5 秒后清除） */
    status(text, isError) {
        const el = this.host._infoOverlay?.querySelector('.lora-info-status');
        if (!el) return;
        el.textContent = text || '';
        el.classList.toggle('error', !!isError);
        if (text) {
            clearTimeout(this._infoStatusTimer);
            this._infoStatusTimer = setTimeout(() => {
                el.textContent = '';
                el.classList.remove('error');
            }, 2500);
        }
    }
}

window.LoraInfoModal = LoraInfoModal;
