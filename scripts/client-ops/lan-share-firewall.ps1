# lan-share-firewall.ps1 — правило брандмауэра для раздачи обновлений между машинами цеха
#
# Зачем. Клиент «Матрица РМЗ» умеет отдавать скачанный установщик соседним машинам в сети
# завода: одна машина забирает 136 МБ с сервера, остальные — у неё. Для этого клиент слушает
# входящий TCP-порт, а Windows входящие соединения по умолчанию блокирует.
#
# Почему это отдельный скрипт, а не шаг установщика. Установщик собран как `oneClick` +
# `perMachine: false`, то есть ставится в профиль пользователя БЕЗ прав администратора.
# Правило брандмауэра требует прав администратора — установщик его создать не может в
# принципе. Поэтому правило ставится разовым обходом машин; удобно совместить с настройкой
# доверенной зоны антивируса (`kaspersky-matrica.ps1`) — одна ходка вместо двух. Обе утилиты
# живут на соседних вкладках окна обслуживания (`matrica-ops.ps1`) ровно поэтому.
#
# Что делает: создаёт ОДНО входящее разрешающее правило, максимально узкое —
#   * только TCP и только на порт раздачи (по умолчанию 38080);
#   * только для конкретного исполняемого файла клиента, а не «для порта вообще»;
#   * только из локальной подсети (LocalSubnet) — из интернета правило не действует;
#   * только в профилях «Домен» и «Частная сеть»; в «Общедоступной» — нет.
#
# Чего НЕ делает: не открывает порт наружу, не трогает другие правила, не меняет профиль
# сети и не включает саму раздачу — она включается настройкой клиента на сервере
# (в админке — тумблер раздачи у клиента), а не этим скриптом.
#
# Режимы:
#   lan-share-firewall.ps1              — создать (или обновить) правило
#   lan-share-firewall.ps1 -Verify      — только проверить, ничего не менять
#   lan-share-firewall.ps1 -Remove      — удалить правило
#   -Port <число>                       — другой порт (должен совпадать с портом клиента)
#   -ClientExe <путь>                   — указать .exe клиента явно, если не нашёлся сам
#   -AsLibrary                          — только определить функции (для окна обслуживания)
#
# Запуск: правой кнопкой по «Запустить-от-администратора.cmd» либо
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\lan-share-firewall.ps1

[CmdletBinding()]
param(
  [int]$Port = 38080,
  [string]$ClientExe = '',
  [switch]$Verify,
  [switch]$Remove,
  # Не выполнять главный поток: скрипт подключают точкой из `matrica-ops.ps1`, которому нужны
  # только функции — построить панель своей вкладки и дёргать её кнопками.
  [switch]$AsLibrary
)

$ErrorActionPreference = 'Stop'

# Имя правила фиксировано: по нему скрипт находит своё прежнее правило и обновляет его,
# вместо того чтобы плодить дубликаты при каждом запуске.
$RuleName = 'MatricaRMZ - раздача обновлений в локальной сети (входящий)'
$LanShareDefaultPort = 38080

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Find-ClientExe {
  # Путь приходит параметром, а не только из поиска: при подъёме прав на НЕадминской учётке
  # оператор вводит чужие данные, и элевированный процесс идёт в ЧУЖОЙ профиль — там клиента
  # нет вовсе. Матрица знает свой `process.execPath` и передаёт его окну обслуживания сама.
  param([string]$Path = $ClientExe)
  if ($Path) {
    if (Test-Path -LiteralPath $Path) { return (Resolve-Path -LiteralPath $Path).Path }
    throw "Указанный путь к клиенту не найден: $Path"
  }
  $localAppData = $env:LOCALAPPDATA
  $candidates = @(
    (Join-Path $localAppData 'Programs\MatricaRMZ\MatricaRMZ.exe'),
    # Каталог установки до 2026-08: electron-builder брал имя папки из `name` пакета.
    (Join-Path $localAppData 'Programs\@matricarmzelectron-app\MatricaRMZ.exe')
  )
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) { return (Resolve-Path -LiteralPath $c).Path }
  }
  return $null
}

function Get-Rule {
  Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
}

