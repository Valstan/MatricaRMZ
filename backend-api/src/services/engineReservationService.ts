/**
 * Write-half of engine advisory reservation (Ф2 tablet-shop-floor).
 *
 * Резерв — server-managed: взятие/продление/снятие идут только сюда, с СЕРВЕРНЫМИ
 * часами. У планшета в цеху часы плывут, а в проекте нет ни одной компенсации
 * скоса; взятие резерва и так требует сети, поэтому серверные часы бесплатны.
 * Клиенты замок только читают (через обычный sync-pull attribute_values).
 */
import { randomUUID } from 'node:crypto';

import {
  AttributeDataType,
  ENGINE_RESERVATION_CODE,
  ENGINE_RESERVATION_TTL_MS,
  type EngineReservation,
  isEngineReservationLive,
  shouldRenewEngineReservation,
  SyncTableName,
} from '@matricarmz/shared';
import { and, eq, isNull } from 'drizzle-orm';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';
import { upsertAttributeDef } from './adminMasterdataService.js';
import { resolveLoginsToFullNames } from './employeeAuthService.js';
import { invalidateEngineReservationCache, readEngineReservations } from './engineReservationGuard.js';
import { recordSyncChanges } from './sync/syncChangeService.js';

const ENGINE_TYPE_CODE = 'engine';

export type ReservationActor = { id: string; username: string; role?: string | undefined };

/** `row` — строка attribute_values в формате sync-payload: клиент кладёт её в реплику сразу, не дожидаясь pull'а. */
export type ReservationRow = {
  id: string;
  entity_id: string;
  attribute_def_id: string;
  value_json: string;
  created_at: number;
  updated_at: number;
  deleted_at: null;
  sync_status: 'synced';
};

export type ReservationResult =
  | { ok: true; reservation: EngineReservation | null; serverNow: number; row?: ReservationRow }
  | { ok: false; status: 403 | 404 | 409; error: string; holder?: EngineReservation; serverNow: number };

let cachedDefId: string | null = null;

async function engineTypeId(): Promise<string | null> {
  const rows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, ENGINE_TYPE_CODE), isNull(entityTypes.deletedAt)))
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

async function ensureEngineReservationDef(actor: ReservationActor): Promise<string | null> {
  if (cachedDefId) return cachedDefId;

  const typeId = await engineTypeId();
  if (!typeId) return null;

  const existing = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(
      and(
        eq(attributeDefs.entityTypeId, typeId as never),
        eq(attributeDefs.code, ENGINE_RESERVATION_CODE),
        isNull(attributeDefs.deletedAt),
      ),
    )
    .limit(1);
  if (existing[0]?.id) {
    cachedDefId = String(existing[0].id);
    return cachedDefId;
  }

  const created = await upsertAttributeDef(
    { id: actor.id, username: actor.username, role: actor.role ?? 'user' },
    {
      entityTypeId: typeId,
      code: ENGINE_RESERVATION_CODE,
      name: 'Резерв двигателя',
      dataType: AttributeDataType.Json,
      sortOrder: 95,
    },
  );
  if (!created.ok || !created.id) return null;
  cachedDefId = String(created.id);
  return cachedDefId;
}

async function engineExists(engineId: string): Promise<boolean> {
  const rows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.id, engineId as never), isNull(entities.deletedAt)))
    .limit(1);
  return !!rows[0]?.id;
}

async function readReservationRow(engineId: string, defId: string) {
  const rows = await db
    .select({
      id: attributeValues.id,
      createdAt: attributeValues.createdAt,
      updatedAt: attributeValues.updatedAt,
    })
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, engineId as never), eq(attributeValues.attributeDefId, defId as never)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * CAS-запись значения резерва.
 *
 * `updated_at` строго монотонен и ОДИН И ТОТ ЖЕ в строке и в sync-payload:
 * `filterStaleBySeqOrUpdatedAt` в applyPushBatch отбрасывает строку с меньшим
 * `updated_at`, и тогда `last_server_seq` не сдвинется — соседи НИКОГДА не
 * увидят замок инкрементальным pull'ом.
 */
