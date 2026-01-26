import { ipcMain } from 'electron';
import { getKeyRing, rotateKey, exportKeyRing } from '../../services/e2eKeyService.js';

export function registerE2eKeysIpc() {
  ipcMain.handle('e2e:keys:status', async () => {
    const ring = getKeyRing();
    return {
      ok: true,
      enabled: true,
      primaryPresent: !!ring.primary,
      previousCount: ring.previous.length,
      updatedAt: ring.updatedAt,
    };
  });

  ipcMain.handle('e2e:keys:export', async () => {
    const ring = exportKeyRing();
    return { ok: true, ring };
  });

  ipcMain.handle('e2e:keys:rotate', async () => {
    const ring = rotateKey();
    return { ok: true, ring };
  });
}
