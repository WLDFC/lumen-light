/**
 * ==========================================================================
 * ComfyUI 工作流 bypass（忽略节点）图改写工具
 * ==========================================================================
 * 作用：把「被忽略节点」从待提交的工作流中剔除，并把下游连线按
 *       ComfyUI 同款规则直通重连——算法对齐其前端 graphToPrompt 编译期
 *       行为（ExecutableNodeDTO.resolveOutput）：
 *         - 被 bypass 节点不进入提交 JSON；
 *         - 其每个输出槽按「该节点输入中第一个类型匹配项」直通：
 *           下游输入重接到该输入的上游源，递归处理链式 bypass；
 *         - 无类型信息时（ComfyUI 离线）降级为同名启发式：
 *           先找与下游输入同名的连接输入，唯一连接输入时直接直通；
 *         - 匹配不上则断链（移除该输入），交由 ComfyUI /prompt 校验
 *           报错——与 ComfyUI 行为一致，不做智能兜底。
 *
 * 纯函数：不改传入对象，返回新工作流对象；类型信息来自 object_info
 * （{ [class_type]: { input: { required, optional }, output: [...] } }），
 * 由调用方（routes/comfyNode.js）在提交前获取。
 * ==========================================================================
 */

/** 输入类型匹配（双向兼容多类型声明）：a、b 任一为数组时看交集 */
function typesMatch(a, b) {
    if (!a || !b) return false;
    const as = Array.isArray(a) ? a : [a];
    const bs = Array.isArray(b) ? b : [b];
    return as.some((x) => bs.includes(x));
}

/**
 * 常见 bypass 相关节点的输入类型兜底表（object_info 不可用时的降级依据）。
 * 背景：offline 同名启发式对多连接输入节点会失效——如 LoraLoader 有
 * model/clip 两个连接输入，同名匹配与「唯一连接输入」条件双双落空，
 * 直通解析返回 null → 下游断链 → /prompt 校验失败（表现为提交无响应）。
 * 同时覆盖 bypass 链两端：被剔除的加载/编码节点与消费其输出的采样/解码
 * 节点——下游输入声明类型缺失时 type=null 同样无法匹配。
 * 本表只列标准 ComfyUI 节点族（参数面板/编辑器最常 bypass 的对象），
 * 自定义节点仍走同名启发式。类型名对齐 ComfyUI object_info 输入声明。
 */
const FALLBACK_INPUT_TYPES = {
    // 加载/变换节点（bypass 的主要目标）
    LoraLoader: { model: 'MODEL', clip: 'CLIP' },
    LoraLoaderModelOnly: { model: 'MODEL' },
    CheckpointLoaderSimple: { clip: 'CLIP', vae: 'VAE' },
    CLIPSetLastLayer: { clip: 'CLIP' },
    // 编码/条件节点（可能被 bypass，也是 CLIP 的消费方）
    CLIPTextEncode: { clip: 'CLIP' },
    CLIPTextEncodeSDXL: { clip: 'CLIP' },
    ConditioningZeroOut: { conditioning: 'CONDITIONING' },
    ConditioningCombine: { conditioning_1: 'CONDITIONING', conditioning_2: 'CONDITIONING' },
    // 采样/解码节点（bypass 输出的消费方，其输入类型决定直通匹配目标）
    KSampler: { model: 'MODEL', positive: 'CONDITIONING', negative: 'CONDITIONING', latent_image: 'LATENT' },
    KSamplerAdvanced: { model: 'MODEL', positive: 'CONDITIONING', negative: 'CONDITIONING', latent_image: 'LATENT' },
    VAEDecode: { samples: 'LATENT', vae: 'VAE' },
    VAEEncode: { pixels: 'IMAGE', vae: 'VAE' },
    VAEDecodeTiled: { samples: 'LATENT', vae: 'VAE' },
    EmptyLatentImage: { width: null, height: null, batch_size: null },
    UpscaleModelLoader: { model_name: null },
    ImageUpscaleWithModel: { upscale_model: 'UPSCALE_MODEL', image: 'IMAGE' }
};

/**
 * 解析节点的输入类型表：优先 object_info，缺失时查兜底表，再缺失走启发式
 * @param {string} classType - 节点 class_type
 * @param {Object|null} info - object_info 定义（可能缺失）
 * @returns {Object|null} { [输入名]: 类型 | null }（null 项 = 启发式）
 */
function resolveInputTypes(classType, info) {
    if (info) return inputTypes(info);
    const fallback = FALLBACK_INPUT_TYPES[classType];
    return fallback ? { ...fallback } : null;
}

/**
 * 提取节点全部输入的声明类型表：{ [输入名]: 类型 | 类型数组 | null }
 * classInfo 缺失（离线/自定义节点未装）时值为 null，走启发式
 */
