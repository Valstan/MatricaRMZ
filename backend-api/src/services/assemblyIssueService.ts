import { randomUUID } from 'node:crypto';

import { applyWorkOrderIssue, applyWorkOrderWithdrawal, resolveAssemblyEngineId, type AssemblyShortageItem, type WorkOrderPayload } from '@matricarmz/shared';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';

import { db } from '../database/db.js';
import {
  assemblyShortageApprovals,
  erpNomenclature,
  erpRegStockBalance,
  operations,
  warehouseLocations,
} from '../database/schema.js';
import { computeAssemblyMaterialHash } from './assemblyPlanningService.js';
import { emitOperationSyncChange, saveAssemblyWorkOrderDraft } from './workOrderClosingService.js';
import { ingestServerCriticalEvent } from './criticalEventsService.js';

type Actor = { id: string; username: string; role?: string };
type IssueResult =
  | { ok: true; operationId: string; state: 'issued' | 'issued_with_shortage'; documentId: string | null; payload: WorkOrderPayload }
  | { ok: false; code: 'invalid_order' | 'stale_materials' | 'shortage' | 'approval_required'; error: string; shortages?: AssemblyShortageItem[]; materialHash?: string };

function parsePayload(raw: string | null): WorkOrderPayload | null {
  try {
    const value = raw ? JSON.parse(raw) : null;
    return value && typeof value === 'object' && value.kind === 'work_order' ? (value as WorkOrderPayload) : null;
  } catch {
    return null;
  }
}

function snapshotHash(payload: WorkOrderPayload): string | null {
  const snapshot = payload.assemblyBomSnapshot;
  const engineId = resolveAssemblyEngineId(payload);
  const engineBrandId = String(snapshot?.engineBrandId ?? snapshot?.works[0]?.engineBrandId ?? payload.freeWorks[0]?.engineBrandId ?? '').trim();
  if (!snapshot || !engineId || !engineBrandId) return null;
  return computeAssemblyMaterialHash({
    engineId,
    engineBrandId,
    bomId: snapshot.bomId,
    version: snapshot.bomVersion,
    variantKey: snapshot.variantKey,
    materials: snapshot.materials.map((line) => ({
      nomenclatureId: line.nomenclatureId,
      qty: line.qty,
      sourceWarehouseId: line.sourceWarehouseId,
    })),
  });
}

async function loadOrder(operationId: string) {
  const rows = await db.select().from(operations).where(and(eq(operations.id, operationId), isNull(operations.deletedAt))).limit(1);
  const row = rows[0];
  const payload = row ? parsePayload(row.metaJson) : null;
  return row && payload ? { row, payload } : null;
}

export async function checkAssemblyAvailability(operationId: string): Promise<
  | { ok: true; payload: WorkOrderPayload; materialHash: string; shortages: AssemblyShortageItem[] }
  | { ok: false; error: string }
> {
  const loaded = await loadOrder(operationId);
  if (!loaded || loaded.payload.workOrderKind !== 'assembly') return { ok: false, error: 'Сборочный наряд не найден' };
  const { payload } = loaded;
  const materialHash = snapshotHash(payload);
  if (!materialHash || materialHash !== payload.assemblyMaterialHash) {
    return { ok: false, error: 'Состав наряда не совпадает с зафиксированным снимком BOM; примените BOM заново' };
  }
  const materials = payload.assemblyBomSnapshot?.materials ?? [];
  const locationKeys = [...new Set(materials.map((line) => line.sourceWarehouseId))];
  const uuidKeys = locationKeys.filter((key) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key));
  const codeKeys = locationKeys.filter((key) => !uuidKeys.includes(key));
  const locationFilter = uuidKeys.length && codeKeys.length
    ? or(inArray(warehouseLocations.id, uuidKeys as any), inArray(warehouseLocations.code, codeKeys))
    : uuidKeys.length
      ? inArray(warehouseLocations.id, uuidKeys as any)
      : inArray(warehouseLocations.code, codeKeys);
  const locations = locationKeys.length
    ? await db
        .select({ id: warehouseLocations.id, code: warehouseLocations.code, name: warehouseLocations.name })
        .from(warehouseLocations)
        .where(and(locationFilter, isNull(warehouseLocations.deletedAt)))
    : [];
  const locationByKey = new Map<string, { id: string; name: string }>();
  for (const location of locations) {
    const value = { id: String(location.id), name: String(location.name) };
    locationByKey.set(String(location.id), value);
    locationByKey.set(String(location.code), value);
  }
  const grouped = new Map<string, { nomenclatureId: string; locationId: string; warehouseName: string; requiredQty: number }>();
  for (const line of materials) {
    const location = locationByKey.get(line.sourceWarehouseId);
    if (!location) return { ok: false, error: `Склад-источник не найден: ${line.sourceWarehouseId}` };
    const key = `${line.nomenclatureId}:${location.id}`;
    const current = grouped.get(key);
    if (current) current.requiredQty += line.qty;
    else grouped.set(key, { nomenclatureId: line.nomenclatureId, locationId: location.id, warehouseName: location.name, requiredQty: line.qty });
  }
  const nomenclatureIds = [...new Set([...grouped.values()].map((line) => line.nomenclatureId))];
  const [balances, nomenclature] = await Promise.all([
    nomenclatureIds.length
      ? db.select().from(erpRegStockBalance).where(inArray(erpRegStockBalance.nomenclatureId, nomenclatureIds as any))
      : [],
    nomenclatureIds.length
      ? db.select({ id: erpNomenclature.id, name: erpNomenclature.name }).from(erpNomenclature).where(inArray(erpNomenclature.id, nomenclatureIds as any))
      : [],
  ]);
  const names = new Map(nomenclature.map((row) => [String(row.id), String(row.name)]));
  const balanceByKey = new Map(
    balances.map((row) => [`${String(row.nomenclatureId)}:${String(row.warehouseLocationId)}`, Number(row.qty) - Number(row.reservedQty)]),
  );
  const shortages: AssemblyShortageItem[] = [];
  for (const line of grouped.values()) {
    const availableQty = Math.max(0, balanceByKey.get(`${line.nomenclatureId}:${line.locationId}`) ?? 0);
    if (availableQty >= line.requiredQty) continue;
    shortages.push({
      nomenclatureId: line.nomenclatureId,
      nomenclatureName: names.get(line.nomenclatureId) ?? line.nomenclatureId,
      warehouseLocationId: line.locationId,
      warehouseName: line.warehouseName,
      requiredQty: line.requiredQty,
      availableQty,
      shortageQty: line.requiredQty - availableQty,
    });
  }
  return { ok: true, payload, materialHash, shortages };
}

