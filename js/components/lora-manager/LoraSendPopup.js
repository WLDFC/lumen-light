/**
 * ==========================================================================
 * LoRA 纸飞机投递弹窗子模块（LoraSendPopup）
 * ==========================================================================
 * 从 LoraManager.js 拆出的投递弹窗：列出画布上所有 LoRA 节点（标题带
 * #NNN 编号）与恒在的「右侧 Comfy 面板」，点击即把该 lora 追加进目标堆栈。
 * 含锚点定位防溢出与点击外部关闭（捕获阶段监听）。
 *
 * 投递名称归一（ADR 028）：目标堆栈的文件清单来自 ComfyUI object_info
 * （面板 modelLists / 节点 loraFiles 同源），而管理器清单以本应用配置的
 * comfy.root/models/loras 为基准扫描——ComfyUI 经 extra_model_paths 等多
 * 根合并加载模型时，同一文件两边清单里的相对路径字符串可能不同，直接投
 * 原值会被判「不在清单」且提交校验失败。resolveForTarget 在投递口把发送
 * 值换算成目标清单认识的形式（精确命中 → 按文件名唯一匹配 → 失败如实
 * 上报），「管理器看得见」与「ComfyUI 认得」自此解耦。
 *
 * 模式：持有宿主（LoraManager 实例）引用读写其状态（_sendPopup/
 * _sendPopupOutside），与 image-studio/ 子模块同款契约。
 * ==========================================================================
 */

class LoraSendPopup {
    /** @param {LoraManager} host - 宿主管理器实例 */
    constructor(host) {
        this.host = host;
    }

    /**
     * 投递名称归一：把管理器扫描路径换算成目标清单认识的 lora_name。
     * @param {string[]} files - 目标清单（ComfyUI object_info 的 loras 枚举）
     * @param {string} path - 管理器扫描出的相对路径（comfy.root/models/loras 基准）
     * @returns {{path: string, resolved: boolean, renamed?: boolean,
     *            reason?: string, candidates?: string[]}}
     *   resolved=true 时 path 即目标清单认识的值；false 时保留原值并带原因
     *   （candidates = 重名歧义的候选完整路径，供日志诊断）
     */
    static resolveForTarget(files, path) {
        if (!path) return { path, resolved: false, reason: '空路径' };
        if (!Array.isArray(files) || files.length === 0) {
            return { path, resolved: false, reason: 'ComfyUI 清单不可用（未连接或未加载）' };
        }
        if (files.includes(path)) return { path, resolved: true };
        // basename 按 / 与 \ 双分隔符切分：部分 Windows 版 ComfyUI 的
        // object_info 枚举返回反斜杠路径（实测 aki v3.2：子文件夹文件
        // 为 anima\xxx.safetensors），与 LumenLight 扫描的正斜杠只差
        // 分隔符——跨分隔符按文件名匹配，命中后换发 ComfyUI 的原生
        // 形态（提交校验按它自家枚举做成员判定，不赌宽容度）
        const baseOf = (p) => p.split(/[\\/]/).pop().toLowerCase();
        const base = baseOf(path);
        const hits = files.filter((f) => baseOf(f) === base);
        if (hits.length === 1) return { path: hits[0], resolved: true, renamed: true };
        if (hits.length > 1) {
            return { path, resolved: false, reason: 'ComfyUI 清单中存在多个同名文件', candidates: hits };
        }
        return { path, resolved: false, reason: 'ComfyUI 清单中未找到该文件' };
    }

    /** 通知（不阻塞投递；socket 不可用时静默降级） */
    static _notify(text) {
        window.socket?.showNotification?.(text, 4000);
    }

    /**
     * 历史条目自动补归一（ADR 028 决策四）：ComfyUI 未就绪期间投递的条目
     * 按原路径入栈（当时清单不可用、无法换名），清单到位后回扫未命中条目，
     * 能按文件名唯一匹配的就地更正为 ComfyUI 认识的路径——页面刷新/清单
     * 重载即自愈，不需要手动删除重投。歧义与真不存在的条目保持原值
     * （显示层照旧标「不在清单」，失败原因可区分）。
     * @param {Array<{file:string}>} entries - 堆栈条目（面板 this.loras /
     *        节点 this.entries，同构 {file,...}），就地修改
     * @param {string[]} files - ComfyUI object_info 的 loras 清单
     * @returns {number} 就地换名的条目数
     */
    static healEntries(entries, files) {
        if (!Array.isArray(entries) || !Array.isArray(files) || files.length === 0) return 0;
        let healed = 0;
        for (const en of entries) {
            if (!en?.file || files.includes(en.file)) continue;
            const r = LoraSendPopup.resolveForTarget(files, en.file);
            if (r.renamed) { en.file = r.path; healed++; }
        }
        return healed;
    }

