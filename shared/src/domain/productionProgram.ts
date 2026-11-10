// Домен модуля «ПРОИЗВОДСТВЕННАЯ ПРОГРАММА (ПП)» — план производства на две недели
// или на месяц по образцу Word-формы «ПП Цех № 1».
//
// Модуль СВОДНЫЙ: строки программы и строки плана. EAV-заморозка (AGENTS.md §EAV)
// не затронута — новых атрибутов нет, данные лежат в строгих таблицах
// `erp_production_programs` / `erp_production_program_rows`.
//
// Что здесь доменного (без БД и без UI):
//  · состояния строки плана и подсказка по виду договора;
//  · подписи программы (слоты из образца + подбор сотрудника по должности);
//  · подсказка по состоянию двигателя («на заводе — можно брать» и т.д.);
//  · модель печати: группировка по договорам, нумерация «№ п/п», подсветка строк.
//
// Вид договора (военный/гражданский) — НЕ новый признак: он уже есть в
// `contract_sections.primary.kind` (см. `contract.ts`), здесь он только читается.
//
// Даты двигателя берём по ИСТОЧНИКУ ПРАВДЫ (engineReclamation.ts): при
// рекламации приход — приёмка по рекламации, отгрузка — отправка с рекламации;
// старые даты основного цикла рекламацию не перебивают.

import type { EngineListItem } from '../ipc/types.js';
import type { ContractKind } from './contract.js';
import { parseContractKind, shortContractSuffix } from './contract.js';
import { engineStateLabel } from './engineFactoryStage.js';
import { resolveEngineTruthDates } from './engineReclamation.js';
import { repairStageRank } from './repairStages.js';
import { findEmployeeByPositionGroups, formatEmployeeSurnameInitials, type WorkOrderSignatureEmployee } from './workOrderSignatures.js';
import { HUMAN_LABEL_DASH, humanCellText, looksLikeIdentifier } from './humanLabels.js';

/**
 * Подпись договора для плана: организация + номер договора (как в Word-форме).
 *
 * Идентификатор в подпись не идёт — это ровно тот «номер вместо наименования», из-за
 * которого печатная форма плана выглядит служебной. Чистит и вычищает его общий
 * проектный `humanCellText`; если после чистки ничего не осталось — подписи нет.
 */
export function productionProgramContractLabel(input: {
  organization?: string | null | undefined;
  contractNumber?: string | null | undefined;
}): string {
  const parts = [input.organization, input.contractNumber].map((v) => String(v ?? '').trim()).filter(Boolean);
  if (parts.length === 0) return '';
  const text = humanCellText(parts.join(' · '));
  return text === HUMAN_LABEL_DASH ? '' : text;
}

/**
 * Подпись группы строк плана — то, что печатается шапкой группы. Технический
 * идентификатор печатается прочерком: подпись должна оставаться человеческой.
 */
export function productionProgramGroupLabel(value: string | null | undefined): string {
  return humanCellText(value) || HUMAN_LABEL_DASH;
}

/**
 * Живая подпись «Организация» для строки плана: заказчик и ТРИ ЦИФРЫ номера
 * договора — те, что до первого слэша (`shortContractSuffix`, `*239`).
 *
 * Именно эту подпись владелец просил поставить в колонку «Организация» печатной
 * формы: полный номер договора в цеху не читают, а рабочий трёхзначный код — да.
 *
 * Числа берутся из карточки двигателя, а не из снимка строки плана: заказчик и
 * договор меняются в карточке — и план должен видеть это сразу (владелец 10.11.2026).
 * Слэша нет — номер показывается как есть (правило владельца 22.09.2026).
 */
export function productionProgramOrganizationLabel(input: {
  customerName?: string | null | undefined;
  contractNumber?: string | null | undefined;
}): string {
  const customer = String(input.customerName ?? '').trim();
  const raw = String(input.contractNumber ?? '').trim();
  const number = raw && !looksLikeIdentifier(raw) ? raw : '';
  const code = shortContractSuffix(number) || number;
  const parts = [customer, code].filter(Boolean);
  return parts.length ? parts.join(' · ') : '';
}

