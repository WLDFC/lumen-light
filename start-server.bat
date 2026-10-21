@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

rem NOTE: keep every rem comment ASCII-only in this file.
rem cmd's batch parser tracks line positions by BYTE offset, which can land
rem mid-character in UTF-8 multi-byte text and garble the rest of the line
rem into a phantom "command" (red 'xxx is not recognized' noise at startup).

rem cd to script dir so relative paths (runtime\node.exe, server.js) resolve
cd /d "%~dp0"

rem server port, must match server.js listen port
set PORT=8080

echo ==========================================
echo    LumenLight 后端启动脚本
echo ==========================================
echo.

rem kill stale watcher node processes that could re-spawn server and grab port
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'watch-path' -and $_.CommandLine -match 'server\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul

echo [1/2] 检查端口 %PORT% 占用...
set KILLED=
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
    if not "%%P" == "0" if "!KILLED!" == "" (
        echo      端口被进程 PID=%%P 占用, 正在结束...
        taskkill /F /PID %%P >nul 2>nul
        if errorlevel 1 (
            echo      [X] 无法结束进程 PID=%%P, 请以管理员身份运行后重试
        ) else (
            echo      [OK] 已结束进程 PID=%%P
        )
        set KILLED=%%P
    )
)
if "!KILLED!" == "" (
    echo      端口 %PORT% 空闲
) else (
    rem port release has TIME_WAIT delay, wait ~2s; inside ( ) must use rem not ::
    ping -n 3 127.0.0.1 >nul
)
(call )

rem pick node: prefer bundled runtime\node.exe, fall back to system node
set "NODE_EXE=%~dp0runtime\node.exe"
if exist "%NODE_EXE%" (
    set "NODE_CMD=%NODE_EXE%"
    echo      使用内置 Node
) else (
    set "NODE_CMD=node"
    echo      使用系统 Node
)

echo [2/2] 启动 LumenLight 后端...
echo      稳定模式: 未启用热重载, 修改后端代码后需重启本脚本生效
echo ==========================================

rem Stable mode: node --watch force-kills the server process tree, and pi
rem (a child of server) dies with it, interrupting long tasks. So no hot
rem reload; restart this script manually after backend changes. Console
rem output is mirrored to data\pi\server-console.log for post-mortem.
if not exist "%~dp0data\pi" mkdir "%~dp0data\pi"
rem rebuild log above 5MB to avoid unbounded growth
if exist "%~dp0data\pi\server-console.log" for %%A in ("%~dp0data\pi\server-console.log") do if %%~zA gtr 5000000 del "%%~A" >nul 2>nul
powershell -NoProfile -Command "& '%NODE_CMD%' server.js 2>&1 | Tee-Object -FilePath '%~dp0data\pi\server-console.log' -Append; exit $LASTEXITCODE"

rem pause window on abnormal node exit so the error stays visible
if errorlevel 1 (
    echo.
    echo ==========================================
    echo 后端异常退出, 错误码: %errorlevel%
    pause
)

endlocal
