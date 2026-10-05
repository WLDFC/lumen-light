/**
 * ==========================================================================
 * 工作流 Prompt 注入工具
 * 作用：在将 ComfyUI 工作流提交到 ComfyUI 之前，自动把正面/负面提示词、
 *       随机种子注入到工作流对应的节点中。支持多种文本编码节点和 Sampler 连接追踪。
 * ==========================================================================
 */

// ==================== 节点类型识别辅助 ====================

// 支持的文本编码节点类型（ComfyUI 内置 + 常见自定义节点）。
// 唯一定义处：injectPromptsToWorkflow 与 findTextEncodeNode 共用
const TEXT_ENCODE_TYPES = [
    'CLIPTextEncode',
    'CLIPTextEncodeFlux',
    'TextEncodeQwenImageEditPlus',
    'CLIPTextEncodeSDXL',
    'CLIPTextEncodeHunyuanDiT'
];

/**
 * 判断节点类型是否为文本编码节点
 * （显式清单 + 兜底：任何名字带 TextEncode 的自定义节点）
 * @param {string} classType - 节点 class_type
 * @returns {boolean}
 */
function isTextEncodeType(classType) {
    return !!classType && (TEXT_ENCODE_TYPES.includes(classType) ||
        classType.includes('TextEncode'));
}

/**
 * 取文本编码节点的提示词输入字段名
 * @param {Object} inputs - 节点 inputs 对象
 * @returns {string|null} 'text' | 'prompt' | null（如 ConditioningZeroOut 无文本输入）
 */
function getPromptField(inputs) {
    if (inputs.text !== undefined) return 'text';
    if (inputs.prompt !== undefined) return 'prompt';
    return null;
}

/**
 * 判断节点类型是否为采样器节点（KSampler 系 / SamplerCustomAdvanced 等）
 * @param {string} classType - 节点 class_type
 * @returns {boolean}
 */
function isSamplerType(classType) {
    return !!classType && (classType.includes('KSampler') || classType.includes('Sampler'));
}

/**
 * 将正面和负面提示词注入到 ComfyUI 工作流中
 * @param {Object} workflow - ComfyUI 工作流对象
 * @param {string} positive - 正面提示词
 * @param {string} negative - 负面提示词
 * @returns {Object} 注入提示词后的工作流对象
 */
function injectPromptsToWorkflow(workflow, positive, negative) {
    console.log('  🔍 查找提示词节点...');

    // 先列出所有节点类型（调试用）
    const allNodes = [];
    for (const nodeId in workflow) {
        const node = workflow[nodeId];
        const classType = node.class_type || node.type;
        allNodes.push({ id: nodeId, type: classType });
    }
    console.log('  📋 所有节点:', allNodes.map(n => `${n.id}:${n.type}`).join(', '));

    // 查找所有文本编码节点
    const textEncodeNodes = [];
    for (const nodeId in workflow) {
        const node = workflow[nodeId];
        if (isTextEncodeType(node.class_type || node.type)) {
            textEncodeNodes.push(nodeId);
        }
    }

    console.log(`  📊 找到 ${textEncodeNodes.length} 个文本编码节点:`, textEncodeNodes.map(id => {
        const node = workflow[id];
        return `${id}(${node.class_type || node.type})`;
    }).join(', '));

    // 情况1：只有一个文本编码节点
    if (textEncodeNodes.length === 1) {
        const nodeId = textEncodeNodes[0];
        const node = workflow[nodeId];
        const inputs = node.inputs || {};

        const promptField = getPromptField(inputs);

        if (promptField) {
            inputs[promptField] = positive;
            console.log(`  ✅ 注入正面提示词到节点 ${nodeId}.${promptField}: ${positive.substring(0, 50)}...`);
        } else {
            console.log(`  ⚠️ 节点 ${nodeId} 没有 text 或 prompt 输入`);
        }

        // 查找负面提示词节点
        const negativeNodeId = findNegativeNode(workflow);
        // 负面链可能指向模板中不存在的节点（如旧版导出的悬空引用），做防御
        const negNode = (negativeNodeId && negativeNodeId !== nodeId)
            ? workflow[negativeNodeId] : null;

        if (negNode) {
            const negInputs = negNode.inputs || {};
            const negPromptField = getPromptField(negInputs);

            if (negPromptField) {
                negInputs[negPromptField] = negative;
                console.log(`  ✅ 注入负面提示词到节点 ${negativeNodeId}.${negPromptField}: ${negative.substring(0, 50)}...`);
            } else {
                console.log(`  ⚠️ 负面节点 ${negativeNodeId} 没有 text 或 prompt 输入，可能是 ConditioningZeroOut`);
            }
        } else {
            console.log('  ⚠️ 未找到负面提示词节点，只注入正面提示词');
        }
    } else if (textEncodeNodes.length >= 2) {
        // 情况2：有两个或以上文本编码节点，按连接判断正负
        for (const nodeId of textEncodeNodes) {
            const node = workflow[nodeId];
            const inputs = node.inputs || {};

            const promptField = getPromptField(inputs);

            if (promptField) {
                const isPositive = isPositiveNode(workflow, nodeId);

                if (isPositive === true) {
                    inputs[promptField] = positive;
                    console.log(`  ✅ 注入正面提示词到节点 ${nodeId}.${promptField}: ${positive.substring(0, 50)}...`);
                } else if (isPositive === false) {
                    inputs[promptField] = negative;
                    console.log(`  ✅ 注入负面提示词到节点 ${nodeId}.${promptField}: ${negative.substring(0, 50)}...`);
                } else {
                    // 无法判断，使用索引备用策略
                    const index = textEncodeNodes.indexOf(nodeId);
                    if (index === 0) {
                        inputs[promptField] = positive;
                        console.log(`  ✅ 注入正面提示词到节点 ${nodeId}.${promptField} (默认)`);
                    } else {
                        inputs[promptField] = negative;
                        console.log(`  ✅ 注入负面提示词到节点 ${nodeId}.${promptField} (默认)`);
                    }
                }
            }
        }
    } else {
        console.log('  ❌ 未找到文本编码节点！支持的类型: CLIPTextEncode, CLIPTextEncodeFlux, TextEncodeQwenImageEditPlus 等');
    }

    // 注入随机种子到工作流
    injectRandomSeed(workflow);

    return workflow;
}

