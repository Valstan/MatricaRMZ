# Applies Drizzle migrations to the local DB and populates dev fixtures.
# Run after setup-env + setup-db.

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '_common.ps1')

$repo = Get-RepoRoot
$envPath = Join-Path $repo 'backend-api\.env.dev'
if (-not (Test-Path $envPath)) {
    throw "$envPath missing - run setup-env.ps1 first"
}

Import-DotEnv -Path $envPath
Set-Location $repo

Write-Output '[bootstrap] ensure entity_types + attribute_defs (so seed migrations pass)'
& corepack pnpm --filter '@matricarmz/backend-api' dev:bootstrap-types
if ($LASTEXITCODE -ne 0) { throw "dev:bootstrap-types exit ${LASTEXITCODE}" }

Write-Output '[migrate] backend-api db:migrate'
& corepack pnpm --filter '@matricarmz/backend-api' db:migrate
if ($LASTEXITCODE -ne 0) { throw "db:migrate exit ${LASTEXITCODE}" }

Write-Output '[seed] permissions'
& corepack pnpm --filter '@matricarmz/backend-api' perm:seed
if ($LASTEXITCODE -ne 0) { throw "perm:seed exit ${LASTEXITCODE}" }

Write-Output '[seed] dev fixtures (verify user + TEST-BRAND + TEST-PART + TEST-001)'
& corepack pnpm --filter '@matricarmz/backend-api' dev:seed-fixtures
if ($LASTEXITCODE -ne 0) { throw "dev:seed-fixtures exit ${LASTEXITCODE}" }

Write-Output ''
Write-Output '=== migrate+seed done ==='
Write-Output 'Next: start-backend.ps1 then start-electron.ps1'
