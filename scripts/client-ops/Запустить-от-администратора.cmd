@echo off
rem Same window, elevated straight away - skips the script's own UAC attempt.
rem Needed on machines where the operator runs cmd as a different (admin) account.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-sta','-NoProfile','-ExecutionPolicy','Bypass','-File','\"%~dp0matrica-ops.ps1\"'"
