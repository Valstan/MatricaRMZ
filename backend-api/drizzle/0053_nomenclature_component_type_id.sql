-- Block C of v1.22.0 plan: dedicated component_type_id column on erp_nomenclature.
--
-- Until v1.22.0 the BOM "component type" of a nomenclature row lived inside
-- erp_nomenclature.spec_json (a free-form text/JSON column). Reading it on
-- every request required JSON parsing in JS (see resolveNomenclatureComponentTypeId
-- in shared/src/domain/warehouse.ts). This migration introduces a native
-- nullable text column + a partial index so that:
--   - reads use a real column (no JSON parsing on hot path),
--   - filtering BOM nomenclature by component type can be indexed,
--   - the transitional period keeps reading spec_json as a fallback (shared
--     code) so old clients that still write the EAV-shaped value keep working.
--
-- Backfill is intentionally NOT inlined here. PostgreSQL would have to parse
-- spec_json text → JSONB → key extraction inside a single UPDATE, and any
-- malformed row would abort the migration. The companion admin script
-- migrateComponentTypeFromSpecJson.ts handles it with --dry-run/--apply +
-- per-row tolerance for malformed JSON.
--
-- Behavior:
--   - New column is nullable, default NULL. ADD COLUMN of a nullable text in
--     PostgreSQL is metadata-only — atomic, no table rewrite.
--   - Partial index covers only non-deleted rows (matches every query path).
--   - Drizzle schema gains a matching field in the same release so backend
--     reads see the new column via `...row` spread; UI (block D) starts writing
--     to the column directly.

ALTER TABLE erp_nomenclature
  ADD COLUMN IF NOT EXISTS component_type_id text;

CREATE INDEX IF NOT EXISTS erp_nomenclature_component_type_idx
  ON erp_nomenclature (component_type_id)
  WHERE deleted_at IS NULL;
