/**
 * ==========================================================================
 * 并排窗口留白共享纯函数层（SidePanelLayout，2026-11-08）
 * ==========================================================================
 * 「布局」模式的窗口右缘留白计算，消费方：LoRA 管理器、提示词管理器
 * （坐标编辑器是历史实现自带同款方法，未改）。口径：
 *   - 弹窗元素自身就是遮罩，css `right: var(--side-layout-gap)` 收右缘
 *     即露出下层 Comfy/LLM 面板，不覆盖不穿透；
 *   - 留白按 #promptPanel 实测左缘对齐 +7px 呼吸（面板宽可拖 480-700px，
 *     写死数字永远差一点）；面板关闭/不可测回落 552px（默认宽 540+留边 5+7）；
 *   - 钳制：至少露 360px 给面板，至多给弹窗保底 minWidth。
 * 纯函数层：Jest 可单测（document/window 经参数与桩注入，不持有状态）。
 */

const SidePanelLayout = {
    /**
     * 留白钳制
     * @param {number} px - 待钳制的留白值（非法值回落 552 默认档）
     * @param {number} innerWidth - 视口宽（非法回落 1920 仅用于测试兜底）
     * @param {number} minWidth - 弹窗保底宽度（留白至多 innerWidth-minWidth）
     * @returns {number}
     */
    clampGap(px, innerWidth, minWidth) {
        const iw = (typeof innerWidth === 'number' && innerWidth > 0) ? innerWidth : 1920;
        const min = 360;
        const max = Math.max(min, iw - minWidth);
        const n = (typeof px === 'number' && Number.isFinite(px)) ? px : 552;
        return Math.round(Math.max(min, Math.min(max, n)));
    },

    /**
     * 默认留白：右侧面板可见时按其实测左缘对齐 +7px 呼吸；面板关闭/
     * 不可测时回落 552px
     * @param {number} innerWidth - 视口宽
     * @param {number} minWidth - 弹窗保底宽度
     * @returns {number}
     */
    defaultGap(innerWidth, minWidth) {
        if (typeof document !== 'undefined') {
            const panel = document.getElementById('promptPanel');
            if (panel) {
                const r = panel.getBoundingClientRect();
                if (typeof window !== 'undefined' &&
                    typeof window.innerWidth === 'number' &&
                    r.width > 0 && r.left >= 0 && r.left < window.innerWidth) {
                    return this.clampGap(window.innerWidth - r.left + 7, window.innerWidth, minWidth);
                }
            }
        }
        return this.clampGap(552, innerWidth, minWidth);
    }
};

window.SidePanelLayout = SidePanelLayout;
