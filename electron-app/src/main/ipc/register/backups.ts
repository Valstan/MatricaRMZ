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
      const date = String((args as any)?.date ?? '').trim();
      const schema = z.object({ date: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/) });
      const parsed = schema.safeParse({ date });
      if (!parsed.success) {
        ctx.logToFile(`backups:nightly:enter invalid date=${date}`);
        return { ok: false as const, error: parsed.error.flatten().fieldErrors?.date?.[0] ?? 'invalid date' };
      }

      ctx.logToFile(`backups:nightly:enter date=${parsed.data.date}`);
      const dl = await nightlyBackupDownload(ctx.sysDb, ctx.mgr.getApiBaseUrl(), { date: parsed.data.date, userDataDir: app.getPath('userData') });
      if (!dl.ok) return dl;
      return await ctrl.enterBackup({ backupDate: parsed.data.date, backupPath: dl.backupPath });
    } catch (e) {
      ctx.logToFile(`backups:nightly:enter failed: ${String(e)}`);
      return { ok: false as const, error: String(e) };
    }
  });

  ipcMain.handle('backups:nightly:runNow', async () => {
    return nightlyBackupRunNow(ctx.sysDb, ctx.mgr.getApiBaseUrl());
  });

  ipcMain.handle('backups:enterLocal', async (_e, args: { backupDate: string; backupPath: string }) => {
    try {
      const backupDate = String((args as any)?.backupDate ?? '').trim();
      const backupPath = String((args as any)?.backupPath ?? '').trim();
      const schema = z.object({
        backupDate: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),
        backupPath: z.string().min(1),
      });
      const parsed = schema.safeParse({ backupDate, backupPath });
      if (!parsed.success) return { ok: false as const, error: 'invalid backupDate/backupPath' };
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