/**
 * Даты двигателя по источнику правды (рекламация выше основного цикла).
 * `isEngineAtPlant` смотрит на сырые даты карточки, поэтому для плана ПП
 * «на заводе» считаем здесь — иначе рекламационный двигатель, который сейчас
 * на заводе, выглядел бы уехавшим по основному циклу.
 */
export function productionProgramEngineDates(engine: EngineListItem | null | undefined): {
  arrivalDate: number | null;
  shippingDate: number | null;
} {
  if (!engine) return { arrivalDate: null, shippingDate: null };
  return resolveEngineTruthDates({
    isReclamation: engine.isReclamation === true,
    reclamationAcceptedDate: engine.reclamationAcceptedDate ?? null,
    reclamationShippedDate: engine.reclamationShippedDate ?? null,
    mainArrivalDate: engine.arrivalDate ?? null,
    mainShippingDate: engine.shippingDate ?? null,
  });
}

/** На заводе по источнику правды: приход есть, отгрузки нет. */
export function isProductionProgramEngineAtPlant(engine: EngineListItem | null | undefined): boolean {
  if (!engine) return false;
  const dates = productionProgramEngineDates(engine);
  return dates.arrivalDate != null && dates.shippingDate == null;
}

// ────────────────────────────────────────────────────────────
// Состояния строк плана
// ────────────────────────────────────────────────────────────

/**
 * Состояние строки производственной программы.
 *
 * Это НЕ статусы двигателя (`status_*` в карточке) и НЕ этапы ремонта: значения
 * новые, ставятся вручную оператором — «восстановление / ремонтопригодный /
 * капитальный ремонт». В статусы двигателя они не пишутся никогда.
 */
export const ProductionProgramState = {
  Restoration: 'restoration',
  Repairable: 'repairable',
  CapitalRepair: 'capital_repair',
} as const;
export type ProductionProgramState = (typeof ProductionProgramState)[keyof typeof ProductionProgramState];

export const PRODUCTION_PROGRAM_STATES: readonly ProductionProgramState[] = [
  ProductionProgramState.Restoration,
  ProductionProgramState.Repairable,
  ProductionProgramState.CapitalRepair,
];

export const PRODUCTION_PROGRAM_STATE_LABELS: Record<ProductionProgramState, string> = {
  restoration: 'Восстановление',
  repairable: 'Ремонтопригодный',
  capital_repair: 'Капитальный ремонт',
};

export function parseProductionProgramState(raw: unknown): ProductionProgramState | null {
  const value = String(raw ?? '').trim();
  return (PRODUCTION_PROGRAM_STATES as readonly string[]).includes(value) ? (value as ProductionProgramState) : null;
}

export function productionProgramStateLabel(state: ProductionProgramState | null | undefined): string {
  const parsed = parseProductionProgramState(state);
  return parsed ? PRODUCTION_PROGRAM_STATE_LABELS[parsed] : '';
}

/**
 * Подсказка состояния по виду договора (вид читается из `contract_sections`).
 *
 * Военный контракт — восстановление или ремонтопригодность; гражданский —
 * капитальный ремонт. Это подсказка, а не запрет: оператор решает сам, значение
 * всё равно ставится вручную.
 */
export function suggestedProductionProgramStates(kind: ContractKind | null | undefined): ProductionProgramState[] {
  if (kind === 'military') return [ProductionProgramState.Restoration, ProductionProgramState.Repairable];
  if (kind === 'civil') return [ProductionProgramState.CapitalRepair];
  return [...PRODUCTION_PROGRAM_STATES];
}

// ────────────────────────────────────────────────────────────
// Подписи программы
// ────────────────────────────────────────────────────────────

/** Слот подписи программы: должность + ФИО (из документа или из базы). */
export type ProductionProgramSignatureSlot = {
  caption: string;
  /** id сотрудника из базы; null — ФИО берётся из документа-образца или вписано вручную. */
  employeeId: string | null;
  /** ФИО из документа-образца (или вписанное вручную) — печатается, если сотрудник не найден. */
  fullName: string;
};

