@echo off
REM ====================================================================
REM  free-claude-router tunnel launcher (for Cursor)
REM  Cursor's "Override OpenAI Base URL" is called from Cursor's CLOUD
REM  servers, so a localhost URL is rejected ("Access to private networks
REM  is forbidden"). ngrok exposes the local router (port 8082) on a
REM  public HTTPS URL that Cursor's servers can reach.
REM
REM  The public URL is RANDOM each start (ngrok free tier). It is printed
REM  below and copied to the clipboard -- paste it into Cursor:
REM    Settings -> Models -> Override OpenAI Base URL
REM    ->  https://<this-url>.ngrok-free.app/v1   (keep the /v1 !)
REM ====================================================================
setlocal
set PORT=8082

echo.
echo  === free-claude-router tunnel (for Cursor) ===
echo  Exposing http://127.0.0.1:%PORT% to the public internet via ngrok ...
echo.

REM Make sure the router is up first.
powershell -NoProfile -Command "try { (Invoke-RestMethod -Uri 'http://127.0.0.1:%PORT%/' -TimeoutSec 3).status | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo  ERROR: router is not running on port %PORT%.
  echo  Run "Start free-claude-router" first.
  pause
  exit /b 1
)

REM Start ngrok in its own window so you can see request logs.
start "free-claude-router tunnel (ngrok)" ngrok http %PORT% --log=stdout

REM Wait for ngrok's local API to publish the public URL, then print + copy it.
powershell -NoProfile -Command "$url=$null; for($i=0;$i -lt 30;$i++){try{$t=Invoke-RestMethod http://127.0.0.1:4040/api/tunnels -TimeoutSec 2; $url=($t.tunnels|Where-Object{$_.proto -eq 'https'}).public_url; if($url){break}}catch{Start-Sleep -Milliseconds 800}}; if(-not $url){Write-Host 'ERROR: ngrok did not publish a URL in time.'; exit 1}; $base=$url + '/v1'; Write-Host ''; Write-Host '=========================================================='; Write-Host '  PUBLIC URL FOR CURSOR:'; Write-Host '    '$base; Write-Host '=========================================================='; Write-Host '  (copied to clipboard too)'; Set-Clipboard $base"

endlocal
