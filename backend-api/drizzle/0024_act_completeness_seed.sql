-- Seed engine brands + parts from "Акт комплектности двигателя" (Table 1)
-- Uses deterministic UUIDs from md5() and avoids duplicates by name/number.

-- 1) Ensure required attribute_defs exist (engine_brand.name, part.name, part.assembly_unit_number, part.engine_brand_ids)
WITH
  now_ms AS (
    SELECT (extract(epoch FROM now()) * 1000)::bigint AS ts
  ),
  et_brand AS (
    SELECT id FROM entity_types WHERE code = 'engine_brand' AND deleted_at IS NULL
  ),
  et_part AS (
    SELECT id FROM entity_types WHERE code = 'part' AND deleted_at IS NULL
  )
INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, is_required, sort_order, meta_json, created_at, updated_at, deleted_at, sync_status)
SELECT
  md5('engine_brand:name')::uuid,
  et_brand.id,
  'name',
  'Название',
  'text',
  false,
  10,
  NULL,
  now_ms.ts,
  now_ms.ts,
  NULL,
  'synced'
FROM et_brand, now_ms
WHERE NOT EXISTS (
  SELECT 1 FROM attribute_defs WHERE entity_type_id = et_brand.id AND code = 'name'
);
-- part.name
WITH
  now_ms AS (
    SELECT (extract(epoch FROM now()) * 1000)::bigint AS ts
  ),
  et_part AS (
    SELECT id FROM entity_types WHERE code = 'part' AND deleted_at IS NULL
  )
INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, is_required, sort_order, meta_json, created_at, updated_at, deleted_at, sync_status)
SELECT
  md5('part:name')::uuid,
  et_part.id,
  'name',
  'Название',
  'text',
  false,
  10,
  NULL,
  now_ms.ts,
  now_ms.ts,
  NULL,
  'synced'
FROM et_part, now_ms
WHERE NOT EXISTS (
  SELECT 1 FROM attribute_defs WHERE entity_type_id = et_part.id AND code = 'name'
);
-- part.assembly_unit_number
WITH
  now_ms AS (
    SELECT (extract(epoch FROM now()) * 1000)::bigint AS ts
  ),
  et_part AS (
    SELECT id FROM entity_types WHERE code = 'part' AND deleted_at IS NULL
  )
INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, is_required, sort_order, meta_json, created_at, updated_at, deleted_at, sync_status)
SELECT
  md5('part:assembly_unit_number')::uuid,
  et_part.id,
  'assembly_unit_number',
  'Номер сборочной единицы',
  'text',
  false,
  35,
  NULL,
  now_ms.ts,
  now_ms.ts,
  NULL,
  'synced'
FROM et_part, now_ms
WHERE NOT EXISTS (
  SELECT 1 FROM attribute_defs WHERE entity_type_id = et_part.id AND code = 'assembly_unit_number'
);
-- part.engine_brand_ids
WITH
  now_ms AS (
    SELECT (extract(epoch FROM now()) * 1000)::bigint AS ts
  ),
  et_part AS (
    SELECT id FROM entity_types WHERE code = 'part' AND deleted_at IS NULL
  )
INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, is_required, sort_order, meta_json, created_at, updated_at, deleted_at, sync_status)
SELECT
  md5('part:engine_brand_ids')::uuid,
  et_part.id,
  'engine_brand_ids',
  'Марки двигателя',
  'json',
  false,
  40,
  NULL,
  now_ms.ts,
  now_ms.ts,
  NULL,
  'synced'
FROM et_part, now_ms
WHERE NOT EXISTS (
  SELECT 1 FROM attribute_defs WHERE entity_type_id = et_part.id AND code = 'engine_brand_ids'
);

-- 2) Seed engine brands
WITH
  now_ms AS (
    SELECT (extract(epoch FROM now()) * 1000)::bigint AS ts
  ),
  et_brand AS (
    SELECT id FROM entity_types WHERE code = 'engine_brand' AND deleted_at IS NULL
  ),
  ad_brand_name AS (
    SELECT id FROM attribute_defs
    WHERE entity_type_id = (SELECT id FROM et_brand)
      AND code = 'name'
      AND deleted_at IS NULL
  ),
  brand_seed(name) AS (
    VALUES
      ('В-59УМС'),
      ('В-84'),
      ('В-84 АМС'),
      ('В-84МБ-1С (В-84Б)'),
      ('В-84 ДТ'),
      ('В-46-5С'),
      ('В-46-2С1 (В-46-2С1М)'),
      ('В-46-1')
  ),
  existing_brands AS (
    SELECT e.id, av.value_json
    FROM entities e
    JOIN attribute_values av
      ON av.entity_id = e.id
     AND av.attribute_def_id = (SELECT id FROM ad_brand_name)
     AND av.deleted_at IS NULL
    WHERE e.type_id = (SELECT id FROM et_brand)
      AND e.deleted_at IS NULL
  ),
  brand_map AS (
    SELECT
      bs.name,
      COALESCE(
        (SELECT eb.id FROM existing_brands eb WHERE eb.value_json = to_jsonb(bs.name)::text LIMIT 1),
        md5('engine_brand:' || bs.name)::uuid
      ) AS brand_id,
      (SELECT eb.id FROM existing_brands eb WHERE eb.value_json = to_jsonb(bs.name)::text LIMIT 1) IS NULL AS is_new
    FROM brand_seed bs
  )
INSERT INTO entities (id, type_id, created_at, updated_at, deleted_at, sync_status)
SELECT
  brand_map.brand_id,
  (SELECT id FROM et_brand),
  now_ms.ts,
  now_ms.ts,
  NULL,
  'synced'
FROM brand_map, now_ms
WHERE brand_map.is_new;

