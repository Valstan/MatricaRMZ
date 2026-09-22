import { arrivalPlacementLabel, normalizeLookupCompact, type ArrivalPlacement } from '@matricarmz/shared';

/**
 * Двигатель глазами выпадающего списка. Тип структурный, а не `EngineListItem`: тем же
 * хелпером пользуется кеш справочников наряда, где строка двигателя своя и урезанная.
 */
export type EngineOptionEngine = {
  id: string;
  engineNumber?: string | null;
  internalNumberFull?: string | null;
  engineBrand?: string | null;
  arrival?: ArrivalPlacement | undefined;
};

/**
 * Служебный хвост подписи — «… · свежий заезд (2 из 2)» (владелец 22.09.2026).
 *
 * Отдельной функцией, потому что состав самой подписи в разных списках разный (где-то
 * один номер, где-то номер с маркой), а различать заезды нужно одинаково везде. Точка-
 * разделитель выбрана намеренно: через тире пометка читалась бы как часть номера.
 * Одиночный заезд хвоста не получает — строка обязана остаться ровно прежней.
 */
export function withArrivalNote(label: string, arrival?: ArrivalPlacement): string {
  const note = arrivalPlacementLabel(arrival);
  return note ? `${label} · ${note}` : label;
}

/** Подпись без пометки заезда: «номер — внутр. 41/26 — ЯМЗ», фолбэк — короткий id. */
export function engineOptionBaseLabel(engine: EngineOptionEngine): string {
  const internal = engine.internalNumberFull?.trim();
  const parts = [engine.engineNumber, internal ? `внутр. ${internal}` : '', engine.engineBrand].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(' — ') : engine.id.slice(0, 8);
}

/** Полная подпись двигателя для выпадающего списка: состав прежний, плюс пометка заезда. */
export function engineOptionLabel(engine: EngineOptionEngine): string {
  return withArrivalNote(engineOptionBaseLabel(engine), engine.arrival);
}

function arrivalRank(arrival?: ArrivalPlacement): number {
  return arrival?.role === 'archived' ? 1 : 0;
}

/**
 * Порядок опций: общий — прежний, по базовой подписи, а внутри одного номера архивные
 * заезды уходят под свежий.
 *
 * Сортировать готовые подписи после появления пометки нельзя: «архивный» встаёт раньше
 * «свежего» по алфавиту, и первым под пальцем оператора оказывается как раз старый заезд,
 * которого владелец и просил избежать.
 */
export function compareEngineOptions(a: EngineOptionEngine, b: EngineOptionEngine): number {
  const keyA = normalizeLookupCompact(String(a.engineNumber ?? ''));
  const keyB = normalizeLookupCompact(String(b.engineNumber ?? ''));
  if (keyA && keyA === keyB) {
    const byRole = arrivalRank(a.arrival) - arrivalRank(b.arrival);
    if (byRole !== 0) return byRole;
    // Среди архивных свежий выше: index растёт от старого заезда к новому.
    const byIndex = (b.arrival?.index ?? 0) - (a.arrival?.index ?? 0);
    if (byIndex !== 0) return byIndex;
  }
  return engineOptionBaseLabel(a).localeCompare(engineOptionBaseLabel(b), 'ru');
}
