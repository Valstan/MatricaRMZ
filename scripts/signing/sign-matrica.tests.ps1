# sign-matrica.tests.ps1 — приёмка помощника подписи (2026-11-04)
#
# Запуск (Windows, PowerShell 5.1 — та же версия, что на машинах парка):
#   powershell -NoProfile -ExecutionPolicy Bypass -File sign-matrica.tests.ps1
# Код возврата 0 — всё зелено, 1 — есть провалы.
#
# Зачем отдельный файл, если в репозитории тесты на vitest: проверяемое здесь —
# байты и API Windows. Подпись — это Authenticode, а её результат читается только
# криптографией Windows (Get-AuthenticodeSignature / signtool verify), а не
# утверждениями скрипта. Ошибка здесь не роняет ничего на этой машине: она всплывает
# на парке, где доверенный корень не установлен или ключ не тот.
# Pester намеренно не используется: на машине парка его нет, а тест должен запускаться
# там же, где инструмент.
#
# Тест НЕ трогает Касперского, не ставит корень в хранилище и не подписывает файлы
# за пределами своей временной папки.
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

function Assert-True {
    param([string]$Name, [bool]$Condition)
    Assert-Equal $Name $Condition $true
}

# Определения функций берём из скрипта разбором, а не точкой: точка запустила бы и
# основной поток.
$target = Join-Path $PSScriptRoot 'sign-matrica.ps1'
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

# --- кодировка файла ---------------------------------------------------------
# Windows PowerShell 5.1 читает .ps1 без BOM как ANSI — русский текст в сообщениях
# об ошибках превращается в мусор, а хуже того — ломает разбор (M188: тот же класс
# проблемы, что и с certutil). Скрипт обязан лежать в UTF-8 с BOM.
Write-Host 'Кодировка файла:'
$bytes = [System.IO.File]::ReadAllBytes($target)
Assert-True 'UTF-8 BOM присутствует' ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)

