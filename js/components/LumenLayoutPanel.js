/**
 * ==========================================================================
 * LumenLayoutPanel —— 并排布局开关预制件（2026-11-08 收敛）
 * ==========================================================================
 * 「布局」钮：窗口右缘留白、露出右侧 Comfy/LLM 面板的开关。消费方：
 * LoRA 管理器 / 提示词管理器 / 漫画编辑器（此前三处各写一套
 * toggle+记忆+置灰+留白应用，收敛成本件；留白数值计算在共享纯函数层
 * js/utils/SidePanelLayout.js，css 壳规则在 recipe-manager.css 的
 * .recipe-dialog.lora-layout 共享段与各窗样式档）。
 *
 * 职责边界：
 *   - 本件管：按钮点击开合与 is-active 高亮、localStorage 记忆、
 *     激活时实测留白并写 css 变量、视口不足时按钮置灰并强制回落
 *     （applyStored，开窗时调，记忆保留不抹——窗口拉宽重开即恢复）；
 *   - 宿主管：按钮元素（模板里建好、样式类自定，观感各窗不同）传入、
 *     窗口根元素（懒取）、css 类名与关-态留白语义（见下）。
 *
 * 留白语义：激活 → getGap()（缺省 SidePanelLayout.defaultGap，按
 * #promptPanel 实测左缘对齐）写 gapVar；关闭 → offGap 有值写该值
 * （漫画壳无条件吃变量，关闭=0px 全屏），为 null 移除变量（lora/recipe
 * 壳按 css 类切换，缺省档=全屏模态）。
 *
 * 契约：与 LumenBatchManager 同款——宿主持有实例、读 .active 判状态。
 * 测试经 vm 加载（SidePanelLayout 须先载），或 Object.create 绕开
 * constructor 桩 button/dialog。
 */
class LumenLayoutPanel {

    /**
     * @param {HTMLElement} button - 布局按钮（宿主模板建好；点击绑定本件）
     * @param {Function} dialog - () => 窗口根元素（开窗前可返回 null）
     * @param {string} storageKey - localStorage 键（'on'/'off'）
     * @param {string|null} [cssClass='lora-layout'] - 激活时挂窗口根的类
     *        （共享壳规则选择器用）；null = 只动变量不挂类（漫画壳）
     * @param {string} [gapVar='--side-layout-gap']
     * @param {string|null} [offGap=null] - 关-态变量值；null = 移除变量
     * @param {number} [minWidth=760] - 留白钳制参数（弹窗保底宽度）
     * @param {number} [minViewport=1500] - 视口下限（低于置灰禁切）
     * @param {Function} [getGap=null] - () => px 自定义留白（如漫画恢复
     *        拖拽值）；缺省 SidePanelLayout.defaultGap 实测面板
     * @param {string} [title] / [titleDisabled] - 按钮提示文案两态
     * @param {Function} [onChange=null] - (on) => {}（如漫画切布局重绘舞台）
     */
    constructor({
        button,
        dialog,
        storageKey,
        cssClass = 'lora-layout',
        gapVar = '--side-layout-gap',
        offGap = null,
        minWidth = 760,
        minViewport = 1500,
        getGap = null,
        title = '布局：窄化本窗口露出右侧 Comfy 面板',
        titleDisabled = '视口过窄（需 1500px 以上），布局模式不可用',
        onChange = null
    } = {}) {
        this.button = button;
        this.dialog = dialog;
        this.storageKey = storageKey;
        this.cssClass = cssClass;
        this.gapVar = gapVar;
        this.offGap = offGap;
        this.minWidth = minWidth;
        this.minViewport = minViewport;
        this.getGap = getGap;
        this.title = title;
        this.titleDisabled = titleDisabled;
        this.onChange = onChange;
        this._active = false;
        button.addEventListener('click', () => this.set(!this._active));
    }

    /** 当前是否并排态（宿主业务按此分流，如 LoRA 纸飞机直投） */
    get active() { return this._active; }

    /**
     * 开关（幂等）：css 类 + 变量 + 按钮高亮 + localStorage 记忆一次到位。
     * @param {boolean} on
     * @param {boolean} [persist=true] - false = 只动界面不落盘（视口不足
     *        强制回落时用，记忆保留待窗口拉宽恢复）
     */
    set(on, persist = true) {
        on = !!on;
        if (persist) localStorage.setItem(this.storageKey, on ? 'on' : 'off');
        this._active = on;
        const d = this.dialog && this.dialog();
        if (d) {
            if (this.cssClass) d.classList.toggle(this.cssClass, on);
            if (on) {
                const gap = this.getGap
                    ? this.getGap()
                    : window.SidePanelLayout.defaultGap(window.innerWidth, this.minWidth);
                d.style.setProperty(this.gapVar, gap + 'px');
            } else if (this.offGap != null) {
                d.style.setProperty(this.gapVar, this.offGap);
            } else {
                d.style.removeProperty(this.gapVar);
            }
        }
        this.button.classList.toggle('is-active', on);
        if (this.onChange) this.onChange(on);
    }

    /**
     * 开窗应用（show/open 时调）：视口判定（不足则按钮置灰并强制回落，
     * 记忆保留不抹）+ 记忆态恢复 + 留白实测（面板宽度自上次可能已变）。
     * @returns {boolean} 是否放行布局（视口足够）
     */
    applyStored() {
        const fits = typeof window.innerWidth === 'number' &&
            window.innerWidth >= this.minViewport;
        this.button.disabled = !fits;
        this.button.title = fits ? this.title : this.titleDisabled;
        this.set(localStorage.getItem(this.storageKey) === 'on' && fits, fits);
        return fits;
    }
}

window.LumenLayoutPanel = LumenLayoutPanel;
