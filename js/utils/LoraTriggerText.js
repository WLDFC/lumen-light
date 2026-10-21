/**
 * ==========================================================================
 * LumenLight LoRA 触发词文本纯函数层（LoraTriggerText）
 * ==========================================================================
 * 作用：触发词管理器（components/LoraTriggerManager.js）的托管块拼装与
 *       正向框写入策略，全部收口为纯函数——不碰 DOM、不碰 localStorage，
 *       可独立单测。使用方只有触发词管理器一处。
 *
 * 托管块契约（受管段落）：
 *   - 叠加区生效 LoRA 的触发词拼成「触发词块」，写入目标正向框末尾，
 *     与原提示词空一行（\n\n）分隔；块内每只 LoRA 一行，词按 ", " 连接；
 *   - 权重 = 1 原文写入；≠1 写 ComfyUI 权重语法 (词:权重)；
 *   - 管理器维护「书签」（上次写入的块文本）：同步时书签原位替换；
 *     书签丢失（手删块/切换存档）→ 末尾重写；块已在框内（含用户手写过
 *     相同内容）→ 整串去重跳过；块为空 → 从框内移除。
 *
 * 路径基准（ADR 028 同源问题）：meta.triggers 与配置键是管理器扫描基准
 * （正斜杠相对路径），叠加区条目 file 可能是 ComfyUI object_info 的
 * 反斜杠原生形态——入表前统一 normalizeRel 归一。
 * ==========================================================================
 */

/**
 * 归一 LoRA 相对路径：反斜杠→正斜杠、去首尾分隔符。
 * @param {string} file - 叠加区条目文件（ComfyUI 原生形态或管理器形态）
 * @returns {string} 正斜杠相对路径（与 meta.triggers / lora-meta.json 键同源）
 */
function normalizeRel(file) {
    return String(file || '')
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '');
}

/**
 * 解析触发词串：按半角/全角逗号拆分、trim、剔除空词与重复词。
 * @param {string} metaStr - meta.triggers[rel] 原文（Civitai trainedWords join(', ')）
 * @returns {string[]} 词列表（保序）
 */
function parseWords(metaStr) {
    const seen = new Set();
    const words = [];
    for (const raw of String(metaStr || '').split(/[,，]/)) {
        const w = raw.trim();
        if (w && !seen.has(w)) {
            seen.add(w);
            words.push(w);
        }
    }
    return words;
}

/**
 * 权重格式化：1 视为不加重；其余保留两位以内小数（1.20 → '1.2'，1.05 → '1.05'）
 * @param {number} weight
 * @returns {string|null} 数字文本；不加重返回 null
 */
function formatWeight(weight) {
    const w = Number(weight);
    if (!isFinite(w) || w === 1) return null;
    return String(Number(w.toFixed(2)));
}

/**
 * 单词按权重落文本：1 → 原文；≠1 → (词:权重)
 * @param {string} word
 * @param {number} weight
 * @returns {string}
 */
function weightWord(word, weight) {
    const w = formatWeight(weight);
    return w ? `(${word}:${w})` : word;
}

/**
 * 拼装托管块。
 * 单词默认态：配置里没记录的词视为 开 + 权重 1；LoRA 级开关关闭整只跳过。
 * @param {Array<{rel: string, words: string[]}>} entries - 叠加区生效条目
 *        （栈序，每只已过生效过滤），words 为该 LoRA 的 Civitai 触发词
 * @param {Object<string, {enabled?: boolean, words?: Object<string, {on?: boolean, weight?: number}>}>} lorasCfg
 *        配置表（按归一化 rel 键；缺省即全开权重 1）
 * @returns {string} 块文本；无生效词为空串
 */
function composeBlock(entries, lorasCfg) {
    const lines = [];
    for (const entry of entries || []) {
        const cfg = (lorasCfg && lorasCfg[entry.rel]) || {};
        if (cfg.enabled === false) continue;
        const seg = (entry.words || [])
            .filter((w) => !cfg.words || !cfg.words[w] || cfg.words[w].on !== false)
            .map((w) => weightWord(w, cfg.words && cfg.words[w] ? cfg.words[w].weight : 1));
        if (seg.length) lines.push(seg.join(', '));
    }
    return lines.join('\n');
}

/**
 * 从框内容中摘除一段（连带其一侧的空行分隔符，不留连续空行）
 * @param {string} value - 框内容
 * @param {string} seg - 要移除的段（精确子串）
 * @returns {string}
 */
function removeSegment(value, seg) {
    let v = value;
    if (v.includes('\n\n' + seg)) v = v.replace('\n\n' + seg, '');
    else if (v.includes(seg + '\n\n')) v = v.replace(seg + '\n\n', '');
    else v = v.replace(seg, '');
    return v;
}

/**
 * 把托管块写入框内容（书签策略，见文件头契约）。
 * @param {string} boxValue - 目标正向框当前内容
 * @param {string} block - 本轮应写入的块文本（空串 = 移除托管块）
 * @param {string} lastBlock - 书签：上次写入的块文本（空串 = 从未写过）
 * @returns {{value: string, changed: boolean}} 新框内容与是否有变化
 */
function applyBlock(boxValue, block, lastBlock) {
    const original = boxValue || '';

    // 移除：块为空但书签还在框里
    if (!block) {
        if (!lastBlock || !original.includes(lastBlock)) {
            return { value: original, changed: false };
        }
        return { value: removeSegment(original, lastBlock).trim(), changed: true };
    }

    // 原位替换：书签命中且内容有变（保住用户可能挪动的位置）
    if (lastBlock && lastBlock !== block && original.includes(lastBlock)) {
        return { value: original.replace(lastBlock, block), changed: true };
    }

    // 整串去重：目标块已在框内（书签相同，或用户手写过相同内容）→ 跳过
    if (original.includes(block)) {
        return { value: original, changed: false };
    }

    // 末尾追加：首次写入 / 书签丢失（手删块、切存档）/ 切换目标框
    const trimmed = original.replace(/\s+$/, '');
    return { value: trimmed + (trimmed ? '\n\n' : '') + block, changed: true };
}

// 暴露到全局作用域
window.LoraTriggerText = {
    normalizeRel,
    parseWords,
    formatWeight,
    weightWord,
    composeBlock,
    applyBlock
};
