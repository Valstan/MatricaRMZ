; NSIS customization for a one-click installer with progress only.

!include "MUI2.nsh"
; Show install progress page.
!insertmacro MUI_PAGE_INSTFILES

; Terminate any running client instances before install.
!macro KillClientProcesses
  ; Graceful close without forceful termination.
  ; Ignore errors if process is not running.
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM "MatricaRMZ.exe"'
  Sleep 1200
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
  !insertmacro KillClientProcesses
!macroend