<#
    Состояние одним куском ТЕКСТА, а не через Write-Host: этот же отчёт печатается в консоли
    режимом -Verify и кладётся в поле журнала на вкладке. Разошлись бы два способа рассказать
    про одно правило — разошлись бы и ответы на вопрос «стоит ли оно тут».

    Отдаётся через `,$lines` — так список из ОДНОЙ строки не схлопывается в скаляр. Плата за
    это в том, что в конвейере результат приезжает одним элементом: перебирать его надо
    `foreach ($line in (Get-LanShareReport …))`, а не `| ForEach-Object`, иначе Write-Host
    склеит весь отчёт в одну строку через пробел.
#>
function Get-LanShareReport {
  param([int]$RulePort = $LanShareDefaultPort, [string]$ExePath = '')

  $lines = @()
  $rule = Get-Rule
  if (-not $rule) {
    $lines += 'Правило брандмауэра: НЕ НАЙДЕНО — соседние машины не смогут забрать установщик у этой.'
  } else {
    $ports = $rule | Get-NetFirewallPortFilter
    $addr = $rule | Get-NetFirewallAddressFilter
    $app = $rule | Get-NetFirewallApplicationFilter
    $lines += 'Правило брандмауэра: НАЙДЕНО'
    $lines += ("  включено:  {0}" -f $rule.Enabled)
    $lines += ("  действие:  {0}" -f $rule.Action)
    $lines += ("  профили:   {0}" -f $rule.Profile)
    $lines += ("  порт:      {0}/{1}" -f $ports.LocalPort, $ports.Protocol)
    $lines += ("  откуда:    {0}" -f ($addr.RemoteAddress -join ', '))
    $lines += ("  программа: {0}" -f $app.Program)
  }

  $exe = $null
  try { $exe = Find-ClientExe -Path $ExePath } catch { $exe = $null }
  if ($exe) { $lines += "Клиент Матрицы: $exe" }
  else { $lines += 'Клиент Матрицы: не найден в обычных местах установки' }

  $listening = Get-NetTCPConnection -State Listen -LocalPort $RulePort -ErrorAction SilentlyContinue
  if ($listening) {
    $lines += "Порт $RulePort сейчас слушается — раздача включена и работает."
  } else {
    # Это НЕ ошибка: клиент открывает порт, только когда у него есть скачанный установщик,
    # которым есть с кем поделиться. Пустой результат ничего не доказывает про правило.
    $lines += "Порт $RulePort сейчас не слушается (клиент открывает его, только когда есть что раздавать)."
  }
  ,$lines
}

<#
    Создать или обновить правило. Возвращает строки отчёта; права проверяет сама — вызывающему
    (кнопке на вкладке) не нужно знать, какие именно операции их требуют.
#>
function Set-LanShareRule {
  param([int]$RulePort = $LanShareDefaultPort, [string]$ExePath = '')

  if (-not (Test-Admin)) { throw 'Нужны права администратора: правило брандмауэра иначе не создать.' }
  $exe = Find-ClientExe -Path $ExePath
  if (-not $exe) {
    throw 'Не нашёл .exe клиента в обычных местах установки. Укажите путь явно в поле «Программа клиента».'
  }

  $lines = @()
  if (Get-Rule) {
    # Обновляем на месте: пересоздание меняло бы идентификатор правила, а групповые политики
    # и инвентаризация ориентируются на него.
    Set-NetFirewallRule -DisplayName $RuleName -Enabled True -Action Allow -Profile Domain, Private -Program $exe
    Set-NetFirewallRule -DisplayName $RuleName -LocalPort $RulePort -Protocol TCP
    Set-NetFirewallRule -DisplayName $RuleName -RemoteAddress LocalSubnet
    $lines += 'Правило обновлено.'
  } else {
    New-NetFirewallRule `
      -DisplayName $RuleName `
      -Description 'Разрешает соседним машинам цеха забирать скачанный установщик Матрицы у этого компьютера. Только локальная подсеть.' `
      -Direction Inbound `
      -Action Allow `
      -Protocol TCP `
      -LocalPort $RulePort `
      -RemoteAddress LocalSubnet `
      -Program $exe `
      -Profile Domain, Private `
      -Enabled True | Out-Null
    $lines += 'Правило создано.'
  }
  $lines += (Get-LanShareReport -RulePort $RulePort -ExePath $exe)
  $lines += ''
  $lines += 'Осталось включить саму раздачу для этой машины в админке (тумблер раздачи у клиента).'
  $lines += 'Настройка читается при запуске клиента — после включения его надо перезапустить.'
  ,$lines
}

