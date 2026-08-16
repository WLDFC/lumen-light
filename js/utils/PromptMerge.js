/**
 * ==========================================================================
 * LumenLight 提示词段合并工具（PromptMerge）
 * ==========================================================================
 * 作用：把多段提示词合并为一条，供发送给 ComfyUI / LLM。使用方：
 *   - 画布提示词节点链（ImagePipeline.collectPrompt，N 个节点）
 *   - 右侧面板双正面框（PromptInputManager.getPrompts，2 个输入框）
 * 两处共用同一套拼接规则，避免规则漂移。
 *
 * 合并规则：
 *   1. 每段先 trim，空段剔除；
 *   2. 段与段之间用空行（\n\n）分隔；
 *   3. 拼接处自动补逗号（区分中英文）：
 *      - 前段已以 ，或 , 结尾 → 不补（避免双逗号）；
 *      - 前段以中文字符结尾 → 补全角 '，'（中文语感，对 Qwen/T5 系
 *        中文编码器更自然）；
 *      - 其余（英文/数字/符号结尾）→ 补半角 ','。
 *
 * 纯函数、不碰 DOM，可独立测试。
 * ==========================================================================
 */

/** 前段以中文字符结尾（常用汉字 + 扩展 A 区） */
const CJK_END_RE = /[\u3400-\u4dbf\u4e00-\u9fff]$/;

/** 前段已以逗号结尾（半角/全角都算） */
const COMMA_END_RE = /[，,]$/;

/**
 * 计算前段结尾需要的连接符
 * @param {string} prev - 前段内容（已 trim）
 * @returns {string} '' | '，' | ','
 */
function junctionSuffix(prev) {
    if (COMMA_END_RE.test(prev)) return '';
    return CJK_END_RE.test(prev) ? '，' : ',';
}

/**
 * 合并多段提示词
 * @param {string[]} segments - 各段原始内容（内部自动 trim / 剔除空段）
 * @returns {string} 合并后的提示词；无有效内容时为空串
 */
function join(segments) {
    const parts = (segments || []).map(s => (s || '').trim()).filter(Boolean);
    let result = '';
    for (const part of parts) {
        if (!result) {
            result = part;
            continue;
        }
        result += junctionSuffix(result) + '\n\n' + part;
    }
    return result;
}

// 暴露到全局作用域
window.PromptMerge = { join };