/** Описание слота по умолчанию: должность, ФИО из образца и подбор по должности. */
export type ProductionProgramSignatureSlotDef = {
  caption: string;
  /** ФИО из Word-образца — печатается, если сотрудник в базе не найден. */
  fullName: string;
  /** Группы ключевых слов должности (AND по группам, OR внутри группы) — как в `findEmployeeByPositionGroups`. */
  positionGroups: readonly string[][];
  /** Ключевые слова, которые ИСКЛЮЧАЮТ сотрудника: нужны, чтобы «Директор» не достал
   *  «Коммерческого директора» (тот тоже содержит слово «директор»). */
  excludePositionHints?: readonly string[];
};

/**
 * Слоты подписи ПП — 8 строк из образца.
 *
 * 7 должностей перечислены в образце подписей; восьмая строка — директор завода
 * (он же в грифе «УТВЕРЖДАЮ» справа вверху). ФИО взяты ИЗ ОБРАЗЦА: подписанты ПП —
 * это строки подписей модуля, а НЕ карточки сотрудников: вносить их в кадровый
 * реестр нельзя (засоряет реестр и попадает под гейт дублей).
 */
export const PRODUCTION_PROGRAM_SIGNATURE_SLOTS: readonly ProductionProgramSignatureSlotDef[] = [
  {
    caption: 'Коммерческий директор',
    fullName: 'Беркута А.А.',
    positionGroups: [['коммерческ'], ['директор']],
  },
  {
    caption: 'Технический директор',
    fullName: 'В.И. Гурьянов',
    positionGroups: [['техническ'], ['директор']],
  },
  {
    caption: 'Зам. директора по основному производству',
    fullName: 'А.А. Габдуллин',
    positionGroups: [['зам', 'заместител'], ['директор'], ['производств']],
  },
  {
    caption: 'Начальник цеха №1',
    fullName: 'И.К. Мухаммадиев',
    positionGroups: [['начальник'], ['цех']],
  },
  {
    caption: 'Начальник отдела учета готовой продукции',
    fullName: 'В.Н. Мубаракшина',
    positionGroups: [['начальник'], ['готов', 'продукц']],
  },
  {
    caption: 'Начальник отдела снабжения и обеспечения',
    fullName: 'Р.А. Костюнин',
    positionGroups: [['начальник'], ['снабж']],
  },
  {
    caption: 'Начальник отдела по рекламационной работе и работе с ВП',
    fullName: 'А.Р. Гомаюнова',
    positionGroups: [['начальник'], ['рекламац']],
  },
  {
    caption: 'Директор',
    fullName: 'И.А. Тихомиров',
    positionGroups: [['директор']],
    excludePositionHints: ['коммерческ', 'техническ', 'зам'],
  },
] as const;

/** Гриф утверждения: «УТВЕРЖДАЮ / Директор АО «Малмыжский РМЗ» / И.А. Тихомиров». */
export const PRODUCTION_PROGRAM_APPROVER = {
  title: 'УТВЕРЖДАЮ',
  position: 'Директор АО «Малмыжский РМЗ»',
  fullName: 'И.А. Тихомиров',
} as const;

function normalizePosition(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replaceAll('ё', 'е');
}

function containsAnyHint(position: string, hints: readonly string[]): boolean {
  const normalized = normalizePosition(position);
  if (!normalized) return false;
  return hints.some((hint) => normalized.includes(normalizePosition(hint)));
}

/**
 * Подбор сотрудника по должности для строки подписи ПП.
 *
 * Переиспользует `findEmployeeByPositionGroups` (тот же подбор по `role`, что у
 * нарядов), но с исключениями: «Директор» иначе нашёл бы «Коммерческого директора».
 */
export function findProductionProgramSignatory(
  employees: readonly WorkOrderSignatureEmployee[],
  slot: ProductionProgramSignatureSlotDef,
): WorkOrderSignatureEmployee | null {
  const pool = slot.excludePositionHints?.length
    ? employees.filter((e) => !containsAnyHint(String(e.position ?? ''), slot.excludePositionHints ?? []))
    : employees;
  return findEmployeeByPositionGroups([...pool], slot.positionGroups.map((g) => [...g]));
}

