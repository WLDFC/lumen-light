/**
 * ==========================================================================
 * LumenLight Comfy 原生工具扩展（lumen-comfy）
 * ==========================================================================
 * comfy-mcp MCP 服务器（comfy-cli 封装，venv 不可随包分发）退役后的原生
 * 替代：精选的 18 个工具注册为 pi 原生工具（comfy_mcp_* 前缀，命名与上游
 * comfy-mcp v0.10.0 一一对应，便于日后 MCP 更新时对照升级），经本地后端
 * /api/comfy-tools/* 执行——后端直连 ComfyUI HTTP API / ComfyUI Manager
 * / 模板画廊（GitHub），零 venv 零 spawn，随发行包解压即用。
 *
 * 与上游 comfy-mcp 的差异：
 *   - 只收录精选清单（生成运行类已由 canvas_run_comfy 覆盖、partner 云端
 *     付费类与 ComfyUI 生命周期管理类未收录）；
 *   - 槽位地址语义对齐 comfy-cli（节点id.输入名 / 唯一标题slug.输入名），
 *     同时支持 UI 格式与 API 格式工作流（UI 格式提交前自动转 API）；
 *   - install_node 走 ComfyUI Manager API（未装 Manager 时报错），
 *     不再依赖 comfy-cli。
 *
 * 权限分级（设置 → 通用）：
 *   - 只读：仅放行无副作用的查询类工具（本文件 READ_ONLY_TOOLS）；
 *   - 标准：全部放行，install_node 除外；
 *   - 完整：全部放行（install_node 会安装第三方节点包代码）。
 *
 * 安装：随项目 pi-extensions/ 分发，由后端拉起 pi 前自动差量同步到
 * ~/.pi/agent/extensions/（见 utils/piExtensionSync.js）。前提：LumenLight
 * 后端运行中（localhost:8080）；本地 ComfyUI 在线（多数工具需要）。
 * ==========================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const LUMEN_BASE = "http://localhost:8080";
const COMFY_TOOLS = LUMEN_BASE + "/api/comfy-tools";

/** 普通查询类工具超时 */
const QUERY_TIMEOUT_MS = 40_000;
/** 提交/等待类工具超时（后端 wait 轮询最长 10 分钟级） */
const RUN_TIMEOUT_MS = 11 * 60_000;
/** 模型下载等待类超时 */
const DOWNLOAD_TIMEOUT_MS = 61 * 60_000;

/** 统一调用后端 comfy-tools 端点，返回 data 字段 */
async function comfyApi(path: string, body?: Record<string, unknown>, timeoutMs = QUERY_TIMEOUT_MS): Promise<unknown> {
    const res = await fetch(COMFY_TOOLS + path, {
        method: body !== undefined ? "POST" : "GET",
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => null)) as { status?: string; data?: unknown; message?: string } | null;
    if (!res.ok || !json || json.status !== "ok") {
        throw new Error(json?.message || `comfy-tools 调用失败（HTTP ${res.status}）`);
    }
    return json.data;
}

/** 工具结果的文本包装（约定契约：content 数组，裸字符串=空输出） */
function text(t: string) {
    return { content: [{ type: "text" as const, text: t }] };
}

/** 执行并序列化结果（所有工具共用） */
async function run(p: string, body: Record<string, unknown> | undefined, timeoutMs: number) {
    const data = await comfyApi(p, body, timeoutMs);
    return text(typeof data === "string" ? data : JSON.stringify(data, null, 1));
}

/** 只读工具清单（「只读」分级下唯一放行的 comfy_mcp_* 子集） */
const READ_ONLY_TOOLS = new Set([
    "comfy_mcp_system_stats",
    "comfy_mcp_nodes",
    "comfy_mcp_search_models",
    "comfy_mcp_search_templates",
    "comfy_mcp_list_workflow_slots",
    "comfy_mcp_workflow_deps",
    "comfy_mcp_get_logs",
]);

