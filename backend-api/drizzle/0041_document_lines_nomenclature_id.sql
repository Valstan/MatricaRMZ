-- Add nomenclature_id column to erp_document_lines for unified stock accounting.
-- Previously nomenclatureId was stored only in payload_json; this makes it a first-class column.

ALTER TABLE "erp_document_lines" ADD COLUMN IF NOT EXISTS "nomenclature_id" uuid;
DO $$ BEGIN
  ALTER TABLE "erp_document_lines" ADD CONSTRAINT "erp_document_lines_nomenclature_id_erp_nomenclature_id_fk"
    FOREIGN KEY ("nomenclature_id") REFERENCES "erp_nomenclature"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "erp_document_lines_nomenclature_idx" ON "erp_document_lines" ("nomenclature_id");
