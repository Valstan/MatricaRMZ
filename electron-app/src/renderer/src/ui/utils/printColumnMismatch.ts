/**
 * Расхождение между колонками, видимыми в списке, и набором колонок печати (владелец
 * 12.11.2026).
 *
 * Печать и выгрузка помнят СВОЙ набор колонок (`localStorage`), и он живёт своей жизнью:
 * оператор настроил лист под привычную форму, потом в списке отключил колонку плашкой —
 * а в файле она осталась (и наоборот). Само по себе это не поломка: «посмотреть» и
 * «распечатать» — разные задачи. Но молчаливый вывод файла читают как «вот что в списке»,
 * и это ловушка.
 *
 * Поэтому модуль считает РАЗНИЦУ двумя списками — чтобы оператор увидел её и решил сам:
 * либо включить недостающие колонки, либо отключить лишние.
 *
 * Порядок колонок печати не меняется: недостающие добавляются в конец своего места (по
 * порядку колонок списка), лишние просто убираются.
 */

export type PrintColumnMismatch = {
  /** Колонки, видимые в списке, но не попавшие в печать. */
  missing: { id: string; label: string }[];
  /** Колонки, попавшие в печать, но не видимые в списке. */
  extra: { id: string; label: string }[];
};

export function printColumnMismatch(params: {
  /** Все колонки, доступные для печати (в порядке колонок списка). */
  columns: readonly { id: string; label: string }[];
  /** Текущий набор колонок печати. */
  printColumnIds: readonly string[];
  /** Колонки, видимые в списке на экране. */
  visibleColumnIds: readonly string[];
}): PrintColumnMismatch {
  const printIds = new Set(params.printColumnIds);
  const visibleIds = new Set(params.visibleColumnIds);
  const missing: { id: string; label: string }[] = [];
  const extra: { id: string; label: string }[] = [];
  for (const column of params.columns) {
    const inPrint = printIds.has(column.id);
    const inList = visibleIds.has(column.id);
    if (inList && !inPrint) missing.push({ id: column.id, label: column.label });
    if (!inList && inPrint) extra.push({ id: column.id, label: column.label });
  }
  return { missing, extra };
}

/** Набор печати после «включить недостающие»: недостающие добавлены, лишние на месте. */
export function printColumnIdsWithMissing(
  printColumnIds: readonly string[],
  missing: readonly { id: string }[],
): string[] {
  if (missing.length === 0) return [...printColumnIds];
  const present = new Set(printColumnIds);
  const next = [...printColumnIds];
  for (const column of missing) {
    if (!present.has(column.id)) next.push(column.id);
  }
  return next;
}

/** Набор печати после «отключить лишние»: лишние убраны, порядок остальных прежний. */
export function printColumnIdsWithoutExtra(
  printColumnIds: readonly string[],
  extra: readonly { id: string }[],
): string[] {
  if (extra.length === 0) return [...printColumnIds];
  const drop = new Set(extra.map((column) => column.id));
  return printColumnIds.filter((id) => !drop.has(id));
}

/** Есть ли расхождение вообще. */
export function hasPrintColumnMismatch(mismatch: PrintColumnMismatch): boolean {
  return mismatch.missing.length > 0 || mismatch.extra.length > 0;
}
