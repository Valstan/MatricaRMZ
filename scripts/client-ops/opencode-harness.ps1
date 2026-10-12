# opencode-harness.ps1 — тихая установка OpenCode-узла (serve) на машину парка
#
# Зачем. Мандат brain 2026-10-12 opencode-silent-deploy: на рабочих станциях, где стоит
# Матрица, в фоне живёт `opencode serve` (нейросети свободных моделей), а суперадмин видит
# узлы в разделе «OpenCode-узлы» клиента. Этот скрипт — та самая «тихая установка»:
# качает релиз с GitHub, проверяет SHA256, кладёт бинарь машино-широко, регистрирует
# задачу планировщика, правило брандмауэра и запись в локальный реестр узлов.
#
# Что ставит и как оно устроено:
#   * бинарь: %PROGRAMDATA%\MatricaRMZ-OpenCode\opencode.exe (машино-широко, не в профиле —
#     окно обслуживания часто поднято под ЧУЖОЙ учёткой, и профиль текущего пользователя
#     может быть не операторским);
#   * служба: задача планировщика `MatricaRMZ-OpenCode-serve-<оператор>` — триггер «при входе
#     оператора», выполняется ОТ ЕГО ИМЕНИ (без повышенных прав): serve читает конфиг и
#     авторизацию провайдеров из ЕГО профиля, а не из системного;
#   * конфиг: <профиль оператора>\.config\opencode\opencode.jsonc — создаётся, только если его
#     нет (чужой не затираем); `model` не задаём до подключения провайдеров;
#   * сеть: `opencode serve --port <порт> --hostname 0.0.0.0` + входящее правило брандмауэра
#     (только TCP, только порт serve, только для opencode.exe, только LocalSubnet,
#     только профили «Домен»/«Частная сеть») — наружу правило не действует;
#   * реестр: запись {имя машины, http://<LAN-IP>:<порт>} вливается в opencode-nodes.json
#     в UserDataDir клиента (если он передан) — оттуда её читает раздел «OpenCode-узлы».
#
# Чего НЕ делает: не включает авторизацию serve (решение владельца — только подсеть),
# не логинит провайдеров (это делает владелец под учёткой оператора: `opencode auth login`),
# не ставит Матрицу (её тут нет и не будет — только serve).
#
# Касперский. Свежий неподписанный opencode.exe эвристика может съесть (та же грабля M94,
# что ела наши .ps1). После установки добавьте %PROGRAMDATA%\MatricaRMZ-OpenCode в исключения
# вкладкой «Антивирус» — скрипт сам напоминает об этом в отчёте.
#
# Режимы:
#   opencode-harness.ps1                    — установить (или обновить) узел
#   opencode-harness.ps1 -Verify             — только проверить, ничего не менять
#   opencode-harness.ps1 -Remove             — снять узел (задача, правило, бинарь; конфиг
#                                             оператора остаётся — там его авторизации)
#   -Port <число>                            — порт serve (по умолчанию 3080, решение 12.10)
#   -Version <x.y.z>                         — приколоть версию вместо latest
#   -AssetName <имя.zip>                     — другой ассет (например, arm64)
#   -UserDataDir <путь>                      — папка данных клиента (для реестра узлов;
#                                             окно обслуживания передаёт её само)
#   -AsLibrary                               — только определить функции (для окна обслуживания)
#
# Запуск: из окна обслуживания (вкладка «OpenCode-узел») либо
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\opencode-harness.ps1 -Verify

[CmdletBinding()]
param(
  [int]$Port = 3080,
  [string]$Version = '',
  [string]$AssetName = '',
  [string]$UserDataDir = '',
  [switch]$Verify,
  [switch]$Remove,
  # Не выполнять главный поток: скрипт подключают точкой из `matrica-ops.ps1`, которому нужны
  # только функции — построить панель своей вкладки и дёргать её кнопками.
  [switch]$AsLibrary
)

$ErrorActionPreference = 'Stop'

$OpencodeTaskPrefix = 'MatricaRMZ-OpenCode-serve'
$OpencodeFwRuleName = 'MatricaRMZ - OpenCode serve (входящий, LAN)'
$OpencodeInstallDirName = 'MatricaRMZ-OpenCode'
$OpencodeExeName = 'opencode.exe'
$OpencodeConfigRelPath = '.config\opencode\opencode.jsonc'
$OpencodeNodesFileName = 'opencode-nodes.json'
$OpencodeReleasesApi = 'https://api.github.com/repos/anomalyco/opencode/releases'
$OpencodeServeHealthPath = '/global/health'

