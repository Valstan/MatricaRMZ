; NSIS customization for a one-click installer with progress only.

!include "MUI2.nsh"

; Only show install progress page (no dialogs/buttons).
!insertmacro MUI_PAGE_INSTFILES

; Disable electron-builder app-running check completely.
!macro customCheckAppRunning
!macroend

