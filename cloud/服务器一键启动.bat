@echo off
chcp 65001 >nul
setlocal

rem NOTE: keep every rem comment ASCII-only in this file.
rem cmd's batch parser tracks line positions by BYTE offset, which can land
rem mid-character in UTF-8 multi-byte text and garble the rest of the line.
rem Chinese text is allowed in plain echo lines (after chcp 65001), but NEVER
rem inside for/if one-liner constructs and never full-width punctuation in
rem parser constructs (proven failure: phantom command from a split line).

rem One-click server bootstrap for the headless backend package:
rem   first run  -> npm install backend deps + cloud gateway deps
rem   every run  -> start backend (server.js :8080) and gateway (:8081)
rem                 each in its own console window (close window = stop it)
rem Long-term daemon setup (NSSM) is documented in the cloud deploy guide
rem (a Chinese markdown doc inside the cloud folder).

rem cd to script dir (zip extract root)
cd /d "%~dp0"

rem check node.js is installed
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装：https://nodejs.org/ 装完重新双击本脚本。
    pause
    exit /b 1
)

echo ==========================================
echo    LumenLight 云端服务一键启动
echo ==========================================
echo.

rem [1/3] install backend production deps on first run
if not exist "node_modules\express\package.json" (
    echo [1/3] 首次运行：安装后端依赖，可能需要几分钟，请耐心等待...
    call npm install --omit=dev
    if errorlevel 1 (
        echo [错误] 后端依赖安装失败，请检查服务器网络后重试。
        pause
        exit /b 1
    )
) else (
    echo [1/3] 后端依赖已就绪，跳过安装。
)

rem [2/3] install cloud gateway deps on first run
if not exist "cloud\node_modules\http-proxy\package.json" (
    echo [2/3] 首次运行：安装网关依赖...
    pushd cloud
    call npm install
    if errorlevel 1 (
        echo [错误] 网关依赖安装失败，请检查服务器网络后重试。
        popd
        pause
        exit /b 1
    )
    popd
) else (
    echo [2/3] 网关依赖已就绪，跳过安装。
)

rem [3/3] start backend and gateway, each in its own console window
echo [3/3] 启动后端与网关，各占一个窗口，关闭窗口即停止对应服务...
start "LumenLight 后端 8080" node server.js
start "LumenLight 网关 8081" node cloud\gateway.js

echo.
echo 两个服务已启动。长期常驻建议改用 NSSM 注册系统服务，见 cloud\部署说明.md。
if exist "cloud\config.json" (
    echo 网关访问码：打开 cloud\config.json 查看 token 字段。
) else (
    echo 网关首次启动会生成 cloud\config.json，其中 token 字段就是访问码。
)
echo 本机入口 http://localhost:8081 ，远程用 http://服务器IP:8081 或你的域名。
echo.
pause
