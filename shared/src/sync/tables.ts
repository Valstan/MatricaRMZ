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
  CardDrafts: 'card_drafts',
  AiChatRequests: 'ai_chat_requests',
  ErpNomenclature: 'erp_nomenclature',
  ErpEngineAssemblyBom: 'erp_engine_assembly_bom',
  ErpEngineAssemblyBomLines: 'erp_engine_assembly_bom_lines',
  ErpEngineAssemblyBomBrandLinks: 'erp_engine_assembly_bom_brand_links',
  ErpEngineInstances: 'erp_engine_instances',
  ErpRegStockBalance: 'erp_reg_stock_balance',
  ErpRegStockMovements: 'erp_reg_stock_movements',
  // Список деталей двигателя построчно (план engine-inventory-lines-2026-09). Первая
  // строгая таблица, которую клиенты будут ПИСАТЬ (push) — с E2; в E1 сервер выводит
  // строки из meta_json листа сам, клиенты только читают.
  ErpEngineInventoryLines: 'erp_engine_inventory_lines',
  // B3/R3: аккаунты и доступы по разделам. Обе — server-write / pull-only:
  // клиент их только читает (офлайн-гейт разделов), а любая клиентская запись
  // отбивается табличным backstop'ом в ledgerAuthzGuard. Секрет (user_credentials)
  // и настройки (user_settings) в контракт НЕ входят — это свойство конструкции,
  // а не фильтр, и его стережёт usersStrictContract.guard.test.ts.
  // Справочник складов и цехов: server-write / pull-only, как users. На клиенте он нужен
  // офлайн (разрез отчётов «по цехам» строится по типу локации), а жил только на сервере —
  // отчёт при отсутствии связи не мог отличить цех от склада и отдавал пустоту (M112).
  WarehouseLocations: 'warehouse_locations',
  Users: 'users',
  UserSectionAccess: 'user_section_access',
} as const;

export type SyncTableName = (typeof SyncTableName)[keyof typeof SyncTableName];


