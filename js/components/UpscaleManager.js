/**
 * LumenLight 高清放大管理器
 * 
 * 本文件负责集成 Real-ESRGAN 算法，对图片进行 AI 高清放大。
 * 支持以下功能：
 *   - 模式选择：动漫（anime）/ 真实场景（real）两种图像类型
 *   - 放大倍数：动漫模式支持 2x / 4x，真实场景模式支持 4x
 *   - 交互方式：通过二级菜单选择类型，三级菜单选择倍数，提供悬停展开与点击外部关闭
 *   - 结果回传：放大完成后派发自定义事件，通知画板添加放大后的新图片
 * 
 * 后端接口：POST http://localhost:8080/api/upscale
 */

/**
 * UpscaleManager 类
 * 管理高清放大菜单的创建、交互、后端请求及状态提示。
 */
class UpscaleManager {
    /**
     * 构造函数
     * 初始化处理状态、当前选中的图片以及菜单 DOM 引用。
     */
    constructor() {
        // 是否正在处理放大请求，防止重复提交
        this.isProcessing = false;
        // 当前待放大的图片数据数组 [{ src, name, ... }]
        this.currentImages = [];
        // 二级菜单容器（类型选择：动漫/真实）
        this.menuContainer = null;
        // 三级菜单容器（倍数选择：2x/4x）
        this.activeScaleMenu = null;
    }

    /**
     * 创建高清放大菜单（二级和三级菜单）
     * @param {HTMLElement} parentBtn - 父按钮元素（高清放大按钮）
     * @param {Array|Object} imageData - 单张图片数据或图片数据数组
     * @returns {HTMLElement} 菜单容器
     */
    createUpscaleMenu(parentBtn, imageData) {
        // 统一处理为数组：单张图片也包装成数组
        this.currentImages = Array.isArray(imageData) ? imageData : [imageData];
        // 移除旧菜单，避免重复创建
        this.removeMenu();

        // 创建二级菜单容器：用于选择动漫/真实类型
        const typeMenu = document.createElement('div');
        typeMenu.className = 'upscale-submenu type-menu';

        // 创建“动漫”类型按钮
        const animeBtn = this.createTypeButton('anime', '动漫');
        // 创建“真实”类型按钮
        const realBtn = this.createTypeButton('real', '真实');

        // 将类型按钮添加到二级菜单
        typeMenu.appendChild(animeBtn);
        typeMenu.appendChild(realBtn);

        // 将二级菜单定位到父按钮下方居中显示
        const rect = parentBtn.getBoundingClientRect();
        typeMenu.style.position = 'fixed';
        typeMenu.style.top = `${rect.bottom + 4}px`;
        typeMenu.style.left = `${rect.left + rect.width / 2}px`;
        typeMenu.style.transform = 'translateX(-50%)';

        // 保存并挂载二级菜单到 body
        this.menuContainer = typeMenu;
        document.body.appendChild(typeMenu);

        // 鼠标悬停“动漫”按钮时，显示对应的三级倍数菜单
        animeBtn.addEventListener('mouseenter', () => {
            this.showScaleMenu('anime', animeBtn);
        });

        // 鼠标悬停“真实”按钮时，显示对应的三级倍数菜单
        realBtn.addEventListener('mouseenter', () => {
            this.showScaleMenu('real', realBtn);
        });

        // 绑定点击页面其他区域关闭菜单的事件
        this.bindOutsideClick();

        return typeMenu;
    }

    /**
     * 创建类型按钮（动漫/真实）
     * @param {string} type - 类型标识：'anime' 或 'real'
     * @param {string} label - 按钮显示文本
     * @returns {HTMLElement} 类型按钮 DOM
     */
    createTypeButton(type, label) {
        const btn = document.createElement('div');
        btn.className = `upscale-type-btn ${type}`;
        btn.dataset.type = type;
        // 根据类型设置对应图标：动漫用画板，真实用相机
        btn.innerHTML = `
            <span class="type-icon">${type === 'anime' ? '🎨' : '📷'}</span>
            <span class="type-label">${label}</span>
        `;
        return btn;
    }

