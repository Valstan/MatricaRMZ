// Operator-driven cleanup of EMPTY auto-created cards / documents (owner request 2026-06-29).
//
// Historically every `create()` immediately inserted a row; if the operator entered nothing
// and closed the card, an empty ghost remained and synced to all clients. This service is the
// broom: it scans for empty cards (entities) and empty documents (operations), lets the
// operator review and pick what to delete, and soft-deletes the selected ones through the
// normal sync path so every client sees the removal.
//
// SAFETY: delete RE-VALIDATES emptiness server-side before removing anything (a card may have
// gained content since the scan), entity deletes go through softDeleteEntity (which refuses if
// other live entities still link to it), and everything is soft-delete (reversible, auditable).
import { SyncTableName, isWorkOrderPayloadEmpty, isSupplyRequestPayloadEmpty } from '@matricarmz/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes, operations } from '../database/schema.js';
import { softDeleteEntity } from './adminMasterdataService.js';
import { recordSyncChanges } from './sync/syncChangeService.js';

type Actor = { id: string; username: string; role: string };

export type EmptyCardKind = 'engine' | 'contract' | 'employee' | 'work_order' | 'supply_request';
export type EmptyCardRow = { id: string; kind: EmptyCardKind; label: string; createdAt: number };
export type EmptyCardsGroup = { kind: EmptyCardKind; label: string; rows: EmptyCardRow[] };

function nowMs() {
  return Date.now();
}

/** EAV value is blank if null, empty/whitespace string, or empty array (mirrors cleanupEmptyEntities). */
function isAttrBlank(valueJson: string | null | undefined): boolean {
  if (valueJson == null) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(valueJson));
  } catch {
    parsed = valueJson;
  }
  if (parsed == null) return true;
  if (typeof parsed === 'string') return parsed.trim() === '';
  if (Array.isArray(parsed)) return parsed.length === 0;
  return false;
}

// An entity-backed card is empty iff EVERY listed attribute code is blank.
const ENTITY_DETECTORS: Array<{ kind: EmptyCardKind; typeCode: string; label: string; emptyWhenAllBlank: string[] }> = [
  { kind: 'engine', typeCode: 'engine', label: 'Двигатели', emptyWhenAllBlank: ['engine_number', 'engine_brand'] },
  { kind: 'contract', typeCode: 'contract', label: 'Договоры', emptyWhenAllBlank: ['number', 'internal_number', 'date'] },
  { kind: 'employee', typeCode: 'employee', label: 'Сотрудники', emptyWhenAllBlank: ['login', 'full_name'] },
];

const OPERATION_DETECTORS: Array<{ kind: EmptyCardKind; operationType: string; label: string; isEmpty: (payload: unknown) => boolean }> = [
  { kind: 'work_order', operationType: 'work_order', label: 'Наряды', isEmpty: isWorkOrderPayloadEmpty },
  { kind: 'supply_request', operationType: 'supply_request', label: 'Заявки снабжения', isEmpty: isSupplyRequestPayloadEmpty },
];

async function collectEmptyEntities(detector: (typeof ENTITY_DETECTORS)[number]): Promise<EmptyCardRow[]> {
  const type = (
    await db
      .select({ id: entityTypes.id })
      .from(entityTypes)
      .where(and(eq(entityTypes.code, detector.typeCode), isNull(entityTypes.deletedAt)))
      .limit(1)
  )[0];
  if (!type) return [];
  const typeId = String(type.id);

  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as never), isNull(attributeDefs.deletedAt)));
  const defIdByCode = new Map<string, string>();
  for (const d of defs) defIdByCode.set(String(d.code), String(d.id));
  const wantDefIds = detector.emptyWhenAllBlank.map((c) => defIdByCode.get(c)).filter((v): v is string => Boolean(v));

  const rows = await db
    .select({ id: entities.id, createdAt: entities.createdAt })
    .from(entities)
    .where(and(eq(entities.typeId, typeId as never), isNull(entities.deletedAt)))
    .limit(200_000);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => String(r.id));

  // entityId -> set of defIds that have a NON-blank value
  const nonBlankByEntity = new Map<string, Set<string>>();
  if (wantDefIds.length > 0) {
    const values = await db
      .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
      .from(attributeValues)
      .where(
        and(
          inArray(attributeValues.entityId, ids as never[]),
          inArray(attributeValues.attributeDefId, wantDefIds as never[]),
          isNull(attributeValues.deletedAt),
        ),
      );
    for (const v of values) {
      if (isAttrBlank(v.valueJson)) continue;
      const eid = String(v.entityId);
      if (!nonBlankByEntity.has(eid)) nonBlankByEntity.set(eid, new Set());
      nonBlankByEntity.get(eid)!.add(String(v.attributeDefId));
    }
  }

  const out: EmptyCardRow[] = [];
  for (const r of rows) {
    const eid = String(r.id);
    // empty iff none of the meaningful attrs is non-blank
    if ((nonBlankByEntity.get(eid)?.size ?? 0) === 0) {
      out.push({ id: eid, kind: detector.kind, label: `…${eid.slice(-6)}`, createdAt: Number(r.createdAt) });
    }
  }
  return out;
}

