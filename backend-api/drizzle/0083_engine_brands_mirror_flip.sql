-- B1 (план matrica-v4-kickoff, трек B этап 1): марки двигателей — переворот источника
-- правды EAV → directory_engine_brands.
--
-- До сих пор зеркало directory_engine_brands наполнялось ЛЕНИВО (upsert номенклатуры +
-- разовый backfill-скрипт), а строгие FK на марку шли прямо в entities.id — единственный
-- жёсткий FK-блокер вывода entities из синка. Здесь:
--   1) полный backfill зеркала из EAV (включая soft-deleted марки — FK не различает
--      живых и удалённых, каждой ссылке нужна строка);
--   2) триггеры на entities/attribute_values держат зеркало синхронным с ЛЮБЫМ путём
--      записи (admin-сервис, sync applyPushBatch, скрипты) — тот же приём, что
--      dual-write склада в 0052: одна точка вместо аудита всех call-site'ов;
--   3) перевес трёх брендовых FK строгих таблиц с entities(id) на
--      directory_engine_brands(id): erp_engine_assembly_bom_brand_links.engine_brand_id,
--      erp_nomenclature.default_brand_id, repair_norm_set_brand_links.engine_brand_id.
-- Клиенты не затронуты: directory_engine_brands не синкается, реплики читают EAV как раньше.

-- 1) Backfill зеркала из EAV (id-тождественно, имя из атрибута name, включая удалённых).
INSERT INTO directory_engine_brands (id, name, is_active, metadata_json, deprecated_at, created_at, updated_at, deleted_at)
SELECT e.id,
       coalesce(
         nullif(trim(both '"' from coalesce(
           (SELECT av.value_json
              FROM attribute_values av
              JOIN attribute_defs ad ON ad.id = av.attribute_def_id AND ad.code = 'name'
             WHERE av.entity_id = e.id AND av.deleted_at IS NULL
             LIMIT 1), '')), ''),
         'Без названия'),
       true, NULL, NULL,
       (extract(epoch from clock_timestamp()) * 1000)::bigint,
       (extract(epoch from clock_timestamp()) * 1000)::bigint,
       e.deleted_at
  FROM entities e
  JOIN entity_types t ON t.id = e.type_id AND t.code = 'engine_brand'
ON CONFLICT (id) DO UPDATE
   SET name = EXCLUDED.name,
       deleted_at = EXCLUDED.deleted_at,
       updated_at = EXCLUDED.updated_at;
--> statement-breakpoint

-- 2) Защитная страховка перед перевесом FK: любые id, на которые ссылаются строгие
-- таблицы, но которых нет в зеркале (битые ссылки на не-марку / жёстко удалённую
-- сущность), заводим помеченными строками — FK обязан пройти, мусор виден по имени.
INSERT INTO directory_engine_brands (id, name, is_active, created_at, updated_at, deleted_at)
SELECT DISTINCT ref.id, 'Неизвестная марка (восстановлено 0083)', false,
       (extract(epoch from clock_timestamp()) * 1000)::bigint,
       (extract(epoch from clock_timestamp()) * 1000)::bigint,
       (extract(epoch from clock_timestamp()) * 1000)::bigint
  FROM (
    SELECT engine_brand_id AS id FROM erp_engine_assembly_bom_brand_links
    UNION
    SELECT default_brand_id FROM erp_nomenclature WHERE default_brand_id IS NOT NULL
    UNION
    SELECT engine_brand_id FROM repair_norm_set_brand_links
  ) ref
  LEFT JOIN directory_engine_brands d ON d.id = ref.id
 WHERE ref.id IS NOT NULL AND d.id IS NULL;
--> statement-breakpoint

