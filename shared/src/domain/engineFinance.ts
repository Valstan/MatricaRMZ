// Финансовая сводка по двигателям договора (промты КАРМАНА #18/#19).
//
// ЗАЧЕМ. Владелец вёл такую таблицу руками в Excel («АУДИТ по цене»): по строке —
// двигатель, по столбцам — цена по договору, аванс, долг, состояние и итог по разделам.
// В программе эти данные уже есть, но размазаны по трём местам: план (марка, количество,
// цена), платежи (аванс/доаванс/ок-расчёт) и карточка двигателя (номер, марка, статус).
// Сводка собирает их в одну таблицу — «сколько кто должен и за что».
//
// СЧИТАЕТСЯ ЧИСТО: функция ничего не меняет и ничего не знает про интерфейс. Секции,
// суммы и статусы приходят аргументами — иначе таблица «разъехалась бы» с реальными
// деньгами при первом же расхождении копий.

import { canonicalContractSectionKey, PRIMARY_CONTRACT_SECTION_KEY } from './contract.js';
import { countdownStatus, slotTotals, type ContractPayments, type PaymentSlot } from './payments.js';
import { isEngineDoneForCountdown } from './payments.js';

/** Двигатель в сводке — всё, что нужно для строки. */
export type EngineFinanceEngine = {
  id: string;
  engineNumber?: string;
  engineBrand?: string;
  engineBrandId?: string;
  /** Токен раздела двигателя; '' — раздела нет. */
  contractSectionNumber?: string;
  statusFlags?: Partial<Record<string, boolean>>;
  arrivalDate?: number | null;
  /**
   * Дата последней работы по двигателю (ms) — без неё порог «забытых карточек» молчит
   * и отсчёт снова показывает все красные двигатели (сторож CountdownStale).
   */
  lastActivityAt?: number | null;
};

export type EngineFinanceRow = {
  /** id двигателя; у свободного места — id места (префикс 'slot:'). */
  key: string;
  engineId?: string;
  slotId?: string;
  sectionKey: string;
  engineNumber: string;
  brandLabel: string;
  /** Цена по контракту, копейки. */
  priceKop: number;
  /** Цена по плану (для движка без места) — по плану, не по месту. */
  priceFromPlan: boolean;
  /** Расчётный аванс по проценту от цены, копейки. */
  plannedAdvanceKop: number;
  /** Внесено авансов и доавансов, копейки. */
  paidAdvanceKop: number;
  /** Внесено окончательного расчёта, копейки. */
  paidFinalKop: number;
  /** Долг: цена минус всё внесённое, копейки. */
  dueKop: number;
  /** Состояние двигателя (текст). */
  statusLabel: string;
  /** Отсчёт ремонта (текст) — пусто, если отсчёта нет. */
  countdownLabel: string;
  /** Место плановое, двигатель не пришёл. */
  emptySlot: boolean;
  /** Движок есть, а места нет — деньги по нему не распределены. */
  noSlot: boolean;
};

export type EngineFinanceTotals = {
  count: number;
  priceKop: number;
  plannedAdvanceKop: number;
  paidAdvanceKop: number;
  paidFinalKop: number;
  dueKop: number;
};

export type EngineFinanceSection = {
  sectionKey: string;
  /** Подпись раздела: номер/дата заклюшения (для ДС) или «Основной договор». */
  label: string;
  rows: EngineFinanceRow[];
  totals: EngineFinanceTotals;
};

export type EngineFinanceTable = {
  sections: EngineFinanceSection[];
  totals: EngineFinanceTotals;
};

/** План договора: сколько мест под марку и по какой цене. */
export type EngineFinancePlanRow = {
  sectionKey: string;
  engineBrandId: string;
  qty: number;
  unitPrice: number;
};

const STATUS_LABELS_LOCAL = {
  status_rejected: 'Забракован',
  status_rework_sent: 'Отправлен заказчику на перекомплектацию',
  status_scrap_confirmed: 'Признан утильным',
  status_customer_accepted: 'Принято заказчиком',
  status_customer_sent: 'Отправлен заказчику',
  status_repaired: 'Отремонтирован',
  status_repair_started: 'Начат ремонт',
  status_storage_received: 'Принят на хранение',
} as const;

/**
 * Состояние двигателя для сводки. Порядок тот же, что и в карточке контракта:
 * терминальные исходы (утиль, забракован, принят заказчиком) важнее промежуточных.
 */
