/**
 * LayerSplit 子模块：会话持久化（IndexedDB，2026-11-13）
 * 解决 F5/关窗后要重新取图+重新识别（花钱）的问题。单槽位（'current'）——
 * 保存即覆盖；原图与切片都是 dataURL 可能好几 MB，localStorage 装不下，
 * 用 IndexedDB（项目内聊天记录同款存储）。运行时字段（_imgEl/_imgSrc）
 * 入库前剥除，恢复后由舞台惰性加载自愈。
 */

Object.assign(LayerSplit.prototype, {

    _openDb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('lumenLayerSplit', 1);
            req.onupgradeneeded = () => req.result.createObjectStore('session');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
        });
    },

    async _writeSession(snap) {
        const db = await this._openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction('session', 'readwrite');
            tx.objectStore('session').put(snap, 'current');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('会话写入失败'));
        });
        db.close();
    },

    async _readSession() {
        const db = await this._openDb();
        const snap = await new Promise((resolve, reject) => {
            const tx = db.transaction('session', 'readonly');
            const req = tx.objectStore('session').get('current');
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error || new Error('会话读取失败'));
        });
        db.close();
        return snap;
    },

    /** 当前工作状态快照（剥图层运行时字段——HTMLImageElement 不可结构化克隆） */
    _snapshot() {
        return {
            version: 1,
            savedAt: Date.now(),
            phase: this.phase,
            sourceImage: this.sourceImage,
            boxes: this.boxes,
            activeBoxId: this.activeBoxId,
            layers: this.layers.map((l) => {
                const { _imgEl, _imgSrc, ...rest } = l;
                return rest;
            }),
            activeLayerId: this.activeLayerId,
            detectModel: this.detectModel,
            inpaintModel: this.inpaintModel,
            detectPrompt: this.detectPrompt,
            inpaintPrompt: this.inpaintPrompt,
            extractPrompt: this.extractPrompt
        };
    },

    /** 工具栏「保存」：要求已取图；成功后恢复按钮在取图阶段可见 */
    async _saveSessionClick() {
        if (!this.sourceImage) {
            this.status('还没有可保存的内容（先取图）', true);
            return;
        }
        try {
            await this._writeSession(this._snapshot());
            this._hasSaved = true;
            this.status('已保存会话——F5 或重开后在取图阶段点「恢复上次」继续');
        } catch (err) {
            this.status('保存失败：' + ((err && err.message) || err), true);
        }
    },

    /** 工具栏「恢复上次」：有未保存改动时先确认 */
    async _restoreSessionClick() {
        const snap = await this._readSession().catch(() => null);
        if (!snap || !snap.sourceImage) {
            this.status('没有找到保存的会话', true);
            this._hasSaved = false;
            this._refreshRestoreUi();
            return;
        }
        if (this.sourceImage &&
            !window.confirm('恢复会覆盖当前窗口里未保存的内容，继续吗？')) return;
        this._applySession(snap);
    },

    /** 应用会话快照：回填全部状态并跳到保存时的阶段（图层图片由舞台
     *  惰性加载自愈——恢复的对象不带 _imgEl） */
    _applySession(snap) {
        this.sourceImage = snap.sourceImage || null;
        this.boxes = Array.isArray(snap.boxes) ? snap.boxes : [];
        this.activeBoxId = (snap.activeBoxId != null) ? snap.activeBoxId : null;
        this.layers = Array.isArray(snap.layers) ? snap.layers : [];
        this.activeLayerId = (snap.activeLayerId != null) ? snap.activeLayerId : null;
        if (snap.detectModel) {
            this.detectModel = snap.detectModel;
            localStorage.setItem('lumen.layerSplit.detectModel', snap.detectModel);
        }
        if (snap.inpaintModel) {
            this.inpaintModel = snap.inpaintModel;
            localStorage.setItem('lumen.layerSplit.inpaintModel', snap.inpaintModel);
        }
        if (typeof snap.detectPrompt === 'string') {
            this.detectPrompt = snap.detectPrompt;
            if (snap.detectPrompt) localStorage.setItem('lumen.layerSplit.detectPrompt', snap.detectPrompt);
            else localStorage.removeItem('lumen.layerSplit.detectPrompt');
        }
        if (typeof snap.inpaintPrompt === 'string') {
            this.inpaintPrompt = snap.inpaintPrompt;
            if (snap.inpaintPrompt) localStorage.setItem('lumen.layerSplit.inpaintPrompt', snap.inpaintPrompt);
            else localStorage.removeItem('lumen.layerSplit.inpaintPrompt');
        }
        if (typeof snap.extractPrompt === 'string') {
            this.extractPrompt = snap.extractPrompt;
            if (snap.extractPrompt) localStorage.setItem('lumen.layerSplit.extractPrompt', snap.extractPrompt);
            else localStorage.removeItem('lumen.layerSplit.extractPrompt');
        }
        if (this.sourceImage) {
            // 重建预览（与 _adoptSourceImage 同口径，但不清 boxes）
            this.previewBox.innerHTML = '';
            const img = document.createElement('img');
            img.src = this.sourceImage.dataUrl;
            img.alt = this.sourceImage.name || '';
            this.previewBox.appendChild(img);
            this.dialog.querySelector('.ls-act-detect').disabled = false;
        }
        const phase = (this.sourceImage && snap.phase === 'edit') ? 'edit' : 'calibrate';
        this._setPhase(phase);
        if (this.sourceImage) {
            this._fitToWrap(this.previewBox.querySelector('img'),
                this.sourceImage.width, this.sourceImage.height);
        }
        this._resetHistory();   // 会话恢复=新基线（恢复动作本身不可撤销）
        this.status(`已恢复上次会话（保存于 ${new Date(snap.savedAt).toLocaleString()}）——继续校准或编辑`);
    },

    /** 恢复按钮显隐：仅取图阶段且有已存会话（编辑中误触覆盖） */
    async _refreshRestoreUi() {
        const snap = await this._readSession().catch(() => null);
        this._hasSaved = !!(snap && snap.sourceImage);
        this._savedAt = this._hasSaved ? snap.savedAt : null;
        const btn = this.dialog && this.dialog.querySelector('.ls-act-restore');
        if (btn) btn.classList.toggle('ls-hidden', !(this._hasSaved && this.phase === 'pick'));
    },
});
