/**
 * ==========================================================================
 * ImageStudio 子模块：图片导入为图层（自 ImageStudio.js 拆出）
 * 作用：文件菜单两条入口——置入本地图片（隐藏 file input 多选）与
 *       从画布选图（多选弹窗网格）；导入即新建内容紧致图层并居中。
 * 契约：构造时传入宿主 ImageStudio 实例并读写其字段与方法（studio.xxx）；
 *       主类保留同名薄代理，内部/外部调用点零改动。
 * ==========================================================================
 */

class StudioImport {
    /** @param {Object} studio - 宿主 ImageStudio 实例 */
    constructor(studio) {
        this.studio = studio;
    }

    /**
     * 把一张图片作为新图层导入（文件菜单 → 置入）：图层画布 = 内容自身
     * 尺寸（等比缩放进画幅框），tx/ty 定位到文档中央——内容紧致的图层
     * 让选框/命中/缩放全部以可见图片为准（画布图片对象同语义）。
     * 置 strokes 脏标记，保存时随 studioLayers 序列化
     * @param {string} src - 图片 URL / dataURL
     * @param {string} name - 图层名（图层面板显示）
     */
    async importImageAsLayer(src, name) {
        const studio = this.studio;
        const img = await new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => reject(new Error('图片加载失败'));
            im.src = src;
        });
        const fit = Math.min(1,
            studio.iw / img.naturalWidth, studio.ih / img.naturalHeight);
        const w = Math.max(1, Math.round(img.naturalWidth * fit));
        const h = Math.max(1, Math.round(img.naturalHeight * fit));
        studio.addLayer({ w, h });
        const layer = studio._activeLayer();
        layer.name = name;
        layer.empty = false;
        // 居中放置：图层画布 = 内容尺寸，位置走 tx/ty 变换
        layer.tx = Math.round((studio.iw - w) / 2);
        layer.ty = Math.round((studio.ih - h) / 2);
        layer.paintCv.getContext('2d').drawImage(img, 0, 0, w, h);
        studio._positionLayerCanvases(layer);
        studio.dirty.strokes = true;
        studio.dirty.layers = true;
        studio._renderLayerList();
        studio._syncPanels();
        studio._pushHistory('置入图片');
    }

    /**
     * 打开本地图片选择框（+ 下拉 → 上传本地图片）。
     * 懒创建隐藏 input 模式照搬 SideToolbar：multiple 多选、仅图片，
     * change 后重置 value 以便下次可选同一文件
     */
    _openLocalFileDialog() {
        const studio = this.studio;
        studio.fileMenuEl.hidden = true;
        if (!studio._fileInput) {
            studio._fileInput = document.createElement('input');
            studio._fileInput.type = 'file';
            studio._fileInput.accept = 'image/*';
            studio._fileInput.multiple = true;
            studio._fileInput.style.display = 'none';
            studio._fileInput.addEventListener('change', async (e) => {
                const files = Array.from(e.target.files || []);
                studio._fileInput.value = '';
                for (const file of files) {
                    if (!file.type.startsWith('image/')) continue;
                    try {
                        const dataUrl = await new Promise((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onload = () => resolve(reader.result);
                            reader.onerror = () => reject(reader.error);
                            reader.readAsDataURL(file);
                        });
                        await studio.importImageAsLayer(
                            dataUrl, file.name.replace(/\.[^.]+$/, ''));
                    } catch (err) {
                        console.error('❌ 导入本地图片失败:', err);
                    }
                }
            });
            document.body.appendChild(studio._fileInput);
        }
        studio._fileInput.click();
    }

    /** 打开画布选图弹窗：网格列出当前画布全部真实图片，点选切换勾选，
     *  确定后逐张导入为新图层 */
    _openPicker() {
        const studio = this.studio;
        studio.fileMenuEl.hidden = true;
        studio._pickerSelected.clear();
        const grid = studio.pickerEl.querySelector('.is-picker-grid');
        grid.innerHTML = '';
        // images.images 是混合数组（还装着提示词/文本等面板节点与占位图），
        // 直接遍历会在节点对象上读 img.src 抛 TypeError——用官方谓词只挑
        // 真实图片；视频对象有首帧封面 img，但导入图片编辑器无意义，同样排除
        const imgs = (studio.canvas?.images?.images || [])
            .filter((o) => NodeTypes.isRealCanvasImage(o)
                && !NodeTypes.isVideo(o.source));
        if (!imgs.length) {
            const empty = document.createElement('div');
            empty.className = 'is-picker-empty';
            empty.textContent = '画布上还没有图片';
            grid.appendChild(empty);
        }
        for (const o of imgs) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'is-picker-item';
            item.title = o.name || '';
            const thumb = document.createElement('img');
            thumb.src = o.img.src;
            thumb.draggable = false;
            const badge = document.createElement('span');
            badge.className = 'is-picker-badge';
            badge.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
            item.append(thumb, badge);
            item.addEventListener('click', () => {
                if (studio._pickerSelected.has(o.id)) {
                    studio._pickerSelected.delete(o.id);
                    item.classList.remove('selected');
                } else {
                    studio._pickerSelected.add(o.id);
                    item.classList.add('selected');
                }
                studio._syncPickerCount();
            });
            grid.appendChild(item);
        }
        studio._syncPickerCount();
        studio.pickerEl.hidden = false;
    }

    _closePicker() {
        const studio = this.studio;
        studio.pickerEl.hidden = true;
        studio._pickerSelected.clear();
    }

    /** 同步弹窗底部的已选计数与确定按钮可用态 */
    _syncPickerCount() {
        const studio = this.studio;
        const n = studio._pickerSelected.size;
        studio.pickerEl.querySelector('.is-picker-count').textContent = `已选 ${n} 张`;
        studio.pickerEl.querySelector('.is-picker-ok').disabled = n === 0;
    }
}

// 暴露到全局作用域（经典 script，ImageStudio.js 之后实例化时消费）
window.StudioImport = StudioImport;
