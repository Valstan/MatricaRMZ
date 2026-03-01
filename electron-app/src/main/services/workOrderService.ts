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

function safeNum(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toCents(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100);
}

function fromCents(value: number): number {
  return Math.round(value) / 100;
}

function normalizeLine(line: any, lineNo: number) {
  const qty = Math.max(0, safeNum(line?.qty, 0));
  const priceRub = Math.max(0, safeNum(line?.priceRub, 0));
  return {
    lineNo,
    serviceId: line?.serviceId ? String(line.serviceId) : null,
    serviceName: String(line?.serviceName ?? ''),
    unit: String(line?.unit ?? ''),
    qty,
    priceRub,
    amountRub: fromCents(toCents(qty * priceRub)),
  };
}

function distributeByKtu(
  totalAmountRub: number,
  crew: Array<{ ktu: number; payoutFrozen: boolean; manualPayoutRub: number }>,
): number[] {
  const totalCents = toCents(Math.max(0, safeNum(totalAmountRub, 0)));
  const frozenCentsByIndex = crew.map((member) => (member.payoutFrozen ? toCents(Math.max(0, safeNum(member.manualPayoutRub, 0))) : 0));
  const frozenTotalCents = frozenCentsByIndex.reduce((acc, value) => acc + value, 0);
  const remainingCents = Math.max(0, totalCents - frozenTotalCents);

  const unfrozen = crew
    .map((member, index) => ({ index, ktu: Math.max(0.01, safeNum(member.ktu, 1)), frozen: member.payoutFrozen }))
    .filter((entry) => !entry.frozen);
  const totalKtu = unfrozen.reduce((acc, entry) => acc + entry.ktu, 0);

  const payoutsCents = [...frozenCentsByIndex];
  if (unfrozen.length === 0 || totalKtu <= 0 || remainingCents <= 0) {
    for (const entry of unfrozen) payoutsCents[entry.index] = 0;
    return payoutsCents.map(fromCents);
  }

  const weighted = unfrozen.map((entry) => {
    const raw = (remainingCents * entry.ktu) / totalKtu;
    const floor = Math.floor(raw);
    return { index: entry.index, floor, remainder: raw - floor };
  });
  let distributed = weighted.reduce((acc, row) => acc + row.floor, 0);
  let remainder = remainingCents - distributed;
  weighted.sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    return a.index - b.index;
  });
  for (let i = 0; i < weighted.length && remainder > 0; i += 1) {
    weighted[i].floor += 1;
    remainder -= 1;
    distributed += 1;
  }
  for (const row of weighted) payoutsCents[row.index] = row.floor;
  return payoutsCents.map(fromCents);
}

function getWorkOrderPartNames(payload: WorkOrderPayload): string[] {
  const names = (Array.isArray(payload.workGroups) ? payload.workGroups : [])
    .map((group) => String(group.partName ?? '').trim())
    .filter((name) => name.length > 0);
  if (names.length > 0) return Array.from(new Set(names));

  const legacyName = String((payload as any).partName ?? '').trim();
  return legacyName ? [legacyName] : [];
}

