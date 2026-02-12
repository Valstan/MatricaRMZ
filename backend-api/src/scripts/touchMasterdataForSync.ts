import { readFileSync } from 'node:fs';

import { and, inArray, isNull } from 'drizzle-orm';
import { LedgerTableName, type LedgerTxPayload } from '@matricarmz/ledger';
import { SyncTableName, type SyncPushRequest } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { entityTypes as entityTypesTable } from '../database/schema.js';
import { signAndAppend } from '../ledger/ledgerService.js';
import { applyPushBatch } from '../services/sync/applyPushBatch.js';
import { getSuperadminUserId } from '../services/employeeAuthService.js';

type LedgerRow = Record<string, any>;

function nowMs() {
  return Date.now();
}

function normalizeTs(row: LedgerRow, ts: number) {
  const created = Number.isFinite(Number(row.created_at)) ? Number(row.created_at) : null;
  const updated = Number.isFinite(Number(row.updated_at)) ? Number(row.updated_at) : null;
  if (!created && updated) row.created_at = updated;
  if (!updated && created) row.updated_at = created;
  if (!row.created_at && !row.updated_at) {
    row.created_at = ts;
    row.updated_at = ts;
  }
  return row;
}

function normalizeEntityType(row: LedgerRow, ts: number) {
  return normalizeTs(
    {
      id: String(row.id),
      code: String(row.code),
      name: String(row.name ?? row.code),
      created_at: row.created_at,
      updated_at: ts,
      deleted_at: row.deleted_at ?? null,
      sync_status: row.sync_status ?? 'synced',
      last_server_seq: row.last_server_seq ?? null,
    },
    ts,
  );
}

function normalizeEntity(row: LedgerRow, ts: number) {
  return normalizeTs(
    {
      id: String(row.id),
      type_id: String(row.type_id),
      created_at: row.created_at,
      updated_at: ts,
      deleted_at: row.deleted_at ?? null,
      sync_status: row.sync_status ?? 'synced',
      last_server_seq: row.last_server_seq ?? null,
    },
    ts,
  );
}

function normalizeAttrValue(row: LedgerRow, ts: number) {
  return normalizeTs(
    {
      id: String(row.id),
      entity_id: String(row.entity_id),
      attribute_def_id: String(row.attribute_def_id),
      value_json: row.value_json ?? null,
      created_at: row.created_at,
      updated_at: ts,
      deleted_at: row.deleted_at ?? null,
      sync_status: row.sync_status ?? 'synced',
      last_server_seq: row.last_server_seq ?? null,
    },
    ts,
  );
}

async function main() {
  const superadminId = await getSuperadminUserId().catch(() => null);
  if (!superadminId) throw new Error('superadmin user not found');

  const canonicalRows = await db
    .select({ id: entityTypesTable.id, code: entityTypesTable.code })
    .from(entityTypesTable)
    .where(and(isNull(entityTypesTable.deletedAt), inArray(entityTypesTable.code, ['engine', 'contract'])))
    .limit(10);
  const canonicalIds = new Map<string, string>(canonicalRows.map((r) => [String(r.code), String(r.id)]));
  const engineTypeId = canonicalIds.get('engine') ?? '';
  const contractTypeId = canonicalIds.get('contract') ?? '';
  if (!engineTypeId || !contractTypeId) throw new Error('canonical type ids not found');

  const state = JSON.parse(readFileSync('/home/valstan/MatricaRMZ/backend-api/ledger/state.json', 'utf8'));
  const entities: Record<string, LedgerRow> = state?.tables?.entities ?? {};
  const attributeValues: Record<string, LedgerRow> = state?.tables?.attribute_values ?? {};
  const entityTypes: Record<string, LedgerRow> = state?.tables?.entity_types ?? {};

  const targetTypeIds = new Set([engineTypeId, contractTypeId]);
  const ts = nowMs();
  const txs: LedgerTxPayload[] = [];
  const entityRows: LedgerRow[] = [];
  const attrRows: LedgerRow[] = [];
  const typeRows: LedgerRow[] = [];

  for (const row of Object.values(entityTypes)) {
    const code = String(row?.code ?? '');
    const id = String(row?.id ?? '');
    if (code === 'engine' && id === engineTypeId) {
      const norm = normalizeEntityType(row, ts);
      txs.push({ type: 'upsert', table: LedgerTableName.EntityTypes, row: norm, row_id: norm.id, actor: { userId: superadminId, username: 'superadmin', role: 'superadmin' }, ts });
      typeRows.push(norm);
    }
    if (code === 'contract' && id === contractTypeId) {
      const norm = normalizeEntityType(row, ts);
      txs.push({ type: 'upsert', table: LedgerTableName.EntityTypes, row: norm, row_id: norm.id, actor: { userId: superadminId, username: 'superadmin', role: 'superadmin' }, ts });
      typeRows.push(norm);
    }
  }

  const entityIds = new Set<string>();
  for (const row of Object.values(entities)) {
    const typeId = String(row?.type_id ?? '');
    if (!targetTypeIds.has(typeId)) continue;
    if (row?.deleted_at != null) continue;
    const norm = normalizeEntity(row, ts);
    txs.push({ type: 'upsert', table: LedgerTableName.Entities, row: norm, row_id: norm.id, actor: { userId: superadminId, username: 'superadmin', role: 'superadmin' }, ts });
    entityRows.push(norm);
    entityIds.add(String(row.id));
  }

  for (const row of Object.values(attributeValues)) {
    const entityId = String(row?.entity_id ?? '');
    if (!entityIds.has(entityId)) continue;
    if (row?.deleted_at != null) continue;
    const norm = normalizeAttrValue(row, ts);
    txs.push({ type: 'upsert', table: LedgerTableName.AttributeValues, row: norm, row_id: norm.id, actor: { userId: superadminId, username: 'superadmin', role: 'superadmin' }, ts });
    attrRows.push(norm);
  }

  if (txs.length === 0) {
    console.log('[touch] nothing to update');
    return;
  }

  signAndAppend(txs);

  const upserts: SyncPushRequest['upserts'] = [];
  if (typeRows.length > 0) upserts.push({ table: SyncTableName.EntityTypes, rows: typeRows });
  if (entityRows.length > 0) upserts.push({ table: SyncTableName.Entities, rows: entityRows });
  if (attrRows.length > 0) upserts.push({ table: SyncTableName.AttributeValues, rows: attrRows });

  const applied = await applyPushBatch(
    { client_id: `touch-${ts}`, upserts },
    { id: superadminId, username: 'superadmin', role: 'superadmin' },
  );
  console.log(`[touch] entityTypes=${typeRows.length} entities=${entityRows.length} attrValues=${attrRows.length} applied=${applied.applied}`);
}

main().catch((e) => {
  console.error('[touch] failed', e);
  process.exit(1);
});
