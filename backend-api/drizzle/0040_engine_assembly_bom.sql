CREATE TABLE IF NOT EXISTS "erp_engine_assembly_bom" (
  "id" uuid PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "engine_nomenclature_id" uuid NOT NULL REFERENCES "erp_nomenclature"("id"),
  "version" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'draft',
  "is_default" boolean NOT NULL DEFAULT false,
  "notes" text,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint,
  "sync_status" text NOT NULL DEFAULT 'synced',
  "last_server_seq" bigint
);

CREATE TABLE IF NOT EXISTS "erp_engine_assembly_bom_lines" (
  "id" uuid PRIMARY KEY NOT NULL,
  "bom_id" uuid NOT NULL REFERENCES "erp_engine_assembly_bom"("id"),
  "component_nomenclature_id" uuid NOT NULL REFERENCES "erp_nomenclature"("id"),
  "component_type" text NOT NULL DEFAULT 'other',
  "qty_per_unit" integer NOT NULL DEFAULT 1,
  "variant_group" text,
  "is_required" boolean NOT NULL DEFAULT true,
  "priority" integer NOT NULL DEFAULT 100,
  "notes" text,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint,
  "sync_status" text NOT NULL DEFAULT 'synced',
  "last_server_seq" bigint
);

CREATE UNIQUE INDEX IF NOT EXISTS "erp_engine_assembly_bom_engine_version_uq"
  ON "erp_engine_assembly_bom" ("engine_nomenclature_id", "version")
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "erp_engine_assembly_bom_engine_idx"
  ON "erp_engine_assembly_bom" ("engine_nomenclature_id");

CREATE INDEX IF NOT EXISTS "erp_engine_assembly_bom_status_idx"
  ON "erp_engine_assembly_bom" ("status");

CREATE UNIQUE INDEX IF NOT EXISTS "erp_engine_assembly_bom_active_default_engine_uq"
  ON "erp_engine_assembly_bom" ("engine_nomenclature_id")
  WHERE "deleted_at" IS NULL AND "status" = 'active' AND "is_default" = true;

CREATE INDEX IF NOT EXISTS "erp_engine_assembly_bom_lines_bom_idx"
  ON "erp_engine_assembly_bom_lines" ("bom_id");

CREATE INDEX IF NOT EXISTS "erp_engine_assembly_bom_lines_component_idx"
  ON "erp_engine_assembly_bom_lines" ("component_nomenclature_id");

CREATE UNIQUE INDEX IF NOT EXISTS "erp_engine_assembly_bom_lines_variant_component_uq"
  ON "erp_engine_assembly_bom_lines" ("bom_id", "variant_group", "component_nomenclature_id")
  WHERE "deleted_at" IS NULL;
