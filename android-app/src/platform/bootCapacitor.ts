// Точка сборки планшетного клиента: платформенные хуки → шифрованная реплика →
// ядро Ф1 (миграции, синк, clientId, heartbeat) → настоящий мост Ф2/Ф3
// (preload + register-модули) → renderer. Замена спайк-моста Ф0
// (bridge/shim.ts), который остаётся только для браузерного просмотра.
import { BrowserWindow } from '../shims/electron.js';
import { setAndroidPlatformHooks } from '../shims/platform.js';
import { bootAndroidCore, type AndroidCore } from '../core/boot.js';
import { installAndroidBridge } from '../core/ipcWiring.js';
import { openAndroidReplica } from './replica.js';

declare const __MATRICA_APP_VERSION__: string;
declare const __MATRICA_DEFAULT_API_BASE_URL__: string;

export async function bootCapacitorClient(): Promise<AndroidCore> {
  const replica = await openAndroidReplica();

  setAndroidPlatformHooks({
    encryptionAvailable: () => replica.encrypted,
    // Перезагрузка WebView: JS-состояние и соединение с БД поднимаются заново —
    // ровно то, что нужно reset-флоу синка после сноса реплики. Нативный
    // процесс при этом живёт, отдельного restart-плагина не заводим.
    relaunch: () => globalThis.location.reload(),
    appVersion: () => __MATRICA_APP_VERSION__,
  });

  const core = await bootAndroidCore({
    sqlite: replica.sqlite,
    defaultApiBaseUrl: __MATRICA_DEFAULT_API_BASE_URL__,
    resetLocalDatabaseFiles: replica.reset,
    // Тот же путь доставки, что у десктопного registerIpc: событие уходит
    // слушателям ipcRenderer.on('sync:progress') внутри WebView.
    onSyncProgress: (payload) => BrowserWindow.getAllWindows()[0]?.webContents.send('sync:progress', payload),
    log: (msg) => console.info(`[android-main] ${msg}`),
  });

  await installAndroidBridge(core);
  core.startHeartbeat();

  // startAuto ядра планирует ПЕРВЫЙ тик только через интервал — на планшете после
  // холодного старта это выглядело как «наряды не грузятся» до 5 минут. Пинаем синк
  // сразу (при восстановленной сессии подтянет данные; без сессии тихо откажет) и при
  // появлении сети — аналог onNetworkChange десктопного registerIpc, не переехавшего
  // в порт. Здесь, а не в ядре: boot-тесты ядра полагаются на «тихий» старт.
  void core.syncManager.runOnce().catch(() => {});
  globalThis.addEventListener?.('online', () => {
    void core.syncManager.runOnce().catch(() => {});
  });

  return core;
}
