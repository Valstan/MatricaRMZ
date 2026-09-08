import { SyncTableName } from '@matricarmz/shared';

/**
 * Карантин строк, которые сервер не примет никогда: их зависимости нет ни на
 * сервере, ни локально (вторая развилка `dependencyRequeue.ts`).
 *
 * Зачем отдельный список, а не статус `error`. Пометка `error` уже стоит — и её
 * на следующем же цикле снимает `recoverErroredRows` в `syncService`: та функция
 * проверяет строку ПО СХЕМЕ, а сломана не схема, а отсутствие родителя. Строка
 * снова становится `pending`, снова уезжает в push, снова пропускается. Так
 * лечение, написанное 04.09.2026, оказалось отменено функцией двадцатью строками
 * ниже: PC19 к 08.09.2026 отправила 8 листов деталей ~800 раз в сутки, каждая
 * попытка легла в журнал сервера (журнал пишется ДО применения), и один клиент
 * держал весь конвейер в статусе `critical`.
 *
 * Карантин — единственное состояние, из которого `recoverErroredRows` не
 * воскрешает. Выход из него один: зависимость появилась локально (её привёз
 * pull или оператор завёл карточку заново) — тогда строка возвращается в
 * очередь сама, см. `releaseResolvedBlockedRows`.
 */

export type BlockedRow = {
  table: SyncTableName;
  id: string;
  dependency: string;
  missingId: string;
  since: number;
};

export type BlockedRowInput = {
  table: SyncTableName;
  id: string;
  dependency: string;
  missingId: string;
};

// Потолок списка. Он живёт одной строкой в `sync_state` — распухший JSON здесь
// стоит дорого (M105: файл состояния упирался в предел строки V8). Реальные
// значения — единицы строк; потолок нужен на патологию, а не на будни.
export const BLOCKED_ROWS_CAP = 500;

const SYNC_TABLES = new Set<string>(Object.values(SyncTableName));

function isBlockedRow(v: unknown): v is BlockedRow {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.table === 'string' &&
    SYNC_TABLES.has(r.table) &&
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    typeof r.dependency === 'string' &&
    typeof r.missingId === 'string' &&
    typeof r.since === 'number' &&
    Number.isFinite(r.since)
  );
}

export function parseBlockedRows(raw: string | null | undefined): BlockedRow[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: BlockedRow[] = [];
  for (const item of parsed) {
    if (!isBlockedRow(item)) continue;
    const key = `${item.table}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      table: item.table,
      id: item.id,
      dependency: item.dependency,
      missingId: item.missingId,
      since: item.since,
    });
  }
  return out;
}

export function serializeBlockedRows(rows: readonly BlockedRow[]): string {
  return JSON.stringify(rows);
}

export function isRowBlocked(rows: readonly BlockedRow[], table: SyncTableName, id: string): boolean {
  return rows.some((r) => r.table === table && r.id === id);
}

export function blockedIdsForTable(rows: readonly BlockedRow[], table: SyncTableName): Set<string> {
  const out = new Set<string>();
  for (const r of rows) if (r.table === table) out.add(r.id);
  return out;
}

/**
 * Добавляет в карантин строки, которым помочь нечем. Возвращает и новый список,
 * и то, что добавилось впервые: докладывать на сервер надо один раз на строку, а
 * не в каждом push — иначе вместо вечного цикла строк получим вечный цикл
 * сообщений о нём.
 *
 * Переполнение потолка НЕ вытесняет старые записи: старые — те, что залипли
 * давно, и вытеснение вернуло бы их в цикл. Лишние просто не берутся в карантин
 * (они останутся в `error` и будут воскресать, как раньше), а вызывающий видит
 * это по `overflow` и сообщает.
 */
export function mergeBlockedRows(
  existing: readonly BlockedRow[],
  incoming: readonly BlockedRowInput[],
  now: number,
): { rows: BlockedRow[]; added: BlockedRow[]; overflow: number } {
  const rows = [...existing];
  const index = new Set(rows.map((r) => `${r.table}:${r.id}`));
  const added: BlockedRow[] = [];
  let overflow = 0;
  for (const item of incoming) {
    if (!item?.id || !SYNC_TABLES.has(String(item.table))) continue;
    const key = `${item.table}:${item.id}`;
    if (index.has(key)) continue;
    if (rows.length >= BLOCKED_ROWS_CAP) {
      overflow += 1;
      continue;
    }
    const row: BlockedRow = {
      table: item.table,
      id: item.id,
      dependency: item.dependency,
      missingId: item.missingId,
      since: now,
    };
    index.add(key);
    rows.push(row);
    added.push(row);
  }
  return { rows, added, overflow };
}

/**
 * Делит карантин на «остаётся» и «отпускаем»: отпускаем те строки, чья
 * зависимость уже появилась локально. Проверку существования отдаёт вызывающий
 * (здесь нет доступа к базе), результаты по одному и тому же id не
 * перепрашиваются.
 */
export async function releaseResolvedBlockedRows(
  rows: readonly BlockedRow[],
  existsLocally: (table: SyncTableName, id: string) => Promise<boolean>,
  dependencyTable: Readonly<Record<string, SyncTableName>>,
): Promise<{ blocked: BlockedRow[]; released: BlockedRow[] }> {
  const blocked: BlockedRow[] = [];
  const released: BlockedRow[] = [];
  const checked = new Map<string, boolean>();
  for (const row of rows) {
    const depTable = dependencyTable[row.dependency];
    if (!depTable || !row.missingId) {
      blocked.push(row);
      continue;
    }
    const key = `${depTable}:${row.missingId}`;
    let exists = checked.get(key);
    if (exists === undefined) {
      exists = await existsLocally(depTable, row.missingId).catch(() => false);
      checked.set(key, exists);
    }
    if (exists) released.push(row);
    else blocked.push(row);
  }
  return { blocked, released };
}