/**
 * Разбор сохранённых слотов подписи (JSON в строке программы).
 * Мусор и неизвестные значения не роняют разбор — слот просто теряет ФИО.
 */
export function parseProductionProgramSignatureSlots(raw: unknown): ProductionProgramSignatureSlot[] {
  let value: unknown = raw;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      value = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: ProductionProgramSignatureSlot[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const caption = String(rec.caption ?? '').trim();
    if (!caption) continue;
    const employeeIdRaw = String(rec.employeeId ?? '').trim();
    out.push({
      caption,
      employeeId: employeeIdRaw || null,
      fullName: String(rec.fullName ?? '').trim(),
    });
  }
  return out;
}

/**
 * Слоты программы: сохранённые — как есть; недостающие — из образца (ФИО из
 * документа, сотрудник не привязан). Так программа, созданная до правки блока
 * подписей, печатается с полным комплектом строк.
 */
export function resolveProductionProgramSignatureSlots(
  saved: readonly ProductionProgramSignatureSlot[] | null | undefined,
): ProductionProgramSignatureSlot[] {
  const byCaption = new Map<string, ProductionProgramSignatureSlot>();
  for (const slot of saved ?? []) byCaption.set(slot.caption, slot);
  return PRODUCTION_PROGRAM_SIGNATURE_SLOTS.map((def) => {
    const stored = byCaption.get(def.caption);
    if (stored) return { ...stored };
    return { caption: def.caption, employeeId: null, fullName: def.fullName };
  });
}

/**
 * ФИО для печати по слоту: привязанный сотрудник → его карточка; иначе ФИО из
 * документа. Возвращает и источник, чтобы UI мог показать, откуда взялось имя.
 */
export function resolveProductionProgramSignatureName(
  slot: ProductionProgramSignatureSlot,
  employees: readonly WorkOrderSignatureEmployee[],
): { name: string; source: 'document' | 'employee' } {
  const employeeId = String(slot.employeeId ?? '').trim();
  if (employeeId) {
    const employee = employees.find((e) => String(e.id ?? '').trim() === employeeId);
    const formatted = employee ? formatEmployeeSurnameInitials(employee) : '';
    if (formatted) return { name: formatted, source: 'employee' };
  }
  return { name: String(slot.fullName ?? '').trim(), source: 'document' };
}

// ────────────────────────────────────────────────────────────
// Подсказка по двигателю
// ────────────────────────────────────────────────────────────

export type ProductionProgramEngineHintTone = 'ok' | 'info' | 'warn' | 'block';

export type ProductionProgramEngineHint = {
  tone: ProductionProgramEngineHintTone;
  text: string;
};

/**
 * Подсказка по двигателю при добавлении строки плана.
 *
 * Считается ТОЛЬКО через домен карточки (`isEngineAtPlant`, `engineStateLabel`) —
 * свои копии правил заводить нельзя, иначе подсказка разойдётся с карточкой.
 */
export function productionProgramEngineHint(engine: EngineListItem | null | undefined): ProductionProgramEngineHint {
  if (!engine) return { tone: 'info', text: 'Двигатель не выбран' };
  if (engine.isScrap === true) return { tone: 'warn', text: 'Утиль — восстановление' };
  const state = engineStateLabel(engine);
  if (state === 'Отгружен') return { tone: 'block', text: 'Уже отгружен — в план не берём' };
  const dates = productionProgramEngineDates(engine);
  if (dates.arrivalDate == null) {
    return { tone: 'warn', text: 'Ещё не прибыл на завод' };
  }
  if (dates.shippingDate != null) {
    return { tone: 'block', text: 'Уже отгружен — в план не берём' };
  }
  const reclamation = engine.isReclamation === true;
  if (state === 'В ремонте') {
    return { tone: 'info', text: reclamation ? 'В ремонте (рекламация) — на заводе, можно брать' : 'В ремонте — на заводе, можно брать' };
  }
  if (state === 'Готов, не отгружен') {
    return { tone: 'ok', text: 'Готов к отгрузке — на заводе, можно брать' };
  }
  return { tone: 'ok', text: reclamation ? 'На заводе (рекламация) — можно брать' : 'На заводе — можно брать' };
}

