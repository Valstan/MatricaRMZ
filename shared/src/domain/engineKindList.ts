/**
 * Вид («ГОЗ / гражданка») **в списках программы** — подписи, порядок, ступень фильтра и группа.
 *
 * Промт КАРМАНА #163 (зачитка владельца 26.11.2026): вид должен стать полноценным признаком
 * во всех списках — им фильтруют, по нему сортируют и по нему группируют; подписи короткие,
 * чтобы влезали в кнопки.
 *
 * **Правило расчёта вида — не здесь.** Его считает `engineKind.ts`
 * (`resolveEngineKind`: договор → карточка двигателя → карточка заказчика), и второй источник
 * правды в проекте быть не должно. Этот модуль — слой ПОВЕРХ правила: как вид называется в
 * тесных местах, в каком порядке идут строки и группы, и как ступень фильтра выглядит.
 *
 * **Почему отдельный модуль, а не ещё пара функций в `engineKind.ts`.** До 26.11.2026 ступень
 * «Вид» была написана трижды своими словами (`engineListFacets.ts`, `contractListFacets.ts`,
 * `counterpartyListFacets.ts`), а порядок вида при сортировке — ещё четвертый раз, вручную в
 * `EnginesPage.tsx`. Четыре реализации одного признака разъезжаются: в одном списке «вид не
 * задан» стоит вторым, в другом третьим, а подпись в ступени — то «Гражданский», то «Гражд.»,
 * и оператор видит, что «один и тот же фильтр» ведёт себя по-разному. Одна реализация —
 * один порядок, одна подпись, одна ступень.
 *
 * **Порядок вида задан, а не по алфавиту:** ГОЗ → гражданский → вид не задан. Вида нет у
 * большинства строк (замер 25.11.2026: из 61 неудалённого заказчика вида не заполнено у 59),
 * и по алфавиту «вид не задан» встал бы в начало — отбор «ГОЗ» тогда выглядел бы пустым.
 */
import { type ContractKind } from './contract.js';
import { ENGINE_KIND_NONE_VALUE } from './engineKind.js';
import type { FacetDescriptor, FacetValue } from './listFacets.js';
import type { GroupKey } from './listGrouping.js';

/**
 * Короткие подписи вида — для кнопок, ступеней фильтра, заголовков групп и подписей колонок
 * в тесных местах (планшет, узкая колонка).
 *
 * В карточках и печатных формах вид подписывается **полностью** («ГОЗ» / «Гражданский»):
 * там есть место, и полная подпись читается без расшифровки.
 */
export const CONTRACT_KIND_SHORT_LABELS: Record<ContractKind, string> = {
  military: 'ГОЗ',
  civil: 'Гражд.',
};

/** Подпись вида «не задан» — одна на всю программу (в ступенях, группах и печати). */
export const ENGINE_KIND_NONE_LABEL = 'Вид не задан';

/** Порядок вида: ГОЗ, потом гражданский, потом вид не задан. */
export const ENGINE_KIND_SORT_ORDER: readonly ContractKind[] = ['military', 'civil'];

/**
 * Ранг вида для сортировки и групп: 0 — ГОЗ, 1 — гражданский, 2 — вид не задан.
 *
 * Число, а не подпись: сортировка по подписи («Гражд.» против «ГОЗ») дала бы «Гражд.» раньше
 * «ГОЗ» по алфавиту, а порядок вида должен быть один и заданный.
 */
export function engineKindRank(kind: ContractKind | null | undefined): number {
  if (!kind) return ENGINE_KIND_SORT_ORDER.length;
  const index = ENGINE_KIND_SORT_ORDER.indexOf(kind);
  return index < 0 ? ENGINE_KIND_SORT_ORDER.length : index;
}

/** Сравнение вида для сортировки: меньше ранга — раньше. */
export function compareEngineKind(
  a: ContractKind | null | undefined,
  b: ContractKind | null | undefined,
): number {
  return engineKindRank(a) - engineKindRank(b);
}

