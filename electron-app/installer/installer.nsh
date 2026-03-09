; NSIS customization for a one-click installer with progress only.

!include "MUI2.nsh"

; Show install progress page.
!insertmacro MUI_PAGE_INSTFILES

!macro CheckClientRunning outVar
  nsExec::ExecToStack '"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH | find /I "${APP_EXECUTABLE_FILENAME}" >NUL'
  Pop $R0
  Pop $R1
  StrCpy ${outVar} "1"
  StrCmp $R0 "0" +2
  StrCpy ${outVar} "0"
!macroend

; Terminate any running client instances before install.
!macro KillClientProcesses
  StrCpy $R2 "0"
killRetry:
  !insertmacro CheckClientRunning $R0
  StrCmp $R0 "0" killDone doSoftClose

doSoftClose:
  DetailPrint "Обнаружен ${APP_EXECUTABLE_FILENAME}. Пытаемся закрыть корректно..."
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}"'
  Sleep 3000

  !insertmacro CheckClientRunning $R0
  StrCmp $R0 "0" killDone askUser

askUser:
  IntOp $R2 $R2 + 1
  StrCmp $R2 "4" cancelInstall
  MessageBox MB_YESNO|MB_ICONEXCLAMATION "${APP_EXECUTABLE_FILENAME} все еще запущена и блокирует установку.$\r$\nЗавершить её принудительно?" IDYES forceClose IDNO killRetry

forceClose:
  DetailPrint "Пользователь выбрал принудительное закрытие ${APP_EXECUTABLE_FILENAME}."
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}"'
  Sleep 2000
  !insertmacro CheckClientRunning $R0
  StrCmp $R0 "0" killDone askUser

cancelInstall:
  Abort "Установка отменена: закройте MatricaRMZ и запустите установку снова."

killDone:
!macroend

; Terminate any running client instances before uninstall/update check in uninstall context.
!macro KillClientProcessesUninstall
  !insertmacro CheckClientRunning $R0
  StrCmp $R0 "0" killDoneUninstall doSoftCloseUninstall

doSoftCloseUninstall:
  DetailPrint "Обнаружен ${APP_EXECUTABLE_FILENAME}. Пытаемся закрыть корректно..."
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}"'
  Sleep 3000

  !insertmacro CheckClientRunning $R0
  StrCmp $R0 "0" killDoneUninstall forceCloseUninstall

forceCloseUninstall:
  DetailPrint "Пользователь выбрал принудительное закрытие ${APP_EXECUTABLE_FILENAME}."
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}"'
  Sleep 2000
  !insertmacro CheckClientRunning $R0
  StrCmp $R0 "0" killDoneUninstall cancelInstallUninstall

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

