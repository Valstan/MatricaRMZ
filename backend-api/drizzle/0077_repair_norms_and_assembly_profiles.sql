ALTER TABLE "erp_engine_assembly_bom" ADD COLUMN "default_variant_key" text;
ALTER TABLE "erp_engine_assembly_bom" ADD COLUMN "execution_profile_json" text;
ALTER TABLE "erp_engine_assembly_bom_brand_links" ADD COLUMN "is_default_for_brand" boolean DEFAULT false NOT NULL;
CREATE UNIQUE INDEX "erp_eabbl_default_brand_uq" ON "erp_engine_assembly_bom_brand_links" USING btree ("engine_brand_id") WHERE "erp_engine_assembly_bom_brand_links"."is_default_for_brand" = true and "erp_engine_assembly_bom_brand_links"."deleted_at" is null;
ALTER TABLE "work_order_templates" ADD COLUMN "archived_at" bigint;
DROP INDEX IF EXISTS "work_order_templates_kind_name_uq";
CREATE UNIQUE INDEX "work_order_templates_kind_name_uq" ON "work_order_templates" USING btree ("work_order_kind", "name") WHERE "work_order_templates"."archived_at" is null;

CREATE TABLE "repair_norm_sets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"source_kind" text,
	"source_key" text,
	"source_imported_at" bigint,
	"source_content_hash" text,
	"notes" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);

CREATE TABLE "repair_norm_set_brand_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"norm_set_id" uuid NOT NULL,
	"engine_brand_id" uuid NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);

CREATE TABLE "repair_norm_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"norm_set_id" uuid NOT NULL,
	"nomenclature_id" uuid NOT NULL,
	"qty_per_engine" numeric(14, 4) NOT NULL,
	"replacement_percent" numeric(7, 4) NOT NULL,
	"group_name" text,
	"source_row_key" text,
	"source_meta_json" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);

ALTER TABLE "repair_norm_set_brand_links" ADD CONSTRAINT "repair_norm_set_brand_links_norm_set_id_repair_norm_sets_id_fk" FOREIGN KEY ("norm_set_id") REFERENCES "public"."repair_norm_sets"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "repair_norm_set_brand_links" ADD CONSTRAINT "repair_norm_set_brand_links_engine_brand_id_entities_id_fk" FOREIGN KEY ("engine_brand_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "repair_norm_lines" ADD CONSTRAINT "repair_norm_lines_norm_set_id_repair_norm_sets_id_fk" FOREIGN KEY ("norm_set_id") REFERENCES "public"."repair_norm_sets"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "repair_norm_lines" ADD CONSTRAINT "repair_norm_lines_nomenclature_id_erp_nomenclature_id_fk" FOREIGN KEY ("nomenclature_id") REFERENCES "public"."erp_nomenclature"("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "repair_norm_sets_status_idx" ON "repair_norm_sets" USING btree ("status");
CREATE INDEX "repair_norm_sets_source_key_idx" ON "repair_norm_sets" USING btree ("source_key");
CREATE UNIQUE INDEX "repair_norm_set_brand_uq" ON "repair_norm_set_brand_links" USING btree ("norm_set_id", "engine_brand_id") WHERE "repair_norm_set_brand_links"."deleted_at" is null;
CREATE INDEX "repair_norm_set_brand_set_idx" ON "repair_norm_set_brand_links" USING btree ("norm_set_id");
CREATE INDEX "repair_norm_set_brand_brand_idx" ON "repair_norm_set_brand_links" USING btree ("engine_brand_id");
CREATE INDEX "repair_norm_lines_set_idx" ON "repair_norm_lines" USING btree ("norm_set_id");
CREATE INDEX "repair_norm_lines_nomenclature_idx" ON "repair_norm_lines" USING btree ("nomenclature_id");
CREATE UNIQUE INDEX "repair_norm_lines_set_source_row_uq" ON "repair_norm_lines" USING btree ("norm_set_id", "source_row_key") WHERE "repair_norm_lines"."deleted_at" is null and "repair_norm_lines"."source_row_key" is not null;
