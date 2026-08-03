// Платформенные хуки android-порта. Изменяемое состояние, которое boot-код
// приложения выставляет ДО использования портированных сервисов.
// Шимы (electron.ts и др.) читают отсюда, чтобы не тащить Capacitor-зависимости
// в модули, гоняемые vitest'ом на десктопе.

export type AndroidPlatformHooks = {
  /**
   * Доступно ли защищённое хранение секретов. На Android true означает:
   * ключ SQLCipher-реплики лежит в Keystore и БД зашифрована — тогда сессия
   * может жить в sync_state ВНУТРИ шифрованной БД (identity-«шифрование» в
   * safeStorage-шиме; двойного слоя, как DPAPI на Windows, здесь нет — слой
   * ровно один, SQLCipher). false — fail-closed: сессия только в памяти,
   * перелогин после рестарта (то же правило, что на десктопе без keyring).
   */
  encryptionAvailable: () => boolean;
  /** Перезапуск приложения (reset-флоу синка). На Android — пересоздание WebView/Activity. */
  relaunch: () => void;
  /** Версия приложения для heartbeat/диагностики. */
  appVersion: () => string;
};

let hooks: AndroidPlatformHooks = {
  encryptionAvailable: () => false,
  relaunch: () => {
    throw new Error('android platform hooks не инициализированы: relaunch');
  },
  appVersion: () => '0.0.0-android-dev',
};

export function setAndroidPlatformHooks(next: Partial<AndroidPlatformHooks>): void {
  hooks = { ...hooks, ...next };
}

export function getAndroidPlatformHooks(): AndroidPlatformHooks {
  return hooks;
}
