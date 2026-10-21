// 更新包打包工具：把「纯代码」收集成更新 zip + version.json（上传 GitHub Releases 用）。
//
// 用法：node tools/make-update-package.js [--version x.y.z]
//   --version 不传时取 package.json 的 version 字段。
//
// 产物（dist/ 下，已 gitignore）：
//   lumen-update.zip   更新包（解压后与项目根对齐，代码文件直接覆盖）
//   version.json       清单：版本号 / 下载直链 / SHA256——与 zip 一起作为
//                      Release 附件上传；update.bat 从 Releases latest 直链
//                      拉取本文件决定是否更新与校验完整性
//
// 范围约定（与 update.bat 的 PKG_DIR_LIST / 根文件清单同源，两处须同步改）：
//   目录：css js routes utils pi-extensions workflows image tools lumen_nodes
//   根文件：index.html help.html server.js package.json package-lock.json
//           start-server.bat 清理缓存.bat 说明.txt update.bat
//   绝不入包：data/（用户数据与 API Key）、save/、tag/、docs/（开发者文档）、
//             runtime/ pi/ models/ node_modules/（体积大，随完整安装包分发）

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');
const STAGE_DIR = path.join(OUT_DIR, 'staging');
const ZIP_PATH = path.join(OUT_DIR, 'lumen-update.zip');
const VERSION_JSON_PATH = path.join(OUT_DIR, 'version.json');
const RELEASE_BASE = 'https://github.com/WLDFC/lumen-light/releases/latest/download';
const ZIP_NAME = 'lumen-update.zip';

// Windows 系统自带 bsdtar（System32），支持 -a 按扩展名生成 zip；
// 不用 PowerShell Compress-Archive：其 5.1 版对中文条目名按系统代码页编码，
// 跨机器解压有乱码风险；bsdtar 写 UTF-8 标志位，两端一致。
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

const PACKAGE_DIRS = ['css', 'js', 'routes', 'utils', 'pi-extensions', 'workflows', 'image', 'tools', 'lumen_nodes'];
const PACKAGE_ROOT_FILES = [
  'index.html', 'help.html', 'server.js', 'package.json', 'package-lock.json',
  'start-server.bat', '清理缓存.bat', '说明.txt', 'update.bat',
];

function collectFiles(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) collectFiles(full, base, out);
    else if (entry.isFile()) out.push(rel);
  }
}

function main() {
  const versionArgIdx = process.argv.indexOf('--version');
  const versionOverride = versionArgIdx > -1 ? process.argv[versionArgIdx + 1] : null;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = versionOverride || pkg.version;
  if (!version) fail('无法确定版本号（package.json 无 version 且未传 --version）');

  // 1. 清空暂存区
  fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  fs.mkdirSync(STAGE_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 2. 收集目录文件
  const manifest = [];
  for (const dir of PACKAGE_DIRS) {
    const src = path.join(ROOT, dir);
    if (!fs.existsSync(src)) fail(`打包目录不存在：${dir}`);
    const files = [];
    collectFiles(src, ROOT, files);
    for (const rel of files) {
      fs.mkdirSync(path.dirname(path.join(STAGE_DIR, rel)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), path.join(STAGE_DIR, rel));
      manifest.push(rel.split(path.sep).join('/'));
    }
  }

  // 3. 收集根级文件
  for (const name of PACKAGE_ROOT_FILES) {
    const src = path.join(ROOT, name);
    if (!fs.existsSync(src)) {
      console.warn(`[警告] 根文件缺失，跳过：${name}`);
      continue;
    }
    fs.copyFileSync(src, path.join(STAGE_DIR, name));
    manifest.push(name);
  }
  manifest.sort();

  // 4. 打 zip（条目相对项目根对齐，tar -C 进暂存区）
  fs.rmSync(ZIP_PATH, { force: true });
  execFileSync(TAR, ['-a', '-cf', ZIP_PATH, ...PACKAGE_DIRS, ...PACKAGE_ROOT_FILES], {
    cwd: STAGE_DIR,
    stdio: 'inherit',
  });

  // 5. 算 SHA256、写 version.json
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(ZIP_PATH)).digest('hex');
  const versionJson = {
    version,
    url: `${RELEASE_BASE}/${ZIP_NAME}`,
    sha256,
    fileCount: manifest.length,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(VERSION_JSON_PATH, JSON.stringify(versionJson, null, 2) + '\n', 'utf8');

  // 6. 清理暂存区
  fs.rmSync(STAGE_DIR, { recursive: true, force: true });

  const zipSize = (fs.statSync(ZIP_PATH).size / 1024 / 1024).toFixed(2);
  console.log('打包完成：');
  console.log(`  ${ZIP_PATH}  (${zipSize} MB, ${manifest.length} 个文件)`);
  console.log(`  ${VERSION_JSON_PATH}  (version=${version})`);
  console.log('下一步：GitHub 仓库页 → Releases → Draft a new release →');
  console.log(`  tag 填 v${version}，上传上面两个文件为附件，Publish 即可。`);
}

function fail(msg) {
  console.error(`[打包失败] ${msg}`);
  process.exit(1);
}

main();
