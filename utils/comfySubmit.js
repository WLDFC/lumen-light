/**
 * ==========================================================================
 * ComfyUI 提交工具（comfy.js 与 comfyNode.js 共用）
 * 作用：把注入完成的工作流 POST 到 ComfyUI 的 /prompt 接口，统一
 *       超时、响应校验与错误解析。此前两条提交链路各写一份 fetch +
 *       错误处理，格式还不一致（"ComfyUI 错误"/"ComfyUI:"）。
 *
 * 错误格式说明：ComfyUI 校验失败时 error 为 {type, message, details}
 * 对象，其他失败时可能直接是字符串，这里统一解析成可读 message。
 * ==========================================================================
 */

/**
 * 提交工作流到 ComfyUI /prompt 接口并校验响应
 * @param {string} comfyApiUrl - ComfyUI API 地址
 * @param {Object} workflow - 注入完成的 ComfyUI 工作流对象
 * @param {string} clientIdPrefix - client_id 前缀（区分提交来源：面板/生图节点）
 * @param {number} [timeoutMs=30000] - 请求超时毫秒数
 * @returns {Promise<{promptId: string}>} 提交成功时的 prompt id
 */
async function submitPromptToComfy(comfyApiUrl, workflow, clientIdPrefix, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const promptData = {
            prompt: workflow,
            client_id: `${clientIdPrefix}_${Date.now()}`
        };

        const response = await fetch(`${comfyApiUrl}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(promptData),
            signal: controller.signal
        });
        const result = await response.json().catch(() => ({}));

        if (!response.ok || result.error) {
            const errInfo = result.error || `HTTP ${response.status}`;
            let message = typeof errInfo === 'object'
                ? (errInfo.message || JSON.stringify(errInfo))
                : errInfo;

            // 附带节点级校验详情："Prompt outputs failed validation" 本身
            // 不定位问题（如模型文件被改名后不在清单），ComfyUI 的
            // node_errors 里有具体节点 id 与输入值，取前 3 条拼进消息
            const nodeErrors = result.node_errors || {};
            const details = [];
            for (const nodeId in nodeErrors) {
                for (const e of (nodeErrors[nodeId].errors || [])) {
                    details.push(`节点 ${nodeId} ${e.details || e.message}`);
                }
            }
            if (details.length > 0) {
                message += `（${details.slice(0, 3).join('；')}）`;
            }

            throw new Error(`ComfyUI 错误: ${message}`);
        }

        return { promptId: result.prompt_id };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { submitPromptToComfy };
