/**
 * ==========================================================================
 * LumenLight ComfyUI 工作流参数扫描器（ComfyParamScanner）
 * ==========================================================================
 * 作用：从 ComfyGenNode 拆出的纯数据层，画布 Comfy 生图节点与右侧面板
 *       Comfy 模式共用。职责单一：
 *         1. scan(workflow)：扫描 API 格式工作流 JSON，探测可调参数
 *            （主模型/步数/CFG/采样器/降噪/尺寸/数量/内嵌 LoRA）。
 *         2. buildOverrides(detected, state)：把参数状态编译成
 *            /api/comfy-node/run 要求的覆盖表 { [节点id]: { [输入键]: 值 } }。
 *         3. scanLoadImageInputs(workflow)：图片输入侧特征扫描（免节点
 *            LoadImage 直注的落点清单与槽位链路判定），画布节点组
 *            imageMapping、面板判定 LoadImage 槽位共用。
 *       纯函数、不碰 DOM、不依赖节点实例，可独立测试与复用。
 *
 * 判定规则（与拆出前 ComfyGenNode.detectParams 完全一致）：
 *   统一以"字面数值/字符串输入"为准——API 格式里连线输入是
 *   [节点id, 槽位] 数组，typeof 检查天然把连线排除在可调参数之外。
 * ==========================================================================
 */

/**
 * 工作流加载节点类型 → 参数类别与输入字段名。
 * 与后端 routes/comfyNode.js 的 LOADER_CLASSES 保持一致：
 * 后端按这张表决定查询哪些 object_info，前端按它识别工作流里的加载节点
 */
const LOADER_TYPES = {
    CheckpointLoaderSimple: { kind: 'checkpoint', field: 'ckpt_name' },
    CheckpointLoaderAdvanced: { kind: 'checkpoint', field: 'ckpt_name' },
    UNETLoader: { kind: 'unet', field: 'unet_name' },
    UnetLoaderGGUF: { kind: 'unet', field: 'unet_name' },
    UnetLoaderGGUFAdvanced: { kind: 'unet', field: 'unet_name' },
    LoraLoader: { kind: 'lora', field: 'lora_name' },
    LoraLoaderModelOnly: { kind: 'lora', field: 'lora_name' }
};

/**
 * 扫描工作流 JSON，探测可调参数（工作流里有什么就暴露什么）
 * @param {Object} workflow - ComfyUI API 格式工作流对象
 * @returns {Object} 探测结果
 *   loaders       加载节点 [{nodeId, classType, kind, field, current, strengthFields?}]
 *   stepsTargets  步数可写节点 [{nodeId, current}]
 *   cfgTargets    CFG 可写节点 [{nodeId, current}]（KSampler/CFGGuider 等）
 *   samplerTargets 采样器可写节点 [{nodeId, current}]（KSampler/KSamplerSelect 等）
 *   denoiseTargets 降噪可写节点 [{nodeId, current}]
 *   sizeTargets   尺寸可写节点 [{nodeId, width, height}]
 *   batchTargets  数量可写节点 [{nodeId, field}]
 */
function scan(workflow) {
    const loaders = [];        // 加载节点
    const stepsTargets = [];   // 步数可写节点
    const cfgTargets = [];     // CFG 可写节点
    const samplerTargets = []; // 采样器可写节点
    const denoiseTargets = []; // 降噪可写节点
    const sizeTargets = [];    // 尺寸可写节点
    const batchTargets = [];   // 数量可写节点

    for (const nodeId in workflow) {
        const node = workflow[nodeId];
        const classType = node.class_type || node.type || '';
        const inputs = node.inputs || {};

        // 主模型 / LoRA 加载节点（清单见 LOADER_TYPES）
        const loaderDef = LOADER_TYPES[classType];
        if (loaderDef && typeof inputs[loaderDef.field] === 'string') {
            const loader = {
                nodeId,
                classType,
                kind: loaderDef.kind,
                field: loaderDef.field,
                current: inputs[loaderDef.field]
            };
            // LoRA 加载节点：记录字面强度值（叠加区内嵌条目的强度初值）与
            // 可注入的字面强度字段（启用开关注入强度 0 软关闭，勾选不碰强度）
            if (loaderDef.kind === 'lora') {
                loader.strengths = {};
                loader.strengthFields =
                    ['strength_model', 'strength_clip']
                        .filter((k) => {
                            if (typeof inputs[k] !== 'number') return false;
                            loader.strengths[k] = inputs[k];
                            return true;
                        });
            }
            loaders.push(loader);
        }

        // 步数 / CFG / 降噪：任何字面数值输入（KSampler 系、CFGGuider、
        // Flux2Scheduler 等，同一字段可能出现在多个节点，统一覆盖）
        if (typeof inputs.steps === 'number') {
            stepsTargets.push({ nodeId, current: inputs.steps });
        }
        if (typeof inputs.cfg === 'number') {
            cfgTargets.push({ nodeId, current: inputs.cfg });
        }
        if (typeof inputs.denoise === 'number') {
            denoiseTargets.push({ nodeId, current: inputs.denoise });
        }

        // 采样器：任何字面字符串的 sampler_name 输入
        // （KSampler 系与 KSamplerSelect 等）
        if (typeof inputs.sampler_name === 'string') {
            samplerTargets.push({ nodeId, current: inputs.sampler_name });
        }

        // 尺寸 / 数量：Empty 系 Latent 节点（EmptyLatentImage、
        // EmptySD3LatentImage、EmptyFlux2LatentImage 等）
        if (classType.includes('Empty') && classType.includes('Latent')) {
            if (typeof inputs.width === 'number' && typeof inputs.height === 'number') {
                sizeTargets.push({ nodeId, width: inputs.width, height: inputs.height });
            }
            if (typeof inputs.batch_size === 'number') {
                batchTargets.push({ nodeId, field: 'batch_size' });
            }
        }
    }

    return { loaders, stepsTargets, cfgTargets, samplerTargets, denoiseTargets, sizeTargets, batchTargets };
}

