-- B3/R2: отставание зеркала должно быть ВИДНО, а не только записано в журнал.
--
-- В 0086 обе rebuild-функции получили барьер исключений: зеркало не имеет права
-- ронять транзакцию клиентского пуша, иначе человек в цеху перестаёт
-- синхронизироваться. Барьер решает эту задачу, но создаёт новую: сбой
-- проглатывается, EAV-запись проходит, а строка в users остаётся СТАРОЙ. Пока
-- читатели ходили в EAV, это стоило лишь расхождения, которое ловит users:parity
-- при ручном запуске. С R2 на строгие таблицы переезжают читатели разделов
-- доступа — и устаревшая строка означает уже не расхождение, а неверный доступ
-- у живого человека.
--
-- Поэтому: отказ пересборки перестаёт быть только строчкой в journald и
-- становится строкой в таблице, которую видит parity и любой ops-запрос.
--
-- Таблица намеренно БЕЗ констрейнтов и БЕЗ внешних ключей: она пишется из
-- обработчика исключений, и её собственный сбой вернул бы нас ровно туда, откуда
-- ушли.

CREATE TABLE IF NOT EXISTS users_mirror_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  fn text,
  sqlstate text,
  message text,
  at bigint
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS users_mirror_failures_at_idx ON users_mirror_failures (at);
--> statement-breakpoint

-- Отдельной функцией, чтобы тела rebuild-функций не разрастались, а сама запись
-- была одной точкой. SECURITY DEFINER не нужен: пишет тот же владелец.
CREATE OR REPLACE FUNCTION mirror_note_failure(p_id uuid, p_fn text, p_state text, p_msg text)
RETURNS void AS $fn$
BEGIN
  INSERT INTO users_mirror_failures (user_id, fn, sqlstate, message, at)
  VALUES (p_id, p_fn, p_state, left(coalesce(p_msg, ''), 2000),
          (extract(epoch from clock_timestamp()) * 1000)::bigint);
EXCEPTION WHEN others THEN
  -- Запись отказа не имеет права сама стать отказом.
  NULL;
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Обе rebuild-функции переопределяются целиком (тела перенесены из 0086 без
-- изменений, добавлена только строка PERFORM mirror_note_failure).

CREATE OR REPLACE FUNCTION rebuild_user(p_id uuid)
RETURNS void AS $fn$
DECLARE
  v_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_deleted bigint;
  v_found boolean;
  v_login text;
  v_role_raw text;
  v_role text;
  v_hash text;
  v_req_by uuid;
  v_req_at bigint;
  v_ui_settings jsonb;
  v_ui_profile jsonb;
  v_logging_enabled boolean;
  v_logging_mode text;
