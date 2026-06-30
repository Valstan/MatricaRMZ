import { and, desc, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db } from '../database/db.js';
import { servicePriceHistory, servicePriceOrders } from '../database/schema.js';

export type ServicePriceOrder = {
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

export type ServicePriceHistoryRow = {
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

type Result<T> = { ok: true } & T | { ok: false; error: string };

function nowMs() { return Date.now(); }

export async function listServicePriceOrders(args?: { status?: string; limit?: number; offset?: number }): Promise<Result<{ rows: ServicePriceOrder[] }>> {
  try {
    const conds = [isNull(servicePriceOrders.deletedAt)];
    if (args?.status) conds.push(eq(servicePriceOrders.status, args.status));
    const limit = Math.min(Math.max(Number(args?.limit ?? 200), 1), 2000);
    const offset = Math.max(Number(args?.offset ?? 0), 0);
    const rows = await db
      .select()
      .from(servicePriceOrders)
      .where(and(...conds))
      .orderBy(desc(servicePriceOrders.effectiveFrom))
      .limit(limit)
      .offset(offset);
    return {
      ok: true,
      rows: rows.map((r) => ({
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
      })),
    };
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
      return { ok: false, error: 'orderNumber и title обязательны' };
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
      .update(servicePriceOrders)
      .set({ deletedAt: ts, updatedAt: ts })
      .where(and(eq(servicePriceOrders.id, id), isNull(servicePriceOrders.deletedAt)));
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listServicePriceHistory(args: { nomenclatureId?: string; orderId?: string; limit?: number; offset?: number }): Promise<Result<{ rows: ServicePriceHistoryRow[] }>> {
  try {
    const conds = [isNull(servicePriceHistory.deletedAt)];
    if (args.nomenclatureId) conds.push(eq(servicePriceHistory.nomenclatureId, args.nomenclatureId));
    if (args.orderId) conds.push(eq(servicePriceHistory.orderId, args.orderId));
    const limit = Math.min(Math.max(Number(args?.limit ?? 500), 1), 5000);
    const offset = Math.max(Number(args?.offset ?? 0), 0);
    const rows = await db
      .select()
      .from(servicePriceHistory)
      .where(and(...conds))
      .orderBy(desc(servicePriceHistory.effectiveFrom))
      .limit(limit)
      .offset(offset);
    return {
      ok: true,
      rows: rows.map((r) => ({
        id: String(r.id),
        nomenclatureId: String(r.nomenclatureId),
        orderId: String(r.orderId),
        price: Number(r.price ?? 0),
        priceCurrency: String(r.priceCurrency ?? 'RUB'),
        effectiveFrom: Number(r.effectiveFrom ?? 0),
        notes: r.notes ?? null,
        createdAt: Number(r.createdAt ?? 0),
        updatedAt: Number(r.updatedAt ?? 0),
      })),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function setServicePriceByOrder(args: {
  nomenclatureId: string;
  orderId: string;
  price: number;
  priceCurrency?: string;
  effectiveFrom?: number;
  notes?: string | null;
}): Promise<Result<{ id: string }>> {
  try {
    const order = await db
      .select({ id: servicePriceOrders.id, effectiveFrom: servicePriceOrders.effectiveFrom })
      .from(servicePriceOrders)
      .where(and(eq(servicePriceOrders.id, args.orderId), isNull(servicePriceOrders.deletedAt)))
      .limit(1);
    if (!order[0]) return { ok: false, error: 'Приказ не найден' };
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
    if (existing[0]?.id) {
      await db
        .update(servicePriceHistory)
        .set({
          price: Math.trunc(Number(args.price)),
          priceCurrency: String(args.priceCurrency ?? 'RUB'),
          effectiveFrom,
          notes: args.notes ?? null,
          updatedAt: ts,
        })
        .where(eq(servicePriceHistory.id, existing[0].id));
      return { ok: true, id: String(existing[0].id) };
    }
    const id = randomUUID();
    await db.insert(servicePriceHistory).values({
      id,
      nomenclatureId: args.nomenclatureId,
      orderId: args.orderId,
      price: Math.trunc(Number(args.price)),
      priceCurrency: String(args.priceCurrency ?? 'RUB'),
      effectiveFrom,
      notes: args.notes ?? null,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getCurrentServicePrice(nomenclatureId: string): Promise<Result<{ row: ServicePriceHistoryRow | null }>> {
  try {
    const now = Date.now();
    const rows = await db
      .select()
      .from(servicePriceHistory)
      .where(and(eq(servicePriceHistory.nomenclatureId, nomenclatureId), isNull(servicePriceHistory.deletedAt)))
      .orderBy(desc(servicePriceHistory.effectiveFrom))
      .limit(20);
    const valid = rows.find((r) => Number(r.effectiveFrom ?? 0) <= now) ?? null;
    return {
      ok: true,
      row: valid
        ? {
            id: String(valid.id),
            nomenclatureId: String(valid.nomenclatureId),
            orderId: String(valid.orderId),
            price: Number(valid.price ?? 0),
            priceCurrency: String(valid.priceCurrency ?? 'RUB'),
            effectiveFrom: Number(valid.effectiveFrom ?? 0),
            notes: valid.notes ?? null,
            createdAt: Number(valid.createdAt ?? 0),
            updatedAt: Number(valid.updatedAt ?? 0),
          }
        : null,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
