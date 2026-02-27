import { randomUUID } from 'node:crypto';

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

function normalizeTs(row: LedgerRow) {
  const created = Number.isFinite(Number(row.created_at)) ? Number(row.created_at) : null;
  const updated = Number.isFinite(Number(row.updated_at)) ? Number(row.updated_at) : null;
  if (!created && updated) row.created_at = updated;
  if (!updated && created) row.updated_at = created;
  if (!row.created_at && !row.updated_at) {
    row.created_at = nowMs();
    row.updated_at = row.created_at;
  }
  return row;
}

function buildTypeMap(defs: Record<string, LedgerRow>) {
  const defToType = new Map<string, string>();
  for (const d of Object.values(defs)) {
    if (d?.id && d?.entity_type_id) defToType.set(String(d.id), String(d.entity_type_id));
  }
  return defToType;
}

function findTypeIdForEntity(entityId: string, values: Record<string, LedgerRow>, defToType: Map<string, string>) {
  const counts = new Map<string, number>();
  for (const v of Object.values(values)) {
    if (String(v?.entity_id ?? '') !== entityId) continue;
    const defId = v?.attribute_def_id ? String(v.attribute_def_id) : '';
    const typeId = defToType.get(defId);
    if (!typeId) continue;
    counts.set(typeId, (counts.get(typeId) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [typeId, count] of counts.entries()) {
    if (count > bestCount) {
      best = typeId;
      bestCount = count;
    }
  }
  return best;
}

async function main() {
  const superadminId = await getSuperadminUserId().catch(() => null);
  if (!superadminId) throw new Error('Пользователь superadmin не найден');

  const state = JSON.parse(readFileSync('/home/valstan/MatricaRMZ/backend-api/ledger/state.json', 'utf8'));
  const entities: Record<string, LedgerRow> = state?.tables?.entities ?? {};
  const attributeDefs: Record<string, LedgerRow> = state?.tables?.attribute_defs ?? {};
  const attributeValues: Record<string, LedgerRow> = state?.tables?.attribute_values ?? {};

  const missing = Object.values(entities).filter((e) => !e?.type_id);
  if (missing.length === 0) {
    console.log('[fix-ledger] нет сущностей без type_id');
    return;
  }

  const defToType = buildTypeMap(attributeDefs);
  const txs: LedgerTxPayload[] = [];
  const upsertRows: LedgerRow[] = [];
  const ts = nowMs();

  for (const row of missing) {
    const id = String(row.id ?? '');
    if (!id) continue;
    const typeId = findTypeIdForEntity(id, attributeValues, defToType);
    if (!typeId) continue;
    const next = normalizeTs({ ...row, type_id: typeId, updated_at: ts });
    txs.push({
      type: 'upsert',
      table: LedgerTableName.Entities,
      row: next,
      row_id: id,
      actor: { userId: superadminId, username: 'superadmin', role: 'superadmin' },
      ts,
    });
    upsertRows.push(next);
  }

  if (txs.length === 0) {
    console.log('[fix-ledger] нет подходящих кандидатов по type_id для восстановления');
    return;
  }

  signAndAppend(txs);

  const upserts: SyncPushRequest['upserts'] = [
    {
      table: SyncTableName.Entities,
      rows: upsertRows.map((row) => ({
        id: row.id,
        type_id: row.type_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
        deleted_at: row.deleted_at ?? null,
        sync_status: row.sync_status ?? 'synced',
        last_server_seq: null,
      })),
    },
  ];

  const applied = await applyPushBatch(
    { client_id: `fix-ledger-${randomUUID()}`, upserts },
    { id: superadminId, username: 'superadmin', role: 'superadmin' },
  );
  console.log(`[fix-ledger] updated=${txs.length} db_applied=${applied.applied}`);
}

main().catch((e) => {
  console.error('[fix-ledger] ошибка', e);
  process.exit(1);
});
