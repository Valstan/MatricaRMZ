import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { EngineListSource } from '../services/engineListInProcess.js';
import type { SyncControl } from '../services/syncControl.js';

export type AppDataMode =
  | { mode: 'live' }
  | { mode: 'backup'; backupDate: string; backupPath: string };

export type IpcContext = {
  // sysDb: always the main local DB (stores auth session, settings, etc.)
  sysDb: BetterSQLite3Database;
  // dataDb: the DB used for reading domain data (live or backup snapshot)
  dataDb: () => BetterSQLite3Database;
  mode: () => AppDataMode;
  mgr: SyncControl;
  /** Список двигателей: отдельный процесс чтения, иначе — этот (см. `engineListSource`). */
  engineList: EngineListSource;
  logToFile: (message: string) => void;
  currentActor: () => Promise<string>;
  currentViewer: () => Promise<{ login: string; role: string }>;
  currentPermissions: () => Promise<Record<string, boolean>>;
};

export function hasPerm(perms: Record<string, boolean>, code: string): boolean {
  return perms?.[code] === true;
}

export async function requirePermOrThrow(ctx: IpcContext, permCode: string) {
  const perms = await ctx.currentPermissions();
  if (!hasPerm(perms, permCode)) throw new Error(`permission denied: ${permCode}`);
}

export async function requirePermOrResult(ctx: IpcContext, permCode: string) {
  const perms = await ctx.currentPermissions();
  if (!hasPerm(perms, permCode)) return { ok: false as const, error: `permission denied: ${permCode}` };
  return { ok: true as const };
}

/**
 * Ворота «любое из прав»: подходит там, где одна операция закрыта двумя разными
 * правами (например, должность сотрудника — кадровым правом или узким
 * правом на должности).
 */
export async function requireAnyPermOrResult(ctx: IpcContext, permCodes: string[]) {
  const perms = await ctx.currentPermissions();
  const ok = permCodes.find((code) => hasPerm(perms, code));
  if (!ok) return { ok: false as const, error: `permission denied: ${permCodes.join(' | ')}` };
  return { ok: true as const };
}

export function isViewMode(ctx: IpcContext): boolean {
  return ctx.mode().mode === 'backup';
}

export function viewModeWriteError() {
  return {
    ok: false as const,
    error: 'view mode: data is read-only (exit backup view mode to edit)',
  };
}


