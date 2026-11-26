/**
 * Вид двигателя (ГОЗ — государственный оборонный заказ, или гражданский) — одно правило
 * на всю программу (просьба владельца 18.11.2026).
 *
 * **Вид — вычисляемое значение, а не поле, которое кто-то переписывает.** У двигателя
 * вид может прийти из трёх мест, и порядок один и тот же везде:
 *
 *   1. **договор** двигателя — вид договора (`contract_sections.primary.kind`);
 *   2. **карточка** двигателя — ручное значение оператора (временное: живёт, пока
 *      договора нет);
 *   3. **карточка контрагента** — ручное значение заказчика (значение по умолчанию для
 *      его двигателей).
 *
 * Раньше вид жил только в договоре, и в списке двигателей его не было вовсе: фильтровать
 * «военку/гражданку» по двигателям было нечем, а в отчётах вид читался каждый раз по-своему.
 *
 * **Ручное значение не переписывается при появлении договора.** Оно просто перестаёт быть
 * первым источником: договор перебивает его, и везде, где вид считается, он меняется сам.
 * Стража, которая переписывала бы поле в фоне, конфликтовала бы с ручным значением и ломала
 * бы историю («почему у двигателя вчера был ГОЗ, а сегодня гражданский» — потому что вчера
 * договора не было).
 *
 * **Когда источников нет вовсе — вида нет (`null`), а не «ГОЗ по умолчанию».** Умолчание
 * есть только у ДОГОВОРА (забытый переключатель не должен оставлять договор без вида);
 * двигатель без договора, без ручного значения и без значения заказчика — это двигатель,
 * про который ещё не сказано, какой он. Молчаливый «ГОЗ» был бы выдумкой: список показывал
 * бы несуществующий факт, и фильтр отбирал бы не то.
 *
 * Прецедент — ровно тот же, что у заказчика двигателя (`engineCustomer.ts`): договор читается
 * первым, поле карточки остаётся запасным путём, а `source` возвращается наружу, чтобы
 * интерфейс мог показать оператору, откуда взято значение.
 */
import { CONTRACT_KIND_LABELS, parseContractKind, type ContractKind } from './contract.js';

/** Откуда взят вид двигателя. */
export type EngineKindSource = 'contract' | 'card' | 'counterparty' | 'none';

export type EngineKindResolution = {
  /** Вид двигателя; `null` — вид не задан (ни один источник не сказал). */
  kind: ContractKind | null;
  /** Источник значения — чтобы UI показал «из договора» / «вручную». */
  source: EngineKindSource;
};

/** Источники вида: каждый может отсутствовать. */
export type EngineKindSources = {
  /** Вид договора двигателя (`contract_sections.primary.kind`). */
  contractKind?: unknown;
  /** Ручное значение в карточке двигателя. */
  cardKind?: unknown;
  /** Ручное значение в карточке контрагента (заказчика). */
  counterpartyKind?: unknown;
};

/**
 * Единственное место, где считается вид двигателя. Любое место, где вид показывается или
 * фильтруется, зовёт эту функцию — второго источника правды в проекте быть не должно.
 */
export function resolveEngineKind(sources: EngineKindSources | null | undefined): EngineKindResolution {
  const fromContract = parseContractKind(sources?.contractKind);
  if (fromContract) return { kind: fromContract, source: 'contract' };

  const fromCard = parseContractKind(sources?.cardKind);
  if (fromCard) return { kind: fromCard, source: 'card' };

  const fromCounterparty = parseContractKind(sources?.counterpartyKind);
  if (fromCounterparty) return { kind: fromCounterparty, source: 'counterparty' };

  return { kind: null, source: 'none' };
}

/** Подпись источника — интерфейсу показывать оператору, откуда взято значение. */
export const ENGINE_KIND_SOURCE_LABELS: Record<EngineKindSource, string> = {
  contract: 'из договора',
  card: 'вручную в карточке',
  counterparty: 'из карточки заказчика',
  none: 'вид не задан',
};

/** Подпись вида для оператора: «ГОЗ» / «Гражданский»; вида нет — прочерк. */
export function engineKindLabel(kind: ContractKind | null | undefined): string {
  return kind ? CONTRACT_KIND_LABELS[kind] : '—';
}

/**
 * Значение ступени фильтра для двигателя без вида: их надо отбирать отдельно («вид не
 * задан»), иначе они молча выпадают из отбора вместе с фильтром по виду.
 */
export const ENGINE_KIND_NONE_VALUE = 'none';

