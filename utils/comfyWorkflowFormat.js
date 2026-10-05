/**
 * ==========================================================================
 * ComfyUI 工作流格式工具（纯函数层，comfyTools 路由专用）
 * ==========================================================================
 * 项目自有工作流链路（画布/面板/编辑器）只认 API 格式；用户从网上下载、
 * 模板库取回的工作流多为前端格式（UI 格式：nodes/links/widgets_values）。
 * 本模块补齐两种格式的识别、互转与"可调槽位"的扫描/设置：
 *
 *   - isUiFormat(workflow)                     格式识别
 *   - convertUiToApi(workflow, objectInfo)     UI 格式 → API 提交格式
 *   - listWorkflowSlots(workflow, objectInfo)  两种格式的可调槽位清单
 *   - setWorkflowSlots(workflow, overrides, objectInfo) 按地址写槽位
 *
 * 槽位（slot）= 节点上由控件（widget）承载的原始值输入：数字/文本/布尔/
 * 下拉选项。连线输入、Note 等纯前端节点不算槽位。地址两种写法：
 *   - `<节点id>.<输入名>`（如 `6.text`，最明确）
 *   - `<节点标题slug>.<输入名>`（如 `ksampler.seed`，标题去重后才可用）
 *
 * 语义对齐 comfy-cli（`comfy workflow slots/set-slot` 的 ADDR=VALUE 约定），
 * 但只支持普通图：子图（subgraph）显式报错。objectInfo 来自 ComfyUI
 * /object_info 的实时响应——分类输入是否为控件全靠它，离线无法工作。
 * ==========================================================================
 */

// ComfyUI 会在 seed 类 INT 控件后追加控制词控件（值存 widgets_values 但
// 不是真实输入），消费 widgets_values 时要跳过
const SEED_CONTROL_WORDS = new Set(['fixed', 'increment', 'decrement', 'randomize']);

// 前端专属节点类型：不出现在 /object_info，转换时直接跳过
// （Reroute 单独处理——它是连线中继，要做穿透解析）
const FRONTEND_ONLY_TYPES = new Set(['Note', 'MarkdownNote', 'PrimitiveNode']);

const UI_FORMAT_HINT = '仅支持普通节点图：子图（subgraph）暂不支持，请先在 ComfyUI 网页端展开后再导出';