WITH
  now_ms AS (
    SELECT (extract(epoch FROM now()) * 1000)::bigint AS ts
  ),
  et_brand AS (
    SELECT id FROM entity_types WHERE code = 'engine_brand' AND deleted_at IS NULL
  ),
  ad_brand_name AS (
    SELECT id FROM attribute_defs
    WHERE entity_type_id = (SELECT id FROM et_brand)
      AND code = 'name'
      AND deleted_at IS NULL
  ),
  brand_seed(name) AS (
    VALUES
      ('В-59УМС'),
      ('В-84'),
      ('В-84 АМС'),
      ('В-84МБ-1С (В-84Б)'),
      ('В-84 ДТ'),
      ('В-46-5С'),
      ('В-46-2С1 (В-46-2С1М)'),
      ('В-46-1')
  ),
  existing_brands AS (
    SELECT e.id, av.value_json
    FROM entities e
    JOIN attribute_values av
      ON av.entity_id = e.id
     AND av.attribute_def_id = (SELECT id FROM ad_brand_name)
     AND av.deleted_at IS NULL
    WHERE e.type_id = (SELECT id FROM et_brand)
      AND e.deleted_at IS NULL
  ),
  brand_map AS (
    SELECT
      bs.name,
      COALESCE(
        (SELECT eb.id FROM existing_brands eb WHERE eb.value_json = to_jsonb(bs.name)::text LIMIT 1),
        md5('engine_brand:' || bs.name)::uuid
      ) AS brand_id,
      (SELECT eb.id FROM existing_brands eb WHERE eb.value_json = to_jsonb(bs.name)::text LIMIT 1) IS NULL AS is_new
    FROM brand_seed bs
  )
INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at, deleted_at, sync_status)
SELECT
  md5('engine_brand:name:' || brand_map.brand_id::text)::uuid,
  brand_map.brand_id,
  (SELECT id FROM ad_brand_name),
  to_jsonb(brand_map.name)::text,
  now_ms.ts,
  now_ms.ts,
  NULL,
  'synced'
FROM brand_map, now_ms
WHERE brand_map.is_new
ON CONFLICT (entity_id, attribute_def_id) DO NOTHING;