/** Значение ступени фильтра: вид двигателя либо «не задан». */
export function engineKindFacetValue(kind: ContractKind | null | undefined): string {
  return kind ?? ENGINE_KIND_NONE_VALUE;
}

/** Подпись значения ступени фильтра. */
export function engineKindFacetLabel(kind: ContractKind | null | undefined): string {
  return kind ? CONTRACT_KIND_LABELS[kind] : 'Вид не задан';
}

/**
 * Вид заказчика (префикс): «ГОЗ» или «Гражданский».
 *
 * Живёт в строгой таблице `erp_counterparties.engine_kind` — и только там. В легаси-EAV
 * вида нет, и брать его оттуда нельзя: подпись и отбор должны читать ОДИН источник, иначе
 * часть заказчиков «потеряет» вид (промт КАРМАНА #147, риск «источник должен быть один»).
 *
 * Разбор — тем же `parseContractKind`, что у договора и у двигателя: значения 'military'/'civil'
 * одни и те же, а мусор в базе не должен становиться видом.
 */
export function parseCounterpartyKind(raw: unknown): ContractKind | null {
  return parseContractKind(raw);
}

/**
 * Отбор заказчиков по виду договора (промт КАРМАНА #147, владелец 25.11.2026).
 *
 * **Правило в обе стороны.** Заказчик вида «Гражданский» не предлагается в ГОЗ-договоре,
 * заказчик вида «ГОЗ» — в гражданском. Это ФИЛЬТР подсказок поля «Контрагент», а не гейт
 * заведения двигателя: гейт (`engineKindRequirement`) вид заказчика по-прежнему не принимает —
 * при заведении вид выбирает оператор. Правила разные, и путать их нельзя.
 *
 * **Заказчик БЕЗ вида предлагается всегда — отдельной группой и с пометкой «Вид не задан».**
 * Так зафиксировано решением владельца по п.5 промта, и вот почему именно так: на живых
 * данных 25.11.2026 из 61 неудалённого заказчика вида не заполнено у 59, гражданских — 2,
 * а вида «ГОЗ» нет НИ У КОГО. Прятать «без вида» означало бы оставить оператора с пустым
 * полем «Контрагент» в каждом ГОЗ-договоре, и он прочёл бы это как поломку (ровно тот риск,
 * который промт называет первым). Прятать можно только заказчиков С ЧУЖИМ видом — там отбор
 * осмыслен, а «нет вида» это отсутствие факта, а не противоречие.
 *
 * **Вид договора не выбран ⇒ отбор выключен.** Состояния «не выбрано» в карточке договора
 * нет: разбор секций даёт вид по умолчанию («ГОЗ», `DEFAULT_CONTRACT_KIND`), и переключатель
 * всегда показывает один из двух видов. Но правило описано и для неизвестного вида: тогда
 * показываются все заказчики — отбор по неизвестному виду отбирал бы не то.
 */
export type CounterpartyKindVerdict =
  /** Вид заказчика совпал с видом договора. */
  | 'match'
  /** У заказчика вида нет — он виден всегда, но отдельной группой. */
  | 'unassigned'
  /** Вид заказчика чужой — такого в этом договоре не предлагаем. */
  | 'mismatch'
  /** Вид договора неизвестен — отбор выключен, показываем всех. */
  | 'off';

/** Что правило отбора говорит о конкретном заказчике при конкретном виде договора. */
export function counterpartyKindVerdict(counterpartyKind: unknown, contractKind: unknown): CounterpartyKindVerdict {
  const contract = parseContractKind(contractKind);
  if (!contract) return 'off';
  const counterparty = parseContractKind(counterpartyKind);
  if (!counterparty) return 'unassigned';
  return counterparty === contract ? 'match' : 'mismatch';
}

/**
 * Отбор заказчиков по виду договора — единственное место, где правило применяется к списку.
 *
 * `keepIds` — заказчики, которых видно ВСЕГДА, даже если их вид чужой: выбранный в договоре
 * контрагент не должен исчезать из поля из-за смены вида договора (иначе интерфейс врал бы,
 * что значение удалено).
 */
export function filterCounterpartiesByContractKind<T extends { id?: string; engineKind?: unknown }>(
  rows: readonly T[],
  contractKind: unknown,
  options?: { keepIds?: readonly string[] },
): T[] {
  const keep = new Set((options?.keepIds ?? []).map((id) => String(id)));
  return rows.filter((row) => {
    if (keep.has(String(row.id ?? ''))) return true;
    return counterpartyKindVerdict(row.engineKind, contractKind) !== 'mismatch';
  });
}

