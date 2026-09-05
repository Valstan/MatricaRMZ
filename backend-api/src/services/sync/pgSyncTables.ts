import { LedgerTableName } from '@matricarmz/ledger';
import { SyncTableName, SyncTableRegistry } from '@matricarmz/shared';

import {
  aiChatRequests,
  attributeDefs,
  attributeValues,
  auditLog,
  cardDrafts,
  chatMessages,
  chatReads,
  entities,
  entityTypes,
  erpEngineAssemblyBom,
  erpEngineAssemblyBomBrandLinks,
  erpEngineAssemblyBomLines,
  erpEngineInstances,
  erpEngineInventoryLines,
  erpNomenclature,
  erpRegStockBalance,
  erpRegStockMovements,
  notes,
  noteShares,
  operations,
  userPresence,
  users,
  userSectionAccess,
} from '../../database/schema.js';

export type PgSyncTableEntry = { drizzle: any; toSyncRow: (r: any) => Record<string, unknown> };

// Единая карта «ledger-таблица → PG-таблица + DTO-строка». Ею отвечает /state/snapshot
// (PostgreSQL — источник истины для клиентов) и ею же ledger:resnapshot-state пересобирает
// проекцию state.json. Одна карта на оба пути, чтобы проекция не могла разойтись со снапшотом
// по набору таблиц или форме строки.
export const PG_SYNC_TABLES: Record<string, PgSyncTableEntry> = {
  [SyncTableName.EntityTypes]: { drizzle: entityTypes, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.EntityTypes, r) },
  [SyncTableName.Entities]: { drizzle: entities, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.Entities, r) },
  [SyncTableName.AttributeDefs]: { drizzle: attributeDefs, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.AttributeDefs, r) },
  [SyncTableName.AttributeValues]: { drizzle: attributeValues, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.AttributeValues, r) },
  [SyncTableName.Operations]: { drizzle: operations, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.Operations, r) },
  [SyncTableName.AuditLog]: { drizzle: auditLog, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.AuditLog, r) },
  [SyncTableName.ChatMessages]: { drizzle: chatMessages, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ChatMessages, r) },
  [SyncTableName.ChatReads]: { drizzle: chatReads, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ChatReads, r) },
  [SyncTableName.UserPresence]: { drizzle: userPresence, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.UserPresence, r) },
  [SyncTableName.Notes]: { drizzle: notes, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.Notes, r) },
  [SyncTableName.NoteShares]: { drizzle: noteShares, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.NoteShares, r) },
  [SyncTableName.CardDrafts]: { drizzle: cardDrafts, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.CardDrafts, r) },
  [SyncTableName.AiChatRequests]: { drizzle: aiChatRequests, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.AiChatRequests, r) },
  [LedgerTableName.ErpNomenclature]: {
    drizzle: erpNomenclature,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ErpNomenclature, r),
  },
  [LedgerTableName.ErpEngineAssemblyBom]: {
    drizzle: erpEngineAssemblyBom,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ErpEngineAssemblyBom, r),
  },
  [LedgerTableName.ErpEngineAssemblyBomLines]: {
    drizzle: erpEngineAssemblyBomLines,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ErpEngineAssemblyBomLines, r),
  },
  [LedgerTableName.ErpEngineAssemblyBomBrandLinks]: {
    drizzle: erpEngineAssemblyBomBrandLinks,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ErpEngineAssemblyBomBrandLinks, r),
  },
  [LedgerTableName.ErpEngineInstances]: {
    drizzle: erpEngineInstances,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ErpEngineInstances, r),
  },
  [LedgerTableName.ErpEngineInventoryLines]: {
    drizzle: erpEngineInventoryLines,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ErpEngineInventoryLines, r),
  },
  [LedgerTableName.ErpRegStockBalance]: {
    drizzle: erpRegStockBalance,
    toSyncRow: (r: any) => ({
      id: String(r.id),
      nomenclature_id: r.nomenclatureId ?? null,
      part_card_id: r.partCardId ?? null,
      warehouse_location_id: r.warehouseLocationId ?? null,
      qty: Number(r.qty ?? 0),
      reserved_qty: Number(r.reservedQty ?? 0),
      updated_at: Number(r.updatedAt),
    }),
  },
  [LedgerTableName.ErpRegStockMovements]: {
    drizzle: erpRegStockMovements,
    toSyncRow: (r: any) => ({
      id: String(r.id),
      nomenclature_id: String(r.nomenclatureId),
      warehouse_location_id: r.warehouseLocationId ?? null,
      document_header_id: r.documentHeaderId ?? null,
      movement_type: String(r.movementType),
      qty: Number(r.qty ?? 0),
      direction: String(r.direction),
      counterparty_id: r.counterpartyId ?? null,
      reason: r.reason ?? null,
      performed_at: Number(r.performedAt),
      performed_by: r.performedBy ?? null,
      created_at: Number(r.createdAt),
    }),
  },
  [LedgerTableName.Users]: { drizzle: users, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.Users, r) },
  [LedgerTableName.UserSectionAccess]: {
    drizzle: userSectionAccess,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.UserSectionAccess, r),
  },
};
