import { dirname, join } from 'node:path';

import { shell } from 'electron';

/**
 * Автозапуск клиента (C9, план client-stability-and-ai-2026-10): Матрица стартует
 * вместе с компьютером, свёрнуто в трей. Per-user, без админа — ярлык в папке
 * автозагрузки (тот же приём, что у сторожа: задачи планировщика обычным
 * пользователем не заводятся, см. installer.nsh). Установщик кладёт ярлык при
 * установке/обновлении; клиент на каждом упакованном старте проверяет его
 * наличие и чинит отсутствующий/сломанный (требование владельца: «клиент сам
 * восстанавливает удалённую запись»). В dev/не-Windows — no-op.
 *
 * Ярлык запускает с `--minimized`: окно не показывается, живёт только трей.
 */
export const CLIENT_AUTOSTART_SHORTCUT_NAME = 'MatricaRMZ.lnk';
export const CLIENT_AUTOSTART_ARGS = '--minimized';

/** Переопределение каталога автозагрузки ( dev/стенд: не гадить в настоящий Startup). */
export function resolveStartupDir(appDataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = String(env.MATRICA_AUTOSTART_DIR ?? '').trim();
  if (override) return override;
  return join(appDataDir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

/** Запуск свёрнуто в трей: флаг ярлыка или env (env — для dev/стенда, где ярлыков нет). */
export function isMinimizedLaunch(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  return argv.includes(CLIENT_AUTOSTART_ARGS) || String(env.MATRICA_START_MINIMIZED ?? '') === '1';
}

export function clientAutostartShortcutPath(startupDir: string): string {
  return join(startupDir, CLIENT_AUTOSTART_SHORTCUT_NAME);
}

/**
 * Чинит запись автозапуска (best-effort, не бросает): всегда 'create' — он и
 * создаёт отсутствующий ярлык, и чинит существующий с неверной целью/аргументами
 * ('replace' на отсутствующем файле возвращает false, проверено на Electron 43).
 */
export function ensureClientAutostart(deps: {
  platform?: string;
  isPackaged?: boolean;
  execPath: string;
  startupDir: string;
  writeShortcutLink?: (path: string, operation: string, options: Record<string, unknown>) => boolean;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const { platform = process.platform, isPackaged = false, env = process.env } = deps;
  if (platform !== 'win32') return false;
  // Dev/стенд: настоящий Startup не трогаем никогда — только явный override.
  if (!isPackaged && !String(env.MATRICA_AUTOSTART_DIR ?? '').trim()) return false;
  try {
    const write = deps.writeShortcutLink ?? shell.writeShortcutLink;
    const written = write(clientAutostartShortcutPath(deps.startupDir), 'create', {
      target: deps.execPath,
      args: CLIENT_AUTOSTART_ARGS,
      cwd: dirname(deps.execPath),
      appUserModelId: 'ru.matricarmz.app',
    });
    if (!written) deps.log?.(`client-autostart: writeShortcutLink returned false for ${deps.startupDir}`);
    return written;
  } catch (e) {
    deps.log?.(`client-autostart failed: ${String(e)}`);
    return false;
  }
}