/**
 * 扫描工作流的图片输入侧特征（免节点 LoadImage 直注通道的仲裁依据，
 * 与后端 utils/comfyNodelessFlow.scanCanvasFlow 同口径——前端扫模板、
 * 后端扫 bypass 后的存活图，被编辑器 bypass 掉的 LoadImage 由后端
 * 校验时跳过并如实上报）。
 * 语义：工作流里画布取图节点（LumenReceiveImageFromCanvas）优先——
 * 有它走槽位链路，LoadImage 不再升格为直注目标（一个工作流一条
 * 输入通道）；没有时原生 LoadImage 按节点 id 升序成为注入落点
 * @param {Object|null} workflow - ComfyUI API 格式工作流对象
 * @returns {{hasReceiveNode: boolean, loadImageIds: string[]}}
 *   loadImageIds 按数值 id 升序（「从左往右第 N 个」的排序口径，
 *   与面板槽位顺序一致）
 */
function scanLoadImageInputs(workflow) {
    const loadImageIds = [];
    let hasReceiveNode = false;
    if (!workflow || typeof workflow !== 'object') return { hasReceiveNode, loadImageIds };
    for (const nodeId in workflow) {
        const cls = workflow[nodeId].class_type || workflow[nodeId].type || '';
        if (cls === 'LumenReceiveImageFromCanvas') hasReceiveNode = true;
        if (cls === 'LoadImage') loadImageIds.push(nodeId);
    }
    loadImageIds.sort((a, b) => Number(a) - Number(b));
    return { hasReceiveNode, loadImageIds };
}

/**
 * 由探测结果与参数状态构建参数覆盖表
 * 后端只覆盖节点 inputs 中已存在的键，这里无需再校验
 * @param {Object|null} detected - scan() 结果
 * @param {Object} state - 参数状态 { models, loraEnabled, steps, cfg,
 *                                 sampler, sizeW, sizeH, denoise, count }
 * @returns {Object} 覆盖表 { [节点id]: { [输入键]: 新值 } }
 */
function buildOverrides(detected, state) {
    if (!detected) return {};
    const { loaders, stepsTargets, cfgTargets, samplerTargets, denoiseTargets, sizeTargets, batchTargets } = detected;
    const overrides = {};
    const patch = (nodeId, key, value) => {
        overrides[nodeId] = overrides[nodeId] || {};
        overrides[nodeId][key] = value;
    };

    for (const loader of loaders) {
        // 已删除的内嵌 lora：提交时走 bypass 剔除节点（bypassLoras 参数），
        // 不再注入任何覆盖（节点已不在图里，注入只会刷警告）
        if (loader.kind === 'lora' && state.loraDeleted && state.loraDeleted[loader.nodeId]) {
            continue;
        }
        const value = state.models[loader.nodeId];
        if (value) patch(loader.nodeId, loader.field, value);
        // 用户在叠加区改过的内嵌 lora 强度（仅字面字段可注入）
        const userStrengths = loader.kind === 'lora' &&
            state.loraStrengths && state.loraStrengths[loader.nodeId];
        if (userStrengths) {
            if (typeof userStrengths.strengthModel === 'number' &&
                loader.strengthFields.includes('strength_model')) {
                patch(loader.nodeId, 'strength_model', userStrengths.strengthModel);
            }
            if (typeof userStrengths.strengthClip === 'number' &&
                loader.strengthFields.includes('strength_clip')) {
                patch(loader.nodeId, 'strength_clip', userStrengths.strengthClip);
            }
        }
        // LoRA 开关：仅显式取消勾选（loraEnabled 记为 false）时把强度注入 0
        // （软关闭，保留连线与文件选择）；缺省/勾选时不碰 strength——
        // 工作流里的原强度值直接生效。
        // 提交按次注入，不改磁盘上的工作流模板
        if (loader.kind === 'lora' && loader.strengthFields &&
            loader.strengthFields.length > 0 &&
            state.loraEnabled[loader.nodeId] === false) {
            for (const k of loader.strengthFields) {
                patch(loader.nodeId, k, 0);
            }
        }
    }
    if (state.steps !== null) {
        for (const t of stepsTargets) patch(t.nodeId, 'steps', state.steps);
    }
    if (state.cfg !== null) {
        for (const t of cfgTargets) patch(t.nodeId, 'cfg', state.cfg);
    }
    if (state.sampler !== null) {
        for (const t of samplerTargets) patch(t.nodeId, 'sampler_name', state.sampler);
    }
    if (state.sizeW !== null && state.sizeH !== null) {
        for (const t of sizeTargets) {
            patch(t.nodeId, 'width', state.sizeW);
            patch(t.nodeId, 'height', state.sizeH);
        }
    }
    if (state.denoise !== null) {
        for (const t of denoiseTargets) patch(t.nodeId, 'denoise', state.denoise);
    }
    if (batchTargets.length > 0) {
        for (const t of batchTargets) patch(t.nodeId, t.field, state.count);
    }
    return overrides;
}

// 暴露到全局作用域（浏览器端经典脚本，画布与面板共用）
window.ComfyParamScanner = { LOADER_TYPES, scan, buildOverrides, scanLoadImageInputs };
