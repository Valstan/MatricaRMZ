# Shared helpers for verifier-electron scripts. Sourced via `. _common.ps1`.

$ErrorActionPreference = 'Stop'

function Get-RepoRoot {
    # Scripts live in .claude/skills/verifier-electron/scripts/; repo root is 4 levels up.
    $here = Split-Path -Parent $MyInvocation.PSCommandPath
    return (Resolve-Path (Join-Path $here '..\..\..\..')).Path
}

function Find-PsqlPath {
    $candidate = Get-Command psql -ErrorAction SilentlyContinue
    if ($candidate) { return $candidate.Source }
    foreach ($p in @(
        'C:\pgsql\bin\psql.exe',
        'C:\Program Files\PostgreSQL\17\bin\psql.exe',
        'C:\Program Files\PostgreSQL\16\bin\psql.exe',
        'C:\Program Files\PostgreSQL\15\bin\psql.exe',
        'C:\Program Files\PostgreSQL\14\bin\psql.exe'
    )) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Require-Psql {
    $psql = Find-PsqlPath
    if (-not $psql) {
        throw 'psql.exe not found. Install PostgreSQL (https://www.postgresql.org/download/windows/) or add psql to PATH.'
    }
    return $psql
}

function Find-PgRestorePath {
    $candidate = Get-Command pg_restore -ErrorAction SilentlyContinue
    if ($candidate) { return $candidate.Source }
    # Sit next to psql.
    $psql = Find-PsqlPath
    if ($psql) {
        $restore = Join-Path (Split-Path -Parent $psql) 'pg_restore.exe'
        if (Test-Path $restore) { return $restore }
    }
    return $null
}

function Get-PgConfig {
    return @{
        Host     = if ($env:PGHOST) { $env:PGHOST } else { '127.0.0.1' }
        Port     = if ($env:PGPORT) { [int]$env:PGPORT } else { 5432 }
        User     = if ($env:PG_VERIFY_USER) { $env:PG_VERIFY_USER } else { 'postgres' }
        Database = if ($env:PG_VERIFY_DB) { $env:PG_VERIFY_DB } else { 'matricarmz_dev' }
    }
}

function Test-PgConnectivity {
    # Probe connection. Supports both $env:PGPASSWORD and %APPDATA%\postgresql\pgpass.conf.
    $psql = Require-Psql
    $pg = Get-PgConfig
    $args = @('-h', $pg.Host, '-p', $pg.Port, '-U', $pg.User, '-d', 'postgres', '-tA', '-c', 'SELECT 1')
    & $psql @args 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw @"
Cannot connect to PostgreSQL ($($pg.User)@$($pg.Host):$($pg.Port)/postgres).
Likely causes:
  1. PG is not running - check pg_isready -h 127.0.0.1
  2. No .pgpass and PGPASSWORD not set - set `$env:PGPASSWORD = '<pass>'` or create %APPDATA%\postgresql\pgpass.conf (host:port:db:user:password)
  3. Role $($pg.User) does not exist - CREATE ROLE via superuser
"@
    }
}

function New-RandomBase64 {
    param([int]$Bytes = 32)
    $buf = New-Object 'byte[]' $Bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
    return [Convert]::ToBase64String($buf)
}

function New-RandomHex {
    param([int]$Bytes = 32)
    $buf = New-Object 'byte[]' $Bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
    return -join ($buf | ForEach-Object { $_.ToString('x2') })
}

function Get-StateDir {
    $repo = Get-RepoRoot
    $dir = Join-Path $repo '.verifier-electron'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    return $dir
}

