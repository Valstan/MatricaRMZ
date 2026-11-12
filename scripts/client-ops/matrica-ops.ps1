# matrica-ops.ps1 — окно обслуживания машины: одна точка входа для всех утилит парка.
#
# Зачем оно есть. Раньше архив со скриптами отдавался оператору как есть: «вот файл, вот
# пароль, распакуйте и запустите нужный .cmd». Каждый шаг там — место, где человек теряется:
# какой из двух .cmd, нужен ли администратор, что вообще делает второй скрипт. Теперь плитка
# Верстака распаковывает архив сама и открывает ЭТО окно, а утилиты живут в нём вкладками.
#
# Как оно запускается. Матрица (`clientOpsService.ts`) распаковывает архив в свою папку данных
# и зовёт этот файл.
#
# ПРАВ АДМИНИСТРАТОРА ОНО НЕ ПРОСИТ И НЕ ТРЕБУЕТ (решение владельца 12.11.2026). Раньше окно
# поднимало себя через UAC, а в шапке была кнопка «Перезапустить от администратора». Причина
# отмены: программа работает в учётке пользователя без повышенных прав, и все настройки
# Касперского тоже должны делаться без прав админа — иначе половина парка (у оператора цеха их
# нет) до списка исключений просто не доберётся. Шаги, которые прав требуют по существу
# (правило брандмауэра, снятие задачи планировщика), делает тот, у кого права есть, — окно
# даёт ему готовую команду.
#
# Что оно НЕ делает: не меняет настройки за оператора. Касперский не позволяет вносить
# исключения программно (Самозащита), а правило брандмауэра создаётся только по явному нажатию.
#
# Запуск вручную: Запустить.cmd (или powershell -sta -ep bypass -file matrica-ops.ps1)

[CmdletBinding()]
param(
    # Какую вкладку открыть первой.
    [ValidateSet('kaspersky', 'lan', 'cleanup', 'guide')]
    [string]$Tab = 'kaspersky',
    # Путь к .exe клиента и к его папке данных — их знает сама Матрица и передаёт сюда.
    # Своими силами их пришлось бы искать по профилю ТЕКУЩЕГО пользователя.
    [string]$ClientExe = '',
    [string]$UserDataDir = '',
    [int]$Port = 38080
)

$ErrorActionPreference = 'Stop'

# ⚠ Свои параметры уносим в отдельные имена ДО подключения утилит точкой. Дот-сорсинг
# исполняет чужой `param()` в ЭТОЙ области видимости, и `$ClientExe` с `$Port` там свои —
# со своими значениями по умолчанию. Оставь мы исходные имена, переданный Матрицей путь к
# клиенту молча затёрся бы пустой строкой из `lan-share-firewall.ps1`.
$OpsTab = $Tab
$OpsClientExe = $ClientExe
$OpsUserDataDir = $UserDataDir
$OpsPort = $Port
$OpsDir = Split-Path -Parent $PSCommandPath

function Test-OpsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# --------------------------------------------------------------------------------------
# Права администратора
#
# Окно НЕ поднимает себя и НЕ просит прав (решение владельца 12.11.2026). Раньше оно
# стартовало через `Start-Process -Verb RunAs`, а в шапке была кнопка «Перезапустить от
# администратора». Обе вещи убраны: программа живёт в учётке пользователя без повышенных
# прав, и весь сценарий настройки Касперского обязан работать так же.
#
# Что осталось делать с правами: правило брандмауэра (вкладка «Раздача соседям») и снятие
# задачи планировщика (вкладка «Уборка OpenCode») требуют прав по существу — их делает
# системный администратор. Окно не мешает: эти вкладки честно пишут, что нужно, и дают
# готовую команду; вкладка «Антивирус» (то, что нужно оператору и админу чаще всего)
# работает полностью без прав.
# --------------------------------------------------------------------------------------

# --------------------------------------------------------------------------------------
# Утилиты — подключаются точкой, каждая отдаёт свою панель
# --------------------------------------------------------------------------------------

. (Join-Path $OpsDir 'kaspersky-matrica.ps1') -AsLibrary
. (Join-Path $OpsDir 'lan-share-firewall.ps1') -AsLibrary
. (Join-Path $OpsDir 'opencode-cleanup.ps1') -AsLibrary

