/**
 * ==========================================================================
 * pi 扩展同步器（piExtensionSync）
 * ==========================================================================
 * 作用：把项目 pi-extensions/*.ts 差量复制到 pi 的全局扩展目录
 *       （~/.pi/agent/extensions/），供 piAgentManager 每次拉起 pi 前调用。
 *
 * 为什么需要：pi 只从全局扩展目录自动发现扩展，而发行包用户的这个目录
 * 是空的——没有同步的话 agent 模式就是裸助手（无画布工具/技能库/MCP 桥/
 * 联网工具）。差量同步让发行包「解压即用」：首次开 agent 模式自动安装，
 * 更新发行包后重启后端自动升级，全程无手动步骤。
 *
 * 设计：
 *   - 差量：目标文件存在且内容一致 → 跳过（每次启动的代价是几次文件
 *     比对，毫秒级）；缺失或内容不同 → 复制覆盖（项目源码是唯一真源）；
 *   - 同步范围：pi-extensions/ 下全部 .ts 文件（新增扩展自动纳入，
 *     无需维护清单）。lumen-guard.ts 也会被同步过去，但它实际由
 *     spawn 命令行 -e 从项目目录显式加载（不依赖信任状态、RPC 模式
 *     下不静默失效），C 盘副本只是无害冗余；
 *   - 不碰目标目录里非本项目的文件（用户自装的扩展不动）；
 *   - 单文件失败不阻塞其余，结果汇总返回由调用方记日志；
 *   - 复制由后端 Node 执行，与 lumen-guard 写门禁无关（门禁管的是
 *     pi 对项目内文件的写入）。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * 差量同步 pi-extensions/*.ts → pi 全局扩展目录
 * @param {Object} [options]
 * @param {string} [options.projectRoot] - 项目根（默认按本模块位置推导）
 * @param {string} [options.targetDir] - pi 全局扩展目录（默认 ~/.pi/agent/extensions）
 * @returns {{installed: number, updated: number, skipped: number,
 *            synced: number, errors: string[]}}
 *   installed=新装 updated=覆盖升级 skipped=内容一致跳过
 *   synced=实际写入数（installed+updated） errors=逐文件失败原因
 */
function syncPiExtensions({ projectRoot, targetDir } = {}) {
    projectRoot = projectRoot || path.resolve(__dirname, '..');
    targetDir = targetDir ||
        path.join(os.homedir(), '.pi', 'agent', 'extensions');
    const srcDir = path.join(projectRoot, 'pi-extensions');

    const result = { installed: 0, updated: 0, skipped: 0, synced: 0, errors: [] };

    let entries;
    try {
        entries = fs.readdirSync(srcDir);
    } catch {
        // 源目录不存在（发行包残缺等）：不算致命，pi 仍可启动（只是裸的）
        result.errors.push('pi-extensions 源目录不存在');
        return result;
    }

    try {
        fs.mkdirSync(targetDir, { recursive: true });
    } catch (err) {
        result.errors.push(`扩展目录无法创建：${err.message}`);
        return result;
    }

    for (const name of entries) {
        if (!name.endsWith('.ts')) continue;
        const src = path.join(srcDir, name);
        const dest = path.join(targetDir, name);
        try {
            if (!fs.statSync(src).isFile()) continue;
            if (fs.existsSync(dest) &&
                fs.readFileSync(dest, 'utf8') === fs.readFileSync(src, 'utf8')) {
                result.skipped++;
                continue;
            }
            const existed = fs.existsSync(dest);
            fs.copyFileSync(src, dest);
            if (existed) result.updated++; else result.installed++;
            result.synced++;
        } catch (err) {
            result.errors.push(`${name}: ${err.message}`);
        }
    }
    return result;
}

module.exports = { syncPiExtensions };
