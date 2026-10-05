/**
 * LumenLight pi 扩展：项目代码写保护门禁（lumen-guard）
 *
 * 目的：画布里的 pi agent 只允许"读取项目 / 写白名单区 / 写项目外"，
 * 未经用户明确要求不得修改项目源代码。历史上 pi 曾在咨询类对话中
 * 擅自修改 js/api/LumenSocket.js 并新建 tools/agent-upscale.js，
 * 本扩展把"不改项目代码"从提示词软约束升级为工具层硬拦截。
 *
 * 权限分级联动（与 MCP 工具门禁同源，读 data/pi/settings.json 的
 * permissionLevel，设置 → 通用 → 权限分级 维护）：
 *   - readonly（只读）：项目内一律禁止写入（含白名单区；
 *     临时产物请走系统临时目录，项目外路径不受门禁管辖）
 *   - standard（标准）：仅白名单目录可写（默认 data/pi/workspace/ 与
 *     data/skills/，可经 guard.json 增删）
 *   - full（完整）：白名单目录 + 画布内容区（save/、tag/、temp_upscale/、
 *     data/videos/）可写——解锁的是"整理用户产物"的范围，不是程序本体
 *
 * 结构性保护（硬编码于本文件，任何分级、任何 guard.json 配置都不可写）：
 *   项目源代码与配置——根级带扩展名的文件（server.js、package.json、
 *   index.html 等）、程序目录（js/css/routes/utils/tools/test/pi/
 *   pi-extensions/mcp/lumen_nodes/workflows/models/runtime/image 等）、
 *   data/settings.json、data/prompts.json、data/pi/（workspace 与
 *   skills 两个白名单区除外）。
 *   权限分级回答"agent 行动多自主"，不扩大行动范围：宿主代码不在任何
 *   分级下开放写入，否则 full 级下一次提示注入就能拆除守卫本身（保护被
 *   被保护对象关闭）。guard.json 只能放宽内容白名单，指向受保护目录的
 *   白名单条目会被静默丢弃。
 *
 * 声明式规则表：白名单目录与 bash 写特征词不硬编码，存于
 * data/pi/guard.json（文件缺失时自动生成默认值，改完下个工具调用即生效，
 * 无需重装扩展）。
 *
 * 拦截日志：每次拦截追加一行 [guard] 到 data/pi/agent.log
 * （与 piAgentManager 生命周期日志同文件同格式，1MB 封顶）。
 *
 * 拦截策略（fail-safe：拿不准就拦，错误信息引导 pi 走白名单）：
 *   - edit / write 工具：按分级与白名单做路径级精确判断
 *   - bash / powershell 工具：命令含写操作特征（重定向、tee、sed -i、
 *     rm/mv/cp、PowerShell 写命令等）时按分级判定，standard 及以下
 *     需命令文本显式指向白名单区或系统临时目录才放行
 *   - read / grep / ls 等只读工具与画布桥接工具：不受影响
 *
 * 测试钩子：环境变量 LUMEN_GUARD_DATA_DIR 可把 settings.json /
 * guard.json / agent.log 所在目录重定向到别处（冒烟测试用；不设则用
 * 项目内 data/pi/）。
 *
 * 重要实现约束：pi 以 --mode rpc 运行时 stdout 是 JSONL 协议通道，
 * 本扩展内严禁 console.log / process.stdout.write 等任何输出，
 * 否则会污染协议流导致后端解析失败。
 */
import path from "node:path";
import fs from "node:fs";

/**
 * 类型定义说明：不从 "@earendil-works/pi-coding-agent" import type——
 * 该包位于 pi/node_modules/（不在项目根依赖解析路径上），TypeScript
 * 无法解析会报 TS2307。运行时类型导入本就会被剥离，本地最小接口
 * 只覆盖本扩展实际用到的 API（pi.on("tool_call")），行为完全一致。
 */

/** pi 的 tool_call 事件（仅本扩展用到的字段） */
interface ToolCallEvent {
    toolName: string;
    input?: Record<string, unknown>;
}

