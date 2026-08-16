@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

:: 服务端口，需与 server.js 中 listen 的端口保持一致
set PORT=8080

echo ==========================================
echo    LumenLight 后端启动脚本
echo ==========================================
echo.

:: ------------------------------------------------------------------
:: [1/2] 释放端口
:: 只结束占用本项目端口的进程，避免影响机器上其他 Node 服务。
:: netstat 输出中 LISTENING 行的第 5 列为 PID。
:: 注意：同一服务会同时监听 IPv4 与 IPv6，netstat 因此输出两行相同 PID，
::       故用 KILLED 变量记录已处理的 PID，避免重复 taskkill 产生误导性报错。
:: ------------------------------------------------------------------
echo [1/2] 正在检查端口 %PORT% 占用情况...

set KILLED=
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
    if not "%%P" == "0" if "!KILLED!" == "" (
        echo      检测到端口被进程 PID=%%P 占用，正在结束...
        taskkill /F /PID %%P >nul 2>nul
        if errorlevel 1 (
            echo      [X] 无法结束进程 PID=%%P，请尝试以管理员身份运行
        ) else (
            echo      [OK] 已结束进程 PID=%%P
        )
        set KILLED=%%P
    )
)

if "!KILLED!" == "" (
    echo      [i] 端口 %PORT% 当前空闲
) else (
    rem 端口释放存在 TIME_WAIT 延迟，等待约 2 秒避免 EADDRINUSE。
    rem 用 ping 而非 timeout：timeout 在无交互输入的环境下会报错退出。
    rem 此处必须用 rem 而非 :: —— 括号块内的 :: 会被当作卷标解析而报错。
    ping -n 3 127.0.0.1 >nul
)

:: 清除上面命令遗留的错误码，避免影响末尾对 node 退出码的判断
(call )

:: ------------------------------------------------------------------
:: 选择 Node：优先使用项目自带的绿色版 Node（runtime/node.exe），
:: 整合包用户解压即用、无需安装；未捆绑时回退到系统 PATH 中的 node。
:: ------------------------------------------------------------------
set "NODE_EXE=%~dp0runtime\node.exe"
if exist "%NODE_EXE%" (
    set "NODE_CMD=%NODE_EXE%"
    echo      使用内置 Node（绿色版，无需安装）
) else (
    set "NODE_CMD=node"
    echo      使用系统 Node
)

echo.
echo [2/2] 正在启动 LumenLight 后端...
echo（--watch 热重载：修改 routes/ server.js 等后端代码后自动重启，无需手动操作）
echo.
echo ==========================================
"%NODE_CMD%" --watch server.js

:: 若 Node 异常退出，保留窗口以便查看错误信息
if errorlevel 1 (
    echo.
    echo ==========================================
    echo 后端异常退出，错误码: %errorlevel%
    pause
)

endlocal
