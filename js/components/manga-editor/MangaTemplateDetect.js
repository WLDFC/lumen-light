/**
 * ==========================================================================
 * MangaEditor 子模块：从图片识别分镜模板（2026-11-09 新增）
 * 作用：「分镜模板」弹窗头部的「从图片识别」按钮——用户给一张漫画页图
 *       （本地上传 / 画布选图，复用文件菜单双通道），多模态模型识别分镜
 *       格子边界，叠图预览（点击格子可剔除误识别）确认后按模板 schema
 *       存入「我的模板」（/api/manga-templates，与手动保存同口）。
 * 识别通道：POST /api/llm/chat（多模态——最后一条用户消息带 images 附件，
 *       后端转 image_url 内容数组，routes/llm.js 原生支持）。模型走
 *       MangaAi 同一条优先级链（_resolveAiModel）。坐标约定 0~1000
 *       千分比（Qwen-VL 惯例，跨模型稳定），前端钳制归一化后再入模板。
 * 提示词：内置常量（用户拍板 2026-11-09「先内置试试」）——不占技能下拉
 *       （那是写作指引语义）；以后要自定义口径再外置 data/skills/。
 * 定位：识别结果是起点不是终点——套模板后格子本来就是可编辑元素框，
 *       误差由预览剔除 + 用户拖拽消化，不做像素级较真。
 * 契约：原型混入（partial-class，ADR 026）——须后于主类加载；
 *       fetch/localStorage 用裸全局引用（测试经 vm context 注入桩）。
 * 对应：css/manga-editor.css（manga-detect-* 区段）。
 * ==========================================================================
 */

// 识别系统提示（内置）：只输出 JSON，坐标用 0~1000 千分比
const MANGA_DETECT_SYSTEM_PROMPT = [
    '你是漫画分镜识别助手。用户给你一张漫画页图片，请识别画面中每个分镜格子（panel）的边界，输出 JSON。',
    '规则：',
    '1. 只输出 JSON，不要任何解释、不要 markdown、不要代码围栏；',
    '2. 格式：{"panels":[{"x1":整数,"y1":整数,"x2":整数,"y2":整数}, ...]}，panels 按阅读顺序排列；',
    '3. 坐标是 0~1000 的相对千分比：x 相对图片宽度、y 相对图片高度（左上角原点，x1<x2、y1<y2）；',
    '4. 格子边界以分镜框线为准；页边留白、页码、对白气泡、音效字不算独立格子；',
    '5. 识别不到分镜（单格满页、无框插画等）时输出 {"panels":[]}。'
].join('\n');

/** 千分比坐标单轴最小占比：小于它的格子视为噪声剔除 */
const MANGA_DETECT_MIN_CELL = 0.02;
/** 单页格子数上限（防模型抽风输出海量碎块） */
const MANGA_DETECT_MAX_CELLS = 40;

