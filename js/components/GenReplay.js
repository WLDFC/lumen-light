/**
 * ==========================================================================
 * LumenLight 生成同款回放器（GenReplay）——「生成同款」按钮的动作层
 * ==========================================================================
 * 职责：把图片上的生成参数记录（genInfo，见 utils/GenRecord.js）回填到
 *       生成链路，可选立即重跑。按模式分路径：
 *   - comfy：走面板路径——切 Comfy 模式 → 选记录工作流 → 覆盖写正面/
 *     负面框（ADR 037 契约：写框不派发合成 input）→ 回填步数/CFG 等
 *     参数（null = 模板值）→ run 时触发面板发送。提示词全量来自记录，
 *     与画布上游现状无关——这是「同款」语义最完整的路径
 *   - api：回填来源生图节点的模型/比例/质量（提示词取当前链路——上游
 *     未改动即同款；原提示词可在弹窗复制），run 时触发节点生成；
 *     节点已删除则如实提示
 *   - rh：来源节点仍在画布时直接重跑（参数随节点保留），已删则如实提示
 * ==========================================================================
 */

const GenReplay = {
    /**
     * 回填入口
     * @param {Object} genInfo - 图片上的生成参数记录
     * @param {Object} [opts] - { run: boolean } true = 回填后立即生成
     * @returns {Promise<boolean>} 是否回填成功
     */
    async apply(genInfo, opts = {}) {
        const run = !!opts.run;
        try {
            if (!genInfo || !genInfo.mode) {
                GenReplay._toast('该图片没有生成记录');
                return false;
            }
            if (genInfo.mode === 'comfy') return await GenReplay._applyComfy(genInfo, run);
            if (genInfo.mode === 'api') return GenReplay._applyApi(genInfo, run);
            if (genInfo.mode === 'rh') return GenReplay._applyRh(genInfo, run);
            GenReplay._toast('未知的生成记录类型');
            return false;
        } catch (err) {
            console.error('生成同款回放失败:', err);
            GenReplay._toast(`回填失败：${err.message || '未知错误'}`);
            return false;
        }
    },

    /**
     * Comfy 记录回填（面板路径）：工作流 + 提示词 + 参数三件全量恢复
     */
    async _applyComfy(info, run) {
        const panel = window.promptPanel;
        const pim = window.promptInputManager || panel?.promptInputManager;
        if (!panel || !pim) {
            GenReplay._toast('提示词面板未初始化，无法回填');
            return false;
        }

        // 切到 Comfy 模式（复用面板模式切换监听，LLM 区收起 Comfy 区展开）
        const modeSelect = document.getElementById('promptMode');
        if (modeSelect && modeSelect.value !== 'comfy') {
            modeSelect.value = 'comfy';
            modeSelect.dispatchEvent(new Event('change'));
        }

        // 选记录工作流（可能已被删除：失败如实提示并中止，不带残缺状态续跑）
        if (info.workflowId && panel.workflowManager?.selectWorkflow) {
            try {
                await panel.workflowManager.selectWorkflow(info.workflowId);
            } catch (err) {
                GenReplay._toast(`工作流加载失败：${err.message || '可能已被删除'}`);
                return false;
            }
        }

        // 提示词覆盖写入（ADR 037：写框不派发合成 input；两框合并语义——
        // 全文进框1、框2 清空，保证 getPrompts 读回一致）
        if (pim.posPrompt) pim.posPrompt.value = info.positive || '';
        if (pim.posPrompt2) pim.posPrompt2.value = '';
        if (pim.negPrompt) pim.negPrompt.value = info.negative || '';

        // 参数回填（null 值显式写入 = 工作流模板值语义，setState 支持）
        const p = info.params || {};
        panel.comfyParams?.setState({
            steps: p.steps,
            cfg: p.cfg,
            sampler: p.sampler,
            sizeW: p.sizeW,
            sizeH: p.sizeH,
            denoise: p.denoise
        });

        // 主模型回填（弹窗内可改）：写入第一个 checkpoint/unet 加载器的
        // 模型选择（与面板 getGenInfo 读取同键）——selectWorkflow 已完成，
        // detected 即新模板的扫描结果；无加载器的工作流跳过。清单已拉到
        // 且记录模型不在其中时如实提示（下拉选中值可能被清单兜底替换）
        if (info.model && panel.comfyParams?.state?.models) {
            const loader = (panel.comfyParams.detected?.loaders || [])
                .find((l) => l.kind === 'checkpoint' || l.kind === 'unet');
            if (loader) {
                panel.comfyParams.state.models[loader.nodeId] = info.model;
                const list = panel.comfyParams.modelLists?.checkpoints || [];
                if (list.length && !list.includes(info.model)) {
                    GenReplay._toast('记录的主模型不在当前 ComfyUI 模型清单中，可能已被替换');
                }
            }
        }

        panel.comfyParams?.render?.();

        if (run) {
            panel.comfyRunner?.run();
            GenReplay._toast('已按记录参数提交生成');
        } else {
            GenReplay._toast('提示词与参数已回填到面板（LoRA 与参考图请按需手动补充）');
        }
        return true;
    },

    /**
     * API 生图记录回填：按来源分流——有画布来源节点走节点路径，
     * 无节点（LLM 面板聊天生图）走聊天窗口路径
     */
    _applyApi(info, run) {
        if (!info.sourceNodeId) return GenReplay._applyApiChat(info, run);

        const node = GenReplay._findNode(info.sourceNodeId, NodeTypes.isImageGenNode);
        if (!node) {
            GenReplay._toast('来源生图节点已删除，无法回填（原提示词可在弹窗复制）');
            return false;
        }

        // 模型写回下拉（复合键可能已不在当前清单——清单动态拉取过）：
        // value 赋不进去时如实提示，不静默丢参数
        if (info.model && node.modelSelect) {
            node.modelSelect.value = info.model;
            if (node.modelSelect.value === info.model) {
                node.modelSelect.dispatchEvent(new Event('change'));
            } else {
                GenReplay._toast('记录的模型不在当前模型清单中，已保留节点原模型');
            }
        }
        if (info.quality && node.qualitySelect) {
            node.qualitySelect.value = info.quality;
            node.qualitySelect.dispatchEvent(new Event('change'));
        }
        if (info.ratio && node.sizePicker?.setRatio) node.sizePicker.setRatio(info.ratio);
        if (info.tier && node.sizePicker?.setTier) node.sizePicker.setTier(info.tier);

        if (run) {
            node.generate();
            GenReplay._toast('已按记录参数在来源节点重新生成（提示词取当前链路）');
        } else {
            GenReplay._toast('模型与参数已回填到来源节点');
        }
        return true;
    },

    /**
     * 聊天窗口来源的 API 记录回填（LLM 面板生图拖入画布的图）：
     * 模型切回记录模型 + 提示词/比例/档位/质量按记录重发——走
     * sendImageGeneration 的"重新生成"通道（opts.ratio 传入即复用
     * 参数态：不清输入框、新图块照常追加在消息底部，参考图不随回填）。
     * 发送器走宿主公开薄代理（LlmChat.sendImageGeneration，内部是
     * this._sender）——拆分后发送器字段名带下划线，不摸私有面
     */
    async _applyApiChat(info, run) {
        const chat = window.llmChat;
        if (!chat || typeof chat.sendImageGeneration !== 'function') {
            GenReplay._toast('聊天窗口未初始化，无法回填');
            return false;
        }

        // 模型切回记录模型（未命中清单时如实提示，保留当前模型）
        let model = chat.modelDropdown?.value || info.model;
        if (info.model && chat.modelDropdown?.select) {
            if (chat.modelDropdown.select(info.model)) {
                model = info.model;
            } else {
                GenReplay._toast('记录的模型不在当前模型清单中，已保留当前模型');
            }
        }

        if (run) {
            await chat.sendImageGeneration(info.positive || '', model, {
                images: [],
                ratio: info.ratio || undefined,
                tier: info.tier || '2K',
                quality: info.quality || ''
            });
            GenReplay._toast('已按记录参数在聊天窗口重新生成');
        } else {
            if (chat.inputEl) chat.inputEl.value = info.positive || '';
            GenReplay._toast('提示词与模型已回填到聊天窗口（参考图不随回填）');
        }
        return true;
    },

    /**
     * RunningHub 记录回填：参数随节点保留，能跑就跑、不能跑如实说
     */
    _applyRh(info, run) {
        const node = GenReplay._findNode(info.sourceNodeId, NodeTypes.isRunHubGenNode);
        if (!node) {
            GenReplay._toast('来源 RunningHub 节点已删除，无法重生成（参数可参照弹窗记录）');
            return false;
        }
        if (run) {
            node.generate();
            GenReplay._toast('已提交来源节点重新生成');
        } else {
            GenReplay._toast('来源节点仍在画布上，参数随节点保留，可直接点生成');
        }
        return true;
    },

    /**
     * 按记录的来源节点 id 找画布节点（节点存于画布 images 数组）
     * @param {string} nodeId - 来源节点 id
     * @param {Function} predicate - NodeTypes 类型谓词
     * @returns {Object|null}
     */
    _findNode(nodeId, predicate) {
        if (!nodeId || !window.canvas) return null;
        return window.canvas.images.images.find(
            (img) => img.id === nodeId && predicate(img.source) &&
                     typeof img.generate === 'function'
        ) || null;
    },

    /** 轻提示（复用 socket 通知条） */
    _toast(message) {
        window.socket?.showNotification?.(message, 4000);
    }
};

// 导出为全局变量，供其他模块使用
window.GenReplay = GenReplay;
