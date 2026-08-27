# kaspersky-matrica.tests.ps1 — приёмка помощника по Касперскому (2026-08-27)
#
# Запуск (Windows, PowerShell 5.1 — та же версия, что на машинах парка):
#   powershell -NoProfile -ExecutionPolicy Bypass -File kaspersky-matrica.tests.ps1
# Код возврата 0 — всё зелено, 1 — есть провалы.
#
# Зачем отдельный файл, если в репозитории тесты на vitest: проверяемое здесь —
# байты. Формат файлов импорта Касперского снят с живого экспорта, документации на него
# нет, и ошибка в нём (UTF-8 вместо UTF-16LE, потерянная косая черта у папки) не роняет
# ничего на этой машине — она всплывает отказом импорта на чужом компьютере через месяц.
# Pester намеренно не используется: на машине парка его нет, а тест должен запускаться
# там же, где инструмент.
#
# Тест НЕ трогает Касперского и ничего не пишет вне своей временной папки.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:Failures = 0
$script:Checks = 0

function Assert-Equal {
    param([string]$Name, $Actual, $Expected)
    $script:Checks++
    if ("$Actual" -eq "$Expected") {
        Write-Host "  ok   $Name" -ForegroundColor DarkGray
    } else {
        Write-Host "  FAIL $Name" -ForegroundColor Red
        Write-Host "       получено: [$Actual]"
        Write-Host "       ожидалось: [$Expected]"
        $script:Failures++
    }
}

# Определения функций берём из скрипта разбором, а не точкой: точка запустила бы и
# основной поток — с окном, записью файлов и походом в сеть.
$target = Join-Path $PSScriptRoot 'kaspersky-matrica.ps1'
if (-not (Test-Path -LiteralPath $target)) { throw "Не найден проверяемый скрипт: $target" }
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($target, [ref]$null, [ref]$parseErrors)

Write-Host 'Разбор скрипта:'
$script:Checks++
if ($parseErrors -and @($parseErrors).Count -gt 0) {
    Write-Host "  FAIL синтаксис: ошибок $(@($parseErrors).Count)" -ForegroundColor Red
    $parseErrors | ForEach-Object { Write-Host "       строка $($_.Extent.StartLineNumber): $($_.Message)" }
    $script:Failures++
} else {
    Write-Host '  ok   синтаксис PowerShell 5.1' -ForegroundColor DarkGray
}

foreach ($fn in $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    . ([scriptblock]::Create($fn.Extent.Text))
}

