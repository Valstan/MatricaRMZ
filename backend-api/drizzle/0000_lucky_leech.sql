CREATE TABLE "attribute_defs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_type_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"data_type" text NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"meta_json" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_server_seq" bigint,
	"deleted_at" bigint,
	"sync_status" text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attribute_values" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_id" uuid NOT NULL,
	"attribute_def_id" uuid NOT NULL,
	"value_json" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_server_seq" bigint,
	"deleted_at" bigint,
	"sync_status" text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_id" uuid,
	"table_name" text,
	"payload_json" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_server_seq" bigint,
	"deleted_at" bigint,
	"sync_status" text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_log" (
	"server_seq" bigserial PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"op" text NOT NULL,
	"payload_json" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"root_entity_id" uuid,
	"before_json" text,
	"after_json" text NOT NULL,
	"record_owner_user_id" uuid,
	"record_owner_username" text,
	"change_author_user_id" uuid NOT NULL,
	"change_author_username" text NOT NULL,
	"note" text,
	"created_at" bigint NOT NULL,
	"decided_at" bigint,
	"decided_by_user_id" uuid,
	"decided_by_username" text
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sender_user_id" uuid NOT NULL,
	"sender_username" text NOT NULL,
	"recipient_user_id" uuid,
	"message_type" text NOT NULL,
	"body_text" text,
	"payload_json" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_server_seq" bigint,
	"deleted_at" bigint,
	"sync_status" text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_reads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_server_seq" bigint,
	"deleted_at" bigint,
	"sync_status" text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_settings" (
	"client_id" text PRIMARY KEY NOT NULL,
	"updates_enabled" boolean DEFAULT true NOT NULL,
	"torrent_enabled" boolean DEFAULT true NOT NULL,
	"logging_enabled" boolean DEFAULT true NOT NULL,
	"logging_mode" text DEFAULT 'dev' NOT NULL,
	"ui_global_settings_json" text,
	"bom_relation_schema_json" text,
	"ui_defaults_version" integer DEFAULT 1 NOT NULL,
	"sync_request_id" text,
	"sync_request_type" text,
	"sync_request_at" bigint,
	"sync_request_payload" text,
	"last_seen_at" bigint,
	"last_version" text,
	"last_ip" text,
	"last_hostname" text,
	"last_platform" text,
	"last_arch" text,
	"last_username" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "command_idempotency" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_operation_id" text NOT NULL,
	"command_type" text NOT NULL,
	"aggregate_id" text,
	"request_json" text,
	"response_json" text,
	"status" text DEFAULT 'applied' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diagnostics_entity_diffs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"payload_json" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diagnostics_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"client_id" text,
	"payload_json" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory_engine_brands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata_json" text,
	"deprecated_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "directory_goods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata_json" text,
	"deprecated_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "directory_parts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata_json" text,
	"deprecated_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "directory_services" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata_json" text,
	"legacy_service_entity_id" uuid,
	"deprecated_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "directory_tools" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata_json" text,
	"deprecated_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type_id" uuid NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_server_seq" bigint,
	"deleted_at" bigint,
	"sync_status" text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_server_seq" bigint,
	"deleted_at" bigint,
	"sync_status" text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "erp_contracts" (
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
--> statement-breakpoint
CREATE TABLE "erp_counterparties" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"attrs_json" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "erp_document_headers" (
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
--> statement-breakpoint
CREATE TABLE "erp_document_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"header_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"part_card_id" uuid,
	"nomenclature_id" uuid,
	"qty" integer DEFAULT 0 NOT NULL,
	"price" bigint,
	"payload_json" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "erp_employee_cards" (
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
--> statement-breakpoint
CREATE TABLE "erp_engine_assembly_bom" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"engine_brand_id" uuid NOT NULL,
	"engine_nomenclature_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint,
	"sync_status" text DEFAULT 'synced' NOT NULL,
	"last_server_seq" bigint
);
--> statement-breakpoint
CREATE TABLE "erp_engine_assembly_bom_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bom_id" uuid NOT NULL,
	"component_nomenclature_id" uuid NOT NULL,
	"component_type" text DEFAULT 'other' NOT NULL,
	"qty_per_unit" integer DEFAULT 1 NOT NULL,
	"variant_group" text,
	"is_required" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"notes" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint,
	"sync_status" text DEFAULT 'synced' NOT NULL,
	"last_server_seq" bigint
);
--> statement-breakpoint
CREATE TABLE "erp_engine_instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"nomenclature_id" uuid NOT NULL,
	"serial_number" text NOT NULL,
	"contract_id" uuid,
	"contract_section_number" text,
	"current_status" text DEFAULT 'in_stock' NOT NULL,
	"warehouse_id" text DEFAULT 'default' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint,
	"sync_status" text DEFAULT 'synced' NOT NULL,
	"last_server_seq" bigint
);
--> statement-breakpoint
CREATE TABLE "erp_journal_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_header_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"event_payload_json" text,
	"event_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "erp_nomenclature" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"sku" text,
	"name" text NOT NULL,
	"item_type" text DEFAULT 'material' NOT NULL,
	"category" text,
	"directory_kind" text,
	"directory_ref_id" uuid,
	"group_id" uuid,
	"unit_id" uuid,
	"barcode" text,
	"min_stock" integer,
	"max_stock" integer,
	"default_brand_id" uuid,
	"is_serial_tracked" boolean DEFAULT false NOT NULL,
	"default_warehouse_id" text,
	"spec_json" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"sync_status" text DEFAULT 'synced' NOT NULL,
	"last_server_seq" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "erp_nomenclature_engine_brand" (
	"id" uuid PRIMARY KEY NOT NULL,
	"nomenclature_id" uuid NOT NULL,
	"engine_brand_id" uuid NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint,
	"sync_status" text DEFAULT 'synced' NOT NULL,
	"last_server_seq" bigint
);
--> statement-breakpoint
CREATE TABLE "erp_part_cards" (
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
--> statement-breakpoint
CREATE TABLE "erp_part_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"spec_json" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "erp_planned_incoming" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_header_id" uuid NOT NULL,
	"expected_date" bigint NOT NULL,
	"warehouse_id" text DEFAULT 'default' NOT NULL,
	"nomenclature_id" uuid NOT NULL,
	"qty" integer DEFAULT 0 NOT NULL,
	"unit" text,
	"source_type" text NOT NULL,
	"source_ref" text,
	"note" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "erp_reg_contract_settlement" (
	"id" uuid PRIMARY KEY NOT NULL,
	"contract_id" uuid NOT NULL,
	"document_header_id" uuid NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	"direction" text DEFAULT 'debit' NOT NULL,
	"at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "erp_reg_employee_access" (
	"id" uuid PRIMARY KEY NOT NULL,
	"employee_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"allowed" boolean DEFAULT true NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "erp_reg_part_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"part_card_id" uuid NOT NULL,
	"engine_id" uuid,
	"document_line_id" uuid,
	"qty" integer DEFAULT 0 NOT NULL,
	"used_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "erp_reg_stock_balance" (
	"id" uuid PRIMARY KEY NOT NULL,
	"nomenclature_id" uuid,
	"part_card_id" uuid,
	"warehouse_id" text DEFAULT 'default' NOT NULL,
	"qty" integer DEFAULT 0 NOT NULL,
	"reserved_qty" integer DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "erp_reg_stock_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"nomenclature_id" uuid NOT NULL,
	"warehouse_id" text DEFAULT 'default' NOT NULL,
	"document_header_id" uuid,
	"movement_type" text NOT NULL,
	"qty" integer DEFAULT 0 NOT NULL,
	"direction" text NOT NULL,
	"counterparty_id" uuid,
	"reason" text,
	"performed_at" bigint NOT NULL,
	"performed_by" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "erp_tool_cards" (
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
--> statement-breakpoint
CREATE TABLE "erp_tool_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"spec_json" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "file_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" bigint NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mime" text,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"storage_kind" text NOT NULL,
	"local_rel_path" text,
	"yandex_disk_path" text,
	"preview_mime" text,
	"preview_size" bigint,
	"preview_local_rel_path" text,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "ledger_tx_index" (
	"server_seq" bigint PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"op" text NOT NULL,
	"payload_json" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note_shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"note_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_server_seq" bigint,
	"deleted_at" bigint,
	"sync_status" text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body_json" text,
	"importance" text DEFAULT 'normal' NOT NULL,
	"due_at" bigint,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_server_seq" bigint,
	"deleted_at" bigint,
	"sync_status" text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"engine_entity_id" uuid NOT NULL,
	"operation_type" text NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"performed_at" bigint,
	"performed_by" text,
	"meta_json" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_server_seq" bigint,
	"deleted_at" bigint,
	"sync_status" text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_delegations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"perm_code" text NOT NULL,
	"starts_at" bigint NOT NULL,
	"ends_at" bigint NOT NULL,
	"note" text,
	"created_at" bigint NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"revoked_at" bigint,
	"revoked_by_user_id" uuid,
	"revoke_note" text
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"code" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "row_owners" (
	"id" uuid PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"owner_username" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "statistics_audit_daily" (
	"id" uuid PRIMARY KEY NOT NULL,
	"summary_date" text NOT NULL,
	"cutoff_hour" integer NOT NULL,
	"login" text NOT NULL,
	"full_name" text NOT NULL,
	"online_ms" bigint NOT NULL,
	"created_count" integer NOT NULL,
	"updated_count" integer NOT NULL,
	"deleted_count" integer NOT NULL,
	"total_changed" integer NOT NULL,
	"generated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "statistics_audit_events" (
	"source_audit_id" uuid PRIMARY KEY NOT NULL,
	"created_at" bigint NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"action_type" text NOT NULL,
	"section" text NOT NULL,
	"action_text" text NOT NULL,
	"document_label" text,
	"client_id" text,
	"table_name" text,
	"processed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"client_id" text PRIMARY KEY NOT NULL,
	"last_pulled_server_seq" bigint DEFAULT 0 NOT NULL,
	"last_pushed_at" bigint,
	"last_pulled_at" bigint
);
--> statement-breakpoint
CREATE TABLE "user_permissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"perm_code" text NOT NULL,
	"allowed" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_presence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"last_activity_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_server_seq" bigint,
	"deleted_at" bigint,
	"sync_status" text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
ALTER TABLE "attribute_defs" ADD CONSTRAINT "attribute_defs_entity_type_id_entity_types_id_fk" FOREIGN KEY ("entity_type_id") REFERENCES "public"."entity_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_values" ADD CONSTRAINT "attribute_values_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_values" ADD CONSTRAINT "attribute_values_attribute_def_id_attribute_defs_id_fk" FOREIGN KEY ("attribute_def_id") REFERENCES "public"."attribute_defs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_record_owner_user_id_entities_id_fk" FOREIGN KEY ("record_owner_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_change_author_user_id_entities_id_fk" FOREIGN KEY ("change_author_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_decided_by_user_id_entities_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sender_user_id_entities_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_recipient_user_id_entities_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reads" ADD CONSTRAINT "chat_reads_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reads" ADD CONSTRAINT "chat_reads_user_id_entities_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_services" ADD CONSTRAINT "directory_services_legacy_service_entity_id_entities_id_fk" FOREIGN KEY ("legacy_service_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_type_id_entity_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."entity_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_contracts" ADD CONSTRAINT "erp_contracts_counterparty_id_erp_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."erp_counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_document_headers" ADD CONSTRAINT "erp_document_headers_author_id_erp_employee_cards_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."erp_employee_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_document_lines" ADD CONSTRAINT "erp_document_lines_header_id_erp_document_headers_id_fk" FOREIGN KEY ("header_id") REFERENCES "public"."erp_document_headers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_document_lines" ADD CONSTRAINT "erp_document_lines_part_card_id_erp_part_cards_id_fk" FOREIGN KEY ("part_card_id") REFERENCES "public"."erp_part_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_document_lines" ADD CONSTRAINT "erp_document_lines_nomenclature_id_erp_nomenclature_id_fk" FOREIGN KEY ("nomenclature_id") REFERENCES "public"."erp_nomenclature"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_engine_assembly_bom" ADD CONSTRAINT "erp_engine_assembly_bom_engine_brand_id_entities_id_fk" FOREIGN KEY ("engine_brand_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_engine_assembly_bom" ADD CONSTRAINT "erp_engine_assembly_bom_engine_nomenclature_id_erp_nomenclature_id_fk" FOREIGN KEY ("engine_nomenclature_id") REFERENCES "public"."erp_nomenclature"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_engine_assembly_bom_lines" ADD CONSTRAINT "erp_engine_assembly_bom_lines_bom_id_erp_engine_assembly_bom_id_fk" FOREIGN KEY ("bom_id") REFERENCES "public"."erp_engine_assembly_bom"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_engine_assembly_bom_lines" ADD CONSTRAINT "erp_engine_assembly_bom_lines_component_nomenclature_id_erp_nomenclature_id_fk" FOREIGN KEY ("component_nomenclature_id") REFERENCES "public"."erp_nomenclature"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_engine_instances" ADD CONSTRAINT "erp_engine_instances_nomenclature_id_erp_nomenclature_id_fk" FOREIGN KEY ("nomenclature_id") REFERENCES "public"."erp_nomenclature"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_engine_instances" ADD CONSTRAINT "erp_engine_instances_contract_id_erp_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."erp_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_journal_documents" ADD CONSTRAINT "erp_journal_documents_document_header_id_erp_document_headers_id_fk" FOREIGN KEY ("document_header_id") REFERENCES "public"."erp_document_headers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_nomenclature" ADD CONSTRAINT "erp_nomenclature_group_id_entities_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_nomenclature" ADD CONSTRAINT "erp_nomenclature_unit_id_entities_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_nomenclature" ADD CONSTRAINT "erp_nomenclature_default_brand_id_entities_id_fk" FOREIGN KEY ("default_brand_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_nomenclature_engine_brand" ADD CONSTRAINT "erp_nomenclature_engine_brand_nomenclature_id_erp_nomenclature_id_fk" FOREIGN KEY ("nomenclature_id") REFERENCES "public"."erp_nomenclature"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_nomenclature_engine_brand" ADD CONSTRAINT "erp_nomenclature_engine_brand_engine_brand_id_entities_id_fk" FOREIGN KEY ("engine_brand_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_part_cards" ADD CONSTRAINT "erp_part_cards_template_id_erp_part_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."erp_part_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_planned_incoming" ADD CONSTRAINT "erp_planned_incoming_document_header_id_erp_document_headers_id_fk" FOREIGN KEY ("document_header_id") REFERENCES "public"."erp_document_headers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_planned_incoming" ADD CONSTRAINT "erp_planned_incoming_nomenclature_id_erp_nomenclature_id_fk" FOREIGN KEY ("nomenclature_id") REFERENCES "public"."erp_nomenclature"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_reg_contract_settlement" ADD CONSTRAINT "erp_reg_contract_settlement_contract_id_erp_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."erp_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_reg_contract_settlement" ADD CONSTRAINT "erp_reg_contract_settlement_document_header_id_erp_document_headers_id_fk" FOREIGN KEY ("document_header_id") REFERENCES "public"."erp_document_headers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_reg_employee_access" ADD CONSTRAINT "erp_reg_employee_access_employee_id_erp_employee_cards_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."erp_employee_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_reg_part_usage" ADD CONSTRAINT "erp_reg_part_usage_part_card_id_erp_part_cards_id_fk" FOREIGN KEY ("part_card_id") REFERENCES "public"."erp_part_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_reg_part_usage" ADD CONSTRAINT "erp_reg_part_usage_engine_id_entities_id_fk" FOREIGN KEY ("engine_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_reg_part_usage" ADD CONSTRAINT "erp_reg_part_usage_document_line_id_erp_document_lines_id_fk" FOREIGN KEY ("document_line_id") REFERENCES "public"."erp_document_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_reg_stock_balance" ADD CONSTRAINT "erp_reg_stock_balance_nomenclature_id_erp_nomenclature_id_fk" FOREIGN KEY ("nomenclature_id") REFERENCES "public"."erp_nomenclature"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_reg_stock_balance" ADD CONSTRAINT "erp_reg_stock_balance_part_card_id_erp_part_cards_id_fk" FOREIGN KEY ("part_card_id") REFERENCES "public"."erp_part_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_reg_stock_movements" ADD CONSTRAINT "erp_reg_stock_movements_nomenclature_id_erp_nomenclature_id_fk" FOREIGN KEY ("nomenclature_id") REFERENCES "public"."erp_nomenclature"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_reg_stock_movements" ADD CONSTRAINT "erp_reg_stock_movements_document_header_id_erp_document_headers_id_fk" FOREIGN KEY ("document_header_id") REFERENCES "public"."erp_document_headers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_reg_stock_movements" ADD CONSTRAINT "erp_reg_stock_movements_counterparty_id_erp_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."erp_counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_tool_cards" ADD CONSTRAINT "erp_tool_cards_template_id_erp_tool_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."erp_tool_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_created_by_user_id_entities_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_shares" ADD CONSTRAINT "note_shares_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_shares" ADD CONSTRAINT "note_shares_recipient_user_id_entities_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_owner_user_id_entities_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_engine_entity_id_entities_id_fk" FOREIGN KEY ("engine_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_delegations" ADD CONSTRAINT "permission_delegations_from_user_id_entities_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_delegations" ADD CONSTRAINT "permission_delegations_to_user_id_entities_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_delegations" ADD CONSTRAINT "permission_delegations_perm_code_permissions_code_fk" FOREIGN KEY ("perm_code") REFERENCES "public"."permissions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_delegations" ADD CONSTRAINT "permission_delegations_created_by_user_id_entities_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_delegations" ADD CONSTRAINT "permission_delegations_revoked_by_user_id_entities_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_entities_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_owners" ADD CONSTRAINT "row_owners_owner_user_id_entities_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_entities_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_perm_code_permissions_code_fk" FOREIGN KEY ("perm_code") REFERENCES "public"."permissions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_presence" ADD CONSTRAINT "user_presence_id_entities_id_fk" FOREIGN KEY ("id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_presence" ADD CONSTRAINT "user_presence_user_id_entities_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_defs_type_code_uq" ON "attribute_defs" USING btree ("entity_type_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_values_entity_attr_uq" ON "attribute_values" USING btree ("entity_id","attribute_def_id");--> statement-breakpoint
CREATE UNIQUE INDEX "change_requests_status_id" ON "change_requests" USING btree ("status","id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_reads_message_user_uq" ON "chat_reads" USING btree ("message_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "command_idempotency_client_operation_uq" ON "command_idempotency" USING btree ("client_id","client_operation_id");--> statement-breakpoint
CREATE INDEX "command_idempotency_status_idx" ON "command_idempotency" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "diagnostics_entity_diffs_client_entity_created_idx" ON "diagnostics_entity_diffs" USING btree ("client_id","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "diagnostics_snapshots_scope_created_idx" ON "diagnostics_snapshots" USING btree ("scope","created_at");--> statement-breakpoint
CREATE INDEX "diagnostics_snapshots_client_scope_created_idx" ON "diagnostics_snapshots" USING btree ("client_id","scope","created_at");--> statement-breakpoint
CREATE INDEX "directory_engine_brands_name_idx" ON "directory_engine_brands" USING btree ("name");--> statement-breakpoint
CREATE INDEX "directory_goods_name_idx" ON "directory_goods" USING btree ("name");--> statement-breakpoint
CREATE INDEX "directory_parts_name_idx" ON "directory_parts" USING btree ("name");--> statement-breakpoint
CREATE INDEX "directory_services_name_idx" ON "directory_services" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "directory_services_legacy_service_entity_uq" ON "directory_services" USING btree ("legacy_service_entity_id") WHERE "directory_services"."legacy_service_entity_id" is not null;--> statement-breakpoint
CREATE INDEX "directory_tools_name_idx" ON "directory_tools" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_types_code_uq" ON "entity_types" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_contracts_code_uq" ON "erp_contracts" USING btree ("code");--> statement-breakpoint
CREATE INDEX "erp_contracts_counterparty_idx" ON "erp_contracts" USING btree ("counterparty_id");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_counterparties_code_uq" ON "erp_counterparties" USING btree ("code");--> statement-breakpoint
CREATE INDEX "erp_counterparties_name_idx" ON "erp_counterparties" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_document_headers_doc_no_uq" ON "erp_document_headers" USING btree ("doc_no");--> statement-breakpoint
CREATE INDEX "erp_document_headers_type_date_idx" ON "erp_document_headers" USING btree ("doc_type","doc_date");--> statement-breakpoint
CREATE INDEX "erp_document_headers_status_idx" ON "erp_document_headers" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_document_lines_header_line_uq" ON "erp_document_lines" USING btree ("header_id","line_no");--> statement-breakpoint
CREATE INDEX "erp_document_lines_part_idx" ON "erp_document_lines" USING btree ("part_card_id");--> statement-breakpoint
CREATE INDEX "erp_document_lines_nomenclature_idx" ON "erp_document_lines" USING btree ("nomenclature_id");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_employee_cards_personnel_no_uq" ON "erp_employee_cards" USING btree ("personnel_no");--> statement-breakpoint
CREATE INDEX "erp_employee_cards_full_name_idx" ON "erp_employee_cards" USING btree ("full_name");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_engine_assembly_bom_brand_version_uq" ON "erp_engine_assembly_bom" USING btree ("engine_brand_id","version") WHERE "erp_engine_assembly_bom"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "erp_engine_assembly_bom_brand_idx" ON "erp_engine_assembly_bom" USING btree ("engine_brand_id");--> statement-breakpoint
CREATE INDEX "erp_engine_assembly_bom_status_idx" ON "erp_engine_assembly_bom" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_engine_assembly_bom_active_default_brand_uq" ON "erp_engine_assembly_bom" USING btree ("engine_brand_id") WHERE "erp_engine_assembly_bom"."deleted_at" is null and "erp_engine_assembly_bom"."status" = 'active' and "erp_engine_assembly_bom"."is_default" = true;--> statement-breakpoint
CREATE INDEX "erp_engine_assembly_bom_lines_bom_idx" ON "erp_engine_assembly_bom_lines" USING btree ("bom_id");--> statement-breakpoint
CREATE INDEX "erp_engine_assembly_bom_lines_component_idx" ON "erp_engine_assembly_bom_lines" USING btree ("component_nomenclature_id");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_engine_assembly_bom_lines_variant_component_uq" ON "erp_engine_assembly_bom_lines" USING btree ("bom_id","variant_group","component_nomenclature_id","component_type") WHERE "erp_engine_assembly_bom_lines"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "erp_engine_instances_nomenclature_serial_uq" ON "erp_engine_instances" USING btree ("nomenclature_id","serial_number") WHERE "erp_engine_instances"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "erp_engine_instances_serial_idx" ON "erp_engine_instances" USING btree ("serial_number");--> statement-breakpoint
CREATE INDEX "erp_engine_instances_contract_idx" ON "erp_engine_instances" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "erp_engine_instances_contract_section_idx" ON "erp_engine_instances" USING btree ("contract_section_number");--> statement-breakpoint
CREATE INDEX "erp_engine_instances_warehouse_idx" ON "erp_engine_instances" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "erp_engine_instances_status_idx" ON "erp_engine_instances" USING btree ("current_status");--> statement-breakpoint
CREATE INDEX "erp_journal_documents_header_event_at_idx" ON "erp_journal_documents" USING btree ("document_header_id","event_at");--> statement-breakpoint
CREATE INDEX "erp_journal_documents_event_at_idx" ON "erp_journal_documents" USING btree ("event_at");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_nomenclature_code_uq" ON "erp_nomenclature" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_nomenclature_sku_uq" ON "erp_nomenclature" USING btree ("sku") WHERE "erp_nomenclature"."sku" is not null;--> statement-breakpoint
CREATE INDEX "erp_nomenclature_item_type_idx" ON "erp_nomenclature" USING btree ("item_type");--> statement-breakpoint
CREATE INDEX "erp_nomenclature_category_idx" ON "erp_nomenclature" USING btree ("category");--> statement-breakpoint
CREATE INDEX "erp_nomenclature_directory_kind_idx" ON "erp_nomenclature" USING btree ("directory_kind");--> statement-breakpoint
CREATE INDEX "erp_nomenclature_directory_ref_idx" ON "erp_nomenclature" USING btree ("directory_ref_id");--> statement-breakpoint
CREATE INDEX "erp_nomenclature_group_idx" ON "erp_nomenclature" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "erp_nomenclature_default_brand_idx" ON "erp_nomenclature" USING btree ("default_brand_id");--> statement-breakpoint
CREATE INDEX "erp_nomenclature_name_idx" ON "erp_nomenclature" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_nomenclature_engine_brand_uq" ON "erp_nomenclature_engine_brand" USING btree ("nomenclature_id","engine_brand_id") WHERE "erp_nomenclature_engine_brand"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "erp_nomenclature_engine_brand_nomenclature_idx" ON "erp_nomenclature_engine_brand" USING btree ("nomenclature_id");--> statement-breakpoint
CREATE INDEX "erp_nomenclature_engine_brand_brand_idx" ON "erp_nomenclature_engine_brand" USING btree ("engine_brand_id");--> statement-breakpoint
CREATE INDEX "erp_part_cards_template_idx" ON "erp_part_cards" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "erp_part_cards_card_no_idx" ON "erp_part_cards" USING btree ("card_no");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_part_templates_code_uq" ON "erp_part_templates" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_planned_incoming_doc_nomenclature_warehouse_uq" ON "erp_planned_incoming" USING btree ("document_header_id","nomenclature_id","warehouse_id") WHERE "erp_planned_incoming"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "erp_planned_incoming_expected_date_idx" ON "erp_planned_incoming" USING btree ("expected_date");--> statement-breakpoint
CREATE INDEX "erp_planned_incoming_warehouse_date_idx" ON "erp_planned_incoming" USING btree ("warehouse_id","expected_date");--> statement-breakpoint
CREATE INDEX "erp_planned_incoming_nomenclature_date_idx" ON "erp_planned_incoming" USING btree ("nomenclature_id","expected_date");--> statement-breakpoint
CREATE INDEX "erp_reg_contract_settlement_contract_at_idx" ON "erp_reg_contract_settlement" USING btree ("contract_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_reg_employee_access_employee_scope_uq" ON "erp_reg_employee_access" USING btree ("employee_id","scope");--> statement-breakpoint
CREATE INDEX "erp_reg_part_usage_part_used_at_idx" ON "erp_reg_part_usage" USING btree ("part_card_id","used_at");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_reg_stock_balance_part_warehouse_uq" ON "erp_reg_stock_balance" USING btree ("part_card_id","warehouse_id") WHERE "erp_reg_stock_balance"."part_card_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "erp_reg_stock_balance_nomenclature_warehouse_uq" ON "erp_reg_stock_balance" USING btree ("nomenclature_id","warehouse_id") WHERE "erp_reg_stock_balance"."nomenclature_id" is not null;--> statement-breakpoint
CREATE INDEX "erp_reg_stock_movements_nomenclature_warehouse_idx" ON "erp_reg_stock_movements" USING btree ("nomenclature_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "erp_reg_stock_movements_header_idx" ON "erp_reg_stock_movements" USING btree ("document_header_id");--> statement-breakpoint
CREATE INDEX "erp_reg_stock_movements_performed_at_idx" ON "erp_reg_stock_movements" USING btree ("performed_at");--> statement-breakpoint
CREATE INDEX "erp_tool_cards_template_idx" ON "erp_tool_cards" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "erp_tool_cards_card_no_idx" ON "erp_tool_cards" USING btree ("card_no");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_tool_templates_code_uq" ON "erp_tool_templates" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "file_assets_sha256_uq" ON "file_assets" USING btree ("sha256") WHERE "file_assets"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "ledger_tx_index_table_row_idx" ON "ledger_tx_index" USING btree ("table_name","row_id");--> statement-breakpoint
CREATE INDEX "ledger_tx_index_created_idx" ON "ledger_tx_index" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "note_shares_note_recipient_uq" ON "note_shares" USING btree ("note_id","recipient_user_id");--> statement-breakpoint
CREATE INDEX "note_shares_recipient_sort_idx" ON "note_shares" USING btree ("recipient_user_id","sort_order");--> statement-breakpoint
CREATE INDEX "notes_owner_sort_idx" ON "notes" USING btree ("owner_user_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "permission_delegations_to_user_perm_uq" ON "permission_delegations" USING btree ("to_user_id","perm_code","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "permissions_code_uq" ON "permissions" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_token_hash_uq" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "row_owners_table_row_uq" ON "row_owners" USING btree ("table_name","row_id");--> statement-breakpoint
CREATE UNIQUE INDEX "statistics_audit_daily_summary_login_uq" ON "statistics_audit_daily" USING btree ("summary_date","cutoff_hour","login");--> statement-breakpoint
CREATE INDEX "statistics_audit_daily_summary_date_idx" ON "statistics_audit_daily" USING btree ("summary_date","cutoff_hour");--> statement-breakpoint
CREATE INDEX "statistics_audit_events_created_idx" ON "statistics_audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "statistics_audit_events_actor_created_idx" ON "statistics_audit_events" USING btree ("actor","created_at");--> statement-breakpoint
CREATE INDEX "statistics_audit_events_type_created_idx" ON "statistics_audit_events" USING btree ("action_type","created_at");--> statement-breakpoint
CREATE INDEX "statistics_audit_events_section_created_idx" ON "statistics_audit_events" USING btree ("section","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_permissions_user_perm_uq" ON "user_permissions" USING btree ("user_id","perm_code");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_uq" ON "users" USING btree ("username") WHERE "users"."deleted_at" is null;