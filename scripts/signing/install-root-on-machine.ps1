# Установка корня Матрицы на машине парка.
#
# Что делает:
#   1. кладёт корень в хранилища сертификатов (машинные или пользовательские) — чтобы
#      выбор в списке вкладки Касперского не был важен (ADR-0003);
#   2. проверяет, что корень виден в этих хранилищах;
#   3. печатает ОСТАВШИЕСЯ шаги в окне Касперского — их продукт отдаёт только человеку.
#
# Запуск (из корня репозитория, на машине парка):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\signing\install-root-on-machine.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\signing\install-root-on-machine.ps1 -Scope CurrentUser
#
# РЕЖИМЫ (Scope):
#   Machine     (по умолчанию) — машинные хранилища Cert:\LocalMachine\Root и \Trust.
#                Нужны права администратора; скрипт поднимает их сам (UAC).
#   CurrentUser — пользовательские хранилища Cert:\CurrentUser\Root и \Trust.
#                ПРАВ АДМИНИСТРАТОРА НЕ НУЖНО: работа идёт от текущего пользователя.
#                Этого достаточно, чтобы программа сама доверяла серверу (TLS) и
#                Windows показывала правильного издателя подписи EXE.
#   Both        — и то, и то (машинное поднимет права).
#
# ЧЕГО НЕ ДАЁТ CurrentUser. ДОВЕРИЕ КАСПЕРСКОГО. Касперский смотрит в СИСТЕМНОЕ
# (машинное) хранилище сертификатов — пользовательское он системным не считает, и
# галочку «Использовать доверенное системное хранилище сертификатов» без корня в
# машинном хранилище включить бессмысленно. Настройку Касперского программно не
# поменять (Самозащита) — это клик человека. Итог: без машинного шага программа
# доверяет серверу сама, но Касперский по подписи всё равно не доверяет.
param(
    [string]$CerPath = (Join-Path $PSScriptRoot 'matrixarmz-rootca.cer'),
    [ValidateSet('Machine', 'CurrentUser', 'Both')]
    [string]$Scope = 'Machine',
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

function Write-Step($text) { if (-not $Quiet) { Write-Host $text } }

# ── Повышение прав (нужно только для машинных хранилищ) ───────────────────────
$needMachine = ($Scope -eq 'Machine' -or $Scope -eq 'Both')
if ($needMachine) {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Step 'Нужны права администратора — перезапускаю с повышенными (подтвердите UAC).'
        $args = @('-NoProfile', 'ExecutionPolicy', 'Bypass', '-File', $PSScriptRoot + ' ' + $PSCommandPath)
        # -File и путь с пробелами: собираем корректно.
        $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
        if ($Scope -eq 'Both') { $argList += @('-Scope', 'Both') }
        Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs -Wait
        exit $LASTEXITCODE
    }
}

if (-not (Test-Path -LiteralPath $CerPath)) {
    throw "Файл корня не найден: $CerPath (передай путь через -CerPath)"
}

# ── Куда ставим ────────────────────────────────────────────────────────────────
# Хранилища: Root — «Доверенные корневые центры», Trust — «Доверительные отношения
# в предприятии». Корень кладём в оба, чтобы выбор в списке вкладки Касперского не
# был важен (ADR-0003).
$targets = @()
if ($Scope -eq 'Machine' -or $Scope -eq 'Both') {
    $targets += @{ Store = 'Root'; Location = 'LocalMachine' }
    $targets += @{ Store = 'Trust'; Location = 'LocalMachine' }
}
if ($Scope -eq 'CurrentUser' -or $Scope -eq 'Both') {
    $targets += @{ Store = 'Root'; Location = 'CurrentUser' }
    $targets += @{ Store = 'Trust'; Location = 'CurrentUser' }
}

