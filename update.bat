@echo off
setlocal
chcp 65001 >nul
title LumenLight Update

rem ============================================================
rem LumenLight self-updater launcher (thin ASCII shell).
rem KEEP THIS FILE ASCII-ONLY AND CRLF - cmd's batch parser
rem tracks line positions by BYTE offset and mis-parses multibyte
rem text; all real logic lives in tools\update.ps1 (PowerShell
rem handles UTF-8 natively). The ps1 ships inside the update
rem package, so the updater updates itself too.
rem
rem Test hooks (env vars, consumed by tools\update.ps1):
rem   LUMEN_UPDATE_BASE / LUMEN_UPDATE_FORCE=1 /
rem   LUMEN_UPDATE_SKIP_PROC_CHECK=1 / LUMEN_UPDATE_YES=1
rem ============================================================

cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\update.ps1"
endlocal
