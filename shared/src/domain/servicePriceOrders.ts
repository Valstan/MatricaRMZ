/**
 * Приказы о ценах на услуги: чистая логика выбора действующей цены.
 *
 * Цена услуги меняется только приказом (номер, дата, с какого числа). У одной услуги может быть
 * несколько строк из разных приказов; действует та, чья дата вступления самая поздняя из уже
 * наступивших. Строки будущих приказов — «запланированная цена», их видно, но они не действуют.
 */
export type ServicePriceOrderStatus = 'active' | 'cancelled';

export type ServicePriceOrderDto = {
  id: string;
  orderNumber: string;
  orderDate: number;
  title: string;
  notes: string | null;
  documentLink: string | null;
  issuedByEmployeeId: string | null;
  effectiveFrom: number;
  status: string;
  createdAt: number;
  updatedAt: number;
};

export type ServicePriceHistoryDto = {
  id: string;
  nomenclatureId: string;
  orderId: string;
  price: number;
  priceCurrency: string;
  effectiveFrom: number;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
};

/** Строка, действующая на момент `now`: самая поздняя из уже наступивших. Нет такой — null. */
export function resolveEffectiveServicePrice<T extends { effectiveFrom: number }>(rows: readonly T[], now: number): T | null {
  let best: T | null = null;
  for (const row of rows) {
    const from = Number(row.effectiveFrom);
    if (!Number.isFinite(from) || from > now) continue;
    if (!best || from > best.effectiveFrom) best = row;
  }
  return best;
}

/** Ближайшая ещё не наступившая строка — «с такого-то числа цена станет …». */
export function resolvePlannedServicePrice<T extends { effectiveFrom: number }>(rows: readonly T[], now: number): T | null {
  let best: T | null = null;
  for (const row of rows) {
    const from = Number(row.effectiveFrom);
    if (!Number.isFinite(from) || from <= now) continue;
    if (!best || from < best.effectiveFrom) best = row;
  }
  return best;
}

export function formatServicePriceOrderLabel(order: Pick<ServicePriceOrderDto, 'orderNumber' | 'orderDate'>): string {
  const d = new Date(order.orderDate);
  const date = Number.isFinite(d.getTime())
    ? `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`
    : '';
  return date ? `№ ${order.orderNumber} от ${date}` : `№ ${order.orderNumber}`;
}
