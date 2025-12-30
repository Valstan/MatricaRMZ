import { app } from 'electron';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { getSession } from '../services/authService.js';
import { SyncManager } from '../services/syncManager.js';
import { logMessageGetEnabled, startLogSender } from '../services/logService.js';

import type { IpcContext } from './ipcContext.js';
import { registerAdminIpc } from './register/admin.js';
import { registerAuthAndSyncIpc } from './register/authAndSync.js';
import { registerChecklistsIpc } from './register/checklists.js';
import { registerChangesIpc } from './register/changes.js';
import { registerEnginesOpsAuditIpc } from './register/enginesOpsAudit.js';
import { registerFilesIpc } from './register/files.js';
import { registerLoggingIpc } from './register/logging.js';
import { registerPartsIpc } from './register/parts.js';
import { registerReportsIpc } from './register/reports.js';
import { registerSupplyRequestsIpc } from './register/supplyRequests.js';
import { registerUpdateIpc } from './register/update.js';

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

  const ctx: IpcContext = {
    db,
    mgr,
    logToFile,
    currentActor,
    currentPermissions,
  };

  // Register IPC domains
  registerLoggingIpc(ctx);
  registerAuthAndSyncIpc(ctx);
  registerChangesIpc(ctx);
  registerEnginesOpsAuditIpc(ctx);
  registerAdminIpc(ctx);
  registerReportsIpc(ctx);
  registerUpdateIpc(ctx);
  registerFilesIpc(ctx);
  registerChecklistsIpc(ctx);
  registerSupplyRequestsIpc(ctx);
  registerPartsIpc(ctx);
}


