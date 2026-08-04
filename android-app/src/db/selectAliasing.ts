// Переписывание проекции SELECT для драйверов, отдающих строки ОБЪЕКТАМИ
// (@capacitor-community/sqlite — единственный доступный на Android формат).
//
// Зачем. Контракт AsyncSqlite.values() — строки МАССИВАМИ в порядке колонок:
// именно это ждёт drizzle sqlite-proxy. На джойнах drizzle печатает
// неалиасованные `"t"."col"`, а SQLite называет такую колонку результата просто
// `col` — то есть `select "entities"."id", …, "attribute_values"."id", …`
// возвращает ДВА `id`. Объектная строка их схлопывает: ключей меньше, чем
// колонок, и Object.values() отдал бы drizzle сдвинутый (молча неверный) кортеж.
//
// Лечение — выдать каждой колонке проекции уникальный алиас `c0…cN` и читать
// строку по этим именам. Разбирается только машинный SQL drizzle, поэтому
// сканера верхнего уровня (кавычки + скобки) достаточно; всё, что не разобрали,
// планировщик честно помечает `raw`, а не притворяется, что понял.

export type QueryPlan =
  /** Не строкодающий statement — исполнять как run(). */
  | { kind: 'exec' }
  /**
   * Проекция переписана: читать значения по aliases в этом порядке.
   * `names` — как назвал бы колонки сам SQLite: явный алиас или последний
   * сегмент ссылки на колонку. Для выражений (`count(*)` без алиаса) имя
   * определяется реализацией — там `null`, и восстанавливать объектную строку
   * по нему нельзя.
   */
  | { kind: 'aliased'; sql: string; aliases: string[]; names: Array<string | null> }
  /** Строки вернёт, но проекцию разобрать не удалось (`*`, нестандартная форма). */
  | { kind: 'raw' };

const WORD = /[A-Za-z0-9_$]/;

function skipQuoted(sql: string, at: number, quote: string): number {
  let i = at + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2; // '' и "" — экранирование внутри литерала
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

/** Позиции слова `word` на верхнем уровне (вне скобок и кавычек). */
function findKeyword(sql: string, word: string, startAt = 0, all = false): number[] {
  const lower = sql.toLowerCase();
  const found: number[] = [];
  let depth = 0;
  let i = startAt;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      i = skipQuoted(sql, i, c);
      continue;
    }
    if (c === '(') {
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      depth--;
      i++;
      continue;
    }
    if (depth === 0 && lower.startsWith(word, i)) {
      const before = i === 0 ? ' ' : sql[i - 1]!;
      const after = sql[i + word.length] ?? ' ';
      if (!WORD.test(before) && !WORD.test(after)) {
        found.push(i);
        if (!all) return found;
      }
    }
    i++;
  }
  return found;
}

/** Разбить список на элементы по запятым верхнего уровня. */
function splitTopLevel(region: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let last = 0;
  let i = 0;
  while (i < region.length) {
    const c = region[i]!;
    if (c === "'" || c === '"') {
      i = skipQuoted(region, i, c);
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      items.push(region.slice(last, i));
      last = i + 1;
    }
    i++;
  }
  items.push(region.slice(last));
  return items;
}

const TRAILING_ALIAS = /\s+as\s+("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)\s*$/i;
const IDENT = '"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*';
const DOTTED_REF = new RegExp(`^(?:${IDENT})(?:\\s*\\.\\s*(?:${IDENT}))*$`);
const LAST_SEGMENT = new RegExp(`(?:${IDENT})\\s*$`);

/** Свой алиас у элемента проекции нам не нужен — sqlite-proxy читает позиционно. */
function stripTrailingAlias(item: string): string {
  return item.replace(TRAILING_ALIAS, '').trim();
}

function unquote(ident: string): string {
  return ident.startsWith('"') ? ident.slice(1, -1).replace(/""/g, '"') : ident;
}

/** Как SQLite назовёт эту колонку результата, если это предсказуемо. */
function outputName(item: string): string | null {
  const alias = TRAILING_ALIAS.exec(item);
  if (alias) return unquote(alias[1]!);
  const expr = item.trim();
  if (!DOTTED_REF.test(expr)) return null;
  const last = LAST_SEGMENT.exec(expr);
  return last ? unquote(last[0].trim()) : null;
}

export function planQuery(sql: string): QueryPlan {
  const head = /^\s*([A-Za-z]+)/.exec(sql)?.[1]?.toLowerCase() ?? '';
  if (head === 'pragma') return { kind: 'raw' }; // имена колонок PRAGMA уникальны

  const returning = findKeyword(sql, 'returning', 0, true);
  let start: number;
  let end: number;

  if (returning.length > 0) {
    start = returning[returning.length - 1]! + 'returning'.length;
    end = sql.length;
  } else {
    // `insert … select …` строк не отдаёт — алиасить его проекцию бессмысленно.
    if (head !== 'select' && head !== 'with' && head !== 'values') return { kind: 'exec' };
    const select = findKeyword(sql, 'select');
    if (select.length === 0) return { kind: 'exec' };
    start = select[0]! + 'select'.length;
    const modifier = /^\s+(distinct|all)\b/i.exec(sql.slice(start));
    if (modifier) start += modifier[0].length;
    const from = findKeyword(sql, 'from', start);
    end = from.length > 0 ? from[0]! : sql.length;
  }

  const items = splitTopLevel(sql.slice(start, end)).map((s) => s.trim());
  if (items.some((s) => s === '' || s === '*' || s.endsWith('.*'))) return { kind: 'raw' };

  const aliases = items.map((_, i) => `c${i}`);
  const names = items.map(outputName);
  const projection = items.map((item, i) => `(${stripTrailingAlias(item)}) as "${aliases[i]}"`).join(', ');
  const tail = sql.slice(end);
  return { kind: 'aliased', sql: `${sql.slice(0, start)} ${projection}${tail ? ` ${tail}` : ''}`, aliases, names };
}