function Test-OpencodeAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-OpencodeInstallDir {
  return (Join-Path $env:PROGRAMDATA $OpencodeInstallDirName)
}

function Get-OpencodeExePath {
  return (Join-Path (Get-OpencodeInstallDir) $OpencodeExeName)
}

function Get-DefaultOpencodeAsset {
  $arch = (Get-WmiObject Win32_Processor | Select-Object -First 1).Architecture
  # 9 = x64, 12 = ARM64 (Win32_Processor.Architecture).
  if ($arch -eq 12) { return 'opencode-windows-arm64.zip' }
  return 'opencode-windows-x64.zip'
}

function Get-OpencodeReleaseAsset {
  param([string]$PinVersion = '', [string]$WantedAsset = '')
  # TLS 1.2 на PS 5.1 сам не всегда включается — без него GitHub рвёт соединение.
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
  $want = $WantedAsset
  if (-not $want) { $want = Get-DefaultOpencodeAsset }
  $apiUrl = $OpencodeReleasesApi + '/latest'
  if ($PinVersion) { $apiUrl = ('{0}/tags/v{1}' -f $OpencodeReleasesApi, $PinVersion.TrimStart('v')) }
  $rel = Invoke-RestMethod -Uri $apiUrl -TimeoutSec 60
  $asset = @($rel.assets) | Where-Object { $_.name -eq $want } | Select-Object -First 1
  if (-not $asset) {
    $names = (@($rel.assets) | ForEach-Object { $_.name }) -join ', '
    throw "В релизе $($rel.tag_name) нет ассета $want (есть: $names). Укажите -AssetName явно."
  }
  $sha = [string]$asset.digest
  if ($sha -like 'sha256:*') { $sha = $sha.Substring(7) }
  if (-not $sha) { throw "У ассета $want нет digest в API GitHub — ставить без SHA256 отказываюсь." }
  return @{
    tag = [string]$rel.tag_name
    name = [string]$asset.name
    url = [string]$asset.browser_download_url
    size = [long]$asset.size
    sha256 = $sha.ToLowerInvariant()
  }
}

function Get-OpencodeInstalledVersion {
  param([string]$ExePath = '')
  $exe = $ExePath
  if (-not $exe) { $exe = Get-OpencodeExePath }
  if (-not (Test-Path -LiteralPath $exe)) { return '' }
  try {
    $out = & $exe --version 2>$null | Select-Object -First 2 | Out-String
    $m = [regex]::Match($out, '\d+\.\d+\.\d+')
    if ($m.Success) { return $m.Value }
    return $out.Trim()
  } catch { return '' }
}

function Get-OpencodeOperator {
  # Кто оператор: профиль выводим из UserDataDir (окно его передаёт), иначе — текущий.
  # Нужно, чтобы конфиг лёг в ЕГО профиль, а задача планировщика бежала ОТ ЕГО ИМЕНИ
  # (serve читает авторизации провайдеров из профиля исполнителя).
  param([string]$DataDir = '')
  $profile = $null
  if ($DataDir) {
    $full = $DataDir.Replace('/', '\')
    $m = [regex]::Match($full, '^(.*)\\AppData\\', 'IgnoreCase')
    if ($m.Success) { $profile = $m.Groups[1].Value }
  }
  if (-not $profile -and $env:USERPROFILE) { $profile = $env:USERPROFILE }
  if (-not $profile) { return $null }
  $user = Split-Path -Leaf $profile
  if (-not $user -or ($user -match '[\\/:*?"<>|]')) { return $null }
  return @{ profile = $profile; user = $user }
}

function Get-OpencodeServeTasks {
  Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like "$OpencodeTaskPrefix*" }
}

function Get-OpencodeFwRule {
  Get-NetFirewallRule -DisplayName $OpencodeFwRuleName -ErrorAction SilentlyContinue
}

function Get-OpencodeLanIp {
  $addrs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
    Sort-Object { $_.InterfaceMetric } |
    Select-Object -ExpandProperty IPAddress
  if ($addrs) { return @($addrs)[0] }
  return ''
}