-- 3) Seed parts and link to engine brands
WITH
  now_ms AS (
    SELECT (extract(epoch FROM now()) * 1000)::bigint AS ts
  ),
  et_brand AS (
    SELECT id FROM entity_types WHERE code = 'engine_brand' AND deleted_at IS NULL
  ),
  et_part AS (
    SELECT id FROM entity_types WHERE code = 'part' AND deleted_at IS NULL
  ),
  ad_brand_name AS (
    SELECT id FROM attribute_defs
    WHERE entity_type_id = (SELECT id FROM et_brand)
      AND code = 'name'
      AND deleted_at IS NULL
  ),
  ad_part_name AS (
    SELECT id FROM attribute_defs
    WHERE entity_type_id = (SELECT id FROM et_part)
      AND code = 'name'
      AND deleted_at IS NULL
  ),
  ad_part_assembly AS (
    SELECT id FROM attribute_defs
    WHERE entity_type_id = (SELECT id FROM et_part)
      AND code = 'assembly_unit_number'
      AND deleted_at IS NULL
  ),
  ad_part_brand_ids AS (
    SELECT id FROM attribute_defs
    WHERE entity_type_id = (SELECT id FROM et_part)
      AND code = 'engine_brand_ids'
      AND deleted_at IS NULL
  ),
  brand_seed(name) AS (
    VALUES
      ('В-59УМС'),
      ('В-84'),
      ('В-84 АМС'),
      ('В-84МБ-1С (В-84Б)'),
      ('В-84 ДТ'),
      ('В-46-5С'),
      ('В-46-2С1 (В-46-2С1М)'),
      ('В-46-1')
  ),
  existing_brands AS (
    SELECT e.id, av.value_json
    FROM entities e
    JOIN attribute_values av
      ON av.entity_id = e.id
     AND av.attribute_def_id = (SELECT id FROM ad_brand_name)
     AND av.deleted_at IS NULL
    WHERE e.type_id = (SELECT id FROM et_brand)
      AND e.deleted_at IS NULL
  ),
  brand_map AS (
    SELECT
      bs.name,
      COALESCE(
        (SELECT eb.id FROM existing_brands eb WHERE eb.value_json = to_jsonb(bs.name)::text LIMIT 1),
        md5('engine_brand:' || bs.name)::uuid
      ) AS brand_id
    FROM brand_seed bs
  ),
  parts_raw(part_name, brand_name, assembly_unit_number) AS (
    VALUES
      ('Картер верхний','В-59УМС','Сб. 3301-15-30'),
      ('Картер нижний','В-59УМС','Сб. 3301-15-30'),
      ('Вал коленчатый','В-59УМС','Сб. 3305-01-18'),
      ('Вал коленчатый','В-84','Сб. 3305-01-17'),
      ('Рубашка цилиндров правая','В-59УМС','Сб. 303-03-11'),
      ('Рубашка цилиндров левая','В-59УМС','Сб. 303-02-16'),
      ('Головки блока правой','В-59УМС','Сб. 306-01-26'),
      ('Головки блока правой','В-84','Сб. 306-01-20'),
      ('Головки блока левой','В-59УМС','Сб. 306-02-26'),
      ('Головки блока левой','В-84','Сб. 306-02-20'),
      ('Насос топливный','В-59УМС','НК-10М сб. 327-00-62'),
      ('Насос топливный','В-84','НК-12М сб. 327-00-47'),
      ('Насос топливоподкачивающий','В-59УМС','Сб. 532-00-02'),
      ('Насос водяной','В-59УМС','Сб. 411-00-35А'),
      ('Насос водяной','В-84','Сб. 411-00-48'),
      ('Насос водяной','В-84 АМС','Сб. 411-00-42'),
      ('Насос водяной','В-84МБ-1С (В-84Б)','Сб. 411-00-48'),
      ('Насос масляный','В-59УМС','Сб. 3312-00-16'),
      ('Насос масляный','В-84','Сб. 3312-00-15'),
      ('Насос масляный','В-84 АМС','Сб. 3312-00-17'),
      ('Насос масляный','В-84МБ-1С (В-84Б)','Сб. 3312-00-16'),
      ('Насос масляный','В-84 ДТ','Сб. 3312-00-15'),
      ('ТФТО','В-59УМС','Сб. 3329-00-13'),
      ('Маслоочиститель центробежный','В-59УМС','Сб. 447-00'),
      ('Маслоочиститель центробежный','В-84','Сб. 447-00-1'),
      ('Маслоочиститель центробежный','В-84 АМС','Сб. 447-00'),
      ('Маслоочиститель центробежный','В-84 ДТ','Сб. 447-00'),
      ('Фильтр масляный','В-59УМС','Сб. 413-00-14'),
      ('Фильтр масляный','В-84','Сб. 413-00-15'),
      ('Фильтр масляный','В-84 АМС','Сб. 413-00-7'),
      ('Фильтр масляный','В-84МБ-1С (В-84Б)','Сб. 413-00-15'),
      ('Фильтр масляный','В-84 ДТ','Сб. 413-00-10'),
      ('Привод','В-59УМС','303.01.сб.2'),
      ('Механизм отбора мощности','В-84 ДТ','306.01СБ'),
      ('Механизм отбора мощности','В-46-2С1 (В-46-2С1М)','306.01СБ'),
      ('Нагнетатель','В-84','Сб.3338-401-10'),
      ('Нагнетатель','В-84 АМС','Сб. 3338-401-6'),
      ('Генератор с муфтой привода','В-59УМС','3309-25-2'),
      ('Генератор с муфтой привода','В-46-5С','3309-25-2'),
      ('Воздухораспределитель','В-59УМС','Сб. 310-30А'),
      ('Трубопровод выпускной левый','В-59УМС','118.01сб.2-1'),
      ('Трубопровод выпускной левый','В-84','Сб.418-50-29/31'),
      ('Трубопровод выпускной правый','В-59УМС','118.01сб.3-1'),
      ('Трубопровод выпускной правый','В-84','Сб. 418-51-29/31'),
      ('Трубопровод впускной левый','В-59УМС','Сб.419-06-10'),
      ('Трубопровод впускной левый','В-84','Сб.419-06-7/сб.419-06-12'),
      ('Трубопровод впускной правый','В-59УМС','Сб.419-05-10'),
      ('Трубопровод впускной правый','В-84','Сб.419-05-7/сб. 419-05-12'),
      ('Трубопровод масляный (труба подвода масла к распредвалу правая)','В-59УМС','Сб. 320-32А'),
      ('Трубопровод масляный (труба подвода масла к распредвалу правая)','В-84','Сб. 320-32'),
      ('Трубопровод масляный (труба подвода масла к распредвалу правая)','В-84 ДТ','Сб. 320-32А'),
      ('Трубопровод масляный (труба подвода масла к распредвалу левая)','В-84','Сб. 320-33А'),
      ('Трубопровод масляный (труба подвода масла к распредвалу левая)','В-84 ДТ','Сб. 320-33'),
      ('Трубопровод масляный (труба подвода масла к распредвалу левая)','В-46-5С','Сб. 320-33А'),
      ('Шланг от маслонасоса к маслоочистителю','В-59УМС','Сб. 420-51'),
      ('Шланг от маслонасоса к маслоочистителю','В-84','Сб. 420-51-7'),
      ('Шланг от маслонасоса к маслоочистителю','В-84МБ-1С (В-84Б)','Сб. 420-164-7'),
      ('Шланг от маслонасоса к маслоочистителю','В-84 ДТ','Сб. 3320-164-8'),
      ('Трубка подвода масла к топливному насосу','В-59УМС','Сб. 420-183-6'),
      ('Трубка подвода масла к топливному насосу','В-84','Сб. 420-183-5'),
      ('Трубка подвода масла к топливному насосу','В-84 АМС','Сб. 420-183-6'),
      ('Труб подвода масла к нагнетателю','В-84 АМС','сб. 3320-268-1 и сб. 3320-273'),
      ('Труб подвода масла к нагнетателю','В-84 ДТ','сб. 3320-268-1 и сб. 3320-273'),
      ('Труба для подвода масла к приводу генератора','В-59УМС','Сб. 3320-161-4'),
      ('Труба для подвода масла к приводу генератора','В-84 ДТ','Сб. 3320-161-4'),
      ('Трубопровод от маслонасоса к маслофильтру','В-84','Сб. 3320-372-4/11'),
      ('Трубопровод от маслонасоса к маслофильтру','В-84 ДТ','Сб. 420-02-12/7'),
      ('Трубопровод от маслофильтра к главной магистрали','В-84','Сб. 3320-398'),
      ('Трубопровод водяной','В-59УМС','Сб. 3321-00-19'),
      ('Трубопровод водяной','В-84','Сб. 3321-00-16'),
      ('Трубопровод воздушного пуска','В-59УМС','Сб. 322-00-4'),
      ('Трубопровод высокого давления','В-59УМС','Сб. 323-33А, сб. 323-34А, сб. 323-35А, сб. 323-36А'),
      ('Трубопровод высокого давления','В-84','Сб. 323-33-4,сб. 323-34-4, сб. 323-35-4,      сб. 323-36-4'),
      ('Трубопровод высокого давления','В-84 АМС','Сб. 323-33А, сб. 323-34А, сб. 323-35А, сб. 323-36А'),
      ('Система суфлирования (корпус маслоотделителя)','В-59УМС','Сб.3342-184-2'),
      ('Система суфлирования (корпус маслоотделителя)','В-84','Сб. 3342-184-1'),
      ('Система суфлирования (корпус маслоотделителя)','В-84 АМС','Сб. 3342-184-2'),
      ('Система суфлирования (корпус маслоотделителя)','В-84МБ-1С (В-84Б)','Сб. 3342-184-1'),
      ('Крышка головки правая','В-59УМС','Сб. 406-08-3'),
      ('Крышка головки правая','В-84','Сб. 306-08-8'),
      ('Крышка головки левая','В-59УМС','Сб. 306-09-8'),
      ('Крышка головки левая','В-84','Сб. 306-09-10'),
      ('Крышка люка','В-59УМС','Сб. 406-12-44')
  ),
  parts_grouped AS (
    SELECT
      pr.part_name,
      pr.assembly_unit_number,
      array_agg(DISTINCT bm.brand_id) AS brand_ids
    FROM parts_raw pr
    JOIN brand_map bm ON bm.name = pr.brand_name
    GROUP BY pr.part_name, pr.assembly_unit_number
  ),
  parts_existing AS (
    SELECT
      e.id,
      av_name.value_json AS name_json,
      av_assembly.value_json AS assembly_json
    FROM entities e
    JOIN attribute_values av_name
      ON av_name.entity_id = e.id
     AND av_name.attribute_def_id = (SELECT id FROM ad_part_name)
     AND av_name.deleted_at IS NULL
    JOIN attribute_values av_assembly
      ON av_assembly.entity_id = e.id
     AND av_assembly.attribute_def_id = (SELECT id FROM ad_part_assembly)
     AND av_assembly.deleted_at IS NULL
    WHERE e.type_id = (SELECT id FROM et_part)
      AND e.deleted_at IS NULL
  ),
  parts_map AS (
    SELECT
      pg.part_name,
      pg.assembly_unit_number,
      pg.brand_ids,
      COALESCE(
        (SELECT pe.id FROM parts_existing pe
         WHERE pe.name_json = to_jsonb(pg.part_name)::text
           AND pe.assembly_json = to_jsonb(pg.assembly_unit_number)::text
         LIMIT 1),
        md5('part:' || pg.part_name || '|' || pg.assembly_unit_number)::uuid
      ) AS part_id,
      (SELECT pe.id FROM parts_existing pe
       WHERE pe.name_json = to_jsonb(pg.part_name)::text
         AND pe.assembly_json = to_jsonb(pg.assembly_unit_number)::text
       LIMIT 1) IS NULL AS is_new
    FROM parts_grouped pg
  )
