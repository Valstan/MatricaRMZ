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

/**
 * Отказ по праву — с названной причиной (промт КАРМАНА #142).
 *
 * Раньше отказ по праву, отказ по разделу и отказ «канал не заведён на планшете»
 * выглядели для оператора одинаково, и владелец поставил диагноз «недостаточно
 * прав» там, где на самом деле не был заведён канал. Теперь у каждого отказа
 * своя формулировка:
 *   - «permission denied: <право> — нет права …» — не хватает права;
 *   - «Нет доступа к разделу «…»» — раздел не выдан;
 *   - «канал не заведён на планшете: … — <причина>» — канала нет на платформе;
 *   - «нужна сеть: …» — до сервера не дошли.
 *
 * Префикс `permission denied` остаётся: по нему ищут отказ программно
 * (App.tsx, engineBrandSummary, shipmentAssemblyGate) — менять его нельзя.
 */
export async function requirePermOrThrow(ctx: IpcContext, permCode: string) {
  const perms = await ctx.currentPermissions();
  if (!hasPerm(perms, permCode)) throw new Error(`permission denied: ${permCode} — нет права «${permCode}»`);
}

export async function requirePermOrResult(ctx: IpcContext, permCode: string) {
  const perms = await ctx.currentPermissions();
  if (!hasPerm(perms, permCode)) {
    return { ok: false as const, error: `permission denied: ${permCode} — нет права «${permCode}»` };
  }
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
  if (!ok) {
    return {
      ok: false as const,
      error: `permission denied: ${permCodes.join(' | ')} — нет ни одного из этих прав`,
    };
  }
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


