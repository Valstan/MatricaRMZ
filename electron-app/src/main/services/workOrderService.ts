import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { WorkOrderPayload } from '@matricarmz/shared';
import { SystemIds } from '@matricarmz/shared';

import { auditLog, operations } from '../database/schema.js';

const WORK_ORDERS_CONTAINER_ID = SystemIds.WorkOrdersContainerEntityId;
const WORK_ORDERS_OPERATION_TYPE = 'work_order';

function nowMs() {
  return Date.now();
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalizeSearch(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/[^a-z0-9а-я\s_-]+/gi, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function monthKeyFromMs(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

async function nextWorkOrderNumber(db: BetterSQLite3Database): Promise<number> {
  const rows = await db
    .select({ metaJson: operations.metaJson })
    .from(operations)
    .where(
      and(
        eq(operations.operationType, WORK_ORDERS_OPERATION_TYPE),
        isNull(operations.deletedAt),
      ),
    )
    .orderBy(desc(operations.createdAt))
    .limit(5000);
  let max = 0;
  for (const row of rows) {
    const parsed = row.metaJson ? (safeJsonParse(String(row.metaJson)) as any) : null;
    if (!parsed || parsed.kind !== 'work_order') continue;
    const n = Number(parsed.workOrderNumber ?? 0);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

function recalcPayload(payload: WorkOrderPayload): WorkOrderPayload {
  const works = (payload.works ?? []).map((line, idx) => {
    const qty = Number(line.qty ?? 0);
    const priceRub = Number(line.priceRub ?? 0);
    return {
      ...line,
      lineNo: idx + 1,
      qty: Number.isFinite(qty) ? qty : 0,
      priceRub: Number.isFinite(priceRub) ? priceRub : 0,
      amountRub: Math.round((Math.max(0, qty) * Math.max(0, priceRub)) * 100) / 100,
    };
  });

  const totalAmountRub = Math.round(works.reduce((acc, x) => acc + Number(x.amountRub ?? 0), 0) * 100) / 100;
  const crew = (payload.crew ?? []).map((member) => {
    const ktu = Number(member.ktu ?? 1);
    return { ...member, ktu: Number.isFinite(ktu) && ktu > 0 ? ktu : 1 };
  });
  const basePerWorkerRub = crew.length > 0 ? Math.round((totalAmountRub / crew.length) * 100) / 100 : 0;
  const payouts = crew.map((member) => {
    const amountRub = Math.round(basePerWorkerRub * Number(member.ktu ?? 1) * 100) / 100;
    return {
      employeeId: String(member.employeeId ?? ''),
      employeeName: String(member.employeeName ?? ''),
      ktu: Number(member.ktu ?? 1),
      amountRub,
    };
  });

  const crewWithPayout = crew.map((member) => {
    const payout = payouts.find((p) => p.employeeId === String(member.employeeId));
    return { ...member, payoutRub: payout?.amountRub ?? 0 };
  });

  return {
    ...payload,
    works,
    crew: crewWithPayout,
    totalAmountRub,
    basePerWorkerRub,
    payouts,
  };
}

function parseWorkOrder(metaJson: string | null): WorkOrderPayload | null {
  if (!metaJson) return null;
  const parsed = safeJsonParse(metaJson) as any;
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.kind !== 'work_order') return null;
  return recalcPayload(parsed as WorkOrderPayload);
}

async function audit(db: BetterSQLite3Database, actor: string, action: string, payload: any) {
  const ts = nowMs();
  await db.insert(auditLog).values({
    id: randomUUID(),
    actor,
    action,
    entityId: payload?.operationId ? String(payload.operationId) : null,
    tableName: 'operations',
    payloadJson: JSON.stringify(payload ?? null),
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'pending',
  });
}

export async function listWorkOrders(
  db: BetterSQLite3Database,
  args?: { q?: string; month?: string },
): Promise<
  | {
      ok: true;
      rows: Array<{
        id: string;
        workOrderNumber: number;
        orderDate: number;
        partName: string;
        crewCount: number;
        totalAmountRub: number;
        updatedAt: number;
      }>;
    }
  | { ok: false; error: string }
> {
  try {
    const rows = await db
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.operationType, WORK_ORDERS_OPERATION_TYPE),
          isNull(operations.deletedAt),
        ),
      )
      .orderBy(desc(operations.updatedAt))
      .limit(5000);

    const qNorm = args?.q ? normalizeSearch(args.q) : '';
    const month = args?.month ? String(args.month).trim() : '';

    const out: Array<{
      id: string;
      workOrderNumber: number;
      orderDate: number;
      partName: string;
      crewCount: number;
      totalAmountRub: number;
      updatedAt: number;
    }> = [];

    for (const row of rows) {
      const payload = parseWorkOrder(row.metaJson ? String(row.metaJson) : null);
      if (!payload) continue;
      const mKey = monthKeyFromMs(Number(payload.orderDate ?? row.createdAt));
      if (month && mKey !== month) continue;
      if (qNorm) {
        const hay = normalizeSearch(
          [
            payload.workOrderNumber,
            payload.partName,
            row.note ?? '',
            JSON.stringify(payload),
          ].join(' '),
        );
        if (!hay.includes(qNorm)) continue;
      }
      out.push({
        id: String(row.id),
        workOrderNumber: Number(payload.workOrderNumber ?? 0),
        orderDate: Number(payload.orderDate ?? row.createdAt),
        partName: String(payload.partName ?? ''),
        crewCount: Array.isArray(payload.crew) ? payload.crew.length : 0,
        totalAmountRub: Number(payload.totalAmountRub ?? 0),
        updatedAt: Number(row.updatedAt),
      });
    }

    return { ok: true as const, rows: out };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function getWorkOrder(
  db: BetterSQLite3Database,
  id: string,
): Promise<{ ok: true; payload: WorkOrderPayload } | { ok: false; error: string }> {
  try {
    const rows = await db
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.id, id),
          eq(operations.operationType, WORK_ORDERS_OPERATION_TYPE),
          isNull(operations.deletedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return { ok: false as const, error: 'Наряд не найден' };
    const payload = parseWorkOrder(row.metaJson ? String(row.metaJson) : null);
    if (!payload) return { ok: false as const, error: 'Некорректный metaJson наряда' };
    return { ok: true as const, payload };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function createWorkOrder(
  db: BetterSQLite3Database,
  actor: string,
): Promise<{ ok: true; id: string; payload: WorkOrderPayload } | { ok: false; error: string }> {
  try {
    const ts = nowMs();
    const id = randomUUID();
    const workOrderNumber = await nextWorkOrderNumber(db);
    const payload = recalcPayload({
      kind: 'work_order',
      version: 1,
      operationId: id,
      workOrderNumber,
      orderDate: ts,
      partId: null,
      partName: '',
      crew: [],
      works: [],
      totalAmountRub: 0,
      basePerWorkerRub: 0,
      payouts: [],
      auditTrail: [{ at: ts, by: actor, action: 'create' }],
    });

    await db.insert(operations).values({
      id,
      engineEntityId: WORK_ORDERS_CONTAINER_ID,
      operationType: WORK_ORDERS_OPERATION_TYPE,
      status: 'draft',
      note: `Наряд №${workOrderNumber}`,
      performedAt: payload.orderDate,
      performedBy: actor?.trim() ? actor.trim() : 'local',
      metaJson: JSON.stringify(payload),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });

    await audit(db, actor, 'work_order.create', payload);
    return { ok: true as const, id, payload };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function updateWorkOrder(
  db: BetterSQLite3Database,
  args: { id: string; payload: WorkOrderPayload; actor: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const current = await getWorkOrder(db, args.id);
    if (!current.ok) return current;
    const ts = nowMs();
    const payload = recalcPayload({
      ...args.payload,
      operationId: args.id,
      auditTrail: [...(args.payload.auditTrail ?? []), { at: ts, by: args.actor, action: 'update' }],
    });

    await db
      .update(operations)
      .set({
        engineEntityId: payload.partId ? String(payload.partId) : WORK_ORDERS_CONTAINER_ID,
        status: 'draft',
        note: `Наряд №${payload.workOrderNumber}`,
        performedAt: payload.orderDate,
        metaJson: JSON.stringify(payload),
        updatedAt: ts,
        syncStatus: 'pending',
      })
      .where(
        and(
          eq(operations.id, args.id),
          eq(operations.operationType, WORK_ORDERS_OPERATION_TYPE),
          isNull(operations.deletedAt),
        ),
      );

    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function deleteWorkOrder(
  db: BetterSQLite3Database,
  args: { id: string; actor: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const current = await getWorkOrder(db, args.id);
    if (!current.ok) return current;
    const ts = nowMs();
    await db
      .update(operations)
      .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'pending' })
      .where(
        and(
          eq(operations.id, args.id),
          eq(operations.operationType, WORK_ORDERS_OPERATION_TYPE),
          isNull(operations.deletedAt),
        ),
      );
    await audit(db, args.actor, 'work_order.delete', current.payload);
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