/** tool_call 处理器返回 { block: true } 时拦截该次工具调用 */
interface ToolCallBlock {
    block: boolean;
    reason?: string;
}

/** 本扩展用到的 ExtensionAPI 最小面 */
interface GuardExtensionAPI {
    on(
        event: "tool_call",
        handler: (event: ToolCallEvent) => Promise<ToolCallBlock | void>
    ): void;
}

/** 声明式规则表（data/pi/guard.json）结构 */
interface GuardConfig {
    /** 项目内可写目录（相对项目根的路径），standard 级放行依据 */
    whitelistDirs: string[];
    /** bash 写操作特征词（正则源字符串，按不区分大小写编译） */
    writePatterns: string[];
}

// ==================== 路径与配置 ====================

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

/** 系统临时目录（可能带末尾分隔符，统一规范化） */
const SYS_TEMP = norm(
    process.env.TEMP || process.env.TMP || "c:/windows/temp"
);

/** guard 数据目录（settings.json / guard.json / agent.log 所在） */
function dataDir(): string {
    const env = process.env.LUMEN_GUARD_DATA_DIR;
    return norm(env ? path.resolve(env) : path.join(PROJECT_ROOT, "data/pi"));
}

/** 默认规则表：白名单与 bash 写特征词（guard.json 缺失时生成该值） */
const DEFAULT_CONFIG: GuardConfig = {
    whitelistDirs: ["data/pi/workspace", "data/skills", "data/pi/skills"],
    writePatterns: [
        "(^|\\s|;)>{1,2}\\s*\\S",                       // 重定向 > >>（2>&1 类已先行剔除）
        "(^|\\s)tee(\\s|$)",
        "(^|\\s)sed(\\s+\\S+)*\\s+-i(\\s|$|['\"])",     // sed -i 原地改写
        "(^|\\s)(rm|rmdir|unlink|touch|dd|truncate|shred)\\s",
        "(^|\\s)(mv|cp|ln)\\s",
        "(^|\\s)(out-file|set-content|add-content|export-csv|export-clixml)\\b",
        "(^|\\s)(remove-item|\\bri\\b|\\bdel\\b|\\berase\\b|\\brd\\b)\\s",
        "(^|\\s)(move-item|\\bmi\\b|\\bmove\\b|copy-item|\\bci\\b|\\bcopy\\b|\\bcp\\b)\\s",
        "(^|\\s)(new-item|\\bni\\b|mkdir)\\s",
        "\\btee-object\\b",
    ],
};

/** 校验并编译规则表：单个字段缺失/为空/全部非法时独立回退默认值
 *  （防止只配 whitelistDirs 时 bash 特征词被静默清空、失去检测能力） */
function compileConfig(raw: unknown): GuardConfig {
    const cfg: GuardConfig = { whitelistDirs: [], writePatterns: [] };
    if (raw && typeof raw === "object") {
        const obj = raw as Record<string, unknown>;
        if (Array.isArray(obj.whitelistDirs)) {
            cfg.whitelistDirs = obj.whitelistDirs
                .filter((d): d is string => typeof d === "string" && d.trim() !== "");
        }
        if (Array.isArray(obj.writePatterns)) {
            // 只保留能编译通过的正则源（存储时不带定界符与标志，统一按 i 编译）
            cfg.writePatterns = (obj.writePatterns as unknown[]).filter(
                (p): p is string =>
                    typeof p === "string" && p.trim() !== "" && safeRegex(p)
            );
        }
    }
    if (cfg.whitelistDirs.length === 0) {
        cfg.whitelistDirs = DEFAULT_CONFIG.whitelistDirs;
    }
    if (cfg.writePatterns.length === 0) {
        cfg.writePatterns = DEFAULT_CONFIG.writePatterns;
    }
    return cfg;
}

