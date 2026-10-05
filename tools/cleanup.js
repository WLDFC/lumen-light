/**
 * ==========================================================================
 * LumenLight 项目清理工具（cleanup.bat 的实现层，bat 只负责选 Node 并调起）
 * ==========================================================================
 * 作用：分层清理项目运行期产生的临时文件，避免文件无限累积。
 *
 * 两层设计：
 *   - 安全层（无任何损失）：pi 临时工作区、各类日志、放大临时目录、
 *     桥接日志与临时区（保留 profile 登录态）
 *   - 深度层（有代价，需显式确认）：实时保存恢复槽位（丢失未存档工作
 *     的崩溃恢复）、agent 会话（所有存档上下文清零）、视频工作区
 *     （未归档视频丢失）、桥接浏览器登录态（需重新登录站点）
 *
 * 永不碰（用户数据，刻意不出现在清理清单里）：save/、tag/、
 * data/settings.json、data/prompts.json、data/skills/、data/assets/、
 * workflows/、models/、image/。
 *
 * 用法：
 *   cleanup.bat               交互式：安全层默认 Y，深度层默认 N
 *   cleanup.bat --yes         只执行安全层，不询问（可脚本化）
 *   cleanup.bat --deep        交互式且深度层默认 Y
 *   cleanup.bat --deep --yes  两层全执行，不询问
 *
 * 已知边界：浏览器侧的聊天记录（面板消息快照）存在 IndexedDB 里，
 * 不在项目磁盘上，本工具够不着——它由 LLM 面板的清屏按钮按存档清理。
 *
 * 安全措施：
 *   - 后端运行中（8080 端口监听）拒绝执行：pi 可能正在用 workspace、
 *     autosave 正在写、日志文件被锁；
 *   - 所有删除只清空目录内容并保留目录本身（组件多有 mkdirSync 兜底，
 *     保留目录更稳）；
 *   - 清理清单写死为上面的固定路径，不接受任何参数注入的目标路径。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const readline = require('readline');

const PROJECT_ROOT = path.resolve(__dirname, '..');

// ==================== 清理清单（固定路径，禁止参数注入） ====================

/** 安全层：无损失，随时可删，删除后自动重建 */
const SAFE_TARGETS = [
    { label: 'pi 临时工作区            data/pi/workspace', dir: 'data/pi/workspace' },
    { label: 'pi 生命周期/拦截日志     data/pi/agent.log', file: 'data/pi/agent.log' },
    { label: '后端控制台日志           server-console.log', file: 'server-console.log' },
    { label: '放大临时目录             temp_upscale', dir: 'temp_upscale' },
    { label: '桥接日志与临时区         data/webbridge（保留 profile）', dir: 'data/webbridge/tmp', files: ['data/webbridge/server.log', 'data/webbridge/diagnose.json'] },
];

/** 深度层：有明确代价，须用户确认 */
const DEEP_TARGETS = [
    { label: '实时保存恢复槽位         data/autosave（丢失未存档工作的崩溃恢复）', dir: 'data/autosave' },
    { label: 'agent 会话               data/pi/sessions（所有存档上下文清零）', dir: 'data/pi/sessions', files: ['data/pi/session-map.json'] },
    { label: '视频工作区               data/videos（未归档视频丢失）', dir: 'data/videos' },
    { label: '桥接浏览器登录态         data/webbridge/profile（需重新登录站点）', dir: 'data/webbridge/profile' },
];

// ==================== 基础工具 ====================

const p = (rel) => path.resolve(PROJECT_ROOT, rel);

/** 递归统计目录/文件体积（字节）；目标不存在按 0 */
function sizeOf(target) {
    let st;
    try { st = fs.statSync(target); } catch { return 0; }
    if (st.isFile()) return st.size;
    let total = 0;
    for (const name of fs.readdirSync(target)) {
        total += sizeOf(path.join(target, name));
    }
    return total;
}

const fmt = (bytes) =>
    bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB'
        : bytes >= 1024 ? (bytes / 1024).toFixed(1) + ' KB'
            : bytes + ' B';

/** 清空目录内容并保留目录本身；返回释放的字节数 */
function clearDir(dir) {
    let freed = 0;
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { return 0; }
    for (const name of entries) {
        const full = path.join(dir, name);
        try {
            freed += sizeOf(full);
            fs.rmSync(full, { recursive: true, force: true });
        } catch { /* 单个文件被占用等：跳过，不影响其余 */ }
    }
    return freed;
}

