# Stops backend + electron using PID files in .verifier-electron/.

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '_common.ps1')

$state = Get-StateDir

function Stop-FromPidFile {
    param([string]$Label, [string]$PidPath)
    if (-not (Test-Path $PidPath)) {
        Write-Output "[$Label] no PID file, skipping"
        return
    }
    $procId = Get-Content $PidPath -ErrorAction SilentlyContinue
    if (-not $procId) {
        Remove-Item $PidPath -Force -ErrorAction SilentlyContinue
        return
    }
    try {
        Stop-Process -Id $procId -Force -ErrorAction Stop
        Write-Output "[$Label] stopped PID=$procId"
    } catch {
        Write-Output "[$Label] PID=$procId no longer active"
    }
    Remove-Item $PidPath -Force -ErrorAction SilentlyContinue
}

Stop-FromPidFile -Label 'electron' -PidPath (Join-Path $state 'electron.pid')
Stop-FromPidFile -Label 'backend'  -PidPath (Join-Path $state 'backend.pid')

# Sweep leftover electron processes (electron-vite may spawn multiple windows).
$leftover = Get-Process -Name 'electron' -ErrorAction SilentlyContinue
foreach ($p in $leftover) {
    try { Stop-Process -Id $p.Id -Force; Write-Output "[cleanup] killed electron PID=$($p.Id)" } catch {}
}
