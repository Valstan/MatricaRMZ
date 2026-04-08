<#
Usage: run in PowerShell (Windows) to create `%USERPROFILE%\.cursor\mcp.json` from the project example.
This script does NOT upload SSH keys. It writes the JSON config with your Windows username filled in.

Run as:
  pwsh -ExecutionPolicy Bypass -File .\scripts\setup-mcp.ps1
#>

$ErrorActionPreference = 'Stop'

$user = $env:USERNAME
$userHome = $env:USERPROFILE
$cursorDir = Join-Path $userHome '.cursor'
if (-not (Test-Path $cursorDir)) {
  New-Item -Path $cursorDir -ItemType Directory -Force | Out-Null
}

 $dest = Join-Path $cursorDir 'mcp.json'

$json = @"
{
  "mcpServers": {
    "vps-matricarmz": {
      "command": "npx",
      "args": [
        "-y",
        "ssh-mcp",
        "--host=a6fd55b8e0ae.vps.myjino.ru",
        "--port=49412",
        "--user=valstan",
        "--key=C:\\Users\\$($user)\\.ssh\\id_rsa",
        "--timeout=120000"
      ]
    }
  }
}
"@

Set-Content -Path $dest -Value $json -Encoding UTF8

Write-Host "Wrote MCP config to: $dest"
Write-Host "Next steps:"
Write-Host "  1) Ensure you have an SSH key at: $userHome\.ssh\id_rsa (generate with ssh-keygen if needed)."
Write-Host "  2) Add the public key ($userHome\.ssh\id_rsa.pub) to the VPS ~/.ssh/authorized_keys for user 'valstan'."
Write-Host "  3) Open Cursor → Settings → MCP and Restart MCP server."
Write-Host "  4) Check logs: %APPDATA%\\Cursor\\logs\\<session>\\<window>\\exthost\\anysphere.cursor-mcp\\MCP user-vps-matricarmz.log"
