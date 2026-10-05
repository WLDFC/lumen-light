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

/** 生图模型调用超时：API 生图比常规命令慢得多（排队+渲染），放宽到 3 分钟 */
const GEN_TIMEOUT_MS = 180_000;

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

    // ===== 2. 权限分级拦截（级别存于 LumenLight 后端） =====
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
                "canvas_build_graph",
            ]);
            if (isCanvasTool && !MUTATING.has(event.toolName)) return;
            return {
                block: true,
                reason: "当前权限分级为「只读」，已阻止该工具（设置 → 通用 → pi 权限分级）",
            };
        }

        // standard：画布工具放行，内置 bash 等系统级工具阻止
        if (!isCanvasTool && event.toolName === "bash") {
            return {
                block: true,
                reason: "当前权限分级为「标准」，bash 已禁用（设置 → 通用 → pi 权限分级）",
            };
        }
    });

    // ===== 3. 画布工具 =====
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

    // 调用 API 生图模型（LLM 面板生图通道，与 canvas_run_comfy 的工作流通道平行）
    pi.registerTool({
        name: "canvas_run_llm_image",
        label: "Run LLM Image",
        description:
            "用 API 生图模型（如 gpt-image-2.5-flare、豆包 seedream 系）生成图片，" +
            "生成结果自动放置到画布。与 canvas_run_comfy（ComfyUI 工作流）是平行通道：" +
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
            // 后端收到参考图后按模型家族自动选 edits/chat/generations 适配器
            const images = await resolveRefImages(params.refImages || []);
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
                signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
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
                const imgRes = await fetch(dataUrl, { signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS) });
                if (!imgRes.ok) throw new Error(`生成图下载失败（HTTP ${imgRes.status}）`);
                const mime = imgRes.headers.get("content-type") || "image/png";
                const buf = Buffer.from(await imgRes.arrayBuffer());
                dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
            }
            // 落图是写操作：走串行链，避免与其它写工具并发冲击浏览器
            return serialized(async () => {
                const dropped = (await bridge("drop_image", { dataUrl })) as { id: string; name: string };
                return text(`模型 ${params.model} 生图完成，已放置画布「${dropped.name}」（id: ${dropped.id}）`);
            });
        },
    });
}
