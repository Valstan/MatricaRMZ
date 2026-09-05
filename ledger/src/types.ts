export const LedgerTableName = {
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
  ErpPartTemplates: 'erp_part_templates',
  ErpPartCards: 'erp_part_cards',
  ErpToolTemplates: 'erp_tool_templates',
  ErpToolCards: 'erp_tool_cards',
  ErpCounterparties: 'erp_counterparties',
  ErpContracts: 'erp_contracts',
  ErpEmployeeCards: 'erp_employee_cards',
  DirectoryEngineBrands: 'directory_engine_brands',
  DirectoryParts: 'directory_parts',
  DirectoryTools: 'directory_tools',
  DirectoryGoods: 'directory_goods',
  DirectoryServices: 'directory_services',
  ErpNomenclature: 'erp_nomenclature',
  ErpEngineAssemblyBom: 'erp_engine_assembly_bom',
  ErpEngineAssemblyBomLines: 'erp_engine_assembly_bom_lines',
  ErpEngineAssemblyBomBrandLinks: 'erp_engine_assembly_bom_brand_links',
  ErpEngineInstances: 'erp_engine_instances',
  ErpEngineInventoryLines: 'erp_engine_inventory_lines',
  ErpDocumentHeaders: 'erp_document_headers',
  ErpDocumentLines: 'erp_document_lines',
  ErpRegStockBalance: 'erp_reg_stock_balance',
  ErpRegStockMovements: 'erp_reg_stock_movements',
  ErpRegPartUsage: 'erp_reg_part_usage',
  ErpRegContractSettlement: 'erp_reg_contract_settlement',
  ErpRegEmployeeAccess: 'erp_reg_employee_access',
  ErpJournalDocuments: 'erp_journal_documents',
  // 'users' — легаси-имя от таблицы, снесённой миграцией 0072; с B3/R3 его
  // переиспользует строгая таблица аккаунтов (новое имя не заводим, иначе в
  // enum'е окажутся два имени одной таблицы).
  Users: 'users',
  UserSectionAccess: 'user_section_access',
  Permissions: 'permissions',
  UserPermissions: 'user_permissions',
  PermissionDelegations: 'permission_delegations',
  FileAssets: 'file_assets',
  ClientSettings: 'client_settings',
  ReleaseRegistry: 'release_registry',
} as const;

export type LedgerTableName = (typeof LedgerTableName)[keyof typeof LedgerTableName];

export type LedgerTxType =
  | 'upsert'
  | 'delete'
  | 'grant'
  | 'revoke'
  | 'presence'
  | 'chat';

export type LedgerActor = {
  userId: string;
  username: string;
  role: string;
};

export type LedgerTxPayload = {
  type: LedgerTxType;
  table: LedgerTableName;
  row?: Record<string, unknown>;
  row_id?: string;
  actor: LedgerActor;
  ts: number;
};

// Транзакция журнала с выданным номером. `signature`/`public_key` остались от цепочки
// блоков (снята 2026-09, план ledger-journal-in-pg): журнал в PostgreSQL не подписывает.
export type LedgerSignedTx = LedgerTxPayload & {
  seq: number;
  tx_id: string;
  signature?: string;
  public_key?: string;
};


export function canonicalizeTxPayload(payload: LedgerTxPayload): string {
  const stable = {
    type: payload.type,
    table: payload.table,
    row_id: payload.row_id ?? null,
    row: payload.row ?? null,
    actor: payload.actor,
    ts: payload.ts,
  };
  return JSON.stringify(stable);
}