    /**
     * 显示三级菜单（倍数选择）
     * 根据所选类型在按钮右侧展示可用的放大倍数选项。
     * @param {string} type - 类型标识：'anime' 或 'real'
     * @param {HTMLElement} btnElement - 触发三级菜单的类型按钮
     */
    showScaleMenu(type, btnElement) {
        // 如果已有三级菜单，先移除旧的
        if (this.activeScaleMenu) {
            this.activeScaleMenu.remove();
            this.activeScaleMenu = null;
        }

        // 创建三级菜单容器：用于选择放大倍数
        const scaleMenu = document.createElement('div');
        scaleMenu.className = 'upscale-submenu scale-menu';

        if (type === 'anime') {
            // 动漫模式：支持 2x 和 4x 两种倍数
            scaleMenu.appendChild(this.createScaleButton('anime', 2));
            scaleMenu.appendChild(this.createScaleButton('anime', 4));
        } else {
            // 真实场景模式：仅支持 4x 倍数
            scaleMenu.appendChild(this.createScaleButton('real', 4));
        }

        // 将三级菜单定位到类型按钮右侧
        const btnRect = btnElement.getBoundingClientRect();
        scaleMenu.style.position = 'fixed';
        scaleMenu.style.top = `${btnRect.top}px`;
        scaleMenu.style.left = `${btnRect.right + 4}px`;

        // 保存并挂载三级菜单到 body
        document.body.appendChild(scaleMenu);
        this.activeScaleMenu = scaleMenu;
    }

    /**
     * 创建倍数按钮
     * @param {string} type - 类型标识：'anime' 或 'real'
     * @param {number} scale - 放大倍数：2 或 4
     * @returns {HTMLElement} 倍数按钮 DOM
     */
    createScaleButton(type, scale) {
        const btn = document.createElement('div');
        btn.className = 'upscale-scale-btn';
        btn.textContent = `${scale}x`;
        
        // 点击倍数按钮后开始放大，并关闭菜单
        btn.addEventListener('click', (e) => {
            // 阻止事件冒泡，避免触发外部点击关闭逻辑
            e.stopPropagation();
            this.startUpscale(type, scale);
            this.removeMenu();
        });

        return btn;
    }

