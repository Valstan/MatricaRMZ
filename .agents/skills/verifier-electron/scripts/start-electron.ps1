# Starts electron-app dev in background using .env.dev. Waits for electron.exe window.
# Pass -Cdp to expose the Chrome DevTools Protocol (for cdp-drive.mjs, the
# computer-use-independent driver). Default port 9222; override with -CdpPort.
param(
    [switch]$Cdp,
    [int]$CdpPort = 9222
)

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '_common.ps1')

$repo = Get-RepoRoot
$envPath = Join-Path $repo 'electron-app\.env.dev'
if (-not (Test-Path $envPath)) {
    throw "$envPath missing - run setup-env.ps1 first"
}

$state = Get-StateDir
$logPath = Join-Path $state 'electron.log'
$pidPath = Join-Path $state 'electron.pid'

if (Test-Path $pidPath) {
    $oldPid = Get-Content $pidPath -ErrorAction SilentlyContinue
    if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
        Write-Output "[start-electron] already running (PID=$oldPid). Run stop.ps1 to restart."
        exit 0
    }
}

Import-DotEnv -Path $envPath
Set-Location $repo

# CDP: when -Cdp is passed (or MATRICA_CDP_PORT is already in the env), make sure
# the var is set so it propagates to the electron child process below. The main
# process reads it before app-ready and appends --remote-debugging-port.
if ($Cdp -or $env:MATRICA_CDP_PORT) {
    if (-not $env:MATRICA_CDP_PORT) { $env:MATRICA_CDP_PORT = "$CdpPort" }
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
    $electronProcess = Get-Process -Name 'electron' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($electronProcess) { break }
}

if (-not $electronProcess) {
    Write-Output "[start-electron] TIMEOUT - electron.exe did not appear. Logs: $logPath"
    exit 1
}

Write-Output "[start-electron] OK: electron.exe PID=$($electronProcess.Id)"
Write-Output ''
Write-Output '=== Stack up ==='
Write-Output 'Login: verify / verify123'
Write-Output 'Engine: TEST-001 (brand TEST-BRAND, 1 brand-linked part TEST-PART qty=2)'