/**
 * 生成一个随机种子
 * 范围：0 到 4294967295（2^32-1）。不少自定义节点（如 SeedVR2 系列）把
 * seed 上限定为 2^32-1，种子必须落在所有节点的合法区间内才能过校验；
 * 32 位随机对上限更大的节点（KSampler 系为 2^64-1）同样合法且空间足够。
 * @returns {number} 随机种子
 */
function generateRandomSeed() {
    return Math.floor(Math.random() * 0x100000000);
}

/**
 * 将随机种子注入到工作流中有 seed 输入的节点
 * @param {Object} workflow - ComfyUI 工作流对象
 */
function injectRandomSeed(workflow) {
    let seedInjected = false;

    console.log('  🔍 查找种子节点...');

    for (const nodeId in workflow) {
        const node = workflow[nodeId];
        const classType = node.class_type || node.type;
        const inputs = node.inputs || {};

        // 查找任何有 seed 输入的节点，为每个节点注入不同的随机种子
        // 这样可以让多个 KSampler / Seed 节点保持独立随机，和直接在 ComfyUI 中运行一致
        if (inputs.seed !== undefined) {
            const nodeSeed = generateRandomSeed();
            inputs.seed = nodeSeed;
            console.log(`  🎲 注入随机种子 ${nodeSeed} 到节点 ${nodeId} (${classType})`);
            seedInjected = true;
        }
    }

    if (!seedInjected) {
        console.log('  ⚠️ 未找到可注入种子的节点');
    }
}

/**
 * 查找负面提示词节点（递归追踪 Sampler 的 negative 输入链）
 * @param {Object} workflow - ComfyUI 工作流对象
 * @param {Set} visited - 已访问节点集合，防止循环
 * @returns {string|null} 负面节点 ID 或 null
 */
function findNegativeNode(workflow, visited = new Set()) {
    for (const id in workflow) {
        const node = workflow[id];
        const classType = node.class_type || node.type;

        // 查找 KSampler 或 SamplerCustomAdvanced 的 negative 输入
        if (isSamplerType(classType)) {
            const inputs = node.inputs || {};

            if (inputs.negative) {
                const negativeInput = Array.isArray(inputs.negative) ? inputs.negative[0] : inputs.negative;
                console.log(`  🔍 找到 Sampler 的 negative 输入来自节点: ${negativeInput}`);

                // 递归追踪，找到最终的文本编码节点
                const finalNode = findTextEncodeNode(workflow, negativeInput, visited);
                if (finalNode) {
                    console.log(`  ✅ 追踪到负面文本编码节点: ${finalNode}`);
                    return finalNode;
                }
                return String(negativeInput);
            }
        }
    }
    return null;
}

