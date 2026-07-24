CREATE TABLE "erp_stock_reservations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "document_header_id" uuid NOT NULL REFERENCES "erp_document_headers"("id"),
  "document_line_id" uuid NOT NULL REFERENCES "erp_document_lines"("id"),
  "nomenclature_id" uuid NOT NULL REFERENCES "erp_nomenclature"("id"),
  "warehouse_location_id" uuid NOT NULL REFERENCES "warehouse_locations"("id"),
  "qty" integer NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "released_at" bigint,
  "consumed_at" bigint
);
CREATE UNIQUE INDEX "erp_stock_reservations_active_doc_line_uq" ON "erp_stock_reservations" ("document_header_id", "document_line_id") WHERE "status" = 'active';
CREATE INDEX "erp_stock_reservations_document_idx" ON "erp_stock_reservations" ("document_header_id");
CREATE INDEX "erp_stock_reservations_balance_key_idx" ON "erp_stock_reservations" ("nomenclature_id", "warehouse_location_id");

CREATE TABLE "assembly_shortage_approvals" (
  "id" uuid PRIMARY KEY NOT NULL,
  "operation_id" uuid NOT NULL REFERENCES "operations"("id"),
  "material_hash" text NOT NULL,
  "shortage_json" text NOT NULL,
  "status" text DEFAULT 'requested' NOT NULL,
  "request_reason" text NOT NULL,
  "requested_by" uuid NOT NULL,
  "requested_at" bigint NOT NULL,
  "decided_by" uuid,
  "decided_at" bigint,
  "decision_reason" text,
  "invalidated_at" bigint
);
CREATE INDEX "assembly_shortage_approvals_operation_idx" ON "assembly_shortage_approvals" ("operation_id", "requested_at");
CREATE UNIQUE INDEX "assembly_shortage_approvals_active_operation_uq" ON "assembly_shortage_approvals" ("operation_id") WHERE "status" in ('requested', 'approved');