/**
 * Подсветка строки плана на печати.
 *
 * Решение владельца: основная подсветка — двигатель ГОТОВ К ОТГРУЗКЕ (прошёл
 * обкатку и выходной ОТК, но ещё не отгружен): это действие, за которым следят.
 * Отгруженные строки получают отдельный гриф «Отгружен» БЕЗ заливки — иначе
 * весь план «позеленеет» и подсветка перестанет что-то значить.
 */
export type ProductionProgramHighlight = 'ready' | 'shipped' | 'none';

export function productionProgramRowHighlight(
  engine: EngineListItem | null | undefined,
): ProductionProgramHighlight {
  if (!engine) return 'none';
  const dates = productionProgramEngineDates(engine);
  if (engineStateLabel(engine) === 'Отгружен' || dates.shippingDate != null) return 'shipped';
  const code = String(engine.lastStageCode ?? '').trim().toLowerCase();
  const at = engine.lastStageAt;
  const dated = typeof at === 'number' && Number.isFinite(at) && at > 0;
  const otkPassed = dated && repairStageRank(code) >= repairStageRank('otk');
  if (otkPassed || engine.statusFlags?.status_repaired === true) return 'ready';
  return 'none';
}

// ────────────────────────────────────────────────────────────
// Выполнение плана
// ────────────────────────────────────────────────────────────

/**
 * Состояние выполнения строки плана по факту из карточки двигателя.
 *
 * Владелец (10.11.2026): «план сам себя отслеживал, выполнение плана по статусам
 * двигателей… если прошёл контроль АТК, то в плане должно ставиться отметка, что
 * план по двигателю выполнен».
 */
export type ProductionProgramExecutionState = 'ready' | 'shipped' | 'inWork' | 'notStarted';

export const PRODUCTION_PROGRAM_EXECUTION_LABELS: Record<ProductionProgramExecutionState, string> = {
  ready: 'Готов к отгрузке',
  shipped: 'Отгружен',
  inWork: 'В работе',
  notStarted: 'Не начат',
};

export type ProductionProgramExecution = {
  state: ProductionProgramExecutionState;
  stateLabel: string;
  /** null — плановой даты отгрузки нет, срок не судим. */
  onTime: boolean | null;
  /** Просрочен ли план по этой строке. */
  overdue: boolean;
};

/**
 * Выполнение строки плана: состояние двигателя + попадание в срок.
 *
 * Срок — плановая отгрузка строки (`shippingPlanAt`): отгружен в срок — «в срок»,
 * отгружен позже — «выпал из сроков»; не отгружен, а срок уже прошёл — «просрочен».
 */
export function productionProgramRowExecution(args: {
  engine: EngineListItem | null | undefined;
  shippingPlanAt?: number | null | undefined;
  /** Текущее время (мс) — для проверки «срок вышел». */
  now?: number | undefined;
}): ProductionProgramExecution {
  const engine = args.engine ?? null;
  const now = typeof args.now === 'number' && Number.isFinite(args.now) ? args.now : Date.now();
  const planAt = typeof args.shippingPlanAt === 'number' && args.shippingPlanAt > 0 ? args.shippingPlanAt : null;

  let state: ProductionProgramExecutionState;
  if (!engine) state = 'notStarted';
  else {
    const highlight = productionProgramRowHighlight(engine);
    if (highlight === 'shipped') state = 'shipped';
    else if (highlight === 'ready') state = 'ready';
    else if (isProductionProgramEngineAtPlant(engine)) state = 'inWork';
    else state = 'notStarted';
  }

  let onTime: boolean | null = null;
  if (planAt != null) {
    if (state === 'shipped') {
      const shippedAt = productionProgramEngineDates(engine).shippingDate;
      onTime = (shippedAt ?? now) <= planAt;
    } else {
      onTime = now <= planAt;
    }
  }

  return {
    state,
    stateLabel: PRODUCTION_PROGRAM_EXECUTION_LABELS[state],
    onTime,
    overdue: onTime === false,
  };
}

