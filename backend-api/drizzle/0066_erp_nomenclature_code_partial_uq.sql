-- Make erp_nomenclature_code_uq PARTIAL (exclude soft-deleted rows), matching the
-- convention of the other identity uniques in schema.ts (directory_workshops_code_uq,
-- warehouse_locations_code_uq, users_username_uq, file_assets_sha256_uq, …).
--
-- Why: a dedupe-merge (directoryPartsDedupeService.mergeDirectoryParts) soft-deletes the
-- loser nomenclature but leaves it holding the pre-merge code, so the pair ends up with
-- two rows sharing that code (one active survivor + one soft-deleted loser). The old GLOBAL
-- unique counted soft-deleted rows, so a full replayLedgerToDb / cold-rebuild — which upserts
-- includeDeleted rows from the ledger — collided on the shared code. Confirmed on prod: pair
-- 3301-15-30 «Картер» (survivor 439822f4 active + loser 03d3185a deleted, both code 3301-15-30
-- in ledger state) is the only duplicate code across 281 ledger nomenclature rows. Excluding
-- deleted rows from the index defuses this for every past and future merge.
--
-- Safe to create: the current GLOBAL unique guarantees no two rows (let alone two active rows)
-- share a code in PG, so the partial subset is trivially unique at apply time.
DROP INDEX IF EXISTS "erp_nomenclature_code_uq";
CREATE UNIQUE INDEX IF NOT EXISTS "erp_nomenclature_code_uq"
  ON "erp_nomenclature" ("code")
  WHERE "deleted_at" IS NULL;
