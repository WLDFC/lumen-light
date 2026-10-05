/**
 * ==========================================================================
 * LumenLight pi 技能库路由
 * ==========================================================================
 * 作用：面板查阅、启停与上传 data/pi/skills/ 技能库（pi agent 的
 *   skill_list/skill_load 数据源，解析实现在 pi-extensions/lumen-skills.ts）：
 *   - GET  /              列出全部技能（元数据 + 正文，供弹窗展开查阅）
 *                         与启用状态，无效项以 invalid 清单单独返回
 *   - PUT  /:id/enabled   勾选/取消勾选（enabled:false = agent 不可见不可加载）
 *   - POST /upload        上传技能：单个 .md（多选）或 Agent Skills 文件夹
 *                         （<id>/SKILL.md + 辅助文件原样存储）
 * 技能形态（与扩展解析规则一致）：
 *   - file   ：平铺 id.md，frontmatter 必填 id/name/description，文件名 = id
 *   - folder ：<id>/SKILL.md，id = 文件夹名；frontmatter 写了 id 必须与
 *              文件夹名一致，description 必填，name 缺省回退文件夹名
 * 禁用状态存 data/pi/settings.json 的 disabledSkills 数组（与权限分级
 * 同文件，读改写保留其他区块）——lumen-skills 扩展每次 skill_list /
 * skill_load 现读该字段，勾选即时生效，无需重启 pi。
 * 无效文件不在列表里静默消失——单独以 invalid 返回（面板灰条显示），
 * 否则用户放了个格式错的文件会以为功能坏了。
 * ==========================================================================
 */

const express = require('express');
const fsSync = require('fs');
const path = require('path');

/** 技能 id 白名单（同时用作文件/文件夹名，防路径穿越），与扩展一致 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 上传限制：单文件 1MB / 单次总量 20MB / 单次 ≤200 个文件 */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 200;

/**
 * 解析 frontmatter 头（扁平 key: value），返回键值表与正文。
 * 无 frontmatter 返回 null
 */
