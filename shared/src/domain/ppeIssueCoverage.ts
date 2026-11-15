/**
 * Ведомость по выдаче СИЗ по сотрудникам и заявка на закупку по позициям.
 *
 * Один расчёт на все экраны: журнал, отчёт и печать берут одни и те же величины.
 * Иначе «невыданное» в ведомости и «к закупке» в заявке разъедутся — а это ровно
 * то, что и требовал владелец (промт КАРМАНА #23): нехватка по людям обязана
 * доходить до бумажки, которая уходит в фирму.
 *
 * Ключевое различение: **«не выдано» и «выдано частично» — разные вещи.**
 * Ведомость говорит, какая именно позиция не выдана (ботинок не хватило);
 * заявка превращает это в «заказать N шт такой-то позиции, такого-то размера».
 *
 * Формула заявки — `к закупке = потребность (нехватка) − остаток на складе`:
 *  - потребность в отчёте **уже за вычетом выданного** (это и есть нехватка);
 *  - выданное показано отдельной величиной и **дважды не вычитается**: выдача
 *    списывает склад (`ppeService.issuePpe` → документ `stock_issue` проводится
 *    сразу), поэтому «выданное» и «остаток» не пересекаются;
 *  - остаток, которого мы не знаем, **не вычитается**: где позиции нормы на
 *    складе нет, остаток — прочерк, а не ноль. Иначе заявка сказала бы «склад
 *    пуст» там, где он просто в другом слое номенклатур (мост «норма ↔ торговая
 *    позиция» — отдельная работа, промт #20/#25).
 */
import type { PpeIssueStatus } from './ppe.js';

/** Причина нехватки по позиции. */
export type PpeShortageReason = 'never_issued' | 'partial' | 'overdue' | 'returned' | 'none';

/** Человеческие названия причин — в ведомости и в заявке. */
export const PPE_SHORTAGE_REASON_RU: Record<PpeShortageReason, string> = {
  never_issued: 'не выдано',
  partial: 'выдано частично',
  overdue: 'пора перевыдать',
  returned: 'сдано',
  none: 'выдано',
};

/**
 * Позиция обеспечения: что по ней положено сотруднику и что с ней произошло.
 *
 * `positionId` — номенклатура позиции. Это может быть **база** («СИЗ-018») или
 * **размерный вариант** («СИЗ-018-44»): нормы приказа ссылаются на базу, а выдача
 * идёт по размеру, и сопоставлять их — работа вызывающего кода.
 */
export type PpeSupplyItem = {
  employeeId: string;
  /** Номенклатура позиции. */
  positionId: string;
  /** Название позиции. */
  name: string;
  /** Размер по этой позиции; `null` — размер неизвестен. */
  size: string | null;
  /** Номенклатура размерной позиции; `null` — размер не разрешён в справочнике. */
  sizeId: string | null;
  /** Количество на год по норме. */
  normQty: number;
  /** Выдано за период количества (год) по этой позиции. */
  issuedInPeriod: number;
  /** Выдано всего за историю по этой позиции. */
  issuedTotal: number;
  /** Состояние по сроку — из `nextIssueDates`, тот же расчёт, что в карточке. */
  status: PpeIssueStatus;
  /** Срок носки текстом (приказ или кладовщик). */
  wearText: string;
  /** Когда пора выдавать; `null` — срока нет. */
  nextDueAt: number | null;
};

/** Факт выдачи в разрезе размера — для «что именно выдано». */
export type PpeIssuedItem = {
  employeeId: string;
  /** Позиция, к которой отнесена выдача. */
  positionId: string;
  /** Название позиции. */
  name: string;
  /** Размер; `null` — размера нет. */
  size: string | null;
  /** Номенклатура фактически выданной позиции (может быть размерным вариантом). */
  sizeId: string | null;
  qty: number;
};

/**
 * Позиция нормы, к которой относится выдача.
 *
 * Нормы приказа ссылаются на базовую позицию, а кладовщик выдаёт конкретный
 * размер, поэтому правило сопоставления одно на все отчёты: точное совпадение
 * номенклатуры → база размера → «вне нормы» (выдано сверх нормы).
 */
export function ppeResolvePositionId(args: {
  /** Номенклатура выданной позиции. */
  nomenclatureId: string;
  /** Базовая номенклатура этой позиции; `null` — позиция сама база. */
  parentId: string | null;
  /** Номенклатуры позиций нормы сотрудника. */
  positionIds: ReadonlySet<string>;
}): string | null {
  if (args.positionIds.has(args.nomenclatureId)) return args.nomenclatureId;
  const parent = args.parentId;
  if (parent && args.positionIds.has(parent)) return parent;
  return null;
}

export type PpeShortage = {
  /** Сколько не хватает (единиц). */
  qty: number;
  reason: PpeShortageReason;
};

