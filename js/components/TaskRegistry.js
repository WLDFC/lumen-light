/**
 * ==========================================================================
 * LumenLight 任务中心注册表（TaskRegistry）
 * ==========================================================================
 * 作用：全项目统一的生成任务序列登记表——画布三条生图链路（API 节点/
 *       Comfy 节点/RunningHub 节点）、Comfy 面板运行、高清放大在各自
 *       生成流程的开始/结算处薄登记，任务中心窗口（TaskCenter）只是
 *       本注册表的纯视图。设计约定：
 *   - 一轮生成 = 一个任务：批量 N 张共享一个条目，进度随完成数推进；
 *   - 状态机：running → done | failed | stopped。done/stopped 中性
 *     （停留数秒变灰后自动移除），failed 驻留列表直到用户清除——
 *     标红等用户看到（任务中心开窗即记为已读、角标熄灭）；
 *   - 停止不另造轮子：登记时挂 onStop（通常是节点 stopControl.abort()），
 *     窗口的 ✕ 与节点 X 调同一内核（两处 UI 一个停止语义）；
 *   - 变更经 window 事件 lumen-tasks-changed 广播，视图自行订阅重渲，
 *     角标读 runningCount/unseenFailures 两个查询。
 * 本类是纯数据层（无 DOM 依赖），文件尾部自实例化为 window.taskRegistry，
 * 各任务源直接取用（TaskCenter 未初始化/未来其他宿主也照常工作）。
 * ==========================================================================
 */

class TaskRegistry {
    /** done/stopped 结算后自动移除前的变灰停留时长 */
    static SETTLED_TTL_MS = 6000;
    /** 登记表容量上限：超出时优先丢最早的已结算条目，没有才丢最早 */
    static MAX_TASKS = 60;

    constructor() {
        this.tasks = [];            // 登记序即任务序列（视图按此展示）
        this._seq = 0;
        this._timers = new Map();   // id -> 自动移除计时器（dismiss/清空时撤销）
    }

    /**
     * 登记一个任务（各生成流程开始处调用；外部镜像任务传 id/startedAt）
     * @param {Object} opts
     * @param {string} [opts.id] - 外部指定 id（pi 后台任务镜像用，防与本地序号冲突；
     *                             缺省自增序号）
     * @param {string} opts.kind - 任务类型（api/comfy/rh/panel/upscale/pi-*，
     *                             图标与展示名由视图定义）
     * @param {string} [opts.label] - 任务标签（通常是提示词，过长由视图截断）
     * @param {number} [opts.total] - 批量总数（N 张共享一个任务时填 N）
     * @param {Function} [opts.onStop] - 停止回调（通常是 () => node.stopControl.abort()）
     * @param {Object} [opts.locateTarget] - 定位目标（需含数值 x/y/width/height，
     *                                       通常是节点实例；不合法视图不显示定位钮）
     * @param {number} [opts.startedAt] - 外部起始时刻（镜像任务的原始开始时间）
     * @returns {Object} 任务引用 { id, update, end, isRunning }
     */
    register(opts) {
        const task = {
            id: (typeof opts.id === 'string' && opts.id) || `t${++this._seq}`,
            kind: opts.kind || 'api',
            label: opts.label || '',
            total: Number.isFinite(opts.total) ? opts.total : null,
            done: 0,
            status: 'running',      // running | done | failed | stopped
            note: '',
            startedAt: Number.isFinite(opts.startedAt) ? opts.startedAt : Date.now(),
            endedAt: null,
            onStop: typeof opts.onStop === 'function' ? opts.onStop : null,
            locateTarget: opts.locateTarget || null,
            seen: true              // failed 结算时置 false（未读），开窗标记已读
        };
        this.tasks.push(task);

        // 容量保护：先丢最早的已结算，实在没有才丢最早（含运行中的极端场景）
        while (this.tasks.length > TaskRegistry.MAX_TASKS) {
            const settledIdx = this.tasks.findIndex(t => t.status !== 'running');
            const victimIdx = settledIdx !== -1 ? settledIdx : 0;
            const victim = this.tasks[victimIdx];
            this.tasks.splice(victimIdx, 1);
            this._clearTimer(victim.id);
        }

        this._emit();

        const registry = this;
        return {
            id: task.id,
            /** 推进进度/改标签（结算后调用为无害空操作） */
            update({ done, label } = {}) {
                if (task.status !== 'running') return;
                if (Number.isFinite(done)) task.done = done;
                if (typeof label === 'string' && label) task.label = label;
                registry._emit();
            },
            /**
             * 结算（幂等）：done/stopped 停留 SETTLED_TTL_MS 后自动移除，
             * failed 驻留（seen=false 驱动角标红显）
             * @param {'done'|'failed'|'stopped'} status
             * @param {string} [note] - 结算附注（如「完成 3/4」「失败原因」）
             */
            end(status, note = '') {
                registry._endTask(task, status, note);
            },
            isRunning: () => task.status === 'running'
        };
    }

