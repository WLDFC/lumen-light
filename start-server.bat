@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

rem 切换到脚本所在目录, 保证相对路径 (runtime\node.exe, server.js) 正确解析
cd /d "%~dp0"

rem 服务端口, 需与 server.js 的监听端口一致
set PORT=8080

echo ==========================================
echo    LumenLight 后端启动脚本
echo ==========================================
echo.

rem 启动前清理残留的旧 watcher 进程, 防止其再次拉起 server 抢占端口
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
    rem 端口释放存在 TIME_WAIT 延迟, 等待约 2 秒; 括号块内必须用 rem 不能用双冒号
    ping -n 3 127.0.0.1 >nul
)
(call )

rem 选择 Node: 优先项目内置绿色版 runtime\node.exe, 未捆绑时回退系统 node
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

rem 稳定模式说明: node --watch 热重载会强制结束 server 进程树, 而 pi 是
rem server 的子进程, 会随之退出, 长任务被中断。因此日常运行不启用热重载,
rem 后端代码改动后手动重启本脚本即可。控制台输出同时写入
rem data\pi\server-console.log, 用于事后排查问题。
if not exist "%~dp0data\pi" mkdir "%~dp0data\pi"
rem 日志超过 5MB 时重建, 避免无限膨胀
if exist "%~dp0data\pi\server-console.log" for %%A in ("%~dp0data\pi\server-console.log") do if %%~zA gtr 5000000 del "%%~A" >nul 2>nul
powershell -NoProfile -Command "& '%NODE_CMD%' server.js 2>&1 | Tee-Object -FilePath '%~dp0data\pi\server-console.log' -Append; exit $LASTEXITCODE"

rem Node 异常退出时暂停窗口, 便于查看错误信息
if errorlevel 1 (
    echo.
    echo ==========================================
    echo 后端异常退出, 错误码: %errorlevel%
    pause
)

endlocal
