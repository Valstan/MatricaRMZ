-- Phase 3.5 PR-2: drop the dead directory_parts.template_id column.
-- The part-template axis was removed in PR-1 (#275): the column is no longer read or
-- written (rowToPartSpec/upsertWarehouseNomenclaturePartSpec dropped it, PartSpec.templateId
-- removed). Pre-existing values were stale category-tag UUIDs with no behaviour. Server-only
-- table (not synced) → no client sync-contract impact. IF EXISTS keeps it idempotent.
ALTER TABLE "directory_parts" DROP COLUMN IF EXISTS "template_id";