/**
 * 递归查找文本编码节点
 * @param {Object} workflow - ComfyUI 工作流对象
 * @param {string} nodeId - 起始节点 ID
 * @param {Set} visited - 已访问节点集合
 * @returns {string|null} 文本编码节点 ID 或 null
 */
function findTextEncodeNode(workflow, nodeId, visited = new Set()) {
    if (visited.has(nodeId)) return null;
    visited.add(nodeId);

    const node = workflow[nodeId];
    if (!node) return null;

    // 检查是否是文本编码节点
    if (isTextEncodeType(node.class_type || node.type)) {
        return String(nodeId);
    }

    // 递归检查输入连接
    const inputs = node.inputs || {};
    for (const key in inputs) {
        const inputValue = inputs[key];
        const inputNodeId = Array.isArray(inputValue) ? inputValue[0] : inputValue;
        const result = findTextEncodeNode(workflow, inputNodeId, visited);
        if (result) return result;
    }

    return null;
}

/**
 * 判断指定节点是否是正面提示词节点（递归追踪 Sampler 连接）
 * @param {Object} workflow - ComfyUI 工作流对象
 * @param {string} nodeId - 要判断的节点 ID
 * @param {Set} visited - 已访问节点集合
 * @returns {boolean|null} true 表示正面，false 表示负面，null 表示无法判断
 */
function isPositiveNode(workflow, nodeId, visited = new Set()) {
    // 防止循环引用
    if (visited.has(nodeId)) return null;
    visited.add(nodeId);

    // 查找所有采样器节点
    for (const id in workflow) {
        const node = workflow[id];
        const classType = node.class_type || node.type;

        if (isSamplerType(classType)) {
            const inputs = node.inputs || {};

            // 检查 positive 输入链
            if (inputs.positive) {
                const positiveInput = Array.isArray(inputs.positive) ? inputs.positive[0] : inputs.positive;
                if (String(positiveInput) === String(nodeId)) {
                    return true;
                }
            }

            // 检查 negative 输入链
            if (inputs.negative) {
                const negativeInput = Array.isArray(inputs.negative) ? inputs.negative[0] : inputs.negative;
                if (String(negativeInput) === String(nodeId)) {
                    return false;
                }
            }
        }
    }

    // 如果没有直接连接到 Sampler，检查是否有其他节点引用这个节点
    for (const id in workflow) {
        const node = workflow[id];
        const inputs = node.inputs || {};

        for (const key in inputs) {
            const inputValue = inputs[key];
            const inputNodeId = Array.isArray(inputValue) ? inputValue[0] : inputValue;

            if (String(inputNodeId) === String(nodeId)) {
                // 递归判断上游节点
                const newVisited = new Set(visited);
                const parentResult = isPositiveNode(workflow, id, newVisited);
                if (parentResult !== null) {
                    return parentResult;
                }
            }
        }
    }

    return null; // 无法判断
}

/**
 * 提交前预处理工作流（提示词面板与 Comfy 生图节点共用）：
 *   1. 移除 LumenLoadWorkflow 占位节点
 *   2. 为 LumenReceiveImageFromCanvas 节点设置随机 seed，强制刷新画板取图缓存
 * @param {Object} workflow - ComfyUI 工作流对象（调用方持有深拷贝，此处原地修改）
 * @returns {Object} 预处理后的工作流对象
 */
function prepareWorkflowForRun(workflow) {
    for (const nodeId in workflow) {
        const node = workflow[nodeId];
        const classType = node.class_type || node.type;

        if (classType === 'LumenLoadWorkflow') {
            // 移除 LumenLoadWorkflow 节点
            console.log(`  🗑️ 移除节点 ${nodeId}: ${classType}`);
            delete workflow[nodeId];
        } else if (classType === 'LumenReceiveImageFromCanvas') {
            // 为 LumenReceiveImageFromCanvas 节点设置随机 seed，强制刷新缓存
            const randomSeed = generateRandomSeed();
            node.inputs = node.inputs || {};
            node.inputs.seed = randomSeed;

            // 处理 slot 可能是数组或字符串的情况
            let slot = node.inputs.slot;
            if (Array.isArray(slot)) {
                slot = slot[0];
            }
            slot = String(slot || '1');
            console.log(`  🎲 设置节点 ${nodeId} (slot=${slot}) 随机 seed: ${randomSeed}`);
        }
    }
    return workflow;
}