/** 正则源能否编译（compileConfig 用，避免坏正则整体失效） */
function safeRegex(source: string): boolean {
    try {
        new RegExp(source, "i");
        return true;
    } catch {
        return false;
    }
}

/**
 * 读规则表（每次工具调用现读，改文件即生效）：guard.json 缺失/损坏时
 * 自动写出默认值并按默认值判定——文件本身就是配置项的自述文档。
 */
function loadConfig(): GuardConfig {
    const file = path.join(dataDir(), "guard.json");
    try {
        return compileConfig(JSON.parse(fs.readFileSync(file, "utf-8")));
    } catch {
        try {
            fs.writeFileSync(
                file,
                JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n",
                "utf-8"
            );
        } catch { /* 只读盘等场景下静默回退默认值 */ }
        return DEFAULT_CONFIG;
    }
}

// ==================== 权限分级（与 MCP 门禁同源） ====================

/** 权限分级 → 数值（越高权力越大），与 utils/mcpManager.js 的 LEVEL_RANK 一致 */
const LEVEL_RANK: Record<string, number> = { readonly: 0, standard: 1, full: 2 };

/**
 * 当前全局权限分级（读 data/pi/settings.json，由 PiAgentManager 维护，
 * 设置 → 通用 → 权限分级 写入）。文件缺失/非法时按 standard——
 * fail-safe 方向与 MCP 门禁一致：拿不准就按较严一档处理。
 */
function permissionLevel(): number {
    try {
        const raw = fs.readFileSync(
            path.join(dataDir(), "settings.json"),
            "utf-8"
        );
        const lv = JSON.parse(raw).permissionLevel;
        return LEVEL_RANK[lv] !== undefined ? LEVEL_RANK[lv] : 1;
    } catch {
        return 1;
    }
}

// ==================== 拦截日志 ====================

/** 拦截日志：追加 [guard] 行到 data/pi/agent.log（1MB 封顶，写失败不影响主流程） */
function logGuard(msg: string): void {
    try {
        const file = path.join(dataDir(), "agent.log");
        if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
            fs.writeFileSync(file, "");
        }
        fs.appendFileSync(file, `${new Date().toLocaleString()} ${msg}\n`);
    } catch { /* 日志写失败不影响主流程 */ }
}

// ==================== 结构性保护与内容区（硬编码，不受配置影响） ====================

/** 完整级额外放行的画布内容区（用户产物，非程序本体） */
const CONTENT_DIRS = ["save", "tag", "temp_upscale", "data/videos"];

/**
 * 结构性保护目录：项目源代码与程序本体，任何分级、任何 guard.json 配置
 * 都不可写。根级文件（server.js、package.json 等）由 isProtected 的
 * "根级直属于项目根" 规则覆盖；data/pi/ 单独处理（workspace 除外）。
 */
const PROTECTED_DIRS = [
    "js", "css", "routes", "utils", "tools", "test",
    "pi", "pi-extensions", "mcp", "lumen_nodes",
    "workflows", "models", "runtime", "image",
    "real-esrgan", "node_modules", ".git", ".vscode", ".trae",
];

/** 结构性保护文件（根级规则覆盖不到的项目内配置） */
const PROTECTED_FILES = ["data/settings.json", "data/prompts.json"];

/** 相对路径 → 项目根下规范化绝对路径 */
function absRel(dir: string): string {
    return norm(path.resolve(PROJECT_ROOT, dir));
}

/**
 * 结构性保护判定：目标是否属于"任何分级都不可写"的程序本体/配置。
 *   - 根级直属文件/目录（server.js、package.json、AGENTS.md 等）
 *   - PROTECTED_DIRS 程序目录
 *   - PROTECTED_FILES 配置文件
 *   - data/pi/（守卫自己的 settings.json / guard.json / 会话在内，
 *     仅 workspace 与 skills 两个白名单区例外）
 */
