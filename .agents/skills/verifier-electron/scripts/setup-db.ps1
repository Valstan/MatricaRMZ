# Idempotently creates the matricarmz_dev database on local PostgreSQL.
#
# Flags:
#   -Reset    drop and recreate (DESTRUCTIVE).

param(
    [switch]$Reset
)

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '_common.ps1')

Test-PgConnectivity
$psql = Require-Psql
$pg = Get-PgConfig

function Invoke-Psql {
    param([string]$Db, [string]$Sql)
    $args = @(
        '-h', $pg.Host,
        '-p', $pg.Port,
        '-U', $pg.User,
        '-d', $Db,
        '-v', 'ON_ERROR_STOP=1',
        '-tA',
        '-c', $Sql
    )
    & $psql @args
    if ($LASTEXITCODE -ne 0) { throw "psql exit ${LASTEXITCODE}: $Sql" }
}

Invoke-Psql -Db 'postgres' -Sql 'SELECT 1' | Out-Null

if ($Reset) {
    Write-Output "[setup-db] reset: dropping $($pg.Database) if exists"
    Invoke-Psql -Db 'postgres' -Sql "DROP DATABASE IF EXISTS $($pg.Database)"
}

$exists = Invoke-Psql -Db 'postgres' -Sql "SELECT 1 FROM pg_database WHERE datname = '$($pg.Database)'"
if ($exists -eq '1') {
    Write-Output "[setup-db] database $($pg.Database) already exists"
} else {
    Write-Output "[setup-db] creating database $($pg.Database)"
    Invoke-Psql -Db 'postgres' -Sql "CREATE DATABASE $($pg.Database)"
}

# Restore production schema (schema-only dump) if user provided it.
# This pre-populates __drizzle_migrations so Drizzle skips already-applied
# migrations and avoids ordering issues with seed-style migrations like 0024.
$state = Get-StateDir

# Find dump file: prefer .dump (custom format via pg_restore), fallback to .sql (plain via psql).
$customDump = Get-ChildItem -Path $state -Filter '*.dump' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$plainDump  = Get-ChildItem -Path $state -Filter 'prod-schema.sql' -ErrorAction SilentlyContinue | Select-Object -First 1
$seedsDump  = Join-Path $state 'prod-seeds.sql'

$tablesCount = Invoke-Psql -Db $pg.Database -Sql "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"
$alreadyPopulated = [int]$tablesCount -gt 0

if ($alreadyPopulated) {
    Write-Output "[setup-db] $($pg.Database) already has $tablesCount tables - skipping restore"
} elseif ($customDump) {
    $pgRestore = Find-PgRestorePath
    if (-not $pgRestore) { throw 'pg_restore.exe not found. Install PostgreSQL client tools.' }
    Write-Output "[setup-db] restoring custom-format dump from $($customDump.FullName) via pg_restore"
    $args = @(
        '-h', $pg.Host, '-p', $pg.Port, '-U', $pg.User, '-d', $pg.Database,
        '--no-owner', '--no-privileges', '--single-transaction',
        $customDump.FullName
    )
    & $pgRestore @args
    if ($LASTEXITCODE -ne 0) { throw "pg_restore exit ${LASTEXITCODE}" }
} elseif ($plainDump) {
    Write-Output "[setup-db] restoring plain SQL schema from $($plainDump.FullName)"
    $args = @(
        '-h', $pg.Host, '-p', $pg.Port, '-U', $pg.User, '-d', $pg.Database,
        '-v', 'ON_ERROR_STOP=1', '-q', '-f', $plainDump.FullName
    )
    & $psql @args
    if ($LASTEXITCODE -ne 0) { throw "schema restore exit ${LASTEXITCODE}" }
    if (Test-Path $seedsDump) {
        Write-Output "[setup-db] restoring seeds from $seedsDump"
        $args = @(
            '-h', $pg.Host, '-p', $pg.Port, '-U', $pg.User, '-d', $pg.Database,
            '-v', 'ON_ERROR_STOP=1', '-q', '-f', $seedsDump
        )
        & $psql @args
        if ($LASTEXITCODE -ne 0) { throw "seeds restore exit ${LASTEXITCODE}" }
    } else {
        Write-Output "[setup-db] WARN: $seedsDump not found - entity_types empty, migrations 0024+ may fail"
    }
} else {
    Write-Output "[setup-db] WARN: no dump found in $state (looked for *.dump or prod-schema.sql)"
    Write-Output "[setup-db] WARN: see SKILL.md for the pg_dump command to generate one"
}

$version = Invoke-Psql -Db $pg.Database -Sql 'SHOW server_version'
Write-Output "[setup-db] OK: $($pg.Database) on PostgreSQL $version"
