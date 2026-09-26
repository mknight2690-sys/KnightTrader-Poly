# Launch trading agent + DASHBOARD SERVER + Chrome
cd "C:\Users\mknig\Documents\6 System Trading System"

# Start trading agent (main.py) in background
$agentProc = Start-Process python -ArgumentList "main.py" -WindowStyle Hidden -PassThru
$agentProc.Id | Out-File "$env:TEMP\trading_agent_pid.txt"

# Start dashboard server in background using existing run_dashboard.py
$dashboardProc = Start-Process python -ArgumentList "run_dashboard.py" -WindowStyle Hidden -WorkingDirectory "C:\Users\mknig\Documents\6 System Trading System" -PassThru
$dashboardProc.Id | Out-File "$env:TEMP\dashboard_pid.txt"

# Wait for dashboard to start
Start-Sleep -Seconds 5

# Verify dashboard started
$client = New-Object System.Net.WebClient
try {
    $response = $client.DownloadString("http://localhost:8766/health")
    if ($response -like "*ok*") {
        Write-Host "Dashboard running on http://localhost:8766"
    } else {
        Write-Host "WARNING: Dashboard not responding"
    }
} catch {
    Write-Host "WARNING: Dashboard not responding"
}

# Open Chrome to dashboard
Start-Process chrome.exe -ArgumentList "--new-window --user-data-dir=C:\Temp\chrome_trading --no-first-run http://localhost:8766"

Write-Host "Trading system launched."
Write-Host "Dashboard: http://localhost:8766"
