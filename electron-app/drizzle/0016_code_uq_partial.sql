-- Deep-dedup Ф1: erp_nomenclature code unique becomes PARTIAL on the client too.
-- (1) Parts without a real article now sync with an EMPTY code instead of a synthetic
--     DET- placeholder — many alive rows share '' and must not collide.
-- (2) Excluding soft-deleted rows also defuses the lurking merge-pair collision
--     (dedupe-merge leaves survivor + soft-deleted loser sharing the pre-merge code) —
--     the server index went partial in server migration 0066, the client one never did.
DROP INDEX IF EXISTS `erp_nomenclature_code_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `erp_nomenclature_code_uq` ON `erp_nomenclature` (`code`) WHERE `code` <> '' AND `deleted_at` IS NULL;
