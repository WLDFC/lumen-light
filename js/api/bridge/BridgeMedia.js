/**
 * ==========================================================================
 * LumenSocket 子模块：桥接命令·媒体（自 LumenSocket.js 拆出）
 * 作用：画布图片/视频的取用与落布——get_image/get_images（内存位图重绘
 *       导出 base64，笔迹合成所见即所得）、drop_image（dataUrl 或公网直链
 *       经后端同源代理取图，base64 不进 agent 上下文）、drop_video（引用
 *       data/videos/ 工作区文件）、clear_media/delete_media（撤销可回退）、
 *       media_arrange/media_rename（几何/改名批量运维）；另有 WS 回流
 *       落画布两方法 addImageToCanvas/addVideoToCanvas（Comfy/网页桥接
 *       生成结果，非桥接命令但同属媒体域）。
 * 契约：原型混入（partial-class，ADR 027）——方法 Object.assign 进
 *       LumenSocket.prototype，this 即 socket 实例；须后于主类文件加载。
 *       _findBridgeMedia 供媒体与视图两域命令共用。
 * ==========================================================================
 */

Object.assign(window.LumenSocket.prototype, {

    // ==================== WS 回流落画布（非桥接命令） ====================

    /**
     * 添加 ComfyUI 生成的图片到画板
     * @param {string} base64 - 图片的 base64 编码数据（不含 data URL 前缀）
     * @param {Object|null} placeholderPosition - 占位图位置信息 {x, y, width, height}
     * @param {Object|null} prompt - 生成该图片时使用的提示词
     * @param {Object|null} [genInfo] - 生成参数记录（溯源/生成同款，GenRecord；
     *   pi 落图/网页桥接等无占位消费方的路径为 null，不登记）
     */
    addImageToCanvas(base64, placeholderPosition = null, prompt = null, genInfo = null) {
        const img = new Image();

        // 图片加载完成后添加到画布
        img.onload = () => {
            // 一次性回调：添加后立即解绑，
            // 防止后续修改图片 src（如保存后回写存档地址）时重复添加
            img.onload = null;

            let x, y, w, h;
            let zoneRouted = false;

            if (placeholderPosition) {
                // 使用占位图的中心位置，生成图片按自身原始尺寸居中显示
                w = img.width;
                h = img.height;
                x = placeholderPosition.x + placeholderPosition.width / 2 - w / 2;
                y = placeholderPosition.y + placeholderPosition.height / 2 - h / 2;
            } else {
                // 没有占位图时：聚集编组启用则统一落入聚集区槽位——
                // 这一路是「无占位消费方的生成回流」（pi 跑 Comfy 工作流、
                // 网页桥接、免节点通道等，原缺省落当前视口中心，用户缩放
                // 画布后不知图落哪）；未启用时落当前视口中心
                w = img.width;
                h = img.height;
                const zone = this.canvas.collectZone;
                const zonePos = zone ? zone.resolveSpawnPosition(w, h) : null;
                if (zonePos) {
                    x = zonePos.x;
                    y = zonePos.y;
                    zoneRouted = true;
                } else {
                    const cp = this.canvas.viewport.screenToCanvas(
                        this.canvas.cssWidth / 2,
                        this.canvas.cssHeight / 2
                    );
                    x = cp.x - w / 2;
                    y = cp.y - h / 2;

                    // 多图连续落画布（网页桥接一轮回多图等）错开排布：
                    // 与已有图片重叠时沿对角线每次偏移 24px，直到让开为止
                    const overlaps = (nx, ny, nw, nh) => this.imageManager.images.some(
                        (im) => nx < im.x + im.width && im.x < nx + nw &&
                                ny < im.y + im.height && im.y < ny + nh
                    );
                    let guard = 0;
                    while (guard++ < 100 && overlaps(x, y, w, h)) {
                        x += 24;
                        y += 24;
                    }
                }
            }

            // 创建图片对象并添加到图片管理器
            const obj = {
                id: LumenLight.generateId(),    // 生成唯一ID
                img: img,                       // 图片DOM对象
                x: x,                           // x坐标
                y: y,                           // y坐标
                width: w,                       // 图片原始宽度
                height: h,                      // 图片原始高度
                selected: false,                // 默认未选中
                source: 'comfy',                // 来源标记为ComfyUI
                prompt: prompt?.positive || '',
                negativePrompt: prompt?.negative || '',
                ...(genInfo ? { genInfo } : {}), // 生成参数记录（面板 Comfy 链路）
                created: Date.now()             // 创建时间戳
            };
            this.imageManager.images.push(obj);

            // 触发画布重绘
            this.canvas.draw();

            // 聚集区提示：区内落图且聚集区不在视口内时弹可点击定位提示
            if (zoneRouted) this.canvas.collectZone.notifyLanded(obj);

            // 显示收到图片的通知
            this.showNotification('生成完成');
        };

        // 设置图片源为 base64 编码的 PNG
        img.src = 'data:image/png;base64,' + base64;
    },

    /**
     * 添加 ComfyUI 生成的视频到画板（委托给 CanvasVideoManager，
     * 画布上以首帧封面展示，双击打开播放器）
     * @param {string} videoUrl - 视频地址（后端 data/videos 下的相对路径）
     * @param {Object|null} prompt - 生成该视频时使用的提示词
     */
    addVideoToCanvas(videoUrl, prompt = null) {
        const videoManager = this.canvas.videoManager;
        if (!videoManager) {
            console.error('画布视频管理器未初始化，无法落视频');
            return;
        }

        // 有生成反馈占位图时按占位图中心落视频并消费一个占位
        let centerX, centerY;
        if (window.generationFeedback && window.generationFeedback.placeholders.length > 0) {
            const first = window.generationFeedback.placeholders[0].imageObj;
            centerX = first.x + first.width / 2;
            centerY = first.y + first.height / 2;
            window.generationFeedback.hide();
        }

        videoManager.addVideo('/' + String(videoUrl).replace(/^\//, ''), {
            prompt: prompt?.positive || '',
            name: String(videoUrl).split('/').pop(),
            ...(centerX !== undefined ? { centerX, centerY } : {})
        }).then(() => {
            this.showNotification('视频已生成');
        }).catch((err) => {
            console.error('添加视频到画布失败:', err);
            this.showNotification('视频落画布失败', 4000);
        });
    },

    // ==================== 桥接命令：媒体 ====================

    /** get_image：取一张画布图片的 base64（{name?} 或 {index?}，缺省取选中） */
    async _bridgeGetImage(params) {
        const c = this.canvas;
        const media = c.images.images
            .filter(img => !NodeTypes.isPanelNode(img.source) &&
                           !NodeTypes.isPlaceholder(img.source) &&
                           !NodeTypes.isVideo(img.source));
        let target = null;
        if (params.name) {
            target = media.find(img => (img.name || '') === params.name);
        } else if (params.index !== undefined) {
            target = media[params.index];
        } else {
            // 无参数：优先取当前选中的图片（用户正在操作的那张），
            // 未选中任何图片时回落第一张
            const sel = c.images.getSelected().find(
                img => !NodeTypes.isVideo(img.source));
            target = sel || media[0];
        }
        if (!target) throw new Error('未找到指定的画布图片');
        return await this._imageToBase64(target);
    },

    /** get_images：多图取用（供 agent 对比选图）：按 names 数组或前 limit 张 */
    async _bridgeGetImages(params) {
        const c = this.canvas;
        const media = c.images.images
            .filter(img => !NodeTypes.isPanelNode(img.source) &&
                           !NodeTypes.isPlaceholder(img.source) &&
                           !NodeTypes.isVideo(img.source));
        let selected = media;
        if (Array.isArray(params.names) && params.names.length > 0) {
            selected = params.names
                .map((n) => media.find((img) => (img.name || '') === n))
                .filter(Boolean);
        } else {
            const limit = Math.max(1, Math.min(8, parseInt(params.limit, 10) || 4));
            selected = media.slice(0, limit);
        }
        if (selected.length === 0) throw new Error('画布上没有图片');
        return { images: await Promise.all(selected.map((img) => this._imageToBase64(img))) };
    },

    /**
     * drop_image：图片来源二选一——dataUrl（pi 自带 base64，如画布取图回传）
     * 或 url（搜图直链——浏览器经后端同源代理 /api/llm/download-image 取字节，
     * 避开 CORS，且 base64 全程不进 agent 上下文）；缺省落视口中心
     */
    async _bridgeDropImage(params) {
        const c = this.canvas;
        let dataUrl = params.dataUrl;
        if (!dataUrl && params.url) {
            const proxyUrl = '/api/llm/download-image?url=' +
                encodeURIComponent(params.url) +
                '&filename=' + encodeURIComponent(params.name || 'bridge-image');
            const resp = await fetch(proxyUrl);
            if (!resp.ok) {
                throw new Error(`取图失败：HTTP ${resp.status}（${params.url}）`);
            }
            const blob = await resp.blob();
            if (!blob.size) throw new Error('取图失败：内容为空');
            // 代理返回的 Content-Type 不可信（可能是 octet-stream）：
            // 非 image/* 时按魔数嗅探重写——声明错 mime 会让 <img> 拒绝解码
            let mime = (blob.type || '').startsWith('image/') ? blob.type : null;
            if (!mime) {
                const head = await blob.slice(0, 16).arrayBuffer();
                mime = window.ImageExport?.sniffImageMime?.(head) || null;
            }
            if (!mime) throw new Error(`该地址不是可识别的图片格式（${params.url}）`);
            dataUrl = await window.ImageExport.blobToDataUrl(blob, mime);
        }
        if (!dataUrl) throw new Error('缺少图片来源：dataUrl 与 url 至少提供一个');
        const img = new Image();
        await new Promise((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('图片数据无法解码'));
            // 用上文解析出的 dataUrl（url 模式下来自代理下载，非 params 原值）
            img.src = dataUrl;
        });
        // 缺省落点：当前视口中心；聚集接管：生图任务落图（params.collect
        // 由 pi canvas_run_llm_image 后台 worker 标记）且聚集编组启用时，
        // 统一落入聚集区槽位（CollectZone 路由，与占位图链路同语义；
        // 不缩放不裁切，放不下按原始尺寸落编组位置级联）
        const dpr = c.dpr || 1;
        let x = params.x, y = params.y;
        let zoneRouted = false;
        if (params.collect === true && x === undefined && y === undefined && c.collectZone) {
            const zonePos = c.collectZone.resolveSpawnPosition(img.naturalWidth, img.naturalHeight);
            if (zonePos) {
                x = zonePos.x;
                y = zonePos.y;
                zoneRouted = true;
            }
        }
        if (x === undefined || y === undefined) {
            x = (-c.viewport.offsetX + c.canvas.width / 2 / dpr) / c.viewport.scale;
            y = (-c.viewport.offsetY + c.canvas.height / 2 / dpr) / c.viewport.scale;
            x -= img.naturalWidth / 2;
            y -= img.naturalHeight / 2;
        }
        const obj = c.images.addImage({
            img,
            x, y,
            width: img.naturalWidth,
            height: img.naturalHeight,
            source: 'bridge',
            name: params.name || `bridge_${Date.now()}.png`
        });
        c.draw();
        // 聚集区提示：区内落图且聚集区不在视口内时弹可点击定位提示
        if (zoneRouted) c.collectZone.notifyLanded(obj);
        return { id: obj.id, name: obj.name };
    },

    /**
     * drop_video：落视频到画布——videoPath 为后端视频工作区的相对路径
     * （如 data/videos/video_xxx.mp4——pi 视频任务完成后已由后端下载落盘，
     * 这里直接引用，不再二次上传）。只接受工作区路径，防止借命令探测任意文件
     */
    async _bridgeDropVideo(params) {
        const c = this.canvas;
        const videoPath = String(params.videoPath || '');
        if (!/^data\/videos\/[\w.\-\u4e00-\u9fff]+$/.test(videoPath)) {
            throw new Error(`非法的 videoPath：${videoPath}（须为 data/videos/ 下的文件）`);
        }
        if (!c.videoManager) throw new Error('视频管理器未初始化');
        const opts = {};
        if (params.name) opts.name = params.name;
        if (params.x !== undefined && params.y !== undefined) {
            opts.x = params.x;
            opts.y = params.y;
        }
        const obj = await c.videoManager.addVideo('/' + videoPath, opts);
        c.draw();
        return { id: obj.id, name: obj.name };
    },

    /**
     * clear_media：批量清空画布上全部图片/视频（面板节点与占位图不受影响）。
     * 供 agent 一条命令完成"清空画布"，避免逐张循环
     */
    async _bridgeClearMedia(params) {
        const c = this.canvas;
        const targets = c.images.images.filter(img =>
            !NodeTypes.isPanelNode(img.source) &&
            !NodeTypes.isPlaceholder(img.source));
        // 撤销记账：agent 批量清除可回退（误清救回）
        c.history?.deleteObjects(targets, [], { label: '清空画布' });
        c.draw();
        return { deleted: targets.length };
    },

    /** delete_media：按名称删除画布对象（撤销可回退） */
    async _bridgeDeleteMedia(params) {
        const c = this.canvas;
        if (!params.name) throw new Error('缺少 name');
        const targets = c.images.images.filter(img =>
            !NodeTypes.isPanelNode(img.source) &&
            !NodeTypes.isPlaceholder(img.source) &&
            (img.name || '') === params.name);
        if (targets.length === 0) throw new Error(`未找到名为「${params.name}」的画布对象`);
        c.history?.deleteObjects(targets, [], { label: '删除对象' });
        c.draw();
        return { deleted: targets.length };
    },

    /**
     * media_arrange：移动/缩放媒体对象（节点位置走 node_update 的 x/y）：
     * 批量几何变更，快照对比入撤销栈（与拖拽/缩放手势同构）
     */
    async _bridgeMediaArrange(params) {
        const c = this.canvas;
        const items = Array.isArray(params.items) ? params.items : null;
        if (!items || items.length === 0) throw new Error('缺少 items 数组');
        const entries = [];
        const skipped = [];
        for (const item of items) {
            const obj = this._findBridgeMedia(item);
            if (!obj) { skipped.push(item.name || item.id || '?'); continue; }
            const from = { x: obj.x, y: obj.y, width: obj.width, height: obj.height };
            if (Number.isFinite(+item.x)) obj.x = +item.x;
            if (Number.isFinite(+item.y)) obj.y = +item.y;
            if (Number.isFinite(+item.width)) obj.width = Math.max(8, +item.width);
            if (Number.isFinite(+item.height)) obj.height = Math.max(8, +item.height);
            entries.push({ obj, from, to: { x: obj.x, y: obj.y, width: obj.width, height: obj.height } });
        }
        if (entries.length === 0) throw new Error(`未找到任何目标对象（缺失：${skipped.join('、')}）`);
        c.history?.recordGeometry(entries, '整理画布');
        c.draw();
        return { arranged: entries.length, skipped };
    },

    /** media_rename：按名称批量重命名（撤销可回退） */
    async _bridgeMediaRename(params) {
        const c = this.canvas;
        if (!params.name || !params.newName) throw new Error('缺少 name / newName 参数');
        const newName = String(params.newName);
        const targets = c.images.images.filter(img =>
            !NodeTypes.isPanelNode(img.source) &&
            !NodeTypes.isPlaceholder(img.source) &&
            (img.name || '') === params.name);
        if (targets.length === 0) throw new Error(`未找到名为「${params.name}」的画布对象`);
        for (const obj of targets) {
            c.history?.recordValue(obj, 'name', params.name, newName, '重命名');
            obj.name = newName;
        }
        c.draw();
        return { renamed: targets.length, newName };
    },

    // ==================== 媒体公共辅助 ====================

    /**
     * 按对象 id 或名称查找媒体对象（图片/视频，不含 DOM 节点与占位图）。
     * 找不到返回 null，由调用方决定报错还是跳过
     * @param {Object} ref - { id } 或 { name }
     * @returns {Object|null} 媒体对象
     */
    _findBridgeMedia(ref) {
        if (!ref) return null;
        return this.canvas.images.images.find(img =>
            !NodeTypes.isPanelNode(img.source) &&
            !NodeTypes.isPlaceholder(img.source) &&
            ((ref.id !== undefined && img.id === ref.id) ||
             (ref.name !== undefined && (img.name || '') === ref.name))) || null;
    },

    /**
     * 画布图片对象 → PNG base64 信息（get_image / get_images 共用）。
     * 无论 src 是 data: 还是 http:，都从内存位图重绘导出，保证自包含。
     * 所见即所得：有编辑笔迹时先合成原图+笔迹（重绘说明随图可见，
     * 与 ImageManager.getCompositeSrc 同源），无笔迹/合成失败沿用内存位图
     * @param {Object} target - 画布图片对象
     */
    async _imageToBase64(target) {
        let img = target.img;
        const composite = this.canvas.images.getCompositeSrc(target);
        if (composite !== target.img.src) {
            // 有笔迹（返回了合成 data URL）：加载合成结果再导出
            img = await new Promise((resolve, reject) => {
                const im = new Image();
                im.onload = () => resolve(im);
                im.onerror = () => reject(new Error('合成图（原图+笔迹）加载失败'));
                im.src = composite;
            });
        }
        const cnv = document.createElement('canvas');
        cnv.width = img.naturalWidth;
        cnv.height = img.naturalHeight;
        cnv.getContext('2d').drawImage(img, 0, 0);
        const dataUrl = cnv.toDataURL('image/png');
        return {
            name: target.name || '',
            width: img.naturalWidth,
            height: img.naturalHeight,
            base64: dataUrl.split(',')[1],
            mediaType: 'image/png'
        };
    },
});