async function collectEmptyOperations(detector: (typeof OPERATION_DETECTORS)[number]): Promise<EmptyCardRow[]> {
  const rows = await db
    .select({ id: operations.id, metaJson: operations.metaJson, createdAt: operations.createdAt })
    .from(operations)
    .where(and(eq(operations.operationType, detector.operationType), isNull(operations.deletedAt)))
    .limit(200_000);
  const out: EmptyCardRow[] = [];
  for (const r of rows) {
    let payload: unknown = null;
    try {
      payload = r.metaJson ? JSON.parse(String(r.metaJson)) : null;
    } catch {
      payload = null;
    }
    if (!detector.isEmpty(payload)) continue;
    const p = (payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}) as Record<string, unknown>;
    const num = detector.kind === 'work_order' ? p.workOrderNumber : p.requestNumber;
    const label = num != null ? `№ ${String(num)}` : `…${String(r.id).slice(-6)}`;
    out.push({ id: String(r.id), kind: detector.kind, label, createdAt: Number(r.createdAt) });
  }
  return out;
}

async function collectEmptyCards(): Promise<{ groups: EmptyCardsGroup[]; kindById: Map<string, EmptyCardKind> }> {
  const groups: EmptyCardsGroup[] = [];
  const kindById = new Map<string, EmptyCardKind>();
  for (const d of ENTITY_DETECTORS) {
    const rows = await collectEmptyEntities(d);
    for (const r of rows) kindById.set(r.id, r.kind);
    if (rows.length > 0) groups.push({ kind: d.kind, label: d.label, rows });
  }
  for (const d of OPERATION_DETECTORS) {
    const rows = await collectEmptyOperations(d);
    for (const r of rows) kindById.set(r.id, r.kind);
    if (rows.length > 0) groups.push({ kind: d.kind, label: d.label, rows });
  }
  return { groups, kindById };
}

let analyzeRunning = false;

export async function analyzeEmptyCards(): Promise<
  { ok: true; total: number; groups: EmptyCardsGroup[] } | { ok: false; error: string }
> {
  if (analyzeRunning) return { ok: false as const, error: 'анализ пустых карточек уже выполняется, подождите' };
  analyzeRunning = true;
  try {
    const { groups } = await collectEmptyCards();
    const total = groups.reduce((s, g) => s + g.rows.length, 0);
    return { ok: true as const, total, groups };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  } finally {
    analyzeRunning = false;
  }
}

async function softDeleteOperation(actor: Actor, id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const op = (await db.select().from(operations).where(eq(operations.id, id as never)).limit(1))[0];
  if (!op) return { ok: false as const, error: 'операция не найдена' };
  if (op.deletedAt != null) return { ok: true as const };
  const ts = nowMs();
  await db.update(operations).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' }).where(eq(operations.id, id as never));
  await recordSyncChanges(
    actor,
    [
      {
        tableName: SyncTableName.Operations,
        rowId: id,
        op: 'delete',
        payload: {
          id: String(op.id),
          engine_entity_id: String(op.engineEntityId),
          operation_type: String(op.operationType),
          status: String(op.status),
          note: op.note ?? null,
          performed_at: op.performedAt ?? null,
          performed_by: op.performedBy ?? null,
          meta_json: op.metaJson ?? null,
          created_at: Number(op.createdAt),
          updated_at: ts,
          deleted_at: ts,
          sync_status: 'synced',
        },
      },
    ],
    { allowSyncConflicts: true },
  );
  return { ok: true as const };
}

export type DeleteEmptyCardsResult = {
  ok: true;
  deleted: number;
  skipped: Array<{ id: string; reason: string }>;
};

/**
 * Soft-delete the requested ids — but only those that are STILL empty on a fresh server scan
 * (defends against a card that gained content since the operator's analyze) and only by their
 * detected kind. Entity deletes respect incoming-link guards; blocked/changed rows are reported
 * back as `skipped`, never force-deleted.
 */
export async function deleteEmptyCards(args: {
  ids: string[];
  actor: Actor;
}): Promise<DeleteEmptyCardsResult | { ok: false; error: string }> {
  try {
    const requested = [...new Set((args.ids ?? []).map(String))].filter(Boolean);
    if (requested.length === 0) return { ok: false as const, error: 'не выбрано ни одной карточки' };
    const { kindById } = await collectEmptyCards();

    let deleted = 0;
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const id of requested) {
      const kind = kindById.get(id);
      if (!kind) {
        skipped.push({ id, reason: 'уже не пуста (изменилась после анализа)' });
        continue;
      }
      if (kind === 'work_order' || kind === 'supply_request') {
        const res = await softDeleteOperation(args.actor, id);
        if (res.ok) deleted += 1;
        else skipped.push({ id, reason: res.error });
      } else {
        const res = await softDeleteEntity(args.actor, id);
        if (res.ok) deleted += 1;
        else skipped.push({ id, reason: res.error });
      }
    }
    return { ok: true as const, deleted, skipped };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}