# ─────────────────────────────────────────────────────────── ИМЕНОВАННЫЕ СТЕНДЫ
# Заказ владельца (23.11): «можно между рабочими областями Матрицы РМЗ
# разделить ресурсы стенда, чтобы каждая запускала свой стенд, а не ждала
# очереди к одному, и чтобы не мешали друг другу при тестировании».
#
# Что для этого нужно и как оно устроено:
#   * Свой CDP-порт   — по нему же рантайм изолирует `userData`
#     (`app.setPath('userData', '…-cdp-<port>')`), то есть клиент, профиль и
#     сессия у каждого стенда свои (это уже было в коде).
#   * Свой порт рендерера (Vite) и свой порт backend — иначе второй стенд
#     либо не поднимется («порт занят»), либо сядет на чужой.
#   * Своя база PostgreSQL — иначе тесты одной линии видят и меняют данные
#     другой (это и есть «мешают при тестировании»).
#   * Свой каталог состояния (логи, pid-файлы) — иначе `stop.ps1` одной линии
#     гасит стенд другой.
#   * `stop.ps1` не должен убивать ЧУЖИЕ процессы electron: раньше он смахивал
#     все `electron.exe` на машине (включая стенды других линий и прод-клиент).

function Get-StandName {
    # Имя стенда: -Stand <имя> или $env:MATRICA_STAND, по умолчанию 'main'.
    param([string]$Stand = '')
    if ($Stand) { return $Stand }
    if ($env:MATRICA_STAND) { return $env:MATRICA_STAND }
    return 'main'
}

function Get-StandPorts {
    # Порты стенда. Имена: main (стенд по умолчанию), lane1..lane3 — линии.
    param([string]$Stand = '')
    $name = Get-StandName -Stand $Stand
    $known = @('main', 'lane1', 'lane2', 'lane3')
    $i = $known.IndexOf($name)
    $offset = if ($i -ge 0) { $i } else { 1 }
    return @{
        Name     = $name
        Offset   = $offset
        Cdp      = 9222 + $offset
        Backend  = 3001 + $offset
        Renderer = 5173 + $offset
    }
}

function Get-StandStateDir {
    # Каталог состояния стенда: .verifier-electron для main, .verifier-electron/<имя> — иначе.
    param([string]$Stand = '')
    $name = Get-StandName -Stand $Stand
    $repo = Get-RepoRoot
    $dir = if ($name -eq 'main') { Join-Path $repo '.verifier-electron' }
           else { Join-Path $repo (Join-Path '.verifier-electron' $name) }
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    return $dir
}

function Get-StandDb {
    # База стенда: у каждого стенда своя (иначе тесты линий мешают друг другу).
    param([string]$Stand = '')
    $name = Get-StandName -Stand $Stand
    if ($name -eq 'main') { return 'matricarmz_dev' }
    return ('matricarmz_dev_' + ($name -replace '[^a-zA-Z0-9_]', '_'))
}

function Get-OwnElectronProcesses {
    # Процессы electron ЭТОГО стенда: по его CDP-порту или по его репозиторию.
    # Чужие electron (стенд другой линии, прод-клиент) сюда не попадают.
    param([string]$Stand = '')
    $ports = Get-StandPorts -Stand $Stand
    $repo = Get-RepoRoot
    $out = @()
    try {
        foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='electron.exe'")) {
            $cl = [string]$p.CommandLine
            if (-not $cl) { continue }
            if ($cl -like "*--remote-debugging-port=$($ports.Cdp)*" -or $cl -like "*$repo*") {
                $out += $p
            }
        }
    } catch {}
    return $out
}

function Import-DotEnv {
    # Parses KEY=VALUE pairs from $Path and sets them as process env vars in
    # the current PowerShell session. Used because backend reads `.env` only;
    # we cannot ask it to load `.env.dev` without code changes.
    param([string]$Path)
    if (-not (Test-Path $Path)) { throw "Import-DotEnv: $Path not found" }
    $lines = Get-Content $Path
    foreach ($line in $lines) {
        $trim = $line.Trim()
        if (-not $trim) { continue }
        if ($trim.StartsWith('#')) { continue }
        $eq = $trim.IndexOf('=')
        if ($eq -lt 1) { continue }
        $key = $trim.Substring(0, $eq).Trim()
        $val = $trim.Substring($eq + 1)
        # Strip surrounding quotes if present.
        if ($val.Length -ge 2 -and (($val[0] -eq '"' -and $val[-1] -eq '"') -or ($val[0] -eq "'" -and $val[-1] -eq "'"))) {
            $val = $val.Substring(1, $val.Length - 2)
        }
        Set-Item -Path "Env:$key" -Value $val
    }
}
