# Office acceptance check: opens the file with the Office actually installed on the machine.
#
# Why a separate step: "valid zip" and "opens in Word/Excel" are different claims. A builder can
# emit a correct container that Office 2007 refuses to render (example: table widths in percent,
# GOTCHAS M80). Unit tests cannot replace this: the file must be opened by the operator's app.
#
# Opens the file non-interactively via COM and reads the model: workbook -> used rows/columns and
# a value lookup, document -> table count, rows/columns and text. A COM exception means Office
# rejected the file. NOTE: this script is ASCII-only on purpose - Windows PowerShell 5.1 reads
# .ps1 without a BOM as CP1251 and breaks on non-ASCII comments.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File office-open-check.ps1 -Path <file> [-Expect <substring>]
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$Expect = ''
)

$ErrorActionPreference = 'Stop'
$full = (Resolve-Path -LiteralPath $Path).Path
$ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
$result = [ordered]@{ path = $full; kind = $null; app = $null; rows = $null; columns = $null; tables = $null; pages = $null; expectFound = $null }

function Release-Com([object]$obj) {
    if ($null -ne $obj) {
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($obj)
    }
}

try {
    if ($ext -eq '.xlsx' -or $ext -eq '.xls' -or $ext -eq '.xlsm') {
        $excel = New-Object -ComObject Excel.Application
        $result.kind = 'excel'
        $result.app = [string]$excel.Version
        $excel.Visible = $false
        $excel.DisplayAlerts = $false
        $book = $excel.Workbooks.Open($full, 0, $true)
        $sheet = $book.Worksheets.Item(1)
        $used = $sheet.UsedRange
        $result.rows = [int]$used.Rows.Count
        $result.columns = [int]$used.Columns.Count
        $found = $false
        if ($Expect) {
            $hit = $used.Find($Expect)
            $found = $null -ne $hit
            if ($null -ne $hit) { Release-Com $hit }
        }
        $result.expectFound = $found
        Release-Com $used
        Release-Com $sheet
        $book.Close($false)
        Release-Com $book
        $excel.Quit()
        Release-Com $excel
    }
    elseif ($ext -eq '.docx' -or $ext -eq '.doc') {
        $word = New-Object -ComObject Word.Application
        $result.kind = 'word'
        $result.app = [string]$word.Version
        $word.Visible = $false
        $word.DisplayAlerts = 0
        $doc = $word.Documents.Open($full, $false, $true)
        $result.tables = [int]$doc.Tables.Count
        if ($result.tables -gt 0) {
            $table = $doc.Tables.Item(1)
            $result.rows = [int]$table.Rows.Count
            $result.columns = [int]$table.Columns.Count
            Release-Com $table
        }
        $text = [string]$doc.Content.Text
        $found = $false
        if ($Expect) { $found = $text.Contains($Expect) }
        $result.expectFound = $found
        $pages = 0
        try { $pages = [int]$doc.ComputeStatistics(2) } catch { $pages = 0 }
        $result.pages = $pages
        $doc.Close($false)
        Release-Com $doc
        $word.Quit()
        Release-Com $word
    }
    else {
        throw "unsupported extension: $ext"
    }

    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
    ($result | ConvertTo-Json -Compress)
    if ($Expect -and -not $result.expectFound) {
        Write-Output "FAIL: value not found in file: $Expect"
        exit 1
    }
    Write-Output 'OK'
    exit 0
}
catch {
    Write-Output ('FAIL: ' + $_.Exception.Message)
    exit 2
}
