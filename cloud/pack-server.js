/**
 * ==========================================================================
 * LumenLight 无头后端打包器（cloud/pack-server.js）
 * ==========================================================================
 * 作用：把公网部署所需的最小集打成 lumen-server-headless.zip——后端+前端
 *       本体 + cloud/ 网关，不含本地 GPU 大件与本地数据（见下方清单）。
 *       服务器有 Node.js 即可：解压 → npm install --omit=dev → 起 server.js
 *       与 cloud/gateway.js。
 *
 * 打包清单：
 *   根文件  server.js / package.json / index.html / help.html /
 *           依赖.txt
 *   整目录  routes/ utils/ js/ css/ image/ workflows/ manga-templates/
 *           lumen_nodes/ cloud/（打包时排除 dist/node_modules/config.json）
 *   不含    pi/（agent 模式选装，缺了其余功能不受影响）、models/ 与
 *           Real-ESRGAN/（本机 GPU 功能，云端弃用）、runtime/（服务器已装
 *           Node）、mcp/（退役）、node_modules（服务器现装）、
 *           data/ save/ tag/（首次启动自动建，本地数据不上传）、
 *           update.bat（自更新会拉整包覆盖，精简部署用重打包升级）
 *
 * 用法：node cloud/pack-server.js
 * 产物：cloud/dist/lumen-server-headless.zip
 * 升级：主项目更新后重跑本脚本重新打包；服务器端覆盖代码文件，
 *       保留 data/ save/ tag/ 与 cloud/config.json（详见部署说明.md）
 * ==========================================================================
 */

'use strict';
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'dist');
const OUT = path.join(OUT_DIR, 'lumen-server-headless.zip');

/** 根级单文件。start-server.bat/update.bat 是本地机脚本，不打进服务器包：
 *  前者只启动后端不带网关、且自带 8080 端口占用清理会杀掉一键启动拉起的
 *  服务（与 服务器一键启动.bat 冲突）；后者的自更新会拉完整发行包覆盖，
 *  与精简部署冲突。服务器包的后端启动入口只有 服务器一键启动.bat。
 *  tools/download-model.js 单独带上：routes/rembg.js 启动加载期就 require
 *  它（云端不用抠图但模块加载链是启动必经），缺了 server.js 直接崩 */
const FILES = ['server.js', 'package.json', 'index.html', 'help.html',
    '依赖.txt', 'tools/download-model.js'];

/** 整目录 */
const DIRS = ['routes', 'utils', 'js', 'css', 'image', 'workflows',
    'manga-templates', 'lumen_nodes'];

/** cloud/ 显式清单（不用 archive.directory——dist 里的 zip 自身会被
    读入导致自引用膨胀；config.json 含访问码永不出包） */
const CLOUD_FILES = ['gateway.js', 'pack-server.js', 'package.json',
    'Caddyfile', '.gitignore', '部署说明.md'];

/** 服务器启动入口：源文件在本目录（不占本地根目录），打包时盖到 zip
    根目录——解压后用户在顶层一眼看到，%~dp0 运行时即解压根，路径自洽 */
const ROOT_STAMPED = ['服务器一键启动.bat'];

// ---- 前置校验：必须在完整项目包里运行 ----
for (const f of [...FILES, ...DIRS,
                 ...CLOUD_FILES.map(f => `cloud/${f}`),
                 ...ROOT_STAMPED.map(f => `cloud/${f}`)]) {
    if (!fs.existsSync(path.join(ROOT, f))) {
        console.error(`❌ 缺少 ${f}——请在完整项目包内运行本脚本`);
        process.exit(1);
    }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const output = fs.createWriteStream(OUT);
const archive = archiver('zip', { zlib: { level: 9 } });

let count = 0;
archive.on('entry', () => { count += 1; });
archive.on('warning', (err) => console.warn('⚠️', err.message));
archive.on('error', (err) => { console.error('❌ 打包失败:', err); process.exit(1); });
output.on('close', () => {
    const mb = (archive.pointer() / 1024 / 1024).toFixed(1);
    console.log(`✅ 打包完成：${OUT}`);
    console.log(`   ${count} 个文件，${mb} MB`);
    console.log('   服务器端：解压 → npm install --omit=dev → 按 cloud/部署说明.md 启动');
});

archive.pipe(output);

for (const f of FILES) {
    archive.file(path.join(ROOT, f), { name: f });
}
for (const d of DIRS) {
    archive.directory(path.join(ROOT, d), d);
}
for (const f of CLOUD_FILES) {
    archive.file(path.join(__dirname, f), { name: `cloud/${f}` });
}
for (const f of ROOT_STAMPED) {
    archive.file(path.join(__dirname, f), { name: f });   // 盖到 zip 根目录
}

archive.finalize();