Write-Host 'Строки списков Касперского:'
Assert-Equal 'папка получает косую черту' `
    (ConvertTo-ExclusionLine -Path 'D:\PROGRAMMING' -IsFolder) '1;D:\PROGRAMMING\;*;*;1;0;1;;1'
Assert-Equal 'вторая косая черта не приписывается' `
    (ConvertTo-ExclusionLine -Path 'D:\PROGRAMMING\' -IsFolder) '1;D:\PROGRAMMING\;*;*;1;0;1;;1'
Assert-Equal 'файл остаётся без косой черты' `
    (ConvertTo-ExclusionLine -Path 'D:\Desktop\MatricaRMZ.lnk') '1;D:\Desktop\MatricaRMZ.lnk;*;*;1;0;1;;1'
Assert-Equal 'прямые слэши разворачиваются в обратные' `
    (ConvertTo-ExclusionLine -Path 'C:/Users/x/AppData/Roaming/@matricarmz' -IsFolder) '1;C:\Users\x\AppData\Roaming\@matricarmz\;*;*;1;0;1;;1'
Assert-Equal 'доверенная программа' `
    (ConvertTo-TrustedLine -Path 'C:\a\MatricaRMZ.exe') '1;C:\a\MatricaRMZ.exe;'

Write-Host 'Разбор чужого экспорта:'
Assert-Equal 'путь из строки исключения' `
    (Get-PathFromListLine '1;D:\PROGRAMMING\;*;*;1;0;1;;1') 'D:\PROGRAMMING\'
Assert-Equal 'путь из строки доверенной программы' `
    (Get-PathFromListLine '1;C:\a\b.exe;') 'C:\a\b.exe'
Assert-Equal 'строка с конкретным вердиктом' `
    (Get-PathFromListLine '1;C:\a\b.exe;PDM:Trojan.Win32.Generic;*;1;0;1;;1') 'C:\a\b.exe'
Assert-Equal 'мусорная строка не даёт пути' (Get-PathFromListLine 'ерунда') ''

Write-Host 'Сравнение путей:'
Assert-Equal 'регистр не важен' (Test-ContainsPath -List @('D:\PROGRAMMING') -Path 'd:\programming') 'True'
Assert-Equal 'хвостовая косая черта не важна' (Test-ContainsPath -List @('D:\PROGRAMMING\') -Path 'D:\PROGRAMMING') 'True'
Assert-Equal 'другой путь не совпадает' (Test-ContainsPath -List @('D:\PROGRAMMING') -Path 'D:\OTHER') 'False'
Assert-Equal 'дубль не увеличивает список' (@(Add-UniquePath -List @('D:\A') -Path 'd:\a\').Count) '1'
Assert-Equal 'новый путь увеличивает список' (@(Add-UniquePath -List @('D:\A') -Path 'D:\B').Count) '2'

Write-Host 'Гейт «что нельзя исключать целиком»:'
Assert-Equal 'корень диска C:\' (Test-CanBeExcludedWholesale 'C:\') 'False'
Assert-Equal 'корень диска D:\' (Test-CanBeExcludedWholesale 'D:\') 'False'
Assert-Equal 'профиль пользователя' (Test-CanBeExcludedWholesale $env:USERPROFILE) 'False'
Assert-Equal 'папка всех профилей' (Test-CanBeExcludedWholesale (Split-Path -Parent $env:USERPROFILE)) 'False'
Assert-Equal 'AppData\Roaming' (Test-CanBeExcludedWholesale $env:APPDATA) 'False'
Assert-Equal 'AppData\Local' (Test-CanBeExcludedWholesale $env:LOCALAPPDATA) 'False'
Assert-Equal 'папка Windows' (Test-CanBeExcludedWholesale $env:SystemRoot) 'False'
Assert-Equal 'несуществующая папка' (Test-CanBeExcludedWholesale 'D:\takoy-papki-net-12345') 'False'
Assert-Equal 'пустая строка' (Test-CanBeExcludedWholesale '') 'False'
Assert-Equal 'обычная рабочая папка' (Test-CanBeExcludedWholesale $PSScriptRoot) 'True'

Write-Host 'Поиск папки с репозиториями (запасной путь, на поддельном дереве):'
$fake = Join-Path ([System.IO.Path]::GetTempPath()) ('kaspersky-matrica-repos-' + [guid]::NewGuid().ToString('N'))
try {
    # Имя нарочно нетиповое и с пробелами: список известных имён такую папку не знает,
    # найти её обязан обход первого уровня.
    foreach ($r in @('alpha', 'beta')) {
        New-Item -ItemType Directory -Path (Join-Path $fake "Мои Исходники 2026\$r\.git") -Force | Out-Null
    }
    New-Item -ItemType Directory -Path (Join-Path $fake 'ОдинКлон\solo\.git') -Force | Out-Null
    # Системное имя обязано быть пропущено, даже если клоны внутри действительно есть.
    foreach ($r in @('alpha', 'beta')) {
        New-Item -ItemType Directory -Path (Join-Path $fake "Windows\$r\.git") -Force | Out-Null
    }
    $found = @(Get-RepoEcosystemCandidates -SearchBases @($fake))
    $paths = @($found | ForEach-Object { $_.Path })
    Assert-Equal 'папка с нетиповым именем найдена' `
        ([bool]($paths -contains (Join-Path $fake 'Мои Исходники 2026'))) 'True'
    Assert-Equal 'одиночный клон экосистемой не считается' `
        ([bool]($paths -contains (Join-Path $fake 'ОдинКлон'))) 'False'
    Assert-Equal 'системное имя пропущено' `
        ([bool]($paths -contains (Join-Path $fake 'Windows'))) 'False'
    Assert-Equal 'сосчитано клонов в найденной папке' `
        (@($found | Where-Object { $_.Path -eq (Join-Path $fake 'Мои Исходники 2026') })[0].RepoCount) '2'

    # Регрессия на две грабли разом. Поле обязано называться RepoCount: встроенное
    # «Count» есть у любого объекта и равно 1, поэтому сортировка по нему сравнивала бы
    # единицы и возвращала первую попавшуюся папку. Имена подобраны так, что при
    # сломанной сортировке победит МЕНЬШАЯ (А раньше Б по алфавиту) — тест покраснеет.
    foreach ($r in @('one', 'two')) {
        New-Item -ItemType Directory -Path (Join-Path $fake "АльфаДва\$r\.git") -Force | Out-Null
    }
    foreach ($r in @('one', 'two', 'three')) {
        New-Item -ItemType Directory -Path (Join-Path $fake "БетаТри\$r\.git") -Force | Out-Null
    }
    $ranked = @(Get-RepoEcosystemCandidates -SearchBases @($fake)) |
              Sort-Object -Property RepoCount -Descending | Select-Object -First 1
    Assert-Equal 'побеждает самая населённая папка' $ranked.Path (Join-Path $fake 'БетаТри')

    Assert-Equal 'пустая база не роняет поиск' (@(Get-RepoEcosystemCandidates -SearchBases @('')).Count) '0'
    Assert-Equal 'несуществующая база не роняет поиск' `
        (@(Get-RepoEcosystemCandidates -SearchBases @('D:\takoy-papki-net-12345')).Count) '0'
} finally {
    Remove-Item -LiteralPath $fake -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'Байты записанного файла (главное — здесь):'
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("kaspersky-matrica-tests-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
    $sample = Join-Path $tmp 'sample.csv'
    Write-KasperskyListFile -Path $sample -Lines @(
        '1;D:\PROGRAMMING\;*;*;1;0;1;;1',
        '1;C:\Users\Иванова\AppData\Roaming\@matricarmz\;*;*;1;0;1;;1'
    )
    $bytes = [System.IO.File]::ReadAllBytes($sample)
    Assert-Equal 'BOM UTF-16LE (FF FE)' ("{0:X2} {1:X2}" -f $bytes[0], $bytes[1]) 'FF FE'
    Assert-Equal 'файл кончается CRLF' `
        ("{0:X2} {1:X2} {2:X2} {3:X2}" -f $bytes[$bytes.Length-4], $bytes[$bytes.Length-3], $bytes[$bytes.Length-2], $bytes[$bytes.Length-1]) `
        '0D 00 0A 00'
    # Кириллица обязана пережить запись: путь с русским именем пользователя — обычное
    # дело на машинах парка, а в UTF-8 он превратится в кракозябры и правило не совпадёт.
    $back = [System.IO.File]::ReadAllText($sample)
    Assert-Equal 'кириллица цела' ([bool]($back -match 'Иванова')) 'True'
    Assert-Equal 'строк в файле' (@($back -split "`r`n" | Where-Object { $_ }).Count) '2'

    # Круг замкнулся: то, что записали, читается обратно нашим же разборщиком.
    $lines = Read-KasperskyListLines $sample
    Assert-Equal 'обратное чтение: строк' (@($lines).Count) '2'
    Assert-Equal 'обратное чтение: первый путь' (Get-PathFromListLine @($lines)[0]) 'D:\PROGRAMMING\'
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($script:Failures -gt 0) {
    Write-Host "ИТОГ: провалов $script:Failures из $script:Checks" -ForegroundColor Red
    exit 1
}
Write-Host "ИТОГ: все проверки пройдены ($script:Checks)" -ForegroundColor Green
