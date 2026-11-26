/**
 * Группировка плоского списка для показа в одной таблице — рамка «отчёт как список»
 * (владелец 15.09.2026): вверху панель фильтров, внизу список, и его можно разложить по
 * группам (этап на заводе, заказчик, заказчик → этап). Таблица рисует ряд `items`: строка
 * группы — один `<td colSpan>`, строка данных — обычная. Нумерация строк сквозная и не
 * прерывается заголовками.
 *
 * Промт КАРМАНА #164: у строки теперь **две** нумерации. Сквозная (`number`) — прежняя:
 * считает строки по всему списку, заголовками групп не сбивается. Групповая (`groupNumber`) —
 * номер строки внутри группы, с единицы в каждой нижней (самой глубокой) группе. Обе нужны
 * как обычные колонки списка: их видно в «Колонках списка», каждую можно отключить, и
 * отключённая не печатается и не выгружается.
 */
export type GroupedListItem<Row> =
  | { kind: 'group'; key: string; label: string; depth: number; count: number }
  | { kind: 'row'; row: Row; number: number; groupNumber: number };

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
      // Уровней больше нет ⇒ мы в самой глубокой группе: групповой номер сбрасывается
      // в каждой такой группе. Без группировки (уровней нет вовсе) группа одна — и
      // групповой номер совпадает со сквозным.
      let groupNumber = 0;
      for (const row of subset) out.push({ kind: 'row', row, number: ++number, groupNumber: ++groupNumber });
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

/**
 * Колонки-номера списка — сквозная и групповая (промт КАРМАНА #164).
 *
 * Это **обычные** колонки: свои идентификаторы, свой порядок, видны в «Колонках списка»,
 * каждую можно отключить. Отключённая не показывается на экране, не печатается и не
 * выгружается. Идентификаторы живут в домене, потому что ими пользуются и список, и
 * печать, и выгрузка — иначе «отключена» значила бы разное в разных местах.
 */
export const LIST_NUMBER_COLUMN_IDS = ['rowNumber', 'groupNumber'] as const;

export type ListNumberColumnId = (typeof LIST_NUMBER_COLUMN_IDS)[number];

export const LIST_NUMBER_COLUMN_LABELS: Record<ListNumberColumnId, string> = {
  rowNumber: '№',
  groupNumber: '№ в группе',
};

/** Какие колонки-номера показывать: обе настраиваемые, по умолчанию включена сквозная. */
export type ListNumberColumns = { number: boolean; groupNumber: boolean };

export const DEFAULT_LIST_NUMBER_COLUMNS: ListNumberColumns = { number: true, groupNumber: false };
