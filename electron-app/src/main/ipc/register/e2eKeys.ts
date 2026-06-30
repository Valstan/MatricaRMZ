import { ipcMain } from 'electron';
import { getKeyRing, rotateKey, exportKeyRing } from '../../services/e2eKeyService.js';
import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';

// The E2E keyring is the master ledger-encryption secret. Exporting or rotating
// it must require admin rights — otherwise any renderer code (incl. a compromised
// one) could silently exfiltrate the key via window.matrica.e2eKeys.export().
// (security-hardening-2026-06, Phase 3 — Electron IPC gate)
export function registerE2eKeysIpc(ctx: IpcContext) {
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
    const gate = await requirePermOrResult(ctx, 'admin.users.manage');
    if (!gate.ok) return gate;
    const ring = exportKeyRing();
    return { ok: true, ring };
  });

  ipcMain.handle('e2e:keys:rotate', async () => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'admin.users.manage');
    if (!gate.ok) return gate;
    const ring = rotateKey();
    return { ok: true, ring };
  });
}
