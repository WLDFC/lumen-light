/**
 * ==========================================================================
 * LumenLight pi 扩展：MCP 工具桥（lumen-mcp）
 * ==========================================================================
 * 作用：把 设置 → MCP 里登记的 MCP 服务器能力注册为 pi 的结构化工具，
 *       agent（LLM 窗口智能体模式）即可直接调用：
 *   - 启动时从后端 /api/mcp/tools 拉取清单并注册：
 *       · 工具：mcp__服务器名__工具名（schema 透传 MCP inputSchema）；
 *       · 有资源的服务器：mcp__服务器名__list_resources / __read_resource；
 *       · 有提示词模板的服务器：mcp__服务器名__get_prompt（描述里列出可用模板）；
 *   - 每 60s 轮询一次，新出现的按逻辑身份追加注册（已注册的跳过）；
 *   - execute 一律经后端 /api/mcp/* 代理调用目标 MCP 服务器。
 *
 * 安装：把本文件复制到 ~/.pi/agent/extensions/（与 lumen-guard 同方式），
 * 重启 pi（面板状态灯点击或重启后端）生效。需要 LumenLight 后端已启动。
 *
 * 说明：不从 "@earendil-works/pi-coding-agent" import 类型（同 lumen-guard，
 * 避免路径解析 TS2307），本地最小接口只覆盖用到的面。typebox 由 pi 提供
 * （官方扩展文档的推荐导入）。
 * ==========================================================================
 */
import { Type } from "typebox";

