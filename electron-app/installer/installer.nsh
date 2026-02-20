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

!macro CleanupMatricaFiles
  ; Installation folders (local and possible historical machine-wide installs).
  RMDir /r "$LOCALAPPDATA\Programs\MatricaRMZ"
  RMDir /r "$PROGRAMFILES\MatricaRMZ"
  RMDir /r "$PROGRAMFILES64\MatricaRMZ"

  ; Local app data and settings.
  RMDir /r "$APPDATA\MatricaRMZ"
  RMDir /r "$APPDATA\matricarmz"
  RMDir /r "$LOCALAPPDATA\MatricaRMZ"
  RMDir /r "$LOCALAPPDATA\matricarmz"

  ; Update caches.
  RMDir /r "$PROFILE\Downloads\MatricaRMZ-Updates"
  RMDir /r "$APPDATA\MatricaRMZ-Updates"
  RMDir /r "$APPDATA\matricarmz-updates"
  RMDir /r "$LOCALAPPDATA\MatricaRMZ-Updates"
  RMDir /r "$LOCALAPPDATA\matricarmz-updates"
!macroend

!macro customInit
  !insertmacro KillClientProcesses
  IfSilent mode_normal mode_prompt
mode_prompt:
  MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON1 \
    "Выберите режим установки обновления:$\r$\n$\r$\nДа — Обновить программу.$\r$\nНет — Полная установка с нуля (удалит локальные файлы и папки MatricaRMZ, данные подтянутся с сервера заново)." \
    IDYES mode_normal
  DetailPrint "Режим установки: Полная установка с нуля"
  !insertmacro CleanupMatricaFiles
  Goto mode_done
mode_normal:
  DetailPrint "Режим установки: Обновить программу"
mode_done:
!macroend

!macro customCheckAppRunning
  !insertmacro KillClientProcesses
!macroend

