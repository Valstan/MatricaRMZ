<#
.SYNOPSIS
Переставляет порт прод-сервера в ~/.ssh/config и обновляет known_hosts.

.DESCRIPTION
Внешний SSH-порт прода меняется ротацией (мандат D-101) и живёт ТОЛЬКО в
~/.ssh/config каждой машины, в комнате КАРМАНа и в канале владельца. В
репозитории его нет и не будет — репозиторий публичный. Поэтому скрипт
принимает номер аргументом, а не хранит его.

Что делает:
  1. снимает копию ~/.ssh/config рядом, с отметкой времени;
  2. правит строку Port внутри блока Host <алиас> (добавляет, если её нет);
  3. сверяет отпечаток ключа сервера на новом порту с уже известным по
     старому порту — и записывает запись known_hosts, только если они
     совпали. Расхождение = стоп: это либо не тот сервер, либо подмена;
  4. проверяет вход и печатает, что ответил сервер.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/set-prod-ssh-port.ps1 -Port 12345

.EXAMPLE
  # другой алиас или другой хост
  ... -File scripts/set-prod-ssh-port.ps1 -Port 12345 -Alias matricarmz
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 65535)]
    [int]$Port,

    [string]$Alias = 'matricarmz',

    # Пропустить сверку отпечатка со старой записью. Нужен один раз, если
    # известной записи нет вовсе (свежая машина): тогда отпечаток печатается
    # и подтверждается глазами.
    [switch]$TrustNewKey
)

$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "ОШИБКА: $msg" -ForegroundColor Red; exit 1 }
function Ok($msg)   { Write-Host "  ok   $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "  ..   $msg" -ForegroundColor DarkGray }

$sshDir = Join-Path $HOME '.ssh'
$configPath = Join-Path $sshDir 'config'
if (-not (Test-Path $configPath)) { Fail "нет файла $configPath — сначала заведите блок Host $Alias" }

$raw = Get-Content -Path $configPath -Raw -Encoding UTF8
$lines = $raw -split "`r?`n"

# Границы блока: от строки Host <алиас> до следующей строки Host на нулевом отступе.
$start = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*Host\s+(.*\s)?$([regex]::Escape($Alias))(\s|$)") { $start = $i; break }
}
if ($start -lt 0) { Fail "в $configPath нет блока Host $Alias" }

$end = $lines.Count
for ($i = $start + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*Host\s') { $end = $i; break }
}

# Хост нужен для known_hosts: записи там ведутся по паре «хост + порт».
$hostName = $null
$oldPort = $null
$portLine = -1
for ($i = $start; $i -lt $end; $i++) {
    if ($lines[$i] -match '^\s*HostName\s+(\S+)') { $hostName = $Matches[1] }
    if ($lines[$i] -match '^(\s*)Port\s+(\d+)')   { $portLine = $i; $oldPort = [int]$Matches[2] }
}
if (-not $hostName) { Fail "в блоке Host $Alias нет HostName — без него не проверить ключ сервера" }
if ($oldPort -eq $Port) { Write-Host "Порт уже $Port — править нечего."; exit 0 }

Write-Host "Машина: $env:COMPUTERNAME · алиас: $Alias · хост: $hostName"
Info "текущий порт в конфиге: $(if ($oldPort) { $oldPort } else { 'не задан' })"

