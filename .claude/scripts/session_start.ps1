# SessionStart hook (D-066): print the session context so the agent starts in the thread
# without a reading ritual. Read-only and offline — `git pull` stays a conscious /start step.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root
Write-Output '=== git status -sb (top 5) ==='
git status -sb 2>$null | Select-Object -First 5
Write-Output '=== git log --oneline -3 ==='
git log --oneline -3 2>$null
$handoff = Join-Path $root 'docs\SESSION_HANDOFF.md'
if (Test-Path -LiteralPath $handoff) {
  Write-Output '=== docs/SESSION_HANDOFF.md ==='
  Get-Content -LiteralPath $handoff -Encoding UTF8
}
exit 0
