/**
 * ==========================================================================
 * LumenLight 提示词写入目标预制件（PromptWriteTargets）
 * ==========================================================================
 * 作用：把「一段提示词文本写进某个目标」的完整链路收口成 Lumen 预制件，
 *       供需要注入/写入提示词的组件复用。首用方：收藏详情弹窗（
 *       TagDetailDialog）的「写入」钮。目标两类：
 *         - Comfy 面板正向框 1/2（textarea#posPrompt / #posPrompt2）
 *         - 画布提示词节点（window.canvas 全量实时枚举；节点标题自带
 *           全局 #NNN 编号——目标区分即靠它，BaseCanvasNode 同款）
 *
 * 写入契约（ADR 031/037 定型，写入原语与 LoraTriggerManager /
 * ComfyPromptPresets 逐字同款）：
 *   - 覆盖语义：目标原内容整体替换（画布节点若带 LoRA 触发词托管块会被
 *     冲掉，触发词管理器书签契约「丢失重写」下次重算自动补回，无需处理）；
 *   - 严禁派发合成 input 事件——会触发提示词自动补全弹建议条（ADR 031
 *     实测踩坑；面板框同样不派发，ADR 037 同约定）；
 *   - 画布节点：同步 node.text + NodeTextMirror.update() 刷镜像层 +
 *     派发 promptNodeTextChanged（detail {node, text}，用户输入同款联动）；
 *   - 面板框折叠时自动展开（posPrompt1/2Wrap + Toggle），写入结果可见。
 *
 * 交互：attachDropdown 把宿主按钮变成动作型下拉（LumenDropdown actionMenu，
 * 坐标编辑器「写入▾」同款）——每次展开菜单前实时枚举画布节点，点目标即写，
 * 结果经 onResult 回调（宿主做变绿/提示）与 socket 通知。
 *
 * 已有同能力实现（本期不迁移，仅登记来源；将来收编以本预制件为准）：
 *   CoordinateEditor._refreshSendTargets/_sendToPanel（ADR 017，面板框
 *   派发 input 属旧约定）/ ComfyPromptPresets 一键注入（ADR 037）/
 *   LoraTriggerManager 写入目标（ADR 031）。
 * ==========================================================================
 */
class PromptWriteTargets {
    constructor() {
        // 临时键 -> 画布提示词节点对象（坐标编辑器同款：value 用临时键映射
        // 节点对象，避免依赖节点 id 字段；每次枚举重建）
        this._nodeMap = {};
        this._seq = 0;
        this._label = '写入';
        this.dd = null;   // attachDropdown 建好的 LumenDropdown 实例
    }

    /** 画布提示词节点实时枚举（inputEl 存在才可写；无画布返回空） */
    collectCanvasNodes() {
        const canvas = window.canvas;
        const nodes = [];
        if (!canvas) return nodes;
        for (const img of canvas.images.images) {
            if (img?.source !== NodeTypes.SOURCE.PROMPT_NODE) continue;
            if (!img.inputEl) continue;
            nodes.push(img);
        }
        return nodes;
    }

    /**
     * 目标清单（每次展开菜单前现调，画布节点按当下状态）：
     * @returns {Array<{value: string, label: string}>}
     */
    enumerateTargets() {
        const opts = [];
        for (const node of this.collectCanvasNodes()) {
            const key = 'n' + (this._seq++);
            this._nodeMap[key] = node;
            const title = (typeof node.getTitle === 'function' && node.getTitle()) || '提示词节点';
            opts.push({ value: key, label: '画布节点 · ' + title });
        }
        opts.push({ value: 'panel1', label: 'Comfy 正向框 1（右侧面板）' });
        opts.push({ value: 'panel2', label: 'Comfy 正向框 2（右侧面板）' });
        return opts;
    }

