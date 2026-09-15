import type { WorkSheetType } from '@matricarmz/shared';

/**
 * Последний удачный список узлов ведомостей — на случай офлайна: справочник живёт на сервере
 * (REST), а строки ведомостей самоописываемы и читаются без него. Кэш нужен лишь для того,
 * чтобы экран показал вкладки и колонки, не дождавшись сервера.
 */
const KEY = 'matrica:workSheetTypes:v1';

export function readWorkSheetTypesCache(): WorkSheetType[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WorkSheetType[]) : [];
  } catch {
    return [];
  }
}

export function writeWorkSheetTypesCache(rows: WorkSheetType[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(rows));
  } catch {
    // localStorage недоступен — просто не кэшируем
  }
}

/**
 * Список узлов: сервер, при отказе — кэш. Состояний ТРИ, и экран обязан различать все:
 * `server` — свежий список; `cache` — сервер молчит, набор может быть устаревшим; `none` —
 * сервера нет И кэш пуст (первый запуск офлайн). Без третьего состояния экран в этом случае
 * показывал пустой набор вкладок молча, как будто узлов на заводе не заведено.
 */
export type WorkSheetTypesSource = 'server' | 'cache' | 'none';

export async function loadWorkSheetTypes(
  opts: { includeArchived?: boolean } = {},
): Promise<{ rows: WorkSheetType[]; source: WorkSheetTypesSource; error?: string }> {
  const fallback = (error: string) => {
    const cached = readWorkSheetTypesCache();
    return { rows: cached, source: (cached.length > 0 ? 'cache' : 'none') as WorkSheetTypesSource, error };
  };
  try {
    const res = await window.matrica.workSheets.types.list(opts);
    if (res.ok) {
      if (!opts.includeArchived) writeWorkSheetTypesCache(res.rows);
      return { rows: res.rows, source: 'server' };
    }
    return fallback(res.error);
  } catch (e) {
    return fallback(String(e));
  }
}
