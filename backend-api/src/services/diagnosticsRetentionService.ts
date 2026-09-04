import { and, inArray, lt } from 'drizzle-orm';

import { db } from '../database/db.js';
import { diagnosticsSnapshots } from '../database/schema.js';
import { logInfo, logWarn } from '../utils/logger.js';

// Ретенция diagnostics_snapshots (решение владельца 04.09.2026: 90 дней). До этого таблица
// росла с января без единого читателя старых строк — 202 МБ к сентябрю. Режутся только
// scope'ы с известным потребителем «свежего»: server / client (экран диагностики) и
// ai_agent_event (метрики агента). Корпус чата и RAG-факты (ai_agent_chat_corpus,
// ai_agent_rag_fact) — не ретенция, а вопрос «нужны ли вообще» (PENDING §«Спорное»).

export const DEFAULT_DIAGNOSTICS_RETENTION_DAYS = 90;
export const DIAGNOSTICS_RETENTION_SCOPES = ['server', 'client', 'ai_agent_event'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_SWEEP_DELAY_MS = 10 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

export function parseRetentionDays(raw: string | undefined, name = 'MATRICA_DIAGNOSTICS_RETENTION_DAYS'): number {
  const s = (raw ?? '').trim();
  if (!s) return DEFAULT_DIAGNOSTICS_RETENTION_DAYS;
  if (!/^\d+$/.test(s) || Number(s) < 1) throw new Error(`${name}: ожидается целое число дней ≥ 1, получено "${s}"`);
  return Number(s);
}

export function retentionCutoffMs(now: number, days: number): number {
  return now - days * DAY_MS;
}

export async function sweepDiagnosticsSnapshots(now = Date.now()): Promise<number> {
  const days = parseRetentionDays(process.env.MATRICA_DIAGNOSTICS_RETENTION_DAYS);
  const cutoff = retentionCutoffMs(now, days);
  const gone = await db
    .delete(diagnosticsSnapshots)
    .where(and(inArray(diagnosticsSnapshots.scope, [...DIAGNOSTICS_RETENTION_SCOPES]), lt(diagnosticsSnapshots.createdAt, cutoff)))
    .returning({ id: diagnosticsSnapshots.id });
  if (gone.length > 0) logInfo('diagnostics_snapshots retention', { removed: gone.length, days, scopes: DIAGNOSTICS_RETENTION_SCOPES.join(',') });
  return gone.length;
}

export function startDiagnosticsRetentionJob() {
  if (timer) return;
  // Кривое значение должно уронить старт, а не молча оставить таблицу расти.
  parseRetentionDays(process.env.MATRICA_DIAGNOSTICS_RETENTION_DAYS);
  const tick = () => {
    sweepDiagnosticsSnapshots().catch((e) => logWarn('diagnostics_snapshots retention failed', { error: String(e) }));
  };
  timer = setInterval(tick, SWEEP_INTERVAL_MS);
  timer.unref?.();
  setTimeout(tick, FIRST_SWEEP_DELAY_MS).unref?.();
}

export function stopDiagnosticsRetentionJob() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
