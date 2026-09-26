@echo off
REM === Stop the free-claude-router server ===
setlocal
set HERE=%~dp0
set PY=py -3.12
echo.
echo  Stopping free-claude-router (finding process on port 8082)...
%PY% "%HERE%stop.py"
echo.
pause
endlocal
