/**
 * Состояние автолечения по клиентам — что сервер видел и что сделал.
 *
 * Отдельный модуль, а не часть `diagnosticsAutohealService`: тот читает отчёт о
 * согласованности, и импорт в обратную сторону замкнул бы кольцо импортов.
 *
 * Лежит в серверных снимках (`diagnostics_snapshots`, scope='server'): сигнал
 * (уровень расхождения) и действие автолечения (поставили починку / отложили и почему).
 */
import { and, desc, eq, gte } from 'drizzle-orm';

import { db } from '../database/db.js';
import { diagnosticsSnapshots } from '../database/schema.js';
import { logError } from '../utils/logger.js';

export type AutohealSignalLevel = 'normal' | 'observe' | 'degraded' | 'critical';

export type ClientAutohealState = {
  /** Уровень последнего сигнала расхождения. */
  level: AutohealSignalLevel | null;
  levelAt: number | null;
  /** Что сервер сделал: `enqueue` — поставил починку, `skip` — не стал. */
  lastAction: 'enqueue' | 'skip' | null;
  lastReason: string | null;
  /** Лечение было нужно, но бюджет его не пустил — «лечение отложено». */
  deferred: boolean;
  requestType: string | null;
  at: number | null;
};

export function parseJson(raw: string | null | undefined): any {
  if (!raw) return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

/**
 * Состояние автолечения по всем клиентам разом — для отчёта «Диагностика клиентов».
 *
 * Считаем по серверным снимкам за сутки: там лежат и сигналы, и действия автолечения.
 */
export async function getAutohealStatesForClients(
  sinceMs = 24 * 60 * 60_000,
): Promise<Map<string, ClientAutohealState>> {
  const states = new Map<string, ClientAutohealState>();
  let rows: any[] = [];
  try {
    rows = (await db
      .select({
        clientId: diagnosticsSnapshots.clientId,
        payloadJson: diagnosticsSnapshots.payloadJson,
        createdAt: diagnosticsSnapshots.createdAt,
      })
      .from(diagnosticsSnapshots)
      .where(
        and(eq(diagnosticsSnapshots.scope, 'server'), gte(diagnosticsSnapshots.createdAt, Date.now() - sinceMs)),
      )
      .orderBy(desc(diagnosticsSnapshots.createdAt))
      .limit(4000)) as any[];
  } catch (e) {
    logError('autoheal states load failed', { error: String(e) });
    return states;
  }
  for (const row of rows) {
    const clientId = String(row?.clientId ?? '');
    if (!clientId) continue;
    const payload = parseJson(row?.payloadJson);
    if (!payload || typeof payload !== 'object') continue;
    const kind = String((payload as any).kind ?? '');
    const at = Number((payload as any).at ?? row?.createdAt ?? 0);
    const state = states.get(clientId) ?? {
      level: null,
      levelAt: null,
      lastAction: null,
      lastReason: null,
      deferred: false,
      requestType: null,
      at: null,
    };
    if (kind === 'autoheal_signal') {
      const level = String((payload as any).level ?? '');
      if (!state.level && ['normal', 'observe', 'degraded', 'critical'].includes(level)) {
        state.level = level as AutohealSignalLevel;
        state.levelAt = at;
      }
      states.set(clientId, state);
      continue;
    }
    if (kind === 'autoheal' && !state.lastAction) {
      state.lastAction = String((payload as any).action ?? 'skip') === 'enqueue' ? 'enqueue' : 'skip';
      state.lastReason = (payload as any).reason ? String((payload as any).reason) : null;
      state.deferred = Boolean((payload as any).deferred);
      state.requestType = (payload as any).requestType ? String((payload as any).requestType) : null;
      state.at = at;
      states.set(clientId, state);
    }
  }
  return states;
}
