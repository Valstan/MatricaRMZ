import type { EngineListItem } from '../ipc/types.js';
import {
  STATUS_LABELS,
  canonicalContractSectionKey,
  isContractAddonToken,
  type StatusCode,
} from './contract.js';
import { engineKindFacetDescriptor } from './engineKindList.js';
import {
  ENGINE_FACTORY_STAGE_LABELS,
  engineFactoryStage,
  engineStatusDate,
  returnsPass,
  type EngineFactoryStageTypeRef,
} from './engineFactoryStage.js';
import {
  DEFAULT_REPAIR_STAGE_TEMPLATES,
  equivalentStageCodes,
  isServiceStageCode,
  repairStageTemplate,
  stageAnsweringAliases,
  type RepairStageTemplate,
} from './repairStages.js';
import {
  repairStageList,
  repairStageValue,
} from './repairStageList.js';
import { COUNTDOWN_STALE_DAYS, countdownThresholds, isEngineDoneForCountdown } from './payments.js';
import {
  activeFacetCount,
  applyFacets,
  clearFacet,
  facetIsActive,
  facetOptions,
  facetRangeOf,
  sanitizeFacetSelection,
  setFacetDateBound,
  toggleFacetValue,
  type FacetDateRange,
  type FacetDescriptor,
  type FacetOption,
  type FacetSelection,
  type FacetValue,
} from './listFacets.js';
import type { ArrivalRole } from './repeatArrival.js';

/**
 * Ступени списка двигателей поверх общего движка (`listFacets.ts`) — там же описано,
 * почему варианты считаются по строкам, прошедшим ОСТАЛЬНЫЕ ступени, и зачем нужен
 * второй вид ступени (диапазон дат).
 */
export type EngineFacetId =
  | 'customer'
  | 'contract'
  | 'kind'
  | 'brand'
  | 'arrivalYear'
  | 'arrival'
  | 'completenessAct'
  | 'defectAct'
  | 'presence'
  | 'status'
  | 'repairDeadline'
  | 'workshop'
  | 'scrap'
  | 'reclamation'
  | 'reclamationAccepted'
  | 'reclamationShipped'
  | 'arrivalDate'
  | 'defectDate'
  | 'shippingDate'
  | 'repairStartedDate'
  | 'repairedDate'
  | 'hasStage'
  | 'repairStage'
  | 'stageDate'
  | 'factoryStage'
  | 'hasRepeatPass';

export type EngineFacetValue = FacetValue;
export type EngineFacetDateRange = FacetDateRange;
export type EngineFacetDescriptor = FacetDescriptor<EngineListItem> & { id: EngineFacetId };
export type EngineFacetOption = FacetOption;
/** Выбор по ступеням: список значений либо диапазон дат — по виду ступени. */
export type EngineFacetSelection = Partial<Record<EngineFacetId, string[] | EngineFacetDateRange>>;

const NO_VALUE = null;

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function dateMs(value: unknown): number | null {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value : null;
  return ms != null && ms > 0 ? ms : null;
}

/**
 * Стадии от поздней к ранней: «где двигатель сейчас» — это самый поздний выставленный
 * флаг, а не все сразу. Ремонт начат и двигатель отремонтирован — стадия «отремонтирован».
 */
const ENGINE_STATUS_STAGE_ORDER: readonly StatusCode[] = [
  'status_customer_accepted',
  'status_customer_sent',
  'status_rework_sent',
  'status_rejected',
  'status_repaired',
  'status_scrap_confirmed',
  'status_repair_started',
  'status_storage_received',
];

/**
 * Заезды в ступени идут от свежего к архивному: оператор ищет в отчёте текущий заезд, а не
 * перебирает историю. «Единственный» — хвост ряда: это обычный двигатель, а не заезд.
 */
const ARRIVAL_STAGE_ORDER: readonly ArrivalRole[] = ['current', 'archived', 'single'];

const ARRIVAL_LABELS: Record<ArrivalRole, string> = {
  current: 'свежий',
  archived: 'архивный',
  single: 'единственный',
};

const DAY_MS = 86_400_000;

/**
 * Срок ремонта по контракту (владелец 22.09.2026: «чтобы по горящим двигателям можно было
 * отфильтровать»). Значения идут от срочного к спокойному: горящие — то, ради чего ступень и
 * открывают. «Без движения» стоит после живых, но до «нет даты» и «закончен»: срок у такого
 * двигателя вышел, но разбирать надо не просрочку, а брошенный учёт. «Без даты поступления» —
 * тоже работа, а не тишина: отсчитывать такому двигателю срок не от чего, и он должен быть
 * виден отдельно.
 */
type RepairDeadlineKey = 'danger' | 'warning' | 'ok' | 'stale' | 'no_arrival' | 'done';