    /**
     * 打开投递弹窗
     * @param {Object|Object[]} loraOrList - 单只 lora 数据或 lora 数组（批量投递）
     * @param {HTMLElement} anchor - 触发按钮（弹窗定位参照）
     */
    open(loraOrList, anchor) {
        this.close();
        const list = Array.isArray(loraOrList) ? loraOrList : [loraOrList];
        const pop = document.createElement('div');
        pop.className = 'lora-send-popup';

        const head = document.createElement('div');
        head.className = 'lora-send-head';
        head.textContent = list.length > 1
            ? `发送 ${list.length} 只 LoRA 到：`
            : `发送「${list[0]?.name || ''}」到：`;
        pop.appendChild(head);

        /** 汇总一轮投递的归一结果，最多两条通知（换名 / 未匹配）不刷屏 */
        const report = (results) => {
            const renamed = results.filter((r) => r.renamed).length;
            const failed = results.filter((r) => !r.resolved);
            if (renamed > 0) {
                LoraSendPopup._notify(`${renamed} 只 LoRA 已按 ComfyUI 清单换名投递（路径基准不同，按文件名匹配）`);
            }
            if (failed.length > 0) {
                const f = failed[0];
                console.warn('[LoRA投递] 未匹配 ComfyUI 清单:', f.reason, f.candidates || '');
                LoraSendPopup._notify(
                    `${failed.length} 只未匹配 ComfyUI 清单（${f.reason}），已按原路径投递：${f.path.split('/').pop()}`);
            }
        };

        let hasNode = false;
        const canvas = window.canvas;
        if (canvas) {
            for (const img of canvas.images.images) {
                if (img?.source !== NodeTypes.SOURCE.LORA_NODE) continue;
                if (typeof img.addLoraFile !== 'function') continue;
                hasNode = true;
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'lora-send-target';
                b.textContent = img.getTitle();   // 自含 #NNN 编号
                b.addEventListener('click', async () => {
                    // 清单为空先补拉一次：节点清单只在节点创建时拉取，若当时
                    // ComfyUI 未就绪会一直空着——投递不应被这次时机差卡住
                    if (!((img.loraFiles) || []).length &&
                        typeof img.loadLoraFiles === 'function') {
                        await img.loadLoraFiles();
                    }
                    const results = list.map((lora) => {
                        // 节点清单与面板同源（/api/comfy-node/models），
                        // 逐节点用各自的 loraFiles（可能加载时点不同）
                        const r = LoraSendPopup.resolveForTarget(img.loraFiles, lora.path);
                        img.addLoraFile(r.path);
                        return r;
                    });
                    report(results);
                    this.close();
                });
                pop.appendChild(b);
            }
        }

        // Comfy 面板恒在（loraStack 堆栈跨工作流保留）；批量一次渲染
        const panelBtn = document.createElement('button');
        panelBtn.type = 'button';
        panelBtn.className = 'lora-send-target';
        panelBtn.textContent = '右侧 Comfy 面板';
        panelBtn.addEventListener('click', async () => {
            const cp = window.promptPanel?.comfyParams;
            if (cp) {
                // 清单为空先补拉一次：loadModelLists 只在面板初始化时跑一次，
                // 页面加载那一刻 ComfyUI 未就绪的话清单会一直空着——投递时
                // 自愈，不再把「页面先开、ComfyUI 后启动」的时机差留给用户
                if (!((cp.modelLists && cp.modelLists.loras) || []).length &&
                    typeof cp.loadModelLists === 'function') {
                    await cp.loadModelLists();
                }
                const files = (cp.modelLists && cp.modelLists.loras) || [];
                const results = list.map((lora) => {
                    const r = LoraSendPopup.resolveForTarget(files, lora.path);
                    cp.loras.push({
                        id: LumenLight.generateId(),
                        file: r.path,
                        strengthModel: 1,
                        strengthClip: 1
                    });
                    return r;
                });
                cp.render();
                report(results);
            }
            this.close();
        });
        pop.appendChild(panelBtn);

        if (!hasNode) {
            const hint = document.createElement('div');
            hint.className = 'lora-send-hint';
            hint.textContent = '画布上暂无 LoRA 节点（右键画布可新建）';
            pop.appendChild(hint);
        }

        document.body.appendChild(pop);
        // 定位：锚点按钮下方，防溢出视口
        const r = anchor.getBoundingClientRect();
        pop.style.visibility = 'hidden';
        pop.style.display = 'block';
        const top = Math.min(r.bottom + 4, window.innerHeight - pop.offsetHeight - 8);
        const left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8));
        pop.style.top = `${Math.max(8, top)}px`;
        pop.style.left = `${left}px`;
        pop.style.visibility = '';
        this.host._sendPopup = pop;

        // 点击外部关闭（捕获阶段，下一帧起生效避免本次点击立即触发）
        setTimeout(() => {
            this.host._sendPopupOutside = (e) => {
                if (!pop.contains(e.target)) this.close();
            };
            document.addEventListener('mousedown', this.host._sendPopupOutside, true);
        }, 0);
    }

    /** 关闭投递弹窗并清理外部点击监听 */
    close() {
        const host = this.host;
        host._sendPopup?.remove();
        host._sendPopup = null;
        if (host._sendPopupOutside) {
            document.removeEventListener('mousedown', this.host._sendPopupOutside, true);
            host._sendPopupOutside = null;
        }
    }
}

window.LoraSendPopup = LoraSendPopup;
