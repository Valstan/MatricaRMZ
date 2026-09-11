-- Уборка фикстуры смоука cdp-employee-dedupe.mjs (все записи «Смоукова Дубль …» и их наряды).
\set ON_ERROR_STOP on
DO $$
DECLARE ids uuid[];
BEGIN
  SELECT array_agg(v.entity_id) INTO ids FROM attribute_values v JOIN attribute_defs d ON d.id=v.attribute_def_id
    WHERE d.code='full_name' AND v.value_json LIKE '"Смоукова Дубль%';
  IF ids IS NULL THEN RAISE NOTICE 'nothing to clean'; RETURN; END IF;
  DELETE FROM operations WHERE engine_entity_id = ANY(ids);
  DELETE FROM attribute_values WHERE entity_id = ANY(ids);
  DELETE FROM user_credentials WHERE user_id = ANY(ids);
  DELETE FROM user_section_access WHERE user_id = ANY(ids);
  DELETE FROM users WHERE id = ANY(ids);
  DELETE FROM row_owners WHERE row_id = ANY(ids);
  DELETE FROM entities WHERE id = ANY(ids);
  RAISE NOTICE 'cleaned %', array_length(ids, 1);
END $$;
