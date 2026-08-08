/**
 * Чанкинг больших IN()-списков. better-sqlite3 на десктопе позволяет 32k bind-параметров,
 * но Android-планшет (capacitor-sqlite) живёт на легаси-капе SQLITE_MAX_VARIABLE_NUMBER=999:
 * запрос с inArray на полторы тысячи id там падает, и «список нарядов/двигателей не грузится».
 * 400 — тот же консервативный размер, что IN_ARRAY_CHUNK в syncService.
 */
export const IN_ARRAY_CHUNK = 400;

/** Прогнать запрос по чанкам списка id ПОСЛЕДОВАТЕЛЬНО (android-адаптер БД не имеет
 * очереди на соединении — параллельные запросы там опасны) и склеить строки.
 * Порядок между чанками теряется; вызывающие, которым важен порядок per-entity,
 * не страдают — каждый entityId целиком попадает в один чанк. */
export async function collectChunked<TId, TRow>(
  ids: readonly TId[],
  run: (chunk: TId[]) => Promise<TRow[]>,
  size = IN_ARRAY_CHUNK,
): Promise<TRow[]> {
  if (ids.length === 0) return [];
  if (ids.length <= size) return run([...ids]);
  const out: TRow[] = [];
  for (let i = 0; i < ids.length; i += size) {
    out.push(...(await run(ids.slice(i, i + size))));
  }
  return out;
}
