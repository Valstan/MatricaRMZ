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

Write-Host 'Что отдавать под исключение, когда клон найден:'
$rt = Join-Path ([System.IO.Path]::GetTempPath()) ('kaspersky-matrica-target-' + [guid]::NewGuid().ToString('N'))
try {
    foreach ($r in @('a', 'b')) {
        New-Item -ItemType Directory -Path (Join-Path $rt "Экосистема\$r\.git") -Force | Out-Null
    }
    New-Item -ItemType Directory -Path (Join-Path $rt 'Свалка\solo\.git') -Force | Out-Null
    Assert-Equal 'папка с двумя клонами отдаётся целиком' `
        (Resolve-RepoExclusionTarget -RepoPath (Join-Path $rt 'Экосистема\a')) (Join-Path $rt 'Экосистема')
    # Главная поправка ревью: раньше проверка «в родителе есть хоть один клон» была
    # тавтологией — им был сам найденный клон, — и папка общего назначения уходила в
    # исключения целиком.
    Assert-Equal 'родитель с ОДНИМ клоном не отдаётся' `
        (Resolve-RepoExclusionTarget -RepoPath (Join-Path $rt 'Свалка\solo')) (Join-Path $rt 'Свалка\solo')
    Assert-Equal 'домашний каталог как репозиторий не отдаётся' `
        (Resolve-RepoExclusionTarget -RepoPath $env:USERPROFILE) ''
    Assert-Equal 'корень диска как репозиторий не отдаётся' `
        (Resolve-RepoExclusionTarget -RepoPath 'C:\') ''
    Assert-Equal 'пустой путь не роняет' (Resolve-RepoExclusionTarget -RepoPath '') ''
} finally { Remove-Item -LiteralPath $rt -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host 'Гейт знает папки общего назначения:'
Assert-Equal 'Рабочий стол' (Test-CanBeExcludedWholesale ([Environment]::GetFolderPath('Desktop'))) 'False'
Assert-Equal 'Документы' (Test-CanBeExcludedWholesale ([Environment]::GetFolderPath('MyDocuments'))) 'False'
$dl = Join-Path $env:USERPROFILE 'Downloads'
if (Test-Path -LiteralPath $dl) { Assert-Equal 'Загрузки' (Test-CanBeExcludedWholesale $dl) 'False' }

Write-Host 'Слияние с прежним экспортом (обещание «наш файл содержит всё твоё»):'
$mt = Join-Path ([System.IO.Path]::GetTempPath()) ('kaspersky-matrica-merge-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $mt -Force | Out-Null
try {
    $prev = Join-Path $mt 'prev.csv'
    Write-KasperskyListFile -Path $prev -Lines @(
        '1;;PDM:Trojan.Win32.Generic;*;1;0;1;;1',                 # правило без пути — только вердикт
        '1;D:\ЧУЖАЯ ПАПКА\;*;*;1;0;1;;1',                          # чужая строка, нашей нет
        '1;d:\programming\;*;*;1;0;1;моё;1'                        # то же, что наша, но иным регистром
    )
    # План строим НАСТОЯЩЕЙ функцией из пустого «ничего не установлено» — так фикстура не
    # разъедется с кодом молча: добавили в план поле, забыли здесь — тест краснеет сразу
    # (Set-StrictMode роняет обращение к отсутствующему свойству).
    $noMatrica = [pscustomobject][ordered]@{
        HandshakeFound = $false; HandshakePath = ''; HandshakeAgeHours = $null
        AppExe = 'C:\a\MatricaRMZ.exe'; AppDir = ''; AppVersion = ''
        WatchdogExe = ''; WatchdogDir = ''
        DataDir = 'D:\PROGRAMMING'; UserDataDir = ''; UpdatesDir = ''
        UpdaterCacheDir = ''; LegacyDataDir = ''; DesktopDir = ''
        FilesDir = ''; LegacyDirs = @(); TempMasks = @()
        Shortcuts = @(); ExtraExes = @()
        ApiBaseUrl = ''; ApiHost = ''; ApiIps = @()
        Tasks = @(); LogonShortcut = $null; Source = ''
    }
    $plan = Get-ExclusionPlan -Matrica $noMatrica -WorkFolders @()
    $res = Write-KasperskyImportFiles -Plan $plan -Dir (Join-Path $mt 'out') -MergeExclusionsFile $prev
    $lines = @(Read-KasperskyListLines $res.ExclusionsPath)
    Assert-Equal 'строка-вердикт без пути сохранена' `
        ([bool](@($lines) -contains '1;;PDM:Trojan.Win32.Generic;*;1;0;1;;1')) 'True'
    Assert-Equal 'чужая строка сохранена дословно' `
        ([bool](@($lines) -contains '1;D:\ЧУЖАЯ ПАПКА\;*;*;1;0;1;;1')) 'True'
    Assert-Equal 'совпадение по регистру не задвоено' (@($lines).Count) '3'
    Assert-Equal 'учтено перенесённых строк' $res.MergedExclusions '3'
    # Мусорный файл не должен утечь в импорт целиком.
    $junk = Join-Path $mt 'junk.txt'
    Write-KasperskyListFile -Path $junk -Lines @('это не список Касперского', 'и это тоже')
    $res2 = Write-KasperskyImportFiles -Plan $plan -Dir (Join-Path $mt 'out2') -MergeExclusionsFile $junk
    Assert-Equal 'строки без точки с запятой отброшены' $res2.MergedExclusions '0'
} finally { Remove-Item -LiteralPath $mt -Recurse -Force -ErrorAction SilentlyContinue }

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

Write-Host 'Доверие по подписи (ADR-0003) — чем закрыт файл:'
$fx = Join-Path ([System.IO.Path]::GetTempPath()) ('kaspersky-matrica-sign-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fx -Force | Out-Null
try {
    # Фикстуры без подписи: файлы PE-подобного вида, но без таблицы сертификатов.
    $unsignedClient = Join-Path $fx 'MatricaRMZ.exe'
    Set-Content -LiteralPath $unsignedClient -Value 'not a PE at all' -Encoding UTF8
    $unsignedExe = Join-Path $fx 'installer.exe'
    Set-Content -LiteralPath $unsignedExe -Value 'not a PE at all' -Encoding UTF8

    Assert-Equal 'файл без подписи не считается подписанным нашим ключом' `
        (Test-SignedByMatrica -Path $unsignedExe) 'False'
    Assert-Equal 'несуществующий файл не считается подписанным' `
        (Test-SignedByMatrica -Path (Join-Path $fx 'нет-такого.exe')) 'False'
    Assert-Equal 'пустой путь не считается подписанным' (Test-SignedByMatrica -Path '') 'False'

    # Подпись ЧУЖИМ издателем (Microsoft) — не наша: подписью Матрицы такой файл не закрыт.
    $foreign = Join-Path $env:SystemRoot 'System32\kernel32.dll'
    if (Test-Path -LiteralPath $foreign) {
        Assert-Equal 'подпись чужого издателя не считается нашей' `
            (Test-SignedByMatrica -Path $foreign) 'False'
    }

    # Клиент, подписанный нашим корнем: берём установленный, если он есть на этой машине.
    $realClient = Join-Path $env:LOCALAPPDATA 'Programs\MatricaRMZ\MatricaRMZ.exe'
    $signedClient = ''
    if (Test-Path -LiteralPath $realClient) {
        $signedClient = Join-Path $fx 'signed-client.exe'
        Copy-Item -LiteralPath $realClient -Destination $signedClient -Force
    }
    $haveSigned = $false
    if ($signedClient -and (Test-SignedByMatrica -Path $signedClient)) {
        $haveSigned = $true
        Assert-Equal 'файл, подписанный нашим корнем, опознан' `
            (Test-SignedByMatrica -Path $signedClient) 'True'
    } else {
        Write-Host '  skip  подписанного нашим корнем клиента на этой машине нет — часть проверок пропущена' -ForegroundColor DarkYellow
    }

    # План доверенных: клиент остаётся ВСЕГДА (на нём правило дочерних процессов),
    # неподписанное остаётся (подпись его не покрывает), подписанное уходит.
    $fake = [pscustomobject][ordered]@{
        AppExe = $unsignedClient; WatchdogExe = $unsignedExe
        ExtraExes = @($unsignedExe); Shortcuts = @()
    }
    $planSig = Get-TrustedAppsPlan -Matrica $fake -Mode 'Signature'
    Assert-Equal 'клиент остаётся в списке доверенных' `
        ([bool](@($planSig.Trusted) -contains $unsignedClient)) 'True'
    Assert-Equal 'неподписанный файл остаётся в списке доверенных' `
        ([bool](@($planSig.Trusted) -contains $unsignedExe)) 'True'
    Assert-Equal 'неподписанное не попадает в «закрытое подписью»' `
        (@($planSig.CoveredBySignature).Count) '0'

    $planLegacy = Get-TrustedAppsPlan -Matrica $fake -Mode 'Legacy'
    Assert-Equal 'в режиме Legacy список полный' (@($planLegacy.Trusted).Count) '2'
    Assert-Equal 'в режиме Legacy закрытых подписью нет' `
        (@($planLegacy.CoveredBySignature).Count) '0'

    if ($haveSigned) {
        $fakeSigned = [pscustomobject][ordered]@{
            AppExe = $unsignedClient; WatchdogExe = $unsignedExe
            ExtraExes = @($signedClient, $unsignedExe); Shortcuts = @()
        }
        $plan2 = Get-TrustedAppsPlan -Matrica $fakeSigned -Mode 'Signature'
        Assert-Equal 'подписанный файл ушёл из списка доверенных' `
            ([bool](@($plan2.Trusted) -contains $signedClient)) 'False'
        Assert-Equal 'подписанный файл помечен как закрытый подписью' `
            ([bool](@($plan2.CoveredBySignature) -contains $signedClient)) 'True'
        Assert-Equal 'неподписанный файл остался в списке' `
            ([bool](@($plan2.Trusted) -contains $unsignedExe)) 'True'

        # Ярлык: Касперский переносит доверие с .lnk на цель, поэтому подписанная цель
        # закрывает ярлык, а неподписанная — нет.
        $shell = New-Object -ComObject WScript.Shell
        $lnkSigned = Join-Path $fx 'на подписанное.lnk'
        $s1 = $shell.CreateShortcut($lnkSigned); $s1.TargetPath = $signedClient; $s1.Save()
        $lnkUnsigned = Join-Path $fx 'на неподписанное.lnk'
        $s2 = $shell.CreateShortcut($lnkUnsigned); $s2.TargetPath = $unsignedExe; $s2.Save()
        $fakeLnk = [pscustomobject][ordered]@{
            AppExe = $unsignedClient; WatchdogExe = $unsignedExe
            ExtraExes = @($unsignedExe); Shortcuts = @($lnkSigned, $lnkUnsigned)
        }
        $plan3 = Get-TrustedAppsPlan -Matrica $fakeLnk -Mode 'Signature'
        Assert-Equal 'ярлык на подписанную цель ушёл из списка' `
            ([bool](@($plan3.Trusted) -contains $lnkSigned)) 'False'
        Assert-Equal 'ярлык на неподписанную цель остался в списке' `
            ([bool](@($plan3.Trusted) -contains $lnkUnsigned)) 'True'
    }
} finally { Remove-Item -LiteralPath $fx -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host 'Список доверенных по умолчанию (откат с подписи):'
# Доверие по подписи на парке не подтвердилось (решение владельца 12.11.2026), поэтому
# по умолчанию список доверенных ПОЛНЫЙ: все наши исполняемые файлы и наши ярлыки.
$planDefault = Get-TrustedAppsPlan -Matrica ([pscustomobject]@{
        AppExe       = 'C:\Program Files\MatricaRMZ\MatricaRMZ.exe'
        WatchdogExe  = 'C:\Program Files\MatricaRMZ-Watchdog\matricarmz-watchdog.exe'
        ExtraExes    = @('C:\Program Files\MatricaRMZ-Updates\matricarmz_update.exe')
        Shortcuts    = @('C:\Users\operator\Desktop\MatricaRMZ.lnk')
    }) -Mode 'Legacy'
Assert-Equal 'клиент в списке доверенных' `
    ([bool](@($planDefault.Trusted) -contains 'C:\Program Files\MatricaRMZ\MatricaRMZ.exe')) 'True'
Assert-Equal 'сторож в списке доверенных' `
    ([bool](@($planDefault.Trusted) -contains 'C:\Program Files\MatricaRMZ-Watchdog\matricarmz-watchdog.exe')) 'True'
Assert-Equal 'апдейтер в списке доверенных' `
    ([bool](@($planDefault.Trusted) -contains 'C:\Program Files\MatricaRMZ-Updates\matricarmz_update.exe')) 'True'
Assert-Equal 'в режиме Legacy закрытых подписью нет' (@($planDefault.CoveredBySignature).Count) '0'

Write-Host 'Чужой ярлык в доверенные не попадает:'
# Поиск ярлыков идёт по образцу имени («*Матриц*.lnk»), и под него попадает ярлык на
# ЧУЖУЮ программу. Доверять чужое нельзя: ярлык берётся только если его цель — наш файл.
$fxLnk = Join-Path ([System.IO.Path]::GetTempPath()) ('matrica-lnk-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fxLnk -Force | Out-Null
try {
    $ourExe = Join-Path $fxLnk 'MatricaRMZ.exe'
    $foreignExe = Join-Path $fxLnk 'OtherApp.exe'
    Set-Content -LiteralPath $ourExe -Value ([byte[]](0x4D, 0x5A)) -Encoding Byte
    Set-Content -LiteralPath $foreignExe -Value ([byte[]](0x4D, 0x5A)) -Encoding Byte
    $shell = New-Object -ComObject WScript.Shell
    $lnkOur = Join-Path $fxLnk 'Матрица РМЗ.lnk'
    $lnkForeign = Join-Path $fxLnk 'Матрица РМЗ (чужая).lnk'
    $s = $shell.CreateShortcut($lnkOur); $s.TargetPath = $ourExe; $s.Save()
    $s = $shell.CreateShortcut($lnkForeign); $s.TargetPath = $foreignExe; $s.Save()
    $planLnk = Get-TrustedAppsPlan -Matrica ([pscustomobject]@{
            AppExe      = $ourExe
            WatchdogExe = ''
            ExtraExes   = @()
            Shortcuts   = @($lnkOur, $lnkForeign)
        }) -Mode 'Legacy'
    Assert-Equal 'наш ярлык в списке доверенных' `
        ([bool](@($planLnk.Trusted) -contains $lnkOur)) 'True'
    Assert-Equal 'чужой ярлык в список доверенных НЕ попал' `
        ([bool](@($planLnk.Trusted) -contains $lnkForeign)) 'False'
} finally { Remove-Item -LiteralPath $fxLnk -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host ''
if ($script:Failures -gt 0) {
    Write-Host "ИТОГ: провалов $script:Failures из $script:Checks" -ForegroundColor Red
    exit 1
}
Write-Host "ИТОГ: все проверки пройдены ($script:Checks)" -ForegroundColor Green
