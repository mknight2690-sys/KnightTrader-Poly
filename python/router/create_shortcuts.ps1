# Creates two desktop shortcuts for free-claude-router: Start and Stop.
$desktop = [Environment]::GetFolderPath("Desktop")
$proj    = "C:\Users\mknig\free-claude-router"
$ws = New-Object -ComObject WScript.Shell

$start = $ws.CreateShortcut((Join-Path $desktop "Start free-claude-router.lnk"))
$start.TargetPath       = Join-Path $proj "start_server.bat"
$start.WorkingDirectory = $proj
$start.IconLocation     = "shell32.dll,165"   # green "play/run" style icon
$start.Description      = "Start the free-claude-router proxy (port 8082)"
$start.WindowStyle      = 1
$start.Save()

$stop = $ws.CreateShortcut((Join-Path $desktop "Stop free-claude-router.lnk"))
$stop.TargetPath       = Join-Path $proj "stop_server.bat"
$stop.WorkingDirectory = $proj
$stop.IconLocation     = "shell32.dll,132"   # red X / stop style icon
$stop.Description      = "Stop the free-claude-router proxy (router + ngrok tunnel)"
$stop.WindowStyle      = 1
$stop.Save()

$tun = $ws.CreateShortcut((Join-Path $desktop "Start router tunnel (Cursor).lnk"))
$tun.TargetPath       = Join-Path $proj "start_tunnel.bat"
$tun.WorkingDirectory = $proj
$tun.IconLocation     = "shell32.dll,13"    # globe / network icon
$tun.Description      = "Expose the router publicly via ngrok for Cursor (prints the public URL)"
$tun.WindowStyle      = 1
$tun.Save()

Write-Output "Created shortcuts on desktop:"
Write-Output ("  " + (Join-Path $desktop "Start free-claude-router.lnk"))
Write-Output ("  " + (Join-Path $desktop "Start router tunnel (Cursor).lnk"))
Write-Output ("  " + (Join-Path $desktop "Stop free-claude-router.lnk"))
