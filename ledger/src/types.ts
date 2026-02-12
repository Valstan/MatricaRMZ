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
  ErpPartTemplates: 'erp_part_templates',
  ErpPartCards: 'erp_part_cards',
  ErpToolTemplates: 'erp_tool_templates',
  ErpToolCards: 'erp_tool_cards',
  ErpCounterparties: 'erp_counterparties',
  ErpContracts: 'erp_contracts',
  ErpEmployeeCards: 'erp_employee_cards',
  ErpDocumentHeaders: 'erp_document_headers',
  ErpDocumentLines: 'erp_document_lines',
  ErpRegStockBalance: 'erp_reg_stock_balance',
  ErpRegPartUsage: 'erp_reg_part_usage',
  ErpRegContractSettlement: 'erp_reg_contract_settlement',
  ErpRegEmployeeAccess: 'erp_reg_employee_access',
  ErpJournalDocuments: 'erp_journal_documents',
  Users: 'users',
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

export type LedgerSignedTx = LedgerTxPayload & {
  seq: number;
  tx_id: string;
  signature: string;
  public_key: string;
};

export type LedgerBlock = {
  height: number;
  prev_hash: string;
  created_at: number;
  txs: LedgerSignedTx[];
  hash: string;
};

export type LedgerState = {
  tables: Record<LedgerTableName, Record<string, Record<string, unknown>>>;
};

export function emptyLedgerState(): LedgerState {
  return {
    tables: {
      entity_types: {},
      entities: {},
      attribute_defs: {},
      attribute_values: {},
      operations: {},
      audit_log: {},
      chat_messages: {},
      chat_reads: {},
      user_presence: {},
      notes: {},
      note_shares: {},
      erp_part_templates: {},
      erp_part_cards: {},
      erp_tool_templates: {},
      erp_tool_cards: {},
      erp_counterparties: {},
      erp_contracts: {},
      erp_employee_cards: {},
      erp_document_headers: {},
      erp_document_lines: {},
      erp_reg_stock_balance: {},
      erp_reg_part_usage: {},
      erp_reg_contract_settlement: {},
      erp_reg_employee_access: {},
      erp_journal_documents: {},
      users: {},
      permissions: {},
      user_permissions: {},
      permission_delegations: {},
      file_assets: {},
      client_settings: {},
      release_registry: {},
    },
  };
}

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
