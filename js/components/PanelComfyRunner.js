/**
 * ==========================================================================
 * LumenLight 面板 ComfyUI 运行器（PanelComfyRunner）
 * ==========================================================================
 * 作用：右侧 Comfy 提示词面板的"发送到 ComfyUI"运行流程。从 PromptPanel
 *       拆出，职责单一：
 *         1. 校验工作流已选择
 *         2. 显示生成占位图 → 上传面板缩略图到槽位（Edit 工作流）
 *         3. 循环提交 /api/comfy-node/run（数量 N = N 个 batch_size=1 的
 *            独立任务，跑完一张回传一张；每次提交后端注入新随机种子，
 *            与画布 Comfy 生图节点同一提交端点；不传 target，生成图经
 *            WebSocket 回流直接落到画布）
 *         4. 运行按钮的三态反馈（运行中/成功/失败）与状态栏提示
 * 依赖全部经构造函数注入（提示词、工作流 id、参数覆盖表、批次数、
 * 状态栏、缩略图上传），本类不持有面板引用，与面板内部实现解耦。
 * ==========================================================================
 */

class PanelComfyRunner {
    /**
     * @param {Object} deps - 依赖注入
     * @param {Function} deps.getPrompts - () => {positive, negative} 面板提示词
     * @param {Function} deps.getWorkflowId - () => 当前工作流 id（未选择时 null）
 * @param {Function} deps.getOverrides - (batchCount) => 参数覆盖表（ComfyParamRows 编译）
 * @param {Function} [deps.getLoras] - () => 生效的叠加 LoRA 条目
 *                                      （ComfyParamRows.getLoras；缺省不传 loras）
 * @param {Function} [deps.getDeletedLoraIds] - () => 已删除的模板内嵌 lora
 *                                      节点 id（ComfyParamRows.getDeletedLoraIds；
 *                                      缺省不传 bypassLoras）
 * @param {Function} deps.getBatchCount - () => 本轮生成数量（工作流含批次输入时为步进器值）
 * @param {Function} deps.updateWorkflowStatus - (message, isError) => void 状态栏提示
 * @param {Function} deps.uploadThumbnails - async () => void 上传缩略图到后端槽位
 * @param {Function} [deps.getNodelessImages] - async () => {images, imageMapping}|null
 *                                      免节点 LoadImage 直注载荷（工作流无画布
 *                                      取图节点时非 null）：非 null 时跳过槽位
 *                                      上传，图片随提交体直注（后端上传 ComfyUI
 *                                      改写 LoadImage）；空槽不出映射条目
 * @param {Function} [deps.getGenInfo] - () => Object|null 本轮生成参数记录
 *                                      （溯源/生成同款，utils/GenRecord.js）——
 *                                      随占位图绑定到回图，GenInfoPopup 展示与回填
 */
    constructor(deps) {
        this.getPrompts = deps.getPrompts;
        this.getWorkflowId = deps.getWorkflowId;
        this.getOverrides = deps.getOverrides;
        this.getLoras = deps.getLoras;
        this.getDeletedLoraIds = deps.getDeletedLoraIds;
        this.getBatchCount = deps.getBatchCount;
        this.updateWorkflowStatus = deps.updateWorkflowStatus;
        this.uploadThumbnails = deps.uploadThumbnails;
        this.getNodelessImages = deps.getNodelessImages || null;
        this.getGenInfo = deps.getGenInfo || null;
        this.button = null;   // 发送按钮（bindButton 绑定）
    }

    /**
     * 绑定发送按钮（按钮文案/禁用态由本类全程管理）
     * @param {HTMLButtonElement} button - "发送到 ComfyUI"按钮
     */
    bindButton(button) {
        this.button = button;
        button.addEventListener('click', () => this.run());
    }