function Get-OpencodeServeHealth {
  param([int]$ServePort = 3080)
  try {
    $r = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}{1}" -f $ServePort, $OpencodeServeHealthPath) -TimeoutSec 5 -UseBasicParsing
    if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) {
      $ver = ''
      try { $ver = [string]($r.Content | ConvertFrom-Json).version } catch {}
      return @{ live = $true; version = $ver }
    }
    return @{ live = $true; version = '' }
  } catch { return @{ live = $false; version = '' } }
}

<#
    Состояние одним куском ТЕКСТА (как Get-LanShareReport в lan-share-firewall.ps1):
    тот же отчёт печатает -Verify в консоль и кладёт в журнал вкладка.
    Отдаётся через `,$lines`, чтобы список из одной строки не схлопывался в скаляр.
#>
function Get-OpencodeReport {
  param([int]$ServePort = 3080, [string]$DataDir = '')

  $lines = @()
  $exe = Get-OpencodeExePath
  $ver = Get-OpencodeInstalledVersion -ExePath $exe
  if ($ver) { $lines += "Бинарь: $exe (версия $ver)" }
  else { $lines += 'Бинарь: НЕ УСТАНОВЛЕН — serve на этой машине не стоит.' }

  $op = Get-OpencodeOperator -DataDir $DataDir
  if ($op) {
    $cfg = Join-Path $op.profile $OpencodeConfigRelPath
    if (Test-Path -LiteralPath $cfg) { $lines += "Конфиг оператора ($($op.user)): есть" }
    else { $lines += "Конфиг оператора ($($op.user)): нет — создастся при установке" }
  } else {
    $lines += 'Оператор: не определён (передайте -UserDataDir) — конфиг и задача не привяжутся.'
  }

  $tasks = @(Get-OpencodeServeTasks)
  if ($tasks.Count -eq 0) { $lines += 'Задача планировщика: НЕТ — serve не запускается сам.' }
  else {
    foreach ($t in $tasks) {
      $info = Get-ScheduledTaskInfo -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction SilentlyContinue
      $lines += ("Задача {0}: {1}, последний запуск: {2}" -f $t.TaskName, $t.State, $(if ($info) { $info.LastTaskResult } else { '?' }))
    }
  }

  $rule = Get-OpencodeFwRule
  if ($rule) { $lines += ("Правило брандмауэра: НАЙДЕНО ({0}, {1})" -f $rule.Enabled, $rule.Profile) }
  else { $lines += 'Правило брандмауэра: НЕТ — соседи не достучатся до serve.' }

  $listening = Get-NetTCPConnection -State Listen -LocalPort $ServePort -ErrorAction SilentlyContinue
  if ($listening) {
    $h = Get-OpencodeServeHealth -ServePort $ServePort
    if ($h.live) { $lines += ("Порт {0} слушается, serve отвечает{1}." -f $ServePort, $(if ($h.version) { " (версия $($h.version))" } else { '' })) }
    else { $lines += "Порт $ServePort слушается, но serve не отвечает — смотрит чужой процесс или serve завис." }
  } else {
    $lines += "Порт $ServePort сейчас не слушается."
  }
  ,$lines
}

