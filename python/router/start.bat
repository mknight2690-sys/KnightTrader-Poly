@echo off
REM ====================================================================
REM  free-claude-router launcher
REM  Starts the local multi-provider proxy, waits for it to come up,
REM  then launches Claude Code. Claude Code's ~/.claude/settings.json
REM  already points it at this proxy (port 8082, token freecc), so no
REM  env vars need to be set here.
REM
REM  The proxy rotates across all providers in providers.json
REM  (OpenRouter, DeepSeek, Kimi, SiliconFlow, Qwen, GLM) and their
REM  keys/models, dodging rate limits automatically.
REM ====================================================================
setlocal

set HERE=%~dp0
set PY=py -3.12
set PORT=8082
set BASE=http://127.0.0.1:%PORT%

echo.
echo  === free-claude-router ===
echo  Starting multi-provider proxy on %BASE% ...
echo.

REM Boot the router in its own window so you can watch the key/model logs.
start "free-claude-router" %PY% "%HERE%router.py"

REM Wait for the proxy to answer the health endpoint.
set /a TRIES=0
:waitloop
timeout /t 1 /nobreak >nul
set /a TRIES+=1
powershell -NoProfile -Command "try { (Invoke-RestMethod -Uri '%BASE%/' -TimeoutSec 3).status | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  if %TRIES% lss 15 (
    goto waitloop
  ) else (
    echo  ERROR: proxy did not start within 15 seconds.
    echo  Check the free-claude-router window for errors.
    pause
    exit /b 1
  )
)

echo  Proxy is up. Launching Claude Code...
echo.
echo  Watch the free-claude-router window to see which provider/key/model
echo  served each request.
echo.

REM settings.json handles ANTHROPIC_BASE_URL / token / model aliases.
claude %*

endlocal
