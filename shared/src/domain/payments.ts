// Платежи по двигателям контракта (план engine-payments-2026-07).
// Единственный источник истины — контрактный EAV-атрибут `contract_payments` (JSON):
// слоты (по одному на планируемый двигатель секции) с платежами. Карточка двигателя
// читает/пишет через контракт (`contract_id`), пустые слоты — деньги без двигателя.
// Никакого DDL: едет существующим EAV-sync.

import { canonicalContractSectionKey } from './contract.js';

export const CONTRACT_PAYMENTS_ATTR_CODE = 'contract_payments';

/** Срок ремонта с даты стартового аванса, дней. */
export const REPAIR_COUNTDOWN_DAYS = 90;
/** Порог «жёлтой» подсветки: прошло больше половины срока. */
export const COUNTDOWN_WARNING_ELAPSED_DAYS = 45;
/** Порог «красной» подсветки: осталось не больше стольких дней (или просрочка). */
export const COUNTDOWN_DANGER_LEFT_DAYS = 20;

export type PaymentKind = 'contract_price' | 'advance' | 'extra_advance' | 'final';

export const PAYMENT_KINDS: PaymentKind[] = ['contract_price', 'advance', 'extra_advance', 'final'];

export const PAYMENT_KIND_LABELS: Record<PaymentKind, string> = {
  contract_price: 'Стоимость по контракту',
  advance: 'Аванс',
  extra_advance: 'Доаванс',
  final: 'Окончательный расчёт',
};

export type PaymentRow = {
  id: string;
  /** ISO-дата платежа (yyyy-mm-dd) — когда оплата получена заводом. */
  date: string;
  /** Сумма в копейках (целое) — без float-дрейфа. */
  amountKop: number;
  kind: PaymentKind;
  note?: string;
  /** Старт отсчёта 90 дней на ремонт. Не больше одного на слот. */
  countdownStart?: boolean;
};

export type PaymentSlot = {
  /** Стабильный uuid слота — платежи привязаны к слоту, не к двигателю. */
  id: string;
  /** 'primary' | 'ДС {seq}' — совпадает с contract_section_number двигателя. */
  sectionKey: string;
  engineBrandId?: string;
  /** Заполняется при привязке двигателя; пусто = слот без двигателя. */
  engineId?: string;
  /** Стоимость двигателя по контракту, копейки (по умолчанию из unitPrice плана). */
  contractPriceKop?: number;
  payments: PaymentRow[];
};

export type ContractPayments = {
  version: 1;
  slots: PaymentSlot[];
};

export function emptyContractPayments(): ContractPayments {
  return { version: 1, slots: [] };
}

function asFiniteInt(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function isPaymentKind(v: unknown): v is PaymentKind {
  return v === 'contract_price' || v === 'advance' || v === 'extra_advance' || v === 'final';
}

/** Толерантный парс value_json: мусор и неполные строки отбрасываются, не роняя карточку. */
export function parseContractPayments(raw: unknown): ContractPayments {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return emptyContractPayments();
    }
  }
  if (!value || typeof value !== 'object') return emptyContractPayments();
  const slotsRaw = (value as { slots?: unknown }).slots;
  if (!Array.isArray(slotsRaw)) return emptyContractPayments();
  const slots: PaymentSlot[] = [];
  for (const s of slotsRaw) {
    if (!s || typeof s !== 'object') continue;
    const rec = s as Record<string, unknown>;
    const id = String(rec.id ?? '').trim();
    // Канонизация на чтении покрывает все места разом: в старых записях ключом
    // основного договора служил его номер, а после чьей-то правки номера — уже
    // осиротевшая строка. И то, и другое означает одну и ту же единственную секцию.
    const sectionKey = canonicalContractSectionKey(rec.sectionKey as string | null | undefined);
    if (!id || !sectionKey) continue;
    const payments: PaymentRow[] = [];
    if (Array.isArray(rec.payments)) {
      for (const p of rec.payments) {
        if (!p || typeof p !== 'object') continue;
        const pr = p as Record<string, unknown>;
        const pid = String(pr.id ?? '').trim();
        const date = String(pr.date ?? '').trim();
        const amountKop = asFiniteInt(pr.amountKop);
        if (!pid || amountKop == null || !isPaymentKind(pr.kind)) continue;
        payments.push({
          id: pid,
          date,
          amountKop,
          kind: pr.kind,
          ...(typeof pr.note === 'string' && pr.note.trim() ? { note: pr.note } : {}),
          ...(pr.countdownStart === true ? { countdownStart: true } : {}),
        });
      }
    }
    const engineBrandId = String(rec.engineBrandId ?? '').trim();
    const engineId = String(rec.engineId ?? '').trim();
    const contractPriceKop = asFiniteInt(rec.contractPriceKop);
    slots.push({
      id,
      sectionKey,
      ...(engineBrandId ? { engineBrandId } : {}),
      ...(engineId ? { engineId } : {}),
      ...(contractPriceKop != null ? { contractPriceKop } : {}),
      payments,
    });
  }
  return { version: 1, slots };
}

