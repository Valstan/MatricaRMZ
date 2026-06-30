import { readFileSync } from 'node:fs';

import { LedgerTableName, type LedgerTxPayload } from '@matricarmz/ledger';
import { SyncTableName, type SyncPushRequest } from '@matricarmz/shared';

import { signAndAppend } from '../ledger/ledgerService.js';
import { applyPushBatch } from '../services/sync/applyPushBatch.js';
import { getSuperadminUserId } from '../services/employeeAuthService.js';

type LedgerRow = Record<string, any>;

function nowMs() {
  return Date.now();
}

function parseJsonValue(raw: unknown) {
  if (raw == null) return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    return raw;
  }
}

function isEmptyValue(raw: unknown) {
  const parsed = parseJsonValue(raw);
  if (parsed == null) return true;
  if (typeof parsed === 'string') return parsed.trim() === '';
  if (Array.isArray(parsed)) return parsed.length === 0;
  return false;
}

function buildDefMap(defs: Record<string, LedgerRow>) {
  const byTypeAndCode = new Map<string, string>();
  for (const d of Object.values(defs)) {
    const typeId = d?.entity_type_id ? String(d.entity_type_id) : '';
    const code = d?.code ? String(d.code) : '';
    if (!typeId || !code) continue;
    byTypeAndCode.set(`${typeId}::${code}`, String(d.id));
  }
  return byTypeAndCode;
}

function collectAttrValues(values: Record<string, LedgerRow>) {
  const byEntity = new Map<string, LedgerRow[]>();
  for (const v of Object.values(values)) {
    const entityId = v?.entity_id ? String(v.entity_id) : '';
    if (!entityId) continue;
    const arr = byEntity.get(entityId) ?? [];
    arr.push(v);
    byEntity.set(entityId, arr);
  }
  return byEntity;
}

function normalizeEntityRow(row: LedgerRow, deletedAt: number) {
  return {
    id: String(row.id),
    type_id: String(row.type_id),
    created_at: Number(row.created_at ?? deletedAt),
    updated_at: deletedAt,
    deleted_at: deletedAt,
    sync_status: row.sync_status ?? 'synced',
    last_server_seq: row.last_server_seq ?? null,
  };
}

function normalizeAttrRow(row: LedgerRow, deletedAt: number) {
  return {
    id: String(row.id),
    entity_id: String(row.entity_id),
    attribute_def_id: String(row.attribute_def_id),
    value_json: row.value_json ?? null,
    created_at: Number(row.created_at ?? deletedAt),
    updated_at: deletedAt,
    deleted_at: deletedAt,
    sync_status: row.sync_status ?? 'synced',
    last_server_seq: row.last_server_seq ?? null,
  };
}

async function main() {
  const superadminId = await getSuperadminUserId().catch(() => null);
  if (!superadminId) throw new Error('Пользователь superadmin не найден');

  const state = JSON.parse(readFileSync('/home/valstan/MatricaRMZ/backend-api/ledger/state.json', 'utf8'));
  const entities: Record<string, LedgerRow> = state?.tables?.entities ?? {};
  const attributeDefs: Record<string, LedgerRow> = state?.tables?.attribute_defs ?? {};
  const attributeValues: Record<string, LedgerRow> = state?.tables?.attribute_values ?? {};
  const entityTypes: Record<string, LedgerRow> = state?.tables?.entity_types ?? {};

  const engineTypeIds = new Set<string>();
  const contractTypeIds = new Set<string>();
  for (const t of Object.values(entityTypes)) {
    const code = t?.code ? String(t.code) : '';
    const id = t?.id ? String(t.id) : '';
    if (!code || !id) continue;
    if (code === 'engine') engineTypeIds.add(id);
    if (code === 'contract') contractTypeIds.add(id);
  }
  const defMap = buildDefMap(attributeDefs);
  const valuesByEntity = collectAttrValues(attributeValues);

  const toDeleteEntityIds = new Set<string>();
  const deletedAt = nowMs();

  for (const e of Object.values(entities)) {
    if (e?.deleted_at != null) continue;
    const typeId = String(e?.type_id ?? '');
    if (!typeId) continue;
    const isEngine = engineTypeIds.has(typeId);
    const isContract = contractTypeIds.has(typeId);
    if (!isEngine && !isContract) continue;

    const vals = valuesByEntity.get(String(e.id)) ?? [];
    const byDefId = new Map<string, LedgerRow>();
    for (const v of vals) {
      if (v?.attribute_def_id) byDefId.set(String(v.attribute_def_id), v);
    }

    if (isEngine) {
      const numDef = defMap.get(`${typeId}::engine_number`);
      const brandDef = defMap.get(`${typeId}::engine_brand`);
      const numVal = numDef ? byDefId.get(numDef)?.value_json : null;
      const brandVal = brandDef ? byDefId.get(brandDef)?.value_json : null;
      if (isEmptyValue(numVal) && isEmptyValue(brandVal)) {
        toDeleteEntityIds.add(String(e.id));
      }
    }

    if (isContract) {
      const numDef = defMap.get(`${typeId}::number`);
      const internalDef = defMap.get(`${typeId}::internal_number`);
      const dateDef = defMap.get(`${typeId}::date`);
      const numVal = numDef ? byDefId.get(numDef)?.value_json : null;
      const internalVal = internalDef ? byDefId.get(internalDef)?.value_json : null;
      const dateVal = dateDef ? byDefId.get(dateDef)?.value_json : null;
      if (isEmptyValue(numVal) && isEmptyValue(internalVal) && isEmptyValue(dateVal)) {
        toDeleteEntityIds.add(String(e.id));
      }
    }
  }

  if (toDeleteEntityIds.size === 0) {
    console.log('[cleanup] нет записей для удаления');
    return;
  }

  const txs: LedgerTxPayload[] = [];
  const entityRows: LedgerRow[] = [];
  const attrRows: LedgerRow[] = [];

  for (const id of toDeleteEntityIds) {
    const row = entities[id];
    if (!row) continue;
    const normalized = normalizeEntityRow(row, deletedAt);
    txs.push({
      type: 'delete',
      table: LedgerTableName.Entities,
      row: normalized,
      row_id: id,
      actor: { userId: superadminId, username: 'superadmin', role: 'superadmin' },
      ts: deletedAt,
    });
    entityRows.push(normalized);

    const vals = valuesByEntity.get(id) ?? [];
    for (const v of vals) {
      if (!v?.id) continue;
      const a = normalizeAttrRow(v, deletedAt);
      txs.push({
        type: 'delete',
        table: LedgerTableName.AttributeValues,
        row: a,
        row_id: String(a.id),
        actor: { userId: superadminId, username: 'superadmin', role: 'superadmin' },
        ts: deletedAt,
      });
      attrRows.push(a);
    }
  }

  signAndAppend(txs);

  const upserts: SyncPushRequest['upserts'] = [];
  if (entityRows.length > 0) upserts.push({ table: SyncTableName.Entities, rows: entityRows });
  if (attrRows.length > 0) upserts.push({ table: SyncTableName.AttributeValues, rows: attrRows });

  const applied = await applyPushBatch(
    { client_id: `cleanup-${deletedAt}`, upserts },
    { id: superadminId, username: 'superadmin', role: 'superadmin' },
  );
  console.log(`[cleanup] entities=${entityRows.length} attr_values=${attrRows.length} applied=${applied.applied}`);
}

main().catch((e) => {
  console.error('[cleanup] ошибка', e);
  process.exit(1);
});