    /**
     * 执行运行流程：校验 → 占位图 → 装载图片输入 → 循环入队 → 按钮反馈。
     * 图片输入按工作流形态分流：无画布取图节点（免节点直注）→ LoadImage
     * 槽位内容随提交体 images+imageMapping 直注，跳过槽位上传；有取图
     * 节点 → 缩略图上传后端槽位（提交体不传 images，后端跳过槽位写入）
     * 提交失败或异常时收回占位图并中止剩余任务；按钮 3 秒后恢复原始状态。
     */
    async run() {
        const prompts = this.getPrompts();
        const workflowId = this.getWorkflowId();
        const count = this.getBatchCount ? this.getBatchCount() : 1;
        const btn = this.button;
        const originalText = btn.textContent;

        // 检查是否有工作流
        if (!workflowId) {
            this.updateWorkflowStatus('请先选择工作流', true);
            return;
        }

        // 大数量确认：N 张 = N 个队列任务，提交前让用户知情
        if (count > 100 &&
            !window.confirm(`即将向 ComfyUI 队列提交 ${count} 个生成任务，确定继续吗？`)) {
            this.updateWorkflowStatus('已取消', true);
            return;
        }

        // 设置按钮为运行中状态
        btn.textContent = count > 1 ? '运行中 0/' + count : '运行中...';
        btn.disabled = true;
        btn.style.background = '#f59e0b';

        let submitted = 0;
        // 任务中心登记：面板一轮提交为一个任务，行内 ✕ 快速取消——中断/
        // 删除已入队的 ComfyUI 任务（与画布 Comfy 节点同一中断端点），
        // 清占位图并按停止收尾。回图直接落画布无定位目标
        const promptIds = [];
        const taskRef = window.taskRegistry?.register({
            kind: 'panel',
            label: prompts.positive || 'Comfy 面板生成',
            total: count,
            onStop: () => {
                if (promptIds.length > 0) {
                    fetch('/api/comfy-node/stop', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ promptIds })
                    }).catch(() => { /* 中断失败不阻断收尾 */ });
                }
                taskRef.end('stopped', '已取消');
                // 传本轮创建的占位图数：提交期间取消时任务尚未挂接，
                // cancelTask 据此从面板 FIFO 尾部清理本轮占位图
                window.generationFeedback?.cancelTask?.(taskRef, count);
            }
        });
        try {
            // 显示生成反馈占位图（数量与任务数一致，跑完一张消费一张）。
            // 本轮生成参数记录（溯源/生成同款）随占位图句柄绑定——每张
            // 占位图独立持有，取消/失败清理天然对齐，不另设队列。
            // 记录是附属功能：构建失败只跳过登记，绝不影响生成主流程
            let genInfo = null;
            try {
                genInfo = this.getGenInfo ? this.getGenInfo() : null;
            } catch (infoErr) {
                console.warn('生成参数记录构建失败（不影响本轮生成）:', infoErr);
            }
            if (window.generationFeedback) {
                window.generationFeedback.show(count, genInfo);
            }

            // 免节点直注优先：工作流无画布取图节点时，LoadImage 直注槽
            // 内容随提交体走（后端上传 ComfyUI 改写节点），不写后端槽位；
            // 有取图节点维持既有槽位上传链路
            const nodeless = this.getNodelessImages ? await this.getNodelessImages() : null;
            if (!nodeless) {
                // 先发送缩略图图片到后端（用于 Edit 工作流）
                await this.uploadThumbnails();

                // 短暂延迟，确保后端图片完全保存
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            // 循环入队 N 个独立任务（每次提交 batch_size=1，
            // ComfyUI 队列按序执行，跑完一张回传一张）
            for (let i = 0; i < count; i++) {
                if (!taskRef.isRunning()) break;   // 行内 ✕ 已取消，停止续投
                btn.textContent = count > 1 ? `运行中 ${i + 1}/${count}` : '运行中...';
                const response = await fetch('/api/comfy-node/run', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        workflowId: workflowId,
                        positive: prompts.positive,
                        negative: prompts.negative,
                        overrides: this.getOverrides(1),
                        // 面板 LoRA 叠加堆栈：后端 injectLoraChain 动态拼链，
                        // 追加在工作流模板 lora 之后（与画布 LoRA 节点同语义）
                        loras: this.getLoras ? this.getLoras() : [],
                        // 已删除的模板内嵌 lora 节点：后端合并进 bypass 清单，
                        // applyBypass 直通重连后剔除（模板 LoRA 从本次提交移除）
                        bypassLoras: this.getDeletedLoraIds ? this.getDeletedLoraIds() : [],
                        // 免节点直注：LoadImage 槽位内容 + 「节点 id → 下标」映射
                        // （空槽不出条目，对应节点保持 ComfyUI 侧已选图）
                        ...(nodeless ? {
                            images: nodeless.images,
                            imageMapping: nodeless.imageMapping
                        } : {})
                    })
                });

                const result = await response.json();
                if (!response.ok || result.status !== 'ok') {
                    throw new Error(result.message || '未知错误');
                }
                submitted++;
                if (result.promptId) promptIds.push(result.promptId);
            }

            // 取消发生在提交期间：任务已按停止收尾（占位图已随 cancelTask
            // 清理），不再挂接，按钮照常走 3 秒恢复
            if (!taskRef.isRunning()) return;

            btn.textContent = count > 1 ? `✓ 已提交 ${count} 个任务` : '✓ 已启动';
            this._attachPanelTask(taskRef, count, null);
            btn.style.background = '#22c55e';
            this.updateWorkflowStatus('工作流运行中...');
        } catch (e) {
            const remaining = count - submitted;
            console.error('❌ 运行失败:', e);
            btn.textContent = '✗ 运行失败';
            btn.style.background = '#ef4444';
            this.updateWorkflowStatus(
                `第 ${submitted + 1} 张提交失败：${e.message}` +
                (remaining > 0 ? `（已中止剩余 ${remaining} 张）` : ''), true);

            // 取消发生在提交失败前：onStop 已按停止收尾（cancelTask 清掉
            // 全部占位图、任务已出列），这里只跳过挂接
            if (taskRef.isRunning()) {
                // 任务中心：有部分入队=按创建的占位图数挂接（随后的 hideExtra
                // 会把预期缩减为实际入队数，回图驱动完成）；全部提交失败=红驻留。
                // 挂接必须先于 hideExtra——尾部多余占位图属于本轮任务
                this._attachPanelTask(taskRef, count, submitted, e);
                const extra = count - submitted;
                if (extra > 0 && window.generationFeedback) {
                    window.generationFeedback.hideExtra(extra);
                }
            }
        }

        // 3秒后恢复按钮原始状态
        setTimeout(() => {
            btn.textContent = originalText;
            btn.disabled = false;
            btn.style.background = '';
        }, 3000);
    }

    /**
     * 任务中心收尾：把任务挂到 GenerationFeedback 的占位图消费上——
     * 回图/视频落定一张推进一张，全部落定由它自动结算为完成，
     * ComfyUI 挂死由其看门狗按失败收尾。提交完成≠生成完成，绝不在此
     * 提前结算。expected 传创建的占位图数（catch 路径随后由 hideExtra
     * 修剪为实际入队数）；全部提交失败（submitted=0）直接红驻留；
     * 无占位图反馈组件可挂时降级为立即结算（避免悬挂）
     * @param {Object} taskRef - 任务引用
     * @param {number} expected - 创建的占位图数
     * @param {number} submitted - 实际入队数量
     * @param {Error|null} err - 提交失败原因
     */
    _attachPanelTask(taskRef, expected, submitted, err) {
        if (!taskRef) return;
        if (submitted === 0) {
            taskRef.end('failed', `提交失败：${err ? err.message : '未知错误'}`);
            return;
        }
        if (window.generationFeedback?.attachTask) {
            window.generationFeedback.attachTask(taskRef, expected);
            return;
        }
        // 降级：没有占位图消费信号可依赖，按提交结果立即结算
        taskRef.end('done', `已入队 ${submitted}`);
    }
}

// 将 PanelComfyRunner 类暴露到全局作用域
window.PanelComfyRunner = PanelComfyRunner;