const REPAIR_DEADLINE_LABELS: Record<RepairDeadlineKey, string> = {
  danger: 'горит',
  warning: 'скоро',
  ok: 'в сроке',
  stale: 'без движения',
  no_arrival: 'без даты поступления',
  done: 'ремонт закончен',
};

const REPAIR_DEADLINE_ORDER: readonly RepairDeadlineKey[] = ['danger', 'warning', 'ok', 'stale', 'no_arrival', 'done'];

/**
 * Пороги — те же, что красят отсчёт в карточке (`countdownThresholds`, `COUNTDOWN_STALE_DAYS`):
 * числа руками здесь не пишем, иначе фильтр и подсветка разъедутся. Срок контракта берём из самой
 * строки (крайний день минус поступление) — обе даты она уже несёт, третьего поля под срок ей не
 * нужно.
 *
 * «Сегодня» — умолчание параметра, как у соседнего `engineDaysOnSite`: строка несёт только даты, а
 * «сколько дней без работ» — величина на момент показа, и двигатель должен уходить в «без движения»
 * от смены суток, а не от пересчёта в `listEngines`. Параметром, а не голым `Date.now()` в теле,
 * чтобы дату можно было задать извне и не зависеть от часов машины.
 */
/**
 * Этап по коду строки: сперва серверный шаблон (порядок и названия меняет владелец),
 * при отсутствии — статичная линейка. Подпись ступени не должна зависеть от того, ответил
 * ли сервер: иначе один и тот же двигатель попадал бы в разные группы при офлайне.
 */
/** Ряд значений ступеней этапов — в порядке шаблона (приоритет линейки, боковая ветка в конце), плюс «этапов нет».
 *  Служебный этап («Создание карточки двигателя») в фильтр не попадает: это отметка о
 *  заведении карточки, а не этап ремонта (решение владельца 02.11.2026).
 *
 *  Ряд собирается ЕДИНЫМ сборщиком `repairStageList` (промт КАРМАНА #181): серверный шаблон,
 *  при его отсутствии — статичная линейка; каждый этап — ровно один раз. Два разных сборщика
 *  разошлись бы подписями, и при офлайне один и тот же двигатель попадал бы в разные группы. */
export function engineStageFacetOptions(types?: readonly EngineFactoryStageTypeRef[], stageTemplates?: readonly RepairStageTemplate[]) {
  void types;
  return [
    ...repairStageList(stageTemplates).map((s) => ({ value: s.historyValue, label: s.label })),
    { value: 'none', label: 'этапов нет' },
  ];
}

/**
 * Ряд значений ступени «Этап ремонта» — из того же сборщика `repairStageList`, что и «История»
 * и отчёт «Сейчас на заводе» (промт КАРМАНА #181, пункт 4: этапы везде из одного источника).
 *
 * Значение ступени — `repair:<код>`: своё пространство имён, чтобы ступень «Этап ремонта»
 * (двигатель СЕЙЧАС на этом этапе) не путалась со ступенью «История» (этап проходил когда-то)
 * и с «Текущим состоянием» (место двигателя вообще).
 */
export function repairStageFacetOptions(stageTemplates?: readonly RepairStageTemplate[]): Array<{ value: string; label: string }> {
  return repairStageList(stageTemplates).map((s) => ({ value: s.stepValue, label: s.label }));
}

/**
 * Полный ряд ступени «Текущее состояние»: состояния карточки по своим местам и виды работ —
 * в порядке справочника. Этапов ремонта здесь НЕТ: они живут в ступени «Этап ремонта»
 * (промт КАРМАНА #181 — в «Сейчас на заводе» один и тот же этап выводился дважды: в
 * «Текущем состоянии» и в «Истории»). Порядок показа групп в списках задаёт ранг
 * (`flattenGrouped`), а не этот ряд: здесь только значения фильтра.
 */
function factoryStageFilterOptions(
  types?: readonly EngineFactoryStageTypeRef[],
  stageTemplates?: readonly RepairStageTemplate[],
): Array<{ value: string; label: string }> {
  void stageTemplates;
  const sheets = [...(types ?? [])]
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, 'ru'))
    .map((t) => ({ value: `sheet:${t.code}`, label: t.name }));
  return [
    { value: 'scrap', label: ENGINE_FACTORY_STAGE_LABELS.scrap },
    { value: 'repaired', label: ENGINE_FACTORY_STAGE_LABELS.repaired },
    ...sheets,
    { value: 'defect_act', label: ENGINE_FACTORY_STAGE_LABELS.defectAct },
    { value: 'completeness_act', label: ENGINE_FACTORY_STAGE_LABELS.completenessAct },
    { value: 'repair_started', label: ENGINE_FACTORY_STAGE_LABELS.repairStarted },
    { value: 'arrived', label: ENGINE_FACTORY_STAGE_LABELS.arrived },
  ];
}

