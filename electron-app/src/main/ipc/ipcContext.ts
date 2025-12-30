import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { SyncManager } from '../services/syncManager.js';

export type IpcContext = {
  db: BetterSQLite3Database;
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