/**
 * Подпись вида заказчика в подсказке поля выбора — оператор должен видеть, почему заказчик
 * предложен или не предложен (промт #147, п.6: «заказчик пропал из подсказок» не должно
 * читаться как поломка).
 */
export function counterpartyKindHint(counterpartyKind: unknown): string {
  const kind = parseContractKind(counterpartyKind);
  return kind ? `Вид: ${CONTRACT_KIND_LABELS[kind]}` : 'Вид не задан';
}

/**
 * Текст под полем «Контрагент»: какое правило отбора сейчас работает и сколько заказчиков
 * из-за него не показывается. Без такой строки отбор читается как поломка (промт #147, п.6).
 */
export function counterpartyKindFilterNote(args: {
  /** Вид договора; `null`/пусто — вид неизвестен, отбор выключен. */
  contractKind: unknown;
  /** Сколько заказчиков скрыто отбором по виду. */
  hiddenCount: number;
  /** Подпись вида договора для текста. */
  contractKindLabel?: string;
}): string {
  const kind = parseContractKind(args.contractKind);
  if (!kind) {
    return 'Вид договора не задан — отбор по виду выключен, показаны все заказчики.';
  }
  const label = args.contractKindLabel ?? CONTRACT_KIND_LABELS[kind];
  const hidden = Math.max(0, Math.trunc(Number(args.hiddenCount) || 0));
  const hiddenText = hidden > 0 ? ` Скрыто: ${hidden} (вид «${CONTRACT_KIND_LABELS[kind === 'military' ? 'civil' : 'military']}»).` : '';
  return `Отбор по виду договора: показываются заказчики вида «${label}» и заказчики без вида.${hiddenText}`;
}

/**
 * Гейт вида при ЗАВЕДЕНИИ двигателя (промты КАРМАНА #36 + #37, владелец 18.11.2026).
 *
 * **Новый двигатель нельзя сохранить без вида.** Договор у него уже выбран — вид берётся
 * из договора, спрашивать оператора не надо. Договора нет — вид оператор ставит руками
 * (военный или гражданский), и без этого карточка не сохраняется.
 *
 * **Почему это требование владельца, а не украшение:** двигатель без вида молча выпадает
 * из отбора по виду («военка/гражданка»), и в отчётах он выглядит как ничей. Вид, который
 * никто не сказал, — это не «ГОЗ по умолчанию», а отсутствие факта.
 *
 * **Третий источник приоритета (вид заказчика по умолчанию) гейтом НЕ принимается:**
 * по требованию владельца при заведении вид выбирает оператор, а не подставляется
 * из карточки контрагента. Иначе «принудительно попросить» означало бы «и так сойдёт».
 *
 * **Отбор заказчиков по виду договора (промт #147) — другое правило, и гейт его не меняет.**
 * Фильтр подсказок поля «Контрагент» отбирает по виду заказчика (см.
 * `counterpartyKindVerdict` выше), а гейт заведения по-прежнему вид заказчика не принимает.
 *
 * Гейт живёт в домене, а дверь записи карточки его зовёт: правило должно быть одно и
 * то же для карточки и для пачечного приёма (второй вход в ту же дверь).
 */
export type EngineKindRequirement =
  | { ok: true; kind: ContractKind; source: 'contract' | 'card' }
  | { ok: false; error: string };

/**
 * Источники для гейта заведения: вид договора (если договор выбран) и ручной вид карточки.
 */
export type EngineKindRequirementSources = {
  /** Вид договора двигателя; `null`/пусто — договор не выбран или вида у него нет. */
  contractKind?: unknown;
  /** Ручной вид в карточке двигателя. */
  cardKind?: unknown;
};

/** Текст отказа для оператора. */
export const ENGINE_KIND_REQUIRED_MESSAGE =
  'Вид двигателя не задан: выберите договор — вид возьмётся из него — или поставьте вид вручную (ГОЗ или гражданский).';

/**
 * Проверка вида для заведения двигателя. `ok: false` — вид не задан, и карточку
 * сохранять нельзя: возвращаем текст для оператора.
 */
export function engineKindRequirement(sources: EngineKindRequirementSources | null | undefined): EngineKindRequirement {
  const fromContract = parseContractKind(sources?.contractKind);
  if (fromContract) return { ok: true, kind: fromContract, source: 'contract' };
  const fromCard = parseContractKind(sources?.cardKind);
  if (fromCard) return { ok: true, kind: fromCard, source: 'card' };
  return { ok: false, error: ENGINE_KIND_REQUIRED_MESSAGE };
}
