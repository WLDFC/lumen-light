/**
 * ==========================================================================
 * CanvasDelivery — 画布对象「交付出口」的纯决策层
 * ==========================================================================
 * 作用：画布对象交给外部（下载到本地、存入资产库等）时，"到底交付什么"
 *       由这里统一决定，UI 层只按返回的计划执行，不再自行判断对象类型。
 *
 * 为什么需要：画布视频是「图片对象（img=首帧封面）+ videoUrl」的寄生模型，
 * 下载/资产等共享出口若直接走图片路径，会把封面 PNG 按视频文件名存出去
 * （下载得到打不开的"视频"，2026-11-01 实际事故）。把分流决策收敛成纯函数：
 *   - 新增交付出口时必须先来这里取计划，禁止出口内直接摸 obj.img；
 *   - 新增对象类型时在 getDownloadPlan 等计划函数里补一个分支 + 补测试。
 * 纯函数零 DOM 依赖，Jest 用 vm 上下文加载（同 CanvasHitTester 测试模式）。
 * ==========================================================================
 */

const CanvasDelivery = {

    /** 归一化本地资源 URL：统一补前导斜杠（videoUrl 各来源带/不带斜杠都有） */
    normalizeVideoUrl(url) {
        if (!url) return '';
        return String(url).startsWith('/') ? String(url) : '/' + String(url);
    },

    /**
     * 把文件名的扩展名替换为指定值；无扩展名则追加
     * （只认最后一个点，目录分隔符后的点不算——文件名本就不该含路径）
     */
    withExtension(filename, ext) {
        const base = String(filename || 'file').replace(/\.[^.\\/]*$/, '');
        return `${base}.${ext}`;
    },

    /**
     * 下载计划：这个画布对象下载到本地应该是什么、叫什么名
     * @param {Object} obj - 画布对象（图片/视频/占位图等）
     * @param {string|null} compositeSrc - 图片对象的所见即所得源（调用方经
     *        getCompositeSrc 预先算好；视频对象传 null——封面不是交付物）
     * @returns {{kind:'video', url:string, filename:string}
     *          |{kind:'image', src:string, filename:string}}
     */
    getDownloadPlan(obj, compositeSrc) {
        if (obj && NodeTypes.isVideo(obj.source) && obj.videoUrl) {
            return {
                kind: 'video',
                url: CanvasDelivery.normalizeVideoUrl(obj.videoUrl),
                filename: obj.name || `lumen-video-${CanvasDelivery._shortId(obj)}-${Date.now()}.mp4`
            };
        }
        return {
            kind: 'image',
            src: (compositeSrc || (obj && obj.img && obj.img.src) || ''),
            filename: (obj && obj.name) || `lumen-image-${CanvasDelivery._shortId(obj)}-${Date.now()}.png`
        };
    },

    /**
     * 资产入库计划：添加到资产库交什么、叫什么名
     * 资产库是图片库（POST /api/assets 存 dataUrl）——视频对象交付封面，
     * 但文件名强制 .png：不能让封面 PNG 挂着 .mp4 名义入库
     * @param {Object} obj - 画布对象
     * @param {string|null} compositeSrc - 同 getDownloadPlan
     * @returns {{src:string, filename:string}}
     */
    getAssetPlan(obj, compositeSrc) {
        const isVideo = !!(obj && NodeTypes.isVideo(obj.source));
        const rawName = (obj && obj.name) || '';
        return {
            src: (compositeSrc || (obj && obj.img && obj.img.src) || ''),
            filename: isVideo
                ? CanvasDelivery.withExtension(rawName || `lumen-cover-${CanvasDelivery._shortId(obj)}-${Date.now()}`, 'png')
                : (rawName || `lumen-image-${CanvasDelivery._shortId(obj)}-${Date.now()}.png`)
        };
    },

    /** 对象 id 前 6 位（缺省时间戳兜底），默认文件名用 */
    _shortId(obj) {
        return ((obj && obj.id) || '').substring(0, 6) || String(Date.now()).slice(-6);
    }
};

// 暴露到全局作用域（与 NodeTypes 同一约定）
window.CanvasDelivery = CanvasDelivery;