function isProtected(p: string): boolean {
    // 根级带扩展名的文件（server.js、package.json、AGENTS.md 等）＝程序本体；
    // 根级无扩展名条目是目录（js/、save/、自定义白名单目录等），交由
    // 目录保护清单、内容区与白名单规则处理
    if (norm(path.dirname(p)) === PROJECT_ROOT && path.extname(p) !== "") return true;
    if (PROTECTED_DIRS.some((d) => isInside(p, absRel(d)))) return true;
    if (PROTECTED_FILES.some((f) => p === absRel(f))) return true;
    const piDir = absRel("data/pi");
    const wsDir = absRel("data/pi/workspace");
    const skillDir = absRel("data/pi/skills");
    if (isInside(p, piDir) && !isInside(p, wsDir) && !isInside(p, skillDir)) return true;
    return false;
}

/** 相对路径 → 项目根下规范化绝对路径（白名单条目用） */
function whitelistAbsDirs(cfg: GuardConfig): string[] {
    return cfg.whitelistDirs
        .map((d) => absRel(d))
        .filter((abs) => !isProtected(abs));   // 清洗：白名单永远盖不过结构性保护
}

// ==================== 路径级判定（edit / write） ====================

/** 判断 child 是否等于 parent 或位于 parent 目录内 */
function isInside(child: string, parent: string): boolean {
    return child === parent || child.startsWith(`${parent}/`);
}

/**
 * 路径级判定：目标是否允许写入（rawPath 先解析为绝对路径再判断）。
 *   - 项目外路径（含系统临时目录）：不受门禁管辖，任何分级放行
 *   - readonly：项目内一律拒绝
 *   - 结构性保护（源码/配置）：任何分级拒绝
 *   - standard：仅白名单目录放行
 *   - full：白名单 + 画布内容区放行
 */
function isAllowedWriteTarget(rawPath: string, level: number, cfg: GuardConfig): boolean {
    if (!rawPath) return false;
    const p = resolvePath(rawPath);
    if (!isInside(p, PROJECT_ROOT)) return true;
    if (level <= 0) return false;
    if (isProtected(p)) return false;
    if (whitelistAbsDirs(cfg).some((dir) => isInside(p, dir))) return true;
    if (level >= 2 && CONTENT_DIRS.some((d) => isInside(p, absRel(d)))) return true;
    return false;
}

/** edit/write 工具入参中可能承载目标路径的字段名（按优先级） */
function extractPathFromInput(input: Record<string, unknown>): string {
    const cand = input.path ?? input.file_path ?? input.filePath ?? input.file;
    return typeof cand === "string" ? cand : "";
}

// ==================== shell 启发式判定（bash / powershell） ====================

/** 剔除非写文件的重定向语法（2>&1、>&2、2>/dev/null 类先折叠掉 & 和 fd 前缀） */
function stripNonFileRedirections(cmd: string): string {
    return cmd
        .replace(/\d*>&\d+/g, " ")      // 2>&1 / >&2
        .replace(/\d*>\s*\/dev\/null/gi, " ")  // >/dev/null 2>/dev/null
        .replace(/\d*>\s*nul\b/gi, " ");       // Windows NUL
}

/**
 * bash/powershell 命令是否疑似写项目内文件（未显式指向允许区域）。
 * 命中写特征后按分级判定：full 级放行白名单 + 内容区，standard 级放行
 * 白名单，readonly 级只认系统临时目录——均与路径级判定同语义。
 */
function bashLooksLikeProjectWrite(cmd: string, level: number, cfg: GuardConfig): boolean {
    const cleaned = stripNonFileRedirections(cmd);
    const hit = cfg.writePatterns.some((src) => new RegExp(src, "i").test(cleaned));
    if (!hit) return false;
    if (level >= 2) {
        // full 级：显式指向白名单/内容区/临时目录才放行，源码路径照样拦
        return !bashMentionsAllowedArea(cmd, cfg, true);
    }
    // 命中写特征：命令文本需显式包含允许区域（相对或绝对形式都算显式指向），
    // 纯相对路径（如 `echo x > out.txt`，CWD 即项目根）拦截。
    if (level <= 0) return !bashMentionsTemp(cmd);
    return !(bashMentionsAllowedArea(cmd, cfg, false) || bashMentionsTemp(cmd));
}

