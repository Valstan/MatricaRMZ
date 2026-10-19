/**
 * Набор колонок для печати и выгрузки. Печать и выгрузка берут ОДИН набор, иначе файл
 * расходится с листом (владелец настраивает колонки в диалоге печати и ждёт их же в Excel).
 * Хранение — `localStorage` по ключу страницы: «посмотреть» и «распечатать» остаются разными
 * задачами с разными наборами полей.
 */

function loadStoredIds(storageKey: string, fallback: string[], known: Set<string>): string[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const ids = parsed.map((v) => String(v)).filter((id) => known.has(id));
    return ids.length > 0 ? ids : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Колонки страницы из памяти. По умолчанию — ровно те, что видны на экране (оператор настроил
 * список под себя); если в списке колонки все скрыты, берём первые пять из доступных, чтобы
 * печать и выгрузка не остались без колонок вовсе.
 */
export function resolvePrintColumnIds(config: {
  storageKey: string;
  columns: readonly { id: string }[];
  visibleColumnIds: readonly string[];
}): string[] {
  const known = new Set(config.columns.map((c) => c.id));
  const visible = config.visibleColumnIds.filter((id) => known.has(id));
  const fallback = visible.length > 0 ? visible : config.columns.slice(0, 5).map((c) => c.id);
  return loadStoredIds(config.storageKey, fallback, known);
}
