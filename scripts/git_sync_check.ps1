<#
.SYNOPSIS
  Git-sync safeguard for MatricaRMZ sessions (brain pool #010).

.DESCRIPTION
  Detects whether the current work is safely on GitHub between machines
  (GitHub is the source of truth). Two modes:

    -Warn   Print a warning to stdout if the working tree is dirty, the branch
            has unpushed commits, or origin is ahead. Best-effort `git fetch`
            with a timeout; offline / fetch failure never breaks. ALWAYS exit 0.
            (Used by the SessionStart hook in .claude/settings.json - its stdout
            is injected into the agent's context at session start.)

    -Gate   Same detection, but exit 1 while the tree is dirty OR has unpushed
            work; exit 0 once everything is committed and pushed. (Used by the
            /close_session sync-gate - the session is not closed until exit 0.)

  Git-agnostic: portable by copy, only the invocation path is project-specific.

.NOTES
  brain directive 2026-05-30-session-sync-safeguard (mandate). Adapted to the
  Windows/PowerShell stack (directive specified bash git_sync_check.sh).
  Keep this file pure ASCII: Windows PowerShell 5.1 reads BOM-less scripts in
  the system code page, so non-ASCII chars (em-dash, emoji) corrupt the parse.
#>
[CmdletBinding()]
param(
  [switch]$Warn,
  [switch]$Gate
)

# Default to -Warn when invoked with no mode (e.g. a bare hook misconfig).
if (-not $Warn -and -not $Gate) { $Warn = $true }

$SIGN_WARN = "[git-sync WARNING]"
$SIGN_OK   = "[git-sync OK]"

function Get-RepoRoot {
  if ($env:CLAUDE_PROJECT_DIR -and (Test-Path -LiteralPath $env:CLAUDE_PROJECT_DIR)) {
    return $env:CLAUDE_PROJECT_DIR
  }
  try {
    $root = git rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -eq 0 -and $root) { return $root.Trim() }
  } catch {}
  return (Get-Location).Path
}

function Invoke-FetchWithTimeout {
  param([int]$TimeoutSec = 10)
  try {
    $job = Start-Job -ScriptBlock {
      param($dir)
      Set-Location $dir
      $env:GIT_TERMINAL_PROMPT = '0'   # never block on a credential prompt
      git fetch --quiet --no-tags 2>&1 | Out-Null
      $LASTEXITCODE
    } -ArgumentList (Get-Location).Path

    if (Wait-Job $job -Timeout $TimeoutSec) {
      $rc = Receive-Job $job
      Remove-Job $job -Force -ErrorAction SilentlyContinue
      return ($rc -eq 0)
    }
    Stop-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    return $false
  } catch {
    return $false
  }
}

function Get-SyncState {
  param([string]$RepoRoot)

  $state = [ordered]@{
    IsRepo = $false; Dirty = $false; HasUpstream = $false
    Ahead = 0; Behind = 0; Branch = ''; FetchOk = $false
  }

  Push-Location -LiteralPath $RepoRoot
  try {
    $null = git rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -ne 0) { return $state }
    $state.IsRepo = $true
    $state.Branch = (git rev-parse --abbrev-ref HEAD 2>$null)

    if (git status --porcelain 2>$null) { $state.Dirty = $true }

    $upstream = git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null
    if ($LASTEXITCODE -eq 0 -and $upstream) {
      $state.HasUpstream = $true
      $state.FetchOk = Invoke-FetchWithTimeout -TimeoutSec 10

      $counts = git rev-list --left-right --count '@{u}...HEAD' 2>$null
      if ($LASTEXITCODE -eq 0 -and $counts) {
        $parts = $counts -split '\s+'
        $state.Behind = [int]$parts[0]   # commits on upstream, missing locally
        $state.Ahead  = [int]$parts[1]   # local commits not pushed
      }
    }
  } finally {
    Pop-Location
  }
  return $state
}

$repo = Get-RepoRoot
$s = Get-SyncState -RepoRoot $repo

if (-not $s.IsRepo) {
  if ($Warn) { Write-Output "$SIGN_WARN not a git repository - skipping check" }
  exit 0
}

$problems = @()
if ($s.Dirty)                            { $problems += "uncommitted changes in the working tree" }
if (-not $s.HasUpstream)                 { $problems += "branch '$($s.Branch)' has no upstream - never pushed" }
elseif ($s.Ahead -gt 0)                  { $problems += "$($s.Ahead) local commit(s) on '$($s.Branch)' not pushed to origin" }
if ($s.HasUpstream -and $s.Behind -gt 0) { $problems += "origin is $($s.Behind) commit(s) ahead - run 'git pull'" }

# Gate is about "is your work on GitHub": dirty or unpushed blocks closing.
# Behind-only (clean + pushed, origin moved on) does not block closing.
$workNotOnGitHub = $s.Dirty -or (-not $s.HasUpstream) -or ($s.Ahead -gt 0)

if ($Gate) {
  if ($workNotOnGitHub) {
    Write-Output "$SIGN_WARN session NOT synced - close blocked:"
    foreach ($p in $problems) { Write-Output "   - $p" }
    Write-Output "   Commit and push via PR-flow (ADR-0002) before closing."
    exit 1
  }
  exit 0
}

# -Warn mode
if ($problems.Count -gt 0) {
  Write-Output "$SIGN_WARN this session has work not yet on GitHub:"
  foreach ($p in $problems) { Write-Output "   - $p" }
  Write-Output "   GitHub is the source of truth between machines - sync before switching computers (see CLAUDE.md / /close_session)."
} else {
  Write-Output "$SIGN_OK clean - committed and pushed (branch '$($s.Branch)')."
}
exit 0