    /**
     * 开始放大处理
     * 向后端 Real-ESRGAN 服务发送请求，支持批量处理多张图片。
     * @param {string} type - 类型标识：'anime' 或 'real'
     * @param {number} scale - 放大倍数：2 或 4
     */
    async startUpscale(type, scale) {
        // 如果正在处理中，提示用户并阻止新的请求
        if (this.isProcessing) {
            alert('正在处理中，请稍候...');
            return;
        }

        // 校验当前是否存在可放大的图片
        if (!this.currentImages.length) {
            console.error('没有可放大的图片');
            return;
        }

        // 标记为处理中状态
        this.isProcessing = true;

        try {
            // 显示处理中提示 toast
            this.showProcessingToast(`${type === 'anime' ? '动漫' : '真实'} ${scale}x 放大中 (${this.currentImages.length} 张)...`);

            let successCount = 0;
            let failCount = 0;

            // 依次处理每张图片
            for (let i = 0; i < this.currentImages.length; i++) {
                const currentImage = this.currentImages[i];

                try {
                    // 如果图片 src 不是 base64（例如相对路径或 URL），先 fetch 转为 base64
                    let imageData = currentImage.src;
                    if (!imageData.startsWith('data:image')) {
                        const imageUrl = imageData.startsWith('http') ? imageData : `http://localhost:8080/${imageData}`;
                        const imgResponse = await fetch(imageUrl);
                        if (!imgResponse.ok) {
                            throw new Error('无法获取图片: ' + imgResponse.status);
                        }
                        const blob = await imgResponse.blob();
                        imageData = await new Promise((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onloadend = () => resolve(reader.result);
                            reader.onerror = reject;
                            reader.readAsDataURL(blob);
                        });
                    }

                    // 调用后端 Real-ESRGAN 放大 API
                    const response = await fetch('http://localhost:8080/api/upscale', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            imageData: imageData,
                            type: type,
                            scale: scale,
                            filename: currentImage.name || 'image.png'
                        })
                    });

                    const data = await response.json();

                    if (data.status === 'ok' && data.upscaledImage) {
                        // 放大成功，触发自定义事件，将结果传递给画板以便添加新图片
                        window.dispatchEvent(new CustomEvent('upscaleComplete', {
                            detail: {
                                originalImage: currentImage,
                                upscaledImage: data.upscaledImage,
                                type: type,
                                scale: scale,
                                index: i,
                                total: this.currentImages.length
                            }
                        }));
                        successCount++;
                    } else {
                        throw new Error(data.message || '放大失败');
                    }
                } catch (itemError) {
                    console.error(`第 ${i + 1} 张图片放大失败:`, itemError);
                    failCount++;
                }
            }

            // 根据成功/失败数量显示提示
            if (failCount === 0) {
                this.showSuccessToast(`${scale}x 放大完成！共 ${successCount} 张`);
            } else {
                this.showSuccessToast(`${scale}x 放大完成：成功 ${successCount} 张，失败 ${failCount} 张`);
            }
        } catch (error) {
            // 捕获网络或后端错误，显示错误提示
            console.error('放大失败:', error);
            this.showErrorToast('放大失败: ' + error.message);
        } finally {
            // 无论成功或失败，都释放处理中状态
            this.isProcessing = false;
        }
    }

    /**
     * 显示处理中提示
     * @param {string} message - 提示内容
     */
    showProcessingToast(message) {
        this.showToast(message, 'processing');
    }

    /**
     * 显示成功提示
     * @param {string} message - 提示内容
     */
    showSuccessToast(message) {
        this.showToast(message, 'success');
    }

    /**
     * 显示错误提示
     * @param {string} message - 提示内容
     */
    showErrorToast(message) {
        this.showToast(message, 'error');
    }

    /**
     * 显示提示
     * 创建并展示一个指定类型的 Toast，3 秒后自动移除。
     * @param {string} message - 提示内容
     * @param {string} type - 提示类型：'processing' / 'success' / 'error'
     */
    showToast(message, type) {
        // 移除页面上已有的提示，避免重叠显示
        const oldToast = document.querySelector('.upscale-toast');
        if (oldToast) oldToast.remove();

        // 创建新的提示元素
        const toast = document.createElement('div');
        toast.className = `upscale-toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        // 3 秒后自动移除提示
        setTimeout(() => {
            toast.remove();
        }, 3000);
    }

    /**
     * 移除菜单
     * 清理二级菜单和三级菜单的 DOM 及引用。
     */
    removeMenu() {
        // 移除二级菜单
        if (this.menuContainer) {
            this.menuContainer.remove();
            this.menuContainer = null;
        }
        // 移除三级菜单
        if (this.activeScaleMenu) {
            this.activeScaleMenu.remove();
            this.activeScaleMenu = null;
        }
    }

    /**
     * 绑定点击外部关闭菜单
     * 当用户点击菜单以外的区域时，关闭所有放大菜单。
     */
    bindOutsideClick() {
        // 定义点击事件处理器
        const handler = (e) => {
            // 判断点击位置是否在二级菜单内
            const clickedInMenu = this.menuContainer && this.menuContainer.contains(e.target);
            // 判断点击位置是否在三级菜单内
            const clickedInScaleMenu = this.activeScaleMenu && this.activeScaleMenu.contains(e.target);
            
            // 若点击位置不在任何菜单内，则关闭菜单并解绑事件
            if (!clickedInMenu && !clickedInScaleMenu) {
                this.removeMenu();
                document.removeEventListener('click', handler);
            }
        };
        
        // 延迟绑定点击事件，避免菜单创建瞬间立即触发关闭
        setTimeout(() => {
            document.addEventListener('click', handler);
        }, 0);
    }
}

// 导出为全局变量，供其他模块通过 window.UpscaleManager 访问
window.UpscaleManager = UpscaleManager;