function getPrimaryPartId(payload: WorkOrderPayload): string | null {
  const group = (Array.isArray(payload.workGroups) ? payload.workGroups : []).find((entry) => entry?.partId);
  if (group?.partId) return String(group.partId);
  const legacyPartId = (payload as any).partId;
  return legacyPartId ? String(legacyPartId) : null;
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
  const rawPayload = payload as any;
  const normalizedGroupsSource: Array<{ groupId: string; partId: string | null; partName: string; lines: any[] }> = [];
  const normalizedFreeSource: any[] = [];

  const hasV2Groups = Array.isArray(rawPayload.workGroups) || Array.isArray(rawPayload.freeWorks);
  if (hasV2Groups) {
    const groups = Array.isArray(rawPayload.workGroups) ? rawPayload.workGroups : [];
    for (let idx = 0; idx < groups.length; idx += 1) {
      const group = groups[idx] ?? {};
      normalizedGroupsSource.push({
        groupId: String(group.groupId ?? `group-${idx + 1}`),
        partId: group.partId ? String(group.partId) : null,
        partName: String(group.partName ?? ''),
        lines: Array.isArray(group.lines) ? group.lines : [],
      });
    }
    if (Array.isArray(rawPayload.freeWorks)) {
      normalizedFreeSource.push(...rawPayload.freeWorks);
    }
  } else {
    const legacyWorks = Array.isArray(rawPayload.works) ? rawPayload.works : [];
    const legacyPartId = rawPayload.partId ? String(rawPayload.partId) : null;
    const legacyPartName = String(rawPayload.partName ?? '');
    if (legacyPartId || legacyPartName.trim().length > 0) {
      normalizedGroupsSource.push({
        groupId: 'legacy-main-group',
        partId: legacyPartId,
        partName: legacyPartName,
        lines: legacyWorks,
      });
    } else {
      normalizedFreeSource.push(...legacyWorks);
    }
  }

  const workGroups = normalizedGroupsSource.map((group, groupIdx) => ({
    groupId: group.groupId || `group-${groupIdx + 1}`,
    partId: group.partId ? String(group.partId) : null,
    partName: String(group.partName ?? ''),
    lines: (Array.isArray(group.lines) ? group.lines : []).map((line, lineIdx) => normalizeLine(line, lineIdx + 1)),
  }));
  const freeWorks = normalizedFreeSource.map((line, idx) => normalizeLine(line, idx + 1));

  const works = [...workGroups.flatMap((group) => group.lines), ...freeWorks].map((line, idx) => ({
    ...line,
    lineNo: idx + 1,
  }));
  const totalAmountRub = fromCents(works.reduce((acc, line) => acc + toCents(safeNum(line.amountRub, 0)), 0));

  const crew = (Array.isArray(rawPayload.crew) ? rawPayload.crew : []).map((member: any) => {
    const ktu = Math.max(0.01, safeNum(member?.ktu, 1));
    const payoutFrozen = Boolean(member?.payoutFrozen);
    const manualPayoutRub = Math.max(0, safeNum(member?.manualPayoutRub ?? member?.payoutRub, 0));
    return {
      employeeId: String(member?.employeeId ?? ''),
      employeeName: String(member?.employeeName ?? ''),
      ktu,
      payoutFrozen,
      manualPayoutRub,
    };
  });

  const payoutValues = distributeByKtu(totalAmountRub, crew);
  const payouts = crew.map((member, idx) => ({
    employeeId: member.employeeId,
    employeeName: member.employeeName,
    ktu: member.ktu,
    amountRub: payoutValues[idx] ?? 0,
  }));
  const crewWithPayout = crew.map((member, idx) => ({
    ...member,
    payoutRub: payoutValues[idx] ?? 0,
    manualPayoutRub: member.payoutFrozen ? member.manualPayoutRub : undefined,
  }));

  return {
    ...payload,
    version: 2,
    workGroups,
    freeWorks,
    works,
    crew: crewWithPayout,
    totalAmountRub,
    basePerWorkerRub: crew.length > 0 ? fromCents(toCents(totalAmountRub / crew.length)) : 0,
    payouts,
    partId: undefined,
    partName: undefined,
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
      const partName = getWorkOrderPartNames(payload).join(', ');
      const mKey = monthKeyFromMs(Number(payload.orderDate ?? row.createdAt));
      if (month && mKey !== month) continue;
      if (qNorm) {
        const hay = normalizeSearch(
          [
            payload.workOrderNumber,
            partName,
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
        partName,
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
      version: 2,
      operationId: id,
      workOrderNumber,
      orderDate: ts,
      crew: [],
      workGroups: [],
      freeWorks: [],
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
        engineEntityId: getPrimaryPartId(payload) ?? WORK_ORDERS_CONTAINER_ID,
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

