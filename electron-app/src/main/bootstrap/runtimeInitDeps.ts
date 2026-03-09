import { getSqliteHandle, openSqlite } from '../database/db.js';
import { migrateSqlite } from '../database/migrate.js';
import { seedIfNeeded } from '../database/seed.js';
import { registerIpc } from '../ipc/registerIpc.js';
import { SettingsKey, settingsGetString, settingsSetString } from '../services/settingsStore.js';
import { getSession } from '../services/authService.js';
import { addAudit } from '../services/auditService.js';
import { alignSchemaWithServer } from '../services/syncService.js';

export function loadRuntimeInitDeps() {
  return {
    alignSchemaWithServer,
    getSqliteHandle,
    openSqlite,
    migrateSqlite,
    seedIfNeeded,
    registerIpc,
    SettingsKey,
    settingsGetString,
    settingsSetString,
    getSession,
    addAudit,
  };
}