export type ProductionProgramExecutionSummary = {
  /** Строк в плане всего. */
  total: number;
  /** Выполнено: готов к отгрузке или отгружен. */
  done: number;
  ready: number;
  shipped: number;
  inWork: number;
  notStarted: number;
  /** Уложились в плановый срок отгрузки. */
  onTime: number;
  /** Выпали из сроков. */
  overdue: number;
};

/**
 * Сводка выполнения плана — то, что показывается на плашке программы
 * («сколько двигателей ещё не собраны, сколько выполнено», владелец 10.11.2026).
 */
export function productionProgramExecutionSummary(args: {
  rows: readonly {
    engineId?: string | null | undefined;
    shippingPlanAt?: number | null | undefined;
  }[];
  engines?: readonly EngineListItem[] | null | undefined;
  now?: number | undefined;
}): ProductionProgramExecutionSummary {
  const engineById = new Map<string, EngineListItem>();
  for (const e of args.engines ?? []) {
    const id = String(e.id ?? '').trim();
    if (id) engineById.set(id, e);
  }
  const summary: ProductionProgramExecutionSummary = {
    total: 0,
    done: 0,
    ready: 0,
    shipped: 0,
    inWork: 0,
    notStarted: 0,
    onTime: 0,
    overdue: 0,
  };
  for (const row of args.rows ?? []) {
    const engineId = String(row.engineId ?? '').trim();
    const engine = engineId ? engineById.get(engineId) ?? null : null;
    const execution = productionProgramRowExecution({
      engine,
      shippingPlanAt: row.shippingPlanAt ?? null,
      ...(typeof args.now === 'number' ? { now: args.now } : {}),
    });
    summary.total += 1;
    if (execution.state === 'ready') summary.ready += 1;
    if (execution.state === 'shipped') summary.shipped += 1;
    if (execution.state === 'inWork') summary.inWork += 1;
    if (execution.state === 'notStarted') summary.notStarted += 1;
    if (execution.state === 'ready' || execution.state === 'shipped') summary.done += 1;
    if (execution.onTime === true) summary.onTime += 1;
    if (execution.overdue) summary.overdue += 1;
  }
  return summary;
}

// ────────────────────────────────────────────────────────────
// Период
// ────────────────────────────────────────────────────────────

export type ProductionProgramPeriodKind = 'two_weeks' | 'month' | 'custom';

export const PRODUCTION_PROGRAM_PERIOD_LABELS: Record<ProductionProgramPeriodKind, string> = {
  two_weeks: 'Две недели',
  month: 'Месяц',
  custom: 'Свои даты',
};

export type ProductionProgramPeriod = {
  start: number;
  end: number;
};

const MONTH_NAMES = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
] as const;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Период программы по виду: две недели (14 дней подряд, 01–14) или календарный
 * месяц. «Свои даты» — как заданы.
 */
export function buildProductionProgramPeriod(
  kind: ProductionProgramPeriodKind,
  baseMs: number,
  custom?: { start?: number | null; end?: number | null } | null,
): ProductionProgramPeriod {
  const base = startOfDay(baseMs);
  if (kind === 'custom') {
    const start = custom?.start ? startOfDay(custom.start) : base;
    const end = custom?.end ? startOfDay(custom.end) : start;
    return { start: Math.min(start, end), end: Math.max(start, end) };
  }
  if (kind === 'month') {
    const d = new Date(base);
    const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime();
    return { start: startOfDay(start), end: startOfDay(end) };
  }
  const end = new Date(base);
  end.setDate(end.getDate() + 13);
  return { start: base, end: startOfDay(end.getTime()) };
}

/**
 * Вид периода по самим датам: календарный месяц — «месяц», ровно 14 дней —
 * «две недели», остальное — «свои даты».
 *
 * Нужен, чтобы выбор вида периода в шапке плана показывал правду: программа,
 * сохранённая с произвольными датами, не должна выглядеть как двухнедельная.
 */
