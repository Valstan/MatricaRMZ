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
import { DEFAULT_REPAIR_STAGE_TEMPLATES, repairStageRank, type RepairStageTemplate } from './repairStages.js';
import { moscowDayKey } from './workSheetDuplicates.js';
import { findEmployeeByPositionGroups, formatEmployeeSurnameInitials, type WorkOrderSignatureEmployee } from './workOrderSignatures.js';
import {
  parsePrintSignatureSlots,
  resolvePrintSignatureSlots,
  type PrintSignatureSlot,
} from './printSignatures.js';
import { HUMAN_LABEL_DASH, humanCellText, looksLikeIdentifier } from './humanLabels.js';
import { normalizeLookupCompact } from './lookupNormalize.js';

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

/**
 * Слот подписи программы: должность + ФИО (из документа или из базы).
 *
 * Модель — общая для печатных форм (`printSignatures.ts`): ПП просто печатает свой
 * блок подписей, а правило одно на все формы.
 */
export type ProductionProgramSignatureSlot = PrintSignatureSlot;

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
 *
 * Правило разбора — общее для печатных форм (`printSignatures.ts`).
 */
export function parseProductionProgramSignatureSlots(raw: unknown): ProductionProgramSignatureSlot[] {
  return parsePrintSignatureSlots(raw);
}

/**
 * Слоты программы: сохранённые — как есть (в том числе добавленные оператором);
 * роли по умолчанию — только если блок не трогали (`saved === null`). Так программа,
 * созданная до правки блока подписей, печатается с полным комплектом строк, а
 * добавленная подпись не исчезает и удалённая не возвращается сама.
 *
 * Роли по умолчанию НЕ дописываются в сохранённый набор: оператор, убравший
 * подпись, должен получить ровно то, что оставил.
 */