function Install-OpencodeHarness {
  param([int]$ServePort = 3080, [string]$PinVersion = '', [string]$WantedAsset = '', [string]$DataDir = '')

  if (-not (Test-OpencodeAdmin)) { throw 'Нужны права администратора: задача планировщика и правило брандмауэра иначе не создать.' }
  $op = Get-OpencodeOperator -DataDir $DataDir
  if (-not $op) { throw 'Не определён оператор: передайте -UserDataDir (окно обслуживания делает это само).' }

  $lines = @()
  $asset = Get-OpencodeReleaseAsset -PinVersion $PinVersion -WantedAsset $WantedAsset
  $lines += ("Релиз: {0}, ассет {1} ({2} МБ)." -f $asset.tag, $asset.name, ([math]::Round($asset.size / 1MB, 1)))

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('opencode-' + [IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    $zipPath = Join-Path $tmp $asset.name
    # Релиз ~60 МБ: таймаут с запасом (мандат требует не меньше 10 минут на шаг установки).
    Invoke-WebRequest -Uri $asset.url -OutFile $zipPath -TimeoutSec 900 -UseBasicParsing
    $got = Get-Item -LiteralPath $zipPath
    if ($got.Length -ne $asset.size) { throw ("Размер скачанного не сошёлся: ждали {0}, приехало {1}." -f $asset.size, $got.Length) }
    $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $asset.sha256) { throw 'SHA256 скачанного не сошёлся с digest релиза — ставить отказываюсь.' }
    $lines += 'Скачано, размер и SHA256 сошлись.'

    $dir = Get-OpencodeInstallDir
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    # Распаковываем поверх: новая версия заменяет opencode.exe на месте, конфиг не трогаем.
    Expand-Archive -LiteralPath $zipPath -DestinationPath $dir -Force
    $exe = Get-OpencodeExePath
    if (-not (Test-Path -LiteralPath $exe)) { throw "В ассете нет $OpencodeExeName — раскладка релиза изменилась, скрипт надо обновить." }
    $lines += ("Бинарь: $exe (версия $(Get-OpencodeInstalledVersion -ExePath $exe)).")
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  # Конфиг оператора: только если его нет. `model` не задаём до подключения провайдеров.
  $cfgPath = Join-Path $op.profile $OpencodeConfigRelPath
  if (-not (Test-Path -LiteralPath $cfgPath)) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $cfgPath) -Force | Out-Null
    # Без BOM: конфиг читает машина (jsonc-парсер opencode).
    [IO.File]::WriteAllText($cfgPath, "// Создан MatricaRMZ (opencode-harness). model не задавать до подключения провайдеров.`r`n{}`r`n", (New-Object Text.UTF8Encoding($false)))
    $lines += "Конфиг создан: $cfgPath."
  } else {
    $lines += 'Конфиг оператора уже есть — не трогаем.'
  }

  # Задача планировщика: при входе оператора, от его имени (иначе serve не увидит его авторизации).
  $taskName = ('{0}-{1}' -f $OpencodeTaskPrefix, $op.user)
  $old = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($old) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
  $action = New-ScheduledTaskAction -Execute $exe -Argument ("serve --port {0} --hostname 0.0.0.0" -f $ServePort) -WorkingDirectory $dir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $op.user
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -User $op.user `
    -Description 'OpenCode serve для раздела «OpenCode-узлы» Матрицы (мандат 2026-10-12). Порт и хост — аргументами задачи.' | Out-Null
  # Чтобы не требовать перелогина: запустить сразу, если оператор сейчас в системе.
  try { Start-ScheduledTask -TaskName $taskName -ErrorAction Stop } catch {}
  $lines += ("Задача планировщика: $taskName (при входе $($op.user), запущена).")

  # Брандмауэр: узко, как раздача обновлений — TCP, порт serve, только opencode.exe,
  # только LocalSubnet, только Домен/Частная.
  if (Get-OpencodeFwRule) {
    Set-NetFirewallRule -DisplayName $OpencodeFwRuleName -Enabled True -Action Allow -Profile Domain, Private -Program $exe
    Set-NetFirewallRule -DisplayName $OpencodeFwRuleName -LocalPort $ServePort -Protocol TCP
    Set-NetFirewallRule -DisplayName $OpencodeFwRuleName -RemoteAddress LocalSubnet
    $lines += 'Правило брандмауэра обновлено.'
  } else {
    New-NetFirewallRule `
      -DisplayName $OpencodeFwRuleName `
      -Description 'Разрешает соседним машинам цеха обращаться к OpenCode serve этого компьютера. Только локальная подсеть.' `
      -Direction Inbound `
      -Action Allow `
      -Protocol TCP `
      -LocalPort $ServePort `
      -RemoteAddress LocalSubnet `
      -Program $exe `
      -Profile Domain, Private `
      -Enabled True | Out-Null
    $lines += 'Правило брандмауэра создано.'
  }

  # Реестр узлов клиента: влить {имя машины, LAN-адрес} в opencode-nodes.json.
  if ($DataDir -and (Test-Path -LiteralPath $DataDir)) {
    $ip = Get-OpencodeLanIp
    if ($ip) {
      $regPath = Join-Path $DataDir $OpencodeNodesFileName
      $nodes = @()
      try {
        $raw = [IO.File]::ReadAllText($regPath)
        $parsed = $raw | ConvertFrom-Json
        if ($parsed.nodes) { $nodes = @($parsed.nodes) }
      } catch {}
      $url = ('http://{0}:{1}' -f $ip, $ServePort)
      $nodes = @($nodes | Where-Object { [string]$_.url -ne $url })
      $nodes += [pscustomobject]@{ name = $env:COMPUTERNAME; url = $url }
      # Без BOM: файл читает Node (JSON.parse падает на BOM).
      $json = (@{ nodes = @($nodes) } | ConvertTo-Json -Depth 4)
      [IO.File]::WriteAllText($regPath, $json, (New-Object Text.UTF8Encoding($false)))
      $lines += ("Реестр узлов: $url.")
    } else {
      $lines += 'LAN-адрес не определён — запись в реестр узлов пропущена (внесётся из раздела «OpenCode-узлы»).'
    }
  } else {
    $lines += 'UserDataDir не передан — запись в реестр узлов пропущена (внесётся из раздела «OpenCode-узлы»).'
  }

  $lines += ''
  $lines += 'Дальше: добавьте папку бинаря в исключения Касперского вкладкой «Антивирус» (свежий неподписанный exe эвристика может съесть), провайдеров логиньте под учёткой оператора (`opencode auth login`).'
  ,$lines
}

function Remove-OpencodeHarness {
  if (-not (Test-OpencodeAdmin)) { throw 'Нужны права администратора: задачу и правило иначе не снять.' }
  $lines = @()
  $tasks = @(Get-OpencodeServeTasks)
  foreach ($t in $tasks) {
    Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false -ErrorAction SilentlyContinue
    $lines += ("Задача снята: $($t.TaskName).")
  }
  if ($tasks.Count -eq 0) { $lines += 'Задач не было — снимать нечего.' }
  if (Get-OpencodeFwRule) {
    Remove-NetFirewallRule -DisplayName $OpencodeFwRuleName
    $lines += 'Правило брандмауэра удалено.'
  } else {
    $lines += 'Правила не было — удалять нечего.'
  }
  $dir = Get-OpencodeInstallDir
  if (Test-Path -LiteralPath $dir) {
    Remove-Item -LiteralPath $dir -Recurse -Force
    $lines += 'Папка бинаря удалена.'
  }
  $lines += 'Конфиг оператора оставлен (там его авторизации провайдеров).'
  ,$lines
}

# --------------------------------------------------------------------------------------
# Вкладка окна обслуживания
# --------------------------------------------------------------------------------------

function New-OpencodePanel {
  param([int]$ServePort = 3080, [string]$DataDir = '')

  Add-Type -AssemblyName System.Windows.Forms, System.Drawing

  $body = New-Object System.Windows.Forms.Panel
  $body.Dock = 'Fill'

  $head = New-Object System.Windows.Forms.Label
  $head.Dock = 'Top'; $head.Height = 92; $head.Padding = New-Object System.Windows.Forms.Padding(10, 8, 10, 0)
  $head.Text = "Фоновая служба нейросетей для раздела «OpenCode-узлы» Матрицы: качает релиз opencode`r`n" +
  "с GitHub (размер и SHA256 сверяются), ставит задачу «при входе оператора» и правило`r`n" +
  "брандмауэра (только своя подсеть). Кнопка ниже делает всё разом; проверка ничего не меняет."

  $fields = New-Object System.Windows.Forms.TableLayoutPanel
  $fields.Dock = 'Top'; $fields.Height = 40; $fields.ColumnCount = 2; $fields.RowCount = 1
  $fields.Padding = New-Object System.Windows.Forms.Padding(10, 4, 10, 4)

  $lblPort = New-Object System.Windows.Forms.Label
  $lblPort.Text = 'Порт serve:'; $lblPort.AutoSize = $true
  $lblPort.Margin = New-Object System.Windows.Forms.Padding(0, 6, 6, 0)
  $tbPort = New-Object System.Windows.Forms.TextBox
  $tbPort.Text = [string]$ServePort; $tbPort.Width = 80

  $fields.Controls.Add($lblPort, 0, 0)
  $fields.Controls.Add($tbPort, 1, 0)

  $log = New-Object System.Windows.Forms.TextBox
  $log.Dock = 'Fill'; $log.Multiline = $true; $log.ReadOnly = $true
  $log.ScrollBars = 'Vertical'
  $log.Font = New-Object System.Drawing.Font('Consolas', 9)
  $log.BackColor = [System.Drawing.Color]::White

  $bottom = New-Object System.Windows.Forms.FlowLayoutPanel
  $bottom.Dock = 'Bottom'; $bottom.Height = 48
  $bottom.Padding = New-Object System.Windows.Forms.Padding(10, 8, 10, 8)

  # Порт разбирается в одном месте (приём lan-share-firewall.ps1): «3080 » с пробелом
  # ронял бы кнопку исключением вместо внятной строки в журнале.
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

  # Замыкание помнит UserDataDir окна: оператор его не вводит и не видит.
  $hereDataDir = $DataDir

  $bCheck = New-Object System.Windows.Forms.Button
  $bCheck.Text = 'Проверить'; $bCheck.Width = 130; $bCheck.Height = 30
  $bCheck.Add_Click({
      try { & $write (Get-OpencodeReport -ServePort (& $readPort) -DataDir $hereDataDir) }
      catch { & $write @([string]$_) }
    }.GetNewClosure())

  $bApply = New-Object System.Windows.Forms.Button
  $bApply.Text = 'Установить / обновить узел'; $bApply.Width = 220; $bApply.Height = 30
  $bApply.Add_Click({
      try { & $write (Install-OpencodeHarness -ServePort (& $readPort) -DataDir $hereDataDir) }
      catch { & $write @([string]$_) }
    }.GetNewClosure())

  $bRemove = New-Object System.Windows.Forms.Button
  $bRemove.Text = 'Снять узел'; $bRemove.Width = 130; $bRemove.Height = 30
  $bRemove.Add_Click({
      $ask = [System.Windows.Forms.MessageBox]::Show(
        'Снять OpenCode-узел? Задача планировщика, правило брандмауэра и бинарь уйдут; конфиг оператора останется. Раздел «OpenCode-узлы» покажет узел мёртвым.',
        'Подтверждение', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning)
      if ($ask -ne 'Yes') { return }
      try { & $write (Remove-OpencodeHarness) }
      catch { & $write @([string]$_) }
    }.GetNewClosure())

  $note = New-Object System.Windows.Forms.Label
  $note.AutoSize = $true; $note.Margin = New-Object System.Windows.Forms.Padding(12, 8, 0, 0)
  if (Test-OpencodeAdmin) {
    $note.Text = 'Права администратора есть — узел можно ставить.'
    $note.ForeColor = [System.Drawing.Color]::DarkGreen
  } else {
    # Кнопки НЕ гасим (приём lan-share): пусть оператор нажмёт и прочитает, чего не хватает.
    $note.Text = 'Без прав администратора узел не поставить — «Проверить» работает, остальное скажет, чего не хватает.'
    $note.ForeColor = [System.Drawing.Color]::Firebrick
  }

  $bottom.Controls.AddRange(@($bCheck, $bApply, $bRemove))

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

  # Состояние показываем сразу при открытии вкладки (приём lan-share).
  try { & $write (Get-OpencodeReport -ServePort $ServePort -DataDir $DataDir) }
  catch { & $write @([string]$_) }

  return $body
}

# --------------------------------------------------------------------------------------
# Главный поток
# --------------------------------------------------------------------------------------

# Подключение точкой (`-AsLibrary`) обрывается здесь: окну обслуживания нужны функции выше.
if ($AsLibrary) { return }

if ($Verify) {
  foreach ($line in (Get-OpencodeReport -ServePort $Port -DataDir $UserDataDir)) { Write-Host $line }
  exit 0
}

if ($Remove) {
  try {
    foreach ($line in (Remove-OpencodeHarness)) { Write-Host $line -ForegroundColor Green }
    exit 0
  } catch {
    Write-Host ([string]$_) -ForegroundColor Red
    Write-Host 'Запустите через «Запустить-от-администратора.cmd» или из консоли администратора.' -ForegroundColor Red
    exit 1
  }
}

try {
  foreach ($line in (Install-OpencodeHarness -ServePort $Port -PinVersion $Version -WantedAsset $AssetName -DataDir $UserDataDir)) { Write-Host $line }
} catch {
  Write-Host ([string]$_) -ForegroundColor Red
  Write-Host 'Запустите через «Запустить-от-администратора.cmd» или из консоли администратора.' -ForegroundColor Red
  exit 1
}
