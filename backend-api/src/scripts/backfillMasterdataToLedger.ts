import { readFileSync } from 'node:fs';

import { and, inArray, isNull } from 'drizzle-orm';
import { LedgerTableName, type LedgerTxPayload } from '@matricarmz/ledger';
import { SyncTableName, type SyncPushRequest } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';
import { signAndAppend } from '../ledger/ledgerService.js';
import { applyPushBatch } from '../services/sync/applyPushBatch.js';
import { getSuperadminUserId } from '../services/employeeAuthService.js';

type LedgerRow = Record<string, any>;

const CODES = ['engine', 'engine_brand', 'part', 'contract', 'customer', 'employee', 'tool', 'tool_property', 'tool_catalog'];

function nowMs() {
  return Date.now();
}

function normalizeEntityTypeRow(row: any) {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: 'synced',
    last_server_seq: row.lastServerSeq ?? null,
  };
}

function normalizeAttributeDefRow(row: any) {
  return {
    id: String(row.id),
    entity_type_id: String(row.entityTypeId),
    code: String(row.code),
    name: String(row.name),
    data_type: String(row.dataType),
    is_required: Boolean(row.isRequired),
    sort_order: Number(row.sortOrder ?? 0),
    meta_json: row.metaJson == null ? null : String(row.metaJson),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: 'synced',
    last_server_seq: row.lastServerSeq ?? null,
  };
}

function normalizeEntityRow(row: any) {
  return {
    id: String(row.id),
    type_id: String(row.typeId),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: 'synced',
    last_server_seq: row.lastServerSeq ?? null,
  };
}

function normalizeAttributeValueRow(row: any) {
  return {
    id: String(row.id),
    entity_id: String(row.entityId),
    attribute_def_id: String(row.attributeDefId),
    value_json: row.valueJson == null ? null : String(row.valueJson),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: 'synced',
    last_server_seq: row.lastServerSeq ?? null,
  };
}

function normalizeLedgerTypeDelete(row: LedgerRow, ts: number) {
  const createdAt = Number(row?.created_at ?? ts);
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name ?? row.code ?? ''),
    created_at: createdAt,
    updated_at: ts,
    deleted_at: ts,
    sync_status: 'synced',
    last_server_seq: row.last_server_seq ?? null,
  };
}

async function main() {
  const superadminId = await getSuperadminUserId().catch(() => null);
  if (!superadminId) throw new Error('Пользователь superadmin не найден');

  const ledgerState = JSON.parse(readFileSync('/home/valstan/MatricaRMZ/backend-api/ledger/state.json', 'utf8'));
  const ledgerTypes: Record<string, LedgerRow> = ledgerState?.tables?.entity_types ?? {};

  const dbTypes = await db
    .select()
    .from(entityTypes)
    .where(and(isNull(entityTypes.deletedAt), inArray(entityTypes.code, CODES)))
    .limit(5000);
  const canonicalByCode = new Map<string, string>();
  const dbTypeById = new Map<string, any>();
  for (const t of dbTypes as any[]) {
    canonicalByCode.set(String(t.code), String(t.id));
    dbTypeById.set(String(t.id), t);
  }

  const duplicateTypeRows: LedgerRow[] = [];
  for (const row of Object.values(ledgerTypes)) {
    const code = String(row?.code ?? '');
    if (!CODES.includes(code)) continue;
    const canonicalId = canonicalByCode.get(code);
    if (canonicalId && String(row.id) !== canonicalId && row?.deleted_at == null) {
      duplicateTypeRows.push(normalizeLedgerTypeDelete(row, nowMs()));
    }
  }

  const typeIds = Array.from(canonicalByCode.values());
  const dbDefs = await db
    .select()
    .from(attributeDefs)
    .where(inArray(attributeDefs.entityTypeId, typeIds as any))
    .limit(200_000);
  const dbEntities = await db
    .select()
    .from(entities)
    .where(inArray(entities.typeId, typeIds as any))
    .limit(200_000);
  const entityIds = dbEntities.map((e: any) => String(e.id));
  const defIds = dbDefs.map((d: any) => String(d.id));
  const dbValues =
    entityIds.length === 0 || defIds.length === 0
      ? []
      : await db
          .select()
          .from(attributeValues)
          .where(and(inArray(attributeValues.entityId, entityIds as any), inArray(attributeValues.attributeDefId, defIds as any)))
          .limit(500_000);

  const ts = nowMs();
  const txs: LedgerTxPayload[] = [];

  for (const row of duplicateTypeRows) {
    txs.push({
      type: 'delete',
      table: LedgerTableName.EntityTypes,
      row: row,
      row_id: String(row.id),
      actor: { userId: superadminId, username: 'superadmin', role: 'superadmin' },
      ts,
    });
  }

  const typeRows = dbTypes.map(normalizeEntityTypeRow);
  for (const row of typeRows) {
    txs.push({
      type: row.deleted_at ? 'delete' : 'upsert',
      table: LedgerTableName.EntityTypes,
      row,
      row_id: String(row.id),
      actor: { userId: superadminId, username: 'superadmin', role: 'superadmin' },
      ts,
    });
  }

  const defRows = dbDefs.map(normalizeAttributeDefRow);
  for (const row of defRows) {
    txs.push({
      type: row.deleted_at ? 'delete' : 'upsert',
      table: LedgerTableName.AttributeDefs,
      row,
      row_id: String(row.id),
      actor: { userId: superadminId, username: 'superadmin', role: 'superadmin' },
      ts,
    });
  }

  const entityRows = dbEntities.map(normalizeEntityRow);
  for (const row of entityRows) {
    txs.push({
      type: row.deleted_at ? 'delete' : 'upsert',
      table: LedgerTableName.Entities,
      row,
      row_id: String(row.id),
      actor: { userId: superadminId, username: 'superadmin', role: 'superadmin' },
      ts,
    });
  }

  const valueRows = (dbValues as any[]).map(normalizeAttributeValueRow);
  for (const row of valueRows) {
    txs.push({
      type: row.deleted_at ? 'delete' : 'upsert',
      table: LedgerTableName.AttributeValues,
      row,
      row_id: String(row.id),
      actor: { userId: superadminId, username: 'superadmin', role: 'superadmin' },
      ts,
    });
  }

  if (txs.length === 0) {
    console.log('[backfill] нет данных для добавления');
    return;
  }

  signAndAppend(txs);

  const upserts: SyncPushRequest['upserts'] = [];
  if (duplicateTypeRows.length > 0 || typeRows.length > 0) {
    upserts.push({ table: SyncTableName.EntityTypes, rows: [...duplicateTypeRows, ...typeRows] });
  }
  if (defRows.length > 0) upserts.push({ table: SyncTableName.AttributeDefs, rows: defRows });
  if (entityRows.length > 0) upserts.push({ table: SyncTableName.Entities, rows: entityRows });
  if (valueRows.length > 0) upserts.push({ table: SyncTableName.AttributeValues, rows: valueRows });

  const applied = await applyPushBatch(
    { client_id: `backfill-${ts}`, upserts },
    { id: superadminId, username: 'superadmin', role: 'superadmin' },
  );
  console.log(
    `[backfill] types=${typeRows.length} defs=${defRows.length} entities=${entityRows.length} values=${valueRows.length} applied=${applied.applied}`,
  );
}

main().catch((e) => {
  console.error('[backfill] ошибка', e);
  process.exit(1);
});
