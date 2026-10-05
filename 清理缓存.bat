@echo off
chcp 65001 >nul
setlocal

rem 切换到脚本所在目录, 保证相对路径 (runtime\node.exe, tools\cleanup.js) 正确解析
cd /d "%~dp0"

rem LumenLight 项目清理工具: 双击执行, 交互式分层清理临时文件
rem 参数会透传给 tools\cleanup.js ( --yes 只清安全层 / --deep 含深度层 )

rem 选择 Node: 优先项目内置绿色版 runtime\node.exe, 未捆绑时回退系统 node
set "NODE_EXE=%~dp0runtime\node.exe"
if exist "%NODE_EXE%" (
    set "NODE_CMD=%NODE_EXE%"
) else (
    set "NODE_CMD=node"
)

"%NODE_CMD%" tools\cleanup.js %*

rem 仅双击启动时暂停窗口便于查看结果; 从终端运行时不暂停
echo %cmdcmdline% | findstr /i /c:"%~dp0" >nul && pause

endlocal