export function productionProgramPeriodKind(period: ProductionProgramPeriod): ProductionProgramPeriodKind {
  const start = startOfDay(period.start);
  const end = startOfDay(period.end);
  const startDate = new Date(start);
  const monthStart = startOfDay(new Date(startDate.getFullYear(), startDate.getMonth(), 1).getTime());
  const monthEnd = startOfDay(new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0).getTime());
  if (start === monthStart && end === monthEnd) return 'month';
  const twoWeeksEnd = new Date(start);
  twoWeeksEnd.setDate(twoWeeksEnd.getDate() + 13);
  if (startOfDay(twoWeeksEnd.getTime()) === end) return 'two_weeks';
  return 'custom';
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function dayMonth(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
}

/**
 * Подпись периода как в образце: «Ноябрь 2026 г. (01.11-15.11)».
 * Для периода, не совпадающего с календарным месяцем, месяц берётся по началу.
 */
export function formatProductionProgramPeriod(period: ProductionProgramPeriod): string {
  const start = new Date(period.start);
  const end = new Date(period.end);
  const month = MONTH_NAMES[start.getMonth()] ?? '';
  const year = start.getFullYear();
  const range = `${dayMonth(period.start)}-${dayMonth(period.end)}`;
  const sameYear = end.getFullYear() === year;
  const tail = sameYear ? range : `${range} ${end.getFullYear()}`;
  return `${month} ${year} г. (${tail})`;
}

// ────────────────────────────────────────────────────────────
// Модель печати
// ────────────────────────────────────────────────────────────

export type ProductionProgramPrintRow = {
  id: string;
  /** Номер «№ п/п» — сквозной по строкам-перевозчикам (шапки групп номера не занимают). */
  orderNo: number;
  contractId: string | null;
  /** Строка-шапка группы: организация + номер договора. */
  groupLabel: string;
  /** Вид договора на момент добавления строки (снимок). */
  contractKind: ContractKind | null;
  engineId: string | null;
  engineMark: string;
  engineNumber: string;
  state: ProductionProgramState | null;
  /** Плановая отгрузка (ручная). */
  shippingPlanAt: number | null;
  /** Факт отгрузки — из карточки двигателя (для подсказки/подсветки). */
  shippingFactAt: number | null;
  /**
   * Живая подпись «Организация» для строки: заказчик и три цифры номера договора
   * (до слэша). Берётся из карточки двигателя, а не из снимка строки плана.
   */
  organizationLabel: string;
  factors: string;
  note: string;
  highlight: ProductionProgramHighlight;
};

export type ProductionProgramPrintGroup = {
  contractId: string | null;
  label: string;
  rows: ProductionProgramPrintRow[];
};

export type ProductionProgramPrintModel = {
  title: string;
  periodLabel: string;
  shop: string;
  groups: ProductionProgramPrintGroup[];
  /** Общее число двигателей в плане (без шапок групп). */
  engineCount: number;
  approver: typeof PRODUCTION_PROGRAM_APPROVER;
  signatures: Array<{ caption: string; name: string; source: 'document' | 'employee' }>;
};

export type ProductionProgramPrintInput = {
  title: string;
  shop: string;
  period: ProductionProgramPeriod;
  rows: readonly {
    id: string;
    contractId?: string | null;
    groupLabel?: string | null;
    contractKind?: string | null;
    engineId?: string | null;
    engineMark?: string | null;
    engineNumber?: string | null;
    state?: string | null;
    shippingPlanAt?: number | null;
    shippingFactAt?: number | null;
    factors?: string | null;
    note?: string | null;
  }[];
  /** Факт по двигателю (для подсветки): ключ — id двигателя. */
  engines?: readonly EngineListItem[] | null;
  signatureSlots?: readonly ProductionProgramSignatureSlot[] | null;
  employees?: readonly WorkOrderSignatureEmployee[] | null;
};

/**
 * Модель печати ПП: строки сгруппированы по договору (группа = шапка с
 * организацией и номером договора), «№ п/п» сквозной по строкам-перевозчикам.
 * Подсветка строк считается по факту из карточки двигателя.
 */
