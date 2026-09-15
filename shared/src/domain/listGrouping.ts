/**
 * Группировка плоского списка для показа в одной таблице — рамка «отчёт как список»
 * (владелец 15.09.2026): вверху панель фильтров, внизу список, и его можно разложить по
 * группам (этап на заводе, заказчик, заказчик → этап). Таблица рисует ряд `items`: строка
 * группы — один `<td colSpan>`, строка данных — обычная. Нумерация строк сквозная и не
 * прерывается заголовками.
 */
export type GroupedListItem<Row> =
  | { kind: 'group'; key: string; label: string; depth: number; count: number }
  | { kind: 'row'; row: Row; number: number };

export type GroupKey = { key: string; label: string; /** Порядок групп: больше — раньше. Без ранга — по подписи. */ rank?: number };

export type GroupLevel<Row> = { keyOf: (row: Row) => GroupKey };

type Bucket<Row> = { key: GroupKey; rows: Row[] };

function bucketize<Row>(rows: readonly Row[], keyOf: (row: Row) => GroupKey): Bucket<Row>[] {
  const map = new Map<string, Bucket<Row>>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = map.get(key.key);
    if (bucket) bucket.rows.push(row);
    else map.set(key.key, { key, rows: [row] });
  }
  return [...map.values()].sort((a, b) => {
    const ra = a.key.rank;
    const rb = b.key.rank;
    if (ra != null && rb != null && ra !== rb) return rb - ra;
    if (ra != null && rb == null) return -1;
    if (ra == null && rb != null) return 1;
    return a.key.label.localeCompare(b.key.label, 'ru');
  });
}

/**
 * Разложить строки по уровням группировки (0, 1 или 2 уровня) в плоский ряд для таблицы.
 * Порядок строк внутри группы — как пришли (сортировка остаётся за страницей).
 */
export function flattenGrouped<Row>(rows: readonly Row[], levels: ReadonlyArray<GroupLevel<Row>>): GroupedListItem<Row>[] {
  const out: GroupedListItem<Row>[] = [];
  let number = 0;
  // Ключ группы — путь от корня: одна и та же подгруппа («Обкатка») под разными
  // родителями обязана отличаться, иначе React перепутает строки при смене группировки.
  const walk = (subset: readonly Row[], depth: number, parentKey: string) => {
    const level = levels[depth];
    if (!level) {
      for (const row of subset) out.push({ kind: 'row', row, number: ++number });
      return;
    }
    for (const bucket of bucketize(subset, level.keyOf)) {
      const key = `${parentKey}/${bucket.key.key}`;
      out.push({ kind: 'group', key, label: bucket.key.label, depth, count: bucket.rows.length });
      walk(bucket.rows, depth + 1, key);
    }
  };
  walk(rows, 0, '');
  return out;
}
