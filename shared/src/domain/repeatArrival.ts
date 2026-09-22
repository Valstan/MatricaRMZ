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
  const archived = new Set<string>();
  for (const [id, placement] of arrivalPlacements(items)) {
    if (placement.role === 'archived') archived.add(id);
  }
  return archived;
}

/**
 * Роль карточки в группе заездов.
 * - `single` — заездов с этим номером один (или группа не про повторный заезд);
 * - `current` — самый свежий заезд в группе;
 * - `archived` — заезд есть, но существует более свежий.
 */
export type ArrivalRole = 'single' | 'current' | 'archived';

export type ArrivalPlacement = {
  role: ArrivalRole;
  /** Порядковый номер заезда от старого к новому, начиная с 1. */
  index: number;
  /** Сколько всего заездов в группе. */
  total: number;
  /** Год заезда — в подписи он отличает «архивный заезд 2025» от соседнего. */
  year?: number;
};

/**
 * Место каждой карточки в своей группе заездов (владелец 22.09.2026).
 *
 * Зачем шире, чем прежний набор архивных: список умел показать «архивный заезд», а
 * выпадающий выбор двигателя не умел ничего — два заезда одного номера в нём
 * неразличимы, и оператор выбирал старый, портя историю. Сама карточка тоже знала
 * только собственный флаг: архивный заезд не догадывался, что он архивный, а
 * флагованный называл себя «повторным», даже будучи уже третьим по счёту.
 *
 * Правило группировки прежнее и остаётся одним на всех: группируем по канон-номеру,
 * карточки «коллизия номера» исключаем (другой физический двигатель), и группу
 * считаем заездами, только если хотя бы одна карточка помечена «повторный заезд» —
 * иначе это случайные дубли, территория склейки, а не истории заездов.
 */
export function arrivalPlacements(items: ArrivalListItem[]): Map<string, ArrivalPlacement> {
  const groups = new Map<string, ArrivalListItem[]>();
  for (const it of items) {
    if (it.isNumberCollision) continue;
    const key = normalizeLookupCompact(String(it.engineNumber ?? ''));
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(it);
  }

  const ts = (it: ArrivalListItem) => it.arrivalDate ?? it.createdAt ?? 0;
  const out = new Map<string, ArrivalPlacement>();
  for (const group of groups.values()) {
    if (group.length < 2 || !group.some((it) => it.isRepeatArrival)) continue;
    // От старого к новому. Ровные даты разводим по id — иначе порядок «N-й из M»
    // менялся бы от прогона к прогону, и подпись в выпадашке прыгала бы.
    const ordered = [...group].sort((a, b) => ts(a) - ts(b) || String(a.id).localeCompare(String(b.id)));
    const total = ordered.length;
    ordered.forEach((it, i) => {
      const at = it.arrivalDate ?? it.createdAt;
      const year = at != null && Number.isFinite(at) ? new Date(at).getFullYear() : undefined;
      out.set(it.id, {
        role: i === total - 1 ? 'current' : 'archived',
        index: i + 1,
        total,
        ...(year != null ? { year } : {}),
      });
    });
  }
  return out;
}

/**
 * Подпись заезда для выпадающего выбора двигателя и списков: «свежий заезд (2 из 2)»
 * либо «архивный заезд 2025 (1 из 2)». Пусто, если заезд единственный — в обычном
 * случае лишнее слово в каждой строке выпадашки только мешает.
 */
export function arrivalPlacementLabel(placement: ArrivalPlacement | undefined): string {
  if (!placement || placement.role === 'single') return '';
  const head = placement.role === 'current' ? 'свежий заезд' : 'архивный заезд';
  const year = placement.role === 'archived' && placement.year != null ? ` ${placement.year}` : '';
  return `${head}${year} (${placement.index} из ${placement.total})`;
}