function Remove-LanShareRule {
  if (-not (Test-Admin)) { throw 'Нужны права администратора: правило брандмауэра иначе не удалить.' }
  if (-not (Get-Rule)) { return , @('Правила нет — удалять нечего.') }
  Remove-NetFirewallRule -DisplayName $RuleName
  , @('Правило удалено.')
}

# --------------------------------------------------------------------------------------
# Вкладка окна обслуживания
# --------------------------------------------------------------------------------------

function New-LanSharePanel {
  param([int]$RulePort = $LanShareDefaultPort, [string]$ExePath = '')

  Add-Type -AssemblyName System.Windows.Forms, System.Drawing

  $body = New-Object System.Windows.Forms.Panel
  $body.Dock = 'Fill'

  $head = New-Object System.Windows.Forms.Label
  $head.Dock = 'Top'; $head.Height = 92; $head.Padding = New-Object System.Windows.Forms.Padding(10, 8, 10, 0)
  $head.Text = "Одна машина забирает обновление с сервера (136 МБ), остальные — у неё по локальной сети.`r`n" +
  "Кнопка ниже создаёт ОДНО входящее правило: только TCP, только порт раздачи, только для файла`r`n" +
  "клиента и только из своей подсети. Наружу, в интернет, это правило не действует.`r`n" +
  'Само включение раздачи — тумблер у клиента в админке, не здесь.'

  $fields = New-Object System.Windows.Forms.TableLayoutPanel
  $fields.Dock = 'Top'; $fields.Height = 72; $fields.ColumnCount = 4; $fields.RowCount = 2
  $fields.Padding = New-Object System.Windows.Forms.Padding(10, 4, 10, 4)

  $lblPort = New-Object System.Windows.Forms.Label
  $lblPort.Text = 'Порт раздачи:'; $lblPort.AutoSize = $true
  $lblPort.Margin = New-Object System.Windows.Forms.Padding(0, 6, 6, 0)
  $tbPort = New-Object System.Windows.Forms.TextBox
  $tbPort.Text = [string]$RulePort; $tbPort.Width = 80

  $lblExe = New-Object System.Windows.Forms.Label
  $lblExe.Text = 'Программа клиента:'; $lblExe.AutoSize = $true
  $lblExe.Margin = New-Object System.Windows.Forms.Padding(16, 6, 6, 0)
  $tbExe = New-Object System.Windows.Forms.TextBox
  $tbExe.Width = 520
  $resolved = $null
  try { $resolved = Find-ClientExe -Path $ExePath } catch { $resolved = $null }
  $tbExe.Text = if ($resolved) { $resolved } else { '' }

  $fields.Controls.Add($lblPort, 0, 0)
  $fields.Controls.Add($tbPort, 1, 0)
  $fields.Controls.Add($lblExe, 2, 0)
  $fields.Controls.Add($tbExe, 3, 0)

  $log = New-Object System.Windows.Forms.TextBox
  $log.Dock = 'Fill'; $log.Multiline = $true; $log.ReadOnly = $true
  $log.ScrollBars = 'Vertical'
  $log.Font = New-Object System.Drawing.Font('Consolas', 9)
  $log.BackColor = [System.Drawing.Color]::White

  $bottom = New-Object System.Windows.Forms.FlowLayoutPanel
  $bottom.Dock = 'Bottom'; $bottom.Height = 48
  $bottom.Padding = New-Object System.Windows.Forms.Padding(10, 8, 10, 8)

  # Порт разбирается в одном месте: иначе «38080 » с пробелом или пустое поле роняли бы
  # кнопку исключением вместо внятной строки в журнале.
  $readPort = {
    $parsed = 0
    if (-not [int]::TryParse($tbPort.Text.Trim(), [ref]$parsed) -or $parsed -lt 1 -or $parsed -gt 65535) {
      throw "Порт «$($tbPort.Text)» — не число от 1 до 65535."
    }
    $parsed
  }.GetNewClosure()

  $write = {
    param([string[]]$Lines)
    $log.Text = ($Lines -join "`r`n")
  }.GetNewClosure()

  $bCheck = New-Object System.Windows.Forms.Button
  $bCheck.Text = 'Проверить'; $bCheck.Width = 130; $bCheck.Height = 30
  $bCheck.Add_Click({
      try { & $write (Get-LanShareReport -RulePort (& $readPort) -ExePath $tbExe.Text.Trim()) }
      catch { & $write @([string]$_) }
    }.GetNewClosure())

  $bApply = New-Object System.Windows.Forms.Button
  $bApply.Text = 'Создать / обновить правило'; $bApply.Width = 210; $bApply.Height = 30
  $bApply.Add_Click({
      try { & $write (Set-LanShareRule -RulePort (& $readPort) -ExePath $tbExe.Text.Trim()) }
      catch { & $write @([string]$_) }
    }.GetNewClosure())

  $bRemove = New-Object System.Windows.Forms.Button
  $bRemove.Text = 'Удалить правило'; $bRemove.Width = 150; $bRemove.Height = 30
  $bRemove.Add_Click({
      $ask = [System.Windows.Forms.MessageBox]::Show(
        'Удалить правило? Эта машина перестанет отдавать обновления соседям — каждая из них снова пойдёт за установщиком на сервер.',
        'Подтверждение', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning)
      if ($ask -ne 'Yes') { return }
      try { & $write (Remove-LanShareRule) }
      catch { & $write @([string]$_) }
    }.GetNewClosure())

  $note = New-Object System.Windows.Forms.Label
  $note.AutoSize = $true; $note.Margin = New-Object System.Windows.Forms.Padding(12, 8, 0, 0)
  if (Test-Admin) {
    $note.Text = 'Права администратора есть — правило можно создать.'
    $note.ForeColor = [System.Drawing.Color]::DarkGreen
  } else {
    # Кнопки НЕ гасим: пусть оператор нажмёт и прочитает в журнале, чего именно не хватает.
    # Погашенная кнопка без объяснения — это «не работает», а не «нужны права».
    $note.Text = 'Без прав администратора правило не создать — «Проверить» работает, остальное скажет, чего не хватает.'
    $note.ForeColor = [System.Drawing.Color]::Firebrick
  }

  $bottom.Controls.AddRange(@($bCheck, $bApply, $bRemove))

  # Подпись — СВОЕЙ полосой, а не четвёртым элементом в ряду кнопок: в FlowLayoutPanel она
  # уезжала на вторую строку и обрезалась высотой полосы, то есть её просто не было видно.
  $noteBar = New-Object System.Windows.Forms.Panel
  $noteBar.Dock = 'Bottom'; $noteBar.Height = 24
  $note.Dock = 'Fill'
  $note.AutoSize = $false
  $note.Margin = New-Object System.Windows.Forms.Padding(0)
  $note.Padding = New-Object System.Windows.Forms.Padding(10, 4, 10, 0)
  $noteBar.Controls.Add($note)

  # Fill-панель добавляется первой: WinForms раздаёт края в порядке добавления.
  $body.Controls.Add($log)
  $body.Controls.Add($noteBar)
  $body.Controls.Add($bottom)
  $body.Controls.Add($fields)
  $body.Controls.Add($head)

  # Состояние показываем сразу при открытии вкладки: первый вопрос оператора — «а стоит ли
  # оно тут уже», и ответ на него не должен стоить нажатия.
  try { & $write (Get-LanShareReport -RulePort $RulePort -ExePath $tbExe.Text.Trim()) }
  catch { & $write @([string]$_) }

  return $body
}

# --------------------------------------------------------------------------------------
# Главный поток
# --------------------------------------------------------------------------------------

# Подключение точкой (`-AsLibrary`) обрывается здесь: окну обслуживания нужны функции выше.
if ($AsLibrary) { return }

if ($Verify) {
  foreach ($line in (Get-LanShareReport -RulePort $Port -ExePath $ClientExe)) { Write-Host $line }
  exit 0
}

if ($Remove) {
  try {
    foreach ($line in (Remove-LanShareRule)) { Write-Host $line -ForegroundColor Green }
    exit 0
  } catch {
    Write-Host ([string]$_) -ForegroundColor Red
    Write-Host 'Запустите через «Запустить-от-администратора.cmd» или из консоли администратора.' -ForegroundColor Red
    exit 1
  }
}

try {
  foreach ($line in (Set-LanShareRule -RulePort $Port -ExePath $ClientExe)) { Write-Host $line }
} catch {
  Write-Host ([string]$_) -ForegroundColor Red
  Write-Host 'Запустите через «Запустить-от-администратора.cmd» или из консоли администратора.' -ForegroundColor Red
  exit 1
}
