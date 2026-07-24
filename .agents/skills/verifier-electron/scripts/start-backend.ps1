# Starts backend-api dev in background using .env.dev. Waits for /health.

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '_common.ps1')

$repo = Get-RepoRoot
$envPath = Join-Path $repo 'backend-api\.env.dev'
if (-not (Test-Path $envPath)) {
    throw "$envPath missing - run setup-env.ps1 first"
}

$state = Get-StateDir
$logPath = Join-Path $state 'backend.log'
$pidPath = Join-Path $state 'backend.pid'

if (Test-Path $pidPath) {
    $oldPid = Get-Content $pidPath -ErrorAction SilentlyContinue
    if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
        Write-Output "[start-backend] already running (PID=$oldPid). Run stop.ps1 to restart."
        exit 0
    }
}

# Fail fast if port already taken.
$sock = New-Object System.Net.Sockets.TcpClient
try {
    $sock.Connect('127.0.0.1', 3001)
    $sock.Close()
    throw '127.0.0.1:3001 already in use - another backend is running.'
} catch [System.Net.Sockets.SocketException] {
    # port free, OK
} finally {
    if ($sock.Connected) { $sock.Close() }
}

Import-DotEnv -Path $envPath
Set-Location $repo

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
        $lastResp = Invoke-WebRequest -Uri 'http://127.0.0.1:3001/health' -UseBasicParsing -TimeoutSec 3
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
