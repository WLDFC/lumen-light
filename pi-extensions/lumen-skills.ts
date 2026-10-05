/**
 * ==========================================================================
 * LumenLight pi 技能库扩展（lumen-skills）
 * ==========================================================================
 * 作用：给 pi 提供按需加载的技能机制——技能是 data/pi/skills/*.md 文件
 * （frontmatter 含 id/name/description，正文为完整指令），pi 平时只看到
 * 技能名与描述（skill_list），任务命中时才把全文读进上下文（skill_load）。
 * 流程知识因此不必塞进 AGENTS.md 随每轮对话重复消耗。
 *
 * 与 data/skills/（画布提示词节点技能栏体系，调聊天模型）互不相干；
 * 本目录 data/pi/skills/ 在守卫白名单内，pi 也可以自己沉淀新技能
 * （写一个符合格式的 .md 即可，skill_list 立即可见）。
 *
 * 工具：
 *   - skill_list：列出全部技能（id/名称/描述）
 *   - skill_load：按 id 加载技能全文
 *
 * 启停联动（LLM 面板技能库窗口）：data/pi/settings.json 的 disabledSkills
 * 数组记录被用户取消勾选的技能 id——skill_list 不列出、skill_load 拒绝
 * （agent 完全感知不到禁用技能的存在）。每次工具调用现读该字段，
 * 面板勾选即时生效，无需重启 pi。
 *
 * 技能形态（两种并存，2026-10-04 起）：
 *   - file   ：平铺的 id.md（历史形态，文件名 = id）
 *   - folder ：<id>/SKILL.md（Anthropic Agent Skills 标准形态，id = 文件夹
 *              名；frontmatter 写了 id 必须与文件夹名一致，description 必填，
 *              name 缺省回退文件夹名；allowed-tools/metadata 等其他键忽略）。
 *              文件夹内 SKILL.md 之外的辅助文件（scripts/、references/ 等）
 *              不参与解析——skill_load 返回正文时附辅助文件路径提示，
 *              agent 需要时用文件工具按需读取（渐进式披露）
 *
 * 安装：放入 ~/.pi/agent/extensions/（自动加载）。技能文件目录按
 * pi 进程 CWD（项目根）下的 data/pi/skills 解析，环境变量
 * LUMEN_SKILLS_DIR 可重定向（冒烟测试用）。
 *
 * 重要实现约束：pi 以 --mode rpc 运行时 stdout 是 JSONL 协议通道，
 * 本扩展内严禁 console.log / process.stdout.write 等任何输出。
 * ==========================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";

/** 技能文件 id 白名单（与文件名一致） */
const ID_RE = /^[A-Za-z0-9_-]+$/;

/** 技能目录：pi 进程 CWD 即项目根 */
function skillsDir(): string {
    const env = process.env.LUMEN_SKILLS_DIR;
    return env ? path.resolve(env) : path.resolve(process.cwd(), "data/pi/skills");
}

interface SkillMeta {
    id: string;
    name: string;
    description: string;
}

/** 技能条目：form 区分单文件/文件夹形态；dir 仅 folder 形态有值（技能目录） */
interface SkillEntry {
    meta: SkillMeta;
    body: string;
    form: "file" | "folder";
    dir: string | null;
}

