import { isLwwRejectedReason, parseEngineReservationSkipReason } from '@matricarmz/shared';

/**
 * Что клиент делает с отказом сервера по конкретной строке.
 *
 *  - `reserved` — временный замок двигателя: строка ждёт своего часа (в очередь);
 *  - `lww_rejected` — сервер отверг строку как устаревшую: серверная копия новее,
 *    клиент СНИМАЕТ `pending` (не error, не ретрай) — план #114, шаг 28;
 *  - `permanent` — отказ, который ретраем не лечится: карантин и баннер оператору;
 *  - `dependency` — не хватает зависимости: строка ждёт pull'а.
 */
export type SkippedRowAction = 'reserved' | 'lww_rejected' | 'permanent' | 'dependency';

export type SkippedRowLike = {
  table?: string | null;
  row_id?: string | null;
  reason?: string | null;
  permanent?: boolean | null;
};

export function skippedRowAction(row: SkippedRowLike): SkippedRowAction {
  const reason = String(row?.reason ?? '');
  if (parseEngineReservationSkipReason(reason)) return 'reserved';
  if (isLwwRejectedReason(reason)) return 'lww_rejected';
  if (row?.permanent === true) return 'permanent';
  return 'dependency';
}

/**
 * Строки, с которых снимается `pending`: сервер отверг их как устаревшие.
 *
 * Данные при этом НЕ теряются: серверная копия строки новее и приедет pull'ом.
 * Раньше отказ был молчаливым — строка навсегда оставалась `pending` и уходила
 * в каждый push снова и снова (класс «строка создана локально, а на сервер не
 * уехала», письмо проекта в Мозг 24.11.2026, п.2).
 */
export function lwwRejectedByTable(rows: SkippedRowLike[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of rows ?? []) {
    if (skippedRowAction(row) !== 'lww_rejected') continue;
    const table = String(row?.table ?? '');
    const rowId = String(row?.row_id ?? '');
    if (!table || !rowId) continue;
    const arr = out.get(table) ?? [];
    arr.push(rowId);
    out.set(table, arr);
  }
  return out;
}
