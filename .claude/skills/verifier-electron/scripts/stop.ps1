# Stops backend + electron of ONE stand, using PID files in .verifier-electron/<stand>/.
#
# -Stand <имя> — какой стенд гасить (по умолчанию 'main').
#
# ⚠️ 23.11, заказ владельца (линии не должны мешать друг другу): раньше скрипт
# смахивал ВСЕ процессы `electron.exe` на машине — то есть гасил стенд соседней
# линии (и вообще любой Electron, включая прод-клиент «Матрицы РМЗ»). Теперь
# убираем только СВОИ: по pid-файлам своего стенда и по процессам, у которых
# наш CDP-порт или наш репозиторий.

param(
    [string]$Stand = ''
)

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '_common.ps1')

$state = Get-StandStateDir -Stand $Stand
$standPorts = Get-StandPorts -Stand $Stand

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

Write-Output "[stop] стенд '$($standPorts.Name)' (CDP $($standPorts.Cdp), backend $($standPorts.Backend), renderer $($standPorts.Renderer))"

Stop-FromPidFile -Label 'electron' -PidPath (Join-Path $state 'electron.pid')
Stop-FromPidFile -Label 'backend'  -PidPath (Join-Path $state 'backend.pid')

# Sweep leftover electron processes OF THIS STAND only (electron-vite may spawn
# multiple windows). Чужие стенды и прод-клиент не трогаем.
$leftover = Get-OwnElectronProcesses -Stand $Stand
foreach ($p in $leftover) {
    try { Stop-Process -Id $p.ProcessId -Force; Write-Output "[cleanup] killed electron PID=$($p.ProcessId) (свой стенд)" } catch {}
}
