import type { EngineListItem } from '../ipc/types.js';
import { STATUS_LABELS, type StatusCode } from './contract.js';
import { engineFactoryStage, engineFactoryStageOrder, engineStatusDate, type EngineFactoryStageTypeRef } from './engineFactoryStage.js';
import { COUNTDOWN_STALE_DAYS, countdownThresholds, isEngineRepairedForCountdown } from './payments.js';
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
  | 'arrivalDate'
  | 'defectDate'
  | 'shippingDate'
  | 'repairStartedDate'
  | 'repairedDate'
  | 'historyAction'
  | 'historyDate'
  | 'sheetNode'
  | 'sheetDate'
  | 'factoryStage';

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
function repairDeadlineKey(e: EngineListItem, now = Date.now()): RepairDeadlineKey {
  // Ремонт закончен (или двигатель уехал) — отсчёт погашен тем же правилом, что в карточке.
  if (isEngineRepairedForCountdown(e.statusFlags)) return 'done';
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
 * Ступени списка двигателей. Справочник видов работ (`types`) даёт ступеням «Этап на заводе» и
 * «Вид работ» полный ряд значений в порядке справочника — новый вид работ появляется в фильтре
 * сам, даже пока в нём нет ни одного двигателя (владелец 16.09). Без справочника ступени живут
 * на том, что несут строки.
 */
export function engineFacets(types?: readonly EngineFactoryStageTypeRef[]): readonly EngineFacetDescriptor[] {
  // Виды работ в порядке справочника (ранний → поздний); в ряду этапов они идут наоборот.
  const sheetTypes = engineFactoryStageOrder(types).filter((s) => s.key.startsWith('sheet:')).reverse();
  return [
    {
      kind: 'values',
      id: 'customer',
      label: 'Контрагент',
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
      valueOf: (e) => {
        const id = text(e.contractId);
        const label = text(e.contractName);
        if (!id && !label) return NO_VALUE;
        return { value: id || `name:${label.toLowerCase()}`, label: label || 'без номера' };
      },
    },
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
      id: 'historyAction',
      // «Что с двигателем происходило» — последнее событие истории ремонта. По нему видно, где
      // двигатель застрял: список отбирается по действию, а не по одной лишь стадии из карточки.
      label: 'Последнее событие',
      valueOf: (e) => {
        const action = text(e.lastHistoryAction);
        return action ? { value: action.toLowerCase(), label: action } : { value: 'none', label: 'событий нет' };
      },
    },
    {
      kind: 'dateRange',
      id: 'historyDate',
      label: 'Дата события',
      dateOf: (e) => dateMs(e.lastHistoryAt),
    },
    {
      kind: 'values',
      id: 'sheetNode',
      // Вид работ последнего этапа — «на каком участке двигатель»: укладка, вал,
      // обкатка, сборка. Отдельно от «последнего события», потому что ручные записи и стадии
      // перебивали бы узел, а вопрос диспетчера — именно про этапы работ.
      label: 'Последний этап работ',
      valueOf: (e) => {
        const node = text(e.lastSheetNode);
        return node ? { value: node.toLowerCase(), label: node } : { value: 'none', label: 'этапов работ нет' };
      },
      options: [...sheetTypes.map((s) => ({ value: s.label.toLowerCase(), label: s.label })), { value: 'none', label: 'этапов работ нет' }],
    },
    {
      kind: 'dateRange',
      id: 'sheetDate',
      label: 'Дата этапа работ',
      dateOf: (e) => dateMs(e.lastSheetAt),
    },
    {
      kind: 'values',
      id: 'factoryStage',
      // «Этап на заводе» — один ответ из карточки и этапов работ разом (`engineFactoryStage`):
      // побеждает поздний признак. Справочник нужен и здесь: ключ этапа работ без кода (старые
      // строки) сходится с ключом отчёта только через него, а полный ряд этапов — из него же.
      label: 'Этап на заводе',
      valueOf: (e) => {
        const s = engineFactoryStage(e, types);
        return { value: s.key, label: s.label };
      },
      options: engineFactoryStageOrder(types).map((s) => ({ value: s.key, label: s.label })),
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
): EngineListItem[] {
  return applyFacets(types ? engineFacets(types) : ENGINE_FACETS, engines, SELECTION(selection));
}

export function engineFacetOptions(
  engines: readonly EngineListItem[],
  selection: EngineFacetSelection,
  facetId: EngineFacetId,
  types?: readonly EngineFactoryStageTypeRef[],
): EngineFacetOption[] {
  return facetOptions(types ? engineFacets(types) : ENGINE_FACETS, engines, SELECTION(selection), facetId);
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