/** Лейбл строки платежа с нумерацией доавансов («Доаванс №2»). */
export function paymentRowLabel(slot: PaymentSlot, row: PaymentRow): string {
  if (row.kind !== 'extra_advance') return PAYMENT_KIND_LABELS[row.kind];
  const extras = slot.payments.filter((p) => p.kind === 'extra_advance');
  if (extras.length <= 1) return PAYMENT_KIND_LABELS.extra_advance;
  const idx = extras.findIndex((p) => p.id === row.id);
  return `${PAYMENT_KIND_LABELS.extra_advance} №${idx + 1}`;
}

export type SlotTotals = {
  /** Оплачено всего (все виды платежей, кроме строк «стоимость по контракту»). */
  paidKop: number;
  /** Стоимость по контракту (contractPriceKop, fallback — строки kind=contract_price). */
  priceKop: number;
  /** paid − price: >0 переплата, <0 недоплата. */
  deltaKop: number;
  lastPaymentDate?: string;
  firstAdvanceDate?: string;
  /** Дата старта отсчёта: флаг countdownStart, иначе самый ранний аванс/доаванс. */
  countdownStartDate?: string;
};

function isPaid(row: PaymentRow): boolean {
  return row.kind !== 'contract_price';
}

export function slotTotals(slot: PaymentSlot): SlotTotals {
  const paidRows = slot.payments.filter(isPaid);
  const paidKop = paidRows.reduce((s, p) => s + p.amountKop, 0);
  const priceFromRows = slot.payments
    .filter((p) => p.kind === 'contract_price')
    .reduce((s, p) => s + p.amountKop, 0);
  const priceKop = slot.contractPriceKop ?? priceFromRows;
  const datedPaid = paidRows.filter((p) => p.date);
  const lastPaymentDate = datedPaid.map((p) => p.date).sort().at(-1);
  const advances = slot.payments.filter((p) => (p.kind === 'advance' || p.kind === 'extra_advance') && p.date);
  const firstAdvanceDate = advances.map((p) => p.date).sort()[0];
  const flagged = slot.payments.find((p) => p.countdownStart && p.date);
  const countdownStartDate = flagged?.date ?? firstAdvanceDate;
  return {
    paidKop,
    priceKop,
    deltaKop: paidKop - priceKop,
    ...(lastPaymentDate ? { lastPaymentDate } : {}),
    ...(firstAdvanceDate ? { firstAdvanceDate } : {}),
    ...(countdownStartDate ? { countdownStartDate } : {}),
  };
}

export type CountdownState = 'none' | 'ok' | 'warning' | 'danger';

export type CountdownStatus = {
  state: CountdownState;
  daysElapsed?: number;
  daysLeft?: number;
};

function daysBetweenIso(fromIso: string, toIso: string): number | null {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.floor((to - from) / 86_400_000);
}

