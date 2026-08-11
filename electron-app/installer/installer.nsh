; NSIS customization for a one-click installer with progress only.

!include "MUI2.nsh"

; Show install progress page.
!insertmacro MUI_PAGE_INSTFILES

; Возвращает "1", если клиент запущен, иначе "0".
;
; ⚠️ Код возврата nsExec ОБЯЗАН лежать в регистре, отличном от outVar. Все вызовы
; передают сюда $R0, а макрос NSIS — текстовая подстановка: `StrCpy ${outVar} "1"`
; разворачивался в `StrCpy $R0 "1"` и затирал код возврата ДО сравнения, поэтому
; StrCmp никогда не совпадал и макрос всегда отвечал «не запущен». Следствие было
; хуже мёртвого taskkill: раз в файле объявлен customCheckAppRunning, electron-builder
; подменяет им СВОЙ рабочий _CHECK_APP_RUNNING — то есть штатное закрытие приложения
; тоже было выключено, и установка поверх живого клиента падала на занятом файле.
!macro CheckClientRunning outVar
  nsExec::ExecToStack '"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH | find /I "${APP_EXECUTABLE_FILENAME}" >NUL'
  Pop $R8
  Pop $R9
  StrCpy ${outVar} "1"
  StrCmp $R8 "0" +2
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
  ; /SD IDYES: the watchdog reinstalls silently (`/S`), where this box is never drawn —
  ; without a silent default the install would hang on an invisible dialog and abort by
  ; the retry counter, exactly when the app is already broken.
  MessageBox MB_YESNO|MB_ICONEXCLAMATION "${APP_EXECUTABLE_FILENAME} все еще запущена и блокирует установку.$\r$\nЗавершить её принудительно?" /SD IDYES IDYES forceClose IDNO killRetry

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
  ; Historical/mistaken layouts only — never the CURRENT install dir.
  ;
  ; ⚠️ Здесь раньше стояло `RMDir /r "$LOCALAPPDATA\Programs\MatricaRMZ"` как чистка
  ; «ошибочной» папки, которой на реальных установках не бывает. С переездом каталога
  ; установки (см. preInit) это ровно тот путь, куда ставится клиент, а CleanupMatricaFiles
  ; вызывается из customInit — то есть строка снесла бы установку на каждом обновлении.
  ; Прежний каталог "@matricarmzelectron-app" отсюда тоже не трогаем: его штатно удаляет
  ; старый деинсталлятор, а хвост подбирает клиент (sweepLegacyInstallDir) — установщик
  ; в этот момент может быть запущен из процесса, который ещё держит те файлы.
  ;
  ; No $PROGRAMFILES* entries here on purpose: a recursive delete aimed at a protected
  ; system folder from a non-elevated installer is logged as suspicious by Kaspersky and
  ; Defender even when it fails, and those folders never existed on real installs.

  ; Update caches. The current default cache is "$LOCALAPPDATA\Programs\MatricaRMZ-Updates"
  ; and MUST NOT be listed here: the installer is normally launched FROM it, and wiping it
  ; on every install would delete the very file being run plus the delta-build cache.
  ; The Downloads entry stays — it clears the pre-2026-08 default on migrating clients.
  RMDir /r "$PROFILE\Downloads\MatricaRMZ-Updates"
  RMDir /r "$APPDATA\MatricaRMZ-Updates"
  RMDir /r "$APPDATA\matricarmz-updates"
  RMDir /r "$LOCALAPPDATA\MatricaRMZ-Updates"
  RMDir /r "$LOCALAPPDATA\matricarmz-updates"

  ; Хвост прежней раскладки — неподписанный сторож в Roaming. Штатно его убирает
  ; СТАРЫЙ деинсталлятор, но uninstallOldVersion молча возвращается, если в реестре
  ; нет UninstallString (а это ровно состояние «установка порвана» — то есть машины,
  ; где переустановку запускает сам сторож). Здесь удаление безусловное. Данные
  ; сторожа (watchdog.json/log/state) и client-id не трогаем — только .exe.
  Delete "$APPDATA\MatricaRMZ\matricarmz-watchdog.exe"