async function persistIssueState(args: {
  operationId: string;
  actor: Actor;
  state: 'issued' | 'issued_with_shortage';
  approval?: WorkOrderPayload['assemblyShortageApproval'];
}): Promise<WorkOrderPayload> {
  const loaded = await loadOrder(args.operationId);
  if (!loaded) throw new Error('Наряд не найден');
  const issued = applyWorkOrderIssue(loaded.payload, { at: Date.now(), by: args.actor.username });
  const payload: WorkOrderPayload = {
    ...issued,
    assemblyIssueState: args.state,
    ...(args.approval ? { assemblyShortageApproval: args.approval } : {}),
  };
  await db.update(operations).set({ status: 'open', metaJson: JSON.stringify(payload), updatedAt: Date.now(), syncStatus: 'synced' }).where(eq(operations.id, args.operationId));
  await emitOperationSyncChange(args.operationId, args.actor);
  return payload;
}

export async function issueAssemblyWorkOrder(args: { operationId: string; actor: Actor }): Promise<IssueResult> {
  const availability = await checkAssemblyAvailability(args.operationId);
  if (!availability.ok) return { ok: false, code: 'invalid_order', error: availability.error };
  if (availability.shortages.length === 0) {
    const reserved = await saveAssemblyWorkOrderDraft({ operationId: args.operationId, actor: args.actor });
    if (!reserved.ok) return { ok: false, code: 'stale_materials', error: reserved.error };
    const payload = await persistIssueState({ operationId: args.operationId, actor: args.actor, state: 'issued' });
    return { ok: true, operationId: args.operationId, state: 'issued', documentId: reserved.documentId, payload };
  }
  const approvedRows = await db
    .select()
    .from(assemblyShortageApprovals)
    .where(and(eq(assemblyShortageApprovals.operationId, args.operationId), eq(assemblyShortageApprovals.status, 'approved')))
    .orderBy(desc(assemblyShortageApprovals.requestedAt))
    .limit(1);
  const approved = approvedRows[0];
  if (!approved || approved.materialHash !== availability.materialHash) {
    return { ok: false, code: 'shortage', error: 'Для выдачи не хватает деталей', shortages: availability.shortages, materialHash: availability.materialHash };
  }
  const approval = {
    id: String(approved.id), status: 'approved' as const, materialHash: approved.materialHash,
    reason: approved.requestReason, requestedAt: Number(approved.requestedAt), requestedBy: String(approved.requestedBy),
    ...(approved.decidedAt != null ? { decidedAt: Number(approved.decidedAt) } : {}),
    ...(approved.decidedBy ? { decidedBy: String(approved.decidedBy) } : {}),
    ...(approved.decisionReason ? { decisionReason: approved.decisionReason } : {}),
  };
  const payload = await persistIssueState({ operationId: args.operationId, actor: args.actor, state: 'issued_with_shortage', approval });
  return { ok: true, operationId: args.operationId, state: 'issued_with_shortage', documentId: null, payload };
}