/**
 * Статус отсчёта 90 дней ремонта. Гасится фактом ремонта двигателя
 * (`engineRepaired`), не оплатой — решение владельца 2026-07-29.
 */
export function countdownStatus(slot: PaymentSlot, todayIso: string, engineRepaired: boolean): CountdownStatus {
  if (engineRepaired) return { state: 'none' };
  const { countdownStartDate } = slotTotals(slot);
  if (!countdownStartDate) return { state: 'none' };
  const daysElapsed = daysBetweenIso(countdownStartDate, todayIso);
  if (daysElapsed == null || daysElapsed < 0) return { state: 'none' };
  const daysLeft = REPAIR_COUNTDOWN_DAYS - daysElapsed;
  const state: CountdownState =
    daysLeft <= COUNTDOWN_DANGER_LEFT_DAYS ? 'danger'
    : daysElapsed > COUNTDOWN_WARNING_ELAPSED_DAYS ? 'warning'
    : 'ok';
  return { state, daysElapsed, daysLeft };
}

export function findSlotForEngine(cp: ContractPayments, engineId: string): PaymentSlot | undefined {
  return cp.slots.find((s) => s.engineId === engineId);
}

export type AttachedEngineRef = {
  engineId: string;
  /** 'primary' | 'ДС {seq}' из contract_section_number двигателя. */
  sectionKey: string;
  engineBrandId?: string;
};

export type PlannedSectionBrand = {
  sectionKey: string;
  engineBrandId: string;
  qty: number;
  /** Цена за двигатель, рубли (как в contract_sections). */
  unitPrice: number;
};

/**
 * Сверка слотов с планом контракта и привязанными двигателями. Идемпотентна.
 * — по каждой (секция, марка) доводит число слотов до плановой qty, где qty —
 *   СУММА по всем строкам плана этой марки (в секции легально несколько строк одной
 *   марки с разными ценами: «10 шт по A + 5 шт по B»);
 * — лишние ПУСТЫЕ слоты (без платежей и двигателя) убирает; слоты с деньгами/двигателем — никогда;
 * — сеет contractPriceKop из unitPrice ПОЗИЦИОННО по строкам плана (первые qty₁ слотов
 *   получают цену первой строки, следующие qty₂ — второй, …), если цена слота не задана;
 * — привязывает двигатели к свободным слотам секции (сначала слоты с платежами — деньги
 *   «встречают» приехавший двигатель), отвязывает уехавшие (платежи остаются на слоте).
 */
