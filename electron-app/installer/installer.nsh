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
  ; Historical/mistaken install folders only. NOTE: the REAL per-user install dir is
  ; "$LOCALAPPDATA\Programs\@matricarmzelectron-app" (electron-builder derives it from
  ; the sanitized package.json `name`, not productName) — it is intentionally NOT wiped
  ; here: electron-builder's own one-click installer manages replacing it. The paths
  ; below never exist on current installs; kept as best-effort cleanup of legacy layouts.
  ;
  ; No $PROGRAMFILES* entries here on purpose: a recursive delete aimed at a protected
  ; system folder from a non-elevated installer is logged as suspicious by Kaspersky and
  ; Defender even when it fails, and those folders never existed on real installs.
  ; RMDir removes exactly the named directory — the siblings "MatricaRMZ-Watchdog" and
  ; "MatricaRMZ-Updates" under the same parent are NOT matched by the line below.
  RMDir /r "$LOCALAPPDATA\Programs\MatricaRMZ"

  ; Update caches. The current default cache is "$LOCALAPPDATA\Programs\MatricaRMZ-Updates"
  ; and MUST NOT be listed here: the installer is normally launched FROM it, and wiping it
  ; on every install would delete the very file being run plus the delta-build cache.
  ; The Downloads entry stays — it clears the pre-2026-08 default on migrating clients.
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

; --- Watchdog (external recovery agent) ------------------------------------
; The watchdog is a tiny external Go binary launched by a per-user Scheduled
; Task. It must live OUTSIDE the install dir ("$LOCALAPPDATA\Programs\
; @matricarmzelectron-app") — the one-click installer replaces that dir on every
; update, and the watchdog's whole purpose is to recover when that replacement
; is left half-done.
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
  ; Refresh the bundled binary on every install/update (best-effort — a CopyFiles
  ; failure must not break the app install).
  CopyFiles /SILENT "$INSTDIR\resources\matricarmz-watchdog.exe" "$LOCALAPPDATA\Programs\MatricaRMZ-Watchdog"
  ; Per-user Scheduled Tasks (no admin rights): fast reaction at logon plus a
  ; steady 15-min cadence. /F overwrites so the path stays current across
  ; updates — including the one that moves the exe here. nsExec only logs; a
  ; schtasks failure never aborts the install.
  nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /Create /F /RL LIMITED /SC ONLOGON /TN "MatricaRMZ\Watchdog Logon" /TR "\"$LOCALAPPDATA\Programs\MatricaRMZ-Watchdog\matricarmz-watchdog.exe\""'
  nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /Create /F /RL LIMITED /SC MINUTE /MO 15 /TN "MatricaRMZ\Watchdog Periodic" /TR "\"$LOCALAPPDATA\Programs\MatricaRMZ-Watchdog\matricarmz-watchdog.exe\""'
!macroend

!macro RemoveWatchdog
  nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /Delete /F /TN "MatricaRMZ\Watchdog Logon"'
  nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /Delete /F /TN "MatricaRMZ\Watchdog Periodic"'
  ; Only the watchdog binary — never its data dir (handshake/log/state) and never
  ; the app's userData. The Roaming path is the pre-2026-08 home: an update runs the
  ; OLD uninstaller first, so this line also clears the stale copy on migrating
  ; clients; keep it until the fleet is known to be past that release.
  Delete "$LOCALAPPDATA\Programs\MatricaRMZ-Watchdog\matricarmz-watchdog.exe"
  RMDir "$LOCALAPPDATA\Programs\MatricaRMZ-Watchdog"
  Delete "$APPDATA\MatricaRMZ\matricarmz-watchdog.exe"
!macroend

!macro customInstall
  !insertmacro InstallWatchdog
!macroend

!macro customUnInstall
  !insertmacro RemoveWatchdog
!macroend

