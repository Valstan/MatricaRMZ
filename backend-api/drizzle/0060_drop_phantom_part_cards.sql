-- Remove the dead part-card subsystem. On prod (v1.44.0) both tables hold 0 rows,
-- the ErpWorkspacePanel UI is unmounted, and every erp_document_lines.part_card_id /
-- erp_reg_stock_balance.part_card_id value is NULL — serial/part-card tracking was
-- abandoned (same as the frozen «разборка двигателя» flow).
--
-- Safe scope: drop the two phantom tables + their inbound FK constraints (via CASCADE);
-- the nullable part_card_id columns on the live synced tables (erp_document_lines,
-- erp_reg_stock_balance) and their sync contract are KEPT untouched, so no client
-- compatibility change. erp_reg_part_usage is dropped first (its part_card_id FK is
-- NOT NULL), then erp_part_cards with CASCADE to drop the remaining inbound FKs.
DROP TABLE IF EXISTS "erp_reg_part_usage";
--> statement-breakpoint
DROP TABLE IF EXISTS "erp_part_cards" CASCADE;
