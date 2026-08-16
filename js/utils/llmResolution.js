/**
 * ==========================================================================
 * LumenLight LLM 尺寸与分辨率计算工具
 * ==========================================================================
 * 作用：将 LLM 对话框中的比例选择、分辨率档位、模型约束/降级逻辑
 *       从 LlmChat.js 中独立出来，方便单独维护、复用和单元测试。
 *       本文件只包含纯计算逻辑，不操作 DOM。
 * 对应组件：js/components/LlmChat.js
 * ==========================================================================
 */

class LlmResolution {
    /**
     * 获取可用的比例选项列表
     * @returns {string[]}
     */
    static getSizeOptions() {
        return ['1:1', '9:16', '2:3', '3:4', '4:3', '3:2', '16:9', 'auto'];
    }

    /**
     * 分辨率档位列表
     * 对 gpt-image-2 实际按目标像素面积处理；
     * 对其他模型，档位对应长边像素，短边按所选比例等比推导。
     * @returns {Array<{label: string, longEdge: number}>}
     */
    static getResolutionTiers() {
        return [
            { label: '1K', longEdge: 1024 },
            { label: '2K', longEdge: 2560 },
            { label: '4K', longEdge: 3840 }
        ];
    }

    /**
     * 根据模型、比例、分辨率档位计算实际像素尺寸
     * 对不支持的档位会自动降级到模型允许的最大尺寸
     * @param {string} modelId - 模型 ID
     * @param {string} ratio - 比例字符串，如 "1:1"
     * @param {string} tierLabel - 档位标签：1K / 2K / 4K
     * @returns {{width: number, height: number}|null}
     */
    static getResolutionForModel(modelId, ratio, tierLabel = '2K') {
        if (ratio === 'auto') return null;

        // gpt-image-2 使用目标像素面积划分档位
        if (modelId && modelId.toLowerCase().includes('gpt-image-2')) {
            return LlmResolution.getGptImage2Resolution(ratio, tierLabel);
        }

        const tier = LlmResolution.getResolutionTiers().find((t) => t.label === tierLabel);
        const longEdge = tier ? tier.longEdge : 2560;

        const [wStr, hStr] = ratio.split(':');
        const w = parseInt(wStr, 10);
        const h = parseInt(hStr, 10);

        let width;
        let height;
        if (w >= h) {
            width = longEdge;
            height = Math.round(longEdge * h / w);
        } else {
            height = longEdge;
            width = Math.round(longEdge * w / h);
        }

        return LlmResolution.applyModelResolutionConstraints(modelId, width, height, ratio);
    }

    /**
     * gpt-image-2 比例档位预设
     * 按 OpenAI 官方稳定性区间，以目标像素面积划分档位：
     * 1K ≈ 157 万（标准费率档），2K ≈ 369 万（官方推荐稳定上限 2560×1440），
     * 4K ≈ 829 万（实验性最大面积）
     * @param {string} ratio - 比例字符串
     * @param {string} tierLabel - 档位标签
     * @returns {{width: number, height: number}|null}
     */
    static getGptImage2Resolution(ratio, tierLabel) {
        const targetAreas = { '1K': 1572864, '2K': 3686400, '4K': 8294400 };
        const targetArea = targetAreas[tierLabel] || 3686400;

        const [wStr, hStr] = ratio.split(':');
        const w = parseInt(wStr, 10);
        const h = parseInt(hStr, 10);
        const ratioValue = w / h;

        const width = Math.sqrt(targetArea * ratioValue);
        const height = Math.sqrt(targetArea / ratioValue);

        return LlmResolution.clampGptImage2Size(Math.round(width), Math.round(height));
    }

