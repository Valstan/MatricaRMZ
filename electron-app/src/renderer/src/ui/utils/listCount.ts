// Счётчик и нумерация строк списка (владелец 15.09.2026): над каждой таблицей —
// «Всего: N · Показано: M» (N — до фильтров, M — после), слева — колонка «№»,
// нумеруемая при каждом построении и никуда не сохраняемая.

/** Подпись счётчика. `total === null` — сервер ещё не ответил (страничные списки). */
export function listCountLabel(total: number | null | undefined, shown: number): string {
  const totalText = typeof total === 'number' && Number.isFinite(total) ? String(total) : '—';
  return `Всего: ${totalText} · Показано: ${shown}`;
}

/**
 * Номер строки по индексу в отображаемом массиве. Для страничных списков нумерация
 * продолжается сквозь страницы: `pageIndex * pageSize + index + 1`.
 */
export function rowNumberAt(index: number, page?: { pageIndex: number; pageSize: number } | null): number {
  const offset = page ? Math.max(0, page.pageIndex) * Math.max(0, page.pageSize) : 0;
  return offset + index + 1;
}
