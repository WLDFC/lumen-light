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
            g.drawImage(layer.paintCv, layer.tx, layer.ty,
                layer.paintCv.width * layer.tscale,
                layer.paintCv.height * layer.tscale);
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
            g.drawImage(layer.paintCv, layer.tx, layer.ty,
                layer.paintCv.width * layer.tscale,
                layer.paintCv.height * layer.tscale);
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
            g.drawImage(layer.maskCv, layer.tx, layer.ty,
                layer.maskCv.width * layer.tscale,
                layer.maskCv.height * layer.tscale);
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
                    g.drawImage(layer.paintCv, layer.tx, layer.ty,
                        layer.paintCv.width * layer.tscale,
                        layer.paintCv.height * layer.tscale);
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
