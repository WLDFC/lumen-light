/**
 * ==========================================================================
 * LumenLight 生成参数记录（GenRecord）——图片溯源与「生成同款」的数据层
 * ==========================================================================
 * 作用：应用内的生图链路（Comfy 生图节点 / Comfy 面板 / API 生图节点 /
 *       RunningHub 节点）在提交时构建一份参数快照，随占位图句柄绑定到
 *       回图（imageObj.genInfo），随存档持久化。pi 落图与网页桥接不登记
 *       （默认路径没有占位图与提交语境，天然无记录）。
 *       GenInfoPopup 负责展示（图片工具栏「生成同款」按钮唤出），
 *       GenReplay 负责「仅回填参数 / 生成同款」两个动作。
 *
 * 字段约定：
 *   - mode：'comfy' | 'api' | 'rh'，决定展示行装配与回填路径
 *   - time：提交时间戳
 *   - sourceNodeId / sourceNodeTitle：来源画布节点（面板链路为
 *     null / '提示词面板'）；标题经 getTitle()——含 #NNN 全局编号
 *   - comfy：workflowId/workflowName + params（steps/cfg/sampler/
 *     sizeW/sizeH/denoise，null = 工作流模板值，回填时不覆盖）+
 *     model（checkpoint/unet 加载器当前值）+ loras（叠加堆栈快照）
 *   - api：model 为下拉复合键 '厂商||模型ID'（回填直接写回下拉 value），
 *     另存 provider/size/quality/ratio/tier/refCount 供展示
 *   - rh：resourceKind/resourceId/resourceName/instanceType +
 *     paramList（非图片参数的 label/value 清单）
 * 纯数据层：零 DOM 依赖，Jest 可单测（describeRows 展示装配等）。
 * ==========================================================================
 */

const GenRecord = {
    /** 模式徽章文案 */
    MODE_LABELS: { comfy: 'ComfyUI', api: 'API 生图', rh: 'RunningHub' },

    /** 模式徽章文案（未知模式原样回显） */
    modeLabel(mode) {
        return GenRecord.MODE_LABELS[mode] || mode || '';
    },

    /**
     * 公共头字段（各链路共用）
     * @param {string} mode - 链路模式
     * @param {Object|null} node - 来源画布节点实例（无节点链路传 null）
     * @param {string} [sourceTitle] - 来源展示名覆盖（聊天窗口等非节点来源）
     */
    _base(mode, node, sourceTitle) {
        return {
            mode,
            time: Date.now(),
            sourceNodeId: node ? (node.id || null) : null,
            sourceNodeTitle: sourceTitle
                || (node
                    ? (typeof node.getTitle === 'function' ? node.getTitle() : (node.title || ''))
                    : '提示词面板')
        };
    },

    /**
     * Comfy 链路记录（画布 Comfy 生图节点 / 提示词面板提交共用）
     * @param {Object} o - { positive, negative, workflowId, workflowName,
     *                      params, model, loras, node, sourceTitle? }
     */
    forComfy(o = {}) {
        return {
            ...GenRecord._base('comfy', o.node, o.sourceTitle),
            workflowId: o.workflowId || '',
            workflowName: o.workflowName || '',
            positive: o.positive || '',
            negative: o.negative || '',
            params: {
                steps: o.params?.steps ?? null,
                cfg: o.params?.cfg ?? null,
                sampler: o.params?.sampler ?? null,
                sizeW: o.params?.sizeW ?? null,
                sizeH: o.params?.sizeH ?? null,
                denoise: o.params?.denoise ?? null
            },
            model: o.model || '',
            loras: (Array.isArray(o.loras) ? o.loras : [])
                .filter((l) => l && l.file)
                .map((l) => ({
                    file: l.file,
                    strengthModel: l.strengthModel,
                    strengthClip: l.strengthClip
                }))
        };
    },

    /**
     * API 生图链路记录（画布 API 生图节点 / LLM 面板聊天生图共用：
     * 无 sourceNodeId 的记录 = 聊天窗口来源，回填走聊天窗口）
     * @param {Object} o - { positive, model, provider, size, quality,
     *                      ratio, tier, refCount, node, sourceTitle? }
     */
    forApi(o = {}) {
        return {
            ...GenRecord._base('api', o.node, o.sourceTitle),
            positive: o.positive || '',
            negative: o.negative || '',
            model: o.model || '',
            provider: o.provider || '',
            size: o.size || null,
            quality: o.quality || '',
            ratio: o.ratio || '',
            tier: o.tier || '',
            refCount: o.refCount || 0
        };
    },

    /**
     * RunningHub 云端链路记录（画布 RunningHub 生成节点）
     * @param {Object} o - { positive, negative, resourceKind, resourceId,
     *                      resourceName, instanceType, paramList, node, sourceTitle? }
     */
    forRh(o = {}) {
        return {
            ...GenRecord._base('rh', o.node, o.sourceTitle),
            positive: o.positive || '',
            negative: o.negative || '',
            resourceKind: o.resourceKind || 'workflow',
            resourceId: o.resourceId || '',
            resourceName: o.resourceName || '',
            instanceType: o.instanceType || '',
            paramList: (Array.isArray(o.paramList) ? o.paramList : [])
                .filter((p) => p && p.label)
                .map((p) => ({ label: String(p.label), value: String(p.value ?? '') }))
        };
    },

    /**
     * 装配弹窗参数摘要行（空值不占行：null = 工作流模板值未覆盖）
     * @param {Object} info - genInfo 记录
     * @returns {Array<{label: string, value: string}>}
     */
    describeRows(info) {
        if (!info) return [];
        const rows = [];
        const push = (label, value) => {
            if (value === null || value === undefined || value === '') return;
            rows.push({ label, value: String(value) });
        };
        if (info.mode === 'comfy') {
            push('工作流', info.workflowName || info.workflowId);
            push('主模型', info.model);
            const p = info.params || {};
            push('步数', p.steps);
            push('CFG', p.cfg);
            push('采样器', p.sampler);
            push('尺寸', p.sizeW && p.sizeH ? `${p.sizeW} × ${p.sizeH}` : null);
            push('去噪', p.denoise);
        } else if (info.mode === 'api') {
            // 下拉复合键 '厂商||模型ID'：展示取模型 ID 段（厂商段只在
            // 同名模型多中转站时才有区分意义，展示层不单列——记录里仍保留）
            const composite = String(info.model || '');
            push('模型', composite.includes('||') ? composite.split('||').pop() : composite);
            push('比例', info.ratio && info.tier ? `${info.ratio} / ${info.tier}` : info.ratio);
            push('尺寸', info.size);
            push('质量', info.quality);
            push('参考图', info.refCount ? `${info.refCount} 张` : null);
        } else if (info.mode === 'rh') {
            push('类型', info.resourceKind === 'app' ? '应用' : '工作流');
            push('资源', info.resourceName || info.resourceId);
            push('档位', info.instanceType);
            for (const p of info.paramList || []) push(p.label, p.value);
        }
        return rows;
    },

    /**
     * LoRA 条目展示文本：文件名 + 模型强度（≠1 时括号标注）
     * @param {Object} l - { file, strengthModel, strengthClip }
     * @returns {string}
     */
    loraText(l) {
        if (!l || !l.file) return '';
        const s = l.strengthModel;
        return (s !== undefined && s !== null && Number(s) !== 1)
            ? `${l.file} (${Number(s)})`
            : l.file;
    },

    /** 时间戳 → 'YYYY-MM-DD HH:mm' 展示 */
    formatTime(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
            `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
};

// 导出为全局变量，供其他模块使用
window.GenRecord = GenRecord;
