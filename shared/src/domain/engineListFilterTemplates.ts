import type { EngineFacetSelection } from './engineListFacets.js';

/**
 * Шаблон фильтров списка двигателей (промт КАРМАНА #181).
 *
 * Шаблон хранит: значения выбранных ступеней, перечень ВКЛЮЧЁННЫХ ступеней и перечень
 * ОТКЛЮЧЁННЫХ фильтров. Всё это — параметры фильтра, а не выбранные данные из базы.
 *
 * Отдельно и по воле владельца: выбор ЗАКАЗЧИКА и ДОГОВОРА в шаблон НЕ тащат. Это данные
 * из базы (конкретный контрагент, конкретный договор), а не параметры фильтра: по шаблону
 * список должен открываться по всем заказчикам и всем договорам.
 */

export const ENGINE_LIST_TEMPLATE_EXCLUDED_FACETS = ['customer', 'contract'] as const;

export type EngineListTemplatePayload = {
  /** Значения ступеней: id ступени → выбранные значения (или период). */
  filters: Record<string, unknown>;
  /** Какие ступени шаблон включает. */
  enabled: string[];
  /** Перечень отключённых фильтров (ступени, в шаблон не вошедшие). */
  disabled: string[];
};

/** Отбор, который в шаблон не тащат (владелец: по шаблону — все заказчики и договоры). */
export function isTemplateExcludedFacet(facetId: string): boolean {
  return (ENGINE_LIST_TEMPLATE_EXCLUDED_FACETS as readonly string[]).includes(facetId);
}

/**
 * Собрать содержимое шаблона из текущего отбора списка.
 *
 * `knownFacetIds` — ступени списка (все, что знает список): из них считается перечень
 * отключённых фильтров — те ступени, что в шаблон не вошли.
 */
export function buildEngineListTemplatePayload(
  selection: EngineFacetSelection,
  knownFacetIds: readonly string[],
): EngineListTemplatePayload {
  const filters: Record<string, unknown> = {};
  for (const [facetId, value] of Object.entries(selection ?? {})) {
    if (isTemplateExcludedFacet(facetId)) continue;
    if (value == null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    filters[facetId] = value;
  }
  const enabled = Object.keys(filters);
  const enabledSet = new Set(enabled);
  const disabled = knownFacetIds.filter((id) => !enabledSet.has(id));
  return { filters, enabled, disabled };
}

/**
 * Отбор списка из шаблона: значения шаблона и НИЧЕГО сверх них — заказчик и договор
 * после применения пусты (владелец: «в шаблоне нет выбранного заказчика и договора»).
 */
export function applyEngineListTemplatePayload(payload: EngineListTemplatePayload): EngineFacetSelection {
  const out: EngineFacetSelection = {};
  for (const [facetId, value] of Object.entries(payload?.filters ?? {})) {
    if (isTemplateExcludedFacet(facetId)) continue;
    if (value == null) continue;
    out[facetId as keyof EngineFacetSelection] = value as Exclude<EngineFacetSelection[keyof EngineFacetSelection], undefined>;
  }
  return out;
}
