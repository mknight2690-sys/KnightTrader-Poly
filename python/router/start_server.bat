@echo off
REM === Start the free-claude-router server ===
setlocal
set HERE=%~dp0
set PY=py -3.12
set PORT=8082
set BASE=http://127.0.0.1:%PORT%

REM If it's already running, don't start a second instance (port would clash).
powershell -NoProfile -Command "try { (Invoke-RestMethod -Uri '%BASE%/' -TimeoutSec 2).status | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 (
  echo.
  echo  free-claude-router is already running on %BASE%.
  echo  Status: http://127.0.0.1:%PORT%/
  echo.
  pause
  exit /b 0
)

echo.
echo  Starting free-claude-router on %BASE% ...
echo  Logs appear in the new "free-claude-router" window.
echo  You can close this window.
echo.

start "free-claude-router" %PY% "%HERE%router.py"

REM Give it a moment, then confirm it came up.
timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "try { (Invoke-RestMethod -Uri '%BASE%/' -TimeoutSec 5).status | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo  WARNING: proxy not reachable yet. Check the "free-claude-router" window for errors.
  pause
) else (
  echo  Proxy is up. Claude Code will use it automatically.
  timeout /t 2 /nobreak >nul
)
endlocal
