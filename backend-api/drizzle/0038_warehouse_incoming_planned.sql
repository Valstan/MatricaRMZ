ALTER TABLE "erp_document_headers"
  ALTER COLUMN "status" SET DEFAULT 'draft';

CREATE TABLE IF NOT EXISTS "erp_planned_incoming" (
  "id" uuid PRIMARY KEY NOT NULL,
  "document_header_id" uuid NOT NULL REFERENCES "erp_document_headers"("id"),
  "expected_date" bigint NOT NULL,
  "warehouse_id" text NOT NULL DEFAULT 'default',
  "nomenclature_id" uuid NOT NULL REFERENCES "erp_nomenclature"("id"),
  "qty" integer NOT NULL DEFAULT 0,
  "unit" text,
  "source_type" text NOT NULL,
  "source_ref" text,
  "note" text,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint
);

CREATE UNIQUE INDEX IF NOT EXISTS "erp_planned_incoming_doc_nomenclature_warehouse_uq"
  ON "erp_planned_incoming" ("document_header_id", "nomenclature_id", "warehouse_id")
  WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "erp_planned_incoming_expected_date_idx"
  ON "erp_planned_incoming" ("expected_date");
CREATE INDEX IF NOT EXISTS "erp_planned_incoming_warehouse_date_idx"
  ON "erp_planned_incoming" ("warehouse_id", "expected_date");
CREATE INDEX IF NOT EXISTS "erp_planned_incoming_nomenclature_date_idx"
  ON "erp_planned_incoming" ("nomenclature_id", "expected_date");