    // ==================== 查询（视图/角标用） ====================

    list() { return this.tasks; }

    /** 运行中任务数（角标常态显示） */
    runningCount() {
        return this.tasks.filter(t => t.status === 'running').length;
    }

    /** 未读失败数（角标红显，开窗清零） */
    unseenFailures() {
        return this.tasks.filter(t => t.status === 'failed' && !t.seen).length;
    }

    /** 标记全部失败已读（任务中心开窗时调用；已读失败仍驻留列表直到手动清除） */
    markAllSeen() {
        let changed = false;
        for (const t of this.tasks) {
            if (t.status === 'failed' && !t.seen) { t.seen = true; changed = true; }
        }
        if (changed) this._emit();
    }

    /** 手动移除单个条目（失败条目的 ✕） */
    dismiss(id) { this._remove(id); }

    /** 清除全部已结算条目（窗口头部「清除」按钮） */
    clearSettled() {
        const settled = this.tasks.filter(t => t.status !== 'running');
        if (settled.length === 0) return;
        for (const t of settled) this._clearTimer(t.id);
        this.tasks = this.tasks.filter(t => t.status === 'running');
        this._emit();
    }

    // ==================== 外部镜像（pi 后台任务） ====================

    /**
     * 镜像外部任务事件（pi 后台任务经后端 /api/tasks 中继、WS task-event 到达）。
     * running：按 ext.id upsert（不存在则登记，kind 前缀 pi-；存在且仍在运行
     * 则只刷新标签）；已结算：找到运行中的对应条目就地结算（沿用外部 endedAt
     * 保证耗时准确）。未知 id 的结算事件忽略——宁缺勿错（如前端错过登记）。
     * pi 任务无停止/定位句柄，视图自然不显示这两颗钮。
     * @param {Object} ext - { id, kind, label, status, note, startedAt, endedAt }
     */
    mirrorExternal(ext) {
        if (!ext || typeof ext.id !== 'string' || !ext.id ||
            typeof ext.status !== 'string') return;
        const existing = this.tasks.find(t => t.id === ext.id);

        if (ext.status === 'running') {
            if (existing) {
                if (existing.status === 'running' && ext.label && existing.label !== ext.label) {
                    existing.label = ext.label;
                    this._emit();
                }
                return;
            }
            this.register({
                id: ext.id,
                kind: 'pi-' + ext.kind,
                label: ext.label || '',
                startedAt: ext.startedAt
            });
            return;
        }

        if (!existing || existing.status !== 'running') return;
        const status = ext.status === 'done' ? 'done'
            : ext.status === 'stopped' ? 'stopped' : 'failed';
        this._endTask(existing, status, ext.note || '', ext.endedAt);
    }

    // ==================== 内部 ====================

    /**
     * 结算内核（ref.end 与镜像结算共用的唯一入口）：done/stopped 安排
     * TTL 自动移除、failed 置未读；幂等（非运行态直接返回）
     */
    _endTask(task, status, note = '', endedAt) {
        if (task.status !== 'running') return;
        task.status = status;
        task.note = note;
        task.endedAt = Number.isFinite(endedAt) ? endedAt : Date.now();
        if (status === 'done' || status === 'stopped') {
            this._timers.set(task.id, setTimeout(() => {
                this._timers.delete(task.id);
                this._remove(task.id);
            }, TaskRegistry.SETTLED_TTL_MS));
        } else if (status === 'failed') {
            task.seen = false;
        }
        this._emit();
    }

    _remove(id) {
        const idx = this.tasks.findIndex(t => t.id === id);
        if (idx === -1) return;
        this._clearTimer(id);
        this.tasks.splice(idx, 1);
        this._emit();
    }

    _clearTimer(id) {
        const timer = this._timers.get(id);
        if (timer) { clearTimeout(timer); this._timers.delete(id); }
    }

    _emit() {
        window.dispatchEvent(new CustomEvent('lumen-tasks-changed'));
    }
}

// 自实例化单例：任务源（节点/面板/放大）直接经 window.taskRegistry 取用
window.taskRegistry = new TaskRegistry();
