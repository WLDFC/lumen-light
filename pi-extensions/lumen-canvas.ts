/**
 * ==========================================================================
 * LumenLight 画布工具扩展（lumen-canvas）
 * ==========================================================================
 * 把 LumenLight 画布能力注册为 pi 的自定义工具（pi.registerTool），
 * 经本地桥接 HTTP API（http://localhost:8080/api/canvas-bridge/command）
 * 驱动浏览器执行真实画布操作。
 *
 * 另外两类职责：
 *   1. provider 注册：从桥接接口读取 LumenLight 面板的模型配置
 *      （data/settings.json），注册为 pi 的 provider（id 前缀 lumen-），
 *      apiKey 经环境变量 LUMEN_KEY_* 引用——pi 由此走 LLM 面板的模型；
 *   2. 权限分级拦截：读取 LumenLight 的权限设置，按级别阻止部分工具
 *      （readonly 只读 / standard 标准屏蔽 bash / full 完整放行）。
 *
 * 安装：本扩展随项目 pi-extensions/ 分发，由后端拉起 pi 前自动差量同步到
 * ~/.pi/agent/extensions/（见 utils/piExtensionSync.js），无需手动复制；
 * 手动方式仍是放入 ~/.pi/agent/extensions/（本文件所在位置）即自动加载。
 * 前提：LumenLight 后端运行中（localhost:8080）且画布页面已打开。
 * ==========================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BRIDGE_URL = "http://localhost:8080/api/canvas-bridge/command";
const LUMEN_BASE = "http://localhost:8080";

/** 单次桥接调用超时：略大于后端 30s 命令超时，保证先拿到后端的明确错误 */
const BRIDGE_TIMEOUT_MS = 35_000;

/**
 * 「只读」分级下放行的 comfy 原生查询工具（lumen-comfy 扩展注册）。
 * 与 lumen-comfy.ts 的 READ_ONLY_TOOLS 保持一致——本扩展的 tool_call
 * 处理器是最外层门禁（会拦掉所有非画布工具），这里不豁免的话
 * comfy 查询类在只读分级下会被误杀
 */
const READONLY_OK = new Set([
    "comfy_mcp_system_stats",
    "comfy_mcp_nodes",
    "comfy_mcp_search_models",
    "comfy_mcp_search_templates",
    "comfy_mcp_list_workflow_slots",
    "comfy_mcp_workflow_deps",
    "comfy_mcp_get_logs",
]);

// ===== 长任务句柄（提交与等待分离）=====
// 生图/视频类工具不再把 agent 回合挂住等结果：提交后立刻返回任务 id，
// 实际生成在后台任务里跑完并自动落画布，模型用 canvas_poll_task 查询。
// 超时只作后台兜底（防悬挂），不再约束回合时长。

/** 后台 API 生图任务超时（此前挂在回合上的 3 分钟上限就此解除） */
const IMG_TASK_TIMEOUT_MS = 10 * 60_000;
/** 视频任务轮询间隔与总超时（视频生成常见 5-15 分钟，上限放宽到 30 分钟） */
const VIDEO_POLL_INTERVAL_MS = 15_000;
const VIDEO_TASK_TIMEOUT_MS = 30 * 60_000;
/** 已完成任务在注册表的保留时长与总量上限（防 Map 无限膨胀） */
const TASK_RETENTION_MS = 30 * 60_000;
const TASK_KEEP = 50;

/**
 * 写操作串行链：模型可能并行发多条破坏性命令（实测一次并行 8 条删除），
 * 突发压力全打在浏览器主线程上且易触发假死。写工具经此链排队执行，
 * 读工具不受影响仍可并行
 */
let mutateChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = mutateChain.then(fn, fn);
    mutateChain = run.catch(() => {});
    return run;
}

/** 调用 LumenLight 画布桥接，返回执行结果 data */
async function bridge(command: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const res = await fetch(BRIDGE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, params }),
        signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.status !== "ok") {
        throw new Error(json?.message || `画布桥接调用失败（HTTP ${res.status}）`);
    }
    return json.data;
}

/** 工具结果的文本包装 */
function text(text: string) {
    return { content: [{ type: "text" as const, text }] };
}

// ===== 后台任务注册表 =====
// 任务状态只存在于本扩展进程内存：pi 重启后任务即失联（poll 报未知 id），
// 属预期行为——后台 fetch/轮询同样随进程消失，不会产生孤儿任务。

type LumenTask = {
    id: string;
    kind: "llm_image" | "video";
    label: string;
    status: "running" | "done" | "error" | "cancelled";
    startedAt: number;
    finishedAt?: number;
    result?: string;
    error?: string;
    promise: Promise<void>;
    /** video 任务轮询所需（model/provider 透传查询接口） */
    meta?: { model: string; provider?: string };
};

const tasks = new Map<string, LumenTask>();
let taskSeq = 0;

// ===== 用户停止信号 =====
// 后端在 /api/pi/abort（用户点停止按钮）时记录 lastAbortAt 时间戳。
// 后台任务提交时快照该值，之后每 5 秒轮询一次 /api/pi/stop-signal：
// 信号晚于快照 = 用户在任务运行期间点了停止 → 本任务 AbortController.abort()。
// 点一次停止，排队消息（clear_queue）与全部后台任务一起清空。
let stopSignalAt = 0;
async function refreshStopSignal(): Promise<void> {
    try {
        const res = await fetch(LUMEN_BASE + "/api/pi/stop-signal", { signal: AbortSignal.timeout(5000) });
        const j = (await res.json().catch(() => null)) as { status?: string; at?: number } | null;
        if (j && j.status === "ok" && typeof j.at === "number") stopSignalAt = j.at;
    } catch { /* 后端不可达：保留旧值，下个周期再试 */ }
}

