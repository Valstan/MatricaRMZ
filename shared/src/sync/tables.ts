// Имена таблиц, участвующих в синхронизации.
// Делаем централизованно, чтобы клиент/сервер всегда совпадали.

export const SyncTableName = {
  EntityTypes: 'entity_types',
  Entities: 'entities',
  AttributeDefs: 'attribute_defs',
  AttributeValues: 'attribute_values',
  Operations: 'operations',
  AuditLog: 'audit_log',
  ChatMessages: 'chat_messages',
  ChatReads: 'chat_reads',
  UserPresence: 'user_presence',
  Notes: 'notes',
  NoteShares: 'note_shares',
  ErpNomenclature: 'erp_nomenclature',
  ErpNomenclatureEngineBrand: 'erp_nomenclature_engine_brand',
  ErpEngineAssemblyBom: 'erp_engine_assembly_bom',
  ErpEngineAssemblyBomLines: 'erp_engine_assembly_bom_lines',
  ErpEngineInstances: 'erp_engine_instances',
  ErpRegStockBalance: 'erp_reg_stock_balance',
  ErpRegStockMovements: 'erp_reg_stock_movements',
} as const;

export type SyncTableName = (typeof SyncTableName)[keyof typeof SyncTableName];


