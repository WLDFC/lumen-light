@echo off
chcp 65001 >nul
setlocal

rem NOTE: keep every rem comment ASCII-only in this file.
rem cmd's batch parser tracks line positions by BYTE offset, which can land
rem mid-character in UTF-8 multi-byte text and garble the rest of the line.
rem User-facing echo lines are fine (UTF-8 after chcp 65001).

rem One-click headless server packer: runs cloud\pack-server.js and opens
rem the output folder. Double-click friendly (window stays on pause).

rem cd to project root (bat lives in cloud\)
cd /d "%~dp0.."

rem pick node: prefer bundled runtime\node.exe, fall back to system node
set "NODE_EXE=%~dp0..\runtime\node.exe"
if exist "%NODE_EXE%" (
    set "NODE_CMD=%NODE_EXE%"
) else (
    set "NODE_CMD=node"
)

echo ==========================================
echo    LumenLight 无头后端一键打包
echo ==========================================
echo.

echo [1/2] 正在打包（后端+前端本体+cloud 网关，不含 GPU 大件与本地数据）...
"%NODE_CMD%" cloud\pack-server.js
if errorlevel 1 (
    echo.
    echo [失败] 打包出错，请查看上方报错信息。
    pause
    exit /b 1
)

echo.
echo [2/2] 完成！上传到服务器的文件（大小见下行，单位字节）：
for %%F in ("cloud\dist\lumen-server-headless.zip") do echo     %%~fF (%%~zF bytes)
echo.
echo 服务器端步骤见 cloud\部署说明.md（解压 → npm install --omit=dev → 起服务）。

rem open the output folder so the zip is one click away
start "" "cloud\dist"

pause
