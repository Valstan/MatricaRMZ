// Платежи по двигателям контракта (план engine-payments-2026-07).
// Единственный источник истины — контрактный EAV-атрибут `contract_payments` (JSON):
// слоты (по одному на планируемый двигатель секции) с платежами. Карточка двигателя
// читает/пишет через контракт (`contract_id`), пустые слоты — деньги без двигателя.
// Никакого DDL: едет существующим EAV-sync.

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
    const sectionKey = String(rec.sectionKey ?? '').trim();
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
 * — по каждой (секция, марка) доводит число слотов до плановой qty;
 * — лишние ПУСТЫЕ слоты (без платежей и двигателя) убирает; слоты с деньгами/двигателем — никогда;
 * — сеет contractPriceKop из unitPrice, если цена слота не задана вручную;
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

  // 1. Слоты по плану.
  for (const plan of planned) {
    const matching = slots.filter((s) => s.sectionKey === plan.sectionKey && s.engineBrandId === plan.engineBrandId);
    const priceKop = Math.round(plan.unitPrice * 100);
    for (const s of matching) {
      if (s.contractPriceKop == null && priceKop > 0) s.contractPriceKop = priceKop;
    }
    if (matching.length < plan.qty) {
      for (let i = matching.length; i < plan.qty; i += 1) {
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
    const brandMatched = a.engineBrandId ? free.filter((s) => s.engineBrandId === a.engineBrandId) : free;
    const pool = brandMatched.length > 0 ? brandMatched : free;
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
 * Равномерно распределить сумму по первым `slotCount` слотам секции
 * (по умолчанию — по всем). Остаток копеек — первому слоту.
 * Каждый созданный платёж — стартовый для отсчёта, если стартового у слота ещё нет.
 */
export function distributeAmount(
  cp: ContractPayments,
  sectionKey: string,
  amountKop: number,
  kind: PaymentKind,
  date: string,
  newId: () => string,
  slotCount?: number,
): ContractPayments {
  const sectionSlots = cp.slots.filter((s) => s.sectionKey === sectionKey);
  const targets = slotCount != null && slotCount > 0 ? sectionSlots.slice(0, slotCount) : sectionSlots;
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
    const row: PaymentRow = {
      id: newId(),
      date,
      amountKop: amount,
      kind,
      ...(!hasStart && (kind === 'advance' || kind === 'extra_advance') ? { countdownStart: true } : {}),
    };
    return { ...s, payments: [...s.payments, row] };
  });
  return { version: 1, slots };
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
