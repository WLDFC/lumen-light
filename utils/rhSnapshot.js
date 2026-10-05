/**
 * ==========================================================================
 * RunningHub 快照与编辑器覆盖（rhSnapshot）
 * ==========================================================================
 * 作用：把「从平台拉取的工作流 JSON」落为 workflows/ 本地快照后，打通
 *       "编辑器改参数 → 云端执行生效" 的链路。平台不提供工作流上传接口，
 *       但提交协议（nodeInfoList）原生支持按次覆盖任意节点字段——本模块把
 *       编辑器保存时的「编辑结果 vs 拉取原版」字段级 diff 转成覆盖清单
 *       （editorOverrides）写入登记卡，提交时合并进 nodeInfoList。
 *
 * 能力边界（由平台 API 决定）：
 *   - 字段值修改（提示词/种子/步数/模型名等）→ 可生效；
 *   - 增删节点、改连线、改节点类型 → 无法表达为覆盖，diff 时跳过并在
 *     结果中报告（addedNodeIds / removedNodeIds / structuralNodeIds）。
 *
 * 纯函数与 I/O 分离：computeFieldDiff / serializeFieldValue /
 * mergeEditorOverrides 可单测；快照 sidecar（data/rh-snapshots.json）与
 * 登记卡（data/settings.json 的 runninghub.workflows）读写由路由层调用。
 * ==========================================================================
 */

/**
 * 把工作流字段值序列化为 nodeInfoList 的 fieldValue 字符串。
 * 平台协议 fieldValue 为字符串：数字/布尔转字符串，数组/对象压缩 JSON，
 * null/undefined 转空串（与路由层既有 String(fieldValue ?? '') 口径一致）
 * @param {*} value - API 格式 JSON 里的字段原始值
 * @returns {string}
 */
function serializeFieldValue(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try { return JSON.stringify(value); } catch { return String(value); }
}

/** 字段值等价比较（序列化后比较，2 与 "2" 视为同值不产生噪音覆盖） */
function fieldEquals(a, b) {
    return serializeFieldValue(a) === serializeFieldValue(b);
}

/**
 * 计算编辑器保存结果相对拉取原版的字段级 diff。
 * 只覆盖「两边都有且类型未变」的节点：原地修改字段值才有云端语义。
 * @param {Object} original - 拉取时的原始 API 格式工作流（diff 基准）
 * @param {Object} edited - 编辑器保存的最新 API 格式工作流
 * @returns {{overrides: Array<{nodeId, fieldName, fieldValue}>,
 *            addedNodeIds: string[], removedNodeIds: string[],
 *            structuralNodeIds: string[]}} overrides 为可直接并入
 *   nodeInfoList 的覆盖清单；三个 id 数组为无法表达的结构变化（报告用）
 */
function computeFieldDiff(original, edited) {
    const overrides = [];
    const addedNodeIds = [];
    const removedNodeIds = [];
    const structuralNodeIds = [];
    if (!original || typeof original !== 'object' ||
        !edited || typeof edited !== 'object') {
        return { overrides, addedNodeIds, removedNodeIds, structuralNodeIds };
    }

    for (const [nodeId, node] of Object.entries(edited)) {
        const orig = original[nodeId];
        if (!orig || typeof orig !== 'object') {
            // 平台工作流里不存在的新节点：覆盖无法凭空建节点，跳过并报告
            addedNodeIds.push(nodeId);
            continue;
        }
        if (node.class_type !== orig.class_type) {
            // 换了节点类型：字段集完全不同，逐字段 diff 会产生垃圾覆盖
            structuralNodeIds.push(nodeId);
            continue;
        }
        const inputs = (node.inputs && typeof node.inputs === 'object') ? node.inputs : {};
        const origInputs = (orig.inputs && typeof orig.inputs === 'object') ? orig.inputs : {};
        for (const [fieldName, value] of Object.entries(inputs)) {
            if (!(fieldName in origInputs)) continue;   // 新增字段：平台节点未必支持，不冒进
            if (fieldEquals(value, origInputs[fieldName])) continue;
            overrides.push({
                nodeId,
                fieldName,
                fieldValue: serializeFieldValue(value)
            });
        }
    }
    for (const nodeId of Object.keys(original)) {
        if (!(nodeId in edited)) removedNodeIds.push(nodeId);
    }
    return { overrides, addedNodeIds, removedNodeIds, structuralNodeIds };
}

/**
 * 把编辑器覆盖合并进 nodeInfoList（提交前调用）。
 * 优先级：运行时参数行 > 编辑器覆盖——参数行是用户当次的显式输入，
 * 覆盖是持久改动，同字段冲突时以当次输入为准。
 * @param {Array<{nodeId, fieldName, fieldValue}>} nodeInfoList - 路由层按
 *        登记卡参数行组装好的运行时覆盖（就地修改）
 * @param {Array<{nodeId, fieldName, fieldValue}>} [editorOverrides] - 登记
 *        卡里存的编辑器覆盖（editorOverrides）
 * @returns {number} 实际新并入的覆盖项数（被参数行压住的不算）
 */