/**
 * 按节点 id 覆盖工作流输入参数（Comfy 生图节点的动态参数注入）
 * 前端扫描工作流后把每个控件绑定的节点 id 与输入键回传，
 * 后端只负责按 id 定位节点并合并覆盖，不重复实现参数探测逻辑。
 * 只覆盖节点 inputs 中已存在的键，避免把无效输入写进工作流导致 ComfyUI 校验失败。
 * @param {Object} workflow - ComfyUI 工作流对象
 * @param {Object} overrides - 覆盖表 { [nodeId]: { [inputKey]: newValue } }
 * @returns {Object} 注入后的工作流对象
 */
function applyWorkflowOverrides(workflow, overrides) {
    if (!overrides || typeof overrides !== 'object') return workflow;

    for (const nodeId in overrides) {
        const node = workflow[nodeId];
        if (!node) {
            console.log(`  ⚠️ 覆盖目标节点 ${nodeId} 不存在，已跳过`);
            continue;
        }
        const patch = overrides[nodeId];
        node.inputs = node.inputs || {};
        for (const key in patch) {
            if (!(key in node.inputs)) {
                console.log(`  ⚠️ 节点 ${nodeId} 没有 ${key} 输入，已跳过`);
                continue;
            }
            node.inputs[key] = patch[key];
            console.log(`  ✏️ 覆盖节点 ${nodeId}.${key} = ${patch[key]}`);
        }
    }
    return workflow;
}

// ==================== 画布 LoRA 堆栈注入（图拼接，追加语义） ====================

/**
 * 注入画布 LoRA 堆栈到工作流（图拼接，追加语义）
 *
 * 语义（与 Comfy 生图节点的分工）：
 *   - 模板内嵌的 LoraLoader 由 Comfy 生图节点的 LoRA 行管理（文件选择 +
 *     启用开关；未启用时经 applyWorkflowOverrides 注入强度 0），本函数
 *     不碰它们——加速 lora 等功能性模板 lora 默认照常生效；
 *   - 画布 LoRA 节点堆栈是增量补充：以 LoraLoader 节点链动态创建并追加在
 *     模型/CLIP 信号链的最末端（后应用的叠加在先应用的上面），模型/CLIP
 *     的全部消费方改指向链尾；
 *   - 工作流模板有没有 LoraLoader 都能注入（无模板 lora 的工作流由此
 *     获得 lora 能力，这正是画布 LoRA 节点的价值之一）；
 *   - 注入只改本次提交的工作流对象，不写磁盘模板。
 *
 * 拼接算法：
 *   1. 扫描全部节点的 model / clip 连线输入，按 (源节点, 源槽位) 分组
 *     （源可能是模型加载器，也可能是模板 LoRA 的输出——画布堆栈追加其上）；
 *   2. 在第一个模型组处拼接 LoRA 链（原源 → lora1 → lora2 → … → 消费方）；
 *   3. 工作流存在 clip 消费方时，clip 信号同样穿过 LoRA 链
 *      （LoraLoader 输出槽位：0=MODEL、1=CLIP），第一个 clip 组的消费方
 *      改指向链尾的 CLIP 输出；不存在 clip 消费方时改用
 *      LoraLoaderModelOnly（仅模型强度，堆栈的 CLIP 强度被忽略）。
 *
 * @param {Object} workflow - ComfyUI 工作流对象（API 格式）
 * @param {Array<{file: string, strengthModel: number, strengthClip: number}>} loras
 *        画布 LoRA 堆栈（已过滤生效条目），按应用顺序排列；空数组 = 无补充、原样返回
 * @returns {Object} 注入后的工作流对象
 */