    /**
     * 覆盖写入一个目标
     * @param {string} targetValue - enumerateTargets() 返回的 value
     * @param {string} text - 要写入的提示词
     * @returns {{ ok: boolean, message: string }}
     */
    write(targetValue, text) {
        if (targetValue === 'panel1' || targetValue === 'panel2') {
            return this._writePanel(targetValue, text);
        }
        return this._writeNode(this._nodeMap[targetValue], text);
    }

    /** 面板正向框：覆盖赋值 + 折叠自动展开；不派发合成 input（ADR 037） */
    _writePanel(value, text) {
        const slotId = value === 'panel2' ? 'posPrompt2' : 'posPrompt';
        const seq = value === 'panel2' ? '2' : '1';
        const name = `正向框 ${seq}`;
        const el = document.getElementById(slotId);
        if (!el) return { ok: false, message: `未找到 Comfy ${name}输入框` };
        el.value = text;
        const wrap = document.getElementById(`posPrompt${seq}Wrap`);
        if (wrap?.classList.contains('collapsed')) {
            document.getElementById(`posPrompt${seq}Toggle`)?.click();
        }
        return { ok: true, message: `已写入 Comfy ${name}` };
    }

    /** 画布提示词节点：覆盖赋值 + 镜像层刷新 + 变更事件；不派发合成 input（ADR 031） */
    _writeNode(node, text) {
        if (!node?.inputEl) return { ok: false, message: '画布节点已不可写（可能已被删除）' };
        const ta = node.inputEl;
        ta.value = text;
        node.text = text;
        if (node.mirrorLayer) node.mirrorLayer.update();
        window.dispatchEvent(new CustomEvent('promptNodeTextChanged', {
            detail: { node, text }
        }));
        const title = (typeof node.getTitle === 'function' && node.getTitle()) || '提示词节点';
        return { ok: true, message: `已写入画布节点 ${title}` };
    }

    /**
     * 把宿主按钮变成「写入」动作下拉：点击展开目标菜单（展开前实时枚举），
     * 点目标即取 getText() 内容覆盖写入。按钮同时成为 LumenDropdown 触发器
     * （文案由下拉管理，宿主反馈只切样式类，不改 textContent）。
     * @param {HTMLElement} btn - 触发按钮
     * @param {Object} [options]
     * @param {Function} [options.getText] - 点目标时取要写入的文本；
     *        返回空串视为无内容可写（如实回调不写入）
     * @param {Function} [options.onResult] - 写入完成回调 ({ok, message})
     * @param {string} [options.label='写入'] - 触发器静态文案
     * @param {string} [options.menuClass] - 菜单附加样式类（宿主在深层级
     *        弹窗里抬菜单 z-index 的逃生口，如详情弹窗 1500 > 菜单默认 1200）
     * @returns {LumenDropdown}
     */
    attachDropdown(btn, { getText, onResult, label = '写入', menuClass = '' } = {}) {
        this._label = label;
        // 注册顺序（坐标编辑器同款）：先挂自己的 click 刷新再建 LumenDropdown
        // ——同目标监听按注册序触发，保证菜单展开前节点清单已刷新为当下画布
        btn.addEventListener('click', () => this._refresh());
        this.dd = new LumenDropdown(btn, {
            actionMenu: true,
            menuClass,
            placeholder: label,
            onChange: (v) => {
                const text = getText ? getText() : '';
                const res = text
                    ? this.write(v, text)
                    : { ok: false, message: '没有可写入的提示词' };
                if (res.ok) window.socket?.showNotification?.(res.message);
                onResult?.(res);
                this.dd.setLabel(label);   // 文案固定为动作名，不随目标项变
            }
        });
        this._refresh();
        return this.dd;
    }

    /** 重建目标清单并恢复触发器静态文案（菜单展开前与初始化各一次） */
    _refresh() {
        if (!this.dd) return;
        this.dd.setOptions(this.enumerateTargets(), '');
        this.dd.setLabel(this._label);
    }
}

window.PromptWriteTargets = PromptWriteTargets;