function mergeEditorOverrides(nodeInfoList, editorOverrides) {
    // 调用方传非数组（未组装出运行时清单）时无从合并，返回 0 而不是
    // 虚构新数组虚报成功
    if (!Array.isArray(nodeInfoList)) return 0;
    if (!Array.isArray(editorOverrides) || editorOverrides.length === 0) return 0;
    const list = nodeInfoList;
    const seen = new Set(list.map((n) => `${n && n.nodeId}:${n && n.fieldName}`));
    let merged = 0;
    for (const ov of editorOverrides) {
        if (!ov || !ov.nodeId || !ov.fieldName) continue;
        const key = `${ov.nodeId}:${ov.fieldName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({
            nodeId: String(ov.nodeId),
            fieldName: String(ov.fieldName),
            fieldValue: String(ov.fieldValue ?? '')
        });
        merged++;
    }
    return merged;
}

/**
 * 读快照 sidecar（data/rh-snapshots.json，缺失/损坏按空对象）
 * @param {string} snapshotsFile
 * @returns {Object} { [workflowId]: { rhWorkflowId, name, fetchedAt, original } }
 */
function readSnapshots(snapshotsFile) {
    const fsSync = require('fs');
    try {
        return JSON.parse(fsSync.readFileSync(snapshotsFile, 'utf-8')) || {};
    } catch {
        return {};
    }
}

/**
 * 写快照 sidecar
 * @param {string} snapshotsFile
 * @param {Object} snapshots
 */
async function writeSnapshots(snapshotsFile, snapshots) {
    const fs = require('fs').promises;
    const path = require('path');
    await fs.mkdir(path.dirname(snapshotsFile), { recursive: true });
    await fs.writeFile(snapshotsFile, JSON.stringify(snapshots, null, 2), 'utf-8');
}

/**
 * 把编辑器覆盖写进登记卡（data/settings.json 的 runninghub.workflows，
 * 按 rhWorkflowId 匹配）。读改写保留文件其余区块（api.providers 密钥等）。
 * 登记卡不存在（快照先于登记/卡已删除）时不动文件，由调用方提示。
 * @param {string} settingsPath - settings.json 绝对路径
 * @param {string} rhWorkflowId - 平台工作流 id（纯数字）
 * @param {Array<{nodeId, fieldName, fieldValue}>} overrides - 覆盖清单；
 *        空数组表示清除覆盖（重新拉取重置基准时用）
 * @returns {Promise<{found: boolean, count: number}>} found=登记卡是否存在
 */
async function applyOverridesToSettings(settingsPath, rhWorkflowId, overrides) {
    const fs = require('fs').promises;
    let settings = {};
    try {
        settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8')) || {};
    } catch { /* 缺失/损坏按空配置 */ }
    const rh = settings.runninghub || {};
    const workflows = Array.isArray(rh.workflows) ? rh.workflows : [];
    const card = workflows.find((w) => w && w.rhWorkflowId === String(rhWorkflowId));
    if (!card) return { found: false, count: 0 };
    const list = Array.isArray(overrides) ? overrides : [];
    if (list.length) card.editorOverrides = list;
    else delete card.editorOverrides;   // 不留空数组字段，保持登记卡干净
    settings.runninghub = rh;
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    return { found: true, count: list.length };
}

/**
 * 把编辑器覆盖写进快照 sidecar（data/rh-snapshots.json，按 rhWorkflowId
 * 反查条目）。节点直连模式（画布节点输入 ID 拉取，无登记卡）下覆盖的
 * 落点：登记卡不存在时提交链路从这里读 editorOverrides。与
 * applyOverridesToSettings 是并行写入——卡在两边都有，读侧任选其一。
 * @param {string} snapshotsFile - rh-snapshots.json 绝对路径
 * @param {string} rhWorkflowId - 平台工作流 id（纯数字）
 * @param {Array<{nodeId, fieldName, fieldValue}>} overrides - 覆盖清单；
 *        空数组表示清除覆盖（重新拉取重置基准时用）
 * @returns {Promise<{found: boolean, count: number}>} found=快照是否存在
 */
async function applyOverridesToSnapshots(snapshotsFile, rhWorkflowId, overrides) {
    const snapshots = readSnapshots(snapshotsFile);
    const id = Object.keys(snapshots).find(
        (k) => snapshots[k] && snapshots[k].rhWorkflowId === String(rhWorkflowId));
    if (!id) return { found: false, count: 0 };
    const list = Array.isArray(overrides) ? overrides : [];
    if (list.length) snapshots[id].editorOverrides = list;
    else delete snapshots[id].editorOverrides;   // 同登记卡口径：不留空数组
    await writeSnapshots(snapshotsFile, snapshots);
    return { found: true, count: list.length };
}

/**
 * 读快照条目里的编辑器覆盖（节点直连提交链路用，按 rhWorkflowId 反查）
 * @param {string} snapshotsFile
 * @param {string} rhWorkflowId - 平台工作流 id（纯数字）
 * @returns {Array<{nodeId, fieldName, fieldValue}>} 无快照/无覆盖返回空数组
 */
function readOverridesFromSnapshots(snapshotsFile, rhWorkflowId) {
    const snapshots = readSnapshots(snapshotsFile);
    const entry = Object.values(snapshots).find(
        (s) => s && s.rhWorkflowId === String(rhWorkflowId));
    return (entry && Array.isArray(entry.editorOverrides)) ? entry.editorOverrides : [];
}

module.exports = {
    serializeFieldValue,
    computeFieldDiff,
    mergeEditorOverrides,
    readSnapshots,
    writeSnapshots,
    applyOverridesToSettings,
    applyOverridesToSnapshots,
    readOverridesFromSnapshots
};
