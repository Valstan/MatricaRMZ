ALTER TABLE "erp_nomenclature" ADD COLUMN "sku" text;
--> statement-breakpoint
ALTER TABLE "erp_nomenclature" ADD COLUMN "category" text;
--> statement-breakpoint
ALTER TABLE "erp_nomenclature" ADD COLUMN "default_brand_id" text;
--> statement-breakpoint
ALTER TABLE "erp_nomenclature" ADD COLUMN "is_serial_tracked" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_nomenclature" ADD COLUMN "sync_status" text DEFAULT 'synced' NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_nomenclature" ADD COLUMN "last_server_seq" integer;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_nomenclature_sku_uq" ON "erp_nomenclature" ("sku");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_nomenclature_category_idx" ON "erp_nomenclature" ("category");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_nomenclature_default_brand_idx" ON "erp_nomenclature" ("default_brand_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "erp_nomenclature_engine_brand" (
  "id" text PRIMARY KEY NOT NULL,
  "nomenclature_id" text NOT NULL,
  "engine_brand_id" text NOT NULL,
  "is_default" integer DEFAULT 0 NOT NULL,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL,
  "deleted_at" integer,
  "sync_status" text DEFAULT 'synced' NOT NULL,
  "last_server_seq" integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_nomenclature_engine_brand_uq"
  ON "erp_nomenclature_engine_brand" ("nomenclature_id", "engine_brand_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_nomenclature_engine_brand_nomenclature_idx"
  ON "erp_nomenclature_engine_brand" ("nomenclature_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_nomenclature_engine_brand_brand_idx"
  ON "erp_nomenclature_engine_brand" ("engine_brand_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "erp_engine_instances" (
  "id" text PRIMARY KEY NOT NULL,
  "nomenclature_id" text NOT NULL,
  "serial_number" text NOT NULL,
  "contract_id" text,
  "current_status" text DEFAULT 'in_stock' NOT NULL,
  "warehouse_id" text DEFAULT 'default' NOT NULL,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL,
  "deleted_at" integer,
  "sync_status" text DEFAULT 'synced' NOT NULL,
  "last_server_seq" integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_engine_instances_nomenclature_serial_uq"
  ON "erp_engine_instances" ("nomenclature_id", "serial_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_engine_instances_serial_idx" ON "erp_engine_instances" ("serial_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_engine_instances_contract_idx" ON "erp_engine_instances" ("contract_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_engine_instances_warehouse_idx" ON "erp_engine_instances" ("warehouse_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_engine_instances_status_idx" ON "erp_engine_instances" ("current_status");
