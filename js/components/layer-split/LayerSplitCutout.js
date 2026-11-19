/**
 * LayerSplit 子模块：切片抠图（Object.assign 进 LayerSplit.prototype，2026-11-13）
 * 本地抠图服务（POST /api/rembg，onnxruntime 跑 BEN2/RMBG，见
 * routes/rembg.js）：矩形裁切的切片带着图标外的边框/背景，抠图后变
 * 透明底干净元素。逐层触发 + 可选批量；origSrc 记矩形原图可随时还原。
 * 挖洞联动：抠图后的切片在 AI 补齐里按不透明像素 bbox 算洞（_opaqueBbox，
 * expandHole 外扩）。
 * 本地去底（2026-11-14 迁自 image-to-slice removeEdgeBackground）：双阈值
 * 色键抠纯色底（水滴按钮），零模型零成本带软边；也是 AI 拆图提取结果
 * 非透明时的中间回退（救不回才矩形降级）。
 */

Object.assign(LayerSplit.prototype, {

    /** 单层抠图核心：本地 rembg 模型（免费、确定性）。2026-11-14 用户
     *  反馈「剪刀怎么用的是 API」——API/Comfy 模式开关只管补齐，抠图
     *  恒走本地模型（剪刀 tooltip 本来就承诺「本地模型」） */
    async _cutoutLayer(layer, label) {
        if (layer.kind !== 'slice') {
            this.status('背景层不参与抠图（主体分离对整图无意义）', true);
            return false;
        }
        return this._cutoutLayerRembg(layer, label);
    },

    /** 本地去底点击入口 */
    async _localKeyClick(layer) {
        await this._runLayerCutoutTask(layer, async () => {
            const ok = await this._cutoutLayerLocal(layer);
            if (ok) this.status(`已去底：${layer.name}（不满意可「还原裁切」后换剪刀或 ☁ 重抠）`);
        });
    },

    /** 本地去底核心：双阈值色键把纯色/近纯色背景抠成透明（硬阈值全透 +
     *  软阈值 alpha 线性渐变保抗锯齿软边）。没抠到东西（背景花色）时不
     *  落地，如实提示换模型 */
    async _cutoutLayerLocal(layer, label) {
        if (layer.kind !== 'slice') {
            this.status('背景层不参与去底', true);
            return false;
        }
        try {
            const img = await this._loadImage(layer.src);
            const w = img.naturalWidth, h = img.naturalHeight;
            if (!w || !h) throw new Error('图层图片未就绪');
            const cv = document.createElement('canvas');
            cv.width = w;
            cv.height = h;
            const ctx = cv.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            const imageData = ctx.getImageData(0, 0, w, h);
            const bg = LayerSplit.sampleEdgeBackground(imageData.data, w, h);
            const keyed = LayerSplit.colorKeyTransparent(imageData.data, w, h, bg);
            if (keyed === 0) {
                this.status(`本地去底没抠到东西（${layer.name}）：背景不是纯色/近纯色——试试 AI 抠图或本地模型`, true);
                return false;
            }
            ctx.putImageData(imageData, 0, 0);
            if (!layer.origSrc) layer.origSrc = layer.src;
            layer.src = cv.toDataURL('image/png');
            layer._imgSrc = null;
            this._renderStage();
            this._renderLayerPanel(this.sideBody);
            this._pushHistory();
            return true;
        } catch (err) {
            this.status(`本地去底失败（${layer.name}）：` + ((err && err.message) || err), true);
            return false;
        }
    },

    /** 整画布色键去底（AI 拆图非透明输出的中间回退）：模型不支持透明
     *  输出时先试本地色键——纯色底能救回真 alpha，比直接退化矩形切片
     *  强一档；成功与否由调用方再探测判定
     * @param {HTMLCanvasElement} canvas - 就地修改
     * @returns {boolean} 是否有像素被抠透
     */
    _colorKeyCanvas(canvas) {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const bg = LayerSplit.sampleEdgeBackground(imageData.data, canvas.width, canvas.height);
        const keyed = LayerSplit.colorKeyTransparent(imageData.data, canvas.width, canvas.height, bg);
        if (keyed > 0) ctx.putImageData(imageData, 0, 0);
        return keyed > 0;
    },

    /** Comfy（本地）通道：POST /api/rembg，BEN2/RMBG 在用户显卡上跑 */
    async _cutoutLayerRembg(layer, label) {
        if (!window.SettingsManager || !window.SettingsManager.getActiveRembgModel) {
            this.status('设置管理器不可用', true);
            return false;
        }
        const model = window.SettingsManager.getActiveRembgModel();
        this.status(`抠图中（${label || layer.name}）：${model || '默认模型'}…`);
        try {
            const r = await fetch('/api/rembg', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imageData: layer.src, model })
            });
            const data = await r.json().catch(() => null);
            if (!r.ok || !data || data.status !== 'ok' || !data.image) {
                throw new Error((data && data.message) || `HTTP ${r.status}`);
            }
            if (!layer.origSrc) layer.origSrc = layer.src;   // 记矩形裁切原图（可还原/换模型重抠）
            layer.src = data.image;
            layer._imgSrc = null;   // 强制舞台重载
            this._renderStage();
            this._renderLayerPanel(this.sideBody);
            this._pushHistory();
            return true;
        } catch (err) {
            const msg = err instanceof TypeError ? '无法连接后端抠图服务' : ((err && err.message) || err);
            const hint = /模型|下载/.test(msg)
                ? '——可到 设置 → 抠图 下载本地模型，或先用「本地去底」（水滴钮，纯色底适用）'
                : '';
            this.status(`抠图失败（${layer.name}）：` + msg + hint, true);
            return false;
        }
    },

    /** 边缘像素复制填充（image-to-slice prepareAiInpaintInputs 的
     *  sharp extend copy 画布等价）：contentBox 之外的留白用紧邻边缘
     *  1px 条带拉伸铺满——模型看不到空白边界，不会把留白当内容脑补 */
    _extendPadEdges(ctx, plan) {
        const { W, H, x, y, contentW, contentH } = plan;
        const right = W - x - contentW;
        const bottom = H - y - contentH;
        if (x > 0) ctx.drawImage(ctx.canvas, x, y, 1, contentH, 0, y, x, contentH);
        if (right > 0) ctx.drawImage(ctx.canvas, x + contentW - 1, y, 1, contentH, x + contentW, y, right, contentH);
        if (y > 0) ctx.drawImage(ctx.canvas, x, y, contentW, 1, x, 0, contentW, y);
        if (bottom > 0) ctx.drawImage(ctx.canvas, x, y + contentH - 1, contentW, 1, x, y + contentH, contentW, bottom);
        // 四角：取内容四角 1px 像素拉伸填角落
        if (x > 0 && y > 0) ctx.drawImage(ctx.canvas, x, y, 1, 1, 0, 0, x, y);
        if (right > 0 && y > 0) ctx.drawImage(ctx.canvas, x + contentW - 1, y, 1, 1, x + contentW, 0, right, y);
        if (x > 0 && bottom > 0) ctx.drawImage(ctx.canvas, x, y + contentH - 1, 1, 1, 0, y + contentH, x, bottom);
        if (right > 0 && bottom > 0) ctx.drawImage(ctx.canvas, x + contentW - 1, y + contentH - 1, 1, 1, x + contentW, y + contentH, right, bottom);
    },

    /** AI（云端）抠图（切片行 ☁ 按钮，2026-11-14 恢复为按需选项）：
     *  /api/llm/generate-image 去背景——效果依模型而定（gpt-image 系
     *  支持透明输出，部分模型会输出不透明图）；按张计费。
     *  尺寸闭环（2026-11-14 用户报「AI 抠图后尺寸变了」）：切片 contain
     *  等比缩放到宽高比三档标准档（planCutoutResize）+ 边缘填充 → 带
     *  size 发送（输出尺寸锁死在该档）→ 输出裁回 contentBox → 缩放回
     *  切片原尺寸——宽高比零变形零留白（原库补齐路径 prepare/restore
     *  同款算法移植；其 AI 透明路径无闭环靠宽高比分档容忍小变形，我们
     *  直接做闭环） */
    async _cutoutLayerAi(layer, label) {
        const modelChoice = this._parseModelChoice(this.inpaintModel);
        if (!modelChoice.id) {
            this.status('AI 抠图用补齐模型去背景——先在右侧选补齐模型', true);
            return false;
        }
        const bw = layer.bbox[2], bh = layer.bbox[3];
        const plan = LayerSplit.planCutoutResize(bw, bh);
        this.status(`AI 抠图中（${label || layer.name}）：${modelChoice.id} 云端去背景（按张计费，输入 ${plan.size}）…`);
        try {
            // ===== 发送前准备：contain 缩放 + 边缘填充 =====
            const srcImg = await this._loadImage(layer.src);
            const sendCv = document.createElement('canvas');
            sendCv.width = plan.W;
            sendCv.height = plan.H;
            const sctx = sendCv.getContext('2d');
            sctx.drawImage(srcImg, 0, 0, srcImg.naturalWidth, srcImg.naturalHeight,
                plan.x, plan.y, plan.contentW, plan.contentH);
            this._extendPadEdges(sctx, plan);
            const r = await fetch('/api/llm/generate-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: modelChoice.id,
                    prompt: LayerSplit.CUTOUT_PROMPT,
                    images: [sendCv.toDataURL('image/png')],
                    size: plan.size,
                    provider: modelChoice.provider || ''
                })
            });
            const result = await r.json().catch(() => null);
            if (!r.ok || !result || result.status !== 'ok' || !result.imageUrl) {
                throw new Error((result && result.message) || `HTTP ${r.status}`);
            }
            const raw = /^data:/.test(result.imageUrl)
                ? result.imageUrl
                : await this._fetchAsDataUrl(result.imageUrl);
            // ===== 回收闭环：铺到档位画布 → 裁回 contentBox → 缩回原尺寸 =====
            const rawImg = await this._loadImage(raw);
            const tierCv = document.createElement('canvas');
            tierCv.width = plan.W;
            tierCv.height = plan.H;
            tierCv.getContext('2d').drawImage(rawImg, 0, 0, plan.W, plan.H);
            const cv = document.createElement('canvas');
            cv.width = bw;
            cv.height = bh;
            cv.getContext('2d').drawImage(tierCv,
                plan.x, plan.y, plan.contentW, plan.contentH,
                0, 0, bw, bh);
            // 输出不透明时试本地色键救 alpha（救不回如实提示）
            const probe = this._probeMattedAlpha(cv) || this._colorKeyCanvas(cv);
            if (!layer.origSrc) layer.origSrc = layer.src;
            layer.src = cv.toDataURL('image/png');
            layer._imgSrc = null;
            this._renderStage();
            this._renderLayerPanel(this.sideBody);
            this._pushHistory();
            if (!probe) {
                this.status(`AI 抠图完成（${layer.name}），但模型输出不含透明通道（色键也没救回）——建议换 gpt-image 系模型`, true);
            }
            return true;
        } catch (err) {
            const msg = err instanceof TypeError ? '无法连接后端服务' : ((err && err.message) || err);
            this.status(`AI 抠图失败（${layer.name}）：` + msg, true);
            return false;
        }
    },

    /** 逐层抠图任务并发壳（2026-11-14 用户「不能多任务同时进行吗」）：
     *  锁粒度=图层——同一层同时只跑一个抠图类任务，不同层可并发（API
     *  天然并发；本地 rembg 并发也只是 GPU 内排队，无害）。运行中禁用
     *  该行三个抠图按钮 */
    async _runLayerCutoutTask(layer, taskFn) {
        if (layer._cutoutBusy) {
            this.status(`「${layer.name}」有抠图任务进行中，稍候（其他图层可同时跑）`, true);
            return;
        }
        layer._cutoutBusy = true;
        const setRowDisabled = (disabled) => {
            const row = this.dialog &&
                this.dialog.querySelector(`.ls-layer-item[data-layer-id="${layer.id}"]`);
            if (!row) return;
            row.querySelectorAll('.ls-layer-cutout, .ls-layer-key, .ls-layer-cutout-ai')
                .forEach((b) => { b.disabled = disabled; });
        };
        setRowDisabled(true);
        try {
            await taskFn();
        } finally {
            layer._cutoutBusy = false;
            setRowDisabled(false);
        }
    },

    /** AI 抠图点击入口 */
    async _cutoutAiClick(layer) {
        await this._runLayerCutoutTask(layer, async () => {
            const ok = await this._cutoutLayerAi(layer);
            if (ok) this.status(`已 AI 抠图：${layer.name}（不满意可「还原裁切」后换通道重抠）`);
        });
    },

    /** 图层面板「抠图」（本地 rembg）按钮 */
    async _cutoutLayerClick(layer) {
        await this._runLayerCutoutTask(layer, async () => {
            await this._cutoutLayer(layer);
            this.status(`已抠图：${layer.name}（想换模型重抠先「还原裁切」再抠）`);
        });
    },

    /** 工具栏「全部抠图」：可见切片串行跑（本地 GPU 一张张最稳），带进度；
     *  串行期间每层占 _cutoutBusy——单层按钮与批量互斥，批量之间互斥。
     *  与逐层 AI 抠图/补齐不互斥：不同层可穿插并发 */
    async _cutoutAllLayers() {
        if (this._cutoutBatchRunning) {
            this.status('批量抠图进行中，稍候', true);
            return;
        }
        const targets = this.layers.filter((l) => l.kind === 'slice' && l.visible && !l._cutoutBusy);
        if (!targets.length) {
            this.status('没有可批量抠图的切片（背景层不参与；正在跑的层跳过）', true);
            return;
        }
        this._cutoutBatchRunning = true;
        const btn = this.dialog.querySelector('.ls-act-cutout-all');
        if (btn) { btn.disabled = true; btn.textContent = '抠图中…'; }
        let ok = 0, fail = 0;
        try {
            for (let i = 0; i < targets.length; i++) {
                const layer = targets[i];
                layer._cutoutBusy = true;
                this.status(`批量抠图中 ${i + 1}/${targets.length}：${layer.name}…`);
                try {
                    const done = await this._cutoutLayer(layer, `${i + 1}/${targets.length}`);
                    done ? ok++ : fail++;
                } finally {
                    layer._cutoutBusy = false;
                }
            }
        } finally {
            this._cutoutBatchRunning = false;
            if (btn) { btn.disabled = false; btn.textContent = '全部抠图'; }
        }
        this.status(fail === 0
            ? `全部抠图完成（${ok} 张），透明底切片已就位`
            : `抠图完成：成功 ${ok} 张、失败 ${fail} 张（失败的可单独重试）`, fail > 0);
    },

    /** 图层面板「还原裁切」：回到矩形裁切原图（抠坏了/想换模型重抠） */
    _restoreLayerCrop(layer) {
        if (!layer.origSrc) return;
        layer.src = layer.origSrc;
        layer.origSrc = null;
        layer._imgSrc = null;
        this._renderStage();
        this._renderLayerPanel(this.sideBody);
        this._pushHistory();
        this.status(`已还原矩形裁切：${layer.name}`);
    },

    /** 抠图切片的实际占地区域（不透明像素 bbox，图像坐标）。
     *  给 AI 补齐挖洞用：矩形 bbox 是偏大超集，按 alpha 扫描能少补很多。
     *  图片没就绪/全透明时回退矩形 bbox */
    async _opaqueBbox(layer) {
        try {
            const img = (layer._imgEl && layer._imgSrc === layer.src)
                ? layer._imgEl
                : await this._loadImage(layer.src);
            const w = img.naturalWidth, h = img.naturalHeight;
            if (!w || !h) return null;
            const cv = document.createElement('canvas');
            cv.width = w;
            cv.height = h;
            const ctx = cv.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const data = ctx.getImageData(0, 0, w, h).data;
            let minX = w, minY = h, maxX = -1, maxY = -1;
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    if (data[(y * w + x) * 4 + 3] > 8) {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }
            if (maxX < 0) return null;   // 全透明
            return [
                layer.bbox[0] + minX,
                layer.bbox[1] + minY,
                maxX - minX + 1,
                maxY - minY + 1
            ];
        } catch (e) {
            return null;
        }
    },

    // ==================== AI 拆图（API 两调管线，2026-11-13 用户拍板） ====================

    /** API 模式专用：第 1 调整图全前景提取（提示词=用户 gpt2.6 实测成功的
     *  整图提取路线；原图先按比例缩放长边≈2K 再发，细节更好）→ 本地按
     *  勾选框裁出各图层（真 alpha 边缘，输出缩回原尺寸后坐标自动对齐）→
     *  第 2 调补齐背景。两次调用包办全部 AI 工作；提取失败不动现有图层，
     *  补齐失败可单独重试 */
    async _runAiSplit() {
        if (this._aiSplitRunning) return;
        if (!this.sourceImage) return;
        if (this._mode() !== 'api') {
            this.status('Comfy 模式请按顺序手动跑：拆分为图层 → 全部抠图 → AI 补齐背景（全免费）', true);
            return;
        }
        const modelChoice = this._parseModelChoice(this.inpaintModel);
        if (!modelChoice.id) {
            this.status('先在右侧选补齐模型（AI 拆图两调都用它）', true);
            return;
        }
        const picked = this.boxes.filter((b) => b.keep);
        if (!picked.length) {
            this.status('先勾选至少一个框再 AI 拆图', true);
            return;
        }
        this._aiSplitRunning = true;
        const btn = this.dialog.querySelector('.ls-act-ai-split');
        btn.disabled = true;
        btn.textContent = 'AI 拆图中…';
        try {
            const W = this.sourceImage.width, H = this.sourceImage.height;
            // ===== 第 1 调：整图主体提取 =====
            // 原图按比例缩放到长边≈2K 再送模型（gpt-image 2K 档细节最好）；
            // 输出会缩回原尺寸裁层，这里的缩放因子在坐标上自动抵消
            const scale = LayerSplit.EXTRACT_TARGET_EDGE / Math.max(W, H);
            const sW = Math.max(1, Math.round(W * scale));
            const sH = Math.max(1, Math.round(H * scale));
            let sendDataUrl = this.sourceImage.dataUrl;
            if (Math.abs(scale - 1) > 1e-6) {
                const sendCv = document.createElement('canvas');
                sendCv.width = sW;
                sendCv.height = sH;
                sendCv.getContext('2d').drawImage(
                    await this._loadImage(this.sourceImage.dataUrl), 0, 0, sW, sH);
                sendDataUrl = sendCv.toDataURL('image/png');
            }
            this.status(`AI 拆图（第 1/2 次调用）：${modelChoice.id} 提取全部前景主体（输入 ${sW}x${sH}）…`);
            const r = await fetch('/api/llm/generate-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: modelChoice.id,
                    prompt: LayerSplit.resolveExtractPrompt(this.extractPrompt, sW, sH),
                    images: [sendDataUrl],
                    size: `${sW}x${sH}`,
                    provider: modelChoice.provider || ''
                })
            });
            const result = await r.json().catch(() => null);
            if (!r.ok || !result || result.status !== 'ok' || !result.imageUrl) {
                throw new Error((result && result.message) || `HTTP ${r.status}`);
            }
            const raw = /^data:/.test(result.imageUrl)
                ? result.imageUrl
                : await this._fetchAsDataUrl(result.imageUrl);
            // 缩放回原图尺寸（云端输出画幅不受控）：contain 等比居中 +
            // 透明补边——硬拉伸会在画幅不符时系统性错位按框裁层（2026-11-19
            // 精抠方案配套修复）；输出与请求同画幅时 contain 等价 1:1 铺满
            const rawImg = await this._loadImage(raw);
            const matted = document.createElement('canvas');
            matted.width = W;
            matted.height = H;
            const fitScale = Math.min(W / (rawImg.naturalWidth || W), H / (rawImg.naturalHeight || H));
            const fitW = Math.max(1, Math.round((rawImg.naturalWidth || W) * fitScale));
            const fitH = Math.max(1, Math.round((rawImg.naturalHeight || H) * fitScale));
            matted.getContext('2d').drawImage(rawImg,
                Math.round((W - fitW) / 2), Math.round((H - fitH) / 2), fitW, fitH);
            // 透明度校验：模型不支持透明输出时先试本地色键救回真 alpha
            // （纯色底能救——比直接退化矩形切片强一档），救不回才矩形降级
            let usedColorKey = false;
            let alphaInfo = this._probeMattedAlpha(matted);
            if (!alphaInfo && this._colorKeyCanvas(matted)) {
                alphaInfo = this._probeMattedAlpha(matted);
                usedColorKey = alphaInfo;   // 色键后探到透明 = 色键救回
            }
            // ===== 本地裁层：按勾选框直接裁提取结果（模型输出的真实像素） =====
            const layers = [{
                id: this._layerSeq++, name: '背景', kind: 'background',
                src: this.sourceImage.dataUrl, bbox: [0, 0, W, H],
                visible: true, opacity: 1
            }];
            for (const box of picked) {
                const [x, y, w, h] = box.bbox;
                const cv = document.createElement('canvas');
                cv.width = w;
                cv.height = h;
                cv.getContext('2d').drawImage(matted, x, y, w, h, 0, 0, w, h);
                layers.push({
                    id: this._layerSeq++, name: box.name, kind: 'slice',
                    src: cv.toDataURL('image/png'), bbox: box.bbox.slice(),
                    visible: true, opacity: 1
                });
            }
            this.layers = layers;
            this.activeLayerId = layers[layers.length - 1].id;
            this._setPhase('edit');
            this._pushHistory();
            if (!alphaInfo) {
                this.status('提取完成，但模型输出不含透明通道（本地色键也没救回，切片是矩形内容）——建议换 gpt-image 系模型；继续第 2 次调用补背景…');
            } else if (usedColorKey) {
                this.status('提取完成：模型输出不透明，已用本地色键抠出透明底（纯色底适用）——继续第 2 次调用补背景…');
            }
            // ===== 第 2 调：背景补齐（复用既有链路，API 模式） =====
            await this._runInpaint();
            if (!alphaInfo) {
                // 补齐状态会盖掉提取阶段的警告——收尾重申（红字驻留）
                this.status('提醒：该模型输出不含透明通道，切片是矩形内容——建议换 gpt-image 系模型重跑「AI 拆图」', true);
            }
        } catch (err) {
            this.status('AI 拆图失败：' + ((err && err.message) || err), true);
        } finally {
            this._aiSplitRunning = false;
            btn.disabled = false;
            btn.textContent = 'AI 拆图';
        }
    },

    /** 逐层精抠（2026-11-19 方案一，用户拍板）：整图一调提取不守坐标契约
     *  （模型重排版导致按框裁层全错位），改为每个勾选框单独一调——发送
     *  框区域+外扩边距裁片（档位闭环 planCutoutResize+边缘填充，☁ AI 抠图
     *  同款），提示词点名元素（box.name/kind），回收端不信坐标：本地 alpha
     *  连通域重新定位 + 抖动/补全两态对齐。坐标权威从模型收归 alpha 几何。
     *  N 个元素 = N 次调用（按张计费），单个失败不拖垮整批；成功后自动
     *  补齐被遮住的背景（此时切片带真 alpha，挖洞是轮廓级的，特别准） */
    async _runAiSplitPrecise() {
        if (this._preciseRunning) return;
        if (!this.sourceImage) return;
        if (this._mode() !== 'api') {
            this.status('逐层精抠走云端模型（API 模式）——Comfy 模式请用「拆分为图层 → 抠图 → AI 补齐」', true);
            return;
        }
        const modelChoice = this._parseModelChoice(this.inpaintModel);
        if (!modelChoice.id) {
            this.status('先在右侧选补齐模型（精抠用它点名提取）', true);
            return;
        }
        const picked = this.boxes.filter((b) => b.keep);
        if (!picked.length) {
            this.status('先勾选至少一个框再逐层精抠', true);
            return;
        }
        if (!confirm(`逐层精抠：对 ${picked.length} 个元素各调用 1 次「${modelChoice.id}」生成透明图层（按张计费）。确认开始？`)) return;
        this._preciseRunning = true;
        const btn = this.dialog.querySelector('.ls-act-ai-split-precise');
        btn.disabled = true;
        btn.textContent = '精抠中…';
        const failures = [];
        const okLayers = [];
        try {
            const W = this.sourceImage.width, H = this.sourceImage.height;
            const srcImg = await this._loadImage(this.sourceImage.dataUrl);
            for (let i = 0; i < picked.length; i++) {
                const box = picked[i];
                this.status(`精抠中 ${i + 1}/${picked.length}：${box.name}…`);
                try {
                    const layer = await this._preciseCutOne(box, srcImg, W, H);
                    if (layer) okLayers.push(layer);
                    else failures.push(`${box.name}（输出没有可用前景像素）`);
                } catch (err) {
                    failures.push(`${box.name}（${(err && err.message) || err}）`);
                }
            }
            if (!okLayers.length) {
                this.status(`逐层精抠全部失败：${failures.join('；')}——建议换 gpt-image 系模型重试`, true);
                return;
            }
            const layers = [{
                id: this._layerSeq++, name: '背景', kind: 'background',
                src: this.sourceImage.dataUrl, bbox: [0, 0, W, H],
                visible: true, opacity: 1
            }];
            for (const l of okLayers) layers.push(l);
            this.layers = layers;
            this.activeLayerId = layers[layers.length - 1].id;
            this._setPhase('edit');
            this._pushHistory();
            // 背景补齐（切片带真 alpha → 挖洞是轮廓级）：失败不回滚已成的图层
            await this._runInpaint();
            if (failures.length) {
                this.status(`逐层精抠完成：成功 ${okLayers.length}、失败 ${failures.length}——${failures.join('；')}`, true);
            }
        } catch (err) {
            this.status('逐层精抠失败：' + ((err && err.message) || err), true);
        } finally {
            this._preciseRunning = false;
            btn.disabled = false;
            btn.textContent = '逐层精抠';
        }
    },

    /** 精抢单元素：裁片规划 → 档位发送（点名提示词）→ 档位回收缩回裁片
     *  尺寸 → 透明校验（色键兜底）→ alpha 连通域定位 + 两态对齐 → 紧贴
     *  alpha 裁出切片。返回图层对象；无前景/无透明输出返回 null（不抛），
     *  网络/HTTP 错误抛出由调用方按元素收集 */
    async _preciseCutOne(box, srcImg, W, H) {
        const modelChoice = this._parseModelChoice(this.inpaintModel);
        const { crop, inner } = LayerSplit.planPreciseCrop(box.bbox, W, H);
        const plan = LayerSplit.planCutoutResize(crop[2], crop[3]);
        // ===== 发送端：裁片 → 档位 contain 等比 + 边缘像素填充 =====
        const cropCv = document.createElement('canvas');
        cropCv.width = crop[2];
        cropCv.height = crop[3];
        cropCv.getContext('2d').drawImage(srcImg,
            crop[0], crop[1], crop[2], crop[3], 0, 0, crop[2], crop[3]);
        const sendCv = document.createElement('canvas');
        sendCv.width = plan.W;
        sendCv.height = plan.H;
        sendCv.getContext('2d').drawImage(cropCv,
            0, 0, crop[2], crop[3], plan.x, plan.y, plan.contentW, plan.contentH);
        this._extendPadEdges(sendCv, plan);
        const r = await fetch('/api/llm/generate-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: modelChoice.id,
                prompt: LayerSplit.resolvePrecisePrompt(this.precisePrompt, box.name, box.kind),
                images: [sendCv.toDataURL('image/png')],
                size: plan.size,
                provider: modelChoice.provider || ''
            })
        });
        const result = await r.json().catch(() => null);
        if (!r.ok || !result || result.status !== 'ok' || !result.imageUrl) {
            throw new Error((result && result.message) || `HTTP ${r.status}`);
        }
        const raw = /^data:/.test(result.imageUrl)
            ? result.imageUrl
            : await this._fetchAsDataUrl(result.imageUrl);
        // ===== 回收端：铺档位画布 → 裁回 contentBox → 缩回裁片尺寸 =====
        const rawImg = await this._loadImage(raw);
        const tierCv = document.createElement('canvas');
        tierCv.width = plan.W;
        tierCv.height = plan.H;
        tierCv.getContext('2d').drawImage(rawImg, 0, 0, plan.W, plan.H);
        const outCv = document.createElement('canvas');
        outCv.width = crop[2];
        outCv.height = crop[3];
        const octx = outCv.getContext('2d', { willReadFrequently: true });
        octx.drawImage(tierCv,
            plan.x, plan.y, plan.contentW, plan.contentH,
            0, 0, crop[2], crop[3]);
        // 透明校验：模型不支持透明输出时本地色键救（纯色底能救回真 alpha）
        let hasAlpha = this._probeMattedAlpha(outCv);
        if (!hasAlpha && this._colorKeyCanvas(outCv)) {
            hasAlpha = this._probeMattedAlpha(outCv);
        }
        if (!hasAlpha) return null;
        // ===== alpha 几何定位（坐标权威不在模型）：连通域去噪 → 两态对齐 =====
        const comp = LayerSplit.opaqueBboxFiltered(
            octx.getImageData(0, 0, crop[2], crop[3]).data, crop[2], crop[3]);
        if (!comp) return null;
        const aligned = LayerSplit.alignPreciseSlice(comp.bbox, inner);
        const sliceCv = document.createElement('canvas');
        sliceCv.width = aligned[2];
        sliceCv.height = aligned[3];
        sliceCv.getContext('2d').drawImage(outCv,
            aligned[0], aligned[1], aligned[2], aligned[3],
            0, 0, aligned[2], aligned[3]);
        return {
            id: this._layerSeq++, name: box.name, kind: 'slice',
            src: sliceCv.toDataURL('image/png'),
            bbox: [crop[0] + aligned[0], crop[1] + aligned[1], aligned[2], aligned[3]],
            visible: true, opacity: 1
        };
    },

    /** 采样检测提取结果是否真有透明像素（阈值 8，抽 ~32×32 网格） */
    _probeMattedAlpha(canvas) {
        try {
            const ctx = canvas.getContext('2d');
            const step = Math.max(1, Math.floor(Math.min(canvas.width, canvas.height) / 32));
            for (let y = 0; y < canvas.height; y += step) {
                for (let x = 0; x < canvas.width; x += step) {
                    if (ctx.getImageData(x, y, 1, 1).data[3] < 8) return true;   // 找到透明像素
                }
            }
            return false;
        } catch (e) {
            return true;   // 读取失败按有透明处理，不打断主流程
        }
    },
});
