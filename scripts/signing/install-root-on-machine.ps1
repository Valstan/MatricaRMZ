# Установка корня Матрицы на машине парка — одна команда, от администратора.
#
# Что делает:
#   1. кладёт корень в ОБА машинных хранилища («Доверенные корневые центры» и
#      «Доверительные отношения в предприятии» / Enterprise Trust) — чтобы выбор
#      в списке вкладки Касперского не был важен (ADR-0003);
#   2. проверяет, что корень виден в машинных хранилищах;
#   3. печатает ОСТАВШИЕСЯ шаги в окне Касперского — их продукт отдаёт только человеку.
#
# Запуск (из корня репозитория, на машине парка):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\signing\install-root-on-machine.ps1
#
# Если скрипт запущен без прав администратора — он попросит повышение сам (UAC).
# Права администратора нужны для машинных хранилищ; на шаг с галочкой в Касперском
# права не нужны, но она всё равно просит подтверждение — это защита продукта.
param(
    [string]$CerPath = (Join-Path $PSScriptRoot 'matrixarmz-rootca.cer'),
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

function Write-Step($text) { if (-not $Quiet) { Write-Host $text } }

# ── Повышение прав ────────────────────────────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Step 'Нужны права администратора — перезапускаю с повышенными (подтвердите UAC).'
    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSScriptRoot + ' ' + $PSCommandPath)
    # -File и путь с пробелами: собираем корректно.
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs -Wait
    exit $LASTEXITCODE
}

if (-not (Test-Path -LiteralPath $CerPath)) {
    throw "Файл корня не найден: $CerPath (передай путь через -CerPath)"
}

# ── Установка в оба машинных хранилища ────────────────────────────────────────
$cer = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($CerPath)
foreach ($storeName in @('Root', 'Trust')) {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, 'LocalMachine')
    try {
        $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
        $already = @($store.Certificates | Where-Object { $_.Thumbprint -eq $cer.Thumbprint })
        if ($already.Count -gt 0) {
            Write-Step "Cert:\LocalMachine\$storeName : уже есть (пропускаем)"
        } else {
            Write-Step "Ставлю корень в Cert:\LocalMachine\$storeName — это МЕДЛЕННО (Windows проверяет доверие), не прерывайте"
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $store.Add($cer)
            $sw.Stop()
            Write-Step ("  готово за " + [math]::Round($sw.Elapsed.TotalSeconds, 1) + " с")
        }
    } finally {
        $store.Close()
    }
}

# ── Проверка: корень виден в машинных хранилищах ─────────────────────────────
$ok = $true
foreach ($storeName in @('Root', 'Trust')) {
    $found = @(Get-ChildItem "Cert:\LocalMachine\$storeName" -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $cer.Thumbprint })
    Write-Step ("Cert:\LocalMachine\$storeName : " + $found.Count)
    if ($found.Count -eq 0) { $ok = $false }
}
Write-Step ("Отпечаток корня: " + $cer.Thumbprint)

# ── Осталось в окне Касперского ───────────────────────────────────────────────
Write-Host ''
Write-Host '=== ОСТАВШИЕСЯ ШАГИ (их отдаёт только человек) ===' -ForegroundColor Yellow
Write-Host '1. Настройки → «Исключения и действия при обнаружении угроз» → «Указать доверенные программы» (или «Настройка»)'
Write-Host '2. Вкладка «Доверенное системное хранилище сертификатов» → галочка «Использовать доверенное системное хранилище сертификатов»'
Write-Host '3. В списке выбрать любое из двух хранилищ (корень лежит в обоих):'
Write-Host '     «Доверенные корневые центры»  ИЛИ  «Доверительные отношения в предприятии»'
Write-Host '4. Сохранить изменения.'
Write-Host ''
Write-Host 'Проверка: подписанный MatricaRMZ.exe должен попасть в группу «Доверенные»,'
Write-Host 'а поведенческий анализ (HIPS / System Watcher) — молчать.'
Write-Host ''
if (-not $ok) {
    Write-Host 'ВНИМАНИЕ: корень виден не во всех машинных хранилищах — скажите, разберёмся.' -ForegroundColor Red
    exit 1
}
Write-Host 'Готово: корень в обоих машинных хранилищах.' -ForegroundColor Green
