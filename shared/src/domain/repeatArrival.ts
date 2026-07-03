// Повторный заезд двигателя с тем же номером (план reclamation-mvp-2026-07 Ф2).
// Единица учёта — «заезд»: карточки с repeat_arrival_flag сосуществуют с прежними
// картами того же номера; старые заезды помечаются «архивный заезд» в списке.
import { normalizeLookupCompact } from './lookupNormalize.js';

export const REPEAT_ARRIVAL_FLAG = 'repeat_arrival_flag';
export const NUMBER_COLLISION_FLAG = 'number_collision_flag';
export const PREVIOUS_ARRIVAL_ID = 'previous_arrival_id';

export type ArrivalListItem = {
  id: string;
  engineNumber?: string;
  isRepeatArrival?: boolean;
  isNumberCollision?: boolean;
  arrivalDate?: number | null;
  createdAt?: number;
};

/**
 * Ids «архивных заездов»: в группе одинакового канон-номера, где есть хотя бы один
 * флагованный повторный заезд, все карточки КРОМЕ самой свежей (по дате прихода,
 * фолбэк created) считаются архивными. Группы без флага «повторный заезд» (случайные
 * дубли до склейки) и карточки «коллизия номера» (другой физический двигатель)
 * не помечаются.
 */
export function findArchivedArrivalIds(items: ArrivalListItem[]): Set<string> {
  const groups = new Map<string, ArrivalListItem[]>();
  for (const it of items) {
    if (it.isNumberCollision) continue;
    const key = normalizeLookupCompact(String(it.engineNumber ?? ''));
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(it);
  }
  const archived = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    if (!group.some((it) => it.isRepeatArrival)) continue;
    const ts = (it: ArrivalListItem) => it.arrivalDate ?? it.createdAt ?? 0;
    const newest = group.reduce((a, b) => (ts(b) > ts(a) ? b : a));
    for (const it of group) {
      if (it.id !== newest.id) archived.add(it.id);
    }
  }
  return archived;
}