    /**
     * 按模型能力对计算出的尺寸进行约束（降级到上限 / 升档到下限）
     * @param {string} modelId - 模型 ID
     * @param {number} width - 理想宽度
     * @param {number} height - 理想高度
     * @param {string} ratio - 比例字符串，用于固定尺寸模型匹配
     * @returns {{width: number, height: number, upgraded?: boolean}}
     *          upgraded 为 true 表示因低于模型最小总像素而被等比放大
     */
    static applyModelResolutionConstraints(modelId, width, height, ratio) {
        if (!modelId) return { width, height };

        const lower = modelId.toLowerCase();

        // gpt-image-2：任意尺寸，但有最大边、16 整除、总像素等约束
        if (lower.includes('gpt-image-2')) {
            return LlmResolution.clampGptImage2Size(width, height);
        }

        // gpt-image-1.x：仅支持固定三档
        if (lower.includes('gpt-image-1')) {
            return LlmResolution.getNearestFixedSize(ratio, [
                { width: 1024, height: 1024 },
                { width: 1536, height: 1024 },
                { width: 1024, height: 1536 }
            ]);
        }

        // DALL-E 3：仅支持固定三档
        if (lower.includes('dall-e-3') || lower.includes('dalle-3')) {
            return LlmResolution.getNearestFixedSize(ratio, [
                { width: 1024, height: 1024 },
                { width: 1792, height: 1024 },
                { width: 1024, height: 1792 }
            ]);
        }

        // DALL-E 2：仅支持 1024x1024
        if (lower.includes('dall-e-2') || lower.includes('dalle-2')) {
            return { width: 1024, height: 1024 };
        }

        // Seedream 5.0 pro：最高 2K
        if (lower.includes('seedream-5') && lower.includes('pro')) {
            return LlmResolution.clampLongEdge(width, height, 2560, 1024);
        }

        // Seedream 5.0 lite：最低 2K，最高 4K
        if (lower.includes('seedream-5') && lower.includes('lite')) {
            return LlmResolution.clampLongEdge(width, height, 4096, 1280);
        }

        // Seedream 4.5：有最小总像素硬限制（3686400，即 2560×1440 级），
        // 1K 档整体低于下限，需等比放大到最低可用档
        if (lower.includes('seedream-4-5')) {
            const result = LlmResolution.clampArea(width, height, LlmResolution.SEEDREAM_45_MIN_TOTAL_PIXELS);
            if (result.width !== width || result.height !== height) {
                result.upgraded = true;   // 标记发生过下限抬升，供调用方提示用户
            }
            return result;
        }

        // Seedream 4.x 及其他：最高 4K
        return LlmResolution.clampLongEdge(width, height, 4096, 1024);
    }

    /**
     * 将总像素钳制到不低于 minArea（保持宽高比等比放大）
     * 用于存在"最小总像素"硬限制的模型（如 Seedream 4.5 要求 ≥ 3686400）
     * @param {number} width - 宽度
     * @param {number} height - 高度
     * @param {number} minArea - 最小总像素
     * @returns {{width: number, height: number}}
     */
    static clampArea(width, height, minArea) {
        const area = width * height;
        if (area >= minArea) return { width, height };
        const scale = Math.sqrt(minArea / area);
        return { width: Math.round(width * scale), height: Math.round(height * scale) };
    }

    /**
     * 获取模型允许的最小总像素（0 表示无特殊下限）
     * 供尺寸选择器判断哪些分辨率档位整档低于模型下限（1:1 时面积最大的比例
     * 仍不达标，则该档位任何比例都不可用）
     * @param {string} modelId - 模型 ID
     * @returns {number}
     */
    static getMinTotalPixels(modelId) {
        if (!modelId) return 0;
        const lower = modelId.toLowerCase();
        if (lower.includes('seedream-4-5')) return LlmResolution.SEEDREAM_45_MIN_TOTAL_PIXELS;
        return 0;
    }

    /**
     * gpt-image-2 尺寸约束：最大边 < 3840、16 整除、总像素范围等
     * @param {number} width - 宽度
     * @param {number} height - 高度
     * @returns {{width: number, height: number}}
     */
    static clampGptImage2Size(width, height) {
        const MAX_EDGE = 3839;        // 官方要求 < 3840
        const MIN_AREA = 655360;      // 官方最低总像素
        const MAX_AREA = 8294400;     // 官方最高总像素
        const MIN_RATIO = 1 / 3;
        const MAX_RATIO = 3;

        // 约束宽高比
        let ratio = width / height;
        if (ratio < MIN_RATIO) {
            height = Math.round(width / MIN_RATIO);
            ratio = MIN_RATIO;
        } else if (ratio > MAX_RATIO) {
            width = Math.round(height * MAX_RATIO);
            ratio = MAX_RATIO;
        }

        // 约束最大边
        let maxEdge = Math.max(width, height);
        if (maxEdge > MAX_EDGE) {
            const scale = MAX_EDGE / maxEdge;
            width = Math.round(width * scale);
            height = Math.round(height * scale);
        }

        // 约束最小总像素
        let area = width * height;
        if (area < MIN_AREA) {
            const scale = Math.sqrt(MIN_AREA / area);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
            maxEdge = Math.max(width, height);
            if (maxEdge > MAX_EDGE) {
                const downScale = MAX_EDGE / maxEdge;
                width = Math.round(width * downScale);
                height = Math.round(height * downScale);
            }
        }

        // 约束最大总像素
        area = width * height;
        if (area > MAX_AREA) {
            const scale = Math.sqrt(MAX_AREA / area);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
        }

        // 两边向下取整到 16 的倍数
        width = Math.floor(width / 16) * 16;
        height = Math.floor(height / 16) * 16;

        if (width < 16) width = 16;
        if (height < 16) height = 16;

        return { width, height };
    }

