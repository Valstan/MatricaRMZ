import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { resolveEffectiveServicePrice, type ServicePriceHistoryDto, type ServicePriceOrderDto } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { erpNomenclature, servicePriceHistory, servicePriceOrders } from '../database/schema.js';
import { setEntityAttribute } from './adminMasterdataService.js';

export type ServicePriceOrder = ServicePriceOrderDto;
export type ServicePriceHistoryRow = ServicePriceHistoryDto & { nomenclatureName: string | null; nomenclatureCode: string | null };

type Actor = { id: string; username: string; role?: string };
type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

function nowMs() {
  return Date.now();
}

function toOrderDto(r: typeof servicePriceOrders.$inferSelect): ServicePriceOrder {
  return {
    id: String(r.id),
    orderNumber: String(r.orderNumber ?? ''),
    orderDate: Number(r.orderDate ?? 0),
    title: String(r.title ?? ''),
    notes: r.notes ?? null,
    documentLink: r.documentLink ?? null,
    issuedByEmployeeId: r.issuedByEmployeeId ? String(r.issuedByEmployeeId) : null,
    effectiveFrom: Number(r.effectiveFrom ?? 0),
    status: String(r.status ?? 'active'),
    createdAt: Number(r.createdAt ?? 0),
    updatedAt: Number(r.updatedAt ?? 0),
  };
}

function toHistoryDto(r: typeof servicePriceHistory.$inferSelect): ServicePriceHistoryDto {
  return {
    id: String(r.id),
    nomenclatureId: String(r.nomenclatureId),
    orderId: String(r.orderId),
    price: Number(r.price ?? 0),
    priceCurrency: String(r.priceCurrency ?? 'RUB'),
    effectiveFrom: Number(r.effectiveFrom ?? 0),
    notes: r.notes ?? null,
    createdAt: Number(r.createdAt ?? 0),
    updatedAt: Number(r.updatedAt ?? 0),
  };
}

