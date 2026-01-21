; NSIS customization for a minimal interactive installer.
; Keep a single "Install" button and skip directory/license steps.

!include "MUI2.nsh"

!define MUI_TEXT_INSTALLBUTTON "Установить"
!define MUI_TEXT_FINISH_INFO_TITLE "Готово"
!define MUI_TEXT_FINISH_INFO_TEXT "Установка завершена. Программа будет запущена."

; Only show install progress and finish pages.
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_LANGUAGE "Russian"