BEGIN
 BEGIN
  SELECT true, e.deleted_at INTO v_found, v_deleted
    FROM entities e
    JOIN entity_types t ON t.id = e.type_id AND t.code = 'employee'
   WHERE e.id = p_id;
  IF v_found IS DISTINCT FROM true THEN RETURN; END IF;

  v_login := lower(btrim(coalesce(eav_emp_text(p_id, 'login'), '')));

  -- Карточка без логина — не аккаунт. Если строка была (логин сняли) — сносим:
  -- зеркало производное, а `login NOT NULL` обязан оставаться честным.
  -- Кред / настройки / разделы уезжают каскадом.
  IF v_login = '' THEN
    DELETE FROM users WHERE id = p_id;
    RETURN;
  END IF;

  v_role_raw := lower(btrim(coalesce(eav_emp_text(p_id, 'system_role'), '')));
  IF v_login = 'valstan' THEN
    v_role := 'superadmin';
  ELSIF v_role_raw IN (
    'superadmin', 'admin',
    'engineer', 'technolog', 'master', 'supply', 'storekeeper', 'timekeeper', 'viewer',
    'user', 'pending', 'employee'
  ) THEN
    v_role := v_role_raw;
  ELSE
    -- 'merged', опечатка, пусто — всё сюда (fail-closed).
    v_role := 'employee';
  END IF;

  v_req_at := eav_emp_ms(p_id, 'delete_requested_at');
  v_req_by := eav_emp_uuid(p_id, 'delete_requested_by_id');
  -- FK-страховка: инициатор, у которого нет своего аккаунта (карточка без
  -- логина, или его ещё не создал первый проход бэкфилла) — в NULL.
  IF v_req_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = v_req_by) THEN
    v_req_by := NULL;
  END IF;
  -- CHECK асимметричен: инициатор без даты невозможен.
  IF v_req_at IS NULL THEN v_req_by := NULL; END IF;

  INSERT INTO users (
    id, login, system_role, access_enabled,
    delete_requested_at, delete_requested_by,
    created_at, updated_at, deleted_at
  )
  VALUES (
    p_id, v_login, v_role,
    coalesce(eav_emp_bool(p_id, 'access_enabled'), false),
    v_req_at, v_req_by,
    v_ms, v_ms, v_deleted
  )
  ON CONFLICT (id) DO UPDATE SET
    login = EXCLUDED.login,
    system_role = EXCLUDED.system_role,
    access_enabled = EXCLUDED.access_enabled,
    delete_requested_at = EXCLUDED.delete_requested_at,
    delete_requested_by = EXCLUDED.delete_requested_by,
    updated_at = EXCLUDED.updated_at,
    deleted_at = EXCLUDED.deleted_at;

  -- Кред: строка есть, только пока хэш непустой (CHECK непустоты).
  v_hash := coalesce(eav_emp_text(p_id, 'password_hash'), '');
  IF btrim(v_hash) = '' THEN
    DELETE FROM user_credentials WHERE user_id = p_id;
  ELSE
    INSERT INTO user_credentials (user_id, password_hash, created_at, updated_at)
    VALUES (p_id, v_hash, v_ms, v_ms)
    ON CONFLICT (user_id) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      updated_at = EXCLUDED.updated_at;
  END IF;

  -- Настройки: строка держится, только пока есть хоть одно значение.
  v_ui_settings := eav_emp_jsonb_object(p_id, 'ui_settings_json');
  v_ui_profile := eav_emp_jsonb_object(p_id, 'ui_profile_json');
  v_logging_enabled := eav_emp_bool(p_id, 'logging_enabled');
  v_logging_mode := eav_emp_text(p_id, 'logging_mode');
  IF v_ui_settings IS NULL AND v_ui_profile IS NULL AND v_logging_enabled IS NULL AND v_logging_mode IS NULL THEN
    DELETE FROM user_settings WHERE user_id = p_id;
  ELSE
    INSERT INTO user_settings (user_id, ui_settings, ui_profile, logging_enabled, logging_mode, created_at, updated_at)
    VALUES (p_id, v_ui_settings, v_ui_profile, v_logging_enabled, v_logging_mode, v_ms, v_ms)
    ON CONFLICT (user_id) DO UPDATE SET
      ui_settings = EXCLUDED.ui_settings,
      ui_profile = EXCLUDED.ui_profile,
      logging_enabled = EXCLUDED.logging_enabled,
      logging_mode = EXCLUDED.logging_mode,
      updated_at = EXCLUDED.updated_at;
  END IF;
 EXCEPTION WHEN others THEN
  -- ЗЕРКАЛО НИКОГДА НЕ РОНЯЕТ ПИСАТЕЛЯ. Функция выполняется внутри транзакции
  -- клиентского пуша (applyPushBatch — одна транзакция на весь пакет, без
  -- SAVEPOINT). Любое исключение отсюда отвергает пакет ЦЕЛИКОМ, и клиент
  -- ретраит его вечно — отказ синхронизации у человека в цеху.
  -- Образец 0084, по которому писалась миграция, обойтись без барьера мог:
  -- у его таблиц нет ни одного CHECK и лишь один FK, прикрытый вручную. Здесь
  -- же констрейнтов восемь, и защита по значению («предусмотрели этот класс
  -- мусора») закрывает только то, что автор сумел вообразить.
  -- Пока источник правды — EAV (R1–R3), отставшее зеркало это дефект данных:
  -- он виден в логе как WARNING и ловится гейтом users:parity. На R4, когда
  -- users станет каноном и триггеры уйдут, барьер уходит вместе с ними.
  PERFORM mirror_note_failure(p_id, 'rebuild_user', SQLSTATE, SQLERRM);
  RAISE WARNING 'rebuild_user(%) пропущен: % %', p_id, SQLSTATE, SQLERRM;
 END;
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rebuild_user_sections(p_id uuid)
RETURNS void AS $fn$
DECLARE
  v_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_raw jsonb;
  v_live text[] := ARRAY[]::text[];
  r record;
BEGIN
 BEGIN
  -- Нет аккаунта — нет и его разделов (каскад уже отработал).
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p_id) THEN RETURN; END IF;

  v_raw := eav_emp_jsonb_object(p_id, 'section_access');

  IF v_raw IS NOT NULL THEN
    FOR r IN SELECT key AS section_id, value AS lvl FROM jsonb_each_text(v_raw) LOOP
      -- Неизвестный раздел (FK) или неизвестный уровень (CHECK) — пропускаем
      -- молча: кривая клиентская строка не должна валить пересборку целиком.
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM access_sections s WHERE s.id = r.section_id);
      -- ВНИМАНИЕ на NULL: jsonb_each_text отдаёт SQL NULL для JSON-null, а
      -- `NULL NOT IN (...)` даёт NULL, и CONTINUE (срабатывает только на TRUE)
      -- НЕ прерывал бы итерацию — level=NULL уехал бы в INSERT и словил
      -- not-null, уронив чужую транзакцию. Именно то, что комментарий выше
      -- обещает не делать.
      CONTINUE WHEN r.lvl IS NULL OR r.lvl NOT IN ('viewer', 'editor');

      INSERT INTO user_section_access (id, user_id, section_id, level, created_at, updated_at, deleted_at)
      VALUES (gen_random_uuid(), p_id, r.section_id, r.lvl, v_ms, v_ms, NULL)
      ON CONFLICT (user_id, section_id) DO UPDATE SET
        level = EXCLUDED.level,
        updated_at = EXCLUDED.updated_at,
        deleted_at = NULL;

      v_live := array_append(v_live, r.section_id);
    END LOOP;
  END IF;

  -- Всё, чего в живом membership больше нет, — soft-delete.
  UPDATE user_section_access
     SET deleted_at = v_ms, updated_at = v_ms
   WHERE user_id = p_id
     AND deleted_at IS NULL
     AND NOT (section_id = ANY (v_live));
 EXCEPTION WHEN others THEN
  -- См. барьер в rebuild_user: доступы человека не стоят отказа синхронизации.
  PERFORM mirror_note_failure(p_id, 'rebuild_user_sections', SQLSTATE, SQLERRM);
  RAISE WARNING 'rebuild_user_sections(%) пропущен: % %', p_id, SQLSTATE, SQLERRM;
 END;
END;
$fn$ LANGUAGE plpgsql;