export async function listServicePriceOrders(args?: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<Result<{ rows: Array<ServicePriceOrder & { linesCount: number }> }>> {
  try {
    const conds = [isNull(servicePriceOrders.deletedAt)];
    if (args?.status) conds.push(eq(servicePriceOrders.status, args.status));
    const limit = Math.min(Math.max(Number(args?.limit ?? 200), 1), 2000);
    const offset = Math.max(Number(args?.offset ?? 0), 0);
    const rows = await db
      .select()
      .from(servicePriceOrders)
      .where(and(...conds))
      .orderBy(desc(servicePriceOrders.effectiveFrom), desc(servicePriceOrders.orderDate))
      .limit(limit)
      .offset(offset);
    const ids = rows.map((r) => String(r.id));
    const counts = new Map<string, number>();
    if (ids.length) {
      const lines = await db
        .select({ orderId: servicePriceHistory.orderId })
        .from(servicePriceHistory)
        .where(and(inArray(servicePriceHistory.orderId, ids), isNull(servicePriceHistory.deletedAt)));
      for (const l of lines) counts.set(String(l.orderId), (counts.get(String(l.orderId)) ?? 0) + 1);
    }
    return { ok: true, rows: rows.map((r) => ({ ...toOrderDto(r), linesCount: counts.get(String(r.id)) ?? 0 })) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function upsertServicePriceOrder(args: {
  id?: string;
  orderNumber: string;
  orderDate: number;
  title: string;
  notes?: string | null;
  documentLink?: string | null;
  issuedByEmployeeId?: string | null;
  effectiveFrom: number;
  status?: string;
}): Promise<Result<{ id: string }>> {
  try {
    const ts = nowMs();
    const id = args.id ?? randomUUID();
    const payload = {
      id,
      orderNumber: String(args.orderNumber ?? '').trim(),
      orderDate: Number(args.orderDate),
      title: String(args.title ?? '').trim(),
      notes: args.notes ?? null,
      documentLink: args.documentLink ?? null,
      issuedByEmployeeId: args.issuedByEmployeeId ?? null,
      effectiveFrom: Number(args.effectiveFrom),
      status: String(args.status ?? 'active'),
      updatedAt: ts,
    } as const;
    if (!payload.orderNumber || !payload.title) {
      return { ok: false, error: 'Номер и название приказа обязательны' };
    }
    const dup = await db
      .select({ id: servicePriceOrders.id })
      .from(servicePriceOrders)
      .where(and(eq(servicePriceOrders.orderNumber, payload.orderNumber), isNull(servicePriceOrders.deletedAt)))
      .limit(1);
    if (dup[0] && String(dup[0].id) !== id) {
      return { ok: false, error: `Приказ № ${payload.orderNumber} уже есть` };
    }
    if (args.id) {
      await db
        .update(servicePriceOrders)
        .set(payload)
        .where(and(eq(servicePriceOrders.id, args.id), isNull(servicePriceOrders.deletedAt)));
    } else {
      await db.insert(servicePriceOrders).values({ ...payload, createdAt: ts, deletedAt: null, syncStatus: 'synced' });
    }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deleteServicePriceOrder(id: string): Promise<Result<{ id: string }>> {
  try {
    const ts = nowMs();
    await db
      .update(servicePriceHistory)
      .set({ deletedAt: ts, updatedAt: ts })
      .where(and(eq(servicePriceHistory.orderId, id), isNull(servicePriceHistory.deletedAt)));
    await db
      .update(servicePriceOrders)
      .set({ deletedAt: ts, updatedAt: ts })
      .where(and(eq(servicePriceOrders.id, id), isNull(servicePriceOrders.deletedAt)));
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listServicePriceHistory(args: {
  nomenclatureId?: string;
  orderId?: string;
  limit?: number;
  offset?: number;
}): Promise<Result<{ rows: ServicePriceHistoryRow[] }>> {
  try {
    const conds = [isNull(servicePriceHistory.deletedAt)];
    if (args.nomenclatureId) conds.push(eq(servicePriceHistory.nomenclatureId, args.nomenclatureId));
    if (args.orderId) conds.push(eq(servicePriceHistory.orderId, args.orderId));
    const limit = Math.min(Math.max(Number(args?.limit ?? 500), 1), 5000);
    const offset = Math.max(Number(args?.offset ?? 0), 0);
    const rows = await db
      .select({ row: servicePriceHistory, name: erpNomenclature.name, code: erpNomenclature.code })
      .from(servicePriceHistory)
      .leftJoin(erpNomenclature, eq(erpNomenclature.id, servicePriceHistory.nomenclatureId))
      .where(and(...conds))
      .orderBy(desc(servicePriceHistory.effectiveFrom))
      .limit(limit)
      .offset(offset);
    return {
      ok: true,
      rows: rows.map((r) => ({ ...toHistoryDto(r.row), nomenclatureName: r.name ?? null, nomenclatureCode: r.code ?? null })),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Цена, по которой наряды считают услугу, живёт в карточке услуги (EAV-атрибут `price` той же
 * сущности — у услуги id номенклатуры и id сущности совпадают). Приказ — источник, карточка —
 * рабочее место оператора, поэтому вступившая в силу строка приказа переносится в карточку
 * сразу, а не по расписанию: иначе наряд, выписанный после подписания приказа, считался бы
 * по старой цене. Будущие строки карточку не трогают — их применит следующая правка приказа
 * или ручной пересчёт (кнопка «Применить действующие цены»).
 */
export async function applyEffectiveServicePriceToCard(
  actor: Actor,
  nomenclatureId: string,
  now = nowMs(),
): Promise<Result<{ applied: boolean; price: number | null; reason?: string }>> {
  try {
    const rows = await db
      .select()
      .from(servicePriceHistory)
      .where(and(eq(servicePriceHistory.nomenclatureId, nomenclatureId), isNull(servicePriceHistory.deletedAt)));
    const effective = resolveEffectiveServicePrice(rows.map(toHistoryDto), now);
    if (!effective) return { ok: true, applied: false, price: null, reason: 'нет вступившей в силу строки' };
    const set = await setEntityAttribute(actor, nomenclatureId, 'price', effective.price);
    if (!set.ok) return { ok: true, applied: false, price: effective.price, reason: set.error };
    return { ok: true, applied: true, price: effective.price };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function setServicePriceByOrder(
  actor: Actor,
  args: {
    nomenclatureId: string;
    orderId: string;
    price: number;
    priceCurrency?: string;
    effectiveFrom?: number;
    notes?: string | null;
  },
): Promise<Result<{ id: string; applied: boolean; appliedPrice: number | null; applyReason?: string }>> {
  try {
    const order = await db
      .select({ id: servicePriceOrders.id, effectiveFrom: servicePriceOrders.effectiveFrom })
      .from(servicePriceOrders)
      .where(and(eq(servicePriceOrders.id, args.orderId), isNull(servicePriceOrders.deletedAt)))
      .limit(1);
    if (!order[0]) return { ok: false, error: 'Приказ не найден' };
    const service = await db
      .select({ id: erpNomenclature.id })
      .from(erpNomenclature)
      .where(eq(erpNomenclature.id, args.nomenclatureId))
      .limit(1);
    if (!service[0]) return { ok: false, error: 'Услуга не найдена в номенклатуре' };
    const price = Math.trunc(Number(args.price));
    if (!Number.isFinite(price) || price < 0) return { ok: false, error: 'Цена должна быть неотрицательным числом' };
    const effectiveFrom = Number(args.effectiveFrom ?? order[0].effectiveFrom ?? Date.now());
    const ts = Date.now();
    const existing = await db
      .select({ id: servicePriceHistory.id })
      .from(servicePriceHistory)
      .where(
        and(
          eq(servicePriceHistory.nomenclatureId, args.nomenclatureId),
          eq(servicePriceHistory.orderId, args.orderId),
          isNull(servicePriceHistory.deletedAt),
        ),
      )
      .limit(1);
    let id: string;
    if (existing[0]?.id) {
      id = String(existing[0].id);
      await db
        .update(servicePriceHistory)
        .set({ price, priceCurrency: String(args.priceCurrency ?? 'RUB'), effectiveFrom, notes: args.notes ?? null, updatedAt: ts })
        .where(eq(servicePriceHistory.id, id));
    } else {
      id = randomUUID();
      await db.insert(servicePriceHistory).values({
        id,
        nomenclatureId: args.nomenclatureId,
        orderId: args.orderId,
        price,
        priceCurrency: String(args.priceCurrency ?? 'RUB'),
        effectiveFrom,
        notes: args.notes ?? null,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced',
      });
    }
    const applied = await applyEffectiveServicePriceToCard(actor, args.nomenclatureId, ts);
    if (!applied.ok) return { ok: true, id, applied: false, appliedPrice: null, applyReason: applied.error };
    return {
      ok: true,
      id,
      applied: applied.applied,
      appliedPrice: applied.price,
      ...(applied.reason ? { applyReason: applied.reason } : {}),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deleteServicePriceHistoryRow(
  actor: Actor,
  id: string,
): Promise<Result<{ id: string; applied: boolean; appliedPrice: number | null }>> {
  try {
    const ts = nowMs();
    const row = await db
      .select({ id: servicePriceHistory.id, nomenclatureId: servicePriceHistory.nomenclatureId })
      .from(servicePriceHistory)
      .where(and(eq(servicePriceHistory.id, id), isNull(servicePriceHistory.deletedAt)))
      .limit(1);
    if (!row[0]) return { ok: false, error: 'Строка приказа не найдена' };
    await db.update(servicePriceHistory).set({ deletedAt: ts, updatedAt: ts }).where(eq(servicePriceHistory.id, id));
    // После удаления строки карточка возвращается к предыдущей действующей цене, если она есть.
    const applied = await applyEffectiveServicePriceToCard(actor, String(row[0].nomenclatureId), ts);
    return { ok: true, id, applied: applied.ok ? applied.applied : false, appliedPrice: applied.ok ? applied.price : null };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getCurrentServicePrice(nomenclatureId: string): Promise<Result<{ row: ServicePriceHistoryDto | null }>> {
  try {
    const rows = await db
      .select()
      .from(servicePriceHistory)
      .where(and(eq(servicePriceHistory.nomenclatureId, nomenclatureId), isNull(servicePriceHistory.deletedAt)));
    return { ok: true, row: resolveEffectiveServicePrice(rows.map(toHistoryDto), nowMs()) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
