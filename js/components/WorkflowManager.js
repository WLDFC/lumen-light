/**
 * ==========================================================================
 * LumenLight 工作流管理组件
 * 作用：管理右侧面板中的 ComfyUI 工作流，包括：
 *       1. 从后端加载工作流列表
 *       2. 渲染工作流下拉选择器
 *       3. 选择工作流并通知外部
 *       4. 更新工作流状态提示
 * 通过 onWorkflowChange 回调通知外部当前选中的工作流发生变化。
 * 注意：编辑框、保存/删除按钮、节点数量与日期已精简，以节省面板空间。
 * ==========================================================================
 */

class WorkflowManager {
    /**
     * 构造函数
     * @param {Function} onWorkflowChange - 工作流切换时的回调函数，参数为 currentWorkflow
     */
    constructor(onWorkflowChange = null) {
        // 工作流切换回调
        this.onWorkflowChange = onWorkflowChange;
        // 从后端加载的工作流列表
        this.workflows = [];
        // 当前选中的工作流详情
        this.currentWorkflow = null;
        // 当前选中工作流的 id（提交 /api/comfy-node/run 用）
        this.currentWorkflowId = null;

        this.init();
    }

    /**
     * 初始化工作流管理
     */
    init() {
        this.initWorkflowManager();
        this.loadWorkflows();
    }

    /**
     * 获取当前选中的工作流
     * @returns {Object|null}
     */
    getCurrentWorkflow() {
        return this.currentWorkflow;
    }

    /**
     * 获取当前选中工作流的 id（未选择时为 null）
     * @returns {string|null}
     */
    getCurrentWorkflowId() {
        return this.currentWorkflowId;
    }

    /**
     * 初始化工作流管理相关的事件监听器
     * 仅保留选择工作流事件
     */
    initWorkflowManager() {
        // 工作流下拉选择器
        const selector = document.getElementById('workflowSelector');

        // 选择工作流事件监听器
        selector?.addEventListener('change', (e) => {
            const workflowId = e.target.value;
            if (workflowId) {
                this.selectWorkflow(workflowId);
            } else {
                // 未选择任何工作流时清空状态
                this.currentWorkflow = null;
                this.currentWorkflowId = null;
                this.updateWorkflowStatus('未加载工作流');
                this.notifyWorkflowChange();
            }
        });
    }

    /**
     * 通知外部工作流选择已变化
     */
    notifyWorkflowChange() {
        if (this.onWorkflowChange) {
            this.onWorkflowChange(this.currentWorkflow);
        }
    }

    /**
     * 从后端加载工作流列表
     * 成功后更新下拉选择器
     */
    async loadWorkflows() {
        try {
            const response = await fetch('http://localhost:8080/api/workflows');
            const data = await response.json();

            if (data.status === 'ok') {
                this.workflows = data.workflows;
                this.updateWorkflowSelector();
            }
        } catch (e) {
            console.error('加载工作流列表失败:', e);
        }
    }

    /**
     * 根据工作流列表更新下拉选择器
     * 保留第一个提示选项，然后动态添加工作流选项
     */
    updateWorkflowSelector() {
        const selector = document.getElementById('workflowSelector');
        if (!selector) return;

        // 保留第一个默认提示选项
        selector.innerHTML = '<option value="">-- 选择工作流 --</option>';

        this.workflows.forEach(wf => {
            const option = document.createElement('option');
            option.value = wf.id;
            option.textContent = wf.name;
            selector.appendChild(option);
        });
    }

    /**
     * 根据工作流 ID 选中并加载工作流详情
     * @param {string} workflowId - 工作流唯一标识
     */
    async selectWorkflow(workflowId) {
        try {
            const response = await fetch(`http://localhost:8080/api/workflows/${workflowId}`);
            const data = await response.json();

            if (data.status === 'ok') {
                this.currentWorkflowId = workflowId;
                this.currentWorkflow = data;
                this.updateWorkflowStatus(`已加载: ${data.name}`);
                this.notifyWorkflowChange();
            }
        } catch (e) {
            console.error('加载工作流失败:', e);
            this.updateWorkflowStatus('加载失败', true);
        }
    }

    /**
     * 更新工作流状态提示文本
     * @param {string} message - 状态信息
     * @param {boolean} isError - 是否为错误状态
     */
    updateWorkflowStatus(message, isError = false) {
        const statusEl = document.getElementById('workflowStatus');
        if (statusEl) {
            statusEl.textContent = message;
            statusEl.className = 'workflow-status ' + (isError ? 'error' : 'success');
        }
    }
}

// 将 WorkflowManager 类暴露到全局作用域
window.WorkflowManager = WorkflowManager;