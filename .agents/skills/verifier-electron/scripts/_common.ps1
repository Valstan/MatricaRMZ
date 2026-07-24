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
