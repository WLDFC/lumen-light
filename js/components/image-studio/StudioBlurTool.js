/**
 * ==========================================================================
 * ImageStudio 子模块：模糊笔刷（像素效果工具）
 * 作用：在激活像素层上涂出柔化效果（PS 模糊工具同语义：作用在所在层
 *       的像素工具）。平铺语义——一笔之内每个像素只模糊一次，重叠
 *       不叠加：拖动中把笔迹画进遮罩画布，实时预览 = 原图层快照模糊
 *       后经遮罩（羽化边缘）合成的结果，松手即定型。
 * 强度：σ = 强度/10（0.4~4px），强度只控模糊轻重，与涂抹次数无关。
 * 契约：构造传入宿主实例；主类 _onPaintDown 调 startStroke、
 *       _onPaintMove 调 strokeSegment、_onPaintUp 调 endStroke；脏标记/
 *       历史/保存烘焙由主类既有管线处理，本模块只管像素。
 * ==========================================================================
 */

class StudioBlurTool {
    /** @param {Object} studio - 宿主 ImageStudio 实例 */
    constructor(studio) {
        this.studio = studio;
        this._tmp = document.createElement('canvas');    // 模糊预览工作画布
        this._mask = document.createElement('canvas');   // 笔迹遮罩（图层局部坐标）
        this._orig = document.createElement('canvas');   // 起笔时的图层内容快照
        this._bounds = null;                             // 笔迹包围盒（局部坐标）
        this._raf = 0;                                   // 预览渲染限帧句柄
    }

    /** 起笔：快照图层内容（模糊采样源）、清空笔迹遮罩（图层局部坐标） */
    startStroke() {
        const studio = this.studio;
        const layer = studio._activeLayer();
        if (!layer || layer.isText) return false;
        this._orig.width = layer.paintCv.width;
        this._orig.height = layer.paintCv.height;
        this._orig.getContext('2d').drawImage(layer.paintCv, 0, 0);
        this._mask.width = layer.paintCv.width;
        this._mask.height = layer.paintCv.height;
        this._bounds = null;
        return true;
    }

    /** 落笔/拖动：把笔迹画进遮罩（圆头线段，半径 = 笔刷半径）并排队
     *  刷新预览。限帧到每帧一次——指针事件速率远超刷新率，效果渲染
     *  每事件一跑会把光标卡死 */
    strokeSegment(from, to) {
        const studio = this.studio;
        const layer = studio._activeLayer();
        if (!layer || layer.isText) return;
        const ts = layer.tscale || 1;
        // 翻转态图层：局部 x 镜像，笔刷落点与显示位置一致（形状层已烘焙，不镜像）
        const lx = (p) => {
            let x = (p.x - layer.tx) / ts;
            if (layer.flipX && !layer.isShape) x = layer.paintCv.width - x;
            return { x, y: (p.y - layer.ty) / ts };
        };
        const lf = lx(from), lt = lx(to);
        const r = (studio.sizes.strokes * ImageStudio.SIZE_SCALE) / 2 / ts;
        const mg = this._mask.getContext('2d');
        mg.strokeStyle = '#000';
        mg.lineWidth = r * 2;
        mg.lineCap = 'round';
        mg.lineJoin = 'round';
        mg.beginPath();
        mg.moveTo(lf.x, lf.y);
        mg.lineTo(lt.x, lt.y);
        mg.stroke();
        const pad = r + Math.ceil(studio.fxStrength / 10) + 4;
        this._growBounds(lf, lt, r, pad);
        if (!this._raf) {
            this._raf = requestAnimationFrame(() => {
                this._raf = 0;
                const layer2 = studio._activeLayer();
                if (layer2 && !layer2.isText && this._bounds && studio.image) {
                    this._renderBlurPreview(layer2, r);
                }
            });
        }
    }

    /** 收笔：取消排队中的预览帧，做一次定型渲染（与预览同参数——
     *  所见即所得） */
    endStroke() {
        if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
        if (!this._bounds) return;
        const studio = this.studio;
        const layer = studio._activeLayer();
        if (!layer) return;
        const ts = layer.tscale || 1;
        const r = (studio.sizes.strokes * ImageStudio.SIZE_SCALE) / 2 / ts;
        this._renderBlurPreview(layer, r);
        this._bounds = null;
    }

    _growBounds(lf, lt, r, pad) {
        const b = this._bounds;
        const nx0 = Math.min(lf.x, lt.x) - r - pad;
        const ny0 = Math.min(lf.y, lt.y) - r - pad;
        const nx1 = Math.max(lf.x, lt.x) + r + pad;
        const ny1 = Math.max(lf.y, lt.y) + r + pad;
        if (!b) this._bounds = { x0: nx0, y0: ny0, x1: nx1, y1: ny1 };
        else {
            b.x0 = Math.min(b.x0, nx0); b.y0 = Math.min(b.y0, ny0);
            b.x1 = Math.max(b.x1, nx1); b.y1 = Math.max(b.y1, ny1);
        }
    }

    /** 模糊实时预览（平铺幂等的核心）：paintCv 每次从起笔快照重建该
     *  区域——先恢复原内容，再叠"模糊后经笔迹遮罩（羽化边缘）"的
     *  结果。同笔内回描只是重画同一结果，永不叠加 */
    _renderBlurPreview(layer, r) {
        const studio = this.studio;
        const g = layer.paintCv.getContext('2d');
        const b = this._bounds;
        if (!b) return;
        const x0 = Math.max(0, Math.floor(b.x0));
        const y0 = Math.max(0, Math.floor(b.y0));
        const x1 = Math.min(layer.paintCv.width, Math.ceil(b.x1));
        const y1 = Math.min(layer.paintCv.height, Math.ceil(b.y1));
        const w = x1 - x0, h = y1 - y0;
        if (w <= 0 || h <= 0) return;
        this._tmp.width = w;
        this._tmp.height = h;
        const tg = this._tmp.getContext('2d');
        tg.clearRect(0, 0, w, h);
        // 模糊：σ = 强度/10（0.4~4px）
        tg.filter = `blur(${Math.max(0.5, studio.fxStrength / 10)}px)`;
        tg.drawImage(this._orig, x0, y0, w, h, 0, 0, w, h);
        tg.filter = 'none';
        // 笔迹遮罩（轻度羽化边缘）限定生效范围
        tg.globalCompositeOperation = 'destination-in';
        tg.filter = 'blur(1.5px)';
        tg.drawImage(this._mask, x0, y0, w, h, 0, 0, w, h);
        tg.filter = 'none';
        tg.globalCompositeOperation = 'source-over';
        // 重建 paintCv 该区域：先恢复原内容，再叠模糊遮罩结果
        // （tmp 与包围盒同尺寸，务必画回包围盒原位——丢了偏移会落到
        // 图层左上角，表现为"涂了没效果"）
        g.clearRect(x0, y0, w, h);
        g.drawImage(this._orig, x0, y0, w, h, x0, y0, w, h);
        g.drawImage(this._tmp, x0, y0);
    }
}

// 暴露到全局作用域（经典 script，ImageStudio.js 之后实例化时消费）
window.StudioBlurTool = StudioBlurTool;