/** 命令文本是否显式指向允许写入的项目内区域（白名单 + full 级内容区） */
function bashMentionsAllowedArea(cmd: string, cfg: GuardConfig, withContent: boolean): boolean {
    const n = norm(cmd);
    const areas = cfg.whitelistDirs
        .map((d) => ({ rel: norm(d), abs: absRel(d) }))
        .filter((a) => !isProtected(a.abs))   // 与路径级同规则：白名单盖不过保护
        .concat(withContent
            ? CONTENT_DIRS.map((d) => ({ rel: norm(d), abs: absRel(d) }))
            : []);
    return areas.some((a) => n.includes(a.rel) || n.includes(a.abs));
}

/** 命令文本是否显式指向系统临时目录 */
function bashMentionsTemp(cmd: string): boolean {
    const n = norm(cmd);
    return n.includes("$env:temp") ||
        n.includes("%temp%") ||
        n.includes(SYS_TEMP) ||
        /\s\/tmp\//.test(n);
}

// ==================== 拦截响应与注册 ====================

/** 分级名（拦截文案用） */
const LEVEL_NAME: Record<number, string> = {
    0: "只读",
    1: "标准",
    2: "完整",
};

/** 拦截响应：reason 会作为工具错误返回给模型，务必给出出路引导 */
function deny(toolName: string, detail: string, level: number) {
    logGuard(`[guard] deny ${toolName}（${LEVEL_NAME[level]}级）: ${detail}`);
    const guidance =
        level <= 0
            ? `当前权限分级为「只读」，项目内一律禁止写入（含 data/pi/workspace/）。` +
              `临时产物请写入系统临时目录；如需写入能力，请用户在 设置 → 通用 → 权限分级 调整。`
            : `[lumen-guard] 已拦截对项目代码的写操作（${toolName}: ${detail}）。` +
              `项目源代码与配置在任何权限分级下都只读：如需修改，请先向用户说明方案，` +
              `由用户自行修改。临时脚本、抓取产物请写入 data/pi/workspace/（白名单` +
              `登记于 data/pi/guard.json），用户技能文件可写入 data/skills/（一个技能` +
              `一个 .md）；权限分级为「完整」时，画布内容区（save/、tag/、` +
              `temp_upscale/、data/videos/）也可写入；或写入系统临时目录。`;
    return { block: true, reason: guidance };
}

export default function (pi: GuardExtensionAPI) {
    pi.on("tool_call", async (event) => {
        const tool = event.toolName;

        // 每次工具调用现读配置与分级：设置/规则表改动即生效，无需重启 pi
        const cfg = loadConfig();
        const level = permissionLevel();

        // ---- 编辑/写入类工具：路径级精确判断 ----
        if (tool === "edit" || tool === "write") {
            const input = (event.input ?? {}) as Record<string, unknown>;
            const target = extractPathFromInput(input);
            if (!target) {
                // 拿不到目标路径：fail-safe 拦截，宁可误杀不可漏放
                return deny(tool, "未能解析目标路径", level);
            }
            if (!isAllowedWriteTarget(target, level, cfg)) {
                return deny(tool, target, level);
            }
            return;
        }

        // ---- shell 类工具：启发式检测 ----
        if (tool === "bash" || tool === "powershell") {
            const input = (event.input ?? {}) as Record<string, unknown>;
            const cmd = typeof input.command === "string" ? input.command : "";
            if (!cmd) return; // 无命令内容则放行（异常参数由工具自身校验）
            if (bashLooksLikeProjectWrite(cmd, level, cfg)) {
                return deny(
                    tool,
                    cmd.length > 120 ? cmd.slice(0, 120) + "…" : cmd,
                    level
                );
            }
            return;
        }

        // 其余工具（read/grep/ls/画布桥接等）全部放行
        return;
    });
}
