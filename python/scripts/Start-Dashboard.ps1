# Standalone: Start only the dashboard server, save PID
$env:PYTHONPATH = "C:/Users/mknig/Documents/6 System Trading System;$env:PYTHONPATH"
$dashboardCmd = "import uvicorn; from dashboard.app import app; uvicorn.run(app, host='0.0.0.0', port=8766)"
$proc = Start-Process python -ArgumentList "-c",$dashboardCmd -WindowStyle Hidden -WorkingDirectory "C:/Users/mknig/Documents/6 System Trading System" -PassThru
$proc.Id | Out-File "$env:TEMP\dashboard_pid.txt"
Write-Host "Dashboard process launched (PID: $($proc.Id))"
