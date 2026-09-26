; Close every running app instance before install/update — including windows
; hidden in the system tray. Without this, NSIS cannot replace the exe while
; Electron is still alive (tray icon keeps the process running).

!macro customInit
  DetailPrint "KnightTrader: closing running app instances (including tray)..."
  ; Primary executable name from electron-builder (${APP_EXECUTABLE_FILENAME}).
  ExecWait 'cmd /c taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T 2>nul' $0
  ; Product-name fallback (same as APP_EXECUTABLE_FILENAME for this app).
  ExecWait 'cmd /c taskkill /F /IM "${PRODUCT_NAME}.exe" /T 2>nul' $0
  ; Hermes child processes can hold locks under %APPDATA%\knight-trader\hermes.
  ExecWait 'cmd /c taskkill /F /IM "hermes.exe" /T 2>nul' $0
  Sleep 2000
!macroend

; Silent auto-update relaunch.
;
; Assisted NSIS (oneClick: false) only relaunches on --force-run via
; StdUtils.ExecShellAsUser. That call no-ops when electron-updater spawned
; the installer detached, so the app quits, the update installs, and nothing
; comes back. Exec() starts the exe directly and works from that context.
; Interactive installs still use the finish-page "Run" checkbox.
!macro customInstall
  IfSilent kt_silent_relaunch kt_skip_relaunch
  kt_silent_relaunch:
    SetOutPath "$INSTDIR"
    Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  kt_skip_relaunch:
!macroend