$OpsIsAdmin = Test-OpsAdmin

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Матрица РМЗ — обслуживание машины'
$form.Size = New-Object System.Drawing.Size(1000, 740)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$form.MinimumSize = New-Object System.Drawing.Size(820, 560)

# --------------------------------------------------------------------------------------
# Шапка: с правами мы или нет
# --------------------------------------------------------------------------------------

$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Dock = 'Fill'
$tabs.Padding = New-Object System.Drawing.Point(12, 6)

$bar = New-Object System.Windows.Forms.FlowLayoutPanel
$bar.Dock = 'Top'; $bar.Height = 34; $bar.Padding = New-Object System.Windows.Forms.Padding(10, 5, 10, 2)

$lblRights = New-Object System.Windows.Forms.Label
$lblRights.AutoSize = $true
$lblRights.Margin = New-Object System.Windows.Forms.Padding(0, 6, 10, 0)
if ($OpsIsAdmin) {
    $lblRights.Text = 'Права администратора есть — доступно всё.'
    $lblRights.ForeColor = [System.Drawing.Color]::DarkGreen
} else {
    $lblRights.Text = 'Без прав администратора: всё для Касперского работает, правило брандмауэра — нет.'
    $lblRights.ForeColor = [System.Drawing.Color]::Firebrick
}
$bar.Controls.Add($lblRights)

if (-not $OpsIsAdmin) {
    $lblProfile = New-Object System.Windows.Forms.Label
    $lblProfile.AutoSize = $true
    $lblProfile.Margin = New-Object System.Windows.Forms.Padding(12, 6, 0, 0)
    $lblProfile.ForeColor = [System.Drawing.Color]::DarkOrange
    $lblProfile.Text = 'Шаги, которым нужны права администратора (правило брандмауэра, снятие задачи), выполняет тот, у кого они есть — окно даёт готовую команду.'
    $bar.Controls.Add($lblProfile)
}

# --------------------------------------------------------------------------------------
# Вкладки
# --------------------------------------------------------------------------------------

$tabKav = New-Object System.Windows.Forms.TabPage
$tabKav.Text = 'Антивирус (Касперский)'
$tabKav.Tag = 'kaspersky'
$tabKav.UseVisualStyleBackColor = $true

# Данные для этой вкладки собираются секунды (обход папок, запрос DNS, проба связи с
# сервером). Собирать их ДО показа окна значит несколько секунд пустого экрана после щелчка
# по плитке — оператор за это время успевает щёлкнуть второй раз. Поэтому окно открывается
# сразу с заглушкой, а сбор идёт на Add_Shown.
$kavLoading = New-Object System.Windows.Forms.Label
$kavLoading.Dock = 'Fill'
$kavLoading.TextAlign = 'MiddleCenter'
$kavLoading.Text = 'Собираю данные о компьютере: где стоит Матрица, где Касперский, отвечает ли сервер…'
$tabKav.Controls.Add($kavLoading)

$tabLan = New-Object System.Windows.Forms.TabPage
$tabLan.Text = 'Раздача обновлений соседям'
$tabLan.Tag = 'lan'
$tabLan.UseVisualStyleBackColor = $true
$tabLan.Controls.Add((New-LanSharePanel -RulePort $OpsPort -ExePath $OpsClientExe))

$tabCleanup = New-Object System.Windows.Forms.TabPage
$tabCleanup.Text = 'Уборка узла OpenCode'
$tabCleanup.Tag = 'cleanup'
$tabCleanup.UseVisualStyleBackColor = $true
$tabCleanup.Controls.Add((New-OpencodeCleanupPanel))

$tabGuide = New-Object System.Windows.Forms.TabPage
$tabGuide.Text = 'Памятка'
$tabGuide.Tag = 'guide'
$tabGuide.UseVisualStyleBackColor = $true

$guideBox = New-Object System.Windows.Forms.TextBox
$guideBox.Dock = 'Fill'; $guideBox.Multiline = $true; $guideBox.ReadOnly = $true
$guideBox.ScrollBars = 'Vertical'
$guideBox.Font = New-Object System.Drawing.Font('Consolas', 9)
$guideBox.BackColor = [System.Drawing.Color]::White
# ⚠ Здесь НЕ `guide.ru.md`: тот файл — шаблон с подстановками вида {{APP_EXE}}, и показывать
# его оператору нельзя (на экране будут фигурные скобки вместо путей). Человеку нужен
# отрендеренный вариант, который Write-Guide собирает под ЭТОТ компьютер, — а он появляется
# только вместе со сбором данных вкладки «Антивирус», то есть на Add_Shown.
$guideBox.Text = 'Памятка собирается под этот компьютер вместе с данными вкладки «Антивирус» — секунду…'