export function resolveProductionProgramSignatureSlots(
  saved: readonly ProductionProgramSignatureSlot[] | null | undefined,
): ProductionProgramSignatureSlot[] {
  const defaults: ProductionProgramSignatureSlot[] = PRODUCTION_PROGRAM_SIGNATURE_SLOTS.map((def) => ({
    caption: def.caption,
    employeeId: null,
    fullName: def.fullName,
  }));
  return resolvePrintSignatureSlots(saved, defaults);
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

// ────────────────────────────────────────────────────────────
// Этап двигателя в плане
// ────────────────────────────────────────────────────────────

/**
 * Текущий этап двигателя — из карточки, по ПОСЛЕДНЕЙ строке истории ремонта.
 *
 * Источник — `EngineListItem.lastStageCode/lastStageName/lastStageAt`: это уже
 * посчитанный в карточке «где двигатель сейчас» (служебная отметка «создание
 * карточки» из расчёта места исключена). Плану не нужен свой расчёт этапов —
 * иначе экран и карточка разойдутся.
 *
 * Подпись — «Сборка двигателя · 12.11.2026»: этап без даты половина правды.
 */
export type ProductionProgramEngineStage = {
  /** Код этапа единого списка (`repairStages.ts`). */
  code: string;
  /** Название этапа. */
  name: string;
  /** Дата этапа (мс) — null, если этап без даты. */
  at: number | null;
  /** Дата этапа подписью: «12.11.2026» (пусто, если этап без даты). */
  dateLabel: string;
  /** Подпись для колонки: название и дата. */
  label: string;
};

/** Название этапа по коду: серверный справочник, а без него — статика шага 1. */
export function productionProgramStageName(code: string | null | undefined): string {
  const c = String(code ?? '').trim().toLowerCase();
  if (!c) return '';
  return DEFAULT_REPAIR_STAGE_TEMPLATES.find((t) => t.code === c)?.name ?? c;
}

/**
 * Текущий этап двигателя для колонки плана.
 *
 * Пусто (null) — этапов ещё не было: тогда ячейка предлагает выбрать этап, но
 * не врёт, что двигатель «где-то».
 */
export function productionProgramEngineStage(
  engine: EngineListItem | null | undefined,
): ProductionProgramEngineStage | null {
  if (!engine) return null;
  const code = String(engine.lastStageCode ?? '').trim().toLowerCase();
  if (!code) return null;
  const at =
    typeof engine.lastStageAt === 'number' && Number.isFinite(engine.lastStageAt) && engine.lastStageAt > 0
      ? engine.lastStageAt
      : null;
  const name = String(engine.lastStageName ?? '').trim() || productionProgramStageName(code);
  const dateLabel = at ? moscowDayKey(at) : '';
  return {
    code,
    name,
    at,
    dateLabel,
    label: dateLabel ? `${name} · ${dateLabel}` : name,
  };
}

/** Пункт меню выбора этапа. */
export type ProductionProgramStageOption = {
  code: string;
  name: string;
  /** Ранг этапа в линейке (порядок ремонта). */
  sortOrder: number;
  /** Это текущий этап двигателя. */
  isCurrent: boolean;
};

/**
 * Меню выбора этапа — по линейке ремонта, сверху вниз.
 *
 * Порядок по рангу, а не по алфавиту: оператор идёт по этапам сверху вниз, и
 * «следующий» обязан стоять рядом с текущим. Текущий этап помечен — иначе
 * оператор не поймёт, где он сейчас, и запишет тот же этап ещё раз.
 */
export function productionProgramStageOptions(
  templates: readonly RepairStageTemplate[] | null | undefined,
  currentCode: string | null | undefined,
): ProductionProgramStageOption[] {
  const list = (templates && templates.length > 0 ? templates : DEFAULT_REPAIR_STAGE_TEMPLATES)
    .filter((t) => !t.archivedAt)
    .slice()
    // Боковая ветка (утиль и брак) в порядок по датам не входит — поэтому в меню
    // она последняя, а не первой: иначе «Утиль и брак» стоял бы над приёмкой.
    .sort((a, b) => Number(Boolean(a.sideBranch)) - Number(Boolean(b.sideBranch)) || a.sortOrder - b.sortOrder);
  const current = String(currentCode ?? '').trim().toLowerCase();
  return list.map((t) => ({
    code: t.code,
    name: t.name,
    sortOrder: t.sortOrder,
    isCurrent: t.code === current,
  }));
}

/**
 * Соседи текущего этапа по линейке: следующий (выше по рангу) и предыдущий.
 *
 * Заказ владельца (20.11.2026): «можно было выбрать другой какой-то этап,
 * следующий, например, или предыдущий» — поэтому в модалке есть кнопки перехода
 * на соседа, а не только общий список.
 */
export function productionProgramStageNeighbours(
  templates: readonly RepairStageTemplate[] | null | undefined,
  currentCode: string | null | undefined,
): { next: RepairStageTemplate | null; prev: RepairStageTemplate | null } {
  // Боковая ветка (утиль и брак) соседом этапа не является: это не шаг назад
  // по линейке, а другой исход. В «предыдущий» она не попадает.
  const line = (templates && templates.length > 0 ? templates : DEFAULT_REPAIR_STAGE_TEMPLATES).filter(
    (t) => !t.sideBranch,
  );
  const options = productionProgramStageOptions(line, currentCode);
  const current = options.find((o) => o.isCurrent) ?? null;
  if (!current) return { next: null, prev: null };
  const byCode = new Map<string, RepairStageTemplate>(line.map((t) => [t.code, t]));
  const above = options.filter((o) => o.sortOrder > current.sortOrder);
  const below = options.filter((o) => o.sortOrder < current.sortOrder);
  // Ближайший ВЫШЕ по линейке = следующий шаг ремонта; ближайший НИЖЕ = шаг назад.
  const next = above.length > 0 ? byCode.get(above[0]!.code) ?? null : null;
  const prev = below.length > 0 ? byCode.get(below[below.length - 1]!.code) ?? null : null;
  return { next, prev };
}

/**
 * Строка плана из карточки двигателя — одна точка правды для всех мест
 * добавления (страница программы и список двигателей): значения берутся из
 * карточки, состояние — из вида договора, подпись группы — из договора.
 *
 * Идентификатор строки даёт вызывающий, и он должен быть ПОСТОЯННЫМ: черновой
 * id ронял строку при сохранении (чинили 10.11).
 */
export function productionProgramRowFromEngine(input: {
  id: string;
  engine: EngineListItem;
  /** Подпись группы: организация и номер договора (без неё строка не имеет группы). */
  groupLabel: string;
  /** Вид договора — по нему подставляется состояние строки. */
  contractKind?: ContractKind | null;
}): ProductionProgramLineDraftDto & { id: string } {
  const engine = input.engine;
  // Вид договора — по разделам договора; если их нет, берём вид двигателя
  // (он считается по тому же правилу: договор → карточка → контрагент).
  const kind = input.contractKind ?? engine.kind ?? null;
  const suggested = suggestedProductionProgramStates(kind);
  return {
    id: input.id,
    orderNo: 0,
    contractId: engine.contractId == null ? null : String(engine.contractId),
    groupLabel: input.groupLabel,
    contractKind: kind,
    engineId: String(engine.id),
    engineMark: String(engine.engineBrand ?? ''),
    engineNumber: String(engine.engineNumber ?? ''),
    state: suggested[0] ?? null,
    shippingPlanAt: null,
    factors: '',
    note: '',
  };
}

/**
 * Нумерация строк плана: общая по программе и своя внутри договора.
 *
 * Обе считаются **по позиции**, а не по сохранённому числу: после перетаскивания
 * сохранённые номера разъезжаются, и цифры на экране перестают быть правдой.
 * Своя нумерация внутри договора отдельным полем не хранится — она выводится
 * из порядка строк.
 */
export type ProductionProgramNumbering = {
  /** Сквозной «№ п/п» по программе. */
  global: number;
  /** «№ п/п» внутри своего договора. */
  inContract: number;
};

/** Ключ группы строк: договор + подпись группы (как в печатной модели). */
export function productionProgramGroupKey(row: {
  contractId?: string | null;
  groupLabel?: string | null;
}): string {
  return `${row.contractId ? String(row.contractId) : ''}::${productionProgramGroupLabel(row.groupLabel)}`;
}

/**
 * Нумерация строк плана по текущему порядку: общая по программе и своя внутри
 * договора. Считается по позиции строки в плоском массиве — тот же порядок, по
 * которому печать собирает группы (`buildProductionProgramPrintModel`), чтобы
 * на экране и на бумаге цифры совпадали.
 */
export function productionProgramNumbering(
  rows: readonly {
    id?: string | null;
    contractId?: string | null;
    groupLabel?: string | null;
  }[],
): Map<string, ProductionProgramNumbering> {
  const result = new Map<string, ProductionProgramNumbering>();
  const inGroup = new Map<string, number>();
  let global = 0;
  for (const row of rows ?? []) {
    global += 1;
    const key = productionProgramGroupKey(row);
    const n = (inGroup.get(key) ?? 0) + 1;
    inGroup.set(key, n);
    const id = String(row.id ?? '');
    if (id) result.set(id, { global, inContract: n });
  }
  return result;
}

/**
 * Сторона места вставки: перед целевой строкой или после неё.
 *
 * Общий слой перетаскивания (кит, промт КАРМАНА #67) отдаёт место вставки
 * именно так — «перед/после». Домен переводит это в порядок строк: правило
 * перестановки одно, а сторона приходит оттуда, где считали прямоугольники.
 */
export type ProductionProgramDropSide = 'before' | 'after';

/**
 * Перестановка двигателя **в пределах своего договора**: строка занимает место
 * указанной строки цели (в том же договоре). Чужая группа не затрагивается.
 *
 * Возвращает НОВЫЙ массив строк (порядок в нём — это и есть порядок плана).
 *
 * `side` — сторона места вставки от кита: `before` (по умолчанию) ставит строку
 * перед целевой, `after` — сразу после неё. Двигатель при этом остаётся в своём
 * договоре: строка принадлежит группе по данным, а не по месту в массиве.
 */
export function productionProgramMoveRowWithinGroup<
  T extends { id?: string | null; contractId?: string | null; groupLabel?: string | null },
>(rows: readonly T[], rowId: string, targetRowId: string, side: ProductionProgramDropSide = 'before'): T[] {
  const list = [...(rows ?? [])];
  const from = list.findIndex((r) => String(r.id ?? '') === rowId);
  if (from < 0) return list;
  const target = list.findIndex((r) => String(r.id ?? '') === targetRowId);
  if (target < 0 || target === from) return list;
  const moving = list[from]!;
  // Двигатель едет только внутри своего договора: цель — строка того же договора.
  if (productionProgramGroupKey(moving) !== productionProgramGroupKey(list[target]!)) return list;
  list.splice(from, 1);
  let to = list.findIndex((r) => String(r.id ?? '') === targetRowId);
  if (to < 0) to = list.length;
  if (side === 'after') to += 1;
  list.splice(to, 0, moving);
  return list;
}

/**
 * Перестановка группы (договора со своим блоком движков) **внутри программы**:
 * блок уезжает целиком и встаёт на место другой группы.
 *
 * `side` — сторона места вставки от кита: `before` (по умолчанию) ставит блок
 * перед целевой группой, `after` — сразу за её блоком.
 */
export function productionProgramMoveGroup<
  T extends { id?: string | null; contractId?: string | null; groupLabel?: string | null },
>(rows: readonly T[], groupKey: string, targetGroupKey: string, side: ProductionProgramDropSide = 'before'): T[] {
  const list = [...(rows ?? [])];
  if (groupKey === targetGroupKey) return list;
  const block = list.filter((r) => productionProgramGroupKey(r) === groupKey);
  if (block.length === 0) return list;
  const rest = list.filter((r) => productionProgramGroupKey(r) !== groupKey);
  const targetIndex = rest.findIndex((r) => productionProgramGroupKey(r) === targetGroupKey);
  if (targetIndex < 0) {
    // Цели нет — блок уходит в конец программы.
    return [...rest, ...block];
  }
  let insertAt = targetIndex;
  if (side === 'after') {
    // За целевой группой: вставляем после её последней строки.
    let last = targetIndex;
    while (last + 1 < rest.length && productionProgramGroupKey(rest[last + 1]!) === targetGroupKey) last += 1;
    insertAt = last + 1;
  }
  return [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)];
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

/**
 * Тон строки плана на экране: фон по факту из карточки движка.
 *
 * Правило живёт в домене, а не в компоненте страницы: один источник правды,
 * иначе подсветка на экране разойдётся с подсветкой на печати (тот же запрет,
 * что у `productionProgramEngineHint`).
 */
export type ProductionProgramRowTone = {
  /** Фон строки ('' — без заливки). */
  background: string;
  /** Подсказка: почему строка такого цвета. */
  label: string;
};

/** Заливка строки «готов к отгрузке» — та же, что на печатной форме. */
export const PRODUCTION_PROGRAM_READY_BACKGROUND = '#dcfce7';

/**
 * Ручная отметка оператора на строке плана (промты КАРМАНА #48/#49, владелец
 * 19.11.2026): «оператор может помечать некоторые двигатели, чтобы быстрее
 * находить в производственной программе и обмениваться данными с другими
 * операторами — чтобы внимание к этому двигателю было особенное».
 *
 * Это НЕ состояние строки плана (`ProductionProgramState`) и НЕ стадия ремонта:
 * три разные вещи, у каждой своё поле. Отметка не влияет на порядок строк.
 *
 * Хранится ПРИЗНАК, а не цвет: цвет выводится из признака — смена палитры не
 * должна быть перекраской данных. Набор признаков задан ЯВНО (как
 * `engineScrapRowStyle`), а не «произвольный цвет из интерфейса».
 */
export const ProductionProgramOperatorMark = {
  Attention: 'attention',
} as const;
export type ProductionProgramOperatorMark =
  (typeof ProductionProgramOperatorMark)[keyof typeof ProductionProgramOperatorMark];

export const PRODUCTION_PROGRAM_OPERATOR_MARKS: readonly ProductionProgramOperatorMark[] = [
  ProductionProgramOperatorMark.Attention,
];

export const PRODUCTION_PROGRAM_OPERATOR_MARK_LABELS: Record<ProductionProgramOperatorMark, string> = {
  attention: 'Особое внимание',
};

/** Заливка строки под ручную отметку оператора. */
export const PRODUCTION_PROGRAM_ATTENTION_BACKGROUND = '#fef3c7';

/** Разбор сохранённой отметки: неизвестное значение — это не отметка. */
export function parseProductionProgramOperatorMark(raw: unknown): ProductionProgramOperatorMark | null {
  const value = String(raw ?? '').trim();
  return (PRODUCTION_PROGRAM_OPERATOR_MARKS as readonly string[]).includes(value)
    ? (value as ProductionProgramOperatorMark)
    : null;
}

/** Подпись отметки для интерфейса (пусто — отметки нет). */
export function productionProgramOperatorMarkLabel(raw: unknown): string {
  const parsed = parseProductionProgramOperatorMark(raw);
  return parsed ? PRODUCTION_PROGRAM_OPERATOR_MARK_LABELS[parsed] : '';
}

export function productionProgramRowTone(
  engine: EngineListItem | null | undefined,
  operatorMark?: string | null | undefined,
): ProductionProgramRowTone {
  const highlight = productionProgramRowHighlight(engine);
  const factLabel =
    highlight === 'ready' ? 'Готов к отгрузке — на заводе' : highlight === 'shipped' ? 'Отгружен' : '';
  // Отметка оператора сильнее факта из карточки: её поставили руками именно
  // для того, чтобы эту строку заметили. Факт при этом не теряется — он в
  // подсказке строки и в колонке «Выполнение».
  if (parseProductionProgramOperatorMark(operatorMark)) {
    return {
      background: PRODUCTION_PROGRAM_ATTENTION_BACKGROUND,
      label: factLabel
        ? `Особое внимание (отметка оператора) · ${factLabel}`
        : 'Особое внимание (отметка оператора)',
    };
  }
  if (highlight === 'ready') {
    return { background: PRODUCTION_PROGRAM_READY_BACKGROUND, label: 'Готов к отгрузке — на заводе' };
  }
  if (highlight === 'shipped') {
    return { background: '', label: 'Отгружен' };
  }
  return { background: '', label: '' };
}

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
  /**
   * Текущий этап двигателя — из карточки (последний этап истории ремонта).
   *
   * В плане «Отгрузка» и «Факторы» убраны (решение владельца 20.11.2026): отгрузка
   * видна этапом, а «Факторы» после чистки колонок печатались бы всегда пустыми.
   * Вместо них — этап: на бумаге видно, где двигатель сейчас.
   */
  stageCode: string;
  stageName: string;
  stageAt: number | null;
  /** Подпись этапа для печати: «Сборка двигателя · 12.11.2026». */
  stageLabel: string;
  /**
   * Живая подпись «Организация» для строки: заказчик и три цифры номера договора
   * (до слэша). Берётся из карточки двигателя, а не из снимка строки плана.
   */
  organizationLabel: string;
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
    // Этап — из живой карточки двигателя: на бумаге видно, где он сейчас.
    const stage = productionProgramEngineStage(engine);
    group.rows.push({
      id: String(raw.id ?? ''),
      orderNo,
      contractId,
      groupLabel,
      contractKind: parseContractKind(raw.contractKind),
      engineId,
      // Марка и номер — **живые**: план не живёт отдельной жизнью, правка карточки
      // видна в плане сразу (правило модуля). Снимок строки — запасной вариант:
      // карточки двигателя может не быть (двигатель уехал из картотеки), и тогда
      // показывать пустоту вместо номера хуже, чем снимок.
      engineMark: String(engine?.engineBrand || raw.engineMark || '').trim(),
      engineNumber: String(engine?.engineNumber || raw.engineNumber || '').trim(),
      state: parseProductionProgramState(raw.state),
      stageCode: stage?.code ?? '',
      stageName: stage?.name ?? '',
      stageAt: stage?.at ?? null,
      stageLabel: stage?.label ?? '',
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

/**
 * Подпись этапа для показа строки: у отгруженного двигателя без строки этапа — «Отгружен».
 *
 * Правило живёт здесь, потому что его показывают два места — лист печати и файл выгрузки.
 * Повторённое в каждом своя копия разъезжается: на бумаге «Отгружен», а в Excel пусто.
 */
export function productionProgramStageText(row: {
  stageLabel?: string | null;
  highlight?: ProductionProgramHighlight | null;
}): string {
  const label = String(row.stageLabel ?? '').trim();
  if (label) return label;
  return row.highlight === 'shipped' ? 'Отгружен' : '';
}

// ────────────────────────────────────────────────────────────
// Контракт клиента (DTO)
// ────────────────────────────────────────────────────────────

/** План производства — как его видит клиент (реплика сервера). */
export type ProductionProgramDto = {
  id: string;
  periodStart: number;
  periodEnd: number;
  /** Снимок имени цеха — ради печати и выгрузки (в образце «Цех № 1»). */
  shop: string;
  /**
   * Цех из справочника `directory_workshops` — связь по id.
   *
   * null — программа заведена до появления связи (или цех в справочнике не
   * нашёлся): такие ждут решения владельца, а не угадывания.
   */
  workshopId: string | null;
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
  /**
   * Ручная отметка оператора ('attention') — свой фон строки. Приезжает зеркалом
   * вместе со строкой; на порядок не влияет.
   */
  operatorNote: string | null;
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
  /**
   * Цех из справочника `directory_workshops` (id).
   *
   * Если задан — сервер сам возьмёт имя цеха и запишет его снимком в `shop`.
   * Если пусто — остаётся legacy-путь: `shop` приходит текстом.
   */
  workshopId?: string | null;
  title: string;
  status?: string;
  signatureSlots?: string | null;
};

/**
 * Слияние серверных строк с локальной правкой.
 *
 * Набор строк плана заменяется ЦЕЛИКОМ, а зеркало программ отстаёт на минуту.
 * Значит, перед любой записью надо взять серверные строки за основу и положить
 * поверх них нашу правку: иначе запись снимет строку, добавленную другим
 * оператором минуту назад (её ещё нет в нашей реплике).
 *
 * Правила:
 *  · строка есть и на сервере, и у нас — наша версия (мы её правили);
 *  · строка только на сервере — чужая, её НЕ трогаем;
 *  · строка только у нас — наша новая (ещё не уехала на сервер).
 */
export function productionProgramMergeRows<T extends { id: string }>(input: {
  server: readonly T[];
  local: readonly T[];
}): T[] {
  const localById = new Map(input.local.map((row) => [String(row.id), row]));
  const serverIds = new Set(input.server.map((row) => String(row.id)));
  const out: T[] = [];
  for (const row of input.server) {
    const mine = localById.get(String(row.id));
    out.push(mine ?? row);
  }
  for (const row of input.local) {
    if (!serverIds.has(String(row.id))) out.push(row);
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Блок «Требует данных»: проблемные строки плана и их переезд
// (промты КАРМАНА #64 + #65, ответы владельца #66 → D-246)
// ────────────────────────────────────────────────────────────

/**
 * Подпись группы проблемных строк — словами: сервер не принимает в подписи группы
 * технический идентификатор (`productionProgramService.ts:344-346`). Это тот самый
 * «блок без договора» из задания владельца: строки без договора живут внутри
 * программы, и когда договор появляется, они САМИ уезжают в группу своего договора.
 */
export const PRODUCTION_PROGRAM_PENDING_GROUP_LABEL = 'Требует данных';

/** Проблема строки плана — по карточке двигателя. */
export type ProductionProgramEngineProblemCode =
  | 'ok'
  | 'no_card'
  | 'no_contract'
  | 'no_customer'
  | 'no_history'
  | 'shipped'
  | 'scrap';

/**
 * Тексты причин — единый список: по нему мы узнаём СВОЙ служебный текст в
 * примечании и не затираем примечание, написанное оператором руками.
 */
export const PRODUCTION_PROGRAM_ENGINE_PROBLEM_TEXTS: Record<ProductionProgramEngineProblemCode, string> = {
  ok: 'Годен для плана',
  no_card: 'Нет карточки в базе',
  no_contract: 'Нет договора',
  no_customer: 'Нет контрагента',
  no_history: 'Нет истории ремонта',
  shipped: 'Уже отгружен — в план не берём',
  scrap: 'Утиль — восстановление',
};

export type ProductionProgramEngineProblem = {
  code: ProductionProgramEngineProblemCode;
  /** Причина словами: едет в примечание строки, в печать и в чат. */
  text: string;
  /** Проблема мешает строке уехать в группу своего договора. */
  blocking: boolean;
  /** Строку взять в план нельзя (двигатель отгружен). */
  forbidden: boolean;
};

/**
 * Причина, по которой двигатель не может встать в план (или встать не может).
 *
 * «Нет контрагента» и «нет истории ремонта» — ПРЕДУПРЕЖДЕНИЯ, а не блок: договор у
 * двигателя есть, значит строка встаёт в группу своего договора (шапка группы
 * сложится из номера договора), а отсутствие контрагента или этапов оператор
 * видит в отчёте добавления. Блокируют переезд только «нет карточки» и «нет
 * договора» — до них строке группы не из чего собрать (ответы владельца #66).
 */
export function productionProgramEngineProblem(
  engine: EngineListItem | null | undefined,
): ProductionProgramEngineProblem {
  const text = (code: ProductionProgramEngineProblemCode) =>
    PRODUCTION_PROGRAM_ENGINE_PROBLEM_TEXTS[code];
  if (!engine) {
    return { code: 'no_card', text: text('no_card'), blocking: true, forbidden: false };
  }
  const hint = productionProgramEngineHint(engine);
  if (hint.tone === 'block') {
    return { code: 'shipped', text: text('shipped'), blocking: true, forbidden: true };
  }
  if (engine.isScrap === true) {
    return { code: 'scrap', text: text('scrap'), blocking: false, forbidden: false };
  }
  if (!String(engine.contractId ?? '').trim()) {
    return { code: 'no_contract', text: text('no_contract'), blocking: true, forbidden: false };
  }
  if (!String(engine.customerName ?? '').trim()) {
    return { code: 'no_customer', text: text('no_customer'), blocking: false, forbidden: false };
  }
  if (!(engine.stageCodes ?? []).length) {
    return { code: 'no_history', text: text('no_history'), blocking: false, forbidden: false };
  }
  return { code: 'ok', text: text('ok'), blocking: false, forbidden: false };
}

/**
 * Причина, по которой строка ждёт в блоке: у договора не видно номера — шапке
 * группы не из чего сложиться (номер приходит зеркалом позже карточки).
 *
 * Служебный текст: как и остальные причины, он узнаётся по списку и снимается,
 * когда строка уезжает в группу договора.
 */
export const PRODUCTION_PROGRAM_NO_CONTRACT_NUMBER_NOTE = 'Нет номера договора';

/** Примечание строки — наш служебный текст (пусто или одна из причин)? */
export function productionProgramSystemNote(note: string | null | undefined): boolean {
  const text = String(note ?? '').trim();
  if (!text) return true;
  if (text === PRODUCTION_PROGRAM_NO_CONTRACT_NUMBER_NOTE) return true;
  return Object.values(PRODUCTION_PROGRAM_ENGINE_PROBLEM_TEXTS).includes(text);
}

/** Ключ нормализованного номера двигателя — тот же, что у гейта дублей и пакетного приёма. */
function productionProgramNumberKey(value: string | null | undefined): string {
  return normalizeLookupCompact(String(value ?? ''));
}

/** Указатель по карточкам двигателей: по id и по номеру. */
export type ProductionProgramEngineIndex = {
  byId: Map<string, EngineListItem>;
  byNumber: Map<string, EngineListItem[]>;
};

export function productionProgramEngineIndex(engines: readonly EngineListItem[]): ProductionProgramEngineIndex {
  const byId = new Map<string, EngineListItem>();
  const byNumber = new Map<string, EngineListItem[]>();
  for (const engine of engines ?? []) {
    const id = String(engine.id);
    if (id) byId.set(id, engine);
    const key = productionProgramNumberKey(engine.engineNumber);
    if (!key) continue;
    const list = byNumber.get(key);
    if (list) list.push(engine);
    else byNumber.set(key, [engine]);
  }
  return { byId, byNumber };
}

export type ProductionProgramEngineMatch = {
  /** Найденная карточка (null — не нашлась или неоднозначно). */
  engine: EngineListItem | null;
  /** Номер совпал с несколькими карточками: выбрать одну молча нельзя. */
  ambiguous: boolean;
  /** Сколько карточек совпало. */
  matches: number;
};

/**
 * Карточка по номеру двигателя.
 *
 * Номер в базе НЕ уникален (`erp_engine_cards_number_idx` — не уникальный индекс),
 * поэтому при нескольких совпадениях выбор не делаем: строка остаётся в блоке, а
 * оператор разбирается сам.
 */
export function productionProgramEngineMatch(
  index: ProductionProgramEngineIndex,
  number: string | null | undefined,
): ProductionProgramEngineMatch {
  const key = productionProgramNumberKey(number);
  if (!key) return { engine: null, ambiguous: false, matches: 0 };
  const found = index.byNumber.get(key) ?? [];
  if (found.length === 0) return { engine: null, ambiguous: false, matches: 0 };
  if (found.length === 1) return { engine: found[0]!, ambiguous: false, matches: 1 };
  return { engine: null, ambiguous: true, matches: found.length };
}

/** Строка плана в том виде, в каком её видит проход перепроверки. */
export type ProductionProgramPendingRowLike = {
  id?: string | null;
  contractId?: string | null;
  engineId?: string | null;
  engineNumber?: string | null;
};

/** Кандидат блока «Требует данных»: строка и её карточка (если нашлась). */
export type ProductionProgramPendingCandidate = {
  rowId: string;
  engine: EngineListItem | null;
  /** Номер совпал с несколькими карточками — строка остаётся в блоке. */
  ambiguous: boolean;
};

/**
 * Строки блока «Требует данных» и их карточки.
 *
 * Нужно клиенту, чтобы знать, у каких договоров читать вид (договор читается с
 * сервера, а не из реплики) — до того, как проход перепроверки примет решение.
 */
export function productionProgramPendingCandidates(
  rows: readonly ProductionProgramPendingRowLike[],
  index: ProductionProgramEngineIndex,
): ProductionProgramPendingCandidate[] {
  const out: ProductionProgramPendingCandidate[] = [];
  for (const row of rows ?? []) {
    if (String(row.contractId ?? '').trim()) continue;
    const rowId = String(row.id ?? '');
    const byId = String(row.engineId ?? '').trim();
    const direct = byId ? index.byId.get(byId) : undefined;
    if (direct) {
      out.push({ rowId, engine: direct, ambiguous: false });
      continue;
    }
    const match = productionProgramEngineMatch(index, row.engineNumber);
    out.push({ rowId, engine: match.engine, ambiguous: match.ambiguous });
  }
  return out;
}

export type ProductionProgramPendingResolution<T> = {
  /** Строки после прохода: переехавшие — на своих местах, остальные — как были. */
  rows: T[];
  /** Что-то изменилось? (запись идёт только при true) */
  changed: boolean;
  /** Сколько строк уехало из блока в группу своего договора. */
  moved: number;
  /** Сколько строк осталось в блоке. */
  unresolved: number;
};

/**
 * Проход перепроверки блока «Требует данных».
 *
 * Строка без договора ищет свою карточку (по id, а если его нет — по номеру) и,
 * когда у карточки появились договор и контрагент, **уезжает в группу своего
 * договора**: меняются `contractId` и `groupLabel`, а ключ группы считается из
 * них — значит, строка меняет группу сама.
 *
 * Пишем только при РЕАЛЬНОМ изменении: иначе каждое открытие программы писало бы
 * в сервер и могло перебить правку оператора (канон #1240).
 */
export function productionProgramResolvePendingRows<
  T extends ProductionProgramLineDraftDto & { id: string },
>(input: {
  rows: readonly T[];
  index: ProductionProgramEngineIndex;
  /** Подпись группы (организация и номер договора) по карточке. Пусто — договора нет. */
  contractLabelOf: (engine: EngineListItem) => string;
  /** Вид договора по его id (из строгой реплики). */
  contractKindOf?: (contractId: string) => ContractKind | null;
}): ProductionProgramPendingResolution<T> {
  const updates = new Map<string, { next: T; moved: boolean }>();
  let moved = 0;
  let unresolved = 0;

  for (const row of input.rows ?? []) {
    if (String(row.contractId ?? '').trim()) continue;
    const rowId = String(row.id ?? '');
    const byId = String(row.engineId ?? '').trim();
    const direct = byId ? input.index.byId.get(byId) : undefined;
    const match = direct ? { engine: direct, ambiguous: false } : productionProgramEngineMatch(input.index, row.engineNumber);
    const engine = match.engine;
    if (!engine) {
      unresolved += 1;
      continue;
    }
    const problem = productionProgramEngineProblem(engine);
    const next: T = { ...row };
    let dirty = false;

    // Карточка нашлась — привязываем её к строке (даже если договора ещё нет:
    // строка без карточки в блоке — это «номер есть, карточки нет»).
    if (!byId) {
      next.engineId = String(engine.id);
      dirty = true;
    }
    if (!String(next.engineMark ?? '').trim() && engine.engineBrand) {
      next.engineMark = String(engine.engineBrand);
      dirty = true;
    }
    if (!String(next.engineNumber ?? '').trim() && engine.engineNumber) {
      next.engineNumber = String(engine.engineNumber);
      dirty = true;
    }

    const label = problem.blocking ? '' : input.contractLabelOf(engine);
    // Шапка группы не годится — строка ждёт в блоке (номер договора ещё не доехал).
    const labelUsable = !!label && !looksLikeIdentifier(label);
    const canMove = !problem.blocking && labelUsable;
    if (canMove) {
      next.contractId = String(engine.contractId);
      next.groupLabel = label;
      next.contractKind = input.contractKindOf?.(String(engine.contractId)) ?? engine.kind ?? null;
      // Причина снята — служебный текст убираем, а примечание оператора не трогаем.
      if (productionProgramSystemNote(row.note)) next.note = '';
      moved += 1;
      dirty = true;
    } else {
      unresolved += 1;
      // Причина в примечании — обновляем, только если там наш служебный текст:
      // написанное оператором руками не затираем.
      const note = problem.blocking ? problem.text : PRODUCTION_PROGRAM_NO_CONTRACT_NUMBER_NOTE;
      if (productionProgramSystemNote(row.note) && row.note !== note) {
        next.note = note;
        dirty = true;
      }
    }
    if (dirty) updates.set(rowId, { next, moved: canMove });
  }

  if (updates.size === 0) {
    return { rows: [...(input.rows ?? [])], changed: false, moved: 0, unresolved };
  }

  // Переехавшие строки встают рядом со своей группой — план читается по порядку.
  const kept: T[] = [];
  const movedRows: Array<{ row: T; groupKey: string; placed: boolean }> = [];
  for (const row of input.rows ?? []) {
    const update = updates.get(String(row.id ?? ''));
    if (!update) {
      kept.push(row);
      continue;
    }
    if (update.moved) {
      movedRows.push({ row: update.next, groupKey: productionProgramGroupKey(update.next), placed: false });
    } else {
      kept.push(update.next);
    }
  }
  const out: T[] = [];
  for (const row of kept) {
    out.push(row);
    const key = productionProgramGroupKey(row);
    for (const m of movedRows) {
      if (!m.placed && m.groupKey === key) {
        m.placed = true;
        out.push(m.row);
      }
    }
  }
  for (const m of movedRows) {
    if (!m.placed) out.push(m.row);
  }

  return { rows: out, changed: true, moved, unresolved };
}
