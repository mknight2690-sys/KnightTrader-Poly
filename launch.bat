@echo off
cd /d "%~dp0"
echo Starting KnightTrader...

set "ELECTRON=node_modules\electron\dist\electron.exe"
if exist "%ELECTRON%" (
  "%ELECTRON%" .
  if errorlevel 1 goto :failed
  exit /b 0
)

where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: Electron not found and npm is not on PATH.
  goto :failed
)

echo Bundled Electron missing — trying npm start...
call npm start
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo KnightTrader failed to start.
pause
exit /b 1
