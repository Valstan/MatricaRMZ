<#
.SYNOPSIS
    Подпись релизных артефактов Матрицы в CI (ADR-0003).

.DESCRIPTION
    Три режима — по одному на каждый артефакт:

      -Mode Electron   подпись того, что собрал electron-builder (клиент, инсталлятор,
                       деинсталлятор, DLL, .node). Работает через собственные опции
                       electron-builder: CSC_LINK + win.signDlls + win.signExts.

      -Mode Watchdog   подпись Go-бинаря сторожа. electron-builder его не подписывает:
                       сторож собирается ДО electron-builder и кладётся в extraResources
                       как готовый файл.

      -Mode Verify     проверка: каждый артефакт подписан и подписан НАШИМ ключом.

    Ключевые свойства, ради которых скрипт написан отдельным:

      1. **Без сертификата сборка не падает.** electron-builder при пустом CSC_LINK
         молча пропускает подпись («no signing info identified, signing is skipped»),
         и релиз выпускается неподписанным. Это осознанное поведение: парк не должен
         остаться без релизов из-за отсутствия ключа.

      2. **Битый сертификат падает ПОНЯТНО.** Если CSC_LINK задан, но PFX не
         открывается (неверный пароль, битый файл) — electron-builder падает с
         невнятным сообщением. Здесь мы проверяем PFX заранее и даём внятную
         диагностику.

      3. **Подпись — только то, что не подписано.** signtool НЕ добавляет вторую
         подпись, а ЗАМЕНЯЕТ имеющуюся (проверено на d3dcompiler_47.dll: размер
         таблицы сертификатов 10608 → 1912, и в таблице остаётся одна запись —
         наша). Поэтому подписывать нужно всё, что мы собираем, включая файлы,
         подписанные Microsoft: иначе они останутся чужими. Файлы Microsoft
         подписываем тоже — доверие важнее происхождения.

.EXAMPLE
    .\ci-sign-artifacts.ps1 -Mode Electron -ReleaseDir .\release

.EXAMPLE
    .\ci-sign-artifacts.ps1 -Mode Watchdog -Target .\watchdog.exe

.EXAMPLE
    .\ci-sign-artifacts.ps1 -Mode Verify -ReleaseDir .\release -RequireSigned
