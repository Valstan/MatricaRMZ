export const ErpSyncTableName = {
  PartTemplates: 'erp_part_templates',
  PartCards: 'erp_part_cards',
  ToolTemplates: 'erp_tool_templates',
  ToolCards: 'erp_tool_cards',
  Counterparties: 'erp_counterparties',
  Contracts: 'erp_contracts',
  EmployeeCards: 'erp_employee_cards',
  DocumentHeaders: 'erp_document_headers',
  DocumentLines: 'erp_document_lines',
  RegisterStockBalance: 'erp_reg_stock_balance',
  RegisterPartUsage: 'erp_reg_part_usage',
  RegisterContractSettlement: 'erp_reg_contract_settlement',
  RegisterEmployeeAccess: 'erp_reg_employee_access',
  JournalDocuments: 'erp_journal_documents',
} as const;

export type ErpSyncTableName = (typeof ErpSyncTableName)[keyof typeof ErpSyncTableName];