INSERT INTO entities (id, type_id, created_at, updated_at, deleted_at, sync_status)
SELECT
  parts_map.part_id,
  (SELECT id FROM et_part),
  now_ms.ts,
  now_ms.ts,
  NULL,
  'synced'
FROM parts_map, now_ms
WHERE parts_map.is_new;

WITH
  now_ms AS (
    SELECT (extract(epoch FROM now()) * 1000)::bigint AS ts
  ),
  et_part AS (
    SELECT id FROM entity_types WHERE code = 'part' AND deleted_at IS NULL
  ),
  ad_part_name AS (
    SELECT id FROM attribute_defs
    WHERE entity_type_id = (SELECT id FROM et_part)
      AND code = 'name'
      AND deleted_at IS NULL
  ),
  ad_part_assembly AS (
    SELECT id FROM attribute_defs
    WHERE entity_type_id = (SELECT id FROM et_part)
      AND code = 'assembly_unit_number'
      AND deleted_at IS NULL
  ),
  ad_part_brand_ids AS (
    SELECT id FROM attribute_defs
    WHERE entity_type_id = (SELECT id FROM et_part)
      AND code = 'engine_brand_ids'
      AND deleted_at IS NULL
  ),
  brand_seed(name) AS (
    VALUES
      ('В-59УМС'),
      ('В-84'),
      ('В-84 АМС'),
      ('В-84МБ-1С (В-84Б)'),
      ('В-84 ДТ'),
      ('В-46-5С'),
      ('В-46-2С1 (В-46-2С1М)'),
      ('В-46-1')
  ),
  existing_brands AS (
    SELECT e.id, av.value_json
    FROM entities e
    JOIN attribute_values av
      ON av.entity_id = e.id
     AND av.attribute_def_id = (
       SELECT id FROM attribute_defs
       WHERE entity_type_id = (SELECT id FROM entity_types WHERE code = 'engine_brand' AND deleted_at IS NULL)
         AND code = 'name'
         AND deleted_at IS NULL
     )
     AND av.deleted_at IS NULL
    WHERE e.type_id = (SELECT id FROM entity_types WHERE code = 'engine_brand' AND deleted_at IS NULL)
      AND e.deleted_at IS NULL
  ),
  brand_map AS (
    SELECT
      bs.name,
      COALESCE(
        (SELECT eb.id FROM existing_brands eb WHERE eb.value_json = to_jsonb(bs.name)::text LIMIT 1),
        md5('engine_brand:' || bs.name)::uuid
      ) AS brand_id
    FROM brand_seed bs
  ),
  parts_raw(part_name, brand_name, assembly_unit_number) AS (
    VALUES
      ('Картер верхний','В-59УМС','Сб. 3301-15-30'),
      ('Картер нижний','В-59УМС','Сб. 3301-15-30'),
      ('Вал коленчатый','В-59УМС','Сб. 3305-01-18'),
      ('Вал коленчатый','В-84','Сб. 3305-01-17'),
      ('Рубашка цилиндров правая','В-59УМС','Сб. 303-03-11'),
      ('Рубашка цилиндров левая','В-59УМС','Сб. 303-02-16'),
      ('Головки блока правой','В-59УМС','Сб. 306-01-26'),
      ('Головки блока правой','В-84','Сб. 306-01-20'),
      ('Головки блока левой','В-59УМС','Сб. 306-02-26'),
      ('Головки блока левой','В-84','Сб. 306-02-20'),
      ('Насос топливный','В-59УМС','НК-10М сб. 327-00-62'),
      ('Насос топливный','В-84','НК-12М сб. 327-00-47'),
      ('Насос топливоподкачивающий','В-59УМС','Сб. 532-00-02'),
      ('Насос водяной','В-59УМС','Сб. 411-00-35А'),
      ('Насос водяной','В-84','Сб. 411-00-48'),
      ('Насос водяной','В-84 АМС','Сб. 411-00-42'),
      ('Насос водяной','В-84МБ-1С (В-84Б)','Сб. 411-00-48'),
      ('Насос масляный','В-59УМС','Сб. 3312-00-16'),
      ('Насос масляный','В-84','Сб. 3312-00-15'),
      ('Насос масляный','В-84 АМС','Сб. 3312-00-17'),
      ('Насос масляный','В-84МБ-1С (В-84Б)','Сб. 3312-00-16'),
      ('Насос масляный','В-84 ДТ','Сб. 3312-00-15'),
      ('ТФТО','В-59УМС','Сб. 3329-00-13'),
      ('Маслоочиститель центробежный','В-59УМС','Сб. 447-00'),
      ('Маслоочиститель центробежный','В-84','Сб. 447-00-1'),
      ('Маслоочиститель центробежный','В-84 АМС','Сб. 447-00'),
      ('Маслоочиститель центробежный','В-84 ДТ','Сб. 447-00'),
      ('Фильтр масляный','В-59УМС','Сб. 413-00-14'),
      ('Фильтр масляный','В-84','Сб. 413-00-15'),
      ('Фильтр масляный','В-84 АМС','Сб. 413-00-7'),
      ('Фильтр масляный','В-84МБ-1С (В-84Б)','Сб. 413-00-15'),
      ('Фильтр масляный','В-84 ДТ','Сб. 413-00-10'),
      ('Привод','В-59УМС','303.01.сб.2'),
      ('Механизм отбора мощности','В-84 ДТ','306.01СБ'),
      ('Механизм отбора мощности','В-46-2С1 (В-46-2С1М)','306.01СБ'),
      ('Нагнетатель','В-84','Сб.3338-401-10'),
      ('Нагнетатель','В-84 АМС','Сб. 3338-401-6'),
      ('Генератор с муфтой привода','В-59УМС','3309-25-2'),
      ('Генератор с муфтой привода','В-46-5С','3309-25-2'),
      ('Воздухораспределитель','В-59УМС','Сб. 310-30А'),
      ('Трубопровод выпускной левый','В-59УМС','118.01сб.2-1'),
      ('Трубопровод выпускной левый','В-84','Сб.418-50-29/31'),
      ('Трубопровод выпускной правый','В-59УМС','118.01сб.3-1'),
      ('Трубопровод выпускной правый','В-84','Сб. 418-51-29/31'),
      ('Трубопровод впускной левый','В-59УМС','Сб.419-06-10'),
      ('Трубопровод впускной левый','В-84','Сб.419-06-7/сб.419-06-12'),
      ('Трубопровод впускной правый','В-59УМС','Сб.419-05-10'),
      ('Трубопровод впускной правый','В-84','Сб.419-05-7/сб. 419-05-12'),
      ('Трубопровод масляный (труба подвода масла к распредвалу правая)','В-59УМС','Сб. 320-32А'),
      ('Трубопровод масляный (труба подвода масла к распредвалу правая)','В-84','Сб. 320-32'),
      ('Трубопровод масляный (труба подвода масла к распредвалу правая)','В-84 ДТ','Сб. 320-32А'),
      ('Трубопровод масляный (труба подвода масла к распредвалу левая)','В-84','Сб. 320-33А'),
      ('Трубопровод масляный (труба подвода масла к распредвалу левая)','В-84 ДТ','Сб. 320-33'),
      ('Трубопровод масляный (труба подвода масла к распредвалу левая)','В-46-5С','Сб. 320-33А'),
      ('Шланг от маслонасоса к маслоочистителю','В-59УМС','Сб. 420-51'),
      ('Шланг от маслонасоса к маслоочистителю','В-84','Сб. 420-51-7'),
      ('Шланг от маслонасоса к маслоочистителю','В-84МБ-1С (В-84Б)','Сб. 420-164-7'),
      ('Шланг от маслонасоса к маслоочистителю','В-84 ДТ','Сб. 3320-164-8'),
      ('Трубка подвода масла к топливному насосу','В-59УМС','Сб. 420-183-6'),
      ('Трубка подвода масла к топливному насосу','В-84','Сб. 420-183-5'),
      ('Трубка подвода масла к топливному насосу','В-84 АМС','Сб. 420-183-6'),
      ('Труб подвода масла к нагнетателю','В-84 АМС','сб. 3320-268-1 и сб. 3320-273'),
      ('Труб подвода масла к нагнетателю','В-84 ДТ','сб. 3320-268-1 и сб. 3320-273'),
      ('Труба для подвода масла к приводу генератора','В-59УМС','Сб. 3320-161-4'),
      ('Труба для подвода масла к приводу генератора','В-84 ДТ','Сб. 3320-161-4'),
      ('Трубопровод от маслонасоса к маслофильтру','В-84','Сб. 3320-372-4/11'),
      ('Трубопровод от маслонасоса к маслофильтру','В-84 ДТ','Сб. 420-02-12/7'),
      ('Трубопровод от маслофильтра к главной магистрали','В-84','Сб. 3320-398'),
      ('Трубопровод водяной','В-59УМС','Сб. 3321-00-19'),
      ('Трубопровод водяной','В-84','Сб. 3321-00-16'),
      ('Трубопровод воздушного пуска','В-59УМС','Сб. 322-00-4'),
      ('Трубопровод высокого давления','В-59УМС','Сб. 323-33А, сб. 323-34А, сб. 323-35А, сб. 323-36А'),
      ('Трубопровод высокого давления','В-84','Сб. 323-33-4,сб. 323-34-4, сб. 323-35-4,      сб. 323-36-4'),
      ('Трубопровод высокого давления','В-84 АМС','Сб. 323-33А, сб. 323-34А, сб. 323-35А, сб. 323-36А'),
      ('Система суфлирования (корпус маслоотделителя)','В-59УМС','Сб.3342-184-2'),
      ('Система суфлирования (корпус маслоотделителя)','В-84','Сб. 3342-184-1'),
      ('Система суфлирования (корпус маслоотделителя)','В-84 АМС','Сб. 3342-184-2'),
      ('Система суфлирования (корпус маслоотделителя)','В-84МБ-1С (В-84Б)','Сб. 3342-184-1'),
      ('Крышка головки правая','В-59УМС','Сб. 406-08-3'),
      ('Крышка головки правая','В-84','Сб. 306-08-8'),
      ('Крышка головки левая','В-59УМС','Сб. 306-09-8'),
      ('Крышка головки левая','В-84','Сб. 306-09-10'),
      ('Крышка люка','В-59УМС','Сб. 406-12-44')
  ),
  parts_grouped AS (
    SELECT
      pr.part_name,
      pr.assembly_unit_number,
      array_agg(DISTINCT bm.brand_id) AS brand_ids
    FROM parts_raw pr
    JOIN brand_map bm ON bm.name = pr.brand_name
    GROUP BY pr.part_name, pr.assembly_unit_number
  ),
  parts_existing AS (
    SELECT
      e.id,
      av_name.value_json AS name_json,
      av_assembly.value_json AS assembly_json
    FROM entities e
    JOIN attribute_values av_name
      ON av_name.entity_id = e.id
     AND av_name.attribute_def_id = (SELECT id FROM ad_part_name)
     AND av_name.deleted_at IS NULL
    JOIN attribute_values av_assembly
      ON av_assembly.entity_id = e.id
     AND av_assembly.attribute_def_id = (SELECT id FROM ad_part_assembly)
     AND av_assembly.deleted_at IS NULL
    WHERE e.type_id = (SELECT id FROM et_part)
      AND e.deleted_at IS NULL
  ),
  parts_map AS (
    SELECT
      pg.part_name,
      pg.assembly_unit_number,
      pg.brand_ids,
      COALESCE(
        (SELECT pe.id FROM parts_existing pe
         WHERE pe.name_json = to_jsonb(pg.part_name)::text
           AND pe.assembly_json = to_jsonb(pg.assembly_unit_number)::text
         LIMIT 1),
        md5('part:' || pg.part_name || '|' || pg.assembly_unit_number)::uuid
      ) AS part_id
    FROM parts_grouped pg
  )
INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at, deleted_at, sync_status)
SELECT
  md5('part:name:' || parts_map.part_id::text)::uuid,
  parts_map.part_id,
  (SELECT id FROM ad_part_name),
  to_jsonb(parts_map.part_name)::text,
  now_ms.ts,
  now_ms.ts,
  NULL,
  'synced'
FROM parts_map, now_ms
ON CONFLICT (entity_id, attribute_def_id) DO NOTHING;

WITH
  now_ms AS (
    SELECT (extract(epoch FROM now()) * 1000)::bigint AS ts
  ),
  et_part AS (
    SELECT id FROM entity_types WHERE code = 'part' AND deleted_at IS NULL
  ),
  ad_part_assembly AS (
    SELECT id FROM attribute_defs
    WHERE entity_type_id = (SELECT id FROM et_part)
      AND code = 'assembly_unit_number'
      AND deleted_at IS NULL
  ),
  ad_part_name AS (
    SELECT id FROM attribute_defs
    WHERE entity_type_id = (SELECT id FROM et_part)
      AND code = 'name'
      AND deleted_at IS NULL
  ),
  parts_raw(part_name, assembly_unit_number) AS (
    VALUES
      ('Картер верхний','Сб. 3301-15-30'),
      ('Картер нижний','Сб. 3301-15-30'),
      ('Вал коленчатый','Сб. 3305-01-18'),
      ('Вал коленчатый','Сб. 3305-01-17'),
      ('Рубашка цилиндров правая','Сб. 303-03-11'),
      ('Рубашка цилиндров левая','Сб. 303-02-16'),
      ('Головки блока правой','Сб. 306-01-26'),
      ('Головки блока правой','Сб. 306-01-20'),
      ('Головки блока левой','Сб. 306-02-26'),
      ('Головки блока левой','Сб. 306-02-20'),
      ('Насос топливный','НК-10М сб. 327-00-62'),
      ('Насос топливный','НК-12М сб. 327-00-47'),
      ('Насос топливоподкачивающий','Сб. 532-00-02'),
      ('Насос водяной','Сб. 411-00-35А'),
      ('Насос водяной','Сб. 411-00-48'),
      ('Насос водяной','Сб. 411-00-42'),
      ('Насос масляный','Сб. 3312-00-16'),
      ('Насос масляный','Сб. 3312-00-15'),
      ('Насос масляный','Сб. 3312-00-17'),
      ('ТФТО','Сб. 3329-00-13'),
      ('Маслоочиститель центробежный','Сб. 447-00'),
      ('Маслоочиститель центробежный','Сб. 447-00-1'),
      ('Фильтр масляный','Сб. 413-00-14'),
      ('Фильтр масляный','Сб. 413-00-15'),
      ('Фильтр масляный','Сб. 413-00-7'),
      ('Фильтр масляный','Сб. 413-00-10'),
      ('Привод','303.01.сб.2'),
      ('Механизм отбора мощности','306.01СБ'),
      ('Нагнетатель','Сб.3338-401-10'),
      ('Нагнетатель','Сб. 3338-401-6'),
      ('Генератор с муфтой привода','3309-25-2'),
      ('Воздухораспределитель','Сб. 310-30А'),
      ('Трубопровод выпускной левый','118.01сб.2-1'),
      ('Трубопровод выпускной левый','Сб.418-50-29/31'),
      ('Трубопровод выпускной правый','118.01сб.3-1'),
      ('Трубопровод выпускной правый','Сб. 418-51-29/31'),
      ('Трубопровод впускной левый','Сб.419-06-10'),
      ('Трубопровод впускной левый','Сб.419-06-7/сб.419-06-12'),
      ('Трубопровод впускной правый','Сб.419-05-10'),
      ('Трубопровод впускной правый','Сб.419-05-7/сб. 419-05-12'),
      ('Трубопровод масляный (труба подвода масла к распредвалу правая)','Сб. 320-32А'),
      ('Трубопровод масляный (труба подвода масла к распредвалу правая)','Сб. 320-32'),
      ('Трубопровод масляный (труба подвода масла к распредвалу левая)','Сб. 320-33А'),
      ('Трубопровод масляный (труба подвода масла к распредвалу левая)','Сб. 320-33'),
      ('Шланг от маслонасоса к маслоочистителю','Сб. 420-51'),
      ('Шланг от маслонасоса к маслоочистителю','Сб. 420-51-7'),
      ('Шланг от маслонасоса к маслоочистителю','Сб. 420-164-7'),
      ('Шланг от маслонасоса к маслоочистителю','Сб. 3320-164-8'),
      ('Трубка подвода масла к топливному насосу','Сб. 420-183-6'),
      ('Трубка подвода масла к топливному насосу','Сб. 420-183-5'),
      ('Труб подвода масла к нагнетателю','сб. 3320-268-1 и сб. 3320-273'),
      ('Труба для подвода масла к приводу генератора','Сб. 3320-161-4'),
      ('Трубопровод от маслонасоса к маслофильтру','Сб. 3320-372-4/11'),
      ('Трубопровод от маслонасоса к маслофильтру','Сб. 420-02-12/7'),
      ('Трубопровод от маслофильтра к главной магистрали','Сб. 3320-398'),
      ('Трубопровод водяной','Сб. 3321-00-19'),
      ('Трубопровод водяной','Сб. 3321-00-16'),
      ('Трубопровод воздушного пуска','Сб. 322-00-4'),
      ('Трубопровод высокого давления','Сб. 323-33А, сб. 323-34А, сб. 323-35А, сб. 323-36А'),
      ('Трубопровод высокого давления','Сб. 323-33-4,сб. 323-34-4, сб. 323-35-4,      сб. 323-36-4'),
      ('Система суфлирования (корпус маслоотделителя)','Сб.3342-184-2'),
      ('Система суфлирования (корпус маслоотделителя)','Сб. 3342-184-1'),
      ('Крышка головки правая','Сб. 406-08-3'),
      ('Крышка головки правая','Сб. 306-08-8'),
      ('Крышка головки левая','Сб. 306-09-8'),
      ('Крышка головки левая','Сб. 306-09-10'),
      ('Крышка люка','Сб. 406-12-44')
  ),
  parts_existing AS (
    SELECT
      e.id,
      av_name.value_json AS name_json,
      av_assembly.value_json AS assembly_json
    FROM entities e
    JOIN attribute_values av_name
      ON av_name.entity_id = e.id
     AND av_name.attribute_def_id = (SELECT id FROM ad_part_name)
     AND av_name.deleted_at IS NULL
    JOIN attribute_values av_assembly
      ON av_assembly.entity_id = e.id
     AND av_assembly.attribute_def_id = (SELECT id FROM ad_part_assembly)
     AND av_assembly.deleted_at IS NULL
    WHERE e.type_id = (SELECT id FROM et_part)
      AND e.deleted_at IS NULL
  ),
  parts_map AS (
    SELECT
      pr.part_name,
      pr.assembly_unit_number,
      COALESCE(
        (SELECT pe.id FROM parts_existing pe
         WHERE pe.name_json = to_jsonb(pr.part_name)::text
           AND pe.assembly_json = to_jsonb(pr.assembly_unit_number)::text
         LIMIT 1),
        md5('part:' || pr.part_name || '|' || pr.assembly_unit_number)::uuid
      ) AS part_id
    FROM parts_raw pr
  )
INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at, deleted_at, sync_status)
SELECT
  md5('part:assembly:' || parts_map.part_id::text)::uuid,
  parts_map.part_id,
  (SELECT id FROM ad_part_assembly),
  to_jsonb(parts_map.assembly_unit_number)::text,
  now_ms.ts,
  now_ms.ts,
  NULL,
  'synced'
FROM parts_map, now_ms
ON CONFLICT (entity_id, attribute_def_id) DO NOTHING;

WITH
  now_ms AS (
    SELECT (extract(epoch FROM now()) * 1000)::bigint AS ts
  ),
  et_part AS (
    SELECT id FROM entity_types WHERE code = 'part' AND deleted_at IS NULL
  ),
  ad_part_brand_ids AS (
    SELECT id FROM attribute_defs
    WHERE entity_type_id = (SELECT id FROM et_part)
      AND code = 'engine_brand_ids'
      AND deleted_at IS NULL
  ),
  brand_seed(name) AS (
    VALUES
      ('В-59УМС'),
      ('В-84'),
      ('В-84 АМС'),
      ('В-84МБ-1С (В-84Б)'),
      ('В-84 ДТ'),
      ('В-46-5С'),
      ('В-46-2С1 (В-46-2С1М)'),
      ('В-46-1')
  ),
  existing_brands AS (
    SELECT e.id, av.value_json
    FROM entities e
    JOIN attribute_values av
      ON av.entity_id = e.id
     AND av.attribute_def_id = (
       SELECT id FROM attribute_defs
       WHERE entity_type_id = (SELECT id FROM entity_types WHERE code = 'engine_brand' AND deleted_at IS NULL)
         AND code = 'name'
         AND deleted_at IS NULL
     )
     AND av.deleted_at IS NULL
    WHERE e.type_id = (SELECT id FROM entity_types WHERE code = 'engine_brand' AND deleted_at IS NULL)
      AND e.deleted_at IS NULL
  ),
  brand_map AS (
    SELECT
      bs.name,
      COALESCE(
        (SELECT eb.id FROM existing_brands eb WHERE eb.value_json = to_jsonb(bs.name)::text LIMIT 1),
        md5('engine_brand:' || bs.name)::uuid
      ) AS brand_id
    FROM brand_seed bs
  ),
  parts_raw(part_name, brand_name, assembly_unit_number) AS (
    VALUES
      ('Картер верхний','В-59УМС','Сб. 3301-15-30'),
      ('Картер нижний','В-59УМС','Сб. 3301-15-30'),
      ('Вал коленчатый','В-59УМС','Сб. 3305-01-18'),
      ('Вал коленчатый','В-84','Сб. 3305-01-17'),
      ('Рубашка цилиндров правая','В-59УМС','Сб. 303-03-11'),
      ('Рубашка цилиндров левая','В-59УМС','Сб. 303-02-16'),
      ('Головки блока правой','В-59УМС','Сб. 306-01-26'),
      ('Головки блока правой','В-84','Сб. 306-01-20'),
      ('Головки блока левой','В-59УМС','Сб. 306-02-26'),
      ('Головки блока левой','В-84','Сб. 306-02-20'),
      ('Насос топливный','В-59УМС','НК-10М сб. 327-00-62'),
      ('Насос топливный','В-84','НК-12М сб. 327-00-47'),
      ('Насос топливоподкачивающий','В-59УМС','Сб. 532-00-02'),
      ('Насос водяной','В-59УМС','Сб. 411-00-35А'),
      ('Насос водяной','В-84','Сб. 411-00-48'),
      ('Насос водяной','В-84 АМС','Сб. 411-00-42'),
      ('Насос водяной','В-84МБ-1С (В-84Б)','Сб. 411-00-48'),
      ('Насос масляный','В-59УМС','Сб. 3312-00-16'),
      ('Насос масляный','В-84','Сб. 3312-00-15'),
      ('Насос масляный','В-84 АМС','Сб. 3312-00-17'),
      ('Насос масляный','В-84МБ-1С (В-84Б)','Сб. 3312-00-16'),
      ('Насос масляный','В-84 ДТ','Сб. 3312-00-15'),
      ('ТФТО','В-59УМС','Сб. 3329-00-13'),
      ('Маслоочиститель центробежный','В-59УМС','Сб. 447-00'),
      ('Маслоочиститель центробежный','В-84','Сб. 447-00-1'),
      ('Маслоочиститель центробежный','В-84 АМС','Сб. 447-00'),
      ('Маслоочиститель центробежный','В-84 ДТ','Сб. 447-00'),
      ('Фильтр масляный','В-59УМС','Сб. 413-00-14'),
      ('Фильтр масляный','В-84','Сб. 413-00-15'),
      ('Фильтр масляный','В-84 АМС','Сб. 413-00-7'),
      ('Фильтр масляный','В-84МБ-1С (В-84Б)','Сб. 413-00-15'),
      ('Фильтр масляный','В-84 ДТ','Сб. 413-00-10'),
      ('Привод','В-59УМС','303.01.сб.2'),
      ('Механизм отбора мощности','В-84 ДТ','306.01СБ'),
      ('Механизм отбора мощности','В-46-2С1 (В-46-2С1М)','306.01СБ'),
      ('Нагнетатель','В-84','Сб.3338-401-10'),
      ('Нагнетатель','В-84 АМС','Сб. 3338-401-6'),
      ('Генератор с муфтой привода','В-59УМС','3309-25-2'),
      ('Генератор с муфтой привода','В-46-5С','3309-25-2'),
      ('Воздухораспределитель','В-59УМС','Сб. 310-30А'),
      ('Трубопровод выпускной левый','В-59УМС','118.01сб.2-1'),
      ('Трубопровод выпускной левый','В-84','Сб.418-50-29/31'),
      ('Трубопровод выпускной правый','В-59УМС','118.01сб.3-1'),
      ('Трубопровод выпускной правый','В-84','Сб. 418-51-29/31'),
      ('Трубопровод впускной левый','В-59УМС','Сб.419-06-10'),
      ('Трубопровод впускной левый','В-84','Сб.419-06-7/сб.419-06-12'),
      ('Трубопровод впускной правый','В-59УМС','Сб.419-05-10'),
      ('Трубопровод впускной правый','В-84','Сб.419-05-7/сб. 419-05-12'),
      ('Трубопровод масляный (труба подвода масла к распредвалу правая)','В-59УМС','Сб. 320-32А'),
      ('Трубопровод масляный (труба подвода масла к распредвалу правая)','В-84','Сб. 320-32'),
      ('Трубопровод масляный (труба подвода масла к распредвалу правая)','В-84 ДТ','Сб. 320-32А'),
      ('Трубопровод масляный (труба подвода масла к распредвалу левая)','В-84','Сб. 320-33А'),
      ('Трубопровод масляный (труба подвода масла к распредвалу левая)','В-84 ДТ','Сб. 320-33'),
      ('Трубопровод масляный (труба подвода масла к распредвалу левая)','В-46-5С','Сб. 320-33А'),
      ('Шланг от маслонасоса к маслоочистителю','В-59УМС','Сб. 420-51'),
      ('Шланг от маслонасоса к маслоочистителю','В-84','Сб. 420-51-7'),
      ('Шланг от маслонасоса к маслоочистителю','В-84МБ-1С (В-84Б)','Сб. 420-164-7'),
      ('Шланг от маслонасоса к маслоочистителю','В-84 ДТ','Сб. 3320-164-8'),
      ('Трубка подвода масла к топливному насосу','В-59УМС','Сб. 420-183-6'),
      ('Трубка подвода масла к топливному насосу','В-84','Сб. 420-183-5'),
      ('Трубка подвода масла к топливному насосу','В-84 АМС','Сб. 420-183-6'),
      ('Труб подвода масла к нагнетателю','В-84 АМС','сб. 3320-268-1 и сб. 3320-273'),
      ('Труб подвода масла к нагнетателю','В-84 ДТ','сб. 3320-268-1 и сб. 3320-273'),
      ('Труба для подвода масла к приводу генератора','В-59УМС','Сб. 3320-161-4'),
      ('Труба для подвода масла к приводу генератора','В-84 ДТ','Сб. 3320-161-4'),
      ('Трубопровод от маслонасоса к маслофильтру','В-84','Сб. 3320-372-4/11'),
      ('Трубопровод от маслонасоса к маслофильтру','В-84 ДТ','Сб. 420-02-12/7'),
      ('Трубопровод от маслофильтра к главной магистрали','В-84','Сб. 3320-398'),
      ('Трубопровод водяной','В-59УМС','Сб. 3321-00-19'),
      ('Трубопровод водяной','В-84','Сб. 3321-00-16'),
      ('Трубопровод воздушного пуска','В-59УМС','Сб. 322-00-4'),
      ('Трубопровод высокого давления','В-59УМС','Сб. 323-33А, сб. 323-34А, сб. 323-35А, сб. 323-36А'),
      ('Трубопровод высокого давления','В-84','Сб. 323-33-4,сб. 323-34-4, сб. 323-35-4,      сб. 323-36-4'),
      ('Трубопровод высокого давления','В-84 АМС','Сб. 323-33А, сб. 323-34А, сб. 323-35А, сб. 323-36А'),
      ('Система суфлирования (корпус маслоотделителя)','В-59УМС','Сб.3342-184-2'),
      ('Система суфлирования (корпус маслоотделителя)','В-84','Сб. 3342-184-1'),
      ('Система суфлирования (корпус маслоотделителя)','В-84 АМС','Сб. 3342-184-2'),
      ('Система суфлирования (корпус маслоотделителя)','В-84МБ-1С (В-84Б)','Сб. 3342-184-1'),
      ('Крышка головки правая','В-59УМС','Сб. 406-08-3'),
      ('Крышка головки правая','В-84','Сб. 306-08-8'),
      ('Крышка головки левая','В-59УМС','Сб. 306-09-8'),
      ('Крышка головки левая','В-84','Сб. 306-09-10'),
      ('Крышка люка','В-59УМС','Сб. 406-12-44')
  ),
  parts_grouped AS (
    SELECT
      pr.part_name,
      pr.assembly_unit_number,
      array_agg(DISTINCT bm.brand_id) AS brand_ids
    FROM parts_raw pr
    JOIN brand_map bm ON bm.name = pr.brand_name
    GROUP BY pr.part_name, pr.assembly_unit_number
  ),
  parts_existing AS (
    SELECT
      e.id,
      av_name.value_json AS name_json,
      av_assembly.value_json AS assembly_json
    FROM entities e
    JOIN attribute_values av_name
      ON av_name.entity_id = e.id
     AND av_name.attribute_def_id = (
       SELECT id FROM attribute_defs
       WHERE entity_type_id = (SELECT id FROM et_part)
         AND code = 'name'
         AND deleted_at IS NULL
     )
     AND av_name.deleted_at IS NULL
    JOIN attribute_values av_assembly
      ON av_assembly.entity_id = e.id
     AND av_assembly.attribute_def_id = (
       SELECT id FROM attribute_defs
       WHERE entity_type_id = (SELECT id FROM et_part)
         AND code = 'assembly_unit_number'
         AND deleted_at IS NULL
     )
     AND av_assembly.deleted_at IS NULL
    WHERE e.type_id = (SELECT id FROM et_part)
      AND e.deleted_at IS NULL
  ),
  parts_map AS (
    SELECT
      COALESCE(
        (SELECT pe.id FROM parts_existing pe
         WHERE pe.name_json = to_jsonb(pg.part_name)::text
           AND pe.assembly_json = to_jsonb(pg.assembly_unit_number)::text
         LIMIT 1),
        md5('part:' || pg.part_name || '|' || pg.assembly_unit_number)::uuid
      ) AS part_id,
      pg.brand_ids
    FROM parts_grouped pg
  )
INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at, deleted_at, sync_status)
SELECT
  md5('part:brands:' || parts_map.part_id::text)::uuid,
  parts_map.part_id,
  (SELECT id FROM ad_part_brand_ids),
  to_jsonb(parts_map.brand_ids)::text,
  now_ms.ts,
  now_ms.ts,
  NULL,
  'synced'
FROM parts_map, now_ms
ON CONFLICT (entity_id, attribute_def_id) DO UPDATE
SET
  value_json = (
    SELECT to_jsonb(ARRAY(
      SELECT DISTINCT v
      FROM (
        SELECT jsonb_array_elements_text(COALESCE(attribute_values.value_json::jsonb, '[]'::jsonb)) AS v
        UNION
        SELECT jsonb_array_elements_text(EXCLUDED.value_json::jsonb) AS v
      ) s
      ORDER BY v
    ))::text
  ),
  updated_at = EXCLUDED.updated_at,
  sync_status = 'synced';