/** 解析 frontmatter 头（扁平 key: value），返回键值表与正文；无 frontmatter 返回 null */
function parseFrontmatter(raw: string): { kv: Record<string, string>; body: string } | null {
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return null;
    const kv: Record<string, string> = {};
    for (const line of m[1].split(/\r?\n/)) {
        const pair = line.match(/^([A-Za-z_]+)\s*:\s*(.+?)\s*$/);
        if (!pair) continue;
        kv[pair[1]] = pair[2].replace(/^["']|["']$/g, "");
    }
    return { kv, body: m[2].trim() };
}

/** 解析单文件形态技能（id.md）：frontmatter 取 id/name/description */
function parseSkillFile(file: string): SkillEntry | null {
    let raw: string;
    try {
        raw = fs.readFileSync(file, "utf-8");
    } catch {
        return null;
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;
    const meta: SkillMeta = {
        id: parsed.kv.id || "",
        name: parsed.kv.name || "",
        description: parsed.kv.description || ""
    };
    if (!ID_RE.test(meta.id) || !meta.name || !meta.description) return null;
    if (path.basename(file) !== meta.id + ".md") return null;   // 文件名与 id 一致
    return { meta, body: parsed.body, form: "file", dir: null };
}

/** 解析文件夹形态技能（<dir>/SKILL.md，Anthropic Agent Skills 标准）：
 *  id = 文件夹名；frontmatter 写了 id 必须与文件夹名一致（防错位）；
 *  description 必填；name 缺省回退文件夹名；其余键忽略不报错 */
function parseSkillFolder(dir: string): SkillEntry | null {
    const id = path.basename(dir);
    if (!ID_RE.test(id)) return null;
    let raw: string;
    try {
        raw = fs.readFileSync(path.join(dir, "SKILL.md"), "utf-8");
    } catch {
        return null;
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;
    if (parsed.kv.id && parsed.kv.id !== id) return null;
    const description = parsed.kv.description || "";
    if (!description) return null;
    return {
        meta: { id, name: parsed.kv.name || id, description },
        body: parsed.body,
        form: "folder",
        dir
    };
}

/** 扫描技能目录（一层）：.md 文件 + 含 SKILL.md 的子文件夹；无效项静默忽略 */
function listSkills(): SkillEntry[] {
    let entries: fs.Dirent[] = [];
    try {
        entries = fs.readdirSync(skillsDir(), { withFileTypes: true });
    } catch {
        return [];
    }
    const skills: SkillEntry[] = [];
    for (const ent of entries) {
        if (ent.isFile() && ent.name.endsWith(".md")) {
            const parsed = parseSkillFile(path.join(skillsDir(), ent.name));
            if (parsed) skills.push(parsed);
        } else if (ent.isDirectory()) {
            const parsed = parseSkillFolder(path.join(skillsDir(), ent.name));
            if (parsed) skills.push(parsed);
        }
    }
    return skills;
}

/** 面板禁用的技能 id 集合：data/pi/settings.json 的 disabledSkills
 *  （LLM 面板技能库窗口勾选控制）。每次调用现读——勾选即时生效，
 *  文件缺失/损坏视为全部启用 */
function disabledSkills(): Set<string> {
    try {
        const file = path.resolve(skillsDir(), "../settings.json");
        const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
        const arr = Array.isArray(raw?.disabledSkills) ? raw.disabledSkills : [];
        return new Set(arr.filter((x: unknown): x is string => typeof x === "string"));
    } catch {
        return new Set();
    }
}

/** 工具结果的文本包装（形状与 lumen-canvas 一致：缺 content 包装 pi 会解析为空输出） */
function text(s: string) {
    return { content: [{ type: "text" as const, text: s }] };
}

export default function (pi: {
    registerTool: (tool: unknown) => void;
}) {
    pi.registerTool({
        name: "skill_list",
        label: "Skill List",
        description:
            "列出当前可用的技能（data/pi/skills/ 技能库：画布出图流程等操作 SOP）。" +
            "接到画布操作、出图、图片处理类任务，或不确定项目约定流程时，先调用本工具" +
            "查看是否有匹配技能，命中就用 skill_load 加载全文后再动手。",
        parameters: Type.Object({}),
        async execute() {
            const disabled = disabledSkills();
            const all = listSkills();
            const skills = all.filter((s) => !disabled.has(s.meta.id));
            const hidden = all.length - skills.length;
            if (skills.length === 0) {
                return text(hidden > 0
                    ? `技能库为空（${hidden} 个技能已在面板禁用，可在 LLM 面板技能库窗口重新勾选启用）`
                    : "技能库为空（data/pi/skills/ 下没有合法技能文件）");
            }
            const NL = String.fromCharCode(10);
            const lines = skills.map(
                (s) => `- ${s.meta.id}（${s.meta.name}）：${s.meta.description}`
            );
            return text(
                `共 ${skills.length} 个技能${hidden > 0 ? `（另有 ${hidden} 个已在面板禁用）` : ""}，` +
                `需要哪个的完整内容就用 skill_load 按 id 加载：` + NL +
                lines.join(NL)
            );
        },
    });

    pi.registerTool({
        name: "skill_load",
        label: "Skill Load",
        description:
            "按 id 加载一个技能的完整指令内容（先 skill_list 查看可用技能）。" +
            "加载后严格按技能正文执行任务。",
        parameters: Type.Object({
            id: Type.String({ description: "技能 id（来自 skill_list）" }),
        }),
        async execute(_toolCallId, params) {
            if (!ID_RE.test(params.id)) throw new Error("非法的技能 id");
            const root = skillsDir();
            // 先找平铺 id.md，再找 <id>/SKILL.md（文件夹形态）
            let entry = parseSkillFile(path.join(root, params.id + ".md"));
            let auxNote = "";
            if (!entry) {
                entry = parseSkillFolder(path.join(root, params.id));
                if (entry) {
                    // 渐进式披露的落地：文件夹里除 SKILL.md 外还有辅助文件时，
                    // 提示 agent 按需用文件工具读取（路径相对项目根，pi 的
                    // CWD 即项目根；LUMEN_SKILLS_DIR 重定向时同样成立）
                    try {
                        const extra = fs.readdirSync(entry.dir!)
                            .filter((n) => n !== "SKILL.md");
                        if (extra.length) {
                            const rel = path.relative(process.cwd(), root)
                                .split(path.sep).join("/");
                            auxNote = String.fromCharCode(10) +
                                `（本技能附带辅助文件：${extra.join("、")}——` +
                                `需要时用文件工具读取 ${rel}/${params.id}/ 下的对应文件）`;
                        }
                    } catch { /* 尽力而为 */ }
                }
            }
            if (!entry) {
                throw new Error(`技能「${params.id}」不存在（用 skill_list 查看可用技能）`);
            }
            if (disabledSkills().has(params.id)) {
                throw new Error(`技能「${params.id}」已在面板禁用` +
                    `（LLM 面板技能库窗口可重新勾选启用）；请跳过该技能按常规方式执行任务`);
            }
            return text(`【技能：${entry.meta.name}】` + String.fromCharCode(10) +
                entry.body + auxNote);
        },
    });
}
