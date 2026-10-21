@echo off
rem ============================================================
rem Standalone release panel launcher (ASCII-only, keep CRLF).
rem Starts tools\release\serve.js (127.0.0.1:8130) which serves
rem the panel page and opens it in the default browser.
rem Independent from the LumenLight main backend - works even
rem when start-server is not running.
rem ============================================================
start "LumenLight ReleasePanel" /min node "%~dp0serve.js"
