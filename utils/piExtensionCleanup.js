/**
 * ==========================================================================
 * pi 遗留全局扩展清理器（piExtensionCleanup）
 * ==========================================================================
 * 作用：清掉 pi 全局扩展目录（~/.pi/agent/extensions/，或 PI_CODING_AGENT_DIR
 *       指向的 agent 目录下 extensions/）里历史版本同步进去的 lumen-*.ts，
 *       供 piAgentManager 每次拉起 pi 前调用。
 *
 * 背景：扩展加载已改为项目级——spawn 命令行 -e 直接加载 pi-extensions/
 * 源码（见 piAgentManager.js），全局目录不再是扩展来源。但旧版本后端曾把
 * 全部扩展差量同步进全局目录，而 pi 的自动发现对全局目录无条件生效：
 * 不清掉的话，画布系工具会泄漏进同机其他项目里启动的任何 pi 实例。
 *
 * 设计：
 *   - 幂等：按「pi-extensions/ 下现存 .ts 文件名」匹配目标目录同名文件，
 *     存在即删；清干净后每次拉起只剩几次 statSync 探测，代价可忽略；
 *   - 按名不按内容：只要同名就删（包括内容与当前源码一致的副本）——
 *     全局目录里的 lumen-*.ts 一律视为本项目扩展的遗留，不区分版本；
 *   - 不碰目标目录里名字不在 pi-extensions/ 清单内的文件（用户自装的
 *     扩展、其他项目的工具一律不动）；
 *   - 源目录/目标目录不存在或不可读时静默返回（发行包残缺、全新安装
 *     都不算错误）；
 *   - 目标目录解析与 pi 自身 getAgentDir() 同源：PI_CODING_AGENT_DIR
 *     环境变量优先（支持 ~ 前缀），否则 ~/.pi/agent/extensions；
 *   - 删除由后端 Node 执行，与 lumen-guard 写门禁无关（门禁管的是
 *     pi 对项目内文件的写入）。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/** ~ 前缀展开（与 pi 的 expandTildePath 同语义的最小子集：~/ 与裸 ~） */
function expandTilde(p) {
    if (p === '~') return os.homedir();
    if (p.startsWith('~/') || p.startsWith('~\\')) {
        return path.join(os.homedir(), p.slice(2));
    }
    return p;
}

/**
 * 清除全局扩展目录里的 lumen-*.ts 遗留副本
 * @param {Object} [options]
 * @param {string} [options.projectRoot] - 项目根（默认按本模块位置推导）
 * @param {string} [options.targetDir] - pi 全局扩展目录（默认按 getAgentDir
 *        同源规则解析；测试用例经此参数隔离真实全局目录）
 * @returns {{removed: string[], errors: string[]}}
 *   removed=已删除文件名列表 errors=逐文件失败原因
 */
function cleanupLegacyGlobalExtensions({ projectRoot, targetDir } = {}) {
    projectRoot = projectRoot || path.resolve(__dirname, '..');
    if (!targetDir) {
        if (process.env.PI_CODING_AGENT_DIR) {
            // 环境变量指向 agent 目录本身，扩展在其下 extensions/ 子目录
            targetDir = path.join(expandTilde(process.env.PI_CODING_AGENT_DIR), 'extensions');
        } else {
            targetDir = path.join(os.homedir(), '.pi', 'agent', 'extensions');
        }
    }

    const result = { removed: [], errors: [] };

    // 匹配清单 = 项目 pi-extensions/ 下现存的 .ts 文件名。
    // 源目录缺失（发行包残缺等）无从判断该删哪些：静默放弃，不算错误
    let names;
    try {
        names = new Set(fs.readdirSync(path.join(projectRoot, 'pi-extensions'))
            .filter(n => n.endsWith('.ts')));
    } catch {
        return result;
    }

    // 全局目录不存在/不可读 = 没有遗留，无需清理
    let entries;
    try {
        entries = fs.readdirSync(targetDir);
    } catch {
        return result;
    }

    for (const name of entries) {
        if (!names.has(name)) continue;
        const dest = path.join(targetDir, name);
        try {
            if (!fs.statSync(dest).isFile()) continue;   // 同名子目录不碰
            fs.rmSync(dest, { force: true });
            result.removed.push(name);
        } catch (err) {
            result.errors.push(`${name}: ${err.message}`);
        }
    }
    return result;
}

module.exports = { cleanupLegacyGlobalExtensions };