# 1. Отпечаток на новом порту — ДО правки конфига: незачем трогать файл, если сервер не отвечает.
# Вывод ssh-keyscan идёт двумя потоками (ключ в stdout, комментарий в stderr), и в Windows
# PowerShell перенаправление потоков нативной команды съедает результат целиком —
# поэтому пишем во временный файл и читаем его, а не ловим конвейером.
$scanFile = Join-Path $env:TEMP "prod-ssh-scan-$PID.txt"
# Out-File -Encoding ascii, а не «>»: обычное перенаправление кладёт UTF-16,
# и ssh-keygen отвечает «is not a public key file».
& ssh-keyscan -p $Port -t ed25519,rsa,ecdsa $hostName 2>$null | Out-File -FilePath $scanFile -Encoding ascii
$scanned = @(Get-Content -Path $scanFile -ErrorAction SilentlyContinue | Where-Object { $_ -and $_ -notmatch '^#' })
if ($scanned.Count -eq 0) {
    Remove-Item -Path $scanFile -ErrorAction SilentlyContinue
    Fail "сервер $hostName не отвечает на порту $Port — проброс не заведён или номер не тот"
}
$newPrint = (& ssh-keygen -lf $scanFile 2>$null | Where-Object { $_ -match 'ED25519' }) -join ' '
if (-not $newPrint) { $newPrint = (& ssh-keygen -lf $scanFile 2>$null) -join ' ' }
if (-not $newPrint) { Remove-Item -Path $scanFile -ErrorAction SilentlyContinue; Fail "не удалось прочитать отпечаток ключа с порта $Port" }
Info "отпечаток на новом порту: $newPrint"

if (-not $TrustNewKey) {
    if (-not $oldPort) { Remove-Item -Path $scanFile -ErrorAction SilentlyContinue; Fail "в конфиге нет прежнего порта, сверять не с чем — перепроверьте отпечаток выше и повторите с -TrustNewKey" }
    $knownOld = & ssh-keygen -F "[$hostName]:$oldPort" -l 2>$null
    if (-not $knownOld) { Remove-Item -Path $scanFile -ErrorAction SilentlyContinue; Fail "в known_hosts нет записи для прежнего порта $oldPort — сверять не с чем; перепроверьте отпечаток выше и повторите с -TrustNewKey" }
    # Из обеих строк берём само значение SHA256:… — форматы вывода у них разные.
    $newHash = [regex]::Match($newPrint, 'SHA256:\S+').Value
    $oldHash = [regex]::Match(($knownOld -join ' '), 'SHA256:\S+').Value
    if (-not $newHash -or $newHash -ne $oldHash) {
        Remove-Item -Path $scanFile -ErrorAction SilentlyContinue
        Fail "отпечаток на новом порту НЕ совпал с известным ($newHash против $oldHash). Это либо чужой сервер, либо подмена — ключ не записан, конфиг не тронут"
    }
    Ok "отпечаток совпал с известным по прежнему порту"
}

# 2. Копия конфига и правка порта.
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item -Path $configPath -Destination "$configPath.bak-$stamp"
Ok "копия конфига: $configPath.bak-$stamp"

if ($portLine -ge 0) {
    $indent = [regex]::Match($lines[$portLine], '^(\s*)').Groups[1].Value
    $lines[$portLine] = "${indent}Port $Port"
} else {
    $lines = $lines[0..$start] + "    Port $Port" + $lines[($start + 1)..($lines.Count - 1)]
}
# Только WriteAllText: Set-Content -Encoding UTF8 в Windows PowerShell кладёт BOM,
# а ssh на первой строке конфига с BOM падает «Bad configuration option».
[System.IO.File]::WriteAllText($configPath, ($lines -join "`n"), (New-Object System.Text.UTF8Encoding($false)))
Ok "порт в конфиге переставлен на $Port"

# 3. known_hosts: старую запись убираем, новую пишем.
if ($oldPort) { & ssh-keygen -R "[$hostName]:$oldPort" 2>$null | Out-Null }
& ssh-keygen -R "[$hostName]:$Port" 2>$null | Out-Null
$knownHosts = Join-Path $sshDir 'known_hosts'
# Пишем уже снятые строки, второй раз сервер не дёргаем.
Add-Content -Path $knownHosts -Value $scanned -Encoding ASCII
Remove-Item -Path $scanFile -ErrorAction SilentlyContinue
Ok "known_hosts обновлён"

# 4. Проверка входа.
Info "проверяю вход…"
$answer = & ssh -o ConnectTimeout=20 -o BatchMode=yes $Alias "echo ВХОД-РАБОТАЕТ; hostname" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host $answer
    Fail "вход не прошёл. Конфиг уже переставлен; прежний лежит в $configPath.bak-$stamp"
}
Ok "вход прошёл: $($answer -join ' | ')"
Write-Host "Готово." -ForegroundColor Green
