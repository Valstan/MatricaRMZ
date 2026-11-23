# Starts electron-app dev in background using .env.dev. Waits for electron.exe window.
# Pass -Cdp to expose the Chrome DevTools Protocol (for cdp-drive.mjs, the
# computer-use-independent driver). Default port 9222; override with -CdpPort.
#
# -Stand <имя> — ИМЕНОВАННЫЙ СТЕНД (23.11, заказ владельца: линии не должны
# делить один стенд). Свой CDP-порт, свой порт рендера, свой backend-URL,
# свой каталог состояния. Стенд 'main' — как раньше.
param(
    [switch]$Cdp,
    [int]$CdpPort = 0,
    [string]$Stand = ''
)

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '_common.ps1')

$repo = Get-RepoRoot
$standPorts = Get-StandPorts -Stand $Stand
if (-not $CdpPort) { $CdpPort = $standPorts.Cdp }
$envPath = Join-Path $repo 'electron-app\.env.dev'
if (-not (Test-Path $envPath)) {
    throw "$envPath missing - run setup-env.ps1 first"
}

$state = Get-StandStateDir -Stand $Stand
$logPath = Join-Path $state 'electron.log'
$pidPath = Join-Path $state 'electron.pid'

# Импорт env ДО подстановки портов стенда: `.env.dev` написан под стенд `main`
# (backend 3001), и импорт после подстановки перебивал порт линии — клиент именованного
# стенда уезжал на ЧУЖОЙ backend (ровно то смешение, ради которого стенды и разделили).
Import-DotEnv -Path $envPath

# Свой порт рендера и свой backend — иначе стенд линии сядет на чужой.
$env:MATRICA_RENDERER_PORT = "$($standPorts.Renderer)"
$env:MATRICA_API_URL = "http://127.0.0.1:$($standPorts.Backend)"
$env:MATRICA_SYNC_V2 = '1'
$env:MATRICA_UPDATE_PEER_HTTP_PORT = "$($standPorts.Backend)"

if (Test-Path $pidPath) {
    $oldPid = Get-Content $pidPath -ErrorAction SilentlyContinue
    # Проверяем по живому electron.exe, а не по pid-файлу: после падения клиента
    # остаётся живая cmd-обёртка, и старая проверка считала стенд «запущенным» —
    # скрипт молча ничего не поднимал (16.11.2026).
    #
    # ⚠️ 23.11: раньше проверка брала ПЕРВЫЙ ПОПАВШИЙСЯ electron.exe на
    # машине ⇒ стенд линии «видел» чужой клиент и не поднимал свой (линии
    # делили один стенд и ждали очереди). Теперь смотрим ТОЛЬКО на свои
    # процессы: по своему CDP-порту или по своему репозиторию.
    $own = Get-OwnElectronProcesses -Stand $Stand
    if ($own) {
        Write-Output "[start-electron] стенд '$($standPorts.Name)' уже запущен (electron PID=$($own[0].ProcessId)). Run stop.ps1 -Stand $($standPorts.Name) to restart."
        exit 0
    }
    Write-Output "[start-electron] stale pid file ($oldPid) — прошлый клиент упал, стартуем заново."
}

Set-Location $repo

# Build shared+ledger ONCE up-front, like start-backend.ps1 does. The Electron main
# process imports their dist/ output at runtime: a stale shared/dist makes the
# client die with "SyntaxError: The requested module '@matricarmz/shared' does
# not provide an export named '<X>'" (16.11.2026 — после параллельного PR в
# shared появился новый экспорт, а dist остался старым). Сборка здесь снимает
# класс падений: клиент всегда поднимается против свежего shared.
Write-Output "[start-electron] building shared + ledger once (no watch)..."
& corepack pnpm --filter @matricarmz/shared --filter @matricarmz/ledger build 2>&1 | Tee-Object -FilePath $logPath
if ($LASTEXITCODE -ne 0) {
    Write-Output "[start-electron] shared/ledger build FAILED (see $logPath)"
    exit 1
}

# CDP: when -Cdp is passed (or MATRICA_CDP_PORT is already in the env), make sure
# the var is set so it propagates to the electron child process below. The main
# process reads it before app-ready and appends --remote-debugging-port.
#
# ⚠️ 23.11: у именованного стенда порт СВОЙ, даже если MATRICA_CDP_PORT в
# окружении уже стоял (иначе стенд линии сел бы на чужой порт и не поднялся).
if ($Cdp -or $env:MATRICA_CDP_PORT -or $standPorts.Name -ne 'main') {
    if ($standPorts.Name -ne 'main' -or -not $env:MATRICA_CDP_PORT) { $env:MATRICA_CDP_PORT = "$CdpPort" }
    Write-Output "[start-electron] CDP enabled: MATRICA_CDP_PORT=$($env:MATRICA_CDP_PORT)"
}

Write-Output "[start-electron] log -> $logPath"
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'cmd.exe'
$psi.Arguments = "/c corepack pnpm --filter @matricarmz/electron-app dev > `"$logPath`" 2>&1"
$psi.WorkingDirectory = $repo
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
foreach ($k in [System.Environment]::GetEnvironmentVariables().Keys) {
    $psi.EnvironmentVariables[$k] = [System.Environment]::GetEnvironmentVariable($k)
}

$proc = [System.Diagnostics.Process]::Start($psi)
$proc.Id | Set-Content -Path $pidPath
Write-Output "[start-electron] started PID=$($proc.Id), waiting for electron.exe (timeout 90s)..."

$deadline = (Get-Date).AddSeconds(90)
$electronProcess = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    # ⚠️ 23.11: ищем СВОЙ electron (по своему CDP-порту/репозиторию), а не первый
    # попавшийся на машине: чужой клиент (стенд другой линии, прод-клиент) не
    # должен считаться «нашим стендом поднятым» — из-за этого линии делили один
    # стенд и ждали очереди.
    $own = Get-OwnElectronProcesses -Stand $Stand
    if ($own) { $electronProcess = $own[0]; break }
}

if (-not $electronProcess) {
    Write-Output "[start-electron] TIMEOUT - electron.exe did not appear. Logs: $logPath"
    exit 1
}

Write-Output "[start-electron] OK: стенд '$($standPorts.Name)', electron PID=$($electronProcess.ProcessId), CDP=$($env:MATRICA_CDP_PORT), renderer=$($env:MATRICA_RENDERER_PORT), backend=$($env:MATRICA_API_URL)"
Write-Output ''
Write-Output '=== Stack up ==='
Write-Output 'Login: verify / verify123'
Write-Output 'Engine: TEST-001 (brand TEST-BRAND, 1 brand-linked part TEST-PART qty=2)'
