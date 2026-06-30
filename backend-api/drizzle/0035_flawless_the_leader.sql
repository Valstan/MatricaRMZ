CREATE TABLE IF NOT EXISTS "erp_nomenclature" (
  "id" uuid PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "item_type" text DEFAULT 'material' NOT NULL,
  "group_id" uuid,
  "unit_id" uuid,
  "barcode" text,
  "min_stock" integer,
  "max_stock" integer,
  "default_warehouse_id" text,
  "spec_json" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "erp_nomenclature" ADD CONSTRAINT "erp_nomenclature_group_id_entities_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "erp_nomenclature" ADD CONSTRAINT "erp_nomenclature_unit_id_entities_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_nomenclature_code_uq" ON "erp_nomenclature" USING btree ("code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_nomenclature_item_type_idx" ON "erp_nomenclature" USING btree ("item_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_nomenclature_group_idx" ON "erp_nomenclature" USING btree ("group_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_nomenclature_name_idx" ON "erp_nomenclature" USING btree ("name");
--> statement-breakpoint

ALTER TABLE "erp_reg_stock_balance" ADD COLUMN IF NOT EXISTS "nomenclature_id" uuid;
--> statement-breakpoint
ALTER TABLE "erp_reg_stock_balance" ALTER COLUMN "part_card_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_reg_stock_balance" ADD COLUMN IF NOT EXISTS "reserved_qty" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "erp_reg_stock_balance" ADD CONSTRAINT "erp_reg_stock_balance_nomenclature_id_erp_nomenclature_id_fk" FOREIGN KEY ("nomenclature_id") REFERENCES "public"."erp_nomenclature"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "erp_reg_stock_balance_part_warehouse_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_reg_stock_balance_part_warehouse_uq"
  ON "erp_reg_stock_balance" USING btree ("part_card_id", "warehouse_id")
  WHERE "erp_reg_stock_balance"."part_card_id" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_reg_stock_balance_nomenclature_warehouse_uq"
  ON "erp_reg_stock_balance" USING btree ("nomenclature_id", "warehouse_id")
  WHERE "erp_reg_stock_balance"."nomenclature_id" is not null;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "erp_reg_stock_movements" (
  "id" uuid PRIMARY KEY NOT NULL,
  "nomenclature_id" uuid NOT NULL,
  "warehouse_id" text DEFAULT 'default' NOT NULL,
  "document_header_id" uuid,
  "movement_type" text NOT NULL,
  "qty" integer DEFAULT 0 NOT NULL,
  "direction" text NOT NULL,
  "counterparty_id" uuid,
  "reason" text,
  "performed_at" bigint NOT NULL,
  "performed_by" text,
  "created_at" bigint NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "erp_reg_stock_movements" ADD CONSTRAINT "erp_reg_stock_movements_nomenclature_id_erp_nomenclature_id_fk" FOREIGN KEY ("nomenclature_id") REFERENCES "public"."erp_nomenclature"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "erp_reg_stock_movements" ADD CONSTRAINT "erp_reg_stock_movements_document_header_id_erp_document_headers_id_fk" FOREIGN KEY ("document_header_id") REFERENCES "public"."erp_document_headers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "erp_reg_stock_movements" ADD CONSTRAINT "erp_reg_stock_movements_counterparty_id_erp_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."erp_counterparties"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_reg_stock_movements_nomenclature_warehouse_idx"
  ON "erp_reg_stock_movements" USING btree ("nomenclature_id", "warehouse_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_reg_stock_movements_header_idx"
  ON "erp_reg_stock_movements" USING btree ("document_header_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_reg_stock_movements_performed_at_idx"
  ON "erp_reg_stock_movements" USING btree ("performed_at");
