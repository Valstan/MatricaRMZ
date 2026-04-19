import type { LedgerTableName } from '@matricarmz/ledger';
import { SyncTableName, SyncTableRegistry } from '@matricarmz/shared';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';

import { db } from '../../database/db.js';
import { erpNomenclature, erpNomenclatureEngineBrand } from '../../database/schema.js';
import { queryState } from '../../ledger/ledgerService.js';
import { applyPushBatch } from './applyPushBatch.js';

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
    case SyncTableName.ErpNomenclature:
      if (!(base as any).code || !(base as any).name || !(base as any).item_type) return null;
      return base;
    case SyncTableName.ErpNomenclatureEngineBrand:
      if (!(base as any).nomenclature_id || !(base as any).engine_brand_id) return null;
      if ((base as any).is_default == null) (base as any).is_default = false;
      return base;
    case SyncTableName.ErpEngineAssemblyBom:
      if (!(base as any).name) return null;
      if (!(base as any).engine_brand_id && !(base as any).engine_nomenclature_id) return null;
      if ((base as any).version == null) (base as any).version = 1;
      if (!(base as any).status) (base as any).status = 'draft';
      if ((base as any).is_default == null) (base as any).is_default = false;
      return base;
    case SyncTableName.ErpEngineAssemblyBomLines:
      if (!(base as any).bom_id || !(base as any).component_nomenclature_id) return null;
      if (!(base as any).component_type) (base as any).component_type = 'other';
      if ((base as any).qty_per_unit == null) (base as any).qty_per_unit = 1;
      if ((base as any).is_required == null) (base as any).is_required = true;
      if ((base as any).priority == null) (base as any).priority = 100;
      return base;
    case SyncTableName.ErpEngineInstances:
      if (!(base as any).nomenclature_id || !(base as any).serial_number) return null;
      if (!(base as any).warehouse_id) (base as any).warehouse_id = 'default';
      if (!(base as any).current_status) (base as any).current_status = 'in_stock';
      return base;
    case SyncTableName.ErpRegStockBalance:
    case SyncTableName.ErpRegStockMovements:
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

async function resolveEngineBrandIdFromLegacyNomenclature(nomenclatureId: string): Promise<string | null> {
  const nomId = String(nomenclatureId).trim();
  if (!nomId) return null;
  const row = await db
    .select({ defaultBrandId: erpNomenclature.defaultBrandId })
    .from(erpNomenclature)
    .where(and(eq(erpNomenclature.id, nomId as any), isNull(erpNomenclature.deletedAt)))
    .limit(1);
  const fromDefault = row[0]?.defaultBrandId ? String(row[0].defaultBrandId) : '';
  if (fromDefault) return fromDefault;
  const jb = await db
    .select({ engineBrandId: erpNomenclatureEngineBrand.engineBrandId })
    .from(erpNomenclatureEngineBrand)
    .where(and(eq(erpNomenclatureEngineBrand.nomenclatureId, nomId as any), isNull(erpNomenclatureEngineBrand.deletedAt)))
    .orderBy(desc(erpNomenclatureEngineBrand.isDefault), asc(erpNomenclatureEngineBrand.createdAt))
    .limit(1);
  return jb[0]?.engineBrandId ? String(jb[0].engineBrandId) : null;
}

async function enrichEngineAssemblyBomRowsForReplay(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    if ((row as any).engine_brand_id) {
      out.push(row);
      continue;
    }
    const nomId = (row as any).engine_nomenclature_id;
    if (!nomId) {
      out.push(row);
      continue;
    }
    const brandId = await resolveEngineBrandIdFromLegacyNomenclature(String(nomId));
    if (brandId) {
      out.push({ ...row, engine_brand_id: brandId });
    } else {
      out.push(row);
    }
  }
  return out;
}

export async function replayLedgerToDb(actor: { id: string; username: string; role: string }) {
  if (!actor?.id) {
    throw new Error('actor is required');
  }
  const upserts: { table: SyncTableName; rows: any[] }[] = [];
  for (const regEntry of SyncTableRegistry.entries()) {
    const rows = await loadAllRows(regEntry.ledgerName as LedgerTableName);
    if (rows.length === 0) continue;
    let normalized = rows
      .map((row) => normalizeRow(regEntry.syncName, row as Record<string, unknown>))
      .filter((row): row is Record<string, unknown> => !!row);
    if (regEntry.syncName === SyncTableName.ErpEngineAssemblyBom && normalized.length > 0) {
      normalized = await enrichEngineAssemblyBomRowsForReplay(normalized);
    }
    if (normalized.length > 0) upserts.push({ table: regEntry.syncName, rows: normalized });
  }

  if (upserts.length === 0) {
    return { applied: 0 };
  }

  const result = await applyPushBatch(
    { client_id: 'ledger-replay', upserts },
    { id: actor.id, username: actor.username, role: actor.role },
    { allowSyncConflicts: true },
  );
  return { applied: result.applied };
}
