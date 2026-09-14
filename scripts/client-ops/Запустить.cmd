@echo off
rem MatricaRMZ maintenance window - tabs for every park utility.
rem The script asks for administrator rights itself and keeps working without them.
start "" powershell -sta -NoProfile -ExecutionPolicy Bypass -File "%~dp0matrica-ops.ps1"