/**
 * Нехватка по позиции и её причина.
 *
 * Правила (в порядке строгости):
 *  - `neverIssued` — не выдавали ни разу: не хватает всей нормы. Это сценарий
 *    владельца: «ботинок не хватило» — значит «не выдана»;
 *  - `returned` — вещь сдали: у сотрудника её нет, нужна новая;
 *  - `overdue` — срок вышел: старая вещь кончилась, нужна новая;
 *  - `partial` — выдано за год меньше нормы: не хватает остатка нормы;
 *  - иначе нехватки нет.
 */
export function ppeShortage(item: PpeSupplyItem): PpeShortage {
  const norm = Math.max(0, Number(item.normQty) || 0);
  if (norm <= 0) return { qty: 0, reason: 'none' };
  if (item.status === 'neverIssued') return { qty: norm, reason: 'never_issued' };
  if (item.status === 'returned') return { qty: norm, reason: 'returned' };
  if (item.status === 'overdue') return { qty: norm, reason: 'overdue' };
  const issued = Math.max(0, Number(item.issuedInPeriod) || 0);
  if (issued < norm) return { qty: norm - issued, reason: 'partial' };
  return { qty: 0, reason: 'none' };
}

/** Подпись позиции с размером: «Жилет сигнальный повышенной видимости (р. 44)». */
export function ppePositionLabel(name: string, size: string | null): string {
  const title = String(name ?? '').trim();
  const raw = String(size ?? '').trim();
  if (!raw) return title || '—';
  const sizeText = /^\d/.test(raw) ? `р. ${raw}` : raw;
  return title ? `${title} (${sizeText})` : `(${sizeText})`;
}

export type PpeEmployeeIssueRow = {
  employeeId: string;
  fullName: string;
  personnelNo: string | null;
  postTitle: string | null;
  /** Что выдано: «Позиция (р. 48) × 1; Позиция (р. 42) × 2». */
  issuedText: string;
  /** Что не выдано: «Позиция (р. 44) — не выдано (1 шт)». */
  missingText: string;
  /** Позиций в норме. */
  positionsCount: number;
  /** Позиций с нехваткой. */
  missingCount: number;
  state: 'обеспечен' | 'не обеспечен' | 'нет норм';
};

/**
 * Ведомость по сотрудникам: одна строка на человека — фамилия и набор.
 *
 * Владелец просил не раздувать отчёт («мне не надо столько всего»): поэтому
 * деталей по срокам и процентам износа здесь нет, есть набор выданного и
 * перечень нехватки с причиной.
 */
export function buildPpeEmployeeIssueRows(args: {
  employees: Array<{
    employeeId: string;
    fullName: string;
    personnelNo?: string | null;
    postTitle?: string | null;
  }>;
  items: PpeSupplyItem[];
  issued: PpeIssuedItem[];
}): PpeEmployeeIssueRow[] {
  const itemsByEmployee = new Map<string, PpeSupplyItem[]>();
  for (const item of args.items) {
    const list = itemsByEmployee.get(item.employeeId) ?? [];
    list.push(item);
    itemsByEmployee.set(item.employeeId, list);
  }
  const issuedByEmployee = new Map<string, PpeIssuedItem[]>();
  for (const entry of args.issued) {
    const list = issuedByEmployee.get(entry.employeeId) ?? [];
    list.push(entry);
    issuedByEmployee.set(entry.employeeId, list);
  }

  const rows: PpeEmployeeIssueRow[] = [];
  for (const employee of args.employees) {
    const items = itemsByEmployee.get(employee.employeeId) ?? [];
    const issuedList = (issuedByEmployee.get(employee.employeeId) ?? [])
      .filter((i) => i.qty > 0)
      .sort(
        (a, b) => a.name.localeCompare(b.name, 'ru') || String(a.size ?? '').localeCompare(String(b.size ?? ''), 'ru'),
      );
    const missing = items
      .map((item) => ({ item, shortage: ppeShortage(item) }))
      .filter((x) => x.shortage.qty > 0)
      .sort((a, b) => a.item.name.localeCompare(b.item.name, 'ru'));

    rows.push({
      employeeId: employee.employeeId,
      fullName: employee.fullName,
      personnelNo: employee.personnelNo ?? null,
      postTitle: employee.postTitle ?? null,
      issuedText: issuedList.map((i) => `${ppePositionLabel(i.name, i.size)} × ${i.qty}`).join('; '),
      missingText: missing
        .map((x) => `${ppePositionLabel(x.item.name, x.item.size)} — ${PPE_SHORTAGE_REASON_RU[x.shortage.reason]} (${x.shortage.qty} шт)`)
        .join('; '),
      positionsCount: items.length,
      missingCount: missing.length,
      state: items.length === 0 ? 'нет норм' : missing.length === 0 ? 'обеспечен' : 'не обеспечен',
    });
  }
  rows.sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'));
  return rows;
}

