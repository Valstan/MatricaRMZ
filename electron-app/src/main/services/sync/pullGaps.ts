import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { SettingsKey, settingsGetString, settingsSetString } from '../settingsStore.js';

/**
 * Журнал «дырок» pull: таблицы, строки которых клиент получил, но применить не смог,
 * потому что его сборка этих таблиц не знает (`applyPulledChanges` не имеет `case`).
 *
 * Зачем отдельный журнал, а не громкий лог. Инкрементальный pull отдаёт строки по
 * `last_server_seq > since`, и клиент сдвигает курсор **всегда** — даже когда часть
 * строк выбросил. Пропущенные строки остаются позади курсора навсегда: ни обновление,
 * ни рестарт их не вернут. Так 28.10.2026 парк не увидел номера РМЗ: клиенты 3.90.0
 * протащили `erp_engine_numbers` в pull, выбросили 2580 строк и ушли вперёд — на проде
 * номера были у всех 2574 живых двигателей, а в цеху «номер не присвоен».
 *
 * Запись в журнал — обещание вернуться. На старте синхронизации `syncService` берёт
 * таблицы оттуда и добирает их полным состоянием (`/ledger/state/snapshot`), не трогая
 * глобальный курсор: строки приходят мимо журнала, идемпотентно, по id. Сборка, которая
 * таблицу уже знает, вылечивает себя сама; сборка, которая ещё не знает, остаётся в
 * журнале и повторяет попытку позже.
 */
export type PullGap = {
  table: string;
  /** Сколько строк выброшено в последний раз — для лога и диагностики, не для логики. */
  rows: number;
  firstSeenAt: number;
  lastAttemptAt: number;
};

// Потолок списка: он живёт одной строкой в `sync_state`, а таблиц в контракте десятки.
// Переполнение здесь возможно только на патологии (сервер шлёт незнакомые имена пачкой).
export const PULL_GAPS_CAP = 100;

// Сборка, которая таблицу не знает, не вылечится за минуту — незачем долбить сервер
// полным состоянием таблицы каждые 60 секунд.
export const PULL_GAP_RETRY_MS = 10 * 60_000;

function isPullGap(v: unknown): v is PullGap {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.table === 'string' &&
    r.table.length > 0 &&
    typeof r.rows === 'number' &&
    Number.isFinite(r.rows) &&
    typeof r.firstSeenAt === 'number' &&
    Number.isFinite(r.firstSeenAt) &&
    typeof r.lastAttemptAt === 'number' &&
    Number.isFinite(r.lastAttemptAt)
  );
}

export function parsePullGaps(raw: string | null | undefined): PullGap[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PullGap[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!isPullGap(item)) continue;
    if (seen.has(item.table)) continue;
    seen.add(item.table);
    out.push({ table: item.table, rows: item.rows, firstSeenAt: item.firstSeenAt, lastAttemptAt: item.lastAttemptAt });
  }
  return out;
}

export function serializePullGaps(gaps: readonly PullGap[]): string {
  return JSON.stringify(gaps);
}

/**
 * Сливает увиденные дырки в журнал. Имя таблицы здесь НЕ сверяется с контрактом
 * намеренно: таблица, которой в этой сборке нет вовсе, — ровно тот случай, ради
 * которого журнал заведён.
 *
 * `firstSeenAt` не переписывается (это когда беда началась), `lastAttemptAt`
 * обновляется всегда — по нему считается пауза перед следующей попыткой.
 */
export function mergePullGaps(
  existing: readonly PullGap[],
  incoming: ReadonlyMap<string, number>,
  now: number,
): PullGap[] {
  const gaps = existing.map((g) => ({ ...g }));
  const index = new Map(gaps.map((g) => [g.table, g]));
  for (const [table, rows] of incoming) {
    const name = String(table ?? '').trim();
    if (!name) continue;
    const count = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 0;
    const prev = index.get(name);
    if (prev) {
      prev.rows = Math.max(prev.rows, count);
      prev.lastAttemptAt = now;
      continue;
    }
    if (gaps.length >= PULL_GAPS_CAP) continue;
    const gap: PullGap = { table: name, rows: count, firstSeenAt: now, lastAttemptAt: now };
    gaps.push(gap);
    index.set(name, gap);
  }
  return gaps;
}

export function gapsToRetry(gaps: readonly PullGap[], now: number): PullGap[] {
  return gaps.filter((g) => now - g.lastAttemptAt >= PULL_GAP_RETRY_MS);
}

export async function listPullGaps(db: BetterSQLite3Database): Promise<PullGap[]> {
  const raw = await settingsGetString(db, SettingsKey.SyncPullGaps).catch(() => null);
  return parsePullGaps(raw);
}

export async function recordPullGaps(
  db: BetterSQLite3Database,
  incoming: ReadonlyMap<string, number>,
  now: number,
): Promise<PullGap[]> {
  const existing = await listPullGaps(db);
  const merged = mergePullGaps(existing, incoming, now);
  await settingsSetString(db, SettingsKey.SyncPullGaps, serializePullGaps(merged));
  return merged;
}

export async function clearPullGaps(db: BetterSQLite3Database, tables: readonly string[]): Promise<void> {
  if (tables.length === 0) return;
  const drop = new Set(tables);
  const existing = await listPullGaps(db);
  const kept = existing.filter((g) => !drop.has(g.table));
  if (kept.length === existing.length) return;
  await settingsSetString(db, SettingsKey.SyncPullGaps, serializePullGaps(kept));
}
