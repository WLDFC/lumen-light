/**
 * ==========================================================================
 * ImageStudio 子模块：保存（拍平 + 契约落盘，自 ImageStudio.js 拆出）
 * 作用：保存契约的全部实现——
 *   1. 原图层涂画 → 文档底片拍平（背景层+图片层按变换合成）写回
 *      image.img.src（实时保存按新内容哈希自动上传）；
 *   2. 上层内容 → 图层栈 2..n 自下而上按变换拍平写 image.editStrokes；
 *   3. 遮罩 → 全图层遮罩画布取并集写 image.mask（Comfy 烘焙 alpha）；
 *   4. 图层栈序列化写 image.studioLayers；
 *   5. 画幅框变更 → outpaintComplete 事件导出白底新图落到原图旁。
 * 契约：构造时传入宿主 ImageStudio 实例并读写其字段与方法（studio.xxx）；
 *       主类保留同名薄代理 save()。
 * ==========================================================================
 */

class StudioSave {
    /** @param {Object} studio - 宿主 ImageStudio 实例 */
    constructor(studio) {
        this.studio = studio;
    }

    /**
     * 按图层变换把内容画进合成上下文（文档坐标）。
     * 左右翻转（layer.flipX）时以图层矩形右缘为轴水平镜像——与编辑期
     * 画布元素的 scaleX(-1) 视觉一致，保存结果与所见相同。
     * 剪贴层（2026-11-11 自漫画编辑器移植，PS Clipping Mask 同语义）：
     * paintCv 的 blit 走合成结果（内容 ∩ 基底 alpha + 形状基底描边补笔，
     * 见 _composeClipScratch）——显示（clipCv）/拍平/吸管同口径；cv 为
     * maskCv 时不经剪贴（遮罩是重绘元数据，不受剪贴影响）
     * @param {CanvasRenderingContext2D} g - 目标上下文（已含文档→画幅平移）
     * @param {Object} layer - 图层
     * @param {HTMLCanvasElement} cv - 图层画布（paintCv 或 maskCv）
     */
    _blitLayer(g, layer, cv) {
        if (layer.clipped && cv === layer.paintCv) {
            g.drawImage(this._composeClipped(layer), 0, 0);
            return;
        }
        this._blitRaw(g, layer, cv);
    }

    /** 变换 blit 本体（剪贴合成内部用——blit 剪贴层的内容源时不可再入
     *  剪贴分支，否则无限递归） */
    _blitRaw(g, layer, cv) {
        const w = cv.width * layer.tscale;
        const h = cv.height * layer.tscale;
        // 形状层的翻转已由 _render 烘焙进画布内容（尾巴换向后重绘），
        // 这里不能再镜像一次
        if (layer.flipX && !layer.isShape) {
            g.save();
            g.translate(layer.tx + w, layer.ty);
            g.scale(-1, 1);
            g.drawImage(cv, 0, 0, w, h);
            g.restore();
            return;
        }
        g.drawImage(cv, layer.tx, layer.ty, w, h);
    }

    // ==================== 剪贴蒙版（2026-11-11 自漫画编辑器移植） ====================

    /** 剪贴基底：本层下方最近的未剪贴层（PS 链式语义——多个剪贴层挂
     *  同一基底；拖拽排序后按新位置自动定基）。返回层对象或 null */
    _clipBaseFor(layer) {
        const layers = this.studio.layers;
        const idx = layers.indexOf(layer);
        if (idx < 0) return null;
        for (let i = idx - 1; i >= 0; i--) {
            const l = layers[i];
            if (l && !l.clipped) return l;
        }
        return null;
    }

    /** 文档尺寸实例级合成 scratch（惰性建 + 随画幅改尺寸） */
    _clipScratch(key) {
        const studio = this.studio;
        let cv = this[key];
        if (!cv) {
            cv = document.createElement('canvas');
            this[key] = cv;
        }
        if (cv.width !== studio.iw || cv.height !== studio.ih) {
            cv.width = studio.iw;
            cv.height = studio.ih;
        }
        return cv;
    }

