-- Фикстура смоука cdp-employee-dedupe.mjs: два сотрудника с одним ФИО (у одного логин smoke_dup_a) и наряд
-- с бригадой из второго. Запуск: psql -d matricarmz_dev -f <этот файл>; после смоука — cdp-employee-dedupe-cleanup.sql.
\set ON_ERROR_STOP on
DO $$
DECLARE t uuid; d_name uuid; d_login uuid; s uuid := gen_random_uuid(); l uuid := gen_random_uuid(); ts bigint := (extract(epoch from now())*1000)::bigint;
BEGIN
  SELECT id INTO t FROM entity_types WHERE code='employee' AND deleted_at IS NULL;
  INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, created_at, updated_at) VALUES (gen_random_uuid(), t, 'full_name', 'ФИО', 'text', ts, ts) ON CONFLICT (entity_type_id, code) DO NOTHING;
  SELECT id INTO d_name FROM attribute_defs WHERE entity_type_id=t AND code='full_name';
  SELECT id INTO d_login FROM attribute_defs WHERE entity_type_id=t AND code='login';
  INSERT INTO entities (id, type_id, created_at, updated_at) VALUES (s, t, ts, ts), (l, t, ts, ts);
  INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at) VALUES
    (gen_random_uuid(), s, d_name, '"Смоукова Дубль ' || substr(s::text,1,6) || '"', ts, ts),
    (gen_random_uuid(), l, d_name, '"Смоукова Дубль ' || substr(s::text,1,6) || '"', ts, ts),
    (gen_random_uuid(), s, d_login, '"smoke_dup_a"', ts, ts);
  INSERT INTO operations (id, engine_entity_id, operation_type, status, meta_json, created_at, updated_at) VALUES
    (gen_random_uuid(), s, 'work_order', 'done', '{"crew":[{"employeeId":"'||l||'","employeeName":"Смоукова Д. Т.","ktu":1}],"signatureBlocks":[{"blockId":"issue","slots":[{"caption":"Наряд выдал","employeeId":"'||l||'"}]}]}', ts, ts);
  RAISE NOTICE 'survivor=% loser=%', s, l;
END $$;