/** Выбран ли фильтр «Текущее состояние»: тогда «Дата этапа» недоступна — смотрим текущее место, а не период. */
export function isFactoryStageActive(selection: EngineFacetSelection): boolean {
  const picked = selection?.factoryStage;
  return Array.isArray(picked) && picked.length > 0;
}

/**
 * Гасит «Дату этапа», когда активен «Текущее состояние» (владелец 14.10.2026): период при
 * вопросе «где двигатель сейчас» не отвечает ни на что — ступень чистится, а не прячется
 * с включённым отбором.
 */
export function stripStageDateWhenWhereNow(selection: EngineFacetSelection): EngineFacetSelection {
  if (!isFactoryStageActive(selection)) return selection;
  if (selection.stageDate == null) return selection;
  const next = { ...selection };
  delete next.stageDate;
  return next;
}

/**
 * Раскрывать ли двигатели в строки-проходы (владелец 14.10.2026): только вопрос про
 * движение — выбранные «История» или период «Даты этапа». Иначе (и при активном
 * «Текущем состоянии») — одна строка на двигатель с текущим местом: обстановка, а не лента.
 *
 * Отбор по этапу ремонта («Этап ремонта») — тоже вопрос про движение: в отчёте «Сейчас на
 * заводе» выбранный этап раскрывает список в строки-проходы, и ступень отбирает их по
 * этапу САМОЙ строки (промт КАРМАНА #181). Раньше этот вопрос задавала ступень «История»,
 * и отбор по этапу в отчёте давал ровно строки-проходы выбранного этапа — столько же должен
 * давать и «Этап ремонта». В списке двигателей ступень работает по последнему этапу
 * двигателя (одна строка на двигатель), и раскрытия там нет.
 */
export function isStageEntriesActive(selection: EngineFacetSelection): boolean {
  if (isFactoryStageActive(selection)) return false;
  const picked = selection?.hasStage;
  if (Array.isArray(picked) && picked.length > 0) return true;
  const repairPicked = selection?.repairStage;
  if (Array.isArray(repairPicked) && repairPicked.length > 0) return true;
  return facetRangeOf(SELECTION(selection), 'stageDate') != null;
}

/**
 * Переезд выбора этапа из «Текущего состояния» в «Этап ремонта» (промт КАРМАНА #181).
 *
 * Раньше этап ремонта выбирался в ступени «Текущее состоянии» (вместе с видами работ и
 * состояниями карточки), и в «Сейчас на заводе» тот же этап попадал в выпадающий список
 * дважды. Теперь этап ремонта — отдельная ступень «Этап ремонта» (значение `repair:<код>`),
 * а сохранённый выбор оператора переезжает туда сам: список открывается с тем же отбором
 * и теми же строками, что и до переезда.
 *
 * `dropHistory` — для списков, где ступени «История» больше нет (отчёт «Сейчас на
 * заводе»): её выбор этапов переезжает в «Этап ремонта» тем же ходом.
 */
export function migrateEngineFacetSelection(
  selection: EngineFacetSelection,
  opts?: { dropHistory?: boolean },
): EngineFacetSelection {
  const isStageValue = (v: unknown): v is string => typeof v === 'string' && v.startsWith('stage:');
  const raw = Array.isArray(selection?.factoryStage) ? (selection?.factoryStage as string[]) : [];
  const historyRaw = opts?.dropHistory && Array.isArray(selection?.hasStage) ? (selection?.hasStage as string[]) : [];
  const stageValues = raw.filter(isStageValue);
  const historyValues = historyRaw.filter(isStageValue);
  if (stageValues.length === 0 && historyValues.length === 0) {
    if (!opts?.dropHistory || selection?.hasStage == null) return selection;
    const cleared = { ...selection };
    delete cleared.hasStage;
    return cleared;
  }
  const next: EngineFacetSelection = { ...selection };
  if (stageValues.length > 0) {
    const rest = raw.filter((v) => !isStageValue(v));
    if (rest.length > 0) next.factoryStage = rest;
    else delete next.factoryStage;
  }
  if (opts?.dropHistory) delete next.hasStage;
  const current = Array.isArray(next.repairStage) ? next.repairStage : [];
  const moved = [...stageValues, ...historyValues].map((v) => `repair:${v.slice('stage:'.length).trim().toLowerCase()}`);
  next.repairStage = [...current, ...moved.filter((v) => !current.includes(v))];
  return next;
}

/**
 * Этап по коду строки: сперва серверный шаблон (порядок и названия меняет владелец),
 * при отсутствии — статичная линейка. Подпись ступени не должна зависеть от того, ответил
 * ли сервер: иначе один и тот же двигатель попадал бы в разные группы при офлайне.
 */
