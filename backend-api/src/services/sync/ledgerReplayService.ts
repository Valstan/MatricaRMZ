import { LedgerTableName } from '@matricarmz/ledger';
import { SyncTableName } from '@matricarmz/shared';

import { queryState } from '../../ledger/ledgerService.js';
import { applyPushBatch } from './applyPushBatch.js';

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

function withTimestamps(row: Record<string, unknown>) {
  const now = Date.now();
  const created = Number.isFinite(Number((row as any).created_at)) ? Number((row as any).created_at) : null;
  const updated = Number.isFinite(Number((row as any).updated_at)) ? Number((row as any).updated_at) : null;
  if (!created && updated) (row as any).created_at = updated;
  if (!updated && created) (row as any).updated_at = created;
  if (!(row as any).created_at && !(row as any).updated_at) {
    (row as any).created_at = now;
    (row as any).updated_at = now;
  }
  return row;
}

function normalizeRow(table: SyncTableName, row: Record<string, unknown>) {
  const base = withTimestamps({ ...row });
  if ((base as any).sync_status == null) (base as any).sync_status = 'synced';
  switch (table) {
    case SyncTableName.EntityTypes:
      if (!(base as any).code || !(base as any).name) return null;
      return base;
    case SyncTableName.Entities:
      if (!(base as any).type_id) return null;
      return base;
    case SyncTableName.AttributeDefs:
      if (!(base as any).entity_type_id || !(base as any).code || !(base as any).name || !(base as any).data_type) return null;
      if ((base as any).is_required == null) (base as any).is_required = false;
      if ((base as any).sort_order == null) (base as any).sort_order = 0;
      return base;
    case SyncTableName.AttributeValues:
      if (!(base as any).entity_id || !(base as any).attribute_def_id) return null;
      return base;
    case SyncTableName.Operations:
      if (!(base as any).engine_entity_id || !(base as any).operation_type || !(base as any).status) return null;
      return base;
    case SyncTableName.AuditLog:
      if (!(base as any).actor || !(base as any).action) return null;
      return base;
    case SyncTableName.ChatMessages:
      if (!(base as any).sender_user_id || !(base as any).sender_username || !(base as any).message_type) return null;
      return base;
    case SyncTableName.ChatReads:
      if (!(base as any).message_id || !(base as any).user_id || (base as any).read_at == null) return null;
      return base;
    case SyncTableName.UserPresence:
      if (!(base as any).user_id || (base as any).last_activity_at == null) return null;
      return base;
    case SyncTableName.Notes:
      if (!(base as any).owner_user_id || !(base as any).title) return null;
      return base;
    case SyncTableName.NoteShares:
      if (!(base as any).note_id || !(base as any).recipient_user_id) return null;
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

export async function replayLedgerToDb(actor: { id: string; username: string; role: string }) {
  if (!actor?.id) {
    throw new Error('actor is required');
  }
  const upserts: { table: SyncTableName; rows: any[] }[] = [];
  for (const entry of SYNC_TABLES) {
    const rows = await loadAllRows(entry.ledger);
    if (rows.length === 0) continue;
    const normalized = rows
      .map((row) => normalizeRow(entry.sync, row as Record<string, unknown>))
      .filter((row): row is Record<string, unknown> => !!row);
    if (normalized.length > 0) upserts.push({ table: entry.sync, rows: normalized });
  }

  if (upserts.length === 0) {
    return { applied: 0 };
  }

  const result = await applyPushBatch(
    { client_id: 'ledger-replay', upserts },
    { id: actor.id, username: actor.username, role: actor.role },
  );
  return { applied: result.applied };
}