export default async function (pi: ExtensionAPI) {
    // ===== 权限分级拦截（级别存于 LumenLight 后端，与画布工具同源） =====
    pi.on("tool_call", async (event) => {
        if (!event.toolName.startsWith("comfy_mcp_")) return;
        let level = "standard";
        try {
            const res = await fetch(LUMEN_BASE + "/api/pi/permission", { signal: AbortSignal.timeout(5000) });
            const json = await res.json();
            if (json.status === "ok") level = json.level || "standard";
        } catch { /* 后端不可达时按 standard 处理 */ }

        if (level === "full") return;
        if (level === "readonly" && !READ_ONLY_TOOLS.has(event.toolName)) {
            return {
                block: true,
                reason: "当前权限分级为「只读」，已阻止该工具（设置 → 通用 → pi 权限分级）",
            };
        }
        // 安装第三方节点包 = 运行外部代码，完整分级才放行
        if (event.toolName === "comfy_mcp_install_node") {
            return {
                block: true,
                reason: "comfy_mcp_install_node 需要权限分级为「完整」（安装节点包会运行第三方代码）",
            };
        }
    });

    // ==================== 状态与任务 ====================

    pi.registerTool({
        name: "comfy_mcp_system_stats",
        label: "Comfy Status",
        description:
            "读取本地 ComfyUI 的实时状态：VRAM/系统内存占用（按设备）、ComfyUI 版本、" +
            "队列概要。诊断显存不足、确认 ComfyUI 是否在线时先调它。",
        parameters: Type.Object({}),
        async execute() {
            return run("/system-stats", undefined, QUERY_TIMEOUT_MS);
        },
    });

    pi.registerTool({
        name: "comfy_mcp_free_memory",
        label: "Comfy Free Memory",
        description:
            "让本地 ComfyUI 卸载已加载的模型并重置执行器缓存，释放显存。" +
            "跑大模型前显存吃紧、或 ComfyUI 报 OOM 时使用；生成进行中调用会中断执行。",
        parameters: Type.Object({
            unload_models: Type.Optional(Type.Boolean({ description: "是否卸载模型（默认 true）" })),
            free_memory: Type.Optional(Type.Boolean({ description: "是否重置执行器缓存（默认 true）" })),
        }),
        async execute(toolCallId, params) {
            return run("/free-memory", params as Record<string, unknown>, QUERY_TIMEOUT_MS);
        },
    });

    pi.registerTool({
        name: "comfy_mcp_job",
        label: "Comfy Job",
        description:
            "检查/等待/取消 ComfyUI 的生成任务。action=status 列出正在执行与排队中的任务" +
            "（含 prompt_id）；action=wait 等指定任务完成（超时返回）；" +
            "action=cancel 取消任务（正在执行的中断、排队中的移除；不带 prompt_id 时" +
            "中断当前执行）。",
        parameters: Type.Object({
            action: Type.Union([
                Type.Literal("status"), Type.Literal("wait"), Type.Literal("cancel"),
            ], { description: "status=查队列 / wait=等完成 / cancel=取消" }),
            prompt_id: Type.Optional(Type.String({ description: "目标任务 id（wait/cancel 必需，cancel 缺省=中断当前执行）" })),
            timeout_seconds: Type.Optional(Type.Number({ description: "wait 的等待上限秒数（默认 120）" })),
        }),
        async execute(toolCallId, params) {
            return run("/job", params as Record<string, unknown>, RUN_TIMEOUT_MS);
        },
    });

    pi.registerTool({
        name: "comfy_mcp_fetch_outputs",
        label: "Fetch Outputs",
        description:
            "按 prompt_id 取回一个已完成任务的输出文件清单（含可直接下载的 /view URL）。" +
            "inline_images=true 时前几张图以 base64 内联返回（多模态模型可直接查看）；" +
            "out_dir 指定本机目录时把文件下载落盘。用于取回 ComfyUI 网页端手动跑的图、" +
            "或把生成结果拿到画布（配合 canvas_drop_image）。",
        parameters: Type.Object({
            prompt_id: Type.String({ description: "任务 id（job status 可查）" }),
            out_dir: Type.Optional(Type.String({ description: "落盘目录（绝对路径或相对 ComfyUI 根目录）；不传则只返回清单" })),
            inline_images: Type.Optional(Type.Boolean({ description: "是否内联返回图片 base64（默认 false）" })),
            max_inline: Type.Optional(Type.Number({ description: "内联张数上限（默认 4，最多 8）" })),
        }),
        async execute(toolCallId, params) {
            return run("/fetch-outputs", params as Record<string, unknown>, 3 * 60_000);
        },
    });

    // ==================== 工作流执行与槽位 ====================

    pi.registerTool({
        name: "comfy_mcp_run_workflow",
        label: "Run Workflow",
        description:
            "在本机 ComfyUI 上执行一个工作流 JSON 文件（路径任意，不限于项目工作流库；" +
            "项目库内的工作流用 canvas_run_comfy）。UI 格式自动转 API 格式后提交；" +
            "overrides 可按槽位地址（节点id.输入名，如 \"6.text\"）临时改值。" +
            "wait=true 时等待完成（默认只返回 prompt_id，用 comfy_mcp_job 查询）。",
        parameters: Type.Object({
            workflow_path: Type.String({ description: "工作流 JSON 路径（绝对路径，或相对 ComfyUI 根目录）" }),
            overrides: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "槽位覆盖 { 地址: 新值 }" })),
            wait: Type.Optional(Type.Boolean({ description: "是否等待完成（默认 false）" })),
            timeout_seconds: Type.Optional(Type.Number({ description: "等待上限秒数（默认 120）" })),
        }),
        async execute(toolCallId, params) {
            return run("/run-workflow", params as Record<string, unknown>, RUN_TIMEOUT_MS);
        },
    });

    pi.registerTool({
        name: "comfy_mcp_list_workflow_slots",
        label: "Workflow Slots",
        description:
            "列出工作流的全部可调槽位（控件输入：提示词/种子/尺寸/模型文件等）——" +
            "地址、类型与当前值。UI 格式与 API 格式都支持。先扫描再决定改哪些，" +
            "配合 comfy_mcp_set_workflow_slot 使用。",
        parameters: Type.Object({
            workflow_path: Type.String({ description: "工作流 JSON 路径（绝对路径，或相对 ComfyUI 根目录）" }),
        }),
        async execute(toolCallId, params) {
            return run("/list-workflow-slots", params as Record<string, unknown>, QUERY_TIMEOUT_MS);
        },
    });

    pi.registerTool({
        name: "comfy_mcp_set_workflow_slot",
        label: "Set Workflow Slot",
        description:
            "按槽位地址批量改写工作流文件里的控件值（原文件写回；stdout=true 时只返回" +
            "改后的 JSON 不落盘）。地址：节点id.输入名（\"6.text\"）或唯一标题 slug" +
            "（\"ksampler.seed\"）。UI/API 两种格式都支持。改完可用 " +
            "comfy_mcp_run_workflow 提交。",
        parameters: Type.Object({
            workflow_path: Type.String({ description: "工作流 JSON 路径" }),
            overrides: Type.Record(Type.String(), Type.Unknown(), { description: "{ 槽位地址: 新值 }" }),
            stdout: Type.Optional(Type.Boolean({ description: "true=不写文件，返回改后 JSON（默认 false）" })),
        }),
        async execute(toolCallId, params) {
            return run("/set-workflow-slot", params as Record<string, unknown>, QUERY_TIMEOUT_MS);
        },
    });

    // ==================== 模板画廊 ====================

    pi.registerTool({
        name: "comfy_mcp_search_templates",
        label: "Search Templates",
        description:
            "搜索 ComfyUI 官方工作流模板画廊（约 558 个，GitHub 直连）。可按关键词/" +
            "标签/类型(image|video|audio)/模型名过滤，分页返回。结果里的 name 用于 " +
            "comfy_mcp_fetch_template / comfy_mcp_run_template。",
        parameters: Type.Object({
            query: Type.Optional(Type.String({ description: "关键词（匹配名称/标题/描述）" })),
            tag: Type.Optional(Type.String({ description: "标签精确匹配" })),
            type: Type.Optional(Type.String({ description: "输出类型：image / video / audio" })),
            model: Type.Optional(Type.String({ description: "按模型名过滤（子串）" })),
            limit: Type.Optional(Type.Number({ description: "每页数量（默认 20）" })),
            offset: Type.Optional(Type.Number({ description: "翻页偏移（默认 0）" })),
        }),
        async execute(toolCallId, params) {
            return run("/search-templates", params as Record<string, unknown>, QUERY_TIMEOUT_MS);
        },
    });

    pi.registerTool({
        name: "comfy_mcp_fetch_template",
        label: "Fetch Template",
        description:
            "取回一个画廊模板的可运行工作流 JSON。out_path 指定本机落盘路径（可再经 " +
            "comfy_mcp_set_workflow_slot 改参后 comfy_mcp_run_workflow 提交）；" +
            "不传则 JSON 直接内联返回。注意 OSS 模板需要的模型要本地已装。",
        parameters: Type.Object({
            name: Type.String({ description: "模板 name（comfy_mcp_search_templates 的结果）" }),
            out_path: Type.Optional(Type.String({ description: "落盘路径（绝对路径或相对 ComfyUI 根目录）；不传则内联返回 JSON" })),
        }),
        async execute(toolCallId, params) {
            return run("/fetch-template", params as Record<string, unknown>, QUERY_TIMEOUT_MS);
        },
    });

    pi.registerTool({
        name: "comfy_mcp_run_template",
        label: "Run Template",
        description:
            "取画廊模板 → 填槽 → 直接在本机 ComfyUI 执行一条龙。params 为槽位覆盖" +
            "（地址可先用 comfy_mcp_fetch_template + list_workflow_slots 确认）。" +
            "OSS 模板需要引用的模型本地已装，缺失会以 ComfyUI 校验错误返回。",
        parameters: Type.Object({
            name: Type.String({ description: "模板 name" }),
            params: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "槽位覆盖 { 地址: 新值 }" })),
            wait: Type.Optional(Type.Boolean({ description: "是否等待完成（默认 false）" })),
            timeout_seconds: Type.Optional(Type.Number({ description: "等待上限秒数（默认 120）" })),
        }),
        async execute(toolCallId, params) {
            return run("/run-template", params as Record<string, unknown>, RUN_TIMEOUT_MS);
        },
    });

    // ==================== 节点与模型 ====================

    pi.registerTool({
        name: "comfy_mcp_nodes",
        label: "Comfy Nodes",
        description:
            "查询本机 ComfyUI 的节点类目录。action=search 按关键词搜索可用节点类" +
            "（含输入/输出概要，搭工作流找节点用）；action=inspect 检视单个类的" +
            "完整输入 schema（required/optional、输出类型）。",
        parameters: Type.Object({
            action: Type.Union([Type.Literal("search"), Type.Literal("inspect")], { description: "search=搜节点类 / inspect=看单个类详情" }),
            query: Type.Optional(Type.String({ description: "search 的关键词" })),
            class_type: Type.Optional(Type.String({ description: "inspect 的节点类名" })),
        }),
        async execute(toolCallId, params) {
            return run("/nodes", params as Record<string, unknown>, QUERY_TIMEOUT_MS);
        },
    });

    pi.registerTool({
        name: "comfy_mcp_search_models",
        label: "Search Models",
        description:
            "列出本机 ComfyUI 可用的模型文件，按类别聚合（checkpoints/loras/vae/unets/" +
            "controlnet/upscale_models 等）。query 子串过滤；category 限定类别。" +
            "回答「有哪些模型可用」「某个 LoRA 装没装」用。",
        parameters: Type.Object({
            query: Type.Optional(Type.String({ description: "文件名子串过滤" })),
            category: Type.Optional(Type.String({ description: "限定类别（如 checkpoints / loras）" })),
        }),
        async execute(toolCallId, params) {
            return run("/search-models", params as Record<string, unknown>, QUERY_TIMEOUT_MS);
        },
    });

    pi.registerTool({
        name: "comfy_mcp_download_model",
        label: "Download Model",
        description:
            "按 URL 下载模型文件到本机 ComfyUI 的 models 子目录（需已在 设置 → 通用 " +
            "配置 ComfyUI 根目录）。wait=true 时等待完成；否则立即返回 downloadId，" +
            "用 comfy_mcp_download 查进度/取消。大文件（几 GB 级）建议 wait=false。",
        parameters: Type.Object({
            url: Type.String({ description: "模型文件直链" }),
            relative_path: Type.Optional(Type.String({ description: "落盘子目录（相对 ComfyUI 根目录，默认 models/checkpoints）" })),
            filename: Type.Optional(Type.String({ description: "保存文件名（缺省取 URL 文件名）" })),
            wait: Type.Optional(Type.Boolean({ description: "是否等待完成（默认 false）" })),
            timeout_seconds: Type.Optional(Type.Number({ description: "wait 的等待上限秒数（默认 600）" })),
        }),
        async execute(toolCallId, params) {
            return run("/download-model", params as Record<string, unknown>, DOWNLOAD_TIMEOUT_MS);
        },
    });

    pi.registerTool({
        name: "comfy_mcp_download",
        label: "Download Status",
        description:
            "查询/取消 comfy_mcp_download_model 启动的下载任务（不发起下载）。" +
            "action=status 返回进度百分比与已收字节；action=cancel 中止下载并清理半成品。",
        parameters: Type.Object({
            action: Type.Union([Type.Literal("status"), Type.Literal("cancel")], { description: "status=查进度 / cancel=取消" }),
            download_id: Type.String({ description: "下载任务 id" }),
        }),
        async execute(toolCallId, params) {
            return run("/download", params as Record<string, unknown>, QUERY_TIMEOUT_MS);
        },
    });

    pi.registerTool({
        name: "comfy_mcp_upload_file",
        label: "Upload File",
        description:
            "把本机文件上传进 ComfyUI 的 input 目录（供工作流 LoadImage 等节点引用；" +
            "画布槽位图不走这里——那是 canvas 工具的事）。返回上传后的 name/subfolder。",
        parameters: Type.Object({
            paths: Type.Array(Type.String(), { description: "本机文件路径数组（最多 10 个）" }),
        }),
        async execute(toolCallId, params) {
            return run("/upload-file", params as Record<string, unknown>, 90_000);
        },
    });

    // ==================== 节点包与诊断 ====================

    pi.registerTool({
        name: "comfy_mcp_install_node",
        label: "Install Node Pack",
        description:
            "安装自定义节点包到本机 ComfyUI（经 ComfyUI Manager 执行，未装 Manager 时" +
            "报错）。安装第三方代码，需要权限分级「完整」；部分包安装后需重启 ComfyUI " +
            "生效。name 用 Manager 里的包名（如 ComfyUI-GGUF）。",
        parameters: Type.Object({
            names: Type.Array(Type.String(), { description: "节点包名数组" }),
        }),
        async execute(toolCallId, params) {
            return run("/install-node", params as Record<string, unknown>, 5 * 60_000);
        },
    });

    pi.registerTool({
        name: "comfy_mcp_workflow_deps",
        label: "Workflow Deps",
        description:
            "分析工作流的节点依赖：列出用到的节点类、本地缺失的类，以及（装了 " +
            "ComfyUI Manager 时）可提供缺失类的节点包——「这工作流还差什么」一查便知，" +
            "接 comfy_mcp_install_node 安装。",
        parameters: Type.Object({
            workflow_path: Type.String({ description: "工作流 JSON 路径" }),
        }),
        async execute(toolCallId, params) {
            return run("/workflow-deps", params as Record<string, unknown>, QUERY_TIMEOUT_MS);
        },
    });

    pi.registerTool({
        name: "comfy_mcp_get_logs",
        label: "Comfy Logs",
        description:
            "读取本地 ComfyUI 最近的控制台日志（经 /internal/logs）。报错定位、" +
            "确认加载了哪些模型/自定义节点时用。ComfyUI 版本过旧无此接口时按提示" +
            "直接看控制台窗口。",
        parameters: Type.Object({
            tail: Type.Optional(Type.Number({ description: "取最近 N 行（默认 100，上限 1000）" })),
        }),
        async execute(toolCallId, params) {
            const tail = (params as { tail?: number })?.tail ?? 100;
            return run(`/get-logs?tail=${encodeURIComponent(tail)}`, undefined, QUERY_TIMEOUT_MS);
        },
    });
}
