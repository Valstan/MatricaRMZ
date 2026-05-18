CREATE TABLE "erp_engine_assembly_bom_brand_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bom_id" uuid NOT NULL,
	"engine_brand_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint,
	"sync_status" text DEFAULT 'synced' NOT NULL,
	"last_server_seq" bigint
);
--> statement-breakpoint
CREATE TABLE "service_price_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"nomenclature_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"price" integer NOT NULL,
	"price_currency" text DEFAULT 'RUB' NOT NULL,
	"effective_from" bigint NOT NULL,
	"notes" text,
	"sync_status" text DEFAULT 'synced' NOT NULL,
	"last_server_seq" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "service_price_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_number" text NOT NULL,
	"order_date" bigint NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"document_link" text,
	"issued_by_employee_id" uuid,
	"effective_from" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"sync_status" text DEFAULT 'synced' NOT NULL,
	"last_server_seq" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
ALTER TABLE "erp_engine_assembly_bom" DROP CONSTRAINT "erp_engine_assembly_bom_engine_brand_id_entities_id_fk";
--> statement-breakpoint
DROP INDEX "erp_engine_assembly_bom_brand_version_uq";--> statement-breakpoint
DROP INDEX "erp_engine_assembly_bom_brand_idx";--> statement-breakpoint
DROP INDEX "erp_engine_assembly_bom_active_default_brand_uq";--> statement-breakpoint
ALTER TABLE "erp_engine_assembly_bom_brand_links" ADD CONSTRAINT "erp_engine_assembly_bom_brand_links_bom_id_erp_engine_assembly_bom_id_fk" FOREIGN KEY ("bom_id") REFERENCES "public"."erp_engine_assembly_bom"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_engine_assembly_bom_brand_links" ADD CONSTRAINT "erp_engine_assembly_bom_brand_links_engine_brand_id_entities_id_fk" FOREIGN KEY ("engine_brand_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_price_history" ADD CONSTRAINT "service_price_history_nomenclature_id_erp_nomenclature_id_fk" FOREIGN KEY ("nomenclature_id") REFERENCES "public"."erp_nomenclature"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_price_history" ADD CONSTRAINT "service_price_history_order_id_service_price_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."service_price_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "erp_eabbl_bom_brand_uq" ON "erp_engine_assembly_bom_brand_links" USING btree ("bom_id","engine_brand_id") WHERE "erp_engine_assembly_bom_brand_links"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "erp_eabbl_bom_idx" ON "erp_engine_assembly_bom_brand_links" USING btree ("bom_id");--> statement-breakpoint
CREATE INDEX "erp_eabbl_brand_idx" ON "erp_engine_assembly_bom_brand_links" USING btree ("engine_brand_id");--> statement-breakpoint
CREATE INDEX "service_price_history_nomenclature_effective_idx" ON "service_price_history" USING btree ("nomenclature_id","effective_from");--> statement-breakpoint
CREATE INDEX "service_price_history_order_idx" ON "service_price_history" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_price_history_nomenclature_order_uq" ON "service_price_history" USING btree ("nomenclature_id","order_id") WHERE "service_price_history"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "service_price_orders_number_uq" ON "service_price_orders" USING btree ("order_number") WHERE "service_price_orders"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "service_price_orders_effective_from_idx" ON "service_price_orders" USING btree ("effective_from");--> statement-breakpoint
ALTER TABLE "erp_engine_assembly_bom" DROP COLUMN "engine_brand_id";