function parseFrontmatter(raw) {
    if (typeof raw !== 'string') return null;
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return null;
    const kv = {};
    for (const line of m[1].split(/\r?\n/)) {
        const pair = line.match(/^([A-Za-z_]+)\s*:\s*(.+?)\s*$/);
        if (!pair) continue;
        kv[pair[1]] = pair[2].replace(/^["']|["']$/g, '');
    }
    return { kv, body: m[2].trim() };
}

/**
 * 解析单文件形态技能（id.md）：frontmatter 取 id/name/description，
 * 正文为指令。无效返回 null
 */
function parseSkillFile(file) {
    let raw;
    try {
        raw = fsSync.readFileSync(file, 'utf-8');
    } catch {
        return null;
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;
    const id = parsed.kv.id || '';
    const name = parsed.kv.name || '';
    const description = parsed.kv.description || '';
    if (!ID_PATTERN.test(id) || !name || !description) return null;
    if (path.basename(file) !== id + '.md') return null;   // 文件名与 id 一致
    return { id, name, description, body: parsed.body, form: 'file' };
}

/**
 * 解析文件夹形态技能（<dir>/SKILL.md，Anthropic Agent Skills 标准）：
 * id = 文件夹名；frontmatter 写了 id 必须与文件夹名一致（防错位）；
 * description 必填；name 缺省回退文件夹名；其余键忽略不报错。
 * 返回 { skill } 或 { reason }（无效原因，面板灰条展示用）
 */
function parseSkillFolder(dir) {
    const id = path.basename(dir);
    if (!ID_PATTERN.test(id)) {
        return { reason: '文件夹名含非法字符（只允许字母/数字/下划线/连字符）' };
    }
    let raw;
    try {
        raw = fsSync.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
    } catch {
        return { reason: '文件夹缺少 SKILL.md' };
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed) return { reason: 'SKILL.md 缺少 frontmatter' };
    if (parsed.kv.id && parsed.kv.id !== id) {
        return { reason: `SKILL.md 的 id（${parsed.kv.id}）与文件夹名（${id}）不一致` };
    }
    if (!(parsed.kv.description || '').trim()) {
        return { reason: 'SKILL.md 缺 description' };
    }
    return {
        skill: {
            id,
            name: parsed.kv.name || id,
            description: parsed.kv.description,
            body: parsed.body,
            form: 'folder'
        }
    };
}

/**
 * 创建 pi 技能库路由
 * @param {Object} options - 依赖项
 * @param {string} options.dataDir - 应用数据目录（data/）
 * @returns {express.Router}
 */
function createPiSkillsRouter({ dataDir }) {
    const router = express.Router();
    const skillsDir = path.join(dataDir, 'pi', 'skills');
    const settingsFile = path.join(dataDir, 'pi', 'settings.json');

    /** 读取禁用清单（文件缺失/损坏视为全部启用） */
    function readDisabled() {
        try {
            const s = JSON.parse(fsSync.readFileSync(settingsFile, 'utf-8'));
            return Array.isArray(s.disabledSkills)
                ? s.disabledSkills.filter((x) => typeof x === 'string')
                : [];
        } catch {
            return [];
        }
    }

    /** 写禁用清单：读改写整个 settings.json，保留 permissionLevel 等其他区块 */
    function writeDisabled(list) {
        let cur = {};
        try {
            cur = JSON.parse(fsSync.readFileSync(settingsFile, 'utf-8'));
        } catch { /* 文件缺失/损坏：以新对象起始 */ }
        if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) cur = {};
        cur.disabledSkills = list;
        fsSync.mkdirSync(path.dirname(settingsFile), { recursive: true });
        fsSync.writeFileSync(settingsFile, JSON.stringify(cur, null, 2), 'utf-8');
    }

    /**
     * GET /
     * 列出全部技能（按名称排序）：{ id, name, description, enabled, body, form }；
     * 另附 invalid 清单（file = 文件/文件夹名, reason = 无效原因）
     */
    router.get('/', (req, res) => {
        const disabled = new Set(readDisabled());
        let entries = [];
        try {
            entries = fsSync.readdirSync(skillsDir, { withFileTypes: true });
        } catch { /* 目录缺失：空库 */ }
        const skills = [];
        const invalid = [];
        for (const ent of entries) {
            if (ent.isFile() && ent.name.toLowerCase().endsWith('.md') &&
                ent.name.toLowerCase() !== 'readme.md') {
                const parsed = parseSkillFile(path.join(skillsDir, ent.name));
                if (!parsed) {
                    invalid.push({ file: ent.name, reason: 'frontmatter 缺 id/name/description，或 id 与文件名不一致' });
                    continue;
                }
                skills.push({ ...parsed, enabled: !disabled.has(parsed.id) });
            } else if (ent.isDirectory()) {
                const result = parseSkillFolder(path.join(skillsDir, ent.name));
                if (result.skill) {
                    skills.push({ ...result.skill, enabled: !disabled.has(result.skill.id) });
                } else {
                    invalid.push({ file: ent.name + '/', reason: result.reason });
                }
            }
        }
        skills.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        res.json({ status: 'ok', skills, invalid });
    });

    /**
     * PUT /:id/enabled   body: { enabled: boolean }
     * 勾选/取消勾选。写 settings.json 的 disabledSkills（差量增删，幂等）
     */
    router.put('/:id/enabled', (req, res) => {
        const id = String(req.params.id || '');
        if (!ID_PATTERN.test(id)) {
            return res.status(400).json({ status: 'error', message: '无效的技能 id' });
        }
        const enabled = !!(req.body && req.body.enabled);
        const list = readDisabled();
        const next = enabled
            ? list.filter((x) => x !== id)
            : (list.includes(id) ? list : [...list, id]);
        try {
            writeDisabled(next);
        } catch (err) {
            console.error('写 pi 技能启停状态失败:', err.message);
            return res.status(500).json({ status: 'error', message: err.message || '写入失败' });
        }
        res.json({ status: 'ok', id, enabled, disabledSkills: next });
    });

    /**
     * POST /upload   body: { files: [{path, content, encoding}], allowOverwrite? }
     * 上传技能（浏览器 FileReader 读出的文件内容，文本/二进制统一 base64）：
     *   - 单 .md（可多选）：按 frontmatter 的 id 落盘为 <id>.md（文件名不匹配
     *     时顺手修正），须通过扩展同款解析校验；
     *   - 文件夹（webkitdirectory，路径形如 <folder>/SKILL.md）：一次一个
     *     文件夹，文件夹名 = 技能 id（须合法），必须含 SKILL.md 且通过解析
     *     校验；辅助文件原样存储（scripts/assets 等，pi 按需读取）；
     *   - 同 id 已存在（同名文件或文件夹）时返回 409 { exists: true }，前端
     *     确认后带 allowOverwrite:true 重发（文件夹覆盖会先清掉同名 .md）。
     * 全部校验通过后才写盘（半途写失败可能留下部分文件，属罕见故障）
     */
    router.post('/upload', (req, res) => {
        const files = Array.isArray(req.body && req.body.files) ? req.body.files : null;
        if (!files || !files.length) {
            return res.status(400).json({ status: 'error', message: '缺少 files' });
        }
        if (files.length > MAX_FILES) {
            return res.status(400).json({ status: 'error', message: `单次最多上传 ${MAX_FILES} 个文件` });
        }
        const allowOverwrite = !!(req.body && req.body.allowOverwrite);

        // 第一遍：逐条规整与限额校验（路径合法、解码、单文件体积、总量）
        const norm = [];
        let totalBytes = 0;
        for (const f of files) {
            const rawPath = String((f && f.path) || '');
            const content = typeof (f && f.content) === 'string' ? f.content : '';
            const encoding = f.encoding === 'utf8' ? 'utf8' : 'base64';
            if (!rawPath || rawPath.includes('\\') || rawPath.includes('..') ||
                path.isAbsolute(rawPath) || /^[a-zA-Z]:/.test(rawPath)) {
                return res.status(400).json({ status: 'error', message: `非法文件路径: ${rawPath.slice(0, 80)}` });
            }
            const parts = rawPath.split('/').filter(Boolean);
            if (!parts.length || parts.some((seg) => !seg || seg === '.' || seg === '..')) {
                return res.status(400).json({ status: 'error', message: `非法文件路径: ${rawPath.slice(0, 80)}` });
            }
            let bytes;
            try {
                bytes = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf-8');
            } catch {
                return res.status(400).json({ status: 'error', message: `文件内容解码失败: ${rawPath.slice(0, 80)}` });
            }
            if (bytes.length > MAX_FILE_BYTES) {
                return res.status(400).json({ status: 'error', message: `文件超过 1MB 上限: ${rawPath.slice(0, 80)}` });
            }
            totalBytes += bytes.length;
            norm.push({ parts, bytes });
        }
        if (totalBytes > MAX_TOTAL_BYTES) {
            return res.status(400).json({ status: 'error', message: '总大小超过 20MB 上限' });
        }

        // 分组判定形态：带 / 的归文件夹（顶层段 = 文件夹名），不带 / 的是单文件。
        // 两者不混传（一次上传只做一件事，校验规则不同）
        const topDirs = new Set(norm.filter((f) => f.parts.length > 1).map((f) => f.parts[0]));
        const hasFlat = norm.some((f) => f.parts.length === 1);
        if (topDirs.size > 1) {
            return res.status(400).json({ status: 'error', message: '一次只能上传一个技能文件夹' });
        }
        if (topDirs.size === 1 && hasFlat) {
            return res.status(400).json({ status: 'error', message: '请不要混合上传文件夹与散装 .md 文件' });
        }

        fsSync.mkdirSync(skillsDir, { recursive: true });

        // ---- 文件夹形态 ----
        if (topDirs.size === 1) {
            const dir = [...topDirs][0];
            if (!ID_PATTERN.test(dir)) {
                return res.status(400).json({ status: 'error', message: '文件夹名含非法字符（只允许字母/数字/下划线/连字符）' });
            }
            const skillMd = norm.find((f) => f.parts.length === 2 && f.parts[1] === 'SKILL.md');
            if (!skillMd) {
                return res.status(400).json({ status: 'error', message: '文件夹缺少 SKILL.md' });
            }
            const parsed = parseFrontmatter(skillMd.bytes.toString('utf-8'));
            if (!parsed) {
                return res.status(400).json({ status: 'error', message: 'SKILL.md 缺少 frontmatter' });
            }
            if (parsed.kv.id && parsed.kv.id !== dir) {
                return res.status(400).json({ status: 'error', message: `SKILL.md 的 id（${parsed.kv.id}）与文件夹名（${dir}）不一致，请修正后重试` });
            }
            if (!(parsed.kv.description || '').trim()) {
                return res.status(400).json({ status: 'error', message: 'SKILL.md 缺 description' });
            }
            const targetDir = path.join(skillsDir, dir);
            const flatPeer = path.join(skillsDir, dir + '.md');
            if (!allowOverwrite && (fsSync.existsSync(targetDir) || fsSync.existsSync(flatPeer))) {
                return res.status(409).json({ status: 'error', exists: true, id: dir, message: `技能「${dir}」已存在` });
            }
            if (fsSync.existsSync(flatPeer)) fsSync.unlinkSync(flatPeer);   // 同 id 平铺件让位
            for (const f of norm) {
                const dest = path.join(skillsDir, ...f.parts);
                fsSync.mkdirSync(path.dirname(dest), { recursive: true });
                fsSync.writeFileSync(dest, f.bytes);
            }
            console.log(`[piSkills] 上传文件夹技能 ${dir}（${norm.length} 个文件）`);
            return res.json({ status: 'ok', id: dir, form: 'folder', fileCount: norm.length });
        }

        // ---- 单 .md 形态（可多选） ----
        const prepared = [];
        for (const f of norm) {
            const fileName = f.parts[0];
            if (!fileName.toLowerCase().endsWith('.md')) {
                return res.status(400).json({ status: 'error', message: `只支持 .md 技能文件: ${fileName.slice(0, 80)}` });
            }
            const parsed = parseFrontmatter(f.bytes.toString('utf-8'));
            if (!parsed) {
                return res.status(400).json({ status: 'error', message: `缺少 frontmatter: ${fileName.slice(0, 80)}` });
            }
            // id 取 frontmatter（无则文件名兜底），落盘一律以 id 命名（顺手修正文件名）
            const id = parsed.kv.id || fileName.replace(/\.md$/i, '');
            if (!ID_PATTERN.test(id)) {
                return res.status(400).json({ status: 'error', message: `技能 id 非法（只允许字母/数字/下划线/连字符）: ${id.slice(0, 80)}` });
            }
            if (!(parsed.kv.name || '').trim() || !(parsed.kv.description || '').trim()) {
                return res.status(400).json({ status: 'error', message: `frontmatter 缺 name 或 description: ${fileName.slice(0, 80)}` });
            }
            prepared.push({ id, bytes: f.bytes });
        }
        const conflicts = prepared.filter((p) =>
            fsSync.existsSync(path.join(skillsDir, p.id + '.md')) ||
            fsSync.existsSync(path.join(skillsDir, p.id)));
        if (!allowOverwrite && conflicts.length) {
            return res.status(409).json({ status: 'error', exists: true, id: conflicts[0].id, message: `技能「${conflicts[0].id}」已存在` });
        }
        for (const p of conflicts) {
            const peerDir = path.join(skillsDir, p.id);
            if (fsSync.existsSync(peerDir) && fsSync.statSync(peerDir).isDirectory()) {
                fsSync.rmSync(peerDir, { recursive: true, force: true });   // 同 id 文件夹让位
            }
        }
        for (const p of prepared) {
            fsSync.writeFileSync(path.join(skillsDir, p.id + '.md'), p.bytes);
        }
        console.log(`[piSkills] 上传技能文件：${prepared.map((p) => p.id).join(', ')}`);
        return res.json({ status: 'ok', ids: prepared.map((p) => p.id), form: 'file', fileCount: prepared.length });
    });

    return router;
}

module.exports = createPiSkillsRouter;
// 导出解析器供测试使用
module.exports.parseSkillFile = parseSkillFile;
module.exports.parseSkillFolder = parseSkillFolder;
module.exports.parseFrontmatter = parseFrontmatter;
