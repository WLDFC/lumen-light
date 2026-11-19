/**
 * LayerSplit 子模块：AI 背景补齐（Object.assign 进 LayerSplit.prototype）
 * 原理（image-to-slice 语义回退同款）：把各可见切片盖住的区域逐个从背景
 * 挖成透明（不并集成大矩形——切片之间的干净背景保持原样，模型只补元素
 * 形状的小洞）→ 图像编辑模型（图片在前文本在后=编辑形态）补全 → 本地把
 * 模型输出缩放回原图尺寸，逐洞把洞区像素贴回（局部合成，其余像素保持
 * 原始）。洞区经 expandHole 外扩（抗锯齿边缘环一起重画，治白边/鬼影）。
 * 双版本随背景层切换：局部合成 / AI 完整版 / 原始。
 */

Object.assign(LayerSplit.prototype, {

    async _runInpaint() {
        if (this._inpaintRunning) return;
        if (!this.sourceImage) return;
        const bg = this.layers.find((l) => l.kind === 'background');
        if (!bg) {
            this.status('没有背景层（可能已被删除）——重新校准拆分一次', true);
            return;
        }
        // 洞区 = 当前所有可见切片的不透明区域，逐切片计算、逐个挖（不再
        // 并集成一个大矩形：并集矩形会把切片之间的干净背景也清掉，逼模型
        // 整片重画——UI 占画面比例大时补出来的背景就「很奇怪」；散点小洞
        // 模型补得又准又稳）。每个切片都尝试按不透明像素 bbox 收窄（AI 拆
        // 图/抠图切片带真 alpha → 主体轮廓级别的洞；纯矩形裁切片全不透明
        // → 自动回退矩形 bbox）
        const sliceLayers = this.layers.filter((l) => l.kind === 'slice' && l.visible);
        const W = this.sourceImage.width, H = this.sourceImage.height;
        const holes = [];
        for (const l of sliceLayers) {
            const precise = await this._opaqueBbox(l);
            // 洞四周外扩（LayerSplit.expandHole）：不透明 bbox 之外还有
            // 抗锯齿半透明边缘环，精确 bbox 挖洞会把边缘环留在洞边——
            // 补齐后出白边/鬼影；挖洞与贴回共用同一份外扩洞
            holes.push(LayerSplit.expandHole(precise || l.bbox, W, H));
        }
        if (!holes.length) {
            this.status('没有可见切片盖在背景上，无需补齐（想手动指定区域请先显示相关切片）', true);
            return;
        }
        this._inpaintRunning = true;
        try {
            // 1. 挖透明：背景画到画布后清掉洞区（两通道共用）
            const bgImg = await this._loadImage(bg.origSrc || bg.src);
            const holeyCv = document.createElement('canvas');
            holeyCv.width = W;
            holeyCv.height = H;
            const hctx = holeyCv.getContext('2d');
            hctx.drawImage(bgImg, 0, 0);
            for (const [hx, hy, hw, hh] of holes) {
                hctx.clearRect(hx, hy, hw, hh);
            }
            const holeyDataUrl = holeyCv.toDataURL('image/png');
            // 2. 按通道分派
            if (this._mode() === 'comfy') {
                await this._runInpaintComfy(holeyDataUrl, holes);
                return;
            }
            // ===== API 通道 =====
            const modelChoice = this._parseModelChoice(this.inpaintModel);
            if (!modelChoice.id) {
                this.status('先在右侧选择补齐模型（清单来自设置 → API）', true);
                return;
            }
            const btn = this.dialog.querySelector('.ls-act-inpaint');
            btn.disabled = true;
            btn.textContent = '补齐中…';
            this.status(`补齐中：${modelChoice.id} 正在还原被遮住的背景…`);
            // 3. 编辑模型补全（图片在前文本在后=编辑形态；provider 留空）
            const r = await fetch('/api/llm/generate-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: modelChoice.id,
                    prompt: LayerSplit.resolveInpaintPrompt(this.inpaintPrompt, W, H),
                    images: [holeyDataUrl],
                    size: `${W}x${H}`,
                    provider: modelChoice.provider || ''
                })
            });
            const result = await r.json().catch(() => null);
            if (!r.ok || !result || result.status !== 'ok' || !result.imageUrl) {
                throw new Error((result && result.message) || `HTTP ${r.status}`);
            }
            // 远程 URL 经后端代理转 dataURL（canvas 合成防 tainted）
            const fullDataUrl = /^data:/.test(result.imageUrl)
                ? result.imageUrl
                : await this._fetchAsDataUrl(result.imageUrl);
            await this._applyInpaintResult(fullDataUrl, holes);
            this.status('补齐完成：默认应用「局部合成」（只动洞区），可在图层面板切「AI 完整版 / 原始」对比');
        } catch (err) {
            this.status('补齐失败：' + ((err && err.message) || err), true);
        } finally {
            this._inpaintRunning = false;
            const b = this.dialog.querySelector('.ls-act-inpaint');
            b.disabled = false;
            b.textContent = 'AI 补齐背景';
        }
    },

    /** 补齐结果落地（两通道共用）：缩放回原图尺寸 → 逐洞区贴模型输出
     *  （洞与洞之间未被遮挡的背景原封不动）→ 挂背景层 */
    async _applyInpaintResult(src, holes) {
        const W = this.sourceImage.width, H = this.sourceImage.height;
        const bg = this.layers.find((l) => l.kind === 'background');
        if (!bg) throw new Error('背景层已不存在');
        // 同源相对路径直接用；远程 URL 经代理转 dataURL（防 canvas tainted）
        const fullDataUrl = /^data:/.test(src)
            ? src
            : (/^https?:/i.test(src) ? await this._fetchAsDataUrl(src) : src);
        const fullImg = await this._loadImage(fullDataUrl);
        const fullCv = document.createElement('canvas');
        fullCv.width = W;
        fullCv.height = H;
        fullCv.getContext('2d').drawImage(fullImg, 0, 0, W, H);
        const inpaintFull = fullCv.toDataURL('image/png');
        // 局部合成：原背景 + 仅各洞区贴模型输出（其余像素原样）
        const blendCv = document.createElement('canvas');
        blendCv.width = W;
        blendCv.height = H;
        const bctx = blendCv.getContext('2d');
        bctx.drawImage(await this._loadImage(bg.origSrc || bg.src), 0, 0);
        for (const [hx, hy, hw, hh] of (holes || [])) {
            const x = Math.max(0, Math.min(hx, W - 1));
            const y = Math.max(0, Math.min(hy, H - 1));
            const w = Math.min(hw, W - x);
            const h = Math.min(hh, H - y);
            if (w <= 0 || h <= 0) continue;
            bctx.drawImage(fullCv, x, y, w, h, x, y, w, h);
        }
        const inpaintBlended = blendCv.toDataURL('image/png');
        if (!bg.origSrc) bg.origSrc = bg.src;
        bg.inpaintFull = inpaintFull;
        bg.inpaintBlended = inpaintBlended;
        bg.src = inpaintBlended;
        bg._imgSrc = null;   // 强制重载
        this._renderStage();
        this._renderLayerPanel(this.sideBody);
        this._pushHistory();
    },

    // ==================== Comfy 通道（本地工作流） ====================

    /** 拉画布工作流清单进下拉（GET /api/workflows，与右侧面板同源） */
    async _refreshWorkflowDropdown() {
        if (!this._workflowDd) return;
        try {
            const r = await fetch('/api/workflows');
            const data = await r.json().catch(() => null);
            const list = (data && data.workflows) || [];
            this._workflowDd.setOptions(
                list.map((w) => ({ value: w.id, label: w.name || w.id })),
                this.comfyWorkflowId);
        } catch (e) { /* 清单拉取失败保留占位，提交时还会再验 */ }
    },

    /** 工作流 JSON 加载（带缓存）：GET /api/workflows/:id → .workflow（API 格式） */
    async _loadComfyWorkflow(id) {
        this._comfyWfCache = this._comfyWfCache || new Map();
        if (this._comfyWfCache.has(id)) return this._comfyWfCache.get(id);
        const r = await fetch('/api/workflows/' + encodeURIComponent(id));
        const data = await r.json().catch(() => null);
        if (!r.ok || !data || data.status !== 'ok' || !data.workflow) {
            throw new Error((data && data.message) || `HTTP ${r.status}`);
        }
        this._comfyWfCache.set(id, data.workflow);
        return data.workflow;
    },

    /** Comfy 通道补齐：挖洞图直注工作流 LoadImage → /api/comfy-node/run →
     *  lumenGeneratedImage 按 promptId 对位捕获回流（成图会照常落画布——
     *  Comfy 回流惯例，不需要可在画布删掉）。holes=逐切片洞区数组 */
    async _runInpaintComfy(holeyDataUrl, holes) {
        const W = this.sourceImage.width, H = this.sourceImage.height;
        const btn = this.dialog.querySelector('.ls-act-inpaint');
        btn.disabled = true;
        btn.textContent = '补齐中…';
        try {
            if (!this.comfyWorkflowId) {
                throw new Error('先在右侧选补齐工作流（画布工作流清单）');
            }
            const wf = await this._loadComfyWorkflow(this.comfyWorkflowId);
            const scan = window.ComfyParamScanner?.scanLoadImageInputs?.(wf) ||
                { hasReceiveNode: false, loadImageIds: [] };
            if (scan.hasReceiveNode) {
                throw new Error('该工作流含画布取图节点——请用纯 LoadImage 的 inpaint 工作流');
            }
            if (!scan.loadImageIds.length) {
                throw new Error('工作流里没有 LoadImage 节点，吃不了挖洞图');
            }
            this.status(`补齐中：工作流「${this.comfyWorkflowId}」已提交本地 ComfyUI…`);
            const promptIds = [];
            let done = false;
            const taskRef = window.taskRegistry?.register({
                kind: 'panel',
                label: '拆图补齐（Comfy）',
                total: 1,
                onStop: () => {
                    if (promptIds.length) {
                        fetch('/api/comfy-node/stop', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ promptIds })
                        }).catch(() => { });
                    }
                    taskRef.end('stopped', '已取消');
                    finish(new Error('已取消'), holes);
                }
            });
            const finish = async (err, src, holes) => {
                if (done) return;
                done = true;
                window.removeEventListener('lumenGeneratedImage', onGenerated);
                clearTimeout(watchdog);
                if (taskRef && taskRef.isRunning()) {
                    taskRef.end(err ? 'failed' : 'done', err ? err.message : '完成');
                }
                if (err) {
                    this.status('补齐失败：' + err.message, true);
                    return;
                }
                try {
                    await this._applyInpaintResult(src, holes);
                    this.status('补齐完成（Comfy）：默认局部合成，可切版本对比；回流的成图也落在了画布，不需要可删');
                } catch (e2) {
                    this.status('补齐结果处理失败：' + e2.message, true);
                }
            };
            const onGenerated = (e) => {
                const d = e.detail || {};
                if (!promptIds.length || !(d.promptIds || []).includes(promptIds[0])) return;
                finish(null, d.src, holes);
            };
            const watchdog = setTimeout(() => {
                finish(new Error('10 分钟未收到 Comfy 回流（工作流可能没跑完或缺 SaveImage 节点）'));
            }, 600000);
            window.addEventListener('lumenGeneratedImage', onGenerated);
            const r = await fetch('/api/comfy-node/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workflowId: this.comfyWorkflowId,
                    positive: LayerSplit.resolveInpaintPrompt(this.inpaintPrompt, W, H),
                    negative: '',
                    overrides: {},
                    loras: [],
                    bypassLoras: [],
                    images: [holeyDataUrl],
                    imageMapping: { [scan.loadImageIds[0]]: 0 }
                })
            });
            const result = await r.json().catch(() => null);
            if (!r.ok || !result || result.status !== 'ok') {
                throw new Error((result && result.message) || `HTTP ${r.status}`);
            }
            if (result.promptId) promptIds.push(result.promptId);
            this.status('工作流运行中…（完成后自动贴回背景层）');
        } catch (err) {
            this.status('补齐失败：' + ((err && err.message) || err), true);
        } finally {
            this._inpaintRunning = false;
            btn.disabled = false;
            btn.textContent = 'AI 补齐背景';
        }
    },

    /** 远程图片经后端代理取回转 dataURL（跨域画布污染规避） */
    async _fetchAsDataUrl(url) {
        const r = await fetch('/api/llm/download-image?url=' + encodeURIComponent(url));
        if (!r.ok) throw new Error(`图片下载失败 HTTP ${r.status}`);
        const blob = await r.blob();
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error('图片转码失败'));
            reader.readAsDataURL(blob);
        });
    },
});
