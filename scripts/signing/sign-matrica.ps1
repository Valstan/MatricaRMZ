<#
.SYNOPSIS
    Подпись исполняемого контура MatricaRMZ собственным ключом (ADR-0003).

.DESCRIPTION
    Два режима, оба работают без прав администратора:

      -Mode NewCa   создать корневой CA MatricaRMZ: codesign.pfx (с приватным ключом,
                    в репозиторий НЕ коммитится) + rootca.cer (публичная часть,
                    кладётся на машины парка и в хранилище доверенных сертификатов).

      -Mode Sign    подписать бинарники. Ключ берётся из codesign.pfx (или из
                    CSC_LINK/CSC_KEY_PASSWORD, как в CI).

    Подпись Authenticode (sha256 + RFC3161-метка времени) делает файл доверенным
    для Касперского через вкладку «Доверенное системное хранилище сертификатов»:
    подписанное доверенной подписью приложение автоматически попадает в группу
    «Доверенные» и не проверяется.

    Ключи:
      -Mode NewCa|Sign|InstallRoot|Verify

      -PfxPath <путь>      codesign.pfx (NewCa: куда создать; Sign: откуда взять)
      -CerPath <путь>      rootca.cer (NewCa: куда сохранить; InstallRoot: откуда поставить)
      -Target <путь>       файл или папка для подписи (Sign). Папка обходится рекурсивно.
      -CertStore           хранилище для InstallRoot: CurrentUser (по умолчанию) | LocalMachine
      -Password <пароль>   пароль PFX (по умолчанию берётся из CSC_KEY_PASSWORD)
      -TimestampUrl <url>  сервер метки времени (по умолчанию http://timestamp.digicert.com)
      -IncludeExt <список> расширения для подписи, по умолчанию .exe,.dll,.node
      -Json                машинный вывод

.EXAMPLE
    .\sign-matrica.ps1 -Mode NewCa -PfxPath .\codesign.pfx -CerPath .\rootca.cer -Password '...'

.EXAMPLE
    .\sign-matrica.ps1 -Mode Sign -PfxPath .\codesign.pfx -Password '...' -Target C:\out\MatricaRMZ

.EXAMPLE
    .\sign-matrica.ps1 -Mode InstallRoot -CerPath .\rootca.cer
#>
[CmdletBinding()]
param(
    [ValidateSet('NewCa', 'Sign', 'InstallRoot', 'Verify')]
    [string]$Mode = 'Verify',
    [string]$PfxPath,
    [string]$CerPath,
    [string]$Target,
    [ValidateSet('CurrentUser', 'LocalMachine')]
    [string]$CertStore = 'CurrentUser',
    [string]$Password,
    [string]$TimestampUrl = 'http://timestamp.digicert.com',
    [string]$IncludeExt = '.exe,.dll,.node',
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

# Вывод идёт в консоль всегда, кроме режима -Json. Флаг берём через Get-Variable,
# а не через $Json напрямую: функции скрипта подключаются точкой из теста
# (sign-matrica.tests.ps1), где параметра $Json нет, и под StrictMode обращение
# к несуществующей переменной роняет тест.
function Write-Info {
    param([string]$Message)
    if (-not (Get-Variable -Name 'Json' -ValueOnly -ErrorAction SilentlyContinue)) {
        Write-Host $Message
    }
}

function Write-Err {
    param([string]$Message)
    if (-not (Get-Variable -Name 'Json' -ValueOnly -ErrorAction SilentlyContinue)) {
        Write-Host $Message -ForegroundColor Red
    }
}

function Get-SignToolPath {
    # Windows SDK: signtool.exe есть в поставке Windows Kits. Ищем x64-сборку —
    # ARM64/x86 не подойдут для подписи x64-бинарьев на старых системах.
    $roots = @(
        'C:\Program Files (x86)\Windows Kits\10\bin',
        'C:\Program Files\Windows Kits\10\bin'
    ) | Where-Object { Test-Path $_ }
    foreach ($root in $roots) {
        $hit = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
            Where-Object { Test-Path $_ } |
            Select-Object -First 1
        if ($hit) { return $hit }
    }
    return $null
}

<#
    Кто подписал файл — по ТАБЛИЦЕ СЕРТИФИКАТОВ PE, а не по Get-AuthenticodeSignature.
    PowerShell 5.1 для файла, ранее подписанного Microsoft, отдаёт подпись из
    каталога подписей Windows и показывает подписавшего Microsoft даже после
    замены подписи нашей (M189). Источник истины — signtool verify /pa /v:
    он печатает отпечатки всех сертификатов цепочки («SHA1 hash:»).
#>
function Get-SignerInfo {
    param([string]$File, [string]$SignTool, [string]$OurThumbprint)

    if (-not (Test-Path -LiteralPath $File)) { return @{ Signed = $false; Ours = $false; Thumbprints = @(); Subject = '' } }

    $out = ''
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = (& $SignTool verify /pa /v $File 2>&1) | Out-String -Width 300
    } finally {
        $ErrorActionPreference = $prevPref
    }

    $hashes = @([regex]::Matches($out, 'SHA1 hash:\s*([0-9A-Fa-f]{40})') | ForEach-Object { $_.Groups[1].Value.ToUpperInvariant() })
    $subject = ''
    $m = [regex]::Match($out, 'Issued to:\s*(.+?)\s*$', [System.Text.RegularExpressions.RegexOptions]::Multiline)
    if ($m.Success) { $subject = $m.Groups[1].Value.Trim() }
    $ours = $false
    if ($OurThumbprint) { $ours = ($hashes -contains $OurThumbprint.ToUpperInvariant()) }
    return @{ Signed = ($hashes.Count -gt 0); Ours = $ours; Thumbprints = $hashes; Subject = $subject }
}

function Resolve-Password {
    param([string]$Explicit)
    if ($Explicit) { return $Explicit }
    if ($env:CSC_KEY_PASSWORD) { return $env:CSC_KEY_PASSWORD }
    return $null
}

function New-SigningCa {
    param([string]$OutPfx, [string]$OutCer, [string]$Pwd)

    if (-not $OutPfx -or -not $OutCer) { throw 'Нужны -PfxPath и -CerPath.' }
    if (-not $Pwd) { throw 'Нужен пароль PFX (-Password или CSC_KEY_PASSWORD).' }

    # Тип CodeSigningCert — ключ с EKU «Подписывание кода». Self-signed: своего
    # публичного CA у проекта нет и не будет (ADR-0003, D-084).
    $cert = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject 'CN=MatricaRMZ Root CA, O=MatricaRMZ, C=RU' `
        -KeyUsage DigitalSignature, CertSign, CRLSign `
        -KeyExportPolicy Exportable `
        -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
        -CertStoreLocation 'Cert:\CurrentUser\My' `
        -NotBefore (Get-Date).AddDays(-1) `
        -NotAfter (Get-Date).AddYears(10)

    $secure = ConvertTo-SecureString $Pwd -AsPlainText -Force
    Export-PfxCertificate -Cert $cert -FilePath $OutPfx -Password $secure | Out-Null
    Export-Certificate -Cert $cert -FilePath $OutCer -Type CERT | Out-Null

    # PFX в репозиторий не попадает: он остаётся в хранилище пользователя и в CI-секрете.
    Write-Info "CA создан: $($cert.Thumbprint)"
    Write-Info "PFX:  $OutPfx  (приватный ключ — в репозиторий НЕ коммитится)"
    Write-Info "CER:  $OutCer  (публичная часть — на машины парка)"
    return @{ Thumbprint = $cert.Thumbprint; Subject = $cert.Subject; PfxPath = $OutPfx; CerPath = $OutCer }
}

function Install-TrustedRoot {
    param([string]$CerFile, [string]$Store)

    if (-not $CerFile) { throw 'Нужен -CerPath.' }
    if (-not (Test-Path -LiteralPath $CerFile)) { throw "Файл не найден: $CerFile" }

    # Именно .NET API, а не certutil/Import-Certificate: certutil в неинтерактивной
    # сессии зависает на невидимом диалоге подтверждения, Import-Certificate
    # отвечает «пользовательский интерфейс запрещен». X509Store.Add() работает молча.
    #
    # ВАЖНО: добавление в хранилище Root идёт ОЧЕНЬ ДОЛГО — замерено на PC79
    # 04.11.2026: первая установка нового корня 207 секунд, повторная того же
    # сертификата 9,4 с, в TrustedPublisher 3 мс на том же .NET API. Задержка не в
    # сертификате (у него нет ни CRL, ни AIA — цепочка строится локально), а на
    # стороне Windows при добавлении в Root. Это НЕ зависание, но оператор на парке
    # должен знать про ожидание — иначе бросит установку. Скрипт предупреждает заранее.
    $x = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($CerFile)
    $s = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', $Store)
    try {
        $s.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
        Write-Info 'Ставлю корень в хранилище. Это МЕДЛЕННО: от 45 секунд до нескольких минут (Windows проверяет доверие). Не прерывайте — установка не зависла.'
        $s.Add($x)
    } finally {
        $s.Close()
    }
    Write-Info "Корень установлен в Cert:\$Store\Root ($Store)"
    return @{ Store = $Store; Thumbprint = $x.Thumbprint; Subject = $x.Subject }
}

function Get-SignTargets {
    param([string]$Path, [string[]]$Extensions)

    if (-not (Test-Path -LiteralPath $Path)) { throw "Путь не найден: $Path" }
    $item = Get-Item -LiteralPath $Path
    if (-not $item.PSIsContainer) { return @($item.FullName) }

    $exts = $Extensions | ForEach-Object { $_.ToLowerInvariant() }
    return @(Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $exts -contains $_.Extension.ToLowerInvariant() } |
        ForEach-Object { $_.FullName })
}

function Invoke-Sign {
    param([string[]]$Files, [string]$PfxFile, [string]$Pwd, [string]$TsUrl, [string]$SignTool)

    if (-not $PfxFile) { throw 'Нужен -PfxPath.' }
    if (-not (Test-Path -LiteralPath $PfxFile)) { throw "PFX не найден: $PfxFile" }
    if (-not $Pwd) { throw 'Нужен пароль PFX (-Password или CSC_KEY_PASSWORD).' }
    if (-not $SignTool) { throw 'signtool.exe не найден (Windows SDK не установлен).' }

    # Отпечаток нашего сертификата: по нему отличаем «подписан нами» от
    # «подписан кем-то ещё» (см. комментарий в цикле ниже).
    # PFX с неверным паролем не открывается — это должно стать понятной ошибкой
    # для человека, а не падением на конструкторе.
    try {
        $pfxCert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($PfxFile, $Pwd)
    } catch {
        throw "PFX не открывается: неверный пароль или файл повреждён ($($_.Exception.Message))"
    }
    $PfxThumbprint = $pfxCert.Thumbprint

    $results = @()
    foreach ($f in $Files) {
        # Кто стоит в подписи файла — по ТАБЛИЦЕ СЕРТИФИКАТОВ PE (M189).
        # Get-AuthenticodeSignature здесь не годится: для файла, ранее
        # подписанного Microsoft, он отдаёт подпись из каталога подписей Windows
        # и показывает подписавшего Microsoft даже после замены подписи нашей.
        #
        # Правило:
        #   - в цепочке есть наш отпечаток → уже подписано нами, пропускаем
        #     (идемпотентность);
        #   - чужая подпись → подписываем заново: signtool ЗАМЕНЯЕТ подпись
        #     (в таблице остаётся одна запись — наша), и файл становится
        #     доверенным по НАШЕМУ ключу — ровно то, ради чего всё затевалось
        #     (ADR-0003);
        #   - подписи нет → подписываем, наша становится первичной.
        $before = Get-SignerInfo -File $f -SignTool $SignTool -OurThumbprint $PfxThumbprint
        if ($before.Ours) {
            $results += [pscustomobject]@{ File = $f; Status = 'AlreadySigned'; Message = $before.Subject }
            continue
        }
        $wasForeign = if ($before.Signed) { " (заменена подпись: $($before.Subject))" } else { '' }

        # signtool пишет об ошибке в stderr, а $ErrorActionPreference='Stop' превращает
        # stderr нативной команды в исключение — скрипт упал бы раньше, чем мы успели
        # записать результат. Поэтому на время вызова ошибки глушим, а вердикт берём
        # из $LASTEXITCODE.
        $out = ''
        $prevPref = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $out = (& $SignTool sign /f $PfxFile /p $Pwd /fd sha256 /tr $TsUrl /td sha256 $f 2>&1) | Out-String
            $code = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $prevPref
        }
        if ($code -ne 0) {
            # Из вывода signtool берём только строку с самой ошибкой — PowerShell
            # дописывает в stderr обёртку вызова, она в сообщении не нужна.
            $msg = ($out -split "`r?`n" | Where-Object { $_ -match 'SignTool Error|error' } | Select-Object -First 1)
            if (-not $msg) { $msg = ($out -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1) }
            $results += [pscustomobject]@{ File = $f; Status = 'Failed'; Message = ($msg -replace '^\s*signtool\.exe\s*:\s*','').Trim() }
            continue
        }
        # Проверяем результат по таблице сертификатов: наш отпечаток должен быть
        # в цепочке. Get-AuthenticodeSignature здесь снова не годится (M189).
        $after = Get-SignerInfo -File $f -SignTool $SignTool -OurThumbprint $PfxThumbprint
        $status = if ($after.Ours) { 'Signed' } elseif ($after.Signed) { 'ForeignSigned' } else { 'NotSigned' }
        $results += [pscustomobject]@{
            File = $f
            Status = $status
            Message = ([string]$after.Subject) + $wasForeign
        }
    }
    return $results
}

function Test-SignedTree {
    param([string]$Path, [string[]]$Extensions, [string]$OurThumbprint)

    $files = Get-SignTargets -Path $Path -Extensions $Extensions
    $rows = foreach ($f in $files) {
        # Кто подписал — по таблице сертификатов PE (M189), а не по
        # Get-AuthenticodeSignature (для файлов Microsoft он врёт).
        $info = Get-SignerInfo -File $f -SignTool $signTool -OurThumbprint $OurThumbprint
        [pscustomobject]@{
            File = $f
            Status = if ($info.Ours) { 'Signed' } elseif ($info.Signed) { 'ForeignSigned' } else { 'NotSigned' }
            Signer = [string]$info.Subject
        }
    }
    return @($rows)
}

# --- main -------------------------------------------------------------------

$signTool = Get-SignToolPath
$pwd = Resolve-Password -Explicit $Password
$exts = $IncludeExt -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }

switch ($Mode) {
    'NewCa' {
        $res = New-SigningCa -OutPfx $PfxPath -OutCer $CerPath -Pwd $pwd
        if ($Json) { $res | ConvertTo-Json -Depth 4 }
    }
    'InstallRoot' {
        $res = Install-TrustedRoot -CerFile $CerPath -Store $CertStore
        if ($Json) { $res | ConvertTo-Json -Depth 4 }
    }
    'Sign' {
        $files = Get-SignTargets -Path $Target -Extensions $exts
        Write-Info "К подписанию: $($files.Count) файл(ов)"
        $results = Invoke-Sign -Files $files -PfxFile $PfxPath -Pwd $pwd -TsUrl $TimestampUrl -SignTool $signTool
        $failed = @($results | Where-Object { $_.Status -eq 'Failed' })
        if ($Json) {
            $results | ConvertTo-Json -Depth 4
        } else {
            $results | ForEach-Object { "{0,-12} {1}" -f $_.Status, (Split-Path $_.File -Leaf) }
            if ($failed.Count) { Write-Err "Не подписано: $($failed.Count)" }
        }
        if ($failed.Count) { exit 1 }
    }
    'Verify' {
        if (-not $Target) { throw 'Нужен -Target.' }
        # Отпечаток нашего CA — если ключ задан, показываем, чья это подпись.
        $ourThumb = ''
        if ($PfxPath -and (Test-Path -LiteralPath $PfxPath)) {
            try {
                $ourThumb = (New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($PfxPath, $pwd)).Thumbprint
            } catch { $ourThumb = '' }
        }
        $rows = Test-SignedTree -Path $Target -Extensions $exts -OurThumbprint $ourThumb
        if ($Json) {
            $rows | ConvertTo-Json -Depth 4
        } else {
            $rows | ForEach-Object { "{0,-12} {1,-46} {2}" -f $_.Status, (Split-Path $_.File -Leaf), $_.Signer }
        }
    }
}
