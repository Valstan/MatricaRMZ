; NSIS customization for a minimal interactive installer.
; Keep a single "Install" button and skip directory/license steps.

!include "MUI2.nsh"

!define MUI_TEXT_INSTALLBUTTON "Установить"
!define MUI_TEXT_FINISH_INFO_TITLE "Готово"
!define MUI_TEXT_FINISH_INFO_TEXT "Установка завершена. Программа будет запущена."

; Only show install progress and finish pages.
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

; Override electron-builder app-running check:
; do not close the app, only warn and ask to retry.
!macro customCheckAppRunning
  check_app_running:
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
        "Программа ${PRODUCT_NAME} сейчас запущена. Закройте ее и нажмите 'Повторить' для продолжения установки." \
        /SD IDCANCEL IDRETRY check_app_running
      Quit
    ${endif}
!macroend