export function engineFinanceStatusLabel(engine: {
  statusFlags?: Partial<Record<string, boolean>>;
  arrivalDate?: number | null;
}): string {
  const flags = engine.statusFlags ?? {};
  if (flags.status_rejected) return STATUS_LABELS_LOCAL.status_rejected;
  if (flags.status_rework_sent) return STATUS_LABELS_LOCAL.status_rework_sent;
  if (flags.status_scrap_confirmed) return STATUS_LABELS_LOCAL.status_scrap_confirmed;
  if (flags.status_customer_accepted) return STATUS_LABELS_LOCAL.status_customer_accepted;
  if (flags.status_customer_sent) return STATUS_LABELS_LOCAL.status_customer_sent;
  if (flags.status_repaired) return STATUS_LABELS_LOCAL.status_repaired;
  if (flags.status_repair_started) return STATUS_LABELS_LOCAL.status_repair_started;
  if (flags.status_storage_received || engine.arrivalDate) return 'Приход на завод';
  return '—';
}

function sumPayments(slot: PaymentSlot, kinds: readonly string[]): number {
  return slot.payments.filter((p) => kinds.includes(p.kind)).reduce((s, p) => s + p.amountKop, 0);
}

function emptyTotals(): EngineFinanceTotals {
  return { count: 0, priceKop: 0, plannedAdvanceKop: 0, paidAdvanceKop: 0, paidFinalKop: 0, dueKop: 0 };
}

function addRow(totals: EngineFinanceTotals, row: EngineFinanceRow): void {
  totals.count += 1;
  totals.priceKop += row.priceKop;
  totals.plannedAdvanceKop += row.plannedAdvanceKop;
  totals.paidAdvanceKop += row.paidAdvanceKop;
  totals.paidFinalKop += row.paidFinalKop;
  totals.dueKop += row.dueKop;
}

function isoDay(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(Number(ms)) || Number(ms) <= 0) return '';
  const d = new Date(Number(ms));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Собрать сводку «кто сколько должен» по двигателям договора.
 *
 * Строки — двигатели договора (с местом или без) плюс плановые места, куда движок
 * ещё не пришёл: оператор должен видеть и «кто пришёл и делается», и «кого ждём».
 * Итоги — по разделам (основной договор и каждое ДС) и общий: это и есть ответ на
 * «сколь куда за что должен».
 */
