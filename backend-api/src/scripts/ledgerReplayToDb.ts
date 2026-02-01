import { LedgerTableName } from '@matricarmz/ledger';
import { SyncTableName } from '@matricarmz/shared';

import { queryState } from '../ledger/ledgerService.js';
import { applyPushBatch } from '../services/sync/applyPushBatch.js';
import { getSuperadminUserId } from '../services/employeeAuthService.js';

const SYNC_TABLES: Array<{ ledger: LedgerTableName; sync: SyncTableName }> = [
  { ledger: LedgerTableName.EntityTypes, sync: SyncTableName.EntityTypes },
  { ledger: LedgerTableName.Entities, sync: SyncTableName.Entities },
  { ledger: LedgerTableName.AttributeDefs, sync: SyncTableName.AttributeDefs },
  { ledger: LedgerTableName.AttributeValues, sync: SyncTableName.AttributeValues },
  { ledger: LedgerTableName.Operations, sync: SyncTableName.Operations },
  { ledger: LedgerTableName.AuditLog, sync: SyncTableName.AuditLog },
  { ledger: LedgerTableName.ChatMessages, sync: SyncTableName.ChatMessages },
  { ledger: LedgerTableName.UserPresence, sync: SyncTableName.UserPresence },
  { ledger: LedgerTableName.Notes, sync: SyncTableName.Notes },
  { ledger: LedgerTableName.NoteShares, sync: SyncTableName.NoteShares },
];

const PAGE_LIMIT = 5000;

function withTimestamps(row: Record<string, any>) {
  const now = Date.now();
  const created = Number.isFinite(Number(row.created_at)) ? Number(row.created_at) : null;
  const updated = Number.isFinite(Number(row.updated_at)) ? Number(row.updated_at) : null;
  if (!created && updated) row.created_at = updated;
  if (!updated && created) row.updated_at = created;
  if (!row.created_at && !row.updated_at) {
    row.created_at = now;
    row.updated_at = now;
  }
  return row;
}

function normalizeRow(table: SyncTableName, row: Record<string, any>) {
  const base = withTimestamps({ ...row });
  if (base.sync_status == null) base.sync_status = 'synced';
  switch (table) {
    case SyncTableName.EntityTypes:
      if (!base.code || !base.name) return null;
      return base;
    case SyncTableName.Entities:
      if (!base.type_id) return null;
      return base;
    case SyncTableName.AttributeDefs:
      if (!base.entity_type_id || !base.code || !base.name || !base.data_type) return null;
      if (base.is_required == null) base.is_required = false;
      if (base.sort_order == null) base.sort_order = 0;
      return base;
    case SyncTableName.AttributeValues:
      if (!base.entity_id || !base.attribute_def_id) return null;
      return base;
    case SyncTableName.Operations:
      if (!base.engine_entity_id || !base.operation_type || !base.status) return null;
      return base;
    case SyncTableName.AuditLog:
      if (!base.actor || !base.action) return null;
      return base;
    case SyncTableName.ChatMessages:
      if (!base.sender_user_id || !base.sender_username || !base.message_type) return null;
      return base;
    case SyncTableName.ChatReads:
      if (!base.message_id || !base.user_id || base.read_at == null) return null;
      return base;
    case SyncTableName.UserPresence:
      if (!base.user_id || base.last_activity_at == null) return null;
      return base;
    case SyncTableName.Notes:
      if (!base.owner_user_id || !base.title) return null;
      return base;
    case SyncTableName.NoteShares:
      if (!base.note_id || !base.recipient_user_id) return null;
      return base;
  }
}

async function loadAllRows(table: LedgerTableName) {
  const all: any[] = [];
  for (let offset = 0; offset < 1000; offset += 1) {
    const rows = queryState(table, { includeDeleted: true, limit: PAGE_LIMIT, offset: offset * PAGE_LIMIT });
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < PAGE_LIMIT) break;
  }
  return all;
}

async function main() {
  const superadminId = await getSuperadminUserId().catch(() => null);
  if (!superadminId) {
    throw new Error('superadmin user not found');
  }
  const upserts: { table: SyncTableName; rows: any[] }[] = [];
  for (const entry of SYNC_TABLES) {
    const rows = await loadAllRows(entry.ledger);
    if (rows.length === 0) continue;
    const normalized = rows
      .map((row) => normalizeRow(entry.sync, row as Record<string, any>))
      .filter((row): row is Record<string, any> => !!row);
    if (normalized.length > 0) upserts.push({ table: entry.sync, rows: normalized });
  }

  if (upserts.length === 0) {
    console.log('[ledger-replay] no rows to apply');
    return;
  }

  const result = await applyPushBatch(
    { client_id: 'ledger-replay', upserts },
    { id: superadminId, username: 'superadmin', role: 'superadmin' },
  );
  console.log(`[ledger-replay] applied=${result.applied}`);
}

main().catch((e) => {
  console.error('[ledger-replay] failed', e);
  process.exit(1);
});