function injectLoraChain(workflow, loras) {
    const entries = Array.isArray(loras)
        ? loras.filter((l) => l && typeof l.file === 'string' && l.file)
        : [];
    if (entries.length === 0) return workflow;   // 空堆栈：无补充，模板 lora 按 LoRA 行控制照常

    // 1. 收集 model / clip 连线输入的 (源节点, 源槽位) 分组
    //   （源可能是模型加载器，也可能是模板 LoRA 的输出——画布堆栈追加其上）
    const collectGroups = (inputKey) => {
        const groups = new Map();   // 'srcId|slot' -> { srcId, slot, consumers: [{nodeId, key}] }
        for (const [nodeId, node] of Object.entries(workflow)) {
            const inputs = (node && node.inputs) || {};
            for (const [key, val] of Object.entries(inputs)) {
                if (key !== inputKey) continue;
                // API 格式：连线输入是 [源节点id, 源槽位] 数组，字面值天然排除
                if (!Array.isArray(val) || val.length !== 2 || typeof val[0] !== 'string') continue;
                if (!workflow[val[0]]) continue;
                const gk = `${val[0]}|${val[1]}`;
                if (!groups.has(gk)) groups.set(gk, { srcId: val[0], slot: val[1], consumers: [] });
                groups.get(gk).consumers.push({ nodeId, key });
            }
        }
        return groups;
    };

    const modelGroups = collectGroups('model');
    const clipGroups = collectGroups('clip');
    if (modelGroups.size === 0) {
        console.log('  ⚠️ 工作流中没有 model 连线输入，LoRA 堆栈无处注入，已跳过');
        return workflow;
    }

    // 2. 生成不冲突的新节点 id
    const newId = (() => {
        let n = 0;
        return () => {
            n += 1;
            let id = `lumen_lora_${n}`;
            while (workflow[id]) { n += 1; id = `lumen_lora_${n}`; }
            return id;
        };
    })();

    // 拼接点选择：取模型/clip 链中「最靠近末端」的连线组——即源节点
    // 本身也是同类型信号的消费方（链的中间节点，如模板 lora）的组。
    // 保证画布堆栈追加在模板 lora 之后（叠加语义），不会插到模板 lora
    // 之前被其盖住；纯 根源→终端 的链（如 flux2）则取唯一的那条边
    const pickTerminalGroup = (groups) => {
        const inputOwners = new Set();   // 拥有同类型连线输入的节点（消费方）
        for (const g of groups.values()) {
            for (const c of g.consumers) inputOwners.add(c.nodeId);
        }
        const terminal = [...groups.values()].filter((g) => inputOwners.has(g.srcId));
        return terminal[0] || groups.values().next().value;
    };
    const primaryModelGroup = pickTerminalGroup(modelGroups);
    const primaryClipGroup = clipGroups.size > 0 ? pickTerminalGroup(clipGroups) : null;
    const useClip = primaryClipGroup !== null;   // 有 clip 消费方才用带 CLIP 强度的 LoraLoader

    // 3. 创建 LoRA 链：模型/clip 链首接当前信号源（可能是模板 lora 的输出），
    //    逐级串接——画布堆栈叠加在模板 lora 之上
    let prevModelRef = [primaryModelGroup.srcId, primaryModelGroup.slot];
    let prevClipRef = primaryClipGroup ? [primaryClipGroup.srcId, primaryClipGroup.slot] : null;
    const created = [];
    for (const entry of entries) {
        const id = newId();
        const classType = useClip ? 'LoraLoader' : 'LoraLoaderModelOnly';
        const inputs = useClip
            ? {
                lora_name: entry.file,
                strength_model: entry.strengthModel,
                strength_clip: entry.strengthClip,
                model: prevModelRef,
                clip: prevClipRef
            }
            : {
                lora_name: entry.file,
                strength_model: entry.strengthModel,
                model: prevModelRef
            };
        workflow[id] = { class_type: classType, inputs };
        created.push(id);
        prevModelRef = [id, 0];                            // LoraLoader(ModelOnly) 的模型输出都是槽位 0
        if (useClip) prevClipRef = [id, 1];                // LoraLoader 的 CLIP 输出是槽位 1
    }
    const chainTail = created[created.length - 1];

    // 4. 把模型/clip 组的消费方改指向链尾输出
    for (const consumer of primaryModelGroup.consumers) {
        workflow[consumer.nodeId].inputs[consumer.key] = [chainTail, 0];
        console.log(`  🔗 LoRA 链接管 ${consumer.nodeId}.${consumer.key}`);
    }
    if (useClip) {
        for (const consumer of primaryClipGroup.consumers) {
            workflow[consumer.nodeId].inputs[consumer.key] = [chainTail, 1];
        }
    }

    console.log(`  🧩 注入画布 LoRA 堆栈 ${created.length} 条（追加在模板 lora 之后）`);
    return workflow;
}

module.exports = {
    injectPromptsToWorkflow,
    generateRandomSeed,
    prepareWorkflowForRun,
    applyWorkflowOverrides,
    injectLoraChain,
    isTextEncodeType,
    getPromptField,
    isSamplerType
};
