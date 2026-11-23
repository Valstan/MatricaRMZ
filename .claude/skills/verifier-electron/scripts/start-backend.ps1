# Starts backend-api dev in background using .env.dev. Waits for /health.
#
# -Stand <имя> — ИМЕНОВАННЫЙ СТЕНД (23.11, заказ владельца: линии не должны
# делить один стенд). Свой порт и своя база PostgreSQL: иначе тесты одной
# линии видят и меняют данные другой.

param(
    [string]$Stand = ''
)

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '_common.ps1')

$repo = Get-RepoRoot
$standPorts = Get-StandPorts -Stand $Stand
$envPath = Join-Path $repo 'backend-api\.env.dev'
if (-not (Test-Path $envPath)) {
    throw "$envPath missing - run setup-env.ps1 first"
}

$state = Get-StandStateDir -Stand $Stand
$logPath = Join-Path $state 'backend.log'
$pidPath = Join-Path $state 'backend.pid'

if (Test-Path $pidPath) {
    $oldPid = Get-Content $pidPath -ErrorAction SilentlyContinue
    if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
        Write-Output "[start-backend] стенд '$($standPorts.Name)' уже запущен (PID=$oldPid). Run stop.ps1 -Stand $($standPorts.Name) to restart."
        exit 0
    }
}

# Порт берём из .env.dev, а не из константы: на машине разработчика 3001 может
# быть занят СОСЕДНИМ проектом (на PC79 там Next.js другого репо), и жёсткая
# константа делала скилл неподнимаемым без правки трекаемого файла. Поэтому
# dotenv импортируется ДО проверки порта.
Import-DotEnv -Path $envPath
Set-Location $repo

# Именованный стенд ⇒ свой порт (не делим с соседней линией).
$backendPort = if ($standPorts.Name -ne 'main') { $standPorts.Backend }
                elseif ($env:PORT) { [int]$env:PORT }
                else { 3001 }
$env:PORT = "$backendPort"
# Именованный стенд ⇒ своя база (тесты линий не должны видеть данные друг друга).
$standDb = Get-StandDb -Stand $Stand
$env:PG_VERIFY_DB = $standDb

# Fail fast if port already taken.
$sock = New-Object System.Net.Sockets.TcpClient
try {
    $sock.Connect('127.0.0.1', $backendPort)
    $sock.Close()
    throw "127.0.0.1:${backendPort} already in use - another backend is running."
} catch [System.Net.Sockets.SocketException] {
    # port free, OK
} finally {
    if ($sock.Connected) { $sock.Close() }
}

# Build shared+ledger ONCE up-front. The backend imports their dist/ output; pre-building
# here means nothing rewrites shared/dist|ledger/dist during the run, so we can launch the
# backend WITHOUT tsx --watch (below) and avoid the restart storm that prevented /health
# from stabilising within the timeout (PENDING_FOLLOWUPS "verifier-electron — стек не поднимается").
Write-Output "[start-backend] building shared + ledger once (no watch)..."
& corepack pnpm --filter @matricarmz/shared --filter @matricarmz/ledger build 2>&1 | Tee-Object -FilePath $logPath
if ($LASTEXITCODE -ne 0) {
    Write-Output "[start-backend] shared/ledger build FAILED (see $logPath)"
    exit 1
}

Write-Output "[start-backend] log -> $logPath"
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'cmd.exe'
# dev:no-watch = `tsx src/index.ts` (no --watch): single boot, no restart-on-rebuild race.
$psi.Arguments = "/c corepack pnpm --filter @matricarmz/backend-api dev:no-watch >> `"$logPath`" 2>&1"
$psi.WorkingDirectory = $repo
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
# Inherit all current env vars (loaded from .env.dev above).
foreach ($k in [System.Environment]::GetEnvironmentVariables().Keys) {
    $psi.EnvironmentVariables[$k] = [System.Environment]::GetEnvironmentVariable($k)
}

$proc = [System.Diagnostics.Process]::Start($psi)
$proc.Id | Set-Content -Path $pidPath
Write-Output "[start-backend] started PID=$($proc.Id), polling /health (timeout 90s)..."

$deadline = (Get-Date).AddSeconds(90)
$ok = $false
$lastResp = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    try {
        $lastResp = Invoke-WebRequest -Uri "http://127.0.0.1:${backendPort}/health" -UseBasicParsing -TimeoutSec 3
        if ($lastResp.StatusCode -eq 200) { $ok = $true; break }
    } catch {
        # still booting
    }
}

if (-not $ok) {
    Write-Output "[start-backend] TIMEOUT - /health did not return 200. Logs: $logPath"
    exit 1
}

Write-Output "[start-backend] OK: $($lastResp.Content)"