Object.assign(window.MangaEditor.prototype, {

    // ==================== 识别按钮与来源菜单（_buildTemplatePopup 调用） ====================

    _buildDetectTools() {
        const wrap = this.dialog.querySelector('.manga-tpl-detect-wrap');
        if (!wrap) return;
        this._detectMenuEl = wrap.querySelector('.manga-detect-menu');
        const btn = wrap.querySelector('.manga-tpl-detect-btn');
        btn.addEventListener('click', () => {
            if (this._detectMenuEl) this._detectMenuEl.hidden = !this._detectMenuEl.hidden;
        });
        // 点外部收起（捕获 mousedown，同导出菜单教训——放行按钮与菜单自身）
        document.addEventListener('mousedown', (e) => {
            if (!this._detectMenuEl || this._detectMenuEl.hidden) return;
            if (btn.contains(e.target) || this._detectMenuEl.contains(e.target)) return;
            this._detectMenuEl.hidden = true;
        }, true);
        for (const item of this._detectMenuEl.querySelectorAll('.manga-detect-item')) {
            item.addEventListener('click', () => {
                this._detectMenuEl.hidden = true;
                if (item.dataset.act === 'local') this._detectPickLocal();
                else this._detectPickCanvas();
            });
        }
    },

    // ==================== 图片来源（本地 / 画布，复用文件菜单通道） ====================

    /** 本地图片：隐藏 input 单选（图片），FileReader 转 data URL */
    _detectPickLocal() {
        if (!this._detectFileInput) {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.style.display = 'none';
            input.addEventListener('change', () => {
                const file = input.files && input.files[0];
                input.value = '';
                if (!file || !file.type.startsWith('image/')) return;
                const reader = new FileReader();
                reader.onload = () => this._detectFromDataUrl(String(reader.result));
                reader.onerror = () => this._status('读取图片失败', true);
                reader.readAsDataURL(file);
            });
            document.body.appendChild(input);
            this._detectFileInput = input;
        }
        this._detectFileInput.click();
    },

    /** 画布图片：复用文件菜单的画布选图弹窗（检测模式标记分流确定行为） */
    _detectPickCanvas() {
        this._detectPickerMode = true;
        this._openFileCanvasPicker();
    },

    // ==================== 识别主流程 ====================

    /**
     * 识别入口：加载原图取尺寸 → 压缩出请求用 data URL（VLM 请求体限重，
     * 长边 1600 JPEG q0.85 足够看清分镜框线）→ 走聊天端点多模态请求 →
     * 解析归一化 → 叠图预览
     * @param {string} dataUrl - 原图 data URL（或画布图片稳定引用）
     */
    async _detectFromDataUrl(dataUrl) {
        if (this._detectRunning) return;
        const key = await this._resolveAiModel();
        if (!key) {
            this._status('未找到可用模型：请先在 设置 → API 配置厂商与模型（需多模态对话模型）', true);
            return;
        }
        this._detectRunning = true;
        this._status('正在识别分镜…（视觉模型响应较慢，请耐心等待）', false);
        let img;
        try {
            img = await new Promise((resolve, reject) => {
                const im = new Image();
                im.onload = () => resolve(im);
                im.onerror = () => reject(new Error('图片解码失败'));
                im.src = dataUrl;
            });

            // 压缩：长边钳 1600，JPEG q0.85（base64 体积可控，框线仍清晰）
            const MAXSIDE = 1600;
            const scale = Math.min(1, MAXSIDE / Math.max(img.naturalWidth, img.naturalHeight));
            const cv = document.createElement('canvas');
            cv.width = Math.max(1, Math.round(img.naturalWidth * scale));
            cv.height = Math.max(1, Math.round(img.naturalHeight * scale));
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
            const smallUrl = cv.toDataURL('image/jpeg', 0.85);

            const { provider, id } = LumenLight.parseModelKey(key);
            const r = await fetch('/api/llm/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: id,
                    provider: provider || undefined,
                    messages: [
                        { role: 'system', content: MANGA_DETECT_SYSTEM_PROMPT },
                        { role: 'user', content: `原图尺寸 ${img.naturalWidth}×${img.naturalHeight}。请识别这张漫画图的分镜格子并按系统指令输出 JSON。` }
                    ],
                    images: [smallUrl]
                })
            });
            const result = await r.json();
            if (!(r.ok && result.status === 'ok' && result.reply)) {
                throw new Error(result.message || '模型未返回内容');
            }
            const cells = this._normalizeDetectCells(this._parseDetectReply(result.reply));
            if (!cells.length) {
                this._status('未能识别出分镜格子（单格满页或无框构图？）', true);
                return;
            }
            this._status(`识别到 ${cells.length} 格，请在预览中确认（点击格子可剔除误识别）`);
            this._showDetectPreview(dataUrl, img, cells);
        } catch (err) {
            this._status('分镜识别失败：' + ((err && err.message) || err) +
                '（需支持图片输入的多模态对话模型）', true);
        } finally {
            this._detectRunning = false;
        }
    },

    // ==================== 回复解析与坐标归一（纯逻辑，Jest 可单测） ====================

    /**
     * 解析识别回复：剥代码围栏 → 取 JSON（panels/items 键的对象或裸数组）
     * → 逐格抽取坐标（x1y1x2y2 优先，x/y/w/h 变形兼容）。取不到结构时抛
     * 带回复开头的错误（便于看清模型回了什么形状）
     * @param {string} reply - 模型原始回复
     * @returns {Array<{x1:number,y1:number,x2:number,y2:number}>} 千分比坐标（未钳制）
     */
    _parseDetectReply(reply) {
        let s = String(reply).replace(/```[a-zA-Z]*\n?/g, '').trim();
        // 优先整体 JSON.parse；失败退化为截取首 [ 至尾 ]（模型在 JSON 外
        // 带说明文字时的兜底）
        let arr = null;
        const a = s.indexOf('['), b = s.lastIndexOf(']');
        if (a >= 0 && b > a) {
            const candidate = s.slice(a, b + 1)
                .replace(/,\s*([}\]])/g, '$1');   // 尾逗号修复
            try { arr = JSON.parse(candidate); } catch { /* 落入下方报错 */ }
        }
        if (!Array.isArray(arr)) {
            throw new Error('无法识别回复格式（开头：' + s.slice(0, 60) + '）');
        }
        const cells = [];
        for (const it of arr) {
            if (!it || typeof it !== 'object') continue;
            let x1 = Number(it.x1), y1 = Number(it.y1), x2 = Number(it.x2), y2 = Number(it.y2);
            if (![x1, y1, x2, y2].every(Number.isFinite)) {
                // x/y/w/h 变形兼容
                x1 = Number(it.x); y1 = Number(it.y);
                x2 = x1 + Number(it.w); y2 = y1 + Number(it.h);
            }
            if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
            cells.push({ x1, y1, x2, y2 });
        }
        return cells;
    },

    /**
     * 千分比坐标 → 归一化格子（模板 cells 契约 {x,y,w,h} 0~1）：
     * 钳 0~1000、倒序对换（x1>x2 时）、单轴小于 MANGA_DETECT_MIN_CELL 剔除、
     * 超过 MANGA_DETECT_MAX_CELLS 截断（保前 N 个）
     * @param {Array<{x1,y1,x2,y2}>} raw - 千分比坐标
     * @returns {Array<{x:number,y:number,w:number,h:number}>} 归一化格子
     */
    _normalizeDetectCells(raw) {
        const clamp = (v) => Math.min(1000, Math.max(0, v));
        const cells = [];
        for (const c of (Array.isArray(raw) ? raw : [])) {
            let x1 = clamp(Number(c.x1)), y1 = clamp(Number(c.y1));
            let x2 = clamp(Number(c.x2)), y2 = clamp(Number(c.y2));
            if (x1 > x2) [x1, x2] = [x2, x1];
            if (y1 > y2) [y1, y2] = [y2, y1];
            const w = (x2 - x1) / 1000, h = (y2 - y1) / 1000;
            if (w < MANGA_DETECT_MIN_CELL || h < MANGA_DETECT_MIN_CELL) continue;
            cells.push({ x: x1 / 1000, y: y1 / 1000, w, h });
            if (cells.length >= MANGA_DETECT_MAX_CELLS) break;
        }
        return cells;
    },

    // ==================== 叠图预览（确认/剔除后入库） ====================

    /**
     * 叠图预览浮层：原图按比例缩放进画布，识别格用粉框叠加（与磁吸参考线
     * 同色 #ff4fd8）；点击格子剔除误识别（命中取层栈最上），确认后走
     * 手动保存同一条 /api/manga-templates 入口入「我的模板」
     * @param {string} src - 原图 data URL（预览展示用，非请求压缩版）
     * @param {Image} img - 已解码的原图
     * @param {Array<{x,y,w,h}>} cells - 归一化格子
     */
    _showDetectPreview(src, img, cells) {
        this._closeDetectPreview();
        const mask = document.createElement('div');
        mask.className = 'manga-detect-mask';
        mask.innerHTML = `
            <div class="manga-detect-panel">
                <div class="manga-detect-head">
                    <span>识别结果预览</span>
                    <span class="manga-detect-hint">点击格子剔除误识别</span>
                    <button type="button" class="manga-detect-close" title="放弃">✕</button>
                </div>
                <div class="manga-detect-body">
                    <canvas class="manga-detect-canvas"></canvas>
                </div>
                <div class="manga-detect-foot">
                    <span class="manga-detect-count"></span>
                    <input type="text" class="manga-detect-name" maxlength="40"
                        placeholder="模板名">
                    <button type="button" class="manga-detect-retry">重试</button>
                    <button type="button" class="manga-detect-save">保存为模板</button>
                </div>
            </div>`;
        this.dialog.appendChild(mask);

        this._detectState = {
            src, img,
            cells: cells.map((c) => ({ ...c })),
            mask,
            canvas: mask.querySelector('.manga-detect-canvas')
        };
        mask.querySelector('.manga-detect-close')
            .addEventListener('click', () => this._closeDetectPreview());
        mask.querySelector('.manga-detect-retry')
            .addEventListener('click', () => {
                const dataUrl = this._detectState && this._detectState.src;
                this._closeDetectPreview();
                if (dataUrl) this._detectFromDataUrl(dataUrl);
            });
        mask.querySelector('.manga-detect-save')
            .addEventListener('click', () => this._saveDetectAsTemplate());
        mask.querySelector('.manga-detect-name').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this._saveDetectAsTemplate(); }
        });
        // 点击画布剔除格子（命中从后往前 = 视觉最上层优先）
        this._detectState.canvas.addEventListener('click', (e) => {
            const st = this._detectState;
            if (!st) return;
            const rect = st.canvas.getBoundingClientRect();
            const px = (e.clientX - rect.left) / rect.width;
            const py = (e.clientY - rect.top) / rect.height;
            const idx = st.cells.findIndex((c) =>
                px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h);
            if (idx >= 0) {
                st.cells.splice(idx, 1);
                this._renderDetectCanvas();
            }
        });
        this._renderDetectCanvas();
    },

    /** 预览画布渲染：等比缩放画原图 + 粉框叠格 + 序号角标 + 计数刷新 */
    _renderDetectCanvas() {
        const st = this._detectState;
        if (!st) return;
        const { img, canvas } = st;
        const MAXW = 680, MAXH = Math.round(window.innerHeight * 0.62);
        const scale = Math.min(MAXW / img.naturalWidth, MAXH / img.naturalHeight, 1);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        const g = canvas.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);
        g.drawImage(img, 0, 0, w, h);
        g.strokeStyle = '#ff4fd8';
        g.fillStyle = 'rgba(255,79,216,0.10)';
        g.lineWidth = 2;
        g.font = 'bold 12px sans-serif';
        st.cells.forEach((c, i) => {
            const x = c.x * w, y = c.y * h, cw = c.w * w, ch = c.h * h;
            g.fillRect(x, y, cw, ch);
            g.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
            g.fillStyle = '#ff4fd8';
            g.fillText(String(i + 1), x + 4, y + 14);
            g.fillStyle = 'rgba(255,79,216,0.10)';
        });
        st.mask.querySelector('.manga-detect-count').textContent =
            `识别到 ${st.cells.length} 格`;
        st.mask.querySelector('.manga-detect-save').disabled = st.cells.length === 0;
    },

    /** 关闭预览浮层并清状态（幂等） */
    _closeDetectPreview() {
        if (this._detectState) {
            this._detectState.mask.remove();
            this._detectState = null;
        }
    },

    /**
     * 预览确认 → 存「我的模板」（与手动保存同一条后端入口；同名覆盖）。
     * 名字缺省自动「识别模板 M.D」，入库后切到我的模板 tab 刷新
     */
    async _saveDetectAsTemplate() {
        const st = this._detectState;
        if (!st || !st.cells.length) return;
        const input = st.mask.querySelector('.manga-detect-name');
        const now = new Date();
        const name = ((input && input.value) || '').trim() ||
            `识别模板 ${now.getMonth() + 1}.${now.getDate()}`;
        try {
            const r = await fetch('/api/manga-templates', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, cells: st.cells })
            });
            const j = await r.json().catch(() => null);
            if (!r.ok || !j || j.status !== 'ok') {
                throw new Error((j && j.message) || ('HTTP ' + r.status));
            }
            this._status(j.overwritten ? `已覆盖同名模板「${name}」` : `已保存模板「${name}」（${st.cells.length} 格）`);
            this._closeDetectPreview();
            this._tplTab = 'user';
            await this._loadTemplateList();
        } catch (err) {
            this._status('模板保存失败：' + ((err && err.message) || err), true);
        }
    },
});
