/**
 * ==========================================================================
 * LumenLight RunningHub 应用参数模板解析器（RhAppImporter）
 * ==========================================================================
 * 作用：把平台 apiCallDemo 接口返回的 AI 应用参数模板解析成画布节点的
 *       参数行定义（params），与工作流的 RhWorkflowImporter 对位：
 *         输入：POST /api/runninghub/fetch-app 的响应
 *               { webappName, nodeInfoList }
 *         输出：[{ nodeId, fieldName, label, type, role?, options? }]
 *               （结构与登记卡 params 完全一致，RunningHubParamRows 直接渲染）
 *
 * 模板条目形态（实测）：
 *   { nodeId, nodeName, fieldName, fieldType, fieldData, fieldValue,
 *     description }  —— description 是应用作者写的中文标签（如「图1：人物」）
 *
 * 解析规则：
 *   1. IMAGE            → type:'image'（生成时按槽位顺序取节点连线图片）
 *   2. LIST             → type:'list'，选项从 fieldData JSON 的
 *                         ["COMBO", {options:[...]}] 解出
 *   3. STRING           → type:'string'；description/fieldName 含提示词
 *                         形态词时带 role（连线提示词/负面提示词自动兜底）
 *   4. INT/FLOAT        → type:'string'（文本行，平台 fieldValue 统一字符串）
 *   5. BOOLEAN          → type:'list'（true/false 下拉）
 *   6. 其他/未知类型    → 有标量 fieldValue 时按 string 暴露，否则跳过
 *
 * 纯函数、不碰 DOM，可独立测试。
 * ==========================================================================
 */

class RhAppImporter {
    /** 提示词形态识别（description 优先，fieldName 兜底） */
    static PROMPT_RE = /(提示词|正向|prompt|positive)/i;
    static NEGATIVE_RE = /(负面|负向|negative)/i;

    /**
     * 解析应用参数模板 → 节点参数行定义
     * @param {Object} data - { webappName?, nodeInfoList: [...] }
     * @returns {Object} { params: [...] } 成功，或 { error: '原因' } 失败
     */
    static import(data) {
        const list = data && Array.isArray(data.nodeInfoList) ? data.nodeInfoList : null;
        if (!list || list.length === 0) {
            return { error: '模板为空（nodeInfoList 缺失或没有可调参数）' };
        }

        const params = [];
        const seen = new Set();
        let imageSeq = 0;

        for (const item of list) {
            if (!item || item.nodeId === undefined || !item.fieldName) continue;
            const nodeId = String(item.nodeId);
            const fieldName = String(item.fieldName);
            const key = `${nodeId}:${fieldName}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const fieldType = String(item.fieldType || '').toUpperCase();
            const desc = String(item.description || '').trim();
            const label = desc || fieldName;
            // 模板默认值：应用参数与工作流不同，空串提交会给强类型字段
            // （FLOAT/INT 等）转换失败，必须随参数行预填并兜底提交
            const def = String(item.fieldValue ?? '').trim();

            // 1. 图片槽位：fieldType 直接标注，字段名 image 兜底
            if (fieldType === 'IMAGE' ||
                (fieldName === 'image' && /\.(png|jpe?g|webp|gif)$/i.test(String(item.fieldValue || '')))) {
                imageSeq++;
                params.push({
                    nodeId, fieldName,
                    label: desc || `输入图片${imageSeq}`,
                    type: 'image'
                });
                continue;
            }

            // 2. 下拉：fieldData 是 JSON 字符串 ["COMBO", {options, default, ...}]
            if (fieldType === 'LIST' || fieldType === 'COMBO') {
                const options = RhAppImporter._parseComboOptions(item.fieldData);
                if (options.length > 0) {
                    params.push({ nodeId, fieldName, label, type: 'list', options, def });
                    continue;
                }
                // 无选项可解析：回退文本行（fieldValue 至少能当缺省值用）
                params.push({ nodeId, fieldName, label, type: 'string', def });
                continue;
            }

            // 5. 开关：渲染成 true/false 下拉（平台 fieldValue 统一字符串）
            if (fieldType === 'BOOLEAN') {
                params.push({
                    nodeId, fieldName, label, type: 'list',
                    options: ['true', 'false'],
                    // 模板默认可能是 'True'/'False'（Python 风格），归一小写
                    def: def.toLowerCase()
                });
                continue;
            }

            // 3/4. 文本与数值：统一文本行；数值/字符串都有 fieldValue 作缺省
            if (fieldType === 'STRING' || fieldType === 'INT' ||
                fieldType === 'FLOAT' || item.fieldValue !== undefined) {
                const role = RhAppImporter.NEGATIVE_RE.test(desc) || /^negative/i.test(fieldName)
                    ? 'negative'
                    : (RhAppImporter.PROMPT_RE.test(desc) || /^(positive|prompt)$/i.test(fieldName))
                        ? 'prompt'
                        : undefined;
                params.push({
                    nodeId, fieldName, label, type: 'string', def,
                    ...(role ? { role } : {})
                });
            }
            // 其他未知类型且无标量值：跳过（不可调）
        }

        if (params.length === 0) {
            return { error: '未从模板解析出可调参数' };
        }
        return { params };
    }

    /**
     * 解析 fieldData 里的 COMBO 选项清单
     * @param {string|Array} fieldData - JSON 字符串或已解数组
     * @returns {string[]} 选项数组（解析失败返回空数组）
     */
    static _parseComboOptions(fieldData) {
        let parsed = fieldData;
        if (typeof fieldData === 'string') {
            try { parsed = JSON.parse(fieldData); } catch { return []; }
        }
        if (!Array.isArray(parsed) || !parsed[1] || typeof parsed[1] !== 'object') return [];
        const options = parsed[1].options;
        if (!Array.isArray(options)) return [];
        return options.map((o) => String(o)).filter((o) => o.length > 0);
    }
}

// 暴露到全局作用域（浏览器端经典脚本，画布节点调用）
window.RhAppImporter = RhAppImporter;
