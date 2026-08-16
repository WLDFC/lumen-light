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
            // LoRA 加载节点：模板内嵌 lora 的启用开关可注入性取决于
            // 强度是否字面数值（开关注入强度 0 软关闭，勾选不碰强度走原值）
            if (loaderDef.kind === 'lora') {
                loader.strengthFields =
                    ['strength_model', 'strength_clip']
                        .filter((k) => typeof inputs[k] === 'number');
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
        const value = state.models[loader.nodeId];
        if (value) patch(loader.nodeId, loader.field, value);
        // LoRA 开关：未启用时把强度注入 0（软关闭，保留连线与文件选择）；
        // 启用时不碰 strength——工作流里的原强度值直接生效。
        // 提交按次注入，不改磁盘上的工作流模板
        if (loader.kind === 'lora' && loader.strengthFields &&
            loader.strengthFields.length > 0 &&
            state.loraEnabled[loader.nodeId] !== true) {
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
window.ComfyParamScanner = { LOADER_TYPES, scan, buildOverrides };
