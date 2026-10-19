# opencode-cleanup.ps1 — снять с машины админ-раскладку OpenCode-узла
#
# Зачем. Модуль OpenCode-узлов вырезан из программы (решение владельца 19.10.2026; план —
# docs/plans/_archive/batch-pain-print-and-filters-2026-10.md §P2). Установщик узла (бывший
# opencode-harness.ps1) оставлял на машине парка следы ВНЕ профиля оператора:
#   * задачу планировщика `MatricaRMZ-OpenCode-serve-<оператор>` (триггер «при входе»);
#   * входящее правило брандмауэра «MatricaRMZ - OpenCode serve …» (только порт serve);
#   * бинарь и его папку `%PROGRAMDATA%\MatricaRMZ-OpenCode`.
# Этот скрипт снимает ровно их: раскладка уходит целиком, по одной кнопке и с отчётом.
#
# Чего НЕ делает (осознанно):
#   * не трогает `%USERPROFILE%\.config\opencode` и `.local\share\opencode` — это личный
#     CLI, а не раскладка Матрицы (в конфиге живут авторизации провайдеров);
#   * не трогает правила брандмауэра с именем `opencode.exe` — под таким именем мог
#     появиться личный CLI, а не узел;
#   * не трогает порт 38080 и правило LAN-раздачи — это собственные следы раздачи
#     обновлений между машинами, к узлу они отношения не имели.
#
# Per-user следы (`%LOCALAPPDATA%\Programs\MatricaRMZ-OpenCode`, `opencode-nodes.json`,
# `opencode-agent-session.json`, песочница, `%TEMP%\matricarmz-opencode`) убирает сам
# клиент шагом клиентской миграции; скрипт только докладывает, что нашёл.
#
# Режимы:
#   opencode-cleanup.ps1          — снять раскладку (нужны права администратора)
#   opencode-cleanup.ps1 -Verify  — только показать, что найдено, ничего не менять
#   -AsLibrary                    — только определить функции (для окна обслуживания)
#
# Запуск: из окна обслуживания (вкладка «Уборка узла») либо
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\opencode-cleanup.ps1

[CmdletBinding()]
param(
  [switch]$Verify,
  # Не выполнять главный поток: скрипт подключают точкой из `matrica-ops.ps1`, которому нужны
  # только функции — построить панель своей вкладки и дёргать её кнопками.
  [switch]$AsLibrary
)

$ErrorActionPreference = 'Stop'

$OpencodeCleanupTaskPrefix = 'MatricaRMZ-OpenCode-serve'
$OpencodeCleanupFwRuleMask = 'MatricaRMZ - OpenCode serve*'
$OpencodeCleanupInstallDirName = 'MatricaRMZ-OpenCode'
$OpencodeCleanupPerUserDir = 'Programs\MatricaRMZ-OpenCode'

function Test-OpencodeCleanupAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-OpencodeCleanupInstallDir {
  return (Join-Path $env:PROGRAMDATA $OpencodeCleanupInstallDirName)
}

function Get-OpencodeCleanupPerUserDir {
  # Папка per-user раскладки у ТЕКУЩЕГО пользователя — для доклада, не для удаления.
  return (Join-Path $env:LOCALAPPDATA $OpencodeCleanupPerUserDir)
}

function Get-OpencodeCleanupTasks {
  return @(Get-ScheduledTask -ErrorAction SilentlyContinue |
    Where-Object { $_.TaskName -like ($OpencodeCleanupTaskPrefix + '*') })
}

function Get-OpencodeCleanupFwRules {
  # Имя правила — единственный якорь: `(входящий, LAN)` и ручные варианты («открытый») оба
  # начинаются с одного префикса, а чужие правила (`opencode.exe`) под маску не попадают.
  return @(Get-NetFirewallRule -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like $OpencodeCleanupFwRuleMask })
}

function Get-OpencodeCleanupProcesses {
  param([string]$InstallDir = '')
  if (-not $InstallDir) { $InstallDir = Get-OpencodeCleanupInstallDir }
  # Живой serve держит exe открытым и не даёт снести папку. Ищем по ПУТИ, а не по имени:
  # под именем `opencode` на машине может жить личный CLI (он остаётся).
  return @(Get-Process -Name 'opencode' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase) })
}

function Get-OpencodeCleanupReport {
  $lines = @()
  $tasks = @(Get-OpencodeCleanupTasks)
  $rules = @(Get-OpencodeCleanupFwRules)
  $dir = Get-OpencodeCleanupInstallDir
  $procs = @(Get-OpencodeCleanupProcesses -InstallDir $dir)
  $perUser = Get-OpencodeCleanupPerUserDir

  if ($tasks.Count -gt 0) {
    $lines += ('Задача(и) планировщика: ' + (($tasks | ForEach-Object { $_.TaskName }) -join ', ') + '.')
  } else {
    $lines += 'Задач планировщика нет.'
  }
  if ($rules.Count -gt 0) {
    $lines += ('Правило(а) брандмауэра: ' + (($rules | ForEach-Object { $_.DisplayName }) -join ', ') + '.')
  } else {
    $lines += 'Правил брандмауэра нет.'
  }
  if (Test-Path -LiteralPath $dir) {
    $lines += ('Папка бинаря: ' + $dir + '.')
  } else {
    $lines += 'Папки бинаря нет.'
  }
  if ($procs.Count -gt 0) {
    $lines += ('Работает сейчас: ' + $procs.Count + ' процесс(ов) serve — будут погашены.')
  }
  if (Test-Path -LiteralPath $perUser) {
    $lines += ('Следы в профиле оператора: ' + $perUser + ' — их уберёт сам клиент (обновите его).')
  }
  $lines += ''
  $lines += 'Не трогаю: `.config\opencode` и `.local\share\opencode` (личный CLI), правила с именем `opencode.exe`, порт 38080 LAN-раздачи.'
  ,$lines
}

