# LumenLight 在线更新主逻辑（根目录 update.bat 是薄壳，调起本脚本）。
# PowerShell 原生处理 UTF-8/JSON/哈希，避开 cmd 批处理解析多字节的坑。
# 本文件必须保存为 UTF-8 with BOM + CRLF（PS5.1 无 BOM 按 ANSI 解析会乱码）。
#
# 测试钩子（环境变量，由 update.bat 透传）：
#   LUMEN_UPDATE_BASE             下载基址覆盖（本地假服务器冒烟测试用）
#   LUMEN_UPDATE_FORCE=1          跳过「已是最新」提前退出
#   LUMEN_UPDATE_SKIP_PROC_CHECK=1 跳过 node 进程检查
#   LUMEN_UPDATE_YES=1            跳过人工确认
#
# 包范围必须与 tools/release/make-update-package.js 保持一致。

# 不用 Stop：PS5.1 下原生命令（curl 等）的 stderr 输出会被升级成终止错误；
# 各步骤靠 $LASTEXITCODE 与产物存在性检查显式兜底。
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$ReleaseBase = 'https://github.com/WLDFC/lumen-light/releases/latest/download'
$MirrorPrefix = 'https://gh-proxy.com/'
if ($env:LUMEN_UPDATE_BASE) { $ReleaseBase = $env:LUMEN_UPDATE_BASE }

$PackageDirs = @('css','js','routes','utils','pi-extensions','workflows','image','tools','lumen_nodes')
$PackageRootFiles = @('index.html','help.html','server.js','package.json','package-lock.json',
  'start-server.bat','清理缓存.bat','说明.txt','update.bat')

function Wait-Exit { [void](Read-Host '按回车键退出'); exit $script:ExitCode }
$script:ExitCode = 0
function Fail([string]$msg) {
  Write-Host ''
  Write-Host "[错误] $msg" -ForegroundColor Red
  $script:ExitCode = 1
  Wait-Exit
}

Write-Host ''
Write-Host '=============================================='
Write-Host '          LumenLight 在线更新'
Write-Host '=============================================='
Write-Host ''

if (-not (Test-Path (Join-Path $Root 'package.json'))) {
  Fail '请把 update.bat 放在项目根目录下运行。'
}