function inputTypes(classInfo) {
    const result = {};
    const input = classInfo && classInfo.input;
    for (const group of [input && input.required, input && input.optional]) {
        if (!group) continue;
        for (const [name, spec] of Object.entries(group)) {
            if (result[name] !== undefined) continue;   // required 优先
            result[name] = Array.isArray(spec) ? spec[0] : null;
        }
    }
    return result;
}

/**
 * 应用 bypass：返回剔除被忽略节点并直通重连后的新工作流。
 * @param {Object} workflow - 纯 API 格式工作流（{ [id]: { class_type, inputs } }）
 * @param {Array<string|number>} bypassedIds - 被忽略的节点 id
 * @param {Object} classInfo - object_info 缓存 { [class_type]: def }
 * @returns {Object} 改写后的新工作流对象（入参不被修改）
 */
function applyBypass(workflow, bypassedIds, classInfo = {}) {
    const bypassSet = new Set((bypassedIds || []).map(String));
    if (bypassSet.size === 0) return workflow;

    // 每个被 bypass 节点的输入类型表与输入声明顺序（直通匹配用）
    const bypassInputTypes = new Map();
    const bypassInputOrder = new Map();
    for (const id of bypassSet) {
        const node = workflow[id];
        if (!node) continue;
        const info = classInfo[node.class_type] || null;
        // 类型表：object_info → 内置兜底表（LoraLoader 等多连接输入节点
        // 离线时靠它避免双信号断链）→ 都没有走同名启发式
        bypassInputTypes.set(id, resolveInputTypes(node.class_type, info));
        bypassInputOrder.set(id, info
            ? [...Object.keys(info.input && info.input.required || {}),
               ...Object.keys(info.input && info.input.optional || {})]
            : Object.keys(node.inputs || {}));
    }

    /**
     * 解析连线源：起点是被 bypass 节点时递归穿透，返回 [源节点id, 源槽位]；
     * 无法直通（无匹配输入/上游是常量/成环）返回 null
     * @param {string} type - 下游输入声明的类型（直通匹配目标）
     * @param {string} sourceName - 下游输入名（离线同名启发式用）
     */
    function resolveSource(nodeId, slot, type, sourceName, visited) {
        if (!bypassSet.has(String(nodeId))) return [nodeId, slot];
        const key = `${nodeId}:${slot}`;
        if (visited.has(key)) return null;   // 环：按断链处理
        visited.add(key);
        const node = workflow[nodeId];
        if (!node) return null;
        const declared = bypassInputTypes.get(String(nodeId));
        const order = bypassInputOrder.get(String(nodeId)) || [];
        const inputs = node.inputs || {};

        // 候选连接输入：declared 顺序（有类型信息时过滤类型匹配）
        const candidates = order.filter((name) => Array.isArray(inputs[name]));
        // 类型匹配优先：declared[name] 已知且与目标类型兼容时命中。
        // 目标类型未知（下游是自定义节点，不在 object_info/兜底表，type=null）
        // 时退到启发式——「宁直通不断链」：同名命中比直接断链更接近
        // ComfyUI 前端 bypass 的实际行为
        let match = candidates.find((name) =>
            type !== null && declared && declared[name] !== undefined &&
            typesMatch(declared[name], type)
        ) || null;
        if (!match) {
            // 启发式：同名连接输入优先；目标类型未知且唯一连接输入时直接直通
            match = candidates.find((name) => name === sourceName)
                || (type === null && candidates.length === 1 ? candidates[0] : null);
        }
        if (!match) return null;
        const value = inputs[match];
        if (!Array.isArray(value)) return null;
        return resolveSource(value[0], value[1], type, match, visited);
    }

    const result = {};
    for (const [id, node] of Object.entries(workflow)) {
        if (bypassSet.has(id)) continue;   // 被忽略节点不进提交 JSON
        const info = classInfo[node.class_type] || null;
        // 下游输入的声明类型：同样经兜底表降级（下游也是标准节点时离线仍可匹配）
        const declared = resolveInputTypes(node.class_type, info);
        const inputs = {};
        for (const [name, value] of Object.entries(node.inputs || {})) {
            if (Array.isArray(value)) {
                const type = declared ? declared[name] ?? null : null;
                const resolved = resolveSource(value[0], value[1], type, name, new Set());
                if (resolved) {
                    inputs[name] = [resolved[0], resolved[1]];
                }
                // resolved 为 null = 断链：移除该输入，交由 /prompt 校验报错
                continue;
            }
            inputs[name] = value;
        }
        result[id] = { ...node, inputs };
    }
    return result;
}

module.exports = { applyBypass, typesMatch };
