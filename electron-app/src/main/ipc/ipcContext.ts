import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { SyncManager } from '../services/syncManager.js';

export type AppDataMode =
  | { mode: 'live' }
  | { mode: 'backup'; backupDate: string; backupPath: string };

export type IpcContext = {
  // sysDb: always the main local DB (stores auth session, settings, etc.)
  sysDb: BetterSQLite3Database;
  // dataDb: the DB used for reading domain data (live or backup snapshot)
  dataDb: () => BetterSQLite3Database;
  mode: () => AppDataMode;
  mgr: SyncManager;
  logToFile: (message: string) => void;
  currentActor: () => Promise<string>;
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

export function isViewMode(ctx: IpcContext): boolean {
  return ctx.mode().mode === 'backup';
}

export function viewModeWriteError() {
  return {
    ok: false as const,
    error: 'view mode: data is read-only (exit backup view mode to edit)',
  };
}