/** Короткая подпись вида (в тесных местах); вида нет — «Вид не задан». */
export function engineKindShortLabel(kind: ContractKind | null | undefined): string {
  return kind ? CONTRACT_KIND_SHORT_LABELS[kind] : ENGINE_KIND_NONE_LABEL;
}

/**
 * Ключ группы «Вид» — порядок групп тот же, что и порядок сортировки.
 *
 * `rank` в `listGrouping.ts` трактуется как «больше — раньше», поэтому ранг вида инвертирован:
 * ГОЗ получает ранг 2, гражданский 1, «вид не задан» 0 — и идёт первым.
 */
export function engineKindGroupKey(kind: ContractKind | null | undefined): GroupKey {
  const value = kind ?? ENGINE_KIND_NONE_VALUE;
  return {
    key: value,
    label: engineKindShortLabel(kind),
    rank: ENGINE_KIND_SORT_ORDER.length - engineKindRank(kind),
  };
}

/**
 * Ряд значений ступени «Вид» — полный, с короткими подписями.
 *
 * Ряд полный потому, что вида «ГОЗ» на живых данных нет ни у кого: ступень, собранная только
 * по строкам, тогда просто исчезла бы из фильтра (та же причина, что у двигателей).
 */
export const ENGINE_KIND_FACET_OPTIONS: readonly FacetValue[] = [
  { value: 'military', label: CONTRACT_KIND_SHORT_LABELS.military },
  { value: 'civil', label: CONTRACT_KIND_SHORT_LABELS.civil },
  { value: ENGINE_KIND_NONE_VALUE, label: ENGINE_KIND_NONE_LABEL },
];

/**
 * Вид двигателя по его id — из каталога двигателей.
 *
 * Нужен спискам, чья строка про двигателя, но вида не несёт (наряды, этапы работ): вид
 * двигателя там уже посчитан по общему правилу (`resolveEngineKind` в `listEngines`), и
 * второй раз считать его в строке наряда не нужно — достаточно взять готовое значение.
 */
export function engineKindById(
  engines: readonly { id?: string | null; kind?: ContractKind | null }[],
): Map<string, ContractKind | null> {
  const out = new Map<string, ContractKind | null>();
  for (const engine of engines) {
    const id = String(engine.id ?? '').trim();
    if (!id) continue;
    out.set(id, engine.kind ?? null);
  }
  return out;
}

/**
 * Ступень «Вид» — **одна на все списки программы**.
 *
 * `kindOf` отдаёт вид строки; вид приходит в строку готовым (его считает `listEngines` по
 * общему правилу `resolveEngineKind`) либо берётся из каталога двигателей, если стока в списке
 * вида не несёт (наряды). Второго счёта вида здесь не происходит.
 */
export function engineKindFacetDescriptor<Row>(args: {
  /** Id ступени — по умолчанию `kind` (один и тот же во всех списках). */
  id?: string;
  /** Подпись ступени — по умолчанию «Вид». */
  label?: string;
  /** Вид строки. */
  kindOf: (row: Row) => ContractKind | null | undefined;
  /**
   * Есть ли в ступени значение «Вид не задан».
   *
   * По умолчанию — да: двигатель или заказчик без вида должен отбираться ОТДЕЛЬНО, а не
   * выпадать из отбора молча (промт КАРМАНА #163, п.7). Для договора — нет: вид у него
   * всегда есть (умолчание «ГОЗ», `DEFAULT_CONTRACT_KIND`), и значение, которого не бывает
   * никогда, в ступени только шумит.
   */
  includeNone?: boolean;
}): FacetDescriptor<Row> {
  return {
    kind: 'values',
    id: args.id ?? 'kind',
    label: args.label ?? 'Вид',
    valueOf: (row) => {
      const kind = args.kindOf(row);
      return { value: kind ?? ENGINE_KIND_NONE_VALUE, label: engineKindShortLabel(kind) };
    },
    options: args.includeNone === false ? ENGINE_KIND_FACET_OPTIONS.slice(0, 2) : ENGINE_KIND_FACET_OPTIONS,
  };
}