/** /api/mcp/tools 的工具条目 */
interface McpToolDef {
    serverId: string;
    serverName: string;
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

/** /api/mcp/tools 的能力服务器条目 */
interface CapabilityServer {
    serverId: string;
    serverName: string;
    prompts?: Array<{ name: string; description: string }>;
}

/** pi 工具 execute 的返回（与官方扩展文档一致） */
interface PiToolResult {
    content: Array<{ type: string; text: string }>;
    details?: unknown;
}

/** 本扩展用到的 pi ExtensionAPI 最小面 */
interface LumenMcpExtensionAPI {
    registerTool(tool: {
        name: string;
        label?: string;
        description: string;
        parameters: unknown;
        execute(toolCallId: string, params: Record<string, unknown>,
                signal: AbortSignal, onUpdate: (u: unknown) => void, ctx: unknown)
            : Promise<PiToolResult>;
    }): void;
}

/** LumenLight 后端地址（本机固定端口） */
const BACKEND = "http://127.0.0.1:8080";

export default function (pi: LumenMcpExtensionAPI) {
    /** 注册名去重（同名冲突追加 _2、_3…） */
    const registered = new Set<string>();
    /** 逻辑身份去重：`${serverId}:${identity}`（轮询不重复注册同一工具） */
    const registeredKeys = new Set<string>();

    /** 服务器名/工具名 → 合法工具名片段：非 [A-Za-z0-9_] 转下划线并压缩，
     *  全下划线（如纯中文名）回退 "server"，保证 LLM API 的工具名约束 */
    const sanitize = (s: string) => {
        const cleaned = String(s || "")
            .replace(/[^A-Za-z0-9_]/g, "_")
            .replace(/_+/g, "_")
            .replace(/^_+|_+$/g, "");
        return cleaned || "server";
    };

    /** 注册名去重：同名冲突时追加 _2、_3… */
    const uniqueName = (base: string) => {
        let name = base;
        let i = 2;
        while (registered.has(name)) name = `${base}_${i++}`;
        return name;
    };

    /** POST 后端代理接口，返回解析后的 JSON（网络/HTTP 错误抛出） */
    async function postBackend(path: string, body: Record<string, unknown>): Promise<Record<string, any>> {
        const res = await fetch(`${BACKEND}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
        return await res.json();
    }

    /** 后端 JSON → pi 工具结果（text 字段为主文案，isError 加 ❌ 前缀） */
    function toResult(data: Record<string, any>): PiToolResult {
        const text = data && data.text ? data.text : (data && data.message) || "（无输出）";
        return { content: [{ type: "text", text: (data && data.isError ? "❌ " : "") + text }], details: {} };
    }

    const errResult = (msg: string): PiToolResult =>
        ({ content: [{ type: "text", text: "❌ MCP 调用失败：" + msg }], details: {} });

    /** 从后端拉工具/能力清单并注册新增项（已注册的按逻辑身份跳过） */
    async function syncTools(): Promise<void> {
        let tools: McpToolDef[] = [];
        let resourceServers: Array<{ serverId: string; serverName: string }> = [];
        let promptServers: CapabilityServer[] = [];
        try {
            const res = await fetch(`${BACKEND}/api/mcp/tools`);
            const data = await res.json();
            if (data && data.status === "ok") {
                tools = data.tools || [];
                resourceServers = data.resourceServers || [];
                promptServers = data.promptServers || [];
            }
        } catch {
            return;   // 后端未就绪：下个轮询周期再试
        }

        for (const t of tools) {
            const key = `${t.serverId}:${t.name}`;
            if (registeredKeys.has(key)) continue;
            const toolName = uniqueName(`mcp__${sanitize(t.serverName)}__${sanitize(t.name)}`);
            try {
                pi.registerTool({
                    name: toolName,
                    label: t.name,
                    description: `[MCP:${t.serverName}] ${t.description || t.name}`,
                    // MCP inputSchema 是标准 JSON Schema，typebox 原样透传
                    parameters: Type.Unsafe(t.inputSchema || { type: "object", properties: {} }),
                    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<PiToolResult> {
                        try {
                            return toResult(await postBackend("/api/mcp/call", {
                                serverId: t.serverId, tool: t.name, args: params
                            }));
                        } catch (err) {
                            return errResult(err instanceof Error ? err.message : String(err));
                        }
                    }
                });
                registered.add(toolName);
                registeredKeys.add(key);
            } catch {
                // 注册失败：跳过该工具，下个轮询周期再试
            }
        }

        // 资源元工具：有资源的服务器注册 list_resources / read_resource
        for (const rs of resourceServers) {
            const listKey = `${rs.serverId}:__list_resources`;
            const readKey = `${rs.serverId}:__read_resource`;
            const tag = `[MCP:${rs.serverName}]`;
            const prefix = `mcp__${sanitize(rs.serverName)}`;

            if (!registeredKeys.has(listKey)) {
                try {
                    pi.registerTool({
                        name: uniqueName(`${prefix}__list_resources`),
                        label: "列出资源",
                        description: `${tag} 列出该 MCP 服务器提供的资源清单（URI 与名称）`,
                        parameters: Type.Unsafe({ type: "object", properties: {} }),
                        async execute(): Promise<PiToolResult> {
                            try {
                                const data = await postBackend("/api/mcp/resources/list", { serverId: rs.serverId });
                                const list = (data && data.resources) || [];
                                const text = list.length
                                    ? list.map((r: any) => `${r.name || r.uri} — ${r.uri}`).join("\n")
                                    : "（该服务器未提供资源）";
                                return { content: [{ type: "text", text }], details: {} };
                            } catch (err) {
                                return errResult(err instanceof Error ? err.message : String(err));
                            }
                        }
                    });
                    registeredKeys.add(listKey);
                } catch { /* 下轮再试 */ }
            }

            if (!registeredKeys.has(readKey)) {
                try {
                    pi.registerTool({
                        name: uniqueName(`${prefix}__read_resource`),
                        label: "读取资源",
                        description: `${tag} 读取指定 URI 的资源内容（先用 list_resources 查可用 URI）`,
                        parameters: Type.Unsafe({
                            type: "object",
                            properties: { uri: { type: "string", description: "资源 URI" } },
                            required: ["uri"]
                        }),
                        async execute(_toolCallId: string, params: Record<string, unknown>): Promise<PiToolResult> {
                            try {
                                return toResult(await postBackend("/api/mcp/resources/read", {
                                    serverId: rs.serverId, uri: params.uri
                                }));
                            } catch (err) {
                                return errResult(err instanceof Error ? err.message : String(err));
                            }
                        }
                    });
                    registeredKeys.add(readKey);
                } catch { /* 下轮再试 */ }
            }
        }

        // 提示词元工具：有模板的服务器注册 get_prompt（描述里列出可用模板）
        for (const ps of promptServers) {
            const key = `${ps.serverId}:__get_prompt`;
            if (registeredKeys.has(key)) continue;
            try {
                const tag = `[MCP:${ps.serverName}]`;
                pi.registerTool({
                    name: uniqueName(`mcp__${sanitize(ps.serverName)}__get_prompt`),
                    label: "获取提示词模板",
                    description: `${tag} 渲染一个提示词模板。可用模板：` +
                        ps.prompts.map((p) => `${p.name}（${p.description || "无描述"}）`).join("；"),
                    parameters: Type.Unsafe({
                        type: "object",
                        properties: {
                            name: { type: "string", description: "模板名" },
                            args: { type: "object", description: "模板参数（可选）" }
                        },
                        required: ["name"]
                    }),
                    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<PiToolResult> {
                        try {
                            const { name, args } = params as { name: string; args?: Record<string, unknown> };
                            return toResult(await postBackend("/api/mcp/prompt/get", {
                                serverId: ps.serverId, name: name, args: args || {}
                            }));
                        } catch (err) {
                            return errResult(err instanceof Error ? err.message : String(err));
                        }
                    }
                });
                registeredKeys.add(key);
            } catch { /* 下轮再试 */ }
        }
    }

    void syncTools();
    setInterval(() => { void syncTools(); }, 60_000);
}