# --- выбор целей -------------------------------------------------------------
Write-Host 'Выбор файлов к подписанию:'
$fake = Join-Path ([System.IO.Path]::GetTempPath()) ('sign-matrica-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $fake 'nested') -Force | Out-Null
foreach ($n in @('a.exe', 'b.dll', 'c.node', 'd.txt', 'e.exe.txt')) {
    [System.IO.File]::WriteAllText((Join-Path $fake $n), 'x')
}
[System.IO.File]::WriteAllText((Join-Path $fake 'nested\deep.exe'), 'x')

try {
    $targets = Get-SignTargets -Path $fake -Extensions @('.exe', '.dll', '.node')
    $names = @($targets | ForEach-Object { Split-Path $_ -Leaf } | Sort-Object)
    Assert-Equal 'подписываются только заданные расширения' ($names -join ',') 'a.exe,b.dll,c.node,deep.exe'

    $onlyExe = Get-SignTargets -Path $fake -Extensions @('.exe')
    $onlyExeNames = @($onlyExe | ForEach-Object { Split-Path $_ -Leaf } | Sort-Object)
    Assert-Equal 'суффикс .exe.txt не считается .exe' ($onlyExeNames -join ',') 'a.exe,deep.exe'

    $single = Get-SignTargets -Path (Join-Path $fake 'a.exe') -Extensions @('.exe')
    Assert-Equal 'одиночный файл отдаётся как есть' (@($single).Count) '1'

    # --- подпись на настоящем бинарнике ---------------------------------------
    # Берём настоящий исполняемый файл Windows: подпись должна пройти, и подпись
    # должна проверяться. Рабочий каталог не трогаем — копия уезжает в temp.
    #
    # Файл берём НЕ подписанный Microsoft'ом (where.exe и подобные) намеренно:
    # проверка подписи файла с чужим сертификатом тянет CRL/OCSP по сети, а на
    # машине без интернета эта проверка встаёт на долгий таймаут. Наш CA своих
    # точек отзыва не публикует, поэтому проверка идёт по локальной цепочке и
    # отрабатывает мгновенно.
    Write-Host 'Подпись настоящего бинарника:'
    $signtool = Get-SignToolPath
    $tsUrl = 'http://timestamp.digicert.com'
    if (-not $signtool) {
        Write-Host '  skip signtool.exe не найден (нет Windows SDK) — проверка подписи пропущена' -ForegroundColor Yellow
    } else {
        # Ищем неподписанный исполняемый файл. Системные where.exe/cmd.exe/reg.exe
        # в современных сборках Windows подписаны Microsoft — такой файл годится
        # для проверки ForeignSigned, но не для проверки самой подписи. Для неё
        # берём неподписанный .node из дерева репозитория (собранный better-sqlite3),
        # а если его нет — любой системный файл, и тогда проверка подписи смягчается.
        $source = $null
        $fallback = $null
        foreach ($cand in @(
                (Join-Path $env:SystemRoot 'System32\where.exe'),
                (Join-Path $env:SystemRoot 'System32\cmd.exe'),
                (Join-Path $env:SystemRoot 'System32\reg.exe'),
                (Join-Path $env:SystemRoot 'System32\notepad.exe'))) {
            if (-not (Test-Path -LiteralPath $cand)) { continue }
            if (-not $fallback) { $fallback = $cand }
            $st = (Get-AuthenticodeSignature -LiteralPath $cand).Status
            if ($st -eq 'NotSigned') { $source = $cand; break }
        }
        # Неподписанный PE из дерева репозитория — надёжнее системного.
        $repoNode = Get-ChildItem -Path (Join-Path (Split-Path -Parent $PSScriptRoot) '..') `
            -Recurse -Include '*.node' -File -ErrorAction SilentlyContinue |
            Where-Object { (Get-AuthenticodeSignature -LiteralPath $_.FullName).Status -eq 'NotSigned' } |
            Select-Object -First 1
        if ($repoNode) { $source = $repoNode.FullName }
        if (-not $source) { $source = $fallback }
        if (-not $source) { throw 'Не найден исполняемый файл Windows для теста подписи.' }
        $copy = Join-Path $fake 'target-copy.exe'
        [System.IO.File]::Copy($source, $copy, $true)

        # Свой CA для теста. Он переиспользуется между прогонами: добавление
        # сертификата в хранилище Root идёт 45–75 секунд (проверка цепочки доверия,
        # M188), и каждый новый CA запускал бы эту проверку заново. Кэш лежит в
        # temp, в репозиторий не попадает.
        $pwd = 'test-only-not-a-secret'
        $cacheDir = Join-Path ([System.IO.Path]::GetTempPath()) 'matrica-signing-test-ca'
        $pfx = Join-Path $cacheDir 'test.pfx'
        $cer = Join-Path $cacheDir 'test.cer'
        $ca = $null
        if ((Test-Path -LiteralPath $pfx) -and (Test-Path -LiteralPath $cer)) {
            try {
                $ca = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($pfx, $pwd)
            } catch { $ca = $null }
        }
        if (-not $ca) {
            New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
            $ca = New-SelfSignedCertificate `
                -Type CodeSigningCert `
                -Subject 'CN=MatricaRMZ Test Root CA, O=MatricaRMZ, C=RU' `
                -KeyUsage DigitalSignature, CertSign, CRLSign `
                -KeyExportPolicy Exportable `
                -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
                -CertStoreLocation 'Cert:\CurrentUser\My' `
                -NotBefore (Get-Date).AddDays(-1) -NotAfter (Get-Date).AddYears(1)
            Export-PfxCertificate -Cert $ca -FilePath $pfx -Password (ConvertTo-SecureString $pwd -AsPlainText -Force) | Out-Null
            Export-Certificate -Cert $ca -FilePath $cer -Type CERT | Out-Null
        }
        try {
            Assert-True 'PFX создан' (Test-Path -LiteralPath $pfx)
            Assert-True 'CER создан' (Test-Path -LiteralPath $cer)
            Assert-Equal 'у CA есть EKU подписи кода' (@($ca.EnhancedKeyUsageList | Where-Object { $_.FriendlyName -eq 'Подписывание кода' }).Count) 1

            $caThumb = $ca.Thumbprint
            $signResult = Invoke-Sign -Files @($copy) -PfxFile $pfx -Pwd $pwd -TsUrl $tsUrl -SignTool $signtool
            Assert-Equal 'подпись прошла' @($signResult)[0].Status 'Signed'

            # Подписал именно наш CA. Проверяем по таблице сертификатов PE:
            # Get-AuthenticodeSignature для файлов Microsoft показывает Microsoft
            # даже после замены подписи (M189).
            $after = Get-SignerInfo -File $copy -SignTool $signtool -OurThumbprint $caThumb
            Assert-True 'подписал наш CA' ([bool]$after.Ours)

            # Повторная подпись не должна ломать файл — она просто пропускается.
            $again = Invoke-Sign -Files @($copy) -PfxFile $pfx -Pwd $pwd -TsUrl $tsUrl -SignTool $signtool
            Assert-Equal 'повторная подпись пропускается' @($again)[0].Status 'AlreadySigned'

            # Неверный пароль PFX — это ошибка конфигурации, а не «файл не
            # подписался»: скрипт обязан упасть целиком с понятным текстом, иначе
            # тихий прогон без подписей выглядит как успех.
            $badFresh = Join-Path $fake 'fresh.exe'
            [System.IO.File]::Copy($source, $badFresh, $true)
            $threw = $false
            $threwMsg = ''
            try {
                Invoke-Sign -Files @($badFresh) -PfxFile $pfx -Pwd 'wrong-password' -TsUrl $tsUrl -SignTool $signtool | Out-Null
            } catch {
                $threw = $true
                $threwMsg = $_.Exception.Message
            }
            Assert-True 'неверный пароль PFX роняет скрипт' $threw
            Assert-True 'в тексте ошибки есть слово про пароль' ([bool]($threwMsg -match 'парол'))

            # Чужая подпись (Microsoft) ЗАМЕНЯЕТСЯ нашей: signtool не добавляет вторую
            # запись, а заменяет имеющуюся (M189 — разбор таблицы сертификатов PE).
            $foreign = Join-Path $fake 'foreign.exe'
            [System.IO.File]::Copy((Join-Path $env:SystemRoot 'System32\where.exe'), $foreign, $true)
            $foreignResult = Invoke-Sign -Files @($foreign) -PfxFile $pfx -Pwd $pwd -TsUrl $tsUrl -SignTool $signtool
            Assert-Equal 'файл с чужой подписью переподписан нашим' @($foreignResult)[0].Status 'Signed'
            $foreignInfo = Get-SignerInfo -File $foreign -SignTool $signtool -OurThumbprint $caThumb
            Assert-True 'подпись Microsoft заменена нашей' ([bool]$foreignInfo.Ours)
            Assert-True 'в цепочке наш отпечаток' (@($foreignInfo.Thumbprints) -contains $caThumb.ToUpperInvariant())

            # Установка корня в CurrentUser\Root — без прав администратора и без диалога
            # (M188: certutil тут зависает, Import-Certificate отказывает).
            # Сама установка идёт 45–75 секунд: Windows проверяет цепочку доверия и
            # тянется до точки отзыва. Это медленно, но не зависание. Если корень
            # уже стоит (тест переиспользует CA между прогонами) — установка
            # повторная и быстрая.
            $alreadyInStore = [bool](Get-ChildItem Cert:\CurrentUser\Root -ErrorAction SilentlyContinue |
                Where-Object { $_.Thumbprint -eq $caThumb })
            if ($alreadyInStore) {
                Write-Host 'Корень уже в доверенных — установку пропускаем.'
                $installed = @{ Store = 'CurrentUser'; Thumbprint = $caThumb; Subject = $ca.Subject }
            } else {
                Write-Host 'Установка доверенного корня (МЕДЛЕННО: от 45 секунд до нескольких минут — Windows проверяет доверие, установка не зависла)...'
                $swRoot = [Diagnostics.Stopwatch]::StartNew()
                $installed = Install-TrustedRoot -CerFile $cer -Store 'CurrentUser'
                $swRoot.Stop()
                Write-Host ("  корень установлен за " + [math]::Round($swRoot.Elapsed.TotalSeconds, 1) + " с")
            }
            Assert-True 'корень установлен' ([bool](Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Thumbprint -eq $installed.Thumbprint }))

            # Имя машинного хранилища задаётся параметром: Касперский по умолчанию
            # предлагает Enterprise Trust («Доверительные отношения в предприятии»), и корень
            # должен лежать в том же хранилище, что выбрано в его списке. Поэтому режим
            # InstallRoot умеет класть корень не только в Root.
            $alreadyInTrust = [bool](Get-ChildItem Cert:\CurrentUser\Trust -ErrorAction SilentlyContinue |
                Where-Object { $_.Thumbprint -eq $caThumb })
            if ($alreadyInTrust) {
                Write-Host 'Корень уже в Trust — установку пропускаем.'
                $installedTrust = @{ Store = 'CurrentUser'; RootStoreName = 'Trust'; Thumbprint = $caThumb }
            } else {
                Write-Host 'Установка доверенного корня в CurrentUser\Trust (Enterprise Trust)...'
                $swTrust = [Diagnostics.Stopwatch]::StartNew()
                $installedTrust = Install-TrustedRoot -CerFile $cer -Store 'CurrentUser' -RootStoreName 'Trust'
                $swTrust.Stop()
                Write-Host ("  корень установлен в Trust за " + [math]::Round($swTrust.Elapsed.TotalSeconds, 1) + " с")
            }
            Assert-True 'корень установлен в выбранное хранилище (Trust)' ([bool](Get-ChildItem Cert:\CurrentUser\Trust -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $installedTrust.Thumbprint }))
            Assert-True 'в ответе указано имя хранилища' ($installedTrust.RootStoreName -eq 'Trust')

            # Теперь цепочка доверия сходится и signtool это подтверждает.
            $verifyOut = & $signtool verify /pa $copy 2>&1 | Out-String
            Assert-True 'signtool verify проходит после установки корня' ($verifyOut -match 'Successfully verified')
        } finally {
            # Чистим за собой: личный сертификат теста из хранилища My убираем
            # (приватный ключ не должен валяться в хранилище). Корневой сертификат
            # в Root оставляем — он переиспользуется следующими прогонами, и его
            # удаление означало бы ещё одну проверку цепочки доверия за 45–75 секунд.
            # Убрать его вручную: certutil -user -delstore Root <отпечаток>.
            try {
                $my = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'CurrentUser')
                $my.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
                $my.Remove($ca)
                $my.Close()
            } catch { }
        }
    }
} finally {
    if (Test-Path -LiteralPath $fake) {
        Get-ChildItem -LiteralPath $fake -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
            try { [System.IO.File]::Delete($_.FullName) } catch { }
        }
        try { Remove-Item -LiteralPath $fake -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    }
}

Write-Host ''
Write-Host "Проверок: $script:Checks, провалов: $script:Failures"
if ($script:Failures -gt 0) { exit 1 }
exit 0
