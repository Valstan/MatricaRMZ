# kaspersky-matrica.ps1 — настройка Касперского под «Матрица РМЗ» (2026-08-26)
#
# Что делает: находит на ЭТОМ компьютере Касперского, клиент Матрицы, сторож (watchdog)
# и адрес прод-сервера; печатает/показывает ГОТОВЫЕ строки для внесения в Касперский,
# рендерит инструкцию под реальные пути и умеет штатный экспорт/импорт настроек
# Касперского (avp.com EXPORT/IMPORT) — единственный поддерживаемый способ перенести
# конфигурацию на другие компьютеры.
#
# ЧЕГО ОН НАМЕРЕННО НЕ ДЕЛАЕТ (и не может — это факт продукта, а не лень автора):
#   * не добавляет исключения молча. У потребительского Касперского НЕТ команды
#     «добавить исключение» — ни CLI, ни реестра, ни файла конфигурации;
#   * не пытается «переписать настройки, пока защита выключена»: Самозащита Касперского
#     — отдельный механизм, она НЕ выключается вместе с защитой в реальном времени и
#     блокирует правку своих файлов/реестра извне в любом состоянии защиты.
#   Проверено на Kaspersky Standard 21.26: `avp.com HELP` → есть EXPORT/IMPORT,
#   команд EXCLUSION/TRUSTED/ADD нет.
#
# Кроме готовых строк он раскладывает их в ДВА файла ровно того формата, который
# Касперский принимает кнопкой «Импорт» на своих экранах списков (см. раздел
# «Файлы импорта» ниже), — чтобы не вбивать строки руками по одной.
#
# Режимы:
#   kaspersky-matrica.ps1                    — окно с готовыми строками + файлы импорта + инструкция
#   kaspersky-matrica.ps1 -Quiet             — то же в консоль, без окна
#   kaspersky-matrica.ps1 -Json              — машинный вывод (для встраивания в Матрицу)
#   kaspersky-matrica.ps1 -Verify            — проверка состояния (что цело, что пропало)
#   kaspersky-matrica.ps1 -Export <файл.cfg> — сохранить эталон настроек Касперского
#   kaspersky-matrica.ps1 -Import <файл.cfg> — применить эталон на этом компьютере
#   -SettingsPassword <пароль>               — если в Касперском стоит пароль на настройки
#   -ImportDir <папка>                       — куда положить файлы импорта (по умолчанию
#                                              %LOCALAPPDATA%\kaspersky-matrica)
#   -MergeExclusions <файл.csv>              — влить в файл исключений строки из твоего
#   -MergeTrusted <файл.xml>                   прежнего экспорта Касперского (см. ниже)
#
# Файлы импорта. У Касперского на экране «Исключения и действия при обнаружении угроз»
# обе кнопки списков умеют Экспорт/Импорт: «Управление исключениями» → *.csv,
# «Указать доверенные программы» → *.xml. Оба файла, несмотря на расширения, — текст
# UTF-16LE с BOM и переводами строк CRLF, поля через точку с запятой:
#   исключения:            1;<путь>;<вердикт>;<область>;1;0;1;<комментарий>;1
#   доверенные программы:  1;<путь>;
# Папка в пути исключения обязана заканчиваться обратной косой чертой, файл — нет.
# Формат снят побайтово с живого экспорта Kaspersky Standard 21.26 (2026-08-27).
#
# ⚠ Импорт вносит в список содержимое файла. Прежде чем импортировать, выгрузи текущий
# список кнопкой «Экспорт» рядом — тогда у тебя есть и точка возврата, и файл для
# -MergeExclusions / -MergeTrusted: с ними сгенерированный файл гарантированно
# СОДЕРЖИТ твои прежние строки, и «заменит ли импорт список целиком» перестаёт быть
# вопросом.
#
# Запуск: Запустить.cmd (или powershell -sta -ep bypass -file kaspersky-matrica.ps1)
[CmdletBinding()]
param(
    [switch]$Quiet,
    [switch]$Json,
    [switch]$Verify,
    [string]$Export,
    [string]$Import,
    [string]$SettingsPassword,
    [string]$Report,
    [string]$ImportDir,
    [string]$MergeExclusions,
    [string]$MergeTrusted
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# Запасной адрес: берётся, только если рукопожатие клиента недоступно. Тот же дефолт,
# что зашит в самом клиенте (electron-app/src/main/index.ts: MATRICA_API_URL ?? …).
$DefaultApiBaseUrl = 'https://a6fd55b8e0ae.vps.myjino.ru'
# IP НАМЕРЕННО не зашит: он определяется DNS-запросом по имени хоста в момент запуска.
# Причина не косметическая — репозиторий публичный, а IP-литерал прод-сервера это
# recon-деталь (правило D-038 портфеля: адреса в тексты публичных репо не кладём).
# Побочная польза: при переезде сервера инструмент не врёт устаревшим адресом.
$KnownProdIps      = @()

# --------------------------------------------------------------------------------------
# Утилиты
# --------------------------------------------------------------------------------------

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-FirstExistingPath {
    param([string[]]$Candidates)
    foreach ($c in $Candidates) {
        if ([string]::IsNullOrWhiteSpace($c)) { continue }
        if (Test-Path -LiteralPath $c) { return $c }
    }
    ''
}

function ConvertTo-WinPath {
    # Приложение отдаёт userData как ...\Roaming\@matricarmz/electron-app — прямой слэш
    # приходит из имени пакета. Windows такой путь откроет, а Касперский сверяет строку
    # исключения текстом: со слэшем правило молча не совпадёт. Плюс схлопываем путь к
    # родителю-вендору (@matricarmz), чтобы одно исключение накрыло и electron-app, и
    # его CDP-двойники (electron-app-cdp-9222), которые плодит смоук.
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    $p = $Path.Replace('/', '\').TrimEnd('\')
    $parent = Split-Path -Parent $p
    if ($parent -and (Split-Path -Leaf $parent).StartsWith('@')) { return $parent }
    $p
}

function ConvertTo-UserMask {
    # C:\Users\<имя>\AppData\Local\... -> C:\Users\*\AppData\Local\...
    # Маска нужна, чтобы одно исключение подходило любому пользователю на любом компе.
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    $profileRoot = Split-Path -Parent $env:USERPROFILE   # обычно C:\Users
    $leaf = Split-Path -Leaf $env:USERPROFILE            # имя пользователя
    if ($Path -like "$env:USERPROFILE*") {
        return ($profileRoot + '\*' + $Path.Substring($env:USERPROFILE.Length))
    }
    $Path -replace [regex]::Escape("\$leaf\"), '\*\'
}

function ConvertTo-FullPath {
    # PowerShell и .NET считают «текущей папкой» РАЗНОЕ: Test-Path идёт от расположения
    # провайдера PowerShell, а [System.IO.File] — от рабочего каталога процесса. Они
    # расходятся сплошь и рядом, и относительный путь из-за этого проходит проверку
    # «файл есть», а потом падает на чтении — вместе со всей выдачей файлов импорта.
    # Поэтому любой путь, пришедший ключом, разворачиваем в абсолютный один раз.
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    try { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path) }
    catch { $Path }
}

function Test-ContainsPath {
    # Сравнение регистронезависимое и без хвостовой косой черты: Windows так и сравнивает
    # пути, а Касперский показал бы две одинаковые строки двумя строками списка.
    param([string[]]$List, [string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $true }
    $p = $Path.Replace('/', '\').TrimEnd('\')
    foreach ($existing in @($List)) {
        if ($existing -and ($existing.Replace('/', '\').TrimEnd('\') -ieq $p)) { return $true }
    }
    $false
}

function Add-UniquePath {
    param([string[]]$List, [string]$Path)
    if (Test-ContainsPath -List $List -Path $Path) { return @($List) }
    @($List) + ($Path.Replace('/', '\').TrimEnd('\'))
}

# --------------------------------------------------------------------------------------
# Обнаружение: рабочие папки этого компьютера (репозитории, Яндекс-диск)
# --------------------------------------------------------------------------------------

function Test-CanBeExcludedWholesale {
    # Отсекает пути, которые нельзя отдавать под исключение целиком: корень диска,
    # профиль пользователя, системные каталоги. Ошибка здесь дорогая: исключение
    # «D:\» или «C:\Users\Вася» снимает защиту с половины компьютера, а выглядит в
    # окне Касперского такой же безобидной строкой, как папка с репозиториями.
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $full = $Path.TrimEnd('\')
    $root = ([System.IO.Path]::GetPathRoot($full)).TrimEnd('\')
    if (-not $root -or ($full -ieq $root)) { return $false }
    $forbidden = @(
        $env:USERPROFILE, (Split-Path -Parent $env:USERPROFILE), $env:SystemRoot,
        $env:ProgramData, $env:ProgramFiles, ${env:ProgramFiles(x86)},
        $env:APPDATA, $env:LOCALAPPDATA, (Split-Path -Parent $env:LOCALAPPDATA)
    )
    # Папки общего назначения. В них лежит всё подряд — в том числе то, ради чего
    # антивирус и держат, — поэтому целиком они не исключаются, даже если внутри
    # действительно нашлись клоны репозиториев. Пути спрашиваем у Windows: рабочий стол
    # и документы часто перенесены на другой диск, и захардкоженный путь их не узнает.
    foreach ($known in @('Desktop', 'MyDocuments', 'MyPictures', 'MyVideos', 'MyMusic')) {
        try { $forbidden += [Environment]::GetFolderPath($known) } catch { }
    }
    # У «Загрузок» нет своего значения в перечислении .NET 4 — только идентификатор
    # известной папки в реестре; запасной вариант учитывает и его отсутствие.
    try {
        $shell = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders' -ErrorAction SilentlyContinue
        if ($shell -and $shell.PSObject.Properties['{374DE290-123F-4565-9164-39C4925E467B}']) {
            $forbidden += [string]$shell.'{374DE290-123F-4565-9164-39C4925E467B}'
        }
    } catch { }
    if ($env:USERPROFILE) { $forbidden += (Join-Path $env:USERPROFILE 'Downloads') }
    foreach ($f in $forbidden) {
        if ($f -and ($full -ieq $f.TrimEnd('\'))) { return $false }
    }
    $true
}

function Get-GitRepoChildCount {
    param([string]$Path)
    @(Get-ChildItem -LiteralPath $Path -Directory -Force -ErrorAction SilentlyContinue |
      Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName '.git') }).Count
}

function Get-SearchBases {
    # Фиксированные диски + профиль. Сетевые и съёмные диски НЕ трогаем: обход сетевой
    # шары вешает скрипт на минуты, а исключение на сетевой путь бессмысленно.
    $bases = @()
    foreach ($d in [System.IO.DriveInfo]::GetDrives()) {
        try {
            if ($d.DriveType -eq 'Fixed' -and $d.IsReady) { $bases += $d.RootDirectory.FullName }
        } catch { }
    }
    if ($env:USERPROFILE) {
        $bases += $env:USERPROFILE
        $bases += (Join-Path $env:USERPROFILE 'Documents')
    }
    # Без «,$bases»: у этой функции результат либо присваивают, либо оборачивают @().
    # Запятая-обёртка в конвейере разворачивается в ОДИН элемент-массив, и вызывающий
    # получает один объект вместо списка — поймано собственным тестом.
    $bases
}

function Resolve-RepoExclusionTarget {
    # Клон найден — что именно отдавать под исключение: папку-родителя или сам клон.
    #
    # Родителя — только если это ДЕЙСТВИТЕЛЬНО папка с репозиториями: кроме нашего в ней
    # есть хотя бы ещё один клон. Прежняя проверка «хотя бы один» была тавтологией — наш
    # собственный клон и есть тот самый git-потомок, — поэтому «папкой с репозиториями»
    # объявлялись Загрузки или Рабочий стол, если клон положили туда, и в файл импорта
    # уходила строка на всю эту папку.
    param([string]$RepoPath)
    if ([string]::IsNullOrWhiteSpace($RepoPath)) { return '' }
    $parent = Split-Path -Parent $RepoPath
    if ((Test-CanBeExcludedWholesale $parent) -and ((Get-GitRepoChildCount $parent) -ge 2)) {
        return $parent.TrimEnd('\')
    }
    # Иначе — только сам клон: node_modules и dist лежат в нём, этого достаточно.
    # Гейт нужен и здесь: домашний каталог сам может быть репозиторием (файлы настроек
    # держат в git), и тогда «клоном» оказывается весь профиль пользователя.
    if (Test-CanBeExcludedWholesale $RepoPath) { return $RepoPath.TrimEnd('\') }
    ''
}

function Get-RepoEcosystemCandidates {
    # Возвращает пары «папка → сколько клонов внутри». Порядок поиска — от дешёвого к
    # дорогому: сначала известные имена, потом папки первого уровня на дисках.
    # Второй проход нужен ровно для случая «репозитории лежат в папке с необычным именем
    # на другом диске»: без него такая папка не находится вовсе.
    param([string[]]$SearchBases)
    $names = @('PROGRAMMING', 'GitHubReps', 'GitHub', 'Repos', 'Projects', 'Dev', 'src', 'source\repos')
    # Системные каталоги не обходим: клонов там не бывает, а подкаталогов тысячи.
    $skip = @('Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'Users',
              'PerfLogs', 'Recovery', 'Config.Msi', 'System Volume Information', '$Recycle.Bin',
              'AppData', 'OneDrive')
    $found = @()
    $seen = @()

    foreach ($b in @($SearchBases)) {
        foreach ($n in $names) {
            if ([string]::IsNullOrWhiteSpace($b)) { continue }
            $candidate = Join-Path $b $n
            if (Test-ContainsPath -List $seen -Path $candidate) { continue }
            if (-not (Test-CanBeExcludedWholesale $candidate)) { continue }
            $seen = Add-UniquePath -List $seen -Path $candidate
            $count = Get-GitRepoChildCount $candidate
            if ($count -ge 2) { $found += [pscustomobject]@{ Path = $candidate.TrimEnd('\'); RepoCount = $count } }
        }
    }

    foreach ($b in @($SearchBases)) {
        if ([string]::IsNullOrWhiteSpace($b) -or -not (Test-Path -LiteralPath $b)) { continue }
        foreach ($dir in @(Get-ChildItem -LiteralPath $b -Directory -Force -ErrorAction SilentlyContinue)) {
            if ($skip -contains $dir.Name) { continue }
            if ($dir.Name.StartsWith('$') -or $dir.Name.StartsWith('.')) { continue }
            if (Test-ContainsPath -List $seen -Path $dir.FullName) { continue }
            if (-not (Test-CanBeExcludedWholesale $dir.FullName)) { continue }
            $seen = Add-UniquePath -List $seen -Path $dir.FullName
            $count = Get-GitRepoChildCount $dir.FullName
            if ($count -ge 2) { $found += [pscustomobject]@{ Path = $dir.FullName.TrimEnd('\'); RepoCount = $count } }
        }
    }
    # Поле называется RepoCount, а не Count: у PowerShell «Count» есть у КАЖДОГО объекта
    # (встроенное, равно 1 у одиночного), и оно перебивает своё же свойство — сортировка
    # по «Count» тогда молча сравнивает единицы с единицами. Тоже поймано тестом.
    $found
}

function Get-RepoEcosystemRoot {
    # Папка, в которой лежат клоны наших репозиториев. Сборка гоняет тысячи файлов в
    # node_modules и dist; антивирус проверяет каждый и заодно принимает свежий
    # неподписанный .exe за угрозу — поэтому исключается вся папка целиком.
    #
    # Первый и главный источник — расположение самого скрипта: он лежит внутри клона,
    # значит соседи клона и есть экосистема. Это работает при любом расположении папки,
    # на любом диске и с любым именем — искать ничего не нужно. Поиск по дискам ниже
    # нужен только копии скрипта, унесённой от клонов.
    param([string[]]$SearchBases)
    $dir = $PSScriptRoot
    $repo = ''
    while ($dir) {
        if (Test-Path -LiteralPath (Join-Path $dir '.git')) { $repo = $dir; break }
        $parent = Split-Path -Parent $dir
        if (-not $parent -or ($parent -ieq $dir)) { break }
        $dir = $parent
    }
    if ($repo) { return Resolve-RepoExclusionTarget -RepoPath $repo }

    if (-not $SearchBases) { $SearchBases = Get-SearchBases }
    # Два клона и больше: одна случайная папка с именем «src» экосистемой не является.
    # Если подходящих папок несколько — берём самую населённую, а не первую попавшуюся:
    # первая зависит от буквы диска, населённость — от сути.
    $candidates = @(Get-RepoEcosystemCandidates -SearchBases $SearchBases)
    if ($candidates.Count -eq 0) { return '' }
    $best = $candidates | Sort-Object -Property RepoCount -Descending | Select-Object -First 1
    if ($best) { return [string]$best.Path }
    ''
}

function Get-YandexDiskRoot {
    # Только реестр. Проверка «есть ли внутри скрытая .sync» кажется надёжной, но на
    # реальной машине ей соответствуют ДВЕ папки: рабочая D:\YandexDisk и брошенная
    # C:\Users\<имя>\YandexDisk от прежней установки — у обеих .sync на месте.
    # Поэтому известных путей на диске не перебираем: нет ключа реестра — считаем,
    # что Яндекс-диска на компьютере нет, и молчим вместо того, чтобы угадать не ту.
    foreach ($key in @('HKCU:\Software\Yandex\Yandex.Disk.2', 'HKCU:\Software\Yandex\Yandex.Disk')) {
        $props = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
        if (-not $props) { continue }
        # Через тот же гейт, что и всё остальное: пользователь волен назначить корнем
        # синхронизации хоть «D:\», хоть свой профиль — реестр это честно вернёт, а
        # исключение на весь диск в файле импорта выглядит такой же обычной строкой.
        if ($props.PSObject.Properties['RootFolder']) {
            $p = [string]$props.RootFolder
            if ($p -and (Test-CanBeExcludedWholesale $p)) { return $p.TrimEnd('\') }
        }
        # Запасной ключ старой версии: корень не хранится, но папка загрузок лежит внутри него.
        if ($props.PSObject.Properties['DownloadsPath']) {
            $dl = [string]$props.DownloadsPath
            if ($dl) {
                $p = Split-Path -Parent $dl.TrimEnd('\')
                if ($p -and (Test-Path -LiteralPath $p) -and (Test-CanBeExcludedWholesale $p)) {
                    return $p.TrimEnd('\')
                }
            }
        }
    }
    ''
}

function Get-WorkFolders {
    # Папки, которые к Матрице отношения не имеют, но на этом компьютере тормозят из-за
    # проверки: свои репозитории и облачная папка. Показываются отдельным разделом —
    # решение вносить их принимает владелец компьютера, а не инструмент.
    $items = @()
    $repos = Get-RepoEcosystemRoot
    if ($repos) {
        $items += [pscustomobject]@{
            Path  = $repos
            Title = 'Папка с репозиториями (сборка, node_modules, свежие .exe)'
        }
    }
    $yandex = Get-YandexDiskRoot
    if ($yandex) {
        $items += [pscustomobject]@{
            Path  = $yandex
            Title = 'Папка Яндекс-диска (постоянная синхронизация)'
        }
    }
    ,$items
}

# --------------------------------------------------------------------------------------
# Обнаружение: Касперский
# --------------------------------------------------------------------------------------

function Get-KasperskyInfo {
    $result = [ordered]@{
        Found = $false; Name = ''; Version = ''; InstallDir = ''; AvpCom = ''
        Running = $false; Edition = ''
    }
    $uninstallRoots = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    $entry = $null
    foreach ($root in $uninstallRoots) {
        $found = Get-ItemProperty -Path $root -ErrorAction SilentlyContinue |
                 Where-Object { $_.PSObject.Properties['DisplayName'] -and
                                $_.DisplayName -match 'Kaspersky|Касперск' } |
                 Select-Object -First 1
        if ($found) { $entry = $found; break }
    }
    if ($entry) {
        $result.Found   = $true
        $result.Name    = [string]$entry.DisplayName
        if ($entry.PSObject.Properties['DisplayVersion']) { $result.Version = [string]$entry.DisplayVersion }
        if ($entry.PSObject.Properties['InstallLocation']) { $result.InstallDir = [string]$entry.InstallLocation }
    }

    # Точная редакция и корень продукта — из ветки продукта (надёжнее Uninstall).
    foreach ($base in @('HKLM:\SOFTWARE\WOW6432Node\KasperskyLab', 'HKLM:\SOFTWARE\KasperskyLab')) {
        $avpKeys = Get-ChildItem -Path $base -ErrorAction SilentlyContinue |
                   Where-Object { $_.PSChildName -like 'AVP*' }
        foreach ($k in $avpKeys) {
            $env_ = Get-ItemProperty -Path (Join-Path $k.PSPath 'environment') -ErrorAction SilentlyContinue
            if ($env_) {
                if ($env_.PSObject.Properties['ProductName'])    { $result.Edition = [string]$env_.ProductName }
                if ($env_.PSObject.Properties['ProductVersion'] -and -not $result.Version) {
                    $result.Version = [string]$env_.ProductVersion
                }
                if ($env_.PSObject.Properties['ProductRoot'] -and (Test-Path -LiteralPath ([string]$env_.ProductRoot))) {
                    $result.InstallDir = [string]$env_.ProductRoot
                    $result.Found = $true
                }
            }
        }
    }

    if ($result.InstallDir) {
        $candidate = Join-Path $result.InstallDir 'avp.com'
        if (Test-Path -LiteralPath $candidate) { $result.AvpCom = $candidate }
    }
    if (-not $result.AvpCom) {
        foreach ($root in @("${env:ProgramFiles(x86)}\Kaspersky Lab", "$env:ProgramFiles\Kaspersky Lab")) {
            if (-not (Test-Path -LiteralPath $root)) { continue }
            $hit = Get-ChildItem -Path $root -Recurse -Filter 'avp.com' -ErrorAction SilentlyContinue |
                   Select-Object -First 1
            if ($hit) { $result.AvpCom = $hit.FullName; $result.Found = $true; break }
        }
    }
    $result.Running = [bool](Get-Process -Name 'avp' -ErrorAction SilentlyContinue)
    [pscustomobject]$result
}

# --------------------------------------------------------------------------------------
# Обнаружение: Матрица РМЗ, сторож, прод-адрес
# --------------------------------------------------------------------------------------

function Get-MatricaInfo {
    $localAppData = $env:LOCALAPPDATA
    $appData      = $env:APPDATA
    $info = [ordered]@{
        HandshakeFound = $false; HandshakePath = ''; HandshakeAgeHours = $null
        AppExe = ''; AppDir = ''; AppVersion = ''
        WatchdogExe = ''; WatchdogDir = ''
        DataDir = ''; UserDataDir = ''; UpdatesDir = ''
        UpdaterCacheDir = ''; LegacyDataDir = ''; DesktopDir = ''
        Shortcuts = @(); ExtraExes = @()
        ApiBaseUrl = ''; ApiHost = ''; ApiIps = @()
        Tasks = @(); LogonShortcut = $null; Source = ''
    }

    # 1) Источник истины — рукопожатие, которое пишет само приложение.
    $hsPath = Join-Path (Join-Path $appData 'MatricaRMZ') 'watchdog.json'
    $info.HandshakePath = $hsPath
    if (Test-Path -LiteralPath $hsPath) {
        try {
            $hs = Get-Content -LiteralPath $hsPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $info.HandshakeFound = $true
            $info.Source = 'handshake'
            foreach ($pair in @(
                @('appExePath', 'AppExe'), @('userDataDir', 'UserDataDir'),
                @('updatesRootDir', 'UpdatesDir'), @('apiBaseUrl', 'ApiBaseUrl'),
                @('version', 'AppVersion'), @('desktopDir', 'DesktopDir'))) {
                if ($hs.PSObject.Properties[$pair[0]]) { $info[$pair[1]] = [string]$hs.($pair[0]) }
            }
            if ($hs.PSObject.Properties['updatedAtMs'] -and $hs.updatedAtMs) {
                $updated = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$hs.updatedAtMs).LocalDateTime
                $info.HandshakeAgeHours = [math]::Round(((Get-Date) - $updated).TotalHours, 1)
            }
        } catch {
            $info.HandshakeFound = $false
        }
    }

    # 2) Реестр (HKCU InstallLocation), 3) стандартные пути — если рукопожатия нет.
    if (-not $info.AppExe) {
        $regHit = Get-ItemProperty -Path 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
                  Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -match 'MatricaRMZ|Матрица' } |
                  Select-Object -First 1
        if ($regHit -and $regHit.PSObject.Properties['InstallLocation'] -and $regHit.InstallLocation) {
            $candidate = Join-Path ([string]$regHit.InstallLocation) 'MatricaRMZ.exe'
            if (Test-Path -LiteralPath $candidate) { $info.AppExe = $candidate; $info.Source = 'registry' }
        }
    }
    if (-not $info.AppExe) {
        $info.AppExe = Get-FirstExistingPath @(
            (Join-Path $localAppData 'Programs\MatricaRMZ\MatricaRMZ.exe'),
            (Join-Path $localAppData 'Programs\@matricarmzelectron-app\MatricaRMZ.exe')
        )
        if ($info.AppExe) { $info.Source = 'standard-path' }
    }
    if ($info.AppExe) { $info.AppDir = Split-Path -Parent $info.AppExe }

    # Сторож ставится приложением/инсталлятором в фиксированное место.
    $wdDir = Join-Path $localAppData 'Programs\MatricaRMZ-Watchdog'
    $wdExe = Join-Path $wdDir 'matricarmz-watchdog.exe'
    $info.WatchdogDir = $wdDir
    if (Test-Path -LiteralPath $wdExe) { $info.WatchdogExe = $wdExe }

    $dataDir = Join-Path $appData 'MatricaRMZ'
    if (Test-Path -LiteralPath $dataDir) { $info.DataDir = $dataDir } else { $info.DataDir = $dataDir }

    # Кэш автообновления (electron-updater). Имя папки собирается из имени пакета, а не
    # из отображаемого имени программы, поэтому оно выглядит как «@matricarmzelectron-app-updater»
    # и угадывать его по productName нельзя — ищем по образцу среди соседей.
    $updaterHit = Get-ChildItem -LiteralPath $localAppData -Directory -Force -ErrorAction SilentlyContinue |
                  Where-Object { $_.Name -like '*-updater' -and $_.Name -like '*matricarmz*' } |
                  Select-Object -First 1
    if ($updaterHit) { $info.UpdaterCacheDir = $updaterHit.FullName }

    # Хвост прежних версий: на части машин парка встречается ~\.matricarmz.
    $legacy = Join-Path $env:USERPROFILE '.matricarmz'
    if (Test-Path -LiteralPath $legacy) { $info.LegacyDataDir = $legacy }

    # Ярлыки. Рабочий стол может быть перенесён на другой диск — рукопожатие знает куда,
    # [Environment]::GetFolderPath это тоже учитывает; берём оба и складываем без дублей.
    if (-not $info.DesktopDir) { $info.DesktopDir = [Environment]::GetFolderPath('Desktop') }
    $shortcuts = @()
    $lnkDirs = @($info.DesktopDir, [Environment]::GetFolderPath('Desktop'),
                 [Environment]::GetFolderPath('CommonDesktopDirectory'),
                 [Environment]::GetFolderPath('Startup'))
    foreach ($d in $lnkDirs) {
        if (-not $d -or -not (Test-Path -LiteralPath $d)) { continue }
        foreach ($lnk in @(Get-ChildItem -LiteralPath $d -Filter '*atricaRMZ*.lnk' -Force -ErrorAction SilentlyContinue)) {
            $shortcuts = Add-UniquePath -List $shortcuts -Path $lnk.FullName
        }
    }
    $info.Shortcuts = @($shortcuts)

    # Исполняемые файлы, которые антивирус видит как «свежий неподписанный .exe»: копии
    # сторожа, скачанный установщик обновления и заглушка-обновлятор.
    $exes = @()
    $exeCandidates = @()
    if ($info.AppDir)  { $exeCandidates += (Join-Path $info.AppDir 'resources\matricarmz-watchdog.exe') }
    if ($info.DataDir) { $exeCandidates += (Join-Path $info.DataDir 'matricarmz-watchdog.exe') }
    foreach ($c in $exeCandidates) {
        if (Test-Path -LiteralPath $c) { $exes = Add-UniquePath -List $exes -Path $c }
    }
    foreach ($dir in @($info.UpdatesDir, $info.UpdaterCacheDir)) {
        if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
        foreach ($exe in @(Get-ChildItem -LiteralPath $dir -Filter '*.exe' -File -Force -ErrorAction SilentlyContinue)) {
            $exes = Add-UniquePath -List $exes -Path $exe.FullName
        }
    }
    $info.ExtraExes = @($exes)

    # Прод-адрес: из рукопожатия, иначе значение по умолчанию из кода клиента.
    if (-not $info.ApiBaseUrl) { $info.ApiBaseUrl = $DefaultApiBaseUrl }
    try {
        $uri = [Uri]$info.ApiBaseUrl
        $info.ApiHost = $uri.Host
    } catch { $info.ApiHost = '' }
    if ($info.ApiHost) {
        try {
            $info.ApiIps = @([System.Net.Dns]::GetHostAddresses($info.ApiHost) |
                Where-Object { $_.AddressFamily -eq 'InterNetwork' } |
                ForEach-Object { $_.IPAddressToString })
        } catch { $info.ApiIps = @() }
    }
    if (-not $info.ApiIps -or $info.ApiIps.Count -eq 0) { $info.ApiIps = $KnownProdIps }

    # Плановые задачи сторожа (их тоже сносил антивирусный свип — см. историю проекта).
    foreach ($taskName in @('MatricaRMZ\Watchdog Periodic')) {
        $exists = $false
        try {
            $null = & "$env:SystemRoot\System32\schtasks.exe" /Query /TN $taskName 2>$null
            $exists = ($LASTEXITCODE -eq 0)
        } catch { $exists = $false }
        $info.Tasks += [pscustomobject]@{ Name = $taskName; Exists = $exists }
    }

    # Автозапуск сторожа при входе. С релиза 3.13.0 это ярлык в папке автозагрузки,
    # а не плановая задача: schtasks.exe не умеет создать logon-задачу для текущего
    # пользователя без прав администратора (ONLOGON отвечает «Отказано в доступе»
    # и с ключом /RU тоже), поэтому задачи «MatricaRMZ\Watchdog Logon» не было ни на
    # одной машине парка. Клиент чинит этот ярлык сам при каждом запуске.
    $startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'MatricaRMZ Watchdog.lnk'
    $info.LogonShortcut = [pscustomobject]@{ Path = $startupLnk; Exists = (Test-Path -LiteralPath $startupLnk) }

    [pscustomobject]$info
}

# --------------------------------------------------------------------------------------
# Сборка плана настройки (что именно вносить в Касперский)
# --------------------------------------------------------------------------------------

function Get-ExclusionPlan {
    param($Matrica, $WorkFolders)
    # Ярлык в списке доверенных — не причуда: Касперский разбирает .lnk и переносит
    # доверие на цель, а запуск с рабочего стола идёт именно через него.
    $trusted = @()
    foreach ($exe in (@($Matrica.AppExe, $Matrica.WatchdogExe) + @($Matrica.ExtraExes) + @($Matrica.Shortcuts))) {
        if ($exe) { $trusted = Add-UniquePath -List $trusted -Path $exe }
    }
    # UserDataDir (база SQLite, логи, файл ключа) — самая пишущая папка приложения:
    # без неё исключения выглядят полными, а постоянное сканирование остаётся.
    # UpdaterCacheDir — туда качается установщик обновления, самое частое место, где
    # антивирус забирает файл прямо из-под обновлятора.
    $folders = @()
    foreach ($raw in @($Matrica.AppDir, $Matrica.WatchdogDir, $Matrica.DataDir,
                       $Matrica.UserDataDir, $Matrica.UpdatesDir,
                       $Matrica.UpdaterCacheDir, $Matrica.LegacyDataDir)) {
        $d = ConvertTo-WinPath $raw
        if ($d) { $folders = Add-UniquePath -List $folders -Path $d }
    }
    $masks = @()
    foreach ($d in $folders) {
        $m = ConvertTo-UserMask $d
        if ($m) { $masks = Add-UniquePath -List $masks -Path $m }
    }
    $work = @()
    foreach ($w in @($WorkFolders)) { if ($w) { $work += $w } }
    [pscustomobject]@{
        TrustedApps    = $trusted
        ExcludeFolders = $folders
        ExcludeFiles   = @($Matrica.Shortcuts)
        ExcludeMasks   = $masks
        WorkFolders    = $work
        NetworkHost    = $Matrica.ApiHost
        NetworkIps     = $Matrica.ApiIps
        NetworkPort    = 443
        TrustedFlags   = @(
            'Не проверять открываемые файлы',
            'Не контролировать активность программы',
            'Не наследовать ограничения родительского процесса',
            'Не контролировать активность дочерних программ',
            'Разрешить взаимодействие с интерфейсом программы',
            'Не проверять сетевой трафик'
        )
    }
}

# --------------------------------------------------------------------------------------
# Файлы импорта для Касперского
#
# Оба списка Касперский отдаёт и принимает одним и тем же текстовым форматом: UTF-16LE
# с BOM,CRLF, поля через точку с запятой. Формат снят побайтово с живого экспорта
# Kaspersky Standard 21.26 (2026-08-27) — не из документации, её на это нет.
# --------------------------------------------------------------------------------------

# Имена файлов живут параметрами Write-KasperskyImportFiles со значениями по умолчанию,
# а не переменными уровня скрипта: так функцию можно вызвать и проверить в отрыве от
# основного потока — приёмка иначе до неё не дотягивается.

function ConvertTo-ExclusionLine {
    # 1;<объект>;<вердикт>;<область>;1;0;1;<комментарий>;1
    # Звёздочки в 3-м и 4-м поле = «любая угроза, любой компонент защиты»: так Касперский
    # записывает исключение, добавленное вручную без уточнений.
    param([string]$Path, [switch]$IsFolder)
    $p = $Path.Replace('/', '\').TrimEnd('\')
    # Папка обязана заканчиваться косой чертой: без неё правило читается как файл без
    # расширения и молча не срабатывает на содержимом.
    if ($IsFolder) { $p = $p + '\' }
    "1;$p;*;*;1;0;1;;1"
}

function ConvertTo-TrustedLine {
    param([string]$Path)
    '1;' + $Path.Replace('/', '\').TrimEnd('\') + ';'
}

function Get-PathFromListLine {
    param([string]$Line)
    $parts = @($Line -split ';')
    if ($parts.Count -lt 2) { return '' }
    [string]$parts[1]
}

function Read-KasperskyListLines {
    # Читает прежний экспорт (для -MergeExclusions / -MergeTrusted). Кодировка определяется
    # по BOM самим ридером — у Касперского это UTF-16LE, но подстраховка ничего не стоит.
    param([string]$File)
    if ([string]::IsNullOrWhiteSpace($File)) { return @() }
    $full = ConvertTo-FullPath $File
    if (-not (Test-Path -LiteralPath $full)) { throw "Файл прежнего экспорта не найден: $File" }
    $text = [System.IO.File]::ReadAllText($full)
    @($text -split "`r?`n" | Where-Object { $_ -and $_.Trim() })
}

function Write-KasperskyListFile {
    param([string]$Path, [string[]]$Lines)
    $text = (@($Lines) -join "`r`n") + "`r`n"
    # Именно UTF-16LE с BOM. В UTF-8 Касперский файл не примет — точнее, примет и
    # покажет строки кракозябрами, что хуже отказа: правило будет, а совпадать не будет.
    $enc = New-Object System.Text.UnicodeEncoding($false, $true)
    [System.IO.File]::WriteAllText($Path, $text, $enc)
}

function Test-LooksLikeListLine {
    # Строка списка Касперского — это как минимум «флаг;объект». Строка без точки с
    # запятой списком не является: значит, подсунули не тот файл, и тащить её в импорт
    # нельзя. Всё остальное переносим, даже если разобрать не смогли.
    param([string]$Line)
    (@($Line -split ';').Count -ge 2)
}

function Write-KasperskyImportFiles {
    param(
        $Plan, [string]$Dir, [string]$MergeExclusionsFile, [string]$MergeTrustedFile,
        [string]$ExclusionFileName = 'Касперский-1-исключения.csv',
        [string]$TrustedFileName   = 'Касперский-2-доверенные-программы.xml'
    )

    if ([string]::IsNullOrWhiteSpace($Dir)) { $Dir = Join-Path $env:LOCALAPPDATA 'kaspersky-matrica' }
    $Dir = ConvertTo-FullPath $Dir
    if (-not (Test-Path -LiteralPath $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }

    # Строки прежнего экспорта переносим ДОСЛОВНО: в них могут стоять настройки, которых
    # мы не знаем (конкретный вердикт вместо звёздочки, свой комментарий). Наши строки
    # добавляются только для путей, которых там ещё нет.
    #
    # Строку БЕЗ пути тоже переносим: в Касперском можно исключить угрозу по имени
    # вердикта, не указывая файла (`1;;PDM:Trojan.Win32.Generic;*;…`). Раньше такая
    # строка молча выпадала — и обещание «наш файл содержит всё твоё» переставало быть
    # правдой ровно там, где человек настраивал руками.
    $exclusionLines = @()
    $seenExcl = @()
    foreach ($line in (Read-KasperskyListLines $MergeExclusionsFile)) {
        if (-not (Test-LooksLikeListLine $line)) { continue }
        $exclusionLines += $line
        $p = Get-PathFromListLine $line
        if ($p) { $seenExcl = Add-UniquePath -List $seenExcl -Path $p }
    }
    $mergedExclusions = @($exclusionLines).Count

    $folderPaths = @($Plan.ExcludeFolders)
    foreach ($w in @($Plan.WorkFolders)) { $folderPaths += $w.Path }
    foreach ($f in $folderPaths) {
        if (Test-ContainsPath -List $seenExcl -Path $f) { continue }
        $seenExcl = Add-UniquePath -List $seenExcl -Path $f
        $exclusionLines += (ConvertTo-ExclusionLine -Path $f -IsFolder)
    }
    foreach ($f in @($Plan.ExcludeFiles)) {
        if (Test-ContainsPath -List $seenExcl -Path $f) { continue }
        $seenExcl = Add-UniquePath -List $seenExcl -Path $f
        $exclusionLines += (ConvertTo-ExclusionLine -Path $f)
    }

    $trustedLines = @()
    $seenTrusted = @()
    foreach ($line in (Read-KasperskyListLines $MergeTrustedFile)) {
        if (-not (Test-LooksLikeListLine $line)) { continue }
        $trustedLines += $line
        $p = Get-PathFromListLine $line
        if ($p) { $seenTrusted = Add-UniquePath -List $seenTrusted -Path $p }
    }
    $mergedTrusted = @($trustedLines).Count

    foreach ($t in @($Plan.TrustedApps)) {
        if (Test-ContainsPath -List $seenTrusted -Path $t) { continue }
        $seenTrusted = Add-UniquePath -List $seenTrusted -Path $t
        $trustedLines += (ConvertTo-TrustedLine -Path $t)
    }

    $result = [ordered]@{
        Dir                = $Dir
        ExclusionsPath     = ''
        TrustedPath        = ''
        ExclusionCount     = @($exclusionLines).Count
        TrustedCount       = @($trustedLines).Count
        MergedExclusions   = $mergedExclusions
        MergedTrusted      = $mergedTrusted
    }
    # Пустой файл не пишем: импорт пустого списка — это в лучшем случае ничего, а в
    # худшем затирание того, что человек внёс руками.
    if ($result.ExclusionCount -gt 0) {
        $result.ExclusionsPath = Join-Path $Dir $ExclusionFileName
        Write-KasperskyListFile -Path $result.ExclusionsPath -Lines $exclusionLines
    }
    if ($result.TrustedCount -gt 0) {
        $result.TrustedPath = Join-Path $Dir $TrustedFileName
        Write-KasperskyListFile -Path $result.TrustedPath -Lines $trustedLines
    }
    [pscustomobject]$result
}

# --------------------------------------------------------------------------------------
# Рендер инструкции под реальные пути
# --------------------------------------------------------------------------------------

function Write-Guide {
    param($Kav, $Matrica, $Plan, [string]$OutPath, $ImportFiles)
    $tpl = Join-Path $PSScriptRoot 'guide.ru.md'
    if (-not (Test-Path -LiteralPath $tpl)) { return '' }
    $text = Get-Content -LiteralPath $tpl -Raw -Encoding UTF8
    $map = @{
        '{{KAV_NAME}}'      = $(if ($Kav.Edition) { $Kav.Edition } elseif ($Kav.Name) { $Kav.Name } else { 'не найден' })
        '{{KAV_VERSION}}'   = $(if ($Kav.Version) { $Kav.Version } else { '—' })
        '{{AVP}}'           = $(if ($Kav.AvpCom) { $Kav.AvpCom } else { 'не найден' })
        '{{APP_EXE}}'       = $Matrica.AppExe
        '{{APP_DIR}}'       = $Matrica.AppDir
        '{{WD_EXE}}'        = $Matrica.WatchdogExe
        '{{WD_DIR}}'        = $Matrica.WatchdogDir
        '{{DATA_DIR}}'      = $Matrica.DataDir
        '{{PROD_HOST}}'     = $Matrica.ApiHost
        '{{PROD_IP}}'       = ($Matrica.ApiIps -join ', ')
        '{{APP_DIR_MASK}}'  = (ConvertTo-UserMask $Matrica.AppDir)
        '{{WD_DIR_MASK}}'   = (ConvertTo-UserMask $Matrica.WatchdogDir)
        '{{DATA_DIR_MASK}}' = (ConvertTo-UserMask $Matrica.DataDir)
        '{{EXCLUDE_LIST}}'  = ($Plan.ExcludeFolders -join "`r`n")
        '{{MASK_LIST}}'     = ($Plan.ExcludeMasks -join "`r`n")
        '{{TRUSTED_LIST}}'  = ($Plan.TrustedApps -join "`r`n")
        '{{FILES_LIST}}'    = $(if (@($Plan.ExcludeFiles).Count -gt 0) { @($Plan.ExcludeFiles) -join "`r`n" } else { '(ярлыков не найдено)' })
        '{{WORK_LIST}}'     = $(if (@($Plan.WorkFolders).Count -gt 0) {
                                   (@($Plan.WorkFolders) | ForEach-Object { $_.Path + '   — ' + $_.Title }) -join "`r`n"
                               } else { '(на этом компьютере не найдено ни репозиториев, ни Яндекс-диска)' })
        '{{IMPORT_EXCLUSIONS}}' = $(if ($ImportFiles -and $ImportFiles.ExclusionsPath) { [string]$ImportFiles.ExclusionsPath } else { '(файл не записан)' })
        '{{IMPORT_TRUSTED}}'    = $(if ($ImportFiles -and $ImportFiles.TrustedPath) { [string]$ImportFiles.TrustedPath } else { '(файл не записан)' })
    }
    foreach ($k in $map.Keys) { $text = $text.Replace($k, [string]$map[$k]) }
    if (-not $OutPath) {
        $dir = Join-Path $env:LOCALAPPDATA 'kaspersky-matrica'
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $OutPath = Join-Path $dir 'Инструкция-Касперский-Матрица.md'
    }
    Set-Content -LiteralPath $OutPath -Value $text -Encoding UTF8
    $OutPath
}

# --------------------------------------------------------------------------------------
# Экспорт / импорт настроек Касперского (штатный avp.com)
# --------------------------------------------------------------------------------------

function Invoke-AvpSettings {
    param(
        [ValidateSet('EXPORT', 'IMPORT')][string]$Action,
        [string]$File,
        $Kav,
        [string]$Password
    )
    if (-not $Kav.AvpCom) { throw 'avp.com не найден — Касперский не установлен или установлен нестандартно.' }
    if ($Action -eq 'IMPORT' -and -not (Test-Path -LiteralPath $File)) {
        throw "Файл эталона не найден: $File"
    }
    if (-not (Test-IsAdmin)) {
        throw 'Нужны права администратора. Запусти «Запустить-от-администратора.cmd» либо PowerShell от имени администратора.'
    }
    $argList = @($Action)
    if ($Password) { $argList += "/password=$Password" }
    $argList += $File
    Write-Host "Выполняю: `"$($Kav.AvpCom)`" $Action <файл>" -ForegroundColor Cyan
    $out = & $Kav.AvpCom @argList 2>&1
    $code = $LASTEXITCODE
    $out | ForEach-Object { Write-Host "  $_" }
    if ($code -ne 0) {
        throw "avp.com $Action завершился с кодом $code. Если в Касперском включён пароль на управление настройками — добавь -SettingsPassword."
    }
    Write-Host "Готово: $Action выполнен ($File)" -ForegroundColor Green
}

# --------------------------------------------------------------------------------------
# Проверка состояния
# --------------------------------------------------------------------------------------

function Invoke-VerifyState {
    param($Kav, $Matrica)
    $lines = @()
    $problems = 0

    $lines += "=== Проверка состояния  $(Get-Date -Format 'yyyy-MM-dd HH:mm') ==="
    if ($Kav.Found) {
        $run = if ($Kav.Running) { 'работает' } else { 'установлен, служба не запущена' }
        $lines += "Касперский: $($Kav.Edition) $($Kav.Version) — $run"
    } else {
        $lines += 'Касперский: НЕ НАЙДЕН (настраивать нечего)'
    }

    if ($Matrica.AppExe) {
        $lines += "Матрица: на месте — $($Matrica.AppExe)"
    } else {
        $lines += 'Матрица: ФАЙЛ НЕ НАЙДЕН — приложение не установлено ЛИБО удалено антивирусом'
        $problems++
    }
    if ($Matrica.WatchdogExe) {
        $lines += "Сторож: на месте — $($Matrica.WatchdogExe)"
    } else {
        $lines += 'Сторож: ФАЙЛ НЕ НАЙДЕН — типичный признак, что антивирус его забрал (Go-бинарь без подписи)'
        $problems++
    }
    foreach ($t in $Matrica.Tasks) {
        if ($t.Exists) { $lines += "Плановая задача «$($t.Name)»: есть" }
        else { $lines += "Плановая задача «$($t.Name)»: ОТСУТСТВУЕТ"; $problems++ }
    }
    if ($Matrica.LogonShortcut) {
        if ($Matrica.LogonShortcut.Exists) {
            $lines += 'Автозапуск сторожа при входе: есть (ярлык в автозагрузке)'
        } else {
            $lines += 'Автозапуск сторожа при входе: ОТСУТСТВУЕТ — ярлык в папке автозагрузки не найден'
            $problems++
        }
    }
    if ($Matrica.HandshakeFound) {
        $age = if ($null -ne $Matrica.HandshakeAgeHours) { "$($Matrica.HandshakeAgeHours) ч назад" } else { 'время неизвестно' }
        $lines += "Рукопожатие приложения: есть (обновлено $age)"
    } else {
        $lines += 'Рукопожатие приложения: нет (приложение ни разу не стартовало на этом пользователе)'
    }

    # Сеть до прода — TCP:443, без DNS-зависимости, если IP уже известен.
    $target = if ($Matrica.ApiIps -and $Matrica.ApiIps.Count -gt 0) { $Matrica.ApiIps[0] } else { $Matrica.ApiHost }
    if ($target) {
        $ok = $false
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $iar = $client.BeginConnect($target, 443, $null, $null)
            $ok = $iar.AsyncWaitHandle.WaitOne(3000) -and $client.Connected
        } catch { $ok = $false } finally { $client.Close() }
        # $($target):443 — не "$target:443": двоеточие после имени переменной PowerShell
        # разбирает как указание области видимости, и подстановка молча даёт пустоту.
        if ($ok) { $lines += "Связь с сервером ($($target):443): есть" }
        else { $lines += "Связь с сервером ($($target):443): НЕТ ОТВЕТА (может быть сеть, VPN или блокировка)"; $problems++ }
    }

    $lines += ''
    $lines += 'ВАЖНО про границу проверки: прочитать список исключений Касперского программно'
    $lines += 'НЕЛЬЗЯ — он не отдаёт их ни через командную строку, ни через реестр. Поэтому'
    $lines += 'проверка отвечает на вопрос «всё ли на месте и работает», а НЕ «внесены ли'
    $lines += 'исключения». Единственное честное подтверждение исключений — увидеть их в окне'
    $lines += 'Касперского (Настройки → Исключения и действия при обнаружении угроз).'
    $lines += ''
    $lines += $(if ($problems -eq 0) { 'ИТОГ: проблем не обнаружено.' } else { "ИТОГ: проблем — $problems (см. выше)." })
    ,$lines
}

# --------------------------------------------------------------------------------------
# Окно с готовыми строками
# --------------------------------------------------------------------------------------

function Show-Window {
    param($Kav, $Matrica, $Plan, [string]$GuidePath, $ImportFiles, [string]$ImportFilesError)

    Add-Type -AssemblyName System.Windows.Forms, System.Drawing

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Касперский × Матрица РМЗ — что внести в исключения'
    $form.Size = New-Object System.Drawing.Size(940, 680)
    $form.StartPosition = 'CenterScreen'
    $form.Font = New-Object System.Drawing.Font('Segoe UI', 9)

    $head = New-Object System.Windows.Forms.Label
    $head.Dock = 'Top'; $head.Height = 74; $head.Padding = New-Object System.Windows.Forms.Padding(10, 8, 10, 0)
    $kavText = if ($Kav.Found) { "$($Kav.Edition) $($Kav.Version)" } else { 'НЕ НАЙДЕН на этом компьютере' }
    $head.Text = "Касперский: $kavText`r`n" +
                 "Матрица: $(if ($Matrica.AppExe) { $Matrica.AppExe } else { 'не найдена (установи приложение и запусти это окно снова)' })`r`n" +
                 "Сервер: $($Matrica.ApiHost)  (IP: $($Matrica.ApiIps -join ', '))   Порт: 443"

    $panel = New-Object System.Windows.Forms.TableLayoutPanel
    $panel.Dock = 'Fill'; $panel.ColumnCount = 2; $panel.AutoScroll = $true
    $panel.Padding = New-Object System.Windows.Forms.Padding(10)
    [void]$panel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
    [void]$panel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 120)))

    $script:allText = New-Object System.Text.StringBuilder

    function Add-Section {
        param([string]$Title, [string]$Hint)
        $lbl = New-Object System.Windows.Forms.Label
        $lbl.Text = $Title; $lbl.AutoSize = $true
        $lbl.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
        $lbl.Margin = New-Object System.Windows.Forms.Padding(0, 14, 0, 2)
        $panel.Controls.Add($lbl, 0, $panel.RowCount); $panel.SetColumnSpan($lbl, 2)
        $panel.RowCount++
        if ($Hint) {
            $h = New-Object System.Windows.Forms.Label
            $h.Text = $Hint; $h.AutoSize = $true; $h.ForeColor = [System.Drawing.Color]::DimGray
            $h.MaximumSize = New-Object System.Drawing.Size(860, 0)
            $panel.Controls.Add($h, 0, $panel.RowCount); $panel.SetColumnSpan($h, 2)
            $panel.RowCount++
        }
        [void]$script:allText.AppendLine("### $Title")
    }

    function Add-Row {
        param([string]$Value)
        if ([string]::IsNullOrWhiteSpace($Value)) { return }
        $tb = New-Object System.Windows.Forms.TextBox
        $tb.Text = $Value; $tb.ReadOnly = $true; $tb.Width = 760
        $tb.Font = New-Object System.Drawing.Font('Consolas', 9)
        $btn = New-Object System.Windows.Forms.Button
        $btn.Text = 'Копировать'; $btn.Width = 110
        $captured = $Value
        $btn.Add_Click({
            try { [System.Windows.Forms.Clipboard]::SetText($captured) } catch {}
        }.GetNewClosure())
        $panel.Controls.Add($tb, 0, $panel.RowCount)
        $panel.Controls.Add($btn, 1, $panel.RowCount)
        $panel.RowCount++
        [void]$script:allText.AppendLine($Value)
    }

    if ($ImportFiles -and ($ImportFiles.ExclusionsPath -or $ImportFiles.TrustedPath)) {
        Add-Section 'Импорт файлами — быстрый путь, вбивать строки не нужно' ('Настройки Касперского → Настройки безопасности → «Исключения и действия при обнаружении угроз». Там две кнопки со своими списками, у каждой рядом есть Экспорт и Импорт: «Управление исключениями» принимает первый файл, «Указать доверенные программы» — второй. Путь можно вставить прямо в строку имени файла в окне открытия — искать папку не нужно. Перед импортом нажми там же «Экспорт» и сохрани то, что уже внесено: это и точка возврата, и файл для ключей -MergeExclusions / -MergeTrusted, после которых наш файл гарантированно содержит твои прежние строки.')
        if ($ImportFiles.ExclusionsPath) { Add-Row $ImportFiles.ExclusionsPath }
        if ($ImportFiles.TrustedPath) { Add-Row $ImportFiles.TrustedPath }
    } elseif ($ImportFilesError) {
        Add-Section 'Импорт файлами недоступен' ('Файлы записать не удалось: ' + $ImportFilesError + '. Строки ниже можно внести руками.')
    }

    Add-Section 'A. Доверенные программы' ('Настройки Касперского → Настройки безопасности → «Исключения и действия при обнаружении угроз» → «Указать доверенные программы» → Добавить. Для каждой поставь все галочки: ' + ($Plan.TrustedFlags -join '; ') + '.')
    foreach ($t in $Plan.TrustedApps) { Add-Row $t }
    if (@($Plan.TrustedApps).Count -eq 0) { Add-Row '(не найдено — установи Матрицу и открой это окно снова)' }

    Add-Section 'B. Исключения — папки этого компьютера' 'Там же → «Управление исключениями» → Добавить → поле «Файл или папка».'
    foreach ($f in $Plan.ExcludeFolders) { Add-Row $f }

    if (@($Plan.ExcludeFiles).Count -gt 0) {
        Add-Section 'C. Исключения — ярлыки' 'Ярлык запуска Касперский проверяет отдельно от файла, на который тот указывает.'
        foreach ($f in $Plan.ExcludeFiles) { Add-Row $f }
    }

    if (@($Plan.WorkFolders).Count -gt 0) {
        Add-Section 'D. Рабочие папки этого компьютера (к Матрице отношения не имеют)' ('Нашлось: ' + ((@($Plan.WorkFolders) | ForEach-Object { $_.Title }) -join '; ') + '. Проверка этих папок тормозит работу заметнее всего, но решение вносить их — твоё: в файл импорта они уже включены.')
        foreach ($w in $Plan.WorkFolders) { Add-Row $w.Path }
    }

    Add-Section 'E. Те же исключения масками (для эталона на весь парк)' 'Маска не привязана к имени пользователя — подойдёт на любом компьютере. Вноси их вместо B, если готовишь эталонный файл настроек для других компов.'
    foreach ($m in $Plan.ExcludeMasks) { Add-Row $m }

    Add-Section 'F. Сеть — если не поставил галочку «Не проверять сетевой трафик»' 'Настройки → Сетевой экран → «Настроить пакетные правила» → Добавить разрешающее правило: протокол TCP, удалённый адрес и порт ниже.'
    foreach ($ip in $Plan.NetworkIps) { Add-Row "$ip" }
    Add-Row '443'
    if ($Plan.NetworkHost) { Add-Row $Plan.NetworkHost }

    $bottom = New-Object System.Windows.Forms.FlowLayoutPanel
    $bottom.Dock = 'Bottom'; $bottom.Height = 96; $bottom.Padding = New-Object System.Windows.Forms.Padding(10, 8, 10, 8)

    $bCopyAll = New-Object System.Windows.Forms.Button
    $bCopyAll.Text = 'Копировать всё'; $bCopyAll.Width = 140; $bCopyAll.Height = 30
    $bCopyAll.Add_Click({ try { [System.Windows.Forms.Clipboard]::SetText($script:allText.ToString()) } catch {} })

    $bGuide = New-Object System.Windows.Forms.Button
    $bGuide.Text = 'Открыть инструкцию'; $bGuide.Width = 160; $bGuide.Height = 30
    $capturedGuide = $GuidePath
    $bGuide.Add_Click({ if ($capturedGuide -and (Test-Path -LiteralPath $capturedGuide)) { Start-Process notepad $capturedGuide } }.GetNewClosure())

    $bFiles = New-Object System.Windows.Forms.Button
    $bFiles.Text = 'Папка с файлами'; $bFiles.Width = 150; $bFiles.Height = 30
    $capturedFilesDir = if ($ImportFiles) { [string]$ImportFiles.Dir } else { '' }
    $bFiles.Enabled = [bool]($capturedFilesDir -and (Test-Path -LiteralPath $capturedFilesDir))
    $bFiles.Add_Click({ try { Start-Process explorer.exe $capturedFilesDir } catch {} }.GetNewClosure())

    $bKav = New-Object System.Windows.Forms.Button
    $bKav.Text = 'Открыть Касперский'; $bKav.Width = 160; $bKav.Height = 30
    $kavUi = if ($Kav.InstallDir) { Join-Path $Kav.InstallDir 'avpui.exe' } else { '' }
    $bKav.Enabled = [bool]($kavUi -and (Test-Path -LiteralPath $kavUi))
    $bKav.Add_Click({ try { Start-Process $kavUi } catch {} }.GetNewClosure())

    $bVerify = New-Object System.Windows.Forms.Button
    $bVerify.Text = 'Проверить состояние'; $bVerify.Width = 160; $bVerify.Height = 30
    $bVerify.Add_Click({
        $report = (Invoke-VerifyState -Kav $Kav -Matrica $Matrica) -join "`r`n"
        [System.Windows.Forms.MessageBox]::Show($report, 'Проверка состояния') | Out-Null
    }.GetNewClosure())

    $bExport = New-Object System.Windows.Forms.Button
    $bExport.Text = 'Сохранить эталон…'; $bExport.Width = 150; $bExport.Height = 30
    $bExport.Add_Click({
        $dlg = New-Object System.Windows.Forms.SaveFileDialog
        $dlg.Filter = 'Настройки Касперского (*.cfg)|*.cfg|Все файлы (*.*)|*.*'
        $dlg.FileName = 'matrica-kaspersky-baseline.cfg'
        if ($dlg.ShowDialog() -eq 'OK') {
            try {
                Invoke-AvpSettings -Action 'EXPORT' -File $dlg.FileName -Kav $Kav -Password $SettingsPassword
                [System.Windows.Forms.MessageBox]::Show("Эталон сохранён:`r`n$($dlg.FileName)`r`n`r`nНа другом компьютере примени его кнопкой «Применить эталон…» (нужны права администратора и та же версия Касперского).", 'Готово') | Out-Null
            } catch {
                [System.Windows.Forms.MessageBox]::Show([string]$_, 'Не получилось') | Out-Null
            }
        }
    }.GetNewClosure())

    $bImport = New-Object System.Windows.Forms.Button
    $bImport.Text = 'Применить эталон…'; $bImport.Width = 150; $bImport.Height = 30
    $bImport.Add_Click({
        $warn = [System.Windows.Forms.MessageBox]::Show(
            "Импорт ЗАМЕНИТ ВСЕ настройки Касперского на этом компьютере снимком из файла (не только исключения Матрицы).`r`n`r`nВерсия Касперского должна совпадать с той, где делался эталон.`r`n`r`nПродолжить?",
            'Подтверждение', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning)
        if ($warn -ne 'Yes') { return }
        $dlg = New-Object System.Windows.Forms.OpenFileDialog
        $dlg.Filter = 'Настройки Касперского (*.cfg;*.dat)|*.cfg;*.dat|Все файлы (*.*)|*.*'
        if ($dlg.ShowDialog() -eq 'OK') {
            try {
                Invoke-AvpSettings -Action 'IMPORT' -File $dlg.FileName -Kav $Kav -Password $SettingsPassword
                [System.Windows.Forms.MessageBox]::Show('Эталон применён.', 'Готово') | Out-Null
            } catch {
                [System.Windows.Forms.MessageBox]::Show([string]$_, 'Не получилось') | Out-Null
            }
        }
    }.GetNewClosure())

    $note = New-Object System.Windows.Forms.Label
    $note.Text = 'Настройки вносишь ты — Касперский не даёт менять их программно (Самозащита не выключается вместе с защитой).'
    $note.AutoSize = $true; $note.ForeColor = [System.Drawing.Color]::DimGray
    $note.Margin = New-Object System.Windows.Forms.Padding(4, 8, 0, 0)

    $bottom.Controls.AddRange(@($bCopyAll, $bGuide, $bFiles, $bKav, $bVerify, $bExport, $bImport, $note))

    $form.Controls.Add($panel)
    $form.Controls.Add($bottom)
    $form.Controls.Add($head)

    # Иначе окно открывается прокрученным вниз (фокус уезжает на первое поле ввода)
    # и заголовок первого раздела не виден — читается как «список начинается сразу».
    $form.Add_Shown({
        $form.ActiveControl = $bCopyAll
        $panel.AutoScrollPosition = New-Object System.Drawing.Point(0, 0)
    }.GetNewClosure())

    [void]$form.ShowDialog()
}

# --------------------------------------------------------------------------------------
# Главный поток
# --------------------------------------------------------------------------------------

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# Пути из ключей разворачиваем в абсолютные СРАЗУ: дальше их читают и пишут вперемешку
# PowerShell и .NET, а «текущая папка» у них разная (см. ConvertTo-FullPath). Заодно в
# окне и в выводе печатается путь, который можно вставить куда угодно, а не «.\файл».
foreach ($name in @('ImportDir', 'MergeExclusions', 'MergeTrusted', 'Report')) {
    $value = (Get-Variable -Name $name -ValueOnly -ErrorAction SilentlyContinue)
    if ($value) { Set-Variable -Name $name -Value (ConvertTo-FullPath $value) }
}

$kav = Get-KasperskyInfo
$matrica = Get-MatricaInfo
$workFolders = Get-WorkFolders
$plan = Get-ExclusionPlan -Matrica $matrica -WorkFolders $workFolders

if ($Export) { Invoke-AvpSettings -Action 'EXPORT' -File $Export -Kav $kav -Password $SettingsPassword; return }
if ($Import) { Invoke-AvpSettings -Action 'IMPORT' -File $Import -Kav $kav -Password $SettingsPassword; return }

# Проверка состояния идёт до генерации: она читающая, и её дёргает сама Матрица —
# писать файлы на каждый опрос состояния незачем.
if ($Verify) {
    (Invoke-VerifyState -Kav $kav -Matrica $matrica) | ForEach-Object { Write-Host $_ }
    return
}

$importFiles = $null
$importFilesError = ''
try {
    $importFiles = Write-KasperskyImportFiles -Plan $plan -Dir $ImportDir `
        -MergeExclusionsFile $MergeExclusions -MergeTrustedFile $MergeTrusted
} catch {
    # Файлы импорта — удобство, а не смысл инструмента: не смогли записать (нет прав,
    # диск полон, антивирус забрал папку) — окно и строки для ручного ввода остаются.
    $importFilesError = [string]$_
}

if ($Json) {
    [pscustomobject]@{
        generatedAt = (Get-Date).ToString('o')
        kaspersky   = $kav
        matrica     = $matrica
        plan        = $plan
        importFiles = $importFiles
        importFilesError = $importFilesError
        canAutoApply = $false
        autoApplyReason = 'Consumer Kaspersky exposes no CLI/registry/file API to add an exclusion; Self-Defense blocks external config tampering independently of real-time protection state. Supported automation: avp.com EXPORT/IMPORT of the whole settings blob, plus per-list Import of the exclusion / trusted-application files this script generates.'
    } | ConvertTo-Json -Depth 6
    return
}

$guidePath = Write-Guide -Kav $kav -Matrica $matrica -Plan $plan -OutPath $Report -ImportFiles $importFiles

if ($Quiet) {
    Write-Host "=== Доверенные программы ==="
    $plan.TrustedApps | ForEach-Object { Write-Host "  $_" }
    Write-Host "=== Исключения (папки) ==="
    $plan.ExcludeFolders | ForEach-Object { Write-Host "  $_" }
    if (@($plan.ExcludeFiles).Count -gt 0) {
        Write-Host "=== Исключения (файлы и ярлыки) ==="
        $plan.ExcludeFiles | ForEach-Object { Write-Host "  $_" }
    }
    if (@($plan.WorkFolders).Count -gt 0) {
        Write-Host "=== Рабочие папки этого компьютера ==="
        $plan.WorkFolders | ForEach-Object { Write-Host "  $($_.Path)   — $($_.Title)" }
    }
    Write-Host "=== Те же исключения масками (для эталона на парк) ==="
    $plan.ExcludeMasks | ForEach-Object { Write-Host "  $_" }
    Write-Host "=== Сеть ==="
    Write-Host "  хост: $($plan.NetworkHost)   IP: $($plan.NetworkIps -join ', ')   порт: $($plan.NetworkPort)"
    if ($importFiles) {
        Write-Host "=== Файлы для импорта в Касперский ==="
        if ($importFiles.ExclusionsPath) {
            Write-Host "  Исключения ($($importFiles.ExclusionCount) строк): $($importFiles.ExclusionsPath)"
        }
        if ($importFiles.TrustedPath) {
            Write-Host "  Доверенные программы ($($importFiles.TrustedCount) строк): $($importFiles.TrustedPath)"
        }
    }
    if ($importFilesError) { Write-Host "  Файлы импорта не записаны: $importFilesError" }
    if ($guidePath) { Write-Host "`nИнструкция: $guidePath" }
    return
}

Show-Window -Kav $kav -Matrica $matrica -Plan $plan -GuidePath $guidePath -ImportFiles $importFiles -ImportFilesError $importFilesError
