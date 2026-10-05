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
        bypassInputTypes.set(id, info ? inputTypes(info) : null);
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
        let match = null;
        if (declared) {
            match = candidates.find((name) => typesMatch(declared[name], type)) || null;
        } else {
            // 离线启发式：同名连接输入优先，唯一连接输入时直接直通
            match = candidates.find((name) => name === sourceName)
                || (candidates.length === 1 ? candidates[0] : null);
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
        const declared = info ? inputTypes(info) : null;
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