/** 为后台任务装上停止检查器：每 5s 拉一次停止信号，晚于提交时刻即触发 controller。
 *  返回定时器句柄，任务收尾时必须 clearInterval */
function watchStopSignal(controller: AbortController, submitStopAt: number): ReturnType<typeof setInterval> {
    return setInterval(() => {
        void refreshStopSignal().then(() => {
            if (stopSignalAt > submitStopAt) controller.abort();
        });
    }, 5000);
}

/** 后台任务收尾统一归类：被停止信号取消 → cancelled，其余 → error */
function settleFailure(task: LumenTask, err: unknown, controller?: AbortController) {
    const cancelled = controller?.signal.aborted === true;
    task.status = cancelled ? "cancelled" : "error";
    task.finishedAt = Date.now();
    task.error = cancelled ? "用户已停止" : (err instanceof Error ? err.message : String(err));
}

/** 登记新任务并清理过期/超量旧任务 */
function registerTask(t: LumenTask) {
    const now = Date.now();
    for (const [id, old] of tasks) {
        if (old.status !== "running" && old.finishedAt && now - old.finishedAt > TASK_RETENTION_MS) {
            tasks.delete(id);
        }
    }
    if (tasks.size >= TASK_KEEP) {
        // 超量：优先丢最早的已完成任务，实在没有才丢最早的
        const doneFirst = [...tasks.values()].sort((a, b) => a.startedAt - b.startedAt);
        const victim = doneFirst.find((x) => x.status !== "running") || doneFirst[0];
        if (victim) tasks.delete(victim.id);
    }
    tasks.set(t.id, t);
    return t;
}