# ── Установка ──────────────────────────────────────────────────────────────────
$cer = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($CerPath)
foreach ($t in $targets) {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($t.Store, $t.Location)
    try {
        $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
        $already = @($store.Certificates | Where-Object { $_.Thumbprint -eq $cer.Thumbprint })
        if ($already.Count -gt 0) {
            Write-Step "Cert:\$($t.Location)\$($t.Store) : уже есть (пропускаем)"
        } else {
            Write-Step "Ставлю корень в Cert:\$($t.Location)\$($t.Store) — это МЕДЛЕННО (Windows проверяет доверие), не прерывайте"
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $store.Add($cer)
            $sw.Stop()
            Write-Step ("  готово за " + [math]::Round($sw.Elapsed.TotalSeconds, 1) + " с")
        }
    } finally {
        $store.Close()
    }
}

# ── Проверка: корень виден в этих хранилищах ──────────────────────────────────
$ok = $true
foreach ($t in $targets) {
    $found = @(Get-ChildItem "Cert:\$($t.Location)\$($t.Store)" -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $cer.Thumbprint })
    Write-Step ("Cert:\$($t.Location)\$($t.Store) : " + $found.Count)
    if ($found.Count -eq 0) { $ok = $false }
}
Write-Step ("Отпечаток корня: " + $cer.Thumbprint)

# ── Осталось в окне Касперского ───────────────────────────────────────────────
$machineDone = $Scope -eq 'Machine' -or $Scope -eq 'Both'
Write-Host ''
if ($machineDone) {
    Write-Host '=== ОСТАВШИЕСЯ ШАГИ (их отдаёт только человек) ===' -ForegroundColor Yellow
    Write-Host '1. Настройка (шестерёнка) → раздел про исключения («Исключения и действия с найденными объектами» в новых сборках, «Угрозы и исключения» в 21.9 и старше) → прокрутить ВНИЗ до строки «Доверенное системное хранилище сертификатов»'
    Write-Host '2. В выпадающем списке выбрать любое из двух хранилищ, НЕ «Не использовать» (корень лежит в обоих):'
    Write-Host '     «Доверенные корневые центры»  ИЛИ  «Доверительные отношения в предприятии»'
    Write-Host '3. Сохранить изменения.'
    Write-Host ''
    Write-Host '   Если такой строки в сборке нет вовсе — работает старый путь: доверенные программы и исключения вносит помощник по антивирусу (импорт готового файла).'
    Write-Host '   Если машина под политикой Kaspersky Security Center — настройка живёт в политике, а не в окне программы.'
    Write-Host '   Сертификат в Касперский добавлять не нужно: он уже стоит в Windows, в машинных хранилищах.'
    Write-Host ''
    Write-Host 'Проверка: подписанный MatricaRMZ.exe должен попасть в группу «Доверенные»,'
    Write-Host 'а поведенческий анализ (HIPS / System Watcher) — молчать.'
} else {
    Write-Host '=== ЧТО ОСТАЛОСЬ ДЛЯ КАСПЕРСКОГО (его отдаёт только человек) ===' -ForegroundColor Yellow
    Write-Host 'Программа уже доверяет серверу сама (корень в хранилище пользователя).'
    Write-Host 'Но Касперский смотрит в СИСТЕМНОЕ (машинное) хранилище — пользовательское он системным'
    Write-Host 'не считает. Чтобы Касперский доверял по подписи, корень должен лежать в машинном'
    Write-Host 'хранилище (один раз, под администратором) + нужна галочка в Касперском:'
    Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\signing\install-root-on-machine.ps1'
    Write-Host '  Настройка (шестерёнка) → раздел про исключения → прокрутить вниз до «Доверенное системное хранилище сертификатов»'
    Write-Host '  (в списке выбрать наше хранилище, НЕ «Не использовать»; нет такой строки — поможет помощник по антивирусу)'
    Write-Host ''
}
Write-Host ''
if (-not $ok) {
    Write-Host 'ВНИМАНИЕ: корень виден не во всех выбранных хранилищах — скажите, разберёмся.' -ForegroundColor Red
    exit 1
}
Write-Host ("Готово: корень установлен (Scope=$Scope).") -ForegroundColor Green
