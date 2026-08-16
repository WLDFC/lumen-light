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
 * @param {Function} deps.getBatchCount - () => 本轮生成数量（工作流含批次输入时为步进器值）
     * @param {Function} deps.updateWorkflowStatus - (message, isError) => void 状态栏提示
     * @param {Function} deps.uploadThumbnails - async () => void 上传缩略图到后端槽位
     */
    constructor(deps) {
        this.getPrompts = deps.getPrompts;
        this.getWorkflowId = deps.getWorkflowId;
        this.getOverrides = deps.getOverrides;
        this.getLoras = deps.getLoras;
        this.getBatchCount = deps.getBatchCount;
        this.updateWorkflowStatus = deps.updateWorkflowStatus;
        this.uploadThumbnails = deps.uploadThumbnails;
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
     * 执行运行流程：校验 → 占位图 → 上传缩略图 → 循环入队 → 按钮反馈。
     * 提交失败或异常时收回占位图并中止剩余任务；按钮 3 秒后恢复原始状态。
     * 不传 images（缩略图已自行上传到槽位），后端检测到 Edit 工作流时
     * 跳过槽位写入，避免清空刚上传的图
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
        try {
            // 显示生成反馈占位图（数量与任务数一致，跑完一张消费一张）
            if (window.generationFeedback) {
                window.generationFeedback.show(count);
            }

            // 先发送缩略图图片到后端（用于 Edit 工作流）
            await this.uploadThumbnails();

            // 短暂延迟，确保后端图片完全保存
            await new Promise(resolve => setTimeout(resolve, 500));

            // 循环入队 N 个独立任务（每次提交 batch_size=1，
            // ComfyUI 队列按序执行，跑完一张回传一张）
            for (let i = 0; i < count; i++) {
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
                        loras: this.getLoras ? this.getLoras() : []
                    })
                });

                const result = await response.json();
                if (!response.ok || result.status !== 'ok') {
                    throw new Error(result.message || '未知错误');
                }
                submitted++;
            }

            btn.textContent = count > 1 ? `✓ 已提交 ${count} 个任务` : '✓ 已启动';
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

            // 提交失败时清掉多余的占位图（未入队的任务不会再回传图片；
            // 已入队任务对应的头部占位图保留给即将回传的图片）
            const extra = count - submitted;
            if (extra > 0 && window.generationFeedback) {
                window.generationFeedback.hideExtra(extra);
            }
        }

        // 3秒后恢复按钮原始状态
        setTimeout(() => {
            btn.textContent = originalText;
            btn.disabled = false;
            btn.style.background = '';
        }, 3000);
    }
}

// 将 PanelComfyRunner 类暴露到全局作用域
window.PanelComfyRunner = PanelComfyRunner;
