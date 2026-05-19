-- Parts-movement / engine-assembly module (client-side mirror, MVP foundations).
-- All additive: NULL columns and indexes only.

ALTER TABLE "erp_document_headers" ADD COLUMN "workshop_id" text;
--> statement-breakpoint
ALTER TABLE "erp_reg_stock_movements" ADD COLUMN "engine_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_reg_stock_movements_engine_idx"
  ON "erp_reg_stock_movements" ("engine_id");