#>
[CmdletBinding()]
param(
    [ValidateSet('Electron', 'Watchdog', 'Verify')]
    [string]$Mode = 'Verify',
    [string]$ReleaseDir,
    [string]$Target,
    [string]$PfxPath,
    [string]$Password,
    [string]$TimestampUrl = 'http://timestamp.digicert.com',
    [switch]$RequireSigned,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Write-Info {
    param([string]$Message)
    if (-not (Get-Variable -Name 'Json' -ValueOnly -ErrorAction SilentlyContinue)) { Write-Host $Message }
}
function Write-Warn2 {
    param([string]$Message)
    if (-not (Get-Variable -Name 'Json' -ValueOnly -ErrorAction SilentlyContinue)) { Write-Host $Message -ForegroundColor Yellow }
}

function Get-SignToolPath {
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

function Resolve-Password {
    param([string]$Explicit)
    if ($Explicit) { return $Explicit }
    if ($env:CSC_KEY_PASSWORD) { return $env:CSC_KEY_PASSWORD }
    return $null
}

function Get-PfxThumbprint {
    param([string]$PfxFile, [string]$Pwd)
    try {
        $c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($PfxFile, $Pwd)
    } catch {
        return $null
    }
    return $c.Thumbprint
}

<#
    Проверка PFX заранее. electron-builder при битом ключе падает внутри
    signUsingSigntool сообщением про невозможность извлечь издателя — там
    не сказано, что не так. Здесь говорим прямо.
#>
function Test-PfxUsable {
    param([string]$PfxFile, [string]$Pwd)

    if (-not $PfxFile) { return @{ Ok = $false; Reason = 'путь к PFX не задан' } }
    if (-not (Test-Path -LiteralPath $PfxFile)) { return @{ Ok = $false; Reason = "файл не найден: $PfxFile" } }
    if (-not $Pwd) { return @{ Ok = $false; Reason = 'пароль не задан (CSC_KEY_PASSWORD)' } }
    try {
        $c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($PfxFile, $Pwd)
    } catch {
        return @{ Ok = $false; Reason = "PFX не открывается — неверный пароль или файл повреждён: $($_.Exception.Message)" }
    }
    # EKU «Подписывание кода» = 1.3.6.1.5.5.7.3.3. Проверяем по OID, а не по
    # FriendlyName: имя локализовано («Подписывание кода» / «Code Signing»).
    # В PowerShell 5.1 элемент EnhancedKeyUsageList — это EnhancedKeyUsageRepresentation
    # со свойствами FriendlyName и ObjectId; ObjectId здесь СТРОКА с OID.
    $codeSigning = 0
    foreach ($e in @($c.EnhancedKeyUsageList)) {
        if (-not $e) { continue }
        $oid = $null
        if ($e.PSObject.Properties['ObjectId'] -and $e.ObjectId) { $oid = [string]$e.ObjectId }
        if (-not $oid -and $e.PSObject.Properties['Value']) { $oid = [string]$e.Value }
        if ($oid -eq '1.3.6.1.5.5.7.3.3') { $codeSigning++ }
    }
    if ($codeSigning -eq 0) {
        # Запасной путь: разбираем само расширение EKU, там OID видны как есть.
        $ekuExt = @($c.Extensions | Where-Object { $_.Oid -and $_.Oid.Value -eq '2.5.29.37' })
        foreach ($ext in $ekuExt) {
            if ($ext.Format($false) -match '1\.3\.6\.1\.5\.5\.7\.3\.3') { $codeSigning++ }
        }
    }
    if ($codeSigning -eq 0) {
        return @{ Ok = $false; Reason = "в сертификате нет EKU «Подписывание кода» (1.3.6.1.5.5.7.3.3)" }
    }
    return @{ Ok = $true; Thumbprint = $c.Thumbprint; Subject = $c.Subject }
}

<#
    Кто подписал файл — по таблице сертификатов PE, а не по Get-AuthenticodeSignature.
    PowerShell 5.1 для файлов с несколькими подписями или с подписью в каталоге
    возвращает подпись Microsoft вместо нашей (проверено: certutil -dump показывает
    нашу, а Get-AuthenticodeSignature — Microsoft). Источник истины — таблица
    сертификатов: signtool verify /pa /v печатает отпечатки всей цепочки.
#>
function Get-EmbeddedSigner {
    param([string]$File, [string]$SignTool, [string]$OurThumbprint)

    if (-not (Test-Path -LiteralPath $File)) { return @{ Signed = $false; Ours = $false; Thumbprints = @(); Subject = '' } }
    # signtool пишет «No signature found» в stderr для неподписанного файла, а
    # $ErrorActionPreference='Stop' превращает это в исключение — цикл проверки
    # упал бы на первом же неподписанном файле. На время вызова ошибки глушим.
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

function Get-SignTargets {
    param([string]$Path, [string[]]$Extensions)
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    $item = Get-Item -LiteralPath $Path
    if (-not $item.PSIsContainer) { return @($item.FullName) }
    $exts = $Extensions | ForEach-Object { $_.ToLowerInvariant() }
    return @(Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $exts -contains $_.Extension.ToLowerInvariant() } |
        ForEach-Object { $_.FullName })
}

# --- main -------------------------------------------------------------------

$signTool = Get-SignToolPath
if (-not $signTool) { throw 'signtool.exe не найден (нужен Windows SDK).' }
$pwd = Resolve-Password -Explicit $Password
$pfx = $PfxPath
if (-not $pfx -and $env:CSC_LINK) {
    # CSC_LINK electron-builder принимает как base64 PFX — раскодим его во временный
    # файл, чтобы и electron-builder, и наша проверка работали с одним и тем же ключом.
    #
    # Значение чистим: пайп PowerShell (например `Get-Content ... | gh secret set`)
    # добавляет UTF-8 BOM и перевод строки, и тогда base64 не распознаётся — сборка
    # падала с невнятным «файл не найден: <замаскированное значение>». Снимаем BOM и
    # крайние пробелы сами, а чистые кладём обратно в $env — electron-builder в этом же
    # шаге увидит то же значение.
    $link = ($env:CSC_LINK -replace '^[\uFEFF]+', '').Trim()
    if ($link -match '^[A-Za-z0-9+/=\s]+$' -and $link.Length -gt 100) {
        # RUNNER_TEMP есть только в GitHub Actions; локально берём TEMP.
        $tmpRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
        if (-not $tmpRoot) { $tmpRoot = [System.IO.Path]::GetTempPath() }
        $pfx = Join-Path $tmpRoot 'matrica-csc.pfx'
        [System.IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String(($link -replace '\s', '')))
        $env:CSC_LINK = $link
    } elseif ($link -match '\.pfx$') {
        # Явный путь к файлу — оставляем как есть.
        $pfx = $link
    } else {
        throw 'CSC_LINK не похож ни на base64-PFX, ни на путь к .pfx. Чаще всего значение попало в секрет с BOM или переводом строки (пайп PowerShell) — перезапишите секрет без них.'
    }
}

switch ($Mode) {

    'Electron' {
        # electron-builder подписывает сам (CSC_LINK + win.signDlls + win.signExts).
        # Здесь только ПРЕДПРОВЕРКА ключа: без неё битый PFX роняет сборку внутри
        # signUsingSigntool сообщением про «невозможность извлечь издателя».
        if (-not $env:CSC_LINK) {
            Write-Warn2 'CSC_LINK не задан — релиз выйдет НЕПОДПИСАННЫМ. Это не ошибка: парк не должен остаться без релизов из-за отсутствия ключа.'
            $res = @{ Mode = 'Electron'; Signed = $false; Reason = 'CSC_LINK не задан' }
            if ($Json) { $res | ConvertTo-Json -Depth 4 }
            break
        }
        $check = Test-PfxUsable -PfxFile $pfx -Pwd $pwd
        if (-not $check.Ok) {
            throw "Сертификат подписи непригоден: $($check.Reason). Сборка остановлена — выпускать релиз с непонятной подписью хуже, чем не выпускать."
        }
        Write-Info "Сертификат пригоден: $($check.Subject) (отпечаток $($check.Thumbprint))"
        $res = @{ Mode = 'Electron'; Signed = $true; Thumbprint = $check.Thumbprint; Subject = $check.Subject }
        if ($Json) { $res | ConvertTo-Json -Depth 4 }
    }

    'Watchdog' {
        # Сторожа electron-builder не подписывает: он собран ДО него и кладётся
        # в extraResources как готовый файл. Подписываем отдельно.
        if (-not $Target) { throw 'Нужен -Target (путь к бинарю сторожа).' }
        if (-not $env:CSC_LINK) {
            Write-Warn2 'CSC_LINK не задан — сторож останется неподписанным.'
            $res = @{ Mode = 'Watchdog'; Signed = $false; Reason = 'CSC_LINK не задан' }
            if ($Json) { $res | ConvertTo-Json -Depth 4 }
            break
        }
        $check = Test-PfxUsable -PfxFile $pfx -Pwd $pwd
        if (-not $check.Ok) { throw "Сертификат подписи непригоден: $($check.Reason)" }

        $files = Get-SignTargets -Path $Target -Extensions @('.exe')
        $signed = @()
        foreach ($f in $files) {
            $out = & $signTool sign /f $pfx /p $pwd /fd sha256 /tr $TimestampUrl /td sha256 $f 2>&1 | Out-String
            if ($LASTEXITCODE -ne 0) {
                throw "Не удалось подписать $f : $out"
            }
            $signed += $f
        }
        Write-Info "Подписано файлов: $($signed.Count)"
        $res = @{ Mode = 'Watchdog'; Signed = $true; Count = $signed.Count; Thumbprint = $check.Thumbprint }
        if ($Json) { $res | ConvertTo-Json -Depth 4 }
    }

    'Verify' {
        if (-not $ReleaseDir) { throw 'Нужен -ReleaseDir.' }
        $expectSigned = $RequireSigned -or [bool]$env:CSC_LINK
        $targets = Get-SignTargets -Path $ReleaseDir -Extensions @('.exe', '.dll', '.node')
        if (@($targets).Count -eq 0) { throw "В $ReleaseDir не найдено ни одного .exe/.dll/.node" }

        # Отпечаток нашего CA: без него отличить «подписан нами» от «подписан
        # Microsoft» нельзя — признак «MatricaRMZ» в Subject не годится (тема
        # сертификата задаётся владельцем, а проверка должна идти по отпечатку).
        $ourThumb = ''
        if ($pfx -and (Test-Path -LiteralPath $pfx)) {
            try { $ourThumb = (New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($pfx, $pwd)).Thumbprint } catch { $ourThumb = '' }
        }

        $rows = foreach ($f in $targets) {
            $info = Get-EmbeddedSigner -File $f -SignTool $signTool -OurThumbprint $ourThumb
            [pscustomobject]@{
                File = $f
                Signed = [bool]$info.Signed
                Ours = [bool]$info.Ours
                Signer = [string]$info.Subject
            }
        }

        $unsigned = @($rows | Where-Object { -not $_.Signed })
        # «Не наш» — подписан, но нашим ключом не подписан. Когда ключа нет вовсе,
        # считать чужими всё подписанное бессмысленно, поэтому при отсутствии
        # отпечатка проверка чужих подписей не выполняется.
        $foreign = if ($ourThumb) { @($rows | Where-Object { $_.Signed -and -not $_.Ours }) } else { @() }

        foreach ($u in $unsigned) { Write-Warn2 "НЕ ПОДПИСАН: $($u.File)" }
        foreach ($f2 in $foreign) { Write-Warn2 "подписан не нашим ключом: $($f2.File) — $($f2.Signer)" }

        $summary = @{
            Mode = 'Verify'
            Total = @($rows).Count
            Signed = (@($rows).Count - @($unsigned).Count)
            Unsigned = @($unsigned).Count
            Foreign = @($foreign).Count
            Files = $rows
        }
        if ($Json) { $summary | ConvertTo-Json -Depth 5 }

        if ($expectSigned -and @($unsigned).Count -gt 0) {
            throw "Ожидалась подпись всех артефактов, но неподписанных: $(@($unsigned).Count). Список — выше."
        }
        if ($expectSigned -and @($foreign).Count -gt 0) {
            throw "Часть артефактов подписана не нашим ключом: $(@($foreign).Count)."
        }
        if (-not $expectSigned) {
            Write-Info "CSC_LINK не задан — подпись не проверялась как обязательная. Проверено файлов: $(@($rows).Count), подписано: $($summary.Signed)."
        } else {
            Write-Info "Проверено файлов: $(@($rows).Count), подписано: $($summary.Signed)."
        }
    }
}
