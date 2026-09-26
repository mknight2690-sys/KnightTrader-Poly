# STOP: Kill only the trading agent and dashboard server (by PID file)
# Does NOT touch any other processes.

$pidFiles = @("$env:TEMP\trading_agent_pid.txt", "$env:TEMP\dashboard_pid.txt", "$env:TEMP\dashboard_chrome_pid.txt")

foreach ($pidFile in $pidFiles) {
    if (Test-Path $pidFile) {
        $pidVal = (Get-Content $pidFile).Trim()
        if ($pidVal -and $pidVal -ne "") {
            Stop-Process -Id $pidVal -Force -ErrorAction SilentlyContinue
            Write-Host "Stopped process (PID: $pidVal)"
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "Stopped trading agent and dashboard server."
