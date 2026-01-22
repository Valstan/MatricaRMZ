; NSIS customization for a one-click installer with progress only.

!include "MUI2.nsh"

; Only show install progress page (no dialogs/buttons).
!insertmacro MUI_PAGE_INSTFILES

; Terminate any running client instances before install.
!macro KillClientProcesses
  ; Ignore errors if process is not running.
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "MatricaRMZ.exe"'
  Sleep 300
!macroend

!macro customInit
  !insertmacro KillClientProcesses
!macroend

!macro customCheckAppRunning
  !insertmacro KillClientProcesses
!macroend