export function syncSlotsWithPlan(
  cp: ContractPayments,
  planned: PlannedSectionBrand[],
  attached: AttachedEngineRef[],
  newId: () => string,
): ContractPayments {
  const slots = cp.slots.map((s) => ({ ...s, payments: [...s.payments] }));

  // 1. Слоты по плану. Строки агрегируются по (секция, марка): раньше вторая строка
  // той же марки не суммировала qty, а «подгоняла» число слотов под своё — слоты
  // оставались только по последней строке (баг «слоты под последнюю марку»).
  const groups = new Map<string, { sectionKey: string; engineBrandId: string; qty: number; pricesKop: number[] }>();
  for (const plan of planned) {
    const key = `${plan.sectionKey} ${plan.engineBrandId}`;
    const g = groups.get(key) ?? { sectionKey: plan.sectionKey, engineBrandId: plan.engineBrandId, qty: 0, pricesKop: [] };
    const priceKop = Math.round(plan.unitPrice * 100);
    for (let i = 0; i < plan.qty; i += 1) g.pricesKop.push(priceKop);
    g.qty += plan.qty;
    groups.set(key, g);
  }
  for (const plan of groups.values()) {
    const matching = slots.filter((s) => s.sectionKey === plan.sectionKey && s.engineBrandId === plan.engineBrandId);
    // Позиционные цены: слот №i группы ← цена строки, «владеющей» позицией i.
    matching.forEach((s, idx) => {
      const priceKop = plan.pricesKop[idx] ?? 0;
      if (s.contractPriceKop == null && priceKop > 0) s.contractPriceKop = priceKop;
    });
    if (matching.length < plan.qty) {
      for (let i = matching.length; i < plan.qty; i += 1) {
        const priceKop = plan.pricesKop[i] ?? 0;
        slots.push({
          id: newId(),
          sectionKey: plan.sectionKey,
          engineBrandId: plan.engineBrandId,
          ...(priceKop > 0 ? { contractPriceKop: priceKop } : {}),
          payments: [],
        });
      }
    } else if (matching.length > plan.qty) {
      let excess = matching.length - plan.qty;
      for (let i = slots.length - 1; i >= 0 && excess > 0; i -= 1) {
        const s = slots[i]!;
        if (s.sectionKey !== plan.sectionKey || s.engineBrandId !== plan.engineBrandId) continue;
        if (s.engineId || s.payments.length > 0) continue;
        slots.splice(i, 1);
        excess -= 1;
      }
    }
  }

  // 2. Отвязка уехавших двигателей (двигатель сменил секцию/контракт — деньги остаются).
  const attachedBySection = new Map<string, string>();
  for (const a of attached) attachedBySection.set(a.engineId, a.sectionKey);
  for (const s of slots) {
    if (s.engineId && attachedBySection.get(s.engineId) !== s.sectionKey) {
      delete (s as { engineId?: string }).engineId;
    }
  }

  // 3. Привязка новых двигателей к свободным слотам.
  const bound = new Set(slots.filter((s) => s.engineId).map((s) => s.engineId as string));
  for (const a of attached) {
    if (bound.has(a.engineId)) continue;
    const free = slots.filter((s) => s.sectionKey === a.sectionKey && !s.engineId);
    // Двигатель с известной маркой садится ТОЛЬКО на слот своей марки. Раньше при
    // отсутствии такого слота он молча занимал чужое плановое место — и аванс, выписанный
    // под другую марку, доставался не тому двигателю. Нет своего слота → заводим сверх
    // плана (ветка ниже). Марка не указана — сверять нечем, берём любой свободный.
    const pool = a.engineBrandId ? free.filter((s) => s.engineBrandId === a.engineBrandId) : free;
    const target = pool.find((s) => s.payments.length > 0) ?? pool[0];
    if (!target) {
      // Двигателей больше плана — заводим слот сверх плана, деньги на него лягут позже.
      slots.push({
        id: newId(),
        sectionKey: a.sectionKey,
        ...(a.engineBrandId ? { engineBrandId: a.engineBrandId } : {}),
        engineId: a.engineId,
        payments: [],
      });
    } else {
      target.engineId = a.engineId;
    }
    bound.add(a.engineId);
  }

  return { version: 1, slots };
}

/**
 * Разнести сумму по ЯВНО выбранным слотам (галочки в карточке контракта).
 *
 * Legacy `distributeAmount` («первые N слотов секции в порядке массива») снесена 2026-08-08:
 * в приложении не вызывалась, а её семантика — источник жалобы владельца «любой аванс
 * ложится с 1-го по N-й». Здесь цели заданы списком `slotIds` — секция не при чём,
 * можно смешивать марки и ДС.
 *
 * Остаток копеек — первому слоту в порядке `cp.slots` (а не в порядке `slotIds`), чтобы
 * повторный вызов с той же выборкой дал тот же результат независимо от порядка кликов.
 */
