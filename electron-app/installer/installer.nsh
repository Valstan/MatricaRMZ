; NSIS customization for a one-click installer with progress only.

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"

Var MatricaUpdateChoice

Page custom SelectInstallMode SelectInstallModeLeave
; Show install progress page.
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
  StrCpy $MatricaUpdateChoice "update"
!macroend

!macro customCheckAppRunning
  !insertmacro KillClientProcesses
!macroend

Function SelectInstallMode
  IfSilent skip_prompt

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "Режим установки обновления" "Выберите вариант установки MatricaRMZ"

  ${NSD_CreateLabel} 0 0 100% 30u "Выберите режим установки обновления.$\r$\n$\r$\nОбновление программы сохранит локальные файлы.$\r$\nПолная установка удалит локальные файлы MatricaRMZ и загрузит данные с сервера заново."
  Pop $1

  ${NSD_CreateButton} 0 42u 100% 18u "Обновить программу"
  Pop $2
  ${NSD_OnClick} $2 SelectInstallModeUpdateClick

  ${NSD_CreateButton} 0 66u 100% 18u "Полная установка с нуля"
  Pop $3
  ${NSD_OnClick} $3 SelectInstallModeCleanClick

  ; Hide default navigation buttons to keep only explicit choices.
  GetDlgItem $4 $HWNDPARENT 1
  ShowWindow $4 ${SW_HIDE}
  GetDlgItem $4 $HWNDPARENT 3
  ShowWindow $4 ${SW_HIDE}

  nsDialogs::Show
  Return

skip_prompt:
  Abort
FunctionEnd

Function SelectInstallModeUpdateClick
  StrCpy $MatricaUpdateChoice "update"
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
FunctionEnd

Function SelectInstallModeCleanClick
  StrCpy $MatricaUpdateChoice "clean"
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
FunctionEnd

Function SelectInstallModeLeave
  ${If} $MatricaUpdateChoice == "clean"
    DetailPrint "Режим установки: Полная установка с нуля"
    !insertmacro CleanupMatricaFiles
  ${Else}
    DetailPrint "Режим установки: Обновить программу"
  ${EndIf}
FunctionEnd