export function buildProductionProgramPrintModel(input: ProductionProgramPrintInput): ProductionProgramPrintModel {
  const engineById = new Map<string, EngineListItem>();
  for (const e of input.engines ?? []) {
    const id = String(e.id ?? '').trim();
    if (id) engineById.set(id, e);
  }

  const groups: ProductionProgramPrintGroup[] = [];
  const groupByKey = new Map<string, ProductionProgramPrintGroup>();
  let orderNo = 0;

  for (const raw of input.rows ?? []) {
    const contractId = raw.contractId ? String(raw.contractId) : null;
    // Шапка группы — человеческое наименование договора. Технический идентификатор
    // в печать не идёт (прочерк): форма плана — документ для подписей, а не выгрузка.
    const groupLabel = productionProgramGroupLabel(raw.groupLabel);
    const key = `${contractId ?? ''}::${groupLabel}`;
    let group = groupByKey.get(key);
    if (!group) {
      group = { contractId, label: groupLabel, rows: [] };
      groupByKey.set(key, group);
      groups.push(group);
    }
    orderNo += 1;
    const engineId = raw.engineId ? String(raw.engineId) : null;
    const engine = engineId ? engineById.get(engineId) ?? null : null;
    group.rows.push({
      id: String(raw.id ?? ''),
      orderNo,
      contractId,
      groupLabel,
      contractKind: parseContractKind(raw.contractKind),
      engineId,
      engineMark: String(raw.engineMark ?? '').trim(),
      engineNumber: String(raw.engineNumber ?? '').trim(),
      state: parseProductionProgramState(raw.state),
      shippingPlanAt: typeof raw.shippingPlanAt === 'number' && raw.shippingPlanAt > 0 ? raw.shippingPlanAt : null,
      // Факт отгрузки — по источнику правды по датам (рекламация выше основного цикла).
      shippingFactAt:
        typeof raw.shippingFactAt === 'number' && raw.shippingFactAt > 0
          ? raw.shippingFactAt
          : productionProgramEngineDates(engine).shippingDate,
      factors: String(raw.factors ?? '').trim(),
      note: String(raw.note ?? '').trim(),
      organizationLabel:
        productionProgramOrganizationLabel({
          customerName: engine?.customerName ?? null,
          contractNumber: engine?.contractName ?? null,
        }) || productionProgramGroupLabel(raw.groupLabel),
      highlight: productionProgramRowHighlight(engine),
    });
  }

  const slots = resolveProductionProgramSignatureSlots(input.signatureSlots ?? null);
  const employees = input.employees ?? [];
  const signatures = slots.map((slot) => {
    const resolved = resolveProductionProgramSignatureName(slot, employees);
    return { caption: slot.caption, name: resolved.name, source: resolved.source };
  });

  return {
    title: String(input.title ?? '').trim(),
    periodLabel: formatProductionProgramPeriod(input.period),
    shop: String(input.shop ?? '').trim(),
    groups,
    engineCount: orderNo,
    approver: PRODUCTION_PROGRAM_APPROVER,
    signatures,
  };
}

// ────────────────────────────────────────────────────────────
// Контракт клиента (DTO)
// ────────────────────────────────────────────────────────────

/** План производства — как его видит клиент (реплика сервера). */
export type ProductionProgramDto = {
  id: string;
  periodStart: number;
  periodEnd: number;
  shop: string;
  title: string;
  status: string;
  signatureSlots: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

/** Строка плана — как её видит клиент. */
export type ProductionProgramLineDto = {
  id: string;
  programId: string;
  orderNo: number;
  contractId: string | null;
  groupLabel: string;
  contractKind: string | null;
  engineId: string | null;
  engineMark: string;
  engineNumber: string;
  state: string | null;
  shippingPlanAt: number | null;
  factors: string;
  note: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

/** Строка плана в редакторе — то, что оператор присылает на сервер. */
export type ProductionProgramLineDraftDto = {
  id?: string | null;
  orderNo: number;
  contractId?: string | null;
  groupLabel: string;
  contractKind?: string | null;
  engineId?: string | null;
  engineMark?: string;
  engineNumber?: string;
  state?: string | null;
  shippingPlanAt?: number | null;
  factors?: string;
  note?: string;
};

/** Шапка плана в редакторе. */
export type ProductionProgramSaveDto = {
  periodStart: number;
  periodEnd: number;
  shop: string;
  title: string;
  status?: string;
  signatureSlots?: string | null;
};
