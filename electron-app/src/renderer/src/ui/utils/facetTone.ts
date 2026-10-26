/**
 * Цвет ступени фильтра (владелец 25.10.2026: «когда открываем много фильтров, получается каша —
 * нужно разделять их по цвету»).
 *
 * Цвет — свойство СТУПЕНИ, а не места в ряду: `customer` синяя и в списке двигателей, и в
 * отчёте, сколько бы раз ряд ни пересортировался по рейтингу. Поэтому оттенок берётся от id
 * ступени, а не от индекса.
 *
 * Оттенки выдаются по одному на ступень внутри списка: если два id попали в один оттенок,
 * второй сдвигается к соседнему. Палитра конечна (12 оттенков), а ступеней в списке двигателей
 * 23 — хвост ряда делит цвета с началом: различать два десятка фильтров по цвету всё равно
 * нельзя, а те, которыми пользуются, рейтинг поднимает влево, где цвета уже разные.
 *
 * Подложки заданы полупрозрачными: они ложатся и на светлую тему, и на ночную, и на сепию
 * (`global.css`), не требуя отдельной палитры на каждую.
 */

const FACET_HUES: readonly number[] = [212, 262, 152, 28, 340, 190, 96, 320, 8, 240, 172, 48];

export type FacetTone = {
  hue: number;
  /** Обводка и цветная полоса слева — сам «цвет фильтра». */
  accent: string;
  /** Заливка открытой кнопки ступени. */
  tint: string;
  /** Подложка панели со значениями ступени. */
  panel: string;
};

function slotOf(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 100_003;
  return hash % FACET_HUES.length;
}

function toneOfHue(hue: number): FacetTone {
  return {
    hue,
    accent: `hsl(${hue} 65% 45%)`,
    tint: `hsl(${hue} 70% 50% / 0.18)`,
    panel: `hsl(${hue} 70% 50% / 0.08)`,
  };
}

/**
 * Оттенки ступеней списка: `id → тон`. Порядок выдачи — порядок `ids` (он задан описанием
 * ступеней и от рейтинга не зависит), поэтому цвет ступени не меняется от сессии к сессии.
 */
export function facetTones(ids: readonly string[]): Record<string, FacetTone> {
  const used = new Set<number>();
  const out: Record<string, FacetTone> = {};
  for (const id of ids) {
    if (out[id]) continue;
    let slot = slotOf(id);
    for (let i = 0; i < FACET_HUES.length && used.has(slot); i += 1) slot = (slot + 1) % FACET_HUES.length;
    used.add(slot);
    out[id] = toneOfHue(FACET_HUES[slot]!);
  }
  return out;
}

/** Тон для ступени вне списка (не должно случаться, но без цвета кнопка не остаётся). */
export const FALLBACK_FACET_TONE: FacetTone = toneOfHue(215);
