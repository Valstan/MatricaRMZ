// Пометка строки утильного двигателя — одно правило на всю программу.
//
// ЗАЧЕМ. Утильный двигатель должен быть виден ВЕЗДЕ, где есть строка двигателя: в
// списке, в отчёте, в печатной форме. Раньше розовая полоса была только в основном
// списке двигателей, и в отчёте утиль выглядел как обычная строка — оператор мог
// не заметить, что двигатель уже признан утильным.
//
// ЦВЕТ. Тот же, что в основном списке: `rgba(239, 68, 68, 0.18)` — приглушённый
// красный поверх строки. В печати (белый фон) полупрозрачный цвет выглядит бледно,
// поэтому для печатных форм — плотный розовый `#fde8e8`.
//
// ПРИОРИТЕТ ПОМЕТОК. У строки бывает другое выделение: выбранный двигатель в списке
// (синее), просрочка в нарядах. Правило отдаёт только фон, поэтому вызывающий код
// накладывает своё выделение ПОСЛЕ — и оно перекрывает розовое (как в основном списке:
// синий выбор перекрывает розовый утиль).

/** Розовая пометка строки утильного двигателя на экране (совпадает с основным списком). */
export const ENGINE_SCRAP_ROW_BACKGROUND = 'rgba(239, 68, 68, 0.18)';

/** Плотный розовый для печати: на белом фоне полупрозрачный цвет бледнеет. */
export const ENGINE_SCRAP_ROW_BACKGROUND_PRINT = '#fde8e8';

/** Плашка «Утиль» на карточке двигателя: подпись, которую видит оператор первым. */
export const ENGINE_SCRAP_BADGE_LABEL = 'Утиль';
/** Фон плашки — тот же плотный розовый, что и для печати (на экране тоже читаем). */
export const ENGINE_SCRAP_BADGE_BACKGROUND = ENGINE_SCRAP_ROW_BACKGROUND_PRINT;
/** Текст плашки — тёмно-красный, читаем на розовом. */
export const ENGINE_SCRAP_BADGE_COLOR = '#b91c1c';

/**
 * Фон строки по признаку утиля. Пусто (без розового), если двигатель не утильный.
 *
 * @param isScrap признак утиля двигателя (тот же, что в основном списке).
 */
export function engineScrapRowStyle(isScrap: boolean | null | undefined): { background?: string } {
  return isScrap === true ? { background: ENGINE_SCRAP_ROW_BACKGROUND } : {};
}

/**
 * Строка каталога двигателей — источник признака утиля для любого списка.
 * Структурный тип: правило не тянет за собой весь `EngineListItem`.
 */
export type EngineScrapSource = { id: string; isScrap?: boolean | null };

/**
 * Карта «двигатель → утиль» по каталогу двигателей.
 *
 * ЗАЧЕМ. Признак утиля считается в одном месте — в списке двигателей (`listEngines`),
 * где он собирается из меток карточки, деталей в утиле и боковой ветки. Повторять это
 * правило в каждом экране нельзя: разойдутся определения, и двигатель в одном списке
 * будет утильным, а в соседнем — обычным (так уже было с «Забракован» против
 * «Признан утильным»). Поэтому списки, где двигатель — не главный объект (этапы
 * работ, карточка договора), берут признак из каталога, а не считают заново.
 *
 * @param engines каталог двигателей (`EngineListItem[]` подходит по структуре).
 */
export function engineScrapFlagsById(
  engines: readonly EngineScrapSource[] | null | undefined,
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const engine of engines ?? []) {
    const id = String(engine?.id ?? '').trim();
    if (!id) continue;
    out.set(id, engine.isScrap === true);
  }
  return out;
}

/**
 * Признак утиля двигателя по карте каталога. Двигателя нет в каталоге — не утиль.
 *
 * @param flags карта из `engineScrapFlagsById`.
 * @param engineId id двигателя строки.
 */
export function engineScrapById(
  flags: Map<string, boolean> | null | undefined,
  engineId: string | null | undefined,
): boolean {
  if (!flags || !engineId) return false;
  return flags.get(String(engineId)) === true;
}

/**
 * Тот же розовый, но для печати: плотный `#fde8e8` вместо полупрозрачного цвета.
 * На белом листе полупрозрачный бледнеет и розовый утиль не читается.
 *
 * @param isScrap признак утиля двигателя (тот же, что в основном списке).
 */
export function engineScrapRowBackgroundPrint(isScrap: boolean | null | undefined): string | undefined {
  return isScrap === true ? ENGINE_SCRAP_ROW_BACKGROUND_PRINT : undefined;
}
