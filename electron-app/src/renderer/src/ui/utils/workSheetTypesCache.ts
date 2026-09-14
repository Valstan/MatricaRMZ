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

/** Список узлов: сервер, при отказе — кэш. `fromCache` говорит экрану, что данные могут быть старыми. */
export async function loadWorkSheetTypes(opts: { includeArchived?: boolean } = {}): Promise<{ rows: WorkSheetType[]; fromCache: boolean; error?: string }> {
  try {
    const res = await window.matrica.workSheets.types.list(opts);
    if (res.ok) {
      if (!opts.includeArchived) writeWorkSheetTypesCache(res.rows);
      return { rows: res.rows, fromCache: false };
    }
    return { rows: readWorkSheetTypesCache(), fromCache: true, error: res.error };
  } catch (e) {
    return { rows: readWorkSheetTypesCache(), fromCache: true, error: String(e) };
  }
}
