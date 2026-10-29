import type { App } from 'electron';

import { appendMainLogLine } from '../utils/logger.js';
import { authSessionProvider } from './authService.js';
import { getKeyRing } from './e2eKeyService.js';
import { setSyncHost } from './syncHost.js';
import { setE2eKeyRingSource } from './sync/e2eKeySource.js';
import { setSyncSessionProvider } from './syncSession.js';

/**
 * Десктопный порт движка синка: всё, что движку нужно от приложения, — путь, версия,
 * лог, сессия и кольцо E2E-ключей. Ставится один раз на старте, до `registerIpc`:
 * первый же синк пишет в лог и спрашивает версию.
 *
 * Сессия и ключи живут здесь, а не в движке, потому что расшифровать их может только
 * процесс с OS-keyring: в отдельном процессе `safeStorage` нет вовсе.
 */
export function installElectronSyncHost(app: App): void {
  setSyncHost({
    userDataPath: () => app.getPath('userData'),
    appVersion: () => app.getVersion(),
    relaunch: () => app.relaunch(),
    exit: (code) => app.exit(code),
    appendLog: (line) => appendMainLogLine(app, line),
  });
  setSyncSessionProvider(authSessionProvider);
  setE2eKeyRingSource(() => {
    const ring = getKeyRing();
    return { primary: ring.primary, previous: ring.previous };
  });
}