export function stageByCode(code: string, stageTemplates?: readonly RepairStageTemplate[]) {
  const c = String(code ?? '').trim().toLowerCase();
  if (!c) return null;
  const hit = (stageTemplates ?? DEFAULT_REPAIR_STAGE_TEMPLATES).find((t) => t.code === c);
  if (hit) return hit;
  try {
    return repairStageTemplate(c as RepairStageTemplate['code']);
  } catch {
    return null;
  }
}
function repairDeadlineKey(e: EngineListItem, now = Date.now()): RepairDeadlineKey {
  // Ремонт закончен (или двигатель уехал) — отсчёт погашен тем же правилом, что в карточке.
  if (isEngineDoneForCountdown(e)) return 'done';
  const arrival = dateMs(e.arrivalDate);
  const due = dateMs(e.repairDueDate);
  if (arrival == null || due == null) return 'no_arrival';
  const daysLeft = typeof e.daysLeftForRepair === 'number' && Number.isFinite(e.daysLeftForRepair) ? e.daysLeftForRepair : null;
  // Даты есть, а отсчёта нет — поступление датировано будущим: гореть ещё нечему.
  if (daysLeft == null) return 'ok';
  const total = Math.round((due - arrival) / DAY_MS);
  const { warningElapsed, dangerLeft } = countdownThresholds(total);
  const key: RepairDeadlineKey =
    daysLeft <= dangerLeft ? 'danger'
    : total - daysLeft > warningElapsed ? 'warning'
    : 'ok';
  // Забытая карточка — про незакрытый учёт, а не про срыв срока (замер владельца 22.09.2026:
  // из 335 «горящих» у 198 не было ни одной работы два месяца). Гасим ровно так же, как
  // `countdownStatus`: только тревожные ключи. «В сроке» внимания и так не просит, а назвать
  // его «без движения» значило бы соврать, будто по двигателю идёт работа.
  const lastActivity = dateMs(e.lastActivityAt);
  const daysIdle = lastActivity == null ? null : Math.floor((now - lastActivity) / DAY_MS);
  if (daysIdle != null && daysIdle > COUNTDOWN_STALE_DAYS && (key === 'danger' || key === 'warning')) return 'stale';
  return key;
}

/**
 * Коды этапов, выбранные в ступенях этапов («История» — значения `stage:<код>`,
 * «Этап ремонта» — `repair:<код>`), — в нижнем регистре, как они лежат в строках проходов.
 * «этапов нет» кодом не является.
 *
 * Выбранный этап сужает ступень «Дата этапа»: «Сборка» + день — это «прошёл сборку в этот
 * день», а не «когда-то прошёл сборку и в этот день был где-то ещё». Раньше это правило
 * читало только «Историю», а «Этап ремонта» в том же отчёте отвечает на тот же вопрос про
 * этап — значит, он сужает дату так же (промт КАРМАНА #181).
 */
function pickedStageCodes(selection?: EngineFacetSelection): string[] {
  const raw = [
    ...(Array.isArray(selection?.hasStage) ? selection.hasStage : []),
    ...(Array.isArray(selection?.repairStage) ? selection.repairStage : []),
  ];
  const out: string[] = [];
  for (const value of raw) {
    const s = text(value);
    const code = s.startsWith('stage:') ? s.slice('stage:'.length) : s.startsWith('repair:') ? s.slice('repair:'.length) : '';
    const c = code.trim().toLowerCase();
    if (!c) continue;
    // Равные этапы (приёмка по рекламации = приёмка): выбрана «приёмка» — отбор
    // ловит и приезд по рекламации (владелец 11.11.2026).
    for (const eq of equivalentStageCodes(c)) if (!out.includes(eq)) out.push(eq);
  }
  return out;
}

/**
 * Даты проходов этапов строки — все, а не только последняя (владелец 19.10.2026).
 * Основа — строки проходов единого списка; у двигателя со старой историей и актовыми этапами
 * их нет, и тогда работают даты по кодам, а в крайнем случае — последний этап.
 */
function stagePassageDates(e: EngineListItem, picked: readonly string[]): number[] {
  const out: number[] = [];
  const push = (ms: number | null) => {
    if (ms != null && !out.includes(ms)) out.push(ms);
  };
  for (const entry of e.stageEntries ?? []) {
    const code = text(entry.code).toLowerCase();
    if (picked.length > 0 && !picked.includes(code)) continue;
    push(dateMs(entry.at));
  }
  if (out.length === 0) {
    const entries = Object.entries(e.stageDates ?? {});
    for (const [code, at] of entries) {
      if (picked.length > 0 && !picked.includes(code.toLowerCase())) continue;
      push(dateMs(at));
    }
  }
  // Выбранные этапы без дат день не подтверждают: пусть лучше строка промолчит, чем попадёт
  // в чужой день по последнему этапу.
  if (out.length === 0 && picked.length === 0) push(dateMs(e.lastStageAt));
  return out;
}