export type PpeRequestPositionRow = {
  /** Номенклатура строки: размерная позиция, если размер известен, иначе позиция. */
  nomenclatureId: string;
  /** Название позиции. */
  name: string;
  /** Размер; `null` — размер не определён. */
  size: string | null;
  /** Потребность (нехватка по людям) — уже за вычетом выданного. */
  demandQty: number;
  /** Выдано по позиции — величина для контекста, дважды не вычитается. */
  issuedQty: number;
  /** Остаток на складе; `null` — позиции на складе нет, остаток неизвестен. */
  stockQty: number | null;
  /** К закупке: потребность минус остаток. */
  toBuyQty: number;
  /** Сколько сотрудников ждут эту позицию. */
  employeesCount: number;
  /** Цена позиции; `null` — цены нет (прочерк, а не ноль). */
  priceRub: number | null;
  /** Сумма к закупке. */
  amountRub: number | null;
};

function readNumberMap(source: Map<string, number> | Record<string, number> | undefined): Map<string, number> {
  if (!source) return new Map();
  if (source instanceof Map) return source;
  return new Map(Object.entries(source));
}

/**
 * Заявка на закупку по позициям и размерам.
 *
 * Строка = пара «позиция + размер». Потребность — нехватка по людям, остаток —
 * по той же номенклатуре (размерная позиция, если размер известен). Остаток,
 * которого нет, **не вычитается** и показывается прочерком: заявка не имеет
 * права сказать «склад пуст» там, где позиции просто нет в складском слое.
 */
export function buildPpeRequestPositions(args: {
  items: PpeSupplyItem[];
  issued: PpeIssuedItem[];
  stockByNomenclature?: Map<string, number> | Record<string, number>;
  prices?: Map<string, number> | Record<string, number>;
}): PpeRequestPositionRow[] {
  const stock = readNumberMap(args.stockByNomenclature);
  const prices = readNumberMap(args.prices);

  type Acc = {
    positionId: string;
    nomenclatureId: string;
    name: string;
    size: string | null;
    demandQty: number;
    issuedQty: number;
    employees: Set<string>;
  };
  const byKey = new Map<string, Acc>();

  const keyOf = (positionId: string, size: string | null): string => `${positionId}|${size ?? ''}`;

  for (const item of args.items) {
    const shortage = ppeShortage(item);
    if (shortage.qty <= 0) continue;
    const key = keyOf(item.positionId, item.size);
    const acc = byKey.get(key) ?? {
      positionId: item.positionId,
      nomenclatureId: item.sizeId ?? item.positionId,
      name: item.name,
      size: item.size,
      demandQty: 0,
      issuedQty: 0,
      employees: new Set<string>(),
    };
    acc.demandQty += shortage.qty;
    acc.employees.add(item.employeeId);
    byKey.set(key, acc);
  }

  for (const entry of args.issued) {
    if (entry.qty <= 0) continue;
    const key = keyOf(entry.positionId, entry.size);
    const acc = byKey.get(key) ?? {
      positionId: entry.positionId,
      nomenclatureId: entry.sizeId ?? entry.positionId,
      name: entry.name,
      size: entry.size,
      demandQty: 0,
      issuedQty: 0,
      employees: new Set<string>(),
    };
    acc.issuedQty += entry.qty;
    byKey.set(key, acc);
  }

  const rows: PpeRequestPositionRow[] = [];
  for (const acc of byKey.values()) {
    const stockQty = stock.has(acc.nomenclatureId) ? Math.max(0, Number(stock.get(acc.nomenclatureId) ?? 0)) : null;
    const toBuyQty = Math.max(0, acc.demandQty - (stockQty ?? 0));
    // Цена живёт на номенклатуре; у размерной позиции её может не быть — тогда
    // берём цену базовой позиции. Нет цены — прочерк, а не ноль: ноль врёт в бюджет.
    const rawPrice = prices.get(acc.nomenclatureId) ?? prices.get(acc.positionId);
    const priceValue = rawPrice != null && Number.isFinite(Number(rawPrice)) ? Number(rawPrice) : null;
    rows.push({
      nomenclatureId: acc.nomenclatureId,
      name: acc.name,
      size: acc.size,
      demandQty: acc.demandQty,
      issuedQty: acc.issuedQty,
      stockQty,
      toBuyQty,
      employeesCount: acc.employees.size,
      priceRub: priceValue == null ? null : Math.round(priceValue * 100) / 100,
      amountRub: priceValue == null ? null : Math.round(toBuyQty * priceValue * 100) / 100,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, 'ru') || String(a.size ?? '').localeCompare(String(b.size ?? ''), 'ru'));
  return rows;
}
