param(
  [string]$Branch = "main",
  [switch]$Force,
  [switch]$SkipReadme
)

$ErrorActionPreference = "Stop"

function Write-Header($text) {
  Write-Host ""
  Write-Host ("=" * 72) -ForegroundColor DarkCyan
  Write-Host " $text" -ForegroundColor Cyan
}

function Ensure-Command($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Не найдена команда '$name' в PATH."
  }
}

Write-Header "Инициализация сессии MatricaRMZ"

Ensure-Command git

Set-Location (Resolve-Path (Join-Path $PSScriptRoot ".."))

$repoRoot = (git rev-parse --show-toplevel).Trim()
if (-not $repoRoot) {
  throw "Не удалось определить корень git-репозитория."
}
Set-Location $repoRoot

Write-Host "Repo: $repoRoot" -ForegroundColor Gray

if ((git rev-parse --is-inside-work-tree).Trim() -ne "true") {
  throw "Команда должна быть запущена внутри репозитория."
}

if ((git remote | Select-String -Pattern '^origin$') -eq $null) {
  throw "В репозитории не настроен remote origin."
}

Write-Host "Текущая ветка: $((git branch --show-current).Trim())" -ForegroundColor Gray

$beforeCommit = (git rev-parse HEAD).Trim()
$hasDirty = (git status --porcelain).Trim()
$stashed = $false

if ($hasDirty) {
  if (-not $Force) {
    Write-Host ""
    Write-Host "В рабочей копии есть незакоммиченные изменения. Для сохранности данных выход:" -ForegroundColor Yellow
    Write-Host "  git status --short" -ForegroundColor Yellow
    Write-Host "  // затем commit / stash / commit --amend / revert" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Если хотите продолжить с временным сохранением изменений, запустите: -Force" -ForegroundColor Yellow
    throw "Отмена: найден local dirty."
  }

  Write-Host "Найден dirty-стейт. Применяю временный stash (--include-untracked)." -ForegroundColor Yellow
  git stash push -u -m "session-start-auto-stash"
  $stashed = $true
}

git checkout $Branch | Out-Null

Write-Host "Синхронизирую with origin/$Branch..."
git fetch origin --prune

$afterRemote = (git rev-parse ("origin/$Branch")).Trim()
if (-not $afterRemote) {
  throw "Нет удаленной ветки origin/$Branch."
}

try {
  git pull --rebase origin $Branch | Out-Null
} catch {
  Write-Host "git pull --rebase не прошел, пробую безопасный режим без rebase..." -ForegroundColor Yellow
  git pull --ff-only origin $Branch | Out-Null
}

$afterCommit = (git rev-parse HEAD).Trim()

if ($stashed) {
  try {
    git stash pop | Out-Null
  } catch {
    Write-Host ""
    Write-Host "Ошибка применения stash. Проверьте вручную: git stash list" -ForegroundColor Red
    throw "Не удалось применить stash после синхронизации."
  }
}

Write-Host ""
Write-Host "Короткий статус синхронизации:" -ForegroundColor Cyan
$statusLine = if ($beforeCommit -ne $afterCommit) { "обновлено" } else { "актуально" }
Write-Host "До: $beforeCommit"
Write-Host "После: $afterCommit"
Write-Host "Статус: $statusLine"

if ($beforeCommit -ne $afterCommit) {
  Write-Header "Что пришло с GitHub (проектные изменения)"
  $incoming = (git log --oneline --no-merges "$beforeCommit..$afterCommit").Trim()
  if ($incoming) {
    Write-Host $incoming
  } else {
    Write-Host "Изменений по коммитам не найдено (возможен fast-forward внутри одного SHA)."
  }

  Write-Header "Новые файлы/изменённые файлы"
  $changed = (git diff --name-only "$beforeCommit..$afterCommit").Trim()
  if ($changed) {
    $changedLines = $changed -split "`r?`n"
    foreach ($line in $changedLines) {
      if ($line.Trim()) {
        Write-Host " - $line"
      }
    }
  }
}

if (-not $SkipReadme) {
  if (Test-Path "docs/README.md") {
    Write-Header "Ключевая точка входа в проект"
    Write-Host "Документация для старта новой сессии: docs/README.md"
    Write-Host "Для AI-агента: это первичный контекст проекта в новой сессии."
    Write-Host ""
    Write-Host "Кратко из docs/README.md:" -ForegroundColor Gray
    Get-Content "docs/README.md" | Select-Object -First 20 | ForEach-Object {
      Write-Host ("  " + $_)
    }
  } else {
    Write-Host "Внимание: docs/README.md не найден." -ForegroundColor Yellow
  }
}

Write-Header "Сессия готова"
Write-Host "Проект синхронизирован и подтвержден для старта разработки." -ForegroundColor Green
Write-Host "Если хотите сразу продолжить с AI-агентом: начните с чтения docs/README.md и задач." -ForegroundColor Green

