/**
 * ==========================================================================
 * LumenLight 通用右键菜单预制件（LumenContextMenu）
 * ==========================================================================
 * 作用：光标处弹出的操作菜单（收藏页卡片右键、LoRA 卡片右键共用）。
 * 调用方给出 items 与坐标，本组件负责 DOM、视口内定位、外点/Esc/滚动/
 * 缩放关闭。视觉遵循项目深色色板（.lumen-ctx-*）。
 *
 * 使用方式：
 *   const menu = new LumenContextMenu({ container: someDialog }); // 挂哪随宿主
 *   menu.open({ x: e.clientX, y: e.clientY, items: [
 *       { label: '移动到…', onClick: () => {} },
 *       { label: '删除', danger: true, onClick: () => {} }
 *   ]});
 *   menu.close(); menu.isOpen;
 *
 * 设计说明：
 *   - 生命周期内监听（open 挂 / close 摘），不常驻 document；
 *   - Esc 由本组件自关；宿主若还有自己的 Esc 链，先查 isOpen 再处理，
 *     避免同一按键连锁触发多层；
 *   - 菜单项 click 先于外点关闭（捕获监听在 document 上，菜单内点击
 *     contains 命中不会误关）。
 * ==========================================================================
 */

class LumenContextMenu {
    /**
     * @param {Object} [options]
     * @param {HTMLElement} [options.container=document.body] - 菜单挂载容器
     *        （建议传宿主弹窗根，随弹窗生命周期存在；默认挂 body）
     */
    constructor({ container = document.body } = {}) {
        this.container = container;
        this.menu = null;
        this._outsideClose = null;
        this._keyClose = null;
        this._scrollClose = null;
    }

    /** 菜单是否打开 */
    get isOpen() {
        return !!(this.menu && this.menu.classList.contains('is-open'));
    }

    /**
     * 打开菜单（已在打开状态时先收再开，保证 items 全量重建）
     * @param {Object} params
     * @param {number} params.x - 视口坐标 clientX
     * @param {number} params.y - 视口坐标 clientY
     * @param {Array<{label: string, danger?: boolean, onClick: Function}>} params.items
     */
    open({ x, y, items }) {
        this.close();
        if (!this.menu) {
            this.menu = document.createElement('div');
            this.menu.className = 'lumen-ctx-menu';
            this.menu.setAttribute('role', 'menu');
            this.container.appendChild(this.menu);
        }
        // 复用容器：先清上一次的条目，防旧闭包菜单项残留可点
        this.menu.replaceChildren();
        for (const item of items || []) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'lumen-ctx-item' + (item.danger ? ' is-danger' : '');
            btn.textContent = item.label;
            btn.setAttribute('role', 'menuitem');
            btn.addEventListener('click', () => {
                this.close();
                item.onClick?.();
            });
            this.menu.appendChild(btn);
        }
        this.menu.classList.add('is-open');
        // 光标处展示，超界回退（fixed 定位与 clientX/Y 同坐标系）
        const nx = Math.min(x, window.innerWidth - this.menu.offsetWidth - 8);
        const ny = Math.min(y, window.innerHeight - this.menu.offsetHeight - 8);
        this.menu.style.left = `${Math.max(8, nx)}px`;
        this.menu.style.top = `${Math.max(8, ny)}px`;

        // 外点关闭（捕获：菜单项自身点击 contains 命中不误关）
        this._outsideClose = (e) => {
            if (!this.menu.contains(e.target)) this.close();
        };
        this._keyClose = (e) => { if (e.key === 'Escape') this.close(); };
        this._scrollClose = () => this.close();   // fixed 菜单滚动会脱离宿主
        document.addEventListener('click', this._outsideClose, true);
        document.addEventListener('keydown', this._keyClose);
        window.addEventListener('scroll', this._scrollClose, true);
        window.addEventListener('resize', this._scrollClose);
    }

    /** 关闭菜单并摘除监听（DOM 保留复用） */
    close() {
        if (!this.isOpen) return;
        this.menu.classList.remove('is-open');
        document.removeEventListener('click', this._outsideClose, true);
        document.removeEventListener('keydown', this._keyClose);
        window.removeEventListener('scroll', this._scrollClose, true);
        window.removeEventListener('resize', this._scrollClose);
        this._outsideClose = this._keyClose = this._scrollClose = null;
    }
}

window.LumenContextMenu = LumenContextMenu;
