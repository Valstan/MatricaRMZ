import { app, BrowserWindow } from 'electron';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { getSession } from '../services/authService.js';
import { SyncManager } from '../services/syncManager.js';
import { logMessageGetEnabled, startLogSender } from '../services/logService.js';
import { startClientSettingsPolling } from '../services/clientAdminService.js';

import type { IpcContext } from './ipcContext.js';
import { registerAdminIpc } from './register/admin.js';
import { registerAuthAndSyncIpc } from './register/authAndSync.js';
import { registerBackupsIpc } from './register/backups.js';
import { registerChecklistsIpc } from './register/checklists.js';
import { registerChatIpc } from './register/chat.js';
import { registerAiAgentIpc } from './register/aiAgent.js';
import { registerChangesIpc } from './register/changes.js';
import { registerEnginesOpsAuditIpc } from './register/enginesOpsAudit.js';
import { registerEmployeesIpc } from './register/employees.js';
import { registerFilesIpc } from './register/files.js';
import { registerLoggingIpc } from './register/logging.js';
import { registerNotesIpc } from './register/notes.js';
import { registerPartsIpc } from './register/parts.js';
import { registerReportsIpc } from './register/reports.js';
import { registerSettingsIpc } from './register/settings.js';
import { registerSupplyRequestsIpc } from './register/supplyRequests.js';
import { registerUpdateIpc } from './register/update.js';
import { registerE2eKeysIpc } from './register/e2eKeys.js';
import { registerToolsIpc } from './register/tools.js';
import { openSqliteReadonly } from '../database/db.js';

export function registerIpc(db: BetterSQLite3Database, opts: { clientId: string; apiBaseUrl: string }) {
  function logToFile(message: string) {
    try {
      const dir = app.getPath('userData');
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'matricarmz.log'), `[${new Date().toISOString()}] ${message}\n`);
    } catch {
      // ignore
    }
  }

  // Один менеджер на процесс (переиспользуем и для ручного sync, и для status).
  const mgr = new SyncManager(db, opts.clientId, opts.apiBaseUrl);
  mgr.startAuto(5 * 60_000);

  // Инициализация системы логирования
  void logMessageGetEnabled(db).then((enabled) => {
    if (enabled) {
      startLogSender(db, mgr.getApiBaseUrl());
    }
  });

  async function currentActor(): Promise<string> {
    const s = await getSession(db).catch(() => null);
    const u = s?.user?.username;
    return u && u.trim() ? u.trim() : 'local';
  }

  async function currentPermissions(): Promise<Record<string, boolean>> {
    const s = await getSession(db).catch(() => null);
    return (s?.permissions ?? {}) as Record<string, boolean>;
  }

  // Live DB also stores settings/auth, so use it as sysDb.
  const sysDb = db;
  const AUTO_SYNC_MS = 5 * 60_000;
  let mode: IpcContext['mode'] = () => ({ mode: 'live' as const });
  let backupSqlite: any | null = null;
  let backupDb: BetterSQLite3Database | null = null;

  function dataDb(): BetterSQLite3Database {
    return backupDb ?? sysDb;
  }

  function getMode() {
    return mode();
  }

  const ctx: IpcContext = {
    sysDb,
    dataDb,
    mode: getMode,
    mgr,
    logToFile,
    currentActor,
    currentPermissions,
  };

  function emitSyncProgress(payload: unknown) {
    try {
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) win.webContents.send('sync:progress', payload);
      });
    } catch {
      // ignore
    }
  }

  startClientSettingsPolling({
    db: sysDb,
    apiBaseUrl: mgr.getApiBaseUrl(),
    clientId: opts.clientId,
    version: app.getVersion(),
    log: logToFile,
    onSyncProgress: emitSyncProgress,
  });

  // Register IPC domains
  registerLoggingIpc(ctx);
  registerAuthAndSyncIpc(ctx);
  registerChangesIpc(ctx);
  registerEnginesOpsAuditIpc(ctx);
  registerEmployeesIpc(ctx);
  registerAdminIpc(ctx);
  registerReportsIpc(ctx);
  registerUpdateIpc(ctx);
  registerFilesIpc(ctx);
  registerChatIpc(ctx);
  registerNotesIpc(ctx);
  registerAiAgentIpc(ctx);
  registerChecklistsIpc(ctx);
  registerSupplyRequestsIpc(ctx);
  registerPartsIpc(ctx);
  registerToolsIpc(ctx);
  registerE2eKeysIpc();
  registerSettingsIpc(ctx);

  registerBackupsIpc(ctx, {
    enterBackup: async (args) => {
      try {
        const backupDate = String(args.backupDate || '').trim();
        const backupPath = String(args.backupPath || '').trim();
        if (!backupDate || !backupPath) return { ok: false as const, error: 'backupDate/backupPath required' };

        // Close previous backup DB if any.
        if (backupSqlite) {
          try {
            backupSqlite.close();
          } catch {
            // ignore
          }
        }
        backupSqlite = null;
        backupDb = null;

        // Open new snapshot DB in readonly mode.
        const opened = openSqliteReadonly(backupPath);
        backupSqlite = opened.sqlite as any;
        backupDb = opened.db as any;

        mode = () => ({ mode: 'backup' as const, backupDate, backupPath });

        // Stop sync while in view mode.
        mgr.stopAuto();

        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, error: String(e) };
      }
    },
    exitBackup: async () => {
      try {
        if (backupSqlite) {
          try {
            backupSqlite.close();
          } catch {
            // ignore
          }
        }
        backupSqlite = null;
        backupDb = null;
        mode = () => ({ mode: 'live' as const });
        mgr.startAuto(AUTO_SYNC_MS);
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, error: String(e) };
      }
    },
  });
}