export function distributeAmountToSlots(
  cp: ContractPayments,
  slotIds: readonly string[],
  amountKop: number,
  kind: PaymentKind,
  date: string,
  newId: () => string,
  note?: string,
): ContractPayments {
  const wanted = new Set(slotIds);
  const targets = cp.slots.filter((s) => wanted.has(s.id));
  if (targets.length === 0 || !Number.isFinite(amountKop) || amountKop <= 0) return cp;
  const per = Math.floor(amountKop / targets.length);
  const remainder = amountKop - per * targets.length;
  const targetIds = new Set(targets.map((s) => s.id));
  let first = true;
  const slots = cp.slots.map((s) => {
    if (!targetIds.has(s.id)) return s;
    const amount = per + (first ? remainder : 0);
    first = false;
    const hasStart = s.payments.some((p) => p.countdownStart);
    const startsCountdown = !hasStart && (kind === 'advance' || kind === 'extra_advance');
    const row: PaymentRow = {
      id: newId(),
      date,
      amountKop: amount,
      kind,
      ...(note?.trim() ? { note: note.trim() } : {}),
      ...(startsCountdown ? { countdownStart: true } : {}),
    };
    // В отличие от distributeAmount прогоняем нормализацию флагов: слот, уже испорченный
    // двумя стартовыми платежами, чинится, а не только «не портится дальше».
    return { ...s, payments: normalizeCountdownFlags([...s.payments, row], startsCountdown ? row.id : undefined) };
  });
  return { version: 1, slots };
}

/** Куда сядет двигатель при привязке к контракту. */
export type EngineSlotPlacement = {
  /** Токен секции для `contract_section_number` двигателя. */
  sectionKey: string;
  /** Свободный слот своей марки, если нашёлся. */
  slotId?: string;
  /**
   * Плановых мест под эту марку не осталось — слот придётся завести сверх плана.
   * Оператору об этом говорим вслух: это либо ошибка марки в карточке двигателя,
   * либо недобитый план контракта, и молча решать за него нельзя.
   */
  overPlan: boolean;
};

/**
 * Выбрать слот под двигатель по его МАРКЕ. Порядок: предпочтённая секция (выбранная
 * оператором), затем остальные в переданном порядке — primary, потом ДС.
 *
 * Двигатель с известной маркой рассматривает только слоты этой марки; без марки —
 * любой свободный (сверять нечем).
 */
export function planSlotForEngine(args: {
  cp: ContractPayments;
  /** Токены секций контракта в порядке предпочтения: primary, затем ДС по возрастанию seq. */
  sectionKeys: readonly string[];
  engineBrandId?: string;
  /** Секция, уже выбранная оператором в карточке двигателя. */
  preferredSectionKey?: string;
}): EngineSlotPlacement {
  const preferred = String(args.preferredSectionKey ?? '').trim();
  const order = [
    ...(preferred ? [preferred] : []),
    ...args.sectionKeys.filter((key) => key !== preferred),
  ];
  for (const sectionKey of order) {
    const free = args.cp.slots.filter((s) => s.sectionKey === sectionKey && !s.engineId);
    const pool = args.engineBrandId ? free.filter((s) => s.engineBrandId === args.engineBrandId) : free;
    // Слот с уже лежащими деньгами берём первым: аванс «встречает» приехавший двигатель.
    const target = pool.find((s) => s.payments.length > 0) ?? pool[0];
    if (target) return { sectionKey, slotId: target.id, overPlan: false };
  }
  return { sectionKey: order[0] ?? '', overPlan: true };
}

/** Посадить двигатель в выбранный слот (или завести слот сверх плана). Иммутабельно. */
export function attachEngineToSlot(
  cp: ContractPayments,
  placement: EngineSlotPlacement,
  engineId: string,
  newId: () => string,
  engineBrandId?: string,
): ContractPayments {
  // Двигатель не может занимать два слота сразу: снимаем прежнюю привязку, деньги
  // остаются на старом слоте («деньги без двигателя») — как и при смене секции.
  const cleared = cp.slots.map((s) => {
    if (s.engineId !== engineId) return s;
    const { engineId: _drop, ...rest } = s;
    return rest;
  });
  if (placement.slotId) {
    return {
      version: 1,
      slots: cleared.map((s) => (s.id === placement.slotId ? { ...s, engineId } : s)),
    };
  }
  return {
    version: 1,
    slots: [
      ...cleared,
      {
        id: newId(),
        sectionKey: placement.sectionKey,
        ...(engineBrandId ? { engineBrandId } : {}),
        engineId,
        payments: [],
      },
    ],
  };
}

