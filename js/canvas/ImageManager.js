/**
 * ==========================================================================
 * LumenLight 图片管理器
 * 作用：负责管理画布上所有图片对象，包括添加本地文件、从 base64 数据添加、
 *       单选/多选、删除、命中检测以及删除按钮点击检测等功能。
 * ==========================================================================
 */

class ImageManager {
    /**
     * 构造函数：初始化图片数组和选中ID集合
     */
    constructor() {
        this.images = [];              // 存储所有图片对象的数组
        this.selectedIds = new Set();  // 多选：存储选中的图片ID集合
        // 多选无限制
    }

    /**
     * 从本地文件添加图片到画布
     * @param {File} file - 图片文件对象
     * @param {number} screenX - 屏幕上的 X 坐标
     * @param {number} screenY - 屏幕上的 Y 坐标
     * @param {Viewport} viewport - 视口实例，用于坐标转换
     * @param {number} offset - 添加时的偏移量（用于批量添加时避免重叠）
     * @returns {Promise<Object>} 返回添加的图片对象
     */
    add(file, screenX, screenY, viewport, offset = 0) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            
            // 读取文件为 Data URL
            reader.onload = (e) => {
                const img = new Image();
                
                // 图片加载完成后创建图片对象
                img.onload = () => {
                    // 一次性回调：添加后立即解绑，
                    // 防止后续修改图片 src（如保存后回写存档地址）时重复添加
                    img.onload = null;
                    // 保持原尺寸，不缩放
                    const w = img.width, h = img.height;
                    
                    // 将屏幕坐标转换为画布坐标，并应用偏移
                    const pos = viewport.screenToCanvas(screenX + offset, screenY + offset);
                    
                    const imageObj = {
                        id: LumenLight.generateId(), // 生成唯一ID
                        name: file.name,             // 保存原始文件名
                        img,                          // 图片DOM对象
                        x: pos.x - w/2,              // 居中显示：x坐标
                        y: pos.y - h/2,              // 居中显示：y坐标
                        width: w,                    // 图片原始宽度
                        height: h,                   // 图片原始高度
                        selected: false              // 默认未选中
                    };
                    
                    this.images.push(imageObj);
                    resolve(imageObj);
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        });
    }

    /**
     * 直接添加已加载完成的图片对象到画布
     * 用途：从 LLM 聊天窗口拖拽图片到画布时使用，保持原生分辨率
     * @param {Object} options - 图片对象配置
     * @param {HTMLImageElement} options.img - 已加载完成的 Image DOM 对象
     * @param {number} options.x - 画布 X 坐标
     * @param {number} options.y - 画布 Y 坐标
     * @param {number} options.width - 图片宽度
     * @param {number} options.height - 图片高度
     * @param {boolean} [options.isPlaceholder=false] - 是否为占位图片
     * @param {string} [options.name] - 图片文件名（缺省时按唯一ID生成，避免同名覆盖）
     * @returns {Object} 添加的图片对象
     */
    addImage(options) {
        const {
            img,
            x,
            y,
            width,
            height,
            isPlaceholder = false
        } = options;

        const id = LumenLight.generateId();       // 生成唯一ID
        const imageObj = {
            id,                                    // 唯一ID
            name: options.name || `llm_image_${id}.png`, // 文件名（默认带ID，避免多张图片同名互相覆盖）
            img,                          // 图片DOM对象
            x,                            // 画布 X 坐标
            y,                            // 画布 Y 坐标
            width,                        // 图片原始宽度
            height,                       // 图片原始高度
            selected: false,              // 默认未选中
            isPlaceholder,                // 占位标记
            source: options.source,
            prompt: options.prompt || '',
            negativePrompt: options.negativePrompt || ''
        };

        // 视频对象额外属性：videoEl（播放控制）和 videoUrl（存档恢复）
        if (options.videoEl) imageObj.videoEl = options.videoEl;
        if (options.videoUrl) imageObj.videoUrl = options.videoUrl;

        this.images.push(imageObj);
        return imageObj;
    }

    /**
     * 单选模式：选中指定图片，取消其他选中
     * @param {string|null} id - 要选中图片的ID，null 表示取消所有选中
     */
    select(id) {
        // 清除所有选中状态
        this.selectedIds.forEach(sid => {
            const img = this.images.find(i => i.id === sid);
            if (img) img.selected = false;
        });
        this.selectedIds.clear();

        let selectedImg = null;
        if (id) {
            this.selectedIds.add(id);
            const img = this.images.find(i => i.id === id);
            if (img) {
                img.selected = true;
                selectedImg = img;
                
                // 将选中的图片置顶（移到数组末尾，最后绘制）
                this.images = this.images.filter(i => i.id !== id);
                this.images.push(img);
            }
        }

        // 触发图片选择事件，通知其他组件
        window.dispatchEvent(new CustomEvent('canvasImageSelected', {
            detail: { image: selectedImg }
        }));
    }

    /**
     * 多选模式：切换指定图片的选中状态（按住 Shift 点击）
     * @param {string} id - 要切换选中状态的图片ID
     */
    toggleSelect(id) {
        const img = this.images.find(i => i.id === id);
        if (!img) return;

        if (this.selectedIds.has(id)) {
            // 如果已选中，则取消选中
            this.selectedIds.delete(id);
            img.selected = false;
        } else {
            // 如果未选中，则添加选中（无数量限制）
            this.selectedIds.add(id);
            img.selected = true;
            
            // 将选中的图片置顶
            this.images = this.images.filter(i => i.id !== id);
            this.images.push(img);
        }

        // 触发图片选择事件（多选时只传递最后选中的图片）
        const selectedImages = this.getSelected();
        const lastSelected = selectedImages.length > 0 ? selectedImages[selectedImages.length - 1] : null;
        window.dispatchEvent(new CustomEvent('canvasImageSelected', {
            detail: { image: lastSelected }
        }));
    }

    /**
     * 获取所有选中的图片
     * @returns {Array} 选中图片对象数组
     */
    getSelected() {
        return this.images.filter(i => this.selectedIds.has(i.id));
    }

    /**
     * 删除指定图片
     * @param {string} id - 要删除的图片ID
     * @param {Object} [options] - 可选参数
     * @param {boolean} [options.skipFileCleanup] - 跳过视频文件清理
     *        （剪切走此选项：文件要留给粘贴出的新对象使用）
     * @returns {boolean} 删除是否成功
     */
    delete(id, options = {}) {
        const idx = this.images.findIndex(i => i.id === id);
        if (idx > -1) {
            const removed = this.images[idx];
            this.images.splice(idx, 1);   // 从数组中移除
            this.selectedIds.delete(id);  // 从选中集合中移除
            this._cleanupVideoFile(removed, options);
            return true;
        }
        return false;
    }

    /**
     * 视频对象删除时的文件清理：videoUrl 指向 data/videos/ 工作区
     * 且画布上没有其他对象引用同一视频时，立即删除后端文件
     * （Delete 键删除即生效）。安全防护：
     *   - 只清理 data/videos/ 内的文件——指向存档副本
     *     （save/<名>/videos/）的地址绝不通过本入口删除；
     *   - 引用计数：同一视频被多个画布对象引用时不删；
     *   - 剪切（Ctrl+X）跳过清理，文件留给粘贴出的新对象。
     * 加载存档/新建画布的批量销毁不走 images.delete()，不触发本逻辑，
     * 残留文件由保存时的后端引用 GC 兜底回收。
     * @param {Object} obj - 被删除的画布对象
     * @param {Object} options - delete() 透传的选项
     */
    _cleanupVideoFile(obj, options) {
        if (options.skipFileCleanup) return;
        if (!NodeTypes.isVideo(obj.source) || !obj.videoUrl) return;
        const url = obj.videoUrl;
        if (!url.includes('data/videos')) return;
        if (this.images.some(i => NodeTypes.isVideo(i.source) && i.videoUrl === url)) return;

        // 该视频的播放器若正打开着，先关闭
        window.canvas?.videoManager?.dispose?.(obj);

        const filename = url.split('/').pop();
        fetch('/api/videos/' + encodeURIComponent(filename), { method: 'DELETE' })
            .catch((err) => console.warn('删除视频工作区文件失败:', err));
    }

    /**
     * 检测画布坐标是否命中某张图片
     * @param {number} canvasX - 画布 X 坐标
     * @param {number} canvasY - 画布 Y 坐标
     * @returns {Object|null} 命中的图片对象，未命中返回 null
     */
    isHit(canvasX, canvasY) {
        // 从后往前遍历，优先检测上层图片
        for (let i = this.images.length - 1; i >= 0; i--) {
            const img = this.images[i];

            // 判断坐标是否落在图片区域内
            if (canvasX >= img.x && canvasX <= img.x + img.width &&
                canvasY >= img.y && canvasY <= img.y + img.height) {
                return img;
            }
        }
        return null;
    }

}
