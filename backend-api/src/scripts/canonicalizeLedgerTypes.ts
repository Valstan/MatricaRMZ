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

function normalizeAttrDef(row: LedgerRow, ts: number) {
  return normalizeTs(
    {
      id: String(row.id),
      entity_type_id: String(row.entity_type_id),
      code: String(row.code),
      name: String(row.name ?? row.code),
      data_type: String(row.data_type ?? 'text'),
      is_required: row.is_required ?? false,
      sort_order: row.sort_order ?? 0,
      meta_json: row.meta_json ?? null,
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
  const canonicalByCode = new Map<string, string>(canonicalRows.map((r) => [String(r.code), String(r.id)]));
  const canonicalEngineId = canonicalByCode.get('engine') ?? '';
  const canonicalContractId = canonicalByCode.get('contract') ?? '';
  if (!canonicalEngineId || !canonicalContractId) {
    throw new Error('canonical engine/contract type ids not found in DB');
  }

  const state = JSON.parse(readFileSync('/home/valstan/MatricaRMZ/backend-api/ledger/state.json', 'utf8'));
  const entities: Record<string, LedgerRow> = state?.tables?.entities ?? {};
  const attributeDefs: Record<string, LedgerRow> = state?.tables?.attribute_defs ?? {};
  const attributeValues: Record<string, LedgerRow> = state?.tables?.attribute_values ?? {};
  const entityTypes: Record<string, LedgerRow> = state?.tables?.entity_types ?? {};

  const nonCanonicalTypeIds = new Set<string>();
  const codeByTypeId = new Map<string, string>();
  for (const row of Object.values(entityTypes)) {
    if (!row?.id || !row?.code) continue;
    const id = String(row.id);
    const code = String(row.code);
    if (code === 'engine' || code === 'contract') {
      codeByTypeId.set(id, code);
      const canonical = code === 'engine' ? canonicalEngineId : canonicalContractId;
      if (id !== canonical) nonCanonicalTypeIds.add(id);
    }
  }

  const canonicalDefByCode = new Map<string, Map<string, string>>();
  const initDefMap = (typeId: string) => canonicalDefByCode.set(typeId, new Map<string, string>());
  initDefMap(canonicalEngineId);
  initDefMap(canonicalContractId);
  for (const d of Object.values(attributeDefs)) {
    const typeId = String(d?.entity_type_id ?? '');
    if (!canonicalDefByCode.has(typeId)) continue;
    const code = String(d?.code ?? '');
    if (!code || !d?.id) continue;
    canonicalDefByCode.get(typeId)!.set(code, String(d.id));
  }

  const defIdRemap = new Map<string, string>();
  for (const d of Object.values(attributeDefs)) {
    const typeId = String(d?.entity_type_id ?? '');
    const code = String(d?.code ?? '');
    if (!code || !d?.id) continue;
    if (typeId === canonicalEngineId || typeId === canonicalContractId) continue;
    if (!nonCanonicalTypeIds.has(typeId)) continue;
    const canonicalType = codeByTypeId.get(typeId) === 'engine' ? canonicalEngineId : canonicalContractId;
    const canonicalDefId = canonicalDefByCode.get(canonicalType)?.get(code);
    if (canonicalDefId && canonicalDefId !== String(d.id)) {
      defIdRemap.set(String(d.id), canonicalDefId);
    }
  }

  const ts = nowMs();
  const txs: LedgerTxPayload[] = [];
  const upserts: SyncPushRequest['upserts'] = [];

  const entityTypeRows: LedgerRow[] = [];
  for (const row of Object.values(entityTypes)) {
    const code = String(row?.code ?? '');
    if (code !== 'engine' && code !== 'contract') continue;
    const canonicalId = code === 'engine' ? canonicalEngineId : canonicalContractId;
    if (String(row.id) === canonicalId) {
      const touched = normalizeEntityType(row, ts);
      txs.push({
        type: 'upsert',
        table: LedgerTableName.EntityTypes,
        row: touched,
        row_id: touched.id,
        actor: { userId: superadminId, username: 'superadmin', role: 'superadmin' },
        ts,
      });
      entityTypeRows.push(touched);
    } else {
      const deleted = normalizeEntityType({ ...row, deleted_at: ts }, ts);
      txs.push({
        type: 'delete',
        table: LedgerTableName.EntityTypes,
        row: deleted,
        row_id: deleted.id,
        actor: { userId: superadminId, username: 'superadmin', role: 'superadmin' },
        ts,
      });
      entityTypeRows.push(deleted);
    }
  }

  const entityRows: LedgerRow[] = [];
  for (const row of Object.values(entities)) {
    const typeId = String(row?.type_id ?? '');
    if (!nonCanonicalTypeIds.has(typeId)) continue;
    const code = codeByTypeId.get(typeId);
    const canonicalId = code === 'engine' ? canonicalEngineId : canonicalContractId;
    const updated = normalizeEntity({ ...row, type_id: canonicalId }, ts);
    txs.push({
      type: 'upsert',
      table: LedgerTableName.Entities,
      row: updated,
      row_id: updated.id,
      actor: { userId: superadminId, username: 'superadmin', role: 'superadmin' },
      ts,
    });
    entityRows.push(updated);
  }

  const attrDefRows: LedgerRow[] = [];
  for (const row of Object.values(attributeDefs)) {
    const typeId = String(row?.entity_type_id ?? '');
    if (!nonCanonicalTypeIds.has(typeId)) continue;
    const code = codeByTypeId.get(typeId);
    const canonicalId = code === 'engine' ? canonicalEngineId : canonicalContractId;
    const canonicalDefId = canonicalDefByCode.get(canonicalId)?.get(String(row.code ?? ''));
    if (canonicalDefId && canonicalDefId !== String(row.id)) {
      const deleted = normalizeAttrDef({ ...row, deleted_at: ts }, ts);
      txs.push({
        type: 'delete',
        table: LedgerTableName.AttributeDefs,
        row: deleted,
        row_id: deleted.id,
        actor: { userId: superadminId, username: 'superadmin', role: 'superadmin' },
        ts,
      });
      attrDefRows.push(deleted);
    }
  }

  const attrValueRows: LedgerRow[] = [];
  for (const row of Object.values(attributeValues)) {
    const defId = String(row?.attribute_def_id ?? '');
    const mapped = defIdRemap.get(defId);
    if (!mapped) continue;
    const updated = normalizeAttrValue({ ...row, attribute_def_id: mapped }, ts);
    txs.push({
      type: 'upsert',
      table: LedgerTableName.AttributeValues,
      row: updated,
      row_id: updated.id,
      actor: { userId: superadminId, username: 'superadmin', role: 'superadmin' },
      ts,
    });
    attrValueRows.push(updated);
  }

  if (txs.length === 0) {
    console.log('[canonicalize] nothing to update');
    return;
  }

  signAndAppend(txs);

  if (entityTypeRows.length > 0) upserts.push({ table: SyncTableName.EntityTypes, rows: entityTypeRows });
  if (entityRows.length > 0) upserts.push({ table: SyncTableName.Entities, rows: entityRows });
  if (attrDefRows.length > 0) upserts.push({ table: SyncTableName.AttributeDefs, rows: attrDefRows });
  if (attrValueRows.length > 0) upserts.push({ table: SyncTableName.AttributeValues, rows: attrValueRows });

  const applied = await applyPushBatch(
    { client_id: `canonicalize-${ts}`, upserts },
    { id: superadminId, username: 'superadmin', role: 'superadmin' },
  );

  console.log(
    `[canonicalize] txs=${txs.length} entityTypes=${entityTypeRows.length} entities=${entityRows.length} attrDefs=${attrDefRows.length} attrValues=${attrValueRows.length} applied=${applied.applied}`,
  );
}

main().catch((e) => {
  console.error('[canonicalize] failed', e);
  process.exit(1);
});
