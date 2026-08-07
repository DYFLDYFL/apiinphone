@echo off
powershell.exe -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:5173 | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 goto open_only
start "" "http://127.0.0.1:5173"
cd /d C:\code\apiinphone
npm run dev -- --host 127.0.0.1
exit /b 0

:open_only
start "" "http://127.0.0.1:5173"
