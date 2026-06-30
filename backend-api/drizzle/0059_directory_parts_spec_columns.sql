-- Phase 2 (parts→nomenclature, Variant A): part-spec columns on directory_parts.
-- Additive, all NULL-able — safe on existing data. `code` = article/SKU; the other
-- three hold the part-only spec fields that are NOT mirrored into erp_nomenclature
-- (see docs/MIGRATION_PARTS_TO_NOMENCLATURE.md). Backfill is a separate script step.

ALTER TABLE "directory_parts" ADD COLUMN IF NOT EXISTS "code" text;
ALTER TABLE "directory_parts" ADD COLUMN IF NOT EXISTS "template_id" uuid;
ALTER TABLE "directory_parts" ADD COLUMN IF NOT EXISTS "dimensions_json" text;
ALTER TABLE "directory_parts" ADD COLUMN IF NOT EXISTS "brand_links_json" text;

CREATE INDEX IF NOT EXISTS "directory_parts_code_idx" ON "directory_parts" ("code");