function withSlot(cp: ContractPayments, slotId: string, fn: (slot: PaymentSlot) => PaymentSlot): ContractPayments {
  return { version: 1, slots: cp.slots.map((s) => (s.id === slotId ? fn(s) : s)) };
}

function normalizeCountdownFlags(payments: PaymentRow[], keepId?: string): PaymentRow[] {
  // Не больше одного стартового флага: выигрывает keepId (последняя правка пользователя).
  let seen = false;
  return payments.map((p) => {
    if (!p.countdownStart) return p;
    if (keepId != null && p.id !== keepId) {
      const { countdownStart: _drop, ...rest } = p;
      return rest;
    }
    if (seen) {
      const { countdownStart: _drop, ...rest } = p;
      return rest;
    }
    seen = true;
    return p;
  });
}

export function addPayment(cp: ContractPayments, slotId: string, row: PaymentRow): ContractPayments {
  return withSlot(cp, slotId, (s) => ({
    ...s,
    payments: normalizeCountdownFlags([...s.payments, row], row.countdownStart ? row.id : undefined),
  }));
}

export function updatePayment(cp: ContractPayments, slotId: string, row: PaymentRow): ContractPayments {
  return withSlot(cp, slotId, (s) => ({
    ...s,
    payments: normalizeCountdownFlags(
      s.payments.map((p) => (p.id === row.id ? row : p)),
      row.countdownStart ? row.id : undefined,
    ),
  }));
}

export function removePayment(cp: ContractPayments, slotId: string, paymentId: string): ContractPayments {
  return withSlot(cp, slotId, (s) => ({ ...s, payments: s.payments.filter((p) => p.id !== paymentId) }));
}

/**
 * «Отремонтирован» для гашения отсчёта: сам ремонт или любой терминальный исход
 * (отгружен / принят заказчиком / утиль отправлен) — двигатель больше не «горит».
 */
export function isEngineRepairedForCountdown(flags: Partial<Record<string, boolean>> | null | undefined): boolean {
  if (!flags) return false;
  return Boolean(
    flags.status_repaired || flags.status_customer_sent || flags.status_customer_accepted || flags.status_rework_sent,
  );
}

/** Число «горящих» (danger) двигателей контракта — для колонки в списке контрактов. */
export function burningEnginesCount(cp: ContractPayments, todayIso: string, repairedEngineIds: ReadonlySet<string>): number {
  return cp.slots.filter((s) => {
    const repaired = s.engineId != null && repairedEngineIds.has(s.engineId);
    return countdownStatus(s, todayIso, repaired).state === 'danger';
  }).length;
}

/** Копейки → «1 234 567,89». Для UI и отчётов — единый формат. */
export function formatKopMoney(kop: number): string {
  const sign = kop < 0 ? '−' : '';
  const abs = Math.abs(Math.round(kop));
  const rub = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  const rubStr = String(rub).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${rubStr},${rest}`;
}

/** «1 234 567,89» / «1234567.89» → копейки (null при мусоре). */
export function parseMoneyToKop(input: string): number | null {
  const cleaned = input.replace(/[\s\u00A0\u202F]/g, '').replace(',', '.');
  if (!cleaned || !/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

/** Исходящие ссылки contract_payments (engineId слотов) — зеркало для реверс-индекса удаления. */
export function collectContractPaymentsEngineIds(cp: ContractPayments): Array<{ path: string; engineId: string }> {
  const result: Array<{ path: string; engineId: string }> = [];
  // engineBrandId тоже ссылка, но реверс-индекс марок уже закрыт contract_sections.
  for (const [index, slot] of cp.slots.entries()) {
    if (slot.engineId) result.push({ path: `slots[${index}].engineId`, engineId: slot.engineId });
  }
  return result;
}
