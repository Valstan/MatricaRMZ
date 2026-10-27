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
  chatRooms,
  entities,
  entityTypes,
  erpContracts,
  erpCounterparties,
  erpContractPaymentSlots,
  erpContractPayments,
  erpEngineCards,
  erpEngineNumbers,
  erpEmployeeCards,
  directoryEngineBrands,
  erpEngineAssemblyBom,
  erpEngineAssemblyBomBrandLinks,
  erpEngineAssemblyBomLines,
  erpEngineInstances,
  erpEngineInventoryLines,
  erpNomenclature,
  erpRegStockBalance,
  erpRegStockMovements,
  ppeAbsences,
  ppeCardNorms,
  ppeCollectiveLines,
  ppeCollectives,
  ppeGroupMembers,
  ppeGroupNorms,
  ppeGroups,
  ppeIssueCards,
  ppeIssueEntries,
  ppeNormLines,
  ppeNormSets,
  signatureDefaults,
  notes,
  noteShares,
  operations,
  userPresence,
  users,
  userSectionAccess,
  warehouseLocations,
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
  [SyncTableName.ChatRooms]: { drizzle: chatRooms, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ChatRooms, r) },
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
  [LedgerTableName.WarehouseLocations]: {
    drizzle: warehouseLocations,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.WarehouseLocations, r),
  },
  [LedgerTableName.ErpCounterparties]: {
    drizzle: erpCounterparties,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ErpCounterparties, r),
  },
  [LedgerTableName.ErpContracts]: {
    drizzle: erpContracts,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ErpContracts, r),
  },
  [LedgerTableName.ErpContractPaymentSlots]: {
    drizzle: erpContractPaymentSlots,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ErpContractPaymentSlots, r),
  },
  [LedgerTableName.ErpContractPaymentPayments]: {
    drizzle: erpContractPayments,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ErpContractPaymentPayments, r),
  },
  // Карточки двигателей и реестр номеров РМЗ (план engine-rmz-numbers-2026-10).
  // Карточки в контракте с E3, но в карты pull не попали: холодный снапшот отдавал по
  // ним пустоту, и свежая машина получала реплику только из журнала. Закрыто 27.10.2026
  // вместе с реестром номеров — сторож mirrorTables ловит только таблицы SERVER_MIRROR_TABLES,
  // карточки в этот список не входят и провалились между PR серии (brain #166).
  [LedgerTableName.ErpEngineCards]: {
    drizzle: erpEngineCards,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ErpEngineCards, r),
  },
  [LedgerTableName.ErpEngineNumbers]: {
    drizzle: erpEngineNumbers,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ErpEngineNumbers, r),
  },
  [LedgerTableName.DirectoryEngineBrands]: {
    drizzle: directoryEngineBrands,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.DirectoryEngineBrands, r),
  },
  [LedgerTableName.Users]: { drizzle: users, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.Users, r) },
  [LedgerTableName.UserSectionAccess]: {
    drizzle: userSectionAccess,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.UserSectionAccess, r),
  },

  // ── Серверные зеркала Кладовщика (СИЗ), умолчаний подписей и сотрудников ──
  // Строки ведут серверные двери обычными insert/update, а публикаторы зеркал
  // (ppeSyncPublisherService, signatureDefaultsSyncPublisherService) доводят
  // их до журнала. В этой карте они обязаны быть — иначе: (а) холодный снапшот
  // отдаёт пусто и реплика клиента остаётся без модуля целиком (тем же путём
  // проект уже терял erp_engine_instances — сторож usersContractDrift), (б)
  // stampRowSeq не ставит last_server_seq, и источник-табличный pull строку
  // не видит вовсе (`NULL > since` в SQL не TRUE).
  // Форму строки держит реестр: у сотрудников attrs_json срезан — в зеркало
  // едут только ФИО/табельный/должность/активность.
  [LedgerTableName.ErpEmployeeCards]: {
    drizzle: erpEmployeeCards,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ErpEmployeeCards, r),
  },
  [LedgerTableName.PpeNormSets]: {
    drizzle: ppeNormSets,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.PpeNormSets, r),
  },
  [LedgerTableName.PpeNormLines]: {
    drizzle: ppeNormLines,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.PpeNormLines, r),
  },
  [LedgerTableName.PpeIssueCards]: {
    drizzle: ppeIssueCards,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.PpeIssueCards, r),
  },
  [LedgerTableName.PpeCardNorms]: {
    drizzle: ppeCardNorms,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.PpeCardNorms, r),
  },
  [LedgerTableName.PpeIssueEntries]: {
    drizzle: ppeIssueEntries,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.PpeIssueEntries, r),
  },
  [LedgerTableName.PpeAbsences]: {
    drizzle: ppeAbsences,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.PpeAbsences, r),
  },
  [LedgerTableName.PpeGroups]: {
    drizzle: ppeGroups,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.PpeGroups, r),
  },
  [LedgerTableName.PpeGroupMembers]: {
    drizzle: ppeGroupMembers,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.PpeGroupMembers, r),
  },
  [LedgerTableName.PpeGroupNorms]: {
    drizzle: ppeGroupNorms,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.PpeGroupNorms, r),
  },
  [LedgerTableName.PpeCollectives]: {
    drizzle: ppeCollectives,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.PpeCollectives, r),
  },
  [LedgerTableName.PpeCollectiveLines]: {
    drizzle: ppeCollectiveLines,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.PpeCollectiveLines, r),
  },
  [LedgerTableName.SignatureDefaults]: {
    drizzle: signatureDefaults,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.SignatureDefaults, r),
  },
};
