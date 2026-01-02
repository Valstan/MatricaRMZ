import { ipcMain, app } from 'electron';
import { z } from 'zod';

import type { IpcContext } from '../ipcContext.js';

import { nightlyBackupDownload, nightlyBackupRunNow, nightlyBackupsList } from '../../services/backupService.js';

export type BackupModeController = {
  enterBackup: (args: { backupDate: string; backupPath: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
  exitBackup: () => Promise<{ ok: true } | { ok: false; error: string }>;
};

export function registerBackupsIpc(ctx: IpcContext, ctrl: BackupModeController) {
  ipcMain.handle('backups:status', async () => {
    const m = ctx.mode();
    return { ok: true as const, mode: m.mode, backupDate: (m as any).backupDate ?? null };
  });

  ipcMain.handle('backups:nightly:list', async () => {
    return nightlyBackupsList(ctx.sysDb, ctx.mgr.getApiBaseUrl());
  });

  ipcMain.handle('backups:nightly:enter', async (_e, args: { date: string }) => {
    try {
      const schema = z.object({ date: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/) });
      const parsed = schema.safeParse(args);
      if (!parsed.success) return { ok: false as const, error: parsed.error.flatten() as any };

      const dl = await nightlyBackupDownload(ctx.sysDb, ctx.mgr.getApiBaseUrl(), { date: parsed.data.date, userDataDir: app.getPath('userData') });
      if (!dl.ok) return dl;
      return await ctrl.enterBackup({ backupDate: parsed.data.date, backupPath: dl.backupPath });
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });

  ipcMain.handle('backups:nightly:runNow', async () => {
    return nightlyBackupRunNow(ctx.sysDb, ctx.mgr.getApiBaseUrl());
  });

  ipcMain.handle('backups:enterLocal', async (_e, args: { backupDate: string; backupPath: string }) => {
    try {
      const schema = z.object({
        backupDate: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),
        backupPath: z.string().min(1),
      });
      const parsed = schema.safeParse(args);
      if (!parsed.success) return { ok: false as const, error: parsed.error.flatten() as any };
      return await ctrl.enterBackup(parsed.data);
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });

  ipcMain.handle('backups:exit', async () => {
    try {
      return await ctrl.exitBackup();
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });
}