$guideBar = New-Object System.Windows.Forms.FlowLayoutPanel
$guideBar.Dock = 'Bottom'; $guideBar.Height = 44
$guideBar.Padding = New-Object System.Windows.Forms.Padding(10, 8, 10, 8)
$bGuideFolder = New-Object System.Windows.Forms.Button
$bGuideFolder.Text = 'Открыть папку со скриптами'; $bGuideFolder.Width = 210; $bGuideFolder.Height = 28
$bGuideFolder.Add_Click({ try { Start-Process explorer.exe $OpsDir } catch {} }.GetNewClosure())
$guideBar.Controls.Add($bGuideFolder)

# Путь к отрендеренной памятке кладётся сюда на Add_Shown — кнопка до тех пор выключена.
$bGuideOpen = New-Object System.Windows.Forms.Button
$bGuideOpen.Text = 'Открыть в блокноте'; $bGuideOpen.Width = 170; $bGuideOpen.Height = 28
$bGuideOpen.Enabled = $false
$bGuideOpen.Add_Click({
        $path = [string]$bGuideOpen.Tag
        if ($path -and (Test-Path -LiteralPath $path)) { Start-Process notepad $path }
    }.GetNewClosure())
$guideBar.Controls.Add($bGuideOpen)

$tabGuide.Controls.Add($guideBox)
$tabGuide.Controls.Add($guideBar)

[void]$tabs.TabPages.Add($tabKav)
[void]$tabs.TabPages.Add($tabLan)
[void]$tabs.TabPages.Add($tabCleanup)
[void]$tabs.TabPages.Add($tabGuide)

switch ($OpsTab) {
    'lan' { $tabs.SelectedTab = $tabLan }
    'cleanup' { $tabs.SelectedTab = $tabCleanup }
    'guide' { $tabs.SelectedTab = $tabGuide }
    default { $tabs.SelectedTab = $tabKav }
}

# Fill добавляется первым: WinForms раздаёт края в порядке добавления.
$form.Controls.Add($tabs)
$form.Controls.Add($bar)

$form.Add_Shown({
        # Дать окну прорисоваться с заглушкой, и только потом уходить в долгий сбор.
        [System.Windows.Forms.Application]::DoEvents()
        try {
            $ctx = Get-KasperskyContext
            $panel = New-KasperskyPanel -Kav $ctx.Kav -Matrica $ctx.Matrica -Plan $ctx.Plan `
                -GuidePath $ctx.GuidePath -ImportFiles $ctx.ImportFiles -ImportFilesError $ctx.ImportFilesError
            $tabKav.Controls.Clear()
            $tabKav.Controls.Add($panel)
            $panel.ScrollPanel.AutoScrollPosition = New-Object System.Drawing.Point(0, 0)

            if ($ctx.GuidePath -and (Test-Path -LiteralPath $ctx.GuidePath)) {
                # Явный -Encoding UTF8: Windows PowerShell 5.1 без него читает файл в ANSI
                # и кириллица приезжает мусором.
                $guideBox.Text = ((Get-Content -LiteralPath $ctx.GuidePath -Encoding UTF8) -join "`r`n")
                $guideBox.Select(0, 0)
                $bGuideOpen.Tag = $ctx.GuidePath
                $bGuideOpen.Enabled = $true
            } else {
                $guideBox.Text = 'Памятку собрать не удалось — записать файл не вышло. Готовые строки остаются на вкладке «Антивирус».'
            }
        } catch {
            # Сбор упал — окно остаётся рабочим: вкладка раздачи и памятка от Касперского
            # не зависят, и терять их из-за него нельзя.
            $kavLoading.Text = "Не удалось собрать данные для этой вкладки:`r`n`r`n$([string]$_)"
            $kavLoading.ForeColor = [System.Drawing.Color]::Firebrick
        }
    }.GetNewClosure())

[void]$form.ShowDialog()