/** 删除单个文件；返回释放的字节数 */
function removeFile(file) {
    try {
        const size = sizeOf(file);
        fs.rmSync(file, { force: true });
        return size;
    } catch { return 0; }
}

/** 执行一组清理目标，逐项报告 */
function runTargets(targets) {
    let total = 0;
    for (const t of targets) {
        let freed = 0;
        if (t.dir) freed += clearDir(p(t.dir));
        for (const f of (t.files || [])) freed += removeFile(p(f));
        if (t.file) freed += removeFile(p(t.file));
        total += freed;
        console.log(`     ${freed > 0 ? '✓' : '·'} ${t.label}  [${fmt(freed)}]`);
    }
    return total;
}

// ==================== 后端运行检测 ====================

/** 8080 端口能否连通（能连通 = 后端在跑）：清理必须避开运行中的后端 */
function backendRunning() {
    return new Promise((resolve) => {
        const sock = net.createConnection({ port: 8080, host: '127.0.0.1' });
        const done = (yes) => { sock.destroy(); resolve(yes); };
        sock.once('connect', () => done(true));
        sock.once('error', () => done(false));
        sock.setTimeout(800, () => done(false));
    });
}

// ==================== 交互 ====================

function ask(rl, question, defaultYes) {
    return new Promise((resolve) => {
        rl.question(`${question}${defaultYes ? ' [Y/n] ' : ' [y/N] '}`, (ans) => {
            const a = (ans || '').trim().toLowerCase();
            if (a === '') return resolve(defaultYes);
            resolve(a === 'y' || a === 'yes');
        });
    });
}

// ==================== 主流程 ====================

(async () => {
    const args = new Set(process.argv.slice(2));
    const deep = args.has('--deep');
    const yes = args.has('--yes');

    // 运行中拒绝执行：日志被锁删不掉是小事，pi 正在用 workspace /
    // autosave 正在写入才是真风险
    if (await backendRunning()) {
        console.error('[X] 检测到后端正在运行（端口 8080）。请先关闭 LumenLight 后端再清理。');
        process.exit(1);
    }

    console.log('==========================================');
    console.log('   LumenLight 项目清理工具');
    console.log('==========================================');
    console.log('[检测] 后端未运行 ✓');
    console.log('');

    // 扫描报体积
    console.log('[扫描] 安全层（无损失）:');
    let safeTotal = 0;
    for (const t of SAFE_TARGETS) {
        let bytes = 0;
        if (t.dir) bytes += sizeOf(p(t.dir));
        for (const f of (t.files || [])) bytes += sizeOf(p(f));
        if (t.file) bytes += sizeOf(p(t.file));
        safeTotal += bytes;
        console.log(`     ${t.label}  [${fmt(bytes)}]`);
    }
    console.log(`     小计: ${fmt(safeTotal)}`);
    console.log('');
    console.log('[扫描] 深度层（有代价）:');
    let deepTotal = 0;
    for (const t of DEEP_TARGETS) {
        let bytes = 0;
        if (t.dir) bytes += sizeOf(p(t.dir));
        for (const f of (t.files || [])) bytes += sizeOf(p(f));
        deepTotal += bytes;
        console.log(`     ${t.label}  [${fmt(bytes)}]`);
    }
    console.log(`     小计: ${fmt(deepTotal)}`);
    console.log('');

    if (safeTotal === 0 && deepTotal === 0) {
        console.log('没有可清理的内容，项目已经很干净。');
        return;
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    let freed = 0;
    if (yes || await ask(rl, '执行安全清理？', true)) {
        console.log('[清理] 安全层:');
        freed += runTargets(SAFE_TARGETS);
    }
    if (deep && (yes || await ask(rl, '执行深度清理？', true))) {
        console.log('[清理] 深度层:');
        freed += runTargets(DEEP_TARGETS);
    }
    rl.close();

    console.log('');
    if (freed > 0) {
        console.log(`完成：释放 ${fmt(freed)}。`);
    } else {
        console.log('未执行任何清理。');
    }
    console.log('提示：浏览器侧聊天记录存于 IndexedDB（不在项目磁盘），');
    console.log('      由 LLM 面板的清屏按钮按存档清理，本工具不涉及。');
})().catch((err) => {
    console.error('[X] 清理失败:', err && err.message ? err.message : err);
    process.exit(1);
});
