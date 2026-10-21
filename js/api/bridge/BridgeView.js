/**
 * ==========================================================================
 * LumenSocket 子模块：桥接命令·视图/撤销/面板/存档（自 LumenSocket.js 拆出）
 * 作用：画布周边操作——view_focus 视口聚焦（全部内容/当前选中/指定对象，
 *       纯查看辅助不改内容）、select_set 设置选中集（ids 或 names，先清
 *       后设幂等）、history_step 撤销/重做步进、set_prompts 面板提示词
 *       写入（正面两框合并语义：全文进框1、清空框2，读回与写入一致）、
 *       archive_save 存档快照（指定 name=另存不覆盖；不指定=保存当前档，
 *       未命名报错不弹窗——弹窗会挂住桥接应答到超时）。
 * 契约：原型混入（partial-class，ADR 027）——方法 Object.assign 进
 *       LumenSocket.prototype，this 即 socket 实例；须后于主类文件加载。
 *       view_focus 跨域消费 _findBridgeMedia（BridgeMedia）与
 *       _findBridgeNode（BridgeGraph），经原型解析无 import。
 * ==========================================================================
 */

Object.assign(window.LumenSocket.prototype, {

    /**
     * view_focus：视口聚焦——all=全部内容 / selected=当前选中 / 其余按
     * 对象 id 或名称（与画布「自适应屏幕」同款 fitToBounds）
     */
    async _bridgeViewFocus(params) {
        const c = this.canvas;
        const target = params.target === undefined ? 'all' : params.target;
        let objs;
        if (target === 'all') {
            objs = c.images.images.filter(img => !NodeTypes.isPlaceholder(img.source));
        } else if (target === 'selected') {
            objs = c.images.getSelected().filter(img => !NodeTypes.isPlaceholder(img.source));
        } else {
            const one = this._findBridgeMedia({ id: target }) ||
                this._findBridgeMedia({ name: target }) ||
                this._findBridgeNode(target, { optional: true });
            objs = one ? [one] : [];
        }
        if (objs.length === 0) throw new Error(`没有可聚焦的内容（target: ${target}）`);
        // 与画布「自适应屏幕」同款调用（Canvas.js init 复位视口同源）
        c.viewport.fitToBounds(objs, c.cssWidth, c.cssHeight);
        c.draw();
        return {
            focused: objs.length,
            scale: c.viewport.scale,
            offsetX: Math.round(c.viewport.offsetX),
            offsetY: Math.round(c.viewport.offsetY)
        };
    },

    /**
     * select_set：设置选中集——ids 或 names 二选一（names 匹配媒体对象）。
     * 总是先清空再设置（幂等）；单选会被置顶（数组序号变化，引用 index
     * 的后续操作以 get_state 最新快照为准）
     */
    async _bridgeSelectSet(params) {
        const c = this.canvas;
        const ids = Array.isArray(params.ids) ? params.ids.map(String) : null;
        const names = Array.isArray(params.names) ? params.names.map(String) : null;
        if (!ids && !names) throw new Error('缺少 ids 或 names 数组');
        c.images.select(null);
        const picked = [];
        const missing = [];
        if (ids) {
            for (const id of ids) {
                const obj = c.images.images.find(img => img.id === id &&
                    !NodeTypes.isPanelNode(img.source) && !NodeTypes.isPlaceholder(img.source));
                if (obj) { c.images.toggleSelect(obj.id); picked.push(obj); }
                else missing.push(id);
            }
        } else {
            for (const name of names) {
                const obj = c.images.images.find(img =>
                    !NodeTypes.isPanelNode(img.source) &&
                    !NodeTypes.isPlaceholder(img.source) &&
                    (img.name || '') === name);
                if (obj) { c.images.toggleSelect(obj.id); picked.push(obj); }
                else missing.push(name);
            }
        }
        c.draw();
        if (picked.length === 0) throw new Error(`未选中任何对象（未找到：${missing.join('、')}）`);
        return {
            selected: picked.map(o => o.name || o.id),
            missing
        };
    },

    /** history_step：画布撤销/重做步进（canvas_undo 工具） */
    async _bridgeHistoryStep(params) {
        const c = this.canvas;
        const h = c.history;
        if (!h) throw new Error('画布历史记录不可用');
        const action = params.action === 'redo' ? 'redo' : params.action === 'undo' ? 'undo' : null;
        if (!action) throw new Error('action 须为 undo 或 redo');
        if (action === 'undo') {
            if (!h.canUndo) throw new Error('没有可撤销的操作');
            h.undo();
        } else {
            if (!h.canRedo) throw new Error('没有可重做的操作');
            h.redo();
        }
        return { action, canUndo: h.canUndo, canRedo: h.canRedo };
    },

    /**
     * set_prompts：面板提示词写入（canvas_set_prompts 工具）。面板正面是
     * 两框合并语义（框1 质量画风 / 框2 内容）：写入时全文进框1、清空框2，
     * 保证 getPrompts 读回与写入一致
     */
    async _bridgeSetPrompts(params) {
        const pim = window.promptInputManager;
        if (!pim) throw new Error('提示词面板未初始化');
        if (params.positive === undefined && params.negative === undefined) {
            throw new Error('至少提供 positive / negative 之一');
        }
        if (params.positive !== undefined) {
            if (pim.posPrompt) pim.posPrompt.value = String(params.positive);
            if (pim.posPrompt2) pim.posPrompt2.value = '';
        }
        if (params.negative !== undefined && pim.negPrompt) {
            pim.negPrompt.value = String(params.negative);
        }
        return pim.getPrompts();
    },

    /**
     * archive_save：存档快照（canvas_archive 工具）。指定 name：另存新档
     * （重名自动加序号，不覆盖）；不指定：保存当前档，画布未命名时报错
     * 而不是弹窗（弹窗会挂住桥接应答直到超时，agent 无法与模态框交互）
     */
    async _bridgeArchiveSave(params) {
        const sm = window.saveManager;
        if (!sm) throw new Error('存档管理器未初始化');
        if (params.name) {
            const name = sm.sanitizeFolderName(String(params.name));
            if (!name) throw new Error('无效的存档名');
            await sm.saveViaHttp(name, false, () => {});
            return { saved: true, archive: name, created: true };
        }
        if (!sm.currentSave) {
            throw new Error('当前画布未命名：请传 name 参数指定存档名，或先在界面上另存');
        }
        await sm.saveProject();
        return { saved: true, archive: sm.currentSave, created: false };
    },
});