/** 任务状态的人读文本（poll 返回值） */
function taskStatusText(t: LumenTask): string {
    const idLine = `任务 ${t.id}（${t.kind === "video" ? "视频生成" : "API 生图"}：${t.label}）`;
    if (t.status === "running") {
        const sec = Math.round((Date.now() - t.startedAt) / 1000);
        return `${idLine}仍在执行，已等待 ${sec} 秒。请隔 30 秒以上再用 canvas_poll_task 查询，不要连续频繁轮询。`;
    }
    if (t.status === "done") return `${idLine}已完成。${t.result || ""}`;
    if (t.status === "cancelled") return `${idLine}已被用户停止。`;
    return `${idLine}失败：${t.error || "未知错误"}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default async function (pi: ExtensionAPI) {
    // ===== 1. 注册 LumenLight 面板的模型为 pi provider =====
    try {
        const res = await fetch(`${LUMEN_BASE}/api/pi/provider-config`);
        const json = await res.json();
        if (json.status === "ok") {
            for (const p of json.data.providers) {
                pi.registerProvider(p.id, {
                    name: p.name,
                    baseUrl: p.baseUrl,
                    apiKey: `$${p.apiKeyEnv}`,
                    api: "openai-completions",
                    models: p.models,
                });
            }
        }
    } catch (err) {
        console.warn("[lumen-canvas] LumenLight provider 注册失败（后端未运行？）:", err);
    }

    // ===== 2. 工具启停联动（面板「工具与技能」勾选） =====
    // 本扩展是工具启停的协调点（setActiveTools 是全量语义，多扩展各自
    // 调用会互相覆盖，故单点执行）：
    //   - 会话启动：把 pi 当前配置的全部扩展工具（含其他扩展注册的）上报
    //     后端注册表，面板「工具」tab 动态展示；
    //   - 启动 + 每回合开始（before_agent_start）：读禁用清单，经
    //     setActiveTools 全量重算（当前激活 - 禁用）——面板里勾掉的工具
    //     下一轮消息即从模型可见清单消失（连同 schema 不占上下文），
    //     无需重启 pi
    // 内置工具全集（pi 按平台注册其一的 shell 工具有两个名字：bash / powershell）
    const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);

    function applyDisabledTools(): void {
        void fetch(`${LUMEN_BASE}/api/pi/disabled-tools`, { signal: AbortSignal.timeout(5000) })
            .then((r) => r.json())
            .then((j: { disabledTools?: string[] }) => {
                const disabled = Array.isArray(j.disabledTools) ? j.disabledTools : [];
                if (disabled.length === 0) return;
                const all = (pi.getAllTools() as { name: string }[]).map((t) => t.name);
                pi.setActiveTools(all.filter((n) => !disabled.includes(n)));
            })
            .catch(() => { /* 后端不可达：跳过本轮应用 */ });
    }

    function reportToolRegistry(): void {
        try {
            const tools = (pi.getAllTools() as { name: string; description?: string }[])
                .filter((t) => !BUILTIN_TOOL_NAMES.has(t.name) && !t.name.startsWith("mcp__"))
                .map((t) => ({
                    name: t.name,
                    label: "",
                    description: (t.description || "").slice(0, 300),
                }));
            void fetch(`${LUMEN_BASE}/api/pi/extension-tools`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ extension: "pi", tools }),
                signal: AbortSignal.timeout(5000),
            }).catch(() => { /* 注册表上报失败不影响工具可用性 */ });
        } catch { /* getAllTools 不可用（旧版 pi）：面板回退到空清单 */ }
    }

    applyDisabledTools();
    pi.on("session_start", () => {
        // 会话启动时全部扩展已注册完毕，此时上报的清单才是全的
        reportToolRegistry();
        applyDisabledTools();
    });
    pi.on("before_agent_start", () => applyDisabledTools());

    // ===== 3. 权限分级拦截（级别存于 LumenLight 后端） =====
    pi.on("tool_call", async (event) => {
        let level = "standard";
        try {
            const res = await fetch(`${LUMEN_BASE}/api/pi/permission`);
            const json = await res.json();
            if (json.status === "ok") level = json.level || "standard";
        } catch { /* 后端不可达时按 standard 处理 */ }

        if (level === "full") return;   // 完整：全部放行

        const isCanvasTool = event.toolName.startsWith("canvas_");

        if (level === "readonly") {
            // 只读：画布查询类放行；落图/删除/跑工作流/搭节点与全部内置工具阻止
            const MUTATING = new Set([
                "canvas_drop_image",
                "canvas_delete_media",
                "canvas_clear_media",
                "canvas_run_comfy",
                "canvas_run_llm_image",
                "canvas_run_video",
                "canvas_build_graph",
            ]);
            if (isCanvasTool && !MUTATING.has(event.toolName)) return;
            // lumen-comfy 的只读查询类工具放行（细粒度门禁由 lumen-comfy
            // 自身的 tool_call 处理器执行：install_node 等仍会被拦）
            if (READONLY_OK.has(event.toolName)) return;
            return {
                block: true,
                reason: "当前权限分级为「只读」，已阻止该工具（设置 → 通用 → pi 权限分级）",
            };
        }

        // standard：画布工具放行，内置 shell 工具阻止（Windows 上 pi 注册的
        // shell 工具名为 powershell 而非 bash，两个名字都要拦）
        if (!isCanvasTool && (event.toolName === "bash" || event.toolName === "powershell")) {
            return {
                block: true,
                reason: "当前权限分级为「标准」，shell 工具（bash/powershell）已禁用（设置 → 通用 → pi 权限分级）",
            };
        }
    });

    // ===== 4. 画布工具 =====
    // 画布状态快照
    pi.registerTool({
        name: "canvas_get_state",
        label: "Canvas State",
        description:
            "获取 LumenLight 画布当前状态。selected 字段是用户当前在画布上选中的" +
            "图片列表（index=清单序号、id、name），空数组表示当前没有选中；" +
            "其余字段：media=图片/视频清单（名称、位置、尺寸）、prompts=正负面提示词、" +
            "viewport=视口、archive=当前存档名。操作画布前先调用它了解现状，" +
            "用户提到「选中的图 / 这张图」时优先读 selected，配合 canvas_get_image 使用。",
        parameters: Type.Object({}),
        async execute() {
            const state = await bridge("get_state");
            return text(JSON.stringify(state, null, 1));
        },
    });

    // 取画布图片（多模态模型可直接查看）
    pi.registerTool({
        name: "canvas_get_image",
        label: "Canvas Image",
        description:
            "取一张画布上的图片，返回 base64 PNG（可直接查看）。" +
            "用 name 指定图片名，或用 index 指定序号（见 canvas_get_state 的清单）；" +
            "都不传时优先返回用户当前选中的图片（canvas_get_state 的 selected），" +
            "没有选中时回落第一张。",
        parameters: Type.Object({
            name: Type.Optional(Type.String({ description: "图片文件名（精确匹配）" })),
            index: Type.Optional(Type.Number({ description: "图片序号（0 起）" })),
        }),
        async execute(toolCallId, params) {
            const data = (await bridge("get_image", params)) as {
                name: string;
                width: number;
                height: number;
                base64: string;
                mediaType: string;
            };
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `图片「${data.name}」 ${data.width}x${data.height}`,
                    },
                    {
                        type: "image" as const,
                        source: {
                            type: "base64" as const,
                            mediaType: data.mediaType,
                            data: data.base64,
                        },
                    },
                ],
            };
        },
    });

    // 落图到画布
    pi.registerTool({
        name: "canvas_drop_image",
        label: "Drop Image",
        description:
            "把一张图片放到 LumenLight 画布上。图片来源二选一：dataUrl 为完整 " +
            "data URL（如 data:image/png;base64,...）；url 为公网图片直链" +
            "（如 web_image_search 返回的原图链接——浏览器经后端代理取图，" +
            "base64 不进会话上下文，推荐用这种方式落搜到的图）。" +
            "x/y 为画布坐标（左上角），不传时落在当前视野中心。",
        parameters: Type.Object({
            dataUrl: Type.Optional(Type.String({ description: "图片的 data URL（与 url 二选一）" })),
            url: Type.Optional(Type.String({ description: "公网图片直链（与 dataUrl 二选一）" })),
            name: Type.Optional(Type.String({ description: "图片名称" })),
            x: Type.Optional(Type.Number({ description: "画布坐标 X（左上角）" })),
            y: Type.Optional(Type.Number({ description: "画布坐标 Y（左上角）" })),
        }),
        async execute(toolCallId, params) {
            return serialized(async () => {
                if (!params.dataUrl && !params.url) {
                    throw new Error("缺少图片来源：dataUrl 与 url 至少提供一个");
                }
                if (params.dataUrl && params.url) {
                    throw new Error("dataUrl 与 url 只能提供一个");
                }
                const result = (await bridge("drop_image", params)) as { id: string; name: string };
                return text(`已放置图片「${result.name}」（id: ${result.id}）`);
            });
        },
    });

    // 读取提示词
    pi.registerTool({
        name: "canvas_get_prompts",
        label: "Canvas Prompts",
        description: "读取 LumenLight 面板里的正面提示词与负面提示词。",
        parameters: Type.Object({}),
        async execute() {
            const prompts = await bridge("get_prompts");
            return text(JSON.stringify(prompts, null, 1));
        },
    });

    // 列出可用工作流
    pi.registerTool({
        name: "canvas_list_workflows",
        label: "List Workflows",
        description: "列出 LumenLight 中可用的 ComfyUI 工作流（id 与名称），供 canvas_run_comfy 使用。",
        parameters: Type.Object({}),
        async execute() {
            const res = await fetch(LUMEN_BASE + "/api/workflows");
            const json = await res.json();
            const list = (json.workflows || []).map((w) => ({ id: w.id, name: w.name }));
            return text(JSON.stringify(list, null, 1));
        },
    });

    // 参考图解析：attachment:N=用户本消息附图（后端按序号供图），
    // 画布名称=画布已有图 → data URL 数组（canvas_run_comfy / canvas_run_llm_image 共用）
    async function resolveRefImages(refs: string[]): Promise<string[]> {
        const images: string[] = [];
        for (const ref of refs) {
            if (ref.startsWith("attachment:")) {
                // 用户附图：按序号引用从后端取（附图只在消息上下文，不在画布上）
                const attRes = await fetch(LUMEN_BASE + "/api/pi/attachments");
                const attJson = (await attRes.json().catch(() => null)) as {
                    attachments?: Array<{ ref: string; dataUrl: string }>;
                } | null;
                const hit = attJson?.attachments?.find((a) => a.ref === ref);
                if (!hit) {
                    throw new Error(
                        `参考图 ${ref} 不存在（本消息共 ${attJson?.attachments?.length || 0} 张附图）`
                    );
                }
                images.push(hit.dataUrl);
            } else {
                const img = (await bridge("get_image", { name: ref })) as {
                    base64: string;
                    mediaType: string;
                };
                images.push(`data:${img.mediaType};base64,${img.base64}`);
            }
        }
        return images;
    }

    // 运行 ComfyUI 工作流
    pi.registerTool({
        name: "canvas_run_comfy",
        label: "Run Comfy Workflow",
        description:
            "运行一个 ComfyUI 工作流生成图片，生成结果会自动回流到画布。" +
            "positive 不传时自动使用画布当前的正面提示词。" +
            "refImages 为参考图数组（按顺序写入画板图片槽位 1-3，工作流内的" +
            "From Canvas (Edit Image) 节点从槽位取图；每次调用都会用本次传入的" +
            "图片覆盖槽位——用户新上传的图每次都必须传入）：每项可以是 " +
            "attachment:N（用户本消息第 N 张附图，用户所发图片必用此项，禁止按画布名猜测）" +
            "或画布图片名（编辑画布已有图）。" +
            "先用 canvas_list_workflows 查看可用工作流。",
        parameters: Type.Object({
            workflowId: Type.String({ description: "工作流 id（来自 canvas_list_workflows）" }),
            positive: Type.Optional(Type.String({ description: "正面提示词（缺省用画布当前值）" })),
            negative: Type.Optional(Type.String({ description: "负面提示词（缺省用画布当前值）" })),
            refImages: Type.Optional(Type.Array(Type.String(), { description: "参考图数组：attachment:N=用户本消息第 N 张附图（用户所发图片必用此项）；画布名称=画布已有图片；按顺序写入槽位 1-3，每次运行都用新图覆盖" })),
        }),
        async execute(toolCallId, params) {
            let positive = params.positive;
            let negative = params.negative;
            if (!positive || !negative) {
                const prompts = (await bridge("get_prompts")) as { positive?: string; negative?: string };
                positive = positive || prompts.positive || "";
                negative = negative || prompts.negative || "";
            }
            if (!positive.trim()) throw new Error("缺少正面提示词（参数与画布中都没有）");
            const images = await resolveRefImages(params.refImages || []);
            const res = await fetch(LUMEN_BASE + "/api/comfy-node/run", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    workflowId: params.workflowId,
                    positive,
                    negative,
                    overrides: {},
                    images: images.length ? images : undefined,
                }),
            });
            const json = (await res.json().catch(() => null)) as { status?: string; promptId?: string; message?: string } | null;
            if (!res.ok || !json || json.status !== "ok") {
                throw new Error(json?.message || `工作流提交失败（HTTP ${res.status}）`);
            }
            const slotNote = images.length
                ? `，参考图已按顺序写入画板槽位 1-${images.length}`
                : "";
            return text(`工作流「${params.workflowId}」已提交（promptId: ${json.promptId}）${slotNote}，生成图将自动回流到画布`);
        },
    });

    // 资产库检索
    pi.registerTool({
        name: "canvas_search_assets",
        label: "Search Assets",
        description:
            "在本地资产库已加载的标签中按关键字检索图片/视频文件名。" +
            "keyword 为名称子串（不区分大小写），不传返回全部（最多 50 条）。",
        parameters: Type.Object({
            keyword: Type.Optional(Type.String({ description: "名称关键字（子串匹配）" })),
        }),
        async execute(toolCallId, params) {
            const data = (await bridge("search_assets", { keyword: params.keyword || "" })) as {
                count: number;
                results: Array<{ tag: string; name: string; type: string }>;
            };
            if (data.count === 0) return text("资产库中没有匹配的文件");
            const lines = data.results.map((r) => `[${r.type}] ${r.name}（标签: ${r.tag}）`);
            const NL = String.fromCharCode(10);
            return text(["共 " + data.count + " 个匹配：", ...lines].join(NL));
        },
    });

    // 多图取用（对比选图）
    pi.registerTool({
        name: "canvas_get_images",
        label: "Canvas Images (Multi)",
        description:
            "一次取多张画布图片（base64 PNG，可直接对比查看）。" +
            "用 names 指定图片名数组；不传时返回前 limit 张（默认 4，上限 8）。" +
            "适合「这几张里哪张最符合提示词」类的对比任务。",
        parameters: Type.Object({
            names: Type.Optional(Type.Array(Type.String(), { description: "图片文件名数组" })),
            limit: Type.Optional(Type.Number({ description: "数量上限（1-8，默认 4）" })),
        }),
        async execute(toolCallId, params) {
            const data = (await bridge("get_images", params)) as {
                images: Array<{ name: string; width: number; height: number; base64: string; mediaType: string }>;
            };
            const content: Array<Record<string, unknown>> = [
                { type: "text" as const, text: `共取回 ${data.images.length} 张图片` },
            ];
            for (const img of data.images) {
                content.push({ type: "text" as const, text: `「${img.name}」 ${img.width}x${img.height}` });
                content.push({
                    type: "image" as const,
                    source: { type: "base64" as const, mediaType: img.mediaType, data: img.base64 },
                });
            }
            return { content };
        },
    });

    // 批量清空画布
    pi.registerTool({
        name: "canvas_clear_media",
        label: "Clear Canvas Media",
        description:
            "清空 LumenLight 画布上的全部图片/视频（一条命令完成，比逐张 " +
            "canvas_delete_media 快得多）。破坏性操作，谨慎使用。" +
            "删除全部或多数对象时必须优先用本工具，不要循环调用 canvas_delete_media。",
        parameters: Type.Object({}),
        async execute() {
            return serialized(async () => {
                const data = (await bridge("clear_media", {})) as { deleted: number };
                return text(`已清空画布，共删除 ${data.deleted} 个对象`);
            });
        },
    });

    // 删除画布对象
    pi.registerTool({
        name: "canvas_delete_media",
        label: "Delete Canvas Media",
        description:
            "从画布删除指定名称的图片/视频（同名全部删除）。破坏性操作，谨慎使用。" +
            "仅用于删除个别对象；删除全部或多数对象时改用 canvas_clear_media。" +
            "本工具内部串行执行，不要并行发多条删除。",
        parameters: Type.Object({
            name: Type.String({ description: "要删除的图片/视频名称" }),
        }),
        async execute(toolCallId, params) {
            return serialized(async () => {
                const data = (await bridge("delete_media", { name: params.name })) as { deleted: number };
                return text(`已删除 ${data.deleted} 个画布对象`);
            });
        },
    });

    // 搭建画布节点工作流（一次性创建节点 + 连线，复用画布右键菜单的节点体系）
    pi.registerTool({
        name: "canvas_build_graph",
        label: "Build Node Graph",
        description:
            "在 LumenLight 画布上一次性创建多个节点并连线，搭出可复用、可手调的节点工作流" +
            "（与画布右键菜单同一套节点体系）。" +
            "连线规则（数据流从左到右，务必遵守）：" +
            "① 提示词节点可以多个串联（prompt→prompt）；" +
            "② LoRA 节点的上游只能是提示词节点或另一个 LoRA 节点（链头必须是提示词），" +
            "且 LoRA 链的末端必须接到生图节点，不能悬空；" +
            "③ 生图节点（image_gen/comfy_gen/runhub_gen）只能作为链的终点，" +
            "左侧只收一条链（对同一生图节点重复连线会替换旧链）；" +
            "④ 画布已有图片可连入提示词节点作为参考图（边端点用 canvas_get_state 的 " +
            "media[].id，可多张并联到同一提示词节点）；" +
            "⑤ text 文本节点是画布备注，不参与任何连线。" +
            "典型完整链：图片 → 提示词 → 提示词* → LoRA* → 生图节点。" +
            "生图节点的提示词来自连入的链，不要试图把提示词直接写在生图节点上；" +
            "comfy_gen 的 workflowId 先用 canvas_list_workflows 查询；" +
            "runhub_gen 的 workflowId（rh: 前缀）与 values 键来自 canvas_get_state / 用户确认。" +
            "坐标 x/y 省略时自动按连线深度分层布局（提示词在左、生图在右）并居中当前视野。" +
            "节点建好后由用户点击生成按钮运行；要直接出图用 canvas_run_comfy / canvas_run_llm_image。" +
            "返回创建清单与失败连线明细（失败原因含规则说明，可据此修正后重试）。",
        parameters: Type.Object({
            nodes: Type.Array(
                Type.Object({
                    id: Type.Optional(Type.String({ description: "引用名（edges 与后续搭建中引用；省略自动编号 n1..nN）" })),
                    type: Type.String({ description: "节点类型: prompt / text / lora / image_gen / comfy_gen / runhub_gen" }),
                    x: Type.Optional(Type.Number({ description: "画布坐标 X（省略则自动布局）" })),
                    y: Type.Optional(Type.Number({ description: "画布坐标 Y（省略则自动布局）" })),
                    text: Type.Optional(Type.String({ description: "prompt / text 节点的文本内容" })),
                    workflowId: Type.Optional(Type.String({ description: "comfy_gen / runhub_gen 的工作流 id" })),
                    model: Type.Optional(Type.String({ description: "image_gen 的生图模型 id" })),
                    ratio: Type.Optional(Type.String({ description: "image_gen 的比例（如 1:1）" })),
                    tier: Type.Optional(Type.String({ description: "image_gen 的分辨率档位（如 2K）" })),
                    quality: Type.Optional(Type.String({ description: "image_gen 的质量档位" })),
                    count: Type.Optional(Type.Number({ description: "生图数量（1-9999）" })),
                    values: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "runhub_gen 登记卡参数值 { [参数键]: 值 }" })),
                    entries: Type.Optional(Type.Array(Type.Object({
                        file: Type.String({ description: "LoRA 文件名" }),
                        strengthModel: Type.Optional(Type.Number({ description: "模型强度（默认 1）" })),
                        strengthClip: Type.Optional(Type.Number({ description: "文本强度（默认 1）" })),
                    }), { description: "lora 节点的 LoRA 条目" })),
                }),
                { description: "要创建的节点数组（单次上限 20 个）" }
            ),
            edges: Type.Optional(Type.Array(
                Type.Object({
                    from: Type.String({ description: "起点：引用名 / 画布节点 id / 画布图片 id（图片只能连入提示词节点作参考图）" }),
                    to: Type.String({ description: "终点：引用名或画布节点 id（提示词/LoRA/生图节点）" }),
                }),
                { description: "连线数组（遵守工具描述顶部的连线规则 ①~⑤）" }
            )),
        }),
        async execute(toolCallId, params) {
            return serialized(async () => {
                const data = (await bridge("build_graph", params)) as {
                    created: Array<{ ref: string; id: string; type: string; x: number; y: number }>;
                    connected: number;
                    failedEdges: Array<{ from: string; to: string; reason: string }>;
                };
                const NL = String.fromCharCode(10);
                const lines = data.created.map(
                    (n) => `-「${n.ref}」${n.type}（id: ${n.id}，位置 ${n.x},${n.y}）`
                );
                let out = `已创建 ${data.created.length} 个节点，连线 ${data.connected} 条`;
                if (data.failedEdges.length) {
                    out += NL + "失败连线：" + data.failedEdges.map((e) => `${e.from}→${e.to}（${e.reason}）`).join("；");
                }
                if (lines.length) out += NL + lines.join(NL);
                return text(out);
            });
        },
    });

    // 调用 API 生图模型（LLM 面板生图通道，与 canvas_run_comfy 的工作流通道平行）。
    // 提交与等待分离：本工具只做参数校验与参考图解析（attachment:N 只在本条
    // 消息上下文有效，必须当场解析成 data URL），实际生成放后台任务，
    // 立刻返回任务 id 供 canvas_poll_task 查询——不再把 agent 回合挂住数分钟
    pi.registerTool({
        name: "canvas_run_llm_image",
        label: "Run LLM Image",
        description:
            "用 API 生图模型（如 gpt-image-2.5-flare、豆包 seedream 系）生成图片，" +
            "异步任务式：立即返回任务 id，生成完成后图片自动放置到画布。" +
            "提交后用 canvas_poll_task 查询进度（建议间隔 30 秒以上，不要连续频繁轮询）。" +
            "与 canvas_run_comfy（ComfyUI 工作流）是平行通道：" +
            "本工具走设置 → API 里配置的 API 生图模型。模型 id 参照设置 → API 中的 image 类模型；" +
            "同一模型 id 配置在多个厂商时，用 provider 指定厂商名。" +
            "传 refImages 时以这些图为参考图做图生图/图像编辑；不传为文生图。每项可以是：" +
            "attachment:N（用户本消息发送的第 N 张附图，1 起；基于用户所发图片的编辑必须用它，禁止按画布名猜测），" +
            "或画布图片名（见 canvas_get_state 清单，仅用于编辑画布上已有的图）。",
        parameters: Type.Object({
            model: Type.String({ description: "生图模型 id（如 gpt-image-2.5-flare）" }),
            prompt: Type.String({ description: "生图提示词" }),
            size: Type.Optional(Type.String({ description: "尺寸（如 1024x1024），不传由后端/模型默认决定" })),
            provider: Type.Optional(Type.String({ description: "厂商名（同一模型 id 存在于多个厂商时必传，如 bearlab.ai）" })),
            refImages: Type.Optional(Type.Array(Type.String(), { description: "参考图数组：attachment:N=用户本消息第 N 张附图（用户所发图片必用此项）；画布名称=画布已有图片；不传为文生图" })),
        }),
        async execute(toolCallId, params) {
            // 参考图（图生图）：attachment:N 或画布名 → data URL；
            // 后端收到参考图后按模型家族自动选 edits/chat/generations 适配器。
            // 必须在提交时当场解析：attachment:N 指向"当前消息"的附图，
            // 拖到后台再取会被下一条用户消息的附图顶掉
            const images = await resolveRefImages(params.refImages || []);
            // 提交前刷新并快照停止信号：之后信号一变即取消本任务
            await refreshStopSignal();
            const submitStopAt = stopSignalAt;
            const controller = new AbortController();
            const taskId = `img_${++taskSeq}`;
            const task = registerTask({
                id: taskId,
                kind: "llm_image",
                label: `${params.model}·${params.prompt.slice(0, 30)}`,
                status: "running",
                startedAt: Date.now(),
                promise: Promise.resolve(),
            });
            // 后台 worker：生图（超时兜底 10 分钟）→ 取回字节 → 串行落画布；
            // 期间每 5s 检查用户停止信号，命中即中断 fetch 并标记取消
            task.promise = (async () => {
                const stopTimer = watchStopSignal(controller, submitStopAt);
                try {
                    const res = await fetch(LUMEN_BASE + "/api/llm/generate-image", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            model: params.model,
                            prompt: params.prompt,
                            size: params.size,
                            provider: params.provider,
                            images,
                        }),
                        signal: AbortSignal.any([AbortSignal.timeout(IMG_TASK_TIMEOUT_MS), controller.signal]),
                    });
                    const json = (await res.json().catch(() => null)) as {
                        status?: string;
                        imageUrl?: string;
                        message?: string;
                    } | null;
                    if (!res.ok || !json || json.status !== "ok" || !json.imageUrl) {
                        throw new Error(json?.message || `生图请求失败（HTTP ${res.status}）`);
                    }
                    // imageUrl 可能是远程 URL 或 data URL；drop_image 只收 data URL，
                    // 远程图需先取回转 base64 再落画布
                    let dataUrl = json.imageUrl;
                    if (!dataUrl.startsWith("data:")) {
                        const imgRes = await fetch(dataUrl, {
                            signal: AbortSignal.any([AbortSignal.timeout(BRIDGE_TIMEOUT_MS), controller.signal]),
                        });
                        if (!imgRes.ok) throw new Error(`生成图下载失败（HTTP ${imgRes.status}）`);
                        const mime = imgRes.headers.get("content-type") || "image/png";
                        const buf = Buffer.from(await imgRes.arrayBuffer());
                        dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
                    }
                    // 落图是写操作：走串行链，避免与其它写工具并发冲击浏览器
                    const dropped = await serialized(async () => {
                        return (await bridge("drop_image", { dataUrl })) as { id: string; name: string };
                    });
                    task.status = "done";
                    task.finishedAt = Date.now();
                    task.result = `模型 ${params.model} 生图完成（耗时 ${Math.round((task.finishedAt - task.startedAt) / 1000)} 秒），已放置画布「${dropped.name}」（id: ${dropped.id}）`;
                } catch (err) {
                    settleFailure(task, err, controller);
                } finally {
                    clearInterval(stopTimer);
                }
            })();
            return text(
                `生图任务已提交（taskId: ${taskId}，模型 ${params.model}）。` +
                `预计 1-5 分钟，完成后图片自动落画布；` +
                `用 canvas_poll_task 查询进度（间隔 30 秒以上），等待期间可先做其他事或结束本轮告知用户稍候。`
            );
        },
    });

    // 长任务进度查询（读操作）：配合 canvas_run_llm_image / canvas_run_video 使用
    pi.registerTool({
        name: "canvas_poll_task",
        label: "Poll Task",
        description:
            "查询后台长任务（API 生图 / 视频生成）的状态与结果。" +
            "taskId 来自提交工具的返回值。waitSeconds 可选（0-30）：等待最多 N 秒" +
            "看任务是否在此期间完成，可减少轮询次数；不传立即返回当前状态。" +
            "轮询间隔建议 30 秒以上；任务完成后产物已自动落画布，无需再取图。" +
            "状态长期不变（如超过 10 分钟无进展）时应告知用户而不是无限轮询。",
        parameters: Type.Object({
            taskId: Type.String({ description: "任务 id（提交工具返回的 taskId）" }),
            waitSeconds: Type.Optional(Type.Number({ description: "最长等待秒数（0-30，默认 0 立即返回）" })),
        }),
        async execute(toolCallId, params) {
            const t = tasks.get(params.taskId);
            if (!t) {
                const known = [...tasks.keys()];
                throw new Error(
                    known.length
                        ? `未知任务 id：${params.taskId}（当前可查：${known.join("、")}）`
                        : `未知任务 id：${params.taskId}（当前没有已登记的任务；pi 重启后任务记录会丢失）`
                );
            }
            const wait = Math.max(0, Math.min(30, params.waitSeconds || 0)) * 1000;
            if (wait > 0 && t.status === "running") {
                await Promise.race([t.promise, sleep(wait)]);
            }
            return text(taskStatusText(t));
        },
    });

    // 视频生成（火山方舟等异步任务式 API）：提交与查询本就是任务制，
    // 这里补齐「轮询 + 完成后自动落画布」的后台闭环，模型只管提交与查询
    pi.registerTool({
        name: "canvas_run_video",
        label: "Run Video Generation",
        description:
            "提交 AI 视频生成任务（设置 → API 里的 video 类模型，火山方舟即梦系等）。" +
            "异步任务式：立即返回任务 id，生成完成后视频自动落画布。" +
            "视频生成通常需要 5-15 分钟，用 canvas_poll_task 查询（间隔 30 秒以上，" +
            "不要连续频繁轮询），等待期间可做其他事或先告知用户稍候。" +
            "prompt 与首帧图片至少提供一个：refImages[0] 作为图生视频首帧" +
            "（attachment:N=用户本消息第 N 张附图，画布名称=画布已有图片）。",
        parameters: Type.Object({
            model: Type.String({ description: "视频模型 id（设置 → API 中的 video 类模型）" }),
            prompt: Type.Optional(Type.String({ description: "视频提示词（与首帧图片至少其一）" })),
            refImages: Type.Optional(Type.Array(Type.String(), { description: "首帧图片（只取第一张）：attachment:N=用户本消息第 N 张附图；画布名称=画布已有图片" })),
            ratio: Type.Optional(Type.String({ description: "宽高比（如 16:9），不传由模型默认" })),
            duration: Type.Optional(Type.Number({ description: "时长（秒）" })),
            provider: Type.Optional(Type.String({ description: "厂商名（同一模型 id 存在于多个厂商时必传）" })),
        }),
        async execute(toolCallId, params) {
            if (!params.prompt && !(params.refImages && params.refImages.length)) {
                throw new Error("视频生成需要提示词或首帧图片至少其一");
            }
            // 首帧必须当场解析（attachment:N 只在本条消息上下文有效）
            let imageUrl: string | undefined;
            if (params.refImages && params.refImages.length) {
                const frames = await resolveRefImages([params.refImages[0]]);
                imageUrl = frames[0];
            }
            const res = await fetch(LUMEN_BASE + "/api/llm/submit-video", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: params.model,
                    prompt: params.prompt,
                    imageUrl,
                    ratio: params.ratio,
                    duration: params.duration,
                    provider: params.provider,
                }),
                signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
            });
            const json = (await res.json().catch(() => null)) as { status?: string; taskId?: string; message?: string } | null;
            if (!res.ok || !json || json.status !== "ok" || !json.taskId) {
                throw new Error(json?.message || `视频任务提交失败（HTTP ${res.status}）`);
            }
            const remoteTaskId = json.taskId;
            // 提交前刷新并快照停止信号；轮询循环每圈检查，命中即跳出并标记取消
            await refreshStopSignal();
            const submitStopAt = stopSignalAt;
            const controller = new AbortController();
            const taskId = `vid_${++taskSeq}`;
            const task = registerTask({
                id: taskId,
                kind: "video",
                label: `${params.model}·${(params.prompt || "图生视频").slice(0, 30)}`,
                status: "running",
                startedAt: Date.now(),
                promise: Promise.resolve(),
                meta: { model: params.model, provider: params.provider },
            });
            // 后台 worker：每 15s 轮询 /api/llm/video-task（成功时后端自动把
            // 视频下载到 data/videos/），完成后 drop_video 落画布；
            // 期间每 5s 检查用户停止信号（取消只停止我们的轮询与落画布，
            // 平台侧任务无法从这里撤销，产物不会回流）
            task.promise = (async () => {
                const stopTimer = watchStopSignal(controller, submitStopAt);
                const query = new URLSearchParams({ model: params.model });
                if (params.provider) query.set("provider", params.provider);
                let consecutiveErrors = 0;
                try {
                    while (Date.now() - task.startedAt < VIDEO_TASK_TIMEOUT_MS) {
                        if (controller.signal.aborted) throw new Error("用户已停止");
                        await sleep(VIDEO_POLL_INTERVAL_MS);
                        if (controller.signal.aborted) throw new Error("用户已停止");
                        let polled: { taskStatus?: string; videoPath?: string; error?: string } | null = null;
                        try {
                            const r = await fetch(
                                `${LUMEN_BASE}/api/llm/video-task/${encodeURIComponent(remoteTaskId)}?${query}`,
                                { signal: AbortSignal.any([AbortSignal.timeout(BRIDGE_TIMEOUT_MS), controller.signal]) }
                            );
                            const j = (await r.json().catch(() => null)) as
                                { status?: string; taskStatus?: string; videoPath?: string; error?: string; message?: string } | null;
                            if (!r.ok || !j || j.status !== "ok") {
                                throw new Error(j?.message || `查询失败（HTTP ${r.status}）`);
                            }
                            polled = j;
                            consecutiveErrors = 0;
                        } catch (err) {
                            if (controller.signal.aborted) throw new Error("用户已停止");
                            // 查询偶发失败（后端重启/网络抖动）容忍连续 5 次，
                            // 全失败才判定任务失联
                            if (++consecutiveErrors >= 5) throw err;
                            continue;
                        }
                        if (polled!.taskStatus === "succeeded" && polled!.videoPath) {
                            let note = "";
                            try {
                                const dropped = await serialized(async () => {
                                    return (await bridge("drop_video", { videoPath: polled!.videoPath })) as
                                        { id: string; name: string };
                                });
                                note = `，已放置画布「${dropped.name}」（id: ${dropped.id}）`;
                            } catch (dropErr) {
                                note = `；视频已保存到 ${polled!.videoPath}，但落画布失败：` +
                                    (dropErr instanceof Error ? dropErr.message : String(dropErr));
                            }
                            task.status = "done";
                            task.finishedAt = Date.now();
                            task.result = `视频生成完成（耗时 ${Math.round((task.finishedAt - task.startedAt) / 1000)} 秒）${note}`;
                            return;
                        }
                        if (polled!.taskStatus !== "queued" && polled!.taskStatus !== "running") {
                            throw new Error(`平台任务状态 ${polled!.taskStatus}${polled!.error ? "：" + polled!.error : ""}`);
                        }
                    }
                    throw new Error(`轮询超时（${VIDEO_TASK_TIMEOUT_MS / 60000} 分钟未完成）`);
                } catch (err) {
                    settleFailure(task, err, controller);
                } finally {
                    clearInterval(stopTimer);
                }
            })();
            return text(
                `视频任务已提交（taskId: ${taskId}，平台任务 ${remoteTaskId}，模型 ${params.model}）。` +
                `通常需要 5-15 分钟，完成后视频自动落画布；` +
                `用 canvas_poll_task 查询进度（间隔 30 秒以上），等待期间可先做其他事或告知用户稍候。`
            );
        },
    });
}
