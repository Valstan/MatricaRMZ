import { useEffect, useState } from 'react';

/**
 * Цех у строки списка приходит идентификатором (`EngineListItem.workshopId` — последнее
 * событие истории), а имя живёт в серверном справочнике без локальной реплики.
 * Хук подставляет `id → имя` одним запросом; нет связи или справочник пуст — пустая
 * карта, и читатель показывает снимок имени из самой строки (`workshopName`).
 * Используют список двигателей и отчёт «Сейчас на заводе» — одним способом.
 */
export function useWorkshopNames(): Record<string, string> {
  const [map, setMap] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await window.matrica.workshops.list({ activeOnly: false });
        if (!alive || !r?.ok) return;
        const next: Record<string, string> = {};
        for (const w of r.rows) next[String(w.id)] = String(w.name ?? '');
        setMap(next);
      } catch {
        /* ignore — читатель покажет снимок имени из строки */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return map;
}

/**
 * Имя цеха строки: свежее из справочника, иначе снимок из самой строки.
 * Пусто — честно пусто, «без названия» решает ступень фильтра, а не это место.
 */
export function resolveWorkshopName(
  workshopNameById: Record<string, string>,
  workshopId: string | null | undefined,
  snapshotName: string | null | undefined,
): string {
  const id = String(workshopId ?? '').trim();
  if (id && workshopNameById[id]) return workshopNameById[id];
  return String(snapshotName ?? '').trim();
}
