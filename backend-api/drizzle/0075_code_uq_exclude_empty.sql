-- Deep-dedup Ф1 (owner decision 2026-07-12): parts without a real article get an
-- EMPTY code instead of a synthetic `DET-<id8>` placeholder. Many alive rows will
-- share '' → the partial unique on code must exclude empty strings as well as
-- soft-deleted rows (extends migration 0066).
DROP INDEX IF EXISTS "erp_nomenclature_code_uq";
CREATE UNIQUE INDEX "erp_nomenclature_code_uq" ON "erp_nomenclature" ("code") WHERE "deleted_at" is null and "code" <> '';
