// Платформенный хост движка синка. Появился потому, что `SyncManager` и `syncService`
// переезжают в отдельный процесс (`utilityProcess`), а там из Electron доступны только
// `net` и `systemPreferences` — `app` нет вовсе (проверено живьём на Electron 43).
// Всё, что движку нужно от приложения, приходит сюда регистрацией, а не импортом.
//
// Модуль намеренно без единого node/electron-импорта: его тянут и main, и воркер, и
// android-порт (где `app` — шим).
export type SyncHost = {
  /** Каталог приложения (pending-export, лог). */
  userDataPath: () => string;
  /** Версия приложения — представляется серверу в диагностике. */
  appVersion: () => string;
  /** Перезапуск после пересоздания локальной базы. */
  relaunch: () => void;
  exit: (code: number) => void;
  /** Строка в `matricarmz.log` (у воркера — тот же файл, дописывание). */
  appendLog: (line: string) => void;
};

/**
 * Хост по умолчанию: молчит и ничего не умеет. Так тесты и любой вызов до бутстрапа
 * ведут себя как раньше, а не падают на «хост не установлен» — падение движка синка
 * из-за отсутствующей строки лога было бы хуже, чем тишина в логе.
 */
const silentHost: SyncHost = {
  userDataPath: () => '',
  appVersion: () => '',
  relaunch: () => {},
  exit: () => {},
  appendLog: () => {},
};

let host: SyncHost = silentHost;

export function setSyncHost(next: SyncHost): void {
  host = next;
}

export function getSyncHost(): SyncHost {
  return host;
}

/** Сброс к тишине — для тестов, которые проверяют отсутствие утечки состояния. */
export function resetSyncHost(): void {
  host = silentHost;
}