async function writeReservationValue(args: {
  engineId: string;
  defId: string;
  value: EngineReservation;
  actor: ReservationActor;
}): Promise<{ ok: true; row: ReservationRow } | { raced: true }> {
  const existing = await readReservationRow(args.engineId, args.defId);
  const now = Date.now();
  const ts = existing ? Math.max(now, Number(existing.updatedAt) + 1) : now;
  const valueJson = JSON.stringify(args.value);

  let rowId: string;
  let createdAt: number;

  if (existing) {
    const updated = await db
      .update(attributeValues)
      .set({ valueJson, updatedAt: ts, syncStatus: 'synced' })
      .where(and(eq(attributeValues.id, existing.id), eq(attributeValues.updatedAt, Number(existing.updatedAt))))
      .returning({ id: attributeValues.id });
    if (!updated[0]?.id) return { raced: true };
    rowId = String(updated[0].id);
    createdAt = Number(existing.createdAt);
  } else {
    const id = randomUUID();
    const inserted = await db
      .insert(attributeValues)
      .values({
        id,
        entityId: args.engineId as never,
        attributeDefId: args.defId as never,
        valueJson,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced',
      })
      .onConflictDoNothing({ target: [attributeValues.entityId, attributeValues.attributeDefId] })
      .returning({ id: attributeValues.id });
    if (!inserted[0]?.id) return { raced: true };
    rowId = String(inserted[0].id);
    createdAt = ts;
  }

  const row: ReservationRow = {
    id: rowId,
    entity_id: args.engineId,
    attribute_def_id: args.defId,
    value_json: valueJson,
    created_at: createdAt,
    updated_at: ts,
    deleted_at: null,
    sync_status: 'synced',
  };

  await recordSyncChanges({ id: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' }, [
    { tableName: SyncTableName.AttributeValues, rowId, op: 'upsert', payload: { ...row } },
  ]);

  invalidateEngineReservationCache(args.engineId);
  return { ok: true, row };
}

export async function getEngineReservation(engineId: string): Promise<ReservationResult> {
  const serverNow = Date.now();
  const found = await readEngineReservations([engineId]);
  return { ok: true, reservation: found.get(engineId) ?? null, serverNow };
}

export async function acquireEngineReservation(args: {
  engineId: string;
  actor: ReservationActor;
}): Promise<ReservationResult> {
  const { engineId, actor } = args;
  if (!actor.id) return { ok: false, status: 403, error: 'Не определён пользователь', serverNow: Date.now() };
  if (!(await engineExists(engineId)))
    return { ok: false, status: 404, error: 'Двигатель не найден', serverNow: Date.now() };

  const defId = await ensureEngineReservationDef(actor);
  if (!defId) return { ok: false, status: 404, error: 'Атрибут резерва не заведён', serverNow: Date.now() };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const now = Date.now();
    const current = (await readEngineReservations([engineId])).get(engineId) ?? null;

    if (isEngineReservationLive(current, now)) {
      const live = current as EngineReservation;
      if (live.holderUserId !== actor.id) {
        return { ok: false, status: 409, error: 'Двигатель уже взят в работу', holder: live, serverNow: now };
      }
      // Троттлинг продления: без него сохранение карточки писало бы ledger-запись
      // каждый раз — это прод-инцидент heartbeat-в-durable-ledger (M28).
      if (!shouldRenewEngineReservation(live, { nowMs: now, viewerUserId: actor.id })) {
        return { ok: true, reservation: live, serverNow: now };
      }
    }

    const fullNames = await resolveLoginsToFullNames([actor.username]);
    const next: EngineReservation = {
      v: 1,
      holderUserId: actor.id,
      holderLogin: actor.username,
      holderFullName: fullNames[actor.username.trim().toLowerCase()] ?? '',
      startedAt: isEngineReservationLive(current, now) ? (current as EngineReservation).startedAt : now,
      expiresAt: now + ENGINE_RESERVATION_TTL_MS,
      releasedAt: null,
      releasedBy: null,
    };

    const written = await writeReservationValue({ engineId, defId, value: next, actor });
    if ('ok' in written) return { ok: true, reservation: next, serverNow: now, row: written.row };
  }

  return { ok: false, status: 409, error: 'Резерв изменён другим клиентом, повторите', serverNow: Date.now() };
}

export async function releaseEngineReservation(args: {
  engineId: string;
  actor: ReservationActor;
  byAdmin: boolean;
}): Promise<ReservationResult> {
  const { engineId, actor, byAdmin } = args;
  const defId = await ensureEngineReservationDef(actor);
  if (!defId) return { ok: false, status: 404, error: 'Атрибут резерва не заведён', serverNow: Date.now() };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const now = Date.now();
    const current = (await readEngineReservations([engineId])).get(engineId) ?? null;
    if (!isEngineReservationLive(current, now)) return { ok: true, reservation: current, serverNow: now };

    const live = current as EngineReservation;
    if (live.holderUserId !== actor.id && !byAdmin) {
      return { ok: false, status: 403, error: 'Резерв держит другой сотрудник', holder: live, serverNow: now };
    }

    // Пишем ЗНАЧЕНИЕ, а не soft-delete строки: getEngineDetails на клиенте читает
    // значения без isNull(deleted_at) — удалённая строка продолжала бы «висеть» замком.
    const next: EngineReservation = {
      ...live,
      releasedAt: now,
      releasedBy: live.holderUserId === actor.id ? 'holder' : 'admin',
    };
    const written = await writeReservationValue({ engineId, defId, value: next, actor });
    if ('ok' in written) return { ok: true, reservation: next, serverNow: now, row: written.row };
  }

  return { ok: false, status: 409, error: 'Резерв изменён другим клиентом, повторите', serverNow: Date.now() };
}
