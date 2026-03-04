; NSIS customization for a one-click installer with progress only.

!include "MUI2.nsh"
; Show install progress page.
!insertmacro MUI_PAGE_INSTFILES

Function IsClientRunning
  nsExec::ExecToStack '"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq MatricaRMZ.exe" /NH | find /I "MatricaRMZ.exe" >NUL'
  Pop $R0
  Pop $R1
  StrCmp $R0 "0" done
  StrCpy $R0 "1"
done:
FunctionEnd

Function un.IsClientRunning
  Call IsClientRunning
FunctionEnd

; Terminate any running client instances before install.
!macro KillClientProcesses
  StrCpy $R2 "0"
killRetry:
  Call IsClientRunning
  StrCmp $R0 "0" doSoftClose killDone

doSoftClose:
  DetailPrint "Обнаружен MatricaRMZ.exe. Пытаемся закрыть корректно..."
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM "MatricaRMZ.exe"'
  Sleep 3000

  Call IsClientRunning
  StrCmp $R0 "0" askUser killDone

askUser:
  IntOp $R2 $R2 + 1
  StrCmp $R2 "4" cancelInstall
  MessageBox MB_ABORTRETRYIGNORE|MB_ICONEXCLAMATION \
    "Программа MatricaRMZ все еще запущена и блокирует установку.$\r$\n$\r$\nRetry: закройте MatricaRMZ вручную и повторите.$\r$\nIgnore: принудительно закрыть MatricaRMZ.$\r$\nAbort: отменить установку." \
    IDRETRY killRetry IDIGNORE forceClose IDABORT cancelInstall

forceClose:
  DetailPrint "Пользователь выбрал принудительное закрытие MatricaRMZ.exe."
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM "MatricaRMZ.exe"'
  Sleep 2000
  Call IsClientRunning
  StrCmp $R0 "0" askUser killDone

cancelInstall:
  Abort "Установка отменена: закройте MatricaRMZ и запустите установку снова."

killDone:
!macroend

; Terminate any running client instances before uninstall/update check in uninstall context.
!macro KillClientProcessesUninstall
  StrCpy $R2 "0"
killRetryUninstall:
  Call un.IsClientRunning
  StrCmp $R0 "0" doSoftCloseUninstall killDoneUninstall

doSoftCloseUninstall:
  DetailPrint "Обнаружен MatricaRMZ.exe. Пытаемся закрыть корректно..."
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM "MatricaRMZ.exe"'
  Sleep 3000

  Call un.IsClientRunning
  StrCmp $R0 "0" askUserUninstall killDoneUninstall

askUserUninstall:
  IntOp $R2 $R2 + 1
  StrCmp $R2 "4" cancelInstallUninstall
  MessageBox MB_ABORTRETRYIGNORE|MB_ICONEXCLAMATION \
    "Программа MatricaRMZ все еще запущена и блокирует установку.$\r$\n$\r$\nRetry: закройте MatricaRMZ вручную и повторите.$\r$\nIgnore: принудительно закрыть MatricaRMZ.$\r$\nAbort: отменить установку." \
    IDRETRY killRetryUninstall IDIGNORE forceCloseUninstall IDABORT cancelInstallUninstall

forceCloseUninstall:
  DetailPrint "Пользователь выбрал принудительное закрытие MatricaRMZ.exe."
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM "MatricaRMZ.exe"'
  Sleep 2000
  Call un.IsClientRunning
  StrCmp $R0 "0" askUserUninstall killDoneUninstall

cancelInstallUninstall:
  Abort "Установка отменена: закройте MatricaRMZ и запустите установку снова."

killDoneUninstall:
!macroend

!macro CleanupMatricaFiles
  ; Installation folders (local and possible historical machine-wide installs).
  RMDir /r "$LOCALAPPDATA\Programs\MatricaRMZ"
  RMDir /r "$PROGRAMFILES\MatricaRMZ"
  RMDir /r "$PROGRAMFILES64\MatricaRMZ"

  ; Update caches.
  RMDir /r "$PROFILE\Downloads\MatricaRMZ-Updates"
  RMDir /r "$APPDATA\MatricaRMZ-Updates"
  RMDir /r "$APPDATA\matricarmz-updates"
  RMDir /r "$LOCALAPPDATA\MatricaRMZ-Updates"
  RMDir /r "$LOCALAPPDATA\matricarmz-updates"
!macroend

!macro customInit
  !insertmacro KillClientProcesses
  DetailPrint "Режим установки: Автоматическая переустановка"
  !insertmacro CleanupMatricaFiles
!macroend

!macro customCheckAppRunning
  !insertmacro KillClientProcessesUninstall
!macroend