    /**
     * 剪贴合成（文档坐标，结果落实例 scratch B 并返回）：
     * A = 基底内容（按其变换/翻转 blit，**基底透明度参与遮罩**——PS 同
     * 语义基底越透明剪贴越透）；B = 本层内容（按本层变换/翻转 blit）→
     * destination-in 基底 alpha → 形状基底补 stroke-only 一笔（置入图
     * 遮罩含描边 alpha 会盖住框线内半边，链顶补笔让分镜框线恒在最上，
     * 2026-11-11 漫画同语义）。本层自身透明度不在此烘焙（显示走
     * clipCv 的 CSS opacity、拍平走调用方 globalAlpha）
     */
    _composeClipScratch(layer, base) {
        const a = this._clipScratch('_clipScratchA');
        const ga = a.getContext('2d');
        ga.setTransform(1, 0, 0, 1, 0, 0);
        ga.clearRect(0, 0, a.width, a.height);
        ga.globalAlpha = base.opacity;
        this._blitRaw(ga, base, base.paintCv);
        ga.globalAlpha = 1;
        const b = this._clipScratch('_clipScratchB');
        const gb = b.getContext('2d');
        gb.setTransform(1, 0, 0, 1, 0, 0);
        gb.clearRect(0, 0, b.width, b.height);
        this._blitRaw(gb, layer, layer.paintCv);
        gb.globalCompositeOperation = 'destination-in';
        gb.drawImage(a, 0, 0);
        gb.globalCompositeOperation = 'source-over';
        if (base.isShape && base.shape) {
            const s = base.shape;
            const w = Math.max(2, Math.round(s.w));
            const h = Math.max(2, Math.round(s.h));
            // 翻转镜像与 StudioShapeTool._render 同构：气泡换尾、多边形
            // 镜像层内点集（x → w − x），内容烘焙式翻转无 CSS 镜像
            const eff = base.flipX
                ? {
                    ...s,
                    tail: ShapeLayout.MIRROR_TAIL[s.tail] || s.tail,
                    points: s.type === 'poly' && Array.isArray(s.points)
                        ? s.points.map(([px, py]) => [s.w - px, py]) : s.points
                }
                : s;
            const ext = ShapeLayout.extFor(eff, w, h);
            gb.save();
            gb.translate(base.tx, base.ty);
            gb.scale(base.tscale, base.tscale);
            ShapeLayout.drawShapeContent(gb, eff, ext.left, ext.top, w, h, 'stroke');
            gb.restore();
        }
        return b;
    }

    /** 剪贴层文档坐标合成结果（拍平/吸管经 _blitLayer 剪贴分支消费）；
     *  基底缺失/隐藏 → 空画布（整层不显示） */
    _composeClipped(layer) {
        const b = this._clipScratch('_clipScratchB');
        const gb = b.getContext('2d');
        gb.setTransform(1, 0, 0, 1, 0, 0);
        gb.clearRect(0, 0, b.width, b.height);
        const base = this._clipBaseFor(layer);
        if (base && base.visible !== false) {
            this._composeClipScratch(layer, base);
        }
        return b;
    }

    /**
     * 剪贴层显示刷新（主类 _refreshClips 转发）：逐剪贴层把合成结果画进
     * 其 clipCv（文档尺寸画布钉在文档原点，变换已烘焙进内容）。
     * 无剪贴层时零开销早退；内容/变换/透明度的变化点都应调用（涂画/模糊
     * 段点、移动拖拽、形状/文字重渲染、透明度滑杆、历史恢复等）
     */
    _refreshClipDisplays() {
        const studio = this.studio;
        if (!studio.image || !studio.layers.some((l) => l.clipped)) return;
        for (const layer of studio.layers) {
            if (!layer.clipped) continue;
            studio._ensureClipCanvas(layer);
            const cv = layer.clipCv;
            if (cv.width !== studio.iw || cv.height !== studio.ih) {
                cv.width = studio.iw;
                cv.height = studio.ih;
            }
            const g = cv.getContext('2d');
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.clearRect(0, 0, cv.width, cv.height);
            const base = this._clipBaseFor(layer);
            if (base && base.visible !== false) {
                g.drawImage(this._composeClipScratch(layer, base), 0, 0);
            }   // 基底缺失/隐藏 → 保持清空（整链不显示即目标态）
            studio._positionLayerCanvases(layer);
        }
    }

