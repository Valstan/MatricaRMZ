ALTER TABLE "erp_nomenclature" ADD COLUMN IF NOT EXISTS "sku" text;
--> statement-breakpoint
ALTER TABLE "erp_nomenclature" ADD COLUMN IF NOT EXISTS "category" text;
--> statement-breakpoint
ALTER TABLE "erp_nomenclature" ADD COLUMN IF NOT EXISTS "default_brand_id" uuid;
--> statement-breakpoint
ALTER TABLE "erp_nomenclature" ADD COLUMN IF NOT EXISTS "is_serial_tracked" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_nomenclature" ADD COLUMN IF NOT EXISTS "sync_status" text DEFAULT 'synced' NOT NULL;
--> statement-breakpoint
ALTER TABLE "erp_nomenclature" ADD COLUMN IF NOT EXISTS "last_server_seq" bigint;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "erp_nomenclature" ADD CONSTRAINT "erp_nomenclature_default_brand_id_entities_id_fk" FOREIGN KEY ("default_brand_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_nomenclature_sku_uq"
  ON "erp_nomenclature" USING btree ("sku")
  WHERE "erp_nomenclature"."sku" is not null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_nomenclature_category_idx" ON "erp_nomenclature" USING btree ("category");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_nomenclature_default_brand_idx" ON "erp_nomenclature" USING btree ("default_brand_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "erp_nomenclature_engine_brand" (
  "id" uuid PRIMARY KEY NOT NULL,
  "nomenclature_id" uuid NOT NULL,
  "engine_brand_id" uuid NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint,
  "sync_status" text DEFAULT 'synced' NOT NULL,
  "last_server_seq" bigint
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "erp_nomenclature_engine_brand" ADD CONSTRAINT "erp_nomenclature_engine_brand_nomenclature_id_fk" FOREIGN KEY ("nomenclature_id") REFERENCES "public"."erp_nomenclature"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "erp_nomenclature_engine_brand" ADD CONSTRAINT "erp_nomenclature_engine_brand_engine_brand_id_fk" FOREIGN KEY ("engine_brand_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_nomenclature_engine_brand_uq"
  ON "erp_nomenclature_engine_brand" USING btree ("nomenclature_id", "engine_brand_id")
  WHERE "erp_nomenclature_engine_brand"."deleted_at" is null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_nomenclature_engine_brand_nomenclature_idx"
  ON "erp_nomenclature_engine_brand" USING btree ("nomenclature_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_nomenclature_engine_brand_brand_idx"
  ON "erp_nomenclature_engine_brand" USING btree ("engine_brand_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "erp_engine_instances" (
  "id" uuid PRIMARY KEY NOT NULL,
  "nomenclature_id" uuid NOT NULL,
  "serial_number" text NOT NULL,
  "contract_id" uuid,
  "current_status" text DEFAULT 'in_stock' NOT NULL,
  "warehouse_id" text DEFAULT 'default' NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint,
  "sync_status" text DEFAULT 'synced' NOT NULL,
  "last_server_seq" bigint
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "erp_engine_instances" ADD CONSTRAINT "erp_engine_instances_nomenclature_id_fk" FOREIGN KEY ("nomenclature_id") REFERENCES "public"."erp_nomenclature"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "erp_engine_instances" ADD CONSTRAINT "erp_engine_instances_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."erp_contracts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_engine_instances_nomenclature_serial_uq"
  ON "erp_engine_instances" USING btree ("nomenclature_id", "serial_number")
  WHERE "erp_engine_instances"."deleted_at" is null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_engine_instances_serial_idx" ON "erp_engine_instances" USING btree ("serial_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_engine_instances_contract_idx" ON "erp_engine_instances" USING btree ("contract_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_engine_instances_warehouse_idx" ON "erp_engine_instances" USING btree ("warehouse_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_engine_instances_status_idx" ON "erp_engine_instances" USING btree ("current_status");