function Invoke-OpencodeCleanup {
  if (-not (Test-OpencodeCleanupAdmin)) { throw 'Нужны права администратора: задачу и правило иначе не снять.' }
  $lines = @()

  $procs = @(Get-OpencodeCleanupProcesses)
  foreach ($p in $procs) {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    $lines += ('Процесс погашен: ' + $p.Id + '.')
  }

  $tasks = @(Get-OpencodeCleanupTasks)
  foreach ($t in $tasks) {
    Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false -ErrorAction SilentlyContinue
    $lines += ('Задача снята: ' + $t.TaskName + '.')
  }
  if ($tasks.Count -eq 0) { $lines += 'Задач не было — снимать нечего.' }

  $rules = @(Get-OpencodeCleanupFwRules)
  foreach ($r in $rules) {
    Remove-NetFirewallRule -DisplayName $r.DisplayName -ErrorAction SilentlyContinue
    $lines += ('Правило брандмауэра удалено: ' + $r.DisplayName + '.')
  }
  if ($rules.Count -eq 0) { $lines += 'Правила не было — удалять нечего.' }

  $dir = Get-OpencodeCleanupInstallDir
  if (Test-Path -LiteralPath $dir) {
    Remove-Item -LiteralPath $dir -Recurse -Force
    $lines += 'Папка бинаря удалена.'
  } else {
    $lines += 'Папки бинаря нет — удалять нечего.'
  }

  $lines += 'Конфиг оператора оставлен (там его авторизации провайдеров).'
  $lines += 'Готово: узла на машине нет.'
  ,$lines
}

# --------------------------------------------------------------------------------------
# Вкладка окна обслуживания
# --------------------------------------------------------------------------------------

function New-OpencodeCleanupPanel {

  Add-Type -AssemblyName System.Windows.Forms, System.Drawing

  $body = New-Object System.Windows.Forms.Panel
  $body.Dock = 'Fill'

  $head = New-Object System.Windows.Forms.Label
  $head.Dock = 'Top'; $head.Height = 78; $head.Padding = New-Object System.Windows.Forms.Padding(10, 8, 10, 0)
  $head.Text = "Модуль OpenCode-узлов вырезан из программы — эта вкладка снимает его следы:`r`n" +
  "задачу планировщика, правило брандмауэра и папку бинаря. Личный CLI владельца`r`n" +
  "(`.config\opencode`) и раздача обновлений (порт 38080) не трогаются."

  $log = New-Object System.Windows.Forms.TextBox
  $log.Dock = 'Fill'; $log.Multiline = $true; $log.ReadOnly = $true
  $log.ScrollBars = 'Vertical'
  $log.Font = New-Object System.Drawing.Font('Consolas', 9)
  $log.BackColor = [System.Drawing.Color]::White

  $bottom = New-Object System.Windows.Forms.FlowLayoutPanel
  $bottom.Dock = 'Bottom'; $bottom.Height = 48
  $bottom.Padding = New-Object System.Windows.Forms.Padding(10, 8, 10, 8)

  $write = {
    param([string[]]$Lines)
    $log.Text = ($Lines -join "`r`n")
  }.GetNewClosure()

  $bCheck = New-Object System.Windows.Forms.Button
  $bCheck.Text = 'Проверить'; $bCheck.Width = 130; $bCheck.Height = 30
  $bCheck.Add_Click({
      try { & $write (Get-OpencodeCleanupReport) }
      catch { & $write @([string]$_) }
    }.GetNewClosure())

  $bRemove = New-Object System.Windows.Forms.Button
  $bRemove.Text = 'Снять раскладку узла'; $bRemove.Width = 220; $bRemove.Height = 30
  $bRemove.Add_Click({
      $ask = [System.Windows.Forms.MessageBox]::Show(
        'Снять с машины раскладку OpenCode-узла? Задача планировщика, правило брандмауэра и папка бинаря уйдут; конфиг оператора останется.',
        'Подтверждение', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning)
      if ($ask -ne 'Yes') { return }
      try { & $write (Invoke-OpencodeCleanup) }
      catch { & $write @([string]$_) }
    }.GetNewClosure())

  $note = New-Object System.Windows.Forms.Label
  $note.AutoSize = $true; $note.Margin = New-Object System.Windows.Forms.Padding(12, 8, 0, 0)
  if (Test-OpencodeCleanupAdmin) {
    $note.Text = 'Права администратора есть — раскладку можно снять.'
    $note.ForeColor = [System.Drawing.Color]::DarkGreen
  } else {
    # Кнопки НЕ гасим (приём lan-share): пусть оператор нажмёт и прочитает, чего не хватает.
    $note.Text = 'Нужны права администратора — запустите окно ярлыком «Запустить-от-администратора».'
    $note.ForeColor = [System.Drawing.Color]::Firebrick
  }

  $bottom.Controls.Add($bCheck)
  $bottom.Controls.Add($bRemove)
  $bottom.Controls.Add($note)
  $body.Controls.Add($log)
  $body.Controls.Add($bottom)
  $body.Controls.Add($head)
  ,$body
}

# --------------------------------------------------------------------------------------
# Главный поток
# --------------------------------------------------------------------------------------

if ($AsLibrary) { return }

if ($Verify) {
  Get-OpencodeCleanupReport | ForEach-Object { Write-Host $_ }
  return
}

Invoke-OpencodeCleanup | ForEach-Object { Write-Host $_ }