    /**
     * 拍平上层笔迹：图层栈 1..n 自下而上，跳过隐藏层、逐层乘透明度。
     * （原图层不参与——它的涂画走烘焙通道，见 save）。
     * 返回 data URL（透明 PNG）
     */
    /** 文档底片拍平：自下而上到图片层为止的全部可见层按变换合成
     *  （背景层 + 图片层，以及被拖到图片层之下的普通层，见
     *  _bakesIntoBase），写回 img.src 用。背景层隐藏时保留透明度
     *  （透明图片工作流不受影响） */
    _flattenDoc() {
        const studio = this.studio;
        const cv = document.createElement('canvas');
        cv.width = studio.iw;
        cv.height = studio.ih;
        const g = cv.getContext('2d');
        for (const layer of studio.layers) {
            if (!studio._bakesIntoBase(layer) || !layer.visible) continue;
            g.globalAlpha = layer.opacity;
            this._blitLayer(g, layer, layer.paintCv);
        }
        g.globalAlpha = 1;
        return cv.toDataURL('image/png');
    }

    /** 上层内容拍平：图片层之上的全部可见层按变换自下而上合成
     *  （editStrokes 用；底片范围是动态的，用 _bakesIntoBase 排除） */
    _flattenPaint() {
        const studio = this.studio;
        const cv = document.createElement('canvas');
        cv.width = studio.iw;
        cv.height = studio.ih;
        const g = cv.getContext('2d');
        for (const layer of studio.layers) {
            if (studio._bakesIntoBase(layer) || !layer.visible) continue;
            g.globalAlpha = layer.opacity;
            this._blitLayer(g, layer, layer.paintCv);
        }
        g.globalAlpha = 1;
        return cv.toDataURL('image/png');
    }

    /**
     * 拍平遮罩：全图层（含原图层）遮罩画布取并集——全强度、忽略
     * 透明度与可见性（遮罩是重绘区域元数据，压暗会让 Comfy 重绘
     * 边界模糊）。返回 data URL（透明 PNG，红色区域=重绘区）
     */
    _flattenMask() {
        const studio = this.studio;
        const cv = document.createElement('canvas');
        cv.width = studio.iw;
        cv.height = studio.ih;
        const g = cv.getContext('2d');
        for (const layer of studio.layers) {
            this._blitLayer(g, layer, layer.maskCv);
        }
        return cv.toDataURL('image/png');
    }

    /**
     * 图层栈序列化。原图层只存 visible/opacity/mask——它的笔迹已
     * 烘焙进 img.src，无需重复存储；上层存 paint/mask data URL
     */
    _serializeLayers() {
        const studio = this.studio;
        return studio.layers.map((layer) => {
            return {
                name: layer.name,
                isBackground: !!layer.isBackground,
                isImage: !!layer.isImage,
                isText: !!layer.isText,
                // 文字层附文字属性（恢复时按属性重渲染，支持再次编辑）；
                // paint 位图照常落盘，字体缺失环境仍能显示原样
                text: layer.text ? { ...layer.text } : null,
                isShape: !!layer.isShape,
                // 形状层附形状属性（恢复时按属性重渲染，支持再次编辑）
                shape: layer.shape ? { ...layer.shape } : null,
                w: layer.paintCv.width,
                h: layer.paintCv.height,
                visible: layer.visible,
                opacity: layer.opacity,
                // 形状层存包围盒位置（tx + 画布外伸——tx 语义是画布左上角，
                // 含尾巴/描边外伸；存包围盒使恢复重渲染时锚点稳定不漂移）
                x: (layer.tx || 0) + (layer._shapeExt ? layer._shapeExt.left : 0),
                y: (layer.ty || 0) + (layer._shapeExt ? layer._shapeExt.top : 0),
                scale: layer.tscale || 1,
                // 左右翻转标记（非破坏式镜像，恢复时重新应用到显示/拍平）
                flipX: !!layer.flipX,
                // 剪贴蒙版标记（显示/拍平走合成结果，恢复时重导出）
                clipped: !!layer.clipped,
                mask: layer.maskCv.toDataURL('image/png'),
                paint: layer.paintCv.toDataURL('image/png')
            };
        });
    }

