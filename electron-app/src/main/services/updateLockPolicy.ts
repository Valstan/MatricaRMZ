// Политика снятия «залипшего» update.lock. Чистый модуль (без electron/IO) — тестируется напрямую.

/**
 * Порог, после которого lock считается протухшим, если владельца опознать не удалось.
 * ДОЛЖЕН совпадать с порогом в acquireUpdateLock: раньше recover снимал lock немедленно,
 * а acquire держал его 2 часа — два механизма противоречили друг другу.
 */
export const UPDATE_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Состояние процесса, записавшего lock: жив / завершился / pid не прочитан. */
export type UpdateLockOwnerState = 'alive' | 'gone' | 'unknown';

export type StaleLockDecision = { release: boolean; reason: string };

/**
 * Снимать ли lock при старте клиента.
 *
 * Ключевое: живого владельца не трогаем. Раньше recoverStuckUpdateState снимал lock
 * безусловно и заодно стирал дельта-базис — закрытие клиента посреди загрузки обновления
 * приводило к тому, что при следующем запуске топливо для delta исчезало, и клиент
 * начинал качать полный installer (~136 МБ) заново. На заводском канале обновление
 * не доезжало никогда.
 */
export function decideStaleLock(args: {
  owner: UpdateLockOwnerState;
  lockAgeMs: number;
  maxAgeMs?: number;
}): StaleLockDecision {
  const maxAgeMs = args.maxAgeMs ?? UPDATE_LOCK_MAX_AGE_MS;
  // Возраст побеждает живость: PID переиспользуются, и чужой процесс с тем же номером
  // иначе заморозил бы обновления навсегда. Реальная загрузка укладывается в минуты.
  if (args.lockAgeMs > maxAgeMs) {
    return { release: true, reason: `lock older than ${Math.round(maxAgeMs / 60_000)}m` };
  }
  if (args.owner === 'alive') {
    return { release: false, reason: 'owner process alive' };
  }
  if (args.owner === 'gone') {
    return { release: true, reason: 'owner process gone' };
  }
  return { release: false, reason: 'owner unknown, lock still fresh' };
}

/**
 * Временный файл сборки delta (`<installer>.delta-new.exe`, см. deltaAssemblyTempPath).
 * Единственное, что recover вправе удалить: недособранный кусок мёртвого процесса.
 * Топливо delta — сам installer, его `.blockmap` и `.cache.json` — обязано пережить recover.
 */
export function isDeltaAssemblyLeftover(fileName: string, stableInstallerName: string): boolean {
  return fileName === `${stableInstallerName}.delta-new.exe`;
}
