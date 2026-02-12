CREATE TABLE IF NOT EXISTS "erp_part_templates" (
  "id" uuid PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "spec_json" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_part_templates_code_uq" ON "erp_part_templates" ("code");

CREATE TABLE IF NOT EXISTS "erp_part_cards" (
  "id" uuid PRIMARY KEY NOT NULL,
  "template_id" uuid NOT NULL,
  "serial_no" text,
  "card_no" text,
  "attrs_json" text,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint
);
CREATE INDEX IF NOT EXISTS "erp_part_cards_template_idx" ON "erp_part_cards" ("template_id");
CREATE INDEX IF NOT EXISTS "erp_part_cards_card_no_idx" ON "erp_part_cards" ("card_no");

CREATE TABLE IF NOT EXISTS "erp_tool_templates" (
  "id" uuid PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "spec_json" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_tool_templates_code_uq" ON "erp_tool_templates" ("code");

CREATE TABLE IF NOT EXISTS "erp_tool_cards" (
  "id" uuid PRIMARY KEY NOT NULL,
  "template_id" uuid NOT NULL,
  "serial_no" text,
  "card_no" text,
  "attrs_json" text,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint
);
CREATE INDEX IF NOT EXISTS "erp_tool_cards_template_idx" ON "erp_tool_cards" ("template_id");
CREATE INDEX IF NOT EXISTS "erp_tool_cards_card_no_idx" ON "erp_tool_cards" ("card_no");

CREATE TABLE IF NOT EXISTS "erp_counterparties" (
  "id" uuid PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "attrs_json" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_counterparties_code_uq" ON "erp_counterparties" ("code");
CREATE INDEX IF NOT EXISTS "erp_counterparties_name_idx" ON "erp_counterparties" ("name");

CREATE TABLE IF NOT EXISTS "erp_contracts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "counterparty_id" uuid,
  "starts_at" bigint,
  "ends_at" bigint,
  "attrs_json" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_contracts_code_uq" ON "erp_contracts" ("code");
CREATE INDEX IF NOT EXISTS "erp_contracts_counterparty_idx" ON "erp_contracts" ("counterparty_id");

CREATE TABLE IF NOT EXISTS "erp_employee_cards" (
  "id" uuid PRIMARY KEY NOT NULL,
  "personnel_no" text,
  "full_name" text NOT NULL,
  "role_code" text,
  "attrs_json" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_employee_cards_personnel_no_uq" ON "erp_employee_cards" ("personnel_no");
CREATE INDEX IF NOT EXISTS "erp_employee_cards_full_name_idx" ON "erp_employee_cards" ("full_name");

CREATE TABLE IF NOT EXISTS "erp_document_headers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "doc_type" text NOT NULL,
  "doc_no" text NOT NULL,
  "doc_date" bigint NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "author_id" uuid,
  "department_id" text,
  "payload_json" text,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "posted_at" bigint,
  "deleted_at" bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_document_headers_doc_no_uq" ON "erp_document_headers" ("doc_no");
CREATE INDEX IF NOT EXISTS "erp_document_headers_type_date_idx" ON "erp_document_headers" ("doc_type", "doc_date");
CREATE INDEX IF NOT EXISTS "erp_document_headers_status_idx" ON "erp_document_headers" ("status");

CREATE TABLE IF NOT EXISTS "erp_document_lines" (
  "id" uuid PRIMARY KEY NOT NULL,
  "header_id" uuid NOT NULL,
  "line_no" integer NOT NULL,
  "part_card_id" uuid,
  "qty" integer DEFAULT 0 NOT NULL,
  "price" bigint,
  "payload_json" text,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_document_lines_header_line_uq" ON "erp_document_lines" ("header_id", "line_no");
CREATE INDEX IF NOT EXISTS "erp_document_lines_part_idx" ON "erp_document_lines" ("part_card_id");

CREATE TABLE IF NOT EXISTS "erp_reg_stock_balance" (
  "id" uuid PRIMARY KEY NOT NULL,
  "part_card_id" uuid NOT NULL,
  "warehouse_id" text DEFAULT 'default' NOT NULL,
  "qty" integer DEFAULT 0 NOT NULL,
  "updated_at" bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_reg_stock_balance_part_warehouse_uq" ON "erp_reg_stock_balance" ("part_card_id", "warehouse_id");

CREATE TABLE IF NOT EXISTS "erp_reg_part_usage" (
  "id" uuid PRIMARY KEY NOT NULL,
  "part_card_id" uuid NOT NULL,
  "engine_id" uuid,
  "document_line_id" uuid,
  "qty" integer DEFAULT 0 NOT NULL,
  "used_at" bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "erp_reg_part_usage_part_used_at_idx" ON "erp_reg_part_usage" ("part_card_id", "used_at");

CREATE TABLE IF NOT EXISTS "erp_reg_contract_settlement" (
  "id" uuid PRIMARY KEY NOT NULL,
  "contract_id" uuid NOT NULL,
  "document_header_id" uuid NOT NULL,
  "amount" bigint DEFAULT 0 NOT NULL,
  "direction" text DEFAULT 'debit' NOT NULL,
  "at" bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "erp_reg_contract_settlement_contract_at_idx" ON "erp_reg_contract_settlement" ("contract_id", "at");

CREATE TABLE IF NOT EXISTS "erp_reg_employee_access" (
  "id" uuid PRIMARY KEY NOT NULL,
  "employee_id" uuid NOT NULL,
  "scope" text NOT NULL,
  "allowed" boolean DEFAULT true NOT NULL,
  "updated_at" bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_reg_employee_access_employee_scope_uq" ON "erp_reg_employee_access" ("employee_id", "scope");

CREATE TABLE IF NOT EXISTS "erp_journal_documents" (
  "id" uuid PRIMARY KEY NOT NULL,
  "document_header_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "event_payload_json" text,
  "event_at" bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "erp_journal_documents_header_event_at_idx" ON "erp_journal_documents" ("document_header_id", "event_at");
CREATE INDEX IF NOT EXISTS "erp_journal_documents_event_at_idx" ON "erp_journal_documents" ("event_at");