/** 值是否为控件可调的原始类型（API 格式槽位判定用） */
function isPrimitiveValue(v) {
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/**
 * 判断工作流格式
 * @param {*} workflow - 工作流对象
 * @returns {boolean} true = 前端格式（UI 格式）
 */
function isUiFormat(workflow) {
    return !!workflow && typeof workflow === 'object'
        && Array.isArray(workflow.nodes)
        && !Array.isArray(workflow);
}

/**
 * 节点定义（object_info 条目）的输入是否为控件输入
 * object_info 输入 spec 形如：
 *   组合框： [["a.safetensors","b.safetensors"], {...}]   → 控件
 *   基础类型： ["INT", {...}] / ["STRING", {...}] 等      → 控件
 *   连线：    ["MODEL", {...}] / ["CLIP", {...}] 等       → 连线
 * @param {Array} spec - 输入定义
 * @returns {boolean}
 */
function isWidgetSpec(spec) {
    if (!Array.isArray(spec) || spec.length === 0) return false;
    const head = spec[0];
    if (Array.isArray(head)) return true;   // 组合框选项列表
    return typeof head === 'string'
        && ['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO', 'NUMBER'].includes(head);
}

/**
 * 取节点定义的有序输入清单（required 在前 optional 在后，JSON 键序即声明序）
 * @param {Object} def - objectInfo[class_type]
 * @returns {Array<[string, Array]>} [输入名, spec] 数组
 */
function getDefInputs(def) {
    if (!def || !def.input) return [];
    const order = [];
    for (const section of ['required', 'optional']) {
        const group = def.input[section];
        if (group && typeof group === 'object') {
            for (const name of Object.keys(group)) order.push([name, group[name]]);
        }
    }
    return order;
}

/**
 * 节点标题 → 槽位别名 slug（小写、非字母数字折叠为下划线）
 * @param {string} title
 * @returns {string}
 */
function slugifyTitle(title) {
    return String(title || '')
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/**
 * 解析单个 UI 节点的控件值 → 输入名映射（转换/槽位扫描共用的核心）。
 * widgets_values 是按控件顺序排列的值数组，需与 object_info 的控件输入
 * 按声明序对位消费；seed 类控件后可能多一个控制词条目要跳过。新版导出里
 * widgets_values 条目也可能是 {name, value} 对象，按名字匹配。
 * @param {Object} node - UI 格式节点
 * @param {Object} def - objectInfo[class_type]（缺省时返回空映射）
 * @returns {{values: Map<string, *>, order: string[]}} values=输入名→值；
 *          order=控件输入名按声明序（写槽位时定位 widgets_values 位置用）
 */
function mapNodeWidgetValues(node, def) {
    const values = new Map();
    const order = [];
    const raw = Array.isArray(node.widgets_values) ? node.widgets_values : [];

    // {name, value} 对象形态：直接按名建索引
    const byName = new Map();
    const positional = [];
    for (const v of raw) {
        if (v && typeof v === 'object' && !Array.isArray(v) && 'name' in v && 'value' in v) {
            byName.set(v.name, v.value);
        } else {
            positional.push(v);
        }
    }

    let pos = 0;
    for (const [name, spec] of getDefInputs(def)) {
        if (!isWidgetSpec(spec)) continue;
        order.push(name);
        if (byName.has(name)) {
            values.set(name, byName.get(name));
            continue;
        }
        let value = pos < positional.length ? positional[pos] : undefined;
        pos++;
        // seed 控制词：仅在前一个消费的确实是 INT 控件时才可能紧跟出现，
        // 这里简化为"原始值命中控制词就跳过"——控制词不可能成为合法控件值
        if (typeof value === 'string' && SEED_CONTROL_WORDS.has(value)) {
            value = pos < positional.length ? positional[pos] : undefined;
            pos++;
        }
        if (value === undefined) {
            const cfg = Array.isArray(spec) ? spec[1] : null;
            value = (cfg && typeof cfg === 'object' && cfg.default !== undefined)
                ? cfg.default : null;
        }
        values.set(name, value);
    }
    return { values, order };
}

/**
 * 解析连线中继（Reroute）：沿 reroute 链回溯到真实来源节点/输出槽。
 * @param {Object} workflow - UI 格式工作流
 * @param {number|string} nodeId - 起始节点 id（可能是 reroute）
 * @param {number} slot - 起始输出槽位
 * @param {number} [depth=0] - 递归深度（防环）
 * @returns {{nodeId: number|string, slot: number}} 穿透后的来源
 */
function resolveReroute(workflow, nodeId, slot, depth = 0) {
    const node = workflow.nodes.find((n) => String(n.id) === String(nodeId));
    if (!node || node.type !== 'Reroute' || depth > 16) {
        return { nodeId, slot };
    }
    // reroute 只有一个输入连线：从 links 里找 target 指向本节点 0 号输入的连线
    const inputEntry = (node.inputs || []).find((i) => i.link != null);
    if (inputEntry == null) return { nodeId, slot };
    const link = (workflow.links || []).find((l) => l[0] === inputEntry.link);
    if (!link) return { nodeId, slot };
    return resolveReroute(workflow, link[1], link[2], depth + 1);
}

/**
 * UI 格式 → API 提交格式。
 * 控件输入按 object_info 声明序对位消费 widgets_values；连线输入按
 * links 表解析为 [来源节点id, 输出槽]；Reroute 链穿透。
 * @param {Object} workflow - UI 格式工作流
 * @param {Object} objectInfo - ComfyUI /object_info 完整响应
 * @returns {Object} API 格式 prompt（可直接提交 /prompt）
 * @throws {Error} 子图 / 未知节点类型（缺失节点包）时抛出
 */
function convertUiToApi(workflow, objectInfo) {
    if (!isUiFormat(workflow)) {
        throw new Error('不是前端格式工作流（缺少 nodes 数组）');
    }
    const subgraphs = workflow.definitions?.subgraphs;
    if (Array.isArray(subgraphs) && subgraphs.length > 0) {
        throw new Error(UI_FORMAT_HINT);
    }

    const nodes = workflow.nodes || [];
    for (const node of nodes) {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(String(node.type))) {
            throw new Error(UI_FORMAT_HINT);
        }
    }

    const result = {};
    for (const node of nodes) {
        // Reroute 是连线中继（不出现在 object_info），已在连线解析时穿透
        if (FRONTEND_ONLY_TYPES.has(node.type) || node.type === 'Reroute') continue;

        const def = objectInfo[node.type];
        if (!def) {
            throw new Error(`节点类型 "${node.type}"（节点 ${node.id}）不在当前 ComfyUI 的 object_info 中——缺自定义节点包或 ComfyUI 未在线`);
        }

        const { values } = mapNodeWidgetValues(node, def);
        const inputs = {};
        for (const [name, spec] of getDefInputs(def)) {
            if (isWidgetSpec(spec)) {
                if (values.has(name)) inputs[name] = values.get(name);
                continue;
            }
            // 连线输入：在 UI 节点的 inputs 里按名找连线 id
            const uiEntry = (node.inputs || []).find((i) => i.name === name);
            if (!uiEntry || uiEntry.link == null) continue;   // 未连接的可选输入
            const link = (workflow.links || []).find((l) => l[0] === uiEntry.link);
            if (!link) continue;
            const from = resolveReroute(workflow, link[1], link[2]);
            inputs[name] = [String(from.nodeId), from.slot];
        }

        result[String(node.id)] = {
            class_type: node.type,
            inputs,
            _meta: { title: node.title || node.type }
        };
    }
    return result;
}

/**
 * 从工作流收集全部节点类型（依赖分析用，两种格式都认）
 * @param {Object} workflow
 * @returns {string[]}
 */
function collectClassTypes(workflow) {
    if (isUiFormat(workflow)) {
        return [...new Set((workflow.nodes || [])
            .map((n) => String(n.type || ''))
            .filter((t) => t && !FRONTEND_ONLY_TYPES.has(t)))];
    }
    return [...new Set(Object.values(workflow || {})
        .map((n) => String(n && n.class_type || ''))
        .filter(Boolean))];
}

/**
 * 扫描工作流的全部可调槽位（两种格式都支持）。
 * UI 格式以控件输入为准；API 格式取全部原始值输入（数组即连线引用）。
 * @param {Object} workflow - 工作流对象
 * @param {Object} [objectInfo] - UI 格式必需
 * @returns {Array<{address: string, name: string|null, type: string,
 *           current_value: *, node: {id: string, title: string, class_type: string}}>}
 */
function listWorkflowSlots(workflow, objectInfo) {
    const slots = [];
    if (isUiFormat(workflow)) {
        const aliasCount = new Map();
        const draft = [];
        for (const node of workflow.nodes || []) {
            if (FRONTEND_ONLY_TYPES.has(node.type) || node.type === 'Reroute') continue;
            const def = objectInfo?.[node.type];
            if (!def) continue;
            const { values } = mapNodeWidgetValues(node, def);
            for (const [name, spec] of getDefInputs(def)) {
                if (!isWidgetSpec(spec)) continue;
                const type = Array.isArray(spec[0]) ? 'COMBO' : spec[0];
                const alias = slugifyTitle(node.title && node.title !== node.type ? node.title : '');
                draft.push({
                    address: `${node.id}.${name}`,
                    alias,
                    type,
                    current_value: values.has(name) ? values.get(name) : null,
                    node: { id: String(node.id), title: node.title || node.type, class_type: node.type },
                    _input: name
                });
                if (alias) aliasCount.set(alias, (aliasCount.get(alias) || 0) + 1);
            }
        }
        for (const d of draft) {
            const entry = {
                address: d.address,
                name: aliasCount.get(d.alias) === 1 ? `${d.alias}.${d._input}` : null,
                type: d.type,
                current_value: d.current_value,
                node: d.node
            };
            slots.push(entry);
        }
        return slots;
    }

    // API 格式：原始值输入即槽位，数组值是连线引用
    for (const [nodeId, node] of Object.entries(workflow || {})) {
        if (!node || typeof node !== 'object') continue;
        const title = node._meta?.title || node.class_type || nodeId;
        for (const [name, value] of Object.entries(node.inputs || {})) {
            if (!isPrimitiveValue(value)) continue;
            slots.push({
                address: `${nodeId}.${name}`,
                name: null,
                type: Array.isArray(value) ? 'ARRAY' : typeof value === 'number'
                    ? (Number.isInteger(value) ? 'INT' : 'FLOAT')
                    : (typeof value === 'boolean' ? 'BOOLEAN' : 'STRING'),
                current_value: value,
                node: { id: nodeId, title, class_type: node.class_type || '' }
            });
        }
    }
    return slots;
}

/**
 * 解析槽位地址 → {nodeId, inputName}。支持 `<id>.<input>` 与唯一标题别名
 * `<slug>.<input>`；名字里带点不可分割，故从右侧取第一个点分段。
 * @param {Object} workflow - 工作流对象
 * @param {string} address
 * @param {Object} [objectInfo] - UI 格式必需
 * @returns {{nodeId: string, inputName: string}}
 * @throws {Error} 地址无法解析时抛出
 */
function resolveSlotAddress(workflow, address, objectInfo) {
    const str = String(address || '').trim();
    const dot = str.lastIndexOf('.');
    if (dot <= 0 || dot === str.length - 1) {
        throw new Error(`槽位地址 "${address}" 格式不正确（应为 节点id.输入名 或 标题slug.输入名）`);
    }
    const head = str.slice(0, dot);
    const inputName = str.slice(dot + 1);

    if (isUiFormat(workflow)) {
        const nodes = workflow.nodes || [];
        const byId = nodes.find((n) => String(n.id) === head);
        if (byId) return { node: byId, inputName };
        // 标题别名：需在全部节点里唯一
        const matches = nodes.filter((n) =>
            slugifyTitle(n.title && n.title !== n.type ? n.title : '') === head);
        if (matches.length === 1) return { node: matches[0], inputName };
        if (matches.length > 1) {
            throw new Error(`槽位地址 "${address}" 的标题别名不唯一（${matches.length} 个同名节点），请改用 节点id.输入名`);
        }
        throw new Error(`槽位地址 "${address}" 找不到对应节点`);
    }

    const node = workflow[head];
    if (node && typeof node === 'object') {
        return { node: { id: head, __apiNode: node }, inputName };
    }
    // API 格式标题别名：经 _meta.title 匹配（需唯一）
    const byTitle = Object.entries(workflow || {}).filter(([, n]) =>
        n && typeof n === 'object' && slugifyTitle(n._meta?.title || '') === head);
    if (byTitle.length === 1) {
        const [id, n] = byTitle[0];
        return { node: { id, __apiNode: n }, inputName };
    }
    if (byTitle.length > 1) {
        throw new Error(`槽位地址 "${address}" 的标题别名不唯一（${byTitle.length} 个同名节点），请改用 节点id.输入名`);
    }
    throw new Error(`槽位地址 "${address}" 找不到对应节点`);
}

/**
 * 按槽位地址批量写入值（不改动传入对象，返回深拷贝后的新工作流）。
 * UI 格式写入 widgets_values 对应位置（并同步新版 inputs 条目）；
 * API 格式直接写 node.inputs。
 * @param {Object} workflow - 工作流对象
 * @param {Object} overrides - { 地址: 新值 }
 * @param {Object} [objectInfo] - UI 格式必需
 * @returns {Object} 修改后的工作流（新对象）
 * @throws {Error} 任一地址无法解析或目标不是槽位时抛出
 */
function setWorkflowSlots(workflow, overrides, objectInfo) {
    const cloned = JSON.parse(JSON.stringify(workflow));
    const isUi = isUiFormat(cloned);

    for (const [address, value] of Object.entries(overrides || {})) {
        const { node, inputName } = resolveSlotAddress(cloned, address, objectInfo);

        if (!isUi) {
            const apiNode = node.__apiNode;
            if (!(inputName in (apiNode.inputs || {}))) {
                throw new Error(`槽位 "${address}" 不存在（API 格式节点的 inputs 里没有 "${inputName}"）`);
            }
            apiNode.inputs[inputName] = value;
            continue;
        }

        const def = objectInfo?.[node.type];
        if (!def) throw new Error(`节点类型 "${node.type}" 不在 object_info 中，无法定位槽位 "${address}"`);
        const specEntry = getDefInputs(def).find(([n]) => n === inputName);
        if (!specEntry || !isWidgetSpec(specEntry[1])) {
            throw new Error(`槽位 "${address}" 不存在或不是可调控件输入（"${inputName}" 是连线输入或未声明）`);
        }

        // 找到该控件在 widgets_values 里的位置：与 mapNodeWidgetValues 同序消费
        const raw = Array.isArray(node.widgets_values) ? node.widgets_values : [];
        const objEntry = raw.find((v) => v && typeof v === 'object' && !Array.isArray(v) && v.name === inputName);
        if (objEntry) {
            objEntry.value = value;
            continue;
        }
        const { order } = mapNodeWidgetValues(node, def);
        const idx = order.indexOf(inputName);
        if (idx >= 0 && idx < raw.length) {
            raw[idx] = value;
        } else if (idx >= 0) {
            while (raw.length < idx) raw.push(null);
            raw.push(value);
        }
        node.widgets_values = raw;

        // 新版导出里控件值可能同时落在 node.inputs 的同名条目上，一并同步
        const uiEntry = (node.inputs || []).find((i) => i.name === inputName);
        if (uiEntry && uiEntry.link == null) uiEntry.value = value;
    }
    return cloned;
}

module.exports = {
    isUiFormat,
    convertUiToApi,
    collectClassTypes,
    listWorkflowSlots,
    setWorkflowSlots,
    resolveSlotAddress
};