# ---- 1. 本地版本 ----
$localVer = (Get-Content -LiteralPath (Join-Path $Root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if (-not $localVer) { $localVer = '未知' }
Write-Host "当前版本： $localVer"

# ---- 2. 拉取远端 version.json（直连失败换 gh-proxy 镜像，仅 GitHub 官方域名才重试镜像）----
$verJsonPath = Join-Path $env:TEMP 'lumen-version.json'
Remove-Item $verJsonPath -Force -ErrorAction SilentlyContinue
Write-Host '正在检查更新…'
& curl.exe -fsL --connect-timeout 8 --max-time 30 -o $verJsonPath "$ReleaseBase/version.json" 2>$null
if ($LASTEXITCODE -ne 0 -and $ReleaseBase -like 'https://github.com/*') {
  Write-Host '直连失败，改用镜像 gh-proxy.com 重试…'
  & curl.exe -fsL --connect-timeout 8 --max-time 60 -o $verJsonPath "$MirrorPrefix$ReleaseBase/version.json" 2>$null
}
if (-not (Test-Path $verJsonPath)) { Fail '无法获取更新信息，请检查网络后重试。' }

try {
  $remote = Get-Content -LiteralPath $verJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  Fail '更新信息格式异常（version.json 损坏或下载不完整）。'
}
$remoteVer = [string]$remote.version
$remoteSha = [string]$remote.sha256
if (-not $remoteVer) { Fail '更新信息格式异常（version.json 缺少 version 字段）。' }
Write-Host "服务器版本： $remoteVer"
Write-Host ''

# ---- 3. 版本比对与确认 ----
if ($remoteVer -eq $localVer -and $env:LUMEN_UPDATE_FORCE -ne '1') {
  Write-Host '已是最新版本，无需更新。'
  Wait-Exit
}
if ($env:LUMEN_UPDATE_YES -ne '1') {
  $answer = Read-Host "发现新版本 $remoteVer，输入 Y 更新（其他任意键取消）"
  if ($answer -notin @('Y','y')) { Write-Host '已取消。'; Wait-Exit }
}

# ---- 4. 服务端运行中拒绝更新（node.exe = 后端/pi 子进程）----
if ($env:LUMEN_UPDATE_SKIP_PROC_CHECK -ne '1') {
  $nodeProcs = Get-Process node -ErrorAction SilentlyContinue
  if ($nodeProcs) {
    Fail "检测到 node 进程正在运行（PID: $($nodeProcs.Id -join ', ')），可能 LumenLight 服务端尚未关闭。请先关闭 start-server 窗口后重新运行本脚本。"
  }
}

# ---- 5. 下载更新包并校验 ----
# zip 文件名带版本号（lumen-update-<版本>.zip）：优先取 version.json 里 url 的
# 文件名部分（不发版域名无关，LUMEN_UPDATE_BASE 本地假服务器测试照常生效），
# url 缺失时按版本号拼
$zipPath = Join-Path $env:TEMP "lumen-update-$remoteVer.zip"
$zipName = 'lumen-update.zip'
if ($remote.url) {
  $zipName = [IO.Path]::GetFileName([string]$remote.url)
} elseif ($remoteVer -ne '未知') {
  $zipName = "lumen-update-$remoteVer.zip"
}
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
Write-Host "正在下载更新包（$zipName）…"
& curl.exe -fsL --connect-timeout 8 --retry 2 -o $zipPath "$ReleaseBase/$zipName" 2>$null
if ($LASTEXITCODE -ne 0 -and $ReleaseBase -like 'https://github.com/*') {
  Write-Host '直连失败，改用镜像 gh-proxy.com 重试…'
  & curl.exe -fsL --connect-timeout 8 --max-time 600 -o $zipPath "$MirrorPrefix$ReleaseBase/$zipName" 2>$null
}
if (-not (Test-Path $zipPath)) { Fail '更新包下载失败，请检查网络后重试。' }

if ($remoteSha) {
  $zipSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash
  if ($zipSha -ne $remoteSha) {
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
    Fail "更新包完整性校验失败（下载损坏或被篡改），已中止。`n期待： $remoteSha`n实际： $zipSha"
  }
  Write-Host '完整性校验通过。'
} else {
  Write-Host '[警告] 服务器未提供校验值，跳过完整性校验。' -ForegroundColor Yellow
}

# ---- 6. 备份当前代码 ----
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $Root "data\update-backup\$localVer-$ts"
Write-Host "正在备份当前版本到 data\update-backup\…"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
foreach ($dir in $PackageDirs) {
  $src = Join-Path $Root $dir
  if (Test-Path $src) { & robocopy $src (Join-Path $backupDir $dir) /E /NFL /NDL /NJH /NJS | Out-Null }
}
foreach ($name in $PackageRootFiles) {
  $src = Join-Path $Root $name
  if (Test-Path $src) { Copy-Item $src $backupDir -Force }
}
Write-Host '备份完成。'

# 依赖变更检测基准：覆盖前先留一份旧 package-lock
$oldLock = Join-Path $env:TEMP 'lumen-lock-old.json'
Copy-Item (Join-Path $Root 'package-lock.json') $oldLock -Force

# ---- 7. 解压并应用 ----
$extDir = Join-Path $env:TEMP "lumen-update-$remoteVer"
if (Test-Path $extDir) { Remove-Item $extDir -Recurse -Force }
New-Item -ItemType Directory -Path $extDir -Force | Out-Null
& "$env:SystemRoot\System32\tar.exe" -xf $zipPath -C $extDir 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'tar 解压失败，尝试 PowerShell 解压…'
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extDir -Force
}
if (-not (Test-Path (Join-Path $extDir 'package.json'))) {
  Fail '更新包解压失败或内容异常，已中止（原文件未改动）。'
}

Write-Host '正在应用更新…'
foreach ($dir in $PackageDirs) {
  $src = Join-Path $extDir $dir
  if (Test-Path $src) {
    & robocopy $src (Join-Path $Root $dir) /MIR /R:2 /W:2 /NFL /NDL /NJH /NJS | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "更新应用过程中出现复制失败（$dir），可用备份恢复： data\update-backup\$localVer-$ts" }
  }
}
foreach ($name in $PackageRootFiles) {
  $src = Join-Path $extDir $name
  if (Test-Path $src) { Copy-Item $src (Join-Path $Root $name) -Force }
}
Remove-Item $extDir -Recurse -Force
Write-Host '更新应用完成。'

# ---- 8. 依赖清单有变化则 npm install ----
$lockChanged = (Get-FileHash $oldLock).Hash -ne (Get-FileHash (Join-Path $Root 'package-lock.json')).Hash
if ($lockChanged) {
  Write-Host '检测到依赖清单有变化。'
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if ($npm) {
    Write-Host '正在执行 npm install，可能需要几分钟…'
    & npm install --no-audit --no-fund
  } else {
    Write-Host '[注意] 本机未安装 npm，无法自动安装依赖。' -ForegroundColor Yellow
    Write-Host '请在项目目录手动执行 npm install，或重新下载完整安装包。' -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host '=============================================='
Write-Host "更新完成： $localVer -> $remoteVer"
Write-Host "备份位置： data\update-backup\$localVer-$ts"
Write-Host '双击 start-server.bat 重新启动即可生效。'
Write-Host '=============================================='
Write-Host ''
Wait-Exit
