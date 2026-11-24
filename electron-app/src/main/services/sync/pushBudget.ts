import { SyncTableName } from '@matricarmz/shared';

/**
 * Бюджет одного push (план #114, шаг 27).
 *
 * Бюджет общий на все таблицы, и раньше его целиком забирали первые четыре
 * таблицы (`entity_types` → `entities` → `attribute_defs` → `attribute_values`).
 * Тогда пачка `operations` не собиралась ВООБЩЕ — без единой ошибки: строка
 * (в т.ч. история ремонта, введённая с планшета) висела `pending` вечно.
 *
 * Теперь под `operations` резервируется место: первые таблицы режутся бюджетом
 * минус резерв, а `operations` забирают свой.
 */

/** Сколько строк `operations` надо зарезервировать под себя. */
export function operationsReserve(pendingOperations: number, operationsPerTableLimit: number): number {
  if (!Number.isFinite(pendingOperations) || pendingOperations <= 0) return 0;
  return Math.max(0, Math.min(pendingOperations, operationsPerTableLimit));
}

/** Бюджет таблицы с учётом резерва `operations`. */
export function budgetForTable(table: SyncTableName, reserve: number, maxTotalRows: number): number {
  if (table === SyncTableName.Operations) return maxTotalRows;
  return Math.max(0, maxTotalRows - reserve);
}
