/**
 * ==========================================================================
 * LumenLight 通用层级树列表预制件（LumenTreeList）
 * ==========================================================================
 * 作用：把扁平节点清单（含 parentId）渲染成可折叠的层级树行。收藏页
 * 标签侧栏（用户建的三级子标签）、移动目标选择框、LoRA 文件夹侧栏
 * （磁盘子文件夹）共用。行内容（标签钮/操作钮/计数等）由宿主通过
 * buildRows 回调填充，本组件只管树形装配、缩进、折叠箭头与记忆。
 *
 * 使用方式：
 *   const tree = new LumenTreeList({
 *       container: listEl,                 // 行渲染进这个容器
 *       collapsedKey: 'lumen.xxx',         // 折叠记忆的 localStorage key；
 *                                          //   不传 = 不显示箭头、始终展开
 *       buildRows: (row, item, depth) => { // 宿主填充行内容
 *           row.classList.add('recipe-models-item');  // 可叠加宿主样式类
 *           const label = ...; row.appendChild(label);
 *       }
 *   });
 *   tree.setNodes([{ id, name, parentId? }]);  // 扁平清单，缺 parentId = 顶层
 *   tree.render();
 *   tree.expand(id);   // 展开某节点（清折叠记忆并重绘，输入框插子级前用）
 *   tree.isOpen(id);
 *
 * 行结构：[折叠箭头|占位] + 宿主内容。宿主行上可读 item/depth 数据。
 * 数据防呆：父引用断链（父已删）按顶层兜底；成环脏数据从任何根不可达，
 * DFS 后漏网的并回顶层，保证一个不丢。
 * ==========================================================================
 */

class LumenTreeList {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - 行容器（render 时先清空）
     * @param {string} [options.collapsedKey] - 折叠记忆 localStorage key（缺省不折叠）
     * @param {Function} options.buildRows - (row, item, depth) => void 宿主填行
     */
    constructor({ container, collapsedKey, buildRows } = {}) {
        this.container = container;
        this.collapsedKey = collapsedKey || null;
        this.buildRows = buildRows || (() => {});
        this.nodes = [];
        this.collapsedIds = this._readCollapsed();
    }

    /** 替换节点清单（不自动渲染，配 render() 调用） */
    setNodes(nodes) {
        this.nodes = Array.isArray(nodes) ? nodes : [];
    }

    /** 装配成树：childrenMap + 顶层（断链归根、漏网并回） */
    _buildTree() {
        const byId = new Map(this.nodes.map((n) => [n.id, n]));
        const childrenMap = new Map();
        const roots = [];
        for (const node of this.nodes) {
            const parent = node.parentId ? byId.get(node.parentId) : null;
            if (parent) {
                if (!childrenMap.has(node.parentId)) childrenMap.set(node.parentId, []);
                childrenMap.get(node.parentId).push(node);
            } else {
                roots.push(node);
            }
        }
        // 成环兜底：从顶层 DFS 收集可达节点，漏网的并回顶层
        const reachable = new Set();
        const walk = (id) => {
            reachable.add(id);
            for (const child of childrenMap.get(id) || []) walk(child.id);
        };
        for (const root of roots) walk(root.id);
        for (const node of this.nodes) {
            if (!reachable.has(node.id)) roots.push(node);
        }
        return { roots, childrenMap };
    }

    /** 重绘整棵树（折叠的子层跳过） */
    render() {
        this.container.replaceChildren();
        const { roots, childrenMap } = this._buildTree();
        const appendTree = (nodes, depth) => {
            for (const node of nodes) {
                const children = childrenMap.get(node.id) || [];
                const collapsed = this.collapsedIds.has(node.id);
                const row = document.createElement('div');
                row.className = 'lumen-tree-item';
                row.classList.add(`is-depth-${Math.min(depth, 2)}`);
                row.dataset.nodeId = node.id;
                row.classList.toggle('is-open', children.length > 0 && !collapsed);
                if (children.length > 0) {
                    row.appendChild(this._createCaret(node, !collapsed));
                } else if (this.collapsedKey) {
                    // 有折叠能力的清单里，叶子也留等宽占位保持名字对齐
                    const spacer = document.createElement('span');
                    spacer.className = 'lumen-tree-caret-spacer';
                    row.appendChild(spacer);
                }
                this.buildRows(row, node, depth);
                this.container.appendChild(row);
                if (!collapsed && children.length) appendTree(children, depth + 1);
            }
        };
        appendTree(roots, 0);
    }

    /** 折叠箭头：点击切换并持久化记忆后重绘 */
    _createCaret(node, isOpen) {
        const caret = document.createElement('button');
        caret.className = 'lumen-tree-caret';
        caret.type = 'button';
        caret.textContent = '▸';
        caret.title = isOpen ? '折叠' : '展开';
        caret.setAttribute('aria-expanded', String(isOpen));
        caret.setAttribute('aria-label', `${isOpen ? '折叠' : '展开'} ${node.name}`);
        caret.addEventListener('click', (event) => {
            event.stopPropagation();
            if (this.collapsedIds.has(node.id)) this.collapsedIds.delete(node.id);
            else this.collapsedIds.add(node.id);
            if (this.collapsedKey) {
                localStorage.setItem(this.collapsedKey, JSON.stringify([...this.collapsedIds]));
            }
            this.render();
        });
        return caret;
    }

    /** 读折叠记忆（坏数据静默归空） */
    _readCollapsed() {
        if (!this.collapsedKey) return new Set();
        try {
            const list = JSON.parse(localStorage.getItem(this.collapsedKey) || '[]');
            return new Set(Array.isArray(list) ? list.filter((id) => typeof id === 'string') : []);
        } catch {
            return new Set();
        }
    }

    /** 展开指定节点（清其折叠态；有折叠能力时持久化并重绘） */
    expand(id) {
        if (!this.collapsedIds.has(id)) return;
        this.collapsedIds.delete(id);
        if (this.collapsedKey) {
            localStorage.setItem(this.collapsedKey, JSON.stringify([...this.collapsedIds]));
        }
        this.render();
    }

    /** 节点当前是否展开 */
    isOpen(id) {
        return !this.collapsedIds.has(id);
    }
}

window.LumenTreeList = LumenTreeList;