    /**
     * 保存：按脏标记依次落盘——
     *   1. 原图层涂画 → 画布内容烘焙进 img.img.src（原位更新，几何
     *      不变；实时保存按新内容哈希自动上传）；
     *   2. 上层笔迹脏 → 图层拍平写 image.editStrokes；
     *   3. 遮罩脏 → 全图层遮罩并集写 image.mask（Comfy 局部重绘随图传递）；
     *   4. 图层内容/结构有变 → 图层栈序列化写 image.studioLayers；
     *   5. 画幅框脏 → outpaintComplete 事件导出白底新图落到原图旁。
     * 全部就绪门闩先行等待，防止既有图层内容未加载完被空数据覆盖。
     */
    async save() {
        const studio = this.studio;
        if (!studio.image) return;
        try {
            await studio._readyAll;
            const imgObj = studio.image;
            // layers 脏 = 图层结构变化（删层/排序/显隐/透明度/置入）：
            // 拍平结果与序列化都必须重算——只删层不涂画时其余脏标记
            // 全为 false，漏掉它会导致旧 studioLayers 原样保留，
            // 重开编辑时被删图层"复活"
            const strokesChanged = studio.dirty.strokes || studio.dirty.layers;
            const maskChanged = studio.dirty.mask || studio.dirty.layers;

            if (studio.dirty.base) {
                // 文档底片：背景层 + 图片层按变换拍平写回图片本体。
                // 同一 HTMLImageElement 换 src，加载完成后触发重绘 +
                // 实时保存调度（内容寻址，自动按新内容上传）
                imgObj.img.src = this._flattenDoc();
                // 显示代理缓存按 imageId 键控、不感知 src 内容变化
                // （见 ImageProxyCache 失效策略），不失效的话常规缩放档
                // 会继续画烘焙笔迹前的旧代理——表现为"保存后笔迹消失"，
                // F5 才恢复。src 内容被替换的只有本处，在此精准失效
                studio.canvas?.renderer?.proxyCache?.invalidate(imgObj.id);
                imgObj.img.onload = () => {
                    imgObj.img.onload = null;
                    studio.canvas?.draw();
                };
            }

            if (strokesChanged) {
                const dataURL = this._flattenPaint();
                imgObj.editStrokes = dataURL;
                imgObj.editStrokesOpacity = 1;   // 透明度已逐层烘焙进拍平结果
                const layer = new Image();
                layer.onload = () => {
                    imgObj.editStrokesImg = layer;
                    studio.canvas?.draw();
                };
                layer.src = dataURL;
            }

            if (maskChanged) {
                const dataURL = this._flattenMask();
                imgObj.mask = dataURL;
                const layer = new Image();
                layer.onload = () => {
                    imgObj.maskImg = layer;
                    studio.canvas?.draw();
                };
                layer.src = dataURL;
            }

            if (studio.dirty.base || strokesChanged || maskChanged) {
                imgObj.studioLayers = this._serializeLayers();
            }

            if (studio.dirty.frame) {
                const f = studio.frame;
                const out = document.createElement('canvas');
                out.width = Math.round(f.fw);
                out.height = Math.round(f.fh);
                const g = out.getContext('2d');
                g.fillStyle = '#ffffff';
                g.fillRect(0, 0, out.width, out.height);
                // 全部可见层按变换合成后取画幅框范围（img.src 可能刚被换过
                // 尚未加载完成，直接画 img 不可靠——用图层画布取当前内容）
                g.translate(-f.fx, -f.fy);
                for (const layer of studio.layers) {
                    if (!layer.visible) continue;
                    g.globalAlpha = layer.opacity;
                    this._blitLayer(g, layer, layer.paintCv);
                }
                window.dispatchEvent(new CustomEvent('outpaintComplete', {
                    detail: { originalImage: studio.image, imageDataUrl: out.toDataURL('image/png') }
                }));
            }

            // 保存完成：不退出编辑器（退出走右上角 ×，requestClose 据
            // 脏标记决定是否弹丢弃确认）——脏标记全部清零，之后继续
            // 编辑产生的新改动才会再次触发保存
            studio.dirty = { base: false, strokes: false, mask: false,
                frame: false, layers: false };
            studio._flashMsg('已保存');
        } catch (err) {
            console.error('图像编辑保存失败:', err);
            studio.msgEl.textContent = '保存失败：图层导出异常';
            studio.msgEl.classList.add('error');
            setTimeout(() => {
                studio.msgEl.textContent = '';
                studio.msgEl.classList.remove('error');
            }, 3000);
        }
    }
}

// 暴露到全局作用域（经典 script，ImageStudio.js 之后实例化时消费）
window.StudioSave = StudioSave;
