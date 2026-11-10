# Опрос состояния корня доверия Матрицы на машине — ТОЛЬКО ЧТЕНИЕ.
#
# Ничего не меняет: проверяет, есть ли корень в хранилищах сертификатов, и подписан ли
# текущий исполняемый файл нашим ключом. Отдаёт JSON — его читает клиент (electron-app),
# человек может запустить и посмотреть глазами.
#
# Запуск:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\signing\trust-root-probe.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\signing\trust-root-probe.ps1 -ExePath "C:\путь\MatricaRMZ.exe" -Human
#
# Почему через .NET X509Store, а не Get-ChildItem Cert:\...:
#   провайдер PowerShell для Cert: тянет за собой консоль и на больших хранилищах заметно
#   медленнее; .NET API — тот же, которым ставится корень (install-root-on-machine.ps1),
#   значит проверка и установка смотрят в ОДНО и то же хранилище.
#
# Отпечаток и Subject боевого корня зашиты запасом: на машине, где файла скрипта рядом нет,
# корень всё равно опознаётся по отпечатку.
param(
    # Какой файл проверять на подпись. Пусто — текущий процесс (для клиента это его EXE).
    [string]$ExePath = '',
    # Отпечаток корня Матрицы (SHA-1).
    [string]$Thumbprint = '7E2D335A418EF9292BA2868EED92F65E2650932D',
    # Subject корня — для вывода и для самопроверки, что нашёлся именно наш корень.
    [string]$RootSubject = 'CN=MatricaRMZ Root CA',
    # Человеческий вывод вместо JSON.
    [switch]$Human
)

$ErrorActionPreference = 'Stop'

# Хранилища, которые важны: машинные — их читает служба Касперского (от SYSTEM),
# пользовательские — из них Windows берёт доверие к подписи у этого пользователя.
$stores = @(
    @{ Location = 'LocalMachine'; Name = 'Root'; Label = 'Доверенные корневые центры (машинное)' },
    @{ Location = 'LocalMachine'; Name = 'Trust'; Label = 'Доверительные отношения в предприятии (машинное)' },
    @{ Location = 'CurrentUser'; Name = 'Root'; Label = 'Доверенные корневые центры (пользователь)' },
    @{ Location = 'CurrentUser'; Name = 'Trust'; Label = 'Доверительные отношения в предприятии (пользователь)' },
    @{ Location = 'CurrentUser'; Name = 'TrustedPublisher'; Label = 'Доверенные издатели (пользователь)' }
)

function Test-CertInStore {
    param([string]$Location, [string]$Name, [string]$Want)
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($Name, $Location)
    try {
        $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
        $found = $null
        foreach ($c in $store.Certificates) {
            if ($c.Thumbprint -eq $Want) { $found = $c; break }
        }
        return $found
    } catch {
        return $null
    } finally {
        try { $store.Close() } catch { }
    }
}

# ── Хранилища ─────────────────────────────────────────────────────────────────
$storeResults = @()
foreach ($s in $stores) {
    $cert = Test-CertInStore -Location $s.Location -Name $s.Name -Want $Thumbprint
    $storeResults += [pscustomobject]@{
        location = $s.Location
        name     = $s.Name
        label    = $s.Label
        present  = ($null -ne $cert)
        subject  = $(if ($null -ne $cert) { $cert.Subject } else { $null })
    }
}

$machineTrusted = @($storeResults | Where-Object { $_.location -eq 'LocalMachine' -and $_.name -in @('Root', 'Trust') -and $_.present }).Count -gt 0
$userTrusted = @($storeResults | Where-Object { $_.location -eq 'CurrentUser' -and $_.name -in @('Root', 'Trust') -and $_.present }).Count -gt 0

# ── Подпись исполняемого файла ───────────────────────────────────────────────
$signed = $false
$signerSubject = $null
$signerIssuer = $null
$chainHasMatrica = $false
$chainTrusted = $false
$chainStatus = @()

$target = $ExePath
if ([string]::IsNullOrWhiteSpace($target)) { $target = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName }

if ($target -and (Test-Path -LiteralPath $target)) {
    try {
        # CreateFromSignedFile читает ИМЕННО встроенную подпись файла (не каталог Windows) —
        # в отличие от Get-AuthenticodeSignature, который берёт подпись из каталога подписей
        # и на переименованном файле показывает чужого издателя (ADR-0003, замер 5).
        $leaf = [System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($target)
        $signed = $true
        $signerSubject = $leaf.Subject
        $signerIssuer = $leaf.Issuer
        $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
        # Проверку отзыва выключаем: она ходит в сеть и на машине парка без интернета
        # виснет на минуты. Для нашей цепи (корень → наш ключ → файл) она ничего не даёт.
        $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
        # Неизвестный корень не роняет проверку: корень может быть ещё не установлен —
        # и это ровно то состояние, которое мы хотим увидеть и показать.
        $chain.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::AllowUnknownCertificateAuthority
        $built = $chain.Build($leaf)
        $chainStatus = @($chain.ChainStatus | ForEach-Object { $_.Status.ToString() })
        $chainHasMatrica = @($chain.ChainElements | Where-Object { $_.Certificate.Thumbprint -eq $Thumbprint }).Count -gt 0
        # Доверена цепочка или нет — по флагам, а не по $built: с AllowUnknownCertificateAuthority
        # Build возвращает true и при недоверенном корне.
        $untrusted = $chainStatus -contains 'UntrustedRoot'
        $chainTrusted = ($built -and -not $untrusted)
    } catch {
        # Файл без встроенной подписи — это не ошибка опроса, а ответ «не подписан».
        $signed = $false
    }
}

$result = [pscustomobject]@{
    thumbprint            = $Thumbprint
    rootSubject           = $RootSubject
    exePath               = $target
    stores                = $storeResults
    machineTrusted        = $machineTrusted
    userTrusted           = $userTrusted
    executableSigned      = $signed
    signatureChainToMatrica = $chainHasMatrica
    signatureTrusted      = $chainTrusted
    signerSubject         = $signerSubject
    signerIssuer          = $signerIssuer
    chainStatus           = $chainStatus
}

if ($Human) {
    Write-Host "Корень: $RootSubject ($Thumbprint)"
    foreach ($s in $storeResults) {
        $mark = if ($s.present) { 'ЕСТЬ' } else { 'нет ' }
        Write-Host ("  [{0}] Cert:\{1}\{2} — {3}" -f $mark, $s.location, $s.name, $s.label)
    }
    Write-Host ("Машинное хранилище: " + $(if ($machineTrusted) { 'корень есть' } else { 'корня НЕТ' }))
    Write-Host ("Хранилище пользователя: " + $(if ($userTrusted) { 'корень есть' } else { 'корня НЕТ' }))
    Write-Host ("Файл: $target")
    Write-Host ("Подписан: " + $(if ($signed) { 'да' } else { 'нет' }) + $(if ($signed) { " ($signerSubject)" } else { '' }))
    Write-Host ("Цепочка ведёт к нашему корню: " + $(if ($chainHasMatrica) { 'да' } else { 'нет' }))
    Write-Host ("Цепочка доверена системой: " + $(if ($chainTrusted) { 'да' } else { 'нет' }))
    if ($chainStatus.Count -gt 0) { Write-Host ("  флаги: " + ($chainStatus -join ', ')) }
} else {
    # JSON без BOM и без лишнего вывода — читает клиент.
    $json = $result | ConvertTo-Json -Depth 6 -Compress
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    Write-Output $json
}
