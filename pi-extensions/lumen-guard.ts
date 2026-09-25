/**
 * LumenLight pi 扩展：项目代码写保护门禁（lumen-guard）
 *
 * 目的：画布里的 pi agent 只允许"读取项目 / 写白名单区 / 写项目外"，
 * 未经用户明确要求不得修改项目源代码。历史上 pi 曾在咨询类对话中
 * 擅自修改 js/api/LumenSocket.js 并新建 tools/agent-upscale.js，
 * 本扩展把"不改项目代码"从提示词软约束升级为工具层硬拦截。
 *
 * 拦截策略（fail-safe：拿不准就拦，错误信息引导 pi 走白名单）：
 *   - edit / write 工具：目标解析后位于项目内且不在白名单区 → 拦截
 *   - bash / powershell 工具：命令含写操作特征（重定向、tee、sed -i、
 *     rm/mv/cp、PowerShell 写命令等）且未显式指向白名单区或系统临时目录
 *     → 拦截
 *   - read / grep / ls 等只读工具与画布桥接工具：不受影响
 *
 * 白名单区：data/pi/workspace/（项目内专供 pi 放临时脚本与产物）
 *          以及系统临时目录（%TEMP%、/tmp 等）。
 *
 * 重要实现约束：pi 以 --mode rpc 运行时 stdout 是 JSONL 协议通道，
 * 本扩展内严禁 console.log / process.stdout.write 等任何输出，
 * 否则会污染协议流导致后端解析失败。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";

/** 规范化路径用于比较：统一 / 分隔符、小写（Windows 不区分大小写） */
function norm(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 把工具入参中的路径解析为规范化的绝对路径（比较基准）。
 * pi 的 CWD 即项目根，相对路径按此解析，与工具实际写入位置一致。
 */
function resolvePath(raw: string): string {
    if (!raw) return "";
    return norm(path.resolve(process.cwd(), raw));
}

/** pi 进程的 CWD 即项目根（piAgentManager spawn 时固定） */
const PROJECT_ROOT = norm(process.cwd());

/** 项目内白名单区：pi 的临时工作区（临时脚本、抓取产物等） */
const WORKSPACE = `${PROJECT_ROOT}/data/pi/workspace`;

/** 系统临时目录（可能带末尾分隔符，统一规范化） */
const SYS_TEMP = norm(
    process.env.TEMP || process.env.TMP || "c:/windows/temp"
);

/** 判断 child 是否等于 parent 或位于 parent 目录内 */
function isInside(child: string, parent: string): boolean {
    return child === parent || child.startsWith(`${parent}/`);
}

/**
 * 目标路径是否允许写入（rawPath 先解析为绝对路径再判断）：
 *   - 白名单区 data/pi/workspace/（pi 的临时工作区）
 *   - 系统临时目录
 *   - 项目外路径
 * 其余情况（项目内的源码、配置、数据文件）一律拒绝。
 */
function isAllowedWriteTarget(rawPath: string): boolean {
    if (!rawPath) return false;
    const p = resolvePath(rawPath);
    if (isInside(p, WORKSPACE)) return true;
    if (isInside(p, SYS_TEMP)) return true;
    return !isInside(p, PROJECT_ROOT);
}

/** edit/write 工具入参中可能承载目标路径的字段名（按优先级） */
function extractPathFromInput(input: Record<string, unknown>): string {
    const cand = input.path ?? input.file_path ?? input.filePath ?? input.file;
    return typeof cand === "string" ? cand : "";
}

/** bash 写操作特征词（含 POSIX 与 Windows PowerShell 两套常见写法） */
const WRITE_PATTERNS: RegExp[] = [
    /(^|\s|;)>{1,2}\s*\S/,              // 重定向 > >>（已剔除 2>&1 类）
    /(^|\s)tee(\s|$)/i,
    /(^|\s)sed(\s+\S+)*\s+-i(\s|$|['"])/i, // sed -i 原地改写（含 sed -n -i 与 -i.bak）
    /(^|\s)(rm|rmdir|unlink|touch|dd|truncate|shred)\s/i,
    /(^|\s)(mv|cp|ln)\s/i,
    /(^|\s)(out-file|set-content|add-content|export-csv|export-clixml)\b/i,
    /(^|\s)(remove-item|\bri\b|\bdel\b|\berase\b|\brd\b)\s/i,
    /(^|\s)(move-item|\bmi\b|\bmove\b|copy-item|\bci\b|\bcopy\b|\bcp\b)\s/i,
    /(^|\s)(new-item|\bni\b|mkdir)\s/i,
    /\btee-object\b/i,
];

/** 剔除非写文件的重定向语法（2>&1、>&2、2>/dev/null 类先折叠掉 & 和 fd 前缀） */
function stripNonFileRedirections(cmd: string): string {
    return cmd
        .replace(/\d*>&\d+/g, " ")      // 2>&1 / >&2
        .replace(/\d*>\s*\/dev\/null/gi, " ")  // >/dev/null 2>/dev/null
        .replace(/\d*>\s*nul\b/gi, " ");       // Windows NUL
}

/** bash/powershell 命令是否疑似写项目内文件（未显式指向白名单） */
function bashLooksLikeProjectWrite(cmd: string): boolean {
    const cleaned = stripNonFileRedirections(cmd);
    const hit = WRITE_PATTERNS.some((re) => re.test(cleaned));
    if (!hit) return false;
    // 有写特征：命令文本显式包含白名单路径（workspace / 系统临时目录）
    // 才放行；纯相对路径（如 `echo x > out.txt`，CWD 即项目根）一律拦截。
    const n = norm(cmd);
    const mentionsWorkspace =
        n.includes("data/pi/workspace") || n.includes("data\\pi\\workspace");
    const mentionsTemp =
        n.includes("$env:temp") ||
        n.includes("%temp%") ||
        n.includes(SYS_TEMP) ||
        /\s\/tmp\//.test(n);
    return !(mentionsWorkspace || mentionsTemp);
}

/** 拦截响应：reason 会作为工具错误返回给模型，务必给出出路引导 */
function deny(toolName: string, detail: string) {
    return {
        block: true,
        reason:
            `[lumen-guard] 已拦截对项目代码的写操作（${toolName}: ${detail}）。` +
            `本项目的源代码对你是只读的：如需修改项目代码，请先向用户说明方案，` +
            `由用户自行修改或明确授权；临时脚本、抓取产物请写入 ` +
            `data/pi/workspace/ 目录（该目录可自由读写），或写入系统临时目录。`,
    };
}

export default function (pi: ExtensionAPI) {
    pi.on("tool_call", async (event) => {
        const tool = event.toolName;

        // ---- 编辑/写入类工具：路径级精确判断 ----
        if (tool === "edit" || tool === "write") {
            const input = (event.input ?? {}) as Record<string, unknown>;
            const target = extractPathFromInput(input);
            if (!target) {
                // 拿不到目标路径：fail-safe 拦截，宁可误杀不可漏放
                return deny(tool, "未能解析目标路径");
            }
            if (!isAllowedWriteTarget(target)) {
                return deny(tool, target);
            }
            return;
        }

        // ---- shell 类工具：启发式检测 ----
        if (tool === "bash" || tool === "powershell") {
            const input = (event.input ?? {}) as Record<string, unknown>;
            const cmd = typeof input.command === "string" ? input.command : "";
            if (!cmd) return; // 无命令内容则放行（异常参数由工具自身校验）
            if (bashLooksLikeProjectWrite(cmd)) {
                return deny(tool, cmd.length > 120 ? cmd.slice(0, 120) + "…" : cmd);
            }
            return;
        }

        // 其余工具（read/grep/ls/画布桥接等）全部放行
        return;
    });
}
