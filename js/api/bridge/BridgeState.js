/**
 * ==========================================================================
 * LumenSocket 子模块：桥接命令·查看与快照（自 LumenSocket.js 拆出）
 * 作用：只读类桥接命令——get_state 画布状态快照（媒体清单/选中集/DOM 节点
 *       清单/连线拓扑/视口/提示词/存档名，agent 搭图与节点运维前的事实来源）、
 *       get_prompts 面板提示词读取、search_assets 资产库网格缓存检索。
 * 契约：原型混入（partial-class，ADR 027）——方法 Object.assign 进
 *       LumenSocket.prototype，this 即 socket 实例（canvas/imageManager/
 *       辅助方法经 this 取用）；须后于主类文件加载。命令名 → 方法名的
 *       注册表见主类 static BRIDGE_COMMANDS()。
 * ==========================================================================
 */

Object.assign(window.LumenSocket.prototype, {

    /** get_state：画布状态快照（selected 放最前——长结果下不易被截断遗漏） */
    async _bridgeGetState(params) {
        const c = this.canvas;
        const media = c.images.images
            .filter(img => !NodeTypes.isPanelNode(img.source) && !NodeTypes.isPlaceholder(img.source))
            .map((img, index) => ({
                index,
                id: img.id,
                name: img.name || '',
                type: NodeTypes.isVideo(img.source) ? 'video' : 'image',
                x: Math.round(img.x), y: Math.round(img.y),
                width: Math.round(img.width), height: Math.round(img.height)
            }));
        // 当前选中的图片（ImageManager.selectedIds 维护，多选有序）：
        // agent 据此知道用户正在操作哪些图，配合 get_image 的 name/index
        // 参数即可对"选中的那张"做后续处理
        const selected = c.images.getSelected().map((img) => ({
            index: c.images.images
                .filter(m => !NodeTypes.isPanelNode(m.source) && !NodeTypes.isPlaceholder(m.source))
                .indexOf(img),
            id: img.id,
            name: img.name || ''
        })).filter(s => s.index >= 0);
        // DOM 节点清单（提示词/文本/LoRA/三类生图节点）：agent 搭建或
        // 修改节点工作流前需要知道现有节点的 id/类型/内容/位置
        const nodes = c.images.images
            .filter(img => NodeTypes.isPanelNode(img.source))
            .map(n => ({
                id: n.id,
                type: n.source,
                x: Math.round(n.x), y: Math.round(n.y),
                width: Math.round(n.width), height: Math.round(n.height),
                ...(NodeTypes.isPromptNode(n.source) || NodeTypes.isTextNode(n.source))
                    ? { text: n.text || '' } : {},
                ...(n.title ? { title: n.title } : {}),
                ...(n.workflowId ? { workflowId: n.workflowId } : {}),
                ...(n.count ? { count: n.count } : {}),
                // image_gen 当前的比例/档位/质量（改参数前先看现值）
                ...(NodeTypes.isImageGenNode(n.source) ? {
                    ratio: n.sizePicker?.getRatio?.() || null,
                    tier: n.sizePicker?.getTier?.() || null,
                    quality: (n.qualityRow && n.qualityRow.style.display !== 'none')
                        ? (n.qualitySelect?.value || null) : null
                } : {}),
                // comfy_gen 当前标量参数（setState 部分更新的可见面）
                ...(NodeTypes.isComfyGenNode(n.source) && n.params ? {
                    comfyParams: {
                        steps: n.params.state?.steps ?? null,
                        cfg: n.params.state?.cfg ?? null,
                        sampler: n.params.state?.sampler ?? null,
                        sizeW: n.params.state?.sizeW ?? null,
                        sizeH: n.params.state?.sizeH ?? null,
                        denoise: n.params.state?.denoise ?? null
                    }
                } : {}),
                ...(NodeTypes.isLoraNode(n.source) ? {
                    loraFiles: (n.entries || []).filter(e => e.file).map(e => e.file)
                } : {})
            }));
        return {
            // selected 放最前：这是 agent 判断"用户正在操作哪张图"的关键
            // 信息，媒体清单可能很长（实测 14KB+），靠前放置保证长结果
            // 下也不易被截断遗漏
            selected,
            archive: window.saveManager?.currentSave || null,
            viewport: {
                scale: c.viewport.scale,
                offsetX: Math.round(c.viewport.offsetX),
                offsetY: Math.round(c.viewport.offsetY)
            },
            prompts: window.promptInputManager?.getPrompts() || { positive: '', negative: '' },
            nodes,
            // 连线清单：agent 修改/断开连线前需要知道现有拓扑
            // （from/to 为画布对象 id，与 nodes/media 的 id 同源）
            edges: c.connections.connections.map(conn => ({
                id: conn.id,
                from: conn.fromId,
                to: conn.toId
            })),
            media
        };
    },

    /** get_prompts：读取面板正面/负面提示词 */
    async _bridgeGetPrompts(params) {
        return window.promptInputManager?.getPrompts() || { positive: '', negative: '' };
    },

    /** search_assets：在资产库已加载的标签网格缓存中按名称子串匹配 */
    async _bridgeSearchAssets(params) {
        const lib = window.assetLibrary;
        if (!lib) throw new Error('资产库未初始化');
        const keyword = (params.keyword || '').toLowerCase();
        const results = [];
        for (const [tagName, entry] of lib._gridCache) {
            for (const f of entry.files) {
                if (!keyword || f.name.toLowerCase().includes(keyword)) {
                    results.push({
                        tag: tagName,
                        name: f.name,
                        type: CanvasVideoManager.isVideoFile(f) ? 'video' : 'image'
                    });
                }
            }
        }
        return { keyword, count: results.length, results: results.slice(0, 50) };
    },
});
