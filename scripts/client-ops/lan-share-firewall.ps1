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
# доверенной зоны антивируса (`kaspersky-matrica.ps1`) — одна ходка вместо двух.
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
#
# Запуск: правой кнопкой по «Запустить-от-администратора.cmd» либо
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\lan-share-firewall.ps1

[CmdletBinding()]
param(
  [int]$Port = 38080,
  [string]$ClientExe = '',
  [switch]$Verify,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

# Имя правила фиксировано: по нему скрипт находит своё прежнее правило и обновляет его,
# вместо того чтобы плодить дубликаты при каждом запуске.
$RuleName = 'MatricaRMZ - раздача обновлений в локальной сети (входящий)'

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Find-ClientExe {
  if ($ClientExe) {
    if (Test-Path -LiteralPath $ClientExe) { return (Resolve-Path -LiteralPath $ClientExe).Path }
    throw "Указанный -ClientExe не найден: $ClientExe"
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

function Show-Rule($rule) {
  if (-not $rule) {
    Write-Host 'Правило: НЕ НАЙДЕНО' -ForegroundColor Yellow
    return
  }
  $ports = $rule | Get-NetFirewallPortFilter
  $addr = $rule | Get-NetFirewallAddressFilter
  $app = $rule | Get-NetFirewallApplicationFilter
  Write-Host 'Правило: НАЙДЕНО' -ForegroundColor Green
  Write-Host ("  включено:  {0}" -f $rule.Enabled)
  Write-Host ("  действие:  {0}" -f $rule.Action)
  Write-Host ("  профили:   {0}" -f $rule.Profile)
  Write-Host ("  порт:      {0}/{1}" -f $ports.LocalPort, $ports.Protocol)
  Write-Host ("  откуда:    {0}" -f ($addr.RemoteAddress -join ', '))
  Write-Host ("  программа: {0}" -f $app.Program)
}

if ($Verify) {
  Show-Rule (Get-Rule)
  $exe = Find-ClientExe
  if ($exe) { Write-Host "Клиент найден: $exe" } else { Write-Host 'Клиент не найден в обычных местах установки' -ForegroundColor Yellow }
  $listening = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if ($listening) {
    Write-Host "Порт $Port сейчас слушается — раздача включена и работает" -ForegroundColor Green
  } else {
    # Это НЕ ошибка: клиент открывает порт, только когда у него есть скачанный установщик,
    # которым есть с кем поделиться. Пустой результат ничего не доказывает про правило.
    Write-Host "Порт $Port сейчас не слушается (клиент открывает его, только когда есть что раздавать)" -ForegroundColor Yellow
  }
  exit 0
}

if (-not (Test-Admin)) {
  Write-Host 'Нужны права администратора: правило брандмауэра иначе не создать.' -ForegroundColor Red
  Write-Host 'Запустите через «Запустить-от-администратора.cmd» или из консоли администратора.' -ForegroundColor Red
  exit 1
}

if ($Remove) {
  $rule = Get-Rule
  if (-not $rule) {
    Write-Host 'Правила нет — удалять нечего.'
    exit 0
  }
  Remove-NetFirewallRule -DisplayName $RuleName
  Write-Host 'Правило удалено.' -ForegroundColor Green
  exit 0
}

$exe = Find-ClientExe
if (-not $exe) {
  Write-Host 'Не нашёл .exe клиента в обычных местах установки.' -ForegroundColor Red
  Write-Host 'Укажите путь явно: lan-share-firewall.ps1 -ClientExe "C:\путь\MatricaRMZ.exe"' -ForegroundColor Red
  exit 1
}

$existing = Get-Rule
if ($existing) {
  # Обновляем на месте: пересоздание меняло бы идентификатор правила, а групповые политики
  # и инвентаризация ориентируются на него.
  Set-NetFirewallRule -DisplayName $RuleName -Enabled True -Action Allow -Profile Domain,Private -Program $exe
  Set-NetFirewallRule -DisplayName $RuleName -LocalPort $Port -Protocol TCP
  Set-NetFirewallRule -DisplayName $RuleName -RemoteAddress LocalSubnet
  Write-Host 'Правило обновлено.' -ForegroundColor Green
} else {
  New-NetFirewallRule `
    -DisplayName $RuleName `
    -Description 'Разрешает соседним машинам цеха забирать скачанный установщик Матрицы у этого компьютера. Только локальная подсеть.' `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -RemoteAddress LocalSubnet `
    -Program $exe `
    -Profile Domain,Private `
    -Enabled True | Out-Null
  Write-Host 'Правило создано.' -ForegroundColor Green
}

Show-Rule (Get-Rule)
Write-Host ''
Write-Host 'Осталось включить саму раздачу для этой машины в админке (тумблер раздачи у клиента).' -ForegroundColor Cyan
Write-Host 'Настройка читается при запуске клиента — после включения его надо перезапустить.' -ForegroundColor Cyan