export function buildEngineFinanceTable(args: {
  /** Платежи договора (места и деньги). */
  contractPayments: ContractPayments;
  /** Двигатели договора. */
  engines: readonly EngineFinanceEngine[];
  /** План договора по разделам и маркам — для цены места, которому движок ещё не достался. */
  plan?: readonly EngineFinancePlanRow[];
  /** Подпись раздела по ключу (номер/дата заключения). */
  sectionLabels?: ReadonlyMap<string, string>;
  /** Процент аванса для расчётной колонки (владельца — 50%). */
  advancePercent?: number;
  /** Дата «сегодня» (ISO) — для отсчёта ремонта. */
  todayIso?: string;
  /** Срок ремонта по договору, дней. */
  repairDays?: number;
}): EngineFinanceTable {
  const percent = Number.isFinite(args.advancePercent ?? 50) ? (args.advancePercent ?? 50) : 50;
  const today = args.todayIso ?? '';
  const slotByEngine = new Map<string, PaymentSlot>();
  for (const slot of args.contractPayments.slots) {
    if (slot.engineId) slotByEngine.set(slot.engineId, slot);
  }

  // Цена по плану для марки: если марка запланирована в одном разделе — берём её цену
  // и раздел (движок без места, но марка известна). Если в нескольких — цену не угадываем.
  const planPriceByBrand = new Map<string, { priceKop: number; sectionKey: string; sections: Set<string> }>();
  for (const p of args.plan ?? []) {
    if (!p.engineBrandId) continue;
    const priceKop = Math.round(p.unitPrice * 100);
    const known = planPriceByBrand.get(p.engineBrandId);
    if (!known) {
      planPriceByBrand.set(p.engineBrandId, { priceKop, sectionKey: p.sectionKey, sections: new Set([p.sectionKey]) });
      continue;
    }
    known.sections.add(p.sectionKey);
    if (known.priceKop !== priceKop) known.priceKop = 0; // цены разные — угадывать нельзя
  }

  const rowsBySection = new Map<string, EngineFinanceRow[]>();
  const push = (sectionKey: string, row: EngineFinanceRow) => {
    const list = rowsBySection.get(sectionKey) ?? [];
    list.push(row);
    rowsBySection.set(sectionKey, list);
  };

  // 1. Двигатели договора.
  const seenSlotIds = new Set<string>();
  for (const engine of args.engines) {
    const slot = slotByEngine.get(engine.id);
    const totals = slot ? slotTotals(slot) : null;
    const priceKop = slot ? (totals?.priceKop ?? 0) : 0;
    const plannedFromPlan = slot ? null : planPriceByBrand.get(engine.engineBrandId ?? '');
    const effectivePrice = slot ? priceKop : plannedFromPlan && plannedFromPlan.sections.size === 1 ? plannedFromPlan.priceKop : 0;
    const paidAdvance = slot ? sumPayments(slot, ['advance', 'extra_advance']) : 0;
    const paidFinal = slot ? sumPayments(slot, ['final']) : 0;
    const sectionKey = slot?.sectionKey ?? canonicalContractSectionKey(engine.contractSectionNumber);
    const repaired = isEngineDoneForCountdown({
      ...(engine.statusFlags ? { statusFlags: engine.statusFlags } : {}),
    });
    const arrivalIso = isoDay(engine.arrivalDate);
    const lastActivityIso = isoDay(engine.lastActivityAt);
    const cd = slot
      ? countdownStatus(slot, today, repaired, {
        ...(arrivalIso ? { arrivalIso } : {}),
        ...(lastActivityIso ? { lastActivityIso } : {}),
        ...(args.repairDays != null ? { days: args.repairDays } : {}),
      })
      : null;
    const countdownLabel = !slot
      ? ''
      : cd?.state === 'none'
        ? repaired
          ? 'отремонтирован'
          : arrivalIso
            ? '—'
            : 'нет даты поступления'
        : cd?.state === 'stale'
          ? `без движения ${cd.daysIdle ?? 0} дн.`
          : (cd?.daysLeft ?? 0) < 0
            ? `просрочка ${Math.abs(cd?.daysLeft ?? 0)} дн.`
            : `осталось ${cd?.daysLeft ?? 0} дн.`;
    if (slot) seenSlotIds.add(slot.id);
    push(sectionKey, {
      key: engine.id,
      engineId: engine.id,
      ...(slot ? { slotId: slot.id } : {}),
      sectionKey,
      engineNumber: engine.engineNumber ?? '',
      brandLabel: engine.engineBrand ?? '',
      priceKop: effectivePrice,
      priceFromPlan: !slot && effectivePrice > 0,
      plannedAdvanceKop: Math.round((effectivePrice * percent) / 100),
      paidAdvanceKop: paidAdvance,
      paidFinalKop: paidFinal,
      dueKop: effectivePrice - paidAdvance - paidFinal,
      statusLabel: engineFinanceStatusLabel(engine),
      countdownLabel,
      emptySlot: false,
      noSlot: !slot,
    });
  }

  // 2. Плановые места без движка: их ждём (деньги по ним уже могут лежать).
  for (const slot of args.contractPayments.slots) {
    if (slot.engineId || seenSlotIds.has(slot.id)) continue;
    const totals = slotTotals(slot);
    const paidAdvance = sumPayments(slot, ['advance', 'extra_advance']);
    const paidFinal = sumPayments(slot, ['final']);
    push(slot.sectionKey, {
      key: `slot:${slot.id}`,
      slotId: slot.id,
      sectionKey: slot.sectionKey,
      engineNumber: '',
      brandLabel: '',
      priceKop: totals.priceKop,
      priceFromPlan: false,
      plannedAdvanceKop: Math.round((totals.priceKop * percent) / 100),
      paidAdvanceKop: paidAdvance,
      paidFinalKop: paidFinal,
      dueKop: totals.priceKop - paidAdvance - paidFinal,
      statusLabel: 'двигатель не пришёл',
      countdownLabel: '',
      emptySlot: true,
      noSlot: false,
    });
  }

  // 3. Разделы в порядке: основной договор, затем ДС по номеру.
  const sectionKeys = [...rowsBySection.keys()].sort((a, b) => {
    if (a === PRIMARY_CONTRACT_SECTION_KEY) return -1;
    if (b === PRIMARY_CONTRACT_SECTION_KEY) return 1;
    return a.localeCompare(b, 'ru', { numeric: true });
  });
  const sections: EngineFinanceSection[] = sectionKeys.map((sectionKey) => {
    const rows = (rowsBySection.get(sectionKey) ?? []).sort((a, b) => {
      if (a.emptySlot !== b.emptySlot) return a.emptySlot ? 1 : -1;
      return a.engineNumber.localeCompare(b.engineNumber, 'ru');
    });
    const totals = emptyTotals();
    for (const row of rows) addRow(totals, row);
    const label = args.sectionLabels?.get(sectionKey) ?? (sectionKey === PRIMARY_CONTRACT_SECTION_KEY ? 'Основной договор' : sectionKey);
    return { sectionKey, label, rows, totals };
  });

  const totals = emptyTotals();
  for (const section of sections) {
    totals.count += section.totals.count;
    totals.priceKop += section.totals.priceKop;
    totals.plannedAdvanceKop += section.totals.plannedAdvanceKop;
    totals.paidAdvanceKop += section.totals.paidAdvanceKop;
    totals.paidFinalKop += section.totals.paidFinalKop;
    totals.dueKop += section.totals.dueKop;
  }
  return { sections, totals };
}