    /**
     * 从固定尺寸列表中挑选最接近目标比例的一项
     * @param {string} ratio - 比例字符串
     * @param {Array<{width: number, height: number}>} sizes - 候选尺寸
     * @returns {{width: number, height: number}}
     */
    static getNearestFixedSize(ratio, sizes) {
        const [wStr, hStr] = ratio.split(':');
        const w = parseInt(wStr, 10);
        const h = parseInt(hStr, 10);
        const targetRatio = w / h;

        let best = sizes[0];
        let bestDiff = Infinity;
        sizes.forEach((size) => {
            const r = size.width / size.height;
            const diff = Math.abs(r - targetRatio);
            if (diff < bestDiff) {
                bestDiff = diff;
                best = size;
            }
        });
        return { width: best.width, height: best.height };
    }

    /**
     * 将长边限制在 [minLong, maxLong] 范围内，短边等比缩放
     * @param {number} width - 宽度
     * @param {number} height - 高度
     * @param {number} maxLong - 最大长边
     * @param {number} minLong - 最小长边
     * @returns {{width: number, height: number}}
     */
    static clampLongEdge(width, height, maxLong, minLong = 1024) {
        let longEdge = Math.max(width, height);
        if (longEdge > maxLong) {
            const scale = maxLong / longEdge;
            width = Math.round(width * scale);
            height = Math.round(height * scale);
        }
        longEdge = Math.max(width, height);
        if (longEdge < minLong) {
            const scale = minLong / longEdge;
            width = Math.round(width * scale);
            height = Math.round(height * scale);
        }
        return { width, height };
    }

    /**
     * 计算比例小图标的内部矩形尺寸与样式
     * 在固定 18x18 容器内居中显示，直观展示宽高比
     * @param {number} w - 宽比例值
     * @param {number} h - 高比例值
     * @returns {string} inline style
     */
    static getRatioIconStyle(w, h) {
        const containerSize = 18;
        const ratio = w / h;
        let iconW;
        let iconH;
        if (ratio >= 1) {
            iconH = 10;
            iconW = Math.round(iconH * ratio);
            if (iconW > containerSize - 2) iconW = containerSize - 2;
        } else {
            iconW = 10;
            iconH = Math.round(iconW / ratio);
            if (iconH > containerSize - 2) iconH = containerSize - 2;
        }
        return `width:${iconW}px;height:${iconH}px`;
    }

    /**
     * 按参考图宽高比例与所选档位计算输出尺寸
     * 返回对象，供后续按模型能力再做约束/降级
     * @param {number} width - 参考图宽度
     * @param {number} height - 参考图高度
     * @param {string} tierLabel - 分辨率档位 1K / 2K / 4K
     * @returns {{width: number, height: number}}
     */
    static computeAdaptiveSize(width, height, tierLabel = '2K') {
        const tier = LlmResolution.getResolutionTiers().find((t) => t.label === tierLabel);
        const LONG_EDGE = tier ? tier.longEdge : 2560;
        const MIN = 1024;
        const MAX = 4096;
        const ratio = width / height;

        let w;
        let h;
        if (ratio >= 1) {
            w = LONG_EDGE;
            h = Math.round(LONG_EDGE / ratio);
        } else {
            h = LONG_EDGE;
            w = Math.round(LONG_EDGE * ratio);
        }

        // 短边低于下限时，以短边 1024 反推长边
        if (w < MIN) {
            w = MIN;
            h = Math.round(MIN / ratio);
        }
        if (h < MIN) {
            h = MIN;
            w = Math.round(MIN * ratio);
        }

        // 长边超上限时等比收缩
        if (w > MAX) {
            h = Math.round(h * (MAX / w));
            w = MAX;
        }
        if (h > MAX) {
            w = Math.round(w * (MAX / h));
            h = MAX;
        }

        return { width: w, height: h };
    }

    /**
     * 将任意宽高比归到最接近的标准比例字符串
     * @param {number} width - 宽度
     * @param {number} height - 高度
     * @returns {string} 比例字符串，如 "16:9"
     */
    static simplifyRatio(width, height) {
        const ratio = width / height;
        const standards = [
            { ratio: 1, label: '1:1' },
            { ratio: 9 / 16, label: '9:16' },
            { ratio: 2 / 3, label: '2:3' },
            { ratio: 3 / 4, label: '3:4' },
            { ratio: 4 / 3, label: '4:3' },
            { ratio: 3 / 2, label: '3:2' },
            { ratio: 16 / 9, label: '16:9' }
        ];

        let best = '1:1';
        let bestDiff = Infinity;
        standards.forEach((item) => {
            const diff = Math.abs(item.ratio - ratio);
            if (diff < bestDiff) {
                bestDiff = diff;
                best = item.label;
            }
        });
        return best;
    }
}

// Seedream 4.5 的最小总像素硬限制（2560×1440 = 3686400，约 2K），
// 由 API 报错原文 "image size must be at least 3686400 pixels" 确认
LlmResolution.SEEDREAM_45_MIN_TOTAL_PIXELS = 3686400;

// 将工具类暴露到全局作用域
window.LlmResolution = LlmResolution;