/**
 * Ступени списка двигателей. Справочник видов работ (`types`) даёт ступени «Текущее состояние»,
 * полный ряд значений в порядке справочника — новый вид работ появляется в фильтре
 * сам, даже пока в нём нет ни одного двигателя (владелец 16.09). Без справочника ступени живут
 * на том, что несут строки. `selection` нужен только ступени «Дата этапа»: она считает даты
 * в границах выбранных этапов.
 */
export function engineFacets(
  types?: readonly EngineFactoryStageTypeRef[],
  stageTemplates?: readonly RepairStageTemplate[],
  selection?: EngineFacetSelection,
): readonly EngineFacetDescriptor[] {
  // Выбранные в «Истории» этапы сужают набор дат ступени «Дата этапа»: «Сборка» + день —
  // это «прошёл сборку в этот день», а не «когда-то прошёл сборку и в этот день был где-то ещё».
  const pickedCodes = pickedStageCodes(selection);
  // Виды работ в порядке справочника (ранний → поздний); в ряду этапов они идут наоборот.
  return [
    {
      kind: 'values',
      id: 'customer',
      // Владелец 02.10.2026: в фильтрах одно слово — «Заказчик» (сущность
      // и колонки при этом называются как раньше).
      label: 'Заказчик',
      valueOf: (e) => {
        const id = text(e.customerId);
        const label = text(e.customerName);
        if (!id && !label) return NO_VALUE;
        return { value: id || `name:${label.toLowerCase()}`, label: label || 'без названия' };
      },
    },
    {
      kind: 'values',
      id: 'contract',
      label: 'Контракт',
      // Владелец 02.11.2026: договор состоит из основного договора и ДС, двигатель сидит
      // на конкретной секции — и в ступени нужно уметь выбрать «договор» и «договор — ДС 2».
      // У двигателя на ДС два значения: весь договор (главное) и само ДС (`values` — строка
      // подходит по любому из них). Выбор договора оставляет все его двигатели, выбор ДС —
      // только двигатели этого соглашения.
      valueOf: (e) => {
        const id = text(e.contractId);
        const label = text(e.contractName);
        if (!id && !label) return NO_VALUE;
        const contractValue = id || `name:${label.toLowerCase()}`;
        const contractLabel = label || 'без номера';
        const section = canonicalContractSectionKey(e.contractSectionNumber);
        if (!isContractAddonToken(section)) return { value: contractValue, label: contractLabel };
        const sectionValue = `${contractValue}::${section}`;
        return {
          value: contractValue,
          label: contractLabel,
          values: [sectionValue],
          extraLabels: { [sectionValue]: `${contractLabel} — ${section}` },
        };
      },
    },
    {
      // Вид двигателя — ГОЗ или гражданский (владелец 18.11.2026). Раньше вид жил только
      // в договоре, и в списке двигателей его не было: отобрать «военку/гражданку» по
      // двигателям было нечем. Считает вид `listEngines` по общему правилу
      // `resolveEngineKind` (договор → карточка → контрагент), а ступень только показывает
      // и отбирает — второго источника правды тут быть не должно.
      //
      // Ступень — из общего конструктора `engineKindFacetDescriptor`: подпись, ряд значений
      // и «вид не задан» должны быть одинаковыми во всех списках (промт КАРМАНА #163).
      ...engineKindFacetDescriptor<EngineListItem>({ kindOf: (e) => e.kind }),
    } as EngineFacetDescriptor,
    {
      kind: 'values',
      id: 'brand',
      label: 'Марка',
      valueOf: (e) => {
        const id = text(e.engineBrandId);
        const label = text(e.engineBrand);
        if (!id && !label) return NO_VALUE;
        return { value: id || `name:${label.toLowerCase()}`, label: label || 'без марки' };
      },
    },
    {
      kind: 'values',
      id: 'arrivalYear',
      label: 'Год прихода',
      valueOf: (e) => {
        const ms = typeof e.arrivalDate === 'number' && Number.isFinite(e.arrivalDate) ? e.arrivalDate : null;
        if (ms == null || ms <= 0) return NO_VALUE;
        const year = String(new Date(ms).getFullYear());
        return { value: year, label: year };
      },
    },
    {
      kind: 'values',
      id: 'arrival',
      // Повторный заезд (владелец 22.09.2026): в отчёте один и тот же номер приходит строкой
      // свежего заезда и строками архивных, и без этой ступени сводка двоится. Роль берём из
      // строки — считает её список целиком, по соседям с тем же номером.
      label: 'Заезд',
      // Место заезда строка несёт целиком, ступени нужна только роль; заезда нет — двигатель
      // с этим номером один, и это «единственный», а не пропуск ступени.
      valueOf: (e) => {
        const role: ArrivalRole = e.arrival?.role ?? 'single';
        return { value: role, label: ARRIVAL_LABELS[role] };
      },
      options: ARRIVAL_STAGE_ORDER.map((role) => ({ value: role, label: ARRIVAL_LABELS[role] })),
    },
    {
      kind: 'values',
      id: 'completenessAct',
      label: 'Акт комплектности',
      valueOf: (e) => (e.hasCompletenessAct === true ? { value: 'yes', label: 'заполнен' } : { value: 'no', label: 'не заполнен' }),
    },
    {
      kind: 'values',
      id: 'presence',
      label: 'Где двигатель',
      // Отгрузка определяется датой отгрузки строки списка — тем же полем, что печатает колонка.
      valueOf: (e) => {
        const shipped = typeof e.shippingDate === 'number' && Number.isFinite(e.shippingDate) && e.shippingDate > 0;
        return shipped ? { value: 'shipped', label: 'отгружен' } : { value: 'on_site', label: 'на заводе' };
      },
    },
    {
      kind: 'values',
      id: 'scrap',
      label: 'Утиль',
      valueOf: (e) => (e.isScrap === true ? { value: 'yes', label: 'утиль' } : { value: 'no', label: 'не утиль' }),
    },
    {
      kind: 'values',
      id: 'reclamation',
      label: 'Рекламация',
      valueOf: (e) => (e.isReclamation === true ? { value: 'yes', label: 'рекламационный' } : { value: 'no', label: 'обычный' }),
    },
    {
      kind: 'values',
      id: 'defectAct',
      label: 'Акт дефектовки',
      valueOf: (e) => (e.hasDefectAct === true ? { value: 'yes', label: 'заполнен' } : { value: 'no', label: 'не заполнен' }),
    },
    {
      kind: 'values',
      id: 'status',
      // Стадия ремонта — последний выставленный флаг по порядку жизненного цикла, а не набор
      // галочек: оператор спрашивает «где двигатель сейчас», и двух ответов тут быть не должно.
      label: 'Стадия ремонта',
      valueOf: (e) => {
        const flags = e.statusFlags ?? {};
        for (const code of ENGINE_STATUS_STAGE_ORDER) {
          if (flags[code] === true) return { value: code, label: STATUS_LABELS[code] ?? code };
        }
        return { value: 'none', label: 'без стадии' };
      },
    },
    {
      kind: 'values',
      id: 'repairDeadline',
      label: 'Срок ремонта',
      valueOf: (e) => {
        const key = repairDeadlineKey(e);
        return { value: key, label: REPAIR_DEADLINE_LABELS[key] };
      },
      // Ряд полный: «горящих» может не быть ни одного, и ступень, собранная по строкам, в такой
      // день исчезала бы из фильтра — оператор решил бы, что фильтра нет вовсе.
      options: REPAIR_DEADLINE_ORDER.map((key) => ({ value: key, label: REPAIR_DEADLINE_LABELS[key] })),
    },
    {
      kind: 'values',
      id: 'workshop',
      label: 'Цех',
      valueOf: (e) => {
        const id = text(e.workshopId);
        const label = text(e.workshopName);
        if (!id && !label) return { value: 'none', label: 'без цеха' };
        return { value: id || `name:${label.toLowerCase()}`, label: label || 'без названия' };
      },
    },
    {
      kind: 'dateRange',
      id: 'arrivalDate',
      label: 'Дата прихода',
      dateOf: (e) => dateMs(e.arrivalDate),
    },
    {
      kind: 'dateRange',
      id: 'defectDate',
      label: 'Дата дефектовки',
      dateOf: (e) => dateMs(e.defectDate),
    },
    {
      kind: 'dateRange',
      id: 'shippingDate',
      label: 'Дата отгрузки',
      dateOf: (e) => dateMs(e.shippingDate),
    },
    // Приёмка по рекламации — отдельная дата карточки (не стадия ремонта): по ней считают,
    // сколько рекламаций приняли за месяц и какие именно.
    {
      kind: 'dateRange',
      id: 'reclamationAccepted',
      label: 'Дата приёмки рекламации',
      dateOf: (e) => dateMs(e.reclamationAcceptedDate),
    },
    // Отправка по рекламации — симметричная приёмке дата (владелец 13.11.2026): сколько
    // двигателей уехало заказчику после ремонта по рекламации за месяц и какие именно.
    {
      kind: 'dateRange',
      id: 'reclamationShipped',
      label: 'Дата отправки по рекламации',
      dateOf: (e) => dateMs(e.reclamationShippedDate),
    },
    // Даты стадий карточки (B2 программы осень-2026): отчёт «Двигатели» отбирает по ним
    // «ремонт начат в периоде» и «отремонтированы в периоде» — исторически, включая отгруженные.
    {
      kind: 'dateRange',
      id: 'repairStartedDate',
      label: 'Начало ремонта',
      dateOf: (e) => engineStatusDate(e, 'status_repair_started'),
    },
    {
      kind: 'dateRange',
      id: 'repairedDate',
      label: 'Окончание ремонта',
      dateOf: (e) => engineStatusDate(e, 'status_repaired'),
    },
    {
      kind: 'values',
      // «История» — БЕЗ привязки к дате (владелец 01.10.2026, подписи «Все этапы» с 12.10.2026
      // и «История» с 19.10.2026): двигатель, у которого такой этап проходил в любой момент.
      // Прежние четыре ступени («Последнее событие», «Дата события», «Последний этап работ»,
      // «Дата этапа работ») отвечали на разные вопросы об одном и том же и взаимоисключали друг
      // друга: движок считает их независимыми, а оператор выбирал одну и получал пустой список.
      id: 'hasStage',
      label: 'История',
      valueOf: (e) => {
        // Служебный этап (заведение карточки) — не этап ремонта: в ступени «История»
        // его нет, и двигатель, у которого он один, попадает в «этапов нет», а не
        // пропадает из выборки совсем (решение владельца 02.11.2026).
        const codes = (e.stageCodes ?? []).filter(
          (c: string) => stageByCode(c, stageTemplates) !== null && !isServiceStageCode(c),
        );
        const first = codes[0];
        if (first === undefined) return { value: 'none', label: 'этапов нет' };
        // Главное значение — первый по порядку линейки (подпись ступени), а `values`
        // отдаёт ВСЕ этапы двигателя: ступени «есть этап» нужна любая комбинация, иначе
        // выбор «Сборка» отбирал бы только тех, у кого сборка — последний этап.
        //
        // Плюс равные этапы (приёмка по рекламации = приёмка): движок, прошедший приёмку
        // по рекламации, попадает под отбор «приёмка двигателя на завод» (владелец
        // 11.11.2026). Ответ — односторонний: обычная приёмка под «приёмку по
        // рекламации» не попадает.
        return {
          value: 'stage:' + first,
          label: stageByCode(first, stageTemplates)!.name,
          values: codes.flatMap((c: string) => [
            'stage:' + c,
            ...stageAnsweringAliases(c).map((eq) => 'stage:' + eq),
          ]),
        };
      },
      options: engineStageFacetOptions(types, stageTemplates),
    },
    // Ступени «Последний этап» (по `lastStageCode`) здесь больше нет — снята 07.10.2026
    // решением владельца: она отвечала «где двигатель» одной последней строкой этапов и
    // рядом с «Этапом на заводе» (ниже) читалась как второй ответ на тот же вопрос, причём
    // молча другой (не видит ни утиль, ни возвраты, ни акты). Полное движение — «Этап на
    // заводе»; отбор по прохождению этапов когда-либо — «История».
    {
      kind: 'dateRange',
      // Дата КОНКРЕТНОГО прохода (владелец 19.10.2026): двигатель попадает в день D, если
      // любой его этап был в D, — а не только последний. Отбор по `lastStageAt` отвечал
      // «где он сейчас», и двигатель, прошедший укладку в понедельник и обкатку в среду,
      // на вопрос «кто укладывал в понедельник» не находился.
      id: 'stageDate',
      label: 'Дата этапа',
      dateOf: (e) => dateMs(e.lastStageAt),
      datesOf: (e) => stagePassageDates(e, pickedCodes),
    },
    {
      kind: 'values',
      id: 'factoryStage',
      // «Текущее состояние» (бывш. «Этап на заводе» → «Где сейчас?» с 14.10.2026,
      // переименование 19.10.2026) — место двигателя, КРОМЕ этапа ремонта: утиль,
      // отремонтирован, виды работ, акты, ремонт начат, пришёл.
      // Справочник нужен и здесь: ключ этапа работ без кода (старые строки) сходится с
      // ключом отчёта только через него, а полный ряд видов работ — из него же.
      //
      // Этап ремонта отсюда убран (промт КАРМАНА #181): он жил ещё и в ступени «Этап
      // ремонта», и в «Сейчас на заводе» один и тот же этап выводился в выпадающем
      // списке дважды — второй раз нерабочим нулём. Теперь этап ремонта — отдельная
      // ступень «Этап ремонта» (см. ниже), а «Текущее состояние» отвечает за остальные
      // места. Старый выбор этапа в «Текущем состоянии» переезжает в «Этап ремонта»
      // сам — `migrateEngineFacetSelection`.
      label: 'Текущее состояние',
      valueOf: (e) => {
        const s = engineFactoryStage(e, types, stageTemplates);
        // Этап ремонта — ступени «Этап ремонта»: здесь его нет, иначе этап выводился бы
        // в двух выпадающих списках сразу.
        if (s.key.startsWith('stage:')) return NO_VALUE;
        return { value: s.key, label: s.label };
      },
      options: factoryStageFilterOptions(types, stageTemplates),
    },
    {
      kind: 'values',
      // «Этап ремонта» (промт КАРМАНА #181) — на каком этапе ремонта двигатель СЕЙЧАС.
      // Раньше отбора по этапу в списке двигателей не было вовсе: были «Стадия ремонта»
      // (стадии жизненного цикла по флагам карточки) и «Срок ремонта» (дедлайн) — а этап
      // ремонта жил только внутри «Текущего состояния» и «Истории», вперемешку с видами
      // работ и состояниями карточки. Теперь это отдельная ступень со своим рядом
      // значений из справочника шаблонов.
      //
      // Значение ступени — `repair:<код>` (своё пространство имён): «История» отвечает
      // на другой вопрос («проходил ли этап когда-то»), и смешивать их в одном отборе
      // нельзя. Отбор по равным этапам сохранён: выбранная «приёмка» ловит и приезд по
      // рекламации (владелец 11.11.2026).
      id: 'repairStage',
      label: 'Этап ремонта',
      valueOf: (e) => {
        // Этап строки: у прохода отчёта «Сейчас на заводе» — свой (`rowStageCode`), у
        // двигателя — последний этап единого списка. Служебный этап (заведение карточки)
        // этапом ремонта не является.
        const raw = String(e.rowStageCode ?? e.lastStageCode ?? '').trim().toLowerCase();
        if (!raw || isServiceStageCode(raw)) return NO_VALUE;
        const value = repairStageValue(raw);
        if (!value) return NO_VALUE;
        const aliases = stageAnsweringAliases(raw);
        return {
          value,
          label: stageByCode(raw, stageTemplates)?.name ?? raw,
          ...(aliases.length > 0 ? { values: aliases.map((eq) => repairStageValue(eq) ?? `repair:${eq}`) } : {}),
        };
      },
      options: repairStageFacetOptions(stageTemplates),
    },
    {
      kind: 'values',
      // B4: отдельный счётчик повторных заходов — НЕ группа. Повторы остаются в группах
      // своих этапов (иначе этапный отбор их терял бы), а сколько их — отвечает эта ступень.
      id: 'hasRepeatPass',
      label: 'Повторный заход',
      valueOf: (e) =>
        returnsPass(e) >= 2 ? { value: 'repeat', label: 'повторный' } : { value: 'first', label: 'первый проход' },
    },
  ];
}