export async function setWorkOrderIssued(args: { operationId: string; issued: boolean; reason?: string; actor: Actor }) {
  const loaded = await loadOrder(args.operationId);
  if (!loaded) return { ok: false as const, error: 'Наряд не найден' };
  if (loaded.payload.workOrderKind === 'assembly' && args.issued) {
    return issueAssemblyWorkOrder({ operationId: args.operationId, actor: args.actor });
  }
  if (!args.issued && !String(args.reason ?? '').trim()) return { ok: false as const, error: 'Для отзыва обязательна причина' };
  const payload = args.issued
    ? applyWorkOrderIssue(loaded.payload, { at: Date.now(), by: args.actor.username })
    : applyWorkOrderWithdrawal(loaded.payload, { at: Date.now(), by: args.actor.username, reason: String(args.reason).trim() });
  await db.update(operations).set({ metaJson: JSON.stringify(payload), updatedAt: Date.now(), syncStatus: 'synced' }).where(eq(operations.id, args.operationId));
  await emitOperationSyncChange(args.operationId, args.actor);
  return { ok: true as const, operationId: args.operationId, payload };
}

export async function requestAssemblyShortageApproval(args: { operationId: string; reason: string; actor: Actor }) {
  const availability = await checkAssemblyAvailability(args.operationId);
  if (!availability.ok) return { ok: false as const, error: availability.error };
  if (availability.shortages.length === 0) return { ok: false as const, error: 'Дефицита больше нет — выполните обычную выдачу' };
  const now = Date.now();
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.update(assemblyShortageApprovals).set({ status: 'invalidated', invalidatedAt: now }).where(
      and(eq(assemblyShortageApprovals.operationId, args.operationId), inArray(assemblyShortageApprovals.status, ['requested', 'approved'])),
    );
    await tx.insert(assemblyShortageApprovals).values({
      id, operationId: args.operationId, materialHash: availability.materialHash,
      shortageJson: JSON.stringify(availability.shortages), status: 'requested', requestReason: args.reason,
      requestedBy: args.actor.id, requestedAt: now,
    });
  });
  return { ok: true as const, id, materialHash: availability.materialHash, shortages: availability.shortages };
}

export async function getAssemblyShortageApproval(operationId: string) {
  const rows = await db
    .select()
    .from(assemblyShortageApprovals)
    .where(eq(assemblyShortageApprovals.operationId, operationId))
    .orderBy(desc(assemblyShortageApprovals.requestedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: true as const, approval: null };
  let shortages: AssemblyShortageItem[] = [];
  try {
    const parsed = JSON.parse(row.shortageJson) as unknown;
    if (Array.isArray(parsed)) shortages = parsed as AssemblyShortageItem[];
  } catch {
    shortages = [];
  }
  return {
    ok: true as const,
    approval: {
      id: String(row.id),
      operationId: String(row.operationId),
      materialHash: row.materialHash,
      status: String(row.status) as 'requested' | 'approved' | 'rejected' | 'invalidated',
      reason: row.requestReason,
      requestedBy: String(row.requestedBy),
      requestedAt: Number(row.requestedAt),
      shortages,
      ...(row.decidedBy ? { decidedBy: String(row.decidedBy) } : {}),
      ...(row.decidedAt != null ? { decidedAt: Number(row.decidedAt) } : {}),
      ...(row.decisionReason ? { decisionReason: row.decisionReason } : {}),
    },
  };
}

export async function decideAssemblyShortageApproval(args: { approvalId: string; approve: boolean; reason: string; actor: Actor }) {
  const rows = await db.select().from(assemblyShortageApprovals).where(eq(assemblyShortageApprovals.id, args.approvalId)).limit(1);
  const approval = rows[0];
  if (!approval || approval.status !== 'requested') return { ok: false as const, error: 'Запрос согласования не найден или уже рассмотрен' };
  const availability = await checkAssemblyAvailability(String(approval.operationId));
  if (!availability.ok || availability.materialHash !== approval.materialHash) {
    await db.update(assemblyShortageApprovals).set({ status: 'invalidated', invalidatedAt: Date.now() }).where(eq(assemblyShortageApprovals.id, approval.id));
    return { ok: false as const, error: 'Состав наряда изменился; запрос аннулирован' };
  }
  if (String(approval.requestedBy) === args.actor.id && !args.reason.trim()) {
    return { ok: false as const, error: 'Для самосогласования обязательна причина' };
  }
  const decided = await db.update(assemblyShortageApprovals).set({
    status: args.approve ? 'approved' : 'rejected', decidedBy: args.actor.id, decidedAt: Date.now(), decisionReason: args.reason.trim() || null,
  }).where(and(eq(assemblyShortageApprovals.id, approval.id), eq(assemblyShortageApprovals.status, 'requested'))).returning({ id: assemblyShortageApprovals.id });
  if (decided.length === 0) return { ok: false as const, error: 'Запрос уже рассмотрен другим пользователем' };
  if (args.approve && String(approval.requestedBy) === args.actor.id) {
    ingestServerCriticalEvent({
      eventCode: 'assembly.shortage.self_approved',
      title: 'Самосогласование дефицита сборочного наряда',
      humanMessage: `${args.actor.username} согласовал собственный запрос по наряду ${String(approval.operationId)}: ${args.reason.trim()}`,
      category: 'storage',
      severity: 'error',
      aiDetails: { approvalId: String(approval.id), operationId: String(approval.operationId), actorId: args.actor.id, reason: args.reason.trim() },
      dedupMessage: String(approval.id),
    });
  }
  return { ok: true as const, id: String(approval.id), status: args.approve ? 'approved' as const : 'rejected' as const };
}
