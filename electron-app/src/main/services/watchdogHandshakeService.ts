import { app, net, shell } from 'electron';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { getUpdatesRootDir } from './updatePaths.js';

const execFileAsync = promisify(execFile);

// Handshake the app publishes for the external watchdog (a separate Go binary
// launched by a Windows Scheduled Task). The watchdog cannot read the app's
// SQLite nor reverse-engineer Electron's productName-based userData dir, so the
// app writes everything the watchdog needs to a FIXED path it can compute from
// %APPDATA% alone:
//   %APPDATA%\MatricaRMZ\watchdog.json
// app.getPath('appData') is the roaming AppData ROOT (without the app name), so
// this path is stable regardless of how productName resolves. The file lives
// outside the install dir (which the NSIS installer wipes), so it survives a
// botched update — exactly the situation the watchdog exists to recover from.
export type WatchdogHandshake = {
  clientId: string;
  apiBaseUrl: string;
  version: string;
  appExePath: string;
  userDataDir: string;
  updatesRootDir: string;
  updaterLogPath: string;
  appLogPath: string;
  /**
   * Настоящая папка рабочего стола (бывает перенесена на другой диск). Сторож
   * проверяет по ней наличие ярлыка. Раньше он выяснял её сам — скрытым
   * `powershell -Command [Environment]::GetFolderPath('Desktop')` раз в 15 минут,
   * что для неподписанного бинаря по расписанию читается антивирусом как LOLBin.
   * Электрон знает путь нативно, поэтому отдаём готовым (ADR-0002).
   */
  desktopDir: string;
  /**
   * Клиент понимает `--restore-shortcuts` (headless-починка ярлыков). Фича-гейт для
   * сторожа: клиент СТАРЕЕ этого релиза неизвестный флаг игнорирует и стартует
   * целиком — окно, а сторож ждёт его закрытия всю смену. Такая связка достижима
   * (сторож при недоступном сервере ставит любой валидный установщик из кэша, в том
   * числе прошлой версии), поэтому право на запуск даёт handshake, а не догадка.
   */
  supportsRestoreShortcuts: boolean;
  updatedAtMs: number;
};

function handshakePath(): string {
  return join(app.getPath('appData'), 'MatricaRMZ', 'watchdog.json');
}

export async function writeWatchdogHandshake(args: {
  clientId: string;
  apiBaseUrl: string;
  version: string;
}): Promise<void> {
  if (process.platform !== 'win32') return;
  // Guard: the handshake path is FIXED and shared with the installed prod
  // client. A dev/CDP instance running on the same machine used to overwrite it
  // with its own appExePath (node_modules electron.exe) and apiBaseUrl
  // (localhost), leaving the watchdog pointed at a dev stack — observed live
  // 2026-08. Only a packaged, non-CDP-isolated instance may publish it.
  if (!app.isPackaged) return;
  if (app.getPath('userData').includes('-cdp-')) return;
  const clientId = String(args.clientId ?? '').trim();
  const apiBaseUrl = String(args.apiBaseUrl ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!clientId || !apiBaseUrl) return;
  const userDataDir = app.getPath('userData');
  const payload: WatchdogHandshake = {
    clientId,
    apiBaseUrl,
    version: String(args.version ?? '').trim(),
    appExePath: app.getPath('exe'),
    userDataDir,
    updatesRootDir: getUpdatesRootDir(),
    updaterLogPath: join(userDataDir, 'matricarmz-updater.log'),
    appLogPath: join(userDataDir, 'matricarmz.log'),
    desktopDir: app.getPath('desktop'),
    supportsRestoreShortcuts: true,
    updatedAtMs: Date.now(),
  };
  const target = handshakePath();
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    // Best-effort: the watchdog degrades gracefully if the handshake is absent
    // or stale — it falls back to the standard install path and server download.
  }
}

// Mutual heal: the watchdog restores a lost app, and the app restores a lost
// watchdog. The owner's machine lost the ENTIRE app dir (likely antivirus) —
// the same sweep can just as well take the watchdog exe or its scheduled
// tasks, and nothing recreated them until the next full installer run.
//
// Mirrors installer.nsh InstallWatchdog: same exe location, same task name and
// schedule, `/RL LIMITED`, per-user, no admin. schtasks.exe is the very tool NSIS
// uses, so per ADR-0002 it is an acceptable child process (unlike powershell).
//
// Только периодическая задача. Задачи «MatricaRMZ\Watchdog Logon» здесь нет
// намеренно: schtasks.exe не умеет создать logon-задачу для текущего пользователя
// без прав администратора. И `/SC ONLOGON`, и `/SC ONLOGON /RU <пользователь>`
// отвечают «Отказано в доступе», тогда как `/SC MINUTE` тем же вызовом проходит
// (замер на Windows 11 22631, 2026-08-26). Установщик ставится per-user и UAC не
// поднимает, поэтому такой задачи не было ни на одной машине парка, а heal при
// каждом старте клиента пытался создать её заново — девять неудач подряд в логе
// rmz4val, видимых только на самой машине. Автозапуск при входе теперь даёт
// ярлык в папке автозагрузки (см. ensureLogonShortcut).
const WATCHDOG_TASKS: ReadonlyArray<{ name: string; scheduleArgs: string[] }> = [
  { name: 'MatricaRMZ\\Watchdog Periodic', scheduleArgs: ['/SC', 'MINUTE', '/MO', '15'] },
];

/**
 * Итог прохода самолечения — чтобы неудача была видна не только в локальном логе.
 * `failures` перечисляет то, что починить не удалось: `watchdog-exe`,
 * `logon-shortcut`, либо имя задачи планировщика.
 */
export type WatchdogHealResult = {
  logonShortcutRestored: boolean;
  tasksRestored: string[];
  failures: string[];
};

