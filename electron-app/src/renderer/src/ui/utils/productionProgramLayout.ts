/**
 * Правила экрана производственной программы: порядок плашек и раскладка
 * (промт КАРМАНА **#179**, зачитка владельца 27.11.2026).
 *
 * Правила живут здесь, а не в странице, потому что их держит сторож: «плашки
 * по свежести правки» и «программа занимает максимум экрана» — это два
 * проверяемых утверждения, и оба должны падать, если их вернули назад.
 *
 * Данных для этого не нужно новых: время последней правки программы
 * (`updatedAt`) и обе даты периода приезжают в реплике — ни новой таблицы,
 * ни новой серверной двери.
 */

/** Программа в том виде, в каком её видит экран. */
export type ProductionProgramTile = {
  id: string;
  /** Время последней правки на сервере (приезжает в реплике). */
  updatedAt: number;
};

/**
 * Клиентская метка правки: программа, которую оператор правит прямо сейчас.
 *
 * Серверное время ещё не обновилось (правка не уехала), поэтому «свежесть»
 * такой программы считаем по клиенту — иначе свежая правка осталась бы внизу
 * списка до прихода зеркала.
 */
export type ProductionProgramLocalEdit = {
  /** Когда оператор тронул программу (время клиента, мс). */
  at: number;
  /**
   * Какое серверное время программы было в тот момент.
   *
   * Это метка «зеркала»: как только реплика покажет другое серверное время,
   * зеркало догнало правку и клиентская метка больше не нужна. Сравнение по
   * значению, а не по «время правки позже времени сервера» — так правило не
   * зависит от расхождения часов клиента и сервера.
   */
  serverUpdatedAt: number;
};

/**
 * Время, по которому сортируем плашки: серверное, а поверх него — клиентское.
 *
 * Большее из двух: правка в руках оператора свежее всего, что есть.
 */
export function productionProgramFreshnessAt(
  program: ProductionProgramTile,
  localEdit?: ProductionProgramLocalEdit,
): number {
  const server = Number(program.updatedAt) || 0;
  const local = localEdit ? Number(localEdit.at) || 0 : 0;
  return Math.max(server, local);
}

/**
 * Порядок плашек: чем позже в программу вносили изменения, тем выше плашка.
 *
 * Порядок **тотальный**: при равенстве времён сравниваются сначала серверные
 * времена, потом id. Это не украшение: без последнего сравнения равные
 * программы менялись бы местами при каждом живом обновлении реплики, и
 * список «прыгал» бы под рукой у оператора.
 *
 * Исходный массив не трогаем — сортировка возвращает копию.
 */
export function sortProductionProgramsByFreshness<T extends ProductionProgramTile>(
  programs: readonly T[],
  localEdits?: ReadonlyMap<string, ProductionProgramLocalEdit>,
): T[] {
  return [...programs].sort((a, b) => {
    const freshA = productionProgramFreshnessAt(a, localEdits?.get(a.id));
    const freshB = productionProgramFreshnessAt(b, localEdits?.get(b.id));
    if (freshA !== freshB) return freshB - freshA;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.id.localeCompare(b.id);
  });
}

/** Левая колонка с карточками программ (как было до сжатия). */
export const PRODUCTION_PROGRAM_LIST_CARD_COLUMN = 'minmax(260px, 340px)';
/**
 * Левая колонка с вертикальными полосками — узкая, программа забирает остаток.
 *
 * 88 px, а не «сколько выйдет»: в полоске живут кнопки («К списку», «Развернуть»)
 * — при 72 px надпись переключателя не влезала и рельс показывал горизонтальную
 * прокрутку (проверено CDP-смоуком).
 */
export const PRODUCTION_PROGRAM_LIST_STRIP_COLUMN = '88px';
/** Правая колонка: программа занимает всё, что осталось. */
export const PRODUCTION_PROGRAM_PROGRAM_COLUMN = 'minmax(0, 1fr)';

/** Вид списка программ: карточки (название, период, цех, статус) или полоски. */
export type ProductionProgramListView = 'cards' | 'strip';

/** Раскладка экрана производственной программы. */
export type ProductionProgramLayout = {
  /** Ширина левой колонки (рельс плашек). */
  listColumn: string;
  /** Ширина правой колонки (программа). */
  programColumn: string;
  /** Что показывает рельс: карточки или вертикальные полоски. */
  railView: ProductionProgramListView;
  /** Развёрнутый список плавает поверх программы (программа сохраняет ширину). */
  listPanelOpen: boolean;
};

/**
 * Раскладка экрана: программа открыта или мы в списке.
 *
 * Правило одно: **открытая программа занимает максимум экрана.** Поэтому в
 * режиме программы левая колонка — всегда узкий рельс с вертикальными
 * полосками, а развёрнутый список (по требованию оператора) плавает поверх
 * программы и ширину ей не отбирает.
 */
export function productionProgramLayout(input: {
  /** Открыта ли программа (на весь экран). */
  programOpen: boolean;
  /** Показывать ли список развёрнутым (карточками). */
  listCards: boolean;
}): ProductionProgramLayout {
  if (input.programOpen) {
    return {
      listColumn: PRODUCTION_PROGRAM_LIST_STRIP_COLUMN,
      programColumn: PRODUCTION_PROGRAM_PROGRAM_COLUMN,
      railView: 'strip',
      listPanelOpen: input.listCards,
    };
  }
  return {
    listColumn: input.listCards
      ? PRODUCTION_PROGRAM_LIST_CARD_COLUMN
      : PRODUCTION_PROGRAM_LIST_STRIP_COLUMN,
    programColumn: PRODUCTION_PROGRAM_PROGRAM_COLUMN,
    railView: input.listCards ? 'cards' : 'strip',
    listPanelOpen: false,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function dayMonth(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
}

function fullDate(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/**
 * Подпись периода для вертикальной полоски: диапазон и год.
 *
 * Формат — решение владельца (промт #179 отдал его нам): по умолчанию
 * «01.11–15.11» и год на второй строке. Вертикально читается «01.11–15.11»
 * плохо, а год без месяцев не сказателен — обе строки вместе отвечают на
 * вопрос «какая это программа» без названия.
 */
export function productionProgramStripLabel(period: { start: number; end: number }): string {
  const startYear = new Date(period.start).getFullYear();
  const endYear = new Date(period.end).getFullYear();
  const range = `${dayMonth(period.start)}–${dayMonth(period.end)}`;
  const years = startYear === endYear ? String(startYear) : `${startYear}–${endYear}`;
  return `${range}\n${years}`;
}

/**
 * Крупная строка периода в шапке программы: вид периода и обе даты.
 *
 * Вид периода («Две недели», «Месяц», «Свои даты») — из того же домена, что и
 * подпись для печати: на экране и на бумаге период должен называться одинаково.
 */
export function productionProgramPeriodLine(
  period: { start: number; end: number },
  kindLabel: string,
): string {
  return `${kindLabel} · ${fullDate(period.start)} — ${fullDate(period.end)}`;
}