/** Ступени без справочника — для санитайзера и мест, где виды работ не нужны. */
export const ENGINE_FACETS: readonly EngineFacetDescriptor[] = engineFacets();

const SELECTION = (selection: EngineFacetSelection): FacetSelection => selection as FacetSelection;

export function engineFacetById(id: string): EngineFacetDescriptor | undefined {
  return ENGINE_FACETS.find((f) => f.id === id);
}

export function engineFacetRangeOf(selection: EngineFacetSelection, id: EngineFacetId): EngineFacetDateRange | null {
  return facetRangeOf(SELECTION(selection), id);
}

export function engineFacetIsActive(selection: EngineFacetSelection, id: EngineFacetId): boolean {
  return facetIsActive(ENGINE_FACETS, SELECTION(selection), id);
}

export function applyEngineFacets(
  engines: readonly EngineListItem[],
  selection: EngineFacetSelection,
  types?: readonly EngineFactoryStageTypeRef[],
  stageTemplates?: readonly RepairStageTemplate[],
): EngineListItem[] {
  return applyFacets(engineFacets(types, stageTemplates, selection), engines, SELECTION(selection));
}

export function engineFacetOptions(
  engines: readonly EngineListItem[],
  selection: EngineFacetSelection,
  facetId: EngineFacetId,
  types?: readonly EngineFactoryStageTypeRef[],
  stageTemplates?: readonly RepairStageTemplate[],
): EngineFacetOption[] {
  return facetOptions(
    engineFacets(types, stageTemplates, selection),
    engines,
    SELECTION(selection),
    facetId,
  );
}

export function toggleEngineFacetValue(
  selection: EngineFacetSelection,
  facetId: EngineFacetId,
  value: string,
): EngineFacetSelection {
  return toggleFacetValue(SELECTION(selection), facetId, value) as EngineFacetSelection;
}

export function clearEngineFacet(selection: EngineFacetSelection, facetId: EngineFacetId): EngineFacetSelection {
  return clearFacet(SELECTION(selection), facetId) as EngineFacetSelection;
}

export function setEngineFacetDateBound(
  selection: EngineFacetSelection,
  facetId: EngineFacetId,
  edge: 'from' | 'to',
  value: string,
): EngineFacetSelection {
  return setFacetDateBound(SELECTION(selection), facetId, edge, value) as EngineFacetSelection;
}

export function activeEngineFacetCount(selection: EngineFacetSelection): number {
  return activeFacetCount(ENGINE_FACETS, SELECTION(selection));
}

export function sanitizeEngineFacetSelection(raw: unknown): EngineFacetSelection {
  return sanitizeFacetSelection(ENGINE_FACETS, raw) as EngineFacetSelection;
}