!macroend

; --- Каталог установки ------------------------------------------------------
; electron-builder при `oneClick` + `perMachine: false` берёт имя папки из `name`
; пакета, а не из productName: getWindowsInstallationDirName(appInfo, !oneClick ||
; isPerMachine) получает false и уходит на appInfo.sanitizedName — отсюда и брался
; "@matricarmzelectron-app". Переименовать `name` нельзя: он же задаёт userData
; ("$APPDATA\@matricarmz\electron-app"), где лежат локальная SQLite-реплика, ключ БД
; и ledger-ключ клиента — смена имени увела бы каждую машину парка на пустой каталог
; с полным ре-sync и потерей ledger-ключа.
;
; Поэтому путь задаётся здесь, через реестр: setInstallModePerUser читает
; InstallLocation ПЕРВЫМ и вычисляет дефолт, только если значения нет. preInit
; выполняется раньше check64BitAndSetRegView, поэтому вид реестра выставляем сами
; (сборка x64 → SetRegView 64, как это потом делает и сам установщик).
!macro preInit
  !ifndef BUILD_UNINSTALLER
    SetShellVarContext current
    SetRegView 64
    WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\MatricaRMZ"
  !endif
!macroend

!macro customInit
  !insertmacro KillClientProcesses
  DetailPrint "Режим установки: Автоматическая переустановка"
  !insertmacro CleanupMatricaFiles
!macroend

!macro customCheckAppRunning
  !insertmacro KillClientProcessesUninstall
!macroend

; --- Watchdog (external recovery agent) ------------------------------------
; The watchdog is a tiny external Go binary launched by a per-user Scheduled
; Task. It must live OUTSIDE the install dir ("$LOCALAPPDATA\Programs\MatricaRMZ")
; — the one-click installer replaces that dir on every update, and the watchdog's
; whole purpose is to recover when that replacement is left half-done.
;
; It lives in a SIBLING folder under "$LOCALAPPDATA\Programs" rather than in
; "$APPDATA\MatricaRMZ" (its pre-2026-08 home): running an unsigned exe out of
; Roaming AppData on a schedule is a top behavioural-analysis trigger, and with
; every executable of the product now under one parent, a single Kaspersky
; exclusion covers the whole set. Note "$APPDATA\MatricaRMZ" is NOT the app's
; userData dir (that is "$APPDATA\@matricarmz\electron-app") — it only holds the
; watchdog's data files: handshake, log and state. Those stay where they are; the
; Go binary reads them from %APPDATA% and is unaffected by this move.
!macro InstallWatchdog
  CreateDirectory "$LOCALAPPDATA\Programs\MatricaRMZ-Watchdog"
  ; Хвост прошлой замены (см. ниже) — подбираем, когда файл уже разблокирован.
  Delete "$LOCALAPPDATA\Programs\MatricaRMZ-Watchdog\matricarmz-watchdog.exe.old"
  ; Сторож сам мог запустить эту установку (восстановление сломанного клиента) и
  ; ждёт её завершения — тогда его образ ЗАБЛОКИРОВАН, и CopyFiles молча не
  ; перезапишет .exe: версия сторожа заморозилась бы навсегда именно на тех машинах,
  ; где он нужнее всего. Rename занятый образ разрешает — уводим в сторону и копируем
  ; на освободившееся имя. Ошибки игнорируются: сбой обновления сторожа не должен
  ; ронять установку клиента (best-effort, как и раньше).
  ClearErrors
  Rename "$LOCALAPPDATA\Programs\MatricaRMZ-Watchdog\matricarmz-watchdog.exe" "$LOCALAPPDATA\Programs\MatricaRMZ-Watchdog\matricarmz-watchdog.exe.old"
  ClearErrors
  CopyFiles /SILENT "$INSTDIR\resources\matricarmz-watchdog.exe" "$LOCALAPPDATA\Programs\MatricaRMZ-Watchdog"
  ClearErrors
  Delete "$LOCALAPPDATA\Programs\MatricaRMZ-Watchdog\matricarmz-watchdog.exe.old"
  ClearErrors
  ; Per-user Scheduled Tasks (no admin rights): fast reaction at logon plus a
  ; steady 15-min cadence. /F overwrites so the path stays current across
  ; updates — including the one that moves the exe here. nsExec only logs; a
  ; schtasks failure never aborts the install.
  nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /Create /F /RL LIMITED /SC ONLOGON /TN "MatricaRMZ\Watchdog Logon" /TR "\"$LOCALAPPDATA\Programs\MatricaRMZ-Watchdog\matricarmz-watchdog.exe\""'
  nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /Create /F /RL LIMITED /SC MINUTE /MO 15 /TN "MatricaRMZ\Watchdog Periodic" /TR "\"$LOCALAPPDATA\Programs\MatricaRMZ-Watchdog\matricarmz-watchdog.exe\""'
  ; Аварийная кнопка оператора: ярлык на `matricarmz-watchdog.exe --repair` —
  ; принудительный проход сторожа без ожидания расписания (15 мин). Иконка — от
  ; клиента: Go-бинарь сторожа собственной не несёт. Клиент поддерживает ярлык и
  ; сам (restoreShortcutsHeadless), поэтому удалённый оператором ярлык вернётся.
  CreateShortCut "$DESKTOP\Восстановить Матрицу РМЗ.lnk" "$LOCALAPPDATA\Programs\MatricaRMZ-Watchdog\matricarmz-watchdog.exe" "--repair" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend

; ⚠️ Вызывается из customUnInstall, а он выполняется и при ОБНОВЛЕНИИ: одноклик-апдейт
; сперва гоняет старый деинсталлятор и только потом распаковывает новую версию. Снимать
; задачи при обновлении нельзя — между этими шагами лежит вся распаковка (~136 МБ), и
; обрыв внутри окна оставлял бы машину без клиента И без сторожа, то есть без всякой
; возможности починиться самой. Ещё коварнее штатная ветка: если деинсталлятор упрётся
; в занятый файл, он делает Abort ПОСЛЕ customUnInstall — приложение откатывается и
; работает как ни в чём не бывало, а сторож удалён молча и навсегда.
; Поэтому при обновлении не трогаем ничего: `schtasks /Create /F` в InstallWatchdog
; перерегистрирует задачи с актуальным путём сам.
!macro RemoveWatchdog
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /Delete /F /TN "MatricaRMZ\Watchdog Logon"'
    nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /Delete /F /TN "MatricaRMZ\Watchdog Periodic"'
    ; Only the watchdog binary — never its data dir (handshake/log/state) and never
    ; the app's userData. The Roaming path is the pre-2026-08 home.
    Delete "$LOCALAPPDATA\Programs\MatricaRMZ-Watchdog\matricarmz-watchdog.exe"
    Delete "$LOCALAPPDATA\Programs\MatricaRMZ-Watchdog\matricarmz-watchdog.exe.old"
    RMDir "$LOCALAPPDATA\Programs\MatricaRMZ-Watchdog"
    Delete "$APPDATA\MatricaRMZ\matricarmz-watchdog.exe"
    Delete "$DESKTOP\Восстановить Матрицу РМЗ.lnk"
    ; Кэш обновлений живёт вне $INSTDIR, поэтому штатный деинсталлятор его не видит:
    ; без этой строки после честного удаления продукта на диске остаются 130+ МБ
    ; установщиков — ровно в той папке, на которую заведено исключение антивируса.
    RMDir /r "$LOCALAPPDATA\Programs\MatricaRMZ-Updates"
    ; Пустая папка «MatricaRMZ» в планировщике остаётся: schtasks удаляет задачи, но
    ; не каталоги. Косметика, отдельного кода (COM/PowerShell) ради неё не заводим.
  ${endIf}
!macroend

!macro customInstall
  !insertmacro InstallWatchdog
!macroend

!macro customUnInstall
  !insertmacro RemoveWatchdog
!macroend

