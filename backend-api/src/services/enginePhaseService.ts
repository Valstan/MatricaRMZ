import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';

import { SyncTableName } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';
import { recordSyncChanges } from './sync/syncChangeService.js';

export const EnginePhase = {
  Received: 'received',
  Disassembled: 'disassembled',
  InAssembly: 'in_assembly',
  Assembled: 'assembled',
  Shipped: 'shipped',
} as const;

export type EnginePhase = (typeof EnginePhase)[keyof typeof EnginePhase];

const ENGINE_TYPE_CODE = 'engine';
const ENGINE_PHASE_ATTR_CODE = 'engine_phase';
const IS_CRITICAL_PART_ATTR_CODE = 'is_critical_part';
const PART_TYPE_CODE = 'part';

type Actor = { id: string; username: string };

function nowMs() {
  return Date.now();
}

async function ensureAttributeDef(
  entityTypeCode: string,
  attrCode: string,
  attrName: string,
  dataType: 'text' | 'boolean',
): Promise<string | null> {
  const typeRows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, entityTypeCode), isNull(entityTypes.deletedAt)))
    .limit(1);
  const typeId = typeRows[0]?.id;
  if (!typeId) return null;

  const existing = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId), eq(attributeDefs.code, attrCode), isNull(attributeDefs.deletedAt)))
    .limit(1);
  if (existing[0]?.id) return String(existing[0].id);

  const ts = nowMs();
  const defId = randomUUID();
  await db.insert(attributeDefs).values({
    id: defId,
    entityTypeId: typeId,
    code: attrCode,
    name: attrName,
    dataType,
    isRequired: false,
    sortOrder: 999,
    metaJson: null,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
    lastServerSeq: null,
  });
  return defId;
}

/**
 * Idempotent — registers `engine_phase` on entity type `engine` and `is_critical_part` on `part`.
 * Safe to call repeatedly; skipped when entity types don't exist (no engine entities yet).
 */
export async function ensurePartsMovementEavSetup(): Promise<void> {
  await ensureAttributeDef(ENGINE_TYPE_CODE, ENGINE_PHASE_ATTR_CODE, 'Фаза двигателя', 'text');
  await ensureAttributeDef(PART_TYPE_CODE, IS_CRITICAL_PART_ATTR_CODE, 'Крупный/важный узел', 'boolean');
}

async function findAttrDefId(entityTypeCode: string, attrCode: string): Promise<string | null> {
  const typeRows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, entityTypeCode), isNull(entityTypes.deletedAt)))
    .limit(1);
  if (!typeRows[0]?.id) return null;
  const defRows = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(
      and(
        eq(attributeDefs.entityTypeId, typeRows[0].id),
        eq(attributeDefs.code, attrCode),
        isNull(attributeDefs.deletedAt),
      ),
    )
    .limit(1);
  return defRows[0]?.id ? String(defRows[0].id) : null;
}

async function getEngineEntityTypeId(engineId: string): Promise<string | null> {
  const rows = await db
    .select({ typeId: entities.typeId })
    .from(entities)
    .where(and(eq(entities.id, engineId), isNull(entities.deletedAt)))
    .limit(1);
  return rows[0]?.typeId ? String(rows[0].typeId) : null;
}

export async function getEnginePhase(engineId: string): Promise<EnginePhase | string | null> {
  const defId = await findAttrDefId(ENGINE_TYPE_CODE, ENGINE_PHASE_ATTR_CODE);
  if (!defId) return null;
  const rows = await db
    .select({ valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(
      and(
        eq(attributeValues.entityId, engineId),
        eq(attributeValues.attributeDefId, defId),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(1);
  if (!rows[0]?.valueJson) return null;
  try {
    const parsed = JSON.parse(String(rows[0].valueJson)) as unknown;
    return typeof parsed === 'string' ? (parsed as EnginePhase | string) : null;
  } catch {
    return null;
  }
}

/**
 * Set engine_phase EAV attribute. Idempotent (writes only if changed).
 * Writes audit_log entry on transition.
 * Returns false silently if engine entity / attribute def doesn't exist yet (no EAV setup).
 */
export async function setEnginePhase(args: {
  engineId: string;
  phase: EnginePhase;
  actor: Actor;
  reasonDocumentId?: string | null;
}): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  try {
    await ensurePartsMovementEavSetup();
    const typeId = await getEngineEntityTypeId(args.engineId);
    if (!typeId) return { ok: false, error: `Engine entity ${args.engineId} not found` };
    const defId = await findAttrDefId(ENGINE_TYPE_CODE, ENGINE_PHASE_ATTR_CODE);
    if (!defId) return { ok: false, error: 'engine_phase attribute def not initialized' };

    const ts = nowMs();
    const existing = await db
      .select({ id: attributeValues.id, valueJson: attributeValues.valueJson, createdAt: attributeValues.createdAt })
      .from(attributeValues)
      .where(
        and(
          eq(attributeValues.entityId, args.engineId),
          eq(attributeValues.attributeDefId, defId),
          isNull(attributeValues.deletedAt),
        ),
      )
      .limit(1);
    const newJson = JSON.stringify(args.phase);
    let from: string | null = null;
    let valueRowId: string;
    let valueCreatedAt: number;
    if (existing[0]) {
      const oldRaw = existing[0].valueJson ?? '';
      try {
        const parsed = JSON.parse(String(oldRaw)) as unknown;
        if (typeof parsed === 'string') from = parsed;
      } catch {
        from = null;
      }
      if (oldRaw === newJson) return { ok: true, changed: false };
      valueRowId = String(existing[0].id);
      valueCreatedAt = Number(existing[0].createdAt) || ts;
      await db
        .update(attributeValues)
        .set({ valueJson: newJson, updatedAt: ts, syncStatus: 'pending' })
        .where(eq(attributeValues.id, existing[0].id));
    } else {
      valueRowId = randomUUID();
      valueCreatedAt = ts;
      await db.insert(attributeValues).values({
        id: valueRowId,
        entityId: args.engineId,
        attributeDefId: defId,
        valueJson: newJson,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'pending',
        lastServerSeq: null,
      });
    }
    // Серверная запись sync-таблиц (фаза + аудит) → единый ledger-путь (last_server_seq),
    // иначе не доезжает до клиентов инкрементальным pull'ом. Best-effort: сбой эмита не валит переход.
    const auditId = randomUUID();
    try {
      await recordSyncChanges({ id: args.actor.id, username: args.actor.username, role: 'user' }, [
        {
          tableName: SyncTableName.AttributeValues,
          rowId: valueRowId,
          op: 'upsert',
          payload: {
            id: valueRowId,
            entity_id: args.engineId,
            attribute_def_id: defId,
            value_json: newJson,
            created_at: valueCreatedAt,
            updated_at: ts,
            deleted_at: null,
            sync_status: 'synced',
          },
          ts,
        },
        {
          tableName: SyncTableName.AuditLog,
          rowId: auditId,
          op: 'upsert',
          payload: {
            id: auditId,
            actor: args.actor.username,
            action: 'engine_phase_transition',
            entity_id: args.engineId,
            table_name: SyncTableName.Entities,
            payload_json: JSON.stringify({
              engineId: args.engineId,
              from,
              to: args.phase,
              reasonDocumentId: args.reasonDocumentId ?? null,
            }),
            created_at: ts,
            updated_at: ts,
            deleted_at: null,
            sync_status: 'synced',
          },
          ts,
        },
      ]);
    } catch (e) {
      console.warn('[enginePhaseService] phase/audit sync redistribution skipped:', e);
    }
    return { ok: true, changed: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
