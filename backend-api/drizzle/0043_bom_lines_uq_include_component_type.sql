-- Скелет BOM и черновые строки могут ссылаться на одну и ту же номенклатуру-заглушку
-- в разных component_type (гильза, поршень, …) внутри одного variant_group.
DROP INDEX IF EXISTS "erp_engine_assembly_bom_lines_variant_component_uq";

CREATE UNIQUE INDEX IF NOT EXISTS "erp_engine_assembly_bom_lines_variant_component_uq"
  ON "erp_engine_assembly_bom_lines" ("bom_id", "variant_group", "component_nomenclature_id", "component_type")
  WHERE "deleted_at" IS NULL;