-- 3) Триггерное зеркало. entities: появление/soft-delete/восстановление марки.
CREATE OR REPLACE FUNCTION mirror_engine_brand_entity()
RETURNS TRIGGER AS $$
DECLARE
  v_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_name text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM entity_types t WHERE t.id = NEW.type_id AND t.code = 'engine_brand'
  ) THEN
    RETURN NEW;
  END IF;
  SELECT nullif(trim(both '"' from coalesce(av.value_json, '')), '') INTO v_name
    FROM attribute_values av
    JOIN attribute_defs ad ON ad.id = av.attribute_def_id AND ad.code = 'name'
   WHERE av.entity_id = NEW.id AND av.deleted_at IS NULL
   LIMIT 1;
  INSERT INTO directory_engine_brands (id, name, is_active, created_at, updated_at, deleted_at)
  VALUES (NEW.id, coalesce(v_name, 'Без названия'), true, v_ms, v_ms, NEW.deleted_at)
  ON CONFLICT (id) DO UPDATE
     SET deleted_at = EXCLUDED.deleted_at,
         name = coalesce(v_name, directory_engine_brands.name),
         updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_mirror_engine_brand_entity ON entities;
--> statement-breakpoint
CREATE TRIGGER trg_mirror_engine_brand_entity
AFTER INSERT OR UPDATE OF deleted_at ON entities
FOR EACH ROW EXECUTE FUNCTION mirror_engine_brand_entity();
--> statement-breakpoint

-- attribute_values: изменение имени марки (в т.ч. приезд имени синком после создания).
CREATE OR REPLACE FUNCTION mirror_engine_brand_name_attr()
RETURNS TRIGGER AS $$
DECLARE
  v_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_name text;
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW; -- снятое имя не затираем: у зеркала останется последнее известное
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM attribute_defs ad
      JOIN entity_types t ON t.id = ad.entity_type_id AND t.code = 'engine_brand'
     WHERE ad.id = NEW.attribute_def_id AND ad.code = 'name'
  ) THEN
    RETURN NEW;
  END IF;
  v_name := nullif(trim(both '"' from coalesce(NEW.value_json, '')), '');
  IF v_name IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO directory_engine_brands (id, name, is_active, created_at, updated_at)
  VALUES (NEW.entity_id, v_name, true, v_ms, v_ms)
  ON CONFLICT (id) DO UPDATE
     SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_mirror_engine_brand_name_attr ON attribute_values;
--> statement-breakpoint
CREATE TRIGGER trg_mirror_engine_brand_name_attr
AFTER INSERT OR UPDATE OF value_json, deleted_at ON attribute_values
FOR EACH ROW EXECUTE FUNCTION mirror_engine_brand_name_attr();
--> statement-breakpoint

-- 4) Перевес FK. Имена констрейнтов на живых средах могли дрейфовать (drizzle-имена
-- длиннее 63 символов режутся) — ищем по колонке через pg_constraint, не по имени.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid::regclass::text AS tbl
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.contype = 'f'
       AND c.confrelid = 'entities'::regclass
       AND (
         (c.conrelid = 'erp_engine_assembly_bom_brand_links'::regclass AND a.attname = 'engine_brand_id')
         OR (c.conrelid = 'erp_nomenclature'::regclass AND a.attname = 'default_brand_id')
         OR (c.conrelid = 'repair_norm_set_brand_links'::regclass AND a.attname = 'engine_brand_id')
       )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END;
$$;
--> statement-breakpoint

ALTER TABLE "erp_engine_assembly_bom_brand_links"
  ADD CONSTRAINT "erp_eabbl_engine_brand_dir_fk"
  FOREIGN KEY ("engine_brand_id") REFERENCES "directory_engine_brands"("id");
--> statement-breakpoint
ALTER TABLE "erp_nomenclature"
  ADD CONSTRAINT "erp_nomenclature_default_brand_dir_fk"
  FOREIGN KEY ("default_brand_id") REFERENCES "directory_engine_brands"("id");
--> statement-breakpoint
ALTER TABLE "repair_norm_set_brand_links"
  ADD CONSTRAINT "repair_norm_set_brand_dir_fk"
  FOREIGN KEY ("engine_brand_id") REFERENCES "directory_engine_brands"("id");