/**
 * Ярлык автозапуска сторожа в папке автозагрузки текущего пользователя.
 *
 * Заменяет несоздаваемую задачу «Watchdog Logon» (см. WATCHDOG_TASKS): папка
 * автозагрузки прав администратора не требует, а .lnk пишется нативным
 * `shell.writeShortcutLink` — тем самым путём, которым ADR-0002 заменил COM-скрипты
 * под powershell. Сторож собран GUI-подсистемой (`-H=windowsgui`), поэтому окно
 * консоли при входе не мелькнёт.
 */
export function watchdogLogonShortcutPath(): string {
  return join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'MatricaRMZ Watchdog.lnk',
  );
}

export async function ensureWatchdogInstalled(log?: (line: string) => void): Promise<WatchdogHealResult> {
  const result: WatchdogHealResult = { logonShortcutRestored: false, tasksRestored: [], failures: [] };
  if (process.platform !== 'win32' || !app.isPackaged) return result;
  const localAppData = String(process.env.LOCALAPPDATA ?? '').trim();
  if (!localAppData) return result;
  const watchdogDir = join(localAppData, 'Programs', 'MatricaRMZ-Watchdog');
  const watchdogExe = join(watchdogDir, 'matricarmz-watchdog.exe');
  try {
    const existing = await stat(watchdogExe).catch(() => null);
    if (!existing || !existing.isFile() || existing.size === 0) {
      const bundled = join(process.resourcesPath, 'matricarmz-watchdog.exe');
      const source = await stat(bundled).catch(() => null);
      if (!source || !source.isFile() || source.size === 0) {
        log?.(`watchdog heal: exe missing and no bundled copy at ${bundled}`);
        result.failures.push('watchdog-exe');
        return result;
      }
      await mkdir(watchdogDir, { recursive: true });
      await copyFile(bundled, watchdogExe);
      log?.('watchdog heal: binary restored from app resources');
    }
  } catch (e) {
    log?.(`watchdog heal: binary restore failed: ${String(e)}`);
    result.failures.push('watchdog-exe');
    return result;
  }
  const schtasks = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe');
  for (const task of WATCHDOG_TASKS) {
    try {
      await execFileAsync(schtasks, ['/Query', '/TN', task.name], { windowsHide: true, timeout: 15_000 });
    } catch {
      try {
        // The quoted /TR value matches the installer: the task action must be
        // the quoted exe path.
        await execFileAsync(
          schtasks,
          ['/Create', '/F', '/RL', 'LIMITED', ...task.scheduleArgs, '/TN', task.name, '/TR', `"${watchdogExe}"`],
          { windowsHide: true, timeout: 15_000 },
        );
        log?.(`watchdog heal: scheduled task re-registered: ${task.name}`);
        result.tasksRestored.push(task.name);
      } catch (e) {
        log?.(`watchdog heal: schtasks create failed for ${task.name}: ${String(e)}`);
        result.failures.push(task.name);
      }
    }
  }
  await ensureLogonShortcut(watchdogExe, result, log);
  if (result.failures.length > 0) pendingAutostartFailure = result.failures.join(', ');
  return result;
}

// Heal отрабатывает один раз при старте, до того как известны clientId и адрес
// сервера, поэтому неудачу держим здесь до первого heartbeat'а — он и отправит её
// (см. reportWatchdogAutostartIfBroken).
let pendingAutostartFailure: string | null = null;

/**
 * Одноразовый отчёт «клиент не смог вернуть сторожу автозапуск» в «Критические
 * события». Без него такая поломка видна только в локальном логе машины: на
 * rmz4val девять неудач подряд за пять дней не заметил никто.
 */
export async function reportWatchdogAutostartIfBroken(args: {
  clientId: string;
  apiBaseUrl: string;
  version: string;
}): Promise<void> {
  const detail = pendingAutostartFailure;
  if (!detail) return;
  pendingAutostartFailure = null;
  const clientId = String(args.clientId ?? '').trim();
  const apiBaseUrl = String(args.apiBaseUrl ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!clientId || !apiBaseUrl) return;
  try {
    await net.fetch(`${apiBaseUrl}/client/watchdog/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId,
        kind: 'autostart_broken',
        version: String(args.version ?? '').trim(),
        detail: `Не восстановлено: ${detail}`,
      }),
    });
  } catch {
    // Best-effort: сервер недоступен — отчёт просто теряется, следующий старт
    // клиента отправит его заново, если поломка не починилась.
  }
}

async function ensureLogonShortcut(
  watchdogExe: string,
  result: WatchdogHealResult,
  log?: (line: string) => void,
): Promise<void> {
  const shortcutPath = watchdogLogonShortcutPath();
  const existing = await stat(shortcutPath).catch(() => null);
  if (existing?.isFile() && existing.size > 0) return;
  try {
    // Только 'create': на отсутствующем файле 'replace' возвращает false, ничего не
    // создавая (та же грабля, что в restoreShortcutsHeadless).
    const written = shell.writeShortcutLink(shortcutPath, 'create', {
      target: watchdogExe,
      cwd: dirname(watchdogExe),
      // У Go-бинаря сторожа нет ресурса иконки — берём иконку клиента, как это
      // делает аварийный ярлык «Восстановить Матрицу РМЗ».
      icon: app.getPath('exe'),
      iconIndex: 0,
    });
    if (written) {
      result.logonShortcutRestored = true;
      log?.('watchdog heal: logon autostart shortcut restored');
    } else {
      result.failures.push('logon-shortcut');
      log?.(`watchdog heal: writeShortcutLink returned false for ${shortcutPath}`);
    }
  } catch (e) {
    result.failures.push('logon-shortcut');
    log?.(`watchdog heal: logon autostart shortcut failed: ${String(e)}`);
  }
}
