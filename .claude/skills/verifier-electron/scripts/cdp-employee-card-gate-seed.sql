-- Фикстура смоука cdp-employee-card-gate.mjs: сотрудник с ПОЛНЫМ ключом личности
-- (ФИО + дата приёма + день рождения). Должности нет — ключ сходится по двум сильным
-- полям (дата приёма и ДР), этого достаточно для уровня «совпал полный ключ».
--
-- Даты — эпоха-миллисекунды ПОЛУНОЧИ ПО МОСКВЕ, ровно то, что пишет клиент полем
-- даты: 15.03.2019 → 1552597200000 (UTC+3), 02.07.1985 → 489096000000 (декретное
-- время UTC+4 — в 1985 году в Москве было именно так).
--
-- Запуск: psql -d matricarmz_dev -f <этот файл>; после смоука — cdp-employee-card-gate-cleanup.sql.
\set ON_ERROR_STOP on
DO $$
DECLARE t uuid; d_name uuid; d_hire uuid; d_birth uuid; d_pers uuid; s uuid := gen_random_uuid(); ts bigint := (extract(epoch from now())*1000)::bigint;
BEGIN
  SELECT id INTO t FROM entity_types WHERE code='employee' AND deleted_at IS NULL;
  IF t IS NULL THEN RAISE EXCEPTION 'тип employee не найден'; END IF;

  INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, created_at, updated_at) VALUES
    (gen_random_uuid(), t, 'full_name', 'ФИО', 'text', ts, ts),
    (gen_random_uuid(), t, 'hire_date', 'Дата приема', 'date', ts, ts),
    (gen_random_uuid(), t, 'birth_date', 'Дата рождения', 'date', ts, ts),
    (gen_random_uuid(), t, 'personnel_number', 'Табельный номер', 'text', ts, ts)
  ON CONFLICT (entity_type_id, code) DO NOTHING;

  SELECT id INTO d_name FROM attribute_defs WHERE entity_type_id=t AND code='full_name';
  SELECT id INTO d_hire FROM attribute_defs WHERE entity_type_id=t AND code='hire_date';
  SELECT id INTO d_birth FROM attribute_defs WHERE entity_type_id=t AND code='birth_date';
  SELECT id INTO d_pers FROM attribute_defs WHERE entity_type_id=t AND code='personnel_number';

  INSERT INTO entities (id, type_id, created_at, updated_at) VALUES (s, t, ts, ts);
  INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at) VALUES
    (gen_random_uuid(), s, d_name, '"Смоукова Ключ Тестовна"', ts, ts),
    (gen_random_uuid(), s, d_hire, '1552597200000', ts, ts),
    (gen_random_uuid(), s, d_birth, '489096000000', ts, ts),
    (gen_random_uuid(), s, d_pers, '"90001"', ts, ts);

  RAISE NOTICE 'seed employee=%', s;
END $$;
