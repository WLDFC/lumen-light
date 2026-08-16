/**
 * ==========================================================================
 * LumenLight 画布右键菜单
 * 作用：在画布空白处右键弹出节点添加菜单，首期仅提供"添加提示词节点"，
 *       结构上以菜单项数组组织，方便将来扩展（API 节点、图片节点等）。
 *
 * 交互规则：
 *   - 右键画布空白处：弹出菜单，节点将创建在鼠标位置（画布坐标）
 *   - 右键图片/节点上：不弹菜单（与现有元素交互不冲突）
 *   - 点击菜单项：执行对应操作并关闭菜单
 *   - 点击其他区域 / ESC：关闭菜单
 *   - 菜单弹出期间画布不响应框选等鼠标交互
 * ==========================================================================
 */

class CanvasContextMenu {
    /**
     * 构造函数
     * @param {Canvas} canvas - 画布主类实例
     */
    constructor(canvas) {
        this.canvas = canvas;
        this.menuEl = null;        // 菜单 DOM 元素（惰性创建）
        this.isVisible = false;    // 当前是否显示
        this.bindEvents();
    }

    /**
     * 绑定全局事件：右键弹出、点击关闭、ESC 关闭
     */
    bindEvents() {
        const canvasEl = this.canvas.canvas;

        // 右键：空白处弹出菜单，命中图片/节点时抑制
        canvasEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();

            const rect = canvasEl.getBoundingClientRect();
            const cp = this.canvas.viewport.screenToCanvas(
                e.clientX - rect.left,
                e.clientY - rect.top
            );

            // 命中任何元素（图片或提示词节点）时不弹菜单
            if (this.canvas.images.isHit(cp.x, cp.y) || this.hitPromptNode(cp.x, cp.y)) {
                this.hide();
                return;
            }

            this.show(e.clientX, e.clientY, cp.x, cp.y);
        });

        // 点击任意位置关闭菜单
        document.addEventListener('mousedown', (e) => {
            if (!this.isVisible) return;
            // 点击菜单内部不关闭（由菜单项各自处理）
            if (this.menuEl && this.menuEl.contains(e.target)) return;
            this.hide();
        });

        // ESC 关闭菜单
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isVisible) {
                this.hide();
            }
        });
    }

    /**
     * 检测画布坐标是否命中某个 DOM 节点（提示词/生图/文本节点）
     * @param {number} cx - 画布 X
     * @param {number} cy - 画布 Y
     * @returns {PromptNode|ImageGenNode|TextNode|null}
     */
    hitPromptNode(cx, cy) {
        const nodes = this.canvas.images.images.filter(
            img => NodeTypes.isPanelNode(img.source)
        );
        for (let i = nodes.length - 1; i >= 0; i--) {
            if (nodes[i].contains(cx, cy)) return nodes[i];
        }
        return null;
    }

    /**
     * 显示右键菜单
     * @param {number} screenX - 鼠标屏幕 X（视口坐标，用于菜单定位）
     * @param {number} screenY - 鼠标屏幕 Y
     * @param {number} canvasX - 鼠标画布 X（节点创建位置）
     * @param {number} canvasY - 鼠标画布 Y
     */
    show(screenX, screenY, canvasX, canvasY) {
        this.ensureMenuEl();
        this.targetCanvasPos = { x: canvasX, y: canvasY };

        // 菜单项定义：将来扩展 API 节点等在这里追加。
        // 图标用项目统一的白色线稿内联 SVG（Feather 风格：
        // fill=none / stroke=currentColor / 2px 圆角线帽，与顶栏、文件菜单一致）
        const svgIcon = (paths) =>
            `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

        const items = [
            {
                label: '提示词节点',
                // 对话气泡（与顶栏"提示词面板"按钮同图标）
                icon: svgIcon('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'),
                action: () => this.addPromptNode(this.targetCanvasPos)
            },
            {
                label: '生图节点',
                // 图片（矩形 + 山景 + 太阳，与 LLM 工具栏上传按钮同风格）
                icon: svgIcon('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'),
                action: () => this.addImageGenNode(this.targetCanvasPos)
            },
            {
                label: 'Comfy 生图节点',
                // 芯片（CPU：外框 + 内核 + 四边引脚，与 Feather cpu 图标一致，
                // 表达"走本地 ComfyUI 工作流"的语义）
                icon: svgIcon('<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>'),
                action: () => this.addComfyGenNode(this.targetCanvasPos)
            },
            {
                label: 'LoRA 节点',
                // 层叠滑块（三条竖线各带一个调节圆点，Feather sliders 风格，
                // 表达"多组可调强度堆叠"的 LoRA 组合语义）
                icon: svgIcon('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>'),
                action: () => this.addLoraNode(this.targetCanvasPos)
            },
            {
                label: '文本节点',
                // 文档线条（备注/注释语义）
                icon: svgIcon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>'),
                action: () => this.addTextNode(this.targetCanvasPos)
            }
        ];

        // 重建菜单内容
        this.menuEl.innerHTML = '';
        items.forEach(item => {
            const btn = document.createElement('button');
            btn.className = 'canvas-context-menu-item';
            btn.innerHTML = `<span class="canvas-context-menu-icon">${item.icon}</span><span>${item.label}</span>`;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.hide();
                item.action();
            });
            this.menuEl.appendChild(btn);
        });

        // 定位并显示（位置微调避免贴边）
        this.menuEl.style.left = screenX + 'px';
        this.menuEl.style.top = screenY + 'px';
        this.menuEl.classList.add('show');
        this.isVisible = true;

        // 防止菜单超出视口右/下边缘
        const rect = this.menuEl.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            this.menuEl.style.left = (screenX - rect.width) + 'px';
        }
        if (rect.bottom > window.innerHeight) {
            this.menuEl.style.top = (screenY - rect.height) + 'px';
        }
    }

    /**
     * 创建菜单 DOM（首次调用时）
     */
    ensureMenuEl() {
        if (this.menuEl) return;
        this.menuEl = document.createElement('div');
        this.menuEl.className = 'canvas-context-menu';
        document.body.appendChild(this.menuEl);
    }

    /**
     * 隐藏菜单
     */
    hide() {
        if (this.menuEl) {
            this.menuEl.classList.remove('show');
        }
        this.isVisible = false;
    }

    /**
     * 在指定画布坐标添加一个提示词节点（新节点居中于鼠标位置）
     * @param {{x: number, y: number}} pos - 画布坐标
     */
    addPromptNode(pos) {
        const node = new PromptNode(
            this.canvas,
            pos.x - PromptNode.DEFAULT_WIDTH / 2,
            pos.y - PromptNode.DEFAULT_HEIGHT / 2
        );
        this.canvas.images.images.push(node);
        // 新节点默认选中，便于立即拖动定位
        this.canvas.images.select(node.id);
        this.canvas.draw();
        window.dispatchEvent(new CustomEvent('promptNodeAdded', {
            detail: { node }
        }));
    }

    /**
     * 在指定画布坐标添加一个生图节点（新节点居中于鼠标位置）
     * @param {{x: number, y: number}} pos - 画布坐标
     */
    addImageGenNode(pos) {
        const node = new ImageGenNode(
            this.canvas,
            pos.x - ImageGenNode.DEFAULT_WIDTH / 2,
            pos.y - ImageGenNode.DEFAULT_HEIGHT / 2
        );
        this.canvas.images.images.push(node);
        // 新节点默认选中，便于立即拖动定位
        this.canvas.images.select(node.id);
        this.canvas.draw();
    }

    /**
     * 在指定画布坐标添加一个 Comfy 生图节点（新节点居中于鼠标位置）
     * @param {{x: number, y: number}} pos - 画布坐标
     */
    addComfyGenNode(pos) {
        const node = new ComfyGenNode(
            this.canvas,
            pos.x - ComfyGenNode.DEFAULT_WIDTH / 2,
            pos.y - ComfyGenNode.DEFAULT_HEIGHT / 2
        );
        this.canvas.images.images.push(node);
        // 新节点默认选中，便于立即拖动定位
        this.canvas.images.select(node.id);
        this.canvas.draw();
    }

    /**
     * 在指定画布坐标添加一个文本节点（备注/注释用，不可连线）
     * @param {{x: number, y: number}} pos - 画布坐标
     */
    addTextNode(pos) {
        const node = new TextNode(
            this.canvas,
            pos.x - TextNode.DEFAULT_WIDTH / 2,
            pos.y - TextNode.DEFAULT_HEIGHT / 2
        );
        this.canvas.images.images.push(node);
        // 新节点默认选中并进入编辑，便于直接输入备注
        this.canvas.images.select(node.id);
        this.canvas.draw();
    }

    /**
     * 在指定画布坐标添加一个 LoRA 节点（可堆叠的 LoRA 组合，
     * 串在提示词链路中作用于下游 Comfy 生图节点）
     * @param {{x: number, y: number}} pos - 画布坐标
     */
    addLoraNode(pos) {
        const node = new LoraNode(
            this.canvas,
            pos.x - LoraNode.DEFAULT_WIDTH / 2,
            pos.y - LoraNode.DEFAULT_HEIGHT / 2
        );
        this.canvas.images.images.push(node);
        // 新节点默认选中，便于立即拖动定位
        this.canvas.images.select(node.id);
        this.canvas.draw();
    }
}

// 将 CanvasContextMenu 类暴露到全局作用域
window.CanvasContextMenu = CanvasContextMenu;
