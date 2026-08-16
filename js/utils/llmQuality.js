/**
 * ==========================================================================
 * LumenLight LLM 质量档位工具
 * ==========================================================================
 * 作用：集中管理图像生成模型的 quality 参数档位判断逻辑，
 *       供 LLM 对话框（LlmChat）与画布生图节点（ImageGenNode）复用，
 *       保证两处的质量下拉行为完全一致。
 *       本文件只包含纯判断逻辑，不操作 DOM。
 * 对应组件：js/components/LlmChat.js、js/canvas/ImageGenNode.js
 * ==========================================================================
 */

class LlmQuality {
    /**
     * 判断给定模型是否支持 quality 质量参数，并返回该模型对应的质量档位选项
     * 目前仅 OpenAI 系图像模型明确暴露该参数：
     *   - gpt-image 系列：low / medium / high / auto
     *   - dall-e-3：standard / hd / auto
     *   - dall-e-2：standard（不单独处理，dall-e-3 下拉已覆盖）
     * @param {string} modelId - 模型 ID
     * @returns {Array<{value: string, label: string}>|null} 支持时返回选项列表，不支持返回 null
     */
    static getOptions(modelId) {
        if (!modelId) return null;
        const lower = modelId.toLowerCase();
        if (lower.includes('gpt-image')) {
            return [
                { value: '', label: '自动' },
                { value: 'low', label: '低质量' },
                { value: 'medium', label: '中质量' },
                { value: 'high', label: '高质量' }
            ];
        }
        if (lower.includes('dall-e') || lower.includes('dalle')) {
            return [
                { value: '', label: '自动' },
                { value: 'standard', label: '标准' },
                { value: 'hd', label: '高清' }
            ];
        }
        return null;
    }
}

// 将 LlmQuality 类暴露到全局作用域
window.LlmQuality = LlmQuality;
