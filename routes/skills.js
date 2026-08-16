/**
 * ==========================================================================
 * LumenLight 用户技能路由
 * ==========================================================================
 * 作用：管理 data/skills/ 目录下的用户自定义技能（提示词节点技能栏使用）。
 *   - 一个技能一个 .md 文件（Agent Skills 主流格式）：YAML frontmatter
 *     存元数据（id/name/icon/输入开关），正文即发给模型的指令，
 *     用户直接放入/备份/分享文件即可，刷新页面即生效（无需重启后端）；
 *   - 兼容读取旧版 .json 技能文件；同 id 时 .md 优先；
 *   - 与内置技能（js/canvas/nodes/PromptSkillBar.js 的 SKILLS 数组）独立；
 *   - 本层负责字段校验与 id 清洗（防路径穿越），name 截断防超长文件名。
 *
 * 路由：
 *   GET    /       列出全部用户技能（统一转为 JSON 结构返回）
 *   POST   /       保存技能（新增或覆盖，upsert，写为 .json）
 *   DELETE /:id    删除技能（同时尝试删除 .md 与 .json）
 * ==========================================================================
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');

// 技能 id 白名单：字母/数字/下划线/连字符，同时用作文件名（防路径穿越）
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 解析技能 Markdown：--- 包裹的 frontmatter（扁平 key: value）+ 指令正文。
 * 正文即发给模型的指令，避免了 JSON 里长指令要写成 \n 转义串的问题。
 * @param {string} content - 文件内容
 * @param {string} fallbackId - frontmatter 缺 id 时用文件名兜底
 * @returns {Object|null} {id,name,icon,instruction,inputText,inputImages}，解析失败为 null
 */
function parseSkillMd(content, fallbackId) {
    if (typeof content !== 'string') return null;
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) return null;

    // 仅支持扁平的 key: value 行（本项目技能字段全部是标量，无需完整 YAML 解析器）
    const meta = {};
    for (const line of match[1].split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();
        // 去掉成对引号
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key) meta[key] = value;
    }

    return {
        id: (meta.id || fallbackId || '').trim(),
        name: (meta.name || '').trim(),
        icon: (meta.icon || '').trim(),
        instruction: match[2].trim(),
        inputText: meta.inputText === 'true',
        inputImages: meta.inputImages === 'true',
        requireImages: meta.requireImages === 'true'
    };
}

/**
 * 创建用户技能路由
 * @param {Object} options - 依赖项
 * @param {string} options.skillsDir - 用户技能文件夹（data/skills）
 * @returns {express.Router} Express 路由实例
 */
function createSkillsRouter({ skillsDir }) {
    const router = express.Router();

    async function ensureDir() {
        await fs.mkdir(skillsDir, { recursive: true });
    }

    /**
     * 校验并规整技能数据；无效返回 null
     * icon 只接受图标键名（如 "zap"），由前端映射为线稿 SVG，杜绝注入
     */
    function sanitizeSkill(input) {
        if (!input || typeof input !== 'object') return null;
        const id = String(input.id || '').trim();
        const name = String(input.name || '').trim();
        const instruction = String(input.instruction ?? '');
        if (!ID_PATTERN.test(id)) return null;
        if (!name || !instruction.trim()) return null;
        return {
            id,
            name: name.slice(0, 50),
            icon: typeof input.icon === 'string' ? input.icon.trim().slice(0, 30) : '',
            instruction: instruction.slice(0, 8000),
            inputText: !!input.inputText,
            inputImages: !!input.inputImages,
            requireImages: !!input.requireImages
        };
    }

    /**
     * 读取单个技能文件（按扩展名分发：.md 走解析器，.json 走旧格式），无效返回 null
     */
    async function readSkillFile(file) {
        const filePath = path.join(skillsDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        let raw = null;
        if (file.endsWith('.md')) {
            raw = parseSkillMd(content, path.basename(file, '.md'));
        } else if (file.endsWith('.json')) {
            raw = JSON.parse(content);
        }
        return raw ? sanitizeSkill(raw) : null;
    }

    /**
     * GET /
     * 列出全部用户技能（.md 优先于同名 .json；损坏的文件跳过并在服务端告警）
     */
    router.get('/', async (req, res) => {
        try {
            await ensureDir();
            const files = (await fs.readdir(skillsDir))
                .filter((f) => f.endsWith('.md') || f.endsWith('.json'))
                .sort((a, b) => {
                    const baseA = a.replace(/\.(md|json)$/, '');
                    const baseB = b.replace(/\.(md|json)$/, '');
                    if (baseA !== baseB) return baseA.localeCompare(baseB, 'zh');
                    return a.endsWith('.md') ? -1 : 1;   // 同名时 .md 优先
                });

            const skills = [];
            const seenIds = new Set();
            for (const file of files) {
                try {
                    const skill = await readSkillFile(file);
                    if (!skill) {
                        console.warn(`跳过无效的用户技能文件 ${file}: 字段不完整`);
                        continue;
                    }
                    if (seenIds.has(skill.id)) continue;   // 同 id 已收录（.md 优先）
                    seenIds.add(skill.id);
                    skills.push(skill);
                } catch (e) {
                    console.warn(`跳过无效的用户技能文件 ${file}: ${e.message}`);
                }
            }
            skills.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
            res.json({ status: 'ok', skills });
        } catch (error) {
            console.error('读取用户技能失败:', error);
            res.status(500).json({ status: 'error', message: error.message || '读取技能失败' });
        }
    });

    /**
     * POST /
     * 保存技能（存在同 id 则覆盖，写为 .json）。字段校验见 sanitizeSkill
     */
    router.post('/', async (req, res) => {
        try {
            const skill = sanitizeSkill(req.body);
            if (!skill) {
                return res.status(400).json({
                    status: 'error',
                    message: '技能数据无效：需要 id（字母/数字/连字符）、name、instruction'
                });
            }
            await ensureDir();
            await fs.writeFile(
                path.join(skillsDir, `${skill.id}.json`),
                JSON.stringify(skill, null, 2),
                'utf-8'
            );
            res.json({ status: 'ok', skill });
        } catch (error) {
            console.error('保存用户技能失败:', error);
            res.status(500).json({ status: 'error', message: error.message || '保存技能失败' });
        }
    });

    /**
     * DELETE /:id
     * 删除技能文件（.md 与 .json 都尝试删除；不存在时静默成功）
     */
    router.delete('/:id', async (req, res) => {
        try {
            const id = String(req.params.id || '');
            if (!ID_PATTERN.test(id)) {
                return res.status(400).json({ status: 'error', message: '无效的技能 id' });
            }
            await fs.unlink(path.join(skillsDir, `${id}.md`)).catch(() => {});
            await fs.unlink(path.join(skillsDir, `${id}.json`)).catch(() => {});
            res.json({ status: 'ok' });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message || '删除技能失败' });
        }
    });

    return router;
}

module.exports = createSkillsRouter;
// 导出解析器供测试使用
module.exports.parseSkillMd = parseSkillMd;